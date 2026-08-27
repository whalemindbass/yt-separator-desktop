'use strict';
// 영상 편집 탭 — 멀티트랙 비디오 타임라인. 스튜디오(오디오 DAW)와는 완전히 분리된 화면이다.
//   - JUCE 엔진과 무관하다: 재생/합성은 전부 Chromium 의 <video> 로 렌더러 안에서 처리한다.
//   - 트랙/클립 상태는 이 모듈 로컬에만 있다(엔진에 동기화할 대상이 없다).
//   - 시간은 전부 초 단위로만 다룬다 — 엔진 경계가 없으니 샘플 변환도 없다.
import { t as tr } from './i18n.js';
import { esc } from './studio/util.js';
import { toYtsepUrl } from './player.js';
import { getClipThumb } from './video-thumbs.js';

const api = window.yssApi;
const $ = (id) => document.getElementById(id);

const HEAD_W = 172;
const DEFAULT_LANE_H = 72;
const TRACK_COLORS = ['#35d1a6', '#4a90d9', '#e2a03f', '#c774e0', '#e05a5a', '#6ad1e0'];

let _wired = false;
let _veTracks = [];   // [{id, name, color, height, hidden}]
let _veClips = [];    // [{id, trackId, file, name, start, inOff, srcDur, dur, w, h}]
let _trackSeq = 0, _clipSeq = 0;
let _pxPerSec = 40;
let _selClipId = null;
let _dragging = false;   // 드래그 중엔 rebuild 로 DOM 을 통째로 갈지 않는다(포인터 이벤트가 끊긴다)

function nextTrackId() { return ++_trackSeq; }
function nextClipId() { return ++_clipSeq; }

// ── 재생 시계 (엔진 없음 — rAF 로 직접 잰다) ──────────────
let _playing = false;
let _playheadSec = 0;
let _playWallStart = 0, _playSecStart = 0;
let _rafId = null;

function nowSec() {
  if (!_playing) return _playheadSec;
  return _playSecStart + (performance.now() - _playWallStart) / 1000;
}
function seekTo(sec) {
  _playheadSec = Math.max(0, sec);
  _playSecStart = _playheadSec; _playWallStart = performance.now();
  updatePlayheadUI();
  syncPreview(_playheadSec);
}
function tick() {
  if (!_playing) return;
  const t = nowSec();
  const end = fullSec();
  if (t >= end) { setPlaying(false); seekTo(end); return; }
  _playheadSec = t;
  updatePlayheadUI();
  syncPreview(t);
  _rafId = requestAnimationFrame(tick);
}
function setPlaying(on) {
  _playing = on;
  const btn = $('ve-play');
  if (btn) { btn.classList.toggle('on', on); btn.textContent = on ? '⏸' : '▶'; }
  if (on) {
    _playSecStart = _playheadSec; _playWallStart = performance.now();
    _rafId = requestAnimationFrame(tick);
  } else if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
}
function updatePlayheadUI() {
  const ph = $('ve-playhead'); if (ph) ph.style.transform = `translate3d(${HEAD_W + _playheadSec * _pxPerSec}px,0,0)`;
  const tc = $('ve-time'); if (tc) tc.textContent = fmtTC(_playheadSec);
}
function fmtTC(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ── 미리보기 합성 — 트랙마다 <video> 한 장, z-index = 트랙 순서(뒤에 올린 트랙이 위) ──
const _layerEls = new Map();   // trackId → <video>
function ensureLayers() {
  const host = $('ve-preview'); if (!host) return;
  const wanted = new Set(_veTracks.map(t => t.id));
  for (const [id, el] of _layerEls) if (!wanted.has(id)) { el.remove(); _layerEls.delete(id); }
  // Vegas Pro 관례: 트랙 목록 맨 위(배열 0번)가 합성에서 맨 앞(최상위 레이어)이 된다.
  _veTracks.forEach((t, i) => {
    let el = _layerEls.get(t.id);
    if (!el) {
      el = document.createElement('video');
      el.muted = true; el.playsInline = true; el.preload = 'auto';
      host.appendChild(el);
      _layerEls.set(t.id, el);
    }
    el.style.zIndex = String(_veTracks.length - i);
    el.dataset.loadedSrc = el.dataset.loadedSrc || '';
  });
}
function clipAt(trackId, t) {
  return _veClips.find(c => c.trackId === trackId && t >= c.start && t < c.start + c.dur) || null;
}
function syncPreview(t) {
  let any = false;
  for (const track of _veTracks) {
    const el = _layerEls.get(track.id); if (!el) continue;
    const clip = track.hidden ? null : clipAt(track.id, t);
    if (!clip) { el.hidden = true; if (!el.paused) el.pause(); continue; }
    any = true;
    el.hidden = false;
    if (el.dataset.loadedSrc !== clip.file) { el.src = toYtsepUrl(clip.file); el.dataset.loadedSrc = clip.file; }
    const target = Math.min(clip.inOff + (t - clip.start), (el.duration || clip.srcDur) - 0.02);
    if (Math.abs(el.currentTime - target) > 0.1) { try { el.currentTime = Math.max(0, target); } catch {} }
    if (_playing && el.paused) el.play().catch(() => {});
    if (!_playing && !el.paused) el.pause();
  }
  return any;
}

// ── 타임라인 크기 ──────────────────────────────────────
function fullSec() {
  const sc = $('ve-tscroll');
  const vw = sc ? sc.clientWidth - HEAD_W : 800;
  let content = 4;
  for (const c of _veClips) content = Math.max(content, c.start + c.dur);
  return Math.max(content + 4, vw / _pxPerSec);
}
const timelineW = () => Math.max(1, fullSec() * _pxPerSec);

function layout() {
  const w = timelineW();
  const lanes = $('ve-lanes'); if (!lanes) return;
  lanes.style.width = (HEAD_W + w) + 'px';
  const ruler = $('ve-ruler');
  if (ruler) {
    ruler.style.width = w + 'px';
    ruler.innerHTML = '';
    const step = _pxPerSec >= 80 ? 1 : _pxPerSec >= 30 ? 5 : 10;   // 초 단위 눈금 간격
    for (let s = 0; s <= fullSec() + 0.001; s += step) {
      const tk = document.createElement('span');
      tk.className = 'tk'; tk.style.left = (s * _pxPerSec) + 'px';
      const lbl = document.createElement('span'); lbl.textContent = fmtTC(s).replace(/\.\d+$/, '');
      tk.appendChild(lbl);
      ruler.appendChild(tk);
    }
  }
  renderClips();
  updatePlayheadUI();
  syncPreview(nowSec());   // 임포트·트림·분할·삭제 등으로 배치가 바뀌면 미리보기도 바로 반영
  const empty = $('ve-empty'); if (empty) empty.hidden = _veClips.length > 0;
}

// ── 트랙/레인 ────────────────────────────────────────
function newVideoTrack() {
  const id = nextTrackId();
  const color = TRACK_COLORS[(_veTracks.length) % TRACK_COLORS.length];
  // Vegas Pro 관례: 새 비디오 트랙은 목록 맨 위(= 합성 맨 앞)에 들어간다.
  _veTracks.unshift({ id, name: '', color, height: DEFAULT_LANE_H, hidden: false });
  ensureLayers();
  renderLanes();
  return id;
}
function trackLabel(vt, idx) { return vt.name || tr('video.trackN', { n: idx + 1 }); }

function renderLanes() {
  const lanes = $('ve-lanes'); if (!lanes) return;
  lanes.querySelectorAll('.ve-lane').forEach(el => el.remove());
  _veTracks.forEach((vt, idx) => {
    const lane = document.createElement('div');
    lane.className = 've-lane';
    lane.style.setProperty('--c', vt.color);
    if (vt.height) lane.style.height = vt.height + 'px';
    lane.dataset.trackId = String(vt.id);
    lane.innerHTML = `
      <div class="ve-head">
        <div class="nm">
          <span class="ve-reorder" data-i18n-title="video.dragReorder" title="드래그로 순서 변경">⠿</span>
          <i data-i18n-title="video.changeColor" title="색 변경"></i>
          <span class="lbl" data-i18n-title="video.rename" title="이름 변경">${esc(trackLabel(vt, idx))}</span>
        </div>
        <div class="ve-ctrls">
          <button class="ve-hs ve-hide${vt.hidden ? ' on' : ''}" data-i18n-title="video.hide" title="숨기기">H</button>
          <button class="ve-hs ve-del" data-i18n-title="video.deleteTrack" title="트랙 삭제">✕</button>
        </div>
      </div>
      <div class="ve-area"></div>
      <div class="ve-lane-resize"></div>`;
    lane.querySelector('.ve-hide').addEventListener('click', (e) => {
      e.stopPropagation();
      vt.hidden = !vt.hidden;
      lane.querySelector('.ve-hide').classList.toggle('on', vt.hidden);
      syncPreview(nowSec());
    });
    lane.querySelector('.ve-del').addEventListener('click', (e) => {
      e.stopPropagation();
      _veClips = _veClips.filter(c => c.trackId !== vt.id);
      _veTracks = _veTracks.filter(t => t.id !== vt.id);
      ensureLayers(); renderLanes(); layout();
    });
    const lbl = lane.querySelector('.lbl');
    lbl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      const val = prompt(tr('video.rename'), trackLabel(vt, idx));
      if (val != null) { vt.name = val.trim(); lbl.textContent = trackLabel(vt, idx); }
    });
    const dot = lane.querySelector('.nm i');
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const ci = document.createElement('input');
      ci.type = 'color'; ci.value = vt.color;
      ci.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ci);
      ci.addEventListener('input', () => { vt.color = ci.value; lane.style.setProperty('--c', ci.value); });
      ci.addEventListener('change', () => ci.remove());
      ci.click();
    });
    const grip = lane.querySelector('.ve-lane-resize');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startY = e.clientY, base = lane.offsetHeight;
      const mv = (ev) => { const h = Math.max(DEFAULT_LANE_H, Math.min(240, base + (ev.clientY - startY))); vt.height = h; lane.style.height = h + 'px'; };
      const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    });
    lane.querySelector('.ve-reorder').addEventListener('pointerdown', (e) => wireReorder(e, vt));
    // 빈 영역 클릭 = 재생헤드 이동
    lane.querySelector('.ve-area').addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ve-clip')) return;
      const rect = e.currentTarget.getBoundingClientRect();
      seekTo((e.clientX - rect.left) / _pxPerSec);
    });
    lanes.appendChild(lane);
  });
  layout();
}
function wireReorder(e, vt) {
  e.preventDefault(); e.stopPropagation();
  const lanes = $('ve-lanes');
  const startY = e.clientY;
  const startIdx = _veTracks.indexOf(vt);
  const mv = (ev) => {
    const dy = ev.clientY - startY;
    const rowH = DEFAULT_LANE_H;
    let newIdx = Math.max(0, Math.min(_veTracks.length - 1, startIdx + Math.round(dy / rowH)));
    if (newIdx !== _veTracks.indexOf(vt)) {
      _veTracks.splice(_veTracks.indexOf(vt), 1);
      _veTracks.splice(newIdx, 0, vt);
      renderLanes();
    }
  };
  const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); ensureLayers(); };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
}

// ── 클립 ────────────────────────────────────────────
function paintThumbs(clip) {
  // renderClips() 가 통째로 다시 그려버렸을 수 있으니(비동기 완료 시점), 그때마다 지금
  // 화면에 있는 엘리먼트를 다시 찾는다 — 없으면(트랙 삭제 등으로 사라짐) 조용히 넘어간다.
  const el = document.querySelector(`.ve-clip[data-clip-id="${clip.id}"] .ve-thumbs`);
  if (!el || !clip._thumbUrls) return;
  el.innerHTML = clip._thumbUrls.map(u => `<img src="${u}" draggable="false">`).join('');
}
function renderClips() {
  document.querySelectorAll('.ve-lane').forEach(lane => {
    const trackId = Number(lane.dataset.trackId);
    const area = lane.querySelector('.ve-area');
    area.innerHTML = '';
    for (const c of _veClips.filter(x => x.trackId === trackId)) {
      const el = document.createElement('div');
      el.className = 've-clip' + (c.id === _selClipId ? ' sel' : '');
      el.style.left = (c.start * _pxPerSec) + 'px';
      el.style.width = Math.max(4, c.dur * _pxPerSec) + 'px';
      el.dataset.clipId = String(c.id);
      el.innerHTML = `<div class="ve-thumbs"></div><span class="ve-clip-lbl">${esc(c.name)}</span>
        <div class="ve-trim l"></div><div class="ve-trim r"></div>`;
      el.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('ve-trim')) return;
        _selClipId = c.id;
        wireMove(e, c, el);
      });
      el.addEventListener('dblclick', () => { seekTo(c.start); });
      wireTrim(el.querySelector('.ve-trim.l'), c, el, 'l');
      wireTrim(el.querySelector('.ve-trim.r'), c, el, 'r');
      area.appendChild(el);
      const cached = getClipThumb(c, _pxPerSec, toYtsepUrl, paintThumbs);
      if (cached) paintThumbs(c);
    }
  });
}
function snapSec(sec, excludeId) {
  const cand = [0];
  for (const c of _veClips) { if (c.id === excludeId) continue; cand.push(c.start, c.start + c.dur); }
  let best = sec, bestPx = 6;
  for (const edge of cand) { const d = Math.abs(sec - edge) * _pxPerSec; if (d < bestPx) { bestPx = d; best = edge; } }
  return best;
}
function wireMove(e, c, el) {
  e.preventDefault();
  const startX = e.clientX;
  const startStart = c.start;
  const startTrackId = c.trackId;
  const laneEls = [...document.querySelectorAll('.ve-lane')];
  _dragging = true;
  try { el.setPointerCapture(e.pointerId); } catch {}
  const mv = (ev) => {
    const dx = (ev.clientX - startX) / _pxPerSec;
    let ns = Math.max(0, snapSec(startStart + dx, c.id));
    c.start = ns;
    el.style.left = (c.start * _pxPerSec) + 'px';
    // 트랙 간 이동 — 포인터가 다른 레인 위에 있으면 그 트랙으로 옮긴다.
    // renderClips() 가 DOM 을 통째로 새로 그리므로, 드래그 중이던 el 은 그 순간
    // 떨어져 나간다(update 해도 화면에 안 보임) — 새로 그려진 같은 클립 엘리먼트를
    // 다시 잡아 el 을 갈아 끼운다(포인터 캡처는 새 엘리먼트로 옮겨줄 필요 없다 —
    // 리스너는 document 에 붙어 있어 계속 받는다).
    const laneUnder = laneEls.find(l => { const r = l.getBoundingClientRect(); return ev.clientY >= r.top && ev.clientY <= r.bottom; });
    if (laneUnder) {
      const tid = Number(laneUnder.dataset.trackId);
      if (tid !== c.trackId) {
        c.trackId = tid;
        renderClips();
        const fresh = document.querySelector(`.ve-clip[data-clip-id="${c.id}"]`);
        if (fresh) el = fresh;
      }
    }
  };
  const up = () => {
    document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
    _dragging = false;
    layout();
    if (c.start !== startStart || c.trackId !== startTrackId) { /* 이동 확정 — 되돌리기 스택은 다음 단계 */ }
  };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
}
function wireTrim(handle, c, el, dir) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    _selClipId = c.id;
    const startX = e.clientX;
    const start0 = c.start, dur0 = c.dur, inOff0 = c.inOff;
    try { handle.setPointerCapture(e.pointerId); } catch {}
    const mv = (ev) => {
      const dx = (ev.clientX - startX) / _pxPerSec;
      if (dir === 'l') {
        let ns = Math.max(0, Math.min(start0 + dur0 - 0.1, snapSec(start0 + dx, c.id)));
        const delta = ns - start0;
        if (inOff0 + delta < 0) return;   // 소스 시작보다 앞으로는 못 당김
        c.start = ns; c.dur = dur0 - delta; c.inOff = inOff0 + delta;
      } else {
        let ne = Math.max(start0 + 0.1, snapSec(start0 + dur0 + dx, c.id));
        c.dur = Math.min(ne - start0, c.srcDur - c.inOff);
      }
      el.style.left = (c.start * _pxPerSec) + 'px';
      el.style.width = Math.max(4, c.dur * _pxPerSec) + 'px';
    };
    const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); layout(); };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
}
function splitAtPlayhead() {
  if (_selClipId == null) return;
  const c = _veClips.find(x => x.id === _selClipId); if (!c) return;
  const t = _playheadSec;
  if (t <= c.start || t >= c.start + c.dur) return;
  const rightDur = c.start + c.dur - t;
  const right = { ...c, id: nextClipId(), start: t, dur: rightDur, inOff: c.inOff + (t - c.start) };
  c.dur = t - c.start;
  _veClips.push(right);
  layout();
}
function deleteSelected() {
  if (_selClipId == null) return;
  _veClips = _veClips.filter(c => c.id !== _selClipId);
  _selClipId = null;
  layout();
}

// ── 임포트 ──────────────────────────────────────────
function probeVideo(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => resolve({ dur: v.duration || 0, w: v.videoWidth || 0, h: v.videoHeight || 0 });
    v.onerror = () => resolve({ dur: 0, w: 0, h: 0 });
    v.src = toYtsepUrl(file);
  });
}
async function importVideoFiles(paths, trackId) {
  let tid = trackId;
  if (tid == null) tid = newVideoTrack();
  let cursor = 0;
  for (const c of _veClips.filter(x => x.trackId === tid)) cursor = Math.max(cursor, c.start + c.dur);
  let n = 0;
  for (const p of paths) {
    const meta = await probeVideo(p);
    if (!meta.dur) continue;
    const name = p.split(/[\\/]/).pop();
    _veClips.push({ id: nextClipId(), trackId: tid, file: p, name, start: cursor, inOff: 0, srcDur: meta.dur, dur: meta.dur, w: meta.w, h: meta.h });
    cursor += meta.dur;
    n++;
  }
  ensureLayers();
  layout();
  if (n) flash(tr('video.importing', { n }));
  else flash(tr('video.needImport'));
}
async function pickImportVideo() {
  const r = await api.dialog.pickVideoFiles();
  if (!r || !r.ok || !r.filePaths?.length) return;
  // 방금 만든(맨 위) 트랙이 아직 비어 있으면 거기로, 아니면 새 트랙을 만든다 —
  // "+트랙" 누르고 바로 "임포트" 눌렀을 때 트랙이 두 개로 늘어나지 않도록.
  const top = _veTracks[0];
  const reuse = top && !_veClips.some(c => c.trackId === top.id);
  importVideoFiles(r.filePaths, reuse ? top.id : null);
}

function flash(msg) {
  let el = document.getElementById('ve-toast');
  if (!el) {
    el = document.createElement('div'); el.id = 've-toast'; el.className = 'daw-toast';
    (document.querySelector('.video-body') || document.body).appendChild(el);
  }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._h); el._h = setTimeout(() => el.classList.remove('show'), 2200);
}

// ── 초기화 ──────────────────────────────────────────
function wire() {
  if (_wired) return; _wired = true;
  $('ve-add-track')?.addEventListener('click', () => newVideoTrack());
  $('ve-import')?.addEventListener('click', () => pickImportVideo());
  $('ve-empty-import')?.addEventListener('click', () => pickImportVideo());
  $('ve-seek0')?.addEventListener('click', () => seekTo(0));
  $('ve-play')?.addEventListener('click', () => setPlaying(!_playing));
  $('ve-zoom-in')?.addEventListener('click', () => { _pxPerSec = Math.min(400, _pxPerSec * 1.3); layout(); });
  $('ve-zoom-out')?.addEventListener('click', () => { _pxPerSec = Math.max(4, _pxPerSec / 1.3); layout(); });
  $('ve-export')?.addEventListener('click', () => flash(tr('video.exportSoon')));
  $('ve-tscroll')?.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    _pxPerSec = Math.max(4, Math.min(400, _pxPerSec * (e.deltaY < 0 ? 1.08 : 0.93)));
    layout();
  }, { passive: false });
  document.addEventListener('keydown', (e) => {
    const view = document.querySelector('.video-body');
    if (!view || view.hidden) return;
    if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!_playing); }
    else if (e.key === 's' || e.key === 'S') splitAtPlayhead();
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
  });
  // 파일 드래그&드롭 — 빈 영역/기존 트랙 위 모두 받는다
  const wrap = $('ve-tscroll');
  wrap?.addEventListener('dragover', (e) => e.preventDefault());
  wrap?.addEventListener('drop', (e) => {
    e.preventDefault();
    const paths = [...(e.dataTransfer?.files || [])].map(f => f.path).filter(Boolean);
    if (paths.length) importVideoFiles(paths, null);
  });
}

export function initVideoEditor() {
  wire();
  if (!_veTracks.length) ensureLayers();
  renderLanes();
  layout();
}
