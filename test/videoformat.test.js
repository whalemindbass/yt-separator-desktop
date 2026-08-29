'use strict';
// 내보내기 포맷 다양화(MP4/MOV/WebM) — 포맷 선택 UI(저장 대화상자 확장자까지 맞는지)
// 와 실제 내보낸 파일이 그 포맷에 맞는 스트림 구성(WebM=VP9+Opus)인지 ffprobe 로 검증한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veformat-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veformat-'));
const SRC = path.join(TMP, 'src.mp4');

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=10',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function probe(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
    '-show_entries', 'stream=codec_type,codec_name', '-of', 'default=noprint_wrappers=1', file], { encoding: 'utf-8' });
  return r.stdout || '';
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트 + 포맷 선택 UI');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  expect('포맷 선택에 mp4/mov/webm 옵션 있음',
    await js(`[...document.getElementById('ve-format').options].map(o => o.value).sort().join(',')`), 'mov,mp4,webm');
  expect('기본값 mp4', await js(`document.getElementById('ve-format').value`), 'mp4');
  let savedName = null;

  section('2) WebM 내보내기 — VP9 영상 + Opus 오디오');
  await js(`(() => {
    const sel = document.getElementById('ve-format');
    sel.value = 'webm';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  const OUT_WEBM = path.join(TMP, 'out.webm');
  dialog.showSaveDialog = async (win, opts) => { savedName = opts.defaultPath; return { canceled: false, filePath: OUT_WEBM }; };
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_WEBM)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('저장 대화상자 기본 파일명이 .webm', (savedName || '').endsWith('.webm'), true);
  expect('WebM 출력 파일 생김', fs.existsSync(OUT_WEBM), true);
  if (fs.existsSync(OUT_WEBM)) {
    const info = probe(OUT_WEBM);
    expect('WebM 영상 코덱 VP9', info.includes('codec_name=vp9'), true);
    expect('WebM 오디오 코덱 Opus', info.includes('codec_name=opus'), true);
  }

  section('3) MOV 내보내기 — H.264 그대로, 컨테이너만 MOV');
  await js(`(() => {
    const sel = document.getElementById('ve-format');
    sel.value = 'mov';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  const OUT_MOV = path.join(TMP, 'out.mov');
  dialog.showSaveDialog = async (win, opts) => { savedName = opts.defaultPath; return { canceled: false, filePath: OUT_MOV }; };
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_MOV)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('저장 대화상자 기본 파일명이 .mov', (savedName || '').endsWith('.mov'), true);
  expect('MOV 출력 파일 생김', fs.existsSync(OUT_MOV), true);
  if (fs.existsSync(OUT_MOV)) {
    const info = probe(OUT_MOV);
    expect('MOV 영상 코덱 H.264', info.includes('codec_name=h264'), true);
    expect('MOV 오디오 코덱 AAC', info.includes('codec_name=aac'), true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
