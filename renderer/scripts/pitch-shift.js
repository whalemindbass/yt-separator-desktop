// Signalsmith Stretch 기반 오프라인 pitch shift.
// 자체 phase vocoder 대체 — WASM 백엔드로 빠르고, formant 보존으로 보컬 자연스러움 유지.

import SignalsmithStretch from '../lib/signalsmith-stretch/SignalsmithStretch.mjs';

/** 스테레오 stem 을 semitones 만큼 피치 시프트. 길이는 유지.
 *  @param {Float32Array} L
 *  @param {Float32Array} R
 *  @param {number} sampleRate
 *  @param {number} semitones  (-12 ~ +12)
 *  @param {object} [opts]
 *  @param {boolean} [opts.formantCompensation=true]  보컬 formant 유지 여부
 *  @returns {Promise<{L: Float32Array, R: Float32Array}>}
 */
export async function pitchShiftStereo(L, R, sampleRate, semitones, opts = {}) {
  const N = Math.min(L.length, R.length);
  if (N === 0) return { L: new Float32Array(0), R: new Float32Array(0) };

  // OfflineAudioContext: 실시간 아닌 최대 속도 렌더링
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: N, sampleRate });
  const stretch = await SignalsmithStretch(ctx);

  // 입력 버퍼 등록 — Float32Array 복사본으로 (원본 버퍼 detach 방지)
  await stretch.addBuffers([new Float32Array(L.subarray(0, N)), new Float32Array(R.subarray(0, N))]);

  stretch.schedule({
    active: true,
    input: 0,
    rate: 1,
    semitones,
    formantCompensation: opts.formantCompensation !== false,
    formantBaseHz: 0,   // 0 = auto pitch tracking
  });
  stretch.start();
  stretch.connect(ctx.destination);

  const rendered = await ctx.startRendering();
  return {
    L: rendered.getChannelData(0).slice(),
    R: rendered.getChannelData(1).slice(),
  };
}

/** 스테레오 stem 을 진짜 타임스트레치(속도 변경) — 피치는 유지, 길이는 rate 에 반비례로 바뀐다.
 *  rate<1(느리게) 이면 출력이 더 길어진다 — 스튜디오 "스템 일괄 속도 조절"이 이걸 쓴다.
 *  @param {Float32Array} L
 *  @param {Float32Array} R
 *  @param {number} sampleRate
 *  @param {number} rate  출력 1초당 소비하는 입력 초 — 0.5 면 절반 속도(길이는 2배)
 *  @returns {Promise<{L: Float32Array, R: Float32Array}>}
 */
export async function timeStretchStereo(L, R, sampleRate, rate) {
  const N = Math.min(L.length, R.length);
  if (N === 0 || !(rate > 0)) return { L: new Float32Array(0), R: new Float32Array(0) };
  const outLen = Math.max(1, Math.round(N / rate));

  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: outLen, sampleRate });
  const stretch = await SignalsmithStretch(ctx);

  await stretch.addBuffers([new Float32Array(L.subarray(0, N)), new Float32Array(R.subarray(0, N))]);

  stretch.schedule({
    active: true,
    input: 0,
    rate,
    semitones: 0,   // 속도만 바꾸고 음정은 그대로 — pitchShiftStereo 와 반대 축
    formantCompensation: false,
    formantBaseHz: 0,
  });
  stretch.start();
  stretch.connect(ctx.destination);

  const rendered = await ctx.startRendering();
  return {
    L: rendered.getChannelData(0).slice(),
    R: rendered.getChannelData(1).slice(),
  };
}
