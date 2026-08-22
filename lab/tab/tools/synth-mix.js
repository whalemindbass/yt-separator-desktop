'use strict';
// bass.wav(정답이 알려진 합성 베이스) 위에 드럼·기타류를 더해 진짜 곡처럼 섞는다.
//
//   node lab/tab/tools/synth-mix.js
//
// 왜 필요한가: 지금까지 합성 음원(synth.js)은 "분리를 전혀 거치지 않은" 채로만 재봤다
// (README 5번). 그래서 검출기 자체의 한계와, 분리 과정이 어택을 지우는 몫을 구분하지 못했다.
// 이 믹스를 실제 htdemucs 로 분리한 뒤(sepattack.html) 그 결과 베이스와 원본 bass.wav 를
// 같은 시각에서 견주면 — 정답을 우리가 정했으므로 — "분리가 어택을 얼마나 지우는가" 를
// 처음으로 직접 잴 수 있다.
//
// 드럼·기타류는 박자를 bass.wav 의 실제 이벤트와 맞추지 않는다. 여기서 재려는 것은
// "베이스 검출이 박에 맞는가"가 아니라 "다른 악기가 섞인 채로 분리를 거치면 베이스 신호가
// 얼마나 살아남는가"이므로, 그냥 곡처럼 들리는 마스킹 소음이면 충분하다.

const fs = require('fs');
const path = require('path');

const SR = 44100;

// ── WAV 읽기/쓰기 (16비트 스테레오, synth.js 의 writeWav 와 짝) ──
function readWavMono(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error(`WAV 아님: ${file}`);
  }
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(body + 2), bits: buf.readUInt16LE(body + 14) };
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
  return out;
}

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

const rms = (buf) => Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / Math.max(1, buf.length));

// ── 드럼 (박자를 베이스와 맞추지 않는다 — 그냥 마스킹 텍스처) ──
function noiseburst(n, decaySec) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * Math.exp(-i / (SR * decaySec));
  return out;
}
function tone(n, hz, decaySec) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin(2 * Math.PI * hz * i / SR) * Math.exp(-i / (SR * decaySec));
  return out;
}
/** 1극 고역통과 — 하이햇을 노이즈에서 밝게 걸러낸다 */
function highpass(buf, cutHz) {
  const a = Math.exp(-2 * Math.PI * cutHz / SR);
  const out = new Float32Array(buf.length);
  let prevIn = 0, prevOut = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = a * (prevOut + buf[i] - prevIn);
    out[i] = v; prevIn = buf[i]; prevOut = v;
  }
  return out;
}
function add(dst, src, at, gain = 1) {
  const end = Math.min(dst.length, at + src.length);
  for (let i = at; i < end; i++) dst[i] += src[i - at] * gain;
}

function synthDrums(totalSamples) {
  const out = new Float32Array(totalSamples);
  const kick = tone(Math.round(SR * 0.2), 58, 0.09);
  const snareBody = tone(Math.round(SR * 0.15), 180, 0.06);
  const snareNoise = highpass(noiseburst(Math.round(SR * 0.15), 0.05), 800);
  const hat = highpass(noiseburst(Math.round(SR * 0.05), 0.02), 5000);

  // 2초짜리 루프를 곡 끝까지 반복한다 — "그냥 곡처럼" 들리면 충분하다
  const loopSec = 2.0, loopSamp = Math.round(SR * loopSec);
  const hitsInLoop = [
    { t: 0.00, kind: 'kick' }, { t: 0.50, kind: 'hat' },
    { t: 0.75, kind: 'hat' },  { t: 1.00, kind: 'snare' },
    { t: 1.25, kind: 'hat' },  { t: 1.50, kind: 'kick' },
    { t: 1.75, kind: 'hat' },
  ];
  for (let loopAt = 0; loopAt < totalSamples; loopAt += loopSamp) {
    for (const h of hitsInLoop) {
      const at = loopAt + Math.round(h.t * SR);
      if (at >= totalSamples) continue;
      if (h.kind === 'kick') add(out, kick, at, 0.9);
      else if (h.kind === 'snare') { add(out, snareBody, at, 0.5); add(out, snareNoise, at, 0.7); }
      else add(out, hat, at, 0.35);
    }
  }
  return out;
}

// ── "other" — 지속되는 패드 (기타·키보드류 자리) ──
// 베이스 음역을 침범하지 않도록 중고음역(대략 C3~C5)에 둔다.
function synthPad(totalSamples) {
  const out = new Float32Array(totalSamples);
  const chords = [
    [48, 52, 55], [50, 53, 57], [45, 48, 52], [43, 47, 50],   // C E G / D F A / A C E / G B D
  ];
  const chordSec = 4.0, chordSamp = Math.round(SR * chordSec);
  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const attack = Math.round(SR * 0.6), release = Math.round(SR * 0.6);

  for (let start = 0, ci = 0; start < totalSamples; start += chordSamp, ci++) {
    const chord = chords[ci % chords.length];
    const len = Math.min(chordSamp, totalSamples - start);
    for (const midi of chord) {
      const hz = midiToHz(midi);
      const detunes = [-0.15, 0, 0.15];   // 살짝 어긋난 두세 옥타브 겹침 — 합성음이 너무 순정음이 되지 않게
      for (let i = 0; i < len; i++) {
        let env = 1;
        if (i < attack) env = i / attack;
        else if (i > len - release) env = Math.max(0, (len - i) / release);
        let s = 0;
        for (const d of detunes) s += Math.sin(2 * Math.PI * (hz + d) * i / SR);
        out[start + i] += (s / detunes.length) * env * 0.5;
      }
    }
  }
  return out;
}

// ── 실행 ────────────────────────────────────────────────
const SYNTH = path.join(__dirname, '..', 'synth');
const bassPath = path.join(SYNTH, 'bass.wav');
if (!fs.existsSync(bassPath)) {
  console.error(`없음: ${bassPath}`);
  console.error('먼저: npm run lab -- synth');
  process.exit(1);
}

const bass = readWavMono(bassPath);
const drums = synthDrums(bass.length);
const pad = synthPad(bass.length);

// 세 파트를 비슷한 세기로 맞춘 뒤 섞는다 — 실제 믹스에서 베이스만 유난히 튀거나
// 묻히지 않는 균형에 가깝게. 목표 RMS 는 임의값이지만 세 파트에 똑같이 적용하므로
// "베이스가 이미 유리한 채로 분리를 통과한다"는 트집을 피할 수 있다.
const targetRms = 0.09;
const norm = (buf) => { const r = rms(buf); const g = r > 1e-6 ? targetRms / r : 1;
  const out = new Float32Array(buf.length); for (let i = 0; i < buf.length; i++) out[i] = buf[i] * g; return out; };
const bassN = norm(bass), drumsN = norm(drums), padN = norm(pad);

const mix = new Float32Array(bass.length);
for (let i = 0; i < mix.length; i++) mix[i] = bassN[i] + drumsN[i] + padN[i];
let peak = 0;
for (const v of mix) peak = Math.max(peak, Math.abs(v));
const g = peak > 0 ? 0.85 / peak : 1;
for (let i = 0; i < mix.length; i++) mix[i] *= g;

const outPath = path.join(SYNTH, 'mix.wav');
writeWav(outPath, mix);

// mix.wav 안에서 베이스가 실제로 차지한 진폭 = bassN * g. 완벽한 분리기라면 이 파일이
// 그대로 나온다 — sepattack.html 은 원본 bass.wav(진폭이 다르다) 대신 이걸 "분리 전" 기준으로
// 삼아야 클리핑 방지 정규화가 어택 손실로 잘못 잡히지 않는다.
const bassAsMixed = new Float32Array(bass.length);
for (let i = 0; i < bass.length; i++) bassAsMixed[i] = bassN[i] * g;
writeWav(path.join(SYNTH, 'bass-as-mixed.wav'), bassAsMixed);

console.log(`믹스 완료 — ${(mix.length / SR).toFixed(1)}초 · 정규화 배율 g=${g.toFixed(3)}`);
console.log(`  파트별 RMS(섞기 전, 정규화 후 동일해야 정상) — 베이스 ${rms(bassN).toFixed(4)} · 드럼 ${rms(drumsN).toFixed(4)} · 패드 ${rms(padN).toFixed(4)}`);
console.log(`  ${outPath}`);
console.log(`\n다음: npm run lab -- sepattack`);
