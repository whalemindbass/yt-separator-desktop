'use strict';
// Stem separation orchestration:
//   1) model bytes (main IPC) → worker LOAD_MODEL
//   2) mp4 → audio 추출 (main IPC, ffmpeg)
//   3) worker PROCESS → PROGRESS/PROCESS_OK
//   4) 결과 stems를 main에 저장 요청

const api = window.yssApi;

let worker = null;
let modelReady = false;
let usedProvider = null; // 로드 완료 후 실제 사용된 provider
let currentModelKey = null;
let currentModelInfo = null;   // { sources, stems }

/**
 * WebGPU 실제 사용 가능한지 확인.
 * navigator.gpu 존재 + adapter request 성공까지.
 */
async function detectWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return !!adapter;
  } catch { return false; }
}

/**
 * 사용자 선호도(localStorage) + 실제 가능성을 종합해 provider 결정.
 * 반환: 'webgpu' | 'wasm'
 */
async function pickProvider() {
  const pref = (localStorage.getItem('executionProvider') || 'auto').toLowerCase();
  if (pref === 'wasm') return 'wasm';
  if (pref === 'webgpu') return (await detectWebGPU()) ? 'webgpu' : 'wasm'; // 요청했지만 없으면 fallback
  // auto
  return (await detectWebGPU()) ? 'webgpu' : 'wasm';
}

export function getUsedProvider() { return usedProvider; }

let cancelRequested = false;
const pendingRejects = new Set();   // worker 메시지 응답 대기 중인 Promise reject 콜백들
export function cancelSeparation() {
  cancelRequested = true;
  if (worker) { try { worker.terminate(); } catch {} worker = null; modelReady = false; usedProvider = null; }
  // 대기 중인 모든 promise 를 즉시 reject → separatePipeline catch 로 흐름 반환
  for (const rej of pendingRejects) { try { rej(new Error('취소됨')); } catch {} }
  pendingRejects.clear();
}
export function isCancelled() { return cancelRequested; }
function resetCancelFlag() { cancelRequested = false; pendingRejects.clear(); }
export async function probeProviders() {
  return {
    webgpuAvailable: await detectWebGPU(),
    preference: (localStorage.getItem('executionProvider') || 'auto').toLowerCase(),
  };
}
export function setProviderPreference(v) {
  if (['auto', 'webgpu', 'wasm'].includes(v)) {
    localStorage.setItem('executionProvider', v);
    // 프리셋 변경 시 다음 처리에서 재로드 필요
    if (worker) { try { worker.terminate(); } catch {} worker = null; modelReady = false; usedProvider = null; }
  }
}

function ensureWorker(onProgress) {
  if (worker) return worker;
  // module worker — Electron file:// 지원
  worker = new Worker(new URL('../workers/stem-worker.js', import.meta.url), { type: 'module' });
  return worker;
}

async function initWorker() {
  await new Promise((resolve, reject) => {
    pendingRejects.add(reject);
    const done = (fn, val) => { pendingRejects.delete(reject); worker?.removeEventListener('message', onMsg); fn(val); };
    const onMsg = (e) => {
      const d = e.data;
      if (d.type === 'INIT_OK')    done(resolve);
      if (d.type === 'INIT_ERROR') done(reject, new Error(d.error));
    };
    worker.addEventListener('message', onMsg);
    worker.addEventListener('error', (e) => done(reject, new Error(e.message || 'worker error')));
    const runtimeUrl = new URL('../', import.meta.url).href;
    worker.postMessage({ type: 'INIT', runtimeUrl });
  });
}

async function loadModelWith(provider, modelKey) {
  const res = await api.stem.modelBytes(modelKey);
  if (!res.ok) {
    const err = new Error(res.error);
    err.needDownload = res.needDownload;
    err.modelKey = modelKey;
    throw err;
  }
  const sources = res.sources || 4;
  currentModelInfo = { sources, stems: res.stems };
  await new Promise((resolve, reject) => {
    pendingRejects.add(reject);
    const done = (fn, val) => { pendingRejects.delete(reject); worker?.removeEventListener('message', onMsg); fn(val); };
    const onMsg = (e) => {
      const d = e.data;
      if (d.type === 'MODEL_OK')    { modelReady = true; usedProvider = d.ep || provider; done(resolve); }
      if (d.type === 'MODEL_ERROR') done(reject, new Error(d.error));
      if (d.type === 'MODEL_DIAG')  { usedProvider = d.ep || provider; console.log('[stem] diag:', JSON.stringify(d)); }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage(
      { type: 'LOAD_MODEL', modelBuffer: res.bytes, executionProvider: provider, sources },
      [res.bytes]
    );
  });
  currentModelKey = modelKey;
}

async function loadModel(modelKey) {
  if (modelReady && currentModelKey === modelKey) return;
  if (modelReady && currentModelKey !== modelKey) {
    // 모델 전환 — 워커 리셋
    try { worker.terminate(); } catch {}
    worker = null; modelReady = false;
    ensureWorker(); await initWorker();
  }
  const provider = await pickProvider();
  await loadModelWith(provider, modelKey);
}

// 기본 STEM_ORDER — 실제 값은 현재 모델에 따라 동적
let STEM_ORDER = ['drums', 'bass', 'other', 'vocals'];

async function process(left, right, totalSamples, onProgress) {
  return await new Promise((resolve, reject) => {
    pendingRejects.add(reject);
    const done = (fn, val) => { pendingRejects.delete(reject); worker?.removeEventListener('message', onMsg); fn(val); };
    const onMsg = (e) => {
      const d = e.data;
      if (d.type === 'PROGRESS')      { onProgress?.(d.value); return; }
      if (d.type === 'PROCESS_OK')    { done(resolve, d.stems); return; }
      if (d.type === 'PROCESS_ERROR') { done(reject, new Error(d.error)); return; }
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage(
      { type: 'PROCESS', left, right, totalSamples, stemOrder: STEM_ORDER },
      [left.buffer, right.buffer]
    );
  });
}

/**
 * 전체 파이프라인.
 * @param {string} videoPath - 다운로드된 mp4 경로
 * @param {string} baseName - 파일 base (예: "IU-through the night-a3b7")
 * @param {(phase:string, ratio?:number, detail?:string)=>void} onStep
 */
function peakOf(arr) {
  if (!arr || !arr.length) return 'empty';
  let p = 0, nan = 0;
  const step = Math.max(1, Math.floor(arr.length / 200000));
  for (let i = 0; i < arr.length; i += step) {
    const v = arr[i];
    if (Number.isNaN(v)) nan++;
    else { const a = Math.abs(v); if (a > p) p = a; }
  }
  return `peak=${p.toFixed(4)}${nan ? ` NaN_hits=${nan}` : ''}`;
}

export async function separatePipeline(videoPath, baseName, onStep, opts = {}) {
  resetCancelFlag();
  const throwIfCancel = () => { if (cancelRequested) throw new Error('취소됨'); };
  const modelKey = opts.modelKey || '4stem';
  onStep?.('init', 0.02, '워커 초기화');
  ensureWorker();
  await initWorker();
  throwIfCancel();

  onStep?.('model', 0.05, `${modelKey === '6stem' ? '6-stem' : '4-stem'} 모델 로드`);
  await loadModel(modelKey);
  STEM_ORDER = currentModelInfo?.stems || STEM_ORDER;

  onStep?.('extract', 0.10, '오디오 추출 (ffmpeg)');
  const ex = await api.stem.extractAudio(videoPath);
  if (!ex.ok) throw new Error(ex.error);

  // ArrayBuffer → Float32Array
  const left  = new Float32Array(ex.left);
  const right = new Float32Array(ex.right);
  console.log(`[sep] extract done: samples=${left.length} sr=${ex.sampleRate} L_${peakOf(left)} R_${peakOf(right)}`);

  onStep?.('separate', 0.15, '스템 분리 시작');
  let stems = await process(left, right, ex.totalSamples, (r) => {
    onStep?.('separate', 0.15 + r * 0.75, '스템 분리 중');
  });

  // 워커 반환 확인 + NaN 감지
  let nanFound = false;
  for (const [n, arr] of Object.entries(stems)) {
    if (Array.isArray(arr) && arr[0] && arr[1]) {
      const info = peakOf(arr[0]);
      console.log(`[sep] worker "${n}": L(len=${arr[0].length} ${info}) R(len=${arr[1].length} ${peakOf(arr[1])})`);
      if (info.includes('NaN')) nanFound = true;
    } else {
      console.warn(`[sep] worker "${n}": unexpected shape`, arr);
    }
  }

  // WebGPU NaN → WASM으로 자동 재시도
  if (nanFound && usedProvider === 'webgpu') {
    console.warn('[sep] WebGPU output has NaN — WASM으로 재시도');
    onStep?.('separate', 0.15, 'WebGPU 실패 감지, CPU로 재시도 중…');
    // 워커 리셋 + WASM 재로드
    if (worker) { try { worker.terminate(); } catch {} worker = null; modelReady = false; }
    ensureWorker();
    await initWorker();
    await loadModelWith('wasm', modelKey);
    // 원본 left/right는 process()에서 transfer됨 → 다시 추출
    const ex2 = await api.stem.extractAudio(videoPath);
    if (!ex2.ok) throw new Error(ex2.error);
    const left2  = new Float32Array(ex2.left);
    const right2 = new Float32Array(ex2.right);
    stems = await process(left2, right2, ex2.totalSamples, (r) => {
      onStep?.('separate', 0.15 + r * 0.75, 'CPU 분리 중 (WebGPU 실패)');
    });
    for (const [n, arr] of Object.entries(stems)) {
      console.log(`[sep] wasm-retry "${n}": L(len=${arr[0].length} ${peakOf(arr[0])})`);
    }
    // 이후 이 세션에서는 WASM 우선
    localStorage.setItem('executionProvider', 'wasm');
    localStorage.setItem('webgpuBlocked', '1');
  }

  onStep?.('save', 0.95, 'WAV 저장');
  // 재생용으로 원본 Float32Array 유지하기 위해 저장 전 복사본을 IPC로 전송
  const payload = {};
  for (const [name, [L, R]] of Object.entries(stems)) {
    // 저장용 사본 (main IPC로 transfer됨)
    const Lc = new Float32Array(L);
    const Rc = new Float32Array(R);
    console.log(`[sep] payload "${name}" copy: L(${peakOf(Lc)}) R(${peakOf(Rc)}) bufBytes=${Lc.buffer.byteLength}`);
    payload[name] = [Lc.buffer, Rc.buffer];
  }
  const save = await api.stem.saveStems(payload, baseName, ex.sampleRate || 44100);
  if (!save.ok) throw new Error(save.error);
  if (save.dbg) save.dbg.forEach(line => console.log('[main:save]', line));

  onStep?.('done', 1, '완료');
  return {
    stemPaths: save.stemPaths,
    outDir: save.outDir,
    stems,                          // 원본 Float32Array (재생용 in-memory)
    sampleRate: ex.sampleRate || 44100,
  };
}
