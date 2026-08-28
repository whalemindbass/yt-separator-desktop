'use strict';
// 효과 체인 프리셋 — 클립 A 의 체인을 이름 붙여 저장하고, 다른 클립 B 에 그대로 적용되는지,
// localStorage(전역, 프로젝트 파일 밖)에 남는지, 삭제하면 메뉴/저장소에서 지워지는지 검증.
// (효과 자체의 픽셀 정확도는 videoeffects.test.js, 패널 UI↔clip.effects[] 매핑은
// videoeffectpanel.test.js 에서 이미 검증됨 — 여긴 프리셋 저장/적용/삭제만.)

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefxpreset-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefxpreset-'));
const SRC = path.join(TMP, 'white.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y',
  '-f', 'lavfi', '-i', `color=white:size=${W}x${H}:duration=2:rate=10`,
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function selectClip(selector, pid) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: ${pid} }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${pid} }));
    return true;
  })()`;
}
// newVideoTrack() 이 새 트랙을 위로 unshift 하므로, N 번째로 임포트한 영상 클립은
// '.ve-clip:not(.audio)' 목록에서 (전체 개수 - N) 번째 인덱스로 온다 — 태그 기반
// nth-of-type 은 :not() 필터와 맞물려 예측이 안 되므로 인덱스로 직접 집는다.
function selectVideoClipByIndex(idx, pid) {
  return `(() => {
    const el = [...document.querySelectorAll('.ve-clip:not(.audio)')][${idx}];
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: ${pid} }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${pid} }));
    return true;
  })()`;
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 클립 A — 효과 2개(밝기, 세피아) 넣고 프리셋으로 저장');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  expect('클립 A 임포트됨(영상+오디오)', await js(`document.querySelectorAll('.ve-clip').length`), 2);
  expect('클립 A(영상) 선택됨', await js(selectClip('.ve-clip:not(.audio)', 1)), true);
  await wait(150);

  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(100);
  await js(`(() => { [...document.querySelectorAll('.ve-fx-add-item')].find(b => b.textContent === '밝기').click(); })(); true`);
  await wait(100);
  await js(`(() => { const s = document.querySelector('.ve-fx-row .ve-fx-slider'); s.value = 25; s.dispatchEvent(new Event('input', { bubbles: true })); })(); true`);
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(100);
  await js(`(() => { [...document.querySelectorAll('.ve-fx-add-item')].find(b => b.textContent === '세피아').click(); })(); true`);
  await wait(100);
  expect('클립 A 체인 = [밝기, 세피아]', await js(`[...document.querySelectorAll('.ve-fx-row .ve-fx-name')].map(x => x.textContent).join(',')`), '밝기,세피아');

  await js(`document.getElementById('ve-fx-preset-btn').click(); true`);
  await wait(100);
  expect('프리셋 메뉴 열림', await js(`!document.getElementById('ve-fx-preset-menu').hidden`), true);
  expect('빈 이름이면 저장 버튼 비활성', await js(`document.querySelector('.ve-fx-preset-save-row button').disabled`), true);
  await js(`(() => {
    const input = document.querySelector('.ve-fx-preset-save-row input');
    input.value = '따뜻한 세피아';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  expect('이름 입력하면 저장 버튼 활성', await js(`document.querySelector('.ve-fx-preset-save-row button').disabled`), false);
  await js(`document.querySelector('.ve-fx-preset-save-row button').click(); true`);
  await wait(100);
  expect('저장 후 메뉴 닫힘', await js(`document.getElementById('ve-fx-preset-menu').hidden`), true);

  section('2) localStorage 에 전역으로 저장됨(프로젝트 파일이 아니라)');
  const stored = JSON.parse(await js(`localStorage.getItem('ve.effectPresets')`));
  expect('프리셋 1개 저장됨', stored.length, 1);
  expect('이름 일치', stored[0].name, '따뜻한 세피아');
  expect('저장된 체인 = [brightness, sepia]', stored[0].effects.map(e => e.type).join(','), 'brightness,sepia');
  expect('밝기 값도 그대로(25)', stored[0].effects[0].value, 25);

  section('3) 클립 B(새 트랙, 빈 체인) 에 프리셋 적용');
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 4) break; await wait(300); }
  expect('클립 B 도 임포트됨(총 4개 .ve-clip)', await js(`document.querySelectorAll('.ve-clip').length`), 4);
  // newVideoTrack() 은 새 트랙을 위로 unshift 하므로, 방금 만든 클립 B(영상) 가
  // '.ve-clip:not(.audio)' 목록의 0번째로 온다.
  expect('클립 B(영상) 선택됨', await js(selectVideoClipByIndex(0, 2)), true);
  await wait(150);
  expect('클립 B 는 빈 체인으로 시작', await js(`document.querySelector('#ve-fx-body .ve-fx-empty')?.textContent`), '적용된 효과가 없습니다');

  await js(`document.getElementById('ve-fx-preset-btn').click(); true`);
  await wait(100);
  expect('프리셋 목록에 방금 저장한 게 보임', await js(`document.querySelector('.ve-fx-preset-apply')?.textContent`), '따뜻한 세피아');
  await js(`document.querySelector('.ve-fx-preset-apply').click(); true`);
  await wait(100);
  expect('클립 B 체인 = [밝기, 세피아](프리셋 그대로)', await js(`[...document.querySelectorAll('.ve-fx-row .ve-fx-name')].map(x => x.textContent).join(',')`), '밝기,세피아');
  expect('클립 B 밝기 값도 25(프리셋 그대로)', await js(`document.querySelector('.ve-fx-row .ve-fx-val')?.textContent`), '+25');

  section('4) 프리셋 삭제 — 메뉴/저장소에서 사라짐, 클립 B 체인은 그대로 남음');
  await js(`document.getElementById('ve-fx-preset-btn').click(); true`);
  await wait(100);
  await js(`document.querySelector('.ve-fx-preset-del').click(); true`);
  await wait(100);
  expect('삭제 후 목록 비어보임', await js(`document.querySelector('.ve-fx-preset-empty')?.textContent`), '저장된 프리셋이 없습니다');
  const storedAfter = JSON.parse(await js(`localStorage.getItem('ve.effectPresets')`));
  expect('localStorage 에서도 지워짐', storedAfter.length, 0);
  expect('클립 B 에 이미 적용된 효과는 그대로(프리셋 삭제와 무관)', await js(`document.querySelectorAll('.ve-fx-row').length`), 2);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
