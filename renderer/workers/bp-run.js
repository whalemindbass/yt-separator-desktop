'use strict';
// basic-pitch(ONNX) 로 노트를 뽑는다. 자체 YIN 결과를 교차 확인하는 용도.
// 모델은 renderer/models/basic-pitch.onnx 에 동봉 (Apache-2.0, 출처는 같은 폴더 NOTICE.md).

import { outputToNotes, toNotes, Mat,
         AUDIO_N_SAMPLES, HOP_SIZE, OVERLAP_LEN, N_OVERLAPPING_FRAMES } from './bp-notes.js';

let _ort = null;
let _session = null;

async function ensureSession(baseUrl) {
  if (_session) return _session;
  const mod = await import(baseUrl + 'lib/ort.webgpu.bundle.min.mjs');
  _ort = mod.default || mod;
  if (!_ort || !_ort.InferenceSession) throw new Error('ORT 로드 실패');
  _ort.env.wasm.wasmPaths = baseUrl + 'lib/';
  _ort.env.wasm.numThreads = 1;
  const buf = await (await fetch(baseUrl + 'models/basic-pitch.onnx')).arrayBuffer();
  _session = await _ort.InferenceSession.create(buf, {
    executionProviders: ['wasm'], graphOptimizationLevel: 'all',
  });
  return _session;
}

/** 44.1k/48k → 22.05k 근처로 (2배 데시메이션 반복) */
function toModelRate(mono, sampleRate) {
  let sig = mono, sr = sampleRate;
  while (sr > 30000) {
    const n = (sig.length - 3) >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const j = i * 2; out[i] = (sig[j] + 3 * sig[j + 1] + 3 * sig[j + 2] + sig[j + 3]) / 8; }
    sig = out; sr /= 2;
  }
  return { sig, sr };
}

/**
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {string} baseUrl renderer/ 의 URL (끝에 /)
 * @param {(pct:number)=>void} [onProgress]
 * @returns {Promise<Array>} { start, dur, midi, conf } 목록 (베이스 음역·단음)
 */
export async function runBasicPitch(mono, sampleRate, baseUrl, onProgress) {
  const session = await ensureSession(baseUrl);
  const { sig } = toModelRate(mono, sampleRate);

  // 원본과 같은 창 나누기: 앞에 overlap/2 만큼 0 을 덧대고 HOP_SIZE 로 이동
  const padded = new Float32Array(OVERLAP_LEN / 2 + sig.length);
  padded.set(sig, OVERLAP_LEN / 2);

  const nOlap = N_OVERLAPPING_FRAMES / 2;
  const frameRows = [], onsetRows = [];
  const total = Math.ceil(padded.length / HOP_SIZE);
  let done = 0;

  for (let off = 0; off < padded.length; off += HOP_SIZE) {
    const win = new Float32Array(AUDIO_N_SAMPLES);
    win.set(padded.subarray(off, Math.min(padded.length, off + AUDIO_N_SAMPLES)));
    const feed = {};
    feed[session.inputNames[0]] = new _ort.Tensor('float32', win, [1, AUDIO_N_SAMPLES, 1]);
    const res = await session.run(feed);
    const two = session.outputNames.map(k => res[k]).filter(t => t.dims[2] === 88);
    const [note, onset] = two;                    // :2 = note, :1 = onset
    const T = note.dims[1];
    for (let f = nOlap; f < T - nOlap; f++) {
      const fr = new Float32Array(88), on = new Float32Array(88);
      for (let c = 0; c < 88; c++) { fr[c] = note.data[f * 88 + c]; on[c] = onset.data[f * 88 + c]; }
      frameRows.push(fr); onsetRows.push(on);
    }
    done++;
    if (onProgress) onProgress(Math.min(99, Math.floor(done / total * 100)));
  }

  const T = frameRows.length;
  if (!T) return [];
  const fm = new Mat(new Float32Array(T * 88), T, 88);
  const om = new Mat(new Float32Array(T * 88), T, 88);
  for (let r = 0; r < T; r++) for (let c = 0; c < 88; c++) { fm.set(r, c, frameRows[r][c]); om.set(r, c, onsetRows[r][c]); }

  // 베이스 음역(E1~E4)으로 제한 — 그 위는 다른 악기가 새어 든 것으로 본다
  const events = outputToNotes(fm, om, { minFreq: 38, maxFreq: 340, minNoteLen: 11 });
  const cand = toNotes(events).sort((a, b) => a.start - b.start || a.midi - b.midi);

  // 단음화 — 겹치면 낮은 음을 남긴다
  const out = [];
  for (const n of cand) {
    const prev = out[out.length - 1];
    if (prev && n.start < prev.start + prev.dur - 0.02) {
      if (n.midi < prev.midi) { prev.dur = Math.max(0.05, n.start - prev.start); out.push({ ...n }); }
      else prev.dur = Math.max(prev.dur, (n.start + n.dur) - prev.start);
    } else out.push({ ...n });
  }
  if (onProgress) onProgress(100);
  return out;
}

/**
 * 두 검출 결과를 대조해 각 음에 합의 여부를 표시한다.
 * 노트를 더하거나 빼지 않는다 — 재현율을 건드리지 않고 신뢰도만 붙인다.
 */
export function markAgreement(notes, other, tol = 0.18) {
  let j = 0;
  return notes.map(n => {
    while (j < other.length && other[j].start < n.start - tol - 1) j++;
    let agree = false;
    for (let k = j; k < other.length; k++) {
      const o = other[k];
      if (o.start > n.start + tol) break;
      // 시작이 비슷하거나 구간이 겹치고, 음정이 같으면 합의
      const overlap = Math.min(n.start + n.dur, o.start + o.dur) - Math.max(n.start, o.start);
      if (o.midi === n.midi && (Math.abs(o.start - n.start) <= tol || overlap > 0.05)) { agree = true; break; }
    }
    return { ...n, agree };
  });
}
