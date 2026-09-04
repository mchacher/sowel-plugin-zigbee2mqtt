import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { createPlugin } from "./index.js";

/**
 * Plugin-level companion to mqtt-connector.test.ts for #19: the connector now
 * reports every connection transition, and the plugin must translate that into
 * getStatus() for its whole lifetime, including across a stop/start cycle.
 */

class FakeMqttClient extends EventEmitter {
  connected = false;
  subscribe(_topic: string, cb: (err: Error | null) => void): void {
    cb(this.connected ? null : new Error("Connection closed"));
  }
  publish(_topic: string, _payload: unknown, cb?: (err: Error | null) => void): void {
    cb?.(null);
  }
  async endAsync(): Promise<void> {
    this.connected = false;
  }
}

/** Every mqtt.connect() call pushes a new client, so a restart gets a fresh one. */
let clients: FakeMqttClient[] = [];

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => {
      const client = new FakeMqttClient();
      clients.push(client);
      return client;
    }),
  },
}));

/** Throws on one specific message, to simulate a start() failing after connect(). */
function makeLogger(throwOnMessage?: string) {
  const fail = (...args: unknown[]) => {
    const msg = typeof args[0] === "string" ? args[0] : args[1];
    if (throwOnMessage && msg === throwOnMessage) throw new Error("boom");
  };
  const logger = {
    child: () => logger,
    info: vi.fn(fail),
    warn: vi.fn(fail),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return logger;
}

function makeDeps(logger: ReturnType<typeof makeLogger>) {
  return {
    logger,
    eventBus: { emit: vi.fn() },
    settingsManager: {
      get: (key: string) =>
        key === "integration.zigbee2mqtt.mqtt_url" ? "mqtt://broker:1883" : undefined,
    },
    deviceManager: {
      upsertFromDiscovery: vi.fn(),
      updateDeviceData: vi.fn(),
      updateDeviceStatus: vi.fn(),
      removeStaleDevices: vi.fn(),
      logSummary: vi.fn(),
    },
    pluginDir: "/tmp/plugin",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makePlugin(logger = makeLogger()): any {
  // createPlugin's deps are structurally typed against the plugin's own local
  // interfaces, which the stubs above satisfy.
  return createPlugin(makeDeps(logger) as never);
}

describe("Zigbee2MQTT plugin status", () => {
  beforeEach(() => {
    clients = [];
  });

  it("recovers to connected when the broker only answers after start() returned", async () => {
    const plugin = makePlugin();

    // Boot-time race: the broker is unreachable, mqtt.js fires "error" first
    // and connect() resolves on it, so start() completes while still offline.
    const starting = plugin.start();
    clients[0].emit("error", new Error("EHOSTUNREACH"));
    await starting;
    expect(plugin.getStatus()).toBe("disconnected");

    // The socket comes up a few seconds later. Before #19 this was invisible
    // to the plugin and the integration stayed disconnected forever.
    clients[0].connected = true;
    clients[0].emit("connect");
    expect(plugin.getStatus()).toBe("connected");

    clients[0].connected = false;
    clients[0].emit("offline");
    expect(plugin.getStatus()).toBe("disconnected");

    await plugin.stop();
  });

  it("ignores the old client's events after a stop/start cycle", async () => {
    const plugin = makePlugin();

    const starting = plugin.start();
    clients[0].connected = true;
    clients[0].emit("connect");
    await starting;
    expect(plugin.getStatus()).toBe("connected");

    await plugin.stop();

    const restarting = plugin.start();
    clients[1].connected = true;
    clients[1].emit("connect");
    await restarting;
    expect(plugin.getStatus()).toBe("connected");

    // The abandoned client can still emit for a while; it must not report on
    // behalf of the connection the plugin actually uses now.
    clients[0].emit("offline");
    expect(plugin.getStatus()).toBe("connected");

    await plugin.stop();
  });

  it("does not let a later reconnect paper over a start() that failed", async () => {
    const plugin = makePlugin(makeLogger("Zigbee2MQTT started"));

    const starting = plugin.start();
    clients[0].connected = true;
    clients[0].emit("connect");
    await starting;
    expect(plugin.getStatus()).toBe("error");

    clients[0].emit("offline");
    clients[0].emit("connect");
    expect(plugin.getStatus()).toBe("error");

    await plugin.stop();
  });
});
