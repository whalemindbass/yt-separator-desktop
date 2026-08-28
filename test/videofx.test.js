'use strict';
// FX(대표 효과) — 흑백/세피아/블러. 색보정 팝오버에 같이 얹었다. 크로미움 실제 CSS
// grayscale()/sepia() 출력과 내 ffmpeg 행렬이 정확히 일치하는지는 별도로 검증했음(정확히
// 일치, 오차 0) — 여기서는 UI→실제 export 왕복 + 픽셀 결과가 기대와 맞는지 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefx-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefx-'));
const SRC = path.join(TMP, 'red.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=0xDC3C1E:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function framePixel(file, t) {
  const raw = file + `.${t}.raw`;
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트 + 선택 + 팝오버 열기');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await js(`(() => {
    document.querySelector('.ve-clip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(100);
  await js(`document.getElementById('ve-color').click(); true`);
  await wait(100);
  expect('팝오버에 흑백/세피아/블러 컨트롤 있음',
    await js(`!!document.getElementById('cc-bw') && !!document.getElementById('cc-sepia') && !!document.getElementById('cc-blur')`), true);

  section('2) 흑백 체크 — 미리보기 CSS filter 에 grayscale(1) 반영');
  await js(`(() => {
    const el = document.getElementById('cc-bw');
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  expect('색보정 버튼 on', await js(`document.getElementById('ve-color').classList.contains('on')`), true);
  let filt = await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.filter`);
  expect('레이어 filter 에 grayscale(1) 포함', filt.includes('grayscale(1)'), true);

  section('3) 흑백 내보내기 — 픽셀이 실제로 무채도(R=G=B, CSS 행렬과 일치)로');
  const OUT_BW = path.join(TMP, 'out_bw.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_BW });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_BW)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT_BW), true);
  if (fs.existsSync(OUT_BW)) {
    const px = framePixel(OUT_BW, 0.5);
    // 소스 0xDC3C1E=(220,60,30) → CSS grayscale(1) 실측값(별도 검증) = (92,92,92)
    near('R≈92(CSS grayscale 실측과 일치)', px.r, 92, 8);
    expect('R=G=B(무채도)', Math.abs(px.r - px.g) < 6 && Math.abs(px.g - px.b) < 6, true);
  }

  section('4) 흑백 끄고 세피아 켜기 — 내보내기 결과가 CSS sepia(1) 실측과 일치');
  await js(`(() => {
    const bw = document.getElementById('cc-bw'); bw.checked = false; bw.dispatchEvent(new Event('input', { bubbles: true }));
    const sep = document.getElementById('cc-sepia'); sep.checked = true; sep.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  filt = await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.filter`);
  expect('레이어 filter 에 sepia(1) 포함(grayscale 은 빠짐)', filt.includes('sepia(1)') && !filt.includes('grayscale'), true);

  const OUT_SEPIA = path.join(TMP, 'out_sepia.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_SEPIA });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_SEPIA)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  if (fs.existsSync(OUT_SEPIA)) {
    const px = framePixel(OUT_SEPIA, 0.5);
    // 소스 (220,60,30) → CSS sepia(1) 실측값(별도 검증) = (138,123,96)
    near('R≈138(CSS sepia 실측과 일치)', px.r, 138, 8);
    near('G≈123', px.g, 123, 8);
    near('B≈96', px.b, 96, 8);
  }

  section('5) 세피아 끄고 블러만 — 내보내기가 에러 없이 되는지(강도까지 정밀검증은 생략)');
  await js(`(() => {
    const sep = document.getElementById('cc-sepia'); sep.checked = false; sep.dispatchEvent(new Event('input', { bubbles: true }));
    const blur = document.getElementById('cc-blur'); blur.value = 10; blur.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  filt = await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.filter`);
  expect('레이어 filter 에 blur(10px) 포함', filt.includes('blur(10px)'), true);
  const OUT_BLUR = path.join(TMP, 'out_blur.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_BLUR });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_BLUR)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('블러 내보내기 파일 생김', fs.existsSync(OUT_BLUR), true);

  section('6) 초기화 — 전부 해제되고 버튼 off');
  await js(`document.getElementById('cc-reset').click(); true`);
  await wait(100);
  expect('색보정 버튼 off', await js(`document.getElementById('ve-color').classList.contains('on')`), false);
  expect('필터 비워짐', await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.filter`), '');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
