import { describe, it, expect } from "vitest";
import { inferCategory, inferOrderCategory, mapPowerSource } from "./z2m-parser.js";

describe("inferCategory", () => {
  it("maps a contact sensor to contact_door (recognised by core for open/closed + openDoors)", () => {
    // Regression: previously mapped to "contact", which core does not recognise,
    // so gate open/closed state and the zone openDoors count stayed empty.
    expect(inferCategory("contact", new Set(["contact", "battery"]))).toBe("contact_door");
  });

  it("keeps the other common mappings", () => {
    expect(inferCategory("occupancy", new Set(["occupancy"]))).toBe("motion");
    expect(inferCategory("temperature", new Set(["temperature", "humidity"]))).toBe("temperature");
    expect(inferCategory("illuminance", new Set(["illuminance"]))).toBe("luminosity");
    expect(inferCategory("linkquality", new Set(["linkquality"]))).toBe("generic");
  });

  it("resolves `state` by context", () => {
    expect(inferCategory("state", new Set(["state"]), "switch")).toBe("light_state");
    expect(inferCategory("state", new Set(["state", "brightness"]))).toBe("light_state");
    expect(inferCategory("state", new Set(["state"]))).toBe("generic");
  });

  it("treats a top-level binary `state` as a relay (Tuya WHD02 & co.)", () => {
    // No switch grouping, no light siblings, but binary ON/OFF → relay.
    expect(inferCategory("state", new Set(["state"]), undefined, "binary")).toBe("light_state");
  });

  it("treats endpoint-suffixed binary `state_lN` channels as relays", () => {
    expect(inferCategory("state_l1", new Set(["state_l1", "state_l2"]), undefined, "binary")).toBe(
      "light_state",
    );
    expect(inferCategory("state_left", new Set(["state_left"]), undefined, "binary")).toBe(
      "light_state",
    );
  });

  it("does NOT relay-classify an enum `state` (cover / appliance)", () => {
    // OPEN/CLOSE/STOP or run/pause come through as enum, must stay generic.
    expect(inferCategory("state", new Set(["state"]), undefined, "enum")).toBe("generic");
    expect(inferCategory("state_x", new Set(["state_x"]), undefined, "enum")).toBe("generic");
  });
});

describe("inferOrderCategory", () => {
  it("keeps existing switch/light and cover behavior", () => {
    expect(inferOrderCategory("state", new Set(["state"]), "switch")).toBe("light_toggle");
    expect(inferOrderCategory("state", new Set(["state"]), "cover")).toBe("shutter_move");
    expect(inferOrderCategory("state", new Set(["state", "brightness"]))).toBe("light_toggle");
    expect(inferOrderCategory("state", new Set(["state"]))).toBeUndefined();
  });

  it("makes a top-level binary `state` an on-off command (the WHD02 fix)", () => {
    // This is what gives the device a `light_toggle` order, which the core
    // on/off candidate rule requires to bind it to a light/switch equipment.
    expect(inferOrderCategory("state", new Set(["state"]), undefined, "binary")).toBe(
      "light_toggle",
    );
    expect(inferOrderCategory("state_l1", new Set(["state_l1"]), undefined, "binary")).toBe(
      "light_toggle",
    );
  });

  it("leaves an enum `state` without a relay order category", () => {
    expect(inferOrderCategory("state", new Set(["state"]), undefined, "enum")).toBeUndefined();
  });
});

// ============================================================
// Discovery: binary wire values on orders (issue #4)
// ============================================================

import { Zigbee2MqttParser } from "./z2m-parser.js";

function runDiscovery(z2mDevices: unknown[]): any[] {
  const handlers = new Map<string, (topic: string, payload: Buffer) => void>();
  const mqtt = {
    subscribe: (pattern: string, handler: (topic: string, payload: Buffer) => void) => {
      handlers.set(pattern, handler);
    },
    publish: () => {},
    isConnected: () => true,
  };
  const discovered: any[] = [];
  const deviceManager = {
    upsertFromDiscovery: (_id: string, _src: string, d: unknown) => discovered.push(d),
    updateDeviceData: () => {},
    updateDeviceStatus: () => {},
    removeStaleDevices: () => {},
    logSummary: () => {},
  };
  const logger = {
    child: () => logger,
    info: () => {},
    error: () => {},
  } as any;
  const parser = new Zigbee2MqttParser({
    integrationId: "zigbee2mqtt",
    baseTopic: "z2m",
    devicePrefix: "",
    mqttConnector: mqtt as any,
    deviceManager: deviceManager as any,
    registry: { report: () => {} } as any,
    logger,
  });
  parser.start();
  handlers.get("z2m/bridge/devices")!("z2m/bridge/devices", Buffer.from(JSON.stringify(z2mDevices)));
  return discovered;
}

describe("discovery order wire values (issue #4)", () => {
  const device = (exposes: unknown[]) => ({
    ieee_address: "0xabc",
    friendly_name: "relay",
    type: "Router",
    supported: true,
    disabled: false,
    definition: { model: "WHD02", vendor: "Tuya", exposes },
  });

  it("propagates value_on/value_off from a binary expose onto the order", () => {
    const [d] = runDiscovery([
      device([
        { type: "binary", property: "state", access: 7, value_on: "ON", value_off: "OFF" },
      ]),
    ]);
    const order = d.orders.find((o: any) => o.key === "state");
    expect(order.valueOn).toBe("ON");
    expect(order.valueOff).toBe("OFF");
  });

  it("keeps literal boolean wire values as booleans", () => {
    const [d] = runDiscovery([
      device([
        { type: "binary", property: "led_night", access: 7, value_on: true, value_off: false },
      ]),
    ]);
    const order = d.orders.find((o: any) => o.key === "led_night");
    expect(order.valueOn).toBe(true);
    expect(order.valueOff).toBe(false);
  });

  it("leaves wire values undefined on non-binary orders", () => {
    const [d] = runDiscovery([
      device([
        { type: "numeric", property: "brightness", access: 7, value_min: 0, value_max: 254 },
      ]),
    ]);
    const order = d.orders.find((o: any) => o.key === "brightness");
    expect(order.valueOn).toBeUndefined();
    expect(order.valueOff).toBeUndefined();
  });
});

// ============================================================
// Availability gating on bridge/info (stale retained topics)
// ============================================================

import { availabilityEnabledFromBridgeInfo, parseBridgeState } from "./z2m-parser.js";

function makeParser() {
  const handlers = new Map<string, (topic: string, payload: Buffer) => void>();
  const statusUpdates: { name: string; status: string }[] = [];
  const mqtt = {
    subscribe: (pattern: string, handler: (topic: string, payload: Buffer) => void) => {
      handlers.set(pattern, handler);
    },
    publish: () => {},
    isConnected: () => true,
  };
  const deviceManager = {
    upsertFromDiscovery: () => {},
    updateDeviceData: () => {},
    updateDeviceStatus: (_id: string, name: string, status: string) => {
      statusUpdates.push({ name, status });
    },
    removeStaleDevices: () => {},
    logSummary: () => {},
  };
  const logger = { child: () => logger, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;
  const parser = new Zigbee2MqttParser({
    integrationId: "zigbee2mqtt",
    baseTopic: "z2m",
    devicePrefix: "",
    mqttConnector: mqtt as any,
    deviceManager: deviceManager as any,
    registry: { report: () => {} } as any,
    logger,
  });
  parser.start();
  // Bridge topics are subscribed under their exact name, devices under a wildcard.
  const send = (topic: string, payload: unknown) =>
    (handlers.get(topic) ?? handlers.get("z2m/+/availability")!)(
      topic,
      Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)),
    );
  return { send, statusUpdates };
}

/** Minimal bridge/devices entry — one relay, enough to be discovered. */
const relayDevice = (friendlyName: string) => ({
  friendly_name: friendlyName,
  ieee_address: `0x${friendlyName}`,
  type: "Router",
  supported: true,
  definition: {
    model: "WHD02",
    vendor: "Tuya",
    exposes: [{ type: "binary", property: "state", access: 7, value_on: "ON", value_off: "OFF" }],
  },
});

describe("availability gating on bridge/info", () => {
  const info = (availability: unknown) => ({ version: "2.4.0", config: { availability } });

  it("honors availability when the feature is enabled", () => {
    const { send, statusUpdates } = makeParser();
    send("z2m/bridge/info", info({ enabled: true }));
    send("z2m/relay/availability", { state: "offline" });
    expect(statusUpdates).toEqual([{ name: "relay", status: "offline" }]);
  });

  it("ignores stale retained availability when the feature is disabled", () => {
    const { send, statusUpdates } = makeParser();
    send("z2m/bridge/info", info({ enabled: false }));
    send("z2m/relay/availability", { state: "offline" });
    expect(statusUpdates).toEqual([]);
  });

  it("queues availability seen before bridge/info, replays if enabled", () => {
    const { send, statusUpdates } = makeParser();
    send("z2m/relay/availability", { state: "offline" });
    expect(statusUpdates).toEqual([]);
    send("z2m/bridge/info", info({ enabled: true }));
    expect(statusUpdates).toEqual([{ name: "relay", status: "offline" }]);
  });

  it("queues availability seen before bridge/info, drops if disabled", () => {
    const { send, statusUpdates } = makeParser();
    send("z2m/relay/availability", { state: "offline" });
    send("z2m/bridge/info", info({ enabled: false }));
    expect(statusUpdates).toEqual([]);
  });

  it("follows a live enable of the feature", () => {
    const { send, statusUpdates } = makeParser();
    send("z2m/bridge/info", info({ enabled: false }));
    send("z2m/relay/availability", { state: "offline" });
    send("z2m/bridge/info", info({ enabled: true }));
    send("z2m/relay/availability", { state: "online" });
    expect(statusUpdates).toEqual([{ name: "relay", status: "online" }]);
  });
});

// ============================================================
// A dead Z2M instance (bridge/state / MQTT last will)
// ============================================================

describe("bridge/state", () => {
  const devices = [relayDevice("relay"), relayDevice("lamp")];

  it("marks every device of the network offline when the bridge dies", () => {
    const { send, statusUpdates } = makeParser();
    send("z2m/bridge/state", { state: "online" });
    send("z2m/bridge/devices", devices);
    statusUpdates.length = 0;

    send("z2m/bridge/state", { state: "offline" });

    expect(statusUpdates).toEqual([
      { name: "relay", status: "offline" },
      { name: "lamp", status: "offline" },
    ]);
  });

  it("does not claim devices are back before they say so", () => {
    const { send, statusUpdates } = makeParser();
    send("z2m/bridge/devices", devices);
    send("z2m/bridge/state", { state: "offline" });
    statusUpdates.length = 0;

    send("z2m/bridge/state", { state: "online" });

    // Z2M republishes cached states and availability on startup; those messages
    // are what brings a device back, not the bridge coming up.
    expect(statusUpdates).toEqual([]);
  });

  it("applies a bridge already down to devices discovered afterwards", () => {
    // Both topics are retained, so bridge/state can land first on resubscribe.
    const { send, statusUpdates } = makeParser();
    send("z2m/bridge/state", { state: "offline" });
    expect(statusUpdates).toEqual([]);

    send("z2m/bridge/devices", devices);

    expect(statusUpdates).toEqual([
      { name: "relay", status: "offline" },
      { name: "lamp", status: "offline" },
    ]);
  });

  it("is independent of the availability feature being disabled", () => {
    // The case that has no other offline signal at all.
    const { send, statusUpdates } = makeParser();
    send("z2m/bridge/info", { version: "2.4.0", config: { availability: { enabled: false } } });
    send("z2m/bridge/devices", devices);
    send("z2m/relay/availability", { state: "offline" });
    expect(statusUpdates).toEqual([]);

    send("z2m/bridge/state", { state: "offline" });

    expect(statusUpdates).toEqual([
      { name: "relay", status: "offline" },
      { name: "lamp", status: "offline" },
    ]);
  });

  it("ignores repeated states so a retained redelivery is not a status storm", () => {
    const { send, statusUpdates } = makeParser();
    send("z2m/bridge/devices", devices);
    send("z2m/bridge/state", { state: "offline" });
    statusUpdates.length = 0;

    send("z2m/bridge/state", { state: "offline" });

    expect(statusUpdates).toEqual([]);
  });
});

describe("parseBridgeState", () => {
  it("reads the Z2M 2.x object shape", () => {
    expect(parseBridgeState('{"state":"offline"}')).toBe("offline");
    expect(parseBridgeState('{"state":"online"}')).toBe("online");
  });

  it("reads the legacy 1.x bare string", () => {
    expect(parseBridgeState("offline")).toBe("offline");
    expect(parseBridgeState(" online ")).toBe("online");
    expect(parseBridgeState('"offline"')).toBe("offline");
  });

  it("ignores anything it does not recognise", () => {
    expect(parseBridgeState("")).toBeNull();
    expect(parseBridgeState("{}")).toBeNull();
    expect(parseBridgeState('{"state":"weird"}')).toBeNull();
  });
});

describe("availabilityEnabledFromBridgeInfo", () => {
  it("reads Z2M 2.x shape", () => {
    expect(availabilityEnabledFromBridgeInfo({ config: { availability: { enabled: false, active: {} } } })).toBe(false);
    expect(availabilityEnabledFromBridgeInfo({ config: { availability: { enabled: true } } })).toBe(true);
  });

  it("reads legacy 1.x shapes", () => {
    expect(availabilityEnabledFromBridgeInfo({ config: { availability: true } })).toBe(true);
    expect(availabilityEnabledFromBridgeInfo({ config: { availability: false } })).toBe(false);
    expect(availabilityEnabledFromBridgeInfo({ config: { availability: { active: { timeout: 10 } } } })).toBe(true);
  });

  it("treats absent config as disabled", () => {
    expect(availabilityEnabledFromBridgeInfo({ config: {} })).toBe(false);
    expect(availabilityEnabledFromBridgeInfo({})).toBe(false);
    expect(availabilityEnabledFromBridgeInfo(null)).toBe(false);
  });
});

describe("mapPowerSource", () => {
  it("maps the values Zigbee2MQTT actually publishes", () => {
    expect(mapPowerSource("Battery")).toBe("battery");
    expect(mapPowerSource("Mains (single phase)")).toBe("mains");
    expect(mapPowerSource("Mains (3 phase)")).toBe("mains");
    expect(mapPowerSource("DC Source")).toBe("dc");
  });

  it("reads the emergency-mains variants as mains — they are not battery-run", () => {
    expect(mapPowerSource("Emergency mains and transfer switch")).toBe("mains");
    expect(mapPowerSource("Emergency mains constantly powered")).toBe("mains");
  });

  it("stays unknown when absent or unrecognised, so Sowel keeps its own heuristic", () => {
    expect(mapPowerSource(undefined)).toBe("unknown");
    expect(mapPowerSource("")).toBe("unknown");
    expect(mapPowerSource("Unknown")).toBe("unknown");
  });
});

describe("battery_low", () => {
  it("is NOT categorised battery — it is a boolean, that category means a percentage", () => {
    // v2.5.0 mapped it to "battery" for spec 143. Core then logs
    // "Declared data type contradicts category contract" on every discovery
    // (battery expects number, this is boolean), and its device list picks the
    // first category === "battery" row, so a ZP01 showed the flag instead of a
    // level. The monitor matches by key, so "generic" loses nothing.
    expect(inferCategory("battery_low", new Set(["battery_low", "occupancy"]))).toBe("generic");
  });

  it("still leaves a real battery percentage on the battery category", () => {
    expect(inferCategory("battery", new Set(["battery", "battery_low"]))).toBe("battery");
  });
});
