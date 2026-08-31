'use strict';
// 오디오 트랙 파형 — Web Audio(decodeAudioData) 로 렌더러 안에서 실제로 디코드해서 캔버스에
// min/max 막대로 그리는지 실측 확인한다(캐시/큐 로직만 읽어서는 실제로 픽셀이 찍히는지
// 알 수 없다 — player.js 의 stem 로딩과 같은 fetch+decodeAudioData 방식이라 이 harness 에서도
// 똑같이 동작해야 한다).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vewave-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vewave-'));
const WAV = path.join(TMP, 'tone.wav');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', WAV], { stdio: 'ignore' });
if (!fs.existsSync(WAV)) throw new Error('ffmpeg 로 테스트 wav 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) Import → 오디오로 wav 임포트 — 오디오 클립에 파형 캔버스가 생긴다');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [WAV] });
  await js(`document.getElementById('ve-import').click();
    document.querySelector('#ve-import-menu [data-kind="audio"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await wait(200);
  const hasCanvas = await js(`!!document.querySelector('.ve-clip .ve-wave')`);
  expect('오디오 클립 안에 .ve-wave 캔버스가 생김', hasCanvas, true);
  const sizedOk = await js(`(() => { const c = document.querySelector('.ve-wave'); return c && c.width > 0 && c.height > 0; })()`);
  expect('캔버스 크기가 클립 실제 렌더 크기로 잡힘(0x0 아님)', sizedOk, true);

  section('2) 디코드 완료 후 — 실제로 소리 있는 파형 픽셀이 그려짐(빈 캔버스 아님)');
  let painted = false;
  for (let i = 0; i < 50; i++) {
    painted = await js(`(() => {
      const c = document.querySelector('.ve-wave');
      if (!c || !c.width || !c.height) return false;
      const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
      return false;
    })()`);
    if (painted) break;
    await wait(300);
  }
  expect('사인파 전체 구간 — 파형 막대가 실제로 칠해짐', painted, true);

  section('3) 줌을 바꿔도(다시 그려도) 여전히 파형이 보인다(재디코드 없이 캐시에서)');
  await js(`document.getElementById('ve-zoom-in').click(); true`);
  await wait(200);
  const paintedAfterZoom = await js(`(() => {
    const c = document.querySelector('.ve-wave');
    if (!c || !c.width || !c.height) return false;
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true;
    return false;
  })()`);
  expect('확대 후에도 파형이 바로 다시 그려짐', paintedAfterZoom, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
