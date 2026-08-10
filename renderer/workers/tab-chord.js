'use strict';
// 원본 믹스에서 박마다 코드를 읽는다.
//
// 베이스 스템에는 화성이 없다 — 한 번에 한 음만 울린다. 코드는 반드시 믹스(또는 화성 스템)
// 에서 와야 한다. 그래서 여기 들어오는 신호는 채보에 쓰는 스템이 아니라 곡 전체다.
//
// 쓸모가 셋이다:
//   1) 코드 심볼 자체
//   2) 마디 첫 박 — 화성은 대개 마디 머리에서 바뀐다. 드럼 킥으로는 판정이 안 됐다.
//   3) 베이스 음 교차검증 — 크로마는 베이스 스템과 다른 신호라 우리 오류와 독립이다.

/** 제자리 radix-2 FFT. n 은 2의 거듭제곱. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// 44.1kHz 에서 빈 간격이 2.7Hz. 화성이 사는 110Hz 근처의 반음 간격이 6.5Hz 이므로
// 이보다 짧은 창을 쓰면 음정끼리 뭉개진다 — 4096(10.8Hz)으로는 코드가 전혀 안 나왔다.
const N_FFT = 16384;

/**
 * 구간마다 12음 크로마. 스펙트럼의 각 빈을 음정으로 접어 넣는다.
 * 저역(베이스 기본파)은 일부러 뺀다 — 코드의 성질은 그 위에 쌓인 화성이 말해준다.
 */
function chromaAt(sig, sr, center, halfWin, out) {
  const from = Math.max(0, Math.round((center - halfWin) * sr));
  const to = Math.min(sig.length, Math.round((center + halfWin) * sr));
  out.fill(0);
  if (to - from < 64) return out;

  const re = new Float64Array(N_FFT), im = new Float64Array(N_FFT);
  const n = Math.min(N_FFT, to - from);
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));   // Hann
    re[i] = sig[from + i] * w;
  }
  fft(re, im);

  const loHz = 110, hiHz = 1760;                 // A2~A6 — 베이스 기본파 위, 심벌 아래
  const loBin = Math.max(1, Math.floor(loHz * N_FFT / sr));
  const hiBin = Math.min(N_FFT >> 1, Math.ceil(hiHz * N_FFT / sr));
  for (let b = loBin; b < hiBin; b++) {
    const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
    if (mag <= 0) continue;
    const hz = b * sr / N_FFT;
    const pc = ((Math.round(12 * Math.log2(hz / 440) + 69) % 12) + 12) % 12;
    out[pc] += mag;
  }
  // 구간마다 음량이 다르므로 정규화한다 — 모양만 본다
  let max = 0;
  for (let i = 0; i < 12; i++) if (out[i] > max) max = out[i];
  if (max > 0) for (let i = 0; i < 12; i++) out[i] /= max;
  return out;
}

/** 코드 종류. 화음 구성음에 1, 나머지는 0. */
//   sus4 는 뺐다. C-F-G 라 장조에서 가장 흔한 세 음을 그대로 덮어, 으뜸·버금딸림·딸림
//   에너지를 통째로 긁어모아 진짜 3화음을 이겨버린다 — 실측에서 곡을 Csus4 로 도배했다.
//   7화음도 뺐다. 3화음의 상위집합이라 애매할 때마다 이기고, 베이스 연주자에게 득이 적다.
const QUALITIES = [
  { name: '',  tones: [0, 4, 7] },          // 메이저
  { name: 'm', tones: [0, 3, 7] },          // 마이너
];
const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 상태 = 근음 12 × 종류. 미리 펼쳐 둔다. */
const STATES = [];
for (let root = 0; root < 12; root++)
  for (const q of QUALITIES) STATES.push({ root, quality: q.name, set: new Set(q.tones.map(t => (root + t) % 12)) });

/** 크로마 하나에 대한 상태별 점수. 구성음은 크고 나머지는 작아야 좋다. */
function scoreStates(ch, out) {
  for (let i = 0; i < STATES.length; i++) {
    const set = STATES[i].set;
    let inSum = 0, outSum = 0;
    for (let pc = 0; pc < 12; pc++) {
      if (set.has(pc)) inSum += ch[pc]; else outSum += ch[pc];
    }
    // 음 수가 다른 종류끼리 견주므로 평균을 쓴다
    out[i] = inSum / set.size - outSum / (12 - set.size);
  }
  return out;
}

/**
 * 비터비로 코드열을 고른다.
 *
 * 박마다 제일 맞는 코드를 따로 고르면 지나가는 음마다 코드가 바뀐다(실측 박당 0.43회).
 * 코드는 원래 여러 박을 유지하므로, 바꾸는 데 값을 물리면 그 흔들림이 사라진다.
 * @param {number} switchCost 코드를 바꾸는 값. 크면 덜 바뀐다.
 */
function viterbi(frames, switchCost) {
  const S = STATES.length, T = frames.length;
  const dp = new Float64Array(S), next = new Float64Array(S);
  const back = new Int16Array(S * T);
  for (let i = 0; i < S; i++) dp[i] = frames[0][i];

  for (let t = 1; t < T; t++) {
    // 앞 단계의 최대값 하나만 알면 "바꾸는 경우"의 최선이 정해진다 — S² 를 S 로 줄인다
    let bestPrev = -Infinity, bestIdx = 0;
    for (let i = 0; i < S; i++) if (dp[i] > bestPrev) { bestPrev = dp[i]; bestIdx = i; }
    for (let i = 0; i < S; i++) {
      const stay = dp[i];
      const move = bestPrev - switchCost;
      if (stay >= move) { next[i] = stay + frames[t][i]; back[t * S + i] = i; }
      else { next[i] = move + frames[t][i]; back[t * S + i] = bestIdx; }
    }
    dp.set(next);
  }

  let last = 0;
  for (let i = 1; i < S; i++) if (dp[i] > dp[last]) last = i;
  const path = new Array(T);
  for (let t = T - 1; t >= 0; t--) { path[t] = last; last = back[t * S + last]; }
  return path;
}

/**
 * 박마다 코드를 읽는다.
 * @param {Float32Array} mixMono 원본 믹스 (모노)
 * @param {number} sampleRate
 * @param {number[]} beats 박 시각(초)
 * @returns {Array<{at:number, root:number, quality:string, name:string, score:number}>}
 */
export function detectChords(mixMono, sampleRate, beats, switchCost = 0.35) {
  if (!mixMono || !beats || beats.length < 2) return [];
  const iv = beats[1] - beats[0];

  // 박마다 크로마를 뽑고, 라벨이 아니라 **크로마 자체를** 앞뒤로 평활한다.
  // 코드는 보통 반 마디 이상 유지되므로 한 박만 보면 지나가는 음에 휘둘린다.
  const per = beats.map(t => {
    const c = new Float64Array(12);
    chromaAt(mixMono, sampleRate, t + iv * 0.5, iv * 0.5, c);
    return c;
  });
  const frames = beats.map((t, i) => {
    const acc = new Float64Array(12);
    for (let k = Math.max(0, i - 1); k <= Math.min(per.length - 1, i + 1); k++)
      for (let pc = 0; pc < 12; pc++) acc[pc] += per[k][pc];
    let max = 0;
    for (let pc = 0; pc < 12; pc++) if (acc[pc] > max) max = acc[pc];
    if (max > 0) for (let pc = 0; pc < 12; pc++) acc[pc] /= max;
    return scoreStates(acc, new Float64Array(STATES.length));
  });

  const path = viterbi(frames, switchCost);
  return beats.map((t, i) => {
    const st = STATES[path[i]];
    return { at: t, root: st.root, quality: st.quality, name: ROOTS[st.root] + st.quality,
             score: frames[i][path[i]] };
  });
}

/**
 * 코드가 바뀌는 지점으로 마디 첫 박을 고른다.
 * 화성은 대개 마디 머리에서 바뀐다 — 드럼 킥이 위상을 못 가르는 곡에서도 이건 남는다.
 * @returns {{phase:number, scores:number[]}|null}
 */
export function phaseFromChords(chords, beatsPerBar = 4) {
  if (!chords || chords.length < beatsPerBar * 2) return null;
  const scores = new Array(beatsPerBar).fill(0);
  for (let i = 1; i < chords.length; i++) {
    const changed = chords[i].root !== chords[i - 1].root || chords[i].quality !== chords[i - 1].quality;
    if (changed) scores[i % beatsPerBar]++;
  }
  let best = 0;
  for (let p = 1; p < beatsPerBar; p++) if (scores[p] > scores[best]) best = p;
  return { phase: best, scores };
}

/** 그 시각에 울리는 코드 */
export function chordAt(chords, t) {
  if (!chords || !chords.length) return null;
  let lo = 0, hi = chords.length - 1;
  if (t <= chords[0].at) return chords[0];
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (chords[mid].at <= t) lo = mid; else hi = mid; }
  return chords[lo];
}

export { ROOTS };
