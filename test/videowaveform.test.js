'use strict';
// 오디오 트랙 파형 — Web Audio(decodeAudioData) 로 렌더러 안에서 실제로 디코드해서 스튜디오와
// 똑같은 방식(buildWaveSvg, SVG 폴리곤)으로 그리는지 실측 확인한다(캐시/큐 로직만 읽어서는
// 실제로 폴리곤이 찍히는지 알 수 없다 — player.js 의 stem 로딩과 같은 fetch+decodeAudioData
// 방식이라 이 harness 에서도 똑같이 동작해야 한다).
//
// 예전엔 캔버스에 열(px)마다 사각형을 따로 찍어서 스튜디오보다 각지고 투박해 보였다(제보:
// "오디오 트랙 파형이 영상의 오디오 파형보다 투박하다") — studio/util.js 의 buildWaveSvg 를
// 그대로 재사용하는 SVG 방식으로 바꿨다. .ve-wave 는 이제 <canvas> 가 아니라 <div> 다.

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

  section('1) Import → 오디오로 wav 임포트 — 오디오 클립에 .ve-wave 컨테이너가 생긴다');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [WAV] });
  await js(`document.getElementById('ve-import').click();
    document.querySelector('#ve-import-menu [data-kind="audio"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await wait(200);
  const hasWaveDiv = await js(`(() => { const w = document.querySelector('.ve-clip .ve-wave'); return !!w && w.tagName === 'DIV'; })()`);
  expect('오디오 클립 안에 .ve-wave 가 <div> 로 생김(캔버스 아님)', hasWaveDiv, true);

  section('2) 디코드 완료 후 — 스튜디오와 같은 SVG 폴리곤이 실제로 그려짐(빈 채 아님)');
  let painted = false;
  for (let i = 0; i < 50; i++) {
    painted = await js(`(() => {
      const svg = document.querySelector('.ve-wave svg');
      if (!svg) return false;
      const polys = svg.querySelectorAll('polygon');
      // buildWaveSvg 는 피크+rms 2겹 폴리곤을 그린다 — 최소 2개, points 속성에 좌표가 실제로 채워져 있어야 한다.
      return polys.length >= 2 && [...polys].every(p => (p.getAttribute('points') || '').trim().length > 0);
    })()`);
    if (painted) break;
    await wait(300);
  }
  expect('사인파 전체 구간 — 피크+rms 폴리곤 2겹이 실제로 채워짐', painted, true);

  const polygonFillsVary = await js(`(() => {
    const svg = document.querySelector('.ve-wave svg');
    const polys = [...svg.querySelectorAll('polygon')];
    // 사인파 최대 진폭이면 buildWaveSvg 의 y = 25 - h(최대 22) 라 3.0 근처까지 간다 — 진폭이
    // 전혀 없으면(무음) 모든 점이 중앙선 25 에 붙는다. y 값 중 20보다 뚜렷이 작은 게 있는지 확인.
    return polys.some(p => {
      const ys = [...(p.getAttribute('points') || '').matchAll(/,(-?\\d+(?:\\.\\d+)?)/g)].map(m => Number(m[1]));
      return ys.some(y => y < 20);
    });
  })()`);
  expect('폴리곤에 실제 진폭(중앙선 밖 좌표)이 있음', polygonFillsVary, true);

  section('3) 줌을 바꿔도(다시 그려도) 여전히 파형이 보인다(재디코드 없이 캐시에서)');
  await js(`document.getElementById('ve-zoom-in').click(); true`);
  await wait(200);
  const paintedAfterZoom = await js(`(() => {
    const svg = document.querySelector('.ve-wave svg');
    if (!svg) return false;
    const polys = svg.querySelectorAll('polygon');
    return polys.length >= 2 && [...polys].every(p => (p.getAttribute('points') || '').trim().length > 0);
  })()`);
  expect('확대 후에도 파형이 바로 다시 그려짐', paintedAfterZoom, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
