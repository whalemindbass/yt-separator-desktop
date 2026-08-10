'use strict';
// basic-pitch (Spotify, Apache-2.0) 모델 출력 → 노트 이벤트.
// 원본 note_creation.py 의 output_to_notes_polyphonic 을 그대로 옮긴 것.
// 파라미터 이름과 기본값을 원본과 맞춰, 나중에 원본과 대조하기 쉽게 둔다.

export const MIDI_OFFSET = 21;      // 빈 0 = A0
export const MAX_FREQ_IDX = 87;
export const FFT_HOP = 256;
export const AUDIO_SAMPLE_RATE = 22050;
export const ANNOTATIONS_FPS = AUDIO_SAMPLE_RATE / FFT_HOP;   // 86.13
export const AUDIO_N_SAMPLES = AUDIO_SAMPLE_RATE * 2 - FFT_HOP;
export const N_OVERLAPPING_FRAMES = 30;
export const OVERLAP_LEN = N_OVERLAPPING_FRAMES * FFT_HOP;
export const HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LEN;

export const BP_DEFAULTS = {
  onsetThresh: 0.5,
  frameThresh: 0.3,
  minNoteLen: 11,        // 프레임 (약 128ms)
  inferOnsets: true,
  melodiaTrick: true,
  energyTol: 11,
  minFreq: null,
  maxFreq: null,
};

/** (T,88) 2차원 뷰 — Float32Array 를 행/열로 다룬다 */
class Mat {
  constructor(data, rows, cols) { this.d = data; this.rows = rows; this.cols = cols; }
  get(r, c) { return this.d[r * this.cols + c]; }
  set(r, c, v) { this.d[r * this.cols + c] = v; }
  static zerosLike(m) { return new Mat(new Float32Array(m.d.length), m.rows, m.cols); }
  clone() { return new Mat(Float32Array.from(this.d), this.rows, this.cols); }
}
export { Mat };

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** min/max 주파수 밖의 빈을 0 으로 */
function constrainFrequency(onsets, frames, maxFreq, minFreq) {
  if (maxFreq != null) {
    const maxIdx = Math.round(hzToMidiRound(maxFreq) - MIDI_OFFSET);
    for (let r = 0; r < frames.rows; r++)
      for (let c = Math.max(0, maxIdx); c < frames.cols; c++) { onsets.set(r, c, 0); frames.set(r, c, 0); }
  }
  if (minFreq != null) {
    const minIdx = Math.round(hzToMidiRound(minFreq) - MIDI_OFFSET);
    for (let r = 0; r < frames.rows; r++)
      for (let c = 0; c < Math.min(frames.cols, minIdx); c++) { onsets.set(r, c, 0); frames.set(r, c, 0); }
  }
}
const hzToMidiRound = (hz) => 69 + 12 * Math.log2(hz / 440);

/** 프레임 활성의 급상승을 온셋으로 추가 (원본 get_infered_onsets) */
function inferOnsets(onsets, frames, nDiff = 2) {
  const { rows, cols } = frames;
  const diffMin = new Float32Array(rows * cols);
  diffMin.fill(Infinity);
  for (let n = 1; n <= nDiff; n++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const prev = r - n >= 0 ? frames.get(r - n, c) : 0;
        const v = frames.get(r, c) - prev;
        const i = r * cols + c;
        if (v < diffMin[i]) diffMin[i] = v;
      }
    }
  }
  let maxDiff = 0, maxOnset = 0;
  for (let i = 0; i < diffMin.length; i++) { if (diffMin[i] < 0) diffMin[i] = 0; if (diffMin[i] > maxDiff) maxDiff = diffMin[i]; }
  for (let r = 0; r < nDiff; r++) for (let c = 0; c < cols; c++) diffMin[r * cols + c] = 0;
  for (let i = 0; i < onsets.d.length; i++) if (onsets.d[i] > maxOnset) maxOnset = onsets.d[i];

  const out = new Mat(new Float32Array(rows * cols), rows, cols);
  const scale = maxDiff > 0 ? maxOnset / maxDiff : 0;
  for (let i = 0; i < out.d.length; i++) out.d[i] = Math.max(onsets.d[i], diffMin[i] * scale);
  return out;
}

/**
 * 모델 출력 → 노트 이벤트.
 * @param {Mat} framesIn (T,88) note 활성
 * @param {Mat} onsetsIn (T,88) onset 활성
 * @returns {Array<{startFrame:number, endFrame:number, midi:number, amp:number}>}
 */
export function outputToNotes(framesIn, onsetsIn, options) {
  const o = { ...BP_DEFAULTS, ...(options || {}) };
  const frames = framesIn.clone();
  let onsets = onsetsIn.clone();
  const nFrames = frames.rows;

  constrainFrequency(onsets, frames, o.maxFreq, o.minFreq);
  if (o.inferOnsets) onsets = inferOnsets(onsets, frames);

  // 시간축 국소최대만 온셋 후보로 (원본 argrelmax)
  const peaks = [];
  for (let r = 1; r < nFrames - 1; r++) {
    for (let c = 0; c < onsets.cols; c++) {
      const v = onsets.get(r, c);
      if (v > onsets.get(r - 1, c) && v > onsets.get(r + 1, c) && v >= o.onsetThresh) peaks.push([r, c]);
    }
  }
  peaks.sort((a, b) => b[0] - a[0]);   // 뒤에서부터

  const remaining = frames.clone();
  const events = [];

  const clearBand = (r0, r1, c) => {
    for (let r = r0; r < r1; r++) {
      remaining.set(r, c, 0);
      if (c < MAX_FREQ_IDX) remaining.set(r, c + 1, 0);
      if (c > 0) remaining.set(r, c - 1, 0);
    }
  };

  for (const [startIdx, c] of peaks) {
    if (startIdx >= nFrames - 1) continue;
    let i = startIdx + 1, k = 0;
    while (i < nFrames - 1 && k < o.energyTol) {
      if (remaining.get(i, c) < o.frameThresh) k++; else k = 0;
      i++;
    }
    i -= k;
    if (i - startIdx <= o.minNoteLen) continue;

    let sum = 0;
    for (let r = startIdx; r < i; r++) sum += frames.get(r, c);
    clearBand(startIdx, i, c);
    events.push({ startFrame: startIdx, endFrame: i, midi: c + MIDI_OFFSET, amp: sum / (i - startIdx) });
  }

  // melodia trick — 온셋을 못 잡았지만 에너지가 남은 구간을 노트로 회수
  if (o.melodiaTrick) {
    for (;;) {
      let best = 0, bi = -1, bc = -1;
      for (let r = 0; r < nFrames; r++)
        for (let c = 0; c < remaining.cols; c++) {
          const v = remaining.get(r, c);
          if (v > best) { best = v; bi = r; bc = c; }
        }
      if (!(best > o.frameThresh)) break;
      remaining.set(bi, bc, 0);

      let i = bi + 1, k = 0;
      while (i < nFrames - 1 && k < o.energyTol) {
        if (remaining.get(i, bc) < o.frameThresh) k++; else k = 0;
        remaining.set(i, bc, 0);
        if (bc < MAX_FREQ_IDX) remaining.set(i, bc + 1, 0);
        if (bc > 0) remaining.set(i, bc - 1, 0);
        i++;
      }
      const iEnd = i - 1 - k;

      i = bi - 1; k = 0;
      while (i > 0 && k < o.energyTol) {
        if (remaining.get(i, bc) < o.frameThresh) k++; else k = 0;
        remaining.set(i, bc, 0);
        if (bc < MAX_FREQ_IDX) remaining.set(i, bc + 1, 0);
        if (bc > 0) remaining.set(i, bc - 1, 0);
        i--;
      }
      const iStart = i + 1 + k;
      if (iEnd - iStart <= o.minNoteLen) continue;

      let sum = 0;
      for (let r = iStart; r < iEnd; r++) sum += frames.get(r, bc);
      events.push({ startFrame: iStart, endFrame: iEnd, midi: bc + MIDI_OFFSET, amp: sum / Math.max(1, iEnd - iStart) });
    }
  }

  events.sort((a, b) => a.startFrame - b.startFrame);
  return events;
}

/** 프레임 인덱스를 초로. 원본과 같은 보정(모델 지연 반영)을 쓴다. */
export function framesToSeconds(f) {
  return f * FFT_HOP / AUDIO_SAMPLE_RATE;
}

/** 노트 이벤트 → tab-core 와 같은 형태 { start, dur, midi, conf } */
export function toNotes(events) {
  return events.map(e => ({
    start: framesToSeconds(e.startFrame),
    dur: framesToSeconds(e.endFrame - e.startFrame),
    midi: e.midi,
    cents: 0,
    conf: Math.min(1, e.amp),
    rms: 0,
    low: 0,
  }));
}
