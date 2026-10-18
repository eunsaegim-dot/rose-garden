// Drives the Arduino's vibration motor (D10, binary VIBRATE_ON/VIBRATE_OFF
// only -- no intensity control, see serial.js) in time with the collective
// composition's actual notes -- but as its own independent set of timers,
// never chained off audio.js's playback callbacks. Both read the exact same
// note list, the exact same compositionGapFor() spacing, and the exact same
// shared `startTime` reference, so they stay in sync without ever calling
// into each other -- a dropped/late vibration write can never stall or
// desync the music, and vice versa.
import { computeNoteDuration, compositionGapFor } from './audio.js';

// A note's audible window is roughly [start, start + 15ms attack + its
// sustain] (see audio.js's pluck(): the envelope ramps up over 15ms, then
// decays to near-silence by the end of `sustain` -- the extra 150ms tail on
// the oscillator itself is already near-inaudible, so it's left out here).
// notes often overlap in time (the piece's intentional layered texture, see
// composer.js) -- a single on/off motor can't represent two overlapping
// notes as two separate pulses, so overlapping windows are merged into one
// continuous "something is sounding" segment. The motor then only toggles
// at a segment's true start/end, and naturally stays off during real rests
// between segments.
export function buildVibrationSchedule(notes, gap = 480) {
  if (!notes.length) return [];
  const effectiveGap = compositionGapFor(notes.length, gap);
  const windows = notes
    .map((note, i) => {
      const startMs = i * effectiveGap;
      const durationMs = computeNoteDuration(note.role, note.feltSeconds) * 1000;
      return { startMs, endMs: startMs + durationMs + 15 };
    })
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

// notes/gap: identical to what's passed to audio.js's playComposition.
// startTime: the SAME performance.now() value the caller passed as
// playComposition's `startTime`, so both schedulers read the one shared
// timetable. send(line): e.g. serial.js's write() -- safe to call whether
// or not a board is actually connected (see serial.js's own guard); if
// omitted, this is a silent no-op, matching "USB가 연결되지 않아도 음악은
// 정상 재생" (the composition itself never depends on this module at all).
export function startVibrationSync(notes, { gap = 480, startTime, send } = {}) {
  stopVibrationSync();
  if (!send || !notes.length) return;
  sendFn = send;
  const segments = buildVibrationSchedule(notes, gap);
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
