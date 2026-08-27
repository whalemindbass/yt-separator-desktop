'use strict';
// 클립 필름스트립 — ffmpeg 안 쓰고 숨은 <video>+<canvas> 로 렌더러 안에서 직접 캡처한다.
// 엔진(비디오 디코딩 능력 없음)과 무관한 게 이 앱의 방향이라, 여기서도 같은 원칙을 지킨다.
//
// 한 번에 하나씩만 처리한다(큐) — seek 마다 실제 프레임 디코드를 기다려야 해서 동시에
// 여러 개를 돌리면 숨은 <video> 하나를 서로 뺏어 쓰게 되어 오히려 다 늦어진다.

// DOM 에 안 붙은 <video> 는 크롬이 실제 프레임 디코드를 건너뛴다(메타데이터는 그래도 읽힌다) —
// 화면 밖으로 치워 붙여 둬야 currentTime 을 옮겨도 진짜 그 프레임이 디코드된다.
const _pool = document.createElement('video');
_pool.preload = 'auto'; _pool.muted = true; _pool.playsInline = true;
// crossOrigin 없이 캔버스에 그리면 "Tainted canvases may not be exported" 로 toDataURL 이 막힌다 —
// ytsep:// 프로토콜이 CORS 헤더는 이미 내려주니(main.js), 이것만 걸어주면 된다.
_pool.crossOrigin = 'anonymous';
_pool.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;';
document.body.appendChild(_pool);

function seekOnce(video, t) {
  return new Promise((resolve) => {
    const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
    video.addEventListener('seeked', onSeeked);
    try { video.currentTime = t; } catch { resolve(); }
  });
}
function loadOnce(video, src) {
  if (video.dataset.src === src && video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    const onMeta = () => { video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('error', onErr); resolve(); };
    const onErr = () => { video.removeEventListener('loadedmetadata', onMeta); video.removeEventListener('error', onErr); resolve(); };
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
    video.src = src; video.dataset.src = src;
  });
}
async function generate(clip, n, toUrl) {
  await loadOnce(_pool, toUrl(clip.file));
  const vw = _pool.videoWidth || 16, vh = _pool.videoHeight || 9;
  const w = 80, h = Math.max(1, Math.round(w * (vh / vw)));
  const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const srcDur = _pool.duration || clip.srcDur || clip.dur;
  const urls = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(srcDur - 0.05, Math.max(0, clip.inOff + (clip.dur * (i + 0.5) / n)));
    await seekOnce(_pool, t);
    try { ctx.drawImage(_pool, 0, 0, w, h); urls.push(canvas.toDataURL('image/jpeg', 0.55)); } catch { /* 코덱 문제 등 — 그 프레임만 건너뜀 */ }
  }
  return urls;
}

const _queue = [];
const _pending = new Set();
let _busy = false;
function pump() {
  if (_busy || !_queue.length) return;
  _busy = true;
  const job = _queue.shift();
  job().finally(() => { _busy = false; pump(); });
}

/**
 * 클립의 필름스트립 URL 배열(캐시)을 즉시 돌려준다(없거나 낡았으면 null 또는 낡은 값).
 * 새로 만들 게 있으면 백그라운드로 만들고, 끝나면 onReady(clip) 를 부른다.
 */
export function getClipThumb(clip, pxPerSec, toUrl, onReady) {
  const n = Math.max(1, Math.min(10, Math.round((clip.dur * pxPerSec) / 70)));
  const key = `${clip.file}:${clip.inOff.toFixed(2)}:${clip.dur.toFixed(2)}:${n}`;
  if (clip._thumbKey === key) return clip._thumbUrls;
  if (_pending.has(clip.id)) return clip._thumbUrls || null;
  _pending.add(clip.id);
  _queue.push(async () => {
    try {
      const urls = await generate(clip, n, toUrl);
      clip._thumbKey = key; clip._thumbUrls = urls;
      onReady(clip);
    } catch { /* 무시 — 다음 zoom/트림 때 다시 시도됨 */ }
    finally { _pending.delete(clip.id); }
  });
  pump();
  return clip._thumbUrls || null;
}
