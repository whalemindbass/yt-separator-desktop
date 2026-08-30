'use strict';
// 임포트 — 오디오 트랙 재사용 범위 버그. 한 번에 여러 파일을 고르면(다중 선택) 영상들을
// 순서대로 이어붙여 편집하는 게 자연스러우니 영상 트랙 하나·오디오 트랙 하나를 같이
// 써야 맞다(videoexport.test.js 가 그 동작을 이미 지킨다). 문제는 "임포트"를 따로따로
// (파일 하나씩) 여러 번 눌렀을 때였다 — 영상은 매번 새 트랙이 생기는데(정상), 오디오는
// "이미 있는 오디오 트랙"을 무조건 재사용해서 서로 다른 영상들의 오디오가 전부 트랙
// 하나에 계속 쌓였다. 오디오도 영상과 똑같은 기준("트랙이 비어 있을 때만 재사용")으로
// 판단하도록 고쳤다 — 이 테스트가 그 두 시나리오를 모두 실측으로 구분해서 검증한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veimportaudio-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veimportaudio-'));
const A = path.join(TMP, 'a.mp4'), B = path.join(TMP, 'b.mp4'), C = path.join(TMP, 'c.mp4');
for (const f of [A, B, C]) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:duration=2:rate=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f], { stdio: 'ignore' });
}
if (![A, B, C].every(fs.existsSync)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

function trackList(js) {
  return js(`JSON.stringify([...document.querySelectorAll('.ve-lane')].map(l => ({
    label: l.querySelector('.lbl')?.textContent,
    kind: l.classList.contains('audio') ? 'audio' : 'video',
    clips: l.querySelectorAll('.ve-clip').length,
  })))`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) 반복 단일 임포트(3번, 한 파일씩) — 영상마다 자기 오디오 트랙이 따로 생겨야 함');
  for (const f of [A, B, C]) {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
    await js(`document.getElementById('ve-import').click(); true`);
    await wait(400);
  }
  for (let i = 0; i < 60; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 6) break; await wait(300); }
  const tracks = JSON.parse(await trackList(js));
  expect('트랙 6개(영상 3 + 오디오 3)', tracks.length, 6);
  expect('영상 트랙 3개', tracks.filter(t => t.kind === 'video').length, 3);
  expect('오디오 트랙 3개(예전엔 1개로 다 쌓였다)', tracks.filter(t => t.kind === 'audio').length, 3);
  expect('트랙마다 클립 정확히 1개씩(쌓이지 않음)', tracks.every(t => t.clips === 1), true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
