'use strict';
// synth-mix.js 의 더 엄격한 버전. 드럼·패드를 우리가 지어내는 대신, 실제 곡에서 분리해
// 이미 갖고 있는 진짜 드럼·기타·보컬 스템을 합성 베이스 위에 얹는다.
//
//   node lab/tab/tools/synth-mix-real.js
//
// 왜 필요한가: synth-mix.js 의 드럼·패드는 Karplus-Strong·사인파로 지어낸 것이라, htdemucs 가
// 그걸 실제 악기처럼 못 알아볼 위험이 있다 — 그러면 "분리가 어택을 지운다"는 결과가 우리
// 합성음의 비현실성 때문인지 진짜 분리의 한계인지 구분이 안 된다. 이 버전은 배경을 전부
// 진짜 악기 소리로 바꿔 그 혼입 변수를 없앤다. 베이스만 여전히 정답을 아는 합성음이다.
//
// manifest.json 의 samples[0] 스템(버스커버스커 첫사랑)을 쓴다 — score.html 이 박자 검출에
// 쓰는 것과 같은 파일이라 이미 로컬에 있을 가능성이 높다.

const fs = require('fs');
const path = require('path');

const SR = 44100;
const LAB = path.join(__dirname, '..');
const SYNTH = path.join(LAB, 'synth');
const manifest = JSON.parse(fs.readFileSync(path.join(LAB, 'manifest.json'), 'utf8'));
const sample = manifest.samples[0];

// ── WAV 읽기/쓰기 (synth-mix.js 와 동일) ──
function readWavMono(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error(`WAV 아님: ${file}`);
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2), bits: buf.readUInt16LE(body + 14), sr: buf.readUInt32LE(body + 4) };
    if (id === 'data') { dataOff = body; dataLen = size; }
    off = body + size + (size & 1);
  }
  if (!fmt || dataOff < 0) throw new Error(`WAV 파싱 실패: ${file}`);
  if (fmt.bits !== 16) throw new Error(`16비트만 지원 (${file} 은 ${fmt.bits}비트)`);
  const ch = fmt.ch;
  const n = Math.floor(dataLen / 2 / ch);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) sum += buf.readInt16LE(dataOff + (i * ch + c) * 2);
    out[i] = (sum / ch) / 32768;
  }
  return { mono: out, sr: fmt.sr };
}
function writeWav(file, mono) {
  const n = mono.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    const s = Math.round(v * 32767);
    data.writeInt16LE(s, i * 4); data.writeInt16LE(s, i * 4 + 2);
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
const rms = (buf) => Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / Math.max(1, buf.length));

// ── 실행 ────────────────────────────────────────────────
const bassPath = path.join(SYNTH, 'bass.wav');
if (!fs.existsSync(bassPath)) { console.error(`없음: ${bassPath}\n먼저: npm run lab -- synth`); process.exit(1); }

const stemDir = path.join(process.env.APPDATA || '', 'yt-separator-desktop', 'downloads', 'stems');
const stemFile = (kind) => path.join(stemDir, `${sample.stems.prefix}_${kind}.wav`);
const need = ['drums', 'other', 'vocals'].map(k => [k, stemFile(k)]).filter(([, p]) => !fs.existsSync(p));
if (need.length) {
  console.error('실제 스템이 없다 — 앱에서 한 번 분리해 두어야 한다:');
  for (const [k, p] of need) console.error(`  ${k}: ${p}`);
  process.exit(1);
}

const { mono: bass, sr: bassSr } = readWavMono(bassPath);
const parts = ['drums', 'other', 'vocals'].map(k => readWavMono(stemFile(k)));
for (const p of parts) if (p.sr !== bassSr) throw new Error(`샘플레이트 불일치 (베이스 ${bassSr} vs 스템 ${p.sr})`);

// 실제 곡은 훨씬 길다 — 앞에서부터 bass.wav 길이만큼만 잘라 쓴다. 인트로(도입부 페이드인)를
// 피하려고 30초 지점부터 시작한다 — 그쪽이 곡의 "본편" 음량에 더 가깝다.
const skip = Math.min(Math.round(30 * bassSr), Math.max(0, parts[0].mono.length - bass.length));
const n = bass.length;
const trimmed = parts.map(p => p.mono.subarray(skip, skip + n));

const targetRms = 0.09;
const norm = (buf) => { const r = rms(buf); const g = r > 1e-6 ? targetRms / r : 1;
  const out = new Float32Array(buf.length); for (let i = 0; i < buf.length; i++) out[i] = buf[i] * g; return out; };
const bassN = norm(bass);
const partsN = trimmed.map(norm);

const mix = new Float32Array(n);
for (let i = 0; i < n; i++) { let s = bassN[i]; for (const p of partsN) s += p[i]; mix[i] = s; }
let peak = 0;
for (const v of mix) peak = Math.max(peak, Math.abs(v));
const g = peak > 0 ? 0.85 / peak : 1;
for (let i = 0; i < mix.length; i++) mix[i] *= g;

const outPath = path.join(SYNTH, 'mix-real.wav');
writeWav(outPath, mix);

// synth-mix.js 와 같은 이유로 "믹스 안에서 베이스가 실제로 차지한 진폭"을 따로 남긴다.
const bassAsMixed = new Float32Array(n);
for (let i = 0; i < n; i++) bassAsMixed[i] = bassN[i] * g;
writeWav(path.join(SYNTH, 'bass-as-mixed-real.wav'), bassAsMixed);

console.log(`믹스 완료(진짜 배경) — ${(mix.length / SR).toFixed(1)}초 · 배경 원곡: ${sample.title} · 정규화 배율 g=${g.toFixed(3)}`);
console.log(`  파트별 RMS(섞기 전, 정규화 후) — 베이스 ${rms(bassN).toFixed(4)} · 드럼 ${rms(partsN[0]).toFixed(4)} · 기타류 ${rms(partsN[1]).toFixed(4)} · 보컬 ${rms(partsN[2]).toFixed(4)}`);
console.log(`  ${outPath}`);
console.log(`\n다음: npm run lab -- sepattack-real`);
