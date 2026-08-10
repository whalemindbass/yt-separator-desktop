'use strict';
// 노트 목록 → 마디로 나눈 악보.
//
// 채보가 주는 것은 "몇 초에 어떤 음"이고, 악보가 주는 것은 "몇 째 마디 몇 박에 몇 분음표"다.
// 그 사이를 메우는 데 필요한 것은 세 가지뿐이다 — 박 격자, 마디의 첫 박이 어디인가,
// 그리고 길이를 음표값으로 바꾸는 규칙.
//
// 박 격자는 드럼 스템에서 이미 얻는다(detectBeats). 마디의 첫 박은 그 안에 없어서
// 베이스 라인에서 추정한다. 음표값은 16분 단위로 반올림한 뒤 표에서 찾는다.

/** 16분 단위 길이 → 음표값. 여기 없는 길이는 잇단음표로 쪼갠다. */
const VALUES = [
  { units: 16, name: 'whole' },
  { units: 12, name: 'half', dotted: true },
  { units: 8,  name: 'half' },
  { units: 6,  name: 'quarter', dotted: true },
  { units: 4,  name: 'quarter' },
  { units: 3,  name: 'eighth', dotted: true },
  { units: 2,  name: 'eighth' },
  { units: 1,  name: 'sixteenth' },
];

/** 한글 표기 — 화면과 텍스트 덤프가 같은 이름을 쓴다 */
export const VALUE_LABEL = {
  whole: '온', half: '2분', quarter: '4분', eighth: '8분', sixteenth: '16분',
};

/**
 * 16분 단위 길이를 음표값들로 나눈다. 표에 있는 길이면 하나, 아니면 이어 붙인다.
 * @returns {Array<{units:number, name:string, dotted:boolean, tied:boolean}>}
 */
export function splitDuration(units) {
  const out = [];
  let left = Math.max(1, Math.round(units));
  while (left > 0) {
    const v = VALUES.find(x => x.units <= left);
    if (!v) break;
    out.push({ units: v.units, name: v.name, dotted: !!v.dotted, tied: false });
    left -= v.units;
  }
  // 뒤에 이어지는 조각은 앞 음과 이어진 것이다
  for (let i = 1; i < out.length; i++) out[i].tied = true;
  return out;
}

/**
 * 시각(초) → 박 단위 위치. 박 간격이 곡 안에서 흔들리므로 격자 수식이 아니라
 * 실제 beats 배열 사이를 선형 보간한다. 곡이 조금씩 밀리거나 당겨져도 따라간다.
 */
function beatPosition(beats, t) {
  const n = beats.length;
  if (t <= beats[0]) {
    const iv = beats[1] - beats[0];
    return iv > 0 ? (t - beats[0]) / iv : 0;
  }
  if (t >= beats[n - 1]) {
    const iv = beats[n - 1] - beats[n - 2];
    return iv > 0 ? (n - 1) + (t - beats[n - 1]) / iv : n - 1;
  }
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid] <= t) lo = mid; else hi = mid; }
  const iv = beats[hi] - beats[lo];
  return lo + (iv > 0 ? (t - beats[lo]) / iv : 0);
}

/**
 * 마디의 첫 박이 몇 번째 박인지 고른다.
 *
 * 박 검출은 "박이 여기 있다"까지만 알려주고 "이게 1박이다"는 알려주지 않는다.
 *
 * 실측에서 단서마다 힘이 크게 달랐다. 드럼 킥은 위상별 세기가 99/97/100/92 로 사실상
 * 아무것도 말해주지 않았고(이 곡은 킥이 모든 박에 고르게 들어간다), 화성 변화는
 * 22/2/6/29 로 갈렸다. 코드는 대개 마디 머리에서 바뀌기 때문이다.
 * 그래서 코드 변화(barPhase)가 있으면 그것을 먼저 쓰고, 없을 때만 킥·베이스로 내려간다.
 *
 * @param {number|null} barPhase 코드 변화로 판정한 위상 (tab-chord 의 phaseFromChords)
 * @param {number[]|null} beatAccent 박마다의 세기 (drums 저역). 길이는 beats 와 같다.
 */
function pickPhase(notes, beats, beatsPerBar, beatAccent, barPhase) {
  if (barPhase != null) return ((barPhase % beatsPerBar) + beatsPerBar) % beatsPerBar;
  const score = new Array(beatsPerBar).fill(0);

  if (beatAccent && beatAccent.length >= beats.length) {
    for (let i = 0; i < beats.length; i++) score[i % beatsPerBar] += beatAccent[i];
  } else {
    for (const n of notes) {
      const pos = beatPosition(beats, n.start);
      const near = Math.round(pos);
      if (Math.abs(pos - near) > 0.25) continue;      // 박에서 먼 음은 단서가 못 된다
      score[((near % beatsPerBar) + beatsPerBar) % beatsPerBar] += Math.min(n.dur, 2);
    }
  }

  let best = 0;
  for (let p = 1; p < beatsPerBar; p++) if (score[p] > score[best]) best = p;
  return best;
}

/**
 * 드럼에서 박마다의 킥 세기를 잰다. 위상 판정용이라 저역만 본다.
 * @param {Float32Array} drumsMono
 * @param {number} sampleRate
 * @param {number[]} beats
 * @returns {number[]} 박마다의 저역 세기
 */
export function beatAccents(drumsMono, sampleRate, beats) {
  // 1극 저역통과 120Hz — 킥만 남기고 스네어·심벌은 덜어낸다
  const a = Math.exp(-2 * Math.PI * 120 / sampleRate);
  const lp = new Float32Array(drumsMono.length);
  let y = 0;
  for (let i = 0; i < drumsMono.length; i++) { y = (1 - a) * drumsMono[i] + a * y; lp[i] = y; }

  const half = Math.round(sampleRate * 0.06);         // 박 앞뒤 60ms
  return beats.map(t => {
    const c = Math.round(t * sampleRate);
    let s = 0, n = 0;
    for (let i = Math.max(0, c - half); i < Math.min(lp.length, c + half); i++) { s += lp[i] * lp[i]; n++; }
    return n ? Math.sqrt(s / n) : 0;
  });
}

/**
 * 노트 목록을 마디로 나눈다.
 *
 * @param {Array} notes  transcribe() 결과 (start, dur, midi, string, fret, tech)
 * @param {number[]} beats  박 시각(초)
 * @param {{beatsPerBar?:number, subdiv?:number}} [opts]
 * @returns {{bars:Array, beatsPerBar:number, subdiv:number, phase:number}|null}
 *   bars[i] = { index, start, end, items }
 *   items[j] = { at, units, rest, values, note }   at·units 는 마디 안에서의 16분 단위
 */
export function buildScore(notes, beats, opts = {}) {
  if (!Array.isArray(beats) || beats.length < 2 || !notes.length) return null;
  const beatsPerBar = opts.beatsPerBar || 4;
  const subdiv = opts.subdiv || 4;                    // 한 박을 나눌 수 (4 = 16분음표)
  const perBar = beatsPerBar * subdiv;
  const phase = opts.phase != null ? opts.phase
                                   : pickPhase(notes, beats, beatsPerBar, opts.beatAccent, opts.barPhase);

  // 각 음을 마디 번호와 마디 안 위치로 옮긴다
  const placed = [];
  for (const n of notes) {
    const p0 = beatPosition(beats, n.start) - phase;
    const p1 = beatPosition(beats, n.start + n.dur) - phase;
    const u0 = Math.round(p0 * subdiv);
    const units = Math.max(1, Math.round((p1 - p0) * subdiv));
    placed.push({ n, u0, units });
  }
  placed.sort((a, b) => a.u0 - b.u0);

  // 마디 채우기 — 빈 자리는 쉼표로 메운다
  const firstBar = Math.floor(placed[0].u0 / perBar);
  const lastEnd = Math.max(...placed.map(p => p.u0 + p.units));
  const lastBar = Math.floor((lastEnd - 1) / perBar);
  const bars = [];

  for (let b = firstBar; b <= lastBar; b++) {
    const base = b * perBar;
    const items = [];
    let cursor = 0;                                   // 마디 안에서 채워진 데까지 (16분 단위)

    for (const p of placed) {
      const at = p.u0 - base;
      if (at >= perBar || at + p.units <= 0) continue;
      const start = Math.max(0, at);
      if (start > cursor) {
        for (const v of splitDuration(start - cursor)) items.push({ at: cursor, units: v.units, rest: true, values: [v] });
        cursor = start;
      }
      if (start < cursor) continue;                   // 앞 음과 겹친다 — 뒤로 밀지 않고 버린다
      const units = Math.min(p.units, perBar - start);
      if (units <= 0) continue;
      items.push({ at: start, units, rest: false, values: splitDuration(units), note: p.n });
      cursor = start + units;
    }
    if (cursor < perBar) {
      for (const v of splitDuration(perBar - cursor)) items.push({ at: cursor, units: v.units, rest: true, values: [v] });
    }

    bars.push({
      index: b - firstBar + 1,
      start: beats[0] + 0,                            // 아래에서 실제 시각으로 채운다
      items,
    });
  }

  // 마디 시작 시각 — 화면에서 재생 위치를 마디에 맞추는 데 쓴다
  for (const bar of bars) {
    const beatIdx = (firstBar + bar.index - 1) * beatsPerBar + phase;
    bar.start = beatAt(beats, beatIdx);
    bar.end = beatAt(beats, beatIdx + beatsPerBar);
  }

  return { bars, beatsPerBar, subdiv, phase };
}

// ── 조성 ────────────────────────────────────────────────────
// Krumhansl-Schmuckler 프로파일. 사람이 각 음을 그 조에서 얼마나 "중심"으로 듣는지를
// 실험으로 잰 값이라, 음 길이 히스토그램과 상관을 재면 조가 나온다.
const PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES  = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
/** 플랫으로 적는 조 (으뜸음 pc, 장/단) */
const FLAT_KEYS = new Set(['5:major', '10:major', '3:major', '8:major', '1:major', '6:major',
                           '2:minor', '7:minor', '0:minor', '5:minor', '10:minor', '3:minor']);

function correlate(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}

/**
 * 조를 추정한다. 음 길이로 가중한 음정 히스토그램을 24개 조 프로파일과 견준다.
 *
 * 베이스만으로 조를 정하는 것은 원래 불리하다 — 3음·7음을 잘 안 치기 때문에 장·단 구분이
 * 약하다. 그래서 확신도(1위와 2위의 상관 차)를 같이 돌려주고, 쓰는 쪽에서 판단하게 한다.
 *
 * @returns {{tonic:number, mode:'major'|'minor', name:string, confidence:number, scale:number[]}|null}
 */
export function estimateKey(notes) {
  if (!notes || !notes.length) return null;
  const hist = new Array(12).fill(0);
  for (const n of notes) {
    if (n.midi == null) continue;
    hist[((n.midi % 12) + 12) % 12] += Math.min(n.dur || 0.1, 2);
  }
  if (!hist.some(v => v > 0)) return null;

  const scored = [];
  for (let t = 0; t < 12; t++) {
    for (const [mode, prof] of [['major', PROFILE_MAJOR], ['minor', PROFILE_MINOR]]) {
      const rot = prof.map((_, i) => prof[(i - t + 12) % 12]);
      scored.push({ tonic: t, mode, r: correlate(hist, rot) });
    }
  }
  scored.sort((a, b) => b.r - a.r);
  const best = scored[0];
  const names = FLAT_KEYS.has(`${best.tonic}:${best.mode}`) ? FLAT_NAMES : SHARP_NAMES;
  const steps = best.mode === 'major' ? [0, 2, 4, 5, 7, 9, 11] : [0, 2, 3, 5, 7, 8, 10];
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${names[best.tonic]} ${best.mode === 'major' ? 'Major' : 'minor'}`,
    confidence: Math.max(0, best.r - scored[1].r),
    scale: steps.map(s => (best.tonic + s) % 12),
  };
}

/** 조에 맞춰 음이름을 적는다 — 같은 건반도 조에 따라 F# 이거나 Gb 다. */
export function noteNameInKey(midi, key) {
  const names = key && FLAT_KEYS.has(`${key.tonic}:${key.mode}`) ? FLAT_NAMES : SHARP_NAMES;
  return names[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
}

/** 박 번호 → 시각. 배열 밖은 마지막 간격으로 연장한다. */
function beatAt(beats, idx) {
  const n = beats.length;
  if (idx < 0) return beats[0] + idx * (beats[1] - beats[0]);
  if (idx >= n) return beats[n - 1] + (idx - (n - 1)) * (beats[n - 1] - beats[n - 2]);
  return beats[idx];
}
