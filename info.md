# Integrated UPS Flow Card

A Home Assistant Lovelace card for **integrated UPS units** — devices where the
battery, inverter, charger, and transfer switch all live in a single sealed box
(e.g. BLUETTI Elite 200 V2).

```
   [ PV   ] ----,           ,---- [ GRID ]
                 \  ( SoC )  /
   [ DC   ] ----'           '---- [ AC   ]
```

Four corners (PV/Grid inputs, DC/AC outputs) with a central semicircular
state-of-charge gauge. Flow lines animate when their input/output is active.

**Features**

- Plain JS Web Component — no build step, no external imports
- Theme-aware (uses Home Assistant CSS custom properties)
- Entity IDs **or** Jinja templates for every entity field (evaluated via the
  real HA WebSocket template API)
- Animated power-flow lines with speed scaled to wattage
- Semicircular SoC gauge whose color follows battery-level conventions
- Staleness signalling — an "updated Xs ago" line whose text reddens when
  readings go stale, plus a red card border when the battery-level entity goes
  unavailable
- Optional DC and PV corners — show "—" when not configured
- Backward-compatible: v0.1 configs using `load:` are accepted and rendered as
  the AC corner

See the README for full configuration and install instructions.
