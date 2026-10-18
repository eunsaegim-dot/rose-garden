// Drives the Arduino's vibration motor (D10, binary VIBRATE_ON/VIBRATE_OFF
// only -- no intensity control, see serial.js) in time with the garden's
// actual notes -- but as its own independent set of timers, never chained
// off audio.js's playback callbacks. Both this module and audio.js build
// their timing from the exact same pure buildTimeline(notes) in
// composer.js, so "same note start time, length, and rest" is defined in
// exactly one place -- a dropped/late vibration write can never stall or
// desync the music, and vice versa.
import { buildTimeline } from './composer.js';

// Each note's own [startMs, endMs] (straight from the shared timeline) is
// its vibration window. With the new rhythm rule every note already has a
// real rest after it (gapMs > 0 always), so these windows rarely if ever
// overlap -- but they're still merged defensively, so a single on/off
// motor never gets a redundant ON while already on, and the motor stays
// off only during genuine rests between notes/flowers.
export function buildVibrationSchedule(notes) {
  if (!notes.length) return [];
  const timeline = buildTimeline(notes);
  const windows = timeline
    .map((note) => ({ startMs: note.startMs, endMs: note.endMs }))
    .sort((a, b) => a.startMs - b.startMs);

  const segments = [];
  for (const w of windows) {
    const last = segments[segments.length - 1];
    if (last && w.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, w.endMs);
    } else {
      segments.push({ ...w });
    }
  }
  return segments;
}

let timers = [];
let running = false;
let sendFn = null;

export function isVibrationSyncRunning() {
  return running;
}

// notes: identical to what's passed to audio.js's playComposition.
// startTime: the SAME performance.now() value the caller passed as
// playComposition's `startTime`, so both schedulers read the one shared
// timetable. send(line): e.g. serial.js's write() -- safe to call whether
// or not a board is actually connected (see serial.js's own guard); if
// omitted, this is a silent no-op, matching "USB가 연결되지 않아도 음악은
// 정상 재생" (the composition itself never depends on this module at all).
export function startVibrationSync(notes, { startTime, send } = {}) {
  stopVibrationSync();
  if (!send || !notes.length) return;
  sendFn = send;
  const segments = buildVibrationSchedule(notes);
  if (!segments.length) return;
  const t0 = startTime ?? performance.now();
  running = true;

  const scheduleAt = (targetMs, action) => {
    const delay = Math.max(0, targetMs - (performance.now() - t0));
    timers.push(
      setTimeout(() => {
        if (running) action();
      }, delay)
    );
  };

  segments.forEach((seg) => {
    scheduleAt(seg.startMs, () => sendFn('VIBRATE_ON'));
    scheduleAt(seg.endMs, () => sendFn('VIBRATE_OFF'));
  });

  const lastEnd = segments[segments.length - 1].endMs;
  scheduleAt(lastEnd, () => {
    running = false;
  });
}

// Always sends one final VIBRATE_OFF (idempotent if the motor was already
// off) -- covers natural end-of-piece, an explicit stop, a page/route
// change, and a mid-playback disconnect alike, so the motor is never left
// buzzing.
export function stopVibrationSync() {
  timers.forEach(clearTimeout);
  timers = [];
  if (sendFn) sendFn('VIBRATE_OFF');
  running = false;
}
