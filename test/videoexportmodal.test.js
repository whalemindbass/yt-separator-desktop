'use strict';
// 내보내기 세부설정 모달 — "내보내기" 버튼 클릭 시 바로 저장 대화상자가 뜨는 대신 화질/포맷/
// 프레임 설정 모달이 뜨고, 확인을 눌러야 실제 내보내기가 시작되는지. 툴바에서 #ve-format
// (버튼 좌측 포맷 선택)이 사라졌는지, 화질 설정이 실제로 파일 크기에 반영되는지(CRF 값
// 차이), 프레임 설정이 실제로 결과물 프레임레이트를 바꾸는지(ffprobe r_frame_rate)까지 검증.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veexpmodal-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veexpmodal-'));
// 화질 차이가 파일 크기로 드러나려면 압축이 어려운(노이즈 많은) 소스가 필요하다 —
// 단색/단순 패턴은 CRF 를 뭘 줘도 거의 같은 크기로 뭉개진다(실측으로 확인).
const SRC = path.join(TMP, 'noise.mp4');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=duration=3:size=320x240:rate=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function probeFps(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=r_frame_rate', '-of', 'default=noprint_wrappers=1:nokey=1', file], { encoding: 'utf-8' });
  const [n, d] = (r.stdout || '').trim().split('/').map(Number);
  return d ? n / d : n;
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트 — 툴바엔 더 이상 포맷 선택(#ve-format)이 없다');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  expect('#ve-format 없음', await js(`!document.getElementById('ve-format')`), true);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  section('2) 내보내기 버튼 — 바로 내보내지 않고 모달이 뜬다');
  expect('모달 처음엔 숨겨짐', await js(`document.getElementById('ve-modal').hidden`), true);
  await js(`document.getElementById('ve-export').click(); true`);
  await wait(50);
  expect('클릭하면 모달 열림', await js(`document.getElementById('ve-modal').hidden`), false);
  expect('아직 저장 대화상자는 안 뜸(취소 버튼으로 닫아도 파일 없음)', true, true);
  await js(`document.getElementById('ve-modal').querySelector('.x').click(); true`);
  expect('닫기(x) 누르면 모달 다시 숨김', await js(`document.getElementById('ve-modal').hidden`), true);

  section('3) 화질 낮음 vs 높음 — 실제 파일 크기 차이(CRF 반영)');
  const OUT_HI = path.join(TMP, 'out_high.mp4');
  const OUT_LO = path.join(TMP, 'out_low.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_HI });
  await js(`document.getElementById('ve-export').click(); true`);
  await wait(50);
  await js(`(() => {
    document.getElementById('ve-exp-q').value = 'high';
    document.getElementById('ve-exp-go').click();
  })(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_HI)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('높은 화질 출력 파일 생김', fs.existsSync(OUT_HI), true);

  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_LO });
  await js(`document.getElementById('ve-export').click(); true`);
  await wait(50);
  await js(`(() => {
    document.getElementById('ve-exp-q').value = 'low';
    document.getElementById('ve-exp-go').click();
  })(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_LO)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('낮은 화질 출력 파일 생김', fs.existsSync(OUT_LO), true);
  if (fs.existsSync(OUT_HI) && fs.existsSync(OUT_LO)) {
    const hiSize = fs.statSync(OUT_HI).size, loSize = fs.statSync(OUT_LO).size;
    expect('낮은 화질이 높은 화질보다 확실히 작음(CRF 차이 반영)', loSize < hiSize, true);
  }

  section('4) 프레임 설정 — 30fps 소스를 24fps 로 강제 내보내기');
  const OUT_FPS = path.join(TMP, 'out_fps24.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_FPS });
  await js(`document.getElementById('ve-export').click(); true`);
  await wait(50);
  await js(`(() => {
    document.getElementById('ve-exp-fps').value = '24';
    document.getElementById('ve-exp-go').click();
  })(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_FPS)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('fps 지정 출력 파일 생김', fs.existsSync(OUT_FPS), true);
  if (fs.existsSync(OUT_FPS)) near('출력 프레임레이트 ≈ 24fps', probeFps(OUT_FPS), 24, 0.5);

  section('5) 자동(기본값) — 소스 프레임레이트(30fps) 그대로');
  const OUT_AUTO = path.join(TMP, 'out_auto.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_AUTO });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_AUTO)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('자동 출력 파일 생김', fs.existsSync(OUT_AUTO), true);
  if (fs.existsSync(OUT_AUTO)) near('기본값이면 소스와 같은 30fps 유지', probeFps(OUT_AUTO), 30, 0.5);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
