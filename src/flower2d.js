// An abstract, generative flower -- not a rose, not any real species. Each
// participant's felt-time record becomes exactly one petal, leaf, or
// stamen (see flowerModel.js/roleClassifier.js); nothing is ever added to
// "fill out" the shape, so a flower with 0 petals or 0 stamens is a fully
// legitimate, intentional result.
//
// Placement is phyllotaxis-based (the golden-angle "sunflower seed"
// pattern): an element's angle/radius depend ONLY on its own index within
// its own type (0, 1, 2, ... -- never on the type's eventual final count),
// so a new participant's element is simply the next step outward along the
// same spiral and never moves anything already drawn. Per-record jitter
// (size/angle/radius wobble, stamen strand count) is seeded from the
// record's own Firestore id, so the exact same stored data always draws
// the exact same flower, on any device, after any reload.
const SVG_NS = 'http://www.w3.org/2000/svg';

export const CX = 150;
export const CY = 150;
export const VIEW_SIZE = 300;

const GOLDEN_ANGLE_DEG = 137.50776;

const COLOR_PETAL_A = '#ffd9df'; // pale blush pink
const COLOR_PETAL_B = '#e8a0ab'; // rose pink
const COLOR_PETAL_C = '#fff3ea'; // cream
const COLOR_LEAF_A = '#a7bd8c'; // sage green
const COLOR_LEAF_B = '#c7d9a8'; // light green
const COLOR_STAMEN = '#e0b24a'; // warm yellow
const COLOR_STAMEN_TIP = '#f3dba0'; // cream-yellow pollen
const COLOR_THORN = '#8a4a52'; // quiet burgundy
const COLOR_ROOT = '#a9805a'; // earthy brown
const STROKE_SOFT = '#c9a0a8';

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

// Deterministic pseudo-random in [0,1) -- same input always gives the
// same output.
function hash(n) {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
}

// A record's Firestore id (a string) -> a stable numeric seed, so jitter
// is tied to the actual stored document rather than to array position.
function seedFromId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
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

function easeOutQuad(t) {
  return 1 - (1 - t) * (1 - t);
}
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ---------- soft, rounded boundary shapes (no points/teeth anywhere) ----------
function petalBoundaryPoints({ length, width, widthPower = 0.62, ruffleAmp = 0.035, ruffleFreq = 3, phase = 0, segs = 14 }) {
  const sample = (u, v) => {
    const w = width * Math.pow(Math.sin(Math.PI * u), widthPower);
    const ruffle = 1 + ruffleAmp * Math.sin(v * ruffleFreq * Math.PI + u * 2.2 + phase) * Math.pow(u, 0.6);
    return { x: v * (w * 0.5) * ruffle, y: u * length };
  };
  const pts = [];
  for (let i = 0; i <= segs; i++) pts.push(sample(i / segs, -1));
  for (let i = segs; i >= 0; i--) pts.push(sample(i / segs, 1));
  return pts;
}

function leafBoundaryPoints({ length, width, phase = 0, segs = 12 }) {
  const sample = (u, v) => {
    const w = width * Math.pow(Math.sin(Math.PI * u), 0.75);
    const bend = Math.sin(u * Math.PI * 0.75 + phase) * width * 0.12;
    return { x: v * (w * 0.5) + bend * (u > 0.1 ? 1 : 0), y: u * length };
  };
  const pts = [];
  for (let i = 0; i <= segs; i++) pts.push(sample(i / segs, -1));
  for (let i = segs; i >= 0; i--) pts.push(sample(i / segs, 1));
  return pts;
}

// An open (not closed) gently-curved line -- one strand of a stamen tuft,
// or (longer, thicker) a single root tendril.
function filamentPoints(length, curve, segs = 8) {
  const pts = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    pts.push({ x: Math.sin(t * Math.PI * 0.5) * curve, y: t * length });
  }
  return pts;
}

// A small, deliberately soft-cornered spike -- symbolic rather than sharp
// (pointsToPath's midpoint-quadratic smoothing rounds the tip slightly).
function thornShapePoints(length, width) {
  return [
    { x: -width / 2, y: 0 },
    { x: 0, y: length },
    { x: width / 2, y: 0 },
  ];
}

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

function placementTransform(angleRad, radius) {
  const deg = (angleRad * 180) / Math.PI;
  return `rotate(${deg.toFixed(2)} ${CX} ${CY}) translate(${(CX + radius).toFixed(2)} ${CY}) rotate(-90)`;
}

// ---------- phyllotaxis placement (depends only on typeIndex -- never on a type's final count) ----------
function petalPlacement(typeIndex, seed) {
  const angle = (typeIndex * GOLDEN_ANGLE_DEG * Math.PI) / 180;
  const jitterAngle = ((hash(seed + 1) - 0.5) * 16 * Math.PI) / 180;
  const radius = (14 + 26 * Math.sqrt(typeIndex + 1)) * (0.94 + hash(seed + 2) * 0.12);
  const sizeScale = clamp(1 - typeIndex * 0.022, 0.55, 1);
  return { angle: angle + jitterAngle, radius, sizeScale };
}

const LEAF_ARC_SPAN_DEG = 130; // confined to a lower arc, below the flower
const LEAF_ARC_CENTER_DEG = 90; // SVG +Y is down, so 90deg points downward

function leafPlacement(typeIndex, seed) {
  const walk = (typeIndex * GOLDEN_ANGLE_DEG) % LEAF_ARC_SPAN_DEG;
  const angleDeg = LEAF_ARC_CENTER_DEG - LEAF_ARC_SPAN_DEG / 2 + walk;
  const jitterDeg = (hash(seed + 1) - 0.5) * 10;
  const radius = (58 + 16 * Math.sqrt(typeIndex + 1)) * (0.92 + hash(seed + 2) * 0.16);
  const sizeScale = clamp(1 - typeIndex * 0.02, 0.6, 1);
  return { angle: ((angleDeg + jitterDeg) * Math.PI) / 180, radius, sizeScale };
}

function stamenPlacement(typeIndex, seed) {
  const angle = (typeIndex * GOLDEN_ANGLE_DEG * Math.PI) / 180;
  const radius = (4 + 7 * Math.sqrt(typeIndex + 1)) * (0.92 + hash(seed + 2) * 0.16);
  return { angle, radius };
}

// A narrow wedge near the flower's base, closer in than the leaves --
// a small, clearly-separate accent rather than an equal partner.
const THORN_ARC_SPAN_DEG = 46;
const THORN_ARC_CENTER_DEG = 90;

function thornPlacement(typeIndex, seed) {
  const walk = (typeIndex * GOLDEN_ANGLE_DEG) % THORN_ARC_SPAN_DEG;
  const angleDeg = THORN_ARC_CENTER_DEG - THORN_ARC_SPAN_DEG / 2 + walk;
  const jitterDeg = (hash(seed + 1) - 0.5) * 6;
  const radius = (32 + 7 * Math.sqrt(typeIndex + 1)) * (0.9 + hash(seed + 2) * 0.2);
  return { angle: ((angleDeg + jitterDeg) * Math.PI) / 180, radius };
}

// Roots extend further out/down than anything else -- below the flower,
// outside the leaves, suggesting growth away from the bloom rather than
// into it.
const ROOT_ARC_SPAN_DEG = 100;
const ROOT_ARC_CENTER_DEG = 90;

function rootPlacement(typeIndex, seed) {
  const walk = (typeIndex * GOLDEN_ANGLE_DEG) % ROOT_ARC_SPAN_DEG;
  const angleDeg = ROOT_ARC_CENTER_DEG - ROOT_ARC_SPAN_DEG / 2 + walk;
  const jitterDeg = (hash(seed + 1) - 0.5) * 8;
  const radius = (98 + 20 * Math.sqrt(typeIndex + 1)) * (0.92 + hash(seed + 2) * 0.16);
  return { angle: ((angleDeg + jitterDeg) * Math.PI) / 180, radius };
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const FADE_LEAD = 0.75;
const FADE_DURATION = 0.4;

export class Flower2D {
  constructor(svgRoot) {
    this.svg = svgRoot;
    this.svg.setAttribute('viewBox', `0 0 ${VIEW_SIZE} ${VIEW_SIZE}`);
    this.slots = [];
    this._buildStaticDOM();
  }

  _buildStaticDOM() {
    this.svg.innerHTML = '';
    const defs = svgEl('defs');
    this.svg.appendChild(defs);
    this.defs = defs;
    this.root = svgEl('g', { class: 'flower-root' });
    this.svg.appendChild(this.root);
    this.rootPartLayer = svgEl('g', { class: 'root-layer' });
    this.leafLayer = svgEl('g', { class: 'leaf-layer' });
    this.thornLayer = svgEl('g', { class: 'thorn-layer' });
    this.petalLayer = svgEl('g', { class: 'petal-layer' });
    this.stamenLayer = svgEl('g', { class: 'stamen-layer' });
    // Back to front: roots (furthest out/behind) -> leaves -> thorns ->
    // petals -> stamens (frontmost) -- a simple, legible stacking rather
    // than any fixed "flower anatomy".
    this.root.appendChild(this.rootPartLayer);
    this.root.appendChild(this.leafLayer);
    this.root.appendChild(this.thornLayer);
    this.root.appendChild(this.petalLayer);
    this.root.appendChild(this.stamenLayer);
    this._gradSeq = 0;
  }

  reset() {
    this.slots = [];
    this._buildStaticDOM();
  }

  _makeGradient(colorFrom, colorTo) {
    this._gradSeq += 1;
    const id = `flower-grad-${Math.random().toString(36).slice(2)}-${this._gradSeq}`;
    const grad = svgEl('linearGradient', { id, x1: '50%', y1: '100%', x2: '50%', y2: '0%' });
    grad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': colorFrom, 'stop-opacity': 0.95 }));
    grad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': colorTo, 'stop-opacity': 0.85 }));
    this.defs.appendChild(grad);
    return id;
  }

  _buildPetalSlot(typeIndex, element) {
    const seed = seedFromId(element.record.id);
    const { angle, radius, sizeScale } = petalPlacement(typeIndex, seed);
    const length = 34 * sizeScale * (0.92 + hash(seed + 3) * 0.16);
    const width = 24 * sizeScale * (0.9 + hash(seed + 4) * 0.2);
    const phase = hash(seed + 5) * Math.PI * 2;
    const pts = petalBoundaryPoints({ length, width, phase });
    const colorT = hash(seed + 6);
    const base =
      colorT < 0.5 ? lerpColor(COLOR_PETAL_A, COLOR_PETAL_B, colorT * 2) : lerpColor(COLOR_PETAL_B, COLOR_PETAL_C, (colorT - 0.5) * 2);
    const gradId = this._makeGradient(base, lerpColor(base, '#ffffff', 0.4));
    const g = svgEl('g', { transform: placementTransform(angle, radius) });
    const path = svgEl('path', {
      d: pointsToPath(pts, true),
      fill: `url(#${gradId})`,
      'fill-opacity': 0,
      stroke: lerpColor(base, STROKE_SOFT, 0.5),
      'stroke-width': 1.4,
      'stroke-opacity': 0,
      'stroke-linejoin': 'round',
    });
    g.appendChild(path);
    this.petalLayer.appendChild(g);
    return this._makeSlotState(element, g, path);
  }

  _buildLeafSlot(typeIndex, element) {
    const seed = seedFromId(element.record.id);
    const { angle, radius, sizeScale } = leafPlacement(typeIndex, seed);
    const length = 26 * sizeScale * (0.9 + hash(seed + 3) * 0.2);
    const width = 11 * sizeScale * (0.88 + hash(seed + 4) * 0.22);
    const phase = hash(seed + 5) * Math.PI * 2;
    const pts = leafBoundaryPoints({ length, width, phase });
    const base = lerpColor(COLOR_LEAF_A, COLOR_LEAF_B, hash(seed + 6));
    const g = svgEl('g', { transform: placementTransform(angle, radius) });
    const path = svgEl('path', {
      d: pointsToPath(pts, true),
      fill: base,
      'fill-opacity': 0,
      stroke: lerpColor(base, '#4f6b43', 0.35),
      'stroke-width': 1.1,
      'stroke-opacity': 0,
    });
    g.appendChild(path);
    const vein = svgEl('line', {
      x1: 0, y1: length * 0.08, x2: 0, y2: length * 0.92,
      stroke: lerpColor(base, '#3d5533', 0.4),
      'stroke-width': 0.6,
      'stroke-opacity': 0,
    });
    g.appendChild(vein);
    this.leafLayer.appendChild(g);
    const slot = this._makeSlotState(element, g, path);
    slot.vein = vein;
    return slot;
  }

  // One stamen ELEMENT (= one participant's record) is drawn as a small,
  // tight tuft of 2-3 curved strands sharing one base point -- a single
  // visually-cohesive unit, never mistaken for several separate
  // participants' elements. Strand count/curve are seeded from this one
  // record's id, so it's always the same tuft for the same record.
  _buildStamenSlot(typeIndex, element) {
    const seed = seedFromId(element.record.id);
    const { angle, radius } = stamenPlacement(typeIndex, seed);
    const strandCount = 2 + Math.floor(hash(seed + 7) * 2); // 2 or 3
    const g = svgEl('g', { transform: placementTransform(angle, radius) });
    const strandPaths = [];
    const dots = [];
    for (let s = 0; s < strandCount; s++) {
      const strandSeed = seed + s * 29;
      const length = 11 * (0.85 + hash(strandSeed + 3) * 0.3);
      const curve = (hash(strandSeed + 4) - 0.5) * 11 + (s - (strandCount - 1) / 2) * 3.5; // fan out from a shared base
      const pts = filamentPoints(length, curve);
      const path = svgEl('path', {
        d: pointsToPath(pts, false),
        fill: 'none',
        stroke: COLOR_STAMEN,
        'stroke-width': 1.2,
        'stroke-linecap': 'round',
        'stroke-opacity': 0,
      });
      g.appendChild(path);
      strandPaths.push(path);
      const tip = pts[pts.length - 1];
      const dot = svgEl('circle', { cx: tip.x.toFixed(2), cy: tip.y.toFixed(2), r: 1.9, fill: COLOR_STAMEN_TIP, opacity: 0 });
      g.appendChild(dot);
      dots.push(dot);
    }
    this.stamenLayer.appendChild(g);
    const slot = this._makeSlotState(element, g, strandPaths[0]);
    slot.extraPaths = strandPaths.slice(1);
    slot.dots = dots;
    return slot;
  }

  // A single small, soft-cornered spike -- one participant's element, not
  // a decorative flourish.
  _buildThornSlot(typeIndex, element) {
    const seed = seedFromId(element.record.id);
    const { angle, radius } = thornPlacement(typeIndex, seed);
    const length = 13 * (0.85 + hash(seed + 3) * 0.3);
    const width = 6 * (0.85 + hash(seed + 4) * 0.3);
    const pts = thornShapePoints(length, width);
    const g = svgEl('g', { transform: placementTransform(angle, radius) });
    const path = svgEl('path', {
      d: pointsToPath(pts, true),
      fill: COLOR_THORN,
      'fill-opacity': 0,
      stroke: lerpColor(COLOR_THORN, '#4a1f26', 0.3),
      'stroke-width': 1,
      'stroke-opacity': 0,
      'stroke-linejoin': 'round',
    });
    g.appendChild(path);
    this.thornLayer.appendChild(g);
    return this._makeSlotState(element, g, path);
  }

  // A single curved tendril extending outward/below the flower -- an
  // exceptionally long measurement (>=75s), given its own longer reach
  // and earthy color rather than reusing the leaf/petal palette.
  _buildRootSlot(typeIndex, element) {
    const seed = seedFromId(element.record.id);
    const { angle, radius } = rootPlacement(typeIndex, seed);
    const length = 30 * (0.85 + hash(seed + 3) * 0.3);
    const curve = (hash(seed + 4) - 0.5) * 14;
    const pts = filamentPoints(length, curve, 10);
    const g = svgEl('g', { transform: placementTransform(angle, radius) });
    const path = svgEl('path', {
      d: pointsToPath(pts, false),
      fill: 'none',
      stroke: COLOR_ROOT,
      'stroke-width': 2.2,
      'stroke-linecap': 'round',
      'stroke-opacity': 0,
    });
    g.appendChild(path);
    this.rootPartLayer.appendChild(g);
    return this._makeSlotState(element, g, path);
  }

  _makeSlotState(element, g, path) {
    return {
      element, g, path,
      length: 0, triggered: false,
      lineStart: 0, lineEnd: 0, fadeStart: 0, fadeEnd: 0, lineDuration: 0.5,
    };
  }

  // elements: the flower's ordered element list (see flowerModel.js).
  // instant: skip the draw/fade animation entirely and show the final
  // appearance right away -- required for any throwaway instance (e.g. a
  // garden card) that nothing ever calls update() on afterwards.
  // nowElapsed: the animation clock, only meaningful when instant=false.
  renderAll(elements, nowElapsed, { instant = false } = {}) {
    this.reset();
    const typeCounters = { petal: 0, stamen: 0, leaf: 0, thorn: 0, root: 0 };
    elements.forEach((element) => {
      const typeIndex = typeCounters[element.type]++;
      this.slots.push(this._buildSlotForType(element.type, typeIndex, element));
    });
    if (instant) {
      this.slots.forEach((slot) => this._finalizeInstant(slot));
    } else {
      this._measurePaths();
      this.slots.forEach((slot) => this._trigger(slot, nowElapsed));
    }
  }

  _buildSlotForType(type, typeIndex, element) {
    if (type === 'petal') return this._buildPetalSlot(typeIndex, element);
    if (type === 'leaf') return this._buildLeafSlot(typeIndex, element);
    if (type === 'thorn') return this._buildThornSlot(typeIndex, element);
    if (type === 'root') return this._buildRootSlot(typeIndex, element);
    return this._buildStamenSlot(typeIndex, element);
  }

  // Adds exactly one new element to the END of the currently-rendered set
  // (the element just measured) and animates only that one in -- every
  // earlier slot's DOM/position is untouched. Always animated (never
  // instant) -- used only on the single live "my current flower" stage,
  // which IS driven by a continuous update() loop.
  grow(elements, nowElapsed) {
    const newElement = elements[elements.length - 1];
    const typeCounters = { petal: 0, stamen: 0, leaf: 0, thorn: 0, root: 0 };
    elements.slice(0, -1).forEach((e) => typeCounters[e.type]++);
    const slot = this._buildSlotForType(newElement.type, typeCounters[newElement.type], newElement);
    this.slots.push(slot);
    this._measurePaths([slot]);
    this._trigger(slot, nowElapsed);
  }

  // Instant slots skip stroke-dasharray entirely (no draw-in animation to
  // measure), so this never depends on an async requestAnimationFrame
  // measurement -- the shape is visible the instant this returns.
  _finalizeInstant(slot) {
    slot.path.style.fillOpacity = '1';
    slot.path.style.strokeOpacity = '0.88';
    if (slot.vein) slot.vein.style.strokeOpacity = '0.5';
    if (slot.extraPaths) slot.extraPaths.forEach((p) => (p.style.strokeOpacity = '0.85'));
    if (slot.dots) slot.dots.forEach((d) => (d.style.opacity = '1'));
  }

  _measurePaths(onlySlots) {
    const targets = onlySlots || this.slots;
    requestAnimationFrame(() => {
      targets.forEach((slot) => {
        try {
          slot.length = slot.path.getTotalLength();
          slot.path.style.strokeDasharray = String(slot.length);
          slot.path.style.strokeDashoffset = String(slot.length);
        } catch {
          slot.length = 0;
        }
      });
    });
  }

  _trigger(slot, nowElapsed) {
    const lineDuration = 0.6;
    slot.lineDuration = lineDuration;
    slot.lineStart = nowElapsed;
    slot.lineEnd = nowElapsed + lineDuration;
    slot.fadeStart = nowElapsed + lineDuration * FADE_LEAD;
    slot.fadeEnd = slot.fadeStart + FADE_DURATION;
    slot.triggered = true;
  }

  // Only ever needs to be called for the ONE live, animated stage (see
  // main.js's boot() rAF loop) -- instant-rendered garden cards never rely
  // on this (see _finalizeInstant above).
  update(nowElapsed) {
    for (const slot of this.slots) {
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
        slot.path.style.strokeOpacity = String(0.9 - 0.7 * p);
        if (slot.vein) slot.vein.style.strokeOpacity = String(0.5 * eased);
        if (slot.extraPaths) slot.extraPaths.forEach((pth) => (pth.style.strokeOpacity = String(0.85 * eased)));
        if (slot.dots) slot.dots.forEach((d) => (d.style.opacity = String(eased)));
      }
    }
  }
}
