import './style.css';
import { Flower2D } from './flower2d.js';
import * as timer from './timer.js';
import { store, usingSharedDatabase } from './store.js';
import { ensureAnonymousAuth } from './firebase.js';
import { composeGarden, composeFlowerMelody } from './composer.js';
import { groupIntoFlowers, nextFlowerPosition, FLOWER_SIZE } from './flowerModel.js';
import { classifyTimeRole, ROLE_RESULT_TEXT, ROLE_LABEL } from './roleClassifier.js';
import { registerRoute, navigate, replaceState, withBase, setNavigationGuard, onRouteChange, startRouter } from './router.js';
import { ensureAudio, playStroke, setMuted, isMuted, playComposition, stopComposition, isComposing } from './audio.js';
import { isWebSerialSupported, isSerialConnected, connectSerial, reconnectSerial, disconnectSerial, write as writeSerial } from './serial.js';
import { startVibrationSync, stopVibrationSync } from './vibrationSync.js';

// ---------- DOM ----------
const svg = document.getElementById('rose-svg');
const roseStage = document.getElementById('rose-stage');
const measuringGlow = document.getElementById('measuring-glow');
const cornerBrand = document.getElementById('corner-brand');
const hwConnectBtn = document.getElementById('hwConnectBtn');
const caption = document.getElementById('caption');
const devPanel = document.getElementById('dev-panel');

const feelBtn = document.getElementById('feelBtn');
const feelGuard = document.getElementById('feel-guard');
const bloomResultEl = document.getElementById('bloom-result');
const muteBtn = document.getElementById('muteBtn');
const playBtn = document.getElementById('playBtn');
const rejoinBtn = document.getElementById('rejoinBtn');
const participantNoteEl = document.getElementById('participant-note');

const gardenGrid = document.getElementById('garden-grid');
const gardenEmptyNote = document.getElementById('garden-empty-note');
const gardenDetail = document.getElementById('garden-detail');
const simBadge = document.getElementById('sim-badge');

// ---------- Clock (purely internal — never rendered to the user) ----------
const startPerf = performance.now();
function clockNow() {
  return (performance.now() - startPerf) / 1000;
}

// ---------- Shared stroke list + derived flowers ----------
// strokes: the REAL, authoritative ordered list from Firestore (shared) or
// localStorage (solo fallback) — see store.js, which guarantees createdAt
// asc + id-tiebreak ordering so every device/reload groups identically.
// Flowers are never persisted; every client derives them fresh from this
// list with groupIntoFlowers() (see flowerModel.js) every time it changes.
let strokes = [];
// Dev-only (?dev=1 / Shift+Alt+D): when set, the garden/current-flower
// views render THIS synthetic list instead of `strokes` — never written to
// Firebase, never mixed with real data. See the dev panel section below.
let simulationStrokes = null;

function activeStrokes() {
  return simulationStrokes || strokes;
}
function activeFlowers() {
  return groupIntoFlowers(activeStrokes());
}

let knownIds = new Set();
let currentRoute = '/';

// Inserts or replaces a record by id, de-duped and kept in createdAt/id
// order -- used only for this browser's own optimistic bloom write, so a
// race between that write resolving and a Firestore snapshot echo can
// never leave the same stroke counted twice.
function upsertStroke(record) {
  const byId = new Map(strokes.map((s) => [s.id, s]));
  byId.set(record.id, record);
  strokes = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The single "my current flower" stage shown on /, /feel, /bloom — always
// the LAST (most recently growing, or just-completed) flower in the real
// stroke list.
const currentFlowerStage = new Flower2D(svg);
function refreshCurrentFlowerStage(instant) {
  const flowers = groupIntoFlowers(strokes);
  const elements = flowers.length ? flowers[flowers.length - 1].elements : [];
  currentFlowerStage.renderAll(elements, clockNow(), { instant });
}

function updateParticipantNote() {
  if (!participantNoteEl) return;
  const n = strokes.length;
  participantNoteEl.textContent = n === 0 ? '아직 아무도 참여하지 않았습니다' : `지금까지 ${n}명이 함께 시간을 심었습니다`;
}

let captionTimeout = null;
function showCaption(text) {
  clearTimeout(captionTimeout);
  caption.textContent = text;
  caption.classList.remove('hidden');
  requestAnimationFrame(() => caption.classList.add('show'));
  captionTimeout = setTimeout(() => caption.classList.remove('show'), 3400);
}

function formatDiffText(feltSeconds) {
  const diff = feltSeconds - 60;
  const t = feltSeconds.toFixed(1);
  if (Math.abs(diff) < 0.4) return `당신은 거의 정확하게 60초를 느꼈습니다. (${t}초)`;
  if (diff > 0) return `당신의 1분은 ${t}초였습니다 — 실제보다 ${diff.toFixed(1)}초 더 길게 느끼셨습니다.`;
  return `당신의 1분은 ${t}초였습니다 — 실제보다 ${Math.abs(diff).toFixed(1)}초 더 짧게 느끼셨습니다.`;
}

// ---------- Felt-time guard: no accidental navigation mid-measurement ----------
setNavigationGuard(() => {
  if (timer.isRunning()) {
    feelGuard.classList.remove('hidden');
    feelGuard.animate?.([{ opacity: 0.4 }, { opacity: 1 }, { opacity: 0.75 }], { duration: 500 });
    return false;
  }
  return true;
});
window.addEventListener('beforeunload', (e) => {
  if (timer.isRunning()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- PAGE: FEEL (start/stop button, zero time exposure) ----------
let firstSnapshotReceived = false;
function resetFeelButton() {
  feelBtn.disabled = Boolean(simulationStrokes) || !firstSnapshotReceived;
  feelBtn.textContent = '시간 느끼기';
  feelBtn.classList.remove('measuring');
  measuringGlow.classList.add('hidden');
  feelGuard.classList.add('hidden');
  cornerBrand.classList.remove('is-locked');
}

// The full start/stop surface for a felt-time measurement — the on-screen
// button and the Arduino's button 1 (D7, via serial.js's
// BUTTON_1_TIME_MEASURE) both only ever call toggleMeasurement() below.
// MEASURE_ON/OFF mirrors that same real state to the board's D11 LED
// regardless of which input triggered it; write() silently no-ops without
// a board connected.
function beginMeasurement() {
  if (timer.isRunning()) return;
  ensureAudio();
  timer.start();
  feelBtn.textContent = '지금 멈추기';
  feelBtn.classList.add('measuring');
  measuringGlow.classList.remove('hidden');
  cornerBrand.classList.add('is-locked');
  writeSerial('MEASURE_ON');
}
function completeMeasurement() {
  if (!timer.isRunning()) return;
  const feltSeconds = timer.stop();
  resetFeelButton();
  writeSerial('MEASURE_OFF');
  navigate('/bloom', { pendingResult: { feltSeconds } });
}
function toggleMeasurement() {
  if (!timer.isRunning()) beginMeasurement();
  else completeMeasurement();
}
feelBtn.addEventListener('click', toggleMeasurement);

// ---------- PAGE: BLOOM (reveal the one new element, grow my current flower) ----------
function onEnterBloom(state) {
  roseStage.classList.remove('hidden', 'stage--large');

  if (state.pendingResult && !state.consumed) {
    const { feltSeconds } = state.pendingResult;
    const note = playStroke(feltSeconds); // sound now, classification included
    const resultHTML = `${formatDiffText(feltSeconds)}<br/>${ROLE_RESULT_TEXT[note.type]}`;
    bloomResultEl.innerHTML = resultHTML;
    replaceState({ consumed: true, resultHTML });

    // Optimistic + immediate: append locally right away (de-duped by id,
    // see upsertStroke) so the stage's "my current flower" already
    // reflects it, then animate the grow-in. The id is reserved and
    // marked "known" BEFORE the write even starts, so Firestore's
    // real-time echo of this exact document later is recognized as
    // already-accounted-for rather than treated as a new foreign stroke.
    const reservedId = store.reserveId();
    knownIds.add(reservedId);
    upsertStroke({ id: reservedId, uid: 'pending', measuredSeconds: feltSeconds, createdAt: Date.now() });
    refreshCurrentFlowerStage(false);

    store
      .addStroke({ measuredSeconds: feltSeconds }, reservedId)
      .then((record) => {
        upsertStroke(record);
        updateParticipantNote();
      })
      .catch((err) => {
        console.error('Failed to save stroke', err);
        knownIds.delete(reservedId);
        strokes = strokes.filter((s) => s.id !== reservedId);
        refreshCurrentFlowerStage(true);
        showCaption('시간을 저장하지 못했습니다 — 네트워크를 확인해주세요');
      });
  } else if (state.resultHTML) {
    bloomResultEl.innerHTML = state.resultHTML;
  } else {
    bloomResultEl.textContent = '지금까지 모인 시간들이 꽃이 되어가고 있습니다.';
  }
}

// ---------- PAGE: GARDEN (every flower, complete or growing) ----------
function applyMuteUI(muted) {
  muteBtn.classList.toggle('muted', muted);
  muteBtn.textContent = muted ? '✕' : '♪';
}
function applyPlayUI(playing) {
  playBtn.textContent = playing ? '정지' : '정원 전체 음악 재생';
}

muteBtn.addEventListener('click', () => {
  const next = !isMuted();
  setMuted(next);
  applyMuteUI(next);
  try {
    localStorage.setItem('rose-garden:muted', next ? '1' : '0');
  } catch {
    /* ignore */
  }
});

// The one full-garden playback entry point — the on-screen button and the
// Arduino's button 2 (D8, via serial.js's BUTTON_2_PLAY_RESULT) both only
// ever call this same function. Audio and vibration are started as two
// independent schedulers sharing one `startTime` and one `notes` list (see
// audio.js's playComposition and vibrationSync.js) — a disconnected/absent
// board never affects playback.
function toggleCollectivePlayback() {
  if (isComposing()) {
    stopComposition();
    stopVibrationSync();
    applyPlayUI(false);
  } else {
    ensureAudio();
    const notes = composeGarden(activeStrokes());
    const startTime = performance.now();
    applyPlayUI(true);
    playComposition(notes, {
      startTime,
      onEnd: () => {
        applyPlayUI(false);
        stopVibrationSync();
      },
    });
    startVibrationSync(notes, { startTime, send: writeSerial });
  }
}
playBtn.addEventListener('click', toggleCollectivePlayback);
rejoinBtn.addEventListener('click', () => navigate('/feel'));

function flowerCardLabel(flower) {
  const status = flower.isComplete ? '완성' : '성장 중';
  return `꽃 ${flower.flowerIndex + 1} · ${flower.participantCount}/${FLOWER_SIZE} (${status})`;
}

function closeFlowerDetail() {
  gardenDetail.classList.add('hidden');
  gardenDetail.innerHTML = '';
}

function openFlowerDetail(flower) {
  const times = flower.elements.map((e) => `${e.record.measuredSeconds.toFixed(1)}초`).join(', ') || '없음';
  gardenDetail.innerHTML = `
    <button type="button" class="detail-close" aria-label="닫기">✕</button>
    <h3 class="detail-title">꽃 ${flower.flowerIndex + 1}</h3>
    <p class="detail-line">참여 인원 · ${flower.participantCount}/${FLOWER_SIZE} ${flower.isComplete ? '(완성)' : '(성장 중)'}</p>
    <p class="detail-line">꽃잎 ${flower.counts.petal} · 꽃수술 ${flower.counts.stamen} · 잎사귀 ${flower.counts.leaf} · 가시 ${flower.counts.thorn} · 뿌리 ${flower.counts.root}</p>
    <p class="detail-times">${times}</p>
    <button type="button" class="primary-btn primary-btn--ghost detail-play">이 꽃 음악 재생</button>
  `;
  gardenDetail.classList.remove('hidden');
  gardenDetail.querySelector('.detail-close').addEventListener('click', closeFlowerDetail);
  gardenDetail.querySelector('.detail-play').addEventListener('click', () => {
    ensureAudio();
    playComposition(composeFlowerMelody(flower), {});
  });
}

function renderGarden() {
  const flowers = activeFlowers();
  simBadge.classList.toggle('hidden', !simulationStrokes);
  gardenGrid.innerHTML = '';
  closeFlowerDetail();
  if (!flowers.length) {
    gardenEmptyNote.classList.remove('hidden');
    return;
  }
  gardenEmptyNote.classList.add('hidden');
  flowers.forEach((flower) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'flower-card';
    const cardSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    cardSvg.setAttribute('class', 'flower-card-svg');
    card.appendChild(cardSvg);
    const label = document.createElement('p');
    label.className = 'flower-card-label';
    label.textContent = flowerCardLabel(flower);
    card.appendChild(label);
    gardenGrid.appendChild(card);
    new Flower2D(cardSvg).renderAll(flower.elements, clockNow(), { instant: true });
    card.addEventListener('click', () => openFlowerDetail(flower));
  });
}

function onEnterGarden() {
  roseStage.classList.add('hidden');
  updateParticipantNote();
  applyPlayUI(isComposing());
  renderGarden();
}
function onLeaveGarden() {
  if (isComposing()) {
    stopComposition();
    stopVibrationSync();
    applyPlayUI(false);
  }
  closeFlowerDetail();
}

// ---------- Routes ----------
registerRoute('/', {
  onEnter: () => {
    roseStage.classList.remove('hidden');
    refreshCurrentFlowerStage(true);
  },
});
registerRoute('/feel', {
  onEnter: () => {
    roseStage.classList.remove('hidden', 'stage--large');
    refreshCurrentFlowerStage(true);
    resetFeelButton();
  },
});
registerRoute('/bloom', { onEnter: onEnterBloom });
registerRoute('/garden', { onEnter: onEnterGarden, onLeave: onLeaveGarden });
// Old link compatibility: previous visitors/bookmarks pointing at
// /collective land safely on the new /garden instead of erroring.
registerRoute('/collective', { onEnter: () => navigate('/garden') });

document.querySelectorAll('[data-nav]').forEach((el) => {
  if (el.hasAttribute('href')) el.setAttribute('href', withBase(el.dataset.nav));
  el.addEventListener('click', (e) => {
    e.preventDefault();
    navigate(el.dataset.nav);
  });
});

const pageSections = document.querySelectorAll('.page[data-route]');
function syncActivePage(path) {
  currentRoute = path;
  pageSections.forEach((section) => {
    section.classList.toggle('active', section.dataset.route === path);
  });
}
onRouteChange(syncActivePage);

// ---------- Dev/test panel (hidden on the real artwork) ----------
// Deterministic, realistically-mixed seconds so a simulated garden isn't
// all one element type.
const SYNTHETIC_PATTERN = [60, 61, 58, 63, 45, 75, 30, 95, 59, 62, 55, 65, 40, 80, 25, 100, 57, 64, 50, 70, 35, 90, 60, 66, 48, 72];
function buildSyntheticStrokes(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `sim-${i}`,
    uid: 'simulation',
    measuredSeconds: SYNTHETIC_PATTERN[i % SYNTHETIC_PATTERN.length],
    createdAt: i,
  }));
}

devPanel.querySelectorAll('button[data-sim]').forEach((btn) => {
  btn.addEventListener('click', () => {
    simulationStrokes = buildSyntheticStrokes(parseInt(btn.dataset.sim, 10));
    feelBtn.disabled = true;
    navigate('/garden');
    renderGarden();
  });
});
document.getElementById('devRealBtn').addEventListener('click', () => {
  simulationStrokes = null;
  resetFeelButton();
  renderGarden();
});

// A single measuredSeconds value -> appended as one more simulation
// record, so a specific classification boundary (e.g. 74 vs 75) can be
// checked directly against what actually renders.
const devSingleInput = document.getElementById('devSingleInput');
const devSingleOut = document.getElementById('devSingleOut');
document.getElementById('devSingleBtn').addEventListener('click', () => {
  const value = parseFloat(devSingleInput.value);
  if (!Number.isFinite(value)) return;
  if (!simulationStrokes) simulationStrokes = [];
  const id = `single-${simulationStrokes.length}-${Date.now()}`;
  simulationStrokes = [...simulationStrokes, { id, uid: 'simulation', measuredSeconds: value, createdAt: simulationStrokes.length }];
  feelBtn.disabled = true;
  navigate('/garden');
  renderGarden();
  devSingleOut.textContent = `${value}초 → ${ROLE_LABEL[classifyTimeRole(value)]}`;
});

const devClearBtn = document.getElementById('devClearBtn');
if (!store.supportsClear) {
  devClearBtn.remove();
} else {
  devClearBtn.addEventListener('click', async () => {
    if (!confirm('테스트용: 저장된 모든 체감시간 기록을 영구히 지울까요?')) return;
    await store.clearAll();
    strokes = [];
    refreshCurrentFlowerStage(true);
    updateParticipantNote();
    if (currentRoute === '/garden') renderGarden();
  });
}

// ---------- Arduino hardware connection (real UI, any page) ----------
// A small corner icon, visible whenever the browser supports Web Serial at
// all. Clicking it is the one required gesture before either physical
// board button does anything useful: it both requests the serial port AND
// calls ensureAudio() right after, which is what lets a LATER, non-gesture
// Arduino button-2 press actually produce sound.
const serialCallbacks = {
  onButton1: toggleMeasurement,
  onButton2: toggleCollectivePlayback,
  onDisconnect: handleHwDisconnect,
};

function updateHwUI(state) {
  hwConnectBtn.classList.toggle('is-connected', state === 'connected');
  hwConnectBtn.classList.toggle('is-connecting', state === 'connecting');
  hwConnectBtn.title = state === 'connected' ? '아두이노 연결됨 (클릭하여 연결 해제)' : '아두이노 연결';
}

function handleHwDisconnect() {
  updateHwUI('idle');
  stopVibrationSync();
  showCaption('하드웨어 연결이 끊어졌습니다 — 연결 아이콘을 다시 눌러주세요');
}

async function handleHwConnectClick() {
  if (isSerialConnected()) {
    await disconnectSerial();
    updateHwUI('idle');
    showCaption('하드웨어 연결을 해제했습니다');
    return;
  }
  updateHwUI('connecting');
  try {
    const reconnected = await reconnectSerial(serialCallbacks);
    if (!reconnected) await connectSerial(serialCallbacks);
    ensureAudio();
    updateHwUI('connected');
    showCaption('아두이노가 연결되었습니다');
  } catch (err) {
    console.error('Serial connect failed', err);
    updateHwUI('idle');
    showCaption('연결에 실패했거나 취소되었습니다');
  }
}

if (isWebSerialSupported()) {
  hwConnectBtn.classList.remove('hidden');
  hwConnectBtn.addEventListener('click', handleHwConnectClick);
  reconnectSerial(serialCallbacks).then((ok) => {
    if (ok) updateHwUI('connected');
  });
}

function toggleDevPanel(show) {
  devPanel.classList.toggle('hidden', !show);
}
if (new URLSearchParams(location.search).get('dev') === '1') toggleDevPanel(true);
window.addEventListener('keydown', (e) => {
  if (e.shiftKey && e.altKey && e.key.toLowerCase() === 'd') {
    toggleDevPanel(devPanel.classList.contains('hidden'));
  }
});

// ---------- Real-time sync: every browser, same garden ----------
function handleStrokesUpdate(list) {
  const wasFirst = !firstSnapshotReceived;
  firstSnapshotReceived = true;
  strokes = list;

  const incomingIds = new Set(list.map((s) => s.id));
  const hasNewForeign = list.some((s) => !knownIds.has(s.id));
  const hasRemoved = [...knownIds].some((id) => !incomingIds.has(id));
  knownIds = incomingIds;

  if (!simulationStrokes && (hasNewForeign || hasRemoved)) {
    refreshCurrentFlowerStage(true);
    if (currentRoute === '/garden') renderGarden();
  }
  updateParticipantNote();
  if (wasFirst && currentRoute === '/feel') resetFeelButton();
}

// ---------- Boot ----------
async function boot() {
  try {
    if (localStorage.getItem('rose-garden:muted') === '1') {
      setMuted(true);
      applyMuteUI(true);
    }
  } catch {
    /* ignore */
  }

  if (usingSharedDatabase) {
    try {
      await ensureAnonymousAuth();
    } catch (err) {
      console.error('Anonymous sign-in failed — strokes cannot be saved yet.', err);
    }
  }

  store.subscribe(handleStrokesUpdate);
  startRouter();

  function animate() {
    requestAnimationFrame(animate);
    currentFlowerStage.update(clockNow());
  }
  animate();
}

boot();
