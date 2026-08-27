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

// ── 되돌리기 — 이 탭 로컬(엔진·스튜디오와 무관). 핵심 편집(트랙 추가/삭제, 클립
// 이동/트림/분할/삭제)만 담는다 — 색·이름·숨김 같은 사소한 건 되돌려도 아쉬울 게 적어 뺐다.
let _undoStack = [], _redoStack = [];
function pushUndo(undo, redo) {
  _undoStack.push({ undo, redo });
  if (_undoStack.length > 100) _undoStack.shift();
  _redoStack.length = 0;
}
function doUndo() {
  const e = _undoStack.pop(); if (!e) return;
  e.undo(); _redoStack.push(e);
  ensureLayers(); renderLanes();
}
function doRedo() {
  const e = _redoStack.pop(); if (!e) return;
  e.redo(); _undoStack.push(e);
  ensureLayers(); renderLanes();
}

// ── 자동 저장/복원 — library.json 처럼 실제 파일로(usageLog.json 과 같은 패턴). 프로젝트가
// 하나뿐이라 "저장" 버튼 없이 편집할 때마다 조용히 저장하고, 탭에 들어올 때 그대로 복원한다.
let _saveTimer = null;
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    api.videoProject.save({
      tracks: _veTracks.map(({ id, name, color, height, hidden }) => ({ id, name, color, height, hidden })),
      clips: _veClips.map(({ id, trackId, file, name, start, inOff, srcDur, dur, w, h, hasAudio }) =>
        ({ id, trackId, file, name, start, inOff, srcDur, dur, w, h, hasAudio })),
    });
  }, 600);
}
let _loaded = false;
async function loadProject() {
  if (_loaded) return; _loaded = true;
  const p = await api.videoProject.load();
  if (p?.tracks?.length) {
    _veTracks = p.tracks;
    _veClips = p.clips || [];
    _trackSeq = Math.max(0, ..._veTracks.map(t => t.id));
    _clipSeq = Math.max(0, ..._veClips.map(c => c.id));
    ensureLayers();
  }
}

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

// ── 미리보기 합성 — 트랙마다 <video> 두 장(a/b). 같은 트랙에서 클립 둘을 겹치게 끌어다
// 놓으면(Vegas Pro 관례) 그 겹친 구간만큼 자동으로 크로스페이드된다 — 트랜지션을 따로
// "추가"하는 UI 없이 겹친 정도가 곧 페이드 길이다. z-index = 트랙 순서(뒤에 올린 트랙이 위).
const _layerEls = new Map();   // trackId → {a,b: <video>}
function ensureLayers() {
  const host = $('ve-preview'); if (!host) return;
  const wanted = new Set(_veTracks.map(t => t.id));
  for (const [id, pair] of _layerEls) if (!wanted.has(id)) { pair.a.remove(); pair.b.remove(); _layerEls.delete(id); }
  // Vegas Pro 관례: 트랙 목록 맨 위(배열 0번)가 합성에서 맨 앞(최상위 레이어)이 된다.
  _veTracks.forEach((t, i) => {
    let pair = _layerEls.get(t.id);
    if (!pair) {
      const mk = () => { const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; host.appendChild(v); return v; };
      pair = { a: mk(), b: mk() };
      _layerEls.set(t.id, pair);
    }
    const z = String(_veTracks.length - i);
    pair.a.style.zIndex = z; pair.b.style.zIndex = z;
  });
}
function clipAt(trackId, t) {
  return _veClips.find(c => c.trackId === trackId && t >= c.start && t < c.start + c.dur) || null;
}
// 한 트랙 안에서 시간 t 를 덮는 클립들(보통 1개, 겹친 구간이면 2개 — 먼저 시작한 게 먼저)
function clipsAt(trackId, t) {
  return _veClips
    .filter(c => c.trackId === trackId && t >= c.start && t < c.start + c.dur)
    .sort((x, y) => x.start - y.start);
}
function driveLayer(el, clip, t) {
  el.hidden = false;
  if (el.dataset.loadedSrc !== clip.file) { el.src = toYtsepUrl(clip.file); el.dataset.loadedSrc = clip.file; }
  const target = Math.min(clip.inOff + (t - clip.start), (el.duration || clip.srcDur) - 0.02);
  if (Math.abs(el.currentTime - target) > 0.1) { try { el.currentTime = Math.max(0, target); } catch {} }
  if (_playing && el.paused) el.play().catch(() => {});
  if (!_playing && !el.paused) el.pause();
}
function hideLayer(el) { el.hidden = true; el.style.opacity = ''; if (!el.paused) el.pause(); }
function syncPreview(t) {
  let any = false;
  for (const track of _veTracks) {
    const pair = _layerEls.get(track.id); if (!pair) continue;
    const { a, b } = pair;
    if (track.hidden) { hideLayer(a); hideLayer(b); continue; }
    const here = clipsAt(track.id, t);
    if (here.length >= 2) {
      const outClip = here[0], inClip = here[1];   // outClip: 먼저 시작해 곧 끝남 · inClip: 나중에 들어와 이어감
      const overlapStart = inClip.start, overlapEnd = outClip.start + outClip.dur;
      const mix = overlapEnd > overlapStart ? Math.min(1, Math.max(0, (t - overlapStart) / (overlapEnd - overlapStart))) : 1;
      driveLayer(a, outClip, t); a.style.opacity = String(1 - mix);
      driveLayer(b, inClip, t); b.style.opacity = String(mix);
      any = true;
    } else if (here.length === 1) {
      driveLayer(a, here[0], t); a.style.opacity = '1';
      hideLayer(b);
      any = true;
    } else {
      hideLayer(a); hideLayer(b);
    }
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
  if (_loaded) scheduleSave();   // 복원 도중(초기 렌더)엔 저장할 필요 없다
}

// ── 트랙/레인 ────────────────────────────────────────
function newVideoTrack(pushHistory = true) {
  const id = nextTrackId();
  const color = TRACK_COLORS[(_veTracks.length) % TRACK_COLORS.length];
  const track = { id, name: '', color, height: DEFAULT_LANE_H, hidden: false };
  // Vegas Pro 관례: 새 비디오 트랙은 목록 맨 위(= 합성 맨 앞)에 들어간다.
  _veTracks.unshift(track);
  if (pushHistory) {
    pushUndo(
      () => { _veTracks = _veTracks.filter(t => t.id !== id); _veClips = _veClips.filter(c => c.trackId !== id); },
      () => { _veTracks.unshift(track); },
    );
  }
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
      const removedClips = _veClips.filter(c => c.trackId === vt.id);
      const removedIdx = _veTracks.indexOf(vt);
      pushUndo(
        () => { _veTracks.splice(removedIdx, 0, vt); _veClips.push(...removedClips); },
        () => { _veTracks = _veTracks.filter(t => t.id !== vt.id); _veClips = _veClips.filter(c => c.trackId !== vt.id); },
      );
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
    if (c.start !== startStart || c.trackId !== startTrackId) {
      const endStart = c.start, endTrackId = c.trackId;
      pushUndo(
        () => { c.start = startStart; c.trackId = startTrackId; layout(); },
        () => { c.start = endStart; c.trackId = endTrackId; layout(); },
      );
    }
    layout();
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
    const up = () => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      if (c.start !== start0 || c.dur !== dur0) {
        const endStart = c.start, endDur = c.dur, endInOff = c.inOff;
        pushUndo(
          () => { c.start = start0; c.dur = dur0; c.inOff = inOff0; layout(); },
          () => { c.start = endStart; c.dur = endDur; c.inOff = endInOff; layout(); },
        );
      }
      layout();
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
}
function splitAtPlayhead() {
  if (_selClipId == null) return;
  const c = _veClips.find(x => x.id === _selClipId); if (!c) return;
  const t = _playheadSec;
  if (t <= c.start || t >= c.start + c.dur) return;
  const origDur = c.dur;
  const rightDur = c.start + c.dur - t;
  const right = { ...c, id: nextClipId(), start: t, dur: rightDur, inOff: c.inOff + (t - c.start) };
  c.dur = t - c.start;
  _veClips.push(right);
  pushUndo(
    () => { c.dur = origDur; _veClips = _veClips.filter(x => x !== right); },
    () => { c.dur = t - c.start; _veClips.push(right); },
  );
  layout();
}
function deleteSelected() {
  if (_selClipId == null) return;
  const removed = _veClips.find(c => c.id === _selClipId); if (!removed) return;
  const idx = _veClips.indexOf(removed);
  pushUndo(
    () => { _veClips.splice(idx, 0, removed); },
    () => { _veClips = _veClips.filter(c => c !== removed); },
  );
  _veClips = _veClips.filter(c => c.id !== _selClipId);
  _selClipId = null;
  layout();
}

// ── 내보내기 ────────────────────────────────────────
// "이 순간엔 어느 트랙이 위인가"만으로 한 줄 구간 목록을 만든다(트랙 간엔 여전히 컷 —
// 오버레이/PIP 는 다음 단계). 같은 트랙에서 클립 둘이 겹치면 미리보기와 똑같이 그 겹친
// 구간 전체를 크로스페이드 구간 하나로 묶어(xfade:true) 내보낸다.
function buildEDL() {
  const bounds = new Set([0]);
  for (const c of _veClips) { bounds.add(c.start); bounds.add(c.start + c.dur); }
  const pts = [...bounds].sort((a, b) => a - b);
  const segs = [];
  let skipUntil = -Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b - a < 0.001) continue;
    if (a < skipUntil - 0.001) continue;   // 크로스페이드 구간을 이미 통째로 넣었다
    const mid = (a + b) / 2;
    let winners = [];
    for (const track of _veTracks) {   // 배열 0번 = 목록 맨 위 = 합성 맨 앞 → 우선
      if (track.hidden) continue;
      const here = clipsAt(track.id, mid);
      if (here.length) { winners = here; break; }
    }
    if (!winners.length) continue;   // 아무 트랙도 없는 구간은 건너뛴다(내보낸 결과엔 그 틈이 없다)
    if (winners.length >= 2) {
      const outC = winners[0], inC = winners[1];
      const overlapStart = inC.start, overlapEnd = outC.start + outC.dur;
      segs.push({
        xfade: true, dur: overlapEnd - overlapStart,
        fileA: outC.file, aIn: outC.inOff + (overlapStart - outC.start), hasAudioA: outC.hasAudio !== false,
        fileB: inC.file, bIn: inC.inOff + (overlapStart - inC.start), hasAudioB: inC.hasAudio !== false,
      });
      skipUntil = overlapEnd;
      continue;
    }
    const winner = winners[0];
    const segStart = winner.inOff + (a - winner.start);
    const segEnd = winner.inOff + (b - winner.start);
    const last = segs[segs.length - 1];
    if (last && !last.xfade && last.file === winner.file && Math.abs(last.end - segStart) < 0.005) last.end = segEnd;
    else segs.push({ file: winner.file, start: segStart, end: segEnd, hasAudio: winner.hasAudio !== false });
  }
  return segs;
}
async function runExport() {
  const segs = buildEDL();
  if (!segs.length) { flash(tr('video.needImport')); return; }
  const r = await api.dialog.saveAs('export.mp4', ['mp4']);
  if (!r || !r.ok) return;
  setPlaying(false);
  const btn = $('ve-export');
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '0%'; }
  const totalSec = segs.reduce((s, x) => s + (x.xfade ? x.dur : (x.end - x.start)), 0) || 1;
  const off = api.video.onExportProgress(({ outTimeMs }) => {
    if (btn) btn.textContent = Math.max(0, Math.min(99, Math.round((outTimeMs / 1e6) / totalSec * 100))) + '%';
  });
  let res;
  try { res = await api.video.export({ segments: segs, outPath: r.filePath }); }
  finally { off?.(); if (btn) { btn.disabled = false; btn.textContent = label; } }
  flash(res.ok ? tr('video.exportDone') : tr('video.exportFail', { err: res.error || '' }));
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
  const createdTrack = tid == null;
  if (createdTrack) tid = newVideoTrack(false);   // 되돌리기는 아래서 임포트 전체를 한 덩어리로 묶는다
  const newTrackRef = createdTrack ? _veTracks.find(t => t.id === tid) : null;
  let cursor = 0;
  for (const c of _veClips.filter(x => x.trackId === tid)) cursor = Math.max(cursor, c.start + c.dur);
  const added = [];
  for (const p of paths) {
    const meta = await probeVideo(p);
    if (!meta.dur) continue;
    const { hasAudio } = await api.video.probeAudio(p);
    const name = p.split(/[\\/]/).pop();
    const clip = { id: nextClipId(), trackId: tid, file: p, name, start: cursor, inOff: 0, srcDur: meta.dur, dur: meta.dur, w: meta.w, h: meta.h, hasAudio };
    _veClips.push(clip);
    added.push(clip);
    cursor += meta.dur;
  }
  if (added.length) {
    pushUndo(
      () => {
        _veClips = _veClips.filter(c => !added.includes(c));
        if (createdTrack) _veTracks = _veTracks.filter(t => t.id !== tid);
      },
      () => {
        if (createdTrack) _veTracks.unshift(newTrackRef);
        _veClips.push(...added);
      },
    );
  }
  ensureLayers();
  layout();
  if (added.length) flash(tr('video.importing', { n: added.length }));
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
  $('ve-undo')?.addEventListener('click', () => doUndo());
  $('ve-redo')?.addEventListener('click', () => doRedo());
  $('ve-empty-import')?.addEventListener('click', () => pickImportVideo());
  $('ve-seek0')?.addEventListener('click', () => seekTo(0));
  $('ve-play')?.addEventListener('click', () => setPlaying(!_playing));
  $('ve-zoom-in')?.addEventListener('click', () => { _pxPerSec = Math.min(400, _pxPerSec * 1.3); layout(); });
  $('ve-zoom-out')?.addEventListener('click', () => { _pxPerSec = Math.max(4, _pxPerSec / 1.3); layout(); });
  $('ve-export')?.addEventListener('click', () => runExport());
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
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); doRedo(); }
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

export async function initVideoEditor() {
  wire();
  await loadProject();
  if (!_veTracks.length) ensureLayers();
  renderLanes();
  layout();
}
