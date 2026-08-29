/**
 * Generic cumulative-energy normaliser.
 *
 * Zigbee's Metering cluster defines `currentSummDelivered` as a SUMMATION, and
 * Zigbee2MQTT surfaces it as a monotonically growing `energy` in kWh. Sowel's
 * `energy` alias is the exact opposite: an additive **Wh delta since the
 * previous report** — `HistoryWriter.accumulateEnergyDelta` does `wh += value`
 * with no subtraction, and the downsampling tasks sum on `category=energy`, so
 * a cumul written there sums cumuls.
 *
 * The PJ-1203A handler next door already solves this, but inside a bespoke
 * per-model handler. Because Zigbee *guarantees* the semantic, the generic path
 * can assert it too: every metering device is normalised here, with no
 * per-model allowlist. PJ-1203A devices never reach this code — they are
 * dispatched earlier (`isPj1203a`, then `pj1203a.isKnown`), so they cannot be
 * converted twice.
 *
 * The raw counter is preserved under `energy_total`, deliberately declared
 * OUTSIDE `category: "energy"`: a cumul carrying that category would pollute
 * every energy aggregation, which is the lesson core encoded by forcing
 * `energy_forward` / `energy_reverse` historization off.
 */

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

interface DeviceManager {
  /** Available since Sowel v1.5.1 — used to rehydrate counter baselines. */
  getDeviceDataValue?(
    integrationId: string,
    sourceDeviceId: string,
    key: string,
  ): string | number | boolean | null;
}

/** Z2M property carrying the cumulative counter, and Sowel's delta alias. */
export const ENERGY_KEY = "energy";
/** Where the raw counter is preserved for display. */
export const ENERGY_TOTAL_KEY = "energy_total";

/** Wh per unit of the declared `energy` expose. Z2M publishes kWh. */
const UNIT_TO_WH: Record<string, number> = { kwh: 1000, wh: 1 };
const DEFAULT_MULTIPLIER = UNIT_TO_WH.kwh;

/** Wh precision kept on the emitted delta — 1 mWh, well under any meter's. */
const WH_PRECISION = 1000;

/**
 * Largest delta credited from a single report. A backwards counter step
 * (device glitch, re-interview, a failed read surfacing as 0) would otherwise
 * re-anchor low and make the NEXT report credit the whole counter — the very
 * bug this module exists to prevent. Generous enough to keep a legitimate
 * catch-up after downtime (10 kWh is days of a fridge), tight enough that a
 * counter-sized jump is rejected.
 */
const MAX_DELTA_WH = 10_000;

export class EnergyCounterNormaliser {
  private readonly integrationId: string;
  private readonly deviceManager: DeviceManager;
  private readonly logger: Logger;

  /** Sowel source id → Wh multiplier for the unit Z2M declared. */
  private readonly multipliers = new Map<string, number>();
  /**
   * Sowel source id → last seen raw counter. A present key with an `undefined`
   * value means "hydration attempted, nothing persisted" — the next report
   * anchors the baseline instead of crediting the whole counter.
   */
  private readonly baselines = new Map<string, number | undefined>();

  constructor(integrationId: string, deviceManager: DeviceManager, logger: Logger) {
    this.integrationId = integrationId;
    this.deviceManager = deviceManager;
    this.logger = logger.child({ module: "energy-counter" });
  }

  /** Record the unit Z2M declares for `energy` on this device, at discovery. */
  register(sourceId: string, unit?: string): void {
    const multiplier = unit ? UNIT_TO_WH[unit.toLowerCase()] : undefined;
    this.multipliers.set(sourceId, multiplier ?? DEFAULT_MULTIPLIER);
  }

  /** Forget devices that no longer exist, so the maps track the network. */
  retainOnly(sourceIds: Set<string>): void {
    for (const id of [...this.multipliers.keys()]) {
      if (!sourceIds.has(id)) this.multipliers.delete(id);
    }
    for (const id of [...this.baselines.keys()]) {
      if (!sourceIds.has(id)) this.baselines.delete(id);
    }
  }

  /**
   * Replace a cumulative `energy` reading with the Wh delta since the previous
   * report, preserving the raw counter under `energy_total`. Payloads with no
   * numeric `energy` are returned untouched, so this is a no-op for the vast
   * majority of Zigbee devices.
   */
  normalise(sourceId: string, payload: Record<string, unknown>): Record<string, unknown> {
    const raw = payload[ENERGY_KEY];
    if (typeof raw !== "number" || !Number.isFinite(raw)) return payload;

    // Until discovery has declared this device, its unit is unknown and
    // `energy_total` is undeclared (core would drop it, so the baseline could
    // never persist). Anchor silently rather than guess kWh or leak the cumul.
    if (!this.multipliers.has(sourceId)) {
      this.baselines.set(sourceId, raw);
      return { ...payload, [ENERGY_KEY]: 0 };
    }

    const baseline = this.ensureBaseline(sourceId);
    const multiplier = this.multipliers.get(sourceId) ?? DEFAULT_MULTIPLIER;
    const out: Record<string, unknown> = { ...payload, [ENERGY_TOTAL_KEY]: raw };

    if (baseline === undefined) {
      // Fresh pairing, or nothing persisted yet: anchor without crediting the
      // counter. Emitting 0 rather than dropping the key keeps the data row
      // populated from the very first report.
      out[ENERGY_KEY] = 0;
    } else {
      if (raw < baseline) {
        this.logger.warn(
          { sourceId, previous: baseline, current: raw },
          "Energy counter went backwards (device reset) — re-anchoring, emitting 0",
        );
      }
      const deltaWh = Math.max(0, raw - baseline) * multiplier;
      if (deltaWh > MAX_DELTA_WH) {
        this.logger.warn(
          { sourceId, previous: baseline, current: raw, deltaWh },
          "Implausible energy jump — re-anchoring, emitting 0",
        );
        out[ENERGY_KEY] = 0;
      } else {
        out[ENERGY_KEY] = Math.round(deltaWh * WH_PRECISION) / WH_PRECISION;
      }
    }

    this.baselines.set(sourceId, raw);
    return out;
  }

  /**
   * Hydrate the baseline from persisted device data the first time this device
   * is seen in this process. Without it a plugin restart would credit the whole
   * cumulative counter as a single delta; with it, the energy consumed while
   * Sowel was down is credited exactly once.
   */
  private ensureBaseline(sourceId: string): number | undefined {
    if (this.baselines.has(sourceId)) return this.baselines.get(sourceId);

    const persisted = this.deviceManager.getDeviceDataValue?.(
      this.integrationId,
      sourceId,
      ENERGY_TOTAL_KEY,
    );
    const baseline = typeof persisted === "number" && Number.isFinite(persisted)
      ? persisted
      : undefined;

    this.baselines.set(sourceId, baseline);
    if (baseline !== undefined) {
      this.logger.info({ sourceId, baseline }, "Energy counter baseline hydrated");
    }
    return baseline;
  }
}
