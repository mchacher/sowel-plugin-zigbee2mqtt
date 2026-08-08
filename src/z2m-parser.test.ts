import { describe, it, expect } from "vitest";
import { inferCategory, inferOrderCategory } from "./z2m-parser.js";

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
