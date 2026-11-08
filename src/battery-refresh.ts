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

/** Parse the `battery_refresh_hours` setting: 0 disables, garbage → default. */
export function parseRefreshHours(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_REFRESH_HOURS;
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_REFRESH_HOURS;
}

export function reportsPowerCfg(device: PowerCfgDevice): boolean {
  if (device.power_source?.toLowerCase() !== "battery") return false;
  return Object.values(device.endpoints ?? {}).some((ep) =>
    [...(ep.bindings ?? []), ...(ep.configured_reportings ?? [])]
      .some((entry) => entry.cluster === "genPowerCfg"));
}

export class BatteryRefresher {
  private readonly intervalMs: number;
  private readonly publishRead: (friendlyName: string) => void;
  private readonly logger: Logger;
  private readonly now: () => number;

  /** Friendly names worth a read, from the last bridge/devices. */
  private eligible = new Set<string>();
  /** Friendly name → time of the last read sent, kept across bridge/devices. */
  private readonly lastRead = new Map<string, number>();
  private lastSentAt = -Infinity;
  private quietUntil = -Infinity;

  constructor(
    hours: number,
    publishRead: (friendlyName: string) => void,
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
    for (const name of [...this.lastRead.keys()]) {
      if (!this.eligible.has(name)) this.lastRead.delete(name);
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

  /** A state message arrived from this device, so it is awake right now. */
  onWake(friendlyName: string): void {
    if (!this.enabled || !this.eligible.has(friendlyName)) return;
    const now = this.now();
    if (now < this.quietUntil) return;
    if (now - this.lastSentAt < MIN_SPACING_MS) return;
    const last = this.lastRead.get(friendlyName);
    if (last !== undefined && now - last < this.intervalMs) return;

    // Stamped before the answer arrives: the answer is itself a state message,
    // and must not trigger another read.
    this.lastRead.set(friendlyName, now);
    this.lastSentAt = now;
    this.publishRead(friendlyName);
    this.logger.debug({ device: friendlyName }, "Battery read sent");
  }
}
