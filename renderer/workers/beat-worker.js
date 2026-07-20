// music-tempo 를 이용해 drums stem 에서 BPM · beat 시간을 추출.
// classic worker (importScripts 사용).

self.importScripts('../lib/music-tempo/music-tempo.min.js');

// 오디오 통계 (peak · rms)
function stats(a) {
  let peak = 0, ss = 0;
  const step = Math.max(1, Math.floor(a.length / 100000));
  let n = 0;
  for (let i = 0; i < a.length; i += step) {
    const v = a[i];
    if (Number.isFinite(v)) {
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
      ss += v * v;
      n++;
    }
  }
  return { peak, rms: Math.sqrt(ss / Math.max(1, n)) };
}

function analyze(mono, sampleRate) {
  // 매우 조용하면 노멀라이즈 (onset 감지 실패 방지)
  const s = stats(mono);
  if (s.peak > 0 && s.peak < 0.5) {
    const gain = Math.min(1 / s.peak, 20);
    for (let i = 0; i < mono.length; i++) mono[i] *= gain;
  }
  const hopSize = Math.round(sampleRate * 0.01);
  const bufferSize = 2048;
  const timeStep = hopSize / sampleRate;
  return new self.MusicTempo(mono, { bufferSize, hopSize, timeStep });
}

// beats 배열을 최소자승법으로 uniform grid (downbeat + interval * n) 에 fit.
// 이후 outlier (residual > 0.35 * interval) 제거 후 재fit.
// 반환: { downbeat, interval, fitStdMs } — fitStdMs 는 나머지 beats 의 표준편차 (ms).
function fitUniformGrid(beats) {
  if (beats.length < 8) return null;
  const linreg = (pts) => {
    const N = pts.length;
    let sX=0,sY=0,sXY=0,sX2=0;
    for (let k=0;k<N;k++){const x=pts[k][0],y=pts[k][1];sX+=x;sY+=y;sXY+=x*y;sX2+=x*x;}
    const denom = N*sX2 - sX*sX;
    if (Math.abs(denom) < 1e-9) return null;
    const interval = (N*sXY - sX*sY) / denom;
    const downbeat = (sY - interval*sX) / N;
    return { downbeat, interval };
  };
  // 1차 fit — beats index 0..N-1
  let pts = beats.map((t, i) => [i, t]);
  let fit = linreg(pts);
  if (!fit || fit.interval <= 0.15 || fit.interval > 2.0) return null;

  // Outlier 제거 반복 (최대 3회)
  for (let iter=0; iter<3; iter++) {
    const cutoff = 0.35 * fit.interval;
    // 각 raw beat 를 가장 가까운 grid 인덱스로 재할당 (index skip · 중복 대응)
    const reassigned = beats.map(t => {
      const n = Math.round((t - fit.downbeat) / fit.interval);
      const expected = fit.downbeat + n * fit.interval;
      return { n, t, resid: t - expected };
    });
    // 잔차 큰 것 (missed/spurious beat) 제거
    const kept = reassigned.filter(x => Math.abs(x.resid) < cutoff);
    if (kept.length < 8) break;
    const newPts = kept.map(x => [x.n, x.t]);
    const newFit = linreg(newPts);
    if (!newFit || newFit.interval <= 0.15 || newFit.interval > 2.0) break;
    // 수렴 체크
    if (Math.abs(newFit.interval - fit.interval) < 1e-5) { fit = newFit; break; }
    fit = newFit;
    pts = newPts;
  }
  // 잔차 표준편차 (ms)
  let ss = 0, n = 0;
  for (const t of beats) {
    const idx = Math.round((t - fit.downbeat) / fit.interval);
    const r = t - (fit.downbeat + idx * fit.interval);
    if (Math.abs(r) < 0.35 * fit.interval) { ss += r*r; n++; }
  }
  const fitStdMs = n ? Math.sqrt(ss/n) * 1000 : 0;
  return { ...fit, fitStdMs };
}

self.addEventListener('message', (e) => {
  const { id, type } = e.data;
  if (type !== 'analyze') return;
  try {
    const { drumsL, drumsR, sampleRate } = e.data;
    const L = new Float32Array(drumsL);
    const R = new Float32Array(drumsR);
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;

    // 1차: drums 로 시도
    let mt;
    try {
      mt = analyze(mono, sampleRate);
    } catch (e1) {
      // 2차: 전체 mix 로 폴백 (drums 가 부족한 조용한 곡 등)
      if (e.data.mixL && e.data.mixR) {
        const mL = new Float32Array(e.data.mixL);
        const mR = new Float32Array(e.data.mixR);
        const mm = new Float32Array(mL.length);
        for (let i = 0; i < mL.length; i++) mm[i] = (mL[i] + mR[i]) * 0.5;
        mt = analyze(mm, sampleRate);
      } else {
        throw e1;
      }
    }
    // 균일 grid fit (outlier 제거 · linear regression)
    const gridFit = fitUniformGrid(mt.beats);
    self.postMessage({
      id, type: 'result',
      tempo: gridFit ? (60 / gridFit.interval) : parseFloat(mt.tempo),
      beats: mt.beats,
      beatInterval: gridFit ? gridFit.interval : mt.beatInterval,
      downbeat: gridFit ? gridFit.downbeat : (mt.beats[0] || 0),
      fitStdMs: gridFit ? gridFit.fitStdMs : null,
    });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: err.message || String(err) });
  }
});
