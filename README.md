# Integrated UPS Flow Card

A Home Assistant Lovelace card for **integrated UPS units** — portable power
stations and similar devices where the battery, inverter, charger, and transfer
switch all live in a single sealed box (e.g. **BLUETTI Elite 200 V2**, EcoFlow
Delta, Anker Solix, etc.).

```
   [ PV   ] ----,           ,---- [ GRID ]
                 \  ( SoC )  /
   [ DC   ] ----'           '---- [ AC   ]
```

Four corner nodes for the two inputs (PV, Grid) and two outputs (DC, AC), with
a semicircular state-of-charge gauge in the middle. Flow lines from each corner
animate when their input/output is active; their speed scales with wattage.

## Why does this exist?

The existing power-flow cards model the wrong topology for an integrated UPS:

- **`power-flow-card-plus`** assumes everything feeds a "home" node with the
  battery as a side branch.
- **`enhanced-power-flow-card`** assumes a Victron-style split inverter/charger
  where the inverter is a separate hub from the battery.

A portable power station is **neither**. It's a single integrated unit with two
inputs (grid, solar) and two outputs (DC, AC). The battery, inverter, charger,
and transfer switch all live inside one box. The natural model: four corners
plus a central battery state.

## Install (HACS)

1. In HACS, open **Frontend**.
2. Click the three-dot menu in the top right and choose **Custom repositories**.
3. Add this repo's URL with category **Lovelace**:
   ```
   https://github.com/bigcspecv/bluetti-battery-card
   ```
4. Find **Integrated UPS Flow Card** in the HACS list, click it, then **Download**.
5. Resource registration:
   - In **Settings → Dashboards → ⋮ → Resources**, add:
     - **URL:** `/hacsfiles/bluetti-battery-card/integrated-ups-flow-card.js`
     - **Resource type:** `JavaScript Module`
   - Or add the same URL to your YAML `lovelace.resources` block.
6. Hard-refresh your browser (Ctrl/Cmd+Shift+R).

> Note: the repo is named `bluetti-battery-card` (where the card was first
> built and tested against a BLUETTI Elite 200 V2), but the card itself
> (`integrated-ups-flow-card`) is generic and works with any single-box
> battery+inverter unit.

## Add to a dashboard

After installing, the card appears in the dashboard card picker as
**Integrated UPS Flow Card**. You can also add it via YAML — see the schema
below.

## Configuration

### Schema (v0.2)

```yaml
type: custom:integrated-ups-flow-card
title: Elite 200 V2          # optional header

# Inputs (top corners)
pv:                          # optional — top-left corner
  entity: sensor.elite_200_v2_01_photovoltaics_input_power
  name: PV
  icon: mdi:solar-panel
grid:                        # required — top-right corner
  entity: sensor.elite_200_v2_01_grid_input_power
  name: Grid
  icon: mdi:transmission-tower

# Outputs (bottom corners)
dc:                          # optional — bottom-left corner
  entity: sensor.elite_200_v2_01_direct_current_out_power
  name: DC
  icon: mdi:current-dc
ac:                          # required — bottom-right corner
  entity: sensor.elite_200_v2_01_alternating_current_out_power
  name: AC
  icon: mdi:power-plug

# Battery (center)
unit:
  name: Elite 200 V2
  icon: mdi:power-socket-us
  soc_entity: sensor.elite_200_v2_01_battery_level                    # optional but recommended
  runtime_entity: sensor.elite_200_v2_01_battery_time_in_minutes      # optional
  power_entity: ~                                                     # optional override

options:
  idle_threshold: 5          # W deadband around zero (default 5)
  invert_battery_sign: false # flip if power_entity uses discharge-positive
  max_power: 2600            # W — used to scale flow animation speed
```

### Field reference

| Field | Required | Description |
| --- | --- | --- |
| `title` | no | Header text. Omit to hide. |
| `pv.entity` | no | Solar input watts. Import-only — clamped to ≥ 0. Corner shows "—" when omitted. |
| `pv.name` / `pv.icon` | no | Display name / MDI icon. Defaults: `PV` / `mdi:solar-panel`. |
| `grid.entity` | **yes** | Grid input watts. Import-only — clamped to ≥ 0. |
| `grid.name` / `grid.icon` | no | Defaults: `Grid` / `mdi:transmission-tower`. |
| `dc.entity` | no | DC output watts. Corner shows "—" when omitted. |
| `dc.name` / `dc.icon` | no | Defaults: `DC` / `mdi:current-dc`. |
| `ac.entity` | **yes** | AC output watts. (`load.entity` from v0.1 still accepted as an alias.) |
| `ac.name` / `ac.icon` | no | Defaults: `AC` / `mdi:power-plug`. |
| `unit.name` / `unit.icon` | no | Center battery node display. |
| `unit.soc_entity` | no | Battery SoC 0–100. Drives the arc fill and SoC text. |
| `unit.runtime_entity` | no | Estimated runtime remaining, in minutes. Formatted `Xh Ym`. |
| `unit.power_entity` | no | Battery throughput in watts. Positive = charging, negative = discharging. If omitted, the card derives `(grid + pv) − (ac + dc)`. |
| `options.idle_threshold` | no | Watts deadband used for active/idle decisions. Default `5`. |
| `options.invert_battery_sign` | no | Set `true` if your `power_entity` reports discharge as positive. |
| `options.max_power` | no | Watts used as the upper bound for animation-speed scaling. Default `2600`. |

### Templates

**Every entity field also accepts a Jinja template string** (anything containing
`{{ … }}` or `{% … %}`). Templates are evaluated by Home Assistant via the
real WebSocket `render_template` API — full Jinja, all standard HA helpers
(`states`, `state_attr`, `is_state`, `expand`, `|abs`, `|round`, `|float`,
`{% if %}`, etc.).

Example — clamp a noisy sensor:

```yaml
grid:
  entity: "{{ [states('sensor.grid_input_power') | float(0), 0] | max }}"
```

Example — sum two PV strings:

```yaml
pv:
  entity: >-
    {{ (states('sensor.pv_string_1') | float(0)
        + states('sensor.pv_string_2') | float(0)) | round(0) }}
```

## Flow logic

Once values are resolved:

```
pv_power      = max(0, pv.entity)            (or 0 if pv not set)
grid_power    = max(0, grid.entity)
dc_power      = max(0, dc.entity)            (or 0 if dc not set)
ac_power      = max(0, ac.entity)
battery_power = unit.power_entity (if set, optionally inverted)
                else (grid_power + pv_power) − (ac_power + dc_power)
```

Each flow is **active** when its corner's wattage exceeds `idle_threshold`.

- Active inflows (PV → battery, Grid → battery) animate from the corner toward
  the center.
- Active outflows (battery → AC, battery → DC) animate from the center toward
  the corner.
- Inactive flows are grayed out, not hidden.
- Animation speed scales with `power / max_power`.

Battery state inside the unit:

- `charging` when `battery_power > idle_threshold` (success color, charging icon)
- `discharging` when `battery_power < -idle_threshold` (warning color, draining icon)
- `idle` otherwise (neutral)

The SoC arc fill color follows battery-level conventions:

- **Green** when SoC > 60
- **Amber** when SoC ≤ 60
- **Red** when SoC ≤ 20

## Example: BLUETTI Elite 200 V2

```yaml
type: custom:integrated-ups-flow-card
title: Elite 200 V2
pv:
  entity: sensor.elite_200_v2_01_photovoltaics_input_power
  name: PV
  icon: mdi:solar-panel
grid:
  entity: sensor.elite_200_v2_01_grid_input_power
  name: Grid
  icon: mdi:transmission-tower
dc:
  entity: sensor.elite_200_v2_01_direct_current_out_power
  name: DC
  icon: mdi:current-dc
ac:
  entity: sensor.elite_200_v2_01_alternating_current_out_power
  name: AC
  icon: mdi:power-plug
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
theme. Properties it reads:

- `--ha-card-background` / `--card-background-color` — card background
- `--primary-text-color`, `--secondary-text-color` — labels
- `--primary-color` / `--info-color` — Grid inflow accent
- `--success-color` — PV inflow accent, charging state
- `--warning-color` — AC outflow accent, discharging state
- `--state-binary-sensor-power-on-color` — DC outflow accent
- `--error-color` — low-SoC arc fill
- `--divider-color` — inactive flow lines and arc background
- `--secondary-background-color` — corner icon chip background

## Compatibility notes

- Plain JS, no build step — works on any modern Home Assistant frontend.
- Uses `ResizeObserver` (debounced) and CSS `stroke-dashoffset` animation.
- Cleans up template subscriptions and observers on `disconnectedCallback`.
- `load.entity` from the v0.1 schema is still accepted as an alias for
  `ac.entity` — existing v0.1 configs render in the new layout with the AC
  corner populated and PV/DC shown as "—".

## License

[MIT](./LICENSE)
