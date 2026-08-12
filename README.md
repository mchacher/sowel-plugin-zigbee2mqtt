# sowel-plugin-zigbee2mqtt

Sowel integration plugin for Zigbee devices exposed by a [Zigbee2MQTT](https://www.zigbee2mqtt.io/) bridge.

It subscribes to `<base_topic>/bridge/devices` for discovery, `<base_topic>/<device>` for state,
`<base_topic>/<device>/availability` for online/offline, and publishes orders to
`<base_topic>/<device>/set`.

## Settings

| Key              | Required | Default      | Description                                 |
| ---------------- | -------- | ------------ | ------------------------------------------- |
| `mqtt_url`       | yes      | —            | `mqtt://host:1883`                          |
| `mqtt_username`  | no       | —            |                                             |
| `mqtt_password`  | no       | —            |                                             |
| `mqtt_client_id` | no       | `sowel-z2m`  | A random suffix is added                    |
| `base_topic`     | no       | `zigbee2mqtt`| Base topic, or a comma-separated list — see below |

Discovery is generic: every expose becomes a device data (readable) and/or a device order (writable),
with its Sowel `DataCategory` inferred from the property name.

## Several Zigbee coordinators

Zigbee2MQTT drives **one coordinator per instance**, so a home with several coordinators runs several
Z2M instances — each with its own `base_topic`, all sharing a single MQTT broker. Sharing a base topic
between instances is not an option: `bridge/devices`, `bridge/info` and `bridge/state` are retained
topics, so the instances would overwrite each other's device list.

The plugin serves them all from one integration. List the base topics in `base_topic`, in a stable
order:

```
zigbee2mqtt, zigbee2mqtt_maison2, zigbee2mqtt_garage
```

- The **first** network is primary: its devices keep their bare `friendly_name` as Sowel source id,
  so an existing install and its equipment bindings survive the upgrade untouched.
- Every **other** network prefixes its devices with its base topic — `zigbee2mqtt_maison2/salon` —
  so two networks hosting the same friendly name stay two distinct Sowel devices.
- An entry can override that prefix with `topic:prefix` (`zigbee2mqtt_maison2:m2` → `m2/salon`), or
  drop it entirely with a trailing colon (`zigbee2mqtt_maison2:` → `salon`). Dropping the prefix is
  only safe when friendly names are unique across networks; on a collision the two devices silently
  become one.

**Do not reorder the list** and do not change a prefix once devices exist: source ids are derived
from it, so any change orphans the affected devices and drops their equipment bindings.

Stale-device cleanup runs on the union of all networks and only once each of them has published its
`bridge/devices`. A network whose Z2M instance is down therefore never gets its devices purged.

Orders are routed back to the owning instance by stripping the prefix from the source id.

Two Zigbee networks in the same building should use **different Zigbee channels** (Z2M's
`advanced.channel`); otherwise they share airtime and both degrade.

### Upgrading from ≤ 2.3.x

Up to 2.3.x the plugin passed the base topic where the core expects an integration id — which only
worked because the default topic and the plugin id are both `zigbee2mqtt`. An install with a custom
`base_topic` had its devices stored under that topic; on first start 2.4.0 migrates them to the
`zigbee2mqtt` integration id, keeping their bindings. Installs on the default topic are unaffected.

## Battery reporting (2.5.0+)

Two things feed Sowel's low-battery monitoring (core spec 143):

- every discovered device declares its **power source** from Zigbee2MQTT's `power_source`
  (`Battery` → `battery`, any `Mains …` → `mains`, `DC Source` → `dc`, anything else → `unknown`),
  so Sowel only warns about devices that actually run on a cell;
- `battery_low` is categorised **battery** instead of `generic`. Sensors that expose only that
  boolean (Tuya ZP01 motion detectors, for instance) were invisible to any battery logic before.

Older Sowel cores ignore the extra field, so the plugin stays compatible with them.

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
