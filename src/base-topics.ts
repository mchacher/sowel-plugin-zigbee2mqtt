/**
 * Base-topic list — one Zigbee2MQTT instance per Zigbee coordinator.
 *
 * Zigbee2MQTT drives a single coordinator per instance, so a home with several
 * coordinators runs several Z2M instances, each with its own `base_topic`, all
 * sharing one MQTT broker. The `base_topic` setting therefore accepts a
 * comma-separated list.
 *
 * The first entry is the primary network: its devices keep their bare
 * `friendly_name` as Sowel source id, so an existing single-network install and
 * its equipment bindings are untouched by the upgrade. Every other network
 * prefixes its devices with its own base topic (`zigbee2mqtt_maison2/salon`),
 * so two networks sharing a friendly name stay two distinct Sowel devices.
 *
 * An entry may override that prefix with `topic:prefix`, including
 * `topic:` (empty) to opt out of prefixing entirely — legitimate when the
 * friendly names are known to be unique across networks, at the cost of two
 * same-named devices silently collapsing into one if they ever collide.
 */

export interface TopicConfig {
  /** MQTT base topic of the Z2M instance. */
  readonly baseTopic: string;
  /**
   * Prepended to `friendly_name` to build the Sowel source device id.
   * Empty for the primary network.
   */
  readonly devicePrefix: string;
}

export const DEFAULT_BASE_TOPIC = "zigbee2mqtt";

/**
 * Parse the `base_topic` setting into an ordered network list.
 * Blank entries and duplicate topics are dropped; an empty setting falls back
 * to the single default topic.
 */
export function parseBaseTopics(raw: string | undefined): TopicConfig[] {
  const seen = new Set<string>();
  const parsed: TopicConfig[] = [];

  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;

    // `topic` | `topic:prefix` | `topic:` — the alias is everything past the
    // first colon, so an empty one is an explicit "no prefix".
    const colon = entry.indexOf(":");
    const baseTopic = (colon === -1 ? entry : entry.slice(0, colon)).trim().replace(/\/+$/, "");
    if (!baseTopic || seen.has(baseTopic)) continue;
    seen.add(baseTopic);

    const alias = colon === -1 ? undefined : entry.slice(colon + 1).trim().replace(/\/+$/, "");
    const defaultPrefix = parsed.length === 0 ? "" : baseTopic;
    const prefix = alias ?? defaultPrefix;

    parsed.push({ baseTopic, devicePrefix: prefix === "" ? "" : `${prefix}/` });
  }

  if (parsed.length === 0) {
    parsed.push({ baseTopic: DEFAULT_BASE_TOPIC, devicePrefix: "" });
  }

  return parsed;
}

export interface ResolvedDevice {
  /** Base topic of the network owning the device. */
  baseTopic: string;
  /** Z2M friendly name, i.e. the source device id stripped of its prefix. */
  deviceName: string;
}

/**
 * Map a Sowel source device id back to the network that owns it — the reverse
 * of the prefixing done at discovery, used to address the right instance when
 * publishing an order.
 *
 * When `ownerBaseTopic` is known (recorded at discovery), it is authoritative:
 * a `topic:` network's devices carry no prefix at all, so only discovery can
 * tell them apart from the primary's.
 *
 * Otherwise, longest prefix wins, so a topic that is itself a prefix of
 * another one still resolves to the right network. Anything unprefixed belongs
 * to the primary.
 */
export function resolveDevice(
  topics: TopicConfig[],
  sourceDeviceId: string,
  ownerBaseTopic?: string,
): ResolvedDevice {
  const owner = ownerBaseTopic
    ? topics.find((t) => t.baseTopic === ownerBaseTopic)
    : undefined;
  if (owner && sourceDeviceId.startsWith(owner.devicePrefix)) {
    return {
      baseTopic: owner.baseTopic,
      deviceName: sourceDeviceId.slice(owner.devicePrefix.length),
    };
  }

  const prefixed = topics
    .filter((t) => t.devicePrefix !== "")
    .sort((a, b) => b.devicePrefix.length - a.devicePrefix.length);

  for (const topic of prefixed) {
    if (sourceDeviceId.startsWith(topic.devicePrefix)) {
      return {
        baseTopic: topic.baseTopic,
        deviceName: sourceDeviceId.slice(topic.devicePrefix.length),
      };
    }
  }

  return {
    baseTopic: topics[0]?.baseTopic ?? DEFAULT_BASE_TOPIC,
    deviceName: sourceDeviceId,
  };
}
