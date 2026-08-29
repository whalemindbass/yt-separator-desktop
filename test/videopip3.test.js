'use strict';
// video:export — 3트랙 동시 PIP. overlay 체인이 2개 넘는 레이어(N>=3)로도 일반화됐는지
// 확인한다. videopip.test.js 와 별도 파일로 둔 이유: 그쪽은 이미 트랙/클립을 쌓아놓은
// 상태라 여기서 픽셀 위치를 새로 가정하려면 프로필을 깨끗하게 새로 시작해야 한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vepip3-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vepip3-'));
const RED = path.join(TMP, 'red.mp4');
const BLUE = path.join(TMP, 'blue.mp4');
const GREEN = path.join(TMP, 'green.mp4');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

function makeClip(file, color, seconds) {
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=${W}x${H}:duration=${seconds}:rate=15`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(RED, 'red', 3);
makeClip(BLUE, 'blue', 3);
makeClip(GREEN, 'green', 3);

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 3트랙 임포트 — A(red,배경) / B(blue,우상단) / C(green,좌상단)');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  async function addTrackAndImport(file, expectTotal) {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
    await wait(150);
    await js(`document.getElementById('ve-import').click(); true`);
    for (let i = 0; i < 40; i++) {
      const n = await js(`document.querySelectorAll('.ve-clip').length`);
      if (n >= expectTotal) break;
      await wait(300);
    }
  }
  await addTrackAndImport(RED, 1);
  await addTrackAndImport(BLUE, 2);
  await addTrackAndImport(GREEN, 3);
  const clipCount = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('클립 3개(트랙 3개) 임포트됨', clipCount, 3);

  section('2) 트랙C(맨 위,green)=좌상단, 트랙B(중간,blue)=우상단 PIP 지정');
  await js(`(() => {
    const btns = document.querySelectorAll('.ve-lane .ve-pip');
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    btns[0].click(); set('pip-x', 0); set('pip-y', 0); set('pip-scale', 25);
    btns[1].click(); set('pip-x', 75); set('pip-y', 0); set('pip-scale', 25);
  })(); true`);
  await wait(200);

  section('3) 내보내기 + overlay 체인 픽셀 검증');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('3트랙 PIP 내보내기 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const RAW = path.join(TMP, 'frame.raw');
    spawnSync(FFMPEG, ['-y', '-ss', '0.5', '-i', OUT, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, RAW], { stdio: 'ignore' });
    const buf = fs.readFileSync(RAW);
    const px = (x, y) => { const o = (y * W + x) * 3; return { r: buf[o], g: buf[o + 1], b: buf[o + 2] }; };
    const topLeft = px(30, 20);      // 트랙C 박스 안 — green
    const topRight = px(280, 20);    // 트랙B 박스 안 — blue
    const bg = px(160, 150);         // 박스 밖 — red 배경
    expect('좌상단은 초록 우세', topLeft.g > topLeft.r + 40 && topLeft.g > topLeft.b + 40, true);
    expect('우상단은 파랑 우세', topRight.b > topRight.r + 40 && topRight.b > topRight.g + 40, true);
    expect('배경은 빨강 우세', bg.r > bg.g + 40 && bg.r > bg.b + 40, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
