'use strict';
// 영상 편집 탭 내보내기 — 진짜 main.js(ipcMain.handle('video:export'))를 태워 ffmpeg 가
// 실제로 mp4 를 만들어내는지 끝까지 확인한다. 파일 대화상자는 automated 환경에서 못 띄우니
// electron.dialog 를 스텁으로 바꿔치기(saveasfilter.test.js 와 같은 방식).
//
// 두 클립 다 오디오 스트림이 없는 합성 영상이다 — video:export 가 무음 소스를 anullsrc 로
// 대신 채우는 경로(그거 없이 그냥 [i:a] 를 매핑하면 ffmpeg 가 "matches no streams" 로 죽는
// 버그가 실제로 있었다)까지 이 테스트가 매번 검증하는 셈이다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

// 실제 userData(videoProject.json 자동저장)를 건드리면 이전 실행이 남긴 클립이 이번 실행의
// 임포트와 섞여버린다(실제로 겪음 — 4클립/2트랙으로 나와 당황했다) — 이 테스트 전용 임시
// 프로필로 격리한다. main.js 를 require 하기 전, app 준비 전에 해야 한다.
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veexp-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veexp-'));
const RED = path.join(TMP, 'red.mp4');
const BLUE = path.join(TMP, 'blue.mp4');
const OUT = path.join(TMP, 'out.mp4');
function makeClip(file, pattern, seconds) {
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `${pattern}=duration=${seconds}:size=320x240:rate=15`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(RED, 'testsrc', 3);
makeClip(BLUE, 'testsrc2', 2);

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED, BLUE] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 2000 });

  section('1) 임포트');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  let n = 0;
  for (let i = 0; i < 40; i++) {
    n = await js(`document.querySelectorAll('.ve-clip').length`);
    if (n >= 2) break;
    await wait(300);
  }
  expect('클립 2개 임포트됨', n, 2);

  section('2) 내보내기');
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  let btnLabel = '';
  for (let i = 0; i < 60; i++) {
    btnLabel = await js(`document.getElementById('ve-export').textContent`);
    if (fs.existsSync(OUT) && !/%$/.test(btnLabel)) break;
    await wait(500);
  }
  const toast = await js(`document.getElementById('ve-toast')?.textContent`);
  expect('완료 토스트', toast, '내보내기 완료');
  expect('출력 파일 생김', fs.existsSync(OUT), true);

  if (fs.existsSync(OUT)) {
    section('3) 결과물 검증(ffprobe)');
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1', OUT], { encoding: 'utf-8' });
    const out = r.stdout || '';
    near('총 길이 ≈ 5초(3+2)', parseFloat((/duration=([\d.]+)/.exec(out) || [])[1] || 0), 5, 0.2);
    expect('비디오 스트림 있음', out.includes('codec_type=video'), true);
    expect('오디오 스트림 있음(무음 소스도 anullsrc 로 채워짐)', out.includes('codec_type=audio'), true);
  }

  section('4) 자동 저장 — 실제 파일에 반영됐는가');
  await wait(1000);   // 저장은 600ms 디바운스
  const projFile = path.join(app.getPath('userData'), 'videoProject.json');
  let proj = null;
  try { proj = JSON.parse(fs.readFileSync(projFile, 'utf-8')); } catch {}
  expect('videoProject.json 에 클립 2개 저장됨', proj?.clips?.length, 2);
  expect('videoProject.json 에 트랙 1개 저장됨', proj?.tracks?.length, 1);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
