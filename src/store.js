// Data layer for felt-time strokes. Two adapters share one interface:
//   - firestoreAdapter: the real, shared database (used whenever Firebase
//     env vars are present) — every browser, every friend's phone, reads
//     and writes the same `rose_strokes` collection in real time.
//   - localAdapter: a single-browser fallback (used only when Firebase
//     isn't configured, e.g. local dev before .env.local exists).
//
// The Firestore security rules only allow {uid, measuredSeconds,
// createdAt} to be written to rose_strokes, and only create (no
// update/delete) — so that is the ONLY shape ever sent to Firestore here.
// Everything else the rose needs (which role a stroke becomes, which note
// it plays) is *derived* locally from measuredSeconds, identically on
// every client — see rose2d.js's classifyTimeRole + Rose2D.plant().
import { collection, doc, setDoc, getDocs, serverTimestamp, onSnapshot, query, orderBy } from 'firebase/firestore';
import { getDb, ensureAnonymousAuth, getCurrentUid, isFirebaseConfigured } from './firebase.js';

const STROKES_COLLECTION = 'rose_strokes';
const LOCAL_KEY = 'rose-garden:strokes:local-v1';

// Every list this module hands out (either adapter) goes through this
// first -- createdAt ascending, with the document id as a stable tiebreak
// for equal timestamps (e.g. two optimistic local records created in the
// same millisecond, or a serverTimestamp() collision). Flowers are formed
// strictly by position in this ordering (see flowerModel.js), so every
// device/reload must land on the exact same order for the exact same
// underlying documents.
function sortStrokes(list) {
  return [...list].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function readLocal() {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}
function writeLocal(list) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable — the piece still works for this session */
  }
}

// ---------- local (single-browser) fallback ----------
const localAdapter = {
  supportsRealtime: false,
  supportsClear: true,

  reserveId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  },
  async getStrokes() {
    return sortStrokes(readLocal());
  },
  // No real push capability locally — callback just gets the current
  // snapshot once; addStroke()/clearAll() call it again after changing.
  subscribe(callback) {
    callback(sortStrokes(readLocal()));
    return () => {};
  },
  async addStroke({ measuredSeconds }, reservedId) {
    const list = readLocal();
    const record = {
      id: reservedId || this.reserveId(),
      uid: 'local',
      measuredSeconds,
      createdAt: Date.now(),
    };
    list.push(record);
    writeLocal(list);
    return record;
  },
  async clearAll() {
    writeLocal([]);
  },
};

// ---------- Firestore (shared) adapter ----------
function mapDoc(d) {
  const data = d.data();
  const createdAt = data.createdAt && typeof data.createdAt.toMillis === 'function' ? data.createdAt.toMillis() : Date.now();
  return { id: d.id, uid: data.uid, measuredSeconds: data.measuredSeconds, createdAt };
}

const firestoreAdapter = {
  supportsRealtime: true,
  // The security rules only allow create — never update/delete — so a
  // shared record can never be altered or removed from the client. There
  // is intentionally no clearAll() capability here.
  supportsClear: false,

  reserveId() {
    return doc(collection(getDb(), STROKES_COLLECTION)).id;
  },
  async getStrokes() {
    const q = query(collection(getDb(), STROKES_COLLECTION), orderBy('createdAt', 'asc'));
    const snap = await getDocs(q);
    return sortStrokes(snap.docs.map(mapDoc));
  },
  subscribe(callback) {
    const q = query(collection(getDb(), STROKES_COLLECTION), orderBy('createdAt', 'asc'));
    return onSnapshot(q, (snap) => callback(sortStrokes(snap.docs.map(mapDoc))));
  },
  // reservedId lets the caller know the document's id *before* the write
  // resolves, so it can render the stroke immediately and recognize the
  // later real-time echo of its own write instead of re-rendering twice.
  async addStroke({ measuredSeconds }, reservedId) {
    await ensureAnonymousAuth();
    const uid = getCurrentUid();
    const ref = reservedId
      ? doc(getDb(), STROKES_COLLECTION, reservedId)
      : doc(collection(getDb(), STROKES_COLLECTION));
    await setDoc(ref, { uid, measuredSeconds, createdAt: serverTimestamp() });
    return { id: ref.id, uid, measuredSeconds, createdAt: Date.now() };
  },
};

export const store = isFirebaseConfigured ? firestoreAdapter : localAdapter;
export const usingSharedDatabase = isFirebaseConfigured;
