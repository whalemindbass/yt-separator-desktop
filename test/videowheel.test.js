'use strict';
// 영상 편집 — 트랙 위에서 마우스 휠 = 가로(시간축) 스크롤, 트랙 컨트롤(헤드) 위에서는
// 그대로 세로(네이티브, 트랙 목록 훑기용). 그리고 오른쪽 끝까지 스크롤하면 타임라인이
// 유기적으로(자동으로) 늘어나서 계속 더 뒤로 갈 수 있는지.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vewheel-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vewheel-'));
const SRC = path.join(TMP, 'src.mp4');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=5:size=320x240:rate=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  section('2) 트랙 컨트롤(헤드) 위 휠 — 가로 스크롤 안 건드림');
  await js(`document.querySelector('.ve-head').dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })); true`);
  await wait(80);
  expect('헤드 위 휠은 scrollLeft 그대로', await js(`document.getElementById('ve-tscroll').scrollLeft`), 0);

  section('3) 타임라인(영역) 위 휠 — 가로로 움직임');
  await js(`document.querySelector('.ve-area').dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true })); true`);
  await wait(80);
  const afterWheel = Number(await js(`document.getElementById('ve-tscroll').scrollLeft`));
  expect('영역 위 휠로 scrollLeft 움직임', afterWheel > 0, true);

  section('4) 오른쪽 끝까지 계속 스크롤 — 타임라인이 유기적으로 늘어남');
  const before = Number(await js(`document.getElementById('ve-tscroll').scrollWidth`));
  for (let i = 0; i < 15; i++) {
    await js(`(() => {
      const sc = document.getElementById('ve-tscroll');
      sc.scrollLeft = sc.scrollWidth;
      document.querySelector('.ve-area').dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true }));
    })(); true`);
    await wait(30);
  }
  const after = Number(await js(`document.getElementById('ve-tscroll').scrollWidth`));
  expect('끝까지 스크롤 반복하면 스크롤 폭이 계속 늘어남', after > before * 2, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
