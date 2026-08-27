'use strict';
// 영상 반전(좌우/상하 뒤집기) — 클립 선택 시 버튼 활성화, 미리보기 CSS transform 반영,
// 실제 내보내기 결과물에도 hflip/vflip 이 적용되는지 4분할 색상 프레임으로 픽셀 검증.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veflip-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veflip-'));
const QUAD = path.join(TMP, 'quad.mp4');
const OUT_H = path.join(TMP, 'out_h.mp4');
const OUT_V = path.join(TMP, 'out_v.mp4');
const W = 320, H = 240;

// 4분할: 좌상 red · 우상 blue · 좌하 green · 우하 yellow (320x240)
{
  const r = spawnSync(FFMPEG, ['-y',
    '-f', 'lavfi', '-i', 'color=red:size=160x120:duration=2',
    '-f', 'lavfi', '-i', 'color=blue:size=160x120:duration=2',
    '-f', 'lavfi', '-i', 'color=green:size=160x120:duration=2',
    '-f', 'lavfi', '-i', 'color=yellow:size=160x120:duration=2',
    '-filter_complex', '[0][1]hstack=inputs=2[top];[2][3]hstack=inputs=2[bot];[top][bot]vstack=inputs=2[out]',
    '-map', '[out]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', QUAD], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(QUAD)) throw new Error('ffmpeg 로 4분할 테스트 영상 생성 실패');
}

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [QUAD] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function samplePng(file, w, h, t, cb) {
  const raw = file + '.raw';
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const px = (x, y) => { const o = (y * w + x) * 3; return { r: buf[o], g: buf[o + 1], b: buf[o + 2] }; };
  cb(px);
}
const isRed = (p) => p.r > p.g + 60 && p.r > p.b + 60;
const isBlue = (p) => p.b > p.r + 60 && p.b > p.g + 60;
const isGreen = (p) => p.g > p.r + 60 && p.g > p.b + 60;

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트 + 선택 — 반전 버튼이 선택 전엔 꺼져 있다가 켜짐');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  expect('선택 전 좌우반전 버튼 비활성', await js(`document.getElementById('ve-flip-h').disabled`), true);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await js(`(() => {
    document.querySelector('.ve-clip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(100);
  expect('선택 후 좌우반전 버튼 활성', await js(`document.getElementById('ve-flip-h').disabled`), false);

  section('2) 좌우 반전 — 미리보기 <video> 레이어에 CSS transform 반영');
  await js(`document.getElementById('ve-flip-h').click(); true`);
  await wait(100);
  expect('버튼 on 표시', await js(`document.getElementById('ve-flip-h').classList.contains('on')`), true);
  const tf = await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.transform`);
  expect('레이어 transform = scale(-1, 1)', tf, 'scale(-1, 1)');

  section('3) 좌우 반전 내보내기 — 실제 픽셀이 뒤집혔는가(좌상단이 이제 파랑)');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_H });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_H)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT_H), true);
  if (fs.existsSync(OUT_H)) {
    samplePng(OUT_H, W, H, 0.5, (px) => {
      expect('좌상단(원래 red) → hflip 후 blue', isBlue(px(30, 30)), true);
      expect('우상단(원래 blue) → hflip 후 red', isRed(px(290, 30)), true);
    });
  }

  section('4) 좌우 반전 끄고 상하 반전 — 또 다른 축 검증');
  await js(`document.getElementById('ve-flip-h').click(); true`);   // 끄기
  await js(`document.getElementById('ve-flip-v').click(); true`);   // 상하 켜기
  await wait(100);
  expect('좌우반전 off', await js(`document.getElementById('ve-flip-h').classList.contains('on')`), false);
  expect('상하반전 on', await js(`document.getElementById('ve-flip-v').classList.contains('on')`), true);
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_V });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_V)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  if (fs.existsSync(OUT_V)) {
    samplePng(OUT_V, W, H, 0.5, (px) => {
      expect('좌상단(원래 red) → vflip 후 green', isGreen(px(30, 30)), true);
    });
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
