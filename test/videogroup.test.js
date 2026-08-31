'use strict';
// 클립 영구 그룹화 — "그룹핑은 못하나?" 요청. 다중 선택(_selClipIds)은 원래 그 자리에서
// 드래그할 때만 같이 움직이는 임시 상태였는데, 이제 "그룹" 동작(Ctrl+G, 우클릭 메뉴)으로
// manualGroupId 를 공유시켜 저장·재선택을 거쳐도 계속 같이 움직이는 진짜 그룹을 만들 수
// 있다. 그룹 중 하나만 평범하게(수식키 없이) 클릭해도 그룹 전체가 강조 표시되고, 그 상태로
// 드래그하면 전부 같이 움직인다. 그룹 해제(U, 우클릭 메뉴)와 그룹째 삭제도 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vegroup-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vegroup-'));
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
function clickWith(js, label, mods) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    el.dispatchEvent(new PointerEvent('pointerdown', { ${mods ? mods + ', ' : ''}bubbles: true, pointerId: 9 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
  })(); true`);
}
function ctrlClick(js, label) { return clickWith(js, label, 'ctrlKey: true'); }
function plainClick(js, label) { return clickWith(js, label, ''); }
function rightClickOn(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 10, clientY: r.top + 5, bubbles: true, cancelable: true }));
  })(); true`);
}
function clickMenuItem(js, label) {
  return js(`(() => {
    const b = [...document.querySelectorAll('.ve-ctxmenu-item')].find(x => x.textContent === ${JSON.stringify(label)});
    b?.click();
    return !!b;
  })()`);
}
function menuLabels(js) {
  return js(`JSON.stringify([...document.querySelectorAll('.ve-ctxmenu-item')].map(b => b.textContent))`);
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
  expect('클립 3개 임포트됨', await js(`document.querySelectorAll('.ve-clip').length`), 3);

  section('1) A, B 를 Ctrl+클릭으로 선택하고 우클릭 → "그룹" 메뉴로 묶기');
  await ctrlClick(js, 'a_red.mp4');
  await wait(60);
  await ctrlClick(js, 'b_green.mp4');
  await wait(60);
  await rightClickOn(js, 'a_red.mp4');
  await wait(80);
  const labels1 = JSON.parse(await menuLabels(js));
  expect('"그룹" 항목이 뜸(2개 이상 선택 중)', labels1.includes('그룹'), true);
  await clickMenuItem(js, '그룹');
  await wait(80);

  section('2) 다른 클립(C) 클릭 후 A 만 다시 평범하게 클릭 — 그룹 전체(A,B)가 강조 표시됨');
  await plainClick(js, 'c_blue.mp4');
  await wait(60);
  await plainClick(js, 'a_red.mp4');
  await wait(60);
  const a2 = await clipBy(js, 'a_red.mp4');
  const b2 = await clipBy(js, 'b_green.mp4');
  const c2 = await clipBy(js, 'c_blue.mp4');
  expect('A 선택됨', a2.sel, true);
  expect('그룹 짝인 B 도 같이 강조됨(수식키 없이 A 만 눌렀는데도)', b2.sel, true);
  expect('그룹 아닌 C 는 강조 안 됨', c2.sel, false);

  section('3) A 를 드래그 — B 도 같은 만큼 움직이고, C 는 그대로');
  const cLeftBefore = c2.left;
  await dragBy(js, 'a_red.mp4', 200);
  await wait(120);
  const a3 = await clipBy(js, 'a_red.mp4');
  const b3 = await clipBy(js, 'b_green.mp4');
  const c3 = await clipBy(js, 'c_blue.mp4');
  const deltaA = a3.left - a2.left, deltaB = b3.left - b2.left;
  expect('A 가 움직임', deltaA > 50, true);
  near('그룹 짝 B 도 같은 만큼 움직임', deltaB, deltaA, 2);
  expect('그룹 아닌 C 는 그대로', c3.left, cLeftBefore);

  section('4) 그룹 해제 — 우클릭 메뉴 "그룹 해제" 클릭 후엔 A 만 다시 단독 클릭됨');
  await rightClickOn(js, 'a_red.mp4');
  await wait(80);
  const labels4 = JSON.parse(await menuLabels(js));
  expect('"그룹 해제" 항목이 뜸', labels4.includes('그룹 해제'), true);
  await clickMenuItem(js, '그룹 해제');
  await wait(80);
  await plainClick(js, 'c_blue.mp4');   // 선택을 다른 데로 옮겼다가
  await wait(60);
  await plainClick(js, 'a_red.mp4');    // 다시 A 만 평범하게 클릭
  await wait(60);
  const a4 = await clipBy(js, 'a_red.mp4');
  const b4 = await clipBy(js, 'b_green.mp4');
  expect('A 만 선택됨', a4.sel, true);
  expect('그룹 해제됐으니 B 는 더 이상 같이 강조 안 됨', b4.sel, false);

  section('5) Ctrl+G 단축키로 다시 그룹 묶고, 그룹째 삭제(Delete) → undo 로 둘 다 복구');
  // 평범한 클릭으로 먼저 A 만 선택(이전 선택 상태를 확실히 정리)한 뒤 Ctrl+클릭으로 B 를
  // 더한다 — A 가 이미 선택된 채로 Ctrl+클릭하면 토글이라 오히려 빠진다.
  await plainClick(js, 'a_red.mp4');
  await wait(60);
  await ctrlClick(js, 'b_green.mp4');
  await wait(60);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true })); true`);
  await wait(80);
  await plainClick(js, 'c_blue.mp4');
  await wait(60);
  await plainClick(js, 'a_red.mp4');   // 그룹 전체 다시 선택되는지
  await wait(60);
  const b5 = await clipBy(js, 'b_green.mp4');
  expect('Ctrl+G 로 묶은 그룹도 평범한 클릭 한 번에 전체 강조됨', b5.sel, true);
  const countBefore = await js(`document.querySelectorAll('.ve-clip').length`);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); true`);
  await wait(100);
  const countAfter = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('그룹째(A,B) 삭제됨(2개 줆)', countBefore - countAfter, 2);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
  await wait(100);
  expect('undo 한 번으로 그룹 전체 복구', await js(`document.querySelectorAll('.ve-clip').length`), countBefore);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
