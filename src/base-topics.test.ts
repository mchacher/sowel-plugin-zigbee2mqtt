import { describe, it, expect } from "vitest";
import { parseBaseTopics, resolveDevice } from "./base-topics.js";

describe("parseBaseTopics", () => {
  it("falls back to the default topic when unset or blank", () => {
    expect(parseBaseTopics(undefined)).toEqual([{ baseTopic: "zigbee2mqtt", devicePrefix: "" }]);
    expect(parseBaseTopics("  , ,")).toEqual([{ baseTopic: "zigbee2mqtt", devicePrefix: "" }]);
  });

  it("leaves a single network unprefixed", () => {
    expect(parseBaseTopics("zigbee2mqtt")).toEqual([{ baseTopic: "zigbee2mqtt", devicePrefix: "" }]);
    expect(parseBaseTopics("z2m_maison")).toEqual([{ baseTopic: "z2m_maison", devicePrefix: "" }]);
  });

  it("prefixes every network but the first", () => {
    expect(parseBaseTopics("zigbee2mqtt, zigbee2mqtt_maison2 ,zigbee2mqtt_garage")).toEqual([
      { baseTopic: "zigbee2mqtt", devicePrefix: "" },
      { baseTopic: "zigbee2mqtt_maison2", devicePrefix: "zigbee2mqtt_maison2/" },
      { baseTopic: "zigbee2mqtt_garage", devicePrefix: "zigbee2mqtt_garage/" },
    ]);
  });

  it("honours an explicit prefix, and an empty one opts out", () => {
    expect(parseBaseTopics("zigbee2mqtt, zigbee2mqtt_maison2:m2")).toEqual([
      { baseTopic: "zigbee2mqtt", devicePrefix: "" },
      { baseTopic: "zigbee2mqtt_maison2", devicePrefix: "m2/" },
    ]);
    expect(parseBaseTopics("zigbee2mqtt, zigbee2mqtt_maison2:")).toEqual([
      { baseTopic: "zigbee2mqtt", devicePrefix: "" },
      { baseTopic: "zigbee2mqtt_maison2", devicePrefix: "" },
    ]);
  });

  it("drops duplicate topics and trailing slashes", () => {
    expect(parseBaseTopics("zigbee2mqtt/, zigbee2mqtt, zigbee2mqtt_maison2")).toEqual([
      { baseTopic: "zigbee2mqtt", devicePrefix: "" },
      { baseTopic: "zigbee2mqtt_maison2", devicePrefix: "zigbee2mqtt_maison2/" },
    ]);
  });
});

describe("resolveDevice", () => {
  const topics = parseBaseTopics("zigbee2mqtt, zigbee2mqtt_maison2, zigbee2mqtt_garage");

  it("routes an unprefixed id to the primary network", () => {
    expect(resolveDevice(topics, "salon_lampe")).toEqual({
      baseTopic: "zigbee2mqtt",
      deviceName: "salon_lampe",
    });
  });

  it("strips the prefix of a secondary network", () => {
    expect(resolveDevice(topics, "zigbee2mqtt_maison2/salon_lampe")).toEqual({
      baseTopic: "zigbee2mqtt_maison2",
      deviceName: "salon_lampe",
    });
    expect(resolveDevice(topics, "zigbee2mqtt_garage/porte")).toEqual({
      baseTopic: "zigbee2mqtt_garage",
      deviceName: "porte",
    });
  });

  it("keeps slashes inside a friendly name", () => {
    expect(resolveDevice(topics, "zigbee2mqtt_maison2/etage/lampe")).toEqual({
      baseTopic: "zigbee2mqtt_maison2",
      deviceName: "etage/lampe",
    });
    expect(resolveDevice(topics, "etage/lampe")).toEqual({
      baseTopic: "zigbee2mqtt",
      deviceName: "etage/lampe",
    });
  });

  it("matches the longest prefix when one topic prefixes another", () => {
    const nested = parseBaseTopics("zigbee2mqtt, z2m, z2m/annexe");
    expect(resolveDevice(nested, "z2m/annexe/porte")).toEqual({
      baseTopic: "z2m/annexe",
      deviceName: "porte",
    });
    expect(resolveDevice(nested, "z2m/porte")).toEqual({ baseTopic: "z2m", deviceName: "porte" });
  });

  it("falls back to the default topic when no network is configured", () => {
    expect(resolveDevice([], "salon")).toEqual({ baseTopic: "zigbee2mqtt", deviceName: "salon" });
  });
});
