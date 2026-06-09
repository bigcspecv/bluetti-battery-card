/*
 * integrated-ups-flow-card
 * https://github.com/bigcspecv/bluetti-battery-card
 *
 * A Home Assistant Lovelace card for INTEGRATED UPS units — devices where
 * the battery, inverter, charger, and transfer switch all live in a single
 * sealed box (e.g. BLUETTI Elite 200 V2).
 *
 * Layout (v0.2):
 *
 *   [ PV   ]----,         ,----[ GRID ]
 *               |  ( SoC )  |
 *   [ DC   ]----'         '----[ AC   ]
 *
 * Four corner nodes (PV/Grid in, DC/AC out) with an arc gauge in the
 * middle showing battery state of charge. Lines from each corner are
 * L-shaped with rounded corners and animated when their flow is active.
 *
 * Plain Web Component, no build step, no external imports.
 *
 * v0.5.0 adds a "last updated / Xs ago" staleness indicator. Some
 * integrations (BLUETTI's cloud poller in particular) silently drop their
 * connection and leave entities holding their last value instead of going
 * `unavailable`. The indicator tracks the newest report timestamp across the
 * configured entities and flags the card when that freshness exceeds a
 * configurable threshold.
 */

const CARD_VERSION = '0.5.0';
const CARD_TAG = 'integrated-ups-flow-card';
const EDITOR_TAG = `${CARD_TAG}-editor`;

console.info(
  `%c ${CARD_TAG} %c v${CARD_VERSION} `,
  'color: white; background: #03a9f4; font-weight: 700; padding: 1px 4px; border-radius: 3px 0 0 3px;',
  'color: #03a9f4; background: white; font-weight: 700; padding: 1px 4px; border: 1px solid #03a9f4; border-radius: 0 3px 3px 0;'
);

window.customCards = window.customCards || [];
if (!window.customCards.find((c) => c && c.type === CARD_TAG)) {
  window.customCards.push({
    type: CARD_TAG,
    name: 'Integrated UPS Flow Card',
    description:
      'Four-corner power flow with a central battery arc for integrated UPS units (battery + inverter in one box) like BLUETTI Elite 200 V2.',
    preview: false,
    documentationURL: 'https://github.com/bigcspecv/bluetti-battery-card',
  });
}

const DEFAULTS = {
  idle_threshold: 5,
  max_power: 2600,
  // Seconds since the newest entity report before the card is flagged stale.
  // BLUETTI's cloud poll cadence is well under this, so a steady connection
  // never trips it; a dropped connection climbs past it within ~2 min.
  stale_threshold: 120,
};

// How often (ms) the relative-age line is refreshed so "Xs ago" keeps ticking
// even when no new state arrives (a dropped integration stops pushing hass).
const FRESHNESS_TICK_MS = 1000;

// Flow animation: longer dur = slower; low power -> slow, high -> fast.
const ANIM_SLOW_S = 4.0;
const ANIM_FAST_S = 1.2;

// Arc gauge geometry (in viewBox units; the SVG is scaled to its container).
const ARC_VB = 200; // square viewBox edge
const ARC_CX = ARC_VB / 2;
const ARC_CY = ARC_VB / 2;
const ARC_R = 78;
const ARC_STROKE = 12;
const ARC_START_DEG = 225; // bottom-left
const ARC_SWEEP_DEG = 270; // clockwise through the top to bottom-right

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

function isTemplate(value) {
  return typeof value === 'string' && (value.includes('{{') || value.includes('{%'));
}

function toNum(v, fallback = 0) {
  if (v === null || v === undefined) return fallback;
  if (v === 'unavailable' || v === 'unknown' || v === '') return fallback;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function fmtPower(w) {
  if (!Number.isFinite(w)) return '0 W';
  const a = Math.abs(w);
  if (a >= 1000) return `${(w / 1000).toFixed(2)} kW`;
  return `${Math.round(w)} W`;
}

function fmtRuntime(min) {
  if (!Number.isFinite(min) || min <= 0) return '';
  const total = Math.floor(min);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// Newest "this entity reported" time, in ms, from a frontend state object.
// Prefer last_reported (bumped on every report even when the value is
// unchanged, so a steady-but-alive poll still counts as fresh), then fall
// back to last_updated and last_changed for older HA cores.
function entityFreshnessMs(stateObj) {
  if (!stateObj) return null;
  const ts = stateObj.last_reported || stateObj.last_updated || stateObj.last_changed;
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

// Compact relative age: "12s ago", "4m ago", "1h 3m ago".
function fmtAgo(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.floor(sec);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m ago` : `${h}h ago`;
}

function polarToCartesian(cx, cy, r, angleDeg) {
  // 0° = 12 o'clock, increases clockwise.
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function describeArc(cx, cy, r, startDeg, sweepDeg) {
  if (sweepDeg <= 0) return '';
  const startPt = polarToCartesian(cx, cy, r, startDeg);
  const endPt = polarToCartesian(cx, cy, r, startDeg + sweepDeg);
  const largeArc = sweepDeg > 180 ? 1 : 0;
  return `M ${startPt.x.toFixed(2)} ${startPt.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${endPt.x.toFixed(2)} ${endPt.y.toFixed(2)}`;
}

// L-shaped path from start to end with rounded corner at (start.x, end.y).
// All four corner-to-center paths use "vertical first, then horizontal"
// because the corners are placed above/below the center row.
function buildVThenHPath(start, end, cornerR) {
  if (Math.abs(start.x - end.x) < 0.5 && Math.abs(start.y - end.y) < 0.5) return '';
  const dirY = Math.sign(end.y - start.y) || 1;
  const dirX = Math.sign(end.x - start.x) || 1;
  // If the horizontal offset is too small to fit a rounded corner, fall back to a straight line.
  const vDist = Math.abs(end.y - start.y);
  const hDist = Math.abs(end.x - start.x);
  if (vDist < cornerR + 1 || hDist < cornerR + 1) {
    return `M ${start.x} ${start.y} L ${end.x} ${end.y}`;
  }
  const cx = start.x;
  const cy = end.y;
  const beforeY = cy - dirY * cornerR;
  const afterX = cx + dirX * cornerR;
  return `M ${start.x} ${start.y} L ${cx} ${beforeY} Q ${cx} ${cy} ${afterX} ${cy} L ${end.x} ${end.y}`;
}

class IntegratedUpsFlowCard extends HTMLElement {
  static async getConfigElement() {
    return document.createElement(EDITOR_TAG);
  }

  static getStubConfig() {
    return {
      title: 'Integrated UPS',
      pv: { entity: '', name: 'PV', icon: 'mdi:solar-panel' },
      grid: { entity: '', name: 'Grid', icon: 'mdi:transmission-tower' },
      dc: { entity: '', name: 'DC', icon: 'mdi:current-dc' },
      ac: { entity: '', name: 'AC', icon: 'mdi:power-plug' },
      unit: {
        soc_entity: '',
      },
      display: {
        show_state: true,
        show_throughput: true,
        show_runtime: true,
        show_last_updated: true,
        runtime_entity: '',
        charge_time_entity: '',
      },
      options: {
        idle_threshold: 5,
        invert_battery_sign: false,
        max_power: 2600,
        stale_threshold: 120,
      },
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._templateSubs = new Map();
    this._templateResults = new Map();
    this._initialized = false;
    this._renderQueued = false;
    this._resizeObserver = null;
    this._resizeTimer = null;
    this._freshnessTimer = null;
  }

  // ----- Lovelace lifecycle -----

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');

    // Back-compat: v0.1 used `load:` for AC output. Accept it as an alias for `ac:`.
    const ac = config.ac || config.load || {};
    const grid = config.grid || {};
    const pv = config.pv || {};
    const dc = config.dc || {};
    const unit = config.unit || {};

    // No fields are required. Any/all of pv, grid, dc, ac can be omitted —
    // their corners (and flow lines) just don't render when absent.
    const opts = config.options || {};
    const display = config.display || {};

    this._config = {
      title: config.title ?? null,
      pv: {
        entity: pv.entity ? String(pv.entity) : null,
        name: pv.name || 'PV',
        icon: pv.icon || 'mdi:solar-panel',
      },
      grid: {
        entity: grid.entity ? String(grid.entity) : null,
        name: grid.name || 'Grid',
        icon: grid.icon || 'mdi:transmission-tower',
      },
      dc: {
        entity: dc.entity ? String(dc.entity) : null,
        name: dc.name || 'DC',
        icon: dc.icon || 'mdi:current-dc',
      },
      ac: {
        entity: ac.entity ? String(ac.entity) : null,
        name: ac.name || 'AC',
        icon: ac.icon || 'mdi:power-plug',
      },
      unit: {
        // name / icon are silently preserved for back-compat with v0.2/v0.3
        // configs but no longer rendered anywhere.
        name: unit.name || null,
        icon: unit.icon || null,
        soc_entity: unit.soc_entity ? String(unit.soc_entity) : null,
        power_entity: unit.power_entity ? String(unit.power_entity) : null,
      },
      display: {
        // Visibility toggles default to true so existing configs are unaffected.
        show_state: display.show_state !== false,
        show_throughput: display.show_throughput !== false,
        show_runtime: display.show_runtime !== false,
        // Last-updated / staleness line. On by default — it's the whole point
        // of the card for integrations that freeze instead of going offline.
        show_last_updated: display.show_last_updated !== false,
        // Optional overrides — when set, the rendered line uses the string
        // (templates allowed) instead of the computed default.
        state_template: display.state_template || null,
        throughput_template: display.throughput_template || null,
        runtime_template: display.runtime_template || null,
        // Runtime/charge-time sensors live alongside the show_runtime toggle.
        // For back-compat, v0.4 configs that placed them under `unit:` are
        // still accepted.
        runtime_entity:
          (display.runtime_entity && String(display.runtime_entity)) ||
          (unit.runtime_entity && String(unit.runtime_entity)) ||
          null,
        charge_time_entity:
          (display.charge_time_entity && String(display.charge_time_entity)) ||
          (unit.charge_time_entity && String(unit.charge_time_entity)) ||
          null,
      },
      options: {
        idle_threshold: Number.isFinite(opts.idle_threshold)
          ? opts.idle_threshold
          : DEFAULTS.idle_threshold,
        invert_battery_sign: !!opts.invert_battery_sign,
        max_power:
          Number.isFinite(opts.max_power) && opts.max_power > 0
            ? opts.max_power
            : DEFAULTS.max_power,
        stale_threshold:
          Number.isFinite(opts.stale_threshold) && opts.stale_threshold > 0
            ? opts.stale_threshold
            : DEFAULTS.stale_threshold,
      },
    };

    this._resetTemplateSubs();
    if (this._hass) this._setupTemplateSubs();

    if (this._initialized) {
      this._scheduleRender(true);
    } else if (this.isConnected) {
      this._buildDom();
      this._initialized = true;
      this._scheduleRender(true);
    }
  }

  set hass(hass) {
    const firstSet = !this._hass;
    this._hass = hass;
    if (firstSet && this._config) this._setupTemplateSubs();
    if (this._initialized) this._scheduleRender();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (this._config && !this._initialized) {
      this._buildDom();
      this._initialized = true;
    }
    if (this._initialized) {
      this._setupResizeObserver();
      this._startFreshnessTimer();
      this._scheduleRender(true);
    }
  }

  disconnectedCallback() {
    this._teardownResizeObserver();
    this._stopFreshnessTimer();
    this._resetTemplateSubs();
  }

  getCardSize() {
    return 5;
  }

  // ----- Template subscriptions (real HA WS API) -----

  _templateFields() {
    if (!this._config) return [];
    const c = this._config;
    return [
      c.pv.entity,
      c.grid.entity,
      c.dc.entity,
      c.ac.entity,
      c.unit.soc_entity,
      c.unit.power_entity,
      c.display.runtime_entity,
      c.display.charge_time_entity,
      c.display.state_template,
      c.display.throughput_template,
      c.display.runtime_template,
    ].filter((f) => f && isTemplate(f));
  }

  // Resolve a display-line override: if it's a template, return the latest
  // rendered value; if it's a plain string, return it as-is.
  _resolveOverride(value) {
    if (!value) return null;
    if (isTemplate(value)) {
      return this._templateResults.has(value) ? this._templateResults.get(value) : '';
    }
    return value;
  }

  _setupTemplateSubs() {
    if (!this._hass || !this._hass.connection || !this._config) return;
    for (const tpl of this._templateFields()) {
      if (this._templateSubs.has(tpl)) continue;
      try {
        const promise = this._hass.connection.subscribeMessage(
          (msg) => {
            const result =
              msg && Object.prototype.hasOwnProperty.call(msg, 'result') ? msg.result : msg;
            this._templateResults.set(tpl, result);
            this._scheduleRender();
          },
          { type: 'render_template', template: tpl }
        );
        this._templateSubs.set(tpl, promise);
      } catch (e) {
        console.error(`${CARD_TAG}: subscribeMessage failed for template`, tpl, e);
      }
    }
  }

  _resetTemplateSubs() {
    const subs = Array.from(this._templateSubs.values());
    this._templateSubs.clear();
    this._templateResults.clear();
    for (const p of subs) {
      Promise.resolve(p)
        .then((unsub) => {
          if (typeof unsub === 'function') {
            try {
              unsub();
            } catch (_) {}
          }
        })
        .catch(() => {});
    }
  }

  _getRaw(field) {
    if (!field) return null;
    if (isTemplate(field)) {
      return this._templateResults.has(field) ? this._templateResults.get(field) : null;
    }
    if (!this._hass || !this._hass.states) return null;
    const s = this._hass.states[field];
    return s ? s.state : null;
  }

  // ----- DOM construction (once) -----

  _buildDom() {
    const root = this.shadowRoot;
    root.innerHTML = '';
    const style = document.createElement('style');
    style.textContent = STYLES;
    root.appendChild(style);

    const card = document.createElement('ha-card');
    card.className = 'ups-card';
    root.appendChild(card);
    this._card = card;

    const header = document.createElement('div');
    header.className = 'ups-header';
    card.appendChild(header);
    this._header = header;

    const wrap = document.createElement('div');
    wrap.className = 'ups-wrap';
    card.appendChild(wrap);
    this._wrap = wrap;

    // SVG overlay for all connection paths and the SoC arc.
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ups-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    wrap.appendChild(svg);
    this._svg = svg;

    // One <g> for the four flow paths.
    const flowGroup = document.createElementNS(SVG_NS, 'g');
    flowGroup.setAttribute('class', 'flow-group');
    svg.appendChild(flowGroup);
    this._flowGroup = flowGroup;

    this._flowPaths = {};
    for (const key of ['pv', 'grid', 'dc', 'ac']) {
      const base = document.createElementNS(SVG_NS, 'path');
      base.setAttribute('class', `flow-base flow-base--${key}`);
      flowGroup.appendChild(base);
      const overlay = document.createElementNS(SVG_NS, 'path');
      overlay.setAttribute('class', `flow-overlay flow-overlay--${key}`);
      flowGroup.appendChild(overlay);
      this._flowPaths[key] = { base, overlay };
    }

    // HTML grid for the four corner nodes (the SVG center cell stays empty;
    // the battery info sits inside it as HTML on top of the SVG arc).
    const grid = document.createElement('div');
    grid.className = 'ups-grid';
    wrap.appendChild(grid);
    this._grid = grid;

    this._cornerNodes = {
      pv: this._createCornerNode('pv', 'tl'),
      grid: this._createCornerNode('grid', 'tr'),
      dc: this._createCornerNode('dc', 'bl'),
      ac: this._createCornerNode('ac', 'br'),
    };
    grid.appendChild(this._cornerNodes.pv.root);
    grid.appendChild(this._cornerNodes.grid.root);
    grid.appendChild(this._cornerNodes.dc.root);
    grid.appendChild(this._cornerNodes.ac.root);

    // Center battery info (overlaid on the SoC arc, which lives in SVG).
    this._battery = this._createBatteryCenter();
    grid.appendChild(this._battery.root);
  }

  _createCornerNode(key, position) {
    const root = document.createElement('div');
    root.className = `corner corner--${key} corner--${position}`;

    const iconWrap = document.createElement('div');
    iconWrap.className = 'corner__icon-wrap';
    const icon = document.createElement('ha-icon');
    icon.className = 'corner__icon';
    iconWrap.appendChild(icon);

    const meta = document.createElement('div');
    meta.className = 'corner__meta';
    const power = document.createElement('div');
    power.className = 'corner__power';
    const name = document.createElement('div');
    name.className = 'corner__name';
    meta.appendChild(power);
    meta.appendChild(name);

    if (position === 'tl' || position === 'bl') {
      root.appendChild(iconWrap);
      root.appendChild(meta);
    } else {
      root.appendChild(meta);
      root.appendChild(iconWrap);
    }

    root.addEventListener('click', (e) => this._handleCornerClick(key, e));

    return { root, icon, name, power, iconWrap };
  }

  // Fire `hass-more-info` so the lovelace shell opens its standard dialog.
  _fireMoreInfo(entityId) {
    if (!entityId) return;
    const evt = new Event('hass-more-info', { bubbles: true, composed: true });
    evt.detail = { entityId };
    this.dispatchEvent(evt);
  }

  _handleCornerClick(key, event) {
    if (!this._config) return;
    const cfg = this._config[key];
    if (!cfg || !cfg.entity || isTemplate(cfg.entity)) return;
    event.stopPropagation();
    this._fireMoreInfo(cfg.entity);
  }

  _handleBatteryClick(event) {
    if (!this._config) return;
    const id = this._config.unit && this._config.unit.soc_entity;
    if (!id || isTemplate(id)) return;
    event.stopPropagation();
    this._fireMoreInfo(id);
  }

  _createBatteryCenter() {
    const root = document.createElement('div');
    root.className = 'battery-center';
    root.addEventListener('click', (e) => this._handleBatteryClick(e));

    // The SoC arc is rendered as its own inline SVG (separate from the
    // outer connection-paths SVG) so it can scale neatly via CSS.
    const arcSvg = document.createElementNS(SVG_NS, 'svg');
    arcSvg.setAttribute('class', 'soc-svg');
    arcSvg.setAttribute('viewBox', `0 0 ${ARC_VB} ${ARC_VB}`);
    arcSvg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const arcBg = document.createElementNS(SVG_NS, 'path');
    arcBg.setAttribute('class', 'soc-arc-bg');
    arcBg.setAttribute('d', describeArc(ARC_CX, ARC_CY, ARC_R, ARC_START_DEG, ARC_SWEEP_DEG));
    arcSvg.appendChild(arcBg);

    const arcFill = document.createElementNS(SVG_NS, 'path');
    arcFill.setAttribute('class', 'soc-arc-fill');
    arcFill.setAttribute('d', '');
    arcSvg.appendChild(arcFill);

    root.appendChild(arcSvg);

    const content = document.createElement('div');
    content.className = 'battery-content';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'battery-icon-wrap';
    const icon = document.createElement('ha-icon');
    icon.className = 'battery-icon';
    iconWrap.appendChild(icon);

    const soc = document.createElement('div');
    soc.className = 'battery-soc';
    const socUnit = document.createElement('span');
    socUnit.className = 'battery-soc-unit';
    socUnit.textContent = '%';
    soc.appendChild(document.createTextNode(''));
    soc.appendChild(socUnit);

    const state = document.createElement('div');
    state.className = 'battery-state';

    const throughput = document.createElement('div');
    throughput.className = 'battery-throughput';

    const runtime = document.createElement('div');
    runtime.className = 'battery-runtime';

    // Freshness / staleness line: a small clock icon + relative age. Turns
    // into an alert icon and warning color once the newest reading is older
    // than options.stale_threshold.
    const freshness = document.createElement('div');
    freshness.className = 'battery-freshness';
    const freshnessIcon = document.createElement('ha-icon');
    freshnessIcon.className = 'battery-freshness__icon';
    freshnessIcon.setAttribute('icon', 'mdi:clock-outline');
    const freshnessText = document.createElement('span');
    freshnessText.className = 'battery-freshness__text';
    freshness.appendChild(freshnessIcon);
    freshness.appendChild(freshnessText);

    content.appendChild(iconWrap);
    content.appendChild(soc);
    content.appendChild(state);
    content.appendChild(throughput);
    content.appendChild(runtime);
    content.appendChild(freshness);

    root.appendChild(content);

    return {
      root,
      arcSvg,
      arcBg,
      arcFill,
      icon,
      socText: soc.childNodes[0],
      socEl: soc,
      stateEl: state,
      throughputEl: throughput,
      runtimeEl: runtime,
      freshnessWrap: freshness,
      freshnessIcon,
      freshnessEl: freshnessText,
    };
  }

  // ----- Render -----

  _scheduleRender(immediate = false) {
    if (immediate) {
      this._renderQueued = false;
      this._render();
      return;
    }
    if (this._renderQueued) return;
    this._renderQueued = true;
    requestAnimationFrame(() => {
      this._renderQueued = false;
      this._render();
    });
  }

  _render() {
    if (!this._initialized || !this._config) return;
    const c = this._config;
    const opt = c.options;

    if (c.title) {
      this._header.textContent = c.title;
      this._header.style.display = '';
    } else {
      this._header.style.display = 'none';
    }

    // Read raw values, clamping where the spec is "import only".
    const pvP = c.pv.entity ? Math.max(0, toNum(this._getRaw(c.pv.entity))) : 0;
    const gridP = Math.max(0, toNum(this._getRaw(c.grid.entity)));
    const dcP = c.dc.entity ? Math.max(0, toNum(this._getRaw(c.dc.entity))) : 0;
    const acP = Math.max(0, toNum(this._getRaw(c.ac.entity)));

    let battP;
    if (c.unit.power_entity) {
      battP = toNum(this._getRaw(c.unit.power_entity));
      if (opt.invert_battery_sign) battP = -battP;
    } else {
      // Charge = sources in - loads out. Sources: grid + pv. Loads: ac + dc.
      battP = gridP + pvP - acP - dcP;
    }

    const soc = c.unit.soc_entity ? clamp(toNum(this._getRaw(c.unit.soc_entity)), 0, 100) : null;
    const runtimeMin = c.display.runtime_entity
      ? toNum(this._getRaw(c.display.runtime_entity))
      : null;
    const chargeMin = c.display.charge_time_entity
      ? toNum(this._getRaw(c.display.charge_time_entity))
      : null;

    // ---- Corner nodes ----
    this._updateCorner('pv', c.pv, pvP, opt.idle_threshold, !!c.pv.entity);
    this._updateCorner('grid', c.grid, gridP, opt.idle_threshold, !!c.grid.entity);
    this._updateCorner('dc', c.dc, dcP, opt.idle_threshold, !!c.dc.entity);
    this._updateCorner('ac', c.ac, acP, opt.idle_threshold, !!c.ac.entity);

    // When only one side has corners, shift the battery toward the empty side
    // so the card doesn't look lopsided. With both / neither side populated,
    // the battery stays centered.
    const hasLeft = !!(c.pv.entity || c.dc.entity);
    const hasRight = !!(c.grid.entity || c.ac.entity);
    this._grid.classList.toggle('no-left', !hasLeft && hasRight);
    this._grid.classList.toggle('no-right', hasLeft && !hasRight);

    // ---- Battery center ----
    const batteryClickable = !!c.unit.soc_entity && !isTemplate(c.unit.soc_entity);
    this._battery.root.classList.toggle('is-clickable', batteryClickable);
    this._battery.icon.setAttribute('icon', this._batteryIconForState(soc, battP, opt.idle_threshold));
    if (soc === null) {
      this._battery.socText.nodeValue = '—';
      this._battery.arcFill.setAttribute('d', '');
    } else {
      this._battery.socText.nodeValue = String(Math.round(soc));
      this._battery.arcFill.setAttribute(
        'd',
        describeArc(ARC_CX, ARC_CY, ARC_R, ARC_START_DEG, (ARC_SWEEP_DEG * soc) / 100)
      );
    }

    let stateClass;
    let stateLabel;
    if (battP > opt.idle_threshold) {
      stateClass = 'charge';
      stateLabel = 'charging';
    } else if (battP < -opt.idle_threshold) {
      stateClass = 'discharge';
      stateLabel = 'discharging';
    } else {
      stateClass = 'idle';
      stateLabel = 'idle';
    }
    this._battery.root.classList.remove('state-charge', 'state-discharge', 'state-idle');
    this._battery.root.classList.add(`state-${stateClass}`);

    // Center display lines — each can be hidden via display.show_X, and each
    // can have its content overridden by a (template-aware) string.
    const stateOverride = this._resolveOverride(c.display.state_template);
    const throughputOverride = this._resolveOverride(c.display.throughput_template);
    const runtimeOverride = this._resolveOverride(c.display.runtime_template);

    const defaultThroughput =
      stateClass === 'idle'
        ? ''
        : `${stateClass === 'charge' ? '+' : '−'}${fmtPower(Math.abs(battP))}`;
    let defaultRuntime = '';
    if (stateClass === 'charge' && chargeMin && chargeMin > 0) {
      defaultRuntime = `${fmtRuntime(chargeMin)} to full`;
    } else if (stateClass === 'discharge' && runtimeMin && runtimeMin > 0) {
      defaultRuntime = `${fmtRuntime(runtimeMin)} left`;
    }

    this._setLine(this._battery.stateEl, c.display.show_state, stateOverride, stateLabel);
    this._setLine(
      this._battery.throughputEl,
      c.display.show_throughput,
      throughputOverride,
      defaultThroughput
    );
    this._setLine(
      this._battery.runtimeEl,
      c.display.show_runtime,
      runtimeOverride,
      defaultRuntime
    );

    // SoC level class drives the arc fill color.
    const socLevel =
      soc === null ? 'unknown' : soc > 60 ? 'high' : soc > 20 ? 'medium' : 'low';
    this._battery.root.classList.remove('soc-high', 'soc-medium', 'soc-low', 'soc-unknown');
    this._battery.root.classList.add(`soc-${socLevel}`);

    // ---- Flow paths active state & speed ----
    this._setFlowState('pv', pvP > opt.idle_threshold, pvP, opt.max_power);
    this._setFlowState('grid', gridP > opt.idle_threshold, gridP, opt.max_power);
    this._setFlowState('dc', dcP > opt.idle_threshold, dcP, opt.max_power);
    this._setFlowState('ac', acP > opt.idle_threshold, acP, opt.max_power);

    // Recompute path geometry — node positions can shift on resize.
    this._updatePaths();

    // Refresh the staleness line on every hass push as well as on the timer.
    this._updateFreshness();
  }

  _batteryIconForState(soc, battP, idle) {
    const charging = battP > idle;
    const buckets = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    if (soc === null) return 'mdi:battery-unknown';
    let nearest = 100;
    for (const b of buckets) if (soc <= b) { nearest = b; break; }
    if (nearest === 100) return charging ? 'mdi:battery-charging-100' : 'mdi:battery';
    return charging ? `mdi:battery-charging-${nearest}` : `mdi:battery-${nearest}`;
  }

  _updateCorner(key, cfg, power, idle, present) {
    const node = this._cornerNodes[key];
    // When the entity isn't configured, hide the entire corner — and skip the
    // flow path (set in _updatePaths) — so the layout shows nothing at all.
    if (!present) {
      node.root.style.display = 'none';
      node.root.classList.remove('is-active', 'is-clickable');
      return;
    }
    node.root.style.display = '';
    node.icon.setAttribute('icon', cfg.icon);
    node.name.textContent = cfg.name;
    node.power.textContent = fmtPower(power);
    const active = power > idle;
    node.root.classList.toggle('is-active', active);
    // Clickable only when the entity is a plain entity_id (templates have no
    // single entity to open a more-info dialog for).
    const clickable = !!cfg.entity && !isTemplate(cfg.entity);
    node.root.classList.toggle('is-clickable', clickable);
  }

  _setFlowState(key, active, power, maxPower) {
    const p = this._flowPaths[key];
    if (!p) return;
    p.base.classList.toggle('is-active', active);
    p.overlay.classList.toggle('is-active', active);
    const dur = this._durFromPower(power, maxPower);
    p.overlay.style.setProperty('--flow-dur', `${dur.toFixed(2)}s`);
  }

  _durFromPower(p, maxP) {
    const ratio = clamp(Math.abs(p) / Math.max(1, maxP), 0, 1);
    return ANIM_SLOW_S - (ANIM_SLOW_S - ANIM_FAST_S) * ratio;
  }

  // Set the content of one center display line. Visibility honors `show`;
  // when an override is provided (string or rendered template) it wins over
  // the computed default.
  _setLine(el, show, override, fallback) {
    if (!show) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }
    el.style.display = '';
    const text = override !== null && override !== undefined ? String(override) : fallback;
    el.textContent = text || '';
  }

  // ----- Freshness / staleness -----

  // Plain entity IDs the card is displaying. Templates are skipped — they
  // don't map to a single state object with a report timestamp.
  _freshnessEntityIds() {
    const c = this._config;
    if (!c) return [];
    return [
      c.pv.entity,
      c.grid.entity,
      c.dc.entity,
      c.ac.entity,
      c.unit.soc_entity,
      c.unit.power_entity,
      c.display.runtime_entity,
      c.display.charge_time_entity,
    ].filter((f) => f && !isTemplate(f));
  }

  // Newest report time (ms) across the displayed entities. These all come
  // from the same device, so a live integration keeps at least one of them
  // fresh every poll; a dropped one freezes them all together. Entities in
  // an unavailable/unknown state are ignored so flipping offline can't be
  // mistaken for a fresh report.
  _computeFreshnessMs() {
    if (!this._hass || !this._hass.states) return null;
    let newest = null;
    for (const id of this._freshnessEntityIds()) {
      const s = this._hass.states[id];
      if (!s || s.state === 'unavailable' || s.state === 'unknown') continue;
      const ms = entityFreshnessMs(s);
      if (ms !== null && (newest === null || ms > newest)) newest = ms;
    }
    return newest;
  }

  _updateFreshness() {
    if (!this._battery || !this._config) return;
    const wrap = this._battery.freshnessWrap;
    const ids = this._freshnessEntityIds();

    // Nothing to measure (hidden, or every field is a template) -> no line.
    if (!this._config.display.show_last_updated || ids.length === 0) {
      wrap.style.display = 'none';
      wrap.classList.remove('is-stale');
      if (this._card) this._card.classList.remove('is-stale');
      return;
    }
    wrap.style.display = '';

    const newest = this._computeFreshnessMs();
    if (newest === null) {
      // No usable reading at all — treat as the worst case.
      this._battery.freshnessIcon.setAttribute('icon', 'mdi:clock-alert-outline');
      this._battery.freshnessEl.textContent = 'no data';
      wrap.classList.add('is-stale');
      if (this._card) this._card.classList.add('is-stale');
      return;
    }

    const ageSec = (Date.now() - newest) / 1000;
    const stale = ageSec >= this._config.options.stale_threshold;
    this._battery.freshnessEl.textContent = fmtAgo(ageSec);
    this._battery.freshnessIcon.setAttribute(
      'icon',
      stale ? 'mdi:alert-circle-outline' : 'mdi:clock-outline'
    );
    wrap.classList.toggle('is-stale', stale);
    if (this._card) this._card.classList.toggle('is-stale', stale);
  }

  _startFreshnessTimer() {
    if (this._freshnessTimer) return;
    this._freshnessTimer = setInterval(() => this._updateFreshness(), FRESHNESS_TICK_MS);
  }

  _stopFreshnessTimer() {
    if (this._freshnessTimer) {
      clearInterval(this._freshnessTimer);
      this._freshnessTimer = null;
    }
  }

  _updatePaths() {
    if (!this._wrap || !this._svg) return;
    const w = this._wrap.clientWidth;
    const h = this._wrap.clientHeight;
    if (w <= 0 || h <= 0) return;
    this._svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this._svg.setAttribute('width', String(w));
    this._svg.setAttribute('height', String(h));

    const wrapRect = this._wrap.getBoundingClientRect();

    const cornerRect = (key) => {
      const r = this._cornerNodes[key].iconWrap.getBoundingClientRect();
      return {
        x: r.left + r.width / 2 - wrapRect.left,
        y: r.top + r.height / 2 - wrapRect.top,
        w: r.width,
        h: r.height,
      };
    };

    const batteryRect = this._battery.arcSvg.getBoundingClientRect();
    const battCenter = {
      x: batteryRect.left + batteryRect.width / 2 - wrapRect.left,
      y: batteryRect.top + batteryRect.height / 2 - wrapRect.top,
    };
    // Effective arc radius in screen pixels (the SVG scales the viewBox).
    const arcScreenR = (Math.min(batteryRect.width, batteryRect.height) / ARC_VB) * ARC_R;

    // Anchor points sit just outside the arc, vertically biased toward the
    // corner that owns the line (inputs above center, outputs below) so each
    // L-path's vertical run is short and the line meets its corner naturally.
    const anchorGap = 6;
    const anchorR = arcScreenR + anchorGap;
    const yBias = arcScreenR * 0.45;
    const anchors = {
      pv: { x: battCenter.x - anchorR, y: battCenter.y - yBias },
      grid: { x: battCenter.x + anchorR, y: battCenter.y - yBias },
      dc: { x: battCenter.x - anchorR, y: battCenter.y + yBias },
      ac: { x: battCenter.x + anchorR, y: battCenter.y + yBias },
    };

    // Each path starts at the inner edge of the corner node (vertically
    // toward the middle row) and ends at the matching anchor. Skip absent
    // corners — their flow lines should be invisible.
    const cornerRadius = 18;
    for (const key of ['pv', 'grid', 'dc', 'ac']) {
      const cfg = this._config[key];
      const present = !!(cfg && cfg.entity);
      const p = this._flowPaths[key];
      if (!present) {
        p.base.style.display = 'none';
        p.overlay.style.display = 'none';
        continue;
      }
      p.base.style.display = '';
      p.overlay.style.display = '';
      const r = cornerRect(key);
      const onTop = key === 'pv' || key === 'grid';
      const start = { x: r.x, y: r.y + (onTop ? r.h / 2 : -r.h / 2) };
      const d = buildVThenHPath(start, anchors[key], cornerRadius);
      p.base.setAttribute('d', d);
      p.overlay.setAttribute('d', d);
    }
  }

  // ----- Resize handling -----

  _setupResizeObserver() {
    if (this._resizeObserver || typeof ResizeObserver === 'undefined') return;
    this._resizeObserver = new ResizeObserver(() => {
      if (this._resizeTimer) clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        this._updatePaths();
      }, 100);
    });
    this._resizeObserver.observe(this);
  }

  _teardownResizeObserver() {
    if (this._resizeObserver) {
      try {
        this._resizeObserver.disconnect();
      } catch (_) {}
      this._resizeObserver = null;
    }
    if (this._resizeTimer) {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = null;
    }
  }
}

const STYLES = `
:host {
  display: block;
}
.ups-card {
  padding: 16px;
  box-sizing: border-box;
}
.ups-header {
  font-size: 1.1rem;
  font-weight: 500;
  color: var(--primary-text-color, #212121);
  margin-bottom: 12px;
  padding: 0 4px;
}
.ups-wrap {
  position: relative;
  width: 100%;
  min-height: 320px;
}
.ups-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
  overflow: visible;
}

/* Flow paths --------------------------------------------------------- */
.flow-base {
  fill: none;
  stroke: var(--divider-color, rgba(127, 127, 127, 0.35));
  stroke-width: 3;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: stroke 0.3s ease, opacity 0.3s ease;
}
.flow-overlay {
  fill: none;
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 18 220;
  opacity: 0;
  transition: opacity 0.3s ease, stroke 0.3s ease;
}
.flow-overlay.is-active { opacity: 1; }

.flow-overlay--pv.is-active   { stroke: var(--success-color, #4caf50); animation: flow-in  var(--flow-dur, 2s) linear infinite; }
.flow-overlay--grid.is-active { stroke: var(--info-color, var(--primary-color, #03a9f4)); animation: flow-in  var(--flow-dur, 2s) linear infinite; }
.flow-overlay--ac.is-active   { stroke: var(--warning-color, #ff9800); animation: flow-out var(--flow-dur, 2s) linear infinite; }
.flow-overlay--dc.is-active   { stroke: var(--state-binary-sensor-power-on-color, #64b5f6); animation: flow-out var(--flow-dur, 2s) linear infinite; }

@keyframes flow-in  { from { stroke-dashoffset: 240; } to { stroke-dashoffset: 0; } }
@keyframes flow-out { from { stroke-dashoffset: 0; }   to { stroke-dashoffset: 240; } }

/* Grid layout -------------------------------------------------------- */
.ups-grid {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1.8fr 1fr;
  grid-template-rows: auto 1fr auto;
  grid-template-areas:
    "pv     .       grid"
    ".      battery .   "
    "dc     .       ac  ";
  align-items: center;
  z-index: 1;
  width: 100%;
  min-height: 320px;
  gap: 8px;
}
.corner--tl { grid-area: pv; justify-self: start; }
.corner--tr { grid-area: grid; justify-self: end; }
.corner--bl { grid-area: dc; justify-self: start; }
.corner--br { grid-area: ac; justify-self: end; }
.battery-center { grid-area: battery; justify-self: center; align-self: center; }

/* Balance the layout when only one side has corners: shift the battery
   toward the empty side so the card stops looking lopsided. */
.ups-grid.no-left {
  grid-template-columns: 3fr 0.5fr 1fr;
}
.ups-grid.no-left .battery-center {
  grid-column: 1 / 2;
  grid-row: 1 / 4;
  justify-self: center;
  align-self: center;
}
.ups-grid.no-right {
  grid-template-columns: 1fr 0.5fr 3fr;
}
.ups-grid.no-right .battery-center {
  grid-column: 3 / 4;
  grid-row: 1 / 4;
  justify-self: center;
  align-self: center;
}

/* Corner nodes ------------------------------------------------------- */
.corner {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  max-width: 100%;
}
.corner.is-clickable { cursor: pointer; }
.corner.is-clickable:hover .corner__icon-wrap {
  box-shadow: 0 0 0 2px var(--divider-color, rgba(127, 127, 127, 0.4));
}
.corner__icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--secondary-background-color, rgba(127, 127, 127, 0.14));
  flex-shrink: 0;
  transition: background 0.3s ease, color 0.3s ease, box-shadow 0.3s ease;
}
.corner__icon {
  --mdc-icon-size: 24px;
  color: var(--secondary-text-color, #aaa);
  transition: color 0.3s ease;
}
.corner__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.corner--tr .corner__meta,
.corner--br .corner__meta { align-items: flex-end; text-align: right; }
.corner--tl .corner__meta,
.corner--bl .corner__meta { align-items: flex-start; text-align: left; }
.corner__power {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--primary-text-color, #fff);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.corner__name {
  font-size: 0.78rem;
  color: var(--secondary-text-color, #999);
  letter-spacing: 0.02em;
  margin-top: 1px;
}
.corner.is-absent .corner__power { color: var(--secondary-text-color, #999); }

/* Active highlighting matches the flow color for each direction. */
.corner--pv.is-active   .corner__icon-wrap { background: var(--success-color, #4caf50); }
.corner--grid.is-active .corner__icon-wrap { background: var(--info-color, var(--primary-color, #03a9f4)); }
.corner--ac.is-active   .corner__icon-wrap { background: var(--warning-color, #ff9800); }
.corner--dc.is-active   .corner__icon-wrap { background: var(--state-binary-sensor-power-on-color, #64b5f6); }
.corner.is-active .corner__icon { color: #ffffff; }

/* Battery center ---------------------------------------------------- */
.battery-center {
  position: relative;
  width: 200px;
  height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.battery-center.is-clickable { cursor: pointer; }
.soc-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.soc-arc-bg {
  fill: none;
  stroke: var(--divider-color, rgba(127, 127, 127, 0.28));
  stroke-width: ${ARC_STROKE};
  stroke-linecap: round;
}
.soc-arc-fill {
  fill: none;
  stroke: var(--success-color, #4caf50);
  stroke-width: ${ARC_STROKE};
  stroke-linecap: round;
  transition: d 0.6s ease, stroke 0.3s ease;
}
.battery-center.soc-medium .soc-arc-fill { stroke: var(--warning-color, #ff9800); }
.battery-center.soc-low .soc-arc-fill    { stroke: var(--error-color, var(--label-badge-red, #f44336)); }
.battery-center.soc-unknown .soc-arc-fill { stroke: var(--secondary-text-color, #999); }

.battery-content {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  text-align: center;
  width: 70%;
}
.battery-icon-wrap {
  margin-bottom: 4px;
}
.battery-icon {
  --mdc-icon-size: 26px;
  color: var(--success-color, #4caf50);
  transition: color 0.3s ease;
}
.battery-center.soc-medium .battery-icon { color: var(--warning-color, #ff9800); }
.battery-center.soc-low .battery-icon    { color: var(--error-color, var(--label-badge-red, #f44336)); }
.battery-center.soc-unknown .battery-icon { color: var(--secondary-text-color, #999); }

.battery-soc {
  font-size: 2.6rem;
  font-weight: 700;
  color: var(--primary-text-color, #fff);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
.battery-soc-unit {
  font-size: 1rem;
  margin-left: 2px;
  color: var(--secondary-text-color, #999);
  font-weight: 500;
}
.battery-state {
  font-size: 0.8rem;
  color: var(--secondary-text-color, #999);
  text-transform: capitalize;
  margin-top: 4px;
  letter-spacing: 0.03em;
}
.battery-center.state-charge .battery-state    { color: var(--success-color, #4caf50); }
.battery-center.state-discharge .battery-state { color: var(--warning-color, #ff9800); }
.battery-throughput {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--secondary-text-color, #999);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
  min-height: 1.1em;
}
.battery-center.state-charge .battery-throughput    { color: var(--success-color, #4caf50); }
.battery-center.state-discharge .battery-throughput { color: var(--warning-color, #ff9800); }
.battery-runtime {
  font-size: 0.78rem;
  color: var(--secondary-text-color, #999);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
  min-height: 1em;
}
.battery-freshness {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 0.72rem;
  color: var(--secondary-text-color, #999);
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
  min-height: 1em;
  transition: color 0.3s ease;
}
.battery-freshness__icon {
  --mdc-icon-size: 13px;
  color: inherit;
}
.battery-freshness.is-stale {
  color: var(--error-color, var(--label-badge-red, #f44336));
  font-weight: 600;
}

/* Stale state: ring the card and dim the (frozen) readings so the values
   are obviously not to be trusted at a glance from the dashboard. */
.ups-card.is-stale {
  box-shadow: inset 0 0 0 2px var(--error-color, var(--label-badge-red, #f44336));
}
.ups-card.is-stale .corner__power,
.ups-card.is-stale .battery-soc,
.ups-card.is-stale .battery-state,
.ups-card.is-stale .battery-throughput,
.ups-card.is-stale .battery-runtime {
  opacity: 0.5;
  transition: opacity 0.3s ease;
}

/* Responsive --------------------------------------------------------- */
@media (max-width: 560px) {
  .ups-card { padding: 12px; }
  .ups-wrap { min-height: 280px; }
  .ups-grid { min-height: 280px; gap: 4px; grid-template-columns: 1fr 1.4fr 1fr; }
  .corner__icon-wrap { width: 36px; height: 36px; }
  .corner__icon { --mdc-icon-size: 20px; }
  .corner__power { font-size: 1rem; }
  .corner__name { font-size: 0.72rem; }
  .battery-center { width: 160px; height: 160px; }
  .battery-icon { --mdc-icon-size: 22px; }
  .battery-soc { font-size: 2.1rem; }
  .battery-soc-unit { font-size: 0.85rem; }
}
`;

customElements.define(CARD_TAG, IntegratedUpsFlowCard);

/* =========================================================================
 * Visual editor — exposes the YAML schema as a ha-form so the card can be
 * added and tuned from the Lovelace UI without writing YAML.
 *
 * ha-form is provided by the Home Assistant frontend. We just render one,
 * give it our schema + the current config as `data`, and forward its
 * `value-changed` event as a `config-changed` event the Lovelace editor
 * pipeline understands.
 * ========================================================================= */

const ENTITY_SELECTOR = { entity: { filter: { domain: 'sensor' } } };
const TEMPLATE_SELECTOR = { template: {} };

// Top-level field labels (shown on the form input)
const EDITOR_LABELS = {
  title: 'Card title',
  pv: 'PV input (top-left)',
  grid: 'Grid input (top-right)',
  dc: 'DC output (bottom-left)',
  ac: 'AC output (bottom-right)',
  unit: 'Battery (center)',
  display: 'Center display lines',
  options: 'Options',
  entity: 'Entity',
  name: 'Display name',
  icon: 'Icon',
  soc_entity: 'Battery level (state of charge)',
  runtime_entity: 'Runtime remaining sensor (minutes, while discharging)',
  charge_time_entity: 'Time-to-full sensor (minutes, while charging)',
  power_entity: 'Battery power sensor (± W, optional)',
  show_state: 'Show charging / discharging / idle label',
  show_throughput: 'Show battery throughput (± W)',
  show_runtime: 'Show estimated runtime',
  show_last_updated: 'Show last-updated / staleness indicator',
  state_template: 'Override the state label',
  throughput_template: 'Override the throughput line',
  runtime_template: 'Override the runtime line',
  idle_threshold: 'Idle threshold (W)',
  max_power: 'Max power for animation scaling (W)',
  stale_threshold: 'Stale threshold (seconds)',
  invert_battery_sign: 'Invert sign of battery power sensor',
};

// Per-field helper text rendered under the input.
const EDITOR_HELPERS = {
  title: 'Optional header shown at the top of the card.',
  entity: 'A sensor reading watts. Switch to YAML if you need a Jinja template here.',
  soc_entity: 'Optional, but recommended. Without it the SoC arc and percentage are blank.',
  runtime_entity:
    "Reports time remaining while discharging (e.g. BLUETTI's battery_time_in_minutes). Reads 0 when not discharging.",
  charge_time_entity:
    "Reports time to full while charging (e.g. BLUETTI's full_charge_time_in_minutes). When set, the runtime line shows 'Xh Ym to full' during charging and 'Xh Ym left' during discharging.",
  power_entity:
    'Advanced. Most integrations do not expose this directly — leave empty and the card will derive battery throughput as (PV + Grid) − (AC + DC). Set only if your integration provides a single ± W battery sensor.',
  state_template:
    'Plain string or Jinja template. Empty = use the default (charging / discharging / idle).',
  throughput_template:
    'Plain string or Jinja template. Empty = use the default (+1.10 kW / −0.35 kW).',
  runtime_template:
    'Plain string or Jinja template. Empty = use the default runtime line (charge-time or runtime, see above).',
  idle_threshold:
    'Power values below this are treated as no flow (line stays gray). Default 5 W.',
  max_power:
    'Wattage that maps to the fastest dot animation. Higher wattages clamp to this; lower wattages slow proportionally. Default 2600 W.',
  show_last_updated:
    'Shows how long ago the displayed entities last reported. Useful when an integration silently drops and entities keep their last value instead of going unavailable.',
  stale_threshold:
    'When the newest reading is older than this many seconds, the indicator turns red and the card readings dim. Default 120 s.',
  invert_battery_sign:
    "Only relevant when 'Battery power sensor' above is set. Toggle on if that sensor reports discharge as positive (some integrations).",
};

// Build the form schema dynamically so override fields only appear when their
// corresponding toggle is on, and `invert_battery_sign` is only offered when
// a `power_entity` is configured.
function buildEditorSchema(config) {
  const c = config || {};
  const u = c.unit || {};
  const d = c.display || {};

  const displaySchema = [];
  displaySchema.push({ name: 'show_state', selector: { boolean: {} } });
  if (d.show_state !== false) {
    displaySchema.push({ name: 'state_template', selector: TEMPLATE_SELECTOR });
  }
  displaySchema.push({ name: 'show_throughput', selector: { boolean: {} } });
  if (d.show_throughput !== false) {
    displaySchema.push({ name: 'throughput_template', selector: TEMPLATE_SELECTOR });
  }
  displaySchema.push({ name: 'show_runtime', selector: { boolean: {} } });
  if (d.show_runtime !== false) {
    displaySchema.push({ name: 'runtime_entity', selector: ENTITY_SELECTOR });
    displaySchema.push({ name: 'charge_time_entity', selector: ENTITY_SELECTOR });
    displaySchema.push({ name: 'runtime_template', selector: TEMPLATE_SELECTOR });
  }
  displaySchema.push({ name: 'show_last_updated', selector: { boolean: {} } });

  const optionsSchema = [
    {
      name: 'idle_threshold',
      selector: {
        number: { min: 0, max: 200, step: 1, mode: 'box', unit_of_measurement: 'W' },
      },
    },
    {
      name: 'max_power',
      selector: {
        number: { min: 100, max: 20000, step: 100, mode: 'box', unit_of_measurement: 'W' },
      },
    },
    {
      name: 'stale_threshold',
      selector: {
        number: { min: 10, max: 3600, step: 5, mode: 'box', unit_of_measurement: 's' },
      },
    },
  ];
  if (u.power_entity) {
    optionsSchema.push({ name: 'invert_battery_sign', selector: { boolean: {} } });
  }

  return [
    { name: 'title', selector: { text: {} } },
    {
      name: 'pv',
      type: 'expandable',
      title: 'PV input (top-left)',
      schema: [
        { name: 'entity', selector: ENTITY_SELECTOR },
        { name: 'name', selector: { text: {} } },
        { name: 'icon', selector: { icon: {} } },
      ],
    },
    {
      name: 'grid',
      type: 'expandable',
      title: 'Grid input (top-right)',
      schema: [
        { name: 'entity', selector: ENTITY_SELECTOR },
        { name: 'name', selector: { text: {} } },
        { name: 'icon', selector: { icon: {} } },
      ],
    },
    {
      name: 'dc',
      type: 'expandable',
      title: 'DC output (bottom-left)',
      schema: [
        { name: 'entity', selector: ENTITY_SELECTOR },
        { name: 'name', selector: { text: {} } },
        { name: 'icon', selector: { icon: {} } },
      ],
    },
    {
      name: 'ac',
      type: 'expandable',
      title: 'AC output (bottom-right)',
      schema: [
        { name: 'entity', selector: ENTITY_SELECTOR },
        { name: 'name', selector: { text: {} } },
        { name: 'icon', selector: { icon: {} } },
      ],
    },
    {
      name: 'unit',
      type: 'expandable',
      title: 'Battery (center)',
      schema: [
        { name: 'soc_entity', selector: ENTITY_SELECTOR },
        { name: 'power_entity', selector: ENTITY_SELECTOR },
      ],
    },
    {
      name: 'display',
      type: 'expandable',
      title: 'Center display lines',
      schema: displaySchema,
    },
    {
      name: 'options',
      type: 'expandable',
      title: 'Options',
      schema: optionsSchema,
    },
  ];
}

class IntegratedUpsFlowCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._config = null;
    this._hass = null;
    this._form = null;
  }

  setConfig(config) {
    this._config = this._normalize(config);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  connectedCallback() {
    if (!this._form) {
      const style = document.createElement('style');
      style.textContent = `
        :host { display: block; }
        ha-form { display: block; padding: 8px 0; }
        .hint {
          font-size: 0.8rem;
          color: var(--secondary-text-color, #888);
          padding: 4px 8px 12px;
        }
      `;
      this.shadowRoot.appendChild(style);

      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent =
        'Every field is optional. Configured corners are clickable (opens the entity more-info dialog); unconfigured corners are hidden along with their flow line.';
      this.shadowRoot.appendChild(hint);

      const form = document.createElement('ha-form');
      this.shadowRoot.appendChild(form);
      this._form = form;

      form.addEventListener('value-changed', (ev) => {
        ev.stopPropagation();
        const newConfig = ev.detail && ev.detail.value ? ev.detail.value : {};
        this._config = newConfig;
        this.dispatchEvent(
          new CustomEvent('config-changed', {
            detail: { config: newConfig },
            bubbles: true,
            composed: true,
          })
        );
      });
    }
    this._render();
  }

  _normalize(config) {
    const c = { ...(config || {}) };

    // v0.1 used `load:` for AC output. Surface it in the editor as `ac:` and
    // drop `load:` so saves write only the modern key.
    if (c.load && !c.ac) {
      c.ac = c.load;
    }
    delete c.load;

    // v0.4 placed runtime/charge_time sensors under `unit:`. v0.4.1 moved them
    // under `display:` next to the show_runtime toggle. Migrate so the form
    // populates from existing configs and saves only the new location.
    const unit = { ...(c.unit || {}) };
    const display = { ...(c.display || {}) };
    if (unit.runtime_entity && !display.runtime_entity) {
      display.runtime_entity = unit.runtime_entity;
    }
    if (unit.charge_time_entity && !display.charge_time_entity) {
      display.charge_time_entity = unit.charge_time_entity;
    }
    delete unit.runtime_entity;
    delete unit.charge_time_entity;
    c.unit = unit;
    c.display = display;

    return c;
  }

  _render() {
    if (!this._form) return;
    this._form.hass = this._hass;
    this._form.schema = buildEditorSchema(this._config || {});
    this._form.data = this._config || {};
    this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] || schema.name;
    this._form.computeHelper = (schema) => EDITOR_HELPERS[schema.name] || undefined;
  }
}

customElements.define(EDITOR_TAG, IntegratedUpsFlowCardEditor);
