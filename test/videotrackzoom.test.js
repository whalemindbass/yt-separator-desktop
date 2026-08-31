'use strict';
// 오토 트래킹 — 추적 대상(밑그림) 영상이 PIP 로 100%보다 크게 확대(또는 이동)돼 있을 때도
// "미리보기에 보이는 대로" 정확히 따라가야 한다("영상크기 대비 100%보다 크게 확대했을 때
// 제대로 못 따라가는 현상 — 아마도 원본 크기 기준으로 위치를 잡아 따라가는 듯" 피드백).
// 예전엔 cssBox→소스 픽셀 변환이 그냥 프리뷰 전체를 원본 비율 레터박스로 가정해서, 소스
// 트랙에 PIP(확대/이동)가 걸려 있으면 그 확대를 무시하고 엉뚱한 자리를 잡았다.
//
// 배경 트랙을 2배 확대(트랙 PIP transform: x=-50%,y=-50%,w=200%,h=200%, 중심 고정)해 두고,
// 그 상태로 화면에 실제로 보이는(확대된) 빨간 상자 위치에 맞춰 추적 영역을 그린다 — 좌표
// 변환이 확대를 반영했다면 트래킹 결과(오버레이)가 정확히 그 확대된 자리 위에 와야 한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrackzoom-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrackzoom-'));
const BG = path.join(TMP, 'bg.mp4');
const OVERLAY_IMG = path.join(TMP, 'overlay.png');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240, BOX = 40;
// 원본(320x240) 안에서 상자 자리 — 중심 근처(140,100)~(180,140).
const SRC_BOX = { x: 140, y: 100 };

// 30fps(예전엔 10fps) — 내보내기가 추적 구간을 EXPORT_INTERP_HZ(30) 만큼 촘촘히 쪼개는데,
// 조각 하나가 소스 프레임 주기보다 짧으면 ffmpeg trim 이 0프레임을 내놓아 결과물이
// 어긋난다(실측 확인된 버그, videotracking.test.js 주석 참고).
const RED_BOX = path.join(TMP, 'red_box.png');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=red:size=${BOX}x${BOX}`, '-frames:v', '1', RED_BOX], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:duration=5:rate=30`, '-i', RED_BOX,
  '-filter_complex', `[0][1]overlay=${SRC_BOX.x}:${SRC_BOX.y}`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BG], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=yellow:size=30x30', '-frames:v', '1', OVERLAY_IMG], { stdio: 'ignore' });
if (!fs.existsSync(BG) || !fs.existsSync(OVERLAY_IMG)) throw new Error('ffmpeg 로 테스트 파일 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

function samplePixel(file, t, x, y) {
  const raw = file + `.${t}.${x}.${y}.raw`;
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (y * W + x) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}
const isYellow = (p) => p.r > 150 && p.g > 150 && p.b < 120;

(async () => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG] });
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 배경 임포트 후 트랙을 2배로 확대(PIP, 중심 고정)');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  await js(`document.querySelector('.ve-lane .ve-pip')?.click(); true`);
  await wait(100);
  expect('PIP 팝오버 열림', await js(`!!document.getElementById('pip-x')`), true);
  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pip-x', -50); set('pip-y', -50); set('pip-w', 200); set('pip-h', 200);
  })(); true`);
  await wait(100);
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { clientX: 2, clientY: 2, bubbles: true })); true`);   // 팝오버 닫기
  await wait(100);

  section('2) 이미지 오버레이 추가 + "+" 메뉴 → 오토 트래킹 → 화면에 실제로 보이는(확대된) 상자 자리에 영역 지정');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [OVERLAY_IMG] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="image"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }

  await js(`(() => {
    const el = document.querySelector('.ve-clip.image');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(150);
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(80);
  await js(`(() => { [...document.querySelectorAll('#ve-fx-add-menu .ve-fx-add-item')][0].click(); })(); true`);
  await wait(150);
  // 원본(140,100)-(180,140) 상자가 2배 확대(중심 고정)된 뒤 화면에 실제로 보이는 자리 —
  // x' = -0.5*320 + x*2 = x*2-160, y' = -0.5*240 + y*2 = y*2-120.
  const screenBox = {
    x0: SRC_BOX.x * 2 - 160, y0: SRC_BOX.y * 2 - 120,
    x1: (SRC_BOX.x + BOX) * 2 - 160, y1: (SRC_BOX.y + BOX) * 2 - 120,
  };
  await js(`(() => {
    const host = document.getElementById('ve-preview');
    const r = host.getBoundingClientRect();
    const sx = r.left + r.width * (${screenBox.x0} / ${W});
    const sy = r.top + r.height * (${screenBox.y0} / ${H});
    const ex = r.left + r.width * (${screenBox.x1} / ${W});
    const ey = r.top + r.height * (${screenBox.y1} / ${H});
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, bubbles: true, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: ex, clientY: ey, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: ex, clientY: ey, pointerId: 5 }));
  })(); true`);

  section('3) 분석 대기');
  for (let i = 0; i < 300; i++) {
    if (/추적 중/.test(await js(`document.querySelector('.ve-track-status')?.textContent || ''`))) break;
    await wait(400);
  }
  expect('분석 끝나면 "추적 중 (N개 지점)" 으로 바뀜', /추적 중/.test(await js(`document.querySelector('.ve-track-status')?.textContent || ''`)), true);

  section('4) 내보내기 — 오버레이가 확대된 상자의 실제(화면) 위치 위에 정확히 와야 함');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 90; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const cx = Math.round((screenBox.x0 + screenBox.x1) / 2), cy = Math.round((screenBox.y0 + screenBox.y1) / 2);
    const center = samplePixel(OUT, 0.5, cx, cy);
    const farCorner = samplePixel(OUT, 0.5, 10, 10);
    console.log(`  확대된 상자 중심(${cx},${cy}) 픽셀: r=${center.r} g=${center.g} b=${center.b}`);
    expect('확대된 상자의 실제 화면 중심에 오버레이(노란색)가 정확히 옴 — 원본 크기 기준이 아니라 화면에 보이는 대로 따라감', isYellow(center), true);
    expect('먼 구석은 오버레이가 안 덮음(전체를 덮어버리는 얼렁뚱땅 버그 아님)', isYellow(farCorner), false);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
