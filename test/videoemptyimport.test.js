'use strict';
// 빈 상태(#ve-empty) 안내 위 "임포트" 버튼(#ve-empty-import) — 실제 마우스 클릭으로도 눌려야
// 한다. 예전엔 .click() 으로만 확인했는데(요소를 직접 지목해 호출하니 화면 배치와 무관하게
// 항상 성공한다), 실제로는 그 자리를 진짜 클릭하면 안쪽 .ve-video-layers(z-index:1 —
// #ve-preview 자체는 z-index 가 없어 별도 스태킹 컨텍스트를 안 만드니 그 값이 그대로 위
// 계층까지 올라와 z-index 없는 #ve-empty 를 덮어버렸다)가 클릭을 가로채 버튼까지 도달하지
// 못했다(실측 확인 — elementFromPoint 로 그 좌표를 찍어 보면 버튼이 아니라 그 레이어가
// 나왔다). #ve-empty 에 z-index:2 를 줘서 고쳤다. .click() 이 아니라 elementFromPoint 로
// 실제 클릭 대상을 찾은 뒤 그 요소에 이벤트를 보내는 방식으로 검증해야 이 버그를 잡아낸다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veemptyimport-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veemptyimport-'));
const BG = path.join(TMP, 'bg.mp4');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=black:size=320x240:duration=1:rate=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BG], { stdio: 'ignore' });
if (!fs.existsSync(BG)) throw new Error('ffmpeg 로 테스트 파일 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 영상 탭 첫 진입 — 시험 기능 안내 모달이 뜨고, 닫으면 빈 상태가 보임');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(400);
  expect('안내 모달이 뜸(최초 1회)', await js(`document.getElementById('ve-modal')?.hidden`), false);
  await js(`document.querySelector('#ve-modal .x')?.click(); true`);
  await wait(150);
  expect('닫으면 모달이 사라짐', await js(`document.getElementById('ve-modal')?.hidden`), true);
  expect('빈 상태 안내가 보임', await js(`document.getElementById('ve-empty')?.hidden`), false);

  section('2) #ve-empty-import 를 실제 화면 좌표로 진짜 클릭(요소를 직접 지목해 부르는 .click() 이 아님)');
  const hit = await js(`(() => {
    const btn = document.getElementById('ve-empty-import');
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const el = document.elementFromPoint(cx, cy);
    return { cx, cy, hitsButton: el === btn || btn.contains(el) };
  })()`);
  expect('그 좌표를 실제로 찍으면 버튼(또는 그 안쪽)이 맞음 — z-index 버그면 .ve-video-layers 가 대신 나옴', hit.hitsButton, true);

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG] });
  await js(`(() => {
    const btn = document.getElementById('ve-empty-import');
    const r = btn.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const el = document.elementFromPoint(cx, cy);
    el.dispatchEvent(new PointerEvent('pointerdown', { clientX: cx, clientY: cy, bubbles: true, pointerId: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('click', { clientX: cx, clientY: cy, bubbles: true }));
  })(); true`);
  await wait(100);
  section('3) 영상/오디오 중 고르는 메뉴가 뜸 — "영상" 선택하면 그제야 다이얼로그가 열림');
  expect('임포트 메뉴가 뜸', await js(`document.getElementById('ve-empty-import-menu')?.hidden`), false);
  await js(`document.querySelector('#ve-empty-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  expect('실제 클릭으로 임포트 다이얼로그가 열리고 클립이 생김', await js(`document.querySelectorAll('.ve-clip').length`) >= 1, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
