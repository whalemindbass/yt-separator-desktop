'use strict';

/* ===================================================================
   Stem Worker — htdemucs_core.onnx 전용
   STFT/iSTFT는 Python 모델 대신 이 워커에서 직접 구현합니다.

   모델 I/O:
     입력  mag  [1, 4, 2048, 336]  — _spec + _magnitude(cac) 결과
     입력  mix  [1, 2, 343980]     — 원본 오디오 (시간 브랜치용)
     출력  x_freq [1, 4, 4, 2048, 336] — 주파수 브랜치 (iSTFT 전)
     출력  xt     [1, 4, 2, 343980]    — 시간 브랜치 오디오
   =================================================================== */

// ── htdemucs / htdemucs_6s 공통 상수 ──────────────────
const N_FFT   = 4096;
const HOP     = 1024;
const CHUNK   = 343980;
const FREQ    = 2048;    // N_FFT/2  (_spec이 마지막 빈 제거)
const FRAMES  = 336;     // ceil(CHUNK/HOP)
let   SOURCES = 4;       // 모델별 동적 (LOAD_MODEL 시 갱신)
const CH      = 2;       // 스테레오

// _spec 패딩 (htdemucs pad1d)
const LE    = Math.ceil(CHUNK / HOP);          // 336
const PADL  = (HOP >> 1) * 3;                  // 1536
const PADR  = PADL + LE * HOP - CHUNK;          // 1620
const CTR   = N_FFT >> 1;                       // 2048 (center pad for STFT)

// iSTFT 상수
const FRAMES_ISTFT = FRAMES + 4;                // 340 (양쪽 2프레임 zero pad)
const PAD_ISPEC    = (HOP >> 1) * 3;            // 1536
const CTR_ISTFT    = N_FFT >> 1;                // 2048 (center=True strip)
const UNSCALE      = Math.sqrt(N_FFT);          // STFT 정규화 역산

// ── SCNet 상수 (4-stem 신모델) ──────────────────────────
// 출처: elicwhite/scnet-web-wasm (MIT License). STFT/ISTFT/inference 로직 vendor.
// 모델: scnet_base.onnx, 4-source (drums, bass, other, vocals)
// SDR 10.51 dB (htdemucs 9.00 대비 +17%)
const SCNET_CHUNK     = 485100;                 // 11초 @ 44100Hz
const SCNET_PAD_FRAMES = 476;                   // 모델 frame 수
const SCNET_TARGET_LEN = (SCNET_PAD_FRAMES - 1) * HOP + N_FFT;  // = 489500
const SCNET_NFREQS    = (N_FFT >> 1) + 1;       // 2049 (htdemucs는 마지막 빈 제거해서 2048)
const SCNET_CROSSFADE = 2048;                    // 청크 경계 crossfade
const SCNET_SOURCES   = 4;                       // 고정 (drums, bass, other, vocals)

let modelType = 'htdemucs';                      // 'htdemucs' | 'scnet' — LOAD_MODEL 시 자동 감지

// Hann 창 (STFT/iSTFT 공용)
const HANN = (() => {
  const w = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++)
    w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT);
  return w;
})();

// ── Cooley-Tukey 기수-2 FFT (제자리) ─────────────────────────────────
// re, im: Float64Array, 길이는 2의 거듭제곱이어야 함
function fft(re, im) {
  const n = re.length;
  // 비트-반전 순열
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // 버터플라이
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wR = Math.cos(ang), wI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cR = 1.0, cI = 0.0;
      for (let j = 0; j < (len >> 1); j++) {
        const u = i + j, v = u + (len >> 1);
        const tR = cR * re[v] - cI * im[v];
        const tI = cR * im[v] + cI * re[v];
        re[v] = re[u] - tR;  im[v] = im[u] - tI;
        re[u] += tR;          im[u] += tI;
        const nCR = cR * wR - cI * wI;
        cI = cR * wI + cI * wR;
        cR = nCR;
      }
    }
  }
}

// ── 반사 패딩 ─────────────────────────────────────────────────────────
function reflectPad(src, padL, padR) {
  const L = src.length;
  const out = new Float32Array(L + padL + padR);
  out.set(src, padL);
  for (let i = 0; i < padL; i++)
    out[padL - 1 - i] = src[Math.min(i + 1, L - 1)];
  for (let i = 0; i < padR; i++)
    out[padL + L + i]  = src[Math.max(L - 2 - i, 0)];
  return out;
}

// ── STFT → mag [4, FREQ, FRAMES] ─────────────────────────────────────
// htdemucs._spec + _magnitude(cac=True)를 재현합니다.
// 채널 순서: [ch0_re, ch0_im, ch1_re, ch1_im] × freq × time
function computeMag(left, right) {
  const SCALE = 1.0 / Math.sqrt(N_FFT);
  const mag   = new Float32Array(4 * FREQ * FRAMES);
  const re    = new Float64Array(N_FFT);
  const im    = new Float64Array(N_FFT);

  for (let ch = 0; ch < CH; ch++) {
    // 1. htdemucs pad1d (반사, left=1536, right=1620)
    const raw    = ch === 0 ? left : right;
    const padded = reflectPad(raw, PADL, PADR);
    // 2. STFT center=True 패드 (N_FFT/2=2048 반사)
    const x = reflectPad(padded, CTR, CTR);
    // x.length = 351232

    // 3. 프레임 f=2..2+FRAMES-1 만 처리 (_spec의 z[..., 2:2+le])
    for (let f = 2; f < 2 + FRAMES; f++) {
      const start = f * HOP;
      for (let k = 0; k < N_FFT; k++) {
        re[k] = x[start + k] * HANN[k];
        im[k] = 0;
      }
      fft(re, im);
      const t = f - 2;
      for (let freq = 0; freq < FREQ; freq++) {
        const idx = freq * FRAMES + t;
        mag[(2 * ch)     * FREQ * FRAMES + idx] = re[freq] * SCALE;
        mag[(2 * ch + 1) * FREQ * FRAMES + idx] = im[freq] * SCALE;
      }
    }
  }
  return mag;
}

// ── iSTFT: x_freq_s + xt_s → [CH, CHUNK] ────────────────────────────
// htdemucs._mask(cac=True) + _ispec 를 재현합니다.
// x_freq_s: Float32Array[4 × FREQ × FRAMES]  채널 [ch0_re,ch0_im,ch1_re,ch1_im]
// xt_s    : Float32Array[CH × CHUNK]          채널 [ch0 | ch1]
function applyIspec(x_freq_s, xt_s) {
  const sigLen = (FRAMES_ISTFT - 1) * HOP + N_FFT;  // 351232
  const result = new Float32Array(CH * CHUNK);

  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);

  for (let ch = 0; ch < CH; ch++) {
    const reCh  = (2 * ch)     * FREQ * FRAMES;
    const imCh  = (2 * ch + 1) * FREQ * FRAMES;

    const signal = new Float64Array(sigLen);
    const winSum = new Float64Array(sigLen);

    for (let ft = 0; ft < FRAMES_ISTFT; ft++) {
      const origT = ft - 2;  // -2..337 (유효: 0..335)

      // N_FFT-점 복소 스펙트럼 구성 (켤레 대칭)
      for (let k = 0; k < N_FFT; k++) { re[k] = 0; im[k] = 0; }

      if (origT >= 0 && origT < FRAMES) {
        for (let freq = 0; freq < FREQ; freq++) {
          const srcIdx = freq * FRAMES + origT;
          const rV = x_freq_s[reCh + srcIdx] * UNSCALE;
          const iV = x_freq_s[imCh + srcIdx] * UNSCALE;
          re[freq] = rV;  im[freq] = iV;
          if (freq > 0) {
            re[N_FFT - freq] =  rV;
            im[N_FFT - freq] = -iV;
          }
        }
        // freq=FREQ=2048 (나이퀴스트): 0으로 유지 (_ispec의 freq 패딩)
      }

      // IFFT (켤레 → FFT → 켤레 → /N)
      for (let k = 0; k < N_FFT; k++) im[k] = -im[k];
      fft(re, im);
      const invN   = 1.0 / N_FFT;
      const fStart = ft * HOP;
      for (let k = 0; k < N_FFT; k++) {
        const w  = HANN[k];
        const xk = re[k] * invN;   // IFFT 실수 부분
        signal[fStart + k] += xk * w;
        winSum[fStart + k] += w * w;
      }
    }

    // OLA 정규화 + center=True 스트립 + _ispec 크롭 + 시간 브랜치 합산
    // center strip: CTR_ISTFT=2048 건너뜀
    // _ispec crop: [PAD_ISPEC : PAD_ISPEC+CHUNK] = [1536 : 345516]
    const base = CTR_ISTFT + PAD_ISPEC;
    for (let i = 0; i < CHUNK; i++) {
      const src = base + i;
      const v   = winSum[src] > 1e-8 ? signal[src] / winSum[src] : 0.0;
      result[ch * CHUNK + i] = v + xt_s[ch * CHUNK + i];
    }
  }
  return result;  // [CH * CHUNK]
}

// ── ORT 세션 ─────────────────────────────────────────────────────────
let ORT = null, session = null;
let cachedModelBuf = null;   // EP 변경 시 메인 thread에서 다시 받지 않고 재사용

self.addEventListener('message', async (e) => {
  switch (e.data.type) {
    case 'INIT':            await handleInit(e.data); break;
    case 'LOAD_MODEL':      await handleLoadModel(e.data); break;
    case 'PROCESS':         await handleProcess(e.data); break;
    case 'RELOAD_SESSION':  await handleReloadSession(e.data); break;
  }
});

async function handleReloadSession(data) {
  try {
    if (!cachedModelBuf) throw new Error('worker에 모델 캐시 없음 - LOAD_MODEL 필요');
    if (data.sources) SOURCES = data.sources;
    await createSession(cachedModelBuf, data.executionProvider);
    self.postMessage({ type: 'MODEL_OK' });
  } catch (err) {
    self.postMessage({ type: 'MODEL_ERROR', error: err.message });
  }
}

async function handleInit(data) {
  try {
    // ESM bundle - default export로 ort 노출 (1.22+)
    const mod = await import(data.runtimeUrl + 'lib/ort.webgpu.bundle.min.mjs');
    ORT = mod.default || mod;
    if (!ORT || !ORT.InferenceSession) throw new Error('ORT 모듈 로드 실패');
    ORT.env.wasm.wasmPaths = data.runtimeUrl + 'lib/';
    ORT.env.wasm.numThreads = typeof SharedArrayBuffer !== 'undefined'
      ? Math.min(navigator.hardwareConcurrency || 2, 4)
      : 1;
    self.postMessage({ type: 'INIT_OK' });
  } catch (err) {
    self.postMessage({ type: 'INIT_ERROR', error: err.message });
  }
}

async function handleLoadModel(data) {
  try {
    if (!ORT) throw new Error('ORT가 초기화되지 않았습니다.');

    // 모델별 SOURCES 결정 (4-stem: 4, 6-stem: 6)
    SOURCES = data.sources || 4;

    const bufSize = data.modelBuffer ? data.modelBuffer.byteLength : -1;
    // SCNet: ~44 MB, htdemucs 4-stem: ~166 MB, 6-stem: ~109 MB
    // 통일 threshold 30 MB (SCNet 수용)
    if (bufSize < 30 * 1024 * 1024) {
      throw new Error(
        `모델 버퍼 크기 이상: ${(bufSize / 1024 / 1024).toFixed(2)} MB ` +
        `(SOURCES=${SOURCES}). 캐시 삭제 후 재시도하세요.`
      );
    }

    const hdr = Array.from(new Uint8Array(data.modelBuffer, 0, 8))
      .map((b) => b.toString(16).padStart(2, '0')).join(' ');

    cachedModelBuf = data.modelBuffer;

    const actualEP = await createSession(data.modelBuffer, data.executionProvider);

    // modelType 자동 감지: SCNet은 input name 'spectrogram'으로 식별. 그 외는 htdemucs.
    const inputNames = session.inputNames || [];
    modelType = inputNames.includes('spectrogram') ? 'scnet' : 'htdemucs';

    self.postMessage({
      type: 'MODEL_DIAG',
      sizeMB: (bufSize / 1024 / 1024).toFixed(2),
      header: hdr,
      ep: actualEP,
      modelType,
      inputs: inputNames,
    });
    self.postMessage({ type: 'MODEL_OK' });
  } catch (err) {
    self.postMessage({ type: 'MODEL_ERROR', error: err.message });
  }
}

async function createSession(buf, requestedEP) {
  requestedEP = requestedEP || 'wasm';
  let actualEP = 'wasm';
  session = null;

  if (requestedEP === 'webgpu') {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      actualEP = 'wasm (navigator.gpu 없음)';
    } else {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('GPU 어댑터 획득 실패');
        session = await ORT.InferenceSession.create(buf, {
          executionProviders: ['webgpu'],
          graphOptimizationLevel: 'all',
        });
        actualEP = 'webgpu';
      } catch (e) {
        actualEP = 'wasm (webgpu 실패: ' + e.message + ')';
      }
    }
  }

  if (!session) {
    session = await ORT.InferenceSession.create(buf, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
    });
  }
  return actualEP;
}

// ── SCNet 전용 STFT/ISTFT (rectangular window, normalized=True) ─────────
// 출처: elicwhite/scnet-web-wasm/example/index.html (MIT)
// htdemucs와 다르게 윈도우 적용 없음, center=False (chunk 내부에서만)
function _fftScNet(reIn, imIn, N) {
  let j = 0;
  for (let i = 0; i < N - 1; i++) {
    if (i < j) {
      let tmp = reIn[i]; reIn[i] = reIn[j]; reIn[j] = tmp;
      tmp = imIn[i]; imIn[i] = imIn[j]; imIn[j] = tmp;
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let size = 2; size <= N; size *= 2) {
    const half = size / 2;
    const step = -2 * Math.PI / size;
    for (let i = 0; i < N; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const wr = Math.cos(angle), wi = Math.sin(angle);
        const idx1 = i + k, idx2 = i + k + half;
        const tr = wr * reIn[idx2] - wi * imIn[idx2];
        const ti = wr * imIn[idx2] + wi * reIn[idx2];
        reIn[idx2] = reIn[idx1] - tr;
        imIn[idx2] = imIn[idx1] - ti;
        reIn[idx1] += tr;
        imIn[idx1] += ti;
      }
    }
  }
}

function _ifftScNet(reIn, imIn, N) {
  for (let i = 0; i < N; i++) imIn[i] = -imIn[i];
  _fftScNet(reIn, imIn, N);
  for (let i = 0; i < N; i++) { reIn[i] /= N; imIn[i] = -imIn[i] / N; }
}

function _stftScNet(signal) {
  const nFft = N_FFT, hopSize = HOP;
  const nFreqs = SCNET_NFREQS;
  const nFrames = Math.floor((signal.length - nFft) / hopSize) + 1;
  const real = new Float32Array(nFreqs * nFrames);
  const imag = new Float32Array(nFreqs * nFrames);
  const scale = 1.0 / Math.sqrt(nFft);
  const re = new Float32Array(nFft), im = new Float32Array(nFft);
  for (let t = 0; t < nFrames; t++) {
    const off = t * hopSize;
    re.fill(0); im.fill(0);
    for (let n = 0; n < nFft; n++) re[n] = signal[off + n];
    _fftScNet(re, im, nFft);
    for (let k = 0; k < nFreqs; k++) {
      real[k * nFrames + t] = re[k] * scale;
      imag[k * nFrames + t] = im[k] * scale;
    }
  }
  return { real, imag, nFreqs, nFrames };
}

function _istftScNet(real, imag, nFreqs, nFrames) {
  const nFft = N_FFT, hopSize = HOP;
  const outLen = (nFrames - 1) * hopSize + nFft;
  const out = new Float32Array(outLen);
  const wSum = new Float32Array(outLen);
  const scale = 1.0 / Math.sqrt(nFft);
  const re = new Float32Array(nFft), im = new Float32Array(nFft);
  for (let t = 0; t < nFrames; t++) {
    const off = t * hopSize;
    re.fill(0); im.fill(0);
    for (let k = 0; k < nFreqs; k++) {
      re[k] = real[k * nFrames + t];
      im[k] = imag[k * nFrames + t];
    }
    // Hermitian symmetry 복원
    for (let k = 1; k < nFreqs - 1; k++) {
      re[nFft - k] = re[k];
      im[nFft - k] = -im[k];
    }
    _ifftScNet(re, im, nFft);
    for (let n = 0; n < nFft; n++) {
      out[off + n] += re[n] * scale * nFft;
      wSum[off + n] += 1;
    }
  }
  for (let i = 0; i < outLen; i++) if (wSum[i] > 0) out[i] /= wSum[i];
  return out;
}

// SCNet 처리 함수 (Python 원본 separate.py와 동일):
// 1) 전체 입력의 mono mean/std로 global normalize
// 2) 25% step (75% overlap)으로 청크 시작점 sweep
// 3) 각 청크: STFT → model → ISTFT → trim padding
// 4) Output 누적 + weight 누적 → 마지막에 평균 (균등 가중)
// 5) Denormalize (× std + mean)
async function _processScNet(left, right, totalSamples, stemOrder, onProgress) {
  const STEM_ORDER = ['drums', 'bass', 'other', 'vocals'];

  // ── Step 1: Global normalization (Python separate.py와 동일) ────
  // mono = (L + R) / 2 → mean/std 계산
  let mSum = 0, mSumSq = 0;
  for (let i = 0; i < totalSamples; i++) {
    const m = 0.5 * (left[i] + right[i]);
    mSum += m;
    mSumSq += m * m;
  }
  const monoMean = mSum / totalSamples;
  const monoVar = mSumSq / totalSamples - monoMean * monoMean;
  const monoStd = Math.sqrt(Math.max(monoVar, 0));
  const invStd = 1 / (monoStd + 1e-8);

  // 정규화된 입력 사본 (원본 보존)
  const normL = new Float32Array(totalSamples);
  const normR = new Float32Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    normL[i] = (left[i] - monoMean) * invStd;
    normR[i] = (right[i] - monoMean) * invStd;
  }
  console.log('[stem-worker] SCNet normalize: mean=' + monoMean.toFixed(4) + ' std=' + monoStd.toFixed(4));

  // ── Step 2: 청크 시작점 sweep (25% step = 75% overlap, Python num_overlap=4) ─
  const NUM_OVERLAP = 4;
  const stepSize = Math.floor(SCNET_CHUNK / NUM_OVERLAP);  // 121275
  const starts = [];
  for (let s = 0; s < totalSamples; s += stepSize) starts.push(s);

  // 출력 누적 + weight 누적
  const acc = STEM_ORDER.map(() => ({
    left:  new Float32Array(totalSamples),
    right: new Float32Array(totalSamples),
  }));
  const weight = new Float32Array(totalSamples);

  const padding = SCNET_TARGET_LEN - SCNET_CHUNK;

  for (let ci = 0; ci < starts.length; ci++) {
    const start = starts[ci];
    const thisChunkSize = Math.min(SCNET_CHUNK, totalSamples - start);

    // Pad chunk to SCNET_TARGET_LEN
    const lP = new Float32Array(SCNET_TARGET_LEN);
    const rP = new Float32Array(SCNET_TARGET_LEN);
    const copyLen = Math.min(SCNET_CHUNK, normL.length - start);
    for (let i = 0; i < copyLen; i++) {
      lP[i] = normL[start + i];
      rP[i] = normR[start + i];
    }

    // STFT
    const lStft = _stftScNet(lP);
    const rStft = _stftScNet(rP);
    const Fr = lStft.nFreqs, T = lStft.nFrames;

    // Pack model input [1, 4, Fr, T]
    const inputData = new Float32Array(4 * Fr * T);
    inputData.set(lStft.real, 0);
    inputData.set(lStft.imag, Fr * T);
    inputData.set(rStft.real, 2 * Fr * T);
    inputData.set(rStft.imag, 3 * Fr * T);
    const inputTensor = new ORT.Tensor('float32', inputData, [1, 4, Fr, T]);

    const inputName = session.inputNames[0];
    const feeds = {}; feeds[inputName] = inputTensor;
    const results = await session.run(feeds);
    const outputName = session.outputNames[0];
    const out = results[outputName].data;

    // Extract each source & overlap-add (균등 가중)
    for (let srcIdx = 0; srcIdx < SCNET_SOURCES; srcIdx++) {
      const base = srcIdx * 4 * Fr * T;
      const lReal = out.subarray(base, base + Fr * T);
      const lImag = out.subarray(base + Fr * T, base + 2 * Fr * T);
      const rReal = out.subarray(base + 2 * Fr * T, base + 3 * Fr * T);
      const rImag = out.subarray(base + 3 * Fr * T, base + 4 * Fr * T);
      const lAudio = _istftScNet(lReal, lImag, Fr, T);
      const rAudio = _istftScNet(rReal, rImag, Fr, T);
      const usableLen = lAudio.length - padding;
      const copyN = Math.min(thisChunkSize, usableLen);

      const aL = acc[srcIdx].left, aR = acc[srcIdx].right;
      for (let i = 0; i < copyN; i++) {
        aL[start + i] += lAudio[i];
        aR[start + i] += rAudio[i];
      }
    }
    // Weight 누적 (모든 source 공통 — output 위치별로 contributing chunk 수)
    const copyN = Math.min(thisChunkSize, SCNET_TARGET_LEN - padding);
    for (let i = 0; i < copyN; i++) weight[start + i] += 1.0;

    if (onProgress) onProgress((ci + 1) / starts.length);
  }

  // ── Step 4: 평균 + denormalize ────────────────────────────
  for (let srcIdx = 0; srcIdx < SCNET_SOURCES; srcIdx++) {
    const aL = acc[srcIdx].left, aR = acc[srcIdx].right;
    for (let i = 0; i < totalSamples; i++) {
      const w = Math.max(weight[i], 1.0);
      // Average → denormalize: × std + mean
      aL[i] = (aL[i] / w) * (monoStd + 1e-8) + monoMean;
      aR[i] = (aR[i] / w) * (monoStd + 1e-8) + monoMean;
    }
  }

  // 결과 매핑
  const stems = {};
  for (let i = 0; i < SCNET_SOURCES; i++) {
    stems[STEM_ORDER[i]] = [acc[i].left, acc[i].right];
  }
  return stems;
}

async function handleProcess(data) {
  try {
    if (!session) throw new Error('모델이 로드되지 않았습니다.');
    const { left, right, totalSamples, stemOrder } = data;

    // SCNet 모델이면 별도 파이프라인으로 분기 (rectangular STFT + 4-channel input + crossfade overlap-add)
    if (modelType === 'scnet') {
      const stems = await _processScNet(left, right, totalSamples, stemOrder,
        (ratio) => self.postMessage({ type: 'PROGRESS', value: ratio }));
      const transferables = [];
      Object.values(stems).forEach(([l, r]) => transferables.push(l.buffer, r.buffer));
      self.postMessage({ type: 'PROCESS_OK', stems }, transferables);
      return;
    }

    // 외부 청크-OLA 파라미터 (25% hop = 75% 오버랩) — htdemucs용
    // 더 많은 overlap = 청크 경계의 phase 불일치 완화 → 음량 변동 줄어듦
    // WebGPU 사용 시 처리 시간 부담 적음
    const hopSize   = Math.floor(CHUNK * 0.25);

    // ── FIX: 곡 앞뒤에 zero-padding (CHUNK-hopSize) 추가 ──
    // 이전 구조는 곡 시작/끝 부분에서 청크가 4개 겹치지 않아 (2~3개만) OLA norm이 정상값보다
    // 훨씬 작음 → NORM_AMP_CAP 걸려도 여전히 amplification → 원본에 없던 피크·노이즈 발생.
    // padding = CHUNK - hopSize 만큼 앞뒤로 확장하면 곡 시작 첫 샘플부터 이미 4개 청크로 커버됨.
    // 최종 output에서 padding 부분 trim.
    const PAD = CHUNK - hopSize;
    const paddedLen = totalSamples + 2 * PAD;
    const numChunks = Math.max(1, Math.ceil((paddedLen - (CHUNK - hopSize)) / hopSize));

    const outLeft  = Array.from({ length: SOURCES }, () => new Float32Array(paddedLen));
    const outRight = Array.from({ length: SOURCES }, () => new Float32Array(paddedLen));
    const norm     = Array.from({ length: SOURCES }, () => new Float32Array(paddedLen));
    const outerWin = buildOuterHann(CHUNK);

    for (let ci = 0; ci < numChunks; ci++) {
      const cStart    = ci * hopSize;
      const cEnd      = Math.min(cStart + CHUNK, paddedLen);
      const actualLen = cEnd - cStart;

      // 원본 인덱스로 매핑: cStart - PAD (음수/초과는 0-fill)
      const chunkL = new Float32Array(CHUNK);
      const chunkR = new Float32Array(CHUNK);
      for (let k = 0; k < actualLen; k++) {
        const srcIdx = cStart + k - PAD;
        if (srcIdx >= 0 && srcIdx < totalSamples) {
          chunkL[k] = left[srcIdx];
          chunkR[k] = right[srcIdx];
        }
      }

      // ① STFT → mag
      const mag = computeMag(chunkL, chunkR);   // [4 * FREQ * FRAMES]

      // ② ONNX 추론
      const mixData = new Float32Array(CH * CHUNK);
      mixData.set(chunkL, 0);
      mixData.set(chunkR, CHUNK);

      const results = await session.run({
        mag: new ORT.Tensor('float32', mag,     [1, CH * 2, FREQ, FRAMES]),
        mix: new ORT.Tensor('float32', mixData, [1, CH,     CHUNK]),
      });

      const xFreqFlat = results.x_freq.data;  // [1, SOURCES, CH*2, FREQ, FRAMES]
      const xtFlat    = results.xt.data;       // [1, SOURCES, CH, CHUNK]

      const freqSlice = CH * 2 * FREQ * FRAMES;   // per source
      const xtSlice   = CH * CHUNK;               // per source

      // ③ iSTFT + 시간 브랜치 합산 → 스템 오디오
      for (let s = 0; s < SOURCES; s++) {
        const xFreqS = xFreqFlat.subarray(s * freqSlice, (s + 1) * freqSlice);
        const xtS    = xtFlat.subarray(s * xtSlice, (s + 1) * xtSlice);
        const stemAudio = applyIspec(xFreqS, xtS);  // [CH * CHUNK]

        // ④ 외부 OLA (청크 경계 스무딩)
        for (let j = 0; j < actualLen; j++) {
          const w = outerWin[j];
          outLeft[s][cStart + j]  += stemAudio[j] * w;
          outRight[s][cStart + j] += stemAudio[CHUNK + j] * w;
          norm[s][cStart + j]     += w * w;
        }
      }

      self.postMessage({ type: 'PROGRESS', value: (ci + 1) / numChunks });
    }

    // OLA 정규화 — amplification cap 강화.
    // FIX (앞뒤 padding 추가 후): 이제 대부분 위치에서 norm ≈ 1.5~2 (정상). 그래도
    // 청크 boundary 근처는 여전히 낮을 수 있어 cap 유지.
    // NORM_AMP_CAP 0.07 → 0.15로 강화 (amplification 최대 6-7배로 제한).
    const NORM_SILENCE = 1e-4;
    const NORM_AMP_CAP = 0.15;
    for (let s = 0; s < SOURCES; s++) {
      for (let j = 0; j < paddedLen; j++) {
        if (norm[s][j] < NORM_SILENCE) {
          outLeft[s][j]  = 0;
          outRight[s][j] = 0;
        } else {
          const eff = norm[s][j] < NORM_AMP_CAP ? NORM_AMP_CAP : norm[s][j];
          outLeft[s][j]  /= eff;
          outRight[s][j] /= eff;
        }
      }
    }

    // Padding 부분 trim + 최종 safety hard clip [-1, 1]
    // 클리핑되면 원본 정보 손실이지만 이 시점의 |x| > 1은 이미 아티팩트(원본에 없던 스파이크)이므로
    // 클리핑이 정상 output 손상은 아님. Soft clip(tanh)도 옵션이지만 사용자가 clean output 원하면 hard가 나음.
    const trimmedStems = {};
    for (let s = 0; s < SOURCES; s++) {
      const tL = new Float32Array(totalSamples);
      const tR = new Float32Array(totalSamples);
      for (let j = 0; j < totalSamples; j++) {
        let vL = outLeft[s][j + PAD];
        let vR = outRight[s][j + PAD];
        if (vL >  1) vL =  1; else if (vL < -1) vL = -1;
        if (vR >  1) vR =  1; else if (vR < -1) vR = -1;
        tL[j] = vL;
        tR[j] = vR;
      }
      trimmedStems[s] = [tL, tR];
    }

    // 스템 이름 매핑
    const stems = {};
    stemOrder.forEach((name, idx) => {
      stems[name] = trimmedStems[idx];
    });

    const transferables = [];
    Object.values(stems).forEach(([l, r]) => transferables.push(l.buffer, r.buffer));
    self.postMessage({ type: 'PROCESS_OK', stems }, transferables);

  } catch (err) {
    self.postMessage({ type: 'PROCESS_ERROR', error: err.message + '\n' + (err.stack || '') });
  }
}

// 외부 OLA용 Hann 창 (청크 경계 스무딩)
function buildOuterHann(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++)
    w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1));
  return w;
}
