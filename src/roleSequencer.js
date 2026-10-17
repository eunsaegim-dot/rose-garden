// Pure, DOM-free role derivation. Firestore's security rules only allow
// {uid, measuredSeconds, createdAt} to be written — role and note are
// NEVER stored. So every client (and the music composer) must derive the
// exact same role for the exact same ordered list of measuredSeconds
// values. This class is the single source of that logic; Rose2D uses one
// instance to drive the actual DOM, and composer.js/derive helpers use a
// throwaway instance to work out music without touching the DOM at all.
import { classifyTimeRole } from './roleClassifier.js';

// Total slots per role (innerPetal's 6 includes the 1 center-spiral slot
// planted first in that pool — see rose2d.js's buildSlotPlan).
export const POOL_SIZES = {
  innerPetal: 6,
  corePetal: 6,
  middlePetal: 6,
  outerPetal: 8,
  leaf: 3,
  thorn: 2,
};
export const PETAL_ROLES = ['innerPetal', 'corePetal', 'middlePetal', 'outerPetal'];
export const AUX_TRIGGER_EVERY = 3;

export class RoleSequencer {
  constructor() {
    this.filled = { innerPetal: 0, corePetal: 0, middlePetal: 0, outerPetal: 0, leaf: 0, thorn: 0 };
    this.pendingAux = 0;
  }

  poolTotal(role) {
    return POOL_SIZES[role] || 0;
  }
  poolFilled(role) {
    return this.filled[role] || 0;
  }
  isPoolFull(role) {
    return this.poolFilled(role) >= this.poolTotal(role);
  }
  petalCount() {
    return PETAL_ROLES.reduce((sum, r) => sum + this.poolFilled(r), 0);
  }

  // Leaf is always preferred while it has room; thorn only once leaf is
  // completely full — a rare, minimal accent rather than an equal partner.
  pickLeafOrThorn() {
    if (this.poolFilled('leaf') < this.poolTotal('leaf')) return 'leaf';
    if (this.poolFilled('thorn') < this.poolTotal('thorn')) return 'thorn';
    return 'leaf'; // both full; caller will see overflow
  }

  // forcedRole is a dev/preview-only escape hatch (see main.js's dev
  // panel) — the real, shared data path never passes it, since there is
  // no stored role to honor in the first place.
  next(measuredSeconds, forcedRole = null) {
    let role = forcedRole;

    if (!role) {
      role = classifyTimeRole(measuredSeconds);
      if (role === 'leafOrThorn') {
        this.pendingAux += 1;
        const roseBodyStarted = this.petalCount() >= 3;
        if (!roseBodyStarted || this.pendingAux % AUX_TRIGGER_EVERY !== 0) {
          return { role: 'auxPending', poolIndex: null, overflow: false, pendingAux: this.pendingAux };
        }
        role = this.pickLeafOrThorn();
      }
    } else if (measuredSeconds <= 30 && (role === 'leaf' || role === 'thorn')) {
      this.pendingAux += 1;
    }

    if (this.isPoolFull(role)) return { role, poolIndex: null, overflow: true };

    const poolIndex = this.filled[role];
    this.filled[role] += 1;
    return { role, poolIndex, overflow: false, pendingAux: this.pendingAux };
  }
}

// strokes: [{measuredSeconds, ...}] in chronological order. Returns a
// parallel array of {role, poolIndex, overflow} — used by composer.js to
// find each stroke's note without instantiating any DOM.
export function deriveSequence(strokes) {
  const seq = new RoleSequencer();
  return strokes.map((s) => seq.next(s.measuredSeconds));
}
