'use strict';
// 영상 편집 탭 (Phase 1) — 트랙 추가, 임포트, 배치, 트림/분할/삭제, 재생헤드 동기화가
// 실제로 동작하는지 확인한다. 진짜 파일 대화상자는 못 띄우니(automated 환경) 스텁으로 대체하고,
// ffmpeg 로 만든 짧은 합성 mp4 두 개를 실제로 디코드시켜 duration 이 클립에 반영되는지까지 본다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { bootRenderer, expect, near, section, wait, finish, expectNoConsoleErrors, ROOT } = require('./harness');

// 색상 패턴만 다른 짧은 합성 mp4 두 개 — 실제 h264 디코드 경로(임포트 duration 읽기 ·
// 필름스트립 · 재생 미리보기)를 진짜로 태우려고 순수 WAV 합성 대신 ffmpeg 로 만든다.
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-ve-'));
const RED = path.join(TMP, 've_test_red.mp4');    // 3초
const BLUE = path.join(TMP, 've_test_blue.mp4');  // 2초
function makeClip(file, pattern, seconds) {
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `${pattern}=duration=${seconds}:size=320x240:rate=15`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(RED, 'testsrc', 3);
makeClip(BLUE, 'testsrc2', 2);

(async () => {
  const { app, js, errors } = await bootRenderer({
    stubs: { 'dialog:pickVideoFiles': () => ({ ok: true, filePaths: [RED, BLUE] }) },
  });

  section('1) 탭 진입');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  let s = await js(`({
    보임: !document.querySelector('.video-body').hidden,
    트랙0: document.querySelectorAll('.ve-lane').length,
    빈상태: !document.getElementById('ve-empty').hidden,
  })`);
  expect('영상 탭 보임', s.보임, true);
  expect('처음엔 트랙 없음', s.트랙0, 0);
  expect('빈 상태 문구 보임', s.빈상태, true);

  section('2) 트랙 추가 + 임포트(스텁 경로 2개, 실제 mp4 디코드)');
  await js(`document.getElementById('ve-add-track').click(); true`);
  await wait(100);
  s = await js(`({ 트랙수: document.querySelectorAll('.ve-lane').length })`);
  expect('트랙 1개 생김', s.트랙수, 1);

  await js(`document.getElementById('ve-import').click(); true`);
  // probeVideo 가 실제 <video> loadedmetadata 를 기다리므로 넉넉히 대기
  let clips = [];
  for (let i = 0; i < 40; i++) {
    clips = await js(`[...document.querySelectorAll('.ve-clip')].map(el => ({
      left: parseFloat(el.style.left), width: parseFloat(el.style.width),
      label: el.querySelector('.ve-clip-lbl').textContent,
    }))`);
    if (clips.length >= 2) break;
    await wait(250);
  }
  expect('클립 2개 임포트됨', clips.length, 2);
  if (clips.length >= 2) {
    expect('첫 클립 이름', clips[0].label, 've_test_red.mp4');
    expect('둘째 클립 이름', clips[1].label, 've_test_blue.mp4');
    expect('첫 클립은 0부터 시작', clips[0].left, 0);
    near('둘째 클립이 첫 클립 뒤에 이어붙음(≈3초*40px)', clips[1].left, 3 * 40, 40);
    near('첫 클립 폭 ≈ 3초', clips[0].width, 3 * 40, 40);
    near('둘째 클립 폭 ≈ 2초', clips[1].width, 2 * 40, 40);
  }

  section('3) 빈 상태 문구는 클립 생기면 숨음');
  s = await js(`({ 빈상태숨음: document.getElementById('ve-empty').hidden })`);
  expect('빈 상태 숨음', s.빈상태숨음, true);

  section('4) 두 번째 트랙 — 새 트랙은 목록 맨 위(Vegas 관례)');
  await js(`document.getElementById('ve-add-track').click(); true`);
  await wait(100);
  s = await js(`({
    트랙수: document.querySelectorAll('.ve-lane').length,
    맨위트랙에클립없음: document.querySelectorAll('.ve-lane')[0].querySelectorAll('.ve-clip').length,
  })`);
  expect('트랙 2개', s.트랙수, 2);
  expect('새 트랙은 비어있고 맨 위', s.맨위트랙에클립없음, 0);

  section('5) 클립 드래그로 이동');
  const before = clips[1];
  await js(`(() => {
    const clip = [...document.querySelectorAll('.ve-clip')].find(el => el.querySelector('.ve-clip-lbl').textContent === 've_test_blue.mp4');
    const r = clip.getBoundingClientRect();
    const down = new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 1, bubbles: true });
    clip.dispatchEvent(down);
    const move = new PointerEvent('pointermove', { clientX: r.left + 5 + 200, clientY: r.top + 5, pointerId: 1, bubbles: true });
    document.dispatchEvent(move);
    const up = new PointerEvent('pointerup', { clientX: r.left + 5 + 200, clientY: r.top + 5, pointerId: 1, bubbles: true });
    document.dispatchEvent(up);
  })(); true`);
  await wait(150);
  const afterMove = await js(`(() => {
    const clip = [...document.querySelectorAll('.ve-clip')].find(el => el.querySelector('.ve-clip-lbl').textContent === 've_test_blue.mp4');
    return parseFloat(clip.style.left);
  })()`);
  expect('드래그로 클립이 실제로 이동함', afterMove > before.left, true);

  section('6) 재생헤드 이동 + 분할(S)');
  // 재생헤드를 red 클립(0~3초) 중간으로 — 클립 자신의 rect 기준으로 정확한 뷰포트 좌표를 잰다
  await js(`(() => {
    const clip = [...document.querySelectorAll('.ve-clip')].find(el => el.querySelector('.ve-clip-lbl').textContent === 've_test_red.mp4');
    const r = clip.getBoundingClientRect();
    clip.closest('.ve-lane').querySelector('.ve-area').dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 20, clientY: r.top + 5, bubbles: true }));
    clip.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 20, clientY: r.top + 5, pointerId: 2, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 20, clientY: r.top + 5, pointerId: 2, bubbles: true }));
  })(); true`);
  await wait(80);
  const countBeforeSplit = (await js(`document.querySelectorAll('.ve-clip').length`));
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true })); true`);
  await wait(80);
  const countAfterSplit = (await js(`document.querySelectorAll('.ve-clip').length`));
  expect('S 로 클립이 둘로 나뉨', countAfterSplit, countBeforeSplit + 1);

  section('7) 삭제');
  const beforeDel = await js(`document.querySelectorAll('.ve-clip').length`);
  await js(`(() => {
    const clip = document.querySelector('.ve-clip');
    clip.dispatchEvent(new PointerEvent('pointerdown', { clientX: clip.getBoundingClientRect().left + 5, clientY: 5, pointerId: 3, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: clip.getBoundingClientRect().left + 5, clientY: 5, pointerId: 3, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  })(); true`);
  await wait(80);
  const afterDel = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('Delete 로 클립 하나 줄어듦', afterDel, beforeDel - 1);

  section('8) 되돌리기/다시 실행 (Ctrl+Z / Ctrl+Shift+Z)');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
  await wait(80);
  const afterUndo = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('Ctrl+Z 로 삭제 취소됨(클립 다시 늘어남)', afterUndo, beforeDel);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true })); true`);
  await wait(80);
  const afterRedo = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('Ctrl+Shift+Z 로 다시 삭제됨', afterRedo, afterDel);
  // 트랙 추가도 되돌릴 수 있어야 한다
  const tracksBefore = await js(`document.querySelectorAll('.ve-lane').length`);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await wait(80);
  await js(`document.getElementById('ve-undo').click(); true`);
  await wait(80);
  const tracksAfterUndo = await js(`document.querySelectorAll('.ve-lane').length`);
  expect('되돌리기 버튼으로 트랙 추가도 취소됨', tracksAfterUndo, tracksBefore);

  section('9) 콘솔 오류 없음');
  expectNoConsoleErrors(errors);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
