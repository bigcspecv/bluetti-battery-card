# Integrated UPS Flow Card

A Home Assistant Lovelace card for **integrated UPS units** — portable power
stations and similar devices where the battery, inverter, charger, and transfer
switch all live in a single sealed box (e.g. **BLUETTI Elite 200 V2**, EcoFlow
Delta, Anker Solix, etc.).

```
GRID  -->  [ UNIT: battery + inverter ]  -->  LOAD
```

## Why does this exist?

The existing power-flow cards model the wrong topology for an integrated UPS:

- **`power-flow-card-plus`** assumes everything feeds a "home" node with the
  battery as a side branch.
- **`enhanced-power-flow-card`** assumes a Victron-style split inverter/charger
  where the inverter is a separate hub from the battery.

A portable power station is **neither**. It's a single integrated unit — battery,
inverter, charger, and transfer switch in one sealed box. The correct mental
model is three nodes in a row, with the battery's charge/discharge state
displayed *inside* the center unit, not as a separate box.

## Install (HACS)

1. In HACS, open **Frontend**.
2. Click the three-dot menu in the top right and choose **Custom repositories**.
3. Add this repo's URL with category **Lovelace**:
   ```
   https://github.com/bigcspecv/bluetti-battery-card
   ```
4. Find **Integrated UPS Flow Card** in the HACS list, click it, then **Download**.
5. Resource registration:
   - If you're using HA's **Dashboards → Resources** UI, add a resource with:
     - **URL:** `/hacsfiles/bluetti-battery-card/integrated-ups-flow-card.js`
     - **Resource type:** `JavaScript Module`
   - If you're managing dashboards via YAML, add the same URL to your
     `lovelace.resources` block.
6. Hard-refresh your browser (Ctrl/Cmd+Shift+R).

> Note: the repo is named `bluetti-battery-card` (where the card was first built
> and tested against a BLUETTI Elite 200 V2), but the card itself
> (`integrated-ups-flow-card`) is generic and works with any single-box
> battery+inverter unit.

## Add to a dashboard

After installing, the card will appear in the dashboard card picker as
**Integrated UPS Flow Card**. You can also add it via YAML — see the schema
below.

## Configuration

### Schema

```yaml
type: custom:integrated-ups-flow-card
title: Elite 200 V2        # optional header text shown above the flow

grid:
  entity: sensor.elite_200_v2_01_grid_input_power   # required: W from grid, >= 0
  name: Grid                                        # optional, default "Grid"
  icon: mdi:transmission-tower                      # optional

load:
  entity: sensor.elite_200_v2_01_alternating_current_out_power   # required: W to loads
  name: Load                                                     # optional
  icon: mdi:home                                                 # optional

unit:
  name: Elite 200 V2                                # optional, default "UPS"
  icon: mdi:power-socket-us                         # optional
  soc_entity: sensor.elite_200_v2_01_battery_level  # optional: battery %, 0..100
  runtime_entity: sensor.elite_200_v2_01_battery_time_in_minutes  # optional: minutes remaining
  power_entity: ~                                   # optional: +charging / -discharging W.
                                                    # If omitted, derived as grid - load.

options:
  idle_threshold: 5          # W deadband around zero (default 5)
  invert_battery_sign: false # flip if power_entity uses discharge-positive (default false)
  max_power: 2600            # W — used to scale flow animation speed (default 2600)
```

### Field reference

| Field | Required | Description |
| --- | --- | --- |
| `title` | no | Header text shown above the card. Omit to hide. |
| `grid.entity` | **yes** | Watts coming in from the wall. Import-only — values are clamped to ≥ 0. |
| `grid.name` | no | Display name for the grid node. Default `"Grid"`. |
| `grid.icon` | no | MDI icon for the grid node. Default `mdi:transmission-tower`. |
| `load.entity` | **yes** | Watts going out to your loads. |
| `load.name` | no | Display name for the load node. Default `"Load"`. |
| `load.icon` | no | MDI icon for the load node. Default `mdi:home`. |
| `unit.name` | no | Display name for the UPS unit. Default `"UPS"`. |
| `unit.icon` | no | MDI icon for the UPS unit. Default `mdi:power-socket-us`. |
| `unit.soc_entity` | no | Battery state-of-charge, 0–100. Controls the battery glyph fill and SoC text. |
| `unit.runtime_entity` | no | Estimated runtime remaining, in minutes. Formatted as `Xh Ym`. |
| `unit.power_entity` | no | Battery throughput in watts. Positive = charging, negative = discharging. If omitted, the card derives `grid − load`. |
| `options.idle_threshold` | no | Watts deadband around zero used to decide whether a flow / the battery counts as active. Default `5`. |
| `options.invert_battery_sign` | no | Set `true` if your `power_entity` reports discharge as positive (some integrations do). Default `false`. |
| `options.max_power` | no | Watts used as the upper bound for animation-speed scaling. Default `2600`. |

### Templates

**Every entity field also accepts a Jinja template string** (anything containing
`{{ … }}` or `{% … %}`). Templates are evaluated by Home Assistant via the
real WebSocket `render_template` API — full Jinja, all the standard HA helpers
(`states`, `state_attr`, `is_state`, `expand`, `|abs`, `|round`, `|float`,
`{% if %}`, etc.) just work.

Example — combine an L1 + L2 reading into a single AC out value:

```yaml
load:
  entity: >-
    {{ (states('sensor.unit_ac_out_l1') | float(0)
        + states('sensor.unit_ac_out_l2') | float(0)) | round(0) }}
```

Example — clamp a noisy sensor:

```yaml
grid:
  entity: "{{ [states('sensor.grid_input_power') | float(0), 0] | max }}"
```

## Flow logic

Once values are resolved:

```
grid_power     = max(0, grid.entity)
load_power     = load.entity
battery_power  = unit.power_entity (if set, optionally inverted)
                 else grid_power - load_power
```

- `GRID → UNIT` flow active when `grid_power > idle_threshold`. Animation speed
  scales with `grid_power / max_power`. Color: `--primary-color`.
- `UNIT → LOAD` flow active when `load_power > idle_threshold`. Animation speed
  scales with `load_power / max_power`. Color: `--warning-color`.
- Battery state inside the unit node:
  - `charging` when `battery_power > idle_threshold` (success color)
  - `discharging` when `battery_power < -idle_threshold` (warning color)
  - `idle` otherwise (neutral)
- Inactive flows are grayed out, not hidden.

## Example: BLUETTI Elite 200 V2

```yaml
type: custom:integrated-ups-flow-card
title: Elite 200 V2
grid:
  entity: sensor.elite_200_v2_01_grid_input_power
  name: Grid
  icon: mdi:transmission-tower
load:
  entity: sensor.elite_200_v2_01_alternating_current_out_power
  name: Load
  icon: mdi:home
unit:
  name: Elite 200 V2
  icon: mdi:power-socket-us
  soc_entity: sensor.elite_200_v2_01_battery_level
  runtime_entity: sensor.elite_200_v2_01_battery_time_in_minutes
options:
  idle_threshold: 5
  max_power: 2600
```

## Theming

The card uses Home Assistant CSS custom properties so it inherits your active
theme. The properties it reads:

- `--ha-card-background` / `--card-background-color` — node backgrounds
- `--primary-text-color`, `--secondary-text-color` — labels
- `--primary-color` — grid → unit flow accent
- `--warning-color` — unit → load flow accent, discharge state
- `--success-color` — charge state
- `--divider-color` — borders and inactive flow line
- `--secondary-background-color` — icon chip background

## Compatibility notes

- Plain JS, no build step — works on any modern Home Assistant frontend.
- Uses `ResizeObserver` (debounced) and SMIL `animateMotion` for flow dots.
- Cleans up template subscriptions and observers on `disconnectedCallback`.

## License

[MIT](./LICENSE)
