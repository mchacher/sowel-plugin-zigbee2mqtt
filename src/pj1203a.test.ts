import { describe, it, expect, beforeEach } from "vitest";
import {
  Pj1203aHandler,
  channelSourceDeviceId,
  extractChannel,
  isPj1203a,
  signPower,
} from "./pj1203a.js";

// ============================================================
// Test doubles
// ============================================================

interface Upsert {
  friendlyName: string;
  model?: string;
  data: { key: string; category: string; unit?: string }[];
}

class FakeDeviceManager {
  upserts: Upsert[] = [];
  updates: { sid: string; payload: Record<string, unknown> }[] = [];
  statuses: { sid: string; status: string }[] = [];
  persisted = new Map<string, number>();

  upsertFromDiscovery(_id: string, _source: string, discovered: unknown): void {
    this.upserts.push(discovered as Upsert);
  }
  updateDeviceData(_id: string, sid: string, payload: Record<string, unknown>): void {
    this.updates.push({ sid, payload });
  }
  updateDeviceStatus(_id: string, sid: string, status: string): void {
    this.statuses.push({ sid, status });
  }
  getDeviceDataValue(_id: string, sid: string, key: string): number | null {
    return this.persisted.get(`${sid}/${key}`) ?? null;
  }
}

const noopLogger = {
  child: () => noopLogger,
  info: () => {},
  error: () => {},
};

const DEVICE = {
  friendly_name: "compteur",
  ieee_address: "0xa4c1380000000001",
  definition: { model: "PJ-1203A", vendor: "Tuya" },
};

/** Full Z2M state payload, direction-enum flavour (signed_power_x off). */
function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    voltage: 232.4,
    ac_frequency: 50,
    power_a: 1200,
    power_b: 800,
    power_ab: 2000,
    current_a: 5.2,
    current_b: 3.4,
    power_factor_a: 98,
    power_factor_b: 95,
    energy_flow_a: "consuming",
    energy_flow_b: "producing",
    energy_a: 10,
    energy_b: 2,
    energy_produced_a: 1,
    energy_produced_b: 5,
    ...over,
  };
}

function lastPayload(dm: FakeDeviceManager, sid: string): Record<string, unknown> {
  const match = dm.updates.filter((u) => u.sid === sid);
  return match[match.length - 1]!.payload;
}

// ============================================================
// Pure helpers
// ============================================================

describe("isPj1203a", () => {
  it("matches on definition model or model id", () => {
    expect(isPj1203a("PJ-1203A", undefined)).toBe(true);
    expect(isPj1203a(undefined, "PJ-1203A")).toBe(true);
    expect(isPj1203a("TS0601", "_TZE204_other")).toBe(false);
    expect(isPj1203a(undefined, undefined)).toBe(false);
  });
});

describe("signPower", () => {
  it("applies the direction enum", () => {
    expect(signPower(1200, "consuming")).toBe(1200);
    expect(signPower(1200, "producing")).toBe(-1200);
  });

  it("normalises a reading whose sign contradicts the direction", () => {
    expect(signPower(-1200, "consuming")).toBe(1200);
  });

  it("passes the raw value through in Z2M signed-power mode", () => {
    // signed_power_a: true → energy_flow_a is the constant "sign"
    expect(signPower(-1200, "sign")).toBe(-1200);
    expect(signPower(1200, "sign")).toBe(1200);
    expect(signPower(-1200, null)).toBe(-1200);
  });

  it("keeps null when the device did not report power", () => {
    expect(signPower(null, "consuming")).toBeNull();
  });
});

describe("extractChannel", () => {
  it("slices channel A and converts the cumulative counters to Wh", () => {
    expect(extractChannel(state(), "a")).toEqual({
      power: 1200,
      voltage: 232.4,
      current: 5.2,
      powerFactor: 98,
      energyFlow: "consuming",
      energyForwardWh: 10000,
      energyReverseWh: 1000,
    });
  });

  it("slices channel B independently and signs a producing channel", () => {
    const b = extractChannel(state(), "b");
    expect(b.power).toBe(-800);
    expect(b.current).toBe(3.4);
    expect(b.energyForwardWh).toBe(2000);
    expect(b.energyReverseWh).toBe(5000);
  });

  it("mirrors the device-level voltage on both channels", () => {
    expect(extractChannel(state(), "a").voltage).toBe(232.4);
    expect(extractChannel(state(), "b").voltage).toBe(232.4);
  });

  it("rounds the kWh → Wh conversion instead of trailing float noise", () => {
    // 1234.56 kWh * 1000 is 1234560.0000000002 in IEEE 754
    expect(extractChannel(state({ energy_a: 1234.56 }), "a").energyForwardWh).toBe(1234560);
  });

  it("keeps nulls for fields the payload omits (partial / late-flow updates)", () => {
    const sample = extractChannel({ power_a: 500 }, "a");
    expect(sample.power).toBe(500);
    expect(sample.voltage).toBeNull();
    expect(sample.energyFlow).toBeNull();
    expect(sample.energyForwardWh).toBeNull();
  });

  it("does not surface the internal `sign` marker as a direction", () => {
    expect(extractChannel(state({ energy_flow_a: "sign" }), "a").energyFlow).toBeNull();
  });
});

// ============================================================
// Handler
// ============================================================

describe("Pj1203aHandler", () => {
  let dm: FakeDeviceManager;
  let handler: Pj1203aHandler;
  const sidA = channelSourceDeviceId("compteur", "a");
  const sidB = channelSourceDeviceId("compteur", "b");

  beforeEach(() => {
    dm = new FakeDeviceManager();
    handler = new Pj1203aHandler("zigbee2mqtt", "", dm, noopLogger);
  });

  it("prefixes the channel ids on a secondary network", () => {
    const prefixed = new Pj1203aHandler("zigbee2mqtt", "zigbee2mqtt_maison2/", dm, noopLogger);
    const ids = prefixed.discover(DEVICE);

    expect(ids).toEqual([
      channelSourceDeviceId("zigbee2mqtt_maison2/compteur", "a"),
      channelSourceDeviceId("zigbee2mqtt_maison2/compteur", "b"),
    ]);
    // State still arrives under the bare friendly name on MQTT.
    expect(prefixed.isKnown("compteur")).toBe(true);
  });

  it("registers one Sowel device per channel, Shelly-shaped", () => {
    const ids = handler.discover(DEVICE);

    expect(ids).toEqual([sidA, sidB]);
    expect(dm.upserts.map((u) => u.friendlyName)).toEqual([sidA, sidB]);
    expect(dm.upserts[0]!.model).toBe("PJ-1203A channel A");
    expect(dm.upserts[0]!.data.map((d) => d.key)).toEqual([
      "power",
      "voltage",
      "current",
      "power_factor",
      "energy_flow",
      "energy_forward",
      "energy_reverse",
      "energy",
    ]);
    // The categories core keys the energy pipeline on
    const byKey = Object.fromEntries(dm.upserts[0]!.data.map((d) => [d.key, d]));
    expect(byKey.power!.category).toBe("power");
    expect(byKey.energy!.category).toBe("energy");
    expect(byKey.energy!.unit).toBe("Wh");
  });

  it("routes each channel to its own device", () => {
    handler.discover(DEVICE);
    handler.handleState("compteur", state());

    expect(dm.updates.map((u) => u.sid)).toEqual([sidA, sidB]);
    expect(lastPayload(dm, sidA).power).toBe(1200);
    expect(lastPayload(dm, sidB).power).toBe(-800);
  });

  it("emits energy = 0 on the first report, anchoring the baseline", () => {
    handler.discover(DEVICE);
    handler.handleState("compteur", state());

    expect(lastPayload(dm, sidA)).toMatchObject({
      energy_forward: 10000,
      energy_reverse: 1000,
      energy: 0,
    });
  });

  it("emits the signed Wh delta between two reports, not the cumul", () => {
    handler.discover(DEVICE);
    handler.handleState("compteur", state());
    handler.handleState("compteur", state({ energy_a: 10.25, energy_b: 2, energy_produced_b: 5.4 }));

    // A consumed 0.25 kWh → +250 Wh
    expect(lastPayload(dm, sidA).energy).toBe(250);
    // B injected 0.4 kWh → -400 Wh
    expect(lastPayload(dm, sidB).energy).toBe(-400);
    // raw counters still forwarded for the Live page
    expect(lastPayload(dm, sidA).energy_forward).toBe(10250);
  });

  it("emits 0 when the counters do not move", () => {
    handler.discover(DEVICE);
    handler.handleState("compteur", state());
    handler.handleState("compteur", state());

    expect(lastPayload(dm, sidA).energy).toBe(0);
  });

  it("nets import against export within the same report", () => {
    handler.discover(DEVICE);
    handler.handleState("compteur", state());
    handler.handleState("compteur", state({ energy_a: 10.1, energy_produced_a: 1.03 }));

    // +100 Wh imported, 30 Wh exported → +70 Wh net
    expect(lastPayload(dm, sidA).energy).toBe(70);
  });

  it("re-anchors without a spike when a counter resets", () => {
    handler.discover(DEVICE);
    handler.handleState("compteur", state());
    handler.handleState("compteur", state({ energy_a: 0, energy_produced_a: 0 }));

    expect(lastPayload(dm, sidA).energy).toBe(0);

    handler.handleState("compteur", state({ energy_a: 0.5, energy_produced_a: 0 }));
    expect(lastPayload(dm, sidA).energy).toBe(500);
  });

  it("rehydrates the baseline from device_data so a restart credits nothing", () => {
    dm.persisted.set(`${sidA}/energy_forward`, 10000);
    dm.persisted.set(`${sidA}/energy_reverse`, 1000);
    handler.discover(DEVICE);

    handler.handleState("compteur", state({ energy_a: 10.1 }));

    expect(lastPayload(dm, sidA).energy).toBe(100);
  });

  it("mirrors availability onto both channels", () => {
    handler.discover(DEVICE);
    handler.handleAvailability("compteur", "offline");

    expect(dm.statuses).toEqual([
      { sid: sidA, status: "offline" },
      { sid: sidB, status: "offline" },
    ]);
  });

  it("ignores state and availability for a friendly name it never discovered", () => {
    handler.handleState("inconnu", state());
    handler.handleAvailability("inconnu", "online");

    expect(dm.updates).toHaveLength(0);
    expect(dm.statuses).toHaveLength(0);
  });

  it("forgets meters removed from the Zigbee network", () => {
    handler.discover(DEVICE);
    handler.retainOnly(new Set());

    expect(handler.isKnown("compteur")).toBe(false);
    handler.handleState("compteur", state());
    expect(dm.updates).toHaveLength(0);
  });
});
