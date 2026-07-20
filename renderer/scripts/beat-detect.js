// drums stem 에서 BPM · beat 시간을 감지 (Web Worker 기반).
// music-tempo 는 UMD · classic worker importScripts 로 로드.

let _worker = null;
function getWorker() {
  if (_worker) return _worker;
  _worker = new Worker(new URL('../workers/beat-worker.js', import.meta.url), { type: 'classic' });
  return _worker;
}

/** drums stem 우선, 실패 시 fallbackMix 로 재시도.
 *  @param {Float32Array} drumsL
 *  @param {Float32Array} drumsR
 *  @param {number} sampleRate
 *  @param {[Float32Array,Float32Array]|null} fallbackMix - [L, R]
 *  @returns {Promise<{tempo:number, beats:number[], beatInterval:number}>} */
export function detectBeats(drumsL, drumsR, sampleRate, fallbackMix) {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    const onMsg = (e) => {
      if (e.data?.id !== id) return;
      w.removeEventListener('message', onMsg);
      if (e.data.type === 'error') return reject(new Error(e.data.error));
      resolve(e.data);
    };
    w.addEventListener('message', onMsg);
    const dL = new Float32Array(drumsL);
    const dR = new Float32Array(drumsR);
    const transfer = [dL.buffer, dR.buffer];
    const msg = { id, type: 'analyze', drumsL: dL.buffer, drumsR: dR.buffer, sampleRate };
    if (fallbackMix && fallbackMix[0] && fallbackMix[1]) {
      const fL = new Float32Array(fallbackMix[0]);
      const fR = new Float32Array(fallbackMix[1]);
      msg.mixL = fL.buffer; msg.mixR = fR.buffer;
      transfer.push(fL.buffer, fR.buffer);
    }
    w.postMessage(msg, transfer);
  });
}
