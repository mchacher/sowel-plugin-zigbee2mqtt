/**
 * Pilot-wire modules (NodOn SIN-4-FP-2x / FPS-4-1-00, ADEO, Legrand cable
 * outlet): Zigbee2MQTT exposes the order on the wire as the enum
 * `pilot_wire_mode`. Sowel has its own vocabulary for it (Sowel spec 217), so
 * the values are translated here, both ways.
 *
 * A value with no translation passes through unchanged: Sowel shows an unknown
 * mode as unknown.
 */

export const PILOT_WIRE_KEY = "pilot_wire_mode";

/** Z2M value → Sowel value, where they differ. */
const TO_SOWEL: ReadonlyMap<string, string> = new Map([
  ["comfort_-1", "comfort_minus_1"],
  ["comfort_-2", "comfort_minus_2"],
]);
const TO_Z2M: ReadonlyMap<string, string> = new Map(
  [...TO_SOWEL].map(([z2m, sowel]) => [sowel, z2m]),
);

/** The values of Zigbee2MQTT's `pilot_wire_mode` preset. */
const Z2M_VALUES: ReadonlySet<string> = new Set([
  "comfort",
  "comfort_-1",
  "comfort_-2",
  "eco",
  "frost_protection",
  "off",
]);

/**
 * Whether an expose speaks the preset's vocabulary. Some devices reuse the
 * property with words of their own (Thaleos TWC-R01: `antifrost`, `comfort_1`):
 * those keep their generic point rather than lose modes.
 */
export function isPilotWireExpose(expose: {
  type: string;
  property?: string;
  values?: string[];
}): boolean {
  return (
    expose.property === PILOT_WIRE_KEY &&
    expose.type === "enum" &&
    !!expose.values?.length &&
    expose.values.every((v) => Z2M_VALUES.has(v))
  );
}

export function pilotModeToSowel(value: string): string {
  return TO_SOWEL.get(value) ?? value;
}

function translate(
  payload: Record<string, unknown>,
  table: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const value = payload[PILOT_WIRE_KEY];
  const translated = typeof value === "string" ? table.get(value) : undefined;
  return translated === undefined ? payload : { ...payload, [PILOT_WIRE_KEY]: translated };
}

/** A device state payload, in Sowel's words. */
export function pilotPayloadToSowel(payload: Record<string, unknown>): Record<string, unknown> {
  return translate(payload, TO_SOWEL);
}

/** A `/set` payload, in Zigbee2MQTT's words. */
export function pilotPayloadToZ2m(payload: Record<string, unknown>): Record<string, unknown> {
  return translate(payload, TO_Z2M);
}
