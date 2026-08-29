'use strict';
// 트랙에 이미지 임포트 — 영상 트랙 클립으로 들어가는지("+트랙" 메뉴의 "이미지" 항목),
// 미리보기가 <video> 대신 <img> 를 보여주는지, 실제 내보내기 결과물에 그 이미지 색이
// 찍히는지(main.js 의 -loop 1 이미지 입력 처리)까지 실측으로 검증한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veimage-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veimage-'));
const IMG = path.join(TMP, 'orange.png');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=orange:size=${W}x${H}`, '-frames:v', '1', IMG], { stdio: 'ignore' });
if (!fs.existsSync(IMG)) throw new Error('ffmpeg 로 테스트 PNG 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [IMG] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) "+트랙" 메뉴 — 이미지 항목으로 임포트');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="image"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }
  expect('이미지 클립 1개 생김', await js(`document.querySelectorAll('.ve-clip.image').length`), 1);
  expect('영상 트랙에 들어감(별도 트랙 아님)', await js(`document.querySelectorAll('.ve-lane:not(.audio):not(.text)').length`), 1);
  expect('기본 길이 5초', await js(`(() => {
    const c = document.querySelector('.ve-clip.image');
    return Math.round(parseFloat(c.style.width) / 40);
  })()`), 5);

  section('2) 미리보기 — <video> 대신 <img> 가 보임');
  await wait(150);
  const layerState = JSON.parse(await js(`(() => {
    const slot = document.querySelector('.ve-video-layers .ve-layer-slot');
    const v = slot.querySelector('video'), img = slot.querySelector('img');
    return JSON.stringify({ videoHidden: v.hidden, imgHidden: img.hidden, imgSrcHasFile: img.src.includes('orange.png') });
  })()`));
  expect('영상 태그는 숨김', layerState.videoHidden, true);
  expect('이미지 태그가 보임', layerState.imgHidden, false);
  expect('그 이미지 파일을 물고 있음', layerState.imgSrcHasFile, true);

  section('3) 내보내기 — 실제 결과물에 orange 색이 찍히는지, 길이 5초인지');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const durR = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', OUT], { encoding: 'utf-8' });
    near('결과물 길이 ≈ 5초', parseFloat((/duration=([\d.]+)/.exec(durR.stdout || '') || [])[1] || 0), 5, 0.3);

    const raw = path.join(TMP, 'out.rgb');
    spawnSync(FFMPEG, ['-y', '-ss', '2', '-i', OUT, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
    const buf = fs.readFileSync(raw);
    const mid = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 3;
    const r = buf[mid], g = buf[mid + 1], b = buf[mid + 2];
    expect('중앙 픽셀이 orange 색(빨강 강, 파랑 약)', r > 180 && b < 80, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
