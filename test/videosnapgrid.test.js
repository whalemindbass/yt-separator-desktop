'use strict';
// 그리드 스냅 토글 — "스튜디오 트랙처럼 snap to grid 기능 넣어줘 토글식으로" 요청. 영상
// 타임라인엔 스튜디오 같은 BPM/박자 개념이 없으니 고정 1초 격자를 쓴다. 기본은 꺼짐, 버튼
// (#ve-snap-grid)으로 켜고 끄면 그 뒤로 클립 드래그가 (기존 클립 경계 스냅과 별개로) 가까운
// 1초 격자선에도 붙는다. 클립을 딱 하나만 두어서(자기 자신 말고는 스냅 후보가 없다) 그리드
// 스냅 자체만 순수하게 가려낸다 — 다른 클립 경계 스냅과 섞이지 않게.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesnapgrid-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesnapgrid-'));
const A = path.join(TMP, 'a.mp4');

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:duration=3:rate=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', A], { stdio: 'ignore' });
if (!fs.existsSync(A)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [A] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function clipLeftPx(js) {
  return js(`parseFloat(document.querySelector('.ve-clip').style.left)`);
}
function dragBy(js, dxPx) {
  return js(`(() => {
    const el = document.querySelector('.ve-clip');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 10, clientY: r.top + 5, pointerId: 4, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 10 + ${dxPx}, clientY: r.top + 5, pointerId: 4, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 10 + ${dxPx}, clientY: r.top + 5, pointerId: 4, bubbles: true }));
  })(); true`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  expect('클립 1개 임포트됨', await js(`document.querySelectorAll('.ve-clip').length`), 1);

  section('1) 기본은 꺼짐');
  expect('그리드 스냅 버튼 기본 꺼짐', await js(`document.getElementById('ve-snap-grid')?.classList.contains('on')`), false);
  expect('aria-pressed 도 false', await js(`document.getElementById('ve-snap-grid')?.getAttribute('aria-pressed')`), 'false');

  section('1b) 꺼진 상태 — 0초 근처로 끌어도 안 붙음("꺼도 동작하는데?" 피드백 — 0초가 그리드와')
  // 별개로 예전부터 무조건 스냅 후보였던 게 원인이었다. 먼저 0초에서 멀리 옮겨 둔 뒤,
  // 0초 쪽으로 몇 px 만 살짝 끌어서(3px, 문턱 6px 안) 그리드가 꺼져 있으면 0초로 확 붙지
  // 않고 그 자리(3px) 그대로여야 한다.
  await dragBy(js, 100);
  await wait(80);
  await dragBy(js, -97);   // 100px → 3px 로: 0초에 아주 가깝지만(문턱 안) 그리드는 꺼짐
  await wait(80);
  near('0초 쪽으로 살짝 끌어도(3px) 그리드 꺼짐이면 안 붙고 그 자리 그대로', await clipLeftPx(js), 3, 1);

  section('2) 꺼진 상태 — 격자선(5초=200px) 근처(202px)로 드래그해도 안 붙음');
  await dragBy(js, 199);   // 3px → 202px 로(5.05초 목표) — 다른 클립이 없으니 격자 후보가 없으면 그대로 5.05초
  await wait(80);
  const leftOff = await clipLeftPx(js);
  near('그리드 꺼짐 — 정확히 200px(5.0초)로는 안 붙고 대략 202px 그대로', leftOff, 202, 1);

  section('3) 되돌리고 그리드 스냅 켜기');
  // 여기까지 드래그를 세 번 했으니(100px, -97px, 199px) 그만큼 되돌린다.
  for (let i = 0; i < 3; i++) {
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
    await wait(80);
  }
  expect('되돌리기로 0px(0초)로 복귀', await clipLeftPx(js), 0);
  await js(`document.getElementById('ve-snap-grid').click(); true`);
  await wait(60);
  expect('버튼이 켜짐 표시로 바뀜', await js(`document.getElementById('ve-snap-grid')?.classList.contains('on')`), true);
  expect('aria-pressed 도 true', await js(`document.getElementById('ve-snap-grid')?.getAttribute('aria-pressed')`), 'true');
  expect('localStorage 에도 저장됨', await js(`localStorage.getItem('yss:videoSnapGrid')`), '1');

  section('4) 켜진 상태 — 같은 202px 드래그가 이번엔 정확히 200px(5.0초) 격자선에 붙음');
  await dragBy(js, 202);
  await wait(80);
  expect('그리드 켜짐 — 정확히 200px(5.0초)로 붙음', await clipLeftPx(js), 200);

  section('5) 다시 끄면 저장값도 0으로 돌아옴');
  await js(`document.getElementById('ve-snap-grid').click(); true`);
  await wait(60);
  expect('버튼 꺼짐', await js(`document.getElementById('ve-snap-grid')?.classList.contains('on')`), false);
  expect('localStorage 값도 0', await js(`localStorage.getItem('yss:videoSnapGrid')`), '0');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
