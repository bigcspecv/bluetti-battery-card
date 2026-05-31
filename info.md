# Integrated UPS Flow Card

A Home Assistant Lovelace card for **integrated UPS units** — devices where the
battery, inverter, charger, and transfer switch all live in a single sealed box
(e.g. BLUETTI Elite 200 V2).

```
GRID  -->  [ UNIT: battery + inverter ]  -->  LOAD
```

Unlike `power-flow-card-plus` (assumes home-centric topology) or
`enhanced-power-flow-card` (assumes a split Victron-style inverter+battery), this
card models the unit as a single node with battery state shown *inside* it.

**Features**

- Plain JS Web Component — no build step, no external imports
- Theme-aware (uses Home Assistant CSS custom properties)
- Entity IDs **or** Jinja templates for every entity field (evaluated via the
  real HA WebSocket template API)
- Animated power flow with speed scaled to wattage
- Battery glyph with SoC fill plus charge/discharge indicators
- Optional battery throughput and runtime display
- Responsive — recomputes flow paths on resize

See the README for full configuration and install instructions.
