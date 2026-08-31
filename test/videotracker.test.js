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

  section('3) 예전 탐색 반경(박스의 0.6배 ≈ 24px)으로는 놓쳤을 빠른 움직임 — 지금은 잡아야 함');
  // "조금이라도 빠르게 움직이면 전혀 못 따라감" 피드백으로 searchRadius 를 0.6→1.5 로
  // 늘렸다 — 박스 40px 기준 옛 반경은 24px, 새 반경은 60px. 프레임당 40px 씩 옮기면(옛
  // 반경 밖, 새 반경 안) 예전엔 놓쳤을 자리를 지금은 정확히 찾아야 한다.
  const result3 = await js(`(async () => {
    const { BoxTracker } = await import('./scripts/video-tracker.js');
    const W = 320, H = 240, BOX = 40;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function draw(x, y) {
      ctx.fillStyle = 'black'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e05a5a'; ctx.fillRect(x, y, BOX, BOX);
    }
    const path = [];
    for (let i = 0; i < 5; i++) path.push({ x: 20 + i * 40, y: 40 });   // 프레임당 40px(가로) 이동
    draw(path[0].x, path[0].y);
    const tracker = new BoxTracker(ctx, { x: path[0].x, y: path[0].y, w: BOX, h: BOX });
    const errors = [];
    for (let i = 1; i < path.length; i++) {
      draw(path[i].x, path[i].y);
      const r = tracker.update(ctx);
      errors.push(Math.hypot(r.x - path[i].x, r.y - path[i].y));
    }
    return JSON.stringify({ errors, maxError: Math.max(...errors) });
  })()`);
  const { errors: errors3, maxError: maxError3 } = JSON.parse(result3);
  console.log('  빠른 이동 오차(px):', errors3.map(e => e.toFixed(1)).join(', '));
  near('예전엔 놓쳤을 빠른 움직임도 지금은 잘 따라감(오차 작음)', maxError3, 0, 10);

  section('4) 화면 밖으로 나갔다가(사라짐) 다시 들어오면(재진입) — 놓친 동안엔 lost, 다시 잡으면 그 자리로');
  // "화면 밖으로 나가면 비슷한 걸로 옮겨가는데, 사라지는 게 맞고 다시 들어오면 다시
  // 따라가야 한다" 요청 — 대상이 아예 안 보이는 프레임에 억지로 아무 자리나 골라 붙잡지
  // 않고(lost=true, 위치는 마지막 위치에 얼어붙는다) 있다가, 다시 나타나면(재진입, 화면
  // 전체를 다시 훑는 재탐색) 그 새 위치를 다시 정확히 찾아야 한다.
  const result4 = await js(`(async () => {
    const { BoxTracker } = await import('./scripts/video-tracker.js');
    const W = 320, H = 240, BOX = 40;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function drawBoxAt(x, y) {
      ctx.fillStyle = 'black'; ctx.fillRect(0, 0, W, H);
      if (x != null) { ctx.fillStyle = '#e05a5a'; ctx.fillRect(x, y, BOX, BOX); }
    }
    drawBoxAt(140, 100);
    const tracker = new BoxTracker(ctx, { x: 140, y: 100, w: BOX, h: BOX });
    drawBoxAt(null, null);              // 화면 밖으로 나감(완전히 사라짐)
    const r1 = tracker.update(ctx);
    drawBoxAt(null, null);              // 계속 안 보임
    const r2 = tracker.update(ctx);
    drawBoxAt(220, 30);                 // 다른 자리로 다시 나타남(재진입)
    const r3 = tracker.update(ctx);
    return JSON.stringify({ lost1: r1.lost, lost2: r2.lost, lost3: r3.lost, x3: r3.x, y3: r3.y });
  })()`);
  const r4 = JSON.parse(result4);
  expect('사라진 첫 프레임에 lost=true(엉뚱한 자리로 안 옮겨붙음)', r4.lost1, true);
  expect('계속 안 보이는 동안엔 계속 lost=true', r4.lost2, true);
  expect('다시 나타나면 lost=false 로 돌아옴(재탐색 성공)', r4.lost3, false);
  near('재진입한 새 위치를 다시 찾음(x)', r4.x3, 220, 15);
  near('재진입한 새 위치를 다시 찾음(y)', r4.y3, 30, 15);

  section('5) 놓친 뒤 재진입 — 화면 안에 비슷하게 생긴 다른 물체(가짜)가 동시에 있으면 그쪽 말고 원래 대상이 다시 나타난 자리(더 가까운 쪽)를 잡아야 함');
  // "화면 밖으로 나간 요소가 비슷한 게 두 개 있으면 다른 거에도 표시되는 경우도 있어"
  // 피드백 — 대상이 놓친(lost) 상태에서 재탐색할 때, 놓치기 직전 마지막 위치에서 먼 가짜
  // 후보와 가까운 진짜 재진입 후보의 점수가 (똑같이 생겨서) 동점이면, 옛날엔 그냥 스캔
  // 순서상 먼저 걸리는 쪽을 골라 가짜를 잡을 수 있었다. 지금은 거리 가중치가 동점을 깨서
  // 마지막 위치에 더 가까운 쪽(=진짜 재진입 지점일 가능성이 높은 쪽)을 우선한다.
  const result5 = await js(`(async () => {
    const { BoxTracker } = await import('./scripts/video-tracker.js');
    const W = 320, H = 240, BOX = 40;
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    function drawScene({ target, decoy }) {
      ctx.fillStyle = 'black'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#e05a5a';
      if (decoy) ctx.fillRect(decoy.x, decoy.y, BOX, BOX);
      if (target) ctx.fillRect(target.x, target.y, BOX, BOX);
    }
    // 마지막으로 확실했던 자리는 (140,100). 재진입 지점은 그 근처(155,105) — 가까움.
    // 가짜(decoy)는 화면 반대편 먼 구석(280,190) — 똑같이 생겼지만 훨씬 멀다.
    drawScene({ target: { x: 140, y: 100 } });
    const tracker = new BoxTracker(ctx, { x: 140, y: 100, w: BOX, h: BOX });
    drawScene({});                                                    // 완전히 사라짐 → lost
    const r1 = tracker.update(ctx);
    // 가짜와 진짜 재진입 지점이 같은 프레임에 동시에 나타남 — 점수는 사실상 동점.
    drawScene({ target: { x: 155, y: 105 }, decoy: { x: 280, y: 190 } });
    const r2 = tracker.update(ctx);
    return JSON.stringify({ lost1: r1.lost, lost2: r2.lost, x2: r2.x, y2: r2.y });
  })()`);
  const r5 = JSON.parse(result5);
  expect('사라진 프레임엔 lost=true', r5.lost1, true);
  expect('가짜/진짜 동시 등장 프레임엔 재탐색 성공(lost=false)', r5.lost2, false);
  const distToReal = Math.hypot(r5.x2 - 155, r5.y2 - 105);
  const distToDecoy = Math.hypot(r5.x2 - 280, r5.y2 - 190);
  expect('먼 가짜가 아니라 가까운 진짜 재진입 지점을 잡음', distToReal < distToDecoy, true);
  near('그 진짜 재진입 지점 좌표도 정확함(x)', r5.x2, 155, 15);
  near('그 진짜 재진입 지점 좌표도 정확함(y)', r5.y2, 105, 15);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
