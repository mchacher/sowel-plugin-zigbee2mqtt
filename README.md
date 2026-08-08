# sowel-plugin-zigbee2mqtt

Sowel integration plugin for Zigbee devices exposed by a [Zigbee2MQTT](https://www.zigbee2mqtt.io/) bridge.

It subscribes to `<base_topic>/bridge/devices` for discovery, `<base_topic>/<device>` for state,
`<base_topic>/<device>/availability` for online/offline, and publishes orders to
`<base_topic>/<device>/set`.

## Settings

| Key              | Required | Default      | Description               |
| ---------------- | -------- | ------------ | ------------------------- |
| `mqtt_url`       | yes      | —            | `mqtt://host:1883`        |
| `mqtt_username`  | no       | —            |                           |
| `mqtt_password`  | no       | —            |                           |
| `mqtt_client_id` | no       | `sowel-z2m`  | A random suffix is added  |
| `base_topic`     | no       | `zigbee2mqtt`| Zigbee2MQTT base topic    |

Discovery is generic: every expose becomes a device data (readable) and/or a device order (writable),
with its Sowel `DataCategory` inferred from the property name.

## Tuya PJ-1203A — bidirectional dual-channel energy meter

This meter gets a dedicated mapping (`src/pj1203a.ts`), because the generic flattening cannot feed
Sowel's energy pipeline: the exposes are named per channel (`power_a`, `energy_b`, …) so they all fall
back to the `generic` category, and `energy_a` / `energy_produced_a` are **cumulative kWh counters**
whereas Sowel's `energy` alias is a **signed Wh delta per report**.

The plugin therefore registers **one Sowel device per channel** — exactly like the Shelly Pro 3EM
plugin does for its `em1:N` channels — and publishes the same data set on each:

| Key              | Unit | Category  | Meaning                                                   |
| ---------------- | ---- | --------- | --------------------------------------------------------- |
| `power`          | W    | `power`   | **Signed**: `> 0` consumed/imported, `< 0` produced/exported |
| `voltage`        | V    | `voltage` | Device-level, mirrored on both channels                    |
| `current`        | A    | `current` | Unsigned                                                   |
| `power_factor`   | %    | `generic` |                                                            |
| `energy_flow`    | —    | `generic` | Raw direction: `consuming` / `producing`                   |
| `energy_forward` | Wh   | `energy`  | Raw cumulative import counter (kWh × 1000)                 |
| `energy_reverse` | Wh   | `energy`  | Raw cumulative export counter (kWh × 1000)                 |
| `energy`         | Wh   | `energy`  | **Signed delta** since the previous report                 |

Devices are named `<friendly_name> - ch A` and `<friendly_name> - ch B`.

### Binding in Sowel

Create one equipment per channel and bind with the alias equal to the key:

- **Grid clamp** → equipment type `main_energy_meter`, bind `power` → `power` and `energy` → `energy`.
  `energy_forward` / `energy_reverse` may be bound too; core keeps them as live values and excludes
  them from historization (they are cumuls).
- **PV clamp** → equipment type `energy_production_meter`, same aliases. Wire/configure the clamp so
  production reads as *consuming* on that channel (i.e. `energy` positive), which is what the
  self-consumption writer expects from a production meter.
- **A single circuit** (water heater, EV charger…) → equipment type `energy_meter`, which feeds the
  "by usage" consumption breakdown.

The `EnergyAggregator` triggers on the `energy` alias and computes the hour/day/month/year cumuls
from InfluxDB, so no extra configuration is needed.

### Recommended Zigbee2MQTT options

The PJ-1203A firmware publishes the flow direction **one cycle late**, so for up to
`update_frequency` seconds after a consuming↔producing transition the direction — and therefore the
sign of `power` — can be wrong. Set in Zigbee2MQTT's `configuration.yaml`:

```yaml
devices:
  '0x00124b00xxxxxxxx':
    friendly_name: compteur
    signed_power_a: true
    signed_power_b: true
    update_frequency: 10
```

With `signed_power_x: true`, Z2M publishes an already-signed `power_x` and reports `energy_flow_x` as
the constant `"sign"`; the plugin detects that and passes the value through unchanged. The
alternative is `late_energy_flow_a/b: true`, which delays publication until the direction is known.

The cumulative counters are unaffected by the quirk, so the `energy` deltas — what the energy charts
and cost calculations actually use — are correct either way.

### Upgrading from ≤ 2.2.x

Earlier versions registered the PJ-1203A as a single flattened device. On upgrade it is removed and
replaced by the two channel devices; **any equipment binding pointing at the old device is dropped
and must be recreated**. Nothing is lost history-wise: the old `power_a` / `energy_a` rows were
`generic` and never fed the energy pipeline.

Orders are not exposed on the channel devices — `update_frequency` is device configuration and stays
in Zigbee2MQTT.

## Development

```bash
npm install
npm run build     # tsc → dist/
npm test          # vitest
```

## License

AGPL-3.0
