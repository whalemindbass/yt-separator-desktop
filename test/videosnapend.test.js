'use strict';
// 클립 드래그 시 "끝" 기준 스냅 — "다른 트랙 클립 끝부분과 지금 잡고 있는 클립의 끝
// 부분이 붙어야 해" 피드백. 예전엔 끄는 클립의 "시작점"만 다른 클립 경계와 비교했다 —
// 끌던 클립의 끝을 다른 트랙 클립의 끝에 맞추려는(흔한) 경우엔 시작점끼리는 전혀 안
// 가까우니 안 붙었다. 이제 시작 기준·끝 기준을 각각 모든 후보와 비교해서 더 가까운 쪽으로
// 붙는다(snapClipMove).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesnapend-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesnapend-'));
const A = path.join(TMP, 'a_red.mp4');   // 2초 — 트랙1, 옮길 클립
const B = path.join(TMP, 'b_green.mp4'); // 3초 — 트랙2, 2~5초에 고정 배치해 둘 기준 클립

function make(file, color, dur) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=320x240:duration=${dur}:rate=10`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
}
make(A, 'red', 2); make(B, 'green', 3);
if (![A, B].every(fs.existsSync)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function dragBy(js, label, dxPx) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 3, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5 + ${dxPx}, clientY: r.top + 5, pointerId: 3, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5 + ${dxPx}, clientY: r.top + 5, pointerId: 3, bubbles: true }));
  })(); true`);
}
function clipLeftPx(js, label) {
  return js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => x.querySelector('.ve-clip-lbl').textContent === ${JSON.stringify(label)});
    return parseFloat(el.style.left);
  })()`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  // 트랙2(B, green) — 2~5초 자리에 고정 배치. 먼저 만들어서 3초 길이 그대로 임포트되게 하고
  // 나중에 클립 자체를 2초 지점으로 옮겨 둔다(초기 임포트는 항상 0초에서 시작하므로).
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [B] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await dragBy(js, 'b_green.mp4', 80);   // 0초 → 2초(80px)로 옮김
  await wait(80);
  expect('B 가 2초(80px) 지점에 자리함', await clipLeftPx(js, 'b_green.mp4'), 80);

  // 트랙1(A, red) — 별도 트랙에 0초부터 배치.
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [A] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) {
    if (await js(`[...document.querySelectorAll('.ve-clip')].some(x => x.querySelector('.ve-clip-lbl').textContent === 'a_red.mp4')`)) break;
    await wait(300);
  }
  expect('A 가 0초(0px)에서 시작', await clipLeftPx(js, 'a_red.mp4'), 0);

  section('1) A(2초 길이)를 끌어 끝(3.05초)이 B 의 끝(5초)에 가깝게 — 끝끼리 붙어야 함');
  // A 의 시작을 3.05초(=122px)로 두면 끝은 5.05초 — B 의 끝(5초)과 0.05초(2px)차, 문턱(6px)
  // 안. 반면 시작(3.05초)은 B 의 시작(2초)이나 끝(5초) 어느 쪽과도 6px 문턱 밖(멀다) —
  // "시작점만 비교하던" 예전 로직이면 전혀 안 붙었을 자리다.
  await dragBy(js, 'a_red.mp4', 122);
  await wait(100);
  const leftAfter = await clipLeftPx(js, 'a_red.mp4');
  expect('A 의 시작이 정확히 120px(3.0초)로 붙음 — 끝(5.0초)이 B 의 끝에 맞춰짐', leftAfter, 120);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
