/*
 * integrated-ups-flow-card
 * https://github.com/bigcspecv/bluetti-battery-card
 *
 * A Home Assistant Lovelace card for INTEGRATED UPS units — devices where the
 * battery, inverter, charger, and transfer switch all live in a single sealed
 * box (e.g. BLUETTI Elite 200 V2). Renders a three-node flow:
 *
 *     GRID  -->  [ UNIT: battery + inverter ]  -->  LOAD
 *
 * Plain Web Component, no build step, no external imports — a single file
 * served by HACS.
 */

const CARD_VERSION = '0.1.0';
const CARD_TAG = 'integrated-ups-flow-card';

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
      'Three-node power flow for integrated UPS units (battery + inverter in one box) like BLUETTI Elite 200 V2.',
    preview: false,
    documentationURL: 'https://github.com/bigcspecv/bluetti-battery-card',
  });
}

const DEFAULTS = {
  idle_threshold: 5,
  max_power: 2600,
};

// Animation: longer dur = slower dots; we map low power -> slow, high -> fast.
const ANIM_SLOW_S = 4.0;
const ANIM_FAST_S = 1.0;

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

class IntegratedUpsFlowCard extends HTMLElement {
  static getStubConfig() {
    return {
      title: 'Integrated UPS',
      grid: { entity: '', name: 'Grid', icon: 'mdi:transmission-tower' },
      load: { entity: '', name: 'Load', icon: 'mdi:home' },
      unit: {
        name: 'UPS',
        icon: 'mdi:power-socket-us',
        soc_entity: '',
        runtime_entity: '',
      },
      options: {
        idle_threshold: 5,
        invert_battery_sign: false,
        max_power: 2600,
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
    this._currentDur = { grid: 0, load: 0 };
  }

  // ----- Lovelace lifecycle -----

  setConfig(config) {
    if (!config) throw new Error('Invalid configuration');
    if (!config.grid || !config.grid.entity)
      throw new Error("Missing required config: 'grid.entity'");
    if (!config.load || !config.load.entity)
      throw new Error("Missing required config: 'load.entity'");
    if (!config.unit) throw new Error("Missing required config: 'unit'");

    const opts = config.options || {};
    this._config = {
      title: config.title ?? null,
      grid: {
        entity: String(config.grid.entity),
        name: config.grid.name || 'Grid',
        icon: config.grid.icon || 'mdi:transmission-tower',
      },
      load: {
        entity: String(config.load.entity),
        name: config.load.name || 'Load',
        icon: config.load.icon || 'mdi:home',
      },
      unit: {
        name: config.unit.name || 'UPS',
        icon: config.unit.icon || 'mdi:power-socket-us',
        soc_entity: config.unit.soc_entity ? String(config.unit.soc_entity) : null,
        runtime_entity: config.unit.runtime_entity ? String(config.unit.runtime_entity) : null,
        power_entity: config.unit.power_entity ? String(config.unit.power_entity) : null,
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
      this._scheduleRender(true);
    }
  }

  disconnectedCallback() {
    this._teardownResizeObserver();
    this._resetTemplateSubs();
  }

  getCardSize() {
    return 4;
  }

  // ----- Template subscriptions (real HA WS API) -----

  _templateFields() {
    if (!this._config) return [];
    const c = this._config;
    return [
      c.grid.entity,
      c.load.entity,
      c.unit.soc_entity,
      c.unit.runtime_entity,
      c.unit.power_entity,
    ].filter((f) => f && isTemplate(f));
  }

  _setupTemplateSubs() {
    if (!this._hass || !this._hass.connection || !this._config) return;
    for (const tpl of this._templateFields()) {
      if (this._templateSubs.has(tpl)) continue;
      try {
        const promise = this._hass.connection.subscribeMessage(
          (msg) => {
            const result = msg && Object.prototype.hasOwnProperty.call(msg, 'result')
              ? msg.result
              : msg;
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

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'ups-svg');
    svg.setAttribute('preserveAspectRatio', 'none');
    wrap.appendChild(svg);
    this._svg = svg;

    const gridPath = document.createElementNS(SVG_NS, 'path');
    gridPath.setAttribute('id', `${CARD_TAG}-grid-path-${++IntegratedUpsFlowCard._uid}`);
    gridPath.setAttribute('class', 'flow-path flow-path--grid');
    svg.appendChild(gridPath);
    this._gridPath = gridPath;

    const loadPath = document.createElementNS(SVG_NS, 'path');
    loadPath.setAttribute('id', `${CARD_TAG}-load-path-${IntegratedUpsFlowCard._uid}`);
    loadPath.setAttribute('class', 'flow-path flow-path--load');
    svg.appendChild(loadPath);
    this._loadPath = loadPath;

    this._gridDots = this._createDotsGroup(gridPath.getAttribute('id'), 'flow-dots--grid');
    svg.appendChild(this._gridDots);

    this._loadDots = this._createDotsGroup(loadPath.getAttribute('id'), 'flow-dots--load');
    svg.appendChild(this._loadDots);

    const nodes = document.createElement('div');
    nodes.className = 'ups-nodes';
    wrap.appendChild(nodes);
    this._nodes = nodes;

    this._gridNode = this._createSideNode('grid');
    nodes.appendChild(this._gridNode.root);

    this._unitNode = this._createUnitNode();
    nodes.appendChild(this._unitNode.root);

    this._loadNode = this._createSideNode('load');
    nodes.appendChild(this._loadNode.root);
  }

  _createDotsGroup(pathId, extraClass) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `flow-dots ${extraClass}`);
    const dotCount = 3;
    const dots = [];
    for (let i = 0; i < dotCount; i++) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('r', '4');
      c.setAttribute('class', 'flow-dot');
      c.setAttribute('cx', '0');
      c.setAttribute('cy', '0');
      const m = document.createElementNS(SVG_NS, 'animateMotion');
      m.setAttribute('dur', `${ANIM_SLOW_S}s`);
      m.setAttribute('repeatCount', 'indefinite');
      m.setAttribute('begin', `${(i / dotCount) * ANIM_SLOW_S}s`);
      m.setAttribute('rotate', '0');
      m.setAttribute('fill', 'freeze');
      const mp = document.createElementNS(SVG_NS, 'mpath');
      mp.setAttributeNS(XLINK_NS, 'xlink:href', `#${pathId}`);
      mp.setAttribute('href', `#${pathId}`);
      m.appendChild(mp);
      c.appendChild(m);
      g.appendChild(c);
      dots.push({ circle: c, motion: m });
    }
    g._dots = dots;
    return g;
  }

  _createSideNode(kind) {
    const root = document.createElement('div');
    root.className = `ups-node ups-node--${kind}`;
    const iconWrap = document.createElement('div');
    iconWrap.className = 'ups-node__icon-wrap';
    const icon = document.createElement('ha-icon');
    icon.className = 'ups-node__icon';
    iconWrap.appendChild(icon);
    const name = document.createElement('div');
    name.className = 'ups-node__name';
    const power = document.createElement('div');
    power.className = 'ups-node__power';
    root.appendChild(iconWrap);
    root.appendChild(name);
    root.appendChild(power);
    return { root, icon, name, power };
  }

  _createUnitNode() {
    const root = document.createElement('div');
    root.className = 'ups-node ups-node--unit ups-node--idle';

    const iconWrap = document.createElement('div');
    iconWrap.className = 'ups-node__icon-wrap unit-icon-wrap';
    const icon = document.createElement('ha-icon');
    icon.className = 'ups-node__icon';
    iconWrap.appendChild(icon);

    const name = document.createElement('div');
    name.className = 'ups-node__name unit-name';

    const battery = document.createElementNS(SVG_NS, 'svg');
    battery.setAttribute('class', 'battery-glyph');
    battery.setAttribute('viewBox', '0 0 100 40');
    battery.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const batBody = document.createElementNS(SVG_NS, 'rect');
    batBody.setAttribute('x', '1');
    batBody.setAttribute('y', '2');
    batBody.setAttribute('width', '90');
    batBody.setAttribute('height', '36');
    batBody.setAttribute('rx', '5');
    batBody.setAttribute('ry', '5');
    batBody.setAttribute('class', 'battery-body');
    battery.appendChild(batBody);

    const batCap = document.createElementNS(SVG_NS, 'rect');
    batCap.setAttribute('x', '92');
    batCap.setAttribute('y', '12');
    batCap.setAttribute('width', '6');
    batCap.setAttribute('height', '16');
    batCap.setAttribute('rx', '2');
    batCap.setAttribute('class', 'battery-cap');
    battery.appendChild(batCap);

    const batFill = document.createElementNS(SVG_NS, 'rect');
    batFill.setAttribute('x', '4');
    batFill.setAttribute('y', '5');
    batFill.setAttribute('height', '30');
    batFill.setAttribute('rx', '3');
    batFill.setAttribute('width', '0');
    batFill.setAttribute('class', 'battery-fill');
    battery.appendChild(batFill);

    const bolt = document.createElementNS(SVG_NS, 'path');
    bolt.setAttribute('class', 'battery-bolt');
    bolt.setAttribute(
      'd',
      'M50 6 L34 23 L46 23 L42 34 L60 17 L48 17 Z'
    );
    battery.appendChild(bolt);

    const arrow = document.createElementNS(SVG_NS, 'path');
    arrow.setAttribute('class', 'battery-arrow');
    arrow.setAttribute('d', 'M30 20 L60 20 M52 14 L60 20 L52 26');
    battery.appendChild(arrow);

    const socLabel = document.createElement('div');
    socLabel.className = 'unit-soc';

    const stateLabel = document.createElement('div');
    stateLabel.className = 'unit-state';

    const throughput = document.createElement('div');
    throughput.className = 'unit-throughput';

    const runtime = document.createElement('div');
    runtime.className = 'unit-runtime';

    root.appendChild(iconWrap);
    root.appendChild(name);
    root.appendChild(battery);
    root.appendChild(socLabel);
    root.appendChild(stateLabel);
    root.appendChild(throughput);
    root.appendChild(runtime);

    return {
      root,
      icon,
      name,
      batBody,
      batCap,
      batFill,
      bolt,
      arrow,
      socLabel,
      stateLabel,
      throughput,
      runtime,
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

    const gridP = Math.max(0, toNum(this._getRaw(c.grid.entity)));
    const loadP = toNum(this._getRaw(c.load.entity));

    let battP;
    if (c.unit.power_entity) {
      battP = toNum(this._getRaw(c.unit.power_entity));
      if (opt.invert_battery_sign) battP = -battP;
    } else {
      battP = gridP - loadP;
    }

    const soc = c.unit.soc_entity ? clamp(toNum(this._getRaw(c.unit.soc_entity)), 0, 100) : null;
    const runtimeMin = c.unit.runtime_entity ? toNum(this._getRaw(c.unit.runtime_entity)) : null;

    // ---- Side nodes ----
    this._gridNode.icon.setAttribute('icon', c.grid.icon);
    this._gridNode.name.textContent = c.grid.name;
    this._gridNode.power.textContent = fmtPower(gridP);
    const gridActive = gridP > opt.idle_threshold;
    this._gridNode.root.classList.toggle('is-active', gridActive);

    this._loadNode.icon.setAttribute('icon', c.load.icon);
    this._loadNode.name.textContent = c.load.name;
    this._loadNode.power.textContent = fmtPower(Math.abs(loadP));
    const loadActive = loadP > opt.idle_threshold;
    this._loadNode.root.classList.toggle('is-active', loadActive);

    // ---- Unit node ----
    this._unitNode.icon.setAttribute('icon', c.unit.icon);
    this._unitNode.name.textContent = c.unit.name;
    if (soc === null) {
      this._unitNode.socLabel.textContent = '';
      this._unitNode.batFill.setAttribute('width', '0');
    } else {
      this._unitNode.socLabel.textContent = `${Math.round(soc)}%`;
      // body is x=1, width=90 -> usable inner span ~4..91
      const fillW = Math.max(0, Math.min(86, (soc / 100) * 86));
      this._unitNode.batFill.setAttribute('width', String(fillW));
    }

    let state, accent;
    if (battP > opt.idle_threshold) {
      state = 'charging';
      accent = 'charge';
    } else if (battP < -opt.idle_threshold) {
      state = 'discharging';
      accent = 'discharge';
    } else {
      state = 'idle';
      accent = 'idle';
    }
    this._unitNode.root.classList.remove(
      'ups-node--charge',
      'ups-node--discharge',
      'ups-node--idle'
    );
    this._unitNode.root.classList.add(`ups-node--${accent}`);
    this._unitNode.stateLabel.textContent = state;
    this._unitNode.throughput.textContent =
      accent === 'idle' ? '' : `${accent === 'charge' ? '+' : '−'}${fmtPower(Math.abs(battP))}`;
    this._unitNode.runtime.textContent =
      c.unit.runtime_entity && runtimeMin && runtimeMin > 0 ? fmtRuntime(runtimeMin) : '';

    // ---- Flow paths ----
    this._gridPath.classList.toggle('is-active', gridActive);
    this._loadPath.classList.toggle('is-active', loadActive);
    this._gridDots.classList.toggle('is-active', gridActive);
    this._loadDots.classList.toggle('is-active', loadActive);

    this._maybeSetDur('grid', this._gridDots, this._durFromPower(gridP, opt.max_power));
    this._maybeSetDur('load', this._loadDots, this._durFromPower(loadP, opt.max_power));

    this._updatePaths();
  }

  _durFromPower(p, maxP) {
    const ratio = clamp(Math.abs(p) / Math.max(1, maxP), 0, 1);
    return ANIM_SLOW_S - (ANIM_SLOW_S - ANIM_FAST_S) * ratio;
  }

  // Only update animation timings when the change is meaningful (avoids constant
  // restart hiccups from SMIL when state nudges by 1W every tick).
  _maybeSetDur(key, group, dur) {
    const last = this._currentDur[key] || 0;
    if (Math.abs(last - dur) < 0.15) return;
    this._currentDur[key] = dur;
    if (!group._dots) return;
    const n = group._dots.length;
    for (let i = 0; i < n; i++) {
      const motion = group._dots[i].motion;
      motion.setAttribute('dur', `${dur.toFixed(2)}s`);
      motion.setAttribute('begin', `${((i / n) * dur).toFixed(2)}s`);
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

    const gridRect = this._gridNode.root.getBoundingClientRect();
    const unitRect = this._unitNode.root.getBoundingClientRect();
    const loadRect = this._loadNode.root.getBoundingClientRect();
    const wrapRect = this._wrap.getBoundingClientRect();

    const gridR = {
      x: gridRect.right - wrapRect.left,
      y: gridRect.top + gridRect.height / 2 - wrapRect.top,
    };
    const unitL = {
      x: unitRect.left - wrapRect.left,
      y: unitRect.top + unitRect.height / 2 - wrapRect.top,
    };
    const unitR = {
      x: unitRect.right - wrapRect.left,
      y: unitRect.top + unitRect.height / 2 - wrapRect.top,
    };
    const loadL = {
      x: loadRect.left - wrapRect.left,
      y: loadRect.top + loadRect.height / 2 - wrapRect.top,
    };

    this._gridPath.setAttribute('d', this._buildPath(gridR, unitL));
    this._loadPath.setAttribute('d', this._buildPath(unitR, loadL));
  }

  _buildPath(a, b) {
    const dx = b.x - a.x;
    const cp1x = a.x + dx * 0.4;
    const cp2x = a.x + dx * 0.6;
    const sag = Math.max(6, Math.abs(dx) * 0.04);
    return `M ${a.x} ${a.y} C ${cp1x} ${a.y + sag} ${cp2x} ${b.y + sag} ${b.x} ${b.y}`;
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

IntegratedUpsFlowCard._uid = 0;

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
  min-height: 240px;
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
.flow-path {
  fill: none;
  stroke: var(--divider-color, rgba(127, 127, 127, 0.4));
  stroke-width: 2.5;
  stroke-linecap: round;
  transition: stroke 0.3s ease, opacity 0.3s ease;
  opacity: 0.7;
}
.flow-path.is-active.flow-path--grid {
  stroke: var(--primary-color, #03a9f4);
  opacity: 1;
}
.flow-path.is-active.flow-path--load {
  stroke: var(--warning-color, #ff9800);
  opacity: 1;
}
.flow-dot {
  fill: var(--divider-color, rgba(127, 127, 127, 0.6));
  opacity: 0;
  transition: opacity 0.3s ease;
}
.flow-dots.is-active .flow-dot {
  opacity: 1;
}
.flow-dots--grid.is-active .flow-dot {
  fill: var(--primary-color, #03a9f4);
}
.flow-dots--load.is-active .flow-dot {
  fill: var(--warning-color, #ff9800);
}

.ups-nodes {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1.4fr 1fr;
  align-items: center;
  gap: 8px;
  z-index: 1;
  width: 100%;
  min-height: 240px;
}
.ups-node {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 12px 8px;
  background: var(--ha-card-background, var(--card-background-color, #ffffff));
  border: 1.5px solid var(--divider-color, rgba(127, 127, 127, 0.25));
  border-radius: 14px;
  color: var(--primary-text-color, #212121);
  transition: border-color 0.3s ease, box-shadow 0.3s ease, transform 0.3s ease;
  min-width: 0;
}
.ups-node--unit {
  padding: 14px 10px;
  box-shadow: var(--ha-card-box-shadow, 0 1px 3px rgba(0, 0, 0, 0.08));
}
.ups-node__icon-wrap {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--secondary-background-color, rgba(127, 127, 127, 0.12));
  margin-bottom: 6px;
  transition: background 0.3s ease, color 0.3s ease;
}
.unit-icon-wrap {
  width: 50px;
  height: 50px;
}
.ups-node__icon {
  --mdc-icon-size: 28px;
  color: var(--secondary-text-color, #727272);
  transition: color 0.3s ease;
}
.ups-node--unit .ups-node__icon {
  --mdc-icon-size: 32px;
}
.ups-node--grid.is-active .ups-node__icon { color: var(--primary-color, #03a9f4); }
.ups-node--load.is-active .ups-node__icon { color: var(--warning-color, #ff9800); }
.ups-node--grid.is-active { border-color: var(--primary-color, #03a9f4); }
.ups-node--load.is-active { border-color: var(--warning-color, #ff9800); }
.ups-node--charge { border-color: var(--success-color, #4caf50); }
.ups-node--discharge { border-color: var(--warning-color, #ff9800); }
.ups-node--idle { border-color: var(--divider-color, rgba(127, 127, 127, 0.25)); }

.ups-node__name {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--primary-text-color, #212121);
  word-break: break-word;
}
.ups-node__power {
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--secondary-text-color, #727272);
  margin-top: 2px;
  transition: color 0.3s ease;
}
.ups-node--grid.is-active .ups-node__power { color: var(--primary-color, #03a9f4); }
.ups-node--load.is-active .ups-node__power { color: var(--warning-color, #ff9800); }

.unit-name {
  font-size: 0.95rem;
  font-weight: 600;
  margin-bottom: 2px;
}
.battery-glyph {
  width: 90%;
  max-width: 110px;
  height: 32px;
  margin: 4px 0 4px;
  display: block;
}
.battery-body {
  fill: none;
  stroke: var(--secondary-text-color, #727272);
  stroke-width: 1.5;
  transition: stroke 0.3s ease;
}
.battery-cap {
  fill: var(--secondary-text-color, #727272);
  stroke: none;
  transition: fill 0.3s ease;
}
.battery-fill {
  fill: var(--secondary-text-color, #727272);
  transition: width 0.6s ease, fill 0.3s ease;
}
.battery-bolt {
  fill: var(--ha-card-background, var(--card-background-color, #fff));
  opacity: 0;
  transition: opacity 0.3s ease;
}
.battery-arrow {
  fill: none;
  stroke: var(--ha-card-background, var(--card-background-color, #fff));
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0;
  transition: opacity 0.3s ease;
}
.ups-node--charge .battery-body,
.ups-node--charge .battery-cap { stroke: var(--success-color, #4caf50); fill: var(--success-color, #4caf50); }
.ups-node--charge .battery-body { fill: none; }
.ups-node--charge .battery-fill { fill: var(--success-color, #4caf50); }
.ups-node--charge .battery-bolt { opacity: 1; animation: bolt-pulse 1.6s ease-in-out infinite; }

.ups-node--discharge .battery-body,
.ups-node--discharge .battery-cap { stroke: var(--warning-color, #ff9800); fill: var(--warning-color, #ff9800); }
.ups-node--discharge .battery-body { fill: none; }
.ups-node--discharge .battery-fill { fill: var(--warning-color, #ff9800); }
.ups-node--discharge .battery-arrow { opacity: 1; animation: arrow-slide 1.4s ease-in-out infinite; transform-origin: 45px 20px; }

.ups-node--idle .battery-fill { fill: var(--secondary-text-color, #727272); opacity: 0.6; }

@keyframes bolt-pulse {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50% { opacity: 1; transform: scale(1.06); }
}
@keyframes arrow-slide {
  0% { opacity: 0.4; transform: translateX(-4px); }
  50% { opacity: 1; transform: translateX(2px); }
  100% { opacity: 0.4; transform: translateX(-4px); }
}

.unit-soc {
  font-size: 1.15rem;
  font-weight: 700;
  color: var(--primary-text-color, #212121);
  margin-top: 2px;
}
.unit-state {
  font-size: 0.78rem;
  text-transform: capitalize;
  letter-spacing: 0.02em;
  color: var(--secondary-text-color, #727272);
}
.ups-node--charge .unit-state { color: var(--success-color, #4caf50); }
.ups-node--discharge .unit-state { color: var(--warning-color, #ff9800); }
.unit-throughput {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--secondary-text-color, #727272);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
  min-height: 1.1em;
}
.ups-node--charge .unit-throughput { color: var(--success-color, #4caf50); }
.ups-node--discharge .unit-throughput { color: var(--warning-color, #ff9800); }
.unit-runtime {
  font-size: 0.78rem;
  color: var(--secondary-text-color, #727272);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
  min-height: 1em;
}

@media (max-width: 520px) {
  .ups-card { padding: 12px; }
  .ups-nodes { grid-template-columns: 1fr 1.3fr 1fr; gap: 4px; min-height: 220px; }
  .ups-wrap { min-height: 220px; }
  .ups-node { padding: 8px 4px; border-radius: 12px; }
  .ups-node__icon-wrap { width: 38px; height: 38px; }
  .ups-node__icon { --mdc-icon-size: 22px; }
  .ups-node--unit .ups-node__icon { --mdc-icon-size: 26px; }
  .battery-glyph { height: 26px; }
  .unit-soc { font-size: 1rem; }
  .ups-node__name { font-size: 0.78rem; }
  .ups-node__power { font-size: 0.85rem; }
}
`;

customElements.define(CARD_TAG, IntegratedUpsFlowCard);
