'use strict';
// 클립 페이드인/아웃 — 상단 코너 핸들 드래그, undo/redo, 실제 내보내기 결과물에서
// 화면 밝기(페이드=검은색으로)·음량이 클립 가장자리에서 실제로 낮아지는지 검증.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefade-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefade-'));
const SRC = path.join(TMP, 'white.mp4');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y',
  '-f', 'lavfi', '-i', `color=white:size=${W}x${H}:duration=4:rate=15`,
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=4',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function frameBrightness(file, t) {
  const raw = file + `.${t}.raw`;
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum / buf.length;   // 0(검정)~255(흰색)
}
function windowVolume(file, start, dur) {
  const r = spawnSync(FFMPEG, ['-ss', String(start), '-t', String(dur), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf-8' });
  return parseFloat((/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr || '') || [])[1] ?? '-999');
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트 + 선택');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await js(`(() => {
    document.querySelector('.ve-clip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(100);

  section('2) 페이드인 핸들 40px(=1초, pxPerSec 40) 드래그');
  await js(`(() => {
    const h = document.querySelector('.ve-fadeh.l');
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left, clientY: r.top, bubbles: true, pointerId: 2 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 40, clientY: r.top, pointerId: 2 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 40, clientY: r.top, pointerId: 2 }));
  })(); true`);
  await wait(100);
  const wIn = await js(`parseFloat(document.querySelector('.ve-fade.l').style.width)`);
  near('페이드인 폭 ≈ 40px(1초)', wIn, 40, 4);

  section('3) 페이드아웃 핸들도 40px 드래그(안쪽으로)');
  await js(`(() => {
    const h = document.querySelector('.ve-fadeh.r');
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left, clientY: r.top, bubbles: true, pointerId: 3 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left - 40, clientY: r.top, pointerId: 3 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left - 40, clientY: r.top, pointerId: 3 }));
  })(); true`);
  await wait(100);
  const wOut = await js(`parseFloat(document.querySelector('.ve-fade.r').style.width)`);
  near('페이드아웃 폭 ≈ 40px(1초)', wOut, 40, 4);

  section('4) Ctrl+Z 두 번 — 페이드가 되돌려지는가');
  await js(`(() => {
    const view = document.querySelector('.video-body');
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
  })(); true`);
  await wait(100);
  expect('페이드아웃 되돌려짐(폭 0)', await js(`parseFloat(document.querySelector('.ve-fade.r').style.width)`), 0);
  expect('페이드인 되돌려짐(폭 0)', await js(`parseFloat(document.querySelector('.ve-fade.l').style.width)`), 0);

  section('5) Ctrl+Shift+Z 두 번 — 다시 실행');
  await js(`(() => {
    const view = document.querySelector('.video-body');
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true }));
    view.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true, bubbles: true }));
  })(); true`);
  await wait(100);
  near('페이드인 다시 적용됨', await js(`parseFloat(document.querySelector('.ve-fade.l').style.width)`), 40, 4);
  near('페이드아웃 다시 적용됨', await js(`parseFloat(document.querySelector('.ve-fade.r').style.width)`), 40, 4);

  section('6) 오디오 클립(링크된 짝)에도 따로 페이드 적용 — 영상 페이드와 독립적임을 확인');
  // 영상 클립에 준 페이드는 화면 밝기만 바꾼다(오디오는 별도 트랙의 링크된 짝 클립 소관) —
  // 소리도 같이 페이드하려면 그 오디오 클립에 따로 걸어야 한다. 의도된 동작(트림과 달리
  // 페이드는 영상/오디오가 독립적 — 다른 NLE 도 마찬가지).
  await js(`(() => {
    const el = document.querySelector('.ve-lane.audio .ve-clip');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 9 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
  })(); true`);
  await wait(100);
  await js(`(() => {
    const h = document.querySelector('.ve-lane.audio .ve-fadeh.l');
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left, clientY: r.top, bubbles: true, pointerId: 10 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 40, clientY: r.top, pointerId: 10 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 40, clientY: r.top, pointerId: 10 }));
  })(); true`);
  await js(`(() => {
    const h = document.querySelector('.ve-lane.audio .ve-fadeh.r');
    const r = h.getBoundingClientRect();
    h.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left, clientY: r.top, bubbles: true, pointerId: 11 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left - 40, clientY: r.top, pointerId: 11 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left - 40, clientY: r.top, pointerId: 11 }));
  })(); true`);
  await wait(100);
  near('오디오 클립 페이드인 폭 ≈ 40px', await js(`parseFloat(document.querySelector('.ve-lane.audio .ve-fade.l').style.width)`), 40, 4);
  near('오디오 클립 페이드아웃 폭 ≈ 40px', await js(`parseFloat(document.querySelector('.ve-lane.audio .ve-fade.r').style.width)`), 40, 4);

  section('7) 내보내기 — 실제 결과물에서 가장자리가 어둡고(페이드) 조용한가(음량)');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const startB = frameBrightness(OUT, 0.1);
    const midB = frameBrightness(OUT, 2.0);
    const endB = frameBrightness(OUT, 3.9);
    expect('시작(페이드인 중)이 중간보다 훨씬 어두움', startB < midB - 60, true);
    expect('끝(페이드아웃 중)이 중간보다 훨씬 어두움', endB < midB - 60, true);

    const vStart = windowVolume(OUT, 0, 0.4);
    const vMid = windowVolume(OUT, 1.8, 0.4);
    const vEnd = windowVolume(OUT, 3.6, 0.4);
    expect('시작 음량이 중간보다 조용함', vStart < vMid - 6, true);
    expect('끝 음량이 중간보다 조용함', vEnd < vMid - 6, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
