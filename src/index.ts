/**
 * Sowel Plugin: Zigbee2MQTT
 *
 * Integrates Zigbee devices via a Zigbee2MQTT MQTT bridge.
 * Subscribes to bridge/devices for discovery, device state, availability, and bridge events.
 * Supports read + write (orders via MQTT publish to device/set topic).
 */

import { MqttConnector } from "./mqtt-connector.js";
import { Zigbee2MqttParser } from "./z2m-parser.js";

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
  logSummary(): void;
}

interface Device { id: string; integrationId: string; sourceDeviceId: string; name: string; }
interface PluginDeps { logger: Logger; eventBus: EventBus; settingsManager: SettingsManager; deviceManager: DeviceManager; pluginDir: string; }

type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";
interface IntegrationSettingDef { key: string; label: string; type: "text" | "password" | "number" | "boolean"; required: boolean; placeholder?: string; defaultValue?: string; }

interface IntegrationPlugin {
  readonly id: string; readonly name: string; readonly description: string; readonly icon: string;
  getStatus(): IntegrationStatus; isConfigured(): boolean; getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>; stop(): Promise<void>;
  executeOrder(device: Device, dispatchConfig: Record<string, unknown>, value: unknown): Promise<void>;
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

  private logger: Logger;
  private eventBus: EventBus;
  private settingsManager: SettingsManager;
  private deviceManager: DeviceManager;
  private mqttConnector: MqttConnector | null = null;
  private status: IntegrationStatus = "disconnected";

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
      { key: "base_topic", label: "Zigbee2MQTT Base Topic", type: "text", required: false, defaultValue: "zigbee2mqtt" },
    ];
  }

  async start(): Promise<void> {
    if (!this.isConfigured()) { this.status = "not_configured"; return; }

    const mqttUrl = this.getSetting("mqtt_url")!;
    const mqttUsername = this.getSetting("mqtt_username") || undefined;
    const mqttPassword = this.getSetting("mqtt_password") || undefined;
    const mqttClientId = this.getSetting("mqtt_client_id") ?? "sowel-z2m";
    const baseTopic = this.getSetting("base_topic") ?? "zigbee2mqtt";

    try {
      this.mqttConnector = new MqttConnector(
        mqttUrl,
        { username: mqttUsername, password: mqttPassword, clientId: mqttClientId },
        this.eventBus, this.logger, INTEGRATION_ID,
      );
      await this.mqttConnector.connect();

      const parser = new Zigbee2MqttParser(baseTopic, this.mqttConnector, this.deviceManager, this.logger);
      parser.start();

      this.status = this.mqttConnector.isConnected() ? "connected" : "disconnected";
      if (this.status === "connected") {
        this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
      }
      this.logger.info("Zigbee2MQTT started");
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

  async executeOrder(_device: Device, dispatchConfig: Record<string, unknown>, value: unknown): Promise<void> {
    if (!this.mqttConnector?.isConnected()) throw new Error("MQTT not connected");
    const topic = dispatchConfig.topic as string;
    const payloadKey = dispatchConfig.payloadKey as string;
    if (!topic || !payloadKey) throw new Error("Missing topic or payloadKey");

    // Composite payload support: when `value` is a plain object, publish it
    // directly as the MQTT payload instead of wrapping under `payloadKey`.
    // This enables atomic multi-key publishes like {"state":"ON","on_time":300}
    // (z2m's "on with timed off" pattern), which would otherwise need two
    // separate publishes that z2m may interleave or rate-limit.
    const isCompositeValue =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value);

    const payload: Record<string, unknown> = isCompositeValue
      ? (value as Record<string, unknown>)
      : { [payloadKey]: value };

    this.mqttConnector.publish(topic, JSON.stringify(payload));
  }

  private getSetting(key: string): string | undefined { return this.settingsManager.get(`${SETTINGS_PREFIX}${key}`); }
}

// ============================================================
// Plugin entry point
// ============================================================

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new Zigbee2MqttPlugin(deps);
}
