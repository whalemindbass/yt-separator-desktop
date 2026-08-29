'use strict';
// 영상 편집 — (1) 재생선이 트랙 컨트롤(헤드) 위로 비치던 z-index 버그 수정 검증,
// (2) 눈금자 Shift+드래그/영역모드 버튼으로 내보내기 구간 지정 — 실제 export 결과 길이로 검증.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-verange2-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-verange2-'));
const RED = path.join(TMP, 'red.mp4');
const OUT = path.join(TMP, 'out.mp4');

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', RED], { stdio: 'ignore' });
if (!fs.existsSync(RED)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트(6초)');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  section('2) 재생선 z-index — 트랙 헤드(컨트롤) 밑에 있어야 함(안 비침)');
  const zPh = await js(`getComputedStyle(document.getElementById('ve-playhead')).zIndex`);
  const zHead = await js(`getComputedStyle(document.querySelector('.ve-head')).zIndex`);
  expect('재생선 z-index < 헤드 z-index', Number(zPh) < Number(zHead), true);

  section('3) 눈금자 Shift+드래그 — 내보내기 구간 지정');
  await js(`(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 80, clientY: rect.top + 10, shiftKey: true, bubbles: true, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 160, clientY: rect.top + 10, shiftKey: true, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 160, clientY: rect.top + 10, pointerId: 1 }));
  })(); true`);
  await wait(150);
  const erangeHidden = await js(`document.getElementById('ve-erange').hidden`);
  expect('구간 표시(erange) 보임', erangeHidden, false);
  // pxPerSec 기본 40 — 80px=2.0초, 160px=4.0초
  const w = await js(`parseFloat(document.getElementById('ve-erange').style.width)`);
  near('구간 폭 ≈ 80px(2초)', w, 80, 3);

  section('3b) 범위 선택 배경(eband) z-index — 트랙 헤드(컨트롤) 위로 안 덮여야 함');
  expect('eband 보임', await js(`document.getElementById('ve-eband').hidden`), false);
  const zBand = await js(`getComputedStyle(document.getElementById('ve-eband')).zIndex`);
  const zHead2 = await js(`getComputedStyle(document.querySelector('.ve-head')).zIndex`);
  expect('범위 배경 z-index < 헤드 z-index(재생선 때와 같은 버그)', Number(zBand) < Number(zHead2), true);

  section('4) 구간 있는 상태로 내보내기 — 결과물 길이가 구간(2초)만큼만');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', OUT], { encoding: 'utf-8' });
    near('결과물 길이 ≈ 2초(6초 소스인데 구간만 나감)', parseFloat((/duration=([\d.]+)/.exec(r.stdout || '') || [])[1] || 0), 2, 0.3);
  }

  section('5) 더블클릭 — 구간 해제');
  await js(`document.getElementById('ve-erange').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await wait(100);
  expect('구간 해제됨(erange 다시 숨김)', await js(`document.getElementById('ve-erange').hidden`), true);

  section('6) 영역 선택 모드 버튼 — Shift 없이도 드래그가 구간 지정으로 동작');
  await js(`document.getElementById('ve-range-mode').click(); true`);
  expect('버튼 on 상태', await js(`document.getElementById('ve-range-mode').classList.contains('on')`), true);
  await js(`(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 40, clientY: rect.top + 10, bubbles: true, pointerId: 2 }));
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 120, clientY: rect.top + 10, pointerId: 2 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: rect.left + 120, clientY: rect.top + 10, pointerId: 2 }));
  })(); true`);
  await wait(150);
  expect('Shift 없이도 구간 지정됨', await js(`document.getElementById('ve-erange').hidden`), false);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
