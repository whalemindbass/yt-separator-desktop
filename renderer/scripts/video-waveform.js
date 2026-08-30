'use strict';
// 오디오 트랙 클립의 파형 — Web Audio API 로 렌더러 안에서 직접 디코드한다(ffmpeg 도
// 필요 없고 엔진과도 무관 — video-thumbs.js 와 같은 원칙). 파일 단위로 한 번만 디코드해서
// 최소/최대 피크 배열로 캐시해 두고(RES_BUCKETS 개), 클립마다 그 배열에서 자기 구간
// (inOff~inOff+dur)만 잘라 캔버스 폭에 맞게 다시 축약해 그린다 — 트림/줌을 바꿀 때마다
// 다시 디코드할 필요가 없다.

const RES_BUCKETS = 4000;   // 파일 전체를 이만큼의 min/max 구간으로 미리 뭉쳐둔다
let _ctx = null;
function audioCtx() {
  // decodeAudioData 전용 — 실제로 소리를 내보내지 않으니 오토플레이 정책과 무관하다.
  return _ctx || (_ctx = new (window.AudioContext || window.webkitAudioContext)());
}

const _cache = new Map();     // file → {min, max, n, bucketSec, duration} | Promise
const _pending = new Set();
const _queue = [];
let _busy = false;
function pump() {
  if (_busy || !_queue.length) return;
  _busy = true;
  const job = _queue.shift();
  job().finally(() => { _busy = false; pump(); });
}

async function decode(file, toUrl) {
  const res = await fetch(toUrl(file));
  const buf = await res.arrayBuffer();
  const audioBuf = await audioCtx().decodeAudioData(buf);
  const ch = audioBuf.getChannelData(0);
  const len = ch.length;
  const bucketSize = Math.max(1, Math.floor(len / RES_BUCKETS));
  const n = Math.ceil(len / bucketSize);
  const min = new Float32Array(n), max = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * bucketSize, end = Math.min(len, start + bucketSize);
    let lo = 0, hi = 0;
    for (let j = start; j < end; j++) { const v = ch[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    min[i] = lo; max[i] = hi;
  }
  return { min, max, n, bucketSec: bucketSize / audioBuf.sampleRate, duration: audioBuf.duration };
}

/**
 * 클립이 가리키는 파일의 캐시된 피크(min/max)를 즉시 돌려준다(없으면 null 이고, 백그라운드로
 * 디코드를 시작해 끝나면 onReady(clip) 를 부른다). 소리가 없는 파일(hasAudio:false)은 아예
 * 시도하지 않는다 — 조용히 빈 채로 남는다(아이콘만 보임).
 */
export function getFilePeaks(clip, toUrl, onReady) {
  if (clip.hasAudio === false) return null;
  const key = clip.file;
  const cached = _cache.get(key);
  if (cached && !(cached instanceof Promise)) return cached;
  if (_pending.has(key)) return null;
  _pending.add(key);
  _queue.push(async () => {
    try {
      const peaks = await decode(key, toUrl);
      _cache.set(key, peaks);
      onReady(clip);
    } catch { /* 디코드 실패(코덱 미지원 등) — 아이콘만 남고 조용히 넘어감 */ }
    finally { _pending.delete(key); }
  });
  pump();
  return null;
}

/** peaks(getFilePeaks 결과)에서 [inOff, inOff+dur] 구간을 캔버스에 min/max 막대로 그린다. */
export function drawWaveform(canvas, peaks, inOff, dur) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!peaks || !peaks.n || w <= 0 || h <= 0) return;
  const startB = Math.max(0, Math.floor(inOff / peaks.bucketSec));
  const endB = Math.min(peaks.n, Math.ceil((inOff + dur) / peaks.bucketSec));
  const span = Math.max(1, endB - startB);
  const bucketsPerPx = span / w;
  const mid = h / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  for (let x = 0; x < w; x++) {
    const b0 = startB + Math.floor(x * bucketsPerPx);
    const b1 = Math.min(endB, Math.max(b0 + 1, startB + Math.floor((x + 1) * bucketsPerPx)));
    let lo = 0, hi = 0;
    for (let b = b0; b < b1; b++) { if (peaks.min[b] < lo) lo = peaks.min[b]; if (peaks.max[b] > hi) hi = peaks.max[b]; }
    const y0 = mid - hi * mid, y1 = mid - lo * mid;
    ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}
