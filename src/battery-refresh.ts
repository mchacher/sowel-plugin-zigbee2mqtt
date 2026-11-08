/**
 * Battery refresh on wake-up (issue #23).
 *
 * Some battery devices never report their battery on their own, even with a
 * `genPowerCfg` binding and reporting configured by Zigbee2MQTT at pairing —
 * the Tuya IH012-RT01 / ZMS-102 motion sensors send occupancy on every motion
 * but their battery once every few months, or never again. Zigbee2MQTT then
 * repeats the last cached `battery` / `voltage` in every state message
 * (`advanced.cache_state`, on by default), so Sowel shows a months-old level
 * with a timestamp from a few seconds ago. A swapped cell kept reading 11 %.
 *
 * A sleepy device only listens while it is awake, and the one moment the
 * plugin knows it is awake is right after it published a state message. At
 * that moment a `genPowerCfg` read gets an answer within a second (measured:
 * 11 % / 2400 mV → 86 % / 2800 mV). So: on a state message from an eligible
 * device whose last read is older than the interval, publish that read.
 *
 * Eligible means battery-powered AND `genPowerCfg` bound or reported in
 * `bridge/devices`. That is exactly the set Z2M itself expects to report the
 * cluster; Xiaomi devices are left out on purpose — they send their battery in
 * a heartbeat and would only time out on the read.
 */

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

/** The slice of a `bridge/devices` entry this module reads. */
export interface PowerCfgDevice {
  friendly_name: string;
  power_source?: string;
  endpoints?: Record<string, {
    bindings?: { cluster?: string }[];
    configured_reportings?: { cluster?: string }[];
  }>;
}

export const BATTERY_READ_PAYLOAD = JSON.stringify({
  read: { cluster: "genPowerCfg", attributes: ["batteryVoltage", "batteryPercentageRemaining"] },
});

export const DEFAULT_REFRESH_HOURS = 24;

/**
 * Minimum gap between two reads on one network. A Z2M restart makes every
 * device publish at once; without it the coordinator would get one read per
 * battery device in the same second. A device skipped here is read on a later
 * wake-up — a busy PIR wakes every few minutes.
 */
export const MIN_SPACING_MS = 10_000;

/**
 * After the bridge comes back online, Z2M republishes its cached states: those
 * messages do not mean the device is awake, and a read sent then would be
 * wasted and push the real one back by a whole interval.
 */
export const BRIDGE_RESTART_GRACE_MS = 60_000;

/**
 * A read is answered within a second. A device that publishes nothing in this
 * window was not awake after all (the message came from Z2M, not from it):
 * retry after RETRY_BACKOFF_MS instead of waiting a whole interval.
 */
export const ANSWER_WINDOW_MS = 5_000;
export const RETRY_BACKOFF_MS = 3_600_000;

/** Below one hour the reads would cost more battery than they are worth. */
export const MIN_REFRESH_HOURS = 1;

/** Parse the `battery_refresh_hours` setting: 0 disables, garbage → default. */
export function parseRefreshHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REFRESH_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_REFRESH_HOURS;
  return hours === 0 ? 0 : Math.max(hours, MIN_REFRESH_HOURS);
}

export function reportsPowerCfg(device: PowerCfgDevice): boolean {
  if (device.power_source?.toLowerCase() !== "battery") return false;
  return Object.values(device.endpoints ?? {}).some((ep) =>
    [...(ep.bindings ?? []), ...(ep.configured_reportings ?? [])]
      .some((entry) => entry.cluster === "genPowerCfg"));
}

export class BatteryRefresher {
  private readonly intervalMs: number;
  /** Returns false when the read could not be published (MQTT down). */
  private readonly publishRead: (friendlyName: string) => boolean;
  private readonly logger: Logger;
  private readonly now: () => number;

  /** Friendly names worth a read, from the last bridge/devices. */
  private eligible = new Set<string>();
  /** Friendly name → time of the last read sent, kept across bridge/devices. */
  private readonly lastRead = new Map<string, number>();
  /** Reads sent and not answered yet: friendly name → time sent. */
  private readonly pending = new Map<string, number>();
  /** Friendly name → time a re-announce last cleared its read. */
  private readonly lastReset = new Map<string, number>();
  private lastSentAt = -Infinity;
  private quietUntil = -Infinity;

  constructor(
    hours: number,
    publishRead: (friendlyName: string) => boolean,
    logger: Logger,
    now: () => number = Date.now,
  ) {
    this.intervalMs = hours * 3_600_000;
    this.publishRead = publishRead;
    this.logger = logger.child({ module: "battery-refresh" });
    this.now = now;
  }

  get enabled(): boolean { return this.intervalMs > 0; }

  /** Rebuild the eligible set from a bridge/devices snapshot. */
  learn(devices: PowerCfgDevice[]): void {
    const previous = this.eligible.size;
    this.eligible = new Set(devices.filter(reportsPowerCfg).map((d) => d.friendly_name));
    for (const map of [this.lastRead, this.pending, this.lastReset]) {
      for (const name of [...map.keys()]) {
        if (!this.eligible.has(name)) map.delete(name);
      }
    }
    // bridge/devices is republished on every rename or join: log changes only.
    if (this.enabled && this.eligible.size !== previous) {
      this.logger.info({ devices: this.eligible.size }, "Battery refresh armed");
    }
  }

  /** The bridge came back online: ignore the cached-state replay that follows. */
  bridgeRestarted(): void {
    this.quietUntil = this.now() + BRIDGE_RESTART_GRACE_MS;
  }

  /**
   * The device announced itself on the network (`device_announce`): it was
   * power-cycled, most often by a battery swap. Forget its last read so its
   * next message reads the new cell instead of waiting out the interval.
   */
  rejoined(friendlyName: string): void {
    if (!this.lastRead.has(friendlyName)) return;
    // Some end devices re-announce on every parent change, near the edge of
    // range. Honouring each one would read on almost every wake-up and drain
    // the cell being watched: one reset per interval is plenty for a swap.
    const now = this.now();
    const previous = this.lastReset.get(friendlyName);
    if (previous !== undefined && now - previous < this.intervalMs) return;
    this.lastReset.set(friendlyName, now);
    this.lastRead.delete(friendlyName);
    this.pending.delete(friendlyName);
    this.logger.debug({ device: friendlyName }, "Device re-announced, battery read due on next wake-up");
  }

  /** A state message arrived from this device, so it is awake right now. */
  onWake(friendlyName: string): void {
    if (!this.enabled || !this.eligible.has(friendlyName)) return;
    const now = this.now();
    this.settlePending(friendlyName, now);
    if (now < this.quietUntil) return;
    if (now - this.lastSentAt < MIN_SPACING_MS) return;
    const last = this.lastRead.get(friendlyName);
    if (last !== undefined && now - last < this.intervalMs) return;

    if (!this.publishRead(friendlyName)) return;
    // Stamped before the answer arrives: the answer is itself a state message,
    // and must not trigger another read.
    this.lastRead.set(friendlyName, now);
    this.pending.set(friendlyName, now);
    this.lastSentAt = now;
    this.logger.debug({ device: friendlyName }, "Battery read sent");
  }

  /**
   * The first message after a read tells whether it was answered: inside the
   * window it is the answer; later, the device was asleep when the read went
   * out, so the next attempt comes after the backoff, not a whole interval.
   * A heuristic: any message counts, so a second message of the same wake-up
   * passes for the answer, and a `debounce` past the window for a miss.
   */
  private settlePending(friendlyName: string, now: number): void {
    const sentAt = this.pending.get(friendlyName);
    if (sentAt === undefined) return;
    this.pending.delete(friendlyName);
    if (now - sentAt <= ANSWER_WINDOW_MS) return;
    this.lastRead.set(friendlyName, sentAt - this.intervalMs + Math.min(RETRY_BACKOFF_MS, this.intervalMs));
    this.logger.debug({ device: friendlyName }, "Battery read unanswered, retrying after backoff");
  }
}
