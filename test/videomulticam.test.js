'use strict';
// 멀티캠 — 같은 순간을 찍은 서로 다른 각도(클립) 2개 이상을 선택해 "멀티캠으로 묶기" 하면
// 클립 하나(각도 전환은 하드컷)로 합쳐지는지, 재생선 위치에서 각도 버튼을 누르면 그
// 시각부터 각도가 바뀌는 컷이 들어가는지, 그리고 export 결과가 실제로 그 컷 경계에서
// 각도가 바뀌는지(빨강→파랑) 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vemc-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vemc-'));
const RED = path.join(TMP, 'red.mp4');    // 각도 1 — 2초
const BLUE = path.join(TMP, 'blue.mp4');  // 각도 2 — 2초
const W = 320, H = 240;
function makeClip(file, color, seconds) {
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=${W}x${H}:duration=${seconds}:rate=15`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(RED, 'red', 2); makeClip(BLUE, 'blue', 2);

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function isPureRed(p) { return p.r > 200 && p.g < 40 && p.b < 40; }
function isPureBlue(p) { return p.b > 200 && p.r < 40 && p.g < 40; }
function pxAt(file, tSec) {
  const raw = path.join(TMP, `f_${path.basename(file, '.mp4')}_${tSec}.raw`);
  spawnSync(FFMPEG, ['-y', '-ss', String(tSec), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (120 * W + 160) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}
function clickClip(label, opts) {
  return `(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl')?.textContent === '${label}');
    const r = el.getBoundingClientRect();
    const init = { clientX: r.left + 5, clientY: r.top + 5, pointerId: 3, bubbles: true, ctrlKey: ${!!opts?.ctrl} };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    ${opts?.ctrl ? '' : "el.dispatchEvent(new PointerEvent('pointerup', init));"}
  })(); true`;
}

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 2000 });

  section('1) 각도 2개를 서로 다른 트랙에, 같은 시작(0초)으로 임포트');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BLUE] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  let n = 0;
  for (let i = 0; i < 40; i++) { n = await js(`document.querySelectorAll('.ve-clip').length`); if (n >= 2) break; await wait(300); }
  expect('클립 2개(각도 2개) 임포트됨', n, 2);
  const redLeft = await js(`parseFloat([...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === 'red.mp4').style.left)`);
  const blueLeft = await js(`parseFloat([...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === 'blue.mp4').style.left)`);
  expect('두 각도 다 0초에서 시작(같은 트랙 아님, 겹치는 클립)', redLeft === 0 && blueLeft === 0, true);

  section('2) 둘 다 선택 → 우클릭 → "멀티캠으로 묶기"');
  await js(clickClip('red.mp4'));
  await wait(80);
  await js(clickClip('blue.mp4', { ctrl: true }));
  await wait(80);
  await js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl')?.textContent === 'blue.mp4');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true, cancelable: true }));
  })(); true`);
  await wait(100);
  const hasMcItem = await js(`!![...document.querySelectorAll('.ve-ctxmenu-item')].find(b => b.textContent.includes('멀티캠'))`);
  expect('컨텍스트 메뉴에 "멀티캠으로 묶기" 항목이 있음', hasMcItem, true);
  await js(`[...document.querySelectorAll('.ve-ctxmenu-item')].find(b => b.textContent.includes('멀티캠')).click(); true`);
  await wait(100);

  const total = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('클립 2개가 멀티캠 클립 1개로 합쳐짐', total, 1);
  const mcClass = await js(`document.querySelector('.ve-clip')?.classList.contains('multicam')`);
  expect('합쳐진 클립이 multicam 클래스를 가짐', mcClass, true);
  const badge = await js(`document.querySelector('.ve-mc-badge')?.textContent`);
  expect('각도 배지가 2개를 표시', badge, 'CAM 2');
  const angleBtns = await js(`document.querySelectorAll('.ve-mc-angle-btn').length`);
  expect('효과 패널에 각도 버튼 2개', angleBtns, 2);

  section('3) 재생선을 1초로 옮기고 각도 버튼 "2" 눌러 컷 삽입');
  await js(`(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 40, clientY: rect.top + 10, bubbles: true }));
  })(); true`);
  await wait(150);
  await js(`document.querySelector('.ve-mc-angle-btn[data-i="1"]').click(); true`);
  await wait(100);
  const cutTicks = await js(`document.querySelectorAll('.ve-mc-cut').length`);
  expect('타임라인 위에 컷 눈금 1개가 생김', cutTicks, 1);

  section('4) 내보내기 — 0.5초는 각도1(빨강), 1.5초는 각도2(파랑)여야 함');
  const OUT = path.join(TMP, 'out.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) { if (fs.existsSync(OUT) && !/%$/.test(await js(`document.getElementById('ve-export').textContent`))) break; await wait(500); }
  expect('export 성공', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const before = pxAt(OUT, 0.5), after = pxAt(OUT, 1.5);
    console.log('  컷 전(0.5초):', JSON.stringify(before), '컷 후(1.5초):', JSON.stringify(after));
    expect('컷 전(0.5초) — 각도1(빨강)', isPureRed(before), true);
    expect('컷 후(1.5초) — 각도2(파랑)', isPureBlue(after), true);
  }

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
