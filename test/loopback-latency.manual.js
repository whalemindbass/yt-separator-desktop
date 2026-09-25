'use strict';
// 루프백 지연 실측(수동) — 인터페이스 출력(헤드폰 등)을 입력에 케이블로 연결한 상태에서만 의미가 있다.
// 클릭 스템을 재생하며 녹음 트랙으로 녹음하고, 녹음 클립 속 클릭이 타임라인 위치에서 몇 샘플
// 어긋나는지(중앙값) 잰다. 엔진의 녹음 정렬·PDC 를 고칠 때 전/후 비교용.
//
//   SCEN=S1|S2|S3  LOOP_DEVICE="Universal Audio Volt"  LOOP_PLUGIN=7  REC_AT=0.5 \
//     node_modules/.bin/electron test/loopback-latency.manual.js
//
//   S1 플러그인 없음 · S2 스템에 지연 플러그인 + PDC 켬 · S3 같은 플러그인 + PDC 끔
//   LOOP_PLUGIN = 스캔 목록 인덱스(지연이 큰 것 — 없으면 S2/S3 는 S1 과 같게 나온다)
//   REC_AT = 녹음 시작 위치(초). 0 이면 "곡 맨 처음부터 녹음" 정렬도 같이 확인된다.
//
// 2026-09-25 UA Volt / 1176(86샘플) 실측 — 수정 전: S1 112, S2 198, 0초 녹음 632
//                                         수정 후: S1 112, S2 112, S3 198, 0초 녹음 112
// (남는 112샘플은 드라이버가 보고 안 하는 변환기 지연 — 앱 버그 아님)
// ⚠ 입력 모니터링은 스크립트가 끈다(루프백이라 켜면 피드백). 인터페이스 다이렉트 모니터도 끌 것.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');
const SCEN = process.env.SCEN || 'S1';
const LOOP_DEVICE = process.env.LOOP_DEVICE || 'Universal Audio Volt';
const LOOP_PLUGIN = Number(process.env.LOOP_PLUGIN || 7);
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-lm-profile-'));
app.setPath('userData', PROFILE);
const FFMPEG = path.join(__dirname, '..', 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-lm-'));
const STEM = path.join(TMP, 'clicks.wav');
const REC_AT = Number(process.env.REC_AT || 0.5);
const CLICKS = []; for (let t = 1.25; t <= 4.51; t += 0.25) CLICKS.push(+t.toFixed(2));
// 스템 레이트를 장치(44.1k)와 같게 — 리샘플러 지연이 측정에 섞이지 않게
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', "aevalsrc='if(gte(t,1.2)*lt(mod(t-1.25,0.25),1/44100),0.9,0)|if(gte(t,1.2)*lt(mod(t-1.25,0.25),1/44100),0.9,0)':s=44100:d=5", '-c:a', 'pcm_s16le', STEM], { stdio: 'ignore' });

function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('latin1', p, p + 4), sz = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') { data = b.subarray(p + 8, p + 8 + Math.min(sz, b.length - p - 8)); break; }
    p += 8 + sz + (sz & 1);
  }
  const bps = fmt.bits / 8, frames = Math.floor(data.length / (bps * fmt.ch)), x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const o = i * bps * fmt.ch;   // 첫 채널
    x[i] = fmt.tag === 3 ? data.readFloatLE(o) : fmt.bits === 16 ? data.readInt16LE(o) / 32768 : fmt.bits === 24 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648;
  }
  return { sr: fmt.sr, x, fmt };
}

const { bootMain, wait, finish } = require('./harness');
(async () => {
  const { app: eApp, js } = await bootMain({ settle: 1500 });
  await js(`window.__e = { dev: null, rec: null, take: null, pdc: null, plugins: null, exits: 0 };
    window.yssApi.engine.onEvent((m) => {
      if (m.ev === 'device') window.__e.dev = { name: m.name, sr: m.sr, rt: m.roundtripMs };
      if (m.ev === 'recTracks') window.__e.rec = m.list || m.tracks;
      if (m.ev === 'take') window.__e.take = m;
      if (m.ev === 'pdc') window.__e.pdc = m;
      if (m.ev === 'plugins') window.__e.plugins = (m.list || []).length;
      if (m.ev === 'exit') window.__e.exits++;
    }); true`);
  await js(`window.yssApi.engine.start([${JSON.stringify(STEM)}], 'probe')`);
  for (let i = 0; i < 30; i++) { if (await js(`!!window.__e.dev`)) break; await wait(200); }
  // ⚠ 루프백이라 입력 모니터링은 반드시 끈다(켜면 피드백)
  await js(`window.yssApi.engine.inputMonitor(false); window.__e.dev = null; window.yssApi.engine.setDevice({ type: 'ASIO', output: ${JSON.stringify(LOOP_DEVICE)}, input: ${JSON.stringify(LOOP_DEVICE)} }); true`);
  for (let i = 0; i < 40; i++) { const d = await js(`window.__e.dev`); if (d && d.name === LOOP_DEVICE) break; await wait(250); }
  await js(`window.yssApi.engine.inputMonitor(false); window.yssApi.engine.scanPlugins(); window.yssApi.engine.recTrackAdd(0, 'probe'); true`);
  for (let i = 0; i < 60; i++) { if (await js(`!!(window.__e.plugins && window.__e.rec && window.__e.rec.length)`)) break; await wait(500); }
  const dev = await js(`window.__e.dev`);
  const tid = (await js(`window.__e.rec`))[0].id;
  if (SCEN !== 'S1') {
    await js(`window.yssApi.engine.fxAdd(90001, ${LOOP_PLUGIN}); true`);   // 스템 트랙에 지연 있는 플러그인
    await wait(3000);
    await js(`window.yssApi.engine.pdc(${SCEN === 'S3' ? 'false' : 'true'}); true`); await wait(800);
  }
  const pdc = await js(`window.__e.pdc`);
  await js(`window.yssApi.engine.recTrackSetInput(${tid}, { mode: 0, chL: 0, chR: 1 }); window.yssApi.engine.inputMonitor(false); true`);
  await wait(400);
  if (!(await js(`window.__e.rec`)).find(r => r.id === tid).armed) await js(`window.yssApi.engine.recArm(${tid}); true`);
  await wait(500);
  await js(`window.yssApi.engine.seek(${Math.round(REC_AT * 44100)}); window.yssApi.engine.recordArm(null, [${tid}], 'probe')`);
  await wait(300);
  await js(`window.yssApi.engine.play(); true`);
  await wait(5200);
  await js(`window.yssApi.engine.stop(); window.yssApi.engine.recordStop(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`!!window.__e.take`)) break; await wait(250); }
  const take = await js(`window.__e.take`);
  await js(`window.yssApi.engine.quit()`); await wait(1000);

  const { x, sr, fmt } = readWav(take.file);
  const start = Number(take.timelineStart);
  const errs = []; // {e, v}
  for (const t of CLICKS) {
    const exp = Math.round(t * sr);
    const a = Math.max(0, exp - Math.round(0.1 * sr) - start), bEnd = Math.min(x.length, exp + Math.round(0.1 * sr) - start);
    let best = -1, bi = -1;
    for (let i = a; i < bEnd; i++) { const v = Math.abs(x[i]); if (v > best) { best = v; bi = i; } }
    if (bi >= 0) errs.push({ e: start + bi - exp, v: best });
  }
  const vmax = Math.max(...errs.map(z => z.v)); const good = errs.filter(z => z.v > 0.3 * vmax).map(z => z.e); errs.length = 0; errs.push(...good); errs.sort((p, q) => p - q);
  const med = errs.length ? errs[Math.floor(errs.length / 2)] : null;
  console.log(JSON.stringify({ SCEN, device: dev.name, sr, rt: +dev.rt.toFixed(2), pdc: pdc ? { on: pdc.on, samples: pdc.samples } : null,
    comp: take.roundtripComp, timelineStart: start, wav: `${fmt.bits}bit tag${fmt.tag}`, clicksFound: errs.length, errsSamples: errs,
    medianErr: med, medianErrMs: med == null ? null : +(med / sr * 1000).toFixed(2) }));
  finish(eApp);
})().catch(e => { console.error(e); process.exit(1); });
