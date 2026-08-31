'use strict';
// 클립 드래그 이동량 배지 — "클립 움직일 때 몇 초 이동했는지 커서 위치에 보여주도록 해"
// 요청. 스튜디오 오디오 타임라인에 이미 있던 것과 같은 생김새(.daw-drag-badge, +M:SS.cc
// 표기)를 그대로 써서 커서를 따라다니며 뜬다 — 드래그 중에만 보이고 손을 떼면 사라진다.
// 단일 클립 드래그와 그룹(다중 선택) 드래그 둘 다 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vedragbadge-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vedragbadge-'));
const A = path.join(TMP, 'a_red.mp4');
const B = path.join(TMP, 'b_green.mp4');

function make(file, color) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=320x240:duration=2:rate=10`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
}
make(A, 'red'); make(B, 'green');
if (![A, B].every(fs.existsSync)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [A, B] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function clipEl(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top };
  })()`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 60; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  expect('클립 2개 임포트됨', await js(`document.querySelectorAll('.ve-clip').length`), 2);

  section('1) 드래그 시작 전엔 배지가 없음');
  expect('배지 없음', await js(`!!document.getElementById('ve-drag-badge')`), false);

  section('2) 단일 클립을 오른쪽으로 200px(=5초, 40px/초) 드래그 — 배지가 "+0:05.00" 을 보여줌');
  const r1 = await clipEl(js, 'a_red.mp4');
  await js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === 'a_red.mp4');
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: ${r1.left + 10}, clientY: ${r1.top + 5}, pointerId: 5, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${r1.left + 10 + 200}, clientY: ${r1.top + 5}, pointerId: 5, bubbles: true }));
  })(); true`);
  await wait(60);
  const badgeText = await js(`document.getElementById('ve-drag-badge')?.textContent`);
  expect('드래그 중 배지가 뜸', !!badgeText, true);
  expect('배지 내용이 이동량(+0:05.00)을 보여줌', badgeText, '+0:05.00');
  const badgePos = await js(`(() => { const b = document.getElementById('ve-drag-badge'); return { left: parseFloat(b.style.left), top: parseFloat(b.style.top) }; })()`);
  expect('배지가 커서 근처(오른쪽)에 자리함', badgePos.left > (r1.left + 200), true);

  await js(`document.dispatchEvent(new PointerEvent('pointerup', { clientX: ${r1.left + 10 + 200}, clientY: ${r1.top + 5}, pointerId: 5, bubbles: true })); true`);
  await wait(80);
  section('3) 손을 떼면 배지가 사라짐');
  expect('배지 사라짐', await js(`!!document.getElementById('ve-drag-badge')`), false);

  section('4) 그룹(다중 선택) 드래그에서도 배지가 뜬다');
  await js(`(() => {
    const a = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === 'a_red.mp4');
    const b = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === 'b_green.mp4');
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8 }));
    b.dispatchEvent(new PointerEvent('pointerdown', { ctrlKey: true, bubbles: true, pointerId: 8 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 8 }));
  })(); true`);
  await wait(80);
  const r2 = await clipEl(js, 'a_red.mp4');
  await js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === 'a_red.mp4');
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: ${r2.left + 10}, clientY: ${r2.top + 5}, pointerId: 6, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: ${r2.left + 10 + 80}, clientY: ${r2.top + 5}, pointerId: 6, bubbles: true }));
  })(); true`);
  await wait(60);
  const groupBadge = await js(`document.getElementById('ve-drag-badge')?.textContent`);
  expect('그룹 드래그 중에도 배지가 뜸(+0:02.00)', groupBadge, '+0:02.00');
  await js(`document.dispatchEvent(new PointerEvent('pointerup', { pointerId: 6, bubbles: true })); true`);
  await wait(80);
  expect('그룹 드래그 끝나면 배지도 사라짐', await js(`!!document.getElementById('ve-drag-badge')`), false);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
