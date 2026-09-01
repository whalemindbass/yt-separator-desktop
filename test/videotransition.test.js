'use strict';
// 크로스페이드 전환 효과 종류 선택 — 겹치는 두 클립 사이에 뜨는 배지(.ve-xfade-badge)를
// 눌러 기본(fade, 블렌드) 대신 wipeleft(하드 경계, 안 섞임)를 고르면 실제 export 결과가
// 달라지는지 확인한다. fade 는 전환 중간에 화면 전체가 두 색이 섞인 색으로 나와야 하고,
// wipeleft 는 중간 시점에도 한쪽 끝은 완전히 순수한 색(안 섞임)이어야 한다 — 이 차이가
// 실제로 ffmpeg 필터에 반영됐다는 증거다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrans-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrans-'));
const RED = path.join(TMP, 'red.mp4');    // 2초
const BLUE = path.join(TMP, 'blue.mp4');  // 2초
const W = 320, H = 240;
function makeClip(file, color, seconds) {
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=${W}x${H}:duration=${seconds}:rate=15`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(RED, 'red', 2); makeClip(BLUE, 'blue', 2);

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED, BLUE] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function isPureRed(p) { return p.r > 200 && p.g < 40 && p.b < 40; }
function isPureBlue(p) { return p.b > 200 && p.r < 40 && p.g < 40; }
function isBlend(p) { return !isPureRed(p) && !isPureBlue(p); }

function pxAt(file, tSec, x, y) {
  const raw = path.join(TMP, `f_${path.basename(file, '.mp4')}_${tSec}_${x}_${y}.raw`);
  spawnSync(FFMPEG, ['-y', '-ss', String(tSec), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (y * W + x) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 2000 });

  section('1) 임포트(red 0~2초, blue 2~4초, 같은 트랙) + blue 를 1초 겹치게 끌기');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  let n = 0;
  for (let i = 0; i < 40; i++) { n = await js(`document.querySelectorAll('.ve-clip').length`); if (n >= 2) break; await wait(300); }
  expect('클립 2개 임포트됨', n, 2);
  await js(`(() => {
    const clip = [...document.querySelectorAll('.ve-clip')].find(el => el.querySelector('.ve-clip-lbl').textContent === 'blue.mp4');
    const r = clip.getBoundingClientRect();
    clip.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 9, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5 - 40, clientY: r.top + 5, pointerId: 9, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5 - 40, clientY: r.top + 5, pointerId: 9, bubbles: true }));
  })(); true`);
  await wait(150);
  const blueLeft = await js(`parseFloat([...document.querySelectorAll('.ve-clip')].find(el => el.querySelector('.ve-clip-lbl').textContent === 'blue.mp4').style.left)`);
  near('blue 가 1초(40px) 지점에서 시작(1초 겹침)', blueLeft, 40, 2);

  section('2) 크로스페이드 배지가 겹친 자리(1.5초=60px 근처)에 뜸');
  const badgeLeft = await js(`parseFloat(document.querySelector('.ve-xfade-badge')?.style.left || '-1')`);
  near('배지 위치가 겹침 중간(1.5초=60px)', badgeLeft, 60, 2);

  section('3) 기본값(fade)으로 내보내기 — 전환 중간엔 화면 전체가 섞인 색');
  const OUT_FADE = path.join(TMP, 'out_fade.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_FADE });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) { if (fs.existsSync(OUT_FADE) && !/%$/.test(await js(`document.getElementById('ve-export').textContent`))) break; await wait(500); }
  expect('fade 내보내기 성공', fs.existsSync(OUT_FADE), true);
  if (fs.existsSync(OUT_FADE)) {
    const left = pxAt(OUT_FADE, 1.5, 10, 120), right = pxAt(OUT_FADE, 1.5, 310, 120);
    expect('fade — 왼쪽 끝도 섞인 색(순수 빨강/파랑 아님)', isBlend(left), true);
    expect('fade — 오른쪽 끝도 섞인 색', isBlend(right), true);
  }

  section('4) 배지 눌러 "wipeleft" 로 바꾸기 — 전환 중간엔 한쪽은 안 섞인 순수한 색이어야 함');
  await js(`(() => {
    const badge = document.querySelector('.ve-xfade-badge');
    const r = badge.getBoundingClientRect();
    badge.dispatchEvent(new MouseEvent('click', { clientX: r.left, clientY: r.top, bubbles: true }));
  })(); true`);
  await wait(100);
  const hasPopover = await js(`!!document.getElementById('tr-type')`);
  expect('전환 효과 팝오버가 열림', hasPopover, true);
  await js(`(() => {
    const sel = document.getElementById('tr-type');
    sel.value = 'wipeleft';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  await wait(100);

  const OUT_WIPE = path.join(TMP, 'out_wipe.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_WIPE });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) { if (fs.existsSync(OUT_WIPE) && !/%$/.test(await js(`document.getElementById('ve-export').textContent`))) break; await wait(500); }
  expect('wipeleft 내보내기 성공', fs.existsSync(OUT_WIPE), true);
  if (fs.existsSync(OUT_WIPE)) {
    const left = pxAt(OUT_WIPE, 1.5, 10, 120), right = pxAt(OUT_WIPE, 1.5, 310, 120);
    console.log('  wipeleft 중간 지점 — 왼쪽:', JSON.stringify(left), '오른쪽:', JSON.stringify(right));
    expect('wipeleft — 최소 한쪽 끝은 순수한 색(하드 경계, fade 와 다름)', isPureRed(left) || isPureBlue(left) || isPureRed(right) || isPureBlue(right), true);
  }

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
