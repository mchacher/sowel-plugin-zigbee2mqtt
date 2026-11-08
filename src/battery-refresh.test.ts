import { describe, it, expect } from "vitest";
import {
  BatteryRefresher,
  BATTERY_READ_PAYLOAD,
  BRIDGE_RESTART_GRACE_MS,
  MIN_SPACING_MS,
  parseRefreshHours,
  reportsPowerCfg,
  type PowerCfgDevice,
} from "./battery-refresh.js";
import { Zigbee2MqttParser } from "./z2m-parser.js";

const logger = { child: () => logger, info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any;
const HOUR = 3_600_000;

/** A Tuya IH012-RT01 as bridge/devices describes it. */
const pir = (name: string): PowerCfgDevice => ({
  friendly_name: name,
  power_source: "Battery",
  endpoints: {
    "1": {
      bindings: [{ cluster: "genPowerCfg" }],
      configured_reportings: [{ cluster: "genPowerCfg" }],
    },
  },
});

function makeRefresher(hours = 24) {
  let now = 1_000_000;
  const reads: string[] = [];
  const refresher = new BatteryRefresher(hours, (name) => reads.push(name), logger, () => now);
  return { refresher, reads, advance: (ms: number) => { now += ms; } };
}

describe("reportsPowerCfg", () => {
  it("accepts a battery device with genPowerCfg bound or reported", () => {
    expect(reportsPowerCfg(pir("pir"))).toBe(true);
    expect(reportsPowerCfg({
      friendly_name: "x", power_source: "Battery",
      endpoints: { "1": { configured_reportings: [{ cluster: "genPowerCfg" }] } },
    })).toBe(true);
  });

  it("leaves out Xiaomi-style devices with no genPowerCfg", () => {
    expect(reportsPowerCfg({
      friendly_name: "aqara", power_source: "Battery",
      endpoints: { "1": { bindings: [], configured_reportings: [] } },
    })).toBe(false);
    expect(reportsPowerCfg({ friendly_name: "old", power_source: "Battery" })).toBe(false);
  });

  it("leaves out mains devices", () => {
    expect(reportsPowerCfg({ ...pir("plug"), power_source: "Mains (single phase)" })).toBe(false);
  });
});

describe("parseRefreshHours", () => {
  it("defaults to 24 when unset or invalid", () => {
    expect(parseRefreshHours(undefined)).toBe(24);
    expect(parseRefreshHours("")).toBe(24);
    expect(parseRefreshHours("abc")).toBe(24);
    expect(parseRefreshHours("-3")).toBe(24);
  });

  it("keeps 0 (off) and any positive value", () => {
    expect(parseRefreshHours("0")).toBe(0);
    expect(parseRefreshHours("6")).toBe(6);
  });
});

describe("BatteryRefresher", () => {
  it("reads an eligible device on its first wake-up", () => {
    const { refresher, reads } = makeRefresher();
    refresher.learn([pir("pir")]);
    refresher.onWake("pir");
    expect(reads).toEqual(["pir"]);
  });

  it("ignores devices that are not eligible", () => {
    const { refresher, reads } = makeRefresher();
    refresher.learn([pir("pir"), { friendly_name: "aqara", power_source: "Battery" }]);
    refresher.onWake("aqara");
    refresher.onWake("unknown");
    expect(reads).toEqual([]);
  });

  it("reads a device again only once the interval has elapsed", () => {
    const { refresher, reads, advance } = makeRefresher(24);
    refresher.learn([pir("pir")]);
    refresher.onWake("pir");
    // The answer is itself a state message: it must not trigger another read.
    advance(1_000);
    refresher.onWake("pir");
    advance(23 * HOUR);
    refresher.onWake("pir");
    expect(reads).toEqual(["pir"]);

    advance(HOUR);
    refresher.onWake("pir");
    expect(reads).toEqual(["pir", "pir"]);
  });

  it("spaces reads on one network, and catches the skipped device later", () => {
    const { refresher, reads, advance } = makeRefresher();
    refresher.learn([pir("a"), pir("b")]);
    refresher.onWake("a");
    refresher.onWake("b");
    expect(reads).toEqual(["a"]);

    advance(MIN_SPACING_MS);
    refresher.onWake("b");
    expect(reads).toEqual(["a", "b"]);
  });

  it("ignores the cached-state replay after the bridge restarts", () => {
    const { refresher, reads, advance } = makeRefresher();
    refresher.learn([pir("pir")]);
    refresher.bridgeRestarted();
    refresher.onWake("pir");
    expect(reads).toEqual([]);

    advance(BRIDGE_RESTART_GRACE_MS);
    refresher.onWake("pir");
    expect(reads).toEqual(["pir"]);
  });

  it("does nothing when disabled (0 hours)", () => {
    const { refresher, reads } = makeRefresher(0);
    refresher.learn([pir("pir")]);
    refresher.onWake("pir");
    expect(refresher.enabled).toBe(false);
    expect(reads).toEqual([]);
  });

  it("forgets a device removed from the network", () => {
    const { refresher, reads, advance } = makeRefresher();
    refresher.learn([pir("pir")]);
    refresher.onWake("pir");
    refresher.learn([]);
    advance(MIN_SPACING_MS);
    refresher.onWake("pir");
    expect(reads).toEqual(["pir"]);
  });
});

describe("parser wiring (issue #23)", () => {
  function makeParser(baseTopic: string, devicePrefix: string, batteryRefreshHours?: number) {
    const handlers = new Map<string, (topic: string, payload: Buffer) => void>();
    const published: { topic: string; payload: string }[] = [];
    const mqtt = {
      subscribe: (pattern: string, handler: (topic: string, payload: Buffer) => void) => {
        handlers.set(pattern, handler);
      },
      publish: (topic: string, payload: string) => published.push({ topic, payload }),
      isConnected: () => true,
    };
    const deviceManager = {
      upsertFromDiscovery: () => {},
      updateDeviceData: () => {},
      updateDeviceStatus: () => {},
      removeStaleDevices: () => {},
      logSummary: () => {},
    };
    const parser = new Zigbee2MqttParser({
      integrationId: "zigbee2mqtt",
      baseTopic,
      devicePrefix,
      mqttConnector: mqtt as any,
      deviceManager: deviceManager as any,
      registry: { report: () => {} } as any,
      logger,
      batteryRefreshHours,
    });
    parser.start();
    const send = (topic: string, payload: unknown) => {
      const pattern = topic.startsWith(`${baseTopic}/bridge/`) ? topic : `${baseTopic}/+`;
      handlers.get(pattern)!(topic, Buffer.from(JSON.stringify(payload)));
    };
    const devices = [{
      ...pir("Tuya_PIR_07"),
      ieee_address: "0xa4c1",
      type: "EndDevice",
      supported: true,
      disabled: false,
      definition: { model: "IH012-RT01", vendor: "Tuya", description: "", exposes: [] },
    }];
    send(`${baseTopic}/bridge/devices`, devices);
    return { send, published };
  }

  it("publishes the read on the device's own network when it wakes up", () => {
    const { send, published } = makeParser("zigbee2mqtt_m2", "m2/");
    send("zigbee2mqtt_m2/Tuya_PIR_07", { occupancy: true, battery: 11 });
    expect(published).toEqual([
      { topic: "zigbee2mqtt_m2/Tuya_PIR_07/set", payload: BATTERY_READ_PAYLOAD },
    ]);
  });

  it("publishes nothing when the setting is 0", () => {
    const { send, published } = makeParser("zigbee2mqtt", "", 0);
    send("zigbee2mqtt/Tuya_PIR_07", { occupancy: true });
    expect(published).toEqual([]);
  });

  it("holds reads during the replay that follows a bridge restart", () => {
    const { send, published } = makeParser("zigbee2mqtt", "");
    send("zigbee2mqtt/bridge/state", { state: "online" });
    send("zigbee2mqtt/bridge/state", { state: "offline" });
    send("zigbee2mqtt/bridge/state", { state: "online" });
    send("zigbee2mqtt/Tuya_PIR_07", { occupancy: false });
    expect(published).toEqual([]);
  });
});
