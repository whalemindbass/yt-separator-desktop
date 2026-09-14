'use strict';
// 미리보기와 내보내기 결과 일치성(총점검) — 트랜지션 종류(wipeleft 등)를 골라도 예전엔
// 미리보기가 항상 똑같은 단순 크로스페이드만 보여줬다(내보내기만 실제 모양이 반영됐다,
// videotransition.test.js 가 그건 이미 검증). 이제 미리보기도 겹치는 두 클립의 레이어에
// clip-path 를 걸어 하드 엣지로 갈라 보여주는지 — 겹침 구간 중간(mix=0.5)에 뒤 클립
// (b 레이어)의 clip-path 가 절반만 드러나는 형태인지, 겹침이 끝난 뒤(mix=1, 트랜지션
// 없는 단일 클립 구간)엔 clip-path 가 다시 비는지 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetranspv-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetranspv-'));
const RED = path.join(TMP, 'red.mp4');
const BLUE = path.join(TMP, 'blue.mp4');
const W = 320, H = 240;
function makeClip(file, color, seconds) {
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=${W}x${H}:duration=${seconds}:rate=15`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(RED, 'red', 2); makeClip(BLUE, 'blue', 2);

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED, BLUE] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function seekViaRuler(js, sec, pxPerSec) {
  return js(`(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', { clientX: rect.left + ${sec} * ${pxPerSec}, clientY: rect.top + 5, bubbles: true });
    ruler.dispatchEvent(ev);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  })(); true`);
}

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 2000 });

  section('1) 임포트 + blue 를 red 트랙으로 끌어와 1초 겹치게(videotransition.test.js 와 같은 픽스처)');
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
    const redClip = [...document.querySelectorAll('.ve-clip')].find(el => el.querySelector('.ve-clip-lbl').textContent === 'red.mp4');
    const r = clip.getBoundingClientRect();
    const redY = redClip.getBoundingClientRect().top + 5;
    const targetLeft = 40;
    const curLeft = parseFloat(clip.style.left) || 0;
    const dx = targetLeft - curLeft;
    clip.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 9, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5 + dx, clientY: redY, pointerId: 9, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5 + dx, clientY: redY, pointerId: 9, bubbles: true }));
  })(); true`);
  await wait(150);
  const blueLeft = await js(`parseFloat([...document.querySelectorAll('.ve-clip')].find(el => el.querySelector('.ve-clip-lbl').textContent === 'blue.mp4').style.left)`);
  near('blue 가 1초(40px) 지점에서 시작(1초 겹침)', blueLeft, 40, 2);

  section('2) 배지 눌러 wipeleft 선택');
  await js(`(() => {
    const badge = document.querySelector('.ve-xfade-badge');
    const r = badge.getBoundingClientRect();
    badge.dispatchEvent(new MouseEvent('click', { clientX: r.left, clientY: r.top, bubbles: true }));
  })(); true`);
  await wait(100);
  await js(`(() => {
    const sel = document.getElementById('tr-type');
    sel.value = 'wipeleft';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  await wait(100);

  section('3) 겹침 중간(1.5초, mix=0.5)으로 재생선 이동 — b 레이어가 절반만 드러나야 함');
  await seekViaRuler(js, 1.5, 40);
  await wait(200);
  const clipPathMid = await js(`document.querySelectorAll('.ve-video-layers .ve-layer-slot')[1].style.clipPath`);
  console.log('  mix=0.5 시점 b 레이어 clip-path:', clipPathMid);
  const m = /inset\(0(?:px)? 0(?:px)? 0(?:px)? ([\d.]+)%\)/.exec(clipPathMid);
  expect('wipeleft — clip-path 형태(inset, 왼쪽만 잘림)', !!m, true);
  if (m) near('mix=0.5 — 왼쪽 절반(50%) 가려짐(inset 왼쪽 = (1-mix)*100)', Number(m[1]), 50, 1);

  section('4) 겹침 시작 직후(1.05초, mix≈0.05) — b 레이어 거의 다 가려짐(inset 왼쪽 ≈95%)');
  await seekViaRuler(js, 1.05, 40);
  await wait(200);
  const clipPathStart = await js(`document.querySelectorAll('.ve-video-layers .ve-layer-slot')[1].style.clipPath`);
  const m0 = /inset\(0(?:px)? 0(?:px)? 0(?:px)? ([\d.]+)%\)/.exec(clipPathStart);
  if (m0) near('mix≈0.05 — 거의 다 가려짐(inset 왼쪽 ≈95%)', Number(m0[1]), 95, 3);
  else expect('mix≈0.05 — clip-path 존재', !!m0, true);

  section('5) 겹침이 끝난 뒤(3초, 단일 클립 구간) — clip-path 가 다시 비어야 함');
  await seekViaRuler(js, 3, 40);
  await wait(200);
  const clipPathAfter = await js(`document.querySelectorAll('.ve-video-layers .ve-layer-slot')[0].style.clipPath`);
  expect('트랜지션 끝난 뒤엔 clip-path 없음(다음 재사용 때 안 남아있음)', clipPathAfter, '');

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
