import { describe, it, expect } from "vitest";
import { inferCategory } from "./z2m-parser.js";

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
