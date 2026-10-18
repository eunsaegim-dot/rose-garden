// Pure music theory for "체감시간의 정원" -- no Web Audio, no DOM. Every
// note's pitch/length/rest is a deterministic function of a single
// measuredSeconds value (pitch) or its classified type (rhythm, see
// roleClassifier.js), so two different people who happened to measure the
// exact same seconds always get the exact same note, and every device
// computes the exact same melody from the exact same stroke list. audio.js
// only turns these note descriptors into actual sound; it never decides
// pitch/rhythm itself.
import { classifyTimeRole } from './roleClassifier.js';
import { groupIntoFlowers } from './flowerModel.js';

const ROOT = 261.63; // C4
const SCALE = [0, 2, 4, 7, 9]; // C D E G A -- C major pentatonic

// 60s-error band -> note length / rest-after. petal (closest to 60s) is
// the longest/most generous; each band further from 60s is a little
// shorter/sparser; root (the long-side exception past 75s) gets its own
// longer, resonant note rather than a short accent, since it represents a
// deliberately sustained over-measurement rather than a fleeting one.
const RHYTHM_BY_TYPE = {
  petal: { durationMs: 750, gapMs: 200 },
  stamen: { durationMs: 550, gapMs: 160 },
  leaf: { durationMs: 400, gapMs: 120 },
  thorn: { durationMs: 250, gapMs: 80 },
  root: { durationMs: 850, gapMs: 220 },
};

// A short extra rest appended after a flower's last note when playing the
// whole garden, so one flower's melody doesn't run straight into the next.
const FLOWER_REST_MS = 500;

// How far (in scale steps) a measurement can push the register, and how
// many seconds of deviation from 60s equal one step -- bounds how extreme
// the pitch can get for very short/long measurements ("극단적인 측정값은
// 음역을 제한").
const MAX_STEPS = 7;
const SECONDS_PER_STEP = 9;

// Shorter than 60s -> higher register; near 60s -> center register;
// longer than 60s -> lower register. Pure function of measuredSeconds
// alone (never of participation order), always lands on a pentatonic
// scale tone.
export function pitchFor(measuredSeconds) {
  const deviation = measuredSeconds - 60;
  const rawSteps = Math.round(-deviation / SECONDS_PER_STEP);
  const steps = Math.max(-MAX_STEPS, Math.min(MAX_STEPS, rawSteps));
  const scaleLen = SCALE.length;
  const octave = Math.floor(steps / scaleLen);
  const degreeIdx = ((steps % scaleLen) + scaleLen) % scaleLen;
  const semitone = SCALE[degreeIdx] + octave * 12;
  return ROOT * Math.pow(2, semitone / 12);
}

export function noteDurationMsFor(measuredSeconds) {
  return RHYTHM_BY_TYPE[classifyTimeRole(measuredSeconds)].durationMs;
}
export function noteGapMsFor(measuredSeconds) {
  return RHYTHM_BY_TYPE[classifyTimeRole(measuredSeconds)].gapMs;
}

// The single conversion point: one measuredSeconds value -> one complete
// playable note descriptor (pitch + type + rhythm). Every other function
// in this file (and audio.js's playStroke/replayStroke) builds on this, so
// a lone measurement and a measurement inside a flower's melody always
// produce the identical note.
export function composeNote(measuredSeconds) {
  const type = classifyTimeRole(measuredSeconds);
  const rhythm = RHYTHM_BY_TYPE[type];
  return {
    freq: pitchFor(measuredSeconds),
    type,
    measuredSeconds,
    durationMs: rhythm.durationMs,
    gapMs: rhythm.gapMs,
  };
}

// One flower's up-to-15 records, in participation order, as a short melody.
export function composeFlowerMelody(flower) {
  return flower.elements.map((el) => composeNote(el.record.measuredSeconds));
}

// The whole garden: flower 1 -> flower 2 -> ... in order, INCLUDING the
// final flower even if it's still growing (not yet 15). A short rest is
// appended after every non-final flower's last note.
export function composeGarden(strokes) {
  const flowers = groupIntoFlowers(strokes);
  const notes = [];
  flowers.forEach((flower, flowerIdx) => {
    const melody = composeFlowerMelody(flower);
    const isLastFlower = flowerIdx === flowers.length - 1;
    melody.forEach((note, noteIdx) => {
      const isLastNoteOfFlower = noteIdx === melody.length - 1;
      const extraRest = isLastNoteOfFlower && !isLastFlower ? FLOWER_REST_MS : 0;
      notes.push({ ...note, gapMs: note.gapMs + extraRest });
    });
  });
  return notes;
}

// Attaches absolute startMs/endMs to an ordered note list -- the ONE
// timeline audio.js's playComposition and vibrationSync.js's
// buildVibrationSchedule both read from, so "same note start time, length,
// and rest" is defined in exactly one place rather than recomputed twice.
export function buildTimeline(notes) {
  let t = 0;
  return notes.map((note) => {
    const startMs = t;
    const endMs = startMs + note.durationMs;
    t = endMs + note.gapMs;
    return { ...note, startMs, endMs };
  });
}
