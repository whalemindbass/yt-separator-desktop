'use strict';
// 오디오 임포트(Import → 오디오) 버그 수정 검증 — 예전엔 오디오 임포트가 항상 "이미 있는
// 오디오 트랙" 하나만 재사용해서, 영상 임포트 후엔 배경음악을 별도 트랙으로 넣을 방법이
// 사실상 없었다(같은 트랙에 순차로만 쌓임 → 동시에 겹치게 두려면 드래그로 자리를 옮겨야
// 했고, 그러면 크로스페이드 취급됨). 이제 오디오를 임포트할 때마다 항상 새 트랙이 생겨야
// 한다("+트랙"의 오디오는 이제 영상처럼 빈 트랙만 만든다 — 파일 임포트는 Import 버튼 쪽 일).
// 버튼 클릭 → 실제 UI 흐름(bootMain, 진짜 ffmpeg export)으로 끝까지 검증한다: 트랙 3개
// (영상 자체 오디오 1 + 배경음악 2)가 buildEDL()→amix 를 거쳐 실제로 동시에 섞이는지.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vemulti-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vemulti-'));
const RED = path.join(TMP, 'red.mp4');
const BG1 = path.join(TMP, 'bg1.wav');
const BG2 = path.join(TMP, 'bg2.wav');
const OUT = path.join(TMP, 'out.mp4');

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:duration=3:rate=15',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-shortest',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', RED], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=3', BG1], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', BG2], { stdio: 'ignore' });
for (const f of [RED, BG1, BG2]) if (!fs.existsSync(f)) throw new Error('ffmpeg 로 테스트 파일 생성 실패: ' + f);

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 영상 임포트 — 영상 트랙 + 자체 오디오 트랙(링크됨) 자동 생성');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  expect('영상+링크오디오 2클립', await js(`document.querySelectorAll('.ve-clip').length`), 2);
  expect('오디오 트랙 1개(자동)', await js(`document.querySelectorAll('.ve-lane.audio').length`), 1);

  section('2) "+오디오" 첫 번째 클릭 — 영상 임포트 후에도 막히지 않고 새 트랙에 들어감');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG1] });
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="audio"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 3) break; await wait(300); }
  expect('클립 3개로 늘어남(배경음악1 추가)', await js(`document.querySelectorAll('.ve-clip').length`), 3);
  expect('오디오 트랙 2개(재사용 아니라 새로 생김)', await js(`document.querySelectorAll('.ve-lane.audio').length`), 2);

  section('3) "+오디오" 두 번째 클릭 — 또 새 트랙(다중 오디오)');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG2] });
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="audio"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 4) break; await wait(300); }
  expect('클립 4개로 늘어남(배경음악2 추가)', await js(`document.querySelectorAll('.ve-clip').length`), 4);
  expect('오디오 트랙 3개', await js(`document.querySelectorAll('.ve-lane.audio').length`), 3);

  section('4) 실제 내보내기 — 오디오 트랙 3개가 진짜로 동시에 섞이는가');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1', OUT], { encoding: 'utf-8' });
    const out = r.stdout || '';
    near('총 길이 ≈ 3초', parseFloat((/duration=([\d.]+)/.exec(out) || [])[1] || 0), 3, 0.3);
    expect('오디오 스트림 있음', out.includes('codec_type=audio'), true);

    const vd = spawnSync(FFMPEG, ['-i', OUT, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf-8' });
    const mean = parseFloat((/mean_volume:\s*(-?[\d.]+)/.exec(vd.stderr || '') || [])[1] ?? '-999');
    expect('무음 아님(3개 오디오소스가 실제로 섞임)', mean > -80, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
