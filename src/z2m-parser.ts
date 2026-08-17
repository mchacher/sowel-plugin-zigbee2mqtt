/**
 * Zigbee2MQTT Parser — handles bridge/devices discovery, device state, availability, and bridge events.
 * Verbatim port of the built-in Sowel Z2M parser.
 */

import type { MqttConnector } from "./mqtt-connector.js";
import type { DiscoveryRegistry } from "./discovery-registry.js";
import { Pj1203aHandler, isPj1203a } from "./pj1203a.js";

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
  /** "Battery", "Mains (single phase)", "DC Source", "Unknown", … */
  power_source?: string;
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

/** Keep only JSON primitives — value_on/value_off are untyped in the Z2M schema. */
function wirePrimitive(v: unknown): string | number | boolean | undefined {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : undefined;
}

/**
 * Whether Z2M's availability feature is enabled, across config shapes:
 * Z2M 2.x: `config.availability.enabled` (boolean). Z2M 1.x legacy:
 * `config.availability` as a boolean, or an object without `enabled`
 * (object form meant enabled). Absent config → disabled.
 */
export function availabilityEnabledFromBridgeInfo(info: unknown): boolean {
  if (typeof info !== "object" || info === null) return false;
  const avail = (info as { config?: { availability?: unknown } }).config?.availability;
  if (typeof avail === "boolean") return avail;
  if (typeof avail === "object" && avail !== null) {
    const enabled = (avail as { enabled?: unknown }).enabled;
    return typeof enabled === "boolean" ? enabled : true;
  }
  return false;
}

/**
 * Read `bridge/state`, which Z2M publishes as `{"state":"online"}` (2.x) and
 * used to publish as the bare string `online` (1.x). The same shapes come back
 * as the broker-delivered last will when the instance dies. Anything else is
 * ignored rather than guessed.
 */
export function parseBridgeState(raw: string): "online" | "offline" | null {
  let value: unknown = raw.trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    value = typeof parsed === "object" && parsed !== null ? (parsed as { state?: unknown }).state : parsed;
  } catch { /* bare string (Z2M 1.x) — keep the trimmed payload */ }
  return value === "online" || value === "offline" ? value : null;
}

const PROPERTY_TO_CATEGORY: Record<string, DataCategory> = {
  occupancy: "motion", presence: "motion",
  temperature: "temperature", device_temperature: "temperature", soil_temperature: "temperature",
  humidity: "humidity", soil_moisture: "humidity",
  pressure: "pressure",
  illuminance: "luminosity", illuminance_lux: "luminosity",
  battery: "battery",
  // NOT "battery": that category's contract is a numeric percentage, and this
  // is a boolean flag. Core's low-battery monitor (spec 143) matches it by key
  // regardless of category — `isBatteryData` is `category === "battery" ||
  // key === "battery_low"` — so the semantics are kept without lying about the
  // type. See the regression note in the test file.
  battery_low: "generic",
  voltage: "voltage", current: "current",
  power: "power", energy: "energy",
  co2: "co2", voc: "voc",
  action: "action",
  // Core recognises door/window openings via "contact_door" / "contact_window"
  // (drives gate open/closed state + the zone openDoors/openWindows counts).
  // Default to door; can be re-categorised to contact_window per device.
  contact: "contact_door",
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

/**
 * Map Zigbee2MQTT's `power_source` onto Sowel's vocabulary (spec 143). Sowel
 * only alerts on low batteries of devices it knows run on one, so an unmapped
 * or missing value must stay `unknown` (Sowel then falls back to its own
 * heuristic) rather than guess.
 */
export function mapPowerSource(powerSource?: string): PowerSource {
  if (!powerSource) return "unknown";
  const s = powerSource.toLowerCase();
  if (s.includes("battery")) return "battery";
  if (s.includes("mains")) return "mains";
  if (s.includes("dc source")) return "dc";
  return "unknown";
}

/**
 * A relay / switch on-off channel: `state`, or an endpoint-suffixed
 * `state_l1` / `state_left` / `state_right`, exposed as a `binary` (ON/OFF).
 *
 * The plain-`state`-under-a-`switch`-grouping check alone misses Tuya relay
 * modules (e.g. WHD02) that expose the switch at the top level or per-endpoint
 * — those land as category `generic` with no `light_toggle` order, so they
 * cannot be bound to a light or switch equipment. Gating on `binary` keeps an
 * enum `state` (cover OPEN/CLOSE/STOP, appliance run/pause) out.
 */
const RELAY_STATE_PROPERTY = /^state(_.+)?$/;
function isRelayState(property: string, exposeType?: string): boolean {
  return exposeType === "binary" && RELAY_STATE_PROPERTY.test(property);
}

export function inferCategory(
  property: string,
  allProperties: Set<string>,
  parentExposeType?: string,
  exposeType?: string,
): DataCategory {
  if (property === "state") {
    if (parentExposeType === "light" || parentExposeType === "switch") return "light_state";
    const hasLightProperties = [...LIGHT_INDICATOR_PROPERTIES].some((p) => allProperties.has(p));
    if (hasLightProperties) return "light_state";
    // A top-level binary `state` (no switch grouping) is a relay/switch.
    if (exposeType === "binary") return "light_state";
    return "generic";
  }
  // Endpoint-suffixed relay channel (state_l1, state_left, ...).
  if (isRelayState(property, exposeType)) return "light_state";
  return PROPERTY_TO_CATEGORY[property] ?? "generic";
}

export function inferOrderCategory(
  property: string,
  allProperties: Set<string>,
  parentExposeType?: string,
  exposeType?: string,
): string | undefined {
  if (property === "state") {
    if (parentExposeType === "cover") return "shutter_move";
    if (parentExposeType === "light" || parentExposeType === "switch") return "light_toggle";
    const hasLightProperties = [...LIGHT_INDICATOR_PROPERTIES].some((p) => allProperties.has(p));
    if (hasLightProperties) return "light_toggle";
    // A top-level binary `state` (no switch grouping) is a relay on-off command.
    if (exposeType === "binary") return "light_toggle";
    return undefined;
  }
  // Endpoint-suffixed relay command (state_l1, state_left, ...).
  if (isRelayState(property, exposeType)) return "light_toggle";
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

type PowerSource = "battery" | "mains" | "dc" | "unknown";

interface DiscoveredDevice {
  ieeeAddress?: string; friendlyName: string; manufacturer?: string; model?: string;
  powerSource?: PowerSource;
  rawExpose?: unknown;
  data: { key: string; type: string; category: string; unit?: string; enumValues?: string[] }[];
  orders: {
    key: string; type: string; category?: string; min?: number; max?: number;
    enumValues?: string[]; unit?: string;
    valueOn?: string | number | boolean; valueOff?: string | number | boolean;
  }[];
}

interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
  updateDeviceData(integrationId: string, sourceDeviceId: string, payload: Record<string, unknown>): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: string): void;
  /** Available since Sowel v1.5.1 — used by the PJ-1203A handler for baselines. */
  getDeviceDataValue?(integrationId: string, sourceDeviceId: string, key: string): string | number | boolean | null;
  logSummary(): void;
}

interface Logger {
  child(bindings: Record<string, unknown>): Logger;
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

// ============================================================
// Parser
// ============================================================

export interface ParserOptions {
  /** Sowel integration id — the same for every network the plugin serves. */
  integrationId: string;
  /** MQTT base topic of this Z2M instance. */
  baseTopic: string;
  /** Prepended to friendly names to build Sowel source ids. Empty for the primary network. */
  devicePrefix: string;
  mqttConnector: MqttConnector;
  deviceManager: DeviceManager;
  /** Shared across networks so stale cleanup runs on the union of their devices. */
  registry: DiscoveryRegistry;
  logger: Logger;
}

/** One instance per Zigbee2MQTT network; several share the MQTT connection. */
export class Zigbee2MqttParser {
  private logger: Logger;
  private mqttConnector: MqttConnector;
  private deviceManager: DeviceManager;
  private registry: DiscoveryRegistry;
  private integrationId: string;
  private baseTopic: string;
  private devicePrefix: string;
  /** Devices needing a bespoke multi-channel mapping (see pj1203a.ts). */
  private pj1203a: Pj1203aHandler;
  /** null until bridge/info is seen; availability messages are queued meanwhile. */
  private availabilityEnabled: boolean | null = null;
  private pendingAvailability: { deviceName: string; status: "online" | "offline" }[] = [];
  /** Sowel source ids owned by this network, from the last bridge/devices. */
  private knownSourceIds = new Set<string>();
  /** null until bridge/state is seen. */
  private bridgeOnline: boolean | null = null;

  constructor(options: ParserOptions) {
    this.integrationId = options.integrationId;
    this.baseTopic = options.baseTopic;
    this.devicePrefix = options.devicePrefix;
    this.mqttConnector = options.mqttConnector;
    this.deviceManager = options.deviceManager;
    this.registry = options.registry;
    this.logger = options.logger.child({ module: "z2m-parser", baseTopic: options.baseTopic });
    this.pj1203a = new Pj1203aHandler(
      options.integrationId,
      options.devicePrefix,
      options.deviceManager,
      this.logger,
    );
  }

  /**
   * Sowel source device id for a Z2M friendly name on this network.
   * Only the prefix distinguishes two networks, so an id stays stable as long
   * as the base topic list keeps its order.
   */
  private sourceId(friendlyName: string): string {
    return `${this.devicePrefix}${friendlyName}`;
  }

  start(): void {
    this.mqttConnector.subscribe(`${this.baseTopic}/bridge/state`, (_topic, payload) => { this.handleBridgeState(payload); });
    this.mqttConnector.subscribe(`${this.baseTopic}/bridge/info`, (_topic, payload) => { this.handleBridgeInfo(payload); });
    this.mqttConnector.subscribe(`${this.baseTopic}/bridge/devices`, (_topic, payload) => { this.handleBridgeDevices(payload); });
    this.mqttConnector.subscribe(`${this.baseTopic}/bridge/event`, (_topic, payload) => { this.handleBridgeEvent(payload); });
    this.mqttConnector.subscribe(`${this.baseTopic}/+`, (topic, payload) => { this.handleDeviceState(topic, payload); });
    this.mqttConnector.subscribe(`${this.baseTopic}/+/availability`, (topic, payload) => { this.handleDeviceAvailability(topic, payload); });
    this.logger.info({ baseTopic: this.baseTopic }, "Zigbee2MQTT parser started");
  }

  /**
   * Track the Z2M instance itself (`bridge/state`: retained, and the MQTT last
   * will Z2M registers with the broker).
   *
   * A dead Z2M instance is invisible from the device topics alone: it stops
   * publishing, its retained `<device>/availability` topics keep their last
   * "online", and the plugin's own MQTT connection to the broker stays up — so
   * every device of that network sits on a stale "online" for as long as the
   * instance is down. `bridge/state` is the only signal that the whole network
   * went away, so mirror it onto the devices it owns.
   *
   * This matters most on a multi-instance setup, where one dead coordinator
   * leaves the integration "connected" and the rest of the home reporting
   * normally, and on installs that keep Z2M's availability feature disabled,
   * where nothing else can ever mark a device offline.
   */
  private handleBridgeState(payload: Buffer): void {
    const state = parseBridgeState(payload.toString());
    if (state === null) return;
    const online = state === "online";
    if (this.bridgeOnline === online) return;
    const first = this.bridgeOnline === null;
    this.bridgeOnline = online;

    if (online) {
      // Deliberately no mass "online" here: Z2M republishes its cached states
      // on startup (and its availability topics when the feature is on), so
      // devices come back as their own messages arrive. Declaring them up
      // before hearing from them would restore the very lie this fixes.
      if (!first) this.logger.info({}, "Zigbee2MQTT bridge back online");
      return;
    }
    this.markAllOffline();
  }

  /** Mirror a down bridge onto every device it owns. */
  private markAllOffline(): void {
    this.logger.warn(
      { devices: this.knownSourceIds.size },
      "Zigbee2MQTT bridge offline — marking its devices offline",
    );
    for (const sourceDeviceId of this.knownSourceIds) {
      this.deviceManager.updateDeviceStatus(this.integrationId, sourceDeviceId, "offline");
    }
  }

  /**
   * Track whether Z2M's availability feature is enabled (bridge/info, retained).
   *
   * When the feature is disabled, `<device>/availability` topics can only be
   * stale retained leftovers from a time it was enabled — Z2M neither updates
   * nor clears them on disable — and honoring them falsely marks working
   * devices offline at every (re)subscribe. Availability messages that arrive
   * before bridge/info are queued and replayed once the flag is known.
   */
  private handleBridgeInfo(payload: Buffer): void {
    try {
      const info = JSON.parse(payload.toString());
      const enabled = availabilityEnabledFromBridgeInfo(info);
      const previous = this.availabilityEnabled;
      this.availabilityEnabled = enabled;
      if (previous === null || previous !== enabled) {
        this.logger.info({ enabled }, enabled
          ? "Z2M availability feature enabled — availability topics honored"
          : "Z2M availability feature disabled — availability topics ignored (stale retained)");
      }
      const pending = this.pendingAvailability;
      this.pendingAvailability = [];
      if (enabled) for (const p of pending) this.applyAvailability(p.deviceName, p.status);
    } catch (err) { this.logger.error({ err } as Record<string, unknown>, "Failed to parse bridge/info"); }
  }

  private handleBridgeDevices(payload: Buffer): void {
    try {
      const devices: Z2MDevice[] = JSON.parse(payload.toString());
      this.logger.info({ count: devices.length }, "Received bridge/devices");
      const currentNames = new Set<string>();
      const pj1203aNames = new Set<string>();
      for (const z2mDevice of devices) {
        if (z2mDevice.type === "Coordinator") continue;
        if (!z2mDevice.supported || z2mDevice.disabled) continue;

        // Multi-channel energy meter: registered as one Sowel device per channel
        // instead of a single flattened one. Its friendly_name is deliberately
        // absent from currentNames so a monolithic device left over from an
        // older plugin version is garbage-collected below.
        if (isPj1203a(z2mDevice.definition?.model, z2mDevice.model_id)) {
          pj1203aNames.add(z2mDevice.friendly_name);
          for (const sid of this.pj1203a.discover(z2mDevice)) currentNames.add(sid);
          continue;
        }

        currentNames.add(this.sourceId(z2mDevice.friendly_name));
        const parsed = this.parseZ2MDevice(z2mDevice);
        if (parsed) this.deviceManager.upsertFromDiscovery(this.integrationId, "zigbee2mqtt", parsed);
      }
      this.pj1203a.retainOnly(pj1203aNames);
      this.knownSourceIds = currentNames;
      this.registry.report(this.baseTopic, currentNames);
      // Both topics are retained, so on (re)subscribe they can arrive in either
      // order: a bridge already known to be down must still reach the devices
      // discovered after it.
      if (this.bridgeOnline === false) this.markAllOffline();
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
      if (this.pj1203a.isKnown(rest)) {
        this.pj1203a.handleState(rest, data as Record<string, unknown>);
        return;
      }
      this.deviceManager.updateDeviceData(
        this.integrationId,
        this.sourceId(rest),
        data as Record<string, unknown>,
      );
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
        if (this.availabilityEnabled === null) {
          // bridge/info not seen yet — queue instead of trusting blindly.
          if (this.pendingAvailability.length < 512) this.pendingAvailability.push({ deviceName, status });
          return;
        }
        if (!this.availabilityEnabled) {
          this.logger.debug({ deviceName, status } as Record<string, unknown>, "Availability ignored (feature disabled in Z2M)");
          return;
        }
        this.applyAvailability(deviceName, status);
      }
    } catch (err) { this.logger.error({ err, topic } as Record<string, unknown>, "Failed to parse availability"); }
  }

  private applyAvailability(deviceName: string, status: "online" | "offline"): void {
    if (this.pj1203a.isKnown(deviceName)) {
      this.pj1203a.handleAvailability(deviceName, status);
      return;
    }
    this.deviceManager.updateDeviceStatus(this.integrationId, this.sourceId(deviceName), status);
  }

  private parseZ2MDevice(z2mDevice: Z2MDevice): DiscoveredDevice | null {
    const exposes = z2mDevice.definition?.exposes ?? [];
    const allProperties = collectProperties(exposes);
    const data: DiscoveredDevice["data"] = [];
    const orders: DiscoveredDevice["orders"] = [];
    this.flattenExposes(exposes, allProperties, data, orders, z2mDevice.friendly_name);
    return {
      ieeeAddress: z2mDevice.ieee_address,
      // friendlyName drives sourceDeviceId in upsertFromDiscovery — prefixed so
      // two networks can host the same friendly name.
      friendlyName: this.sourceId(z2mDevice.friendly_name),
      manufacturer: z2mDevice.definition?.vendor ?? z2mDevice.manufacturer,
      model: z2mDevice.definition?.model ?? z2mDevice.model_id,
      // Only an explicit Z2M declaration writes powerSource; an absent field
      // stays undefined so core keeps the last known value (device-manager's
      // `?? existing.power_source`) rather than clobbering it to "unknown".
      powerSource: z2mDevice.power_source
        ? mapPowerSource(z2mDevice.power_source)
        : undefined,
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
        const category = inferCategory(expose.property, allProperties, parentExposeType, expose.type);
        data.push({ key: expose.property, type: dataType, category, unit: expose.unit, enumValues: expose.values });
      }

      if (access & Z2M_ACCESS_SET) {
        const orderCat = inferOrderCategory(expose.property, allProperties, parentExposeType, expose.type);
        orders.push({
          key: expose.property, type: dataType, category: orderCat,
          min: expose.value_min, max: expose.value_max, enumValues: expose.values, unit: expose.unit,
          // Wire representations of a binary expose (usually "ON"/"OFF", but
          // some devices use literal booleans or "LOCK"/"UNLOCK"). Core maps
          // boolean order values onto them at dispatch (Sowel >= 1.34), so
          // executeOrder stays a pass-through. Fixes silently dropped
          // {"state": true} payloads (issue #4).
          valueOn: wirePrimitive(expose.value_on), valueOff: wirePrimitive(expose.value_off),
        });
      }
    }
  }
}
