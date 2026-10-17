// A small generative sound engine. Every planted stroke gets a short voice
// of its own (timbre/register/length chosen by its *role*, see
// roleClassifier.js) plus — for petals — a soft sustained pad that joins a
// slowly accumulating drone, so the piece grows richer the longer people
// keep measuring. All voices draw from one shared scale, so no matter the
// mix of roles the result stays in tune with itself.

const ROOT = 293.66; // D4 — a calm, warm root
// A pentatonic-with-extensions scale: dreamy, never dissonant in any order.
const SCALE = [0, 2, 4, 7, 9, 11, 14, 16, 19, 21];
const MAX_PADS = 10;

// Per-role voice character. octave: register shift in semitone-octaves.
// wave: oscillator type for the tone body. cutoff: lowpass Hz (brightness).
// sustainBase: nominal note length in seconds. pickGain: loudness of the
// bright noise "pick" transient (string-pluck attack). send: how much of
// this voice goes to the reverb bus (space/width). shimmer: adds a quiet
// octave-up partial for extra clarity (core petal only).
const ROLE_VOICE = {
  corePetal: { octave: 0, wave: 'triangle', cutoff: 3200, sustainBase: 1.0, pickGain: 0.1, send: 0.38, shimmer: true },
  innerPetal: { octave: 1, wave: 'sine', cutoff: 2000, sustainBase: 0.32, pickGain: 0.05, send: 0.22, shimmer: false },
  middlePetal: { octave: 0, wave: 'triangle', cutoff: 2300, sustainBase: 0.7, pickGain: 0.09, send: 0.3, shimmer: false },
  outerPetal: { octave: -1, wave: 'triangle', cutoff: 1900, sustainBase: 1.6, pickGain: 0.08, send: 0.5, shimmer: false, wide: true },
  leaf: { octave: -1, wave: 'sine', cutoff: 1100, sustainBase: 0.95, pickGain: 0.02, send: 0.3, shimmer: false },
  thorn: { octave: 2, wave: 'square', cutoff: 4200, sustainBase: 0.1, pickGain: 0.16, send: 0.08, shimmer: false },
};
const DEFAULT_VOICE = ROLE_VOICE.middlePetal;

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

// poolIndex walks the scale within its own role (so e.g. successive core
// petals form a little melodic line); role sets the register.
export function noteFreq(role, poolIndex = 0) {
  const voice = ROLE_VOICE[role] || DEFAULT_VOICE;
  const degree = SCALE[((poolIndex % SCALE.length) + SCALE.length) % SCALE.length];
  return ROOT * Math.pow(2, (degree + voice.octave * 12) / 12);
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

// The voice itself: a filtered tone body (timbre set by role) plus a
// bright noise "pick" transient — reusable for a brand-new stroke and for
// replaying an existing one on click/tap.
function pluck(freq, role, feltSeconds = 0) {
  const voice = ROLE_VOICE[role] || DEFAULT_VOICE;
  const context = ensureAudio();
  const now = context.currentTime;
  const sustain = clamp(voice.sustainBase + feltSeconds * 0.01, voice.sustainBase * 0.7, voice.sustainBase * 1.7);

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
  env.gain.linearRampToValueAtTime(0.2, now + 0.015);
  env.gain.exponentialRampToValueAtTime(0.0008, now + 0.015 + sustain);
  osc.start(now);
  osc.stop(now + sustain + 0.15);

  if (voice.wide) {
    // a second, slightly detuned voice for an outer-petal sense of spread
    const osc2 = context.createOscillator();
    osc2.type = voice.wave;
    osc2.frequency.value = freq * 1.006;
    osc2.connect(filter);
    osc2.start(now);
    osc2.stop(now + sustain + 0.15);
  }
  if (voice.shimmer) {
    // a quiet octave-up partial for the core petal's "clearest, most
    // beautiful" tone
    const shimmerOsc = context.createOscillator();
    shimmerOsc.type = 'sine';
    shimmerOsc.frequency.value = freq * 2;
    const shimmerGain = context.createGain();
    shimmerGain.gain.setValueAtTime(0, now);
    shimmerGain.gain.linearRampToValueAtTime(0.05, now + 0.02);
    shimmerGain.gain.exponentialRampToValueAtTime(0.0005, now + 0.02 + sustain * 0.6);
    shimmerOsc.connect(shimmerGain);
    shimmerGain.connect(masterGain);
    shimmerGain.connect(sendTrim);
    shimmerOsc.start(now);
    shimmerOsc.stop(now + sustain * 0.6 + 0.1);
  }

  const pick = context.createBufferSource();
  pick.buffer = noiseBuffer;
  const pickFilter = context.createBiquadFilter();
  pickFilter.type = 'bandpass';
  pickFilter.frequency.value = freq * (role === 'thorn' ? 3.2 : 2);
  pickFilter.Q.value = role === 'thorn' ? 7 : 4;
  const pickGain = context.createGain();
  pickGain.gain.setValueAtTime(voice.pickGain, now);
  pickGain.gain.exponentialRampToValueAtTime(0.0005, now + (role === 'thorn' ? 0.035 : 0.05));
  pick.connect(pickFilter);
  pickFilter.connect(pickGain);
  pickGain.connect(masterGain);
  pick.start(now);
}

// feltSeconds: the raw measured duration (nudges the voice's length a touch).
// role / poolIndex: see roleClassifier.js / Rose2D.plant().
// Returns the frequency used, so it can be stored and replayed later.
export function playStroke(feltSeconds, role, poolIndex) {
  const freq = noteFreq(role, poolIndex);
  pluck(freq, role, feltSeconds);
  if (role !== 'thorn') addPad(freq * 0.5); // thorns are a point accent only, no drone
  return freq;
}

// Replays a single stroke's note (click/tap), without adding another pad
// layer — the sustained harmony only grows when a *new* stroke is planted.
export function replayStroke(freq, role, feltSeconds) {
  pluck(freq, role, feltSeconds);
}

export function playOverflowChime() {
  const context = ensureAudio();
  const now = context.currentTime;
  [1, 1.5, 2].forEach((mult, i) => {
    const osc = context.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = ROOT * 2 * mult;
    const g = context.createGain();
    g.gain.value = 0;
    osc.connect(g);
    g.connect(masterGain);
    g.connect(sendGain);
    const t0 = now + i * 0.06;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.07, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, t0 + 1.3);
    osc.start(t0);
    osc.stop(t0 + 1.4);
  });
}

export function resetAudio() {
  [...activePads].forEach(fadeOutPad);
  activePads.length = 0;
}

// ---------- Collective playback: the whole piece, note by note ----------
let compositionTimer = null;
let compositionPlaying = false;

export function isComposing() {
  return compositionPlaying;
}

// notes: [{ freq, role, feltSeconds }, ...] — see composer.js. Plain
// setTimeout pacing (not Web-Audio-scheduled) keeps start/stop trivially
// cancellable.
export function playComposition(notes, { gap = 480, onNote, onEnd } = {}) {
  stopComposition();
  ensureAudio();
  if (!notes.length) {
    onEnd && onEnd();
    return;
  }
  compositionPlaying = true;
  let i = 0;
  const step = () => {
    if (!compositionPlaying) return;
    if (i >= notes.length) {
      compositionPlaying = false;
      onEnd && onEnd();
      return;
    }
    const note = notes[i];
    pluck(note.freq, note.role, note.feltSeconds);
    onNote && onNote(i, note);
    i += 1;
    compositionTimer = setTimeout(step, gap);
  };
  step();
}

export function stopComposition() {
  compositionPlaying = false;
  if (compositionTimer) {
    clearTimeout(compositionTimer);
    compositionTimer = null;
  }
}
