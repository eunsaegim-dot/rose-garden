// Maps a felt-time measurement to the rose part it will become. Pure and
// deterministic — the same seconds value always classifies the same way.
// 'leafOrThorn' is resolved into one of the two concrete roles by whichever
// component currently has fewer filled slots (see Rose2D._pickLeafOrThorn).
export function classifyTimeRole(seconds) {
  if (seconds <= 30) {
    return 'leafOrThorn';
  }
  if (seconds < 55) {
    // 30초 초과 ~ 55초 미만
    return 'innerPetal';
  }
  if (seconds <= 65) {
    // 55 ~ 65초
    return 'corePetal';
  }
  if (seconds < 80) {
    // 65초 초과 ~ 80초 미만
    return 'middlePetal';
  }
  return 'outerPetal'; // 80초 이상
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
