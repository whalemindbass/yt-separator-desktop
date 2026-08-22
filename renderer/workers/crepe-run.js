'use strict';
// CREPE(marl/crepe, MIT) ONNX 로 프레임별 피치 살리언스를 뽑는다. bp-run.js 와 같은 패턴
// (세션 준비 → 창 단위 추론). 모델은 renderer/models/crepe-full.onnx 에 동봉
// (출처는 같은 폴더 NOTICE.md). tab-core.js 의 transcribeCrepe() 는 이 결과(360bin 살리언스
// 배열)를 받기만 하는 순수 함수라 — 이 파일이 실제 ONNX/네트워크를 다루는 유일한 곳이다.

let _ort = null;
let _session = null;
let _sessionCapacity = null;
let _sessionEP = null;

// capacity 별 배치=64 WASM 실측(CPU 전용 · numThreads=1):
//   tiny(2MB)  세션생성 0.2초 · 배치 0.3초    full(85MB) 세션생성 0.0초 · 배치 5.4초 (17배)
// tiny 는 빠르지만 베이스 저음역(E1 41Hz)에서 못 쓴다 — 공식 파이썬 구현(crepe.predict,
// model_capacity='tiny')으로 검증: 같은 합성 베이스 E1 구간에서 confidence 0.1~0.3 에
// 검출 Hz 가 287Hz(엉뚱한 배음)로 튐. full 은 같은 구간 confidence 0.87~0.93 에 41.2~41.4Hz
// 로 정확하다. 그래서 기본은 느리더라도 full 을 쓴다.
//
// full 이 WASM(CPU)에서 배치당 5.4초라 210초 곡 하나에 10분 넘게 걸리는 데다, 오프스크린
// lab 하네스(offscreen:true) 안에서는 Chromium 이 백그라운드 창으로 보고 스케줄링을 깎아
// 그 몇 배로 늘어지기도 한다(sepattack 처럼 짧은 연산에선 안 드러나던 문제). separator.js/
// stem-worker.js 가 이미 htdemucs 분리에 쓰는 것과 같은 방식으로 WebGPU 를 먼저 시도하고,
// 어댑터가 없거나 세션 생성이 실패하면 WASM 으로 자동 되돌아간다.
async function ensureSession(baseUrl, capacity = 'full', preferGpu = true) {
  if (_session && _sessionCapacity === capacity) return { session: _session, ep: _sessionEP };
  const mod = await import(baseUrl + 'lib/ort.webgpu.bundle.min.mjs');
  _ort = mod.default || mod;
  if (!_ort || !_ort.InferenceSession) throw new Error('ORT 로드 실패');
  _ort.env.wasm.wasmPaths = baseUrl + 'lib/';
  _ort.env.wasm.numThreads = 1;
  const buf = await (await fetch(baseUrl + `models/crepe-${capacity}.onnx`)).arrayBuffer();

  let session = null, ep = 'wasm';
  if (preferGpu) {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      ep = 'wasm (navigator.gpu 없음)';
    } else {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error('GPU 어댑터 획득 실패');
        session = await _ort.InferenceSession.create(buf, {
          executionProviders: ['webgpu'], graphOptimizationLevel: 'all',
        });
        ep = 'webgpu';
      } catch (e) {
        ep = 'wasm (webgpu 실패: ' + e.message + ')';
      }
    }
  }
  if (!session) {
    session = await _ort.InferenceSession.create(buf, {
      executionProviders: ['wasm'], graphOptimizationLevel: 'all',
    });
  }

  _session = session; _sessionCapacity = capacity; _sessionEP = ep;
  return { session, ep };
}

const MODEL_SR = 16000;
const FRAME = 1024;

/** 선형보간 리샘플 — CREPE 는 정확히 16kHz 를 기대한다(2배 데시메이션으로는 안 떨어진다). */
function resampleLinear(mono, srcSr, dstSr) {
  if (srcSr === dstSr) return mono;
  const n = Math.max(1, Math.round(mono.length * dstSr / srcSr));
  const out = new Float32Array(n);
  const ratio = (mono.length - 1) / Math.max(1, n - 1);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos), i1 = Math.min(mono.length - 1, i0 + 1);
    const t = pos - i0;
    out[i] = mono[i0] * (1 - t) + mono[i1] * t;
  }
  return out;
}

// 프레임 하나씩 session.run() 을 부르면(초기 버전) 73초 곡 하나에 7000번 넘게 WASM 을
// 넘나든다 — 그 호출 오버헤드가 실제 연산보다 커서 비현실적으로 느렸다. marl/crepe 의
// 파이썬 구현도 model.predict(frames, ...) 로 한 번에 배치를 돌린다 — ONNX 로 내보낼 때
// 배치 축을 동적(None)으로 뒀으므로(crepe_to_onnx.py) 여기서도 여러 프레임을 한 번에
// 넣을 수 있다. BATCH 개씩 묶어서 부른다.
const BATCH = 64;

/**
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {string} baseUrl renderer/ 의 URL (끝에 /)
 * @param {number} [hopMs] 프레임 간격 — marl/crepe 기본값과 같은 10ms
 * @param {(pct:number)=>void} [onProgress]
 * @param {string} [capacity] 'tiny'|'small'|'medium'|'large'|'full' — renderer/models/crepe-<capacity>.onnx
 * @param {boolean} [preferGpu] WebGPU 를 먼저 시도할지 — 실패하면 WASM 으로 자동 전환
 * @returns {Promise<{ frames: Float32Array[], hopSec: number, ep: string }>}
 */
export async function runCrepe(mono, sampleRate, baseUrl, hopMs = 10, onProgress, capacity = 'full', preferGpu = true) {
  const { session, ep } = await ensureSession(baseUrl, capacity, preferGpu);
  const sig = resampleLinear(mono, sampleRate, MODEL_SR);

  // marl/crepe 의 get_activation(center=True) 과 같다 — 첫 프레임이 시각 0 에 중심이 오도록
  // 앞뒤에 FRAME/2 만큼 0을 덧댄다.
  const padded = new Float32Array(FRAME / 2 + sig.length + FRAME / 2);
  padded.set(sig, FRAME / 2);

  const hop = Math.round(MODEL_SR * hopMs / 1000);
  const n = Math.max(0, 1 + Math.floor((padded.length - FRAME) / hop));
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const frames = new Array(n);

  for (let base = 0; base < n; base += BATCH) {
    const b = Math.min(BATCH, n - base);
    const batch = new Float32Array(b * FRAME);
    for (let k = 0; k < b; k++) {
      const off = (base + k) * hop;
      const win = padded.subarray(off, off + FRAME);
      // 프레임별 정규화(평균 0·표준편차 1) — crepe.core.get_activation 과 동일. 모델이 이
      // 정규화를 전제로 학습돼 있어 생략하면 살리언스가 무너진다.
      let mean = 0;
      for (let j = 0; j < FRAME; j++) mean += win[j];
      mean /= FRAME;
      let variance = 0;
      for (let j = 0; j < FRAME; j++) { const d = win[j] - mean; variance += d * d; }
      const std = Math.max(1e-8, Math.sqrt(variance / FRAME));
      const rowOff = k * FRAME;
      for (let j = 0; j < FRAME; j++) batch[rowOff + j] = (win[j] - mean) / std;
    }

    const feed = {};
    feed[inputName] = new _ort.Tensor('float32', batch, [b, FRAME]);
    const res = await session.run(feed);
    const out = res[outputName].data;   // [b, 360] 이어붙은 배열
    for (let k = 0; k < b; k++) frames[base + k] = new Float32Array(out.subarray(k * 360, (k + 1) * 360));

    if (onProgress) onProgress(Math.floor(Math.min(n, base + b) / n * 100));
  }

  return { frames, hopSec: hop / MODEL_SR, ep };
}
