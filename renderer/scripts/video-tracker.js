'use strict';
// 특정 영역을 프레임마다 따라가는 단순 템플릿 매칭 트래커 — OpenCV 없이 순수 JS(Canvas 2D).
// (OpenCV.js 시도했으나 이 배포판의 Tracker 바인딩이 껍데기뿐이라 포기 — video-tracker
// 관련 메모리 참고). 그레이스케일로 축소한 패치끼리 SSD(제곱오차합)로 비교하고, 이전
// 위치 주변 좁은 범위만 훑는다(전체 프레임 탐색은 느리고 프레임 간 이동은 보통 작다).
// 빠른 움직임·회전·가림에는 약하다 — "완만하게 움직이는 대상 가리기" 정도가 목표.

const PATCH = 24;   // 비교용 축소 크기(정사각) — 클수록 정확하지만 느림

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
  // 찾고 박스를 그쪽으로 옮긴다. searchRadius 는 박스 크기 대비 탐색 반경 비율.
  update(ctx, searchRadius = 0.6) {
    const { x, y, w, h } = this.box;
    const rx = Math.max(6, Math.round(w * searchRadius)), ry = Math.max(6, Math.round(h * searchRadius));
    const region = this._clipToCanvas(ctx, x - rx, y - ry, w + rx * 2, h + ry * 2);
    let img;
    try { img = ctx.getImageData(region.x, region.y, region.w, region.h); }
    catch { return { ...this.box, score: Infinity, lost: true }; }
    const gray = toGray(img);
    const step = Math.max(1, Math.round(Math.min(rx, ry) / 10));
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
    this.box.x = bestX; this.box.y = bestY;
    return { x: bestX, y: bestY, w, h, score: bestScore, lost: false };
  }
}
