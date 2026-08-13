'use strict';
// 정답을 아는 베이스 오디오를 만든다.
//
//   node lab/tab/tools/synth.js <출력 폴더>
//
// 왜 필요한가: 지금 정답지는 검출기의 출력에서 파생돼 시각이 검출기 자신의 값이다.
// 그것으로는 온셋·타이밍을 잴 수 없다(lab/tab/README.md). 여기서 만든 것은
// 언제 무슨 음이 울리는지 우리가 정하므로, 시각도 음정도 검출기와 무관하다.
//
// 소리는 Karplus-Strong 발현음이다. 실제 베이스는 아니지만 이 실험에 필요한 성질 —
// 뚜렷한 어택, 하모닉스, 감쇠 — 을 갖는다. 분리 모델이 베이스로 알아볼 만큼은 저역이다.

const fs = require('fs');
const path = require('path');

const SR = 44100;
const BPM = 100;
const BEAT = 60 / BPM;

// ── 음 배치 ──────────────────────────────────────────────
// 검출기가 실제로 틀리는 자리를 겨냥해 짠다.
//   · 같은 음 반복      — 지금 43개를 놓치는 그 실패 모드
//   · 옥타브·5도 도약   — 음정 오류 45개가 이 관계다
//   · 짧은 음과 긴 음   — 감쇠 중에 다음 음이 오는 경우
const N = (n) => n;   // MIDI 번호. E1=28 (4현 베이스 최저음)

function buildLine() {
  const ev = [];
  let t = 0.5;
  const add = (midi, dur) => { ev.push({ start: t, midi, dur }); t += dur; };

  const bars = [
    // 1) 4분음 근음 — 가장 쉬운 경우
    () => { for (const m of [28, 28, 28, 28]) add(m, BEAT); },
    // 2) 같은 음 8분 반복 — 어택이 뭉개지면 여기서 놓친다
    () => { for (let i = 0; i < 8; i++) add(31, BEAT / 2); },
    // 3) 옥타브 도약 — 옥타브 오류를 겨냥
    () => { for (const m of [33, 45, 33, 45]) add(m, BEAT); },
    // 4) 5도 도약 — 5도 오류를 겨냥
    () => { for (const m of [28, 35, 28, 35]) add(m, BEAT); },
    // 5) 긴 음 하나 — 감쇠 꼬리
    () => add(30, BEAT * 4),
    // 6) 긴 음 뒤 빠른 반복
    () => { add(30, BEAT * 2); for (let i = 0; i < 4; i++) add(30, BEAT / 2); },
    // 7) 걷는 베이스
    () => { for (const m of [28, 32, 35, 39]) add(m, BEAT); },
    // 8) 16분 반복 — 가장 어려운 경우
    () => { for (let i = 0; i < 16; i++) add(43, BEAT / 4); },
    // 9) 높은 자리 (개방현이 아닌 음)
    () => { for (const m of [50, 48, 45, 43]) add(m, BEAT); },
    // 10) 쉼표를 낀 배치 — 없는 곳에서 찾아내면 헛 노트다
    () => { add(28, BEAT); t += BEAT; add(35, BEAT); t += BEAT; },
  ];

  for (let rep = 0; rep < 3; rep++) for (const bar of bars) bar();
  return ev;
}

// ── 발현음 합성 ──────────────────────────────────────────
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Karplus-Strong — 잡음을 채운 지연선을 저역통과로 되먹인다 */
function pluck(out, startSample, midi, seconds, gain = 0.9) {
  const f = midiToHz(midi);
  const n = Math.max(2, Math.round(SR / f));
  const buf = new Float32Array(n);
  // 픽 잡음을 그대로 쓰면 너무 밝다 — 한 번 눌러 베이스에 가깝게
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    prev = prev * 0.6 + white * 0.4;
    buf[i] = prev;
  }
  const total = Math.min(Math.round(seconds * SR), out.length - startSample);
  // 저음일수록 오래 울린다
  const damp = 0.5 - Math.min(0.08, f / 4000);
  let idx = 0, last = 0;
  for (let i = 0; i < total; i++) {
    const cur = buf[idx];
    const nxt = buf[(idx + 1) % n];
    const v = (cur + nxt) * damp + last * (0.996 - damp * 2);
    buf[idx] = v;
    last = v;
    idx = (idx + 1) % n;
    // 감쇠 꼬리 — 다음 음이 와도 완전히 끊지 않는다
    const env = Math.exp(-i / (SR * 0.9));
    out[startSample + i] += cur * gain * env;
  }
}

function render(events, tailSeconds = 1.5) {
  const end = Math.max(...events.map(e => e.start + e.dur)) + tailSeconds;
  const out = new Float32Array(Math.ceil(end * SR));
  for (const e of events) {
    // 실제 연주처럼 음이 제 길이보다 조금 더 울리게 둔다
    pluck(out, Math.round(e.start * SR), e.midi, e.dur + 0.35);
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? 0.7 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  return out;
}

// ── WAV 쓰기 (16비트 스테레오) ───────────────────────────
function writeWav(file, mono) {
  const n = mono.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    const s = Math.round(v * 32767);
    data.writeInt16LE(s, i * 4);
    data.writeInt16LE(s, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28);
  h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

// ── 정답지 (score.html 이 읽는 형식) ─────────────────────
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const midiName = (m) => NAMES[m % 12] + (Math.floor(m / 12) - 1);

function writeGt(file, events, seconds) {
  const L = [
    `# 합성 베이스 — 정답이 알려진 오디오`,
    `# ${seconds.toFixed(1)}초 · ${events.length}음 · BPM ${BPM} · 튜닝 E A D G`,
    `# 시각·음정을 우리가 정했으므로 검출기와 무관하다`,
    '',
  ];
  for (let i = 0; i < events.length; i += 16) {
    const chunk = events.slice(i, i + 16);
    L.push(chunk.map(e => e.start.toFixed(2)).join(' '));
    L.push(chunk.map(e => midiName(e.midi)).join(' '));
    L.push('');
  }
  fs.writeFileSync(file, L.join('\n'), 'utf8');
}

// ── 실행 ────────────────────────────────────────────────
const outDir = process.argv[2] || path.join(__dirname, '..', 'synth');
fs.mkdirSync(outDir, { recursive: true });

const events = buildLine();
const audio = render(events);
const seconds = audio.length / SR;

writeWav(path.join(outDir, 'bass.wav'), audio);
writeGt(path.join(outDir, 'bass.gt.txt'), events, seconds);

const repeats = events.filter((e, i) => i > 0 && events[i - 1].midi === e.midi).length;
console.log(`합성 완료 — ${seconds.toFixed(1)}초 · ${events.length}음`);
console.log(`  같은 음 연속 ${repeats}쌍 (놓침이 여기서 나온다)`);
console.log(`  음역 ${midiName(Math.min(...events.map(e => e.midi)))} ~ ${midiName(Math.max(...events.map(e => e.midi)))}`);
console.log(`  ${path.join(outDir, 'bass.wav')}`);
console.log(`  ${path.join(outDir, 'bass.gt.txt')}`);
