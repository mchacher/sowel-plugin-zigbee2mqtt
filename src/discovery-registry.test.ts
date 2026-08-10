import { describe, it, expect, vi } from "vitest";
import { DiscoveryRegistry } from "./discovery-registry.js";

function makeDeps() {
  const deviceManager = { removeStaleDevices: vi.fn(), logSummary: vi.fn() };
  const logger = { child: () => logger, info: vi.fn() } as never;
  return { deviceManager, logger };
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
});
