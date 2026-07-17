'use strict';
// WAV 인코딩 / Int16 ↔ Float32 변환을 메인 스레드에서 분리.
// 큰 영상 처리 시 UI freeze 방지.

function f32ToI16(arr) {
  const out = new Int16Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = Math.max(-1, Math.min(1, arr[i]));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
  }
  return out;
}
function i16ToF32(arr) {
  const out = new Float32Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] / 0x8000;
  return out;
}

function encodeWav(leftF32, rightF32, sampleRate) {
  const numFrames = Math.min(leftF32.length, rightF32.length);
  const dataBytes = numFrames * 2 * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    const l = Math.max(-1, Math.min(1, leftF32[i]));
    const r = Math.max(-1, Math.min(1, rightF32[i]));
    view.setInt16(off,     l < 0 ? l * 0x8000 : l * 0x7FFF, true);
    view.setInt16(off + 2, r < 0 ? r * 0x8000 : r * 0x7FFF, true);
    off += 4;
  }
  return buffer;
}

// ── Offline dynamic range compressor ─────────────────────────────
// Web Audio DynamicsCompressor는 look-ahead가 없어 재생 시작 시 첫 어택이 통과.
// 이 함수는 offline이라 look-ahead 임의 설정 가능 → 초반 spike도 미리 gain 낮춰 잡음.
//
// 알고리즘:
//   1) Peak envelope with look-ahead (monotonic deque sliding max, O(N))
//   2) Attack/release smoothing (1-pole IIR on log domain)
//   3) Soft knee gain reduction
//
// params: { threshold(dB), ratio, kneeDb, attackMs, releaseMs, lookaheadMs, makeupDb }
function compressChannel(input, sampleRate, params) {
  const N = input.length;
  if (N === 0) return new Float32Array(0);
  const threshold = params.threshold;
  const ratio     = params.ratio;
  const kneeDb    = params.kneeDb ?? 6;
  const attackMs  = params.attackMs ?? 5;
  const releaseMs = params.releaseMs ?? 100;
  const lookaheadMs = params.lookaheadMs ?? 5;
  const makeupDb    = params.makeupDb ?? 0;

  const lookaheadSamples = Math.max(1, Math.floor(lookaheadMs * sampleRate / 1000));
  const attackSamples  = Math.max(1, Math.floor(attackMs * sampleRate / 1000));
  const releaseSamples = Math.max(1, Math.floor(releaseMs * sampleRate / 1000));
  // 1-pole IIR coefficients for smoothing (근사)
  const attackCoef  = Math.exp(-1 / attackSamples);
  const releaseCoef = Math.exp(-1 / releaseSamples);
  const kneeHalf = kneeDb * 0.5;

  // 1) Peak envelope with look-ahead — 미래 lookaheadSamples 안의 |input| 최대값
  //    Monotonic deque으로 sliding max O(N)
  const peakEnv = new Float32Array(N);
  const deque = new Int32Array(N);
  let head = 0, tail = 0;
  for (let i = 0; i < N; i++) {
    const rightAdd = Math.min(N - 1, i + lookaheadSamples);
    const startAdd = (i === 0) ? 0 : Math.min(N - 1, (i - 1) + lookaheadSamples) + 1;
    for (let j = startAdd; j <= rightAdd; j++) {
      const abs = input[j] >= 0 ? input[j] : -input[j];
      while (tail > head && (input[deque[tail - 1]] >= 0 ? input[deque[tail - 1]] : -input[deque[tail - 1]]) <= abs) tail--;
      deque[tail++] = j;
    }
    // 좌측 outdated 제거 (window는 [i, i+lookaheadSamples])
    while (head < tail && deque[head] < i) head++;
    const v = input[deque[head]];
    peakEnv[i] = v >= 0 ? v : -v;
  }

  // 2) Attack/release smoothing on envelope (log domain 근사, linear로도 근사 가능)
  const smoothed = new Float32Array(N);
  let smooth = 0;
  for (let i = 0; i < N; i++) {
    const target = peakEnv[i];
    if (target > smooth) smooth = attackCoef * smooth + (1 - attackCoef) * target;
    else                 smooth = releaseCoef * smooth + (1 - releaseCoef) * target;
    smoothed[i] = smooth;
  }

  // 3) Gain reduction with soft knee, apply
  const output = new Float32Array(N);
  const makeupLin = Math.pow(10, makeupDb / 20);
  const invRatio = 1 / ratio;
  for (let i = 0; i < N; i++) {
    const env = smoothed[i];
    let gain = 1;
    if (env > 1e-9) {
      // envDb = 20*log10(env). log10(env) = ln(env)/ln(10)
      const envDb = 20 * Math.log(env) / Math.LN10;
      let overDb;
      if (envDb > threshold + kneeHalf) {
        overDb = envDb - threshold;
      } else if (envDb > threshold - kneeHalf) {
        // Soft knee (quadratic interpolation)
        const kneeIn = envDb - (threshold - kneeHalf);
        overDb = (kneeIn * kneeIn) / (2 * kneeDb);
      } else {
        overDb = 0;
      }
      if (overDb > 0) {
        const gainDb = overDb * (invRatio - 1);  // 음수 (감쇠)
        gain = Math.exp(gainDb * Math.LN10 / 20);
      }
    }
    output[i] = input[i] * gain * makeupLin;
  }
  return output;
}

const COMPRESSION_PRESETS = {
  off:    null,
  light:  { threshold: -12, ratio: 2,   kneeDb: 6,  attackMs: 10, releaseMs: 120, lookaheadMs: 5, makeupDb: 1.5 },
  medium: { threshold: -18, ratio: 3,   kneeDb: 8,  attackMs: 5,  releaseMs: 100, lookaheadMs: 5, makeupDb: 3.0 },
  heavy:  { threshold: -24, ratio: 4,   kneeDb: 10, attackMs: 3,  releaseMs: 80,  lookaheadMs: 5, makeupDb: 5.0 },
};

// stem mix: 가중치 합산 후 normalize
function mixStems(stemArrays, weights) {
  const names = Object.keys(stemArrays);
  if (names.length === 0) return null;
  const length = stemArrays[names[0]][0].length;
  const L = new Float32Array(length);
  const R = new Float32Array(length);
  for (const name of names) {
    const w = weights[name] ?? 1;
    if (w === 0) continue;
    const [l, r] = stemArrays[name];
    for (let i = 0; i < length; i++) {
      L[i] += l[i] * w;
      R[i] += r[i] * w;
    }
  }
  return [L, R];
}

// ── Phase vocoder pitch shift ────────────────────────────────────
// 1. Resample input by ratio → length / ratio, pitch * ratio
// 2. Phase vocoder time-stretch by ratio → length restored, pitch * ratio (= 원하는 결과)
// granular OLA의 phase 불연속으로 인한 "펄럭임" 제거. FFT 기반이라 느리지만 음질 좋음.

// In-place radix-2 Cooley-Tukey FFT. re/im: Float32Array length = N (must be power of 2).
function fft(re, im, inverse) {
  const N = re.length;
  // Bit-reversal permutation
  for (let i = 0, j = 0; i < N - 1; i++) {
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
    let k = N >> 1;
    while (k <= j) { j -= k; k >>= 1; }
    j += k;
  }
  // Butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const step = (inverse ? 2 : -2) * Math.PI / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < half; k++) {
        const a = step * k;
        const cs = Math.cos(a), sn = Math.sin(a);
        const i1 = i + k, i2 = i + k + half;
        const tr = cs * re[i2] - sn * im[i2];
        const ti = cs * im[i2] + sn * re[i2];
        re[i2] = re[i1] - tr;
        im[i2] = im[i1] - ti;
        re[i1] += tr;
        im[i1] += ti;
      }
    }
  }
  if (inverse) {
    const inv = 1 / N;
    for (let i = 0; i < N; i++) { re[i] *= inv; im[i] *= inv; }
  }
}

// Phase vocoder time-stretching with phase locking (Laroche-Dolson rigid phase locking).
// Magnitude spectrum의 local maxima(peak)를 찾아 그 phase만 표준 PV로 advance하고,
// 인접 non-peak bin들은 같은 frame 내 peak와의 phase 관계를 유지 → harmonic 일관성 보존
// → "phasiness"(울리는 느낌) 제거.
function timeStretch(input, factor) {
  const N = 4096;            // FFT size (2048→4096 더 좋은 freq resolution)
  const Ha = N >> 2;         // analysis hop = N/4 (75% overlap)
  const Hs = Math.max(1, Math.round(Ha * factor));
  const halfN = N >> 1;
  const inputLen = input.length;
  if (inputLen < N) return new Float32Array(input);

  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));

  const numFrames = Math.floor((inputLen - N) / Ha) + 1;
  const outLen = (numFrames - 1) * Hs + N;
  const out = new Float32Array(outLen);
  const normSum = new Float32Array(outLen);

  const prevPhase = new Float32Array(halfN + 1);
  const synPhase = new Float32Array(halfN + 1);
  const omega = new Float32Array(halfN + 1);
  for (let k = 0; k <= halfN; k++) omega[k] = 2 * Math.PI * k * Ha / N;

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const mag = new Float32Array(halfN + 1);
  const ph = new Float32Array(halfN + 1);
  const isPeak = new Uint8Array(halfN + 1);
  const peakOf = new Int32Array(halfN + 1);
  const TWO_PI = 2 * Math.PI;
  const hopRatio = Hs / Ha;

  for (let f = 0; f < numFrames; f++) {
    const start = f * Ha;
    for (let j = 0; j < N; j++) {
      re[j] = input[start + j] * win[j];
      im[j] = 0;
    }
    fft(re, im, false);

    for (let k = 0; k <= halfN; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      ph[k] = Math.atan2(im[k], re[k]);
      isPeak[k] = 0;
    }
    // Peak detection — local max in magnitude with ±2 bin window
    for (let k = 2; k <= halfN - 2; k++) {
      if (mag[k] > mag[k - 1] && mag[k] > mag[k + 1] &&
          mag[k] >= mag[k - 2] && mag[k] >= mag[k + 2]) {
        isPeak[k] = 1;
      }
    }
    // 각 bin을 가장 가까운 peak에 할당 (Voronoi)
    let lastPk = -1;
    for (let k = 0; k <= halfN; k++) {
      if (isPeak[k]) lastPk = k;
      peakOf[k] = lastPk;
    }
    let nextPk = -1;
    for (let k = halfN; k >= 0; k--) {
      if (isPeak[k]) nextPk = k;
      else if (nextPk !== -1) {
        if (peakOf[k] === -1 || (nextPk - k) < (k - peakOf[k])) peakOf[k] = nextPk;
      }
    }
    // Peak: standard phase vocoder
    for (let k = 0; k <= halfN; k++) {
      if (!isPeak[k]) continue;
      let dp = ph[k] - prevPhase[k] - omega[k];
      dp -= TWO_PI * Math.round(dp / TWO_PI);
      synPhase[k] += (omega[k] + dp) * hopRatio;
    }
    // Non-peak: lock to nearest peak's phase relationship
    for (let k = 0; k <= halfN; k++) {
      if (isPeak[k]) continue;
      const pk = peakOf[k];
      if (pk === -1) {
        // Fallback — peak가 하나도 없는 silent frame
        let dp = ph[k] - prevPhase[k] - omega[k];
        dp -= TWO_PI * Math.round(dp / TWO_PI);
        synPhase[k] += (omega[k] + dp) * hopRatio;
      } else {
        synPhase[k] = synPhase[pk] + (ph[k] - ph[pk]);
      }
    }
    // Save current phase
    for (let k = 0; k <= halfN; k++) prevPhase[k] = ph[k];
    // Apply (magnitude 그대로)
    for (let k = 0; k <= halfN; k++) {
      re[k] = mag[k] * Math.cos(synPhase[k]);
      im[k] = mag[k] * Math.sin(synPhase[k]);
    }
    // Conjugate symmetry
    for (let k = 1; k < halfN; k++) {
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    im[0] = 0; im[halfN] = 0;

    fft(re, im, true);

    const sStart = f * Hs;
    for (let j = 0; j < N; j++) {
      const idx = sStart + j;
      if (idx < outLen) {
        out[idx] += re[j] * win[j];
        normSum[idx] += win[j] * win[j];
      }
    }
  }
  for (let j = 0; j < outLen; j++) {
    if (normSum[j] > 1e-8) out[j] /= normSum[j];
  }
  return out;
}

function pitchShiftChannel(input, semitones) {
  if (Math.abs(semitones) < 0.001) return new Float32Array(input);
  const ratio = Math.pow(2, semitones / 12);
  const N = input.length;
  // 1) Resample by ratio — pitch up * ratio, length /= ratio
  const resampledLen = Math.max(1, Math.round(N / ratio));
  const resampled = new Float32Array(resampledLen);
  for (let i = 0; i < resampledLen; i++) {
    const srcPos = i * ratio;
    const idx = srcPos | 0;
    const frac = srcPos - idx;
    if (idx + 1 < N) resampled[i] = input[idx] * (1 - frac) + input[idx + 1] * frac;
    else if (idx < N) resampled[i] = input[idx];
  }
  // 2) Phase vocoder time-stretch by ratio — length 복원, pitch는 유지
  const stretched = timeStretch(resampled, ratio);
  // 정확한 출력 길이 N으로 trim/pad
  const out = new Float32Array(N);
  out.set(stretched.subarray(0, Math.min(N, stretched.length)));
  return out;
}


self.addEventListener('message', (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'encodeWav') {
      const { left, right, sampleRate } = e.data;
      const buf = encodeWav(left, right, sampleRate);
      self.postMessage({ id, type: 'result', data: buf }, [buf]);
    } else if (type === 'compressStems') {
      const { stems } = e.data;
      const out = {};
      const xfers = [];
      for (const k of Object.keys(stems)) {
        const [l, r] = stems[k];
        const li = f32ToI16(l), ri = f32ToI16(r);
        out[k] = [li, ri];
        xfers.push(li.buffer, ri.buffer);
      }
      self.postMessage({ id, type: 'result', stems: out }, xfers);
    } else if (type === 'decompressStems') {
      const { stems } = e.data;
      const out = {};
      const xfers = [];
      for (const k of Object.keys(stems)) {
        const [l, r] = stems[k];
        const lf = i16ToF32(l), rf = i16ToF32(r);
        out[k] = [lf, rf];
        xfers.push(lf.buffer, rf.buffer);
      }
      self.postMessage({ id, type: 'result', stems: out }, xfers);
    } else if (type === 'pitchShift') {
      const { stems, semitones } = e.data;
      const out = {};
      const xfers = [];
      for (const k of Object.keys(stems)) {
        const [l, r] = stems[k];
        const lOut = pitchShiftChannel(l, semitones);
        const rOut = pitchShiftChannel(r, semitones);
        out[k] = [lOut, rOut];
        xfers.push(lOut.buffer, rOut.buffer);
      }
      self.postMessage({ id, type: 'result', stems: out }, xfers);
    } else if (type === 'mixAndEncode') {
      const { stems, weights, sampleRate } = e.data;
      const mix = mixStems(stems, weights);
      if (!mix) throw new Error('mix 실패');
      const buf = encodeWav(mix[0], mix[1], sampleRate);
      self.postMessage({ id, type: 'result', data: buf }, [buf]);
    } else if (type === 'applyCompression') {
      // Offline dynamic-range compression per stem. 사용자가 preset='off'면 원본 그대로 반환.
      const { stems, preset, sampleRate } = e.data;
      const params = COMPRESSION_PRESETS[preset] || null;
      const out = {};
      const xfers = [];
      for (const k of Object.keys(stems)) {
        const [l, r] = stems[k];
        let lOut, rOut;
        if (!params) {
          // Off: 복사만 (호출부는 transferable을 재사용할 것)
          lOut = new Float32Array(l);
          rOut = new Float32Array(r);
        } else {
          lOut = compressChannel(l, sampleRate, params);
          rOut = compressChannel(r, sampleRate, params);
        }
        out[k] = [lOut, rOut];
        xfers.push(lOut.buffer, rOut.buffer);
      }
      self.postMessage({ id, type: 'result', stems: out }, xfers);
    } else {
      throw new Error('알 수 없는 type: ' + type);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', error: err.message });
  }
});
