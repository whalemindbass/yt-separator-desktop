'use strict';
// 영상 편집 — 눈금자(트랙 위 타임라인) 클릭/드래그로 재생선 이동. bootRenderer 로 충분한
// 순수 UI 동작(엔진·ffmpeg 무관)이라 가볍게 돈다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veruler-'));
const RED = path.join(TMP, 'red.mp4');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=10:size=320x240:rate=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', RED], { stdio: 'ignore' });

const { bootRenderer, expect, near, section, wait, finish } = require('./harness');
function toSec(tc) {   // "M:SS.mmm" → 초
  const m = /^(\d+):(\d+)\.(\d+)$/.exec(tc || '');
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
}

(async () => {
  const { app, js } = await bootRenderer({
    stubs: { 'dialog:pickVideoFiles': () => ({ ok: true, filePaths: [RED] }) },
  });

  section('1) 임포트');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) {
    if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break;
    await wait(300);
  }

  section('2) 눈금자 클릭 — 재생선이 클릭 지점(초 단위)으로 이동');
  // pxPerSec 기본값 40 — 눈금자 왼쪽에서 200px 지점 클릭 → 5.0초 근처로 이동해야 한다.
  await js(`(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', { clientX: rect.left + 200, clientY: rect.top + 10, bubbles: true });
    ruler.dispatchEvent(ev);
  })(); true`);
  await wait(150);
  const t1 = await js(`document.getElementById('ve-time').textContent`);
  near('200px 클릭 → 약 5.0초', toSec(t1), 5.0, 0.3);

  section('3) 다른 지점 클릭 — 매번 그 위치로 이동(누적 아님)');
  await js(`(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', { clientX: rect.left + 80, clientY: rect.top + 10, bubbles: true });
    ruler.dispatchEvent(ev);
  })(); true`);
  await wait(150);
  const t2 = await js(`document.getElementById('ve-time').textContent`);
  near('80px 클릭 → 약 2.0초', toSec(t2), 2.0, 0.3);

  section('4) 재생선(#ve-playhead) 위치도 같이 반영됐는가');
  const phX = await js(`(() => {
    const m = /translate3d\\(([\\d.]+)px/.exec(document.getElementById('ve-playhead').style.transform);
    return m ? parseFloat(m[1]) : -1;
  })()`);
  // HEAD_W(172) + 2.0초*40px = 252
  near('재생선 x 좌표', phX, 252, 3);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
