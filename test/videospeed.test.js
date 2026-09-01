'use strict';
// 클립 배속(speed) — 우클릭 메뉴 "속도..." → 팝오버에서 %로 조절. 타임라인 길이(dur)가
// 배속에 반비례로 바뀌고(빠르면 짧게), 실제 export 도 그 길이대로 나오면서 소스 안의
// 색 전환 지점이 정확히 배속만큼 압축/신장된 시각에 와야 한다(setpts 정확성 검증).
// 오디오(atempo)도 같이 늘어난/줄어든 길이로 무음 없이 나오는지 확인.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vespeed-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vespeed-'));
const SRC = path.join(TMP, 'rb.mp4');   // 0~1초 빨강, 1~2초 파랑, 사인파 오디오 2초
const W = 320, H = 240;

{
  const r = spawnSync(FFMPEG, ['-y',
    '-f', 'lavfi', '-i', `color=red:size=${W}x${H}:duration=1:rate=10`,
    '-f', 'lavfi', '-i', `color=blue:size=${W}x${H}:duration=1:rate=10`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', SRC,
  ], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');
}

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function isRed(px) { return px.r > 180 && px.g < 80 && px.b < 80; }
function isBlue(px) { return px.b > 180 && px.r < 80 && px.g < 80; }

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  const clipCount = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('클립 임포트됨(영상+짝지어진 오디오 있으면 2개, 없으면 1개)', clipCount >= 1, true);

  function openSpeedPopover() {
    return js(`(() => {
      const el = [...document.querySelectorAll('.ve-clip')].find(x => !x.classList.contains('audio'));
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true }));
    })(); true`);
  }
  function setSpeedPct(pct) {
    return js(`(() => {
      const btn = [...document.querySelectorAll('.ve-ctxmenu-item')].find(b => b.textContent.includes('속도'));
      btn.click();
      const input = document.getElementById('sp-val');
      input.value = ${pct};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })(); true`);
  }
  function videoClipWidthPx() {
    return js(`parseFloat([...document.querySelectorAll('.ve-clip')].find(x => !x.classList.contains('audio')).style.width)`);
  }
  function speedBadgeText() {
    return js(`[...document.querySelectorAll('.ve-clip')].find(x => !x.classList.contains('audio')).querySelector('.ve-clip-speed')?.textContent || null`);
  }

  section('1) 2배속 — 타임라인 길이가 절반(80px→40px), 배지 "2×"');
  await openSpeedPopover();
  await wait(100);
  await setSpeedPct(200);
  await wait(100);
  near('2배속이면 클립 폭이 절반(2초→1초=40px)', await videoClipWidthPx(), 40, 1);
  expect('배속 배지가 "2×"', await speedBadgeText(), '2×');

  const OUT2X = path.join(TMP, 'out2x.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT2X });
  await js(`document.getElementById('ve-export').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT2X)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('2배속 export 파일 생김', fs.existsSync(OUT2X), true);
  if (fs.existsSync(OUT2X)) {
    const probe = spawnSync(FFMPEG, ['-i', OUT2X], { encoding: 'utf-8' });
    const durM = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(probe.stderr || '');
    const outDur = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : -1;
    near('2배속 출력 길이 ≈ 1.0초(2초÷2)', outDur, 1.0, 0.15);

    const raw04 = path.join(TMP, 'f04.raw'), raw06 = path.join(TMP, 'f06.raw');
    spawnSync(FFMPEG, ['-y', '-ss', '0.4', '-i', OUT2X, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw04], { stdio: 'ignore' });
    spawnSync(FFMPEG, ['-y', '-ss', '0.6', '-i', OUT2X, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw06], { stdio: 'ignore' });
    const px = (buf) => ({ r: buf[0], g: buf[1], b: buf[2] });
    expect('0.4초(경계 0.5초 전) — 아직 빨강', isRed(px(fs.readFileSync(raw04))), true);
    expect('0.6초(경계 0.5초 후) — 이미 파랑(색 전환이 정확히 절반 시각으로 압축됨)', isBlue(px(fs.readFileSync(raw06))), true);

    const vd = spawnSync(FFMPEG, ['-i', OUT2X, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf-8' });
    const mean = parseFloat((/mean_volume:\s*(-?[\d.]+)/.exec(vd.stderr || '') || [])[1] ?? '-999');
    expect('오디오도 무음 아님(atempo 가 소리를 죽이지 않음)', mean > -80, true);
  }

  section('2) 0.5배속(프리셋 버튼) — 타임라인 길이가 2배(40px→160px), 배지 "0.5×"');
  await openSpeedPopover();
  await wait(100);
  await js(`document.querySelector('#sp-presets button[data-p="50"]').click(); true`);
  await wait(100);
  near('0.5배속이면 폭이 2초 기준의 4배(원래 2초 소스÷0.5=4초=160px)', await videoClipWidthPx(), 160, 1);
  expect('배속 배지가 "0.5×"', await speedBadgeText(), '0.5×');

  const OUTHALF = path.join(TMP, 'outhalf.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUTHALF });
  await js(`document.getElementById('ve-export').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUTHALF)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('0.5배속 export 파일 생김', fs.existsSync(OUTHALF), true);
  if (fs.existsSync(OUTHALF)) {
    const probe = spawnSync(FFMPEG, ['-i', OUTHALF], { encoding: 'utf-8' });
    const durM = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(probe.stderr || '');
    const outDur = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : -1;
    near('0.5배속 출력 길이 ≈ 4.0초(2초÷0.5)', outDur, 4.0, 0.3);
  }

  section('3) 범위를 벗어난 값은 클램프됨(400% 상한)');
  await openSpeedPopover();
  await wait(100);
  await setSpeedPct(1000);
  await wait(100);
  expect('1000% 입력해도 400%(상한)로 클램프', await speedBadgeText(), '4×');

  section('4) Ctrl+Z — 배속과 길이가 이전 단계로 되돌아감');
  const widthBefore = await videoClipWidthPx();
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })); true`);
  await wait(100);
  const widthAfter = await videoClipWidthPx();
  expect('Ctrl+Z 로 폭이 바뀜(직전 배속으로 복귀)', widthAfter !== widthBefore, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
