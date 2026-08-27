'use strict';
// 영상 편집 탭 — mp3/wav 처럼 영상 트랙이 없는 파일도 임포트해서 쓸 수 있어야 한다
// (배경음악 등). 임포트 필터가 예전엔 영상 확장자만이라 매번 "모든 파일"로 바꿔야
// 했던 것도 고쳤다(main.js dialog:pickVideoFiles). 여기서는 실제로 영상+mp3 를 같이
// 임포트해서: 오디오 전용 클립이 썸네일 대신 음표 표시로 뜨는지, 미리보기가 음소거가
// 아닌지(재생해도 소리 안 나던 버그), 내보내기가 그 구간을 검은 화면+오디오로 잘
// 채워서 끝까지 성공하는지를 본다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veaudio-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veaudio-'));
const VID = path.join(TMP, 'vid.mp4');   // 4초, 320x240
const MP3 = path.join(TMP, 'song.mp3');  // 3초
const OUT = path.join(TMP, 'out.mp4');

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', VID], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-c:a', 'libmp3lame', MP3], { stdio: 'ignore' });
if (!fs.existsSync(VID) || !fs.existsSync(MP3)) throw new Error('ffmpeg 로 픽스처 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [VID, MP3] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 2000 });

  section('1) 영상+mp3 함께 임포트');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-import').click(); true`);
  let clips = [];
  for (let i = 0; i < 60; i++) {
    clips = await js(`[...document.querySelectorAll('.ve-clip')].map(el => ({
      label: el.querySelector('.ve-clip-lbl').textContent,
      isAudioClass: el.classList.contains('audio'),
      hasThumbs: !!el.querySelector('.ve-thumbs'),
      hasAudioIcon: !!el.querySelector('.ve-audio-icon'),
    }))`);
    if (clips.length >= 2) break;
    await wait(300);
  }
  expect('클립 2개(영상+mp3) 임포트됨', clips.length, 2);
  const vidClip = clips.find(c => c.label === 'vid.mp4');
  const mp3Clip = clips.find(c => c.label === 'song.mp3');
  expect('영상 클립은 썸네일', vidClip?.hasThumbs, true);
  expect('mp3 클립은 오디오 아이콘(썸네일 없음)', mp3Clip?.hasAudioIcon && !mp3Clip?.hasThumbs, true);

  section('2) 미리보기 레이어가 음소거 아님(재생해도 소리 안 나던 버그)');
  const muted = await js(`[...document.querySelectorAll('#ve-preview video')].map(v => v.muted)`);
  expect('미리보기 <video> 전부 음소거 아님', muted.every(m => m === false), true);

  section('3) 내보내기 — 오디오 전용 구간은 검은 화면 + 오디오로 채워짐');
  await js(`document.getElementById('ve-export').click(); true`);
  let btnLabel = '';
  for (let i = 0; i < 80; i++) {
    btnLabel = await js(`document.getElementById('ve-export').textContent`);
    if (fs.existsSync(OUT) && !/%$/.test(btnLabel)) break;
    await wait(500);
  }
  const toast = await js(`document.getElementById('ve-toast')?.textContent`);
  expect('완료 토스트', toast, '내보내기 완료');
  expect('출력 파일 생김', fs.existsSync(OUT), true);

  if (fs.existsSync(OUT)) {
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration',
      '-show_entries', 'stream=codec_type,width,height', '-of', 'default=noprint_wrappers=1', OUT], { encoding: 'utf-8' });
    const out = r.stdout || '';
    near('총 길이 ≈ 7초(영상4+mp3 3)', parseFloat((/duration=([\d.]+)/.exec(out) || [])[1] || 0), 7, 0.3);
    expect('비디오 스트림 있음(mp3 구간도 검은 화면으로 채워짐)', out.includes('codec_type=video'), true);
    expect('해상도가 영상 클립과 같음(320x240)', out.includes('width=320') && out.includes('height=240'), true);
    expect('오디오 스트림 있음', out.includes('codec_type=audio'), true);
  }

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
