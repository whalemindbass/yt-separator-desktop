'use strict';
// 트랙에 도형(사각형/타원) 추가 — "+트랙" 메뉴의 "도형" 항목이 실제로는 <canvas> 로 그린
// PNG 를 이미지 클립으로 만든다("이미지 파이프라인 재사용" 설계) — 팝오버에서 채우기색을
// 바꾸면 파일이 다시 그려지는지, PIP 로 위치를 옮겨 내보냈을 때 그 자리에 실제로 그
// 색이 찍히는지(main.js 의 -loop 1 이미지 입력 재사용)까지 실측으로 검증한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veshape-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veshape-'));
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

// 배경으로 쓸 검은 영상 하나(도형이 그 위 PIP 레이어로 겹쳐지는지 보려면 바탕이 필요하다).
const BG = path.join(TMP, 'bg.mp4');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BG], { stdio: 'ignore' });
if (!fs.existsSync(BG)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function realPathFromYtsepSrc(src) {
  const m = /ytsep:\/\/f\/(.+)$/.exec(src || '');
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/\//g, '\\');
}
function samplePixel(file, w, h, x, y) {
  const raw = file + '.raw';
  spawnSync(FFMPEG, ['-y', '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (y * w + x) * 4;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2], a: buf[o + 3] };
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 배경 영상 임포트 + "+트랙" 메뉴 — 도형 항목으로 사각형 추가');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="shape"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }
  expect('도형(이미지 파이프라인) 클립 1개 생김', await js(`document.querySelectorAll('.ve-clip.image').length`), 1);
  expect('영상 트랙 2개(배경 + 도형용 새 트랙)', await js(`document.querySelectorAll('.ve-lane:not(.audio):not(.text)').length`), 2);
  expect('팝오버가 자동으로 열림', await js(`!!document.querySelector('.ve-text-pop #sh-type')`), true);

  section('2) 팝오버 — 채우기색을 빨강으로 바꾸면 파일이 그 색으로 다시 그려짐');
  await js(`(() => {
    const pop = document.querySelector('.ve-text-pop');
    pop.querySelector('#sh-fill').value = '#ff0000';
    pop.querySelector('#sh-fill').dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(200);
  const src = await js(`document.querySelector('.ve-clip.image .ve-thumbs img')?.getAttribute('src')`);
  const shapeFile = realPathFromYtsepSrc(src);
  expect('생성된 PNG 파일 경로를 얻음', !!shapeFile && fs.existsSync(shapeFile), true);
  if (shapeFile) {
    const px = samplePixel(shapeFile, 96, 64, 48, 32);   // 기본 30%x20% 프레임 비율 기준 크기 근처 중앙
    expect('PNG 중앙이 빨강으로 채워짐', px.r > 200 && px.g < 60 && px.b < 60, true);
  }

  section('3) PIP 로 우측하단 30% 로 옮기고 내보내기 — 그 자리에 빨강이 찍히는지');
  await js(`(() => {
    const shapeLane = [...document.querySelectorAll('.ve-lane:not(.audio):not(.text)')][0];
    shapeLane.querySelector('.ve-pip')?.click();
  })(); true`);
  await wait(100);
  await js(`(() => {
    document.getElementById('pip-x').value = 65;
    document.getElementById('pip-x').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('pip-y').value = 65;
    document.getElementById('pip-y').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('pip-scale').value = 30;
    document.getElementById('pip-scale').dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(150);

  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const rawTop = OUT + '.rgb';
    spawnSync(FFMPEG, ['-y', '-i', OUT, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, rawTop], { stdio: 'ignore' });
    const buf = fs.readFileSync(rawTop);
    const px = (x, y) => { const o = (y * W + x) * 3; return { r: buf[o], g: buf[o + 1], b: buf[o + 2] }; };
    const corner = px(Math.round(W * 0.8), Math.round(H * 0.8));   // PIP 65%+scale30% 안쪽
    const topLeft = px(10, 10);
    expect('우측하단(PIP 자리)이 빨강', corner.r > 150 && corner.g < 80 && corner.b < 80, true);
    expect('좌상단은 배경(검정) 그대로', topLeft.r < 40 && topLeft.g < 40 && topLeft.b < 40, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
