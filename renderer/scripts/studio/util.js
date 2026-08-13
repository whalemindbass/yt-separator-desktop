'use strict';
// 스튜디오의 순수 계산·표시 도우미.
//
// 여기 있는 것들은 화면도 엔진도 모듈 상태도 건드리지 않는다. 그래서 옮겨도 아무것도
// 딸려오지 않고, 눈으로 확인할 필요 없이 값만 넣어 보면 맞는지 알 수 있다.
// studio.js 에 섞여 있을 때는 이 성질이 보이지 않았다.

/** HTML 삽입 전 이스케이프 */
export const esc = (s) => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 재생 위치 표시 — M:SS.mmm */
export const fmtTC = (sec) => {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};

/** 클립을 끌 때의 이동량 — +M:SS.cc. 세밀한 이동을 눈으로 확인하려고 센티초까지 쓴다 */
export const fmtDelta = (sec) => {
  const a = Math.abs(sec), m = Math.floor(a / 60), s = a - m * 60;
  return `${sec >= 0 ? '+' : '−'}${m}:${s.toFixed(2).padStart(5, '0')}`;
};

/** "rgb(r,g,b)" 또는 "#rgb"/"#rrggbb" → "#rrggbb" (색상 input 의 기본값은 이 꼴만 받는다) */
export function rgbToHex(c) {
  c = String(c).trim();
  if (c[0] === '#') return c.length === 4 ? '#' + [...c.slice(1)].map(x => x + x).join('') : c.slice(0, 7);
  const m = c.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return '#888888';
  return '#' + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, '0')).join('');
}

// ── 미터 눈금 ────────────────────────────────────────────
// 선형 진폭을 그대로 쓰면 노이즈 플로어(-60dB 수준)도 첫 LED 를 켜서 무음일 때 깜빡인다.
// dB 로 옮기고 게이트를 둔 뒤 블록 단위로 내림 — 값이 경계에서 흔들려도 표시가 떨리지 않는다.
export const METER_BLOCKS = 30;      // CSS 의 LED 분할 수와 같아야 한다
export const METER_FLOOR_DB = -54;   // 이 아래는 완전히 꺼짐
export const METER_GATE = 0.0056;    // ≈ -45 dB — 엔진 게이트와 같은 값

export function meterPct(v) {
  if (!(v > METER_GATE)) return 0;
  const db = 20 * Math.log10(Math.min(1, v));
  const p = (db - METER_FLOOR_DB) / -METER_FLOOR_DB;
  if (p <= 0) return 0;
  return Math.min(1, Math.floor(p * METER_BLOCKS) / METER_BLOCKS) * 100;
}

// ── 파형 ────────────────────────────────────────────────
/**
 * 스테레오 버퍼를 파형 SVG 로. peak 는 흐린 외곽, rms 는 본체.
 * 버킷마다 200 지점만 훑는다 — 긴 곡에서 전부 읽으면 로드가 눈에 띄게 느려진다.
 */
export function buildWaveSvg(ch, color, N = 1400) {
  if (!ch || !ch[0]) return '';
  const L = ch[0], R = ch[1] || ch[0], len = L.length;
  const bucket = Math.max(1, Math.floor(len / N));
  let mx = 1e-6;
  const peaks = new Float32Array(N), rms = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const start = i * bucket, end = Math.min(len, start + bucket);
    let p = 0, s2 = 0, cnt = 0;
    const step = Math.max(1, Math.floor((end - start) / 200));
    for (let j = start; j < end; j += step) {
      const a = (L[j] + R[j]) * 0.5, aa = Math.abs(a);
      if (aa > p) p = aa;
      s2 += a * a; cnt++;
    }
    peaks[i] = p; rms[i] = cnt ? Math.sqrt(s2 / cnt) : 0;
    if (p > mx) mx = p;
  }
  const poly = (arr, scale) => {
    let a = '', b = '';
    for (let i = 0; i < N; i++) { const h = Math.min(1, arr[i] / mx) * 22 * scale; a += `${i},${(25 - h).toFixed(1)} `; }
    for (let i = N - 1; i >= 0; i--) { const h = Math.min(1, arr[i] / mx) * 22 * scale; b += `${i},${(25 + h).toFixed(1)} `; }
    return a + b;
  };
  return `<svg viewBox="0 0 ${N} 50" preserveAspectRatio="none">`
    + `<polygon points="${poly(peaks, 1)}" fill="${color}" fill-opacity=".24"/>`
    + `<polygon points="${poly(rms, 1)}" fill="${color}" fill-opacity=".7"/>`
    + `<line x1="0" y1="25" x2="${N}" y2="25" stroke="${color}" stroke-opacity=".45" stroke-width=".6"/></svg>`;
}
