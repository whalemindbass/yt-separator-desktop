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

// ── 엔진 크래시 반복 감지 ──────────────────────────────────
// 엔진이 죽으면 자동으로 다시 살리는데(handleEngineCrash), 무조건 매번 재시도하면
// 고장난 VST·드라이버 충돌처럼 근본적으로 깨진 상황에서 즉시·계속 재시작을 반복한다
// (오디오 드라이버 스래싱, 크래시 저널 스팸, 화면이 계속 깜빡이는 것처럼 보임).
// 이 창(윈도) 안에 이만큼 죽으면 "반복 크래시"로 보고 자동 재시작을 멈춘다.
export const CRASH_LOOP_MAX = 3;
export const CRASH_LOOP_WINDOW_MS = 30000;

/**
 * 크래시 시각을 기록하고 "반복 크래시(루프)"인지 판정한다.
 * @param {number[]} timestamps 지금까지의 크래시 시각(ms) — 이 함수가 in-place 로 오래된 것을 정리한다
 * @param {number} now
 * @returns {boolean} true 면 "루프로 판단, 자동 재시작 중단"
 */
export function noteCrashAndCheckLoop(timestamps, now) {
  while (timestamps.length && now - timestamps[0] > CRASH_LOOP_WINDOW_MS) timestamps.shift();
  timestamps.push(now);
  return timestamps.length >= CRASH_LOOP_MAX;
}

// ── 저장된 입력 채널 설정이 지금 장치에서 유효한지 ──────────────
// 모노 모드일 땐 chR 을 안 쓴다. 그런데도 chR 까지 항상 범위 검사에 넣으면, 채널이 많은
// 인터페이스(RME/Audient 등)에서 예전에 스테레오로 쓰다 chR 을 예컨대 9번으로 남겨 둔 채
// 모노로 바꿨을 때 — chR=9 가 지금 장치가 보고한 입력 개수보다 커 보이는 상황(장치가 열리는
// 도중 잠깐 더 적은 개수를 보고하는 경우 포함)마다, 정작 쓰는 chL 까지 통째로 안 밀어
// 넣어진다. 2채널 장치는 chR 기본값(1)이 항상 범위 안이라 이 버그가 원천적으로 안 드러난다
// — "채널 많은 인터페이스에서 저장한 입력 채널이 안 돌아온다" 제보가 유독 잦았던 이유.
// ── 지연 내역 ────────────────────────────────────────────────────
// 왕복 지연 하나만 보여 주면 "버퍼 탓인지, 인터페이스 드라이버 탓인지, 플러그인 탓인지"를
// 알 수가 없다(제보: 같은 버퍼인데 다른 DAW보다 늦게 들린다). 엔진이 이미 보내는 값으로 나눈다.
//  · 버퍼   = 입력·출력 버퍼 한 번씩(2 × block / sr)
//  · 드라이버 = 드라이버가 보고한 왕복 지연 중 버퍼를 뺀 나머지(인터페이스 내부 DSP·안전 버퍼)
//  · 재생 정렬(PDC) = 켜져 있으면 엔진이 재생 소스를 이만큼 미리 읽어 플러그인 지연을 맞춘다.
//    라이브 입력 모니터링엔 더해지지 않는다(v1.9.22 엔진부터 — 예전엔 녹음 트랙 전체에 보정
//    지연선을 걸어 모니터링까지 늦어졌다). 그래서 모니터링 합계에는 넣지 않는다.
// 반환은 전부 ms. 값이 없으면 0.
export function latencyBreakdown({ sr, block, roundtripMs, pdcMs, pdcOn }) {
  const bufferMs = sr > 0 && block > 0 ? (2 * block / sr) * 1000 : 0;
  const rt = roundtripMs > 0 ? roundtripMs : 0;
  const driverMs = Math.max(0, rt - bufferMs);
  const plugin = pdcOn && pdcMs > 0 ? pdcMs : 0;
  return { bufferMs, driverMs, pdcMs: plugin, monitorMs: rt };
}

// ── FX 상태(노브값) 캐시 병합 ────────────────────────────────────
// 엔진이 죽으면 플러그인 노브값은 엔진만 알고 있어서 같이 사라진다. 살아 있는 동안 주기적으로
// 받아 둔 값(캐시)으로 복구한다. 새로 받은 값(fresh)이 있으면 그걸, 이번에 응답이 늦어 못 받은
// 슬롯은 예전 캐시 값을 유지한다(부분 응답 때문에 멀쩡한 값이 지워지지 않게). 지금 체인에
// 없는 슬롯(지운 플러그인)은 버린다 — 캐시가 세션 내내 끝없이 불어나지 않게.
// prev·fresh: { slotId: base64 } · currentIds: 지금 존재하는 슬롯 id 목록
export function mergeFxCache(prev, currentIds, fresh) {
  const out = {};
  for (const id of currentIds || []) {
    const v = fresh && fresh[id] != null ? fresh[id] : (prev && prev[id] != null ? prev[id] : undefined);
    if (v != null) out[id] = v;
  }
  return out;
}

// ── 장치별 저장된 입력 채널 고르기 ─────────────────────────────
// 예전엔 입력 채널(모노/스테레오·채널 번호)을 장치 구분 없이 하나만 저장해서, 인터페이스를
// 두 개 번갈아 쓰면(집 2ch · 작업실 12ch 등) 서로의 채널 번호를 덮어썼다. 이제 장치 이름별로
// 저장한다(byDevice). 예전 형식(legacy, 장치 구분 없는 값 하나)은 장치별 기록이 아직
// 하나도 없을 때만 이어받는다 — 이미 장치별 기록이 있는데 처음 보는 장치라면, 다른
// 장치의 채널 번호를 끌어오지 않고 기본값으로 시작한다.
// 반환: { cfg, source } — source 는 'device' | 'legacy' | 'default'
export const INPUT_CFG_DEFAULT = { mode: 0, chL: 0, chR: 1 };
export function pickInputConfig(byDevice, legacy, deviceName) {
  const map = byDevice && typeof byDevice === 'object' ? byDevice : {};
  const norm = (s) => ({ mode: s.mode | 0, chL: s.chL | 0, chR: s.chR | 0 });
  if (deviceName && map[deviceName] && typeof map[deviceName] === 'object') return { cfg: norm(map[deviceName]), source: 'device' };
  if (!Object.keys(map).length && legacy && typeof legacy === 'object') return { cfg: norm(legacy), source: 'legacy' };
  return { cfg: { ...INPUT_CFG_DEFAULT }, source: 'default' };
}

export function inputConfigInRange(want, deviceInCount) {
  const n = Math.max(1, deviceInCount || 1);
  const chLInRange = want.chL < n;
  const chRInRange = want.mode !== 1 || want.chR < n;
  return chLInRange && chRInRange;
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
  return wavePolySvg(peaks, rms, mx, N, color);
}

/**
 * 미리 요약된 파형(버킷마다 피크·RMS — 영상편집은 메인 프로세스의 ffmpeg 가 파일을 흘려 읽으며
 * 만든다)의 [s0, s1) 구간을 N 점으로 모아 buildWaveSvg 와 똑같은 모양의 SVG 로 그린다.
 * 원본 샘플 전체를 렌더러 메모리에 올리지 않아도 된다(큰/긴 영상에서 렌더러 OOM 크래시가
 * 났던 원인). N 이 구간 버킷 수보다 많으면(크게 확대) 같은 버킷을 여러 점이 나눠 쓴다.
 */
export function buildWaveSvgFromEnvelope(envPeaks, envRms, s0, s1, color, N = 1400) {
  if (!envPeaks || !envRms) return '';
  s0 = Math.max(0, s0 | 0);
  s1 = Math.min(envPeaks.length, s1 | 0);
  const len = s1 - s0;
  if (len <= 0) return '';
  let mx = 1e-6;
  const peaks = new Float32Array(N), rms = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = s0 + Math.floor(i * len / N);
    const b = Math.max(a + 1, s0 + Math.floor((i + 1) * len / N));
    let p = 0, s2 = 0;
    for (let j = a; j < b; j++) {
      if (envPeaks[j] > p) p = envPeaks[j];
      s2 += envRms[j] * envRms[j];
    }
    peaks[i] = p; rms[i] = Math.sqrt(s2 / (b - a));
    if (p > mx) mx = p;
  }
  return wavePolySvg(peaks, rms, mx, N, color);
}

// 피크(흐린 외곽)·RMS(본체) 두 겹 폴리곤 + 가운데 선 — buildWaveSvg·buildWaveSvgFromEnvelope 공용
function wavePolySvg(peaks, rms, mx, N, color) {
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
