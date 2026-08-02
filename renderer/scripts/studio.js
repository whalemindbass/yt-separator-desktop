// 스튜디오 DAW — 대형 영상 + 스템/녹음 트랙 + 저지연 엔진(JUCE)
//   엔진(오디오)=마스터 클럭. 영상은 muted 로 playhead 따라감(드리프트 보정).
import { Library } from './library.js';
import { toYtsepUrl, loadStemFilesToBuffers } from './player.js';

const api = window.yssApi;
const $ = (id) => document.getElementById(id);
// innerHTML 삽입 전 외부/사용자 유래 문자열 이스케이프 (yt 영상 제목·VST명·프리셋명 등)
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STEM_COLOR = {
  vocals: 'var(--stem-vocals)', drums: 'var(--stem-drums)',
  bass: 'var(--stem-bass)', other: 'var(--stem-other)',
  guitar: 'var(--stem-other)', piano: 'var(--stem-drums)', mine: 'var(--accent)',
};
const STEM_LABEL = { vocals: '보컬', drums: '드럼', bass: '베이스', other: '기타', guitar: '기타', piano: '피아노' };

let _wired = false, _started = false;
let _sr = 44100, _dur = 0, _pxPerSec = 12;
let _playing = false, _recArmed = false;
let _playStart = 0;   // 재생 시작점
let _returnOnStop = true;   // 정지 시 재생 시작 위치로 복귀 (옵션)
let _tracks = [];          // [{key,label,color,engineIndex}]
let _chain = [];              // 선택된 트랙의 FX 체인 미러 (_chainByTrack[_selTrack])
let _chainByTrack = {};       // trackId → [{id,index,name,hasEditor,bypass}]
let _selTrack = null;         // 선택(편집 대상) 녹음 트랙 id — 이펙트 패널 대상
let _activePresetId = null;
let _presetGather = null;     // 저장: {name,id?,states:{slotId:data},need:[ids],meta:[{index,bypass}],order:[ids]}
let _pendingPreset = null;    // 로드: {slots:[{index,bypass,data}]}

// ── FX 프리셋(톤) — 체인 전체 스냅샷 ──
function getPresets() { try { return JSON.parse(localStorage.getItem('yss:fx-presets') || '[]'); } catch { return []; } }
function setPresets(a) { try { localStorage.setItem('yss:fx-presets', JSON.stringify(a)); } catch {} }
function upsertPreset(p) { const a = getPresets(); const i = a.findIndex(x => x.id === p.id); if (i >= 0) a[i] = p; else a.push(p); setPresets(a); }

function startGather(opts) {   // 현재 트랙 체인 상태를 모아 프리셋 생성/갱신
  if (_selTrack == null) { flashTake('트랙을 선택하세요.'); return; }
  if (!_chain.length) { flashTake('추가된 VST가 없습니다.'); return; }
  _presetGather = { ...opts, states: {}, need: _chain.map(s => s.id), meta: _chain.map(s => ({ index: s.index, bypass: s.bypass })), order: _chain.map(s => s.id) };
  for (const s of _chain) api.engine.fxSaveState(_selTrack, s.id);
}
function loadPreset(p) {
  if (_selTrack == null) { flashTake('트랙을 선택하세요.'); return; }
  _activePresetId = p.id;
  showFxOverlay('톤 불러오는 중…');
  // 엔진이 선택 트랙 체인을 한 번에 재구성 (원자적) → fxChain 이벤트 오면 overlay 해제
  api.engine.fxSetChain(_selTrack, p.slots.map(s => ({ index: s.index, data: s.data, bypass: s.bypass })));
}
function showFxOverlay(msg) {
  const el = $('daw-fx-overlay'); if (!el) return;
  el.querySelector('.msg').textContent = msg || '';
  el.hidden = false;
}
function hideFxOverlay() { const el = $('daw-fx-overlay'); if (el) el.hidden = true; }
function openNameModal(title, def, onOk) {
  const host = $('daw-modal');
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>${title}</span><button class="x">✕</button></div>
    <div class="daw-modal-list" style="padding:16px">
      <input id="daw-name-in" class="daw-fx-select" style="margin:0" placeholder="톤 이름" />
      <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end"><button class="mini" id="daw-name-ok">저장</button></div>
    </div></div>`;
  host.hidden = false;
  const inp = $('daw-name-in'); inp.value = def || ''; inp.focus(); inp.select();
  const done = () => { const v = inp.value.trim(); host.hidden = true; if (v) onOk(v); };
  host.querySelector('.x').addEventListener('click', () => host.hidden = true);
  $('daw-name-ok').addEventListener('click', done);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
}
function openPresetPicker() {
  const ps = getPresets();
  const host = $('daw-modal');
  if (!ps.length) { openModal('톤 불러오기', '<div class="daw-modal-empty">저장된 톤이 없습니다.</div>', () => {}); return; }
  const html = ps.map((p, i) => `<div class="daw-modal-item" data-idx="${i}">
    <div class="mt"><div class="n">${esc(p.name)}</div><div class="m">${esc((_plugins[p.index] && _plugins[p.index].name) || ('VST ' + p.index))}</div></div>
    <button class="daw-preset-del" data-id="${esc(p.id)}" title="삭제">✕</button></div>`).join('');
  openModal('톤 불러오기', html, (idx) => loadPreset(ps[Number(idx)]));
  host.querySelectorAll('.daw-preset-del').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = b.dataset.id;
    setPresets(getPresets().filter(p => p.id !== id));
    if (_activePresetId === id) _activePresetId = null;
    openPresetPicker();
  }));
}
let _plugins = [];         // 스캔된 VST 목록
let _songKey = null;

const HEAD_W = 140;
// 마디(bar) 기준 눈금 — 템포 가정(추후 감지/조절 가능). 120BPM·4/4 → 1마디 2초
const BPM = 120, BEATS_PER_BAR = 4, SEC_PER_BAR = BEATS_PER_BAR * 60 / BPM;
let _stemOffset = 0;   // 스템 전체 오프셋(초)
let _recTracks = [];   // 녹음 트랙 목록(엔진 동기) [{id,gain,mute,solo,armed}]
let _recTracksGen = 0, _recTracksGenReq = 0;   // 트랙 재구성 동기화 토큰
let _exporting = false, _exportMp3 = null, _exportTmp = null;   // export 진행 상태
const armedRecId = () => (_recTracks.find(r => r.armed) || _recTracks[0] || {}).id;
// 클립 가로 드래그 유틸 — onDelta(초), onEnd
function dragClip(e, onDelta, onEnd) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX; let moved = false;
  const move = (ev) => { moved = true; onDelta((ev.clientX - startX) / _pxPerSec); };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);   // 인터럽트 시 리스너 누수 방지
    onEnd(moved);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}
function repositionStems() {
  const w = contentW();   // 스템 클립 폭을 배율에 묶어야 줌이 파형에 반영됨
  document.querySelectorAll('.daw-lane:not(.daw-lane-rec) .daw-clip').forEach(c => {
    c.style.left = (_stemOffset * _pxPerSec) + 'px'; c.style.width = w + 'px'; c.style.right = 'auto';
  });
}
// 트랙 빈 곳 클릭+유지 = 재생선 스크럽 (재생 위치 이동)
function scrubStart(e, area) {
  const seekTo = (clientX) => {
    const r = area.getBoundingClientRect();
    const t = Math.max(0, Math.min(fullSec(), (clientX - r.left) / _pxPerSec));   // 소스 밖(타임라인 전체)까지 이동
    api.engine.seek(Math.round(t * (_sr || 44100)));
    const v = $('daw-video'); if (v && isFinite(v.duration) && t <= v.duration) v.currentTime = t;
    updatePlayhead(t);
  };
  seekTo(e.clientX);
  const mv = (ev) => seekTo(ev.clientX);
  const up = () => {
    document.removeEventListener('pointermove', mv);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
  };
  document.addEventListener('pointermove', mv);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}
const fmtTC = (sec) => {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};
const contentW = () => Math.max(1, _dur * _pxPerSec);

// ── 파형 SVG ──────────────────────────────────────
function buildWaveSvg(ch, color, N = 1400) {
  if (!ch || !ch[0]) return '';
  const L = ch[0], R = ch[1] || ch[0], len = L.length;
  const bucket = Math.max(1, Math.floor(len / N));
  let pts = '';
  let mx = 1e-6;
  const peaks = new Float32Array(N), rms = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const start = i * bucket, end = Math.min(len, start + bucket);
    let p = 0, s2 = 0, cnt = 0;
    const step = Math.max(1, Math.floor((end - start) / 200));
    for (let j = start; j < end; j += step) { const a = (L[j] + R[j]) * 0.5; const aa = Math.abs(a); if (aa > p) p = aa; s2 += a * a; cnt++; }
    peaks[i] = p; rms[i] = cnt ? Math.sqrt(s2 / cnt) : 0; if (p > mx) mx = p;
  }
  const poly = (arr, scale) => {
    let a = '', b = '';
    for (let i = 0; i < N; i++) { const h = Math.min(1, arr[i] / mx) * 22 * scale; a += `${i},${(25 - h).toFixed(1)} `; }
    for (let i = N - 1; i >= 0; i--) { const h = Math.min(1, arr[i] / mx) * 22 * scale; b += `${i},${(25 + h).toFixed(1)} `; }
    return a + b;
  };
  // peak = 흐린 외곽, rms = 본체(플랫·선명), 가운데 기준선 (그라디언트 없음)
  return `<svg viewBox="0 0 ${N} 50" preserveAspectRatio="none">`
    + `<polygon points="${poly(peaks, 1)}" fill="${color}" fill-opacity=".24"/>`
    + `<polygon points="${poly(rms, 1)}" fill="${color}" fill-opacity=".7"/>`
    + `<line x1="0" y1="25" x2="${N}" y2="25" stroke="${color}" stroke-opacity=".45" stroke-width=".6"/></svg>`;
}

// ── 렌더 ──────────────────────────────────────────
function renderTracks() {
  const lanes = $('daw-lanes');
  lanes.innerHTML = '';
  _tracks.forEach((t) => {   // 스템 트랙만 (내 녹음 트랙은 renderRecLanes 에서)
    const lane = document.createElement('div');
    lane.className = 'daw-lane';
    lane.style.setProperty('--c', t.color);
    lane.dataset.key = t.key;
    lane.innerHTML = `
      <div class="daw-head">
        <div class="nm"><i></i>${t.label}</div>
        <div class="ctrls">
          <button class="daw-ms" data-m="mute" title="뮤트" aria-pressed="false">M</button>
          <button class="daw-ms" data-m="solo" title="솔로" aria-pressed="false">S</button>
          <input class="daw-vol" type="range" min="0" max="150" value="100" title="볼륨">
        </div>
      </div>
      <div class="daw-area"><div class="daw-clip"></div></div>`;
    const mBtn = lane.querySelector('[data-m="mute"]');
    const sBtn = lane.querySelector('[data-m="solo"]');
    const vol = lane.querySelector('.daw-vol');
    mBtn.addEventListener('click', () => { const on = mBtn.classList.toggle('on'); mBtn.setAttribute('aria-pressed', String(on)); api.engine.track(t.engineIndex, { mute: on }); });
    sBtn.addEventListener('click', () => { const on = sBtn.classList.toggle('on'); sBtn.setAttribute('aria-pressed', String(on)); api.engine.track(t.engineIndex, { solo: on }); updateSoloDim(); });
    vol.addEventListener('input', () => api.engine.track(t.engineIndex, { gain: Number(vol.value) / 100 }));
    // 스템 클립 드래그 = 스템 전체 오프셋 (묶음 이동)
    const clip = lane.querySelector('.daw-clip');
    clip.addEventListener('click', (e) => e.stopPropagation());
    clip.addEventListener('pointerdown', (e) => {
      const base = _stemOffset;
      dragClip(e, (dSec) => {
        _stemOffset = Math.max(0, base + dSec); repositionStems();   // 0:00 뒤로 못 감
        showDragBadge(lane, _stemOffset - base);
      }, () => { hideDragBadge(); api.engine.stemOffset(Math.round(_stemOffset * (_sr || 44100))); });
    });
    lanes.appendChild(lane);
  });
  renderRecLanes();
}

// 내 녹음 트랙 레인(여러 개) — 스템 레인은 건드리지 않음(파형 보존)
function renderRecLanes() {
  const lanes = $('daw-lanes');
  lanes.querySelectorAll('.daw-lane-rec, .daw-addrec-row').forEach(el => el.remove());
  _recTracks.forEach((rt, i) => {
    const lane = document.createElement('div');
    lane.className = 'daw-lane daw-lane-rec';
    lane.style.setProperty('--c', 'var(--accent)');
    lane.dataset.key = 'rec-' + rt.id;
    lane.dataset.recid = rt.id;
    lane.innerHTML = `
      <div class="daw-head" title="클릭하면 이 트랙의 입력 이펙트 편집">
        <div class="nm"><i></i>내 녹음 ${i + 1}</div>
        <div class="ctrls">
          <button class="daw-ms daw-rec-arm${rt.armed ? ' armed' : ''}" data-m="arm" title="녹음 대상(arm)" aria-pressed="${!!rt.armed}">R</button>
          <button class="daw-ms${rt.mute ? ' on' : ''}" data-m="mute" title="뮤트" aria-pressed="${!!rt.mute}">M</button>
          <button class="daw-ms${rt.solo ? ' on' : ''}" data-m="solo" title="솔로" aria-pressed="${!!rt.solo}">S</button>
          <input class="daw-vol" type="range" min="0" max="150" value="${Math.round((rt.gain != null ? rt.gain : 1) * 100)}" title="볼륨">
          <button class="daw-ms daw-rec-del" data-m="del" title="트랙 삭제">✕</button>
        </div>
      </div>
      <div class="daw-area"></div>`;
    const rBtn = lane.querySelector('[data-m="arm"]');
    const mBtn = lane.querySelector('[data-m="mute"]');
    const sBtn = lane.querySelector('[data-m="solo"]');
    const vol = lane.querySelector('.daw-vol');
    const del = lane.querySelector('[data-m="del"]');
    // 헤드 클릭 = 트랙 선택 (버튼/슬라이더 조작은 각자 처리, 그래도 선택은 됨)
    lane.querySelector('.daw-head').addEventListener('pointerdown', () => selectTrack(rt.id));
    rBtn.addEventListener('click', (e) => {   // R = 이 트랙 녹음 대상 지정 + 즉시 녹음 준비·재생
      e.stopPropagation();
      selectTrack(rt.id);
      api.engine.recArm(rt.id);
      armRecPlay();
    });
    mBtn.addEventListener('click', (e) => { e.stopPropagation(); const on = mBtn.classList.toggle('on'); mBtn.setAttribute('aria-pressed', String(on)); rt.mute = on; api.engine.recTrack(rt.id, { mute: on }); });
    sBtn.addEventListener('click', (e) => { e.stopPropagation(); const on = sBtn.classList.toggle('on'); sBtn.setAttribute('aria-pressed', String(on)); rt.solo = on; api.engine.recTrack(rt.id, { solo: on }); updateSoloDim(); });
    vol.addEventListener('input', () => {
      rt.gain = Number(vol.value) / 100; api.engine.recTrack(rt.id, { gain: rt.gain });
      if (rt.id === _selTrack) { $('mx-track').value = vol.value; $('mx-track-val').textContent = vol.value; }   // 믹서 동기화
    });
    // 삭제: 녹음이 있는 트랙은 2단계 확인 (실수 방지)
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const takesN = _takes.filter(t => t.trackId === rt.id).length;
      if (del.dataset.confirm || takesN === 0) { clearTimeout(del._t); api.engine.recTrackRemove(rt.id); return; }
      del.dataset.confirm = '1'; del.textContent = '‼'; del.classList.add('confirm');
      flashTake(`이 트랙에 녹음 ${takesN}개 — 다시 누르면 함께 삭제`);
      del._t = setTimeout(() => { del.dataset.confirm = ''; del.textContent = '✕'; del.classList.remove('confirm'); }, 2500);
    });
    lanes.appendChild(lane);
  });
  // + 녹음 트랙 추가 — 버튼은 헤드(컨트롤) 컬럼에 sticky 로 묶음
  const add = document.createElement('div');
  add.className = 'daw-addrec-row';
  add.innerHTML = `<div class="daw-addrec-head"><button class="daw-addrec" title="녹음 트랙 추가">＋ 녹음 트랙</button></div>`;
  add.querySelector('button').addEventListener('click', () => api.engine.recTrackAdd());
  lanes.appendChild(add);
  syncSelection();
  layout();
}

// ── 트랙 선택 (편집 대상) — 이펙트 패널 대상 ──
function selectTrack(id) {
  if (id != null && !_recTracks.some(r => r.id === id)) id = null;
  _selTrack = id;
  if (id != null) { _chain = _chainByTrack[id] || []; api.engine.fxChainReq(id); }
  else _chain = [];
  syncSelection();
  renderFxSlots();
  updateFxPanel();
}
function syncSelection() {   // 재렌더 후 선택 하이라이트 재적용
  if (_selTrack != null && !_recTracks.some(r => r.id === _selTrack)) _selTrack = null;
  document.querySelectorAll('.daw-lane').forEach(l =>
    l.classList.toggle('selected', l.dataset.recid != null && Number(l.dataset.recid) === _selTrack));
}
function updateFxPanel() {   // 선택된 트랙 있을 때만 이펙트 표시
  const left = document.querySelector('.daw-left');
  if (!left) return;
  const has = _selTrack != null;
  left.classList.toggle('empty', !has);
  const h = $('daw-left-h');
  if (h) {
    const idx = _recTracks.findIndex(r => r.id === _selTrack);
    h.textContent = has ? `내 녹음 ${idx + 1} 이펙트` : '입력 이펙트';
  }
  updateTrackFader();
}
function updateTrackFader() {   // 믹서 우측 = 선택 트랙 볼륨
  const f = $('mx-track'), val = $('mx-track-val'), lbl = $('mx-track-lbl'); if (!f) return;
  const rt = _recTracks.find(r => r.id === _selTrack);
  if (rt) {
    const v = Math.round((rt.gain != null ? rt.gain : 1) * 100);
    f.disabled = false; f.value = v; val.textContent = v;
    lbl.textContent = '내 녹음 ' + (_recTracks.findIndex(r => r.id === _selTrack) + 1);
  } else { f.disabled = true; f.value = 100; val.textContent = '—'; lbl.textContent = '트랙'; }
}

// ── 드래그 이동량 배지 (+0:07) ──
function fmtDelta(sec) {
  const s = Math.round(sec), a = Math.abs(s);
  return `${s >= 0 ? '+' : '-'}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}
function showDragBadge(laneEl, deltaSec) {
  const area = laneEl.querySelector('.daw-area'); if (!area) return;
  let b = area.querySelector('.daw-drag-badge');
  if (!b) { b = document.createElement('div'); b.className = 'daw-drag-badge'; area.appendChild(b); }
  b.textContent = fmtDelta(deltaSec);
}
function hideDragBadge() { document.querySelectorAll('.daw-drag-badge').forEach(b => b.remove()); }

function updateSoloDim() {
  const anySolo = [...document.querySelectorAll('.daw-ms[data-m="solo"].on')].length > 0;
  document.querySelectorAll('.daw-lane').forEach(l => {
    const soloed = l.querySelector('.daw-ms[data-m="solo"].on');
    l.style.opacity = (anySolo && !soloed) ? '.45' : '1';
  });
}

function resolveColor(cssVar) {
  const m = String(cssVar).match(/var\((--[\w-]+)\)/);
  if (m) return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || '#8a8f99';
  return cssVar;
}
function renderWaves(buffers) {
  _tracks.forEach((t) => {
    if (t.key === 'mine') return;
    const lane = document.querySelector(`.daw-lane[data-key="${t.key}"]`);
    const clip = lane && lane.querySelector('.daw-clip');
    const ch = buffers && buffers[t.key];
    if (clip && ch) clip.innerHTML = buildWaveSvg(ch, resolveColor(t.color));
  });
}

function ensurePlayhead() {
  const lanes = $('daw-lanes'); if (!lanes) return null;
  let ph = document.getElementById('daw-playhead');
  if (!ph || ph.parentElement !== lanes) {   // renderTracks 가 lanes 비우므로 없으면 재생성
    if (ph) ph.remove();
    ph = document.createElement('div'); ph.id = 'daw-playhead'; ph.className = 'daw-ph'; ph.hidden = true;
    lanes.appendChild(ph);
  }
  return ph;
}

// ── 내보내기 범위 (룰러에서 드래그 선택) ──
let _exportRange = null;   // {start, end} 초
function ensureExportEls() {
  const ruler = $('daw-ruler');
  if (ruler && !document.getElementById('daw-erange')) { const e = document.createElement('div'); e.id = 'daw-erange'; e.className = 'daw-erange'; e.hidden = true; ruler.appendChild(e); }
  const lanes = $('daw-lanes');
  let band = document.getElementById('daw-eband');
  if (lanes && (!band || band.parentElement !== lanes)) { if (band) band.remove(); band = document.createElement('div'); band.id = 'daw-eband'; band.className = 'daw-eband'; band.hidden = true; lanes.appendChild(band); }
}
function renderExportRange() {
  const e = document.getElementById('daw-erange'), band = document.getElementById('daw-eband');
  if (!_exportRange) { if (e) e.hidden = true; if (band) band.hidden = true; return; }
  const x = _exportRange.start * _pxPerSec, w = (_exportRange.end - _exportRange.start) * _pxPerSec;
  if (e) { e.hidden = false; e.style.left = x + 'px'; e.style.width = w + 'px'; }
  if (band) { band.hidden = false; band.style.left = (HEAD_W + x) + 'px'; band.style.width = w + 'px'; band.style.height = ($('daw-lanes').offsetHeight || 0) + 'px'; }
}
const fmtBar = (sec) => '마디 ' + (Math.floor(sec / SEC_PER_BAR) + 1);

// 타임라인 총 길이(초) — 소스 길이 + 여유(뷰포트는 채우되 무한 아님), 마디 단위로 반올림
function fullSec() {
  const sc = $('daw-tscroll');
  const vw = sc ? sc.clientWidth - HEAD_W : 1000;
  const base = Math.max(_dur, vw / _pxPerSec) + 8;   // 소스보다 조금 더 길게
  return Math.ceil(base / SEC_PER_BAR) * SEC_PER_BAR;
}
const timelineW = () => Math.max(1, fullSec() * _pxPerSec);

function layout() {
  const w = timelineW();   // 타임라인 전체 폭 (오른쪽 회색 여백 제거)
  $('daw-lanes').style.width = (HEAD_W + w) + 'px';
  document.querySelectorAll('.daw-lane').forEach(l => { l.style.width = (HEAD_W + w) + 'px'; });
  const ruler = $('daw-ruler');
  ruler.style.width = w + 'px'; ruler.innerHTML = '';
  const barPx = SEC_PER_BAR * _pxPerSec;
  $('daw-lanes').style.setProperty('--grid', barPx + 'px');   // 마디마다 그리드선
  const lblEvery = barPx >= 60 ? 1 : barPx >= 30 ? 2 : barPx >= 15 ? 4 : 8;   // 라벨 간격(마디)
  const end = fullSec();
  let bar = 1;
  for (let s = 0; s <= end + 0.001; s += SEC_PER_BAR, bar++) {
    const tk = document.createElement('span');
    tk.className = 'tk' + ((bar - 1) % lblEvery === 0 ? '' : ' minor');
    tk.style.left = (s * _pxPerSec) + 'px';
    if ((bar - 1) % lblEvery === 0) tk.textContent = bar;
    ruler.appendChild(tk);
  }
  ensurePlayhead();   // 재생선을 lanes 안에 유지(헤드보다 아래 z → 컨트롤 컬럼에 안 비침)
  ensureExportEls(); renderExportRange();
  renderTakes();
  repositionStems();
  updatePlayhead(_lastSec);
  const zv = $('st-zoom-val'); if (zv) zv.textContent = Math.round(_pxPerSec) + ' px/s';
  const te = $('daw-tracks-empty'); if (te) te.hidden = _tracks.length > 0 || _recTracks.length > 0;
}

let _lastSec = 0;
function updatePlayhead(sec) {
  _lastSec = sec;
  const ph = $('daw-playhead');
  if (!ph) return;
  ph.hidden = _tracks.length === 0 && _recTracks.length === 0;
  ph.style.left = (HEAD_W + sec * _pxPerSec) + 'px';
  ph.style.height = ($('daw-lanes').offsetHeight || 0) + 'px';
  $('st-pos').textContent = fmtTC(sec);
  $('daw-ruler').style.transform = `translateX(${-$('daw-tscroll').scrollLeft}px)`;
}

// ── 트랜스포트 (모듈 스코프 — 어디서든 호출 가능) ──
function updatePlayIcon() { const el = $('daw-vplay'); if (el) el.hidden = _playing; }
function playStudio() {
  _playStart = _lastSec;   // 재생 시작점 기억(정지 시 복귀)
  _playing = true; api.engine.play(); const v = $('daw-video'); if (v) v.play().catch(() => {}); updatePlayIcon();
}
function stopStudio() {
  _playing = false; api.engine.stop(); const v = $('daw-video'); if (v) v.pause(); updatePlayIcon();
  if (_recArmed) { _recArmed = false; $('st-rec').classList.remove('armed'); $('st-rec').setAttribute('aria-pressed', 'false'); api.engine.recordStop(); }
  clearRecLive();
  if (_returnOnStop) {   // 정지 시 재생 시작 위치로 복귀(옵션)
    const back = Math.max(0, _playStart || 0);
    api.engine.seek(Math.round(back * (_sr || 44100)));
    const v2 = $('daw-video'); if (v2 && isFinite(v2.duration)) v2.currentTime = back;
    updatePlayhead(back);
  }
}
function armRecPlay() {   // R: 즉시 녹음 준비 + 재생 시작
  if (!armedRecId()) { flashTake('먼저 “＋ 녹음 트랙”으로 녹음 트랙을 추가하세요.'); return; }
  if (!_recArmed) { _recArmed = true; $('st-rec').classList.add('armed'); $('st-rec').setAttribute('aria-pressed', 'true'); api.engine.recordArm(); }
  if (!_playing) playStudio();
  flashTake('● 녹음 시작');
}

// ── 동기 ──────────────────────────────────────────
let _recStartSec = null;
function updateRecLive(t) {
  const lane = document.querySelector(`.daw-lane-rec[data-recid="${armedRecId()}"]`) || document.querySelector('.daw-lane-rec');
  const area = lane && lane.querySelector('.daw-area');
  if (!area) return;
  if (_recStartSec == null) _recStartSec = t;
  let el = area.querySelector('.daw-rec-live');
  if (!el) { el = document.createElement('div'); el.className = 'daw-rec-live'; area.appendChild(el); }
  el.style.left = (_recStartSec * _pxPerSec) + 'px';
  el.style.width = Math.max(2, (t - _recStartSec) * _pxPerSec) + 'px';
}
function clearRecLive() { _recStartSec = null; document.querySelector('.daw-rec-live')?.remove(); }

function onPos(samples) {
  const t = (samples || 0) / (_sr || 44100);
  updatePlayhead(t);
  if (_recArmed && _playing) updateRecLive(t);
  if (_dur > 0) $('daw-vbar-fill').style.width = Math.min(100, (t / _dur) * 100) + '%';
  const v = $('daw-video');
  if (v && _playing && isFinite(v.duration) && Math.abs(v.currentTime - t) > 0.15) v.currentTime = t;
  const sc = $('daw-tscroll'), x = HEAD_W + t * _pxPerSec;
  if (x < sc.scrollLeft + HEAD_W || x > sc.scrollLeft + sc.clientWidth - 40)
    sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2);
}

// ── 부가: 레벨 미터 · 튜너 ──
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function updateVU(peak) {
  const fill = $('st-vu-fill'), dbEl = $('st-vu-db'); if (!fill) return;
  const p = peak || 0;
  const db = p > 0.00001 ? 20 * Math.log10(p) : -80;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));   // -60..0dB
  fill.style.width = pct + '%';
  fill.classList.toggle('clip', p >= 0.99);
  dbEl.textContent = p > 0.00001 ? `${db.toFixed(0)} dB` : '—';
}
let _tunerHold = 0;
function updateTuner(freq) {
  const noteEl = $('st-tuner-note'), needle = $('st-tuner-needle'), centsEl = $('st-tuner-cents');
  if (!noteEl) return;
  if (!freq || freq < 40) {
    if (Date.now() - _tunerHold > 700) { noteEl.textContent = '—'; centsEl.textContent = ''; needle.style.left = '50%'; }
    return;
  }
  _tunerHold = Date.now();
  const n = 69 + 12 * Math.log2(freq / 440);
  const nearest = Math.round(n);
  const cents = Math.round((n - nearest) * 100);
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1);
  noteEl.textContent = name;
  noteEl.classList.toggle('in-tune', Math.abs(cents) <= 5);
  centsEl.textContent = (cents > 0 ? '+' : '') + cents + ' cent';
  needle.style.left = Math.max(0, Math.min(100, 50 + cents)) + '%';
}

function setEnabled(on) {
  ['st-load-song', 'st-seek0', 'st-play', 'st-stop', 'st-rec', 'st-return', 'st-zoom-in', 'st-zoom-out', 'st-tools-toggle', 'st-export', 'mx-master', 'st-fx-add', 'st-fx-save', 'st-fx-saveas', 'st-fx-load', 'st-fx-bypassall', 'st-audio-settings', 'st-monitor', 'st-take-save', 'st-take-load']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
}

// ── 곡 로드 ────────────────────────────────────────
let _loadingSong = false;
async function loadSong(item) {
  if (_loadingSong) return;   // 재진입 차단 (더블클릭 시 전역상태 오염)
  const it = item || Library.getSelected();
  if (!it) return;
  const paths = Object.values(it.stemPaths || {}).filter(Boolean);
  if (!paths.length) { flashTake('이 곡에 스템 파일이 없습니다.'); return; }
  _loadingSong = true;
  _songKey = String(it.videoPath || it.id);
  _takes = []; _stemOffset = 0;

  const keys = Object.keys(it.stemPaths || {});
  _tracks = keys.map((k, i) => ({ key: k, label: STEM_LABEL[k] || k, color: STEM_COLOR[k] || 'var(--accent)', engineIndex: i }));
  renderTracks();

  const v = $('daw-video');
  $('daw-video-empty').hidden = true;
  if (it.videoPath) { v.src = toYtsepUrl(it.videoPath); v.load(); }

  api.engine.loadStems(paths);
  api.engine.scanPlugins();
  flashTake(`불러옴: ${it.name}`);

  // 파형 (렌더러에서 디코드)
  flashTake(`불러옴: ${it.name} · 파형 분석 중…`);
  try {
    const { stems } = await loadStemFilesToBuffers(it.stemPaths);
    renderWaves(stems);
    flashTake(`불러옴: ${it.name}`);
  } catch (e) { flashTake(`파형 디코드 실패: ${e && e.message || e}`); }
  finally { _loadingSong = false; }
}

function flashTake(msg) {   // 하단 로그 대신 잠깐 뜨는 토스트
  let t = document.getElementById('daw-toast');
  if (!t) { t = document.createElement('div'); t.id = 'daw-toast'; t.className = 'daw-toast'; (document.querySelector('.daw') || document.body).appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

let _takes = [];   // [{ id, file, start(sec), dur(sec), svg }]
async function renderTake(file, startSamples, engineId, trackId) {
  try {
    const { stems } = await loadStemFilesToBuffers({ take: file });
    const ch = stems.take;
    _takes.push({
      id: engineId != null ? engineId : Date.now(), file,
      trackId: trackId != null ? trackId : armedRecId(),
      start: (startSamples || 0) / (_sr || 44100),
      dur: ch[0].length / (_sr || 44100),
      svg: buildWaveSvg(ch, resolveColor('var(--danger)')),
    });
    renderTakes();
  } catch (e) { flashTake('녹음 파형 실패: ' + (e && e.message || e)); }
}
function renderTakes() {
  const areas = {};
  document.querySelectorAll('.daw-lane-rec').forEach(l => {
    const a = l.querySelector('.daw-area'); a.innerHTML = ''; areas[l.dataset.recid] = a;
  });
  if (!Object.keys(areas).length) return;
  const fallback = armedRecId();
  for (const tk of _takes) {
    const tid = (tk.trackId != null && areas[tk.trackId]) ? tk.trackId : fallback;
    const area = areas[tid]; if (!area) continue;
    const el = document.createElement('div');
    el.className = 'daw-take-clip';
    el.style.left = (tk.start * _pxPerSec) + 'px';
    el.style.width = Math.max(3, tk.dur * _pxPerSec) + 'px';
    el.innerHTML = tk.svg;
    el.title = tk.file;
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showTakeMenu(e.clientX, e.clientY, tk.id); });
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('pointerdown', (e) => {
      selectTrack(tk.trackId);
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX, base = tk.start;
      const srcLane = el.closest('.daw-lane-rec');
      let target = srcLane;
      const move = (ev) => {
        tk.start = Math.max(0, base + (ev.clientX - startX) / _pxPerSec);   // 좌우 = 시간
        el.style.left = (tk.start * _pxPerSec) + 'px';
        // 상하 = 대상 내 트랙 감지 (다른 내 트랙으로 이동)
        const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.daw-lane-rec');
        document.querySelectorAll('.daw-lane-rec.drop-target').forEach(l => l.classList.remove('drop-target'));
        if (lane) { target = lane; if (lane !== srcLane) lane.classList.add('drop-target'); }
        showDragBadge(srcLane, tk.start - base);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        hideDragBadge();
        document.querySelectorAll('.daw-lane-rec.drop-target').forEach(l => l.classList.remove('drop-target'));
        const newId = target ? Number(target.dataset.recid) : tk.trackId;
        const startS = Math.round(tk.start * (_sr || 44100));
        if (newId && newId !== tk.trackId) {   // 트랙 변경
          tk.trackId = newId;
          api.engine.takeMove(tk.id, startS, newId);
          renderTakes();   // 새 레인으로 클립 이동
        } else {
          api.engine.takeMove(tk.id, startS, 0);
        }
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    area.appendChild(el);
  }
}
function showTakeMenu(x, y, id) {
  document.querySelector('.daw-ctx')?.remove();
  const menu = document.createElement('div');
  menu.className = 'daw-ctx';
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.innerHTML = `<button class="del">삭제</button>`;
  menu.querySelector('.del').addEventListener('click', () => {
    api.engine.takeRemove(id);   // 엔진 재생 소스도 제거
    _takes = _takes.filter(t => t.id !== id); renderTakes(); menu.remove();
  });
  document.body.appendChild(menu);
  const close = (e) => { if (menu.contains(e.target)) return; menu.remove(); document.removeEventListener('mousedown', close); };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ── 모달 ───────────────────────────────────────────
function openModal(title, itemsHtml, onClick) {
  const host = $('daw-modal');
  host.innerHTML = `<div class="daw-modal-box">
    <div class="daw-modal-h"><span>${title}</span><button class="x">✕</button></div>
    <div class="daw-modal-list">${itemsHtml}</div></div>`;
  host.hidden = false;
  host.querySelector('.x').addEventListener('click', () => host.hidden = true);
  host.addEventListener('click', (e) => { if (e.target === host) host.hidden = true; }, { once: true });
  host.querySelectorAll('.daw-modal-item').forEach(el => el.addEventListener('click', () => {
    host.hidden = true; onClick(el.dataset.idx);
  }));
}

function openSongPicker() {
  const seen = new Set(); const items = [];
  for (const it of (Library.getItems() || [])) {
    const k = it.videoPath || it.id; if (seen.has(k)) continue; seen.add(k); items.push(it);
  }
  if (!items.length) { openModal('곡 선택', `<div class="daw-modal-empty">라이브러리가 비어있습니다.</div>`, () => {}); return; }
  const groups = [...new Set(items.map(it => it.group).filter(Boolean))];
  const chips = groups.length
    ? `<div class="daw-modal-tabs"><button class="daw-mtab on" data-g="__all">전체</button>${groups.map(g => `<button class="daw-mtab" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>`
    : '';
  const row = (it, i) => `<div class="daw-modal-item" data-idx="${i}" data-g="${esc(it.group || '')}"><div class="mt"><div class="n">${esc(it.name)}</div>
      <div class="m">${Object.keys(it.stemPaths || {}).length} 스템${it.group ? ' · ' + esc(it.group) : ''}</div></div></div>`;
  const host = $('daw-modal');
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>곡 선택</span><button class="x">✕</button></div>${chips}<div class="daw-modal-list">${items.map(row).join('')}</div></div>`;
  host.hidden = false;
  host.querySelector('.x').addEventListener('click', () => host.hidden = true);
  host.addEventListener('click', (e) => { if (e.target === host) host.hidden = true; }, { once: true });
  host.querySelectorAll('.daw-modal-item').forEach(el => el.addEventListener('click', () => { host.hidden = true; loadSong(items[Number(el.dataset.idx)]); }));
  host.querySelectorAll('.daw-mtab').forEach(b => b.addEventListener('click', () => {
    host.querySelectorAll('.daw-mtab').forEach(x => x.classList.remove('on')); b.classList.add('on');
    const g = b.dataset.g;
    host.querySelectorAll('.daw-modal-item').forEach(el => { el.style.display = (g === '__all' || el.dataset.g === g) ? '' : 'none'; });
  }));
}

function openVstPicker() {
  if (_selTrack == null) { flashTake('먼저 녹음 트랙을 선택하세요.'); return; }
  if (!_plugins.length) { openModal('VST 추가', `<div class="daw-modal-empty">감지된 VST 없음. 설정·스캔 필요.</div>`, () => {}); return; }
  const html = _plugins.map(p =>
    `<div class="daw-modal-item" data-idx="${p.index}"><div class="mt"><div class="n">${esc(p.name)}</div>
      <div class="m">${esc(p.manufacturer)}</div></div></div>`).join('');
  openModal('VST 추가', html, (idx) => api.engine.fxAdd(_selTrack, Number(idx)));   // 선택 트랙에 추가
}

// ── 녹음(테이크 세트) 저장/불러오기 — 곡별, 이름 지정 ──
function takesetKey(k) { return 'yss:takesets:' + String(k).replace(/\\/g, '/').toLowerCase(); }
function getTakeSets() { if (!_songKey) return []; try { return JSON.parse(localStorage.getItem(takesetKey(_songKey)) || '[]'); } catch { return []; } }
function setTakeSets(a) { if (!_songKey) return; try { localStorage.setItem(takesetKey(_songKey), JSON.stringify(a)); } catch {} }
let _takeSetGather = null;
function saveTakeSet(name) {
  if (!_takes.length) { flashTake('저장할 녹음이 없습니다.'); return; }
  // 트랙 레이아웃(개수·게인·뮤트·솔로) + 트랙별 FX 체인까지 통째로 저장
  const tracks = _recTracks.map(r => ({
    id: r.id, gain: r.gain != null ? r.gain : 1, mute: !!r.mute, solo: !!r.solo,
    fxOrder: (_chainByTrack[r.id] || []).map(s => ({ id: s.id, index: s.index, bypass: s.bypass })),
  }));
  const takes = _takes.map(t => ({ id: t.id, file: t.file, start: Math.round(t.start * (_sr || 44100)), dur: t.dur, trackId: t.trackId }));
  const need = [];
  tracks.forEach(t => t.fxOrder.forEach(s => need.push({ track: t.id, id: s.id })));
  if (!need.length) { persistTakeSet(name, stripFxOrder(tracks), takes); return; }   // FX 없으면 바로 저장
  // FX 슬롯 상태(노브값)를 비동기로 모은 뒤 저장
  _takeSetGather = { name, tracks, takes, need: need.map(n => n.id), states: {} };
  flashTake('녹음 + 이펙트 저장 중…');
  need.forEach(n => api.engine.fxSaveState(n.track, n.id));
  _takeSetGather._t = setTimeout(finishTakeSetGather, 2000);   // 일부 못 받아도 저장(타임아웃)
}
function stripFxOrder(tracks) {
  return tracks.map(t => ({ id: t.id, gain: t.gain, mute: t.mute, solo: t.solo, fx: t.fxOrder.map(s => ({ index: s.index, bypass: s.bypass })) }));
}
function finishTakeSetGather() {
  const g = _takeSetGather; if (!g) return; _takeSetGather = null; clearTimeout(g._t);
  const tracks = g.tracks.map(t => ({
    id: t.id, gain: t.gain, mute: t.mute, solo: t.solo,
    fx: t.fxOrder.map(s => ({ index: s.index, bypass: s.bypass, data: g.states[s.id] })),
  }));
  persistTakeSet(g.name, tracks, g.takes);
}
function persistTakeSet(name, tracks, takes) {
  const a = getTakeSets(); a.push({ id: 't' + Date.now(), name, tracks, takes }); setTakeSets(a);
  flashTake('녹음 저장됨: ' + name);
}
function waitRecTracks(gen) {   // recTracksReset 후 새 트랙 목록(generation 에코)까지 대기
  return new Promise(res => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (_recTracksGen === gen || Date.now() - t0 > 2500) { clearInterval(iv); res(_recTracksGen === gen); }
    }, 20);
  });
}
let _loadingTakeSet = false;
async function loadTakeSet(ts) {
  if (_loadingTakeSet) return;   // 재진입 차단 (더블클릭 시 전역상태 오염 방지)
  _loadingTakeSet = true;
  try {
    api.engine.takeClear();
    _takes = []; renderTakes();

    // 트랙 레이아웃 복원 (구버전 세트는 tracks 없음 → 현재 트랙 유지)
    let idMap = null;
    if (Array.isArray(ts.tracks) && ts.tracks.length) {
      _recTracks = [];   // stale 값으로 즉시 resolve 되지 않도록 비우고 이벤트로만 채움
      const gen = ++_recTracksGenReq;
      api.engine.recTracksReset(ts.tracks.map(t => ({ gain: t.gain, mute: t.mute, solo: t.solo })), gen);
      const ok = await waitRecTracks(gen);
      if (!ok) { flashTake('트랙 복원 시간 초과 — 다시 시도하세요.'); return; }
      idMap = {};   // 저장된 trackId(순서) → 새 트랙 id
      ts.tracks.forEach((t, i) => { if (_recTracks[i]) idMap[t.id] = _recTracks[i].id; });
      // 트랙별 FX 체인 복원 (선택 트랙만이 아니라 모든 트랙에 적용)
      ts.tracks.forEach((t, i) => {
        if (_recTracks[i] && Array.isArray(t.fx) && t.fx.length)
          api.engine.fxSetChain(_recTracks[i].id, t.fx.map(s => ({ index: s.index, bypass: s.bypass, data: s.data })));
      });
    }

    for (const t of ts.takes) {
      let tid = t.trackId;
      if (idMap && idMap[t.trackId] != null) tid = idMap[t.trackId];
      else if (!_recTracks.some(r => r.id === tid)) tid = armedRecId();
      const id = t.id != null ? t.id : t.start;   // 고유 id (구버전은 start 폴백)
      api.engine.takeLoad(t.file, t.start, tid, id);
      await renderTake(t.file, t.start, id, tid);
    }
    flashTake('녹음 불러옴: ' + ts.name);
  } finally { _loadingTakeSet = false; }
}
// ── Export: 포맷·품질 선택 ──
const EXPORT_QUAL = {
  wav:  [['24', '24-bit'], ['16', '16-bit'], ['32', '32-bit float']],
  aiff: [['24', '24-bit'], ['16', '16-bit'], ['32', '32-bit float']],
  flac: [['24', '24-bit'], ['16', '16-bit']],
  mp3:  [['320', '320 kbps'], ['256', '256 kbps'], ['192', '192 kbps'], ['128', '128 kbps']],
};
function openExportModal() {
  if (!_tracks.length && !_recTracks.length) { flashTake('내보낼 내용이 없습니다.'); return; }
  if (_exporting) { flashTake('이미 내보내는 중입니다.'); return; }
  const host = $('daw-modal');
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>내보내기</span><button class="x">✕</button></div>
    <div class="daw-modal-list" style="padding:16px">
      <div class="dev-field"><span>범위</span><select id="exp-scope">
        <option value="mix">전체 믹스 (스템 + 내 녹음)</option>
        <option value="mine">내 녹음 트랙만</option>
      </select></div>
      <div class="dev-field" style="margin-top:10px"><span>포맷</span><select id="exp-fmt">
        <option value="wav">WAV · 무손실</option>
        <option value="flac">FLAC · 무손실(압축)</option>
        <option value="aiff">AIFF · 무손실</option>
        <option value="mp3">MP3 · 손실(공유용)</option>
      </select></div>
      <div class="dev-field" style="margin-top:10px"><span>품질</span><select id="exp-q"></select></div>
      <div class="dev-field" style="margin-top:10px"><span>구간</span><select id="exp-span">
        <option value="full">전체</option>
        <option value="range"${_exportRange ? '' : ' disabled'}>${_exportRange ? '선택 범위 (' + fmtBar(_exportRange.start) + '–' + fmtBar(_exportRange.end) + ')' : '선택 범위 (룰러에서 드래그)'}</option>
      </select></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="mini" id="exp-go">내보내기</button></div>
    </div></div>`;
  host.hidden = false;
  if (_exportRange) $('exp-span').value = 'range';
  host.querySelector('.x').addEventListener('click', () => host.hidden = true);
  host.addEventListener('click', (e) => { if (e.target === host) host.hidden = true; }, { once: true });
  const fmt = $('exp-fmt'), q = $('exp-q');
  const fillQ = () => { q.innerHTML = EXPORT_QUAL[fmt.value].map(([v, l]) => `<option value="${v}">${l}</option>`).join(''); };
  fmt.addEventListener('change', fillQ); fillQ();
  $('exp-go').addEventListener('click', () => { host.hidden = true; runExport(fmt.value, q.value, $('exp-scope').value === 'mine', $('exp-span').value === 'range'); });
}
async function runExport(format, quality, mineOnly, useRange) {
  if (_exporting) { flashTake('이미 내보내는 중입니다.'); return; }
  const base = mineOnly ? 'recording' : 'mix';
  const res = await api.dialog.saveAs(base + '.' + format, [format]);
  if (!res || !res.ok || !res.filePath) return;
  const rg = (useRange && _exportRange) ? _exportRange : { start: 0, end: 0 };   // end 0 = 끝까지
  _exporting = true;
  flashTake('내보내는 중… 0%');
  if (format === 'mp3') {   // 임시 WAV 렌더 → ffmpeg MP3 변환
    _exportTmp = res.filePath.replace(/\.mp3$/i, '') + '.__export_tmp.wav';
    _exportMp3 = { dst: res.filePath, bitrate: quality };
    api.engine.cmd({ cmd: 'export', file: _exportTmp, format: 'wav', bitDepth: 24, mineOnly, startSec: rg.start, endSec: rg.end });
  } else {
    _exportMp3 = null; _exportTmp = null;
    api.engine.cmd({ cmd: 'export', file: res.filePath, format, bitDepth: Number(quality), mineOnly, startSec: rg.start, endSec: rg.end });
  }
}

function openTakeSetPicker() {
  const ps = getTakeSets();
  if (!ps.length) { openModal('녹음 불러오기', '<div class="daw-modal-empty">이 곡에 저장된 녹음이 없습니다.</div>', () => {}); return; }
  const host = $('daw-modal');
  const html = ps.map((p, i) => `<div class="daw-modal-item" data-idx="${i}">
    <div class="mt"><div class="n">${esc(p.name)}</div><div class="m">${p.takes.length} 테이크</div></div>
    <button class="daw-preset-del" data-id="${esc(p.id)}" title="삭제">✕</button></div>`).join('');
  openModal('녹음 불러오기', html, (idx) => loadTakeSet(ps[Number(idx)]));
  host.querySelectorAll('.daw-preset-del').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    setTakeSets(getTakeSets().filter(p => p.id !== b.dataset.id));
    openTakeSetPicker();
  }));
}

// ── 오디오 설정 모달 ──
let _devOpen = false;
function openDevModal(d) {
  const host = $('daw-modal');
  const opts = (arr, cur) => (arr || []).map(v => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${v}</option>`).join('');
  const curType = (d.types || []).find(t => t.name === d.currentType) || (d.types || [])[0] || { outputs: [], inputs: [] };
  const rates = (d.rates && d.rates.length ? d.rates : [44100, 48000, 96000]).map(r => Math.round(r));
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>오디오 설정</span><button class="x">✕</button></div>
    <div class="daw-modal-list" style="padding:16px;display:flex;flex-direction:column;gap:12px">
      <label class="dev-field"><span>드라이버</span><select id="dv-type">${opts((d.types || []).map(t => t.name), d.currentType)}</select></label>
      <label class="dev-field"><span>출력 기기</span><select id="dv-out">${opts(curType.outputs, d.output)}</select></label>
      <label class="dev-field"><span>입력 기기</span><select id="dv-in">${opts(curType.inputs, d.input)}</select></label>
      <label class="dev-field"><span>샘플레이트</span><select id="dv-sr">${opts(rates, Math.round(d.sampleRate))}</select></label>
      <label class="dev-field"><span>버퍼 크기</span><select id="dv-buf">${opts(d.buffers && d.buffers.length ? d.buffers : [128, 256, 512], d.bufferSize)}</select></label>
      <div style="display:flex;justify-content:flex-end"><button class="mini" id="dv-apply">적용</button></div>
    </div></div>`;
  host.hidden = false;
  host.querySelector('.x').addEventListener('click', () => host.hidden = true);
  // 드라이버 변경 → 즉시 전환 후 목록 갱신
  $('dv-type').addEventListener('change', (e) => { api.engine.setDevice({ type: e.target.value }); });
  $('dv-apply').addEventListener('click', () => {
    api.engine.setDevice({
      type: $('dv-type').value, output: $('dv-out').value, input: $('dv-in').value,
      sampleRate: Number($('dv-sr').value), bufferSize: Number($('dv-buf').value),
    });
    host.hidden = true;
  });
}

// ── 이벤트 ─────────────────────────────────────────
function onEngineEvent(m) {
  switch (m.ev) {
    case 'ready':
      _started = true;
      $('st-engine-status').textContent = '오디오 준비됨';
      $('st-engine-dot').classList.add('on');
      $('st-engine-start').hidden = true; $('st-engine-stop').hidden = false;
      setEnabled(true);
      api.engine.scanPlugins();   // 미리 스캔 → 톤 불러오기·VST 추가 즉시 가능
      break;
    case 'device':
      _sr = m.sr || 44100;
      $('st-engine-status').textContent = `${m.name} · ${Number(m.roundtripMs).toFixed(2)}ms`;
      if (m.srMismatch) flashTake(`⚠ 샘플레이트 불일치: 스템 ${Math.round(m.stemSr)}Hz ≠ 장치 ${Math.round(m.sr)}Hz — 피치/템포 어긋남. 장치 SR을 맞추세요.`);
      break;
    case 'fxError':
      flashTake(`⚠ 이펙트 ${m.failed}개 로드 실패 (플러그인 누락/버전)`);
      break;
    case 'exportProgress':
      flashTake(`내보내는 중… ${Math.round(m.pct)}%`);
      break;
    case 'exportDone':
      if (_exportMp3) {   // 임시 WAV 렌더 끝 → MP3 변환
        const job = _exportMp3, tmp = _exportTmp; _exportMp3 = null; _exportTmp = null;
        flashTake('MP3 변환 중…');
        api.audio.transcode(tmp, job.dst, { bitrate: job.bitrate }).then((r) => {
          _exporting = false;
          if (r && r.ok) { flashTake('내보내기 완료: ' + job.dst); api.openPath(job.dst); }
          else flashTake('MP3 변환 실패: ' + (r && r.error || ''));
        });
      } else {
        _exporting = false;
        flashTake('내보내기 완료: ' + (m.file || ''));
        if (m.file) api.openPath(m.file);
      }
      break;
    case 'exportError':
      _exporting = false; _exportMp3 = null; _exportTmp = null;
      flashTake('내보내기 실패: ' + (m.msg || ''));
      break;
    case 'plugins':
      _plugins = m.list || [];
      $('st-fx-add').disabled = false;
      break;
    case 'fxChain':
      _chainByTrack[m.trackId] = m.list || [];
      if (m.trackId === _selTrack) { _chain = m.list || []; renderFxSlots(); }
      hideFxOverlay();
      break;
    case 'fxState':
      if (_takeSetGather) {
        _takeSetGather.states[m.id] = m.data;
        if (_takeSetGather.need.every(id => _takeSetGather.states[id] != null)) finishTakeSetGather();
      }
      if (_presetGather) {
        _presetGather.states[m.id] = m.data;
        if (_presetGather.need.every(id => _presetGather.states[id] != null)) {
          const g = _presetGather; _presetGather = null;
          const slots = g.order.map((id, i) => ({ index: g.meta[i].index, bypass: g.meta[i].bypass, data: g.states[id] }));
          const preset = { id: g.id || ('p' + Date.now()), name: g.name, slots };
          upsertPreset(preset); _activePresetId = preset.id;
          if (!g.id) flashTake('톤 저장됨: ' + preset.name);
        }
      }
      break;
    case 'devices':
      if (_devOpen) { openDevModal(m); _devOpen = false; }
      else if (!$('daw-modal').hidden) openDevModal(m);   // 열려있으면 갱신
      break;
    case 'pos': onPos(m.samples); break;
    case 'level': updateVU(m.peak); break;
    case 'pitch': updateTuner(m.freq); break;
    case 'recTracks':
      _recTracks = m.list || [];
      if (m.gen != null) _recTracksGen = m.gen;
      _takes = _takes.filter(t => _recTracks.some(r => r.id === t.trackId));   // 삭제된 트랙의 테이크 정리(고아 방지)
      renderRecLanes(); updateSoloDim();
      if (_selTrack == null || !_recTracks.some(r => r.id === _selTrack)) {
        const a = armedRecId();                       // 선택 없으면 녹음 대상 자동 선택
        selectTrack(a != null ? a : null);
      } else updateFxPanel();
      break;
    case 'take':
      clearRecLive();
      flashTake(`녹음 저장: ${m.file}`);
      renderTake(m.file, m.timelineStart || 0, m.id, m.trackId);
      break;
    case 'exit':
      _started = false; _playing = false;
      $('st-engine-status').textContent = '오디오 꺼짐';
      $('st-engine-dot').classList.remove('on');
      $('st-engine-start').hidden = false; $('st-engine-start').disabled = false;
      $('st-engine-stop').hidden = true;
      _chain = []; _chainByTrack = {}; _selTrack = null; _recTracks = [];
      _recArmed = false; $('st-rec').classList.remove('armed'); clearRecLive();   // 재시작 후 녹음버튼 잔상 방지
      _activePresetId = null; renderFxSlots(); renderRecLanes(); updateFxPanel();
      setEnabled(false);
      break;
    case 'error': $('st-engine-status').textContent = '오디오 오류'; break;
    case 'log': {
      const s = String(m.msg || '');
      if (/fail|cannot|error|armed|writer|no device/i.test(s)) flashTake('엔진: ' + s.trim());
      break;
    }
  }
}

function renderFxSlots() {
  const pb = $('st-fx-bypassall');   // 전원 토글: 하나라도 켜져 있으면 active(초록)
  if (pb) { pb.classList.toggle('active', _chain.length > 0 && _chain.some(s => !s.bypass)); }
  const box = $('st-fx-slots'); if (!box) return;
  box.innerHTML = '';
  _chain.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'daw-fx-slot' + (s.bypass ? ' bypassed' : '');
    row.draggable = true; row.dataset.id = s.id;
    row.innerHTML = `<span class="drag" title="드래그로 순서 변경">⠿</span>
      <span class="pw ${s.bypass ? '' : 'on'}" title="클릭하면 켜기/끄기"></span>
      <div class="info"><div class="n">${s.name}</div></div>
      <button class="ed" title="편집" ${s.hasEditor ? '' : 'disabled'}>✎</button>
      <button class="del" title="삭제">✕</button>`;
    const pw = row.querySelector('.pw');
    pw.setAttribute('role', 'button'); pw.setAttribute('aria-pressed', String(!s.bypass));
    pw.addEventListener('click', () => {
      const ns = !s.bypass; s.bypass = ns;                     // 낙관적 갱신 (엔진 fxChain 로 재확정)
      row.classList.toggle('bypassed', ns);
      pw.classList.toggle('on', !ns);
      pw.setAttribute('aria-pressed', String(!ns));
      api.engine.fxBypass(_selTrack, s.id, ns);
    });
    row.querySelector('.ed').addEventListener('click', () => api.engine.fxEditor(_selTrack, s.id));
    row.querySelector('.del').addEventListener('click', () => api.engine.fxRemove(_selTrack, s.id));
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(s.id)); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => e.preventDefault());
    row.addEventListener('drop', (e) => { e.preventDefault(); reorderChain(Number(e.dataTransfer.getData('text/plain')), s.id); });
    box.appendChild(row);
  });
}
function reorderChain(fromId, toId) {
  if (fromId === toId) return;
  const ids = _chain.map(s => s.id);
  const fi = ids.indexOf(fromId), ti = ids.indexOf(toId);
  if (fi < 0 || ti < 0) return;
  ids.splice(ti, 0, ids.splice(fi, 1)[0]);
  api.engine.fxReorder(_selTrack, ids);
}

// ── 배선 ───────────────────────────────────────────
function wire() {
  if (_wired) return; _wired = true;
  api.engine.onEvent(onEngineEvent);

  $('st-engine-start').addEventListener('click', async () => {
    $('st-engine-start').disabled = true; $('st-engine-status').textContent = '연결 중…';
    const r = await api.engine.start([]);
    if (!r.ok) { $('st-engine-status').textContent = '오디오 엔진 없음'; $('st-engine-start').disabled = false; }
  });

  $('st-load-song').addEventListener('click', openSongPicker);

  const video = $('daw-video');
  video.addEventListener('loadedmetadata', () => { _dur = video.duration || 0; layout(); $('daw-vplay').hidden = false; });

  const play = playStudio, stopAll = stopStudio;   // 모듈 함수 별칭
  window._dawUpdatePlayIcon = updatePlayIcon;

  // 영상 클릭 = 재생/정지 (곡 로드 후에만)
  video.addEventListener('click', () => { if (!_dur) return; if (_playing) stopAll(); else play(); });
  // 진행바 클릭 = 이동
  $('daw-vbar').addEventListener('click', (e) => {
    if (!_dur || _recArmed) return;
    const r = $('daw-vbar').getBoundingClientRect();
    const t = Math.max(0, Math.min(_dur, ((e.clientX - r.left) / r.width) * _dur));
    api.engine.seek(Math.round(t * _sr)); video.currentTime = t; updatePlayhead(t);
  });

  $('st-play').addEventListener('click', play);
  $('st-stop').addEventListener('click', stopAll);

  // 스페이스바 = 재생/정지 (스튜디오 뷰 활성 + 입력창 아닐 때)
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const main = document.querySelector('main[data-view="studio"]');
    if (!main || main.hidden || !_started) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    if (_playing) stopAll(); else play();
  });
  // 마스터 볼륨 — 좌측 믹서 페이더 (하단바 슬라이더는 제거됨)
  const applyMaster = (v) => { api.engine.master(v / 100); $('mx-master').value = v; $('mx-master-val').textContent = v; };
  $('mx-master').addEventListener('input', (e) => applyMaster(Number(e.target.value)));
  $('mx-master').addEventListener('dblclick', () => applyMaster(100));   // 더블클릭 = 100 (유니티)
  // 선택 트랙 볼륨 페이더 (믹서 우측)
  const applyTrackVol = (v) => {
    if (_selTrack == null) return;
    const g = v / 100;
    api.engine.recTrack(_selTrack, { gain: g });
    const rt = _recTracks.find(r => r.id === _selTrack); if (rt) rt.gain = g;
    $('mx-track').value = v; $('mx-track-val').textContent = v;
    const lv = document.querySelector(`.daw-lane-rec[data-recid="${_selTrack}"] .daw-vol`); if (lv) lv.value = v;
  };
  $('mx-track').addEventListener('input', (e) => applyTrackVol(Number(e.target.value)));
  $('mx-track').addEventListener('dblclick', () => applyTrackVol(100));   // 더블클릭 = 100
  $('st-seek0').addEventListener('click', () => { if (_recArmed) return; api.engine.seek(0); video.currentTime = 0; updatePlayhead(0); });
  $('st-rec').addEventListener('click', () => {
    if (!_recArmed && !armedRecId()) { flashTake('먼저 “＋ 녹음 트랙”으로 녹음 트랙을 추가하고 R로 대상을 지정하세요.'); return; }
    _recArmed = !_recArmed;
    $('st-rec').classList.toggle('armed', _recArmed);
    $('st-rec').setAttribute('aria-pressed', String(_recArmed));
    if (_recArmed) api.engine.recordArm(); else { api.engine.recordStop(); clearRecLive(); }
  });

  $('st-zoom-in').addEventListener('click', () => { _pxPerSec = Math.min(200, _pxPerSec * 1.4); layout(); });
  $('st-zoom-out').addEventListener('click', () => { _pxPerSec = Math.max(2, _pxPerSec / 1.4); layout(); });

  // Ctrl+휠 = 배율(커서 기준). 그냥 휠 = 위아래 스크롤(네이티브)
  $('daw-tscroll').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;              // 배율은 Ctrl 눌렀을 때만
    if (!_dur) return;
    e.preventDefault();
    const sc = $('daw-tscroll');
    const rect = $('daw-lanes').getBoundingClientRect();
    const cursorX = e.clientX - rect.left - HEAD_W + sc.scrollLeft;
    const tAt = cursorX / _pxPerSec;
    const factor = Math.exp(-e.deltaY * 0.0015);
    _pxPerSec = Math.max(2, Math.min(200, _pxPerSec * factor));
    layout();
    sc.scrollLeft = Math.max(0, tAt * _pxPerSec - (e.clientX - rect.left - HEAD_W));
  }, { passive: false });

  // 타임라인 클릭 → 이동
  $('daw-tscroll').addEventListener('click', (e) => {
    if (!_dur || _recArmed || e.target.closest('.daw-head')) return;
    const rect = $('daw-lanes').getBoundingClientRect();
    const x = e.clientX - rect.left - HEAD_W;
    if (x < 0) return;
    const t = Math.max(0, Math.min(_dur, x / _pxPerSec));
    api.engine.seek(Math.round(t * _sr)); video.currentTime = t; updatePlayhead(t);
  });
  $('daw-tscroll').addEventListener('scroll', () => updatePlayhead(_lastSec));

  $('st-fx-add').addEventListener('click', () => {
    if (!_plugins.length) { api.engine.scanPlugins(); setTimeout(openVstPicker, 700); }
    else openVstPicker();
  });
  $('st-fx-save').addEventListener('click', () => {
    if (!_chain.length) { flashTake('추가된 VST가 없습니다.'); return; }
    const p = _activePresetId && getPresets().find(x => x.id === _activePresetId);
    if (p) { startGather({ id: p.id, name: p.name }); flashTake('톤 덮어씀: ' + p.name); }   // 활성 톤 덮어쓰기
    else openNameModal('톤 저장', '', (name) => startGather({ name }));                       // 활성 없으면 새로
  });
  $('st-fx-saveas').addEventListener('click', () => {
    if (!_chain.length) { flashTake('추가된 VST가 없습니다.'); return; }
    openNameModal('새 톤으로 저장', '', (name) => startGather({ name }));
  });
  $('st-fx-load').addEventListener('click', openPresetPicker);
  // 이펙트 일괄 끄기/켜기 (선택 트랙)
  $('st-fx-bypassall').addEventListener('click', () => {
    if (_selTrack == null || !_chain.length) { flashTake('추가된 VST가 없습니다.'); return; }
    const allOff = _chain.every(s => s.bypass);   // 전부 꺼져있으면 → 켜기, 아니면 → 끄기
    api.engine.fxBypassAll(_selTrack, !allOff);
  });
  // 트랙 빈 곳 스크럽 + 선택 (재렌더돼도 #daw-lanes 는 유지되므로 위임)
  $('daw-lanes').addEventListener('pointerdown', (e) => {
    const area = e.target.closest('.daw-area');
    if (!area || e.target.closest('.daw-clip, .daw-take-clip, .daw-drag-badge')) return;
    const lane = area.closest('.daw-lane-rec');
    if (lane) selectTrack(Number(lane.dataset.recid));
    scrubStart(e, area);
  });
  // 룰러에서 드래그 = 내보내기 범위 선택 (클릭만 하면 해제)
  $('daw-ruler-wrap').addEventListener('pointerdown', (e) => {
    if (!_dur) return;
    e.preventDefault();
    const wrap = $('daw-ruler-wrap'), sc = $('daw-tscroll');
    const toSec = (cx) => { const r = wrap.getBoundingClientRect(); return Math.max(0, Math.min(fullSec(), (cx - r.left - HEAD_W + sc.scrollLeft) / _pxPerSec)); };
    const a = toSec(e.clientX); let b = a;
    const mv = (ev) => { b = toSec(ev.clientX); _exportRange = { start: Math.min(a, b), end: Math.max(a, b) }; renderExportRange(); };
    const up = () => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
      if (Math.abs(b - a) < 0.08) { _exportRange = null; renderExportRange(); }   // 드래그 안 하면 해제
      else flashTake(`내보내기 범위: ${fmtBar(_exportRange.start)}–${fmtBar(_exportRange.end)}`);
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
  });
  $('st-engine-stop').addEventListener('click', () => { api.engine.quit(); });
  $('st-audio-settings').addEventListener('click', () => { _devOpen = true; api.engine.listDevices(); });
  $('st-take-save').addEventListener('click', () => {
    if (!_songKey) { flashTake('곡을 먼저 불러오세요.'); return; }
    if (!_takes.length) { flashTake('저장할 녹음이 없습니다.'); return; }
    openNameModal('녹음 저장', '', (name) => saveTakeSet(name));
  });
  $('st-take-load').addEventListener('click', openTakeSetPicker);

  // Export — 포맷/품질 선택 후 전체 믹스를 오프라인 렌더
  $('st-export').addEventListener('click', openExportModal);

  // 정지 시 시작 위치 복귀 토글 (설정 유지)
  _returnOnStop = localStorage.getItem('yss:returnOnStop') !== '0';
  $('st-return').classList.toggle('on', _returnOnStop);
  $('st-return').setAttribute('aria-pressed', String(_returnOnStop));
  $('st-return').addEventListener('click', () => {
    _returnOnStop = !_returnOnStop;
    localStorage.setItem('yss:returnOnStop', _returnOnStop ? '1' : '0');
    $('st-return').classList.toggle('on', _returnOnStop);
    $('st-return').setAttribute('aria-pressed', String(_returnOnStop));
    flashTake(_returnOnStop ? '정지 시 재생 시작 위치로 복귀 — 켬' : '정지 시 현재 위치 유지');
  });

  // 내 소리 모니터 on/off
  let _monOn = true;
  $('st-monitor').addEventListener('click', () => {
    _monOn = !_monOn;
    $('st-monitor').classList.toggle('on', _monOn);
    $('st-monitor').setAttribute('aria-pressed', String(_monOn));
    api.engine.inputMonitor(_monOn);
  });

  // 도구 드로어 — 열면 도구 선택 탭. 하나씩 사용.
  $('st-tools-toggle').addEventListener('click', () => { const d = $('daw-tools'); d.hidden = !d.hidden; });
  $('st-tools-close').addEventListener('click', () => { $('daw-tools').hidden = true; });
  const selectTool = (name) => {
    document.querySelectorAll('.daw-tool-tab').forEach(b => b.classList.toggle('on', b.dataset.tool === name));
    document.querySelectorAll('.daw-tool').forEach(el => { el.hidden = el.dataset.tool !== name; });
    const empty = $('tool-empty'); if (empty) empty.hidden = !!name;
  };
  document.querySelectorAll('.daw-tool-tab').forEach(b =>
    b.addEventListener('click', () => selectTool(b.classList.contains('on') ? null : b.dataset.tool)));   // 다시 누르면 닫기
  selectTool(null);   // 처음엔 아무 도구도 안 열림
}

export async function initStudio() { wire(); }
