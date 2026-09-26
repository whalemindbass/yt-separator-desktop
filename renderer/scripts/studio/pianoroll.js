// 피아노롤 — MIDI 클립 하나의 노트를 직접 편집한다(스튜디오 작업 영역 위에 뜨는 패널).
//
// 시간은 전부 초. 노트 t 는 클립 시작 기준(studio.js 의 _midiClips 와 같은 형식). 격자선은 곡의
// 박(origin = _gridOffset)에 맞춘다 — 클립이 박 중간에서 시작해도 격자는 곡 기준이다.
// 편집 결과는 이 모듈이 클립 객체를 직접 고치고 onCommit(before) 로 알린다. 스튜디오 쪽이
// 엔진 전송·실행취소·저장 표시를 맡는다. 실행취소로 클립이 바뀌면 스튜디오가 refresh() 를 부른다.
import { noteName } from './util.js';

const ROW = 14;          // 음 하나 높이(px)
const KEYS_W = 52;       // 왼쪽 건반 폭
const MIN_PPS = 20, MAX_PPS = 800;

/** 격자 내림(노트를 놓을 칸의 시작) — 절대 시각 기준 */
export function floorToGrid(abs, origin, step) { return origin + Math.floor((abs - origin) / step + 1e-6) * step; }
/** 격자 반올림(끌어서 옮길 때) */
export function roundToGrid(abs, origin, step) { return origin + Math.round((abs - origin) / step) * step; }
/** 복사 — 선택 노트를 가장 앞 노트 기준 상대 시각으로(음높이는 그대로) */
export function copyNotes(notes) {
  if (!notes.length) return [];
  const t0 = Math.min(...notes.map(n => n.t));
  return notes.map(n => ({ t: n.t - t0, d: n.d, p: n.p, v: n.v })).sort((a, b) => a.t - b.t || a.p - b.p);
}
/**
 * 붙여넣기 — 기준 음(가장 앞, 같으면 가장 낮은 음)이 at(시각)·pitch(음높이)에 오고 나머지는 시간 간격·음정을
 * 그대로 유지한다. pitch 가 없으면 원래 음높이 그대로. 범위를 벗어나는 음은 0~127 로 막는다.
 */
export function pasteNotes(clipNotes, at, pitch) {
  if (!clipNotes || !clipNotes.length) return [];
  const ref = clipNotes[0];   // copyNotes 가 시각→음높이 순으로 정렬해 둔다
  const dp = pitch == null ? 0 : pitch - ref.p;
  return clipNotes.map(n => ({ t: Math.max(0, at + n.t), d: n.d, p: Math.max(0, Math.min(127, n.p + dp)), v: n.v }));
}
let _noteClipboard = null;   // 피아노롤을 닫았다 다른 클립에서 열어도 남는다(FL 과 같다)

/**
 * @param {object} o
 *  host: 붙일 요소, getClip(): 지금 클립(실행취소로 객체가 바뀔 수 있어 매번 찾아온다),
 *  color, stepSec(), origin(), secPerBar(), onCommit(beforeSnapshot), onPreview(pitch, on),
 *  onClose(), onQuantize(), tr, quantLabel()
 */
export function openPianoRoll(o) {
  const clip0 = o.getClip();
  if (!clip0) return null;
  const root = document.createElement('div');
  root.className = 'pr';
  root.style.setProperty('--c', o.color || 'var(--accent)');
  root.innerHTML = `
    <div class="pr-head">
      <b class="pr-title"></b>
      <span class="pr-hint">${o.tr('studio.pr.hint')}</span>
      <span class="pr-sp"></span>
      <label class="pr-gridsel">${o.tr('studio.midi.grid')} <select>${(o.divs || []).map(d => `<option value="${d}">${d.replace('T', ' ' + o.tr('studio.midi.triplet'))}</option>`).join('')}</select></label>
      <button class="btn btn-sm pr-q" type="button"></button>
      <button class="pr-x" type="button" title="${o.tr('studio.pr.close')}">✕</button>
    </div>
    <div class="pr-bar">
      <button class="pr-play" type="button" title="${o.tr('studio.pr.playTitle')}"><svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 3.2v9.6L12.5 8z"/></svg></button>
      <button class="pr-solo" type="button" aria-pressed="false" title="${o.tr('studio.pr.soloTitle')}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 9.5V8a5 5 0 0 1 10 0v1.5"/><rect x="2.2" y="9" width="2.6" height="4.2" rx="1"/><rect x="11.2" y="9" width="2.6" height="4.2" rx="1"/></svg><span>${o.tr('studio.pr.solo')}</span></button>
      <span class="pr-time"></span>
    </div>
    <div class="pr-ruler" title="${o.tr('studio.pr.rulerTitle')}"><div class="pr-ruler-sp"></div><div class="pr-ruler-view"><div class="pr-ruler-in"></div></div></div>
    <div class="pr-scroll"><div class="pr-canvas"><div class="pr-keys"></div><div class="pr-grid"><div class="pr-lines"></div><div class="pr-notes"></div><div class="pr-end"></div><div class="pr-ph"></div><div class="pr-marq" hidden></div><div class="pr-anchor" hidden></div></div></div></div>
    <div class="pr-vel"><div class="pr-vel-lbl">${o.tr('studio.pr.velocity')}</div><div class="pr-vel-view"><div class="pr-vel-in"></div></div></div>`;
  o.host.appendChild(root);
  const $q = (s) => root.querySelector(s);
  const scroll = $q('.pr-scroll'), canvas = $q('.pr-canvas'), grid = $q('.pr-grid'), notesEl = $q('.pr-notes'), lines = $q('.pr-lines');
  let pps = 0;               // 초당 픽셀 — 처음엔 클립이 화면 폭에 맞게
  let sel = new Set();       // 선택된 노트(객체 참조 대신 인덱스가 흔들리지 않게 노트 객체 자체를 담는다)
  let lastLen = null;        // 마지막으로 놓거나 늘린 길이 — 새 노트 기본값(FL 과 같은 동작)
  const clip = () => o.getClip();
  const rowOf = (p) => 127 - p;
  const pitchAt = (y) => Math.max(0, Math.min(127, 127 - Math.floor(y / ROW)));

  // 건반 — C 에만 이름을 쓴다. 누르면 그 음을 들려준다.
  // 실제 피아노처럼 — 흰건반은 옥타브(12줄 = 168px)를 7등분한 폭으로 깔고, 검은건반은 자기 줄
  // 높이 그대로 60% 폭으로 그 위에 얹는다. 줄(음 하나 = 14px)과 격자 줄은 그대로 맞는다.
  {
    const keys = $q('.pr-keys');
    keys.style.height = (128 * ROW) + 'px';
    const WHITE = [0, 2, 4, 5, 7, 9, 11], WH = (12 * ROW) / 7;
    let html = '';
    for (let c = 0; c <= 120; c += 12) {
      const blockBottom = (127 - c) * ROW + ROW;   // 이 옥타브 C 줄의 아래 끝
      WHITE.forEach((off, i) => {
        const p = c + off; if (p > 127) return;
        const top = blockBottom - (i + 1) * WH;
        html += `<div class="pr-key w${off === 0 ? ' c' : ''}" data-p="${p}" style="top:${top.toFixed(2)}px;height:${WH.toFixed(2)}px">${off === 0 ? `<span>${noteName(p)}</span>` : ''}</div>`;
      });
    }
    for (let p = 0; p <= 127; p++) {
      if (!noteName(p).includes('#')) continue;
      html += `<div class="pr-key b" data-p="${p}" style="top:${rowOf(p) * ROW}px;height:${ROW}px"></div>`;
    }
    keys.innerHTML = html;
  }
  $q('.pr-keys').addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.pr-key'); if (!k) return;
    const p = Number(k.dataset.p); o.onPreview(p, true); k.classList.add('on');
    const up = () => { o.onPreview(p, false); k.classList.remove('on'); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointerup', up);
  });

  function widthSec() {
    const c = clip(); if (!c) return 1;
    const vis = Math.max(1, (scroll.clientWidth - KEYS_W) / pps);
    return Math.max(c.dur + o.secPerBar() * 2, vis);
  }
  function drawLines() {
    const c = clip(); if (!c) return;
    const step = o.stepSec(), origin = o.origin(), bar = o.secPerBar(), beat = bar / 4;
    const W = widthSec();
    let html = '';
    // 128 줄 — 검은건반 줄은 어둡게, C 줄 위에 옥타브 경계선
    for (let i = 0; i < 128; i++) {
      const p = 127 - i, nm = noteName(p);
      html += `<div class="pr-row${nm.includes('#') ? ' b' : ''}${p % 12 === 0 ? ' c' : ''}" style="top:${i * ROW}px"></div>`;
    }
    // 세로선 — 격자(연하게) · 박 · 마디(진하게). 화면 밖까지 다 그리되 너무 촘촘하면 격자선은 뺀다.
    const drawStep = step * pps >= 6 ? step : beat;
    const a0 = floorToGrid(c.start, origin, drawStep);
    for (let a = a0; a <= c.start + W; a += drawStep) {
      const x = (a - c.start) * pps; if (x < -1) continue;
      const onBar = Math.abs(((a - origin) / bar) - Math.round((a - origin) / bar)) < 1e-4;
      const onBeat = Math.abs(((a - origin) / beat) - Math.round((a - origin) / beat)) < 1e-4;
      html += `<i class="pr-vl${onBar ? ' bar' : onBeat ? ' beat' : ''}" style="left:${x.toFixed(1)}px"></i>`;
    }
    lines.innerHTML = html;
    canvas.style.width = (KEYS_W + W * pps) + 'px';
    canvas.style.height = (128 * ROW) + 'px';
    $q('.pr-end').style.left = (c.dur * pps) + 'px';
  }
  // 시간 눈금자 — 마디 번호. 누르거나 끌면 재생선이 그리로(피아노롤 안에서 재생 위치를 정한다).
  const rulerIn = $q('.pr-ruler-in'), rulerView = $q('.pr-ruler-view');
  function drawRuler() {
    const c = clip(); if (!c) return;
    const bar = o.secPerBar(), beat = bar / 4, origin = o.origin(), W = widthSec();
    let html = '';
    const a0 = floorToGrid(c.start, origin, beat);
    for (let a = a0; a <= c.start + W; a += beat) {
      const x = (a - c.start) * pps; if (x < -1) continue;
      const bi = (a - origin) / bar, onBar = Math.abs(bi - Math.round(bi)) < 1e-4;
      html += onBar ? `<i class="bar" style="left:${x.toFixed(1)}px"><b>${Math.round(bi) + 1}</b></i>` : `<i style="left:${x.toFixed(1)}px"></i>`;
    }
    rulerIn.innerHTML = html;
    rulerIn.style.width = (W * pps) + 'px';
    rulerIn.style.transform = `translateX(${-scroll.scrollLeft}px)`;
  }
  scroll.addEventListener('scroll', () => { rulerIn.style.transform = `translateX(${-scroll.scrollLeft}px)`; });
  rulerView.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const seek = (ev) => {
      const c = clip(); if (!c) return;
      const r = rulerView.getBoundingClientRect();
      const rel = Math.max(0, (ev.clientX - r.left + scroll.scrollLeft) / pps);
      o.onSeek(c.start + rel);
    };
    seek(e);
    const up = () => { document.removeEventListener('pointermove', seek); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', seek); document.addEventListener('pointerup', up);
  });
  function drawNotes() {
    const c = clip(); if (!c) return;
    $q('.pr-title').textContent = o.title ? o.title() : '';
    $q('.pr-q').textContent = o.tr('studio.midi.quantizeNow', { div: o.quantLabel() });
    notesEl.innerHTML = '';
    c.notes.forEach((n, i) => {
      const el = document.createElement('div');
      el.className = 'pr-note' + (sel.has(n) ? ' sel' : '');
      el.dataset.i = String(i);
      el.style.left = (n.t * pps) + 'px';
      el.style.top = (rowOf(n.p) * ROW + 1) + 'px';
      el.style.width = Math.max(4, n.d * pps - 1) + 'px';
      el.style.height = (ROW - 2) + 'px';
      el.style.setProperty('--v', String(0.45 + 0.55 * (n.v || 0.8)));
      if (n.d * pps > 34) el.textContent = noteName(n.p);
      notesEl.appendChild(el);
    });
  }
  // 세기(벨로시티) 줄 — 노트마다 막대 하나. 위아래로 끌면 세기, 끌면서 옆으로 쓸면 지나간 노트를 다 칠한다.
  const velIn = $q('.pr-vel-in'), velView = $q('.pr-vel-view');
  const VEL_H = 64;
  function drawVel() {
    const c = clip(); if (!c) return;
    velIn.style.width = (widthSec() * pps) + 'px';
    velIn.innerHTML = c.notes.map((n, i) => `<i class="${sel.has(n) ? 'sel' : ''}" data-i="${i}" style="left:${(n.t * pps).toFixed(1)}px;height:${Math.round((n.v || 0.8) * (VEL_H - 6))}px"></i>`).join('');
    velIn.style.transform = `translateX(${-scroll.scrollLeft}px)`;
  }
  scroll.addEventListener('scroll', () => { velIn.style.transform = `translateX(${-scroll.scrollLeft}px)`; });
  velView.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const c = clip(); if (!c || !c.notes.length) return;
    e.preventDefault();
    const before = snapshot();
    let changed = false;
    const paint = (ev) => {
      const r = velView.getBoundingClientRect();
      const x = ev.clientX - r.left + scroll.scrollLeft, y = ev.clientY - r.top;
      const v = Math.max(0.05, Math.min(1, 1 - (y - 3) / (VEL_H - 6)));
      const tAt = x / pps;
      // 커서 아래 노트(시작점이 4px 안) — 선택된 노트가 걸리면 선택 전체를 같은 세기로
      const hit = c.notes.filter(n => Math.abs(n.t * pps - x) <= 4);
      if (!hit.length) return;
      const targets = hit.some(n => sel.has(n)) ? [...sel] : hit;
      for (const n of targets) n.v = Math.round(v * 100) / 100;
      changed = true; void tAt;
      drawVel(); drawNotes();
    };
    paint(e);
    const up = () => { document.removeEventListener('pointermove', paint); document.removeEventListener('pointerup', up); if (changed) commit(before); };
    document.addEventListener('pointermove', paint); document.addEventListener('pointerup', up);
  });
  let anchor = null;   // 우클릭으로 찍은 붙여넣기 자리 { t(클립 기준), p }
  let phRel = -1;      // 마지막으로 받은 재생선(클립 기준)
  function drawAnchor() {
    const el = $q('.pr-anchor');
    if (!anchor) { el.hidden = true; return; }
    el.hidden = false;
    el.style.left = (anchor.t * pps) + 'px';
    el.style.top = (rowOf(anchor.p) * ROW) + 'px';
    el.style.width = Math.max(6, o.stepSec() * pps) + 'px';
    el.style.height = ROW + 'px';
  }
  function redraw() { drawLines(); drawNotes(); drawVel(); drawRuler(); drawAnchor(); }
  const snapshot = () => { const c = clip(); return c ? { ...c, notes: c.notes.map(n => ({ ...n })) } : null; };
  function commit(before) {
    const c = clip(); if (!c) return;
    c.notes.sort((a, b) => a.t - b.t || a.p - b.p);
    const end = c.notes.reduce((m, n) => Math.max(m, n.t + n.d), 0);
    if (end > c.dur) c.dur = end;   // 클립 끝을 넘는 노트는 잘려 들리니 클립을 늘린다
    o.onCommit(before);
    redraw();
  }
  const localPos = (e) => { const r = grid.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  grid.addEventListener('contextmenu', (e) => e.preventDefault());
  grid.addEventListener('pointerdown', (e) => {
    const c = clip(); if (!c) return;
    const noteEl = e.target.closest('.pr-note');
    const { x, y } = localPos(e);
    const step = o.stepSec(), origin = o.origin();
    if (e.button === 2) {
      if (!noteEl) {   // 빈 칸 우클릭 = 붙여넣기 자리(그 칸의 격자 시작 + 그 음)
        const abs = floorToGrid(c.start + x / pps, origin, step);
        anchor = { t: Math.max(0, abs - c.start), p: pitchAt(y) };
        drawAnchor(); return;
      }
      // 노트 우클릭 = 지우기, 누른 채 끌면 지나가는 노트를 다 지운다(FL)
      const before = snapshot();
      const eraseAt = (px, py) => {
        const hit = c.notes.filter(m => { const x0 = m.t * pps, x1 = x0 + Math.max(4, m.d * pps), y0 = rowOf(m.p) * ROW; return px >= x0 && px <= x1 && py >= y0 && py < y0 + ROW; });
        if (!hit.length) return false;
        c.notes = c.notes.filter(m => !hit.includes(m)); hit.forEach(m => sel.delete(m));
        drawNotes(); drawVel(); return true;
      };
      let erased = eraseAt(x, y);
      const mv = (ev) => { const q = localPos(ev); if (eraseAt(q.x, q.y)) erased = true; };
      const upR = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', upR); if (erased) commit(before); };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', upR);
      return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const before = snapshot();
    let n, mode, clonedFrom = null;
    if (noteEl) {
      n = c.notes[Number(noteEl.dataset.i)];
      const r = noteEl.getBoundingClientRect();
      mode = (r.right - e.clientX) <= 6 ? 'resize' : 'move';
      if (e.ctrlKey || e.metaKey) { if (sel.has(n)) sel.delete(n); else sel.add(n); drawNotes(); drawVel(); return; }
      if (!sel.has(n)) sel = new Set([n]);
      if (e.shiftKey && mode === 'move') {   // Shift+끌기 = 복사해서 끌기 — 원본은 제자리, 복제본이 움직인다
        const clones = [...sel].map(m => ({ ...m }));
        const idx = [...sel].indexOf(n);
        clonedFrom = { src: new Set(sel), clones: new Set(clones) };
        c.notes.push(...clones);
        sel = new Set(clones); n = clones[idx];
      }
    } else if (e.ctrlKey || e.metaKey || e.shiftKey) {
      // 빈 곳에서 Ctrl/Shift + 끌기 = 범위 선택(Ctrl: 새로, Shift: 기존에 더하기). 스쳐 지나간 노트가 잡힌다.
      const add = e.shiftKey, base = add ? new Set(sel) : new Set();
      const marq = $q('.pr-marq');
      const x0 = x, y0 = y;
      const paint = (ev) => {
        const q = localPos(ev);
        const l = Math.min(x0, q.x), rgt = Math.max(x0, q.x), t = Math.min(y0, q.y), b = Math.max(y0, q.y);
        Object.assign(marq.style, { left: l + 'px', top: t + 'px', width: (rgt - l) + 'px', height: (b - t) + 'px' });
        marq.hidden = false;
        sel = new Set(base);
        for (const n of c.notes) {
          const nx0 = n.t * pps, nx1 = nx0 + Math.max(4, n.d * pps), ny0 = rowOf(n.p) * ROW, ny1 = ny0 + ROW;
          if (nx1 >= l && nx0 <= rgt && ny1 >= t && ny0 <= b) sel.add(n);
        }
        drawNotes(); drawVel();
      };
      paint(e);
      const up = () => { marq.hidden = true; document.removeEventListener('pointermove', paint); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
      document.addEventListener('pointermove', paint); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
      return;
    } else {
      // 빈 칸 = 새 노트 — 클릭한 칸의 격자 시작에, 마지막 길이로
      sel = new Set();
      const abs = floorToGrid(c.start + x / pps, origin, step);
      n = { t: Math.max(0, abs - c.start), d: lastLen || step, p: pitchAt(y), v: 0.8 };
      c.notes.push(n); sel = new Set([n]);
      mode = 'move';
      o.onPreview(n.p, true, n.v); setTimeout(() => o.onPreview(n.p, false), 180);
    }
    const group = [...sel];
    const orig = group.map(m => ({ m, t: m.t, p: m.p, d: m.d }));
    const x0 = x, y0 = y;
    let changed = !noteEl, lastPitch = n.p;
    drawNotes();
    const move = (ev) => {
      const q = localPos(ev);
      if (mode === 'resize') {
        for (const g of orig) {
          const rawEnd = c.start + g.t + g.d + (q.x - x0) / pps;
          const endAbs = ev.altKey ? rawEnd : roundToGrid(rawEnd, origin, step);   // Alt = 격자 무시(FL)
          g.m.d = Math.max(step / 2, endAbs - (c.start + g.t));
        }
        lastLen = n.d;
      } else {
        const dp = Math.round((y0 - q.y) / ROW);
        const rawAbs = c.start + orig.find(g => g.m === n).t + (q.x - x0) / pps;
        const anchorAbs = ev.altKey ? rawAbs : roundToGrid(rawAbs, origin, step);
        const dt = anchorAbs - (c.start + orig.find(g => g.m === n).t);
        const minT = Math.min(...orig.map(g => g.t));
        const dtc = Math.max(dt, -minT);   // 클립 앞으로는 못 나간다
        for (const g of orig) { g.m.t = g.t + dtc; g.m.p = Math.max(0, Math.min(127, g.p + dp)); }
        if (n.p !== lastPitch) { o.onPreview(lastPitch, false); o.onPreview(n.p, true); setTimeout(() => o.onPreview(n.p, false), 150); lastPitch = n.p; }
      }
      changed = true;
      drawNotes(); drawVel();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (mode === 'move' && noteEl) lastLen = n.d;
      if (!changed && clonedFrom) {   // Shift+클릭만 하고 안 끌었으면 복제본을 거둔다(겹친 채 남지 않게)
        c.notes = c.notes.filter(m => !clonedFrom.clones.has(m)); sel = clonedFrom.src; drawNotes(); drawVel(); return;
      }
      if (changed) commit(before);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', up);
  });
  // Ctrl+휠 = 가로 확대/축소(커서 자리 고정)
  scroll.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = scroll.getBoundingClientRect();
    const cx = e.clientX - r.left - KEYS_W + scroll.scrollLeft;
    const tAt = cx / pps;
    pps = Math.max(MIN_PPS, Math.min(MAX_PPS, pps * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    redraw();
    scroll.scrollLeft = tAt * pps - (e.clientX - r.left - KEYS_W);
  }, { passive: false });

  // 키보드 — 피아노롤이 열려 있는 동안 Delete·Ctrl+A·↑↓·Esc 는 여기서 먼저 처리한다
  // (안 그러면 스튜디오 단축키가 받아서 클립 통째 삭제 등이 일어난다). 타이핑 키보드 연주 중엔
  // ↑↓·Esc 를 연주 모드가 먼저 가져간다(capture 순서).
  function onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' && t.type !== 'range' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const c = clip(); if (!c) return;
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.code === 'Escape') { stop(); close(); return; }
    if ((e.code === 'Delete' || e.code === 'Backspace') && sel.size) {
      stop(); const before = snapshot();
      c.notes = c.notes.filter(n => !sel.has(n)); sel = new Set(); commit(before); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') { stop(); sel = new Set(c.notes); drawNotes(); drawVel(); return; }
    // 노트 복사·잘라내기·붙여넣기 — 타임라인의 클립 복사로 새지 않게 여기서 끝낸다
    if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyC' || e.code === 'KeyX')) {
      stop(); if (!sel.size) return;
      _noteClipboard = copyNotes([...sel]);
      if (e.code === 'KeyX') { const before = snapshot(); c.notes = c.notes.filter(n => !sel.has(n)); sel = new Set(); commit(before); }
      o.flash?.(o.tr('studio.p.copied', { n: _noteClipboard.length }));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyV') {
      stop(); if (!_noteClipboard || !_noteClipboard.length) return;
      const before = snapshot();
      // 자리: 우클릭으로 찍어 둔 칸(음높이까지) → 없으면 재생선(클립 안일 때) → 없으면 클립 처음, 음높이는 그대로
      const at = anchor ? anchor.t : (phRel >= 0 && phRel <= c.dur ? floorToGrid(c.start + phRel, o.origin(), o.stepSec()) - c.start : 0);
      const added = pasteNotes(_noteClipboard, Math.max(0, at), anchor ? anchor.p : null);
      c.notes.push(...added); sel = new Set(added);
      commit(before); return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyB' && sel.size) {   // FL Ctrl+B — 선택을 바로 뒤에 복제
      stop(); const before = snapshot();
      const ns = [...sel], step = o.stepSec();
      const t0 = Math.min(...ns.map(n => n.t)), t1 = Math.max(...ns.map(n => n.t + n.d));
      const span = Math.max(step, Math.ceil((t1 - t0) / step - 1e-6) * step);
      const added = ns.map(n => ({ ...n, t: n.t + span }));
      c.notes.push(...added); sel = new Set(added);
      commit(before); return;
    }
    if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && sel.size && !e.ctrlKey && !e.altKey) {   // 격자 한 칸씩
      stop(); const before = snapshot();
      const d = (e.code === 'ArrowRight' ? 1 : -1) * o.stepSec();
      const minT = Math.min(...[...sel].map(n => n.t));
      const dd = Math.max(d, -minT);
      for (const n of sel) n.t += dd;
      commit(before); return;
    }
    if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && sel.size && !e.ctrlKey && !e.altKey) {
      stop(); const before = snapshot();
      const d = (e.code === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      for (const n of sel) n.p = Math.max(0, Math.min(127, n.p + d));
      commit(before); return;
    }
  }
  document.addEventListener('keydown', onKey, true);
  $q('.pr-x').addEventListener('click', () => close());
  // 재생 바 — 재생은 클립 처음부터(연주 중이면 정지). "이 트랙만"은 피아노롤이 열려 있는 동안만의 임시 솔로.
  const playBtn = $q('.pr-play'), soloBtn = $q('.pr-solo');
  playBtn.addEventListener('click', () => { o.onPlay(); });
  let soloOn = false;
  soloBtn.addEventListener('click', () => { soloOn = !soloOn; soloBtn.classList.toggle('on', soloOn); soloBtn.setAttribute('aria-pressed', String(soloOn)); o.onSolo(soloOn); });
  $q('.pr-q').addEventListener('click', () => { o.onQuantize(); });
  const gs = $q('.pr-gridsel select');
  if (gs) { gs.value = o.quantLabel(); gs.addEventListener('change', () => { o.setDiv(gs.value); redraw(); }); }

  function close() {
    if (soloOn) { soloOn = false; o.onSolo(false); }
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    o.onClose();
  }
  // 처음 배율 — 클립(최소 1마디)이 화면 폭에 들어오게, 세로는 노트들 가운데(없으면 C4)로
  pps = Math.max(MIN_PPS, Math.min(MAX_PPS, (scroll.clientWidth - KEYS_W - 40) / Math.max(clip0.dur, o.secPerBar())));
  redraw();
  const ps = clip0.notes.map(n => n.p);
  const mid = ps.length ? (Math.min(...ps) + Math.max(...ps)) / 2 : 60;
  scroll.scrollTop = Math.max(0, rowOf(Math.round(mid)) * ROW - scroll.clientHeight / 2);

  return {
    close,
    refresh() { const c = clip(); if (!c) { close(); return; } sel = new Set([...sel].filter(n => c.notes.includes(n))); redraw(); },
    setPlayhead(relSec) {
      phRel = relSec;
      const ph = $q('.pr-ph'); ph.style.left = (relSec * pps) + 'px'; ph.hidden = relSec < 0;
      const t = Math.max(0, relSec); $q('.pr-time').textContent = `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`;
    },
    setPlaying(on) { playBtn.innerHTML = on ? '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="8" height="8" rx="1"/></svg>' : '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 3.2v9.6L12.5 8z"/></svg>'; playBtn.classList.toggle('on', !!on); },
    clipId: clip0.id,
  };
}
