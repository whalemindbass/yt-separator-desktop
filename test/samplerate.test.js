'use strict';
// 스템 리샘플 — 44.1kHz 스템을 다른 레이트 장치로 재생·내보내도 길이와 음정이 그대로인가.
//
// 실제 오디오 장치가 필요하다. 48kHz 를 열지 못하는 기계에서는 건너뛴다.
// 엔진만 쓰므로 Electron 창은 띄우지 않는다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'engine', 'bin', 'yss-engine.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-sr-'));

let pass = 0, fail = 0;
const expect = (l, g, w) => { const ok = String(g) === String(w); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${l}: ${g}${ok ? '' : ` (기대 ${w})`}`); };
const near = (l, g, w, t) => { const ok = Math.abs(g - w) <= t; ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${l}: ${g}${ok ? '' : ` (기대 ${w}±${t})`}`); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** 16비트 스테레오 사인파 WAV */
function tone(file, sr, seconds, hz) {
  const n = Math.round(sr * seconds), data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(0.5 * 32767 * Math.sin(2 * Math.PI * hz * i / sr));
    data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'latin1');
  h.write('fmt ', 12, 'latin1'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

/** 24비트 WAV 를 읽어 특정 주파수의 세기를 잰다 (Goertzel) */
function analyse(file) {
  const b = fs.readFileSync(file);
  let pos = 12, dataAt = -1, sr = 0, ch = 2, bits = 24;
  while (pos + 8 <= b.length) {
    const id = b.toString('latin1', pos, pos + 4), len = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') { ch = b.readUInt16LE(pos + 10); sr = b.readUInt32LE(pos + 12); bits = b.readUInt16LE(pos + 22); }
    if (id === 'data') { dataAt = pos + 8; break; }
    pos += 8 + len + (len & 1);
  }
  const bytes = bits / 8, frames = Math.floor((b.length - dataAt) / (bytes * ch));
  const xs = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = dataAt + i * bytes * ch;
    xs[i] = (bits === 24 ? (b.readIntLE(o, 3) / 8388608) : (b.readInt16LE(o) / 32768));
  }
  const mag = (f) => {
    const k = 2 * Math.cos(2 * Math.PI * f / sr); let s1 = 0, s2 = 0;
    for (let i = 0; i < xs.length; i++) { const s0 = xs[i] + k * s1 - s2; s2 = s1; s1 = s0; }
    return Math.hypot(s1 - s2 * Math.cos(2 * Math.PI * f / sr), s2 * Math.sin(2 * Math.PI * f / sr));
  };
  return { sr, frames, seconds: frames / sr, mag };
}

function engine() {
  const p = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = []; let buf = '';
  let pos = 0, sr = 48000, lastAudible = 0;
  p.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.ev === 'pos') pos = m.samples;
      if (m.ev === 'device' && m.sr) sr = m.sr;
      // 스템 트랙(90000번대)에서 소리가 잡힌 마지막 위치를 기억한다
      if (m.ev === 'trackMeter' && (m.list || []).some(t => t.id >= 90000 && Math.max(t.l || 0, t.r || 0) > 0.05)) {
        lastAudible = pos;
      }
      for (let k = waiters.length - 1; k >= 0; k--)
        if (waiters[k].ev === m.ev) { clearTimeout(waiters[k].t); waiters[k].res(m); waiters.splice(k, 1); }
    }
  });
  p.stderr.on('data', () => {});
  return {
    send: (o) => p.stdin.write(JSON.stringify(o) + '\n'),
    on: (ev, ms = 25000) => new Promise((res, rej) => {
      waiters.push({ ev, res, t: setTimeout(() => rej(new Error('이벤트 없음: ' + ev)), ms) });
    }),
    /** ms 동안 재생을 지켜보고 소리가 마지막으로 잡힌 지점을 초로 돌려준다 */
    track: async (ms) => { lastAudible = 0; await wait(ms); return lastAudible / sr; },
    kill: () => { try { p.kill(); } catch {} },
  };
}

(async () => {
  if (!fs.existsSync(EXE)) { console.log('  건너뜀 — 엔진 실행 파일 없음'); process.exit(0); }

  const stem = path.join(TMP, 'tone44k.wav');
  tone(stem, 44100, 4.0, 1000);

  const e = engine();
  await e.on('ready');
  e.send({ cmd: 'listDevices' });
  let dev = await e.on('devices');
  if (Math.round(dev.sampleRate) !== 48000) {
    e.send({ cmd: 'setDevice', sampleRate: 48000 });
    dev = await e.on('devices');
  }
  if (Math.round(dev.sampleRate) !== 48000) {
    console.log('  건너뜀 — 48kHz 를 열 수 있는 오디오 장치가 없다');
    e.kill(); process.exit(0);
  }

  console.log('1) 44.1kHz 스템을 48kHz 로 내보내기');
  e.send({ cmd: 'loadStems', paths: [stem] });
  await e.on('stems');
  const out = path.join(TMP, 'out48.wav');
  e.send({ cmd: 'export', file: out, format: 'wav', bitDepth: 24, mineOnly: false, startSec: 0, endSec: 0 });
  await e.on('exportDone', 60000);

  const a = analyse(out);
  expect('출력 레이트  ', a.sr, 48000);
  near('길이(초)     ', Number(a.seconds.toFixed(4)), 4.0, 0.01);
  const at1k = a.mag(1000), at1088 = a.mag(1088.4);
  console.log(`   1000Hz ${Math.round(at1k)} · 1088Hz ${Math.round(at1088)}`);
  expect('음정 보존    ', at1k > at1088 * 100, true);   // 변환 없으면 1088Hz 쪽이 커진다

  // 실시간 재생은 익스포트와 다른 코드다. 소리가 언제까지 나오는지로 잰다 —
  // 변환이 빠지면 44.1k 분량이 48k 로 흘러 3.675초에 끊긴다.
  console.log('2) 실시간 재생도 끝까지 간다 (48kHz)');
  e.send({ cmd: 'master', gain: 0.0005 });   // 스피커로는 들리지 않게
  e.send({ cmd: 'setDevice', sampleRate: 48000 });
  await e.on('devices');
  e.send({ cmd: 'seek', pos: 0 });
  e.send({ cmd: 'play' });
  const heard = await e.track(5400);
  e.send({ cmd: 'stop' });
  console.log(`   마지막 소리 ${heard.toFixed(3)}초 · 변환 없으면 ${(4 * 44100 / 48000).toFixed(3)}초`);
  near('끝까지 재생  ', Number(heard.toFixed(2)), 4.0, 0.25);

  console.log('3) 레이트가 같으면 그대로다');
  e.send({ cmd: 'setDevice', sampleRate: 44100 });
  await e.on('devices');
  const out2 = path.join(TMP, 'out44.wav');
  e.send({ cmd: 'export', file: out2, format: 'wav', bitDepth: 24, mineOnly: false, startSec: 0, endSec: 0 });
  await e.on('exportDone', 60000);
  const b = analyse(out2);
  expect('출력 레이트  ', b.sr, 44100);
  near('길이(초)     ', Number(b.seconds.toFixed(4)), 4.0, 0.01);
  expect('음정 보존    ', b.mag(1000) > b.mag(1088.4) * 100, true);

  e.send({ cmd: 'quit' });
  await wait(600); e.kill();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('테스트 실패:', err.message); process.exit(1); });
