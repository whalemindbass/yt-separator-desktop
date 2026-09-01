'use strict';
// 립플 삭제(Shift+Delete) — 같은 트랙에서 클립을 지우면 뒤 클립들이 그 자리만큼 당겨져
// 빈 자리가 안 남아야 한다. 평범한 삭제(Delete, Shift 없이)는 그대로 자리를 비워 둬야
// 한다(기존 동작 유지 확인, 둘을 대조).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veripple-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veripple-'));
const A = path.join(TMP, 'a_red.mp4');     // 2초
const B = path.join(TMP, 'b_green.mp4');   // 3초

function make(file, color, dur) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=320x240:duration=${dur}:rate=10`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
}
make(A, 'red', 2); make(B, 'green', 3);
if (![A, B].every(fs.existsSync)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

function dragBy(js, label, dxPx) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 3, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5 + ${dxPx}, clientY: r.top + 5, pointerId: 3, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5 + ${dxPx}, clientY: r.top + 5, pointerId: 3, bubbles: true }));
  })(); true`);
}
// 임포트는 항상 새 트랙을 만든다(빈 트랙이 없으면) — 그래서 B 를 A 와 "같은 트랙"에
// 두려면(립플이 트랙 단위라 이게 필요) 가로 위치뿐 아니라 세로로도 A 의 레인 위까지
// 끌어다 놔야 한다(실제 사용자가 "다른 트랙에 있던 클립을 끌어와 합친다" 할 때와 동일).
function dragOntoTrack(js, label, dxPx, ontoLabel) {
  return js(`(() => {
    const find = (l) => [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === l);
    const el = find(${JSON.stringify(label)});
    const target = find(${JSON.stringify(ontoLabel)});
    const r = el.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 3, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5 + ${dxPx}, clientY: tr.top + 5, pointerId: 3, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5 + ${dxPx}, clientY: tr.top + 5, pointerId: 3, bubbles: true }));
  })(); true`);
}
function clipLeftPx(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    return el ? parseFloat(el.style.left) : null;
  })()`);
}
function clickClip(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: el.getBoundingClientRect().left + 5, clientY: 5, bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { clientX: el.getBoundingClientRect().left + 5, clientY: 5, bubbles: true }));
  })(); true`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [A] });
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  expect('A 가 0초(0px)에서 시작', await clipLeftPx(js, 'a_red.mp4'), 0);

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [B] });
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  // 임포트가 만든 B 의 새 트랙을 없애고 A 의 트랙으로 옮긴다 — 세로로 A 의 레인까지,
  // 가로로 A 바로 뒤(2.0초=80px)까지 한 번의 드래그로.
  await dragOntoTrack(js, 'b_green.mp4', 80, 'a_red.mp4');
  await wait(80);
  const dbg = await js(`[...document.querySelectorAll('.ve-clip')].map(x => ({ label: x.querySelector('.ve-clip-lbl').textContent, left: x.style.left, lane: x.closest('.ve-lane')?.dataset.trackId }))`);
  expect('A/B 가 같은 트랙에 있음', dbg[0].lane === dbg[1].lane, true);
  expect('B 가 A 바로 뒤(80px=2.0초)에 붙어 있음', await clipLeftPx(js, 'b_green.mp4'), 80);

  section('1) A 선택 후 Shift+Delete(립플 삭제) — B 가 0px 로 당겨져야 함');
  await clickClip(js, 'a_red.mp4');
  await wait(80);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', shiftKey: true, bubbles: true })); true`);
  await wait(100);
  expect('A 사라짐', await js(`document.querySelectorAll('.ve-clip').length`), 1);
  expect('B 가 0px(0초)로 당겨짐 — 빈 자리 없음', await clipLeftPx(js, 'b_green.mp4'), 0);

  section('2) Ctrl+Z — A 도 되돌아오고 B 위치도 원래(80px)로 복귀');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
  await wait(100);
  expect('클립 2개로 복귀', await js(`document.querySelectorAll('.ve-clip').length`), 2);
  expect('B 위치도 80px 로 복귀', await clipLeftPx(js, 'b_green.mp4'), 80);

  section('3) 대조 — A 선택 후 평범한 Delete(Shift 없이)는 B 를 안 당김(빈 자리 남음)');
  await clickClip(js, 'a_red.mp4');
  await wait(80);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); true`);
  await wait(100);
  expect('A 사라짐', await js(`document.querySelectorAll('.ve-clip').length`), 1);
  expect('B 는 그대로 80px — 립플 아니니 안 당겨짐', await clipLeftPx(js, 'b_green.mp4'), 80);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
