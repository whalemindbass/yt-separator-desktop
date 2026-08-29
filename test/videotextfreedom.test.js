'use strict';
// 텍스트 위치 자유도 — PIP 와 동일하게 프레임 테두리에 안 묶인다, 밖으로 드래그하면
// 그만큼 잘려 보이는 게 맞다(요청: "화면 밖으로 내보낼 수 있어야 한다, 자유도 향상").
//
// 여전히 지켜야 하는 건 따로 있다 — CSS 버그(position:absolute + left:X% 가 오른쪽 끝
// 근처에서 shrink-to-fit 가용폭을 좁게 계산해 텍스트가 불필요하게 줄바꿈되던 것)는
// "잘림"이 아니라 "안 옮겼는데 저절로 좁아지는" 진짜 버그였다 — 그건 여전히 고쳐진 채여야
// 한다: 자리를 옮겨도(아직 실제로 프레임 밖으로 나가지 않은 한) 자연 크기 그대로 유지.
// 진짜로 프레임 밖까지 나가면(이번 요청대로) 그만큼은 잘려도 된다.

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
  return maxX > -1 ? maxX - minX + 1 : 0;   // 실제 그려진 박스(글자+배경)의 가로폭(px), 아예 안 보이면 0
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  const baseSeg = { file: SRC, start: 0, end: 2, refW: W, refH: H, dur: 2, audioSources: [{ file: SRC, start: 0, end: 2 }] };

  section('1) main.js — 아직 프레임 안에 다 들어오는 자리(x=0.85)에서는 CSS 버그로 안 좁아짐');
  const OUT_CENTER = path.join(TMP, 'center.mp4');
  let res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ content: 'HI', x: 0.5, y: 0.5, size: 28, color: '#ffff00' }] }], outPath: OUT_CENTER, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('가운데 텍스트 export 성공', res?.ok, true);
  if (!res?.ok) console.log('  export error:', res?.error);
  const spanCenter = res?.ok ? measureSpan(OUT_CENTER) : 0;

  const OUT_NEAR = path.join(TMP, 'near.mp4');   // 아직 안 잘리는 위치(작은 글자, 상자가 프레임 안에 다 들어옴)
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ content: 'HI', x: 0.85, y: 0.5, size: 28, color: '#ffff00' }] }], outPath: OUT_NEAR, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('근처(x=0.85) 텍스트 export 성공', res?.ok, true);
  const spanNear = measureSpan(OUT_NEAR);
  expect(`아직 안 잘리는 자리에선 폭이 그대로(가운데 ${spanCenter}px, x=0.85 → ${spanNear}px)`, spanNear, spanCenter);

  section('2) main.js — 진짜로 프레임 밖까지(x=1.5) 밀어내면 잘리는 게 맞음(자유도)');
  const OUT_OFF = path.join(TMP, 'off.mp4');
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ content: 'HI', x: 1.5, y: 0.5, size: 28, color: '#ffff00' }] }], outPath: OUT_OFF, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('프레임 완전히 밖으로 나간 텍스트도 export 성공(에러 안 남)', res?.ok, true);
  const spanOff = measureSpan(OUT_OFF);
  expect(`x=1.5(프레임 절반만큼 밖) 이면 화면에 아예 안 보임(잘려서 폭 0)`, spanOff, 0);

  section('3) 렌더러 미리보기 — 아직 안 잘리는 자리(x=85%)에선 폭 그대로, 완전히 밖(x=150%)이면 자유롭게 나감');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="text"]').click(); true`);
  await wait(150);
  const w0 = await js(`document.querySelector('.ve-text-item.sel').getBoundingClientRect().width`);
  await js(`(() => {
    const el = document.getElementById('tx-x'); el.value = 85;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  const w1 = await js(`document.querySelector('.ve-text-item.sel').getBoundingClientRect().width`);
  near('아직 프레임 안에 있는 자리(85%)에서는 폭이 거의 그대로(±1px, CSS 줄바꿈 버그 없음)', Math.abs(w1 - w0), 0, 1);

  await js(`(() => {
    const el = document.getElementById('tx-x'); el.value = 150;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  const rightEdge = await js(`(() => {
    const r = document.querySelector('.ve-text-item.sel').getBoundingClientRect();
    const hr = document.getElementById('ve-preview').getBoundingClientRect();
    return r.right - hr.right;
  })()`);
  expect('150% 위치로 옮기면 프레임 경계를 실제로 넘어감(더 이상 안에 묶여있지 않음)', rightEdge > 10, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
