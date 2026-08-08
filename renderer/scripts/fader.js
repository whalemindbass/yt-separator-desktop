// 볼륨 페이더 테이퍼.
//
// 슬라이더의 value 는 게인이 아니라 "손잡이 위치"다. 눈금이 선형이면 상한을 올릴수록
// 유니티(게인 1.0)가 페이더 한가운데로 내려와 0dB 근처 미세 조정이 둔해진다.
// 그래서 dB 로 매핑한다 — 유니티를 위쪽 FADER_UNITY 지점에 고정하고, 그 아래는
// 제곱 곡선으로 눌러서 실제로 많이 쓰는 -20~0dB 구간에 눈금을 몰아준다.
//
// 저장·표시는 계속 게인(퍼센트)이고 위치는 화면에서만 쓴다. 위치를 저장하면
// 테이퍼 상수를 바꾸는 순간 기존 프로젝트의 볼륨이 달라져 버린다.
'use strict';

export const FADER_POS = 1000;      // 슬라이더 정수 눈금 수
export const FADER_UNITY = 0.72;    // 게인 1.0 이 놓이는 위치 비율
export const FADER_MAX_DB = 10;     // 최상단 = +10dB (게인 ≈3.16)
export const FADER_MIN_DB = -60;    // 최하단 — 이 아래는 무음 취급

export function faderToGain(pos) {
  const p = Math.max(0, Math.min(1, Number(pos) / FADER_POS));
  if (p <= 0) return 0;
  const db = p >= FADER_UNITY
    ? ((p - FADER_UNITY) / (1 - FADER_UNITY)) * FADER_MAX_DB
    : FADER_MIN_DB * Math.pow(1 - p / FADER_UNITY, 2);
  return Math.pow(10, db / 20);
}

export function gainToFader(g) {
  if (!(g > 0)) return 0;
  const db = 20 * Math.log10(g);
  const p = db >= 0
    ? FADER_UNITY + Math.min(1, db / FADER_MAX_DB) * (1 - FADER_UNITY)
    : FADER_UNITY * (1 - Math.sqrt(Math.min(1, db / FADER_MIN_DB)));
  return Math.round(Math.max(0, Math.min(1, p)) * FADER_POS);
}

export const FADER_UNITY_POS = gainToFader(1);

/** 표시용 — 게인을 퍼센트 정수로 */
export const gainPct = (g) => Math.round(g * 100);
/** 퍼센트로 저장된 값 ↔ 슬라이더 위치 */
export const pctToFader = (pct) => gainToFader(Number(pct) / 100);
export const faderToPct = (pos) => gainPct(faderToGain(pos));

/** 표시용 — 게인을 dB 문자열로. 0.0 = 유니티, 무음은 -∞ */
export function dbText(g) {
  if (!(g > 0)) return '-∞ dB';
  const db = 20 * Math.log10(g);
  if (db <= FADER_MIN_DB) return '-∞ dB';
  if (Math.abs(db) < 0.05) return '0.0 dB';   // 반올림하면 0.0 인데 부호만 남는 것 방지
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}
/** 유니티 눈금을 CSS 로 넘길 때 쓰는 위치(%) — 페이더 트랙 기준 */
export const FADER_UNITY_CSS = `${(FADER_UNITY * 100).toFixed(1)}%`;
