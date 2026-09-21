'use strict';
// 오디오 트랙 클립의 파형 — 스튜디오(studio.js renderWaves/buildWaveSvg, studio/util.js)와
// 완전히 같은 방식으로 그린다: SVG 폴리곤. 예전엔 캔버스에 열(px)마다 사각형을 따로 찍어서
// 스튜디오와 구성은 비슷해도(피크+rms 2겹) 실제로 보면 각지고 투박했다(제보: "오디오 트랙
// 파형이 영상의 오디오 파형보다 투박하다" — 캔버스 사각형 vs SVG 매끈한 실루엣의 차이였다).
// 아예 studio/util.js 의 buildWaveSvg 를 그대로 가져다 쓰면 화면 배율(devicePixelRatio)도
// 신경 쓸 필요가 없다(SVG 는 벡터라 항상 선명하다) — 스튜디오와 다른 그리기 코드를 유지할
// 이유가 없다.
//
// Web Audio API 로 렌더러 안에서 직접 디코드한다(ffmpeg 도 필요 없고 엔진과도 무관 —
// video-thumbs.js 와 같은 원칙). 파일 단위로 한 번만 디코드해서 원본 채널 배열(L/R)을
// 캐시해 두고, 클립마다 그 배열에서 자기 구간(inOff~inOff+dur)만 잘라 buildWaveSvg 에 넘긴다
// — 트림/줌을 바꿀 때마다 다시 디코드할 필요가 없다.

import { buildWaveSvg } from './studio/util.js';

let _ctx = null;
function audioCtx() {
  // decodeAudioData 전용 — 실제로 소리를 내보내지 않으니 오토플레이 정책과 무관하다.
  return _ctx || (_ctx = new (window.AudioContext || window.webkitAudioContext)());
}

// decode() 는 파일 전체를 fetch 로 렌더러 메모리에 올린 뒤 decodeAudioData 로 통째로
// 비압축 PCM(Float32, 채널당 duration×sampleRate×4바이트)으로 풀어 둔다 — 몇 분짜리
// 클립엔 문제없지만, 길거나 고비트레이트인 파일(예: 몇 시간짜리 4K 촬영본)은 이 PCM만
// 으로도 수백MB~GB 급이라 원본 fetch 버퍼까지 겹치면 렌더러 프로세스가 통째로 OOM 으로
// 죽는다(실사용 제보: 1.2GB 영상 임포트 직후 크래시, kind:renderer/oom). 파형은 "있으면
// 좋은" 부가 정보일 뿐이라 — 너무 긴 파일은 디코드 자체를 건너뛴다(클립은 파형 없이
// 정상 동작, 크래시보다 훨씬 낫다).
const MAX_WAVE_DECODE_SEC = 20 * 60;   // 20분 — 48kHz 스테레오 기준 PCM 약 230MB

const _cache = new Map();     // file → {chL, chR, sampleRate, duration} | Promise
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
  const chL = audioBuf.getChannelData(0);
  const chR = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : chL;
  return { chL, chR, sampleRate: audioBuf.sampleRate, duration: audioBuf.duration };
}

/**
 * 클립이 가리키는 파일의 캐시된 원본 채널 데이터를 즉시 돌려준다(없으면 null 이고, 백그라운드로
 * 디코드를 시작해 끝나면 onReady(clip) 를 부른다). 소리가 없는 파일(hasAudio:false)은 아예
 * 시도하지 않는다 — 조용히 빈 채로 남는다(아이콘만 보임).
 */
export function getFileChannels(clip, toUrl, onReady) {
  if (clip.hasAudio === false) return null;
  if ((clip.srcDur || 0) > MAX_WAVE_DECODE_SEC) return null;   // 너무 길면 파형 생략(OOM 방지)
  const key = clip.file;
  const cached = _cache.get(key);
  if (cached && !(cached instanceof Promise)) return cached;
  if (_pending.has(key)) return null;
  _pending.add(key);
  _queue.push(async () => {
    try {
      const decoded = await decode(key, toUrl);
      _cache.set(key, decoded);
      onReady(clip);
    } catch { /* 디코드 실패(코덱 미지원 등) — 아이콘만 남고 조용히 넘어감 */ }
    finally { _pending.delete(key); }
  });
  pump();
  return null;
}

/**
 * decoded(getFileChannels 결과)에서 [inOff, inOff+dur] 구간만 잘라 스튜디오와 똑같은
 * buildWaveSvg 로 그린다 — container.innerHTML 에 SVG 문자열을 그대로 꽂는다(캔버스 아님,
 * studio.js 의 `clip.innerHTML = buildWaveSvg(...)` 와 동일 패턴). n(포인트 개수)은 스튜디오의
 * waveN 과 같은 공식: 화면에 실제로 보이는 폭(px)만큼, 300~8000 사이로 자른다 — 줌 배율에
 * 맞게 항상 딱 필요한 만큼만 촘촘하다.
 */
export function renderWaveSvg(container, decoded, inOff, dur, color, pxWidth) {
  if (!container) return;
  if (!decoded) { container.innerHTML = ''; return; }
  const sr = decoded.sampleRate;
  const s0 = Math.max(0, Math.floor(inOff * sr));
  const s1 = Math.min(decoded.chL.length, Math.max(s0 + 1, Math.ceil((inOff + dur) * sr)));
  const n = Math.max(300, Math.min(8000, Math.round(Math.max(1, pxWidth || (dur * 40)))));
  container.innerHTML = buildWaveSvg([decoded.chL.subarray(s0, s1), decoded.chR.subarray(s0, s1)], color, n);
}
