'use strict';
// 특정 영역을 프레임마다 따라가는 단순 템플릿 매칭 트래커 — OpenCV 없이 순수 JS(Canvas 2D).
// (OpenCV.js 시도했으나 이 배포판의 Tracker 바인딩이 껍데기뿐이라 포기 — video-tracker
// 관련 메모리 참고). 그레이스케일로 축소한 패치끼리 SSD(제곱오차합)로 비교하고, 이전
// 위치 주변을 훑는다(전체 프레임 탐색은 느리다). 회전·가림에는 여전히 약하지만, 빠르게
// 움직이는 대상을 자주 놓친다는 피드백으로 탐색 반경/촘촘함을 크게 늘렸다("오래 걸려도
// 상관없다"는 전제) — video-editor.js 의 TRACK_SAMPLE_INTERVAL(샘플 간격)도 같이 줄였다.

const PATCH = 24;   // 비교용 축소 크기(정사각) — 클수록 정확하지만 느림
// 정규화(픽셀당) SSD 가 이 값을 넘으면 "그 자리에 그 대상이 없다"로 본다 — 화면 밖으로
// 나가면 검색창 안엔 배경만 남아 실제로는 전혀 안 닮았는데도 "그나마 제일 비슷한 자리"를
// 억지로 골라 엉뚱한 곳(비슷한 색의 다른 물체 등)에 들러붙던 문제("화면 밖으로 나가면
// 비슷한 걸로 옮겨간다" 피드백)를 이 임계값으로 막는다. 그레이스케일(0~255) 기준이라
// 어느 정도 여유(압축 노이즈·조명 변화)는 허용하면서도 "완전히 다른 배경"은 확실히 걸러
// 지도록 실측으로 골랐다(합성 테스트에서 완전히 다른 배경 매칭은 15000 안팎, 정상 매칭은
// 0에 가까웠다 — videotracker.test.js 참고).
const LOST_SCORE_THRESHOLD = 3000;

function ssd(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}
// gray: 소스 영역 전체를 미리 그레이스케일로 변환해 둔 배열(iw x ih). 그 안의 (ox,oy,w,h)
// 박스를 PATCHxPATCH 로 리샘플해 out 에 채운다 — 후보마다 getImageData 를 다시 부르지
// 않기 위해서다(GPU→CPU 리드백이 후보 수만큼 반복되면 느리다).
function resamplePatch(gray, iw, ih, ox, oy, w, h, out) {
  for (let py = 0; py < PATCH; py++) {
    const gy = Math.min(ih - 1, Math.max(0, Math.floor(oy + py * h / PATCH)));
    for (let px = 0; px < PATCH; px++) {
      const gx = Math.min(iw - 1, Math.max(0, Math.floor(ox + px * w / PATCH)));
      out[py * PATCH + px] = gray[gy * iw + gx];
    }
  }
}
function toGray(imageData) {
  const { data, width, height } = imageData;
  const gray = new Float32Array(width * height);
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return gray;
}

export class BoxTracker {
  // ctx: 현재 프레임이 이미 그려진 2D 캔버스 컨텍스트(추적 시작 프레임). box: {x,y,w,h} 그
  // 컨텍스트와 같은 좌표계(보통 소스 영상의 자연 해상도 픽셀).
  constructor(ctx, box) {
    this.box = { x: box.x, y: box.y, w: box.w, h: box.h };
    this.template = new Float32Array(PATCH * PATCH);
    this.lost = false;   // 화면 밖으로 나갔거나(또는 확 달라져서) 놓친 상태 — update() 참고
    const clip = this._clipToCanvas(ctx, box.x, box.y, box.w, box.h);
    const img = ctx.getImageData(clip.x, clip.y, clip.w, clip.h);
    const gray = toGray(img);
    resamplePatch(gray, clip.w, clip.h, box.x - clip.x, box.y - clip.y, box.w, box.h, this.template);
  }
  _clipToCanvas(ctx, x, y, w, h) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(cw, Math.ceil(x + w)), y1 = Math.min(ch, Math.ceil(y + h));
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  }
  // ctx 에 다음 프레임이 그려진 상태로 호출한다 — 이전 위치 주변을 훑어 가장 비슷한 자리를
  // 찾고 박스를 그쪽으로 옮긴다. searchRadius 는 박스 크기 대비 탐색 반경 비율 — 예전 0.6
  // 이었는데, 그 폭(박스의 0.6배)보다 더 빨리 움직이는 대상은 다음 샘플에서 아예 탐색
  // 범위 밖으로 나가버려 조용히 놓쳤다("조금만 빠르게 움직여도 전혀 못 따라감" 피드백).
  // 1.5 로 늘려 같은 시간 동안 훨씬 더 멀리 움직인 대상도 범위 안에 들어오게 한다 —
  // 후보 수가 늘어(느려)지지만 "오래 걸려도 상관없다"는 전제로 정확도를 우선한다.
  // 놓친 상태(this.lost)면 좁은 범위 대신 화면 전체를 훑는 재탐색(_reacquire)으로 돈다 —
  // "화면 안으로 다시 들어오면 다시 따라가도록" 요청.
  update(ctx, searchRadius = 1.5) {
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    if (this.lost) return this._reacquire(ctx, cw, ch);
    const { x, y, w, h } = this.box;
    const rx = Math.max(6, Math.round(w * searchRadius)), ry = Math.max(6, Math.round(h * searchRadius));
    const region = this._clipToCanvas(ctx, x - rx, y - ry, w + rx * 2, h + ry * 2);
    let img;
    try { img = ctx.getImageData(region.x, region.y, region.w, region.h); }
    catch { this.lost = true; return { ...this.box, score: Infinity, lost: true }; }
    const gray = toGray(img);
    // 범위가 넓어진 만큼 촘촘함(step)도 같이 올려서(나눗수 10→20) 넓어진 범위 안에서도
    // 예전과 비슷하거나 더 촘촘한 격자로 훑는다 — "처리 깊이 늘려야 할듯" 요청 반영.
    const step = Math.max(1, Math.round(Math.min(rx, ry) / 20));
    let bestScore = Infinity, bestX = x, bestY = y;
    const cur = new Float32Array(PATCH * PATCH);
    const maxOx = region.w - 1, maxOy = region.h - 1;
    for (let ny = y - ry; ny <= y + ry; ny += step) {
      const oy = Math.min(maxOy, Math.max(0, ny - region.y));
      for (let nx = x - rx; nx <= x + rx; nx += step) {
        const ox = Math.min(maxOx, Math.max(0, nx - region.x));
        resamplePatch(gray, region.w, region.h, ox, oy, w, h, cur);
        const score = ssd(cur, this.template);
        if (score < bestScore) { bestScore = score; bestX = nx; bestY = ny; }
      }
    }
    if (this._isLostMatch(bestScore, bestX, bestY, w, h, cw, ch)) {
      // 화면 밖으로 나갔거나(또는 그 자리에 더 이상 그 대상이 없거나) — 엉뚱한 곳으로
      // 옮겨붙지 않도록 박스 위치를 마지막으로 확실했던 자리에 그대로 얼려 둔다. 다음
      // update() 호출부터는 _reacquire() 가 이어받는다.
      this.lost = true;
      return { ...this.box, score: bestScore, lost: true };
    }
    this.box.x = bestX; this.box.y = bestY;
    return { x: bestX, y: bestY, w, h, score: bestScore, lost: false };
  }
  // 정규화 SSD 가 너무 크면(그 자리에 원래 대상이 없다) 놓친 걸로 본다. 점수가 괜찮아도
  // 박스 대부분이 캔버스 밖이면(화면 가장자리에서 아주 좁은 조각만 걸쳐 우연히 낮은
  // 점수가 나올 수 있다) 마찬가지로 놓친 걸로 본다.
  _isLostMatch(score, bx, by, w, h, cw, ch) {
    if (score / (PATCH * PATCH) > LOST_SCORE_THRESHOLD) return true;
    const overlapX = Math.max(0, Math.min(bx + w, cw) - Math.max(bx, 0));
    const overlapY = Math.max(0, Math.min(by + h, ch) - Math.max(by, 0));
    return (overlapX * overlapY) / (w * h) < 0.5;
  }
  // 놓친 뒤엔 좁은 범위만 봐선 다시 나타나도 못 찾는다 — 화면 전체를 성기게(칸 간격은
  // 박스 크기의 1/3 정도) 훑어서 다시 나타났는지 확인한다. 정상 추적 중엔 여전히 좁은
  // 범위만 보니, 이 무거운 전체 탐색은 실제로 놓친 동안에만 돈다.
  _reacquire(ctx, cw, ch) {
    const { w, h } = this.box;
    let img;
    try { img = ctx.getImageData(0, 0, cw, ch); } catch { return { ...this.box, score: Infinity, lost: true }; }
    const gray = toGray(img);
    const stepX = Math.max(2, Math.round(w / 3)), stepY = Math.max(2, Math.round(h / 3));
    let bestScore = Infinity, bestX = this.box.x, bestY = this.box.y;
    const cur = new Float32Array(PATCH * PATCH);
    for (let ny = 0; ny <= ch - h; ny += stepY) {
      for (let nx = 0; nx <= cw - w; nx += stepX) {
        resamplePatch(gray, cw, ch, nx, ny, w, h, cur);
        const score = ssd(cur, this.template);
        if (score < bestScore) { bestScore = score; bestX = nx; bestY = ny; }
      }
    }
    if (bestScore / (PATCH * PATCH) <= LOST_SCORE_THRESHOLD) {
      this.lost = false;
      this.box.x = bestX; this.box.y = bestY;
      return { x: bestX, y: bestY, w, h, score: bestScore, lost: false };
    }
    return { ...this.box, score: bestScore, lost: true };
  }
}
