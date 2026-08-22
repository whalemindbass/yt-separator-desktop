'use strict';
// 코드 검출(chordQualityAt) 정확도를 정답이 알려진 합성 오디오로 잰다.
//
//   node lab/tab/tools/chord-synth.js
//
// 왜 필요한가: 지금까지의 "보컬 빼라" "confidence 넣어라" 는 전부 추론이었지 잰 게
// 아니다. synth.js 가 베이스 온셋·음정에 했던 걸 코드에도 똑같이 한다 — 근음·성질을
// 우리가 정해서 합성하므로 검출기가 실제로 몇 %를 맞히는지 숫자로 나온다.
//
// 근음은 정답으로 주고(베이스 검출은 이미 따로 검증됨 — README 참고) 성질(장·단·sus4)
// 판정만 잰다. chordQualityAt() 이 실제로 쓰는 그 함수다 — 우회 없음.

const fs = require('fs');
const path = require('path');

const SR = 44100;
const BAR_SEC = 2.0;         // 마디 하나 길이 — 실제 곡의 느린 템포 수준

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Karplus-Strong 발현음 — synth.js 와 같은 방식(검증된 합성). out 에 더한다(믹스). */
function pluck(out, startSample, midi, seconds, gain) {
  const f = midiToHz(midi);
  const n = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    prev = prev * 0.6 + white * 0.4;
    buf[i] = prev;
  }
  const total = Math.min(Math.round(seconds * SR), out.length - startSample);
  const damp = 0.5 - Math.min(0.08, f / 4000);
  let idx = 0, last = 0;
  for (let i = 0; i < total; i++) {
    const cur = buf[idx];
    const nxt = buf[(idx + 1) % n];
    const v = (cur + nxt) * damp + last * (0.996 - damp * 2);
    buf[idx] = v;
    last = v;
    idx = (idx + 1) % n;
    const env = Math.exp(-i / (SR * 0.9));
    if (startSample + i >= 0 && startSample + i < out.length) out[startSample + i] += cur * gain * env;
  }
}

/** 화음 하나를 한 마디 동안 스트럼처럼 반복 발현 — 실제 반주에 가깝게 */
function strumChord(out, barStartSample, barSec, tones, gain) {
  const strums = Math.max(1, Math.round(barSec / 0.5));   // 0.5초마다 다시 튕긴다
  for (let s = 0; s < strums; s++) {
    const t0 = barStartSample + Math.round(s * 0.5 * SR);
    for (const midi of tones) pluck(out, t0, midi, 0.6, gain / tones.length);
  }
}

// ── 화음 진행 만들기 ────────────────────────────────────
// tab-chord.js 의 FIXED_ROOT_QUALITIES 와 정확히 같은 목록으로 맞춰 둔다 — 실제 쓰는
// 후보군을 그대로 잰다. 7화음·dim·aug 를 넣어 봤더니(2026-08-21 측정) 클린 조건에서도
// 33~83% 로 떨어져서 뺐다 — 다시 시도할 거면 아래에 추가하고 이 스크립트로 먼저 재 볼 것.
//   7: [0,4,7,10]  maj7: [0,4,7,11]  m7: [0,3,7,10]  dim: [0,3,6]  aug: [0,4,8]
const QUALITIES = {
  '':     [0, 4, 7],
  'm':    [0, 3, 7],
  'sus4': [0, 5, 7],
  'sus2': [0, 2, 7],
};
const BASE_OCT = 60;   // 반주 옥타브(가운데 C 근처) — 근음은 별도로 베이스 옥타브에도 얹는다

function buildProgression() {
  const prog = [];
  // 1) 12 근음 x 3 성질 — 전 범위 고르게. 붙은 반음정끼리(장3도 vs 단3도 한 반음 차)
  //    가장 헷갈리는 경우라 일부러 다 넣는다. (variant: clean)
  for (let root = 0; root < 12; root++) {
    for (const q of Object.keys(QUALITIES)) prog.push({ root, quality: q, variant: 'clean' });
  }
  // 2) 9음(add9) 얹은 버전 — 실제 기타·건반 보이싱은 순정 3화음이 드물다. 9음이 크로마를
  //    어느 쪽으로도 안 흔드는지가 진짜 실전 근접 테스트다. (variant: add9)
  for (let root = 0; root < 12; root++) {
    for (const q of Object.keys(QUALITIES)) prog.push({ root, quality: q, variant: 'add9' });
  }
  // 3) 분리 잔여 잡음(드럼 새어든 것 흉내) 섞은 버전 — 화성 스템만 골라도 분리가 완벽하진
  //    않다. 브로드밴드 잡음을 낮은 레벨로 얹는다. (variant: bleed)
  for (let root = 0; root < 12; root++) {
    for (const q of Object.keys(QUALITIES)) prog.push({ root, quality: q, variant: 'bleed' });
  }
  // 4) 파워코드(근음+5도만, 3음 없음) — 정답이 없는 경우다. 장/단 어느 쪽으로도 확신하면
  //    안 된다 — confidence 가 여기서 낮게 나오는지가 진짜 확인 포인트.
  const powerChordCases = [0, 4, 7, 9];
  for (const root of powerChordCases) prog.push({ root, quality: 'power', variant: 'clean' });
  return prog;
}

function render(prog) {
  const barSamples = Math.round(BAR_SEC * SR);
  const out = new Float32Array(prog.length * barSamples + SR);
  for (let i = 0; i < prog.length; i++) {
    const { root, quality, variant } = prog[i];
    const tones = quality === 'power' ? [0, 7] : QUALITIES[quality].slice();
    if (variant === 'add9') tones.push(14);   // 옥타브+장2도 = 9음
    const midis = tones.map(t => BASE_OCT + ((root + t) % 12) + 12 * Math.floor((root + t) / 12));
    strumChord(out, i * barSamples, BAR_SEC, midis, 0.8);
    if (variant === 'bleed') {
      // 브로드밴드 잡음 — 드럼이 덜 빠진 것을 흉내. 화음 톤(0.8 게인)보다 뚜렷이 낮게.
      const start = i * barSamples, end = Math.min(out.length, start + barSamples);
      for (let s = start; s < end; s++) out[s] += (Math.random() * 2 - 1) * 0.12;
    }
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.7 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

// ── 실행 ────────────────────────────────────────────────
async function main() {
  const { chordQualityAt } = await import('../../../renderer/workers/tab-chord.js');

  const prog = buildProgression();
  const audio = render(prog);
  const barSamples = Math.round(BAR_SEC * SR);

  const byVariant = {};   // variant → { total, correct, byQuality:{}, confCorrect:[], confWrong:[] }
  const powerConfidences = [];
  const rows = [];
  // MIN_CHORD_CONFIDENCE 와 같은 값 — tab-score.js 것과 따로 관리되지만 여기선 참고용으로만 쓴다
  const MIN_CHORD_CONFIDENCE = 0.06;
  let gatedRight = 0, gatedTotal = 0;   // "confidence 문턱을 실제로 적용하면" 시뮬레이션

  for (let i = 0; i < prog.length; i++) {
    const { root, quality, variant } = prog[i];
    const t0 = i * BAR_SEC, t1 = t0 + BAR_SEC;
    const q = chordQualityAt(audio, SR, t0, t1, root);
    const guessed = q ? q.quality : '(null)';

    if (quality === 'power') {
      powerConfidences.push(q ? q.confidence : 0);
      rows.push(`  [파워코드/${variant}] ${ROOTS[root]}5 → ${ROOTS[root]}${guessed || '(메이저)'}  conf=${(q?.confidence ?? 0).toFixed(4)}`);
      continue;
    }

    const v = byVariant[variant] = byVariant[variant] || { total: 0, correct: 0, byQuality: {}, confCorrect: [], confWrong: [] };
    v.total++;
    const hit = guessed === quality;
    if (hit) v.correct++;
    const qKey = quality || '(메이저)';
    v.byQuality[qKey] = v.byQuality[qKey] || { n: 0, hit: 0 };
    v.byQuality[qKey].n++;
    if (hit) v.byQuality[qKey].hit++;
    (hit ? v.confCorrect : v.confWrong).push(q ? q.confidence : 0);

    // 문턱을 적용했다면(낮은 confidence 는 조성표로 내려간다) 이 케이스가 어떻게 됐을지 —
    // 조성표 쪽 정답률은 여기서 모르니, "문턱 밑이면 최소한 오답을 자백은 한다" 만 잰다.
    gatedTotal++;
    if (hit || (q && q.confidence < MIN_CHORD_CONFIDENCE)) gatedRight++;

    if (!hit) rows.push(`  틀림[${variant}]: ${ROOTS[root]}${quality} → ${ROOTS[root]}${guessed || '(메이저)'}  conf=${(q?.confidence ?? 0).toFixed(4)}`);
  }

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;

  console.log(`\n=== chordQualityAt 정확도 (근음은 정답으로 줌, 성질만 판정) ===`);
  for (const [variant, v] of Object.entries(byVariant)) {
    console.log(`\n[${variant}] 전체 ${v.correct}/${v.total} (${(100 * v.correct / v.total).toFixed(1)}%)`);
    for (const [k, s] of Object.entries(v.byQuality)) {
      console.log(`  ${k.padEnd(6)} ${s.hit}/${s.n} (${(100 * s.hit / s.n).toFixed(1)}%)`);
    }
    console.log(`  확신도 — 맞았을 때 평균 ${avg(v.confCorrect).toFixed(4)}, 틀렸을 때 평균 ${avg(v.confWrong).toFixed(4)}`);
  }
  console.log(`\n문턱(${MIN_CHORD_CONFIDENCE}) 적용 시뮬레이션 — "맞혔거나 최소한 틀린 걸 자백(낮은 confidence)한" 비율: ${gatedRight}/${gatedTotal} (${(100*gatedRight/gatedTotal).toFixed(1)}%)`);
  console.log(`\n파워코드(3음 없음, 정답 불가) confidence 평균 ${avg(powerConfidences).toFixed(4)} — 문턱(${MIN_CHORD_CONFIDENCE}) 밑이어야 조성표로 안전하게 내려간다`);

  if (rows.length) {
    console.log(`\n상세(틀린 것만):`);
    for (const r of rows) console.log(r);
  }

  const outDir = path.join(__dirname, '..', 'synth');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'chord-accuracy.json'), JSON.stringify({
    byVariant, avgConfidencePower: avg(powerConfidences), gatedRight, gatedTotal,
  }, null, 2));
  console.log(`\n${path.join(outDir, 'chord-accuracy.json')} 에 저장`);
}

main().catch(e => { console.error(e); process.exit(1); });
