import { describe, expect, it, vi } from "vitest";
import { isPilotWireExpose, pilotModeToSowel, pilotPayloadToSowel, pilotPayloadToZ2m } from "./pilot-wire.js";
import { Zigbee2MqttParser } from "./z2m-parser.js";
import { createPlugin } from "./index.js";

const PAIRS = [
  ["comfort", "comfort"],
  ["comfort_-1", "comfort_minus_1"],
  ["comfort_-2", "comfort_minus_2"],
  ["eco", "eco"],
  ["frost_protection", "frost_protection"],
  ["off", "off"],
] as const;

const logger: any = { child: () => logger, info() {}, warn() {}, error() {}, debug() {} };

describe("pilot-wire values", () => {
  it.each(PAIRS)("%s <-> %s", (z2m, sowel) => {
    expect(pilotModeToSowel(z2m)).toBe(sowel);
    expect(pilotPayloadToSowel({ pilot_wire_mode: z2m })).toEqual({ pilot_wire_mode: sowel });
    expect(pilotPayloadToZ2m({ pilot_wire_mode: sowel })).toEqual({ pilot_wire_mode: z2m });
  });

  it("passes an unknown value, a non-string and any other key through", () => {
    for (const p of [
      { pilot_wire_mode: "unknown" },
      { pilot_wire_mode: null },
      { other: "comfort_-1" },
      { pilot_wire_mode: "toString" },
    ]) {
      expect(pilotPayloadToSowel(p)).toEqual(p);
      expect(pilotPayloadToZ2m(p)).toEqual(p);
    }
  });
});

describe("isPilotWireExpose", () => {
  const expose = (values?: string[], type = "enum", property = "pilot_wire_mode") =>
    isPilotWireExpose({ type, property, values });

  it("accepts the preset and a subset of it", () => {
    expect(expose(PAIRS.map(([z2m]) => z2m))).toBe(true);
    expect(expose(["comfort", "eco", "frost_protection", "off"])).toBe(true);
  });

  it("refuses another vocabulary (Thaleos TWC-R01), no values, another type or key", () => {
    expect(expose(["comfort", "eco", "antifrost", "off", "comfort_1", "comfort_2"])).toBe(false);
    expect(expose()).toBe(false);
    expect(expose([])).toBe(false);
    expect(expose(["eco"], "text")).toBe(false);
    expect(expose(["eco"], "enum", "mode")).toBe(false);
  });
});

describe("pilot-wire module in the parser", () => {
  const handlers = new Map<string, (topic: string, payload: Buffer) => void>();
  const upsertFromDiscovery = vi.fn();
  const updateDeviceData = vi.fn();
  new Zigbee2MqttParser({
    integrationId: "zigbee2mqtt",
    baseTopic: "z2m",
    devicePrefix: "",
    mqttConnector: {
      subscribe: (p: string, h: (topic: string, payload: Buffer) => void) => handlers.set(p, h),
      publish: () => true,
      isConnected: () => true,
    } as any,
    deviceManager: {
      upsertFromDiscovery,
      updateDeviceData,
      updateDeviceStatus() {},
      logSummary() {},
    } as any,
    registry: { report() {} } as any,
    logger,
  }).start();

  handlers.get("z2m/bridge/devices")!(
    "z2m/bridge/devices",
    Buffer.from(
      JSON.stringify([
        {
          ieee_address: "0x1",
          friendly_name: "rad",
          type: "Router",
          supported: true,
          disabled: false,
          definition: {
            model: "SIN-4-FP-21",
            vendor: "NodOn",
            exposes: [
              {
                type: "switch",
                features: [
                  { type: "binary", property: "state", access: 7, value_on: "ON", value_off: "OFF" },
                ],
              },
              { type: "enum", property: "mode", access: 7, values: ["comfort_-1"] },
              {
                type: "enum",
                property: "pilot_wire_mode",
                access: 7,
                values: PAIRS.map(([z2m]) => z2m),
              },
            ],
          },
        },
      ]),
    ),
  );
  const device = upsertFromDiscovery.mock.calls[0][2];
  const sowelValues = PAIRS.map(([, sowel]) => sowel);

  it("declares the categories and Sowel's values", () => {
    const by = (list: any[], key: string) => list.find((x) => x.key === key);
    expect(by(device.data, "pilot_wire_mode")).toMatchObject({
      type: "enum",
      category: "pilot_wire_mode",
      enumValues: sowelValues,
    });
    expect(by(device.orders, "pilot_wire_mode")).toMatchObject({
      category: "set_pilot_wire_mode",
      enumValues: sowelValues,
    });
  });

  it("leaves the state and the other enums alone", () => {
    const order = (key: string) => device.orders.find((o: any) => o.key === key);
    expect(order("state").category).toBe("light_toggle");
    expect(order("mode").enumValues).toEqual(["comfort_-1"]);
  });

  it("translates a state message", () => {
    handlers.get("z2m/+")!(
      "z2m/rad",
      Buffer.from(JSON.stringify({ pilot_wire_mode: "comfort_-2", state: "ON" })),
    );
    expect(updateDeviceData).toHaveBeenCalledWith("zigbee2mqtt", "rad", {
      pilot_wire_mode: "comfort_minus_2",
      state: "ON",
    });
  });
});

describe("pilot-wire order", () => {
  it("is published in Zigbee2MQTT's words, on that key only", async () => {
    const publish = vi.fn();
    const plugin: any = createPlugin({
      logger,
      eventBus: { emit() {} },
      settingsManager: { get: () => undefined },
      deviceManager: {},
      pluginDir: "/tmp/plugin",
    } as any);
    plugin.mqttConnector = { isConnected: () => true, publish };
    plugin.topics = [{ baseTopic: "z2m", prefix: "" }];
    const device: any = { sourceDeviceId: "rad" };
    await plugin.executeOrder(device, "pilot_wire_mode", "comfort_minus_1");
    await plugin.executeOrder(device, "mode", "comfort_minus_1");
    expect(publish.mock.calls.map(([, p]) => JSON.parse(p))).toEqual([
      { pilot_wire_mode: "comfort_-1" },
      { mode: "comfort_minus_1" },
    ]);
  });
});
