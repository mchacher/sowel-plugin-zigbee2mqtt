/**
 * Sowel Plugin: Zigbee2MQTT
 *
 * Integrates Zigbee devices via a Zigbee2MQTT MQTT bridge.
 * Subscribes to bridge/devices for discovery, device state, availability, and bridge events.
 * Supports read + write (orders via MQTT publish to device/set topic).
 *
 * This is a verbatim port of the built-in Zigbee2MQTT integration.
 */

import mqtt, { type MqttClient, type IClientOptions } from "mqtt";

// ============================================================
// Local type definitions (no imports from Sowel source)
// ============================================================

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
}

interface EventBus { emit(event: unknown): void; }
interface SettingsManager { get(key: string): string | undefined; set(key: string, value: string): void; }

interface DiscoveredDevice {
  ieeeAddress?: string; friendlyName: string; manufacturer?: string; model?: string;
  rawExpose?: unknown;
  data: { key: string; type: string; category: string; unit?: string }[];
  orders: { key: string; type: string; dispatchConfig: Record<string, unknown>; min?: number; max?: number; enumValues?: string[]; unit?: string }[];
}

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
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
// Z2M types (from Sowel shared/types.ts)
// ============================================================

interface Z2MDevice {
  ieee_address: string;
  friendly_name: string;
  type: "Coordinator" | "Router" | "EndDevice";
  definition?: { model: string; vendor: string; description: string; exposes: Z2MExpose[] };
  manufacturer?: string;
  model_id?: string;
  supported: boolean;
  disabled: boolean;
}

interface Z2MExpose {
  type: "binary" | "numeric" | "enum" | "text" | "composite" | "list";
  name?: string;
  property?: string;
  access?: number;
  unit?: string;
  value_min?: number;
  value_max?: number;
  values?: string[];
  value_on?: unknown;
  value_off?: unknown;
  features?: Z2MExpose[];
  description?: string;
}

interface Z2MBridgeEvent {
  type: string;
  data: Record<string, unknown>;
}

// ============================================================
// Constants (inlined from Sowel shared/constants.ts)
// ============================================================

const INTEGRATION_ID = "zigbee2mqtt";
const SETTINGS_PREFIX = `integration.${INTEGRATION_ID}.`;

type DataType = "number" | "boolean" | "enum" | "text" | "json";
type DataCategory = string;

const Z2M_TYPE_TO_DATA_TYPE: Record<string, DataType> = {
  binary: "boolean", numeric: "number", enum: "enum", text: "text", composite: "json",
};

const Z2M_ACCESS_STATE = 0b001;
const Z2M_ACCESS_SET = 0b010;

const PROPERTY_TO_CATEGORY: Record<string, DataCategory> = {
  occupancy: "motion", presence: "motion",
  temperature: "temperature", device_temperature: "temperature", soil_temperature: "temperature",
  humidity: "humidity", soil_moisture: "humidity",
  pressure: "pressure",
  illuminance: "luminosity", illuminance_lux: "luminosity",
  battery: "battery",
  voltage: "voltage", current: "current",
  power: "power", energy: "energy",
  co2: "co2", voc: "voc",
  action: "action",
  contact: "contact",
  state: "light_state",
  brightness: "light_brightness", color_temp: "light_brightness",
  position: "shutter_position",
  rain: "rain", wind: "wind", noise: "noise",
};

const LIGHT_INDICATOR_PROPERTIES = new Set(["brightness", "color_temp", "color", "color_xy", "color_hs"]);

// ============================================================
// Category inference (from Sowel devices/category-inference.ts)
// ============================================================

function inferCategory(property: string, allProperties: Set<string>, parentExposeType?: string): DataCategory {
  if (property === "state") {
    if (parentExposeType === "light" || parentExposeType === "switch") return "light_state";
    const hasLightProperties = [...LIGHT_INDICATOR_PROPERTIES].some((p) => allProperties.has(p));
    return hasLightProperties ? "light_state" : "generic";
  }
  return PROPERTY_TO_CATEGORY[property] ?? "generic";
}

function collectProperties(exposes: Z2MExpose[]): Set<string> {
  const props = new Set<string>();
  for (const expose of exposes) {
    if (expose.property) props.add(expose.property);
    if (expose.features) for (const prop of collectProperties(expose.features)) props.add(prop);
  }
  return props;
}

// ============================================================
// MQTT Connector (from Sowel src/mqtt/mqtt-connector.ts)
// ============================================================

type MessageHandler = (topic: string, payload: Buffer) => void;

class MqttConnector {
  private client: MqttClient | null = null;
  private logger: Logger;
  private eventBus: EventBus;
  private url: string;
  private options: IClientOptions;
  private handlers: Map<string, MessageHandler[]> = new Map();

  constructor(url: string, options: { username?: string; password?: string; clientId: string }, eventBus: EventBus, logger: Logger) {
    this.url = url;
    this.options = { clientId: options.clientId, username: options.username, password: options.password, clean: true, reconnectPeriod: 5000 };
    this.eventBus = eventBus;
    this.logger = logger;
  }

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      let resolved = false;
      const doResolve = () => { if (!resolved) { resolved = true; resolve(); } };

      this.client = mqtt.connect(this.url, this.options);

      this.client.on("connect", () => {
        this.logger.info({ url: this.url }, "MQTT connected");
        this.eventBus.emit({ type: "system.integration.connected", integrationId: INTEGRATION_ID });
        doResolve();
      });

      this.client.on("reconnect", () => { this.logger.warn({ url: this.url }, "MQTT reconnecting"); });

      this.client.on("disconnect", () => {
        this.logger.warn({ url: this.url }, "MQTT disconnected");
        this.eventBus.emit({ type: "system.integration.disconnected", integrationId: INTEGRATION_ID });
      });

      this.client.on("offline", () => {
        this.logger.warn({ url: this.url }, "MQTT offline");
        this.eventBus.emit({ type: "system.integration.disconnected", integrationId: INTEGRATION_ID });
      });

      this.client.on("error", (err) => {
        this.logger.error({ err: err.message } as Record<string, unknown>, "MQTT error");
        doResolve();
      });

      this.client.on("message", (topic, payload) => { this.routeMessage(topic, payload); });

      setTimeout(() => {
        if (!this.isConnected()) {
          this.logger.warn({ url: this.url }, "MQTT initial connection timeout, continuing");
        }
        doResolve();
      }, 10_000);
    });
  }

  subscribe(topicPattern: string, handler: MessageHandler): void {
    if (!this.handlers.has(topicPattern)) this.handlers.set(topicPattern, []);
    this.handlers.get(topicPattern)!.push(handler);
    if (this.client) {
      this.client.subscribe(topicPattern, (err) => {
        if (err) this.logger.error({ err, topic: topicPattern } as Record<string, unknown>, "Subscribe error");
      });
    }
  }

  publish(topic: string, payload: string | Buffer): void {
    if (!this.client || !this.isConnected()) { this.logger.warn({ topic } as Record<string, unknown>, "Cannot publish: not connected"); return; }
    this.client.publish(topic, payload, (err) => { if (err) this.logger.error({ err, topic } as Record<string, unknown>, "Publish error"); });
  }

  isConnected(): boolean { return this.client?.connected ?? false; }

  async disconnect(): Promise<void> {
    if (this.client) { await this.client.endAsync(); this.logger.info("MQTT disconnected"); }
  }

  private routeMessage(topic: string, payload: Buffer): void {
    for (const [pattern, handlers] of this.handlers) {
      if (this.topicMatches(pattern, topic)) {
        for (const handler of handlers) {
          try { handler(topic, payload); } catch (err) { this.logger.error({ err, topic } as Record<string, unknown>, "Handler error"); }
        }
      }
    }
  }

  private topicMatches(pattern: string, topic: string): boolean {
    const pp = pattern.split("/");
    const tp = topic.split("/");
    for (let i = 0; i < pp.length; i++) {
      if (pp[i] === "#") return true;
      if (i >= tp.length) return false;
      if (pp[i] !== "+" && pp[i] !== tp[i]) return false;
    }
    return pp.length === tp.length;
  }
}

// ============================================================
// Z2M Parser (from Sowel src/mqtt/parsers/zigbee2mqtt.ts)
// ============================================================

class Zigbee2MqttParser {
  private logger: Logger;
  private mqttConnector: MqttConnector;
  private deviceManager: DeviceManager;
  private baseTopic: string;

  constructor(baseTopic: string, mqttConnector: MqttConnector, deviceManager: DeviceManager, logger: Logger) {
    this.baseTopic = baseTopic;
    this.mqttConnector = mqttConnector;
    this.deviceManager = deviceManager;
    this.logger = logger.child({ module: "z2m-parser" });
  }

  start(): void {
    this.mqttConnector.subscribe(`${this.baseTopic}/bridge/devices`, (_topic, payload) => { this.handleBridgeDevices(payload); });
    this.mqttConnector.subscribe(`${this.baseTopic}/bridge/event`, (_topic, payload) => { this.handleBridgeEvent(payload); });
    this.mqttConnector.subscribe(`${this.baseTopic}/+`, (topic, payload) => { this.handleDeviceState(topic, payload); });
    this.mqttConnector.subscribe(`${this.baseTopic}/+/availability`, (topic, payload) => { this.handleDeviceAvailability(topic, payload); });
    this.logger.info({ baseTopic: this.baseTopic }, "Zigbee2MQTT parser started");
  }

  private handleBridgeDevices(payload: Buffer): void {
    try {
      const devices: Z2MDevice[] = JSON.parse(payload.toString());
      this.logger.info({ count: devices.length }, "Received bridge/devices");
      const currentNames = new Set<string>();
      for (const z2mDevice of devices) {
        if (z2mDevice.type === "Coordinator") continue;
        if (!z2mDevice.supported || z2mDevice.disabled) continue;
        currentNames.add(z2mDevice.friendly_name);
        const parsed = this.parseZ2MDevice(z2mDevice);
        if (parsed) this.deviceManager.upsertFromDiscovery(this.baseTopic, "zigbee2mqtt", parsed);
      }
      this.deviceManager.removeStaleDevices(this.baseTopic, currentNames);
      this.deviceManager.logSummary();
    } catch (err) { this.logger.error({ err } as Record<string, unknown>, "Failed to parse bridge/devices"); }
  }

  private handleBridgeEvent(payload: Buffer): void {
    try {
      const event: Z2MBridgeEvent = JSON.parse(payload.toString());
      if (event.type === "device_joined" || event.type === "device_announce" || event.type === "device_interview") {
        this.logger.info({ eventType: event.type, data: event.data }, "Bridge event");
      }
    } catch (err) { this.logger.error({ err } as Record<string, unknown>, "Failed to parse bridge/event"); }
  }

  private handleDeviceState(topic: string, payload: Buffer): void {
    const prefix = `${this.baseTopic}/`;
    if (!topic.startsWith(prefix)) return;
    const rest = topic.slice(prefix.length);
    if (rest.startsWith("bridge/") || rest.includes("/")) return;
    try {
      const data = JSON.parse(payload.toString());
      if (typeof data !== "object" || data === null) return;
      this.deviceManager.updateDeviceData(this.baseTopic, rest, data as Record<string, unknown>);
    } catch { /* non-JSON ignored */ }
  }

  private handleDeviceAvailability(topic: string, payload: Buffer): void {
    const prefix = `${this.baseTopic}/`;
    const suffix = "/availability";
    if (!topic.startsWith(prefix) || !topic.endsWith(suffix)) return;
    const deviceName = topic.slice(prefix.length, -suffix.length);
    try {
      const raw = payload.toString();
      let status: string;
      try { const parsed = JSON.parse(raw); status = typeof parsed === "object" && parsed !== null ? parsed.state : raw; }
      catch { status = raw; }
      if (status === "online" || status === "offline") {
        this.deviceManager.updateDeviceStatus(this.baseTopic, deviceName, status);
      }
    } catch (err) { this.logger.error({ err, topic } as Record<string, unknown>, "Failed to parse availability"); }
  }

  private parseZ2MDevice(z2mDevice: Z2MDevice): DiscoveredDevice | null {
    const exposes = z2mDevice.definition?.exposes ?? [];
    const allProperties = collectProperties(exposes);
    const data: DiscoveredDevice["data"] = [];
    const orders: DiscoveredDevice["orders"] = [];
    this.flattenExposes(exposes, allProperties, data, orders, z2mDevice.friendly_name);
    return {
      ieeeAddress: z2mDevice.ieee_address,
      friendlyName: z2mDevice.friendly_name,
      manufacturer: z2mDevice.definition?.vendor ?? z2mDevice.manufacturer,
      model: z2mDevice.definition?.model ?? z2mDevice.model_id,
      data, orders, rawExpose: exposes,
    };
  }

  private flattenExposes(
    exposes: Z2MExpose[], allProperties: Set<string>,
    data: DiscoveredDevice["data"], orders: DiscoveredDevice["orders"],
    deviceName: string, parentExposeType?: string,
  ): void {
    for (const expose of exposes) {
      if ((expose.type === "composite" || expose.type === "list") && expose.features) {
        this.flattenExposes(expose.features, allProperties, data, orders, deviceName, parentExposeType);
        continue;
      }
      if (!expose.property && expose.features) {
        this.flattenExposes(expose.features, allProperties, data, orders, deviceName, expose.type);
        continue;
      }
      if (!expose.property) continue;

      const access = expose.access ?? Z2M_ACCESS_STATE;
      const dataType = Z2M_TYPE_TO_DATA_TYPE[expose.type] ?? "text";

      if (access & Z2M_ACCESS_STATE) {
        const category = inferCategory(expose.property, allProperties, parentExposeType);
        data.push({ key: expose.property, type: dataType, category, unit: expose.unit });
      }

      if (access & Z2M_ACCESS_SET) {
        orders.push({
          key: expose.property, type: dataType,
          dispatchConfig: { topic: `${this.baseTopic}/${deviceName}/set`, payloadKey: expose.property },
          min: expose.value_min, max: expose.value_max, enumValues: expose.values, unit: expose.unit,
        });
      }
    }
  }
}

// ============================================================
// Plugin implementation
// ============================================================

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
      this.mqttConnector = new MqttConnector(mqttUrl, { username: mqttUsername, password: mqttPassword, clientId: mqttClientId }, this.eventBus, this.logger);
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
    const payload: Record<string, unknown> = {};
    payload[payloadKey] = value;
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
