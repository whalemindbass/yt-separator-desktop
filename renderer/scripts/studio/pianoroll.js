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
    <div class="pr-scroll"><div class="pr-canvas"><div class="pr-keys"></div><div class="pr-grid"><div class="pr-lines"></div><div class="pr-notes"></div><div class="pr-end"></div><div class="pr-ph"></div></div></div></div>`;
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
  $q('.pr-keys').innerHTML = Array.from({ length: 128 }, (_, i) => {
    const p = 127 - i, nm = noteName(p), black = nm.includes('#');
    return `<div class="pr-key ${black ? 'b' : 'w'}${nm.startsWith('C') && !black ? ' c' : ''}" data-p="${p}">${nm.startsWith('C') && !black ? nm : ''}</div>`;
  }).join('');
  $q('.pr-keys').addEventListener('pointerdown', (e) => {
    const k = e.target.closest('.pr-key'); if (!k) return;
    const p = Number(k.dataset.p); o.onPreview(p, true);
    const up = () => { o.onPreview(p, false); document.removeEventListener('pointerup', up); };
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
  function redraw() { drawLines(); drawNotes(); }
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
    if (e.button === 2) {   // 우클릭 = 지우기
      if (!noteEl) return;
      const before = snapshot();
      const n = c.notes[Number(noteEl.dataset.i)];
      c.notes = c.notes.filter(m => m !== n); sel.delete(n);
      commit(before); return;
    }
    if (e.button !== 0) return;
    e.preventDefault();
    const before = snapshot();
    let n, mode;
    if (noteEl) {
      n = c.notes[Number(noteEl.dataset.i)];
      const r = noteEl.getBoundingClientRect();
      mode = (r.right - e.clientX) <= 6 ? 'resize' : 'move';
      if (e.ctrlKey || e.metaKey) { if (sel.has(n)) sel.delete(n); else sel.add(n); drawNotes(); return; }
      if (!sel.has(n)) sel = new Set([n]);
    } else {
      // 빈 칸 = 새 노트 — 클릭한 칸의 격자 시작에, 마지막 길이로
      if (!(e.ctrlKey || e.metaKey)) sel = new Set();
      const abs = floorToGrid(c.start + x / pps, origin, step);
      n = { t: Math.max(0, abs - c.start), d: lastLen || step, p: pitchAt(y), v: 0.8 };
      c.notes.push(n); sel = new Set([n]);
      mode = 'move';
      o.onPreview(n.p, true); setTimeout(() => o.onPreview(n.p, false), 180);
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
          const endAbs = roundToGrid(c.start + g.t + g.d + (q.x - x0) / pps, origin, step);
          g.m.d = Math.max(step / 2, endAbs - (c.start + g.t));
        }
        lastLen = n.d;
      } else {
        const dp = Math.round((y0 - q.y) / ROW);
        const anchorAbs = roundToGrid(c.start + orig.find(g => g.m === n).t + (q.x - x0) / pps, origin, step);
        const dt = anchorAbs - (c.start + orig.find(g => g.m === n).t);
        const minT = Math.min(...orig.map(g => g.t));
        const dtc = Math.max(dt, -minT);   // 클립 앞으로는 못 나간다
        for (const g of orig) { g.m.t = g.t + dtc; g.m.p = Math.max(0, Math.min(127, g.p + dp)); }
        if (n.p !== lastPitch) { o.onPreview(lastPitch, false); o.onPreview(n.p, true); setTimeout(() => o.onPreview(n.p, false), 150); lastPitch = n.p; }
      }
      changed = true;
      drawNotes();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', up);
      if (mode === 'move' && noteEl) lastLen = n.d;
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
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA') { stop(); sel = new Set(c.notes); drawNotes(); return; }
    if ((e.code === 'ArrowUp' || e.code === 'ArrowDown') && sel.size && !e.ctrlKey && !e.altKey) {
      stop(); const before = snapshot();
      const d = (e.code === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      for (const n of sel) n.p = Math.max(0, Math.min(127, n.p + d));
      commit(before); return;
    }
  }
  document.addEventListener('keydown', onKey, true);
  $q('.pr-x').addEventListener('click', () => close());
  $q('.pr-q').addEventListener('click', () => { o.onQuantize(); });
  const gs = $q('.pr-gridsel select');
  if (gs) { gs.value = o.quantLabel(); gs.addEventListener('change', () => { o.setDiv(gs.value); redraw(); }); }

  function close() {
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
    setPlayhead(relSec) { const ph = $q('.pr-ph'); ph.style.left = (relSec * pps) + 'px'; ph.hidden = relSec < 0; },
    clipId: clip0.id,
  };
}
