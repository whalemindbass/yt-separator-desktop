'use strict';
// 영상 편집 — 타임라인 마커(북마크). 클릭=재생선 이동으로 추가, 클릭=이동, 우클릭=삭제,
// Ctrl+Z 로 되돌리기, M 키로 재생선 위치에 추가, [/] 로 이전/다음 마커 이동. 순수 UI
// 동작(엔진·ffmpeg export 무관)이라 videoruler.test.js 와 같은 bootRenderer 로 가볍게.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vemarker-'));
const RED = path.join(TMP, 'red.mp4');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=320x240:rate=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', RED], { stdio: 'ignore' });

const { bootRenderer, expect, near, section, wait, finish } = require('./harness');
function toSec(tc) {
  const m = /^(\d+):(\d+)\.(\d+)$/.exec(tc || '');
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
}
function clickRulerAt(px) {
  return `(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + ${px}, clientY: rect.top + 10, bubbles: true }));
  })(); true`;
}

(async () => {
  const { app, js } = await bootRenderer({
    stubs: { 'dialog:pickVideoFiles': () => ({ ok: true, filePaths: [RED] }) },
  });

  section('1) 임포트');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) {
    if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break;
    await wait(300);
  }

  section('2) 버튼으로 마커 추가 — 재생선 위치(5.0초=200px)에 깃발이 뜸');
  await js(clickRulerAt(200));
  await wait(100);
  await js(`document.getElementById('ve-marker-add').click(); true`);
  await wait(100);
  let flags = await js(`[...document.querySelectorAll('.ve-marker-flag')].map(f => parseFloat(f.style.left))`);
  expect('깃발 1개', flags.length, 1);
  near('깃발이 200px(5.0초) 근처', flags[0], 200, 1);

  section('3) 깃발 클릭 — 그 위치로 재생선 이동');
  await js(clickRulerAt(80));   // 2.0초로 딴 데 갔다가
  await wait(100);
  await js(`document.querySelector('.ve-marker-flag').click(); true`);
  await wait(100);
  let t = await js(`document.getElementById('ve-time').textContent`);
  near('깃발 클릭 → 5.0초로 복귀', toSec(t), 5.0, 0.3);

  section('4) 우클릭 — 마커 삭제, Ctrl+Z 로 되돌리기');
  await js(`document.querySelector('.ve-marker-flag').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); true`);
  await wait(100);
  expect('우클릭 후 깃발 0개', await js(`document.querySelectorAll('.ve-marker-flag').length`), 0);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
  await wait(100);
  expect('Ctrl+Z 로 삭제 취소 — 깃발 1개로 복귀', await js(`document.querySelectorAll('.ve-marker-flag').length`), 1);

  section('5) M 키 — 재생선 위치(3.0초=120px)에 새 마커, 정렬된 순서로 그려짐');
  await js(clickRulerAt(120));
  await wait(100);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true })); true`);
  await wait(100);
  flags = await js(`[...document.querySelectorAll('.ve-marker-flag')].map(f => parseFloat(f.style.left))`);
  expect('마커 2개(3.0초·5.0초)', flags.length, 2);
  near('작은 값이 먼저(3.0초=120px) — 정렬됨', flags[0], 120, 1);
  near('큰 값이 나중(5.0초=200px)', flags[1], 200, 1);

  section('6) ]/[ — 다음/이전 마커로 이동');
  await js(clickRulerAt(0));
  await wait(100);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true })); true`);
  await wait(100);
  t = await js(`document.getElementById('ve-time').textContent`);
  near('0초에서 ] → 가장 가까운 다음 마커(3.0초)', toSec(t), 3.0, 0.3);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ']', bubbles: true })); true`);
  await wait(100);
  t = await js(`document.getElementById('ve-time').textContent`);
  near('한 번 더 ] → 5.0초', toSec(t), 5.0, 0.3);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: '[', bubbles: true })); true`);
  await wait(100);
  t = await js(`document.getElementById('ve-time').textContent`);
  near('[ → 다시 3.0초', toSec(t), 3.0, 0.3);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
