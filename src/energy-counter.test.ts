import { describe, it, expect, beforeEach } from "vitest";
import { EnergyCounterNormaliser, ENERGY_TOTAL_KEY } from "./energy-counter.js";

// ============================================================
// Test doubles
// ============================================================

class FakeDeviceManager {
  persisted = new Map<string, number>();
  getDeviceDataValue(_id: string, sid: string, key: string): number | null {
    return this.persisted.get(`${sid}:${key}`) ?? null;
  }
}

class FakeLogger {
  warns: Record<string, unknown>[] = [];
  infos: Record<string, unknown>[] = [];
  child(): FakeLogger { return this; }
  info(obj: Record<string, unknown>): void { this.infos.push(obj); }
  warn(obj: Record<string, unknown>): void { this.warns.push(obj); }
}

const SID = "SONOFF_PLUG_00";

describe("EnergyCounterNormaliser", () => {
  let dm: FakeDeviceManager;
  let logger: FakeLogger;
  let norm: EnergyCounterNormaliser;

  beforeEach(() => {
    dm = new FakeDeviceManager();
    logger = new FakeLogger();
    norm = new EnergyCounterNormaliser("zigbee2mqtt", dm, logger);
  });

  it("anchors on the first report without crediting the counter (AC2)", () => {
    // Regression: the whole bug. A plug already at 12.34 kWh must not credit
    // 12 340 Wh the moment Sowel discovers it.
    const out = norm.normalise(SID, { energy: 12.34, power: 23 });
    expect(out.energy).toBe(0);
    expect(out[ENERGY_TOTAL_KEY]).toBe(12.34);
    expect(out.power).toBe(23);
  });

  it("emits the Wh delta between two reports, not the counter (AC1)", () => {
    norm.normalise(SID, { energy: 0.02 });
    const out = norm.normalise(SID, { energy: 0.03 });
    // 0.01 kWh = 10 Wh. The bug emitted 0.03 instead.
    expect(out.energy).toBe(10);
    expect(out[ENERGY_TOTAL_KEY]).toBe(0.03);
  });

  it("emits 0 when the counter has not moved", () => {
    norm.normalise(SID, { energy: 0.03 });
    expect(norm.normalise(SID, { energy: 0.03 }).energy).toBe(0);
  });

  it("keeps the raw counter available for display (AC5)", () => {
    const out = norm.normalise(SID, { energy: 5.5 });
    expect(out[ENERGY_TOTAL_KEY]).toBe(5.5);
  });

  it("rehydrates the baseline from persisted data across a restart (AC3)", () => {
    dm.persisted.set(`${SID}:${ENERGY_TOTAL_KEY}`, 100);
    // Sowel was down while the plug went 100 -> 100.5 kWh: credit 500 Wh once.
    const out = norm.normalise(SID, { energy: 100.5 });
    expect(out.energy).toBe(500);
    expect(logger.infos.some((i) => i.baseline === 100)).toBe(true);
    // ...and only once.
    expect(norm.normalise(SID, { energy: 100.5 }).energy).toBe(0);
  });

  it("re-anchors and emits 0 when the counter resets (AC4)", () => {
    norm.normalise(SID, { energy: 8 });
    const out = norm.normalise(SID, { energy: 0 });
    expect(out.energy).toBe(0);
    expect(logger.warns).toHaveLength(1);
    // The next report counts from the new anchor, not from 8.
    expect(norm.normalise(SID, { energy: 0.01 }).energy).toBe(10);
  });

  it("leaves payloads without a numeric energy untouched", () => {
    const payload = { power: 12, state: "ON" };
    expect(norm.normalise(SID, payload)).toBe(payload);
    expect(norm.normalise(SID, { energy: null })).toEqual({ energy: null });
    expect(norm.normalise(SID, { energy: "n/a" })).toEqual({ energy: "n/a" });
  });

  it("honours a Wh-declared expose instead of assuming kWh", () => {
    norm.register(SID, "Wh");
    norm.normalise(SID, { energy: 1000 });
    expect(norm.normalise(SID, { energy: 1010 }).energy).toBe(10);
  });

  it("defaults to kWh when the unit is absent or unknown", () => {
    norm.register(SID, undefined);
    norm.normalise(SID, { energy: 1 });
    expect(norm.normalise(SID, { energy: 2 }).energy).toBe(1000);
  });

  it("does not drift on floating-point counters", () => {
    norm.normalise(SID, { energy: 0.1 });
    // 0.3 - 0.1 in IEEE754 is 0.19999999999999998 → must still read 200 Wh.
    expect(norm.normalise(SID, { energy: 0.3 }).energy).toBe(200);
  });

  it("forgets devices that left the network", () => {
    norm.normalise(SID, { energy: 5 });
    norm.retainOnly(new Set(["OTHER"]));
    // Baseline dropped: the device is treated as newly seen and re-anchors.
    expect(norm.normalise(SID, { energy: 9 }).energy).toBe(0);
  });

  it("keeps baselines independent per device", () => {
    norm.normalise("A", { energy: 1 });
    norm.normalise("B", { energy: 50 });
    expect(norm.normalise("A", { energy: 1.5 }).energy).toBe(500);
    expect(norm.normalise("B", { energy: 50.25 }).energy).toBe(250);
  });
});
