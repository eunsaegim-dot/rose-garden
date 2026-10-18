// Maps a felt-time measurement to the rose part it will become. Pure and
// deterministic — the same seconds value always classifies the same way.
// 'leafOrThorn' is resolved into one of the two concrete roles by whichever
// component currently has fewer filled slots (see Rose2D._pickLeafOrThorn).
export function classifyTimeRole(seconds) {
  if (seconds <= 35) {
    // 35초 이하 -- thorn, decided directly by time (no more pool-balance
    // ambiguity/accumulation gating here).
    return 'thorn';
  }
  if (seconds <= 45) {
    // 35초 초과 ~ 45초 이하 -- leaf, likewise decided directly by time.
    return 'leaf';
  }
  if (seconds < 55) {
    // 45초 초과 ~ 55초 미만 -- intentionally held at its original mapping
    // (innerPetal) for now; this range has no "stamen" visual in the rose
    // renderer, so it is not reassigned until that's designed.
    return 'innerPetal';
  }
  if (seconds <= 65) {
    // 55 ~ 65초 -- already matches the requested "petal" band exactly.
    return 'corePetal';
  }
  if (seconds < 80) {
    // 65초 초과 ~ 80초 미만 -- held at its original mapping (middlePetal);
    // covers the requested "stamen" (65~75) and part of "root" (75~80)
    // ranges, neither of which has a rose-renderer visual yet.
    return 'middlePetal';
  }
  return 'outerPetal'; // 80초 이상 -- held at its original mapping.
}

export const ROLE_RESULT_TEXT = {
  corePetal: '당신의 시간은 장미의 중심 꽃잎이 되었습니다.',
  innerPetal: '당신의 시간은 장미의 안쪽 꽃잎이 되었습니다.',
  middlePetal: '당신의 시간은 장미의 중간 꽃잎이 되었습니다.',
  outerPetal: '당신의 시간은 장미의 바깥 꽃잎이 되었습니다.',
  leaf: '당신의 시간은 장미의 잎사귀가 되었습니다.',
  thorn: '당신의 시간은 장미의 가시가 되었습니다.',
};

export const ROLE_LABEL = {
  corePetal: '핵심 꽃잎',
  innerPetal: '안쪽 꽃잎',
  middlePetal: '중간 꽃잎',
  outerPetal: '바깥 꽃잎',
  leaf: '잎사귀',
  thorn: '가시',
};
