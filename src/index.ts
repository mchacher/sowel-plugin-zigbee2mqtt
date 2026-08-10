/**
 * Sowel Plugin: Zigbee2MQTT
 *
 * Integrates Zigbee devices via a Zigbee2MQTT MQTT bridge.
 * Subscribes to bridge/devices for discovery, device state, availability, and bridge events.
 * Supports read + write (orders via MQTT publish to device/set topic).
 */

import { MqttConnector } from "./mqtt-connector.js";
import { Zigbee2MqttParser } from "./z2m-parser.js";
import { DiscoveryRegistry } from "./discovery-registry.js";
import { parseBaseTopics, resolveDevice, type TopicConfig } from "./base-topics.js";

// ============================================================
// Local type definitions (no imports from Sowel source)
// ============================================================

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

interface EventBus { emit(event: unknown): void; }
interface SettingsManager { get(key: string): string | undefined; }

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: unknown): void;
  updateDeviceData(integrationId: string, sourceDeviceId: string, payload: Record<string, unknown>): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
  removeStaleDevices(integrationId: string, activeIds: Set<string>): void;
  /** Available since Sowel v1.4 — used to reclaim devices stored under a legacy integration id. */
  migrateIntegrationId?(oldIntegrationId: string, newIntegrationId: string): number;
  logSummary(): void;
}

interface Device { id: string; integrationId: string; sourceDeviceId: string; name: string; }
interface PluginDeps { logger: Logger; eventBus: EventBus; settingsManager: SettingsManager; deviceManager: DeviceManager; pluginDir: string; }

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";
interface IntegrationSettingDef { key: string; label: string; type: "text" | "password" | "number" | "boolean"; required: boolean; placeholder?: string; defaultValue?: string; }

interface IntegrationPlugin {
  readonly id: string; readonly name: string; readonly description: string; readonly icon: string;
  readonly apiVersion?: number;
  getStatus(): IntegrationStatus; isConfigured(): boolean; getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>; stop(): Promise<void>;
  executeOrder(device: Device, orderKeyOrDispatchConfig: string | Record<string, unknown>, value: unknown): Promise<void>;
  refresh?(): Promise<void>; getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

// ============================================================
// Plugin
// ============================================================

const INTEGRATION_ID = "zigbee2mqtt";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;

class Zigbee2MqttPlugin implements IntegrationPlugin {
  readonly id = INTEGRATION_ID;
  readonly name = "Zigbee2MQTT";
  readonly description = "Zigbee devices via MQTT bridge";
  readonly icon = "Radio";
  readonly apiVersion = 2;

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private mqttConnector: MqttConnector | null = null;
  private status: IntegrationStatus = "disconnected";
  /** One entry per Zigbee2MQTT network, in `base_topic` order. */
  private topics: TopicConfig[] = [];

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settingsManager = deps.settingsManager;
    this.deviceManager = deps.deviceManager;
  }

  getStatus(): IntegrationStatus {
    if (!this.isConfigured()) return "not_configured";
    if (this.status === "connected" && this.mqttConnector && !this.mqttConnector.isConnected()) return "error";
    return this.status;
  }

  isConfigured(): boolean { return this.getSetting("mqtt_url") !== undefined; }

  getSettingsSchema(): IntegrationSettingDef[] {
    return [
      { key: "mqtt_url", label: "MQTT Broker URL", type: "text", required: true, placeholder: "mqtt://localhost:1883" },
      { key: "mqtt_username", label: "MQTT Username", type: "text", required: false },
      { key: "mqtt_password", label: "MQTT Password", type: "password", required: false },
      { key: "mqtt_client_id", label: "MQTT Client ID", type: "text", required: false, defaultValue: "sowel-z2m" },
      { key: "base_topic", label: "Zigbee2MQTT Base Topic(s)", type: "text", required: false, defaultValue: "zigbee2mqtt", placeholder: "zigbee2mqtt, zigbee2mqtt_maison2" },
    ];
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) { this.status = "not_configured"; return; }

    const mqttUrl = this.getSetting("mqtt_url")!;
    const mqttUsername = this.getSetting("mqtt_username") || undefined;
    const mqttPassword = this.getSetting("mqtt_password") || undefined;
    // Append a random suffix so a stale broker session or a previous Sowel
    // process holding the same clientId can't kick this one in a loop.
    const baseClientId = this.getSetting("mqtt_client_id") ?? "sowel-z2m";
    const mqttClientId = `${baseClientId}-${Math.random().toString(36).slice(2, 8)}`;
    this.topics = parseBaseTopics(this.getSetting("base_topic"));

    try {
      this.reclaimLegacyDevices();

      this.mqttConnector = new MqttConnector(
        mqttUrl,
        { username: mqttUsername, password: mqttPassword, clientId: mqttClientId },
        this.eventBus, this.logger, INTEGRATION_ID,
      );
      await this.mqttConnector.connect();

      // Zigbee2MQTT drives one coordinator per instance, so each network is a
      // separate parser — but they share the MQTT connection, the Sowel
      // integration id, and the stale-device registry.
      const registry = new DiscoveryRegistry(
        this.topics.map((t) => t.baseTopic),
        INTEGRATION_ID,
        this.deviceManager,
        this.logger,
      );
      for (const topic of this.topics) {
        new Zigbee2MqttParser({
          integrationId: INTEGRATION_ID,
          baseTopic: topic.baseTopic,
          devicePrefix: topic.devicePrefix,
          mqttConnector: this.mqttConnector,
          deviceManager: this.deviceManager,
          registry,
          logger: this.logger,
        }).start();
      }

      this.status = this.mqttConnector.isConnected() ? "connected" : "disconnected";
      if (this.status === "connected") {
        this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
      }
      this.logger.info(
        { networks: this.topics.map((t) => t.baseTopic) } as Record<string, unknown>,
        "Zigbee2MQTT started",
      );
    } catch (err) {
      this.status = "error";
      this.logger.error({ err } as Record<string, unknown>, "Failed to start Zigbee2MQTT");
    }
  }

  async stop(): Promise<void> {
    if (this.mqttConnector) {
      await this.mqttConnector.disconnect();
      this.mqttConnector = null;
      this.status = "disconnected";
      this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
      this.logger.info("Zigbee2MQTT stopped");
    }
  }

  async executeOrder(device: Device, orderKey: string, value: unknown): Promise<void> {
    if (!this.mqttConnector?.isConnected()) throw new Error("MQTT not connected");
    // The source id carries the network prefix, so it tells us which Z2M
    // instance owns the device and what its friendly name is over there.
    const { baseTopic, deviceName } = resolveDevice(this.topics, device.sourceDeviceId);
    const topic = `${baseTopic}/${deviceName}/set`;

    // Composite payload support: when `value` is a plain object, publish it
    // directly as the MQTT payload instead of wrapping under `orderKey`.
    const isCompositeValue =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value);

    const payload: Record<string, unknown> = isCompositeValue
      ? (value as Record<string, unknown>)
      : { [orderKey]: value };

    this.mqttConnector.publish(topic, JSON.stringify(payload));
  }

  /**
   * Up to v2.3.x the parser passed the base topic where the core expects an
   * integration id, so an install whose `base_topic` was not the default
   * `zigbee2mqtt` stored its devices under that topic. Now that every network
   * reports under `zigbee2mqtt`, those rows would be orphaned — hand them over
   * once, on the primary network only (the secondary ones are new by
   * definition, and their devices are prefixed).
   */
  private reclaimLegacyDevices(): void {
    const primary = this.topics[0]?.baseTopic;
    if (!primary || primary === INTEGRATION_ID) return;
    if (typeof this.deviceManager.migrateIntegrationId !== "function") return;

    const moved = this.deviceManager.migrateIntegrationId(primary, INTEGRATION_ID);
    if (moved > 0) {
      this.logger.info(
        { from: primary, to: INTEGRATION_ID, moved } as Record<string, unknown>,
        "Migrated devices from legacy base-topic integration id",
      );
    }
  }

  private getSetting(key: string): string | undefined { return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`); }
}

// ============================================================
// Plugin entry point
// ============================================================

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new Zigbee2MqttPlugin(deps);
}
