// Maps a felt-time measurement to the flower element it will become. Pure
// and deterministic — the same seconds value always classifies the same
// way. Checked in priority order (root first), so "root" is an exception
// that overrides the plain distance-from-60s bands for sufficiently long
// measurements — see the project discussion for the exact spec. This one
// function is the single source every sense (visual element type, note
// rhythm band) reads from — see flowerModel.js, composer.js.
export function classifyTimeRole(measuredSeconds) {
  // Root: only when measuredSeconds > 60 AND at least 15s past it, i.e.
  // measuredSeconds >= 75 -- checked first, overriding every other band.
  if (measuredSeconds >= 75) return 'root';

  const diff = measuredSeconds - 60;
  const absDiff = Math.abs(diff);
  if (absDiff <= 5) return 'petal';
  if (absDiff <= 15) return 'stamen';
  if (absDiff <= 25) return 'leaf'; // the measuredSeconds>60 sub-case here is unreachable (already root above)
  return 'thorn'; // absDiff > 25 and measuredSeconds < 75 (guaranteed by the root check above)
}

export const ROLE_RESULT_TEXT = {
  petal: '당신의 시간은 꽃잎이 되었습니다.',
  stamen: '당신의 시간은 꽃수술이 되었습니다.',
  leaf: '당신의 시간은 잎사귀가 되었습니다.',
  thorn: '당신의 시간은 가시가 되었습니다.',
  root: '당신의 시간은 뿌리가 되었습니다.',
};

export const ROLE_LABEL = {
  petal: '꽃잎',
  stamen: '꽃수술',
  leaf: '잎사귀',
  thorn: '가시',
  root: '뿌리',
};
