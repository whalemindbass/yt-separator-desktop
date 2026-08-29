'use strict';
// 영상 편집 탭 — 같은 트랙에서 클립 둘을 겹치게 끌어다 놓으면(Vegas Pro 관례) 그 겹친
// 구간만큼 자동 크로스페이드되는지. 미리보기(opacity 블렌드)와 내보내기(ffmpeg xfade/
// acrossfade) 둘 다 실제로 확인한다 — 이 필터그래프는 눈으로 안 보면 offset/duration
// 계산이 맞는지 알 수 없어서(실제로 처음엔 감으로 짰다가 여기서 검증했다) 매번 돈다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vexf-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vexf-'));
const RED = path.join(TMP, 'red.mp4');    // 3초
const BLUE = path.join(TMP, 'blue.mp4');  // 2초
const OUT = path.join(TMP, 'out.mp4');
function makeClip(file, pattern, seconds) {
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `${pattern}=duration=${seconds}:size=320x240:rate=15`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(RED, 'testsrc', 3);
makeClip(BLUE, 'testsrc2', 2);

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED, BLUE] });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 2000 });

  section('1) 임포트 (연속 배치: red 0~3초, blue 3~5초)');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-import').click(); true`);
  let n = 0;
  for (let i = 0; i < 40; i++) {
    n = await js(`document.querySelectorAll('.ve-clip').length`);
    if (n >= 2) break;
    await wait(300);
  }
  expect('클립 2개 임포트됨', n, 2);

  section('2) blue 를 왼쪽으로 1초(40px) 끌어 red 꼬리와 겹침');
  await js(`(() => {
    const clip = [...document.querySelectorAll('.ve-clip')].find(el => el.querySelector('.ve-clip-lbl').textContent === 'blue.mp4');
    const r = clip.getBoundingClientRect();
    clip.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 5, clientY: r.top + 5, pointerId: 9, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left + 5 - 40, clientY: r.top + 5, pointerId: 9, bubbles: true }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: r.left + 5 - 40, clientY: r.top + 5, pointerId: 9, bubbles: true }));
  })(); true`);
  await wait(150);
  const positions = await js(`[...document.querySelectorAll('.ve-clip')].map(el => ({
    label: el.querySelector('.ve-clip-lbl').textContent, left: parseFloat(el.style.left),
  }))`);
  const blue = positions.find(p => p.label === 'blue.mp4');
  near('blue 클립이 2초(80px) 지점에서 시작(1초 겹침)', blue?.left, 80, 2);

  section('3) 미리보기 — 겹친 구간 중간에서 두 레이어가 50/50 으로 섞임');
  await js(`document.querySelector('.ve-area').dispatchEvent(new PointerEvent('pointerdown', { clientX: 172 + 2.5 * 40, clientY: 10, bubbles: true })); true`);
  await wait(300);
  const layers = await js(`[...document.querySelectorAll('#ve-preview video')].map(v => ({ hidden: v.hidden, opacity: parseFloat(v.style.opacity || '1') }))`);
  const visible = layers.filter(l => !l.hidden);
  expect('두 레이어 다 보임(겹친 구간)', visible.length, 2);
  if (visible.length === 2) {
    near('opacity 합이 1(정확히 크로스페이드)', visible[0].opacity + visible[1].opacity, 1, 0.05);
    near('한쪽은 대략 0.5', visible[0].opacity, 0.5, 0.15);
  }

  section('4) 내보내기 — xfade/acrossfade 필터가 실제로 성공하는가');
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  let btnLabel = '';
  for (let i = 0; i < 60; i++) {
    btnLabel = await js(`document.getElementById('ve-export').textContent`);
    if (fs.existsSync(OUT) && !/%$/.test(btnLabel)) break;
    await wait(500);
  }
  const toast = await js(`document.getElementById('ve-toast')?.textContent`);
  expect('완료 토스트', toast, '내보내기 완료');
  expect('출력 파일 생김', fs.existsSync(OUT), true);

  if (fs.existsSync(OUT)) {
    section('5) 결과물 길이 — 3+2-1(겹친 만큼 짧아짐)');
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1', OUT], { encoding: 'utf-8' });
    near('총 길이 ≈ 4초', parseFloat((/duration=([\d.]+)/.exec(r.stdout || '') || [])[1] || 0), 4, 0.2);
  }

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
