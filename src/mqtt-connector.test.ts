import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { MqttConnector } from "./mqtt-connector.js";

/**
 * Regression coverage for mchacher/sowel-plugin-zigbee2mqtt#19: a broker
 * unreachable at boot (EHOSTUNREACH) used to leave the plugin permanently
 * stuck reporting disconnected, with live subscriptions silently lost,
 * even though the underlying socket connected moments later.
 */

class FakeMqttClient extends EventEmitter {
  connected = false;
  subscribeCalls: string[] = [];
  subscribe(topic: string, cb: (err: Error | null) => void): void {
    this.subscribeCalls.push(topic);
    cb(this.connected ? null : new Error("Connection closed"));
  }
  publish(_topic: string, _payload: unknown, cb?: (err: Error | null) => void): void {
    cb?.(null);
  }
  async endAsync(): Promise<void> {
    this.connected = false;
  }
}

let fakeClient: FakeMqttClient;

vi.mock("mqtt", () => ({
  default: { connect: vi.fn(() => fakeClient) },
}));

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("MqttConnector", () => {
  beforeEach(() => {
    fakeClient = new FakeMqttClient();
  });

  it("does not send a subscribe to the broker while the client isn't actually connected yet", async () => {
    const connector = new MqttConnector(
      "mqtt://broker",
      { clientId: "test" },
      { emit: vi.fn() },
      makeLogger(),
      "test-integration",
    );

    // Simulates the boot-time race: the broker isn't reachable yet, so
    // mqtt.js fires "error" before ever firing "connect" — connect()
    // resolves on that first outcome, same as the real client.
    const connectPromise = connector.connect();
    fakeClient.emit("error", new Error("EHOSTUNREACH"));
    await connectPromise;

    // The plugin's start() sequence registers its topic handlers right
    // after connect() resolves, exactly like this — at this point the
    // socket is still not connected.
    connector.subscribe("bridge/devices", vi.fn());

    expect(fakeClient.subscribeCalls).toEqual([]);
  });

  it("resubscribes every previously-registered pattern once the real connect fires", async () => {
    const connector = new MqttConnector(
      "mqtt://broker",
      { clientId: "test" },
      { emit: vi.fn() },
      makeLogger(),
      "test-integration",
    );

    const connectPromise = connector.connect();
    fakeClient.emit("error", new Error("EHOSTUNREACH"));
    await connectPromise;

    connector.subscribe("bridge/devices", vi.fn());
    connector.subscribe("zigbee2mqtt/+", vi.fn());
    expect(fakeClient.subscribeCalls).toEqual([]);

    // Broker comes up a few seconds later — the real, later "connect".
    fakeClient.connected = true;
    fakeClient.emit("connect");

    expect(fakeClient.subscribeCalls.sort()).toEqual(["bridge/devices", "zigbee2mqtt/+"].sort());
  });

  it("routes an incoming message to a handler that was registered before the client connected", async () => {
    const connector = new MqttConnector(
      "mqtt://broker",
      { clientId: "test" },
      { emit: vi.fn() },
      makeLogger(),
      "test-integration",
    );

    const connectPromise = connector.connect();
    fakeClient.emit("error", new Error("EHOSTUNREACH"));
    await connectPromise;

    const handler = vi.fn();
    connector.subscribe("bridge/devices", handler);

    fakeClient.connected = true;
    fakeClient.emit("connect");

    const payload = Buffer.from("[]");
    fakeClient.emit("message", "bridge/devices", payload);

    expect(handler).toHaveBeenCalledWith("bridge/devices", payload);
  });

  it("reports live connection state via the status callback, not just once at startup", async () => {
    const statusChanges: boolean[] = [];
    const connector = new MqttConnector(
      "mqtt://broker",
      { clientId: "test" },
      { emit: vi.fn() },
      makeLogger(),
      "test-integration",
      (connected) => statusChanges.push(connected),
    );

    const connectPromise = connector.connect();
    fakeClient.emit("error", new Error("EHOSTUNREACH"));
    await connectPromise;
    expect(statusChanges).toEqual([]); // nothing yet — not actually connected

    fakeClient.connected = true;
    fakeClient.emit("connect");
    expect(statusChanges).toEqual([true]);

    fakeClient.connected = false;
    fakeClient.emit("offline");
    expect(statusChanges).toEqual([true, false]);
  });

  it("still subscribes immediately when the client is already connected", async () => {
    const connector = new MqttConnector(
      "mqtt://broker",
      { clientId: "test" },
      { emit: vi.fn() },
      makeLogger(),
      "test-integration",
    );

    const connectPromise = connector.connect();
    fakeClient.connected = true;
    fakeClient.emit("connect");
    await connectPromise;

    connector.subscribe("bridge/devices", vi.fn());
    expect(fakeClient.subscribeCalls).toEqual(["bridge/devices"]);
  });
});
