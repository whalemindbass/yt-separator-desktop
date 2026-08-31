'use strict';
// 임포트를 파일 하나씩 반복해서(예: "임포트" 버튼을 여러 번) 눌렀을 때 생기던 트랙 버그
// 세 가지 — 실측으로 각각 재현·확인 후 고쳤다.
//   1) 오디오가 "이미 있는 오디오 트랙"을 무조건 재사용해서, 서로 다른 영상들의 오디오가
//      전부 트랙 하나에 계속 쌓였다(영상은 매번 새 트랙이 생기는데 오디오만 안 그랬다).
//      → 오디오도 영상과 같은 기준("트랙이 비어 있을 때만 재사용")으로 바꿈.
//   2) 순서가 "영1 영2 영3 오1"(영상 트랙끼리 위에 몰리고 오디오가 맨 아래 한 덩어리)로
//      나왔는데, 영상+그 영상의 오디오가 "영1 오1 영2 오2" 처럼 바로 붙어 있어야 한다.
//      → 새 영상 트랙은 맨 아래에 이어 붙이고(맨 위로 안 튐), 오디오는 자기 영상 트랙
//      바로 다음 자리에 끼운다.
//   3) 새 트랙이 맨 위로 튀어 오르던 예전 방식 탓에, 두 번째로 임포트하면 기존 "영상 1"
//      이 "영상 2"로 자기도 모르게 번호가 바뀌었다(trackLabel 이 목록 위치로 순번을
//      매기는데, 위에 새 트랙이 끼어들면 밀리니까). → 위 2)번처럼 맨 아래로 붙이면 기존
//      트랙 위치가 안 밀리니 번호도 안 바뀐다.
//   (덤) 영상 1개를 임포트하면 그 영상+짝지어진 오디오로 클립이 2개 생기는데, 토스트가
//   "2개가 임포트되었습니다"로 잘못 떴다(사용자가 고른 건 1개 파일이다) — 파일 개수로
//   세도록 고침.

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

  section('1) 반복 단일 임포트(3번, 한 파일씩) — 순서/번호 안정성/토스트 문구까지 매번 확인');
  const expectedOrders = [
    ['영상 1', '오디오 1'],
    ['영상 1', '오디오 1', '영상 2', '오디오 2'],
    ['영상 1', '오디오 1', '영상 2', '오디오 2', '영상 3', '오디오 3'],
  ];
  const files = [A, B, C];
  for (let i = 0; i < files.length; i++) {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [files[i]] });
    await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
    for (let w = 0; w < 40; w++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= (i + 1) * 2) break; await wait(300); }
    await wait(200);
    const labels = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.ve-lane .lbl')].map(l => l.textContent))`));
    expect(`파일 ${i + 1}개째 임포트 후 순서(영·오 바로 붙어있고 기존 번호 안 바뀜)`, labels, expectedOrders[i]);
    const toast = await js(`document.getElementById('ve-toast')?.textContent`);
    expect(`파일 ${i + 1}개째 임포트 토스트는 "영상 1개가"(클립 2개라도 파일은 1개)`, toast, '영상 1개가 임포트되었습니다');
  }

  const tracks = JSON.parse(await trackList(js));
  expect('트랙 6개(영상 3 + 오디오 3)', tracks.length, 6);
  expect('영상 트랙 3개', tracks.filter(t => t.kind === 'video').length, 3);
  expect('오디오 트랙 3개(예전엔 1개로 다 쌓였다)', tracks.filter(t => t.kind === 'audio').length, 3);
  expect('트랙마다 클립 정확히 1개씩(쌓이지 않음)', tracks.every(t => t.clips === 1), true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
