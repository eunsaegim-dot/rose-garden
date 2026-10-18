// Pure, DOM-free grouping of the shared stroke list into flowers of
// FLOWER_SIZE participants each. No pool-capacity or overflow concept at
// all (unlike the old rose's per-role pools) — every stroke always
// belongs to exactly one deterministic flower and position, purely from
// its position in the ordered list:
//   flowerIndex  = floor(globalIndex / FLOWER_SIZE)
//   posInFlower  = globalIndex % FLOWER_SIZE
// strokes[0..14] -> flower 0, strokes[15..29] -> flower 1, etc. Flowers
// are never persisted (see store.js) -- every client derives the exact
// same flowers from the exact same ordered stroke list every time.
import { classifyTimeRole } from './roleClassifier.js';

export const FLOWER_SIZE = 15;

// strokes: already ordered createdAt asc, id as a tiebreaker (store.js
// guarantees this for both the shared and local adapters) so every
// client/device/reload groups the identical strokes into the identical
// flowers.
export function groupIntoFlowers(strokes) {
  // Defensive de-dupe by id, keeping each id's first occurrence (its
  // original chronological position) -- so one stored record can never
  // become two elements even if an upstream list somehow repeats an id.
  const seenIds = new Set();
  const deduped = strokes.filter((record) => {
    if (seenIds.has(record.id)) return false;
    seenIds.add(record.id);
    return true;
  });

  const flowers = [];
  deduped.forEach((record, i) => {
    const flowerIndex = Math.floor(i / FLOWER_SIZE);
    const posInFlower = i % FLOWER_SIZE;
    if (!flowers[flowerIndex]) {
      flowers[flowerIndex] = { flowerIndex, elements: [] };
    }
    flowers[flowerIndex].elements.push({
      type: classifyTimeRole(record.measuredSeconds),
      record,
      posInFlower,
    });
  });
  return flowers.map(summarizeFlower);
}

function summarizeFlower(flower) {
  const counts = { petal: 0, stamen: 0, leaf: 0, thorn: 0, root: 0 };
  flower.elements.forEach((e) => {
    counts[e.type] += 1;
  });
  return {
    flowerIndex: flower.flowerIndex,
    elements: flower.elements,
    participantCount: flower.elements.length,
    isComplete: flower.elements.length === FLOWER_SIZE,
    counts,
  };
}

// The in-progress flower a brand-new stroke would land in, given the
// CURRENT known strokes (before it's actually appended) -- used for the
// optimistic /bloom reveal, which must agree with the real reconstruction
// once the write is echoed back by Firestore.
export function nextFlowerPosition(strokes) {
  const globalIndex = strokes.length;
  return {
    flowerIndex: Math.floor(globalIndex / FLOWER_SIZE),
    posInFlower: globalIndex % FLOWER_SIZE,
  };
}
