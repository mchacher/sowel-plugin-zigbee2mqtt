/**
 * Tuya PJ-1203A — bidirectional dual-channel energy meter (2× 80 A clamps).
 *
 * Why this device needs a dedicated handler
 * -----------------------------------------
 * The generic Z2M discovery flattens every expose into ONE Sowel device with
 * one data row per property (`power_a`, `energy_a`, `energy_produced_b`, …).
 * That is unusable for the Sowel energy pipeline for three reasons:
 *
 *  1. **Naming** — core only recognises the exact keys `power` / `energy` as
 *     categories `power` / `energy`. `power_a` & co. fall back to `generic`,
 *     so nothing reaches the EnergyAggregator.
 *  2. **Semantics** — `energy_a` / `energy_produced_a` are *cumulative* kWh
 *     counters. Sowel's `energy` alias is a **signed Wh delta per report**
 *     (the downsampling tasks sum on `category=energy`, so writing a cumul
 *     would sum cumuls). Same contract as the Shelly Pro 3EM plugin.
 *  3. **Channels** — one physical device carries two independent circuits.
 *     Bound as a single Sowel device, voie A (grid) and voie B (PV) could not
 *     be assigned to `main_energy_meter` and `energy_production_meter`.
 *
 * So, exactly like `sowel-plugin-shelly-mqtt` does for `em1:N`, this module
 * registers **one Sowel device per channel** and synthesises the Shelly-shaped
 * data set on each of them:
 *
 *   power           W   signed: > 0 consumed / imported, < 0 produced / exported
 *   voltage         V   device-level, mirrored on both channels
 *   current         A   unsigned
 *   power_factor    %   unsigned
 *   energy_flow     enum "consuming" | "producing" (raw direction, for display)
 *   energy_forward  Wh  raw cumulative import counter  (kWh × 1000)
 *   energy_reverse  Wh  raw cumulative export counter  (kWh × 1000)
 *   energy          Wh  signed delta since the previous report → EnergyAggregator
 *
 * Sign handling
 * -------------
 * The device reports an unsigned `power_x` plus a direction enum `energy_flow_x`
 * ("consuming" / "producing"). Z2M also offers a per-device option
 * `signed_power_a` / `signed_power_b` (set in Z2M's `configuration.yaml`), which
 * makes `power_x` signed and turns `energy_flow_x` into the constant `"sign"`.
 * Both layouts are supported: on `"sign"` (or an unknown/absent direction) the
 * raw value is trusted as already signed.
 *
 * Known firmware quirk (Z2M doc): the direction is published one cycle late, so
 * for up to `update_frequency` seconds after a consuming↔producing transition
 * the sign can be wrong. Enabling `signed_power_a` / `late_energy_flow_a` in Z2M
 * avoids it. The cumulative counters are unaffected, so the `energy` deltas —
 * what the energy charts actually use — stay correct either way.
 *
 * Orders: none. `update_frequency` is device configuration and stays in Z2M.
 */

// ============================================================
// Local Sowel surface
// ============================================================

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: unknown): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
  ): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
  /** Available since Sowel v1.5.1 — used to rehydrate counter baselines. */
  getDeviceDataValue?(
    integrationId: string,
    sourceDeviceId: string,
    key: string,
  ): string | number | boolean | null;
}

interface ChannelData {
  key: string;
  type: "boolean" | "number" | "enum" | "text" | "json";
  category: string;
  unit?: string;
  enumValues?: string[];
}

// ============================================================
// Constants
// ============================================================

/** Z2M model ids handled here. `PJ-1203A` covers all `_TZE204_*` variants. */
const PJ1203A_MODELS = new Set(["PJ-1203A"]);

export const PJ1203A_CHANNELS = ["a", "b"] as const;
export type Pj1203aChannel = (typeof PJ1203A_CHANNELS)[number];

/** Per-channel data definition — deliberately identical to the Shelly Pro 3EM one. */
export const PJ1203A_CHANNEL_DATA: ChannelData[] = [
  { key: "power", type: "number", category: "power", unit: "W" },
  { key: "voltage", type: "number", category: "voltage", unit: "V" },
  { key: "current", type: "number", category: "current", unit: "A" },
  { key: "power_factor", type: "number", category: "generic", unit: "%" },
  {
    key: "energy_flow",
    type: "enum",
    category: "generic",
    enumValues: ["consuming", "producing"],
  },
  { key: "energy_forward", type: "number", category: "energy", unit: "Wh" },
  { key: "energy_reverse", type: "number", category: "energy", unit: "Wh" },
  { key: "energy", type: "number", category: "energy", unit: "Wh" },
];

// ============================================================
// Pure helpers (unit-tested)
// ============================================================

/** True when a Z2M device is a PJ-1203A, from its definition model or model id. */
export function isPj1203a(model?: string, modelId?: string): boolean {
  return PJ1203A_MODELS.has(model ?? "") || PJ1203A_MODELS.has(modelId ?? "");
}

/** Stable Sowel source id for one channel of a PJ-1203A. */
export function channelSourceDeviceId(friendlyName: string, channel: Pj1203aChannel): string {
  return `${friendlyName} - ch ${channel.toUpperCase()}`;
}

function numericOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** kWh → Wh, rounded to 1 mWh to kill float noise (0.01 kWh steps × 1000). */
function kwhToWh(kwh: number | null): number | null {
  return kwh === null ? null : Math.round(kwh * 1_000_000) / 1000;
}

/**
 * Resolve the signed instantaneous power from the unsigned reading + direction.
 * `"sign"` is what Z2M publishes when the `signed_power_x` option is on — the
 * raw value already carries the sign, so it is passed through untouched. Same
 * for an absent or unexpected direction: never fabricate a sign we don't know.
 */
export function signPower(power: number | null, flow: string | null): number | null {
  if (power === null) return null;
  if (flow === "producing") return -Math.abs(power);
  if (flow === "consuming") return Math.abs(power);
  return power;
}

export interface ChannelSample {
  power: number | null;
  voltage: number | null;
  current: number | null;
  powerFactor: number | null;
  /** Raw direction enum, or null when Z2M runs in signed-power mode. */
  energyFlow: string | null;
  /** Cumulative imported energy, Wh. */
  energyForwardWh: number | null;
  /** Cumulative exported energy, Wh. */
  energyReverseWh: number | null;
}

/** Slice one channel out of a full PJ-1203A Z2M state payload. */
export function extractChannel(
  state: Record<string, unknown>,
  channel: Pj1203aChannel,
): ChannelSample {
  const flowRaw = state[`energy_flow_${channel}`];
  const flow = typeof flowRaw === "string" ? flowRaw : null;
  return {
    power: signPower(numericOrNull(state[`power_${channel}`]), flow),
    voltage: numericOrNull(state.voltage),
    current: numericOrNull(state[`current_${channel}`]),
    powerFactor: numericOrNull(state[`power_factor_${channel}`]),
    energyFlow: flow === "consuming" || flow === "producing" ? flow : null,
    energyForwardWh: kwhToWh(numericOrNull(state[`energy_${channel}`])),
    energyReverseWh: kwhToWh(numericOrNull(state[`energy_produced_${channel}`])),
  };
}

// ============================================================
// Handler
// ============================================================

interface Baseline {
  fwd?: number;
  rev?: number;
}

interface KnownMeter {
  friendlyName: string;
  channelIds: Record<Pj1203aChannel, string>;
}

const SOURCE = "zigbee2mqtt";

export class Pj1203aHandler {
  private readonly integrationId: string;
  private readonly deviceManager: DeviceManager;
  private readonly logger: Logger;

  /** friendly_name → per-channel Sowel source ids. */
  private readonly known = new Map<string, KnownMeter>();
  /** Per-channel cumulative-counter baseline, hydrated lazily from device_data. */
  private readonly baselines = new Map<string, Baseline>();

  constructor(integrationId: string, deviceManager: DeviceManager, logger: Logger) {
    this.integrationId = integrationId;
    this.deviceManager = deviceManager;
    this.logger = logger.child({ module: "pj1203a" });
  }

  /** True when this Z2M friendly name is a PJ-1203A we already split. */
  isKnown(friendlyName: string): boolean {
    return this.known.has(friendlyName);
  }

  /**
   * Register the two channel devices. Returns their source ids so the caller
   * can feed them to `removeStaleDevices` — the monolithic device that older
   * plugin versions created is intentionally NOT re-declared, so it gets
   * garbage-collected on the next discovery.
   */
  discover(device: {
    friendly_name: string;
    ieee_address?: string;
    definition?: { model?: string; vendor?: string };
    model_id?: string;
  }): string[] {
    const channelIds = {} as Record<Pj1203aChannel, string>;
    for (const channel of PJ1203A_CHANNELS) {
      const sid = channelSourceDeviceId(device.friendly_name, channel);
      channelIds[channel] = sid;
      this.deviceManager.upsertFromDiscovery(this.integrationId, SOURCE, {
        // friendlyName drives sourceDeviceId in upsertFromDiscovery
        friendlyName: sid,
        ieeeAddress: device.ieee_address,
        manufacturer: device.definition?.vendor ?? "Tuya",
        model: `${device.definition?.model ?? device.model_id ?? "PJ-1203A"} channel ${channel.toUpperCase()}`,
        data: PJ1203A_CHANNEL_DATA,
        orders: [],
      });
    }

    this.known.set(device.friendly_name, { friendlyName: device.friendly_name, channelIds });
    this.logger.info(
      { friendlyName: device.friendly_name, channels: Object.values(channelIds) },
      "PJ-1203A split into per-channel devices",
    );
    return Object.values(channelIds);
  }

  /** Drop in-memory state for meters that vanished from bridge/devices. */
  retainOnly(activeFriendlyNames: Set<string>): void {
    for (const [friendlyName, meter] of this.known) {
      if (activeFriendlyNames.has(friendlyName)) continue;
      this.known.delete(friendlyName);
      for (const sid of Object.values(meter.channelIds)) this.baselines.delete(sid);
    }
  }

  /** Fan a full Z2M state payload out to the two channel devices. */
  handleState(friendlyName: string, state: Record<string, unknown>): void {
    const meter = this.known.get(friendlyName);
    if (!meter) return;
    for (const channel of PJ1203A_CHANNELS) {
      const sid = meter.channelIds[channel];
      const sample = extractChannel(state, channel);
      const payload = this.buildPayload(sid, sample);
      if (Object.keys(payload).length === 0) continue;
      this.deviceManager.updateDeviceData(this.integrationId, sid, payload);
    }
  }

  /** Mirror the device's availability onto both channel devices. */
  handleAvailability(friendlyName: string, status: string): void {
    const meter = this.known.get(friendlyName);
    if (!meter) return;
    for (const sid of Object.values(meter.channelIds)) {
      this.deviceManager.updateDeviceStatus(this.integrationId, sid, status);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private buildPayload(sid: string, sample: ChannelSample): Record<string, unknown> {
    const payload: Record<string, unknown> = {};
    if (sample.power !== null) payload.power = sample.power;
    if (sample.voltage !== null) payload.voltage = sample.voltage;
    if (sample.current !== null) payload.current = sample.current;
    if (sample.powerFactor !== null) payload.power_factor = sample.powerFactor;
    if (sample.energyFlow !== null) payload.energy_flow = sample.energyFlow;

    if (sample.energyForwardWh === null && sample.energyReverseWh === null) return payload;

    const baseline = this.ensureBaseline(sid);
    let deltaFwd = 0;
    let deltaRev = 0;

    if (sample.energyForwardWh !== null) {
      // current < baseline (counter reset / out-of-order) → emit 0, re-anchor
      if (baseline.fwd !== undefined) deltaFwd = Math.max(0, sample.energyForwardWh - baseline.fwd);
      baseline.fwd = sample.energyForwardWh;
      payload.energy_forward = sample.energyForwardWh;
    }
    if (sample.energyReverseWh !== null) {
      if (baseline.rev !== undefined) deltaRev = Math.max(0, sample.energyReverseWh - baseline.rev);
      baseline.rev = sample.energyReverseWh;
      payload.energy_reverse = sample.energyReverseWh;
    }

    // Signed delta, Wh: > 0 consumed on this channel, < 0 injected.
    payload.energy = Math.round((deltaFwd - deltaRev) * 1000) / 1000;
    return payload;
  }

  /**
   * Hydrate the counter baseline from device_data the first time we see a
   * channel in this process. Without it, a Sowel restart would credit the whole
   * cumulative counter as a single delta. On a fresh install both stay
   * undefined and the first report emits `energy = 0`, anchoring the baseline.
   */
  private ensureBaseline(sid: string): Baseline {
    const existing = this.baselines.get(sid);
    if (existing) return existing;

    const read = (key: string): number | undefined => {
      const v = this.deviceManager.getDeviceDataValue?.(this.integrationId, sid, key);
      return typeof v === "number" ? v : undefined;
    };
    const baseline: Baseline = { fwd: read("energy_forward"), rev: read("energy_reverse") };
    this.baselines.set(sid, baseline);
    if (baseline.fwd !== undefined || baseline.rev !== undefined) {
      this.logger.info({ sid, fwd: baseline.fwd, rev: baseline.rev }, "Baseline hydrated");
    }
    return baseline;
  }
}
