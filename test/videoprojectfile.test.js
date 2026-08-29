'use strict';
// 1) "+트랙" 버튼 하나로 통일 — 눌렀을 때 뜨는 메뉴에서 영상/오디오/텍스트 고를 수 있는지.
// 2) 프로젝트 저장(.dsvproj)/열기 — 실제 파일로 저장되고, 다시 열면 트랙/클립이 복원되는지.
// 3) 불러왔을 때 원본 파일이 삭제돼 있으면 빨간 X 표시가 붙는지(파일 하나는 지우고,
//    하나는 그대로 둬서 있는 것/없는 것 둘 다 맞게 구분되는지까지 확인).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veprojfile-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veprojfile-'));
const KEEP = path.join(TMP, 'keep.mp4');
const DOOMED = path.join(TMP, 'doomed.mp4');
const W = 320, H = 240;

for (const [f, color] of [[KEEP, 'red'], [DOOMED, 'blue']]) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=${W}x${H}:duration=2:rate=10`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f], { stdio: 'ignore' });
}
if (!fs.existsSync(KEEP) || !fs.existsSync(DOOMED)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) "+트랙" 버튼 하나 — 메뉴에서 영상/오디오/텍스트 고르기');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  expect('메뉴는 처음엔 숨겨짐', await js(`document.getElementById('ve-add-track-menu').hidden`), true);
  await js(`document.getElementById('ve-add-track-btn').click(); true`);
  await wait(50);
  expect('버튼 누르면 메뉴 열림', await js(`document.getElementById('ve-add-track-menu').hidden`), false);
  expect('메뉴 항목 3개(영상/오디오/텍스트)', await js(`document.querySelectorAll('#ve-add-track-menu [data-kind]').length`), 3);
  const menuBounds = await js(`(() => {
    const r = document.getElementById('ve-add-track-menu').getBoundingClientRect();
    return JSON.stringify({ left: r.left, right: r.right, winW: window.innerWidth });
  })()`);
  const { left: mLeft, right: mRight, winW } = JSON.parse(menuBounds);
  expect('메뉴가 창 왼쪽 밖으로 안 나감', mLeft >= 0, true);
  expect('메뉴가 창 오른쪽 밖으로 안 나감', mRight <= winW, true);
  await js(`document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(50);
  expect('선택하면 메뉴 닫힘', await js(`document.getElementById('ve-add-track-menu').hidden`), true);
  expect('영상 트랙 하나 생김', await js(`document.querySelectorAll('.ve-lane:not(.audio):not(.text)').length`), 1);

  section('2) 두 파일 임포트(keep/doomed) — 저장 전 상태');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [KEEP, DOOMED] });
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip:not(.audio)').length`) >= 2) break; await wait(300); }
  expect('영상 클립 2개 임포트됨', await js(`document.querySelectorAll('.ve-clip:not(.audio)').length`), 2);
  expect('저장 전엔 빨간 X 없음', await js(`document.querySelectorAll('.ve-clip-missing').length`), 0);

  section('3) 프로젝트 저장(.dsvproj) — 실제 파일로 남는지');
  const PROJ = path.join(TMP, 'test.dsvproj');
  dialog.showSaveDialog = async (win, opts) => { return { canceled: false, filePath: PROJ }; };
  await js(`document.getElementById('ve-save-project').click(); true`);
  for (let i = 0; i < 20; i++) { if (fs.existsSync(PROJ)) break; await wait(200); }
  expect('.dsvproj 파일 생김', fs.existsSync(PROJ), true);
  let savedRaw = null;
  if (fs.existsSync(PROJ)) {
    savedRaw = JSON.parse(fs.readFileSync(PROJ, 'utf-8'));
    expect('저장된 트랙 1개(영상)', (savedRaw.tracks || []).length, 1);
    expect('저장된 클립 2개', (savedRaw.clips || []).length, 2);
  }

  section('4) 원본 파일 하나 삭제 후 프로젝트 새로 열기 — 빨간 X 는 지운 것에만');
  fs.unlinkSync(DOOMED);
  expect('doomed.mp4 실제로 지워짐', fs.existsSync(DOOMED), false);
  // 기존 상태를 지우고(새 트랙 하나 더 만들어 확실히 다른 상태로 만든 다음) 다시 연다.
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PROJ] });
  await js(`document.getElementById('ve-open-project').click(); true`);
  for (let i = 0; i < 30; i++) { if (await js(`document.querySelectorAll('.ve-clip-missing').length`) > 0) break; await wait(200); }
  expect('연 뒤 트랙 다시 1개로(새로 만든 임시 트랙은 사라짐)', await js(`document.querySelectorAll('.ve-lane:not(.audio):not(.text)').length`), 1);
  expect('클립 2개 복원됨', await js(`document.querySelectorAll('.ve-clip:not(.audio)').length`), 2);
  expect('지운 파일 클립엔 빨간 X 붙음', await js(`document.querySelectorAll('.ve-clip-missing').length`), 1);
  const missingName = await js(`(() => {
    const badge = document.querySelector('.ve-clip-missing');
    return badge?.closest('.ve-clip')?.querySelector('.ve-clip-lbl')?.textContent;
  })()`);
  expect('X 붙은 클립이 실제로 doomed.mp4 것', missingName, 'doomed.mp4');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
