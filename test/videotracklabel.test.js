'use strict';
// 트랙 이름 자동 표시 + 인라인 이름 변경 + 재생 컨트롤이 화면 맨 아래 전용 바로 옮겨졌는지.
//   1) "+트랙"으로 이미지/도형을 넣으면 그 트랙은 "영상 N"이 아니라 "이미지 N"/"도형 N"으로
//      표시된다(각자 독립적으로 순번을 센다) — 진짜 영상 트랙은 그대로 "영상 N".
//   2) 트랙 헤드 라벨을 더블클릭하면 (예전 window.prompt() 대신) 인라인 입력칸이 뜨고,
//      Enter 로 적용하면 즉시 반영 + 저장 파일에도 남는다.
//   3) 재생(처음으로/재생·정지/시간) 버튼이 위쪽 툴바가 아니라 화면 맨 아래 전용 바에 있다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetracklabel-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetracklabel-'));
const IMG1 = path.join(TMP, 'img1.png');
const IMG2 = path.join(TMP, 'img2.png');
const VID = path.join(TMP, 'vid.mp4');

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=orange:size=100x100', '-frames:v', '1', IMG1], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=purple:size=100x100', '-frames:v', '1', IMG2], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=green:size=320x240:duration=1:rate=5',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', VID], { stdio: 'ignore' });
if (![IMG1, IMG2, VID].every(fs.existsSync)) throw new Error('ffmpeg 로 테스트 픽스처 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

function laneLabels(js) {
  return js(`JSON.stringify([...document.querySelectorAll('.ve-lane:not(.audio):not(.text) .lbl')].map(l => l.textContent))`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) 이미지 두 번, 도형 한 번, 영상 한 번 — 각자 독립적으로 순번 매겨 라벨이 붙는다');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [IMG1] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="image"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [IMG2] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="image"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 2) break; await wait(300); }

  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="shape"]').click(); true`);
  await wait(200);

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [VID] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) {
    const n = await js(`document.querySelectorAll('.ve-clip:not(.image):not(.audio):not(.text)').length`);
    if (n >= 1) break;
    await wait(300);
  }
  await wait(300);

  const labels = JSON.parse(await laneLabels(js));
  expect('트랙 4개(이미지2 + 도형1 + 영상1)', labels.length, 4);
  // "+트랙" 은 매번 맨 위로 새 트랙을 얹는다(예전부터의 관례, importVideoFiles 만 예외로
  // 맨 아래에 붙는다 — 그건 이 파일이 아니라 videoimportaudiotrack.test.js 대상) — 라벨은
  // 그때그때 배열 위치로 매기니, 나중에 넣은 같은 종류 트랙이 맨 위(=1번)를 차지하고
  // 먼저 넣은 쪽이 뒤로 밀려 번호가 올라간다.
  expect('맨 위(가장 최근 추가) = 영상 1', labels[0], '영상 1');
  expect('그 다음 = 도형 1', labels[1], '도형 1');
  expect('그 다음 = 이미지 1(나중에 넣은 이미지가 맨 위라 1번)', labels[2], '이미지 1');
  expect('맨 아래(가장 먼저 넣은 이미지, 밀려서 2번) = 이미지 2', labels[3], '이미지 2');

  section('2) 트랙 헤드 라벨 더블클릭 — 인라인 입력칸(예전 네이티브 prompt 대신)으로 바로 바뀜');
  await js(`(() => {
    const lanes = [...document.querySelectorAll('.ve-lane:not(.audio):not(.text)')];
    const lane = lanes.find(l => l.querySelector('.lbl')?.textContent === '이미지 1');
    lane.querySelector('.lbl').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  })(); true`);
  await wait(80);
  expect('인라인 입력칸이 뜸', await js(`!!document.querySelector('.ve-track-rename')`), true);
  await js(`(() => {
    const input = document.querySelector('.ve-track-rename');
    input.value = '내 배경 이미지';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })(); true`);
  await wait(200);
  const renamedLabels = JSON.parse(await laneLabels(js));
  expect('이름이 바로 반영됨', renamedLabels.includes('내 배경 이미지'), true);
  expect('입력칸은 사라지고 다시 라벨로', await js(`!document.querySelector('.ve-track-rename')`), true);

  // 자동 저장(scheduleSave, 600ms 디바운스) 이 실제 파일에 반영됐는지 직접 읽어 확인.
  await wait(700);
  const projFile = path.join(app.getPath('userData'), 'videoProject.json');
  const proj = JSON.parse(fs.readFileSync(projFile, 'utf-8'));
  expect('저장 파일에도 바뀐 이름이 남음', proj.tracks.some(t => t.name === '내 배경 이미지'), true);

  section('3) 재생 컨트롤이 위쪽 툴바가 아니라 화면 맨 아래 전용 바에 있음');
  expect('재생 버튼이 위쪽 툴바 안에는 없음', await js(`!document.querySelector('.ve-toolbar #ve-play')`), true);
  expect('.ve-bottombar 안에 재생 버튼이 있음', await js(`!!document.querySelector('.ve-bottombar #ve-play')`), true);
  expect('.ve-bottombar 안에 처음으로 버튼도 있음', await js(`!!document.querySelector('.ve-bottombar #ve-seek0')`), true);
  expect('.ve-bottombar 안에 시간 표시도 있음', await js(`!!document.querySelector('.ve-bottombar #ve-time')`), true);
  // flash() 토스트가 .video-body 에 그때그때 append 돼서 "실제로 마지막 자식"만 보면
  // 우연히 토스트에 가려 틀릴 수 있다 — 구조적으로 타임라인(.ve-tscroll) 바로 다음
  // 형제(즉 그 아래)에 자리하는지로 확인하는 쪽이 안정적이다.
  const bottombarRightAfterTimeline = await js(`document.querySelector('.ve-tscroll')?.nextElementSibling === document.querySelector('.ve-bottombar')`);
  expect('그 바가 타임라인 바로 아래(화면 맨 아래)에 자리함', bottombarRightAfterTimeline, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
