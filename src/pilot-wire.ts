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
