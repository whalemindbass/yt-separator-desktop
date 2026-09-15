'use strict';
// 코드 스트립 — 오선보 대신 마디마다 코드명(알파벳/숫자)만 보여주는 얇은 한 줄.
// StaffView 와 같은 호출 인터페이스(clear/render/setTime)를 유지해서 studio.js/
// library.js 의 교체를 기계적으로 만든다. SVG·폰트 대기 없이 순수 DOM 텍스트라
// StaffView 보다 훨씬 단순하다.

/** 시각(초) → 그 시각을 담은 마디 index. bars 는 시간순(start 오름차순)이라 이분탐색. */
function barIndexAt(bars, sec) {
  if (!bars.length) return -1;
  if (sec < bars[0].start) return -1;
  let lo = 0, hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].start <= sec) lo = mid; else hi = mid - 1;
  }
  return lo;
}

export class ChordStripView {
  /** @param {HTMLElement} el @param {{onSeek?:(sec:number)=>void}} [opts] */
  constructor(el, { onSeek } = {}) {
    this.el = el;
    this.onSeek = onSeek || null;
    this._bars = [];      // [{start, end}] — setTime 탐색용
    this._cells = [];     // bars 와 같은 순서의 .chord-cell 엘리먼트
    this._fills = [];     // bars 와 같은 순서의 진행률 채우기 div(.chord-cell-fill)
    this._active = -1;
  }

  clear() {
    this.el.innerHTML = '';
    this._bars = [];
    this._cells = [];
    this._fills = [];
    this._active = -1;
  }

  /**
   * @param {{bars:Array}|null} score  tab-score.js 의 buildScore() 결과
   * @param {object|null} key  미사용 — StaffView 와 시그니처만 맞춘다(음이름 표기용이라 코드 스트립엔 불필요)
   * @param {Array<{name:string}|null>|null} [barChords]  computeBarChords() 결과 — score.bars 와 같은 순서
   */
  render(score, key, barChords) {
    this.clear();
    if (!score || !score.bars || !score.bars.length) return;
    for (let i = 0; i < score.bars.length; i++) {
      const bar = score.bars[i];
      this._bars.push({ start: bar.start, end: bar.end });
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'chord-cell';
      // 채우기(fill)는 음수 z-index 로 깔아 둔다 — 뒤에 붙는 텍스트는 포지션 없는
      // 인라인 콘텐츠라 음수 z-index 자손보다 항상 위에 그려진다(스태킹 규칙).
      // 그래서 별도로 텍스트에 z-index 를 안 줘도 채우기가 글자를 가리지 않는다.
      const fill = document.createElement('span');
      fill.className = 'chord-cell-fill';
      cell.appendChild(fill);
      cell.appendChild(document.createTextNode((barChords && barChords[i] && barChords[i].name) || '–'));
      if (this.onSeek) cell.addEventListener('click', () => this.onSeek(bar.start));
      this.el.appendChild(cell);
      this._cells.push(cell);
      this._fills.push(fill);
    }
  }

  /** 재생 위치(초) — 지금 마디를 강조하고, 마디 안에서 얼마나 지났는지 왼쪽부터 채운다. */
  setTime(sec) {
    const idx = barIndexAt(this._bars, sec);
    if (idx !== this._active) {
      if (this._active >= 0 && this._cells[this._active]) {
        this._cells[this._active].classList.remove('active');
        this._fills[this._active].style.width = '0%';
      }
      this._active = idx;
      if (idx >= 0 && this._cells[idx]) {
        this._cells[idx].classList.add('active');
        this._cells[idx].scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      }
    }
    if (idx < 0) return;
    const bar = this._bars[idx];
    const frac = bar.end > bar.start ? Math.max(0, Math.min(1, (sec - bar.start) / (bar.end - bar.start))) : 0;
    this._fills[idx].style.width = `${frac * 100}%`;
  }
}
