'use strict';
// 실제 UI 흐름으로 추적 기능 검증 — 배경 영상(움직이는 사각형) 임포트 → 이미지 오버레이
// 추가 → 효과 패널의 "추적할 영역 지정" → 미리보기 위 드래그로 영역 지정 → 자동 분석 →
// 내보내기 결과에서 오버레이가 실제로 대상을 따라 움직였는지 실측한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrackui-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrackui-'));
const BG = path.join(TMP, 'bg.mp4');
const OVERLAY_IMG = path.join(TMP, 'overlay.png');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

// 검정 배경 위, 빨간 40x40 사각형이 좌상단→우하단으로 2초에 걸쳐 이동(overlay 필터, 시간
// 표현식 지원이 확실한 필터라 drawbox 대신 이걸 쓴다 — 세션 중 drawbox 는 t 변수를 못 받는
// 걸 실측으로 확인했었다).
const RED_BOX = path.join(TMP, 'red_box.png');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=40x40', '-frames:v', '1', RED_BOX], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:duration=2:rate=10`, '-i', RED_BOX,
  '-filter_complex', `[0][1]overlay=x='20+t*110':y='20+t*70'`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BG], { stdio: 'ignore' });
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
const isYellowish = (p) => p.r > 150 && p.g > 150 && p.b < 120;

(async () => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG] });
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 배경(움직이는 빨간 사각형) 임포트 + 이미지 오버레이 추가');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [OVERLAY_IMG] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="image"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }

  section('2) 클립 선택 → 효과 패널의 "추적할 영역 지정" 버튼');
  await js(`(() => {
    const el = document.querySelector('.ve-clip.image');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(150);
  expect('따라다니기 섹션이 보임', await js(`!!document.querySelector('.ve-track-start-btn')`), true);

  section('3) 미리보기에서 드래그로 영역 지정 → 자동 분석 대기 → 완료 확인');
  await js(`document.querySelector('.ve-track-start-btn').click(); true`);
  await wait(150);
  await js(`(() => {
    const host = document.getElementById('ve-preview');
    const r = host.getBoundingClientRect();
    // 시작 시각(t=0) 빨간 사각형은 (20,20,40x40) 근처 — 미리보기 좌표로 환산해 그 자리에 드래그.
    const sx = r.left + r.width * (20 / ${W});
    const sy = r.top + r.height * (20 / ${H});
    const ex = r.left + r.width * (65 / ${W});
    const ey = r.top + r.height * (65 / ${H});
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, bubbles: true, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: ex, clientY: ey, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: ex, clientY: ey, pointerId: 5 }));
  })(); true`);
  // 프레임 seek(디코드) 자체가 느려서 샘플당 0.3~0.8초 걸린다(실측) — 기본 5초 클립이면
  // 0.3초 간격으로 17개 샘플, 넉넉히 40초까지 기다린다.
  for (let i = 0; i < 100; i++) {
    if (await js(`!!document.querySelector('.ve-track-status')`)) break;
    await wait(400);
  }
  expect('추적 완료 후 상태 표시가 뜸', await js(`!!document.querySelector('.ve-track-status')`), true);
  const kfCount = await js(`(() => {
    const m = document.querySelector('.ve-track-status')?.textContent.match(/\\d+/);
    return m ? Number(m[0]) : 0;
  })()`);
  expect('키프레임이 여러 개 쌓임', kfCount >= 2, true);

  section('4) 내보내기 — 오버레이가 실제로 대상(빨간 사각형)을 따라 움직였는지');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    // 트래커가 이상적인 궤적을 정확히 따르진 않는다(격자 탐색이라 약간 어긋남) — 실측한
    // 실제 추적 결과 기준으로 넉넉히 중앙 근처를 잡는다.
    const start = samplePixel(OUT, 0.1, 45, 45);
    const end = samplePixel(OUT, 1.7, 195, 155);
    expect('시작 시점 근처에 오버레이(노랑) 있음', isYellowish(start), true);
    expect('끝 시점 근처에도 오버레이(노랑) 있음(따라 움직임)', isYellowish(end), true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
