'use strict';
// 색보정 LUT(.cube) 효과 — "+" 효과 메뉴에서 LUT 를 고르면 파일 선택창이 뜨고, 고른
// .cube 파일이 실제 export 에 반영되는지 확인한다. 테스트용 LUT 는 "빨강 채널만
// 뒤집는다"(R→1-R) 는 아주 단순한 8꼭짓점 3D LUT — 순수 빨강(1,0,0) 클립에 적용하면
// 결과가 검정(0,0,0)이 돼야 한다(모호함 없이 확인 가능한 신호).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-velut-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-velut-'));
const RED = path.join(TMP, 'red.mp4');
const CUBE = path.join(TMP, 'invert_red.cube');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=red:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', RED], { stdio: 'ignore' });
if (!fs.existsSync(RED)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

// output(R,G,B) = (1-R, G, B) — 8꼭짓점, Adobe .cube 순서(R 먼저 변화, 그다음 G, 그다음 B).
fs.writeFileSync(CUBE, [
  'TITLE "invert red"', 'LUT_3D_SIZE 2',
  '1.0 0.0 0.0', '0.0 0.0 0.0', '1.0 1.0 0.0', '0.0 1.0 0.0',
  '1.0 0.0 1.0', '0.0 0.0 1.0', '1.0 1.0 1.0', '0.0 1.0 1.0',
].join('\n'));

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 1500 });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED] });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  expect('클립 임포트됨', await js(`document.querySelectorAll('.ve-clip').length >= 1`), true);
  await js(`(() => {
    const el = document.querySelector('.ve-clip');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 1, bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 1, bubbles: true }));
  })(); true`);
  await wait(100);

  section('1) "+" 효과 메뉴 → LUT(.cube) 선택 → 파일 선택창');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [CUBE] });
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(100);
  await js(`(() => {
    const btn = [...document.querySelectorAll('.ve-fx-add-item')].find(b => b.textContent.includes('LUT'));
    btn.click();
  })(); true`);
  for (let i = 0; i < 30; i++) { if (await js(`!!document.querySelector('.ve-fx-file-name')`)) break; await wait(200); }
  const fileLabel = await js(`document.querySelector('.ve-fx-file-name')?.textContent`);
  expect('LUT 효과가 추가되고 파일명이 표시됨', fileLabel, 'invert_red.cube');
  expect('미리보기 제한 안내문이 뜸', await js(`!!document.querySelector('.ve-fx-file-hint')`), true);

  section('2) 내보내기 — 순수 빨강이 LUT(R→1-R) 적용돼 검정으로 나옴');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) { if (fs.existsSync(OUT) && !/%$/.test(await js(`document.getElementById('ve-export').textContent`))) break; await wait(500); }
  expect('export 성공', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const raw = path.join(TMP, 'frame.raw');
    spawnSync(FFMPEG, ['-y', '-ss', '1', '-i', OUT, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
    const buf = fs.readFileSync(raw);
    const o = (120 * W + 160) * 3;
    const px = { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
    console.log('  LUT 적용 후 중앙 픽셀:', JSON.stringify(px));
    expect('빨강(1,0,0)이 LUT 로 검정(0,0,0)이 됨', px.r < 30 && px.g < 30 && px.b < 30, true);
  }

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
