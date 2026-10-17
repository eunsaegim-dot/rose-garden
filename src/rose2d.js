// Curve-accumulation rose, now with role-based placement: a felt-time
// measurement is classified (see roleClassifier.js) into one of six parts
// of the flower, and fills the NEXT free slot *within that part's own
// pool* — never reshuffling or redrawing anything already revealed, so
// every past participant's stroke is preserved exactly, even across a
// page reload.
//
// The module is split in two: `buildSlotPlan()` is pure data/math (no DOM),
// fully testable in isolation; `Rose2D` wraps it with actual SVG elements.
import { RoleSequencer, POOL_SIZES, PETAL_ROLES } from './roleSequencer.js';

export { AUX_TRIGGER_EVERY } from './roleSequencer.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export const CX = 300;
export const CY = 300;
export const GUIDE_RADIUS = 180;

export const ROLE_ORDER = ['innerPetal', 'corePetal', 'middlePetal', 'outerPetal', 'leaf', 'thorn'];

const COLOR_INNER = '#c9677e'; // deep rose
const COLOR_MID = '#ea9ca1'; // dusty rose / coral
const COLOR_OUTER = '#ffd9c6'; // peach blush
const COLOR_LEAF = '#a7bd8c'; // muted sage green
const COLOR_THORN = '#8a4a52'; // quiet burgundy
const COLOR_STROKE_DARK = '#9c5566';
const WARM_TOUCH = '#ffb199';
const COOL_TOUCH = '#e6b7d6';

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

// Deterministic pseudo-random in [0,1) — same input always gives the same
// output, so reloading the page reconstructs identical geometry.
function hash(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}
function lerpColor(hexA, hexB, t) {
  const a = hexToRgb(hexA);
  const b = hexToRgb(hexB);
  return rgbToHex(a.map((v, i) => v + (b[i] - v) * t));
}
function petalColorHex(t) {
  return t < 0.5 ? lerpColor(COLOR_INNER, COLOR_MID, t * 2) : lerpColor(COLOR_MID, COLOR_OUTER, (t - 0.5) * 2);
}

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---------- shape builders (local space: base at (0,0), grows toward +Y) ----------
function petalBoundaryPoints({ length, width, widthPower, ruffleAmp, ruffleFreq, phase, segs = 14 }) {
  const sample = (u, v) => {
    const w = width * Math.pow(Math.sin(Math.PI * u), widthPower);
    const ruffle =
      1 +
      ruffleAmp * Math.sin(v * ruffleFreq * Math.PI + u * 2.4 + phase) * Math.pow(u, 0.6) +
      ruffleAmp * 0.4 * Math.sin(v * (ruffleFreq * 2.1) + u * 5 + phase * 1.6) * Math.pow(u, 0.85);
    const x = v * (w * 0.5) * ruffle;
    const y = u * length;
    return { x, y };
  };
  const pts = [];
  for (let i = 0; i <= segs; i++) pts.push(sample(i / segs, -1));
  for (let i = segs; i >= 0; i--) pts.push(sample(i / segs, 1));
  return pts;
}

// Narrower and pointier than a petal, with a gentle sideways bend — reads
// as a leaf rather than a flower part.
function leafBoundaryPoints({ length, width, phase, segs = 12 }) {
  const sample = (u, v) => {
    const w = width * Math.pow(Math.sin(Math.PI * u), 0.78);
    const bend = Math.sin(u * Math.PI * 0.8 + phase) * width * 0.1;
    const x = v * (w * 0.5) + bend * (u > 0.1 ? 1 : 0);
    const y = u * length;
    return { x, y };
  };
  const pts = [];
  for (let i = 0; i <= segs; i++) pts.push(sample(i / segs, -1));
  for (let i = segs; i >= 0; i--) pts.push(sample(i / segs, 1));
  return pts;
}

// A small, deliberately soft-cornered spike (the midpoint-quadratic path
// smoothing rounds it slightly) — symbolic rather than sharp.
function thornPoints(length, width) {
  return [
    { x: -width / 2, y: 0 },
    { x: 0, y: length },
    { x: width / 2, y: 0 },
  ];
}

function spiralPoints(radius, turns = 1.6, segs = 40) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const r = radius * t;
    const a = -Math.PI * 0.4 + t * turns * Math.PI * 2;
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  return pts;
}

// Smooths a point list into an SVG path using original points as Bezier
// control handles and midpoints as anchors — simple and numerically safe.
function pointsToPath(points, closed) {
  if (points.length < 3) return '';
  const f = (n) => n.toFixed(2);
  const d = [`M ${f(points[0].x)} ${f(points[0].y)}`];
  for (let i = 1; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    d.push(`Q ${f(p1.x)} ${f(p1.y)} ${f(mx)} ${f(my)}`);
  }
  const last = points[points.length - 1];
  d.push(`Q ${f(last.x)} ${f(last.y)} ${f(last.x)} ${f(last.y)}`);
  if (closed) d.push('Z');
  return d.join(' ');
}

// theta=0 points along world +X; rotate(-90) inside the placement makes a
// shape's local +Y (its "grows toward") axis align with the radial-outward
// direction at that angle, while local X stays tangential (fans sideways)
// at every angle — see the petal-placement note in the project history.
function placementTransform(theta, baseR) {
  const thetaDeg = (theta * 180) / Math.PI;
  return `rotate(${thetaDeg.toFixed(2)} ${CX} ${CY}) translate(${(CX + baseR).toFixed(2)} ${CY}) rotate(-90)`;
}

// ---------- per-role pool configuration ----------
// Radius grows inner -> core -> middle -> outer, matching "closer to 60s
// sits toward the showcase layer; farther on either side moves further
// from it". Every petal pool is confined to PETAL_ARC (never the bottom
// wedge), and leaf/thorn are confined to that wedge instead — the two
// never share any angle, so they can never visually interleave.
const PETAL_ARC_START_DEG = -55;
const PETAL_ARC_SPAN_DEG = 290; // leaves exactly the bottom 70deg (-125..-55) free
const AUX_WEDGE_CENTER_DEG = -90;

// Pool sizes are kept deliberately small — a handful of real participants
// should already cover a meaningful fraction of each ring (instead of
// leaving wide empty gaps that read as "scattered pieces"). The whole
// flower (petals + leaf + thorn) tops out around 30 strokes, matching
// "31+ keeps refining detail, never grows without bound."
const PETAL_POOLS = {
  innerPetal: {
    count: POOL_SIZES.innerPetal - 1, // the 6th slot is the center spiral
    baseR: 20,
    len: 40,
    width: 26,
    widthPower: 0.6,
    ruffle: 0.03,
    colorT: 0.12,
    staggerFrac: 0,
    highlightOpacity: 0.25,
  },
  corePetal: {
    count: POOL_SIZES.corePetal,
    baseR: 52,
    len: 100,
    width: 66,
    widthPower: 0.56,
    ruffle: 0.05,
    colorT: 0.02, // closest to the richest, most saturated deep rose
    staggerFrac: 0.5,
    highlightOpacity: 0.42, // glossiest — the visual highlight of the piece
  },
  middlePetal: {
    count: POOL_SIZES.middlePetal,
    baseR: 92,
    len: 120,
    width: 72,
    widthPower: 0.6,
    ruffle: 0.06,
    colorT: 0.5,
    staggerFrac: 0,
    highlightOpacity: 0.28,
  },
  outerPetal: {
    count: POOL_SIZES.outerPetal,
    baseR: 134,
    len: 150,
    width: 92,
    widthPower: 0.63,
    ruffle: 0.08,
    colorT: 0.85,
    staggerFrac: 0.5,
    highlightOpacity: 0.26,
  },
};

// Small pools, tucked into the one reserved wedge below the flower —
// leaves sit at roughly the same radius as the outer petals (so they read
// as part of the same bloom's base), thorns sit noticeably closer in and
// smaller, as a minimal stem-side accent rather than a flower part.
const LEAF_POOL = { count: POOL_SIZES.leaf, baseR: 130, len: 56, width: 20, angleSpreadDeg: 52, angleCenterDeg: AUX_WEDGE_CENTER_DEG };
const THORN_POOL = { count: POOL_SIZES.thorn, baseR: 78, len: 15, width: 6, angleSpreadDeg: 22, angleCenterDeg: AUX_WEDGE_CENTER_DEG };

function buildPetalSlot(role, cfg, i, seedBase) {
  const slotWidthDeg = PETAL_ARC_SPAN_DEG / cfg.count;
  const thetaDeg =
    PETAL_ARC_START_DEG + (i + cfg.staggerFrac) * slotWidthDeg + (hash(seedBase + 1) - 0.5) * slotWidthDeg * 0.3;
  const theta = (thetaDeg * Math.PI) / 180;
  const baseR = cfg.baseR * (0.94 + hash(seedBase + 2) * 0.12);
  const length = cfg.len * (0.92 + hash(seedBase + 3) * 0.16);
  const width = cfg.width * (0.9 + hash(seedBase + 4) * 0.2);
  const phase = hash(seedBase + 5) * Math.PI * 2;
  const ruffleFreq = 3 + Math.floor(hash(seedBase + 6) * 2);

  const pts = petalBoundaryPoints({ length, width, widthPower: cfg.widthPower, ruffleAmp: cfg.ruffle, ruffleFreq, phase });
  const base = petalColorHex(cfg.colorT);

  return {
    role,
    poolIndex: i,
    type: 'petal',
    localPath: pointsToPath(pts, true),
    transform: placementTransform(theta, baseR),
    baseColor: base,
    strokeColor: lerpColor(base, COLOR_STROKE_DARK, 0.4),
    highlight: { x: -width * 0.12, y: length * 0.38, r: width * 0.32 },
    highlightOpacity: cfg.highlightOpacity,
  };
}

function buildInnerSpiralSlot(seedBase) {
  const radius = 20;
  const pts = spiralPoints(radius);
  const color = petalColorHex(0);
  return {
    role: 'innerPetal',
    poolIndex: -1, // the bud center, planted first within this pool
    type: 'spiral',
    localPath: pointsToPath(pts, false),
    transform: `translate(${CX} ${CY})`,
    baseColor: color,
    strokeColor: lerpColor(color, COLOR_STROKE_DARK, 0.5),
    highlightOpacity: 0,
  };
}

function buildLeafSlot(i, seedBase) {
  const cfg = LEAF_POOL;
  const spread = (cfg.angleSpreadDeg * Math.PI) / 180;
  const center = (cfg.angleCenterDeg * Math.PI) / 180;
  const t = cfg.count > 1 ? i / (cfg.count - 1) - 0.5 : 0;
  const theta = center + t * spread + (hash(seedBase + 1) - 0.5) * 0.12;
  const baseR = cfg.baseR * (0.92 + hash(seedBase + 2) * 0.18);
  const length = cfg.len * (0.9 + hash(seedBase + 3) * 0.2);
  const width = cfg.width * (0.88 + hash(seedBase + 4) * 0.24);
  const phase = hash(seedBase + 5) * Math.PI * 2;

  const pts = leafBoundaryPoints({ length, width, phase });
  return {
    role: 'leaf',
    poolIndex: i,
    type: 'leaf',
    localPath: pointsToPath(pts, true),
    transform: placementTransform(theta, baseR),
    baseColor: COLOR_LEAF,
    strokeColor: lerpColor(COLOR_LEAF, '#4f6b43', 0.4),
    highlight: null,
    highlightOpacity: 0,
  };
}

function buildThornSlot(i, seedBase) {
  const cfg = THORN_POOL;
  const spread = (cfg.angleSpreadDeg * Math.PI) / 180;
  const center = (cfg.angleCenterDeg * Math.PI) / 180;
  const t = cfg.count > 1 ? i / (cfg.count - 1) - 0.5 : 0;
  const theta = center + t * spread + (hash(seedBase + 1) - 0.5) * 0.08;
  const baseR = cfg.baseR * (0.9 + hash(seedBase + 2) * 0.2);
  const length = cfg.len * (0.85 + hash(seedBase + 3) * 0.3);
  const width = cfg.width * (0.85 + hash(seedBase + 4) * 0.3);

  const pts = thornPoints(length, width);
  return {
    role: 'thorn',
    poolIndex: i,
    type: 'thorn',
    localPath: pointsToPath(pts, true),
    transform: placementTransform(theta, baseR),
    baseColor: COLOR_THORN,
    strokeColor: lerpColor(COLOR_THORN, '#4a1f26', 0.3),
    highlight: null,
    highlightOpacity: 0,
  };
}

// Pure, deterministic: builds every role's pool of slots, independent of
// the DOM. Each pool is filled in array order as that role's measurements
// arrive.
export function buildSlotPlan() {
  let seed = 0;
  const nextSeed = () => (seed += 10) * 17;

  const pools = { innerPetal: [], corePetal: [], middlePetal: [], outerPetal: [], leaf: [], thorn: [] };

  pools.innerPetal.push(buildInnerSpiralSlot(nextSeed()));
  for (let i = 0; i < PETAL_POOLS.innerPetal.count; i++) {
    pools.innerPetal.push(buildPetalSlot('innerPetal', PETAL_POOLS.innerPetal, i, nextSeed()));
  }
  for (const role of ['corePetal', 'middlePetal', 'outerPetal']) {
    for (let i = 0; i < PETAL_POOLS[role].count; i++) {
      pools[role].push(buildPetalSlot(role, PETAL_POOLS[role], i, nextSeed()));
    }
  }
  for (let i = 0; i < LEAF_POOL.count; i++) pools.leaf.push(buildLeafSlot(i, nextSeed()));
  for (let i = 0; i < THORN_POOL.count; i++) pools.thorn.push(buildThornSlot(i, nextSeed()));

  return pools;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const LINE_FADE_LEAD = 0.78;
const FADE_DURATION = 0.45;

export class Rose2D {
  constructor(svgRoot, { onPetalClick, onPetalEnter, onPetalMove, onPetalLeave } = {}) {
    this.svg = svgRoot;
    this.onPetalClick = onPetalClick;
    this.onPetalEnter = onPetalEnter;
    this.onPetalMove = onPetalMove;
    this.onPetalLeave = onPetalLeave;
    this.pulseStart = null;
    this._buildDOM();
  }

  get totalSlots() {
    return ROLE_ORDER.reduce((sum, role) => sum + this.pools[role].length, 0);
  }
  get filledCount() {
    return ROLE_ORDER.reduce((sum, role) => sum + this.poolFilled(role), 0);
  }
  poolTotal(role) {
    return this.sequencer.poolTotal(role);
  }
  poolFilled(role) {
    return this.sequencer.poolFilled(role);
  }
  isPoolFull(role) {
    return this.sequencer.isPoolFull(role);
  }

  _buildDOM() {
    this.svg.innerHTML = '';
    this.pools = buildSlotPlan();
    this.sequencer = new RoleSequencer();
    this.pulseStart = null;

    const defs = svgEl('defs');
    this.svg.appendChild(defs);

    this.rootGroup = svgEl('g', { class: 'rose-root' });
    this.svg.appendChild(this.rootGroup);

    this.guideCircle = svgEl('circle', {
      cx: CX,
      cy: CY,
      r: GUIDE_RADIUS,
      fill: 'none',
      stroke: '#c9788a',
      'stroke-width': 1.4,
      'stroke-opacity': 0.5,
      style: 'pointer-events:none',
    });
    this.rootGroup.appendChild(this.guideCircle);

    // A soft, blurred, low-opacity glow — NOT a petal, not tied to any one
    // participant's data. It only appears once at least one real petal
    // exists, purely to visually bridge sparse real petals into a single
    // continuous "rose presence" instead of letting them float in empty
    // space. It never represents a stroke that didn't happen.
    const ghostBlur = svgEl('filter', { id: 'ghostBlur', x: '-80%', y: '-80%', width: '260%', height: '260%' });
    ghostBlur.appendChild(svgEl('feGaussianBlur', { stdDeviation: 28 }));
    defs.appendChild(ghostBlur);
    this.ghostGlow = svgEl('circle', {
      cx: CX,
      cy: CY,
      r: 10,
      fill: '#e39aa0',
      filter: 'url(#ghostBlur)',
      style: 'opacity:0;pointer-events:none',
    });
    this.rootGroup.appendChild(this.ghostGlow);

    // One soft ring-glow per petal role, at that role's own radius band —
    // once a role has even a single real petal, its whole band gets a
    // faint color presence, so that one lonely petal reads as "the start
    // of this ring" rather than a shape floating alone in empty space.
    this.ringGhosts = {};
    for (const role of PETAL_ROLES) {
      const cfg = PETAL_POOLS[role];
      const midR = cfg.baseR + cfg.len / 2;
      const strokeW = cfg.len * 1.05;
      const ring = svgEl('circle', {
        cx: CX,
        cy: CY,
        r: midR.toFixed(1),
        fill: 'none',
        stroke: petalColorHex(cfg.colorT),
        'stroke-width': strokeW.toFixed(1),
        filter: 'url(#ghostBlur)',
        style: 'opacity:0;pointer-events:none',
      });
      this.rootGroup.appendChild(ring);
      this.ringGhosts[role] = ring;
    }

    const petalShadow = svgEl('filter', { id: 'petalShadow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
    petalShadow.appendChild(
      svgEl('feDropShadow', { dx: 0, dy: 1.6, stdDeviation: 2.4, 'flood-color': '#8a4a52', 'flood-opacity': 0.28 })
    );
    defs.appendChild(petalShadow);

    this.petalLayer = svgEl('g', { class: 'petal-layer' });
    this.rootGroup.appendChild(this.petalLayer);

    const hg = svgEl('radialGradient', { id: 'highlightGrad' });
    hg.appendChild(svgEl('stop', { offset: '0%', 'stop-color': '#ffffff', 'stop-opacity': 0.85 }));
    hg.appendChild(svgEl('stop', { offset: '100%', 'stop-color': '#ffffff', 'stop-opacity': 0 }));
    defs.appendChild(hg);

    this.slotStates = {};
    let gradSeq = 0;

    for (const role of ROLE_ORDER) {
      this.slotStates[role] = this.pools[role].map((def) => {
        gradSeq += 1;
        const gradId = `rose-grad-${gradSeq}`;
        const grad = svgEl('linearGradient', { id: gradId, x1: '50%', y1: '100%', x2: '50%', y2: '0%' });
        const stop0 = svgEl('stop', { offset: '0%', 'stop-color': def.baseColor, 'stop-opacity': 0.96 });
        const stop1 = svgEl('stop', {
          offset: '100%',
          'stop-color': lerpColor(def.baseColor, '#fffaf6', 0.5),
          'stop-opacity': 0.75,
        });
        grad.appendChild(stop0);
        grad.appendChild(stop1);
        defs.appendChild(grad);

        const wantsShadow = def.type === 'petal' || def.type === 'leaf';
        const baseFilter = wantsShadow ? 'url(#petalShadow)' : '';
        const g = svgEl('g', {
          transform: def.transform,
          style: `pointer-events:none${baseFilter ? `;filter:${baseFilter}` : ''}`,
        });

        // Thorns (and, a little, leaves) are visually tiny — give them a
        // generously-sized invisible hit target so they stay easy to
        // hover/tap without changing how they look.
        if (def.type === 'thorn' || def.type === 'leaf') {
          const padR = def.type === 'thorn' ? 16 : 22;
          const midY = def.type === 'thorn' ? 8 : 28;
          g.appendChild(svgEl('circle', { cx: 0, cy: midY, r: padR, fill: 'transparent' }));
        }

        const path = svgEl('path', {
          d: def.localPath,
          fill: def.type === 'spiral' ? 'none' : `url(#${gradId})`,
          'fill-opacity': 0,
          stroke: def.strokeColor,
          'stroke-width': def.type === 'thorn' ? 1.3 : def.type === 'spiral' ? 1.6 : 2,
          'stroke-opacity': 0,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        });
        g.appendChild(path);

        let highlight = null;
        if (def.highlight) {
          highlight = svgEl('ellipse', {
            cx: def.highlight.x,
            cy: def.highlight.y,
            rx: def.highlight.r,
            ry: def.highlight.r * 1.6,
            fill: 'url(#highlightGrad)',
            opacity: 0,
            style: 'mix-blend-mode:soft-light',
          });
          g.appendChild(highlight);
        }

        this.petalLayer.appendChild(g);

        const slotState = {
          def,
          g,
          path,
          stop0,
          stop1,
          highlight,
          baseFilter,
          length: 0,
          triggered: false,
          revealed: false,
          feltSeconds: 0,
          lineStart: 0,
          lineEnd: 0,
          fadeStart: 0,
          fadeEnd: 0,
          lineDuration: 0.5,
        };

        if (this.onPetalClick) {
          g.addEventListener('click', (e) => {
            if (slotState.triggered) this.onPetalClick(slotState, e);
          });
        }
        // Hover (mouse only — touch doesn't fire these in modern browsers,
        // so tap-to-show is handled entirely through the click listener
        // above instead). Brightens the hovered part itself; never scales
        // or rotates it.
        g.addEventListener('mouseenter', (e) => {
          if (!slotState.triggered) return;
          g.style.filter = `${slotState.baseFilter} brightness(1.2) saturate(1.08)`.trim();
          this.onPetalEnter?.(slotState, e);
        });
        g.addEventListener('mousemove', (e) => {
          if (slotState.triggered) this.onPetalMove?.(slotState, e);
        });
        g.addEventListener('mouseleave', (e) => {
          if (!slotState.triggered) return;
          g.style.filter = slotState.baseFilter;
          this.onPetalLeave?.(slotState, e);
        });

        return slotState;
      });
    }

    requestAnimationFrame(() => {
      for (const role of ROLE_ORDER) {
        this.slotStates[role].forEach((s) => {
          try {
            s.length = s.path.getTotalLength();
            s.path.style.strokeDasharray = String(s.length);
            s.path.style.strokeDashoffset = String(s.length);
          } catch {
            s.length = 0;
          }
        });
      }
    });
  }

  // feltSeconds: the measured duration (the data point).
  // nowElapsed: current animation-clock seconds, timing this slot's reveal.
  // instant: skip the draw/fade animation (used for restoring saved state).
  // forcedRole: a dev/preview-only escape hatch (see main.js's dev panel)
  // — the real, shared data path never passes it. Classification and the
  // leaf/thorn accumulation counter live in RoleSequencer so the exact
  // same logic can run DOM-free elsewhere (composer.js) for music.
  plant(feltSeconds, nowElapsed, instant = false, forcedRole = null) {
    const result = this.sequencer.next(feltSeconds, forcedRole);
    if (result.overflow) return result;
    if (result.role === 'auxPending') return { ...result, overflow: false };

    const { role, poolIndex } = result;
    const slot = this.slotStates[role][poolIndex];

    const lineDuration = instant ? 0.001 : Math.max(0.45, Math.min(2.4, 0.5 + feltSeconds * 0.04));
    const start = instant ? nowElapsed - 50 : nowElapsed;
    slot.feltSeconds = feltSeconds;
    slot.lineDuration = lineDuration;
    slot.lineStart = start;
    slot.lineEnd = start + lineDuration;
    slot.fadeStart = start + lineDuration * LINE_FADE_LEAD;
    slot.fadeEnd = slot.fadeStart + FADE_DURATION;
    slot.triggered = true;
    slot.g.style.pointerEvents = 'auto';
    slot.g.style.cursor = 'pointer';

    // a faint, data-driven tint — the single trace this measurement leaves.
    const jitter = ((feltSeconds * 37) % 1) - 0.5;
    const touch = jitter >= 0 ? WARM_TOUCH : COOL_TOUCH;
    const amount = Math.abs(jitter) * (slot.def.type === 'petal' ? 0.22 : 0.08);
    slot.stop0.setAttribute('stop-color', lerpColor(slot.def.baseColor, touch, amount));

    return {
      overflow: false,
      role,
      poolIndex,
      filledInRole: this.poolFilled(role),
      poolTotal: this.poolTotal(role),
    };
  }

  pulse(nowElapsed) {
    this.pulseStart = nowElapsed;
  }

  update(nowElapsed) {
    for (const role of ROLE_ORDER) {
      for (const slot of this.slotStates[role]) {
        if (!slot.triggered || slot.length === 0) continue;

        if (nowElapsed < slot.lineEnd) {
          const p = easeOutQuad(clamp((nowElapsed - slot.lineStart) / slot.lineDuration, 0, 1));
          slot.path.style.strokeDashoffset = String(slot.length * (1 - p));
          slot.path.style.strokeOpacity = 0.9;
        } else {
          slot.path.style.strokeDashoffset = '0';
        }

        if (nowElapsed >= slot.fadeStart) {
          const p = clamp((nowElapsed - slot.fadeStart) / FADE_DURATION, 0, 1);
          const eased = easeInOutCubic(p);
          slot.path.style.fillOpacity = String(eased);
          slot.path.style.strokeOpacity = String(0.9 - 0.68 * p);
          if (slot.highlight) {
            slot.highlight.style.opacity = String((slot.def.highlightOpacity ?? 0.3) * eased);
          }
          if (p >= 1) slot.revealed = true;
        }
      }
    }

    const frac = this.totalSlots ? this.filledCount / this.totalSlots : 0;
    const guideProgress = clamp(frac / 0.6, 0, 1);
    this.guideCircle.style.opacity = String(1 - guideProgress);

    const petalFilled = this.sequencer.petalCount();
    if (petalFilled === 0) {
      this.ghostGlow.style.opacity = '0';
    } else {
      const petalTotal = PETAL_ROLES.reduce((sum, r) => sum + this.poolTotal(r), 0);
      const petalFrac = clamp(petalFilled / petalTotal, 0, 1);
      const radius = 55 + petalFrac * 195;
      const opacity = 0.12 + petalFrac * 0.12;
      this.ghostGlow.setAttribute('r', radius.toFixed(1));
      this.ghostGlow.style.opacity = opacity.toFixed(3);
    }

    for (const role of PETAL_ROLES) {
      const filled = this.poolFilled(role);
      const ring = this.ringGhosts[role];
      if (filled === 0) {
        ring.style.opacity = '0';
      } else {
        const ringFrac = filled / this.poolTotal(role);
        ring.style.opacity = (0.05 + ringFrac * 0.13).toFixed(3);
      }
    }

    if (this.pulseStart !== null) {
      const pt = nowElapsed - this.pulseStart;
      if (pt < 0.6) {
        const s = 1 + Math.sin((pt / 0.6) * Math.PI) * 0.03;
        this.rootGroup.setAttribute('transform', `translate(${CX} ${CY}) scale(${s}) translate(${-CX} ${-CY})`);
      } else {
        this.rootGroup.removeAttribute('transform');
        this.pulseStart = null;
      }
    }
  }

  reset() {
    this._buildDOM();
  }
}
