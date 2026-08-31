'use strict';
// 클립 다중 선택 — "여러 개 선택 후 같이 움직이게 그룹화도 해줘" 요청. Ctrl/Cmd+클릭으로
// 하나씩 더하고 빼고, Shift+클릭으로 마지막 선택~지금 클릭 사이(시간 기준)를 통째로 고른
// 뒤, 그 중 아무거나 하나를 드래그하면 선택된 클립 전부가 같은 델타만큼 같이 움직여야
// 한다. Delete 도 선택된 전부를 지운다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vemulti-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vemulti-'));
const A = path.join(TMP, 'a_red.mp4');
const B = path.join(TMP, 'b_green.mp4');
const C = path.join(TMP, 'c_blue.mp4');

function make(file, color) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=320x240:duration=2:rate=10`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
}
make(A, 'red'); make(B, 'green'); make(C, 'blue');
if (![A, B, C].every(fs.existsSync)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [A, B, C] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function clipBy(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    return el ? { left: parseFloat(el.style.left), sel: el.classList.contains('sel') } : null;
  })()`);
}
function ctrlClick(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    el.dispatchEvent(new PointerEvent('pointerdown', { ctrlKey: true, bubbles: true, pointerId: 9 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
  })(); true`);
}
function shiftClick(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    el.dispatchEvent(new PointerEvent('pointerdown', { shiftKey: true, bubbles: true, pointerId: 9 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
  })(); true`);
}
function plainClick(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
  })(); true`);
}
function dragBy(js, label, dxPx) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 10, clientY: r.top + 5, pointerId: 7, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 10 + ${dxPx}, clientY: r.top + 5, pointerId: 7, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 10 + ${dxPx}, clientY: r.top + 5, pointerId: 7, bubbles: true }));
  })(); true`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 60; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 3) break; await wait(300); }
  expect('클립 3개 임포트됨(연속 배치)', await js(`document.querySelectorAll('.ve-clip').length`), 3);

  section('1) Ctrl+클릭으로 A, C 만 선택(B 는 빼고) — 둘 다 sel 표시, B 는 아님');
  await ctrlClick(js, 'a_red.mp4');
  await wait(60);
  await ctrlClick(js, 'c_blue.mp4');
  await wait(60);
  const a1 = await clipBy(js, 'a_red.mp4');
  const b1 = await clipBy(js, 'b_green.mp4');
  const c1 = await clipBy(js, 'c_blue.mp4');
  expect('A 선택됨', a1.sel, true);
  expect('B 는 선택 안 됨', b1.sel, false);
  expect('C 선택됨', c1.sel, true);

  section('2) 선택된 A 를 드래그 — A 와 C 는 같이 움직이고, 선택 안 된 B 는 그대로');
  const bLeftBefore = b1.left;
  await dragBy(js, 'a_red.mp4', 200);
  await wait(120);
  const a2 = await clipBy(js, 'a_red.mp4');
  const b2 = await clipBy(js, 'b_green.mp4');
  const c2 = await clipBy(js, 'c_blue.mp4');
  const deltaA = a2.left - a1.left, deltaC = c2.left - c1.left;
  expect('A 가 오른쪽으로 움직임', deltaA > 50, true);
  near('C 도 A 와 같은 만큼 움직임(그룹 이동)', deltaC, deltaA, 2);
  expect('선택 안 된 B 는 그대로', b2.left, bLeftBefore);

  section('3) Ctrl+클릭으로 선택 해제 — 다시 한 번 A 를 Ctrl+클릭하면 A 만 빠지고 C 는 남음');
  await ctrlClick(js, 'a_red.mp4');
  await wait(60);
  const a3 = await clipBy(js, 'a_red.mp4');
  const c3 = await clipBy(js, 'c_blue.mp4');
  expect('A 선택 해제됨', a3.sel, false);
  expect('C 는 여전히 선택됨', c3.sel, true);

  section('4) 평범한(수식키 없는) 클릭 — 다중 선택을 풀고 그 클립 하나만 선택됨');
  await plainClick(js, 'b_green.mp4');
  await wait(60);
  const a4 = await clipBy(js, 'a_red.mp4');
  const b4 = await clipBy(js, 'b_green.mp4');
  const c4 = await clipBy(js, 'c_blue.mp4');
  expect('A 는 선택 해제됨', a4.sel, false);
  expect('B 만 선택됨', b4.sel, true);
  expect('C 도 선택 해제됨', c4.sel, false);

  section('5) Shift+클릭 — 마지막 선택(B)~지금 클릭(A, C 중 하나) 사이를 통째로 선택');
  await shiftClick(js, 'c_blue.mp4');
  await wait(60);
  const a5 = await clipBy(js, 'a_red.mp4');
  const b5 = await clipBy(js, 'b_green.mp4');
  const c5 = await clipBy(js, 'c_blue.mp4');
  expect('범위 안의 A 도 선택됨', a5.sel, true);
  expect('범위 안의 B 도 선택됨', b5.sel, true);
  expect('클릭한 C 도 선택됨', c5.sel, true);

  section('6) Delete — 다중 선택된 클립 전부가 지워짐');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); true`);
  await wait(100);
  expect('클립 전부 삭제됨(0개)', await js(`document.querySelectorAll('.ve-clip').length`), 0);

  section('7) Ctrl+Z — 다중 삭제도 undo 한 번으로 전부 복구');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
  await wait(100);
  expect('undo 한 번으로 3개 다 복구', await js(`document.querySelectorAll('.ve-clip').length`), 3);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
