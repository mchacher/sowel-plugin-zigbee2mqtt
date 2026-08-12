import { describe, it, expect, vi } from "vitest";
import { DiscoveryRegistry } from "./discovery-registry.js";

function makeDeps() {
  const deviceManager = { removeStaleDevices: vi.fn(), logSummary: vi.fn() };
  const warn = vi.fn();
  const logger = { child: () => logger, info: vi.fn(), warn } as never;
  return { deviceManager, logger, warn };
}

describe("DiscoveryRegistry", () => {
  it("defers cleanup until every network has reported", () => {
    const { deviceManager, logger } = makeDeps();
    const registry = new DiscoveryRegistry(["a", "b"], "zigbee2mqtt", deviceManager, logger);

    registry.report("a", new Set(["lampe"]));
    expect(deviceManager.removeStaleDevices).not.toHaveBeenCalled();

    registry.report("b", new Set(["b/volet"]));
    expect(deviceManager.removeStaleDevices).toHaveBeenCalledWith(
      "zigbee2mqtt",
      new Set(["lampe", "b/volet"]),
    );
  });

  it("prunes on the union, so one network never deletes another's devices", () => {
    const { deviceManager, logger } = makeDeps();
    const registry = new DiscoveryRegistry(["a", "b"], "zigbee2mqtt", deviceManager, logger);

    registry.report("a", new Set(["lampe"]));
    registry.report("b", new Set(["b/volet"]));
    deviceManager.removeStaleDevices.mockClear();

    // Network A re-announces alone: B's device must survive.
    registry.report("a", new Set(["lampe", "capteur"]));
    expect(deviceManager.removeStaleDevices).toHaveBeenCalledWith(
      "zigbee2mqtt",
      new Set(["lampe", "capteur", "b/volet"]),
    );
  });

  it("cleans up straight away on a single-network install", () => {
    const { deviceManager, logger } = makeDeps();
    const registry = new DiscoveryRegistry(["a"], "zigbee2mqtt", deviceManager, logger);

    registry.report("a", new Set(["lampe"]));
    expect(deviceManager.removeStaleDevices).toHaveBeenCalledWith("zigbee2mqtt", new Set(["lampe"]));
  });

  describe("ownerOf", () => {
    it("returns the network that discovered the device, unprefixed ids included", () => {
      const { deviceManager, logger } = makeDeps();
      const registry = new DiscoveryRegistry(["a", "b"], "zigbee2mqtt", deviceManager, logger);

      registry.report("a", new Set(["lampe"]));
      registry.report("b", new Set(["salon"])); // `topic:` opt-out: no prefix

      expect(registry.ownerOf("lampe")).toBe("a");
      expect(registry.ownerOf("salon")).toBe("b");
    });

    it("returns undefined before the owning network has reported, or for an unknown id", () => {
      const { deviceManager, logger } = makeDeps();
      const registry = new DiscoveryRegistry(["a", "b"], "zigbee2mqtt", deviceManager, logger);

      registry.report("a", new Set(["lampe"]));
      expect(registry.ownerOf("salon")).toBeUndefined();
      expect(registry.ownerOf("inconnu")).toBeUndefined();
    });

    it("resolves a cross-network id collision to the first network in configured order", () => {
      const { deviceManager, logger } = makeDeps();
      const registry = new DiscoveryRegistry(["a", "b"], "zigbee2mqtt", deviceManager, logger);

      registry.report("b", new Set(["salon"]));
      registry.report("a", new Set(["salon"]));

      expect(registry.ownerOf("salon")).toBe("a");
    });
  });

  describe("collision warning", () => {
    it("warns once per colliding id, not on re-announces", () => {
      const { deviceManager, logger, warn } = makeDeps();
      const registry = new DiscoveryRegistry(["a", "b"], "zigbee2mqtt", deviceManager, logger);

      registry.report("a", new Set(["salon", "lampe"]));
      registry.report("b", new Set(["salon"]));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ sourceDeviceId: "salon", networks: ["a", "b"] }),
        expect.stringContaining("merge into one"),
      );

      registry.report("b", new Set(["salon"]));
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("stays silent when ids are distinct across networks", () => {
      const { deviceManager, logger, warn } = makeDeps();
      const registry = new DiscoveryRegistry(["a", "b"], "zigbee2mqtt", deviceManager, logger);

      registry.report("a", new Set(["lampe"]));
      registry.report("b", new Set(["b/volet"]));
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
