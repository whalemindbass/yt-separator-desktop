'use strict';
// 베이스 TAB 채보 — 워커 실행과 화면 표시.
// 라이브러리와 스튜디오가 같은 모듈을 쓴다. 재생 위치만 넣어주면 현재 음을 따라간다.

import { TUNINGS, TECH_GLYPH } from '../workers/tab-core.js';
import { t as tr } from './i18n.js';

const STRING_LABELS = {
  '4':  ['E', 'A', 'D', 'G'],
  '5':  ['B', 'E', 'A', 'D', 'G'],
  '5H': ['E', 'A', 'D', 'G', 'C'],
};

let _worker = null;
function getWorker() {
  if (!_worker) _worker = new Worker(new URL('../workers/tab-worker.js', import.meta.url), { type: 'module' });
  return _worker;
}

/**
 * 모노 오디오를 채보한다.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {{tuning?:string}} opts
 * @param {(pct:number)=>void} [onProgress]
 * @returns {Promise<{notes:Array, tuning:string}>}
 */
export function transcribeBass(mono, sampleRate, opts, onProgress) {
  const w = getWorker();
  // 워커가 ORT·모델을 fetch 할 기준 URL (renderer/)
  const baseUrl = new URL('../', import.meta.url).href;
  return new Promise((resolve, reject) => {
    const id = Math.random().toString(36).slice(2);
    let cross = null;
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.id !== id) return;
      if (d.type === 'progress') { onProgress && onProgress(d.pct, d.phase); return; }
      if (d.type === 'crosscheck') { cross = d; return; }
      w.removeEventListener('message', onMsg);
      if (d.type === 'error') reject(new Error(d.error));
      else resolve({ notes: d.notes, tuning: d.tuning, cross });
    };
    w.addEventListener('message', onMsg);
    const buf = new Float32Array(mono);   // 전송 후 원본을 잃지 않도록 복사
    w.postMessage({ id, type: 'transcribe', audio: buf.buffer, sampleRate, opts: opts || {}, baseUrl }, [buf.buffer]);
  });
}

/** 스템 두 채널을 모노로 */
export function toMono(L, R) {
  const n = L.length;
  const out = new Float32Array(n);
  if (!R || R === L) { out.set(L); return out; }
  for (let i = 0; i < n; i++) out[i] = (L[i] + R[i]) * 0.5;
  return out;
}

/**
 * TAB 화면. 컨테이너 하나를 받아 그 안을 관리한다.
 *   const view = new TabView(el);
 *   view.setNotes(notes, '4');
 *   view.setTime(sec);          // 재생 위치 — 현재 음 강조 + 자동 스크롤
 */
export class TabView {
  /**
   * @param {HTMLElement} el
   * @param {{onSeek?:(sec:number)=>void, pxPerSec?:number, playheadAt?:number}} opts
   *   playheadAt — 재생선이 화면 가로에서 차지하는 위치(0~1). 왼쪽에 둘수록 앞을 더 본다.
   */
  constructor(el, { onSeek, pxPerSec = 110, playheadAt = 0.3 } = {}) {
    this.el = el;
    this.onSeek = onSeek || null;
    this.pps = pxPerSec;
    this.playheadAt = playheadAt;
    this.notes = [];
    this.tuning = '4';
    this.score = null;
    this._cells = [];
    this._active = -1;
    this._time = 0;
    el.classList.add('tabv');
    // 빈 곳을 클릭하면 그 시각으로 이동 — 악보가 흐르므로 위치 = 시간이다
    if (this.onSeek) {
      el.addEventListener('click', (e) => {
        if (e.target.closest('.tabv-note')) return;   // 노트 클릭은 아래에서 처리
        const r = el.getBoundingClientRect();
        const x = e.clientX - r.left - r.width * this.playheadAt;
        this.onSeek(Math.max(0, this._time + x / this.pps));
      });
    }
  }

  clear() {
    this.notes = []; this.score = null; this._cells = []; this._active = -1; this._time = 0;
    this.el.innerHTML = '';
    this.el.classList.remove('has-notes');
  }

  setNotes(notes, tuning) {
    this.notes = notes || [];
    this.tuning = TUNINGS[tuning] ? tuning : '4';
    this._render();
  }

  /**
   * 마디선을 얹는다. 노트는 그대로 두고 그 위에 마디의 틀만 그린다 —
   * 박이 없으면 마디도 없다(null 을 주면 지운다).
   * @param {{bars:Array}|null} score buildScore() 결과
   */
  setScore(score) {
    this.score = score && score.bars && score.bars.length ? score : null;
    this._render();
  }

  _render() {
    const el = this.el;
    el.innerHTML = '';
    this._cells = [];
    this._active = -1;
    if (!this.notes.length) { el.classList.remove('has-notes'); return; }
    el.classList.add('has-notes');

    const labels = STRING_LABELS[this.tuning] || STRING_LABELS['4'];
    const nStrings = labels.length;
    el.style.setProperty('--tab-strings', String(nStrings));
    el.style.setProperty('--tab-playhead', `${this.playheadAt * 100}%`);

    // 현 이름 (왼쪽 고정)
    const gutter = document.createElement('div');
    gutter.className = 'tabv-gutter';
    for (let s = nStrings - 1; s >= 0; s--) {
      const b = document.createElement('b');
      b.textContent = labels[s];
      gutter.appendChild(b);
    }
    el.appendChild(gutter);

    // 흐르는 악보 — 시간에 비례해 배치한다
    const flow = document.createElement('div');
    flow.className = 'tabv-flow';
    const last = this.notes[this.notes.length - 1];
    flow.style.width = `${(last.start + last.dur + 4) * this.pps}px`;

    // 마디선 — 노트보다 먼저 깔아 뒤에 놓이게 한다
    if (this.score) {
      for (const bar of this.score.bars) {
        const line = document.createElement('i');
        line.className = 'tabv-bar';
        line.style.left = `${bar.start * this.pps}px`;
        flow.appendChild(line);
        const num = document.createElement('u');
        num.className = 'tabv-barnum';
        num.textContent = String(bar.index);
        num.style.left = `${bar.start * this.pps + 3}px`;
        flow.appendChild(num);
      }
    }

    for (let s = nStrings - 1; s >= 0; s--) {
      const line = document.createElement('i');
      line.className = 'tabv-string';
      line.style.top = `calc(${nStrings - 1 - s} * var(--tab-row) + var(--tab-row) / 2)`;
      flow.appendChild(line);
    }

    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.string == null || n.fret == null) { this._cells.push(null); continue; }
      const b = document.createElement('b');
      b.className = 'tabv-note';
      b.dataset.i = String(i);
      // 테크닉은 앞 음에서 이어진다는 뜻이라 프렛 앞에 붙인다 (/9, \5, h9, p7)
      const glyph = n.tech ? TECH_GLYPH[n.tech] : '';
      b.textContent = glyph + n.fret;
      if (glyph) {
        b.classList.add('tech');
        b.title = tr('tab.tech.' + n.tech);
      }
      b.style.left = `${n.start * this.pps}px`;
      b.style.top = `calc(${nStrings - 1 - n.string} * var(--tab-row))`;
      b.style.minWidth = `${Math.max(glyph ? 24 : 16, n.dur * this.pps)}px`;
      // 두 검출기가 합의하지 않은 음은 흐리게 — 지우지 않고 확신도만 알린다
      if (n.agree === false) { b.classList.add('unsure'); b.title = tr('tab.unsure'); }
      if (this.onSeek) {
        b.tabIndex = 0;
        b.addEventListener('click', (e) => { e.stopPropagation(); this.onSeek(n.start); });
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.onSeek(n.start); } });
      }
      flow.appendChild(b);
      this._cells.push(b);
    }
    el.appendChild(flow);
    this._flow = flow;

    // 재생선 — 화면에 고정되고 악보가 그 아래로 흐른다
    const ph = document.createElement('span');
    ph.className = 'tabv-playhead';
    el.appendChild(ph);

    this.setTime(this._time);
  }

  /** 재생 위치(초) — 악보를 흘리고, 지금 울리는 음을 표시 */
  setTime(sec) {
    this._time = sec;
    if (!this._flow) return;
    // 재생선은 고정, 악보가 움직인다
    this._flow.style.transform = `translateX(${-sec * this.pps}px)`;

    let idx = -1;
    const from = this._active >= 0 && this.notes[this._active] && this.notes[this._active].start <= sec ? this._active : 0;
    for (let i = from; i < this.notes.length; i++) {
      if (this.notes[i].start > sec + 0.02) break;
      idx = i;
    }
    if (idx >= 0 && sec > this.notes[idx].start + this.notes[idx].dur + 0.15) idx = -1;
    if (idx === this._active) return;
    if (this._active >= 0 && this._cells[this._active]) this._cells[this._active].classList.remove('now');
    this._active = idx;
    if (idx >= 0 && this._cells[idx]) this._cells[idx].classList.add('now');
  }

  /** 텍스트 TAB — 복사·저장용 (지금은 화면 표시만 쓰지만 만들어 둔다) */
  toText(perLine = 16) {
    const labels = STRING_LABELS[this.tuning] || STRING_LABELS['4'];
    const out = [];
    for (let i = 0; i < this.notes.length; i += perLine) {
      const chunk = this.notes.slice(i, i + perLine);
      for (let s = labels.length - 1; s >= 0; s--) {
        const row = chunk.map(n => {
          if (!(n.string === s && n.fret != null)) return '---';
          const v = (n.tech ? TECH_GLYPH[n.tech] : '') + n.fret;
          return v.padEnd(3, '-');
        }).join('--');
        out.push(`${labels[s]}|--${row}--|`);
      }
      out.push('');
    }
    return out.join('\n');
  }
}

export function stringLabels(tuning) {
  return STRING_LABELS[tuning] || STRING_LABELS['4'];
}

export { TUNINGS };
