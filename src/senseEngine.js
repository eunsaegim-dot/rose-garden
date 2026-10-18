// Pure, DOM/Audio-free "sense engine": every visual/audio/haptic result in
// this piece is derived from the SAME measuredSeconds value, so one
// person's felt minute reads as one stroke, one note, and one vibration
// pattern -- never three independently-random outputs. Nothing here touches
// the DOM, the Web Audio API, or Firestore; it is just math, so it gives the
// exact same result on every refresh and every device for the same
// measuredSeconds (role/poolIndex are themselves already deterministic --
// see roleSequencer.js -- since they come from the shared, ordered stroke
// list rather than from randomness).
import { noteFreq, computeNoteDuration, getVoiceProfile } from './audio.js';

export const BASELINE_SECONDS = 60;

export function computeDeviation(measuredSeconds) {
  const deviation = measuredSeconds - BASELINE_SECONDS;
  return { deviation, absoluteDeviation: Math.abs(deviation) };
}

// The same five felt-time bands the rose/role classifier already uses (see
// roleClassifier.js's 30/55/65/80 boundaries), restated here under
// sense-neutral names -- sound and vibration don't care which petal/leaf/
// thorn a stroke becomes, only how far its felt minute sat from 60s.
export function bandOf(measuredSeconds) {
  if (measuredSeconds <= 30) return 'brief';
  if (measuredSeconds < 55) return 'inner';
  if (measuredSeconds <= 65) return 'core';
  if (measuredSeconds < 80) return 'middle';
  return 'outer';
}

const RHYTHM_LABEL = {
  brief: '짧고 가벼운 포인트 음',
  inner: '섬세하고 높은 음역의 짧은 음',
  core: '맑고 아름다운 중심 선율',
  middle: '부드럽게 이어지는 중간 길이의 음',
  outer: '길고 풍성한 여운을 가진 낮은 음',
};

// role/poolIndex: already-resolved rose-part placement (see
// roleSequencer.js) -- this only describes, never decides, the stroke's
// sound.
export function computeSoundParameters(role, poolIndex, measuredSeconds) {
  const band = bandOf(measuredSeconds);
  const voice = getVoiceProfile(role);
  return {
    pitchHz: noteFreq(role, poolIndex),
    durationSeconds: computeNoteDuration(role, measuredSeconds),
    timbre: voice.wave,
    brightnessHz: voice.cutoffHz,
    rhythmLabel: RHYTHM_LABEL[band],
    band,
  };
}

// ---------- vibration ----------
// Three independent dimensions (count / length / interval), each its own
// small pure function -- so a future Arduino driver can read exactly the
// one it needs (how many times to pulse, how long to hold the pin high,
// how long to wait between pulses) without depending on the other two.
// `intensity` is kept as plain 0..1 data for a future PWM-capable motor
// driver -- nothing in this app currently plays it back as a felt
// sensation, since no real motor is connected (see serial.js).
const VIBRATION_BANDS = {
  brief: { pulses: 1, duration: 110, gap: 0, intensity: 0.5, label: '짧은 진동 한 번' },
  inner: { pulses: 2, duration: 90, gap: 150, intensity: 0.4, label: '가벼운 진동 두 번' },
  core: { pulses: 2, duration: 190, gap: 230, intensity: 0.65, label: '균형 잡힌 진동 두 번' },
  middle: { pulses: 2, duration: 260, gap: 420, intensity: 0.55, label: '느린 간격의 부드러운 진동 두 번' },
  outer: { pulses: 1, duration: 760, gap: 0, intensity: 0.8, label: '길고 느린 진동' },
};

// Bounded stretch (up to 1.25x) so a value's distance from 60s nudges
// duration/gap without ever leaving its band's character.
function stretchFactor(absoluteDeviation) {
  return 1 + Math.min(absoluteDeviation, 40) / 160;
}

export function computeVibrationRepeatCount(measuredSeconds) {
  return VIBRATION_BANDS[bandOf(measuredSeconds)].pulses;
}
export function computeVibrationPulseDuration(measuredSeconds) {
  const { absoluteDeviation } = computeDeviation(measuredSeconds);
  const base = VIBRATION_BANDS[bandOf(measuredSeconds)].duration;
  return Math.round(base * stretchFactor(absoluteDeviation));
}
export function computeVibrationGap(measuredSeconds) {
  const { absoluteDeviation } = computeDeviation(measuredSeconds);
  const base = VIBRATION_BANDS[bandOf(measuredSeconds)].gap;
  return Math.round(base * stretchFactor(absoluteDeviation));
}

// The one function the rest of the app calls -- composes the three
// dimensions above into a single pattern ready for display now, and for a
// real motor driver later.
export function computeVibrationPattern(measuredSeconds) {
  const band = bandOf(measuredSeconds);
  const cfg = VIBRATION_BANDS[band];
  const { deviation, absoluteDeviation } = computeDeviation(measuredSeconds);
  const pulseCount = computeVibrationRepeatCount(measuredSeconds);
  const pulseDurationMs = computeVibrationPulseDuration(measuredSeconds);
  const gapMs = computeVibrationGap(measuredSeconds);

  const pulses = Array.from({ length: pulseCount }, (_, i) => ({
    durationMs: pulseDurationMs,
    gapMs: i < pulseCount - 1 ? gapMs : 0,
  }));
  const totalDurationMs = pulses.reduce((sum, p) => sum + p.durationMs + p.gapMs, 0);

  return {
    measuredSeconds,
    deviation,
    absoluteDeviation,
    band,
    label: cfg.label,
    pulseCount,
    pulseDurationMs,
    gapMs,
    intensity: cfg.intensity,
    pulses,
    totalDurationMs,
  };
}

// A compact, Arduino-friendly serialization -- e.g. "110,0" (one pulse) or
// "90,150,90,0" (duration,gap pairs, ms) -- not transmitted anywhere yet,
// but ready for the moment a Web Serial connection exists (see serial.js).
export function serializeVibrationPattern(pattern) {
  return pattern.pulses.map((p) => `${p.durationMs},${p.gapMs}`).join(',');
}

export function computeSenseProfile(role, poolIndex, measuredSeconds) {
  const { deviation, absoluteDeviation } = computeDeviation(measuredSeconds);
  return {
    measuredSeconds,
    deviation,
    absoluteDeviation,
    role,
    soundParameters: computeSoundParameters(role, poolIndex, measuredSeconds),
    vibrationParameters: computeVibrationPattern(measuredSeconds),
  };
}
