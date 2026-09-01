'use strict';

/* ===================================================================
   STT Worker — Whisper-small(ONNX, 양자화) 전용.

   Mel 스펙트로그램 추출(FFT/윈도우/필터뱅크)과 디코더 루프는 HuggingFace
   transformers.js(@huggingface/transformers, Apache-2.0)의 utils/maths.js,
   utils/audio.js, models/whisper/* 를 참고해 이식했다 — 이 ONNX 파일들
   자체가 그 라이브러리의 변환 스크립트로 만들어진 것이라, 정확히 같은
   전처리/디코딩 규약(텐서 이름, mel 필터, 타임스탬프 토큰 프로토콜)을
   따라야 실제로 맞는 결과가 나온다. stem-worker.js 의 htdemucs/scnet 처럼
   이 프로젝트도 외부 구현을 그대로 vendor 하는 방식을 쓴다(scnet 쪽 주석
   참고 — 같은 패턴).
   =================================================================== */

// ── FFT (transformers.js utils/maths.js 이식, Apache-2.0) ──────────────
// P2FFT: 2의 거듭제곱 길이용 라딕스-4 FFT(fft.js 기반). NP2FFT: 임의 길이용
// Bluestein(chirp-z) 변환 — Whisper 의 n_fft=400 은 2의 거듭제곱이 아니라
// 이게 필요하다. 원본 코드를 거의 그대로 옮겼다(변수/로직 변경 없음).
function isPowerOfTwo(number) {
  return number > 0 && (number & (number - 1)) === 0;
}
class P2FFT {
  constructor(size) {
    this.size = size | 0;
    if (this.size <= 1 || !isPowerOfTwo(this.size)) throw new Error('FFT size must be a power of two larger than 1');
    this._csize = size << 1;
    this.table = new Float64Array(this.size * 2);
    for (let i = 0; i < this.table.length; i += 2) {
      const angle = (Math.PI * i) / this.size;
      this.table[i] = Math.cos(angle);
      this.table[i + 1] = -Math.sin(angle);
    }
    let power = 0;
    for (let t = 1; this.size > t; t <<= 1) ++power;
    this._width = power % 2 === 0 ? power - 1 : power;
    this._bitrev = new Int32Array(1 << this._width);
    for (let j = 0; j < this._bitrev.length; ++j) {
      this._bitrev[j] = 0;
      for (let shift = 0; shift < this._width; shift += 2) {
        const revShift = this._width - shift - 2;
        this._bitrev[j] |= ((j >>> shift) & 3) << revShift;
      }
    }
  }
  createComplexArray() { return new Float64Array(this._csize); }
  transform(out, data) {
    if (out === data) throw new Error('Input and output buffers must be different');
    this._transform4(out, data, 1);
  }
  realTransform(out, data) {
    if (out === data) throw new Error('Input and output buffers must be different');
    this._realTransform4(out, data, 1);
  }
  inverseTransform(out, data) {
    if (out === data) throw new Error('Input and output buffers must be different');
    this._transform4(out, data, -1);
    for (let i = 0; i < out.length; ++i) out[i] /= this.size;
  }
  _transform4(out, data, inv) {
    const size = this._csize;
    const width = this._width;
    let step = 1 << width;
    let len = (size / step) << 1;
    let outOff, t;
    const bitrev = this._bitrev;
    if (len === 4) {
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) this._singleTransform2(data, out, outOff, bitrev[t], step);
    } else {
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) this._singleTransform4(data, out, outOff, bitrev[t], step, inv);
    }
    const table = this.table;
    for (step >>= 2; step >= 2; step >>= 2) {
      len = (size / step) << 1;
      const quarterLen = len >>> 2;
      for (outOff = 0; outOff < size; outOff += len) {
        const limit = outOff + quarterLen - 1;
        for (let i = outOff, k = 0; i < limit; i += 2, k += step) {
          const A = i, B = A + quarterLen, C = B + quarterLen, D = C + quarterLen;
          const Ar = out[A], Ai = out[A + 1], Br = out[B], Bi = out[B + 1];
          const Cr = out[C], Ci = out[C + 1], Dr = out[D], Di = out[D + 1];
          const tableBr = table[k], tableBi = inv * table[k + 1];
          const MBr = Br * tableBr - Bi * tableBi, MBi = Br * tableBi + Bi * tableBr;
          const tableCr = table[2 * k], tableCi = inv * table[2 * k + 1];
          const MCr = Cr * tableCr - Ci * tableCi, MCi = Cr * tableCi + Ci * tableCr;
          const tableDr = table[3 * k], tableDi = inv * table[3 * k + 1];
          const MDr = Dr * tableDr - Di * tableDi, MDi = Dr * tableDi + Di * tableDr;
          const T0r = Ar + MCr, T0i = Ai + MCi, T1r = Ar - MCr, T1i = Ai - MCi;
          const T2r = MBr + MDr, T2i = MBi + MDi, T3r = inv * (MBr - MDr), T3i = inv * (MBi - MDi);
          out[A] = T0r + T2r; out[A + 1] = T0i + T2i;
          out[B] = T1r + T3i; out[B + 1] = T1i - T3r;
          out[C] = T0r - T2r; out[C + 1] = T0i - T2i;
          out[D] = T1r - T3i; out[D + 1] = T1i + T3r;
        }
      }
    }
  }
  _singleTransform2(data, out, outOff, off, step) {
    const evenR = data[off], evenI = data[off + 1], oddR = data[off + step], oddI = data[off + step + 1];
    out[outOff] = evenR + oddR; out[outOff + 1] = evenI + oddI;
    out[outOff + 2] = evenR - oddR; out[outOff + 3] = evenI - oddI;
  }
  _singleTransform4(data, out, outOff, off, step, inv) {
    const step2 = step * 2, step3 = step * 3;
    const Ar = data[off], Ai = data[off + 1], Br = data[off + step], Bi = data[off + step + 1];
    const Cr = data[off + step2], Ci = data[off + step2 + 1], Dr = data[off + step3], Di = data[off + step3 + 1];
    const T0r = Ar + Cr, T0i = Ai + Ci, T1r = Ar - Cr, T1i = Ai - Ci;
    const T2r = Br + Dr, T2i = Bi + Di, T3r = inv * (Br - Dr), T3i = inv * (Bi - Di);
    out[outOff] = T0r + T2r; out[outOff + 1] = T0i + T2i;
    out[outOff + 2] = T1r + T3i; out[outOff + 3] = T1i - T3r;
    out[outOff + 4] = T0r - T2r; out[outOff + 5] = T0i - T2i;
    out[outOff + 6] = T1r - T3i; out[outOff + 7] = T1i + T3r;
  }
  _realTransform4(out, data, inv) {
    const size = this._csize;
    const width = this._width;
    let step = 1 << width;
    let len = (size / step) << 1;
    let outOff, t;
    const bitrev = this._bitrev;
    if (len === 4) {
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) this._singleRealTransform2(data, out, outOff, bitrev[t] >>> 1, step >>> 1);
    } else {
      for (outOff = 0, t = 0; outOff < size; outOff += len, ++t) this._singleRealTransform4(data, out, outOff, bitrev[t] >>> 1, step >>> 1, inv);
    }
    const table = this.table;
    for (step >>= 2; step >= 2; step >>= 2) {
      len = (size / step) << 1;
      const halfLen = len >>> 1, quarterLen = halfLen >>> 1, hquarterLen = quarterLen >>> 1;
      for (outOff = 0; outOff < size; outOff += len) {
        for (let i = 0, k = 0; i <= hquarterLen; i += 2, k += step) {
          const A = outOff + i, B = A + quarterLen, C = B + quarterLen, D = C + quarterLen;
          const Ar = out[A], Ai = out[A + 1], Br = out[B], Bi = out[B + 1];
          const Cr = out[C], Ci = out[C + 1], Dr = out[D], Di = out[D + 1];
          const MAr = Ar, MAi = Ai;
          const tableBr = table[k], tableBi = inv * table[k + 1];
          const MBr = Br * tableBr - Bi * tableBi, MBi = Br * tableBi + Bi * tableBr;
          const tableCr = table[2 * k], tableCi = inv * table[2 * k + 1];
          const MCr = Cr * tableCr - Ci * tableCi, MCi = Cr * tableCi + Ci * tableCr;
          const tableDr = table[3 * k], tableDi = inv * table[3 * k + 1];
          const MDr = Dr * tableDr - Di * tableDi, MDi = Dr * tableDi + Di * tableDr;
          const T0r = MAr + MCr, T0i = MAi + MCi, T1r = MAr - MCr, T1i = MAi - MCi;
          const T2r = MBr + MDr, T2i = MBi + MDi, T3r = inv * (MBr - MDr), T3i = inv * (MBi - MDi);
          out[A] = T0r + T2r; out[A + 1] = T0i + T2i;
          out[B] = T1r + T3i; out[B + 1] = T1i - T3r;
          if (i === 0) { out[C] = T0r - T2r; out[C + 1] = T0i - T2i; continue; }
          if (i === hquarterLen) continue;
          const SA = outOff + quarterLen - i, SB = outOff + halfLen - i;
          out[SA] = T1r - inv * T3i; out[SA + 1] = -T1i - inv * T3r;
          out[SB] = T0r - inv * T2r; out[SB + 1] = -T0i + inv * T2i;
        }
      }
    }
    const half = size >>> 1;
    for (let i = 2; i < half; i += 2) { out[size - i] = out[i]; out[size - i + 1] = -out[i + 1]; }
  }
  _singleRealTransform2(data, out, outOff, off, step) {
    const evenR = data[off], oddR = data[off + step];
    out[outOff] = evenR + oddR; out[outOff + 1] = 0;
    out[outOff + 2] = evenR - oddR; out[outOff + 3] = 0;
  }
  _singleRealTransform4(data, out, outOff, off, step, inv) {
    const step2 = step * 2, step3 = step * 3;
    const Ar = data[off], Br = data[off + step], Cr = data[off + step2], Dr = data[off + step3];
    const T0r = Ar + Cr, T1r = Ar - Cr, T2r = Br + Dr, T3r = inv * (Br - Dr);
    out[outOff] = T0r + T2r; out[outOff + 1] = 0;
    out[outOff + 2] = T1r; out[outOff + 3] = -T3r;
    out[outOff + 4] = T0r - T2r; out[outOff + 5] = 0;
    out[outOff + 6] = T1r; out[outOff + 7] = T3r;
  }
}
class NP2FFT {
  constructor(fft_length) {
    const a = 2 * (fft_length - 1);
    const b = 2 * (2 * fft_length - 1);
    const nextP2 = 2 ** Math.ceil(Math.log2(b));
    this.bufferSize = nextP2;
    this._a = a;
    const chirp = new Float64Array(b);
    const ichirp = new Float64Array(nextP2);
    this._chirpBuffer = new Float64Array(nextP2);
    this._buffer1 = new Float64Array(nextP2);
    this._buffer2 = new Float64Array(nextP2);
    this._outBuffer1 = new Float64Array(nextP2);
    this._outBuffer2 = new Float64Array(nextP2);
    const theta = (-2 * Math.PI) / fft_length;
    const baseR = Math.cos(theta), baseI = Math.sin(theta);
    for (let i = 0; i < b >> 1; ++i) {
      const e = (i + 1 - fft_length) ** 2 / 2.0;
      const result_mod = Math.sqrt(baseR ** 2 + baseI ** 2) ** e;
      const result_arg = e * Math.atan2(baseI, baseR);
      const i2 = 2 * i;
      chirp[i2] = result_mod * Math.cos(result_arg);
      chirp[i2 + 1] = result_mod * Math.sin(result_arg);
      ichirp[i2] = chirp[i2]; ichirp[i2 + 1] = -chirp[i2 + 1];
    }
    this._slicedChirpBuffer = chirp.subarray(a, b);
    this._f = new P2FFT(nextP2 >> 1);
    this._f.transform(this._chirpBuffer, ichirp);
  }
  _transform(output, input, real) {
    const ib1 = this._buffer1, ib2 = this._buffer2, ob2 = this._outBuffer1, ob3 = this._outBuffer2;
    const cb = this._chirpBuffer, sb = this._slicedChirpBuffer, a = this._a;
    if (real) {
      for (let j = 0; j < sb.length; j += 2) {
        const j2 = j + 1, j3 = j >> 1;
        const a_real = input[j3];
        ib1[j] = a_real * sb[j]; ib1[j2] = a_real * sb[j2];
      }
    } else {
      for (let j = 0; j < sb.length; j += 2) {
        const j2 = j + 1;
        ib1[j] = input[j] * sb[j] - input[j2] * sb[j2];
        ib1[j2] = input[j] * sb[j2] + input[j2] * sb[j];
      }
    }
    this._f.transform(ob2, ib1);
    for (let j = 0; j < cb.length; j += 2) {
      const j2 = j + 1;
      ib2[j] = ob2[j] * cb[j] - ob2[j2] * cb[j2];
      ib2[j2] = ob2[j] * cb[j2] + ob2[j2] * cb[j];
    }
    this._f.inverseTransform(ob3, ib2);
    for (let j = 0; j < ob3.length; j += 2) {
      const a_real = ob3[j + a], a_imag = ob3[j + a + 1], b_real = sb[j], b_imag = sb[j + 1];
      output[j] = a_real * b_real - a_imag * b_imag;
      output[j + 1] = a_real * b_imag + a_imag * b_real;
    }
  }
  transform(output, input) { this._transform(output, input, false); }
  realTransform(output, input) { this._transform(output, input, true); }
}
class FFT {
  constructor(fft_length) {
    this.fft_length = fft_length;
    this.isPowerOfTwo = isPowerOfTwo(fft_length);
    if (this.isPowerOfTwo) { this.fft = new P2FFT(fft_length); this.outputBufferSize = 2 * fft_length; }
    else { this.fft = new NP2FFT(fft_length); this.outputBufferSize = this.fft.bufferSize; }
  }
  realTransform(out, input) { this.fft.realTransform(out, input); }
  transform(out, input) { this.fft.transform(out, input); }
}

// ── Whisper 특징 추출(로그-멜 스펙트로그램) ─────────────────────────────
// n_fft=400, hop=160, 80-mel, 16kHz — preprocessor_config.json 과 동일.
// transformers.js utils/audio.js 의 spectrogram()/mel_filter_bank()/
// window_function() 을 이 프로젝트의 고정 파라미터에 맞게 특수화했다.
function calculateReflectOffset(i, w) { return Math.abs(((i + w) % (2 * w)) - w); }
function padReflect(array, left, right) {
  const padded = new Float64Array(array.length + left + right);
  const w = array.length - 1;
  for (let i = 0; i < array.length; ++i) padded[left + i] = array[i];
  for (let i = 1; i <= left; ++i) padded[left - i] = array[calculateReflectOffset(i, w)];
  for (let i = 1; i <= right; ++i) padded[w + left + i] = array[calculateReflectOffset(w - i, w)];
  return padded;
}
// periodic Hann(짝수 길이) — numpy.hanning(M+1)[:M] 과 동치.
function hannPeriodic(M) {
  const w = new Float64Array(M);
  const factor = (2 * Math.PI) / M;
  for (let i = 0; i < M; ++i) w[i] = 0.5 - 0.5 * Math.cos(i * factor);
  return w;
}
const SLANEY_MIN_LOG_HZ = 1000.0, SLANEY_MIN_LOG_MEL = 15.0, SLANEY_LOGSTEP = 27.0 / Math.log(6.4);
function hzToMelSlaney(hz) {
  return hz >= SLANEY_MIN_LOG_HZ ? SLANEY_MIN_LOG_MEL + Math.log(hz / SLANEY_MIN_LOG_HZ) * SLANEY_LOGSTEP : (3.0 * hz) / 200.0;
}
function melToHzSlaney(mel) {
  return mel >= SLANEY_MIN_LOG_MEL ? SLANEY_MIN_LOG_HZ * Math.exp((Math.log(6.4) / 27.0) * (mel - SLANEY_MIN_LOG_MEL)) : (200.0 * mel) / 3.0;
}
function linspace(start, end, num) {
  const step = (end - start) / (num - 1);
  return Float64Array.from({ length: num }, (_, i) => start + step * i);
}
// (num_mel_filters, num_frequency_bins) 형태로 돌려준다(matmul 에서 그대로 쓰기 편하게 —
// transformers.js 원본은 (freq,mel) 이지만 우리는 옮겨서 사용).
function buildMelFilterBank(numFreqBins, numMelFilters, sampleRate) {
  const melMin = hzToMelSlaney(0), melMax = hzToMelSlaney(sampleRate / 2);
  const melPts = linspace(melMin, melMax, numMelFilters + 2);
  const hzPts = Float64Array.from(melPts, melToHzSlaney);
  const fftFreqs = linspace(0, Math.floor(sampleRate / 2), numFreqBins);
  const filterDiff = Float64Array.from({ length: numMelFilters + 1 }, (_, i) => hzPts[i + 1] - hzPts[i]);
  const filters = new Float32Array(numMelFilters * numFreqBins);
  for (let i = 0; i < numMelFilters; ++i) {
    for (let j = 0; j < numFreqBins; ++j) {
      const down = (fftFreqs[j] - hzPts[i]) / filterDiff[i];
      const up = (hzPts[i + 2] - fftFreqs[j]) / filterDiff[i + 1];
      filters[i * numFreqBins + j] = Math.max(0, Math.min(down, up));
    }
    // slaney 정규화 — 채널당 에너지가 대략 일정하게.
    const enorm = 2.0 / (hzPts[i + 2] - hzPts[i]);
    for (let j = 0; j < numFreqBins; ++j) filters[i * numFreqBins + j] *= enorm;
  }
  return filters;   // Float32Array[numMelFilters * numFreqBins], row-major (mel, freq)
}
const N_FFT = 400, HOP = 160, N_MELS = 80, N_SAMPLES = 480000, NB_MAX_FRAMES = 3000, SAMPLE_RATE = 16000;
const NUM_FREQ_BINS = N_FFT / 2 + 1;   // 201
const HANN_WINDOW = hannPeriodic(N_FFT);
const MEL_FILTERS = buildMelFilterBank(NUM_FREQ_BINS, N_MELS, SAMPLE_RATE);
const _fftEngine = new FFT(N_FFT);
// waveform: Float32Array, 이미 16kHz 모노. 30초(480000 샘플) 이하로 이미 잘려 있어야 한다
// (긴 오디오는 호출부가 30초 창으로 나눠서 넘긴다). 반환: Float32Array[80*3000] (row-major, mel-major).
function computeLogMelSpectrogram(waveformIn) {
  // 30초 기준으로 0-패딩(짧으면) — n_samples 만큼 항상 맞춘다.
  let waveform;
  if (waveformIn.length >= N_SAMPLES) waveform = waveformIn.subarray(0, N_SAMPLES);
  else { waveform = new Float32Array(N_SAMPLES); waveform.set(waveformIn); }

  const padding = N_FFT >> 1;   // 200
  const padded = padReflect(waveform, padding, padding);   // length 480400

  const numFrames = Math.min(1 + Math.floor((padded.length - N_FFT) / HOP), NB_MAX_FRAMES);
  const magnitudes = new Float32Array(NUM_FREQ_BINS * NB_MAX_FRAMES);   // (freq, frame), 부족분은 0으로 남음
  const inputBuffer = new Float64Array(N_FFT);
  const outputBuffer = new Float64Array(_fftEngine.outputBufferSize);
  for (let i = 0; i < numFrames; ++i) {
    const offset = i * HOP;
    for (let j = 0; j < N_FFT; ++j) inputBuffer[j] = padded[offset + j] * HANN_WINDOW[j];
    _fftEngine.realTransform(outputBuffer, inputBuffer);
    for (let j = 0; j < NUM_FREQ_BINS; ++j) {
      const j2 = j << 1;
      magnitudes[j * NB_MAX_FRAMES + i] = outputBuffer[j2] ** 2 + outputBuffer[j2 + 1] ** 2;   // power=2.0
    }
  }

  // mel_spec[m][t] = sum_f MEL_FILTERS[m][f] * magnitudes[f][t]  → (80, 3000)
  const melSpec = new Float32Array(N_MELS * NB_MAX_FRAMES);
  for (let m = 0; m < N_MELS; ++m) {
    const filterRow = m * NUM_FREQ_BINS;
    const outRow = m * NB_MAX_FRAMES;
    for (let f = 0; f < NUM_FREQ_BINS; ++f) {
      const w = MEL_FILTERS[filterRow + f];
      if (w === 0) continue;
      const magRow = f * NB_MAX_FRAMES;
      for (let t = 0; t < numFrames; ++t) outRow + t < melSpec.length && (melSpec[outRow + t] += w * magnitudes[magRow + t]);
    }
  }
  // mel_floor 클램프 → log10 → (log10_max_norm) max-8 클리핑 → (x+4)/4
  let maxVal = -Infinity;
  for (let i = 0; i < melSpec.length; ++i) {
    const v = Math.max(1e-10, melSpec[i]);
    const lv = Math.log10(v);
    melSpec[i] = lv;
    if (lv > maxVal) maxVal = lv;
  }
  const threshold = maxVal - 8.0;
  for (let i = 0; i < melSpec.length; ++i) melSpec[i] = (Math.max(melSpec[i], threshold) + 4.0) / 4.0;
  return melSpec;
}

// ── 토크나이저(디코드 전용) — 바이트 레벨 BPE(GPT-2 계열) id→텍스트만 필요하다
// (음성→텍스트는 인코딩이 필요 없다, 나오는 토큰 id를 문자열로 되돌리기만 하면 된다).
function buildByteDecoder() {
  const bs = [];
  for (let i = '!'.charCodeAt(0); i <= '~'.charCodeAt(0); ++i) bs.push(i);
  for (let i = '¡'.charCodeAt(0); i <= '¬'.charCodeAt(0); ++i) bs.push(i);
  for (let i = '®'.charCodeAt(0); i <= 'ÿ'.charCodeAt(0); ++i) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; ++b) {
    if (!bs.includes(b)) { bs.push(b); cs.push(256 + n); n++; }
  }
  const map = new Map();   // unicode char → byte value
  for (let i = 0; i < bs.length; ++i) map.set(String.fromCharCode(cs[i]), bs[i]);
  return map;
}
const BYTE_DECODER = buildByteDecoder();
class WhisperTokenizer {
  constructor(vocabJson) {
    const vocab = JSON.parse(vocabJson);   // {token_string: id}
    this.idToToken = new Map();
    for (const [tok, id] of Object.entries(vocab)) this.idToToken.set(id, tok);
  }
  // ids: 순수 텍스트(비특수) 토큰 id 배열 → 실제 문자열(UTF-8) 하나로 합쳐서 디코드.
  decode(ids) {
    let byteStr = '';
    for (const id of ids) {
      const tok = this.idToToken.get(id);
      if (tok == null) continue;
      byteStr += tok;
    }
    const bytes = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; ++i) bytes[i] = BYTE_DECODER.get(byteStr[i]) ?? 0;
    return new TextDecoder('utf-8').decode(bytes);
  }
}

// ── ORT 세션 + 디코드 루프 ───────────────────────────────────────────
let ORT = null, encoderSession = null, decoderSession = null, tokenizer = null;
let genCfg = null;   // generation_config.json 파싱 결과
const N_LAYERS = 12, N_HEADS = 12, HEAD_DIM = 64;   // whisper-small

self.addEventListener('message', async (e) => {
  const d = e.data;
  try {
    if (d.type === 'INIT') {
      const mod = await import(d.runtimeUrl + 'lib/ort.webgpu.bundle.min.mjs');
      ORT = mod.default || mod;
      if (!ORT || !ORT.InferenceSession) throw new Error('ORT 모듈 로드 실패');
      ORT.env.wasm.wasmPaths = d.runtimeUrl + 'lib/';
      ORT.env.wasm.numThreads = typeof SharedArrayBuffer !== 'undefined' ? Math.min(navigator.hardwareConcurrency || 2, 4) : 1;
      self.postMessage({ type: 'INIT_OK' });
    } else if (d.type === 'LOAD_MODEL') {
      encoderSession = await ORT.InferenceSession.create(d.encoder, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      decoderSession = await ORT.InferenceSession.create(d.decoder, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      tokenizer = new WhisperTokenizer(d.vocab);
      genCfg = JSON.parse(d.generationConfig);
      self.postMessage({ type: 'MODEL_OK' });
    } else if (d.type === 'TRANSCRIBE') {
      const segments = await transcribe(d.pcm, d.jobId);
      self.postMessage({ type: 'RESULT', jobId: d.jobId, segments });
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', jobId: d.jobId, error: String(err && (err.stack || err.message || err)) });
  }
});

function argmaxMasked(logits, suppressSet) {
  let best = -Infinity, bestIdx = 0;
  for (let i = 0; i < logits.length; ++i) {
    if (suppressSet && suppressSet.has(i)) continue;
    if (logits[i] > best) { best = logits[i]; bestIdx = i; }
  }
  return bestIdx;
}
// 언어 지정 없이(자동 감지) 시작 프롬프트를 만든다 — 표준 Whisper 규약대로,
// <|startoftranscript|> 하나만 넣고 디코더를 한 스텝 돌려 그 자리 logits 중
// lang_to_id 후보들끼리만 비교해 가장 높은 언어를 고른다.
async function detectLanguageAndBuildPrompt() {
  const bos = genCfg.decoder_start_token_id;   // 50258
  const langIds = new Set(Object.values(genCfg.lang_to_id));
  const feeds = {
    input_ids: new ORT.Tensor('int64', BigInt64Array.from([BigInt(bos)]), [1, 1]),
    encoder_hidden_states: _lastEncoderHidden,
    use_cache_branch: new ORT.Tensor('bool', [false], [1]),
    ..._emptyPastFeeds(),
  };
  const out = await decoderSession.run(feeds);
  const logits = out.logits.data;   // [1,1,vocabSize]
  const vocabSize = out.logits.dims[2];
  let best = -Infinity, bestId = genCfg.lang_to_id['<|en|>'] ?? 50259;
  for (const id of langIds) { const v = logits[id]; if (v > best) { best = v; bestId = id; } }
  return [bos, bestId, genCfg.task_to_id.transcribe];
}
// past_key_values.*.decoder/encoder.key/value — use_cache_branch=false(첫 스텝)일 땐
// 그래프가 encoder K/V 를 내부에서 새로 계산하니 그 입력들은 아무 값(0-length)이나
// 넣어도 된다. decoder 쪽도 아직 캐시가 없으니 길이 0.
function _emptyPastFeeds() {
  const feeds = {};
  const emptyDec = new ORT.Tensor('float32', new Float32Array(0), [1, N_HEADS, 0, HEAD_DIM]);
  const emptyEnc = new ORT.Tensor('float32', new Float32Array(0), [1, N_HEADS, 0, HEAD_DIM]);
  for (let i = 0; i < N_LAYERS; ++i) {
    feeds[`past_key_values.${i}.decoder.key`] = emptyDec;
    feeds[`past_key_values.${i}.decoder.value`] = emptyDec;
    feeds[`past_key_values.${i}.encoder.key`] = emptyEnc;
    feeds[`past_key_values.${i}.encoder.value`] = emptyEnc;
  }
  return feeds;
}
let _lastEncoderHidden = null;

// 하나의 30초 창(멜 스펙트로그램)을 인코더+디코더로 돌려 토큰 시퀀스를 만들고,
// 타임스탬프 토큰(<=50364 이상, 0.02초 단위)으로 (start,end,text) 세그먼트를 뽑는다.
// progressInfo — {jobId, chunkIndex, totalChunks}: 디코드 진행(생성한 토큰 수)을
// 실시간으로 알려준다 — 문장이 짧으면 금방(수십 토큰 안에) 끝나니 최대 길이(448) 대비
// 퍼센트로 보여주면 오히려 "몇 % 안 갔는데 끝남" 처럼 왜곡돼서, 그냥 진행 중인 토큰
// 개수를 그대로 보여준다(퍼센트 아님, "지금 몇 개째 만드는 중"만 알려줌).
async function transcribeChunk(melData, progressInfo) {
  const encFeeds = { input_features: new ORT.Tensor('float32', melData, [1, N_MELS, NB_MAX_FRAMES]) };
  const encOut = await encoderSession.run(encFeeds);
  _lastEncoderHidden = encOut.last_hidden_state;

  const promptIds = await detectLanguageAndBuildPrompt();
  const noTimestamps = genCfg.no_timestamps_token_id || 50363;
  const timestampBegin = noTimestamps + 1;
  // notimestamps 토큰을 늘 억제한다 — 안 그러면 모델이 그 토큰을 골라 타임스탬프 없이
  // 통째로(문장 전체를 한 덩어리로) 뱉어버릴 수 있다(실측 확인). 우리는 자막을 구간별로
  // 배치해야 하니 타임스탬프가 꼭 있어야 한다.
  const suppressAlways = new Set([...(genCfg.suppress_tokens || []), noTimestamps]);
  const suppressBegin = new Set(genCfg.begin_suppress_tokens || []);
  const eos = genCfg.eos_token_id;
  const maxLen = genCfg.max_length || 448;

  let pastFeeds = _emptyPastFeeds();
  let tokens = [];
  let useCacheBranch = false;
  let nextInputIds = promptIds;

  while (promptIds.length + tokens.length < maxLen) {
    const idsTensorData = BigInt64Array.from(nextInputIds.map((v) => BigInt(v)));
    const feeds = {
      input_ids: new ORT.Tensor('int64', idsTensorData, [1, nextInputIds.length]),
      encoder_hidden_states: _lastEncoderHidden,
      use_cache_branch: new ORT.Tensor('bool', [useCacheBranch], [1]),
      ...pastFeeds,
    };
    const out = await decoderSession.run(feeds);
    const dims = out.logits.dims;   // [1, seqLen, vocab]
    const seqLen = dims[1], vocab = dims[2];
    const lastLogits = out.logits.data.subarray((seqLen - 1) * vocab, seqLen * vocab);

    const mask = tokens.length === 0 ? new Set([...suppressAlways, ...suppressBegin]) : suppressAlways;
    const nextId = argmaxMasked(lastLogits, mask);
    if (nextId === eos) break;
    tokens.push(nextId);
    self.postMessage({ type: 'DECODE_PROGRESS', jobId: progressInfo.jobId, chunkIndex: progressInfo.chunkIndex, totalChunks: progressInfo.totalChunks, tokenCount: tokens.length });

    // KV 캐시 갱신 — present.* 를 다음 스텝의 past.* 로.
    const newPast = {};
    for (let i = 0; i < N_LAYERS; ++i) {
      newPast[`past_key_values.${i}.decoder.key`] = out[`present.${i}.decoder.key`];
      newPast[`past_key_values.${i}.decoder.value`] = out[`present.${i}.decoder.value`];
      newPast[`past_key_values.${i}.encoder.key`] = useCacheBranch ? pastFeeds[`past_key_values.${i}.encoder.key`] : out[`present.${i}.encoder.key`];
      newPast[`past_key_values.${i}.encoder.value`] = useCacheBranch ? pastFeeds[`past_key_values.${i}.encoder.value`] : out[`present.${i}.encoder.value`];
    }
    pastFeeds = newPast;
    nextInputIds = [nextId];
    useCacheBranch = true;
  }

  // 타임스탬프 토큰 쌍으로 세그먼트를 나눈다: <ts0> text... <ts1> (<ts1> text... <ts2> ...).
  const segments = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] < timestampBegin) { i++; continue; }
    const startTs = (tokens[i] - timestampBegin) * 0.02;
    i++;
    const textIds = [];
    while (i < tokens.length && tokens[i] < timestampBegin) { textIds.push(tokens[i]); i++; }
    if (i < tokens.length) {
      const endTs = (tokens[i] - timestampBegin) * 0.02;
      i++;
      if (textIds.length) segments.push({ start: startTs, end: endTs, text: tokenizer.decode(textIds).trim() });
    } else if (textIds.length) {
      segments.push({ start: startTs, end: null, text: tokenizer.decode(textIds).trim() });
    }
  }
  return segments;
}

// 30초보다 긴 오디오는 30초 창으로 나눠 돌리고, 각 창의 세그먼트 시각에 창 시작
// 오프셋을 더해 이어 붙인다. 마지막 창이 짧아도(30초 미만) computeLogMelSpectrogram
// 이 0-패딩해 주니 그대로 넘기면 된다.
async function transcribe(pcmBuffer, jobId) {
  const pcm = new Float32Array(pcmBuffer);
  const windowSamples = N_SAMPLES;
  const totalChunks = Math.max(1, Math.ceil(pcm.length / windowSamples));
  const all = [];
  let chunkIndex = 0;
  for (let off = 0; off < pcm.length; off += windowSamples) {
    const chunk = pcm.subarray(off, Math.min(off + windowSamples, pcm.length));
    if (chunk.length < SAMPLE_RATE * 0.2) break;   // 0.2초 미만 꼬리는 버린다(의미 있는 소리 아님)
    chunkIndex++;
    self.postMessage({ type: 'CHUNK_START', jobId, chunkIndex, totalChunks });
    const mel = computeLogMelSpectrogram(chunk);
    const segs = await transcribeChunk(mel, { jobId, chunkIndex, totalChunks });
    const offsetSec = off / SAMPLE_RATE;
    for (const s of segs) all.push({ start: s.start + offsetSec, end: s.end == null ? null : s.end + offsetSec, text: s.text });
    self.postMessage({ type: 'PROGRESS', jobId, done: Math.min(off + windowSamples, pcm.length), total: pcm.length });
  }
  return all.filter((s) => s.text);
}
