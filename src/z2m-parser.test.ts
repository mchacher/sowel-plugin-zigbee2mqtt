import { describe, it, expect } from "vitest";
import { inferCategory, mapPowerSource } from "./z2m-parser.js";

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
  it("is categorised battery so the low-battery monitor sees it (spec 143)", () => {
    expect(inferCategory("battery_low", new Set(["battery_low", "occupancy"]))).toBe("battery");
  });
});
