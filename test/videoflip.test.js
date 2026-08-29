'use strict';
// 영상 반전(좌우/상하 뒤집기) — 이제 툴바 버튼이 아니라 효과 체인의 토글 항목이다
// (요청: 상하좌우 반전 버튼을 효과 추가로 대체). "+" 효과 추가 메뉴에서 넣고, 목록의
// on/off 스위치로 끄고 켠다 — 다른 색보정 효과(흑백/세피아)와 똑같은 조작 방식.
// 미리보기 CSS transform 반영 + 실제 내보내기 결과물 픽셀까지 검증한다.

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

  section('1) 임포트 + 선택 — 툴바엔 더 이상 반전 버튼이 없다');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  expect('상하좌우 반전 툴바 버튼 자체가 없음', await js(`!document.getElementById('ve-flip-h') && !document.getElementById('ve-flip-v')`), true);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await js(`(() => {
    document.querySelector('.ve-clip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(100);

  section('2) 효과 추가 메뉴에서 "좌우 반전" 넣기 — 미리보기 <video> 레이어에 CSS transform 반영');
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(100);
  await js(`(() => { [...document.querySelectorAll('.ve-fx-add-item')].find(b => b.textContent === '좌우 반전').click(); })(); true`);
  await wait(100);
  expect('효과 목록에 좌우 반전 행 생김', await js(`document.querySelector('.ve-fx-row .ve-fx-name')?.textContent`), '좌우 반전');
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

  section('4) 좌우 반전 끄고(on/off 스위치) 상하 반전 추가 — 또 다른 축 검증');
  await js(`document.querySelector('.ve-fx-row .ve-fx-onoff').click(); true`);   // 좌우 반전 끄기(지우지 않고 비활성화)
  await wait(80);
  expect('좌우 반전 행에 off 표시', await js(`document.querySelector('.ve-fx-row')?.classList.contains('off')`), true);
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(80);
  await js(`(() => { [...document.querySelectorAll('.ve-fx-add-item')].find(b => b.textContent === '상하 반전').click(); })(); true`);
  await wait(80);
  expect('행 2개(좌우 반전 꺼짐 + 상하 반전 켜짐)', await js(`document.querySelectorAll('.ve-fx-row').length`), 2);
  const tf2 = await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.transform`);
  expect('레이어 transform = scale(1, -1)(좌우는 꺼졌으니 세로만)', tf2, 'scale(1, -1)');
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

  section('5) 같은 종류를 두 번 넣으면 서로 상쇄(홀짝) — h 단축키로 좌우 반전 다시 켜고 한 번 더');
  await js(`(() => {
    const view = document.querySelector('.video-body');
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true }));
  })(); true`);
  await wait(80);
  // 기존 좌우 반전 항목이 꺼져 있었으니(3번에서 off) h 는 그걸 다시 켠다(새로 추가하지 않음).
  expect('h 단축키는 기존 항목을 재사용(행 여전히 2개)', await js(`document.querySelectorAll('.ve-fx-row').length`), 2);
  const tf3 = await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.transform`);
  expect('좌우+상하 둘 다 켜짐 = scale(-1, -1)', tf3, 'scale(-1, -1)');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
