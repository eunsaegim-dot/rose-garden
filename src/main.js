import './style.css';
import { Rose2D, AUX_TRIGGER_EVERY } from './rose2d.js';
import { createSparkleLayer } from './sparkleLayer.js';
import * as timer from './timer.js';
import { store, usingSharedDatabase } from './store.js';
import { ensureAnonymousAuth } from './firebase.js';
import { composeFromStrokes } from './composer.js';
import { classifyTimeRole, ROLE_RESULT_TEXT, ROLE_LABEL } from './roleClassifier.js';
import { registerRoute, navigate, replaceState, withBase, setNavigationGuard, onRouteChange, startRouter } from './router.js';
import {
  ensureAudio,
  playStroke,
  replayStroke,
  playOverflowChime,
  resetAudio,
  noteFreq,
  setMuted,
  isMuted,
  playComposition,
  stopComposition,
  isComposing,
} from './audio.js';
import { computeVibrationPattern } from './senseEngine.js';
import { isWebSerialSupported, connectSerial } from './serial.js';

// ---------- DOM ----------
const svg = document.getElementById('rose-svg');
const roseStage = document.getElementById('rose-stage');
const sparkleLayerEl = document.getElementById('sparkle-layer');
const measuringGlow = document.getElementById('measuring-glow');
const cornerBrand = document.getElementById('corner-brand');
const caption = document.getElementById('caption');
const devPanel = document.getElementById('dev-panel');

const feelBtn = document.getElementById('feelBtn');
const feelGuard = document.getElementById('feel-guard');
const bloomResultEl = document.getElementById('bloom-result');
const participantNoteEl = document.getElementById('participant-note');
const muteBtn = document.getElementById('muteBtn');
const playBtn = document.getElementById('playBtn');
const rejoinBtn = document.getElementById('rejoinBtn');
const tooltipEl = document.getElementById('rose-tooltip');
const vibeWaveEl = document.getElementById('vibe-wave');
const senseCaptionEl = document.getElementById('sense-caption');
const bloomSenseEl = document.getElementById('bloom-sense');
const bloomVibeWaveEl = document.getElementById('bloom-vibe-wave');

createSparkleLayer(sparkleLayerEl);

// ---------- Clock (purely internal — never rendered to the user) ----------
const startPerf = performance.now();
function clockNow() {
  return (performance.now() - startPerf) / 1000;
}

// ---------- Rose + sound-per-slot bookkeeping ----------
// keyed "role:poolIndex" -> frequency, so a click on any petal/leaf/thorn
// can replay exactly the note it was given when first planted.
const slotFreqs = new Map();
function freqKey(role, poolIndex) {
  return `${role}:${poolIndex}`;
}
let strokes = []; // the authoritative, ordered list — from Firestore (shared) or localStorage (solo fallback)

// Which real stroke record(s) each visible slot represents. A petal maps
// to exactly one record; a leaf/thorn can map to several (every <=30s
// measurement that quietly accumulated before one finally became
// visible) — see AUX_TRIGGER_EVERY in rose2d.js. Ghost/ring-glow elements
// are never in here, since they are not click/hover targets at all.
const slotRecords = new Map();
let pendingAuxGroup = [];

// Shared by both the live measurement path and rebuilding from storage,
// so the exact same grouping rule applies whether a record is brand new
// or being restored — nothing here is fabricated, only real stored
// records are ever attached to a slot.
function attachRecord(result, record) {
  if (result.overflow || !record) return;
  if (result.role === 'auxPending') {
    pendingAuxGroup.push(record);
    return;
  }
  const key = freqKey(result.role, result.poolIndex);
  if (result.role === 'leaf' || result.role === 'thorn') {
    slotRecords.set(key, [...pendingAuxGroup, record]);
    pendingAuxGroup = [];
  } else {
    slotRecords.set(key, [record]);
  }
}

let currentRoute = '/';
let tooltipHandledThisClick = false;

function formatTooltipHTML(role, records) {
  const label = ROLE_LABEL[role] || role;
  if (!records || records.length === 0) return '';
  if (records.length === 1) {
    return `<p class="tooltip-time">${records[0].measuredSeconds.toFixed(1)}초</p><p class="tooltip-role">${label}</p>`;
  }
  const times = records.map((r) => `${r.measuredSeconds.toFixed(1)}초`).join(' · ');
  return `<p class="tooltip-time">${times}</p><p class="tooltip-role">${label} · ${records.length}개의 시간이 담겼습니다</p>`;
}

function positionTooltip(x, y) {
  tooltipEl.style.left = `${x}px`;
  tooltipEl.style.top = `${y}px`;
  requestAnimationFrame(() => {
    const rect = tooltipEl.getBoundingClientRect();
    const margin = 10;
    let dx = 0;
    let dy = 0;
    if (rect.left < margin) dx = margin - rect.left;
    if (rect.right > window.innerWidth - margin) dx = window.innerWidth - margin - rect.right;
    if (rect.top < margin) dy = margin - rect.top;
    if (dx || dy) {
      tooltipEl.style.left = `${x + dx}px`;
      tooltipEl.style.top = `${y + dy}px`;
    }
  });
}

function showTooltipForSlot(slot, x, y) {
  if (currentRoute !== '/collective') return;
  const key = freqKey(slot.def.role, slot.def.poolIndex);
  const records = slotRecords.get(key);
  if (!records || !records.length) return; // purely decorative element — never fabricate a time
  tooltipEl.innerHTML = formatTooltipHTML(slot.def.role, records);
  positionTooltip(x, y);
  tooltipEl.classList.add('show');
  // Same slot, same instant -> the tactile preview echoes this slot's most
  // recent real measurement, exactly like the tooltip's time does.
  updateSensePanel(records[records.length - 1].measuredSeconds, slot.def.role);
}
function hideTooltip() {
  tooltipEl.classList.remove('show');
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Draws measuredSeconds' vibration pattern as a row of soft pulsing bars —
// NOT a real vibration, just its screen preview (see senseEngine.js for the
// actual pulse/gap/repeat math this reads). Returns the pattern so callers
// can also use its text label.
function renderVibrationWave(svgEl, measuredSeconds) {
  if (!svgEl) return null;
  const pattern = computeVibrationPattern(measuredSeconds);
  svgEl.innerHTML = '';
  const viewH = svgEl.viewBox.baseVal.height || 48;
  const viewW = svgEl.viewBox.baseVal.width || 220;
  const usableW = viewW - 16;
  const totalUnits = Math.max(pattern.totalDurationMs, 200);
  const scale = usableW / totalUnits;

  let x = 8;
  pattern.pulses.forEach((p, i) => {
    const w = Math.max(14, p.durationMs * scale);
    const barHeight = viewH * (0.4 + pattern.intensity * 0.45);
    const y = (viewH - barHeight) / 2;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', x.toFixed(1));
    rect.setAttribute('y', y.toFixed(1));
    rect.setAttribute('width', w.toFixed(1));
    rect.setAttribute('height', barHeight.toFixed(1));
    rect.setAttribute('rx', (barHeight / 2).toFixed(1));
    rect.setAttribute('fill', i % 2 === 0 ? '#e8a0ab' : '#c97b8a');
    rect.setAttribute('opacity', '0.88');
    rect.style.animation = `vibePulse 1.15s ease-in-out ${(i * 0.14).toFixed(2)}s infinite`;
    svgEl.appendChild(rect);
    x += w + Math.max(5, p.gapMs * scale);
  });
  return pattern;
}

function resetSensePanel() {
  if (vibeWaveEl) vibeWaveEl.innerHTML = '';
  if (senseCaptionEl) senseCaptionEl.textContent = '꽃잎에 마우스를 올리면 그 시간의 촉각 결이 나타납니다';
}

function updateSensePanel(measuredSeconds, role) {
  const pattern = renderVibrationWave(vibeWaveEl, measuredSeconds);
  if (!pattern || !senseCaptionEl) return;
  const label = ROLE_LABEL[role] || role;
  senseCaptionEl.textContent = `${label} · ${measuredSeconds.toFixed(1)}초의 촉각 결 — ${pattern.label}`;
}

const rose = new Rose2D(svg, {
  onPetalClick: (slot, e) => {
    const freq = slotFreqs.get(freqKey(slot.def.role, slot.def.poolIndex));
    if (freq) replayStroke(freq, slot.def.role, slot.feltSeconds);
    tooltipHandledThisClick = true;
    if (e) showTooltipForSlot(slot, e.clientX, e.clientY);
  },
  onPetalEnter: (slot, e) => showTooltipForSlot(slot, e.clientX, e.clientY),
  onPetalMove: (slot, e) => {
    if (currentRoute === '/collective') positionTooltip(e.clientX, e.clientY);
  },
  onPetalLeave: () => hideTooltip(),
});

// Mobile tap-outside-to-close: each slot's click handler (above) sets the
// flag first (it fires before this bubbles to document); if nothing set
// it, the tap landed outside any rose part.
document.addEventListener('click', () => {
  if (!tooltipHandledThisClick) hideTooltip();
  tooltipHandledThisClick = false;
});

// Ids already reflected in the rose's current visual state — including
// this browser's own just-planted (but not yet server-confirmed) stroke.
// Firestore's real-time snapshot will later echo that same id back; since
// it's already known, that echo doesn't trigger a redundant, animation-
// interrupting rebuild. Only genuinely new ids (someone else's stroke)
// do.
let knownIds = new Set();

// Rebuilds the ENTIRE rose from an ordered stroke list, deriving each
// one's role fresh (Firestore never stores role/freq — see store.js).
// Used on boot, whenever a remote update introduces unseen strokes, and
// by the dev panel's "실제 데이터" button.
function rebuildRoseFromStrokes(list) {
  slotFreqs.clear();
  slotRecords.clear();
  pendingAuxGroup = [];
  rose.reset();
  list.forEach((entry) => {
    const result = rose.plant(entry.measuredSeconds, clockNow(), true);
    attachRecord(result, entry);
    if (!result.overflow && result.role !== 'auxPending') {
      slotFreqs.set(freqKey(result.role, result.poolIndex), noteFreq(result.role, result.poolIndex));
    }
  });
  knownIds = new Set(list.map((s) => s.id));
}

function updateParticipantNote() {
  participantNoteEl.textContent =
    strokes.length === 0
      ? '아직 아무도 참여하지 않았습니다'
      : `지금까지 ${strokes.length}명이 함께 시간을 심었습니다`;
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
    feelGuard.animate?.(
      [{ opacity: 0.4 }, { opacity: 1 }, { opacity: 0.75 }],
      { duration: 500 }
    );
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
// Measuring before the shared history has loaded even once could
// misjudge the leaf/thorn accumulation gate (it depends on how many
// petals already exist) — so the button stays disabled until the first
// snapshot (local or remote) arrives.
let firstSnapshotReceived = false;
function resetFeelButton() {
  feelBtn.disabled = devPreviewActive || !firstSnapshotReceived;
  feelBtn.textContent = '시간 느끼기';
  feelBtn.classList.remove('measuring');
  measuringGlow.classList.add('hidden');
  feelGuard.classList.add('hidden');
  cornerBrand.classList.remove('is-locked');
}

// These two are the full start/stop surface for a felt-time measurement.
// A future Arduino (via WebSerial) just needs to call these same two
// functions on its own button-press / button-release events — nothing
// about them is tied to the on-screen button.
function beginMeasurement() {
  if (timer.isRunning()) return;
  ensureAudio();
  timer.start();
  feelBtn.textContent = '지금 멈추기';
  feelBtn.classList.add('measuring');
  measuringGlow.classList.remove('hidden');
  cornerBrand.classList.add('is-locked');
}
function completeMeasurement() {
  if (!timer.isRunning()) return;
  const feltSeconds = timer.stop();
  resetFeelButton();
  navigate('/bloom', { pendingResult: { feltSeconds } });
}

feelBtn.addEventListener('click', () => {
  if (!timer.isRunning()) beginMeasurement();
  else completeMeasurement();
});

// ---------- PAGE: BLOOM (classify + reveal the one new stroke, once) ----------
function onEnterBloom(state) {
  roseStage.classList.remove('hidden', 'stage--large');
  // Only the fresh-reveal branch below (a brand-new pendingResult) knows
  // feltSeconds, so only it renders a tactile preview — same as resultHTML
  // itself, this never gets reconstructed from a reload.
  bloomSenseEl.classList.add('hidden');

  if (state.pendingResult && !state.consumed) {
    const { feltSeconds } = state.pendingResult;
    // Optimistic + immediate: the rose already reflects every stroke we
    // know about, so this derives (and animates) the next one right now,
    // without waiting on any network round trip.
    const result = rose.plant(feltSeconds, clockNow(), false);
    bloomSenseEl.classList.remove('hidden');
    renderVibrationWave(bloomVibeWaveEl, feltSeconds);

    let resultHTML;
    if (result.overflow) {
      playOverflowChime();
      rose.pulse(clockNow());
      resultHTML = `${formatDiffText(feltSeconds)}<br/>장미의 이 부위는 이미 가득 차, 당신의 시간은 음악에만 더해졌습니다.`;
      showCaption('장미가 가득 피었습니다 — 당신의 시간도 음악에 더해집니다');
    } else if (result.role === 'auxPending') {
      // Too short to be a petal, and not yet enough of these have
      // accumulated to earn a visible leaf/thorn — still gets a voice.
      playStroke(feltSeconds, 'leaf', result.pendingAux);
      resultHTML = `${formatDiffText(feltSeconds)}<br/>당신의 시간은 장미 곁에 조용히 머물렀습니다.`;
    } else {
      const freq = playStroke(feltSeconds, result.role, result.poolIndex);
      slotFreqs.set(freqKey(result.role, result.poolIndex), freq);
      resultHTML = `${formatDiffText(feltSeconds)}<br/>${ROLE_RESULT_TEXT[result.role]}`;
    }
    bloomResultEl.innerHTML = resultHTML;
    replaceState({ consumed: true, resultHTML });

    // Persist in the background. The id is reserved and marked "known"
    // BEFORE the write even starts, so when Firestore's real-time
    // subscription later echoes this exact document back, it's already
    // accounted for and won't trigger a second, animation-interrupting
    // rebuild.
    const reservedId = store.reserveId();
    knownIds.add(reservedId);
    store
      .addStroke({ measuredSeconds: feltSeconds }, reservedId)
      .then((record) => {
        if (!strokes.some((s) => s.id === record.id)) strokes.push(record);
        attachRecord(result, record);
        updateParticipantNote();
      })
      .catch((err) => {
        console.error('Failed to save stroke', err);
        knownIds.delete(reservedId);
        showCaption('시간을 저장하지 못했습니다 — 네트워크를 확인해주세요');
      });
  } else if (state.resultHTML) {
    bloomResultEl.innerHTML = state.resultHTML;
  } else {
    bloomResultEl.textContent = '지금까지 모인 시간들이 장미가 되어가고 있습니다.';
  }
}

// ---------- PAGE: COLLECTIVE (whole-piece playback) ----------
function applyMuteUI(muted) {
  muteBtn.classList.toggle('muted', muted);
  muteBtn.textContent = muted ? '✕' : '♪';
}
function applyPlayUI(playing) {
  playBtn.textContent = playing ? '정지' : '음악 재생';
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

playBtn.addEventListener('click', () => {
  if (isComposing()) {
    stopComposition();
    applyPlayUI(false);
  } else {
    ensureAudio();
    const notes = composeFromStrokes(strokes);
    applyPlayUI(true);
    playComposition(notes, { onEnd: () => applyPlayUI(false) });
  }
});

rejoinBtn.addEventListener('click', () => navigate('/feel'));

function onEnterCollective() {
  roseStage.classList.remove('hidden');
  roseStage.classList.add('stage--large');
  updateParticipantNote();
  applyPlayUI(isComposing());
  resetSensePanel();
}
function onLeaveCollective() {
  if (isComposing()) {
    stopComposition();
    applyPlayUI(false);
  }
}

// ---------- Routes ----------
registerRoute('/', {
  onEnter: () => {
    roseStage.classList.add('hidden');
  },
});
registerRoute('/feel', {
  onEnter: () => {
    roseStage.classList.remove('hidden', 'stage--large');
    resetFeelButton();
  },
});
registerRoute('/bloom', { onEnter: onEnterBloom });
registerRoute('/collective', { onEnter: onEnterCollective, onLeave: onLeaveCollective });

document.querySelectorAll('[data-nav]').forEach((el) => {
  // Real <a href> elements (just the corner wordmark) get a base-aware
  // href too, so a middle-click / "copy link" / no-JS fallback still
  // points at the right URL under GitHub Pages' /rose-garden/ subpath.
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
  if (path !== '/collective') hideTooltip();
}
onRouteChange(syncActivePage);

// ---------- Dev/test panel (hidden on the real artwork) ----------
let devPreviewActive = false;
function setDevPreview(active) {
  devPreviewActive = active;
  feelBtn.disabled = active;
  feelBtn.style.opacity = active ? 0.4 : 1;
}

const devSecondsInput = document.getElementById('devSecondsInput');
const devRoleOut = document.getElementById('devRoleOut');
const devClearBtn = document.getElementById('devClearBtn');
// The shared database can never be cleared from the client (the security
// rules only allow create) — only the local, solo fallback supports it.
if (!store.supportsClear) devClearBtn.remove();

// A deterministic, realistically-mixed sequence of felt-time values (not
// all landing in one role), for previewing "what does N participants look
// like" without touching the real recorded data.
const SYNTHETIC_PATTERN = [
  58, 22, 63, 47, 90, 60, 70, 12, 61, 50, 85, 59, 40, 68, 25, 62, 55, 75, 95, 30, 64, 44, 72, 18, 60, 53, 78, 65, 36, 88,
];
function syntheticSeconds(i) {
  return SYNTHETIC_PATTERN[i % SYNTHETIC_PATTERN.length];
}

devPanel.querySelectorAll('button[data-n]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const n = parseInt(btn.dataset.n, 10);
    setDevPreview(true);
    slotFreqs.clear();
    slotRecords.clear();
    pendingAuxGroup = [];
    rose.reset();
    for (let i = 0; i < n; i++) {
      const seconds = syntheticSeconds(i);
      const result = rose.plant(seconds, clockNow(), true);
      attachRecord(result, { id: `preview-${i}`, measuredSeconds: seconds });
      if (!result.overflow && result.role !== 'auxPending') {
        slotFreqs.set(freqKey(result.role, result.poolIndex), noteFreq(result.role, result.poolIndex));
      }
    }
    devRoleOut.textContent = `미리보기 ${n}명`;
  });
});

document.getElementById('devPlantBtn').addEventListener('click', () => {
  const seconds = parseFloat(devSecondsInput.value);
  if (!Number.isFinite(seconds)) return;
  setDevPreview(true);
  const expected = classifyTimeRole(seconds);
  const result = rose.plant(seconds, clockNow(), true);
  attachRecord(result, { id: `test-${Date.now()}`, measuredSeconds: seconds });
  if (result.overflow) {
    devRoleOut.textContent = `${ROLE_LABEL[result.role] || result.role} (가득 참)`;
  } else if (result.role === 'auxPending') {
    devRoleOut.textContent = `보류 중 (누적 ${result.pendingAux}/${AUX_TRIGGER_EVERY})`;
  } else {
    const resolvedLabel = ROLE_LABEL[result.role] || result.role;
    const note = expected === 'leafOrThorn' ? ` [잎/가시 균형→${resolvedLabel}]` : '';
    devRoleOut.textContent = `${resolvedLabel}${note}`;
  }
});

document.getElementById('devFillBtn').addEventListener('click', () => {
  setDevPreview(true);
  slotFreqs.clear();
  slotRecords.clear();
  pendingAuxGroup = [];
  rose.reset();
  const REPRESENTATIVE = { corePetal: 60, innerPetal: 45, middlePetal: 72, outerPetal: 90 };
  let i = 0;
  for (const role of ['innerPetal', 'corePetal', 'middlePetal', 'outerPetal']) {
    while (!rose.isPoolFull(role)) {
      const r = rose.plant(REPRESENTATIVE[role], clockNow(), true, role);
      if (r.overflow) break;
      attachRecord(r, { id: `fill-${i++}`, measuredSeconds: REPRESENTATIVE[role] });
    }
  }
  while (!rose.isPoolFull('leaf')) {
    const r = rose.plant(18, clockNow(), true, 'leaf');
    if (r.overflow) break;
    attachRecord(r, { id: `fill-${i++}`, measuredSeconds: 18 });
  }
  while (!rose.isPoolFull('thorn')) {
    const r = rose.plant(12, clockNow(), true, 'thorn');
    if (r.overflow) break;
    attachRecord(r, { id: `fill-${i++}`, measuredSeconds: 12 });
  }
  devRoleOut.textContent = '전체 채움';
});

document.getElementById('devRealBtn').addEventListener('click', () => {
  setDevPreview(false);
  rebuildRoseFromStrokes(strokes);
  devRoleOut.textContent = '';
});

if (store.supportsClear) {
  devClearBtn.addEventListener('click', async () => {
    if (!confirm('테스트용: 저장된 모든 체감시간 기록을 영구히 지울까요?')) return;
    await store.clearAll();
    strokes = [];
    setDevPreview(false);
    rebuildRoseFromStrokes(strokes);
    resetAudio();
    updateParticipantNote();
    devRoleOut.textContent = '';
  });
}

// ---------- Arduino (experimental, dev-panel only) ----------
// Not reachable from the real artwork's own UI — only from the hidden dev
// panel — and clearly labeled "실험적" (experimental), since no real board
// is connected. Wires straight into the same beginMeasurement/
// completeMeasurement pair the on-screen button uses, so once a real board
// is plugged in, nothing about the measurement logic itself needs to change.
const devSerialBtn = document.getElementById('devSerialBtn');
const devSerialOut = document.getElementById('devSerialOut');
if (!isWebSerialSupported()) {
  devSerialBtn.disabled = true;
  devSerialOut.textContent = '이 브라우저는 Web Serial을 지원하지 않습니다';
} else {
  devSerialBtn.addEventListener('click', async () => {
    devSerialOut.textContent = '연결 중...';
    try {
      await connectSerial({ onPress: beginMeasurement, onRelease: completeMeasurement });
      devSerialOut.textContent = '연결됨 (실험적) — 보드의 버튼으로 측정 시작/종료';
    } catch (err) {
      console.error('Web Serial connect failed', err);
      devSerialOut.textContent = '연결 실패 또는 취소됨';
    }
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

// ---------- Real-time sync: every browser, same rose ----------
// Called whenever the shared (or local) store's stroke list changes —
// including the very first callback on boot, and including this
// browser's own writes echoing back. Only rebuilds the visible rose when
// the update actually introduces strokes we haven't rendered yet, so it
// never interrupts an in-progress reveal animation for no reason.
function handleStrokesUpdate(list) {
  const wasFirst = !firstSnapshotReceived;
  firstSnapshotReceived = true;

  if (devPreviewActive) {
    strokes = list; // keep the authoritative list current even mid-preview
    return;
  }
  strokes = list;
  const incomingIds = new Set(list.map((s) => s.id));
  const hasNewForeign = list.some((s) => !knownIds.has(s.id));
  const hasRemoved = [...knownIds].some((id) => !incomingIds.has(id));
  if (hasNewForeign || hasRemoved) {
    rebuildRoseFromStrokes(list);
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
    rose.update(clockNow());
  }
  animate();
}

boot();
