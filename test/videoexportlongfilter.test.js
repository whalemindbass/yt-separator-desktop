'use strict';
// 내보내기 — 클립이 아주 많은 프로젝트에서 "spawn ENAMETOOLONG" 으로 죽던 버그("내보내기
// 실패해, spawn ENAMETOOLING 이라고 떠" 신고). filter_complex 문자열을 명령줄 인자로 그대로
// 넘기면 Windows 의 명령줄 길이 제한(약 32KB)을 넘는 프로젝트에서 ffmpeg 프로세스 자체가
// 못 뜬다 — main.js 가 이제 그 문자열을 파일에 써서 -filter_complex_script 로 읽게 바꿨다.
// 클립 200개(같은 파일을 짧게짧게 이어붙임)로 이 제한을 확실히 넘는 프로젝트를 만들어
// 내보내기가 그래도 성공하는지 확인한다 — 실제 화면 내용은 다 같은 색이라 안 보고, 오직
// "명령줄 길이 때문에 아예 못 뜨던 문제가 고쳐졌는지"만 본다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-velongfilter-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-velongfilter-'));
const SRC = path.join(TMP, 'src.mp4');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;
const N = 200;          // 클립 개수 — filter_complex 문자열이 확실히 32KB 를 넘도록
const CLIP_DUR = 0.05;  // 초 — 총 길이 200*0.05 = 10초

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=red:size=${W}x${H}:duration=1:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const clips = Array.from({ length: N }, (_, i) => ({
  id: i + 1, trackId: 1, file: SRC, name: 'src.mp4',
  start: i * CLIP_DUR, inOff: 0, srcDur: 1, dur: CLIP_DUR,
  w: W, h: H, hasAudio: false, isAudioOnly: false, effects: [],
}));
const PROJ = {
  tracks: [{ id: 1, name: '', color: '#4a90d9', height: 72, hidden: false, kind: 'video', transform: null }],
  clips,
  resolution: { w: W, h: H },
};
const projPath = path.join(TMP, 'longfilter.dsvproj');
fs.writeFileSync(projPath, JSON.stringify(PROJ));

// 실측 — 이 프로젝트의 filter_complex 문자열이 실제로 32KB(Windows CreateProcess 한도)를
// 넘는지 대략 확인해 둔다(각 세그먼트 trim/setpts/scale/pad/concat 조각 * 200개). 넘지
// 않으면 이 테스트가 애초에 그 버그를 재현하지 못하는 셈이라 의미가 없다.
const roughFragmentLen = 300;   // 세그먼트 하나당 대략 이 정도(넉넉히 잡은 하한)
if (N * roughFragmentLen < 32768) throw new Error('클립 수가 부족해 32KB 명령줄 한도를 확실히 넘지 못할 수 있음 — N 을 늘리세요');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [projPath] });

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section(`1) 클립 ${N}개짜리 .dsvproj 열기`);
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-open-project').click(); true`);
  for (let i = 0; i < 60; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= N) break; await wait(300); }
  expect(`클립 ${N}개 복원됨`, await js(`document.querySelectorAll('.ve-clip').length`), N);

  section('2) 내보내기 — 예전엔 filter_complex 명령줄이 너무 길어 ffmpeg 자체가 못 떴다(spawn ENAMETOOLONG)');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 180; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  const toast = await js(`document.getElementById('ve-toast')?.textContent`);
  console.log(`  토스트 문구: ${toast}`);
  expect('출력 파일 생김(ENAMETOOLONG 없이 실제로 끝까지 인코딩됨)', fs.existsSync(OUT), true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
