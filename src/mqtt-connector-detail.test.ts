import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { MqttConnector } from "./mqtt-connector.js";

/** Spec 216 (sowel): the connector keeps the last connection error as a sentence. */

class FakeMqttClient extends EventEmitter {
  connected = false;
  subscribe(): void {}
  publish(): void {}
  async endAsync(): Promise<void> {
    this.connected = false;
  }
}

let fakeClient: FakeMqttClient;

vi.mock("mqtt", () => ({
  default: { connect: vi.fn(() => fakeClient) },
}));

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

describe("MqttConnector status detail (spec 216)", () => {
  beforeEach(() => {
    fakeClient = new FakeMqttClient();
  });

  it("explains the last error until the broker answers", async () => {
    const connector = new MqttConnector("mqtt://127.0.0.1:1883", { clientId: "t" }, { emit: vi.fn() }, logger, "t");
    const connecting = connector.connect();
    expect(connector.getStatusDetail()).toBeNull();

    fakeClient.emit("error", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1883"), { code: "ECONNREFUSED" }));
    await connecting;
    expect(connector.getStatusDetail()).toMatch(/^Connection refused on 127\.0\.0\.1:1883/);

    fakeClient.connected = true;
    fakeClient.emit("connect");
    expect(connector.getStatusDetail()).toBeNull();
  });
});
