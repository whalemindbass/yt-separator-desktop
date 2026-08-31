'use strict';
// 트랙에 도형(사각형/타원) 추가 — "+트랙" 메뉴의 "도형" 항목이 실제로는 <canvas> 로 그린
// PNG 를 이미지 클립으로 만든다("이미지 파이프라인 재사용" 설계).
//
// 사용자 피드백으로 잡은 버그 3개를 이 테스트가 커버한다:
//   1) 원/타원으로 바꿔도 화면에 안 바뀌어 보임 — 같은 파일 경로를 계속 덮어써서 브라우저가
//      캐시된 옛 그림을 계속 보여준 것(파일 자체는 맞게 써졌었다). 캐시버스터(?v=N)로 고침.
//   2) 사각형 크기 조절 시 가로세로 비율을 못 바꿈 — 도형엔 애초에 자기만의 위치/크기가
//      없어서 트랙 전체 PIP(항상 정사각 비율로만 확대/축소)를 억지로 썼던 것. 도형 전용
//      팝오버에 x/y/w/h 입력칸 + 미리보기 위 독립 리사이즈 박스를 새로 달았다.
//   3) 위아래로 이상한 여백 — 도형에 위치가 없으면(기본값 없음) "화면 꽉 채움"으로 오인돼
//      작은 그림을 프레임 전체로 늘려 붙였다. 이제 생성 시점부터 기본 위치를 준다.
//   4) 우클릭해도 설정 모달이 안 뜸 — 더블클릭만 지원했었다. 우클릭(contextmenu)도 추가.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veshape-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veshape-'));
const OUT = path.join(TMP, 'out.mp4');
const OUT2 = path.join(TMP, 'out2.mp4');
const W = 320, H = 240;

// 배경으로 쓸 검은 영상 하나(도형이 그 위 오버레이로 겹쳐지는지 보려면 바탕이 필요하다).
const BG = path.join(TMP, 'bg.mp4');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BG], { stdio: 'ignore' });
if (!fs.existsSync(BG)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function realPathFromYtsepSrc(src) {
  const m = /ytsep:\/\/f\/([^?]+)/.exec(src || '');   // 캐시버스터(?v=N) 뒤는 파일 경로가 아니다
  if (!m) return null;
  return decodeURIComponent(m[1]).replace(/\//g, '\\');
}
function samplePngPixel(file, w, h, x, y) {
  const raw = file + '.raw';
  spawnSync(FFMPEG, ['-y', '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (y * w + x) * 4;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2], a: buf[o + 3] };
}
function sampleFrame(file, x, y) {
  const raw = file + `.frame.${x}.${y}.raw`;
  spawnSync(FFMPEG, ['-y', '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (y * W + x) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}
// selector 엘리먼트 중심에서 pointerdown → (dx,dy) 만큼 이동 → pointerup(videocanvashandles.test.js 와 같은 패턴).
async function dragBy(js, selector, dx, dy) {
  await js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 9 }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 9 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 9 }));
  })(); true`);
}
const isRedish = (p) => p.r > 150 && p.g < 80 && p.b < 80;
const isBlackish = (p) => p.r < 40 && p.g < 40 && p.b < 40;

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 배경 영상 임포트 + "+트랙" 메뉴 — 도형 항목으로 사각형 추가');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
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
    const px = samplePngPixel(shapeFile, 96, 64, 48, 32);   // 기본 30%x20% 프레임 비율 기준 크기 근처 중앙
    expect('PNG 중앙이 빨강으로 채워짐', px.r > 200 && px.g < 60 && px.b < 60, true);
  }

  section('2b) 타원으로 바꾸면 실제로 다시 그려지는지(캐시 문제로 안 바뀌어 보이던 버그)');
  const revBefore = await js(`(() => {
    const img = document.querySelector('.ve-clip.image .ve-thumbs img');
    const m = /[?&]v=(\\d+)/.exec(img?.src || '');
    return m ? Number(m[1]) : -1;
  })()`);
  await js(`(() => {
    const pop = document.querySelector('.ve-text-pop');
    pop.querySelector('#sh-type').value = 'ellipse';
    pop.querySelector('#sh-type').dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  await wait(200);
  const revAfter = await js(`(() => {
    const img = document.querySelector('.ve-clip.image .ve-thumbs img');
    const m = /[?&]v=(\\d+)/.exec(img?.src || '');
    return m ? Number(m[1]) : -1;
  })()`);
  expect('캐시버스터 값이 바뀜(브라우저가 새로 읽어오게)', revAfter > revBefore, true);
  const src2 = await js(`document.querySelector('.ve-clip.image .ve-thumbs img')?.getAttribute('src')`);
  const shapeFile2 = realPathFromYtsepSrc(src2);
  if (shapeFile2) {
    // 사각형이면 모서리(2,2)도 채워지지만, 타원이면 모서리는 원 밖이라 투명(alpha=0)이어야 한다.
    const corner = samplePngPixel(shapeFile2, 96, 64, 2, 2);
    expect('타원으로 바뀌어서 모서리는 투명(사각형이면 안 그랬을 것)', corner.a, 0);
  }

  section('3) 도형 전용 위치/크기(x/y/w/h) — 트랙 PIP 와 달리 가로세로 독립적으로 늘릴 수 있음');
  await js(`(() => {
    const pop = document.querySelector('.ve-text-pop');
    pop.querySelector('#sh-x').value = 55; pop.querySelector('#sh-x').dispatchEvent(new Event('input', { bubbles: true }));
    pop.querySelector('#sh-y').value = 60; pop.querySelector('#sh-y').dispatchEvent(new Event('input', { bubbles: true }));
    pop.querySelector('#sh-w').value = 40; pop.querySelector('#sh-w').dispatchEvent(new Event('input', { bubbles: true }));
    pop.querySelector('#sh-h').value = 12; pop.querySelector('#sh-h').dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(150);

  section('3b) 미리보기 위 리사이즈 박스를 세로로만 드래그 — 폭은 그대로, 높이만 바뀌는지(비율 안 묶임)');
  const wBefore = Number(await js(`document.getElementById('sh-w').value`));
  const hBefore = Number(await js(`document.getElementById('sh-h').value`));
  await dragBy(js, '.ve-pip-box-handle', 0, 25);   // 오른쪽으로는 안 움직이고 아래로만
  await wait(100);
  const wAfter = Number(await js(`document.getElementById('sh-w').value`));
  const hAfter = Number(await js(`document.getElementById('sh-h').value`));
  expect('세로로만 드래그하면 폭은 거의 그대로', Math.abs(wAfter - wBefore) <= 2, true);
  expect('높이는 늘어남(가로세로 독립적으로 조절됨)', hAfter > hBefore + 3, true);

  section('3c) 미리보기 레이어의 object-fit — 위치가 걸린 오버레이는 비율 무시하고 늘어나야(실제 내보내기와 일치)');
  const objectFit = await js(`(() => {
    const img = [...document.querySelectorAll('#ve-preview .ve-video-layers img')].find(el => !el.hidden);
    return img ? getComputedStyle(img).objectFit : null;
  })()`);
  expect('오버레이 위치가 걸리면 object-fit: fill(레터박스 없이 그대로 늘림)', objectFit, 'fill');

  section('4) 내보내기 — 지정한 위치에 도형이 실제로 찍히고, 다른 곳은 배경 그대로인지');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    // x=55%,y=60%,w=40%,h=12% → 중심 근처(55+20, 60+6)%.
    const inside = sampleFrame(OUT, Math.round(W * 0.65), Math.round(H * 0.63));
    const outside = sampleFrame(OUT, 10, 10);
    expect('지정한 자리 근처에 빨강 도형', isRedish(inside), true);
    expect('먼 구석은 배경(검정) 그대로 — 프레임 전체로 안 늘어남', isBlackish(outside), true);
  }

  section('5) 우클릭 — 클립을 새로 안 만들고 같은 설정 팝오버가 다시 열리는지');
  await js(`(() => { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 })); })(); true`);
  await wait(80);
  expect('먼저 팝오버 닫힘(바깥 클릭)', await js(`!document.querySelector('.ve-text-pop')`), true);
  const clipCountBefore = await js(`document.querySelectorAll('.ve-clip').length`);
  await js(`document.querySelector('.ve-clip.image').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`);
  await wait(100);
  expect('우클릭으로 설정 팝오버가 다시 뜸', await js(`!!document.querySelector('.ve-text-pop #sh-type')`), true);
  expect('클립이 새로 생기지 않음(개수 그대로)', await js(`document.querySelectorAll('.ve-clip').length`), clipCountBefore);
  expect('기존 값(타원)이 그대로 보임', await js(`document.querySelector('#sh-type').value`), 'ellipse');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
