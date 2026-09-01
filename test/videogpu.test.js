'use strict';
// GPU(NVENC) 인코딩 — 목록에 h264_nvenc 가 있으면(빌드에 컴파일돼 있음, 실제 하드웨어
// 유무와 무관) video:gpuInfo 가 available:true 를 돌려주고, gpu:true 로 내보내면 그
// 경로를 먼저 시도한다. 이 개발 머신엔 NVIDIA GPU 가 없어서(AMD 내장 그래픽) 실제
// NVENC 인코딩 자체는 반드시 실패한다 — 그 실패 뒤 자동으로 CPU(libx264) 로 재시도해
// export 가 그래도 성공하는지, 즉 안전망이 실제로 동작하는지가 이 테스트의 핵심이다
// (mock 이 아니라 진짜 ffmpeg 프로세스로 검증).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vegpu-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vegpu-'));
const SRC = path.join(TMP, 'red.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=red:size=${W}x${H}:duration=1:rate=10`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  const baseSeg = { file: SRC, start: 0, end: 1, refW: W, refH: H, dur: 1, audioSources: [{ file: SRC, start: 0, end: 1 }] };

  section('1) video:gpuInfo — 번들 ffmpeg 에 h264_nvenc 가 컴파일돼 있으면 available:true');
  const gpuInfo = await js(`yssApi.video.gpuInfo()`);
  expect('gpuInfo.available === true(이 빌드는 NVENC 포함)', gpuInfo.available, true);

  section('2) main.js — mp4 + gpu:true → 이 머신엔 실제 NVIDIA GPU 가 없어 1차(NVENC) 시도는 실패해야 정상,');
  console.log('  하지만 자동으로 CPU(libx264) 재시도가 붙어 최종 export 는 성공해야 한다.');
  const OUT_GPU = path.join(TMP, 'gpu.mp4');
  let res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [baseSeg], outPath: OUT_GPU, format: 'mp4', gpu: true })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('gpu:true 로 내보내도(NVENC 실패 → CPU 자동 재시도) 최종 성공', res?.ok, true);
  if (!res?.ok) console.log('  export error:', res?.error);
  expect('실패한 NVENC 시도가 남긴 부분 파일 없이 최종 결과물이 있음', fs.existsSync(OUT_GPU), true);

  section('3) main.js — webm + gpu:true → webm 은 GPU 인코더가 없으니 처음부터 CPU 한 번만(재시도 없이 바로 성공)');
  const OUT_WEBM = path.join(TMP, 'gpu.webm');
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [baseSeg], outPath: OUT_WEBM, format: 'webm', gpu: true })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('webm 은 gpu:true 를 줘도 정상적으로 CPU 경로로 성공', res?.ok, true);

  section('4) 렌더러 — 내보내기 모달에 GPU 체크박스가 뜨고(available:true) 기본 켜짐');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) {
    if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break;
    await wait(300);
  }
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 20; i++) {
    if (await js(`!!document.getElementById('ve-exp-gpu')`)) break;
    await wait(150);
  }
  const gpuChecked = await js(`document.getElementById('ve-exp-gpu')?.checked`);
  expect('GPU 체크박스가 존재하고 기본으로 켜져 있음', gpuChecked, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
