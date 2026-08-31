'use strict';
// 실제 UI 흐름으로 추적("오토 트래킹") 기능 검증 — 배경 영상(움직이는 사각형) 임포트 →
// 이미지 오버레이 추가 → 효과 패널 "+" 추가 메뉴에서 "오토 트래킹" 선택(기본으로 항상
// 보이는 게 아니라 이렇게 직접 추가해야만 생긴다는 요청 반영) → 미리보기 위 드래그로
// 영역 지정 → 자동 분석(시작하자마자 "분석 중…" 표시가 뜨는지도 확인 — 예전엔 처음
// 추가할 때만 이 표시가 안 뜨는 버그가 있었다) → 내보내기 결과에서 오버레이가 실제로
// 대상을 따라 움직였는지 실측한다.

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
// 걸 실측으로 확인했었다). 30fps(예전엔 10fps) — 내보내기가 추적 구간을 EXPORT_INTERP_HZ
// (30) 만큼 촘촘히 쪼개는데, 조각 하나가 소스 프레임 주기보다 짧으면 ffmpeg trim 이
// 0프레임을 내놓아 결과물이 어긋난다(실측 확인된 버그, videotracking.test.js 주석 참고).
const RED_BOX = path.join(TMP, 'red_box.png');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=40x40', '-frames:v', '1', RED_BOX], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:duration=2:rate=30`, '-i', RED_BOX,
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

  section('2) 클립 선택 — 기본으로는 오토 트래킹 섹션이 안 보임(요청대로)');
  await js(`(() => {
    const el = document.querySelector('.ve-clip.image');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(150);
  expect('선택만으론 오토 트래킹 섹션 안 뜸', await js(`!document.querySelector('.ve-track-start-btn')`), true);

  section('2b) "+" 효과 추가 메뉴에서 "오토 트래킹" 선택 — 골라야만 그리기 모드로 들어감');
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(80);
  // .ve-fx-add-item 클래스는 "+트랙" 메뉴(#ve-add-track-menu)도 같이 쓴다 — 반드시
  // #ve-fx-add-menu 안으로 좁혀서 찾는다.
  const trackItemLabel = await js(`(() => {
    const items = [...document.querySelectorAll('#ve-fx-add-menu .ve-fx-add-item')];
    return items[0]?.textContent;
  })()`);
  expect('메뉴 맨 위가 오토 트래킹 항목', trackItemLabel, '오토 트래킹');
  await js(`(() => { [...document.querySelectorAll('#ve-fx-add-menu .ve-fx-add-item')][0].click(); })(); true`);
  await wait(150);

  section('3) 미리보기에서 드래그로 영역 지정 — 지정하는 동안엔 그 오버레이 이미지 자신이 안 보여야 함(가려서 거슬린다는 피드백)');
  // pointerdown+move 까지만 먼저 보내고(놓지 않은 채) 중간 상태를 확인한다 — 한 js() 호출
  // 안에서 down/move/up 을 다 보내버리면 테스트 쪽에서 "드래그 도중" 시점을 볼 수 없다.
  await js(`(() => {
    const host = document.getElementById('ve-preview');
    const r = host.getBoundingClientRect();
    // 시작 시각(t=0) 빨간 사각형은 (20,20,40x40) 근처 — 미리보기 좌표로 환산해 그 자리에 드래그.
    const sx = r.left + r.width * (20 / ${W});
    const sy = r.top + r.height * (20 / ${H});
    window.__dragEnd = { x: r.left + r.width * (65 / ${W}), y: r.top + r.height * (65 / ${H}) };
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, bubbles: true, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: window.__dragEnd.x, clientY: window.__dragEnd.y, pointerId: 5 }));
  })(); true`);
  await wait(60);
  const overlayHiddenMidDrag = await js(`(() => {
    const img = document.querySelector('.ve-video-layers .ve-layer-slot img:not([hidden])');
    return img?.closest('.ve-layer-slot')?.style.visibility === 'hidden';
  })()`);
  expect('드래그 도중엔 오버레이 이미지 레이어가 숨겨짐', overlayHiddenMidDrag, true);
  await js(`document.dispatchEvent(new PointerEvent('pointerup', { clientX: window.__dragEnd.x, clientY: window.__dragEnd.y, pointerId: 5 })); true`);
  await wait(60);
  const overlayVisibleAfterDrag = await js(`(() => {
    const img = document.querySelector('.ve-video-layers .ve-layer-slot img:not([hidden])');
    return img?.closest('.ve-layer-slot')?.style.visibility !== 'hidden';
  })()`);
  expect('드래그(영역 지정) 끝나면 다시 보임', overlayVisibleAfterDrag, true);

  section('4) "분석 중…" 표시가 처음 추가하는 이번에도 바로 뜨는지(버그였던 부분)');
  const analyzingText = await js(`document.querySelector('.ve-track-status')?.textContent || ''`);
  expect('처음 추가하는 이번에도 분석 시작과 동시에 "분석 중…" 표시가 뜸(예전엔 안 떴다)', /분석 중/.test(analyzingText), true);
  expect('다시 지정/해제 버튼은 분석 중엔 비활성', await js(`document.querySelector('.ve-track-start-btn')?.disabled`), true);

  section('5) 자동 분석 완료 대기 — "분석 중…" 표시가 "추적 중 (N개 지점)" 으로 바뀔 때까지');
  // 프레임 seek(디코드) 자체가 느려진 촘촘한 샘플 간격(0.1초) 탓에 시간이 걸린다(실측) —
  // 기본 5초 클립이면 대략 50개 샘플, 넉넉히 60초까지 기다린다.
  for (let i = 0; i < 150; i++) {
    if (/추적 중/.test(await js(`document.querySelector('.ve-track-status')?.textContent || ''`))) break;
    await wait(400);
  }
  const finalStatus = await js(`document.querySelector('.ve-track-status')?.textContent || ''`);
  expect('분석 끝나면 "추적 중 (N개 지점)" 으로 바뀜', /추적 중/.test(finalStatus), true);
  const kfCount = Number((finalStatus.match(/\d+/) || [0])[0]);
  expect('키프레임이 여러 개 쌓임', kfCount >= 2, true);

  section('6) 내보내기 — 오버레이가 실제로 대상(빨간 사각형)을 따라 움직였는지');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    // 트래커가 이상적인 궤적을 정확히 따르진 않는다(격자 탐색이라 약간 어긋남) — 실제
    // 대상(빨간 사각형, x='20+t*110':y='20+t*70', 40x40)의 그 시각 중심 좌표를 잡는다
    // (탐색 반경/촘촘함이 바뀌면 트래커의 정확한 오차까지 매번 달라지니, 매직넘버로
    // 실측값을 박아두는 대신 원래 목표의 중심을 기준으로 넉넉히 잡는 쪽이 더 안정적이다).
    const start = samplePixel(OUT, 0.1, Math.round(20 + 0.1 * 110 + 20), Math.round(20 + 0.1 * 70 + 20));
    const end = samplePixel(OUT, 1.7, Math.round(20 + 1.7 * 110 + 20), Math.round(20 + 1.7 * 70 + 20));
    expect('시작 시점 근처에 오버레이(노랑) 있음', isYellowish(start), true);
    expect('끝 시점 근처에도 오버레이(노랑) 있음(따라 움직임)', isYellowish(end), true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
