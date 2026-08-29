'use strict';
// video-tracker.js(순수 JS 템플릿 매칭 트래커) — 실제 알고리즘 정확도를 캔버스에 직접 그린
// 움직이는 사각형으로 검증한다(합성 영상 파일 없이, 순수 캔버스 픽셀만으로 빠르게).
// OpenCV.js 시도가 막힌 뒤(Tracker 바인딩이 빈 껍데기) 직접 만든 대체 구현이다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetracker-profile-')));

const ROOT = path.resolve(__dirname, '..');
const { bootRenderer, expect, near, section, finish } = require('./harness');

(async () => {
  const { app, js } = await bootRenderer({ settle: 500 });

  section('1) 대각선으로 움직이는 사각형을 20프레임 동안 계속 따라가는지');
  const result = await js(`(async () => {
    const { BoxTracker } = await import('./scripts/video-tracker.js');
    const W = 320, H = 240, BOX = 40;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function draw(x, y) {
      ctx.fillStyle = 'black'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e05a5a'; ctx.fillRect(x, y, BOX, BOX);
    }
    const path = [];
    for (let i = 0; i < 20; i++) path.push({ x: 40 + i * 6, y: 40 + i * 4 });
    draw(path[0].x, path[0].y);
    const tracker = new BoxTracker(ctx, { x: path[0].x, y: path[0].y, w: BOX, h: BOX });
    const errors = [];
    for (let i = 1; i < path.length; i++) {
      draw(path[i].x, path[i].y);
      const r = tracker.update(ctx);
      const dx = r.x - path[i].x, dy = r.y - path[i].y;
      errors.push(Math.sqrt(dx * dx + dy * dy));
    }
    return JSON.stringify({ errors, maxError: Math.max(...errors), meanError: errors.reduce((a, b) => a + b, 0) / errors.length });
  })()`);
  const { errors, maxError, meanError } = JSON.parse(result);
  console.log('  프레임별 오차(px):', errors.map(e => e.toFixed(1)).join(', '));
  near('평균 오차가 몇 px 이내(잘 따라감)', meanError, 0, 4);
  near('최대 오차도 크게 안 벗어남', maxError, 0, 8);

  section('2) 빠르게 튀는(탐색 범위 밖) 경우 — 놓치는 게 정상(과신 안 함)');
  const result2 = await js(`(async () => {
    const { BoxTracker } = await import('./scripts/video-tracker.js');
    const W = 320, H = 240, BOX = 40;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function draw(x, y) {
      ctx.fillStyle = 'black'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e05a5a'; ctx.fillRect(x, y, BOX, BOX);
    }
    draw(40, 40);
    const tracker = new BoxTracker(ctx, { x: 40, y: 40, w: BOX, h: BOX });
    draw(250, 180);   // 탐색 반경(박스의 0.6배 ≈ 24px) 훨씬 밖으로 순간이동
    const r = tracker.update(ctx);
    return JSON.stringify({ x: r.x, y: r.y });
  })()`);
  const far = JSON.parse(result2);
  const distFromTarget = Math.hypot(far.x - 250, far.y - 180);
  expect('탐색 범위 밖으로 튄 대상은 못 따라감(범위 내에서만 최선을 찾음)', distFromTarget > 50, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
