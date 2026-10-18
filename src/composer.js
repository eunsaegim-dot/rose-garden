// Turns the stored strokes into an ordered note sequence for the
// "collective" playback. Firestore only ever stores {uid, measuredSeconds,
// createdAt} — role and note are never stored — so this derives them the
// same deterministic way the rose itself does (see roleSequencer.js),
// using the strokes' chronological order. A future version can swap this
// one function for an AI-generated composition without touching the
// scheduling/playback code in audio.js.
import { noteFreq } from './audio.js';
import { deriveSequence } from './roleSequencer.js';

export function composeFromStrokes(strokes) {
  const sequence = deriveSequence(strokes);
  const notes = [];
  sequence.forEach((result, i) => {
    if (result.overflow || result.role === 'auxPending') return;
    notes.push({
      freq: noteFreq(result.role, result.poolIndex),
      role: result.role,
      feltSeconds: strokes[i].measuredSeconds,
    });
  });
  return notes;
}
