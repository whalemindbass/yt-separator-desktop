'use strict';
// 오디오 트랙 클립의 파형 — Web Audio API 로 렌더러 안에서 직접 디코드한다(ffmpeg 도
// 필요 없고 엔진과도 무관 — video-thumbs.js 와 같은 원칙). 파일 단위로 한 번만 디코드해서
// 최소/최대/rms 피크 배열로 캐시해 두고(RES_BUCKETS 개), 클립마다 그 배열에서 자기 구간
// (inOff~inOff+dur)만 잘라 캔버스 폭에 맞게 다시 축약해 그린다 — 트림/줌을 바꿀 때마다
// 다시 디코드할 필요가 없다.

const RES_BUCKETS = 4000;   // 파일 전체를 이만큼의 min/max/rms 구간으로 미리 뭉쳐둔다
let _ctx = null;
function audioCtx() {
  // decodeAudioData 전용 — 실제로 소리를 내보내지 않으니 오토플레이 정책과 무관하다.
  return _ctx || (_ctx = new (window.AudioContext || window.webkitAudioContext)());
}

const _cache = new Map();     // file → {min, max, rms, n, bucketSec, duration} | Promise
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
  const min = new Float32Array(n), max = new Float32Array(n), rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const start = i * bucketSize, end = Math.min(len, start + bucketSize);
    let lo = 0, hi = 0, s2 = 0;
    for (let j = start; j < end; j++) { const v = ch[j]; if (v < lo) lo = v; if (v > hi) hi = v; s2 += v * v; }
    min[i] = lo; max[i] = hi;
    rms[i] = (end > start) ? Math.sqrt(s2 / (end - start)) : 0;
  }
  return { min, max, rms, n, bucketSec: bucketSize / audioBuf.sampleRate, duration: audioBuf.duration };
}

/**
 * 클립이 가리키는 파일의 캐시된 피크(min/max/rms)를 즉시 돌려준다(없으면 null 이고, 백그라운드로
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

/**
 * peaks(getFilePeaks 결과)에서 [inOff, inOff+dur] 구간을 캔버스에 그린다 — 스튜디오 파형
 * (buildWaveSvg, studio/util.js)과 같은 2겹 구성: 흐린 외곽선은 그 구간의 진짜 피크(min/max,
 * 순간 최대치까지 다 보여줌), 진한 안쪽 막대는 rms(체감 음량) — 피크만 있으면 잔잔한 곡도
 * 삐죽삐죽해 보이고, rms만 있으면 트랜지언트(타격감)가 다 뭉개져 안 보인다.
 */
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
  // 표시 구간 안에서의 최대 rms 를 기준으로 rms 막대 높이를 정규화한다(스튜디오와 같은 방식,
  // buildWaveSvg 의 mx) — 그래야 조용한 클립도 안쪽 막대가 납작하게 안 뭉개지고 잘 보인다.
  let maxRms = 1e-6;
  for (let b = startB; b < endB; b++) if (peaks.rms[b] > maxRms) maxRms = peaks.rms[b];
  for (let x = 0; x < w; x++) {
    const b0 = startB + Math.floor(x * bucketsPerPx);
    const b1 = Math.min(endB, Math.max(b0 + 1, startB + Math.floor((x + 1) * bucketsPerPx)));
    let lo = 0, hi = 0, r = 0;
    for (let b = b0; b < b1; b++) {
      if (peaks.min[b] < lo) lo = peaks.min[b];
      if (peaks.max[b] > hi) hi = peaks.max[b];
      if (peaks.rms[b] > r) r = peaks.rms[b];
    }
    // 외곽(피크) — 흐리게
    const py0 = mid - hi * mid, py1 = mid - lo * mid;
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fillRect(x, py0, 1, Math.max(1, py1 - py0));
    // 안쪽(rms, 체감 음량) — 진하게, 최대 rms 기준으로 정규화해서 피크 높이 안쪽에 겹쳐 그림
    const rh = Math.min(1, r / maxRms) * mid;
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(x, mid - rh, 1, Math.max(1, rh * 2));
  }
}
