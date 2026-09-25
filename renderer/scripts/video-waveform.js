'use strict';
// 오디오 트랙 클립의 파형 — 스튜디오(studio/util.js buildWaveSvg)와 같은 모양(SVG 폴리곤)으로
// 그린다. SVG 는 벡터라 화면 배율/줌과 무관하게 항상 매끈하다.
//
// 파형 데이터는 메인 프로세스가 만든 요약본(버킷마다 피크·RMS, 초당 400버킷 — main.js
// video:waveEnvelope)을 쓴다. 예전엔 렌더러가 파일 전체를 fetch 로 메모리에 올리고
// decodeAudioData 로 비압축 PCM 까지 통째로 풀어 뒀다 — 큰 영상(1.2GB 등)을 올리자마자 렌더러가
// OOM 으로 죽었다(실사용 제보). 한때는 20분 넘는 파일만 파형을 끄는 걸로 막았는데, 그건 PCM
// 크기만 막을 뿐 원본을 통째로 읽는 건 그대로라 "짧지만 큰" 파일은 여전히 위험했다.
// 이제 렌더러에는 요약본(1시간 ≈ 11MB)만 온다 — 파일 크기·길이와 무관하고, 긴 파일도 파형이 보인다.
//
// 파일 단위로 한 번만 받아 캐시하고, 클립마다 그 요약본에서 자기 구간(inOff~inOff+dur)만 잘라
// 그린다 — 트림/줌을 바꿀 때마다 다시 받을 필요가 없다.

import { buildWaveSvgFromEnvelope } from './studio/util.js';

const _cache = new Map();     // file → { rate, peaks, rms }
const _pending = new Set();
const _queue = [];
let _busy = false;
function pump() {
  if (_busy || !_queue.length) return;
  _busy = true;
  const job = _queue.shift();
  job().finally(() => { _busy = false; pump(); });
}

/**
 * 클립이 가리키는 파일의 캐시된 파형 요약본을 즉시 돌려준다(없으면 null 이고, 백그라운드로
 * 요청해 끝나면 onReady(clip) 를 부른다). 소리가 없는 파일(hasAudio:false)은 아예 시도하지
 * 않는다 — 조용히 빈 채로 남는다(아이콘만 보임). 두 번째 인자는 예전 호출부 호환용(안 씀).
 */
export function getFileChannels(clip, _toUrl, onReady) {
  if (clip.hasAudio === false) return null;
  const key = clip.file;
  const cached = _cache.get(key);
  if (cached) return cached;
  if (_pending.has(key)) return null;
  _pending.add(key);
  _queue.push(async () => {
    try {
      const r = await window.yssApi.video.waveEnvelope(key);
      if (r && r.ok) {
        _cache.set(key, { rate: r.rate, peaks: r.peaks, rms: r.rms });
        onReady(clip);
      }
      // 실패(오디오 없음·코덱 미지원 등) — 아이콘만 남고 조용히 넘어감
    } catch { /* 위와 같음 */ }
    finally { _pending.delete(key); }
  });
  pump();
  return null;
}

/**
 * 요약본에서 [inOff, inOff+dur] 구간만 잘라 그린다 — container.innerHTML 에 SVG 문자열을 꽂는다.
 * n(포인트 개수)은 스튜디오와 같은 공식: 화면에 실제로 보이는 폭(px)만큼, 300~8000 사이.
 */
export function renderWaveSvg(container, decoded, inOff, dur, color, pxWidth) {
  if (!container) return;
  if (!decoded || !decoded.peaks) { container.innerHTML = ''; return; }
  const rate = decoded.rate;
  const s0 = Math.max(0, Math.floor(inOff * rate));
  const s1 = Math.min(decoded.peaks.length, Math.max(s0 + 1, Math.ceil((inOff + dur) * rate)));
  const n = Math.max(300, Math.min(8000, Math.round(Math.max(1, pxWidth || (dur * 40)))));
  container.innerHTML = buildWaveSvgFromEnvelope(decoded.peaks, decoded.rms, s0, s1, color, n);
}
