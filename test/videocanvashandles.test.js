'use strict';
// 미리보기 위에서 직접 드래그로 위치/크기 조정 — "숫자칸으로만 조정 가능하다"는 문제
// 제기에 대한 응답. PIP 박스(영상 트랙, openPipPopover 로 열림)와 텍스트 아이템(선택된
// 텍스트 클립) 둘 다: 1) 본문 드래그 = 위치 이동, 2) 모서리 핸들 드래그 = 크기 조절,
// 3) 숫자 입력칸과 캔버스 조작이 서로 실시간으로 맞는지(양방향) 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vehandles-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vehandles-'));
const SRC = path.join(TMP, 'red.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=red:size=${W}x${H}:duration=3:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

// selector 엘리먼트 중심에서 pointerdown → (dx,dy) 만큼 이동 → pointerup 을 실제 이벤트로 쏜다.
async function dragBy(js, selector, dx, dy) {
  const err = await js(`(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NO_EL';
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 1 }));
      return null;
    } catch (e) { return String(e && (e.stack || e.message || e)); }
  })()`);
  if (err) console.log('  dragBy error:', err);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) PIP 박스 — 미리보기 위 드래그로 위치/크기, 숫자칸과 양방향 동기화');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await js(`document.querySelector('.ve-lane .ve-pip').click(); true`);
  await wait(100);
  expect('PIP 박스가 미리보기에 나타남', await js(`!!document.querySelector('.ve-pip-box')`), true);
  // 처음엔 w=h=100%(풀프레임)이라 이동 여지가 없다 — 먼저 숫자칸으로 축소.
  await js(`(() => {
    document.getElementById('pip-w').value = 30;
    document.getElementById('pip-w').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('pip-h').value = 30;
    document.getElementById('pip-h').dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(80);
  expect('숫자칸 축소가 박스 크기에도 반영됨', await js(`document.querySelector('.ve-pip-box').style.width`), '30%');

  await dragBy(js, '.ve-pip-box', 40, 20);
  await wait(80);
  const pipX1 = Number(await js(`document.getElementById('pip-x').value`));
  const pipY1 = Number(await js(`document.getElementById('pip-y').value`));
  expect('박스 드래그(오른쪽 아래)로 pip-x 증가', pipX1 > 0, true);
  expect('박스 드래그로 pip-y 증가', pipY1 > 0, true);

  const wBefore = Number(await js(`document.getElementById('pip-w').value`));
  const hBefore = Number(await js(`document.getElementById('pip-h').value`));
  await dragBy(js, '.ve-pip-box-handle', 30, 30);
  await wait(80);
  const wAfter = Number(await js(`document.getElementById('pip-w').value`));
  const hAfter = Number(await js(`document.getElementById('pip-h').value`));
  expect('모서리 핸들 드래그로 폭 커짐', wAfter > wBefore, true);
  expect('모서리 핸들 드래그로 높이도 커짐', hAfter > hBefore, true);

  section('2) 실제 export 에도 캔버스 드래그 결과가 반영되는가(픽셀 검증)');
  const OUT = path.join(TMP, 'out_pip.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('드래그로 조정한 PIP export 성공', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const raw = path.join(TMP, 'frame_pip.rgb');
    spawnSync(FFMPEG, ['-y', '-i', OUT, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
    const d = fs.readFileSync(raw);
    // 중앙(드래그로 옮긴 뒤에는 박스가 화면 가운데를 덮지 않을 가능성이 높다) 대신, 전체에서
    // 빨간 픽셀이 검정 배경보다 훨씬 적게(즉 화면 전체를 채우지 않고 일부만) 있는지로
    // "박스가 실제로 작아지고 옮겨졌다"는 걸 대략 확인한다.
    let red = 0, black = 0;
    for (let i = 0; i < d.length; i += 3) { const r = d[i], g = d[i + 1], b = d[i + 2]; if (r > 150 && g < 80 && b < 80) red++; else if (r < 30 && g < 30 && b < 30) black++; }
    expect('배경(검정)이 화면 대부분을 차지(PIP 가 축소됨)', black > red, true);
  }

  section('3) 텍스트 — 미리보기에서 바로 드래그(위치)·리사이즈 핸들(크기)');
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="text"]').click(); true`);
  await wait(150);
  expect('선택된 텍스트 아이템에 리사이즈 핸들 있음', await js(`!!document.querySelector('.ve-text-item.sel .ve-text-item-rs')`), true);
  const x0 = Number(await js(`document.getElementById('tx-x').value`));
  const y0 = Number(await js(`document.getElementById('tx-y').value`));

  await dragBy(js, '.ve-text-item.sel', 30, -25);
  await wait(80);
  const x1 = Number(await js(`document.getElementById('tx-x').value`));
  const y1 = Number(await js(`document.getElementById('tx-y').value`));
  expect('텍스트 드래그(오른쪽) → tx-x 증가', x1 > x0, true);
  expect('텍스트 드래그(위) → tx-y 감소', y1 < y0, true);

  const size0 = Number(await js(`document.getElementById('tx-size').value`));
  await dragBy(js, '.ve-text-item.sel .ve-text-item-rs', 40, 40);
  await wait(80);
  const size1 = Number(await js(`document.getElementById('tx-size').value`));
  expect('리사이즈 핸들 드래그(바깥쪽) → 글자 크기 커짐', size1 > size0, true);
  // clip.size 는 출력 해상도 기준 px 라, 미리보기 CSS font-size 는 화면 축소 배율만큼
  // 줄어서 렌더된다(videotextsize.test.js 에서 배율 자체를 따로 검증함) — 여긴 raw size1
  // 이 아니라 그 배율을 반영한 값과 같은지 본다.
  const fontInfo = await js(`(() => {
    const host = document.getElementById('ve-preview');
    const el = document.querySelector('.ve-text-item.sel');
    return JSON.stringify({ previewW: host.clientWidth, css: parseFloat(el.style.fontSize) });
  })()`);
  const { previewW: fiPreviewW, css: fiCss } = JSON.parse(fontInfo);
  near('미리보기 요소 폰트 크기도 실제로 커짐(배율 반영, 소스 320x240 기준)', fiCss, size1 * (fiPreviewW / W), 0.5);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
