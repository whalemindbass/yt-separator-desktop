'use strict';
// 베이스 스템 → TAB 채보 코어. DOM·워커 API 를 쓰지 않는 순수 함수라
// 워커에서도, 테스트 하네스에서도 그대로 불러 쓴다.
//
// 흐름: 2배 데시메이션 → 프레임별 YIN 피치 → 중앙값 평활 → 노트 분절
//       → 지판 배치(DP). 튜너와 같은 방식이라 로우 B(30.87Hz)까지 잡는다.

/** 표준 튜닝. midi 는 각 현의 개방현 음 (낮은 현 → 높은 현 순서). */
export const TUNINGS = {
  '4': { id: '4', label: 'E A D G', strings: [28, 33, 38, 43] },              // E1 A1 D2 G2
  '5': { id: '5', label: 'B E A D G', strings: [23, 28, 33, 38, 43] },        // + B0
  '5H': { id: '5H', label: 'E A D G C', strings: [28, 33, 38, 43, 48] },      // 하이 C
  '4b': { id: '4b', label: 'Eb Ab Db Gb', strings: [27, 32, 37, 42] },        // 하프다운(반음 내림)
  '4d': { id: '4d', label: 'D A D G', strings: [26, 33, 38, 43] },            // 드랍 D — 4번줄만 온음 내림
};

export const DEFAULTS = {
  tuning: '4',
  maxFret: 22,
  fmin: 25,        // 로우 B(30.87) · 드롭 A(27.5) 포함
  fmax: 520,       // 베이스 기본파 상한 (G4 392Hz 위로 여유)
  hopMs: 11.6,     // 프레임 간격
  // 피치 추정 방식(실험용, 기본은 옛 방식 유지). 'yin' 이면 프레임마다 하나를 그 자리에서
  // 확정(옛 동작) · 'pyin' 이면 CMND 다중 후보를 남겨 전체 곡에서 가장 매끄러운 경로를
  // Viterbi 로 고른다(lab/tab/README.md 10번 절). 'crepe' 는 이 옵션만으로는 안 켜진다 —
  // ONNX 추론이 비동기라 transcribe() 가 아니라 별도의 transcribeCrepe() 를 호출해야 한다
  // (11번 절). score/synth-score/sepattack-real 로 비교하기 전에는 기본을 바꾸지 않는다.
  pitchTracker: 'yin',
  pyinCandidates: 3,      // 프레임당 남길 후보 개수(CMND 국소최소 또는 CREPE 살리언스 피크. +옥타브 대안은 pyin 경로에서만 별도로 더 붙는다)
  pyinNearCost: 0.15,     // 근처 bin(±1.5반음)으로 미끄러질 때 bin당 비용
  pyinJumpCost: 3.0,      // 아무 데서나 새 음으로 도약하는 비용 — 낮추면 잡음도 쉽게 옮겨붙는다
  pyinV2U: 1.0,           // 유성 → 무성 전이 비용
  pyinU2V: 1.5,           // 무성 → 유성 전이 비용 (비대칭 — 애매하면 조용한 쪽이 싸다)
  pyinUnvoicedEmit: 1.2,  // 무성 상태 자체의 방출비용(경쟁 상대인 유성 후보들과 견줄 기준)
  minNoteMs: 70,   // 이보다 짧으면 버린다 (검출 흔들림)
  gapMs: 45,       // 같은 음이 이 간격 안에서 끊기면 하나로 잇는다
  rmsGate: 0.0016, // 튜너 실측에서 약하게 튕긴 음이 rms 0.0017 근처였다
  octRatio: 0.55,       // 한 옥타브 아래 성분이 이 비율보다 크면 그쪽이 진짜 기본파
  // 3배음이 2배음의 이 비율보다 작으면 지금 물고 있는 것이 기본파가 아니다 — 한 옥타브 올린다.
  // 0 으로 두면 옛 동작(아래로 접기만 함)이 된다.
  octUpRatio: 0.35,
  // 그리고 지금 자리의 기본파가 2배음보다 약해야 한다 (죽어 있다는 증거).
  // 두 곡 격자 훑기에서 고른 값 — 샘플1 음정 88%(옛값 89%) · 샘플2 옥타브 위쪽 음 69%(옛값 14%).
  // octUpRatio 를 0.5 위로 올리면 샘플1 이 83% 로 무너진다.
  octUpH2: 1.0,
  onsetThresh: 0.12,    // 로그 에너지 상승분이 국소 평균보다 이만큼 크면 어택 (고정 방식)
  // 온셋용 에너지를 재는 창(ms). 0 이면 피치 창(약 93ms)을 그대로 쓴다.
  //   피치 창은 저음 한 주기를 담으려 길다. 어택은 5~20ms 사건이라 그 창에서는 평균에 묻힌다.
  //   한동안 0 으로 두었는데, 그때 근거로 삼은 "스템에서 잉여가 26 → 156 으로 뛴다" 는
  //   검출기에서 파생된 정답지가 만든 허수였다. 손으로 찍은 독립 정답지
  //   (ground-truth/bass_sample.onsets.txt) 로 다시 재니 짧은 창이 놓침과 잉여를 함께 줄인다.
  //
  //     실제 곡 (손 정답지 670개 · 밀림 보정 · 허용 50ms)   합성 (정답 정확)
  //     피치창·0.08  일치 488 · 놓침 182 · 잉여 112  F1 77%   밀림 -39ms · IQR 38ms
  //     20ms  ·0.12  일치 573 · 놓침  97 · 잉여 117  F1 84%   밀림  -9ms · IQR  7ms
  //
  //   밀림도 여기서 같이 사라진다. 93ms 창은 어택을 평균으로 뭉개면서 시각까지 39ms 앞으로
  //   당기고 있었다. 상수 보정을 넣을 뻔했는데, 원인은 창이었다.
  onsetWinMs: 20,
  onsetAdaptive: false, // 켜면 아래 두 값을 쓰고 onsetThresh 는 무시한다
  onsetK: 2.5,          // 국소 MAD 의 몇 배를 여유로 둘 것인가
  onsetFloor: 0.012,    // 무음 구간에서 MAD 가 0 이 되면 아무거나 잡히므로 바닥을 둔다
  minOnsetGapMs: 90,    // 어택 사이 최소 간격 (16분음표 @ 160BPM ≈ 94ms)
  // 같은 음정 병합(segment() 참고) 판단에서 "재타현"으로 칠 온셋의 최소 강도(margin =
  // flux 가 문턱을 넘은 양). 0 이면 문턱을 겨우 넘은 것도 재타현으로 쳐서 병합을 막는다
  // (예전 동작) — 분리 스템에서는 그게 노이즈 흔들림과 안 갈라져 진짜 한 음이 둘로 잘린다.
  mergeOnsetMargin: 0,
  // 손을 떼는 소리·앞 음의 잔향은 "주변보다 훨씬 작고 짧다".
  // 절대 세기로는 못 거른다 — 곡의 구간마다 음량이 다르기 때문.
  ghostRatio: 0.30,     // 주변 음 세기 중앙값의 이 비율 미만이면 의심
  ghostMaxMs: 260,      // 그러면서 이보다 짧으면 버린다
  ghostWindowSec: 3,    // 주변을 판단하는 창
  // 슬라이드·해머로 목표음에 닿는 도중의 경유음. 세기는 멀쩡해서 위 규칙에 안 걸린다.
  // 특징은 "아주 짧고, 곧바로 훨씬 긴 음이 따라온다".
  transMaxMs: 110,      // 경유음으로 볼 최대 길이
  transGapMs: 170,      // 다음 음까지의 간격
  transLongerX: 2.0,    // 다음 음이 이 배 이상 길면 목표음으로 본다
  // 슬라이드 — 손가락이 훑고 간 자리는 두 음 사이 음정에 남는다.
  techniques: true,     // 끄면 기호도, 같은 현 제약도 없다
  techMaxSemi: 12,      // 이보다 먼 도약은 검출 오류로 본다
  techMaxGapMs: 140,    // 앞 음이 끝나고 다음 음이 시작하기까지
  techMinVoiced: 0.8,   // 그 사이가 이만큼 이어져 울려야 한 번에 낸 소리다
  slideMinFrames: 2,    // 두 음 사이를 지나가는 중간 음정 프레임 수
  slideStepMaxMs: 140,  // 슬라이드 도중 잠깐 걸린 음의 최대 길이
  stepMaxSemi: 5,       // 중간 음정 없이 건너뛴 한 단계로 볼 최대 간격
  stepLoudMax: 0.85,    // 그 단계가 앞 음보다 이 비율 아래로 작아야 한다
  // 슬라이드로 이어진 음을 같은 현에 두려는 힘. 기본은 0 — 운지에 관여하지 않는다.
  //   3.0 으로 밀면 기호가 26개까지 늘지만 580음 중 135음의 현이 바뀌었다. 즉 기호 14개를
  //   얻으려고 운지를 지어낸 셈이고, 중간값(1~2)은 12프렛 이상 음이 기준보다도 늘어 더 나빴다.
  //   0 이면 원래 고를 운지가 마침 같은 현인 슬라이드 12개만 남고 배치는 전혀 흔들리지 않는다.
  sameStringPenalty: 0,
};

/** TAB 에 찍는 기호 */
export const TECH_GLYPH = { slideUp: '/', slideDown: '\\' };

/** [1,3,3,1]/8 저역통과 후 2배 데시메이션 */
function decimate2(src) {
  const n = ((src.length - 3) >> 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i * 2;
    out[i] = (src[j] + 3 * src[j + 1] + 3 * src[j + 2] + src[j + 3]) / 8;
  }
  return out;
}

/** 한 프레임의 YIN. 반환 { hz, conf } — conf 는 1 - CMND 최소값(0~1). */
function yinFrame(buf, off, N, sr, minLag, maxLag, rmsGate, scratch, fmin, OCT_RATIO, fmax, UP_RATIO, UP_H2) {
  const { win, d, cm } = scratch;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += buf[off + i];
  mean /= N;
  let rms = 0;
  for (let i = 0; i < N; i++) { const v = buf[off + i] - mean; win[i] = v; rms += v * v; }
  rms = Math.sqrt(rms / N);
  if (rms < rmsGate) return { hz: 0, conf: 0, rms };

  const W = N >> 1;
  const hi = Math.min(maxLag, W - 1);
  for (let tau = 1; tau <= hi; tau++) {
    let sum = 0;
    for (let i = 0; i < W; i++) { const diff = win[i] - win[i + tau]; sum += diff * diff; }
    d[tau] = sum;
  }
  let run = 0;
  for (let tau = 1; tau <= hi; tau++) { run += d[tau]; cm[tau] = run > 1e-12 ? d[tau] * tau / run : 1; }

  const TH = 0.15;
  let tau = -1;
  for (let t = minLag; t < hi; t++) {
    if (cm[t] < TH) { while (t + 1 <= hi && cm[t + 1] < cm[t]) t++; tau = t; break; }
  }
  if (tau < 0) {
    let m = 1e9;
    for (let t = minLag; t <= hi; t++) if (cm[t] < m) { m = cm[t]; tau = t; }
    if (tau < 0 || m > 0.5) return { hz: 0, conf: 0, rms };
  }
  // 5도 오검출 보정 — 기본파가 약한 저음은 실제 주기의 2/3 지점을 먼저 문다.
  // 정수배는 주기 신호라면 언제나 낮게 나오므로 후보로 삼지 않는다.
  const cand = Math.round(tau * 1.5);
  if (cand <= hi - 1 && cm[cand] < TH && cm[cand] <= cm[tau]) tau = cand;

  let better = tau;
  if (tau > 1 && tau < hi) {
    const s0 = cm[tau - 1], s1 = cm[tau], s2 = cm[tau + 1];
    const den = 2 * (2 * s1 - s2 - s0);
    if (Math.abs(den) > 1e-12) better = tau + (s2 - s0) / den;
  }
  let hz = sr / better;

  // 옥타브 확인.
  //   기본파가 약한 베이스는 YIN 이 절반 주기(=2배음)를 물기 쉽다. CMND 는 진짜 주기와
  //   절반 주기 모두에서 낮게 나오므로 그것만으로는 구분되지 않는다.
  //   그래서 한 옥타브 아래 성분이 실제로 있는지 스펙트럼에서 직접 재본다.
  //   진짜 그 음이면 아래 옥타브에는 에너지가 거의 없다.
  if (hz / 2 >= fmin) {
    const half = goertzel(win, N, hz / 2, sr);
    const full = goertzel(win, N, hz, sr);
    if (half > full * OCT_RATIO) hz /= 2;
  }

  // 위쪽 옥타브 확인.
  //   낮은 음이 울리는 중에 그 한 옥타브 위를 치면(디스코 옥타브 주법) 잔향의 주기가
  //   그대로 남아 있어 YIN 이 낮은 쪽을 문다. 위 검사는 아래로 접기만 해서 이것을 못 되돌린다.
  //   가르는 표는 3배음이다 — hz 가 진짜 기본파면 3배음이 서 있고,
  //   진짜가 2·hz 라면 3·hz 는 그것의 1.5배라 배음이 아니어서 비어 있다.
  //
  //   조건이 둘인 이유: 3배음만 보면 원래 배음이 약한 음(뮤트 톤 등)까지 올려버린다.
  //   진짜로 한 옥타브 위가 울리고 있다면 지금 hz 자리의 기본파가 죽어 있어야 한다.
  //
  //     실측(bass_sample_2)  진짜 58Hz  h1 1.00 · h2 0.66 · h3 0.43   h3/h2 0.65 · h2/h1 0.66
  //                          진짜 115Hz h1 0.11 · h2 1.00 · h3 0.00   h3/h2 0.00 · h2/h1 9.0
  if (hz * 2 <= fmax) {
    const h1 = goertzel(win, N, hz, sr);
    const h2 = goertzel(win, N, hz * 2, sr);
    const h3 = goertzel(win, N, hz * 3, sr);
    if (h3 < h2 * UP_RATIO && h2 > h1 * UP_H2) hz *= 2;
  }
  return { hz, conf: Math.max(0, 1 - cm[tau]), rms };
}

/** 한 주파수의 진폭만 재는 Goertzel — FFT 없이 두어 개만 볼 때 싸다. */
function goertzel(buf, n, freq, sr) {
  const w = 2 * Math.PI * freq / sr;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = buf[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2)) / n;
}

const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

/**
 * pYIN 식 다중 후보. yinFrame() 은 CMND 국소최소 하나를 그 자리에서 확정하고(5도·옥타브
 * 보정까지 전부 그 프레임만 보고 결정) 다음 단계로 넘긴다 — 그 프레임의 잡음이 그대로
 * 결정이 된다. 여기서는 후보를 최대 K 개까지 남겨 두고, 옥타브 위·아래 대안도 결정하지
 * 않은 채 후보로만 얹는다. 어느 게 맞는지는 pyinViterbi() 가 앞뒤 프레임 흐름을 보고
 * 고른다 — sepattack.html 로 다섯 가지 특징을 다 재봐도 "한 프레임만 보고" 가르는 방법이
 * 안 통했던 것과 같은 이유로, 결정을 뒤로 미루는 쪽을 택했다.
 * @returns {{ cands: {hz:number, w:number}[], rms: number }}
 */
function pyinFrameCandidates(buf, off, N, sr, minLag, maxLag, rmsGate, scratch, fmax, K) {
  const { win, d, cm } = scratch;
  let mean = 0;
  for (let i = 0; i < N; i++) mean += buf[off + i];
  mean /= N;
  let rms = 0;
  for (let i = 0; i < N; i++) { const v = buf[off + i] - mean; win[i] = v; rms += v * v; }
  rms = Math.sqrt(rms / N);
  if (rms < rmsGate) return { cands: [], rms };

  const W = N >> 1;
  const hi = Math.min(maxLag, W - 1);
  for (let tau = 1; tau <= hi; tau++) {
    let sum = 0;
    for (let i = 0; i < W; i++) { const diff = win[i] - win[i + tau]; sum += diff * diff; }
    d[tau] = sum;
  }
  let run = 0;
  for (let tau = 1; tau <= hi; tau++) { run += d[tau]; cm[tau] = run > 1e-12 ? d[tau] * tau / run : 1; }

  const mins = [];
  for (let t = Math.max(minLag, 2); t < hi; t++) {
    if (cm[t] < cm[t - 1] && cm[t] <= cm[t + 1] && cm[t] < 0.9) mins.push(t);
  }
  if (!mins.length) return { cands: [], rms };
  mins.sort((a, b) => cm[a] - cm[b]);

  const cands = [];
  for (const tau of mins.slice(0, K)) {
    let better = tau;
    if (tau > 1 && tau < hi) {
      const s0 = cm[tau - 1], s1 = cm[tau], s2 = cm[tau + 1];
      const den = 2 * (2 * s1 - s2 - s0);
      if (Math.abs(den) > 1e-12) better = tau + (s2 - s0) / den;
    }
    const hz = sr / better;
    const w = Math.max(1e-3, 1 - cm[tau]);
    cands.push({ hz, w });
    // 옥타브 위·아래 대안 — yinFrame() 처럼 스펙트럼을 재서 여기서 확정하지 않는다.
    // 낮게 얹어 두고, 실제로 맞다면 앞뒤 프레임에서 같은 대안이 반복될 것이므로
    // Viterbi 의 매끄러운-경로 선호가 자연히 골라낸다.
    if (hz / 2 >= 20) cands.push({ hz: hz / 2, w: w * 0.5 });
    if (hz * 2 <= fmax * 1.5) cands.push({ hz: hz * 2, w: w * 0.5 });
  }
  return { cands, rms };
}

/**
 * 후보 목록(프레임별)에 대해 전체 곡 최적 피치 경로를 Viterbi 로 찾는다. 상태는 반음을
 * BINS_PER_SEMI 등분한 격자 + 무성음 하나. "확률"이 아니라 비용(작을수록 좋음)으로
 * 잰다 — assignFrets() 의 DP 와 같은 관용구다.
 * @returns {Float64Array} 프레임별 MIDI (무성음은 0)
 */
function pyinViterbi(frameCands, midiMin, midiMax, opts) {
  const BINS_PER_SEMI = 5;                              // 0.2반음 — segment() 는 반음 반올림만 쓴다
  const nBins = Math.max(1, Math.round((midiMax - midiMin) * BINS_PER_SEMI));
  const UNVOICED = nBins;
  const nStates = nBins + 1;
  const binMidi = (b) => midiMin + b / BINS_PER_SEMI;

  const SIGMA = 0.12;                                   // 후보 하나가 근처 bin 에 퍼지는 폭(반음)
  const NEAR_BAND = Math.max(1, Math.round(1.5 * BINS_PER_SEMI));   // ±1.5반음 = "미끄러짐"
  const NEAR_COST = opts.pyinNearCost != null ? opts.pyinNearCost : 0.15;
  const JUMP_COST = opts.pyinJumpCost != null ? opts.pyinJumpCost : 3.0;     // 새 음 도약
  const V2U = opts.pyinV2U != null ? opts.pyinV2U : 1.0;                    // 유성 → 무성
  const U2V = opts.pyinU2V != null ? opts.pyinU2V : 1.5;                    // 무성 → 유성
  const UNVOICED_EMIT = opts.pyinUnvoicedEmit != null ? opts.pyinUnvoicedEmit : 1.2;

  const n = frameCands.length;

  // 프레임마다 매 bin(최대 280개)에서 emitCost 를 부르고 그 안에서 후보마다 hzToMidi 를
  // 다시 재는 최초 버전은 실제 곡(210초 · 프레임 18000개대)에서 30분을 넘겨도 안 끝났다
  // — bin 과 무관한 hzToMidi(c.hz) 를 bin 수(280)만큼 매번 다시 계산하고 있었다. 후보의
  // midi 값은 프레임당 한 번만 구해 두고, cur/backtrack 버퍼도 프레임마다 새로 만들지
  // 않고 미리 잡아 둔 자리를 재사용한다(스크래치 버퍼 관용구 — yinFrame() 의 scratch 와 같다).
  let prev = new Float64Array(nStates);
  let cur = new Float64Array(nStates);
  const backtrack = new Int32Array(n * nStates);
  const maxCands = Math.max(9, (opts.pyinCandidates || 3) * 3);   // 후보 1개당 옥타브 위·아래 대안 2개
  const candMidi = new Float64Array(maxCands), candW = new Float64Array(maxCands);

  for (let i = 0; i < n; i++) {
    const cands = frameCands[i];
    const nc = Math.min(cands.length, candMidi.length);
    for (let c = 0; c < nc; c++) { candMidi[c] = hzToMidi(cands[c].hz); candW[c] = cands[c].w; }

    // "어디서든 도약" 비용을 프레임당 O(states) 로 계산하려고 이전 프레임 전체의
    // 최솟값을 미리 구해 둔다 — 매 bin 마다 O(states) 로 다시 훑지 않는다.
    let bestPrev = Infinity, bestPrevIdx = -1;
    for (let s = 0; s < nStates; s++) if (prev[s] < bestPrev) { bestPrev = prev[s]; bestPrevIdx = s; }
    const jumpTotal = bestPrev + JUMP_COST;
    const rowOff = i * nStates;

    for (let b = 0; b < nBins; b++) {
      let best = Infinity, bestFrom = -1;
      const lo = Math.max(0, b - NEAR_BAND), hiB = Math.min(nBins - 1, b + NEAR_BAND);
      for (let s = lo; s <= hiB; s++) {
        const total = prev[s] + NEAR_COST * Math.abs(s - b);
        if (total < best) { best = total; bestFrom = s; }
      }
      { const total = prev[UNVOICED] + U2V; if (total < best) { best = total; bestFrom = UNVOICED; } }
      if (jumpTotal < best) { best = jumpTotal; bestFrom = bestPrevIdx; }

      const m = midiMin + b / BINS_PER_SEMI;
      let mass = 1e-4;
      for (let c = 0; c < nc; c++) {
        const dm = (candMidi[c] - m) / SIGMA;
        mass += candW[c] * Math.exp(-0.5 * dm * dm);
      }
      cur[b] = best - Math.log(mass);
      backtrack[rowOff + b] = bestFrom;
    }
    {
      let best = prev[UNVOICED], bestFrom = UNVOICED;
      for (let s = 0; s < nBins; s++) {
        const total = prev[s] + V2U;
        if (total < best) { best = total; bestFrom = s; }
      }
      cur[UNVOICED] = best + UNVOICED_EMIT;
      backtrack[rowOff + UNVOICED] = bestFrom;
    }

    const tmp = prev; prev = cur; cur = tmp;   // 다음 프레임을 위해 버퍼만 맞바꾼다(재할당 없음)
  }

  let bestEnd = 0, bestCost = Infinity;
  for (let s = 0; s < nStates; s++) if (prev[s] < bestCost) { bestCost = prev[s]; bestEnd = s; }
  const path = new Int32Array(n);
  let s = bestEnd;
  for (let i = n - 1; i >= 0; i--) { path[i] = s; s = backtrack[i * nStates + s]; }

  const midis = new Float64Array(n);
  for (let i = 0; i < n; i++) midis[i] = path[i] === UNVOICED ? 0 : binMidi(path[i]);
  return midis;
}

/** 홀수 길이 중앙값 필터 (0 은 무음이라 건너뛴다) */
function medianSmooth(arr, k) {
  const half = k >> 1;
  const out = new Float64Array(arr.length);
  const buf = [];
  for (let i = 0; i < arr.length; i++) {
    buf.length = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= arr.length) continue;
      if (arr[j] > 0) buf.push(arr[j]);
    }
    if (!buf.length) { out[i] = 0; continue; }
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

/**
 * 에너지가 솟는 지점(어택)을 찾는다.
 * 같은 음을 두 번 연달아 튕기면 음정이 바뀌지 않으므로, 피치만 보면 한 음으로 붙어버린다.
 * @returns {{ onset: Uint8Array, margin: Float64Array }} 프레임별 온셋 여부 · 그 지점에서
 *   문턱을 얼마나 넘었는지(flux - bar, 온셋이 아닌 프레임은 0). segment() 가 "같은 음 다시
 *   병합" 판단에서 애매한(문턱을 겨우 넘은) 온셋과 뚜렷한 온셋을 가르는 데 쓴다 —
 *   분리 스템의 잡음이 만드는 흔들림은 대개 문턱을 살짝만 넘는다(sepattack.html 실측).
 */
function detectOnsets(fluxSrc, hopSec, opts, gateArr) {
  const n = fluxSrc.length;
  const gate = gateArr || fluxSrc;
  const onset = new Uint8Array(n);
  const margin = new Float64Array(n);
  if (n < 3) return { onset, margin };

  // 로그 에너지의 상승분만 취한다 (감쇠는 무시)
  const flux = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    const a = Math.log(fluxSrc[i] + 1e-9), b = Math.log(fluxSrc[i - 1] + 1e-9);
    flux[i] = Math.max(0, a - b);
  }
  // 국소 평균 대비 튀는 지점만 남긴다 — 곡 전체 음량에 좌우되지 않는다
  const win = Math.max(3, Math.round(0.12 / hopSec));
  const minGap = Math.max(1, Math.round(opts.minOnsetGapMs / 1000 / hopSec));
  const buf = [];
  let last = -minGap;
  for (let i = 1; i < n; i++) {
    const lo = Math.max(1, i - win), hi = Math.min(n - 1, i + win);

    let bar;
    if (opts.onsetAdaptive) {
      // 빼야 할 것은 "이 근처에서 flux 가 평소 얼마나 흔들리는가" 다.
      // 고정 여유값 하나는 조용한 구간에서 너무 크고(음을 버린다) 지저분한 구간에서 너무 작다
      // (아티팩트를 줍는다). 분리 스템은 구간마다 잡음 바닥이 달라 그 차이가 크게 벌어진다.
      // 중앙값과 MAD 는 온셋 봉우리 자체에 끌려가지 않아 이 자리에 맞다.
      buf.length = 0;
      for (let j = lo; j <= hi; j++) buf.push(flux[j]);
      buf.sort((a, b) => a - b);
      const med = buf[buf.length >> 1];
      for (let k = 0; k < buf.length; k++) buf[k] = Math.abs(buf[k] - med);
      buf.sort((a, b) => a - b);
      bar = Math.max(opts.onsetFloor, med + opts.onsetK * buf[buf.length >> 1]);
    } else {
      let sum = 0, cnt = 0;
      for (let j = lo; j <= hi; j++) { sum += flux[j]; cnt++; }
      bar = (cnt ? sum / cnt : 0) + opts.onsetThresh;
    }

    const isPeak = flux[i] > flux[i - 1] && flux[i] >= (flux[i + 1] || 0);
    if (isPeak && flux[i] > bar && gate[i] > opts.rmsGate && i - last >= minGap) {
      onset[i] = 1; margin[i] = flux[i] - bar; last = i;
    }
  }
  return { onset, margin };
}

/**
 * 프레임 피치열 → 노트 목록.
 * 같은 반음이 이어지는 구간을 하나의 노트로 묶되, 어택이 있으면 거기서 끊는다.
 */
function segment(midis, confs, hopSec, opts, onsets, rmss, lowRatios, onsetMargin) {
  const notes = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const dur = cur.end - cur.start;
    if (dur * 1000 >= opts.minNoteMs && cur.n > 0) {
      cur.frames.sort((a, b) => a - b);
      const med = cur.frames[cur.frames.length >> 1];
      notes.push({
        start: cur.start,
        dur,
        midi: Math.round(med),
        cents: Math.round((med - Math.round(med)) * 100),
        conf: cur.confSum / cur.n,
        rms: cur.rmsSum / cur.n,
        low: cur.lowSum / cur.n,     // 저역 에너지 비율 — 누수 판별용
      });
    }
    cur = null;
  };

  for (let i = 0; i < midis.length; i++) {
    const m = midis[i];
    const t = i * hopSec;
    if (!(m > 0)) { flush(); continue; }
    const semi = Math.round(m);
    if (onsets && onsets[i] && cur) flush();     // 어택이면 같은 음이라도 새 노트
    if (cur && Math.abs(semi - cur.semi) === 0) {
      cur.end = t + hopSec;
      cur.frames.push(m);
      cur.confSum += confs[i]; cur.rmsSum += rmss[i]; cur.lowSum += lowRatios[i]; cur.n++;
    } else {
      flush();
      cur = { semi, start: t, end: t + hopSec, frames: [m],
              confSum: confs[i], rmsSum: rmss[i], lowSum: lowRatios[i], n: 1 };
    }
  }
  flush();

  // 같은 음이 짧게 끊긴 경우 잇는다 (검출이 한두 프레임 비는 일이 흔하다).
  // 단, 사이에 "뚜렷한" 어택이 있으면 잇지 않는다 — 같은 음을 다시 튕긴 것이다.
  //
  // "뚜렷한"을 문턱을 겨우 넘은 것까지 포함해 아무 온셋으로나 판단하면(예전 동작,
  // mergeOnsetMargin=0) 분리 스템의 잡음 흔들림도 재타현으로 오인해 진짜 한 음을 둘로
  // 쪼갠다 — sepattack.html 실측: 실제 분리 조건에서 이렇게 쪼개진 게 "잉여" 91개 중
  // 59개(65%)였고, 그중 78%는 45ms 이내라 원래 이 병합에 걸렸어야 했다. margin(=flux가
  // 문턱을 넘은 양)이 opts.mergeOnsetMargin 을 넘어야만 "진짜 재타현"으로 본다.
  const onsetAt = (t0, t1) => {
    if (!onsets) return false;
    const a = Math.max(0, Math.ceil(t0 / hopSec)), b = Math.min(onsets.length - 1, Math.floor(t1 / hopSec));
    if (onsetMargin) {
      for (let i = a; i <= b; i++) if (onsetMargin[i] > opts.mergeOnsetMargin) return true;
      return false;
    }
    for (let i = a; i <= b; i++) if (onsets[i]) return true;
    return false;
  };
  const merged = [];
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    const prevEnd = prev ? prev.start + prev.dur : 0;
    if (prev && prev.midi === n.midi && (n.start - prevEnd) * 1000 <= opts.gapMs && !onsetAt(prevEnd, n.start)) {
      prev.dur = n.start + n.dur - prev.start;
      prev.conf = (prev.conf + n.conf) / 2;
    } else merged.push({ ...n });
  }
  return merged;
}

/**
 * 손 떼는 소리·앞 음의 잔향 걸러내기.
 * 이런 것들은 "주변 음보다 훨씬 작으면서 짧다"는 성질을 같이 가진다.
 * 세기만 보면 조용한 구간의 진짜 음까지 날아가므로, 주변 창의 중앙값과 비교한다.
 */
function dropGhosts(notes, opts) {
  if (notes.length < 3) return notes;
  const W = opts.ghostWindowSec;
  const out = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const near = [];
    for (let j = 0; j < notes.length; j++) {
      if (j === i) continue;
      if (Math.abs(notes[j].start - n.start) <= W) near.push(notes[j].rms);
    }
    // 경유음 — 아주 짧은데 곧바로 훨씬 긴 음이 따라오면 그쪽이 목표음이다.
    // 빠른 16분음표 연속은 다음 음도 짧으므로 여기 걸리지 않는다.
    const nx = notes[i + 1];
    if (nx
        && n.dur * 1000 <= opts.transMaxMs
        && (nx.start - n.start) * 1000 <= opts.transGapMs
        && nx.dur >= n.dur * opts.transLongerX) continue;

    if (!near.length) { out.push(n); continue; }
    near.sort((a, b) => a - b);
    const med = near[near.length >> 1];
    const quiet = med > 0 && n.rms < med * opts.ghostRatio;
    const short = n.dur * 1000 < opts.ghostMaxMs;
    if (quiet && short) continue;
    out.push(n);
  }
  return out;
}

/**
 * 슬라이드 찾기.
 *
 * 근거는 **두 음 사이에 중간 음정이 실제로 찍혔는가** 다. 손가락이 지판을 훑고 가면
 * 그 경로가 피치에 남는다. 다시 뜯은 음은 그 사이가 비어 있다.
 *
 * 해머온·풀오프도 한때 같이 찾았지만 뺐다. 그쪽 근거는 "어택이 없다"는 부재뿐인데,
 * 분리 스템은 온셋이 전체 음의 24% 에서만 잡혀 그 부재가 아무것도 말해주지 않는다.
 * 세기 조건을 더해도 결과가 미덥지 않아 노트 자리만 흔들었다.
 *
 * @param {Array} notes
 * @param {{midis:Float64Array, onsets:Uint8Array, rmss:Float64Array, hopSec:number}} ctx 프레임 단위 원자료
 */
function detectTechniques(notes, ctx, opts) {
  const { midis, onsets, rmss, hopSec } = ctx;
  if (notes.length < 2) return notes;
  const fr = (t) => Math.round(t / hopSec);
  const onsetNear = (f) => {
    for (let i = f - 1; i <= f + 1; i++) if (i >= 0 && i < onsets.length && onsets[i]) return true;
    return false;
  };
  /** 음이 시작하고 ms 동안의 최대 세기 — 뜯은 소리인지 짚어서 낸 소리인지 가른다 */
  const attackRms = (n, ms) => {
    const a = fr(n.start), b = a + Math.max(1, Math.round(ms / 1000 / hopSec));
    let peak = 0;
    for (let f = a; f <= b && f < rmss.length; f++) if (rmss[f] > peak) peak = rmss[f];
    return peak;
  };

  const out = notes.map(n => ({ ...n, attacked: onsetNear(fr(n.start)) }));
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1], b = out[i];
    const d = b.midi - a.midi;
    const ad = Math.abs(d);
    if (!ad || ad > opts.techMaxSemi) continue;

    const gapMs = (b.start - (a.start + a.dur)) * 1000;
    if (gapMs > opts.techMaxGapMs || gapMs < -20) continue;
    const bf = fr(b.start);
    if (b.attacked) continue;                          // 다시 뜯었다

    // 앞 음 끝에서 다음 음 시작까지의 음정 경로
    const f0 = Math.max(0, fr(a.start + a.dur) - 1);
    let total = 0, voiced = 0, between = 0;
    const lo = Math.min(a.midi, b.midi) + 0.4, hi = Math.max(a.midi, b.midi) - 0.4;
    for (let f = f0; f <= bf && f < midis.length; f++) {
      total++;
      const m = midis[f];
      if (m > 0) voiced++;
      if (m > lo && m < hi) between++;
    }
    if (total && voiced < total * opts.techMinVoiced) continue;

    if (between >= opts.slideMinFrames) {
      b.tech = d > 0 ? 'slideUp' : 'slideDown';         // 중간 음정을 밟고 갔다
      continue;
    }
    // 중간 음정을 밟지 않은 한 단계 이동. 이것만으로는 기호를 달지 않는다 —
    // 천천히 미끄러질 때 이런 단계가 같은 방향으로 줄줄이 이어지고, 그때만 아래에서 합친다.
    if (ad <= opts.stepMaxSemi && attackRms(b, 40) <= attackRms(a, 40) * opts.stepLoudMax) {
      b.step = d > 0 ? 1 : -1;
    }
  }

  // 천천히 미끄러지면 중간 음정이 한 음으로 잡힐 만큼 오래 머문다. 그러면 위에서
  // 짧은 단계가 여러 번 이어진 것처럼 보인다 — 같은 방향으로 연달아 붙었고
  // 중간 음이 짧으면 하나의 슬라이드로 합친다. 단계가 하나뿐이면 기호를 달지 않는다.
  const keep = new Array(out.length).fill(true);
  for (let i = 1; i < out.length; i++) {
    const dir = out[i].step || 0;
    if (!dir) continue;
    let j = i;
    while (j + 1 < out.length
           && out[j + 1].step === dir
           && out[j].dur * 1000 <= opts.slideStepMaxMs) j++;
    if (j === i) continue;
    for (let k = i; k < j; k++) keep[k] = false;       // 중간 경유음은 지운다
    const end = out[j].start + out[j].dur;
    out[j].tech = dir > 0 ? 'slideUp' : 'slideDown';
    out[j].start = out[i - 1].start + out[i - 1].dur;  // 앞 음이 끝나자마자 미끄러진다
    out[j].dur = Math.max(0.05, end - out[j].start);
    i = j;
  }
  const res = out.filter((_, i) => keep[i]);
  for (const n of res) delete n.step;
  return res;
}

/**
 * 지판 배치. 각 노트마다 (현, 프렛) 후보를 만들고 DP 로 손 이동이 적은 경로를 고른다.
 * 그리디로 하면 한 번 잘못 든 자리가 끝까지 따라온다.
 */
export function assignFrets(notes, tuningId, maxFret, sameStringPenalty, tune) {
  const T = tune || {};        // 가중치 실험용 — 실사용 경로에서는 비어 있다
  const tuning = TUNINGS[tuningId] || TUNINGS[DEFAULTS.tuning];
  const open = tuning.strings;                      // 낮은 현 → 높은 현
  const cands = notes.map(n => {
    const list = [];
    for (let s = 0; s < open.length; s++) {
      const fret = n.midi - open[s];
      if (fret >= 0 && fret <= maxFret) list.push({ string: s, fret });
    }
    return list;
  });

  // 사람 손 기준 비용.
  //   베이스는 한 손가락 한 프렛(4프렛 span)으로 짚고, 손을 옮기는 것(포지션 이동)이
  //   현을 건너뛰는 것보다 훨씬 부담이 크다. 예전 가중치는 그 반대라서
  //   한 현에 눌러앉아 17프렛까지 기어올라갔다.
  const SHIFT_FIXED = 1.4;   // 손을 옮기는 행위 자체의 비용
  const SHIFT_PER   = 0.45;  // 옮기는 거리(프렛)당
  const SPAN        = 4;     // 손이 한 번에 덮는 프렛 수
  const IN_SPAN     = 0.15;  // span 안에서의 손가락 이동은 싸다
  // 현 이동 — 오른손 문제라 왼손 이동보다 가볍다. 다만 방향에 따라 값이 다르다.
  //   베이스는 굵은 현이 소리로 유리하므로 아래로 내려가는 것은 이득 쪽이고,
  //   얇은 현으로 올라가는 것은 손해 쪽이다. 같은 값을 주면 "웬만하면 저음현"이
  //   성립하지 못한다 — 내려가는 비용(0.3)이 저음현 보너스(0.18)보다 커서
  //   공짜일 때만 내려가게 된다. 실제로 같은 G3 가 1현12 와 2현17 을 오갔고
  //   그 차이는 0.07 이었다.
  const STRING_DOWN = T.stringDown != null ? T.stringDown : 0.12;   // 굵은 현 쪽으로
  const STRING_UP   = T.stringUp != null ? T.stringUp : 0.32;       // 얇은 현 쪽으로
  const OPEN_BONUS  = 0.25;  // 개방현
  // 낮은 프렛 선호. 프렛마다 같은 값을 매기면 안 된다 —
  //   5프렛과 7프렛의 차이는 사람에게 거의 없고, 12프렛과 17프렛의 차이는 크다.
  //   그래서 편한 자리(COMFY) 까지는 아주 약하게, 그 위로는 가파르게 올린다.
  //   전에는 프렛당 0.02 하나였고, 그 값이 아래 LOW_STRING(0.50) 에 눌려
  //   A2 를 A현 12(0.74) 대신 E현 17(0.34) 에 놓았다. 손이 17프렛까지 기어올라갔다.
  const POS_COST    = T.posCost  != null ? T.posCost  : 0.02;
  const COMFY       = T.comfy    != null ? T.comfy    : 7;
  const HIGH_RATE   = T.highRate != null ? T.highRate : 0.10;   // COMFY 초과 프렛당
  // 같은 음이면 굵은 현을 택한다 — 베이스는 그쪽이 소리로 유리하다. 다만 이것은
  //   비슷한 자리들 사이의 가름말이지 프렛 높이를 이겨서는 안 된다.
  const LOW_STRING  = T.lowString != null ? T.lowString : 0.12;
  const HIGH_FRET   = 19;    // 이 위는 실제로 드물다
  const HIGH_PEN    = 1.2;
  // 슬라이드는 한 현 위에서만 성립한다. 금지가 아니라 벌점으로 둔다 —
  // 검출이 틀렸을 때 경로 자체가 막히면 그 구간 전체가 풀리지 않는다.
  const SAME_STRING = sameStringPenalty != null ? sameStringPenalty : DEFAULTS.sameStringPenalty;

  const linked = notes.map(n => !!n.tech);

  const out = new Array(notes.length).fill(null);

  // 후보가 없는 음(음역 밖 = 대개 오검출)에서 구간을 끊고, 구간마다 따로 DP 를 돌린다.
  // 한 줄로 이으면 그런 음 하나가 앞쪽 전부를 못 풀게 만든다.
  let s = 0;
  while (s < notes.length) {
    if (!cands[s].length) { s++; continue; }
    let e = s;
    while (e + 1 < notes.length && cands[e + 1].length) e++;

    const dp = [];
    for (let i = s; i <= e; i++) {
      const row = cands[i].map(c => {
        const emit = c.fret * POS_COST
                   + Math.max(0, c.fret - COMFY) * HIGH_RATE
                   - (c.fret === 0 ? OPEN_BONUS : 0)
                   + c.string * LOW_STRING
                   + (c.fret > HIGH_FRET ? HIGH_PEN : 0);
        // 개방현은 손을 움직이지 않으므로 직전 손 위치를 그대로 물려받는다
        const anchor = c.fret === 0 ? -1 : c.fret;
        if (i === s) return { ...c, cost: emit, prev: -1, hand: anchor };

        const prevRow = dp[i - 1 - s];
        let best = Infinity, bestIdx = -1, bestHand = anchor;
        for (let k = 0; k < prevRow.length; k++) {
          const p = prevRow[k];
          const ph = p.hand;                       // 직전에 손이 있던 프렛 (-1 = 아직 모름)
          const ds = c.string - p.string;
          let move = (ds < 0 ? STRING_DOWN : STRING_UP) * Math.abs(ds);
          if (linked[i] && c.string !== p.string) move += SAME_STRING;
          let hand = anchor;
          if (c.fret === 0) {
            hand = ph;                             // 개방현 — 손은 그대로
          } else if (ph < 0) {
            hand = c.fret;                         // 첫 짚는 음
          } else if (Math.abs(c.fret - ph) < SPAN) {
            move += IN_SPAN * Math.abs(c.fret - ph);   // 같은 자리 안에서 손가락만
            hand = ph;
          } else {
            const d = Math.abs(c.fret - ph);
            move += SHIFT_FIXED + SHIFT_PER * d;   // 포지션 이동
            hand = c.fret;
          }
          const total = p.cost + move;
          if (total < best) { best = total; bestIdx = k; bestHand = hand; }
        }
        return { ...c, cost: best + emit, prev: bestIdx, hand: bestHand };
      });
      dp.push(row);
    }

    let idx = 0, best = Infinity;
    dp[dp.length - 1].forEach((c, k) => { if (c.cost < best) { best = c.cost; idx = k; } });
    for (let i = e; i >= s; i--) {
      const c = dp[i - s][idx];
      out[i] = { string: c.string, fret: c.fret };
      idx = c.prev;
      if (idx < 0) break;
    }
    s = e + 1;
  }

  const placed = notes.map((n, k) => ({ ...n, string: out[k] ? out[k].string : null, fret: out[k] ? out[k].fret : null }));

  // 배치가 끝나야 그 기호를 실제로 연주할 수 있는지 알 수 있다. 못 하는 것은 지운다.
  //   · 같은 현 위가 아니면 미끄러질 수 없다
  //   · 양쪽 다 짚은 음이어야 한다 — 개방현은 미끄러뜨릴 손가락이 없다
  for (let i = 0; i < placed.length; i++) {
    const n = placed[i], p = placed[i - 1];
    if (!n.tech) continue;
    if (!p || n.string == null || p.string == null || n.string !== p.string
        || n.fret === 0 || p.fret === 0) delete n.tech;
  }
  return placed;
}

/**
 * 채보 본체.
 * @param {Float32Array} mono  베이스 스템 (모노)
 * @param {number} sampleRate
 * @param {object} [options]
 * @param {(pct:number)=>void} [onProgress]
 * @returns {{ notes: Array, tuning: string, sampleRate: number, hopSec: number }}
 */
export function transcribe(mono, sampleRate, options, onProgress) {
  const opts = { ...DEFAULTS, ...(options || {}) };

  // 22kHz 근처까지 낮춘다 — 베이스 음역엔 충분하고 연산이 1/4 로 준다
  let sig = mono, sr = sampleRate;
  while (sr > 30000) { sig = decimate2(sig); sr = sr / 2; }

  const N = 2048;                                     // 약 93ms @22.05k
  const hop = Math.max(64, Math.round(sr * opts.hopMs / 1000));
  const minLag = Math.max(2, Math.floor(sr / opts.fmax));
  const maxLag = Math.min((N >> 1) - 1, Math.ceil(sr / opts.fmin));
  const frames = Math.max(0, Math.floor((sig.length - N) / hop));
  if (frames < 2) return { notes: [], tuning: opts.tuning, sampleRate: sr, hopSec: hop / sr };

  const scratch = {
    win: new Float64Array(N),
    d: new Float64Array(maxLag + 2),
    cm: new Float64Array(maxLag + 2).fill(1),
  };

  // 저역만 남긴 사본. 프레임마다 (저역 세기 / 전체 세기) 를 재두면
  // 다른 악기가 스템에 새어 들어온 구간을 가려낼 수 있다 — 베이스는 저역에 에너지가 몰린다.
  const lp = new Float32Array(sig.length);
  {
    const a = Math.exp(-2 * Math.PI * 250 / sr);   // 1극 저역통과 250Hz
    let y = 0;
    for (let i = 0; i < sig.length; i++) { y = (1 - a) * sig[i] + a * y; lp[i] = y; }
  }

  const rawMidi = new Float64Array(frames);
  const confs = new Float64Array(frames);
  const rmss = new Float64Array(frames);
  const lows = new Float64Array(frames);
  const usePyin = opts.pitchTracker === 'pyin';
  const frameCands = usePyin ? new Array(frames) : null;
  // 온셋용 에너지는 따로 짧은 창으로 잰다.
  //
  // 피치 창(N=2048 ≈ 93ms)은 저음의 한 주기를 담으려고 그만큼 긴 것인데, 어택은 5~20ms 짜리
  // 사건이다. 그 창으로 잰 에너지에서는 상승이 평균에 묻혀, 150ms 간격 반복 타현이
  // 신호에 뚜렷이 있어도(20ms 창 에너지비 중앙값 1.66) flux 에 봉우리가 서지 않는다.
  const onN = Math.max(32, Math.round(sr * opts.onsetWinMs / 1000));
  const onsetRms = new Float64Array(frames);
  let lastPct = -1;
  for (let f = 0; f < frames; f++) {
    let rms;
    if (usePyin) {
      const { cands, rms: r } = pyinFrameCandidates(sig, f * hop, N, sr, minLag, maxLag, opts.rmsGate, scratch, opts.fmax, opts.pyinCandidates);
      frameCands[f] = cands;
      rms = r;
      confs[f] = cands.length ? cands[0].w : 0;   // Viterbi 가 실제 경로를 고르므로 여기 conf 는 참고값
    } else {
      const { hz, conf, rms: r } = yinFrame(sig, f * hop, N, sr, minLag, maxLag, opts.rmsGate, scratch,
                                         opts.fmin, opts.octRatio, opts.fmax, opts.octUpRatio, opts.octUpH2);
      rawMidi[f] = hz > 0 ? hzToMidi(hz) : 0;
      confs[f] = conf;
      rms = r;
    }
    rmss[f] = rms || 0;
    { // 저역 비율
      let lo = 0, all = 0;
      for (let i = 0, o = f * hop; i < N; i++) { const a = lp[o + i], b = sig[o + i]; lo += a * a; all += b * b; }
      lows[f] = all > 1e-12 ? Math.sqrt(lo / all) : 0;
    }
    { // 온셋용 짧은 창 에너지 — 프레임 시작부터 onN 샘플
      let e = 0;
      const o = f * hop, end = Math.min(sig.length, o + onN);
      for (let i = o; i < end; i++) e += sig[i] * sig[i];
      onsetRms[f] = Math.sqrt(e / Math.max(1, end - o));
    }
    if (onProgress) {
      const pct = Math.floor((f / frames) * 45);   // pyin 은 뒤에 Viterbi 단계가 더 있다 — 앞절반만
      if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
    }
  }

  // pYIN 경로는 Viterbi 가 이미 전체 흐름을 보고 매끄러운 경로를 고르므로 중앙값 평활이
  // 더 필요 없다 — 오히려 빠른 진짜 변화까지 뭉갤 수 있어 여기서는 건너뛴다.
  let smooth;
  if (usePyin) {
    if (onProgress) onProgress(50);
    smooth = pyinViterbi(frameCands, hzToMidi(opts.fmin), hzToMidi(opts.fmax), opts);
    if (onProgress) onProgress(95);
  } else {
    smooth = medianSmooth(rawMidi, 5);
  }
  const hopSec = hop / sr;
  const withFrets = finishFromPitchTrack(smooth, confs, rmss, lows, onsetRms, hopSec, opts);
  if (onProgress) onProgress(100);
  return { notes: withFrets, tuning: opts.tuning, sampleRate: sr, hopSec };
}

/**
 * 피치 추정이 끝난 뒤의 공통 꼬리 — 온셋 검출 → 분절 → 유령음 제거 → 테크닉 → 격자 → 운지.
 * transcribe() 의 YIN/pYIN 경로와 transcribeCrepe() 의 CREPE 경로가 여기서 합류한다.
 * 피치 추정 방식이 무엇이었든 이 아래는 완전히 같은 코드를 탄다.
 */
function finishFromPitchTrack(smooth, confs, rmss, lows, onsetRms, hopSec, opts) {
  const { onset: onsets, margin: onsetMargin } = detectOnsets(opts.onsetWinMs > 0 ? onsetRms : rmss, hopSec, opts, rmss);
  let notes = dropGhosts(segment(smooth, confs, hopSec, opts, onsets, rmss, lows, onsetMargin), opts);
  // 테크닉은 프레임 시각 그대로일 때 판별한다 — 격자에 붙이고 나면 사이의 경로가 흐려진다
  if (opts.techniques) notes = detectTechniques(notes, { midis: smooth, onsets, rmss, hopSec }, opts);
  // 박 정보가 있으면 격자에 붙인다 (드럼 스템에서 얻는다)
  if (opts.beats && opts.beats.length > 1) notes = quantizeToGrid(notes, opts.beats, opts.subdiv || 4);
  return assignFrets(notes, opts.tuning, opts.maxFret, opts.sameStringPenalty, opts.tune);
}

/**
 * CREPE(marl/crepe, MIT) 360bin 살리언스에서 상위 K 개 국소 피크를 뽑아 (hz,weight) 후보로 —
 * pyinFrameCandidates() 가 만드는 것과 같은 모양이라 pyinViterbi() 를 그대로 재사용한다.
 * cents→Hz 변환은 marl/crepe 의 to_local_average_cents/predict 와 동일한 공식이다
 * (cents_mapping = linspace(0,7180,360) + 1997.3794084376191, hz = 10 * 2**(cents/1200)).
 */
function topKCandidatesFromSalience(salience, cents0, centsStep, K, fmin, fmax) {
  const n = salience.length;
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (salience[i] > salience[i - 1] && salience[i] >= salience[i + 1] && salience[i] > 0.05) peaks.push(i);
  }
  if (!peaks.length) return [];
  peaks.sort((a, b) => salience[b] - salience[a]);

  const out = [];
  for (const center of peaks.slice(0, K)) {
    const lo = Math.max(0, center - 4), hi = Math.min(n - 1, center + 4);
    let num = 0, den = 0;
    for (let i = lo; i <= hi; i++) { const cents = cents0 + i * centsStep; num += salience[i] * cents; den += salience[i]; }
    const hz = 10 * Math.pow(2, (num / den) / 1200);
    if (hz < fmin * 0.9 || hz > fmax * 1.1) continue;   // 베이스 음역 밖은 버린다(약간의 여유)
    out.push({ hz, w: salience[center] });
  }
  return out;
}

/**
 * CREPE 살리언스로 채보한다. ONNX 추론은 비동기라서(crepe-run.js) 이 함수 자체는 동기로
 * 남긴다 — 추론은 호출부가 먼저 끝내고 프레임별 360bin 결과만 넘긴다. YIN/pYIN 과 뒷단
 * (온셋·분절·테크닉·운지)을 finishFromPitchTrack() 으로 완전히 공유한다.
 *
 * CREPE 는 16kHz·1024샘플·자체 hop(보통 10ms) 격자로 돈다 — transcribe() 의 hopSec 격자
 * (N=2048 기준 약 11.6ms)와 다르다. rms/저역/온셋은 원본 mono 로 transcribe() 와 동일하게
 * 다시 재고, CREPE 살리언스만 그 격자에 맞춰 가장 가까운 시각의 프레임을 가져다 쓴다.
 *
 * @param {Float32Array[]} crepeSalience 프레임마다 360bin
 * @param {number} crepeHopSec CREPE 프레임 간격(보통 0.01)
 * @param {Float32Array} mono 원본
 * @param {number} sampleRate
 */
export function transcribeCrepe(crepeSalience, crepeHopSec, mono, sampleRate, options) {
  const opts = { ...DEFAULTS, ...(options || {}) };

  let sig = mono, sr = sampleRate;
  while (sr > 30000) { sig = decimate2(sig); sr = sr / 2; }
  const N = 2048;
  const hop = Math.max(64, Math.round(sr * opts.hopMs / 1000));
  const frames = Math.max(0, Math.floor((sig.length - N) / hop));
  if (frames < 2 || !crepeSalience.length) return { notes: [], tuning: opts.tuning, sampleRate: sr, hopSec: hop / sr };
  const hopSec = hop / sr;

  const lp = new Float32Array(sig.length);
  {
    const a = Math.exp(-2 * Math.PI * 250 / sr);
    let y = 0;
    for (let i = 0; i < sig.length; i++) { y = (1 - a) * sig[i] + a * y; lp[i] = y; }
  }

  const rmss = new Float64Array(frames), lows = new Float64Array(frames), onsetRms = new Float64Array(frames);
  const onN = Math.max(32, Math.round(sr * opts.onsetWinMs / 1000));
  for (let f = 0; f < frames; f++) {
    const o = f * hop;
    let rms = 0;
    for (let i = 0; i < N; i++) rms += sig[o + i] * sig[o + i];
    rmss[f] = Math.sqrt(rms / N);
    let lo = 0, all = 0;
    for (let i = 0; i < N; i++) { const a = lp[o + i], b = sig[o + i]; lo += a * a; all += b * b; }
    lows[f] = all > 1e-12 ? Math.sqrt(lo / all) : 0;
    let e = 0;
    const end = Math.min(sig.length, o + onN);
    for (let i = o; i < end; i++) e += sig[i] * sig[i];
    onsetRms[f] = Math.sqrt(e / Math.max(1, end - o));
  }

  const CENTS0 = 1997.3794084376191, CENTS_STEP = 7180 / 359;
  const K = opts.pyinCandidates || 3;
  const candsPerFrame = new Array(frames);
  for (let f = 0; f < frames; f++) {
    const ci = Math.min(crepeSalience.length - 1, Math.max(0, Math.round((f * hopSec) / crepeHopSec)));
    candsPerFrame[f] = topKCandidatesFromSalience(crepeSalience[ci], CENTS0, CENTS_STEP, K, opts.fmin, opts.fmax);
  }

  const smooth = pyinViterbi(candsPerFrame, hzToMidi(opts.fmin), hzToMidi(opts.fmax), opts);
  const confs = new Float64Array(frames);
  for (let f = 0; f < frames; f++) { const c = candsPerFrame[f]; confs[f] = c.length ? c[0].w : 0; }

  const withFrets = finishFromPitchTrack(smooth, confs, rmss, lows, onsetRms, hopSec, opts);
  return { notes: withFrets, tuning: opts.tuning, sampleRate: sr, hopSec };
}

/**
 * 박자 격자에 맞춘다.
 *   검출된 시작 시각은 프레임 해상도(약 12ms)만큼 흔들린다. 사람은 그 흔들림을
 *   "박에서 벗어났다"로 읽으므로, 격자에 붙이면 같은 검출로도 훨씬 정확해 보인다.
 *   다만 격자에서 너무 먼 음은 건드리지 않는다 — 당김음이나 검출 오류를 억지로 끌어오면
 *   오히려 틀린 자리에 고정된다.
 * @param {Array} notes
 * @param {number[]} beats 박 시각(초)
 * @param {number} subdiv 한 박을 나눌 수 (4 = 16분음표)
 * @param {number} tolRatio 격자 간격의 이 비율 안에 있을 때만 붙인다
 */
export function quantizeToGrid(notes, beats, subdiv = 4, tolRatio = 0.45) {
  if (!Array.isArray(beats) || beats.length < 2 || !notes.length) return notes;

  // 박 사이를 subdiv 등분한 격자
  const grid = [];
  for (let i = 0; i < beats.length - 1; i++) {
    const a = beats[i], b = beats[i + 1];
    for (let k = 0; k < subdiv; k++) grid.push(a + (b - a) * (k / subdiv));
  }
  grid.push(beats[beats.length - 1]);
  const step = (beats[beats.length - 1] - beats[0]) / Math.max(1, (beats.length - 1) * subdiv);
  const tol = step * tolRatio;

  const nearest = (t) => {
    let lo = 0, hi = grid.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (grid[mid] < t) lo = mid + 1; else hi = mid; }
    const cands = [grid[lo - 1], grid[lo], grid[lo + 1]].filter(v => v != null);
    let best = null, bd = Infinity;
    for (const g of cands) { const d = Math.abs(g - t); if (d < bd) { bd = d; best = g; } }
    return { at: best, dist: bd };
  };

  const out = notes.map(n => ({ ...n }));
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    const end = n.start + n.dur;
    const s = nearest(n.start);
    if (s.at != null && s.dist <= tol) n.start = s.at;
    const e = nearest(end);
    if (e.at != null && e.dist <= tol && e.at > n.start) n.dur = e.at - n.start;
    else n.dur = Math.max(0.05, end - n.start);
  }
  // 붙이는 과정에서 앞 음이 다음 음을 덮을 수 있다
  for (let i = 0; i < out.length - 1; i++) {
    const over = (out[i].start + out[i].dur) - out[i + 1].start;
    if (over > 0) out[i].dur = Math.max(0.05, out[i].dur - over);
  }
  return out;
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiToName(m) {
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
