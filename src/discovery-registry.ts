/**
 * Stale-device pruning across several Zigbee2MQTT networks.
 *
 * `removeStaleDevices` is scoped to an integration, and every network shares the
 * `zigbee2mqtt` integration id — so pruning straight from one instance's
 * `bridge/devices` would delete every device of the other networks. This
 * registry keeps the latest active-id set of each network and prunes on their
 * union, and only once every configured network has reported at least once.
 *
 * That last condition is deliberately fail-safe: a network whose Z2M instance is
 * down never reports, so nothing is pruned at all rather than its devices being
 * wrongly declared stale.
 */

interface DeviceManager {
  removeStaleDevices(integrationId: string, activeDeviceIds: Set<string>): void;
  logSummary(): void;
}

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export class DiscoveryRegistry {
  private readonly expected: Set<string>;
  private readonly reported = new Map<string, Set<string>>();
  private readonly integrationId: string;
  private readonly deviceManager: DeviceManager;
  private readonly logger: Logger;

  constructor(
    baseTopics: string[],
    integrationId: string,
    deviceManager: DeviceManager,
    logger: Logger,
  ) {
    this.expected = new Set(baseTopics);
    this.integrationId = integrationId;
    this.deviceManager = deviceManager;
    this.logger = logger.child({ module: "discovery-registry" });
  }

  /** Collisions already logged, so a re-announce doesn't warn again. */
  private readonly warnedCollisions = new Set<string>();

  /** Record one network's active source ids, then prune on the union. */
  report(baseTopic: string, activeDeviceIds: Set<string>): void {
    this.reported.set(baseTopic, activeDeviceIds);
    this.warnOnCollisions(baseTopic, activeDeviceIds);

    if (this.reported.size < this.expected.size) {
      const pending = [...this.expected].filter((t) => !this.reported.has(t));
      this.logger.info(
        { baseTopic, pending },
        "Discovery incomplete, deferring stale device cleanup",
      );
      return;
    }

    const union = new Set<string>();
    for (const ids of this.reported.values()) {
      for (const id of ids) union.add(id);
    }

    this.deviceManager.removeStaleDevices(this.integrationId, union);
    this.deviceManager.logSummary();
  }

  /**
   * A source id announced by two networks means their devices silently merge
   * into one Sowel device — possible when a `topic:` entry opts out of
   * prefixing. Nothing else surfaces it, so log it loudly, once per id.
   */
  private warnOnCollisions(baseTopic: string, activeDeviceIds: Set<string>): void {
    for (const [otherTopic, otherIds] of this.reported) {
      if (otherTopic === baseTopic) continue;
      for (const id of activeDeviceIds) {
        if (otherIds.has(id) && !this.warnedCollisions.has(id)) {
          this.warnedCollisions.add(id);
          this.logger.warn(
            { sourceDeviceId: id, networks: [otherTopic, baseTopic] },
            "Same source id announced by two networks: their devices merge into one, orders go to the first configured network",
          );
        }
      }
    }
  }

  /**
   * Base topic of the network that discovered this source id, if it has
   * reported yet. On a cross-network id collision (possible when a `topic:`
   * entry opts out of prefixing), the first network in configured order wins.
   */
  ownerOf(sourceDeviceId: string): string | undefined {
    for (const topic of this.expected) {
      if (this.reported.get(topic)?.has(sourceDeviceId)) return topic;
    }
    return undefined;
  }
}
