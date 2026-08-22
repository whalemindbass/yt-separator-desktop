'use strict';
// 오선보 프로토타입 — buildScore() 가 이미 만들어 둔 마디·음표값 분해(쉼표·붙임줄 포함)를
// VexFlow 로 그리기만 한다. 리듬 양자화는 새로 만들 필요가 없었다 — tab-score.js 가
// TAB 마디선을 위해 이미 계산해 두고 있었다(items[].values, .rest, .tied).
//
// VexFlow 는 renderer/lib/vexflow/vexflow.js (UMD) 를 index.html 에서 classic <script>
// 로 얹어 window.VexFlow 전역으로 쓴다 — 렌더링이 DOM 이 필요해 워커로 뺄 수 없다.
//
// VexFlow 5 는 음표머리를 실제 폰트 글리프(Bravura, SMuFL)로 그린다 — 그 폰트가
// document.fonts 에 아직 안 올라온 채로 그리면 빈 네모(글리프 없음)로 나온다. 번들이
// 스크립트 로드 시점에 자동으로 등록은 시작하지만 비동기라, 그리기 전에 항상 기다린다.
// (CSP font-src 에 data: 를 안 열어 두면 그 등록 자체가 막혀 계속 빈 네모다 — index.html 참고.)
//
// 재생선은 TAB(tabview.js) 과 같은 구조다 — 화면엔 고정된 선을 하나 그어 두고, 음표가
// 그려진 flow 통째를 시간에 맞춰 translateX 로 미끄러뜨린다. 다만 TAB 은 px/sec 가
// 일정해 단순 곱셈이면 되는데, 오선보는 마디 폭이 고정 픽셀이라(마디 길이가 달라도
// 220px) 시간→위치가 마디마다 기울기가 다른 조각선형이다. 그래서 마디 경계를
// 저장해 두고 그 사이를 보간한다(_timeToX).

import { noteNameInKey } from '../workers/tab-score.js';

const DUR = { whole: '1', half: '2', quarter: '4', eighth: '8', sixteenth: '16' };
const BAR_WIDTH = 220;

function midiToVexKey(midi, key) {
  const name = noteNameInKey(midi, key);            // "C#3" / "Bb2" 형태
  const m = /^([A-G])([#b]?)(-?\d+)$/.exec(name);
  if (!m) return 'c/4';
  return `${m[1].toLowerCase()}${m[2]}/${m[3]}`;
}

export class StaffView {
  /**
   * @param {HTMLElement} el
   * @param {{onSeek?:(sec:number)=>void, playheadAt?:number}} [opts]
   */
  constructor(el, { onSeek, playheadAt = 0.3 } = {}) {
    this.el = el;
    this.onSeek = onSeek || null;
    this.playheadAt = playheadAt;
    this._items = [];   // 강조·클릭 탐색용 — [{start, end, sn, el}], 시각순
    this._bars = [];    // 재생선 위치 계산용 — [{start, end, x}], x = 마디 왼쪽 끝 픽셀
    this._active = -1;
    this._time = 0;
    this._flow = null;
  }

  clear() {
    this.el.innerHTML = '';
    this._items = [];
    this._bars = [];
    this._active = -1;
    this._flow = null;
  }

  /**
   * @param {{bars:Array, beatsPerBar:number, subdiv:number}|null} score  tab-score.js 의 buildScore() 결과
   * @param {object|null} key  estimateKey() 결과 — 음이름 표기(#/b)에만 쓴다
   * @param {Array|null} [barChords]  tab-score.js 의 computeBarChords() 결과 — score.bars 와 같은 순서(없으면 생략)
   */
  async render(score, key, barChords) {
    this.clear();
    if (!score || !score.bars || !score.bars.length || !window.VexFlow) return;
    // Bravura 글리프 폰트가 올라올 때까지 — 안 기다리면 음표가 빈 네모로 나온다.
    if (document.fonts && document.fonts.ready) {
      try { await document.fonts.ready; } catch { /* 폰트 상태를 못 읽어도 일단 그려본다 */ }
    }
    try {
      this._render(score, key, barChords);
    } catch (err) {
      // 프로토타입 단계 — 렌더링이 깨져도 TAB/채보 결과는 그대로 두고 여기만 알린다.
      console.error('[staff] render failed', err);
      this.clear();
      const p = document.createElement('div');
      p.style.cssText = 'color:#c00; font-family:monospace; font-size:12px; padding:6px;';
      p.textContent = `오선보 표시 실패: ${(err && err.message) || err}`;
      this.el.appendChild(p);
    }
  }

  _render(score, key, barChords) {
    const VF = window.VexFlow;
    const beatsPerBar = score.beatsPerBar || 4;
    const perBar = beatsPerBar * (score.subdiv || 4);
    const width = score.bars.length * BAR_WIDTH + 40;

    this.el.style.setProperty('--staff-playhead', `${this.playheadAt * 100}%`);
    const flow = document.createElement('div');
    flow.className = 'staff-view-flow';
    this.el.appendChild(flow);
    this._flow = flow;

    const renderer = new VF.Renderer(flow, VF.Renderer.Backends.SVG);
    renderer.resize(width, 190);
    const ctx = renderer.getContext();

    const items = [];
    const bars = [];
    let x = 18;
    for (let bi = 0; bi < score.bars.length; bi++) {
      const bar = score.bars[bi];
      bars.push({ start: bar.start, end: bar.end, x });
      const stave = new VF.Stave(x, 42, BAR_WIDTH);
      if (bi === 0) stave.addClef('bass').addTimeSignature(`${beatsPerBar}/4`);
      const chord = barChords ? barChords[bi] : null;
      if (chord) {
        // 기본 텍스트 폰트가 밋밋해서 코드 라벨만 굵게·색을 얹는다 — 인쇄 악보 위 손글씨
        // 코드 메모 느낌으로. 본문 음표는 손대지 않는다(그건 그대로 검게 두는 게 맞다).
        const label = new VF.StaveText(chord.name, VF.StaveModifierPosition.ABOVE);
        label.setFont('Georgia, "Noto Serif KR", serif', 15, '700');
        label.setStyle({ fillStyle: '#8a5a2b' });
        stave.addModifier(label);
      }
      stave.setContext(ctx).draw();

      const barDur = bar.end - bar.start;
      const vexNotes = [];
      const ties = [];
      for (const item of bar.items) {
        // 마디를 넘어가거나 표준 음표값이 아닌 길이는 여러 조각(붙임줄)으로 온다 —
        // buildScore() 의 splitDuration() 이 이미 나눠 뒀다.
        let cursor = item.at;
        for (const v of item.values) {
          const durBase = DUR[v.name] || '4';
          // 쉼표는 그리지 않는다 — 짧은 쉼표가 하도 많이 끼어 오히려 읽기 힘들었다(사용자 제보).
          // GhostNote 는 자리(박)만 차지하고 아무것도 안 그린다 — Voice 틱 계산은 그대로 맞는다.
          const sn = item.rest
            ? new VF.GhostNote(durBase + (v.dotted ? 'd' : ''))
            : new VF.StaveNote({ keys: [midiToVexKey(item.note.midi, key)], duration: durBase + (v.dotted ? 'd' : ''), clef: 'bass' });
          vexNotes.push(sn);
          const t0 = bar.start + (cursor / perBar) * barDur;
          const t1 = bar.start + ((cursor + v.units) / perBar) * barDur;
          items.push({ start: t0, end: t1, sn, seekAt: item.note ? item.note.start : t0 });
          cursor += v.units;
          if (!item.rest && v.tied) {
            ties.push(new VF.StaveTie({ firstNote: vexNotes[vexNotes.length - 2], lastNote: sn }));
          }
        }
      }
      if (vexNotes.length) {
        const voice = new VF.Voice({ numBeats: beatsPerBar, beatValue: 4 }).setStrict(false);
        voice.addTickables(vexNotes);
        // StaveNote 는 key 문자열의 #/b 로 자리(줄)만 정하지, 옆에 붙는 우발표(#/♮/b) 기호는
        // 저절로 안 그려진다 — 그래서 예를 들어 G 와 G# 이 표기상 아예 같아 보였다(사용자 제보:
        // TAB 으론 반음씩 세 개인데 오선보엔 둘이 같아 보였다). applyAccidentals 가 그 기호를
        // 붙여준다. 조표는 늘 'C'(없음)로 줘서 — 스테이브에 조표 자체를 안 그리므로, 실제
        // 조표를 준다면 "이미 표시돼 있다"고 착각해 우발표를 오히려 안 붙이는 역효과가 난다.
        VF.Accidental.applyAccidentals([voice], 'C');
        new VF.Formatter().joinVoices([voice]).format([voice], BAR_WIDTH - 20);
        voice.draw(ctx, stave);
        for (const tie of ties) tie.setContext(ctx).draw();
      }
      x += BAR_WIDTH;
    }

    // 재생선 추적·클릭 탐색용 — 그려진 다음이라야 실제 SVG 엘리먼트를 잡을 수 있다
    for (const it of items) {
      it.el = it.sn.getSVGElement && it.sn.getSVGElement();
      if (it.el && this.onSeek) {
        it.el.style.cursor = 'pointer';
        it.el.addEventListener('click', () => this.onSeek(it.seekAt));
      }
    }
    this._items = items;
    this._bars = bars;

    const ph = document.createElement('span');
    ph.className = 'staff-playhead';
    this.el.appendChild(ph);

    this.setTime(this._time);
  }

  /** 시각(초) → flow 안 픽셀 위치. 마디 사이는 선형 보간, 밖은 앞뒤 마디 기울기로 늘린다. */
  _timeToX(sec) {
    const bars = this._bars;
    if (!bars.length) return 0;
    const rate0 = BAR_WIDTH / Math.max(1e-6, bars[0].end - bars[0].start);
    if (sec <= bars[0].start) return bars[0].x + (sec - bars[0].start) * rate0;
    const last = bars[bars.length - 1];
    const rateN = BAR_WIDTH / Math.max(1e-6, last.end - last.start);
    if (sec >= last.end) return last.x + BAR_WIDTH + (sec - last.end) * rateN;
    let lo = 0, hi = bars.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].end <= sec) lo = mid + 1; else hi = mid; }
    const bar = bars[lo];
    const frac = (sec - bar.start) / Math.max(1e-6, bar.end - bar.start);
    return bar.x + frac * BAR_WIDTH;
  }

  /** 재생 위치(초) — 악보를 흘리고, 지금 울리는 음표를 강조한다 */
  setTime(sec) {
    this._time = sec;
    if (this._flow) {
      // CSS 의 left: var(--staff-playhead) 가 이미 재생선 위치로 flow 원점을 옮겨 둔다 —
      // 여기선 그 원점 기준으로 현재 시각만큼 왼쪽으로 밀면 된다(TAB 과 같은 방식).
      const x = this._timeToX(sec);
      this._flow.style.transform = `translateX(${-x}px)`;
    }
    if (!this._items.length) return;
    let idx = -1;
    const from = this._active >= 0 && this._items[this._active] && this._items[this._active].start <= sec ? this._active : 0;
    for (let i = from; i < this._items.length; i++) {
      if (this._items[i].start > sec) break;
      if (sec < this._items[i].end) idx = i;
    }
    if (idx === this._active) return;
    if (this._active >= 0 && this._items[this._active].el) this._items[this._active].el.classList.remove('staffv-now');
    this._active = idx;
    if (idx >= 0 && this._items[idx].el) this._items[idx].el.classList.add('staffv-now');
  }
}
