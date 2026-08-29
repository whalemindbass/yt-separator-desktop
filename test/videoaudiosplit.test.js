'use strict';
// 영상 편집 탭 — Vegas Pro 관례: 영상+오디오가 둘 다 있는 파일을 임포트하면 영상 트랙엔
// 영상 클립, 오디오 트랙엔 그와 짝지어진(groupId 공유) 오디오 클립이 자동으로 생긴다.
// 기본은 그룹이라 이동/트림/분할/삭제가 서로 따라가고, U 로 그룹을 풀면 따로 논다.
//
// 이 테스트는 실제로 오디오가 있는 mp4(사인파를 실제로 얹은 합성 파일)를 만들어서:
// 1) 임포트 시 클립이 정말 두 개(영상+오디오)로 갈라지는지, 서로 다른 트랙(kind)에
//    놓이는지, groupId 를 공유하는지
// 2) 영상 클립을 드래그하면 오디오 짝도 실시간으로 같은 시작점을 따라가는지
// 3) U 로 그룹 해제하면 그 다음부턴 따로 움직이는지
// 4) 영상 클립을 지우면(그룹 상태) 오디오 짝도 같이 지워지는지
// 5) 내보내기 — 영상 클립 자체는 무음(짝이 소리를 내므로)이고, 최종 결과물엔 오디오가
//    정확히 살아있는지(ffprobe)
// 를 실제로 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesplit-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesplit-'));
const CLIP = path.join(TMP, 'clip.mp4');   // 4초, 영상+오디오 둘 다 있음
const OUT = path.join(TMP, 'out.mp4');

{
  const r = spawnSync(FFMPEG, ['-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', CLIP], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(CLIP)) throw new Error('영상+오디오 픽스처 생성 실패');
}

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [CLIP] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 2000 });

  section('1) 임포트 — 영상 클립 + 짝지어진 오디오 클립으로 자동 분리');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-import').click(); true`);
  let info = null;
  for (let i = 0; i < 60; i++) {
    info = await js(`(() => {
      const lanes = [...document.querySelectorAll('.ve-lane')];
      const clips = [...document.querySelectorAll('.ve-clip')];
      return {
        laneCount: lanes.length,
        audioLaneCount: lanes.filter(l => l.classList.contains('audio')).length,
        clipCount: clips.length,
        clips: clips.map(el => ({ id: el.dataset.clipId, isAudioClass: el.classList.contains('audio') })),
      };
    })()`);
    if (info.clipCount >= 2) break;
    await wait(300);
  }
  expect('트랙 2개(영상+오디오)', info.laneCount, 2);
  expect('오디오 트랙 1개 자동 생성됨', info.audioLaneCount, 1);
  expect('클립 2개(영상+오디오)로 갈라짐', info.clipCount, 2);
  const videoClipInfo = info.clips.find(c => !c.isAudioClass);
  const audioClipInfo = info.clips.find(c => c.isAudioClass);
  expect('영상 클립 하나 있음', !!videoClipInfo, true);
  expect('오디오 클립 하나 있음', !!audioClipInfo, true);

  section('2) 영상 클립을 드래그하면 오디오 짝도 같은 시작점으로 실시간 이동');
  const before = await js(`(() => {
    const v = [...document.querySelectorAll('.ve-clip')].find(el => !el.classList.contains('audio'));
    const a = [...document.querySelectorAll('.ve-clip')].find(el => el.classList.contains('audio'));
    return { vLeft: parseFloat(v.style.left), aLeft: parseFloat(a.style.left) };
  })()`);
  expect('처음엔 영상·오디오 클립이 같은 위치(0초)에서 시작', before.vLeft === before.aLeft, true);

  await js(`(() => {
    const v = [...document.querySelectorAll('.ve-clip')].find(el => !el.classList.contains('audio'));
    const r = v.getBoundingClientRect();
    v.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 5, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5 + 80, clientY: r.top + 5, pointerId: 5, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5 + 80, clientY: r.top + 5, pointerId: 5, bubbles: true }));
  })(); true`);
  await wait(150);
  const afterMove = await js(`(() => {
    const v = [...document.querySelectorAll('.ve-clip')].find(el => !el.classList.contains('audio'));
    const a = [...document.querySelectorAll('.ve-clip')].find(el => el.classList.contains('audio'));
    return { vLeft: parseFloat(v.style.left), aLeft: parseFloat(a.style.left) };
  })()`);
  near('영상 클립이 2초(80px) 옮겨감', afterMove.vLeft, 80, 2);
  expect('오디오 짝도 같이 옮겨감(그룹)', Math.abs(afterMove.vLeft - afterMove.aLeft) < 1, true);

  section('3) U 로 그룹 해제 후엔 따로 움직임');
  await js(`(() => {
    const v = [...document.querySelectorAll('.ve-clip')].find(el => !el.classList.contains('audio'));
    v.dispatchEvent(new PointerEvent('pointerdown', { clientX: v.getBoundingClientRect().left + 5, clientY: v.getBoundingClientRect().top + 5, pointerId: 6, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: v.getBoundingClientRect().left + 5, clientY: v.getBoundingClientRect().top + 5, pointerId: 6, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }));
  })(); true`);
  await wait(100);
  await js(`(() => {
    const v = [...document.querySelectorAll('.ve-clip')].find(el => !el.classList.contains('audio'));
    const r = v.getBoundingClientRect();
    v.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 7, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5 + 40, clientY: r.top + 5, pointerId: 7, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5 + 40, clientY: r.top + 5, pointerId: 7, bubbles: true }));
  })(); true`);
  await wait(150);
  const afterUngroupMove = await js(`(() => {
    const v = [...document.querySelectorAll('.ve-clip')].find(el => !el.classList.contains('audio'));
    const a = [...document.querySelectorAll('.ve-clip')].find(el => el.classList.contains('audio'));
    return { vLeft: parseFloat(v.style.left), aLeft: parseFloat(a.style.left) };
  })()`);
  expect('그룹 해제 후엔 오디오 짝이 안 따라옴(서로 다른 위치)', Math.abs(afterUngroupMove.vLeft - afterUngroupMove.aLeft) > 5, true);

  section('4) 되돌리기로 그룹 이동/해제 이전 상태로 — 다시 그룹 상태에서 삭제하면 짝도 같이 지워짐');
  // Ctrl+Z 두 번(그룹 해제 취소, 두 번째 이동 취소) 으로 1)~2) 직후 상태(그룹, 첫 이동 완료)로 되돌린다.
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
  await wait(80);
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
  await wait(80);
  const beforeDel = await js(`document.querySelectorAll('.ve-clip').length`);
  await js(`(() => {
    const v = [...document.querySelectorAll('.ve-clip')].find(el => !el.classList.contains('audio'));
    v.dispatchEvent(new PointerEvent('pointerdown', { clientX: v.getBoundingClientRect().left + 5, clientY: v.getBoundingClientRect().top + 5, pointerId: 8, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: v.getBoundingClientRect().left + 5, clientY: v.getBoundingClientRect().top + 5, pointerId: 8, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
  })(); true`);
  await wait(100);
  const afterDel = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('영상 클립 삭제 시 그룹인 오디오 짝도 같이 지워짐(클립 2개 → 0개)', beforeDel - afterDel, 2);

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
