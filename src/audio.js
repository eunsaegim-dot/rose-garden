// The Web Audio synthesis engine for "체감시간의 정원" -- a soft music-box /
// glockenspiel / ambient voice. Pitch and rhythm are never decided here;
// they come from composer.js (pure music theory, no Web Audio) as a note
// descriptor {freq, type, durationMs, gapMs}. This file only turns that
// descriptor into an actual sound, plus the shared signal chain (reverb
// bus, compressor, sustained-pad drone) that stays identical regardless of
// which element types exist in a given flower.
import { composeNote, buildTimeline } from './composer.js';

const MAX_PADS = 10;

// Per-type voice character -- a soft music-box/glockenspiel-ish bell tone:
// fast attack, a quiet octave-up "shimmer" partial for the bright metallic
// overtone, filtered to stay gentle rather than harsh. petal (closest to
// 60s, longest/most "generous" note) carries the warmest body and joins
// the ambient pad drone; stamen (furthest from 60s, shortest note) is a
// bright point accent only, no drone -- mirroring how the rhythm table
// itself treats it as the most "fleeting" of the three.
const ROLE_VOICE = {
  petal: { wave: 'triangle', cutoff: 3000, pickGain: 0.07, send: 0.4, shimmer: true, pad: true },
  stamen: { wave: 'sine', cutoff: 2600, pickGain: 0.06, send: 0.34, shimmer: true, pad: true },
  leaf: { wave: 'sine', cutoff: 2400, pickGain: 0.05, send: 0.32, shimmer: true, pad: true },
  thorn: { wave: 'square', cutoff: 4200, pickGain: 0.1, send: 0.18, shimmer: true, pad: false },
  root: { wave: 'triangle', cutoff: 1600, pickGain: 0.06, send: 0.5, shimmer: false, pad: true },
};
const DEFAULT_VOICE = ROLE_VOICE.leaf;

let ctx = null;
let masterGain = null;
let muteGain = null;
let sendGain = null;
let noiseBuffer = null;
let muted = false;
const activePads = [];

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function makeImpulse(context, duration = 2.6, decay = 2.8) {
  const rate = context.sampleRate;
  const length = Math.floor(rate * duration);
  const impulse = context.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function makeNoiseBuffer(context) {
  const length = Math.floor(context.sampleRate * 0.05);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function buildGraph() {
  masterGain = ctx.createGain();
  masterGain.gain.value = 0.85;

  muteGain = ctx.createGain();
  muteGain.gain.value = muted ? 0 : 1;

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -22;
  compressor.knee.value = 18;
  compressor.ratio.value = 3.5;
  compressor.attack.value = 0.01;
  compressor.release.value = 0.3;

  masterGain.connect(muteGain);
  muteGain.connect(compressor);
  compressor.connect(ctx.destination);

  sendGain = ctx.createGain();
  sendGain.gain.value = 1;
  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = 0.32;

  sendGain.connect(convolver);
  convolver.connect(wet);
  wet.connect(muteGain);

  noiseBuffer = makeNoiseBuffer(ctx);
}

export function ensureAudio() {
  if (!ctx) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    ctx = new AudioCtx();
    buildGraph();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function setMuted(value) {
  muted = value;
  if (muteGain) muteGain.gain.linearRampToValueAtTime(muted ? 0 : 1, ctx.currentTime + 0.15);
}

export function isMuted() {
  return muted;
}

function fadeOutPad(pad) {
  const now = ctx.currentTime;
  pad.gain.gain.cancelScheduledValues(now);
  pad.gain.gain.setValueAtTime(pad.gain.gain.value, now);
  pad.gain.gain.linearRampToValueAtTime(0.0001, now + 1.1);
  setTimeout(() => {
    try {
      pad.osc1.stop();
      pad.osc2.stop();
      pad.lfo.stop();
    } catch {
      /* already stopped */
    }
  }, 1300);
}

function addPad(freq) {
  if (activePads.length >= MAX_PADS) {
    const old = activePads.shift();
    fadeOutPad(old);
  }
  const now = ctx.currentTime;

  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  osc1.type = 'sine';
  osc2.type = 'sine';
  osc1.frequency.value = freq;
  osc2.frequency.value = freq * 1.004;

  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.12 + Math.random() * 0.1;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = freq * 0.0025;
  lfo.connect(lfoGain);
  lfoGain.connect(osc1.frequency);
  lfoGain.connect(osc2.frequency);

  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  osc1.connect(gain);
  osc2.connect(gain);
  gain.connect(masterGain);
  gain.connect(sendGain);

  gain.gain.linearRampToValueAtTime(0.045, now + 1.8);

  osc1.start(now);
  osc2.start(now);
  lfo.start(now);

  const pad = { osc1, osc2, lfo, gain };
  activePads.push(pad);
}

// The voice itself: a filtered tone body (timbre set by element type) plus
// a bright noise "pick" transient and a quiet octave-up shimmer partial --
// reusable for a brand-new stroke and for replaying an existing one on
// click/tap. durationSec is decided entirely by composer.js; this never
// recomputes it.
function pluck(freq, type, durationSec) {
  const voice = ROLE_VOICE[type] || DEFAULT_VOICE;
  const context = ensureAudio();
  const now = context.currentTime;
  const sustain = Math.max(0.05, durationSec);

  const sendTrim = context.createGain();
  sendTrim.gain.value = voice.send;
  sendTrim.connect(sendGain);

  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = voice.cutoff;
  filter.Q.value = 0.6;

  const env = context.createGain();
  env.gain.value = 0;
  filter.connect(env);
  env.connect(masterGain);
  env.connect(sendTrim);

  const osc = context.createOscillator();
  osc.type = voice.wave;
  osc.frequency.value = freq;
  osc.connect(filter);
  env.gain.setValueAtTime(0, now);
  env.gain.linearRampToValueAtTime(0.2, now + 0.012);
  env.gain.exponentialRampToValueAtTime(0.0008, now + 0.012 + sustain);
  osc.start(now);
  osc.stop(now + sustain + 0.15);

  if (voice.shimmer) {
    // a quiet octave-up partial for the bright, bell/glockenspiel-like edge
    const shimmerOsc = context.createOscillator();
    shimmerOsc.type = 'sine';
    shimmerOsc.frequency.value = freq * 2;
    const shimmerGain = context.createGain();
    shimmerGain.gain.setValueAtTime(0, now);
    shimmerGain.gain.linearRampToValueAtTime(0.055, now + 0.015);
    shimmerGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.015 + sustain * 0.55);
    shimmerOsc.connect(shimmerGain);
    shimmerGain.connect(masterGain);
    shimmerGain.connect(sendTrim);
    shimmerOsc.start(now);
    shimmerOsc.stop(now + sustain * 0.55 + 0.1);
  }

  const pick = context.createBufferSource();
  pick.buffer = noiseBuffer;
  const pickFilter = context.createBiquadFilter();
  pickFilter.type = 'bandpass';
  pickFilter.frequency.value = freq * 2.4;
  pickFilter.Q.value = 5;
  const pickGain = context.createGain();
  pickGain.gain.setValueAtTime(voice.pickGain, now);
  pickGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.045);
  pick.connect(pickFilter);
  pickFilter.connect(pickGain);
  pickGain.connect(masterGain);
  pick.start(now);
}

// measuredSeconds: the raw measurement. Returns the note descriptor (see
// composer.js) so the caller can read .type for UI text etc.
export function playStroke(measuredSeconds) {
  const note = composeNote(measuredSeconds);
  pluck(note.freq, note.type, note.durationMs / 1000);
  const voice = ROLE_VOICE[note.type] || DEFAULT_VOICE;
  if (voice.pad) addPad(note.freq * 0.5);
  return note;
}

// Replays a single stroke's note (click/tap) -- never adds another pad
// layer, since the sustained harmony should only grow when a *new* stroke
// is planted, not every time an existing one is replayed.
export function replayStroke(measuredSeconds) {
  const note = composeNote(measuredSeconds);
  pluck(note.freq, note.type, note.durationMs / 1000);
  return note;
}

export function resetAudio() {
  [...activePads].forEach(fadeOutPad);
  activePads.length = 0;
}

// ---------- Collective playback: a whole garden/flower melody, note by note ----------
let compositionTimer = null;
let compositionPlaying = false;

export function isComposing() {
  return compositionPlaying;
}

// notes: [{freq, type, durationMs, gapMs, measuredSeconds}, ...] from
// composer.js's composeGarden()/composeFlowerMelody() -- this builds its
// own absolute timeline via buildTimeline() (pure, deterministic) and
// schedules each note against a shared `startTime` so a parallel scheduler
// (vibrationSync.js) computing the SAME timeline from the SAME notes stays
// in lockstep without either ever calling into the other.
export function playComposition(notes, { startTime, onNote, onEnd } = {}) {
  stopComposition();
  ensureAudio();
  if (!notes.length) {
    onEnd && onEnd();
    return;
  }
  const timeline = buildTimeline(notes);
  compositionPlaying = true;
  const t0 = startTime ?? performance.now();
  let i = 0;
  const scheduleNext = () => {
    if (!compositionPlaying) return;
    if (i >= timeline.length) {
      compositionPlaying = false;
      onEnd && onEnd();
      return;
    }
    const note = timeline[i];
    const delay = Math.max(0, note.startMs - (performance.now() - t0));
    compositionTimer = setTimeout(() => {
      if (!compositionPlaying) return;
      pluck(note.freq, note.type, note.durationMs / 1000);
      const voice = ROLE_VOICE[note.type] || DEFAULT_VOICE;
      if (voice.pad) addPad(note.freq * 0.5);
      onNote && onNote(i, note);
      i += 1;
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

export function stopComposition() {
  compositionPlaying = false;
  if (compositionTimer) {
    clearTimeout(compositionTimer);
    compositionTimer = null;
  }
}
