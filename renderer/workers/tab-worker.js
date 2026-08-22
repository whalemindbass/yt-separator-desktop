'use strict';
// 채보를 메인 스레드에서 떼어낸다 — 3분 곡에 10초 안팎이 걸려 UI 가 멈추면 안 된다.
//
// 채보는 자체 YIN 으로 한다.
//
// basic-pitch(ONNX) 교차 확인도 붙여 두었지만 기본은 끔(opts.crossCheck 로만 켠다).
// 사용자 수정 정답지(617음) 대비 실측에서 YIN 87% · basic-pitch 18% (옥타브 무시 90% vs 29%)로
// 격차가 커서, 불일치는 신뢰도 신호가 아니라 basic-pitch 의 오답이었다. 표시하면 맞는 음이 흐려진다.

import { transcribe, transcribeCrepe, assignFrets } from './tab-core.js';

self.addEventListener('message', async (e) => {
  const d = e.data || {};
  if (d.type !== 'transcribe') return;
  const { id, sampleRate, opts, baseUrl } = d;
  const post = (pct, phase) => self.postMessage({ id, type: 'progress', pct, phase });
  const cross = !!(opts && opts.crossCheck === true && baseUrl);
  // CREPE(lab/tab/README.md 11번 절) — 클린·분리 후 둘 다 YIN 을 이긴 유일한 경로.
  // 아직 옵트인이라 opts.pitchTracker === 'crepe' 를 명시해야만 이 경로를 탄다.
  const useCrepe = !!(opts && opts.pitchTracker === 'crepe' && baseUrl);

  try {
    const mono = new Float32Array(d.audio);

    // 1단계 — 자체 검출. 교차 확인을 켰을 때만 뒤에 자리를 남겨 둔다.
    const span = cross ? 0.7 : 1;
    let last = -1;
    let r;
    if (useCrepe) {
      const { runCrepe } = await import('./crepe-run.js');
      const { frames, hopSec } = await runCrepe(mono, sampleRate, baseUrl, 10,
        (pct) => { const p = Math.round(pct * 0.9 * span); if (p !== last) { last = p; post(p, 'crepe'); } });
      r = transcribeCrepe(frames, hopSec, mono, sampleRate, opts);
    } else {
      r = transcribe(mono, sampleRate, opts, (pct) => {
        const p = Math.round(pct * span);
        if (p !== last) { last = p; post(p, 'yin'); }
      });
    }

    let notes = r.notes;

    // 2단계 — basic-pitch 교차 확인 (70~100%). 실패해도 1단계 결과는 그대로 낸다.
    if (cross) {
      try {
        const { runBasicPitch, markAgreement } = await import('./bp-run.js');
        const bp = await runBasicPitch(mono, sampleRate, baseUrl, (pct) => post(70 + Math.round(pct * 0.3), 'bp'));
        notes = markAgreement(notes, bp);
        const agreed = notes.filter(n => n.agree).length;
        self.postMessage({ id, type: 'crosscheck', total: notes.length, agreed, bpCount: bp.length });
      } catch (err) {
        self.postMessage({ id, type: 'crosscheck', error: (err && err.message) || String(err) });
      }
    }

    // 격자 정렬로 순서가 바뀌었을 수 있으니 운지는 마지막에 다시 매긴다
    notes = assignFrets(notes, r.tuning, (opts && opts.maxFret) || 22, opts && opts.sameStringPenalty, opts && opts.tune);
    self.postMessage({ id, type: 'done', notes, tuning: r.tuning });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: (err && err.message) || String(err) });
  }
});
