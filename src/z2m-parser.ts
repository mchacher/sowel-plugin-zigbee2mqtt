/**
 * Zigbee2MQTT Parser — handles bridge/devices discovery, device state, availability, and bridge events.
 * Verbatim port of the built-in Sowel Z2M parser.
 */

import type { MqttConnector } from "./mqtt-connector.js";

// ============================================================
// Z2M types
// ============================================================

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

interface Z2MBridgeEvent {
  type: string;
  data: Record<string, unknown>;
}

// ============================================================
// Constants
// ============================================================

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

const PROPERTY_TO_ORDER_CATEGORY: Record<string, string> = {
  brightness: "set_brightness",
  color_temp: "set_color_temp",
  color: "set_color",
  color_xy: "set_color",
  color_hs: "set_color",
  position: "set_shutter_position",
};

const LIGHT_INDICATOR_PROPERTIES = new Set(["brightness", "color_temp", "color", "color_xy", "color_hs"]);

// ============================================================
// Category inference
// ============================================================

function inferCategory(property: string, allProperties: Set<string>, parentExposeType?: string): DataCategory {
  if (property === "state") {
    if (parentExposeType === "light" || parentExposeType === "switch") return "light_state";
    const hasLightProperties = [...LIGHT_INDICATOR_PROPERTIES].some((p) => allProperties.has(p));
    return hasLightProperties ? "light_state" : "generic";
  }
  return PROPERTY_TO_CATEGORY[property] ?? "generic";
}

function inferOrderCategory(property: string, allProperties: Set<string>, parentExposeType?: string): string | undefined {
  if (property === "state") {
    if (parentExposeType === "cover") return "shutter_move";
    if (parentExposeType === "light" || parentExposeType === "switch") return "light_toggle";
    const hasLightProperties = [...LIGHT_INDICATOR_PROPERTIES].some((p) => allProperties.has(p));
    if (hasLightProperties) return "light_toggle";
    return undefined;
  }
  return PROPERTY_TO_ORDER_CATEGORY[property];
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
// Types for DeviceManager interaction
// ============================================================

interface DiscoveredDevice {
  ieeeAddress?: string; friendlyName: string; manufacturer?: string; model?: string;
  rawExpose?: unknown;
  data: { key: string; type: string; category: string; unit?: string }[];
  orders: { key: string; type: string; category?: string; min?: number; max?: number; enumValues?: string[]; unit?: string }[];
}

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
  updateDeviceData(integrationId: string, sourceDeviceId: string, payload: Record<string, unknown>): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
  removeStaleDevices(integrationId: string, activeIds: Set<string>): void;
  logSummary(): void;
}

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

// ============================================================
// Parser
// ============================================================

export class Zigbee2MqttParser {
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
        const orderCat = inferOrderCategory(expose.property, allProperties, parentExposeType);
        orders.push({
          key: expose.property, type: dataType, category: orderCat,
          min: expose.value_min, max: expose.value_max, enumValues: expose.values, unit: expose.unit,
        });
      }
    }
  }
}
