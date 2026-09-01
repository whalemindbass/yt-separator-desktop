'use strict';
// 무음 구간 자동 제거 — 소리 1초 · 무음 1초 · 소리 1초 · 무음 1초(총 4초)짜리 클립에서
// "무음 구간 제거"를 실행하면 무음 두 구간이 잘려나가고 남은 소리 구간들이 서로 붙어야
// 한다(립플). 총 길이가 대략 2초(1+1)로 줄고, export 해도 그 길이 그대로 나오는지 확인.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesilence-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesilence-'));
const SRC = path.join(TMP, 'talk.mp4');   // 소리1초-무음1초-소리1초-무음1초
const W = 320, H = 240;

{
  const r = spawnSync(FFMPEG, ['-y',
    '-f', 'lavfi', '-i', `color=green:size=${W}x${H}:duration=4:rate=10`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono:d=1',
    '-filter_complex', '[1:a][2:a][3:a][4:a]concat=n=4:v=0:a=1[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC,
  ], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');
}

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  section('1) "무음 구간 제거" 실행 — 무음 두 구간이 잘리고 남은 소리 구간끼리 붙음');
  await js(`(() => {
    const el = [...document.querySelectorAll('.ve-clip')].find(x => !x.classList.contains('audio'));
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true }));
  })(); true`);
  await wait(100);
  await js(`(() => {
    const btn = [...document.querySelectorAll('.ve-ctxmenu-item')].find(b => b.textContent.includes('무음'));
    btn.click();
  })(); true`);
  // 비동기(ffmpeg silencedetect IPC) — 영상 트랙 클립 개수가 2개(소리 구간 2조각)로
  // 안정될 때까지 기다린다.
  let videoClipCount = 0;
  for (let i = 0; i < 60; i++) {
    videoClipCount = await js(`[...document.querySelectorAll('.ve-clip')].filter(x => !x.classList.contains('audio')).length`);
    if (videoClipCount === 2) break;
    await wait(300);
  }
  expect('영상 클립이 2조각(소리 구간)으로 남음', videoClipCount, 2);

  const totalDur = await js(`(() => {
    const els = [...document.querySelectorAll('.ve-clip')].filter(x => !x.classList.contains('audio'));
    let maxRight = 0;
    for (const el of els) { const right = parseFloat(el.style.left) + parseFloat(el.style.width); if (right > maxRight) maxRight = right; }
    return maxRight / 40;   // px → 초(기본 pxPerSec=40)
  })()`);
  near('전체 길이가 대략 2초(1초+1초, 무음 두 구간 잘림)로 줄어듦', totalDur, 2.0, 0.35);

  section('2) 내보내기 — 실제 파일 길이도 그만큼 줄어듦, 소리도 끊김 없이 있음');
  const OUT = path.join(TMP, 'out.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('export 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const probe = spawnSync(FFMPEG, ['-i', OUT], { encoding: 'utf-8' });
    const durM = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(probe.stderr || '');
    const outDur = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : -1;
    near('출력 파일 길이도 대략 2초', outDur, 2.0, 0.4);
    const vd = spawnSync(FFMPEG, ['-i', OUT, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf-8' });
    const mean = parseFloat((/mean_volume:\s*(-?[\d.]+)/.exec(vd.stderr || '') || [])[1] ?? '-999');
    expect('무음 구간이 빠졌으니 전체 평균 음량도 무음이 아님', mean > -50, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
