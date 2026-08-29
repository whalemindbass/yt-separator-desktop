'use strict';
// 텍스트를 프레임 가장자리(특히 오른쪽)로 옮겨도 폭이 줄어들며 잘리면 안 된다 — 크기는
// 오직 사용자가 리사이즈 핸들/숫자칸으로만 바꿀 수 있어야 한다는 요청. main.js 의 drawtext
// x/y 를 min/max 로 클램프해서 텍스트(+박스 배경)가 항상 프레임 안에 완전히 들어오게 했다
// — 실제로 "안 잘림(자연 폭 그대로)"을 픽셀로 확인한다(클램프 없으면 잘려서 폭이 준다).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetxclamp-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetxclamp-'));
const SRC = path.join(TMP, 'blue.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=blue:size=${W}x${H}:duration=2:rate=10`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

// 노란 박스(텍스트+반투명 검정 배경 중 눈에 띄는 텍스트 픽셀 기준)의 x범위를 잰다.
function measureSpan(file) {
  const raw = path.join(TMP, path.basename(file, '.mp4') + '.rgb');
  spawnSync(FFMPEG, ['-y', '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const d = fs.readFileSync(raw);
  let minX = 999, maxX = -1;
  for (let yy = 0; yy < H; yy++) for (let xx = 0; xx < W; xx++) {
    const i = (yy * W + xx) * 3;
    const R = d[i], G = d[i + 1], B = d[i + 2];
    const isBlue = B > 150 && R < 80 && G < 80;
    if (!isBlue) { if (xx < minX) minX = xx; if (xx > maxX) maxX = xx; }
  }
  return maxX - minX + 1;   // 실제 그려진 박스(글자+배경)의 가로폭(px)
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  const baseSeg = { file: SRC, start: 0, end: 2, refW: W, refH: H, dur: 2, audioSources: [{ file: SRC, start: 0, end: 2 }] };

  section('1) main.js — 가운데 vs 오른쪽 끝(x=0.98) 텍스트, 실제 그려진 폭이 같아야 함(안 잘림)');
  const OUT_CENTER = path.join(TMP, 'center.mp4');
  let res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ content: 'HI', x: 0.5, y: 0.5, size: 28, color: '#ffff00' }] }], outPath: OUT_CENTER, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('가운데 텍스트 export 성공', res?.ok, true);
  if (!res?.ok) console.log('  export error:', res?.error);
  const spanCenter = res?.ok ? measureSpan(OUT_CENTER) : 0;

  const OUT_EDGE = path.join(TMP, 'edge.mp4');
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ content: 'HI', x: 0.98, y: 0.5, size: 28, color: '#ffff00' }] }], outPath: OUT_EDGE, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('오른쪽 끝 텍스트 export 성공', res?.ok, true);
  const spanEdge = measureSpan(OUT_EDGE);
  expect(`오른쪽 끝(x=0.98)에서도 폭이 안 줄어듦(가운데 ${spanCenter}px, 끝 ${spanEdge}px)`, spanEdge, spanCenter);

  section('2) 렌더러 미리보기 — 오른쪽 끝으로 드래그해도 실제 렌더 크기(getBoundingClientRect)가 안 줄어듦');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-text').click(); true`);
  await wait(150);
  const w0 = await js(`document.querySelector('.ve-text-item.sel').getBoundingClientRect().width`);
  // 팝오버 숫자칸으로 x=98% 로 옮긴다(팝오버가 열려 있으므로).
  await js(`(() => {
    const el = document.getElementById('tx-x'); el.value = 98;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  const w1 = await js(`document.querySelector('.ve-text-item.sel').getBoundingClientRect().width`);
  near('미리보기에서도 오른쪽 끝 이동 후 폭이 거의 그대로(±1px)', Math.abs(w1 - w0), 0, 1);
  const rightEdge = await js(`(() => {
    const r = document.querySelector('.ve-text-item.sel').getBoundingClientRect();
    const hr = document.getElementById('ve-preview').getBoundingClientRect();
    return r.right - hr.right;
  })()`);
  expect('오른쪽 끝이 프레임 경계를 넘지 않음(0 이하)', rightEdge <= 0.5, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
