// 스튜디오 DAW — 대형 영상 + 스템/녹음 트랙 + 저지연 엔진(JUCE)
//   엔진(오디오)=마스터 클럭. 영상은 muted 로 playhead 따라감(드리프트 보정).
import { Library } from './library.js';
import { toYtsepUrl, loadStemFilesToBuffers } from './player.js';
import { detectBeats } from './beat-detect.js';

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
let _rangeMode = false;     // 영역 선택 모드(룰러 드래그 = 내보내기 구간)
let _tracks = [];          // [{key,label,color,engineIndex}]
let _chain = [];              // 선택된 트랙의 FX 체인 미러 (_chainByTrack[_selTrack])
let _chainByTrack = {};       // trackId → [{id,index,name,hasEditor,bypass}]
let _selTrack = null;         // 선택(편집 대상) 녹음 트랙 id — 이펙트 패널 대상
let _selClipId = null;        // 선택 클립 id — 분할(S) 대상(마지막 클릭=주 선택)
let _selClips = new Set();    // 다중 선택 클립 id 집합
let _clipboard = [];          // 복사/잘라낸 클립 스냅샷 [{file,inOff,dur,srcDur,fadeIn,fadeOut,trackId,relStart}]
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
let _stemPaths = null;     // 현재 스템 경로맵 {key:path} — 프로젝트 저장용
let _songName = '';        // 현재 곡/프로젝트 이름
let _videoPath = null;     // 현재 영상 경로 (프로젝트 저장용)

const HEAD_W = 140;
const DEFAULT_LANE_H = 64;   // CSS .daw-lane 기본 높이 — 이보다 작게는 못 줄임(뷰 깨짐 방지)
// 마디(bar) 기준 눈금 — 템포 가정(추후 감지/조절 가능). 120BPM·4/4 → 1마디 2초
const BEATS_PER_BAR = 4;
let _bpm = 120;         // 조절 가능(그리드·스냅·룰러에 반영). 곡 로드 시 자동 감지
let _gridOffset = 0;    // 마디 위상(초) — 첫 다운비트에 그리드 정렬
let _beats = [];        // 감지된 실제 비트 시각(초, 스템 로컬) — 참고용 저장
let _detBpm = 0;        // 감지 당시 BPM(반올림) — ÷2/×2 보정 시 클릭 간격 조정 기준
let _beatInterval = 0;  // 감지된 정밀 박 간격(초) — 메트로놈 균일 그리드용
const secPerBar = () => BEATS_PER_BAR * 60 / _bpm;
const secPerBeat = () => 60 / _bpm;
// 그리드 스냅 — 위상(_gridOffset) 기준 1/4박(16분음표) 격자에 5px 이내면 스냅.
// 그 밖은 연속(픽셀 단위) 이동 → 세밀 배치 가능. Alt 누르면 스냅 완전 해제.
function snapSec(sec, disable) {
  if (disable) return Math.max(0, sec);
  const g = secPerBeat() / 4;   // 16분음표 격자(촘촘)
  const near = _gridOffset + Math.round((sec - _gridOffset) / g) * g;
  return Math.abs(near - sec) * _pxPerSec <= 5 ? Math.max(0, near) : Math.max(0, sec);
}
let _stemOffset = 0;   // 스템 전체 오프셋(초)
let _recTracks = [];   // 녹음 트랙 목록(엔진 동기) [{id,gain,mute,solo,armed}]
let _recTracksGen = 0, _recTracksGenReq = 0;   // 트랙 재구성 동기화 토큰
let _exporting = false, _exportMp3 = null, _exportTmp = null;   // export 진행 상태
// 녹음 대상 = 녹음(type 0) 트랙만
const armedRecId = () => (_recTracks.find(r => r.armed && r.type !== 1) || _recTracks.find(r => r.type !== 1) || {}).id;
// 클립 가로 드래그 유틸 — onDelta(초), onEnd
function dragClip(e, onDelta, onEnd) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX; let moved = false;
  const move = (ev) => { moved = true; onDelta((ev.clientX - startX) / _pxPerSec, ev.clientX, ev.clientY); };
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
// 화면 x → 재생선 이동
function seekToClientX(cx) {
  const rect = $('daw-lanes').getBoundingClientRect();
  const t = Math.max(0, Math.min(fullSec(), (cx - rect.left - HEAD_W) / _pxPerSec));
  api.engine.seek(Math.round(t * (_sr || 44100))); syncVideo(t); updatePlayhead(t);
}
// 룰러/트랙 빈 곳 클릭·드래그 = 재생선 따라오기(스크럽). 좌우 스크롤은 휠
function grabPan(e) {
  if (_recArmed) return;   // 녹음 중 재생위치 이동 금지
  clearClipSelection();    // 빈 곳 클릭 = 클립 선택 해제
  seekToClientX(e.clientX);
  const mv = (ev) => seekToClientX(ev.clientX);
  const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
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
    lane.dataset.selid = stemIdOf(t.engineIndex);   // 스템도 선택 가능(FX·볼륨 대상)
    const g100 = Math.round((t.gain != null ? t.gain : 1) * 100);
    const p100 = Math.round((t.pan != null ? t.pan : 0) * 100);
    lane.innerHTML = `
      <div class="daw-head" title="클릭하면 이 스템의 이펙트·볼륨 편집">
        <div class="nm"><i></i>${t.label}</div>
        <div class="ctrls">
          <button class="daw-ms${t.mute ? ' on' : ''}" data-m="mute" title="뮤트" aria-pressed="${!!t.mute}">M</button>
          <button class="daw-ms${t.solo ? ' on' : ''}" data-m="solo" title="솔로" aria-pressed="${!!t.solo}">S</button>
          <input class="daw-pan${p100 === 0 ? ' off' : ''}" type="range" min="-100" max="100" value="${p100}" title="팬 (더블클릭=센터)">
          <input class="daw-vol" type="range" min="0" max="150" value="${g100}" title="볼륨">
        </div>
        <div class="daw-meter" data-mid="${stemIdOf(t.engineIndex)}"><i class="l"></i><i class="r"></i></div>
      </div>
      <div class="daw-area"><div class="daw-clip"></div></div>`;
    lane.querySelector('.daw-head').addEventListener('pointerdown', () => selectTrack(stemIdOf(t.engineIndex)));
    const mBtn = lane.querySelector('[data-m="mute"]');
    const sBtn = lane.querySelector('[data-m="solo"]');
    const vol = lane.querySelector('.daw-vol');
    const pan = lane.querySelector('.daw-pan');
    mBtn.addEventListener('click', () => { const on = mBtn.classList.toggle('on'); mBtn.setAttribute('aria-pressed', String(on)); t.mute = on; api.engine.track(t.engineIndex, { mute: on }); markDirty(); });
    sBtn.addEventListener('click', () => { const on = sBtn.classList.toggle('on'); sBtn.setAttribute('aria-pressed', String(on)); t.solo = on; api.engine.track(t.engineIndex, { solo: on }); updateSoloDim(); markDirty(); });
    vol.addEventListener('input', () => {
      t.gain = Number(vol.value) / 100; api.engine.track(t.engineIndex, { gain: t.gain }); markDirty();
      if (stemIdOf(t.engineIndex) === _selTrack) { $('mx-track').value = vol.value; $('mx-track-val').textContent = vol.value; }   // 믹서 동기화
    });
    pan.addEventListener('input', () => {
      const v = Number(pan.value); t.pan = v / 100;
      pan.classList.toggle('off', v === 0);
      api.engine.track(t.engineIndex, { pan: t.pan }); markDirty();
    });
    pan.addEventListener('dblclick', () => { pan.value = 0; pan.classList.add('off'); t.pan = 0; api.engine.track(t.engineIndex, { pan: 0 }); markDirty(); });
    // 스템 클립 드래그 = 스템 전체 오프셋 (묶음 이동)
    const clip = lane.querySelector('.daw-clip');
    clip.addEventListener('click', (e) => e.stopPropagation());
    clip.addEventListener('pointerdown', (e) => {
      const base = _stemOffset;
      dragClip(e, (dSec, cx, cy) => {
        _stemOffset = snapSec(base + dSec, e.altKey); repositionStems();   // 0:00 뒤로 못 감 + 그리드 스냅
        showDragBadge(_stemOffset - base, cx, cy);
      }, (moved) => {
        hideDragBadge(); api.engine.stemOffset(Math.round(_stemOffset * (_sr || 44100)));
        if (moved && _stemOffset !== base) { const nw = _stemOffset; pushUndo(() => setStemOffset(base), () => setStemOffset(nw), '스템 이동'); markDirty(); }
      });
    });
    lanes.appendChild(lane);
  });
  renderRecLanes();
}

// 내 녹음 트랙 레인(여러 개) — 스템 레인은 건드리지 않음(파형 보존)
function renderRecLanes() {
  const lanes = $('daw-lanes');
  lanes.querySelectorAll('.daw-lane-rec, .daw-addrec-row, .daw-lanes-spacer').forEach(el => el.remove());
  let recN = 0, audN = 0;
  _recTracks.forEach((rt, idx) => {
    const isAudio = rt.type === 1;
    const autoLabel = isAudio ? `오디오 ${++audN}` : `내 녹음 ${++recN}`;
    const label = rt.name || autoLabel;
    const defColor = isAudio ? 'var(--stem-bass)' : 'var(--accent)';
    const lane = document.createElement('div');
    lane.className = 'daw-lane daw-lane-rec' + (isAudio ? ' daw-lane-audio' : '');
    lane.style.setProperty('--c', rt.color || defColor);
    if (rt.height) lane.style.height = rt.height + 'px';
    lane.dataset.key = 'rec-' + rt.id;
    lane.dataset.recid = rt.id;
    lane.dataset.selid = rt.id;
    lane.dataset.type = isAudio ? 'audio' : 'rec';
    const rBtnHtml = isAudio ? '' : `<button class="daw-ms daw-rec-arm${rt.armed ? ' armed' : ''}" data-m="arm" title="녹음 대상(arm)" aria-pressed="${!!rt.armed}">R</button>`;
    const rp100 = Math.round((rt.pan != null ? rt.pan : 0) * 100);
    lane.innerHTML = `
      <div class="daw-head" title="클릭하면 이 트랙의 입력 이펙트 편집">
        <div class="nm"><span class="daw-reorder" title="드래그해 순서 변경">⠿</span><i title="색 변경"></i><span class="lbl" title="더블클릭해 이름 변경">${esc(label)}</span></div>
        <div class="ctrls">
          ${rBtnHtml}
          <button class="daw-ms${rt.mute ? ' on' : ''}" data-m="mute" title="뮤트" aria-pressed="${!!rt.mute}">M</button>
          <button class="daw-ms${rt.solo ? ' on' : ''}" data-m="solo" title="솔로" aria-pressed="${!!rt.solo}">S</button>
          <input class="daw-pan${rp100 === 0 ? ' off' : ''}" type="range" min="-100" max="100" value="${rp100}" title="팬 (더블클릭=센터)">
          <input class="daw-vol" type="range" min="0" max="150" value="${Math.round((rt.gain != null ? rt.gain : 1) * 100)}" title="볼륨">
          <button class="daw-ms daw-rec-del" data-m="del" title="트랙 삭제">✕</button>
        </div>
        <div class="daw-meter" data-mid="${rt.id}"><i class="l"></i><i class="r"></i></div>
      </div>
      <div class="daw-area"></div>
      <div class="daw-lane-resize" title="드래그해 높이 조절"></div>`;
    const rBtn = lane.querySelector('[data-m="arm"]');
    const mBtn = lane.querySelector('[data-m="mute"]');
    const sBtn = lane.querySelector('[data-m="solo"]');
    const vol = lane.querySelector('.daw-vol');
    const pan = lane.querySelector('.daw-pan');
    const del = lane.querySelector('[data-m="del"]');
    // 헤드 클릭 = 트랙 선택 (버튼/슬라이더 조작은 각자 처리, 그래도 선택은 됨)
    lane.querySelector('.daw-head').addEventListener('pointerdown', () => selectTrack(rt.id));
    if (rBtn) rBtn.addEventListener('click', (e) => {   // R = 이 트랙을 녹음 대상으로 선택(arm). 녹음 시작은 ● 또는 R키
      e.stopPropagation();
      selectTrack(rt.id);
      api.engine.recArm(rt.id);
    });
    mBtn.addEventListener('click', (e) => { e.stopPropagation(); const on = mBtn.classList.toggle('on'); mBtn.setAttribute('aria-pressed', String(on)); rt.mute = on; api.engine.recTrack(rt.id, { mute: on }); });
    sBtn.addEventListener('click', (e) => { e.stopPropagation(); const on = sBtn.classList.toggle('on'); sBtn.setAttribute('aria-pressed', String(on)); rt.solo = on; api.engine.recTrack(rt.id, { solo: on }); updateSoloDim(); });
    vol.addEventListener('input', () => {
      rt.gain = Number(vol.value) / 100; api.engine.recTrack(rt.id, { gain: rt.gain });
      if (rt.id === _selTrack) { $('mx-track').value = vol.value; $('mx-track-val').textContent = vol.value; }   // 믹서 동기화
    });
    pan.addEventListener('input', (e) => {
      e.stopPropagation();
      const v = Number(pan.value); rt.pan = v / 100;
      pan.classList.toggle('off', v === 0);
      api.engine.recTrack(rt.id, { pan: rt.pan }); markDirty();
    });
    pan.addEventListener('dblclick', (e) => { e.stopPropagation(); pan.value = 0; pan.classList.add('off'); rt.pan = 0; api.engine.recTrack(rt.id, { pan: 0 }); markDirty(); });
    // 삭제: 녹음이 있는 트랙은 2단계 확인 (실수 방지)
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const takesN = _takes.filter(t => t.trackId === rt.id).length;
      if (del.dataset.confirm || takesN === 0) { clearTimeout(del._t); api.engine.recTrackRemove(rt.id); return; }
      del.dataset.confirm = '1'; del.textContent = '‼'; del.classList.add('confirm');
      flashTake(`이 트랙에 녹음 ${takesN}개 — 다시 누르면 함께 삭제`);
      del._t = setTimeout(() => { del.dataset.confirm = ''; del.textContent = '✕'; del.classList.remove('confirm'); }, 2500);
    });
    // 이름 변경 — 라벨 더블클릭 · 우클릭 메뉴 (autoLabel 기억)
    const lbl = lane.querySelector('.lbl');
    lbl.dataset.auto = autoLabel;
    lbl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRenameTrack(rt.id); });
    lane.querySelector('.daw-head').addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation(); selectTrack(rt.id);
      openDropdownAt(e.clientX, e.clientY, [
        { label: '이름 변경', fn: () => startRenameTrack(rt.id) },
        { label: '색 변경', fn: () => lane.querySelector('.nm i').click() },
        { label: '녹음 트랙 추가', fn: () => api.engine.recTrackAdd() },
        { label: '트랙 삭제', fn: () => del.click() },
      ]);
    });
    // 색 변경 — 점 클릭 → 색상 선택기
    const dot = lane.querySelector('.nm i');
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const ci = document.createElement('input');
      ci.type = 'color'; ci.value = rt.color ? rgbToHex(resolveColor(rt.color)) : rgbToHex(resolveColor(defColor));
      ci.style.cssText = 'position:fixed;left:-9999px';
      document.body.appendChild(ci);
      const oldColor = rt.color || '';
      ci.addEventListener('input', () => { rt.color = ci.value; lane.style.setProperty('--c', ci.value); });
      ci.addEventListener('change', () => { const nw = rt.color; ci.remove(); if (nw !== oldColor) pushUndo(() => setTrackProp(rt.id, 'color', oldColor), () => setTrackProp(rt.id, 'color', nw), '트랙 색'); });
      ci.click();
    });
    // 높이 조절 — 하단 그립 드래그
    const grip = lane.querySelector('.daw-lane-resize');
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startY = e.clientY, base = lane.offsetHeight, oldH = rt.height || 0;
      const mv = (ev) => { const h = Math.max(DEFAULT_LANE_H, Math.min(280, base + (ev.clientY - startY))); rt.height = h; lane.style.height = h + 'px'; updatePlayhead(_lastSec); renderExportRange(); };
      const up = () => {
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
        const nw = rt.height || 0;
        if (nw !== oldH) pushUndo(() => setTrackProp(rt.id, 'height', oldH), () => setTrackProp(rt.id, 'height', nw), '트랙 높이');
      };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    });
    // 순서 변경 — 그립 드래그로 리오더
    const reorder = lane.querySelector('.daw-reorder');
    reorder.addEventListener('pointerdown', (e) => wireReorder(e, rt, lane));
    lanes.appendChild(lane);
  });
  // 하단 추가버튼 제거(재생선 침범 방지). 추가는 좌상단 ＋ 버튼·트랙 우클릭으로.
  // 맨 아래 트랙 높이 조절 시 여유용 빈칸
  const spacer = document.createElement('div');
  spacer.className = 'daw-lanes-spacer';
  spacer.innerHTML = '<div class="sp-head"></div><div class="sp-area"></div>';
  lanes.appendChild(spacer);
  syncSelection();
  layout();
}

// ── 트랙 선택 (편집 대상) — 이펙트 패널 대상. 스템 트랙도 선택 가능 ──
const STEM_ID_BASE = 90001;
const isStemId = (id) => id != null && id >= STEM_ID_BASE;
const stemIdOf = (engineIndex) => STEM_ID_BASE + engineIndex;
const stemForId = (id) => (isStemId(id) ? _tracks.find(t => t.engineIndex === id - STEM_ID_BASE) : null);
function selTrackObj(id) { return isStemId(id) ? stemForId(id) : _recTracks.find(r => r.id === id); }
function selTrackLabel(id) {
  if (isStemId(id)) { const t = stemForId(id); return t ? t.label : '트랙'; }
  return document.querySelector(`.daw-lane-rec[data-recid="${id}"] .lbl`)?.textContent?.trim() || '트랙';
}
function selTrackGain(id) { const o = selTrackObj(id); return o && o.gain != null ? o.gain : 1; }
function applySelTrackGain(id, g) {   // 볼륨 라우팅 — 스템=track(index), 녹음=recTrack(id)
  const o = selTrackObj(id); if (o) o.gain = g;
  if (isStemId(id)) api.engine.track(id - STEM_ID_BASE, { gain: g });
  else api.engine.recTrack(id, { gain: g });
  markDirty();
}
function selValid(id) { return id != null && (_recTracks.some(r => r.id === id) || stemForId(id) != null); }
function selectTrack(id) {
  if (!selValid(id)) id = null;
  _selTrack = id;
  if (id != null) { _chain = _chainByTrack[id] || []; api.engine.fxChainReq(id); }
  else _chain = [];
  syncSelection();
  renderFxSlots();
  updateFxPanel();
}
function syncSelection() {   // 재렌더 후 선택 하이라이트 재적용 (data-selid: 녹음=id, 스템=stemId)
  if (!selValid(_selTrack)) _selTrack = null;
  document.querySelectorAll('.daw-lane').forEach(l =>
    l.classList.toggle('selected', l.dataset.selid != null && Number(l.dataset.selid) === _selTrack));
}
function updateFxPanel() {   // 선택된 트랙 있을 때만 이펙트 표시
  const left = document.querySelector('.daw-left');
  if (!left) return;
  const has = _selTrack != null;
  left.classList.toggle('empty', !has);
  const h = $('daw-left-h');
  if (h) h.textContent = has ? `${selTrackLabel(_selTrack)} 이펙트` : '입력 이펙트';
  updateTrackFader();
}
function updateTrackFader() {   // 믹서 우측 = 선택 트랙 볼륨
  const f = $('mx-track'), val = $('mx-track-val'), lbl = $('mx-track-lbl'); if (!f) return;
  if (selValid(_selTrack)) {
    const v = Math.round(selTrackGain(_selTrack) * 100);
    f.disabled = false; f.value = v; val.textContent = v;
    lbl.textContent = selTrackLabel(_selTrack);
  } else { f.disabled = true; f.value = 100; val.textContent = '—'; lbl.textContent = '트랙'; }
}

// ── 트랙 미터 (엔진 20Hz emit + 렌더러 rAF 감쇠) ──
const _meters = new Map();   // id → {curL, curR, holdL, holdR, holdLTs, holdRTs}
function onTrackMeter(list) {
  const now = performance.now();
  for (const m of list) {
    const st = _meters.get(m.id) || { curL: 0, curR: 0, holdL: 0, holdR: 0, holdLTs: 0, holdRTs: 0 };
    if (m.l > st.curL)  st.curL  = m.l;
    if (m.r > st.curR)  st.curR  = m.r;
    if (m.l > st.holdL) { st.holdL = m.l; st.holdLTs = now; }
    if (m.r > st.holdR) { st.holdR = m.r; st.holdRTs = now; }
    _meters.set(m.id, st);
  }
  if (!_metersRafOn) { _metersRafOn = true; requestAnimationFrame(_metersTick); }
}
let _metersRafOn = false, _metersLast = 0;
function _metersTick(ts) {
  const dt = Math.min(0.05, (ts - _metersLast) / 1000 || 0.016);
  _metersLast = ts;
  const decay = Math.exp(-dt * 5);        // curr peak: ~200ms 감쇠상수
  const holdMs = 800;                     // peak-hold 유지
  const holdDecay = Math.exp(-dt * 3);
  let anyLive = false;
  _meters.forEach((st, id) => {
    st.curL *= decay; st.curR *= decay;
    if (ts - st.holdLTs > holdMs) st.holdL *= holdDecay;
    if (ts - st.holdRTs > holdMs) st.holdR *= holdDecay;
    if (st.curL > 0.001 || st.curR > 0.001 || st.holdL > 0.001 || st.holdR > 0.001) anyLive = true;
    const el = document.querySelector(`.daw-meter[data-mid="${id}"]`);
    if (!el) return;
    const l100 = Math.min(100, st.curL * 100), r100 = Math.min(100, st.curR * 100);
    const hlL = Math.min(100, st.holdL * 100), hlR = Math.min(100, st.holdR * 100);
    const iL = el.children[0], iR = el.children[1];
    iL.style.setProperty('--v', l100 + '%');
    iR.style.setProperty('--v', r100 + '%');
    iL.style.setProperty('--hold', hlL + '%');
    iR.style.setProperty('--hold', hlR + '%');
    iL.style.setProperty('--holdOp', hlL > 1 ? '1' : '0');
    iR.style.setProperty('--holdOp', hlR > 1 ? '1' : '0');
    el.classList.toggle('clip', st.holdL >= 1.0 || st.holdR >= 1.0);
  });
  if (anyLive) requestAnimationFrame(_metersTick);
  else _metersRafOn = false;
}

// ── 드래그 이동량 배지 (+0:07) ──
function fmtDelta(sec) {   // +M:SS.cc (센티초까지) — 세밀 이동 확인용
  const a = Math.abs(sec), m = Math.floor(a / 60), s = a - m * 60;
  return `${sec >= 0 ? '+' : '−'}${m}:${s.toFixed(2).padStart(5, '0')}`;
}
// 커서를 따라다니는 배지 (트랙 뒤쪽에서 이동해도 보이게 화면 고정)
function showDragBadge(deltaSec, cx, cy) {
  let b = document.getElementById('daw-drag-badge');
  if (!b) { b = document.createElement('div'); b.id = 'daw-drag-badge'; b.className = 'daw-drag-badge'; document.body.appendChild(b); }
  b.textContent = fmtDelta(deltaSec);
  b.style.left = (cx + 14) + 'px'; b.style.top = (cy - 26) + 'px';
}
function hideDragBadge() { document.getElementById('daw-drag-badge')?.remove(); }

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
function rgbToHex(c) {   // "rgb(r,g,b)" 또는 "#rrggbb" → "#rrggbb" (색상 input 기본값용)
  c = String(c).trim();
  if (c[0] === '#') return c.length === 4 ? '#' + [...c.slice(1)].map(x => x + x).join('') : c.slice(0, 7);
  const m = c.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (!m) return '#888888';
  return '#' + [1, 2, 3].map(i => Number(m[i]).toString(16).padStart(2, '0')).join('');
}
// 트랙 순서 변경 — 그립 드래그. 포인터 아래 rec 레인 감지, up 시 배열 재배치
function wireReorder(e, rt, lane) {
  e.preventDefault(); e.stopPropagation();
  lane.classList.add('reordering');
  const mv = (ev) => {
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.daw-lane-rec');
    document.querySelectorAll('.daw-lane-rec.reorder-target').forEach(l => l.classList.remove('reorder-target'));
    if (over && over !== lane) over.classList.add('reorder-target');
  };
  const up = (ev) => {
    document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
    lane.classList.remove('reordering');
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.daw-lane-rec');
    document.querySelectorAll('.daw-lane-rec.reorder-target').forEach(l => l.classList.remove('reorder-target'));
    if (over && over !== lane) {
      const oldOrder = _recTracks.map(r => r.id);
      const from = _recTracks.findIndex(r => r.id === rt.id);
      const to = _recTracks.findIndex(r => r.id === Number(over.dataset.recid));
      if (from >= 0 && to >= 0) {
        const [m] = _recTracks.splice(from, 1); _recTracks.splice(to, 0, m); renderRecLanes(); renderTakes();
        const newOrder = _recTracks.map(r => r.id);
        pushUndo(() => reorderTracks(oldOrder), () => reorderTracks(newOrder), '트랙 순서');
      }
    }
  };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
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
  if (ruler && !document.getElementById('daw-erange')) {
    const e = document.createElement('div'); e.id = 'daw-erange'; e.className = 'daw-erange'; e.hidden = true;
    e.innerHTML = '<div class="daw-eh l" title="시작 조절"></div><div class="daw-eh r" title="끝 조절"></div>';
    ruler.appendChild(e);
    e.querySelector('.daw-eh.l').addEventListener('pointerdown', (ev) => dragExportEdge(ev, 'start'));
    e.querySelector('.daw-eh.r').addEventListener('pointerdown', (ev) => dragExportEdge(ev, 'end'));
    e.addEventListener('dblclick', (ev) => { ev.stopPropagation(); _exportRange = null; renderExportRange(); flashTake('내보내기 범위 해제'); });
  }
  const lanes = $('daw-lanes');
  let band = document.getElementById('daw-eband');
  if (lanes && (!band || band.parentElement !== lanes)) { if (band) band.remove(); band = document.createElement('div'); band.id = 'daw-eband'; band.className = 'daw-eband'; band.hidden = true; lanes.appendChild(band); }
}
// 범위 가장자리 핸들 드래그로 시작/끝 조절
function dragExportEdge(e, which) {
  e.preventDefault(); e.stopPropagation();
  const wrap = $('daw-ruler-wrap'), sc = $('daw-tscroll');
  const toSec = (cx) => Math.max(0, Math.min(fullSec(), (cx - wrap.getBoundingClientRect().left - HEAD_W + sc.scrollLeft) / _pxPerSec));
  const mv = (ev) => {
    const v = toSec(ev.clientX);
    if (which === 'start') _exportRange.start = Math.min(v, _exportRange.end - 0.02);
    else _exportRange.end = Math.max(v, _exportRange.start + 0.02);
    renderExportRange();
  };
  const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); flashTake(`내보내기 범위: ${fmtTC(_exportRange.start)}–${fmtTC(_exportRange.end)}`); };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
}
function renderExportRange() {
  const e = document.getElementById('daw-erange'), band = document.getElementById('daw-eband');
  if (!_exportRange) { if (e) e.hidden = true; if (band) band.hidden = true; return; }
  const x = _exportRange.start * _pxPerSec, w = (_exportRange.end - _exportRange.start) * _pxPerSec;
  if (e) { e.hidden = false; e.style.left = x + 'px'; e.style.width = w + 'px'; }
  if (band) { band.hidden = false; band.style.left = (HEAD_W + x) + 'px'; band.style.width = w + 'px'; band.style.height = tracksHeight() + 'px'; }
}
const fmtBar = (sec) => '마디 ' + (Math.floor((sec - _gridOffset) / secPerBar()) + 1);

// 타임라인 총 길이(초) — 소스 길이 + 여유(뷰포트는 채우되 무한 아님), 마디 단위로 반올림
function fullSec() {
  const sc = $('daw-tscroll');
  const vw = sc ? sc.clientWidth - HEAD_W : 1000;
  let content = _dur + _stemOffset;   // 오프셋된 스템 끝
  for (const t of _takes) content = Math.max(content, t.start + t.dur);   // 녹음 테이크 끝
  const base = Math.max(content, vw / _pxPerSec) + 8;   // 콘텐츠보다 조금 더 길게
  return Math.ceil(base / secPerBar()) * secPerBar();
}
const timelineW = () => Math.max(1, fullSec() * _pxPerSec);

function layout() {
  const w = timelineW();   // 타임라인 전체 폭 (오른쪽 회색 여백 제거)
  $('daw-lanes').style.width = (HEAD_W + w) + 'px';
  document.querySelectorAll('.daw-lane').forEach(l => { l.style.width = (HEAD_W + w) + 'px'; });
  const ruler = $('daw-ruler');
  ruler.style.width = w + 'px'; ruler.innerHTML = '';
  const spb = secPerBar();
  const barPx = spb * _pxPerSec;
  const phase = ((_gridOffset % spb) + spb) % spb;   // 첫 마디선 위치(0~1마디)
  $('daw-lanes').style.setProperty('--grid', barPx + 'px');   // 마디마다 그리드선
  $('daw-lanes').style.setProperty('--grid-off', (phase * _pxPerSec) + 'px');   // 다운비트 정렬
  const lblEvery = barPx >= 60 ? 1 : barPx >= 30 ? 2 : barPx >= 15 ? 4 : 8;   // 라벨 간격(마디)
  const end = fullSec();
  let bar = Math.round((phase - _gridOffset) / spb) + 1;   // 첫 선의 마디 번호
  for (let s = phase; s <= end + 0.001; s += spb, bar++) {
    const isLabel = bar >= 1 && (bar - 1) % lblEvery === 0;
    const tk = document.createElement('span');
    tk.className = 'tk' + (isLabel ? '' : ' minor');
    tk.style.left = (s * _pxPerSec) + 'px';
    if (isLabel) tk.textContent = bar;
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
// 트랙 영역 높이 — 하단 여유 스페이서 제외(재생선·범위밴드가 빈칸으로 안 나가게)
function tracksHeight() {
  const lanes = $('daw-lanes'); if (!lanes) return 0;
  const sp = lanes.querySelector('.daw-lanes-spacer');
  return (lanes.offsetHeight || 0) - (sp ? sp.offsetHeight : 0);
}
function updatePlayhead(sec) {
  _lastSec = sec;
  const ph = $('daw-playhead');
  if (!ph) return;
  ph.hidden = _tracks.length === 0 && _recTracks.length === 0;
  ph.style.left = (HEAD_W + sec * _pxPerSec) + 'px';
  ph.style.height = tracksHeight() + 'px';
  const pos = $('st-pos'); if (pos) pos.textContent = fmtTC(sec);
  $('daw-ruler').style.transform = `translateX(${-$('daw-tscroll').scrollLeft}px)`;
}

// ── 트랜스포트 (모듈 스코프 — 어디서든 호출 가능) ──
function updatePlayIcon() { const el = $('daw-vplay'); if (el) el.hidden = _playing; }
function playStudio() {
  _playStart = _lastSec;   // 재생 시작점 기억(정지 시 복귀)
  _playing = true; api.engine.play(); syncVideo(_playStart); updatePlayIcon();
}
function stopStudio() {
  _playing = false; api.engine.stop(); const v = $('daw-video'); if (v) v.pause(); updatePlayIcon();
  if (_recArmed) { _recArmed = false; $('st-rec').classList.remove('armed'); $('st-rec').setAttribute('aria-pressed', 'false'); api.engine.recordStop(); }
  clearRecLive();
  if (_returnOnStop) {   // 정지 시 재생 시작 위치로 복귀(옵션)
    const back = Math.max(0, _playStart || 0);
    api.engine.seek(Math.round(back * (_sr || 44100)));
    syncVideo(back);
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

// 영상 동기 — 스템 오프셋 반영. 영상시간 = 재생위치 - 스템오프셋 (스템이 시작되면 영상 재생)
function syncVideo(t) {
  const v = $('daw-video'); if (!v || !isFinite(v.duration)) return;
  const vt = t - _stemOffset;
  if (vt < 0) { if (!v.paused) v.pause(); if (Math.abs(v.currentTime) > 0.05) v.currentTime = 0; return; }
  const target = Math.min(vt, v.duration);
  if (Math.abs(v.currentTime - target) > 0.15) v.currentTime = target;
  if (_playing && v.paused && vt <= v.duration) v.play().catch(() => {});
}
function onPos(samples) {
  const t = (samples || 0) / (_sr || 44100);
  updatePlayhead(t);
  if (_recArmed && _playing) updateRecLive(t);
  const vdur = _dur > 0 ? _dur + _stemOffset : 0;
  if (vdur > 0) $('daw-vbar-fill').style.width = Math.min(100, Math.max(0, ((t - _stemOffset) / _dur) * 100)) + '%';
  syncVideo(t);
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
let _tunerHold = 0, _tunerBuf = [], _tunerNeedle = 50, _tunerTarget = 50, _tunerRAFon = false;
let _tunerRef = Number(localStorage.getItem('yss:tunerRef')) || 440;   // A4 기준음(Hz)
function setTunerRef(hz) {
  _tunerRef = hz; localStorage.setItem('yss:tunerRef', String(hz));
  document.querySelectorAll('#st-tuner-ref button').forEach(b => b.classList.toggle('on', Number(b.dataset.hz) === hz));
  _tunerBuf.length = 0;   // 기준 바뀌면 스무딩 리셋
}
// 데이터는 저빈도(엔진 이벤트)라도 바늘은 rAF 로 60fps 보간 → 부드러움
function tunerRAF() {
  const needle = $('st-tuner-needle');
  const tool = $('tool-tuner');
  if (needle && tool && !tool.hidden) {
    const d = _tunerTarget - _tunerNeedle;
    _tunerNeedle += d * 0.22;
    if (Math.abs(d) < 0.05) _tunerNeedle = _tunerTarget;
    needle.style.transform = `translateX(-50%) translateX(${((_tunerNeedle - 50) * 0.01) * (needle.parentElement?.clientWidth || 200)}px)`;
  }
  requestAnimationFrame(tunerRAF);
}
function updateTuner(freq) {
  const noteEl = $('st-tuner-note'), needle = $('st-tuner-needle'), centsEl = $('st-tuner-cents');
  if (!noteEl) return;
  if (!_tunerRAFon) { _tunerRAFon = true; requestAnimationFrame(tunerRAF); }   // 최초 1회 시작
  const octEl = $('st-tuner-oct'), freqEl = $('st-tuner-freq'), flat = $('st-tuner-flat'), sharp = $('st-tuner-sharp');
  const wrap = $('tool-tuner');
  if (!freq || freq < 40) {
    _tunerBuf.length = 0;
    if (Date.now() - _tunerHold > 900) {
      noteEl.textContent = '—'; if (octEl) octEl.textContent = ''; centsEl.textContent = '—'; if (freqEl) freqEl.textContent = '';
      flat && flat.classList.remove('on'); sharp && sharp.classList.remove('on');
      wrap && wrap.classList.remove('in-tune');
      needle && needle.classList.remove('in-tune');
      _tunerTarget = 50;   // 바늘은 rAF 가 가운데로 복귀
    }
    return;
  }
  _tunerHold = Date.now();
  // 스무딩: 최근 프레임 중앙값(스파이크 제거)
  _tunerBuf.push(freq); if (_tunerBuf.length > 7) _tunerBuf.shift();
  const sorted = [..._tunerBuf].sort((a, b) => a - b);
  const f = sorted[sorted.length >> 1];

  const n = 69 + 12 * Math.log2(f / _tunerRef);
  const nearest = Math.round(n);
  const cents = (n - nearest) * 100;
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12];
  const oct = Math.floor(nearest / 12) - 1;
  noteEl.textContent = name;
  if (octEl) octEl.textContent = oct;
  const inTune = Math.abs(cents) <= 4;
  noteEl.classList.toggle('in-tune', inTune);
  wrap && wrap.classList.toggle('in-tune', inTune);
  centsEl.textContent = (cents > 0 ? '+' : '') + cents.toFixed(0) + '¢';
  if (freqEl) freqEl.textContent = f.toFixed(1) + ' Hz';
  flat && flat.classList.toggle('on', cents < -4);
  sharp && sharp.classList.toggle('on', cents > 4);
  needle.classList.toggle('in-tune', inTune);
  _tunerTarget = Math.max(0, Math.min(100, 50 + cents));   // rAF 가 여기로 부드럽게 이동
}

function setEnabled(on) {
  ['st-load-song', 'st-file-menu', 'st-proj-name', 'st-bpm', 'st-bpm-half', 'st-bpm-double', 'st-seek0', 'st-play', 'st-stop', 'st-rec', 'st-return', 'st-range-mode', 'st-add-rec', 'st-zoom-in', 'st-zoom-out', 'st-tools-toggle', 'st-export', 'mx-master', 'st-fx-add', 'st-fx-save', 'st-fx-saveas', 'st-fx-load', 'st-fx-bypassall', 'st-audio-settings', 'st-monitor']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  updateCloseSongBtn();   // 곡 닫기는 스템 곡 로드 시에만
}
// 곡 닫기 버튼 — 라이브러리 스템 곡을 불러온 경우에만 활성화
function updateCloseSongBtn() {
  const el = $('st-close-song'); if (el) el.disabled = !(_started && _stemPaths);
}

// ── 파일 임포트 (내 파일로 편집 — DAW) ──────────────
let _clipSeq = Date.now() * 1000;   // 단조증가 → 루프·같은 ms 에도 항상 고유
function nextClipId() { return ++_clipSeq; }
async function newAudioTrack() {   // 오디오(임포트) 트랙 생성 후 새 id 반환
  const before = _recTracks.length;
  api.engine.recTrackAdd(1);   // type 1 = 오디오(녹음 불가)
  await new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { if (_recTracks.length > before || Date.now() - t0 > 2000) { clearInterval(iv); res(); } }, 25); });
  return _recTracks.length ? _recTracks[_recTracks.length - 1].id : null;
}
async function importAudio(paths, startSec, trackId) {
  if (!_started) { flashTake('먼저 상단 “오디오 시작”을 누르세요.'); return; }
  // 대상: 드롭한 오디오 레인이면 그 트랙, 아니면 새 오디오 트랙
  const dropTrack = _recTracks.find(t => t.id === trackId && t.type === 1);
  const tid = dropTrack ? dropTrack.id : await newAudioTrack();
  if (tid == null) { flashTake('트랙을 만들 수 없습니다.'); return; }
  const startS = Math.round(Math.max(0, startSec || 0) * (_sr || 44100));
  for (const p of paths) {
    const id = nextClipId();
    api.engine.takeLoad(p, startS, tid, id);
    await renderTake(p, startS, id, tid);
  }
  layout();   // 임포트 클립이 범위 밖이면 타임라인 연장
  markDirty();
  flashTake(`오디오 임포트: ${paths.length}개`);
}
async function pickImportAudio() {
  const r = await api.dialog.pickAudioFiles();
  if (r && r.ok && r.filePaths?.length) importAudio(r.filePaths, _lastSec, null);
}

// 불러온 스템 곡 닫기(되돌리기) — 스템·영상 비움, 내 녹음/임포트 트랙은 유지
function closeSong() {
  api.engine.loadStems([]);
  _tracks = []; _stemOffset = 0; _dur = 0; _songKey = null;
  _stemPaths = null; _videoPath = null;
  const v = $('daw-video'); if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
  const em = $('daw-video-empty'); if (em) em.hidden = false;
  renderTracks();
  updateCloseSongBtn();
  flashTake('곡을 닫았습니다.');
}

// ── 곡 로드 ────────────────────────────────────────
let _loadingSong = false;
async function loadSong(item, opts) {
  if (_loadingSong) return;   // 재진입 차단 (더블클릭 시 전역상태 오염)
  const it = item || Library.getSelected();
  if (!it) return;
  const autoBpm = !(opts && opts.autoBpm === false);   // 프로젝트 복원 시엔 감지 생략
  const paths = Object.values(it.stemPaths || {}).filter(Boolean);
  if (!paths.length) { flashTake('이 곡에 스템 파일이 없습니다.'); return; }
  _loadingSong = true;
  _songKey = String(it.videoPath || it.id);
  _stemPaths = it.stemPaths || null; _songName = it.name || ''; _videoPath = it.videoPath || null;
  _takes = []; _stemOffset = 0; _gridOffset = 0; _beats = []; _detBpm = 0; _beatInterval = 0; clearUndo();
  _projectPath = null; markClean();   // 라이브러리 곡 = 미저장 새 편집 상태

  const keys = Object.keys(it.stemPaths || {});
  _tracks = keys.map((k, i) => ({ key: k, label: STEM_LABEL[k] || k, color: STEM_COLOR[k] || 'var(--accent)', engineIndex: i }));
  renderTracks();
  updateCloseSongBtn();

  const v = $('daw-video');
  $('daw-video-empty').hidden = true;
  if (it.videoPath) { v.src = toYtsepUrl(it.videoPath); v.load(); }

  api.engine.loadStems(paths);
  api.engine.scanPlugins();
  flashTake(`불러옴: ${it.name}`);

  // 파형 (렌더러에서 디코드)
  flashTake(`불러옴: ${it.name} · 파형 분석 중…`);
  try {
    const { stems, sampleRate } = await loadStemFilesToBuffers(it.stemPaths);
    renderWaves(stems);
    flashTake(`불러옴: ${it.name}`);
    if (autoBpm) detectSongBpm(stems, sampleRate || _sr || 44100);   // drums 에서 BPM·박자 감지(비동기)
  } catch (e) { flashTake(`파형 디코드 실패: ${e && e.message || e}`); }
  finally { _loadingSong = false; }
}
// 곡 로드 후 drums stem 에서 BPM·다운비트 감지 → 그리드·스냅 정렬
async function detectSongBpm(stems, sampleRate) {
  try {
    const d = stems.drums;
    if (!d || !d[0] || !d[0].length) return;
    const mix = stems.other || stems.vocals || null;
    const res = await detectBeats(d[0], d[1] || d[0], sampleRate || 44100, mix ? [mix[0], mix[1] || mix[0]] : null);
    if (!res || !(res.tempo > 0)) return;
    _bpm = Math.max(20, Math.min(300, Math.round(res.tempo)));
    _detBpm = _bpm;
    _beatInterval = (res.beatInterval > 0) ? res.beatInterval : (60 / res.tempo);   // 정밀 박 간격
    const b = $('st-bpm'); if (b) b.value = _bpm;
    _beats = Array.isArray(res.beats) ? res.beats.slice() : [];
    const phase = (res.downbeat != null ? res.downbeat : (_beats.length ? _beats[0] : 0)) || 0;
    _gridOffset = Math.max(0, phase) + _stemOffset;   // 첫 다운비트에 마디 정렬
    layout();
    flashTake(`BPM ${_bpm} · 박자 자동 정렬`);
  } catch (e) { /* 감지 실패 — 수동 BPM 유지 */ }
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
    const tid = trackId != null ? trackId : armedRecId();
    const isAudio = (_recTracks.find(r => r.id === tid) || {}).type === 1;   // 오디오 트랙 클립 = 다른 색
    const srcDur = ch[0].length / (_sr || 44100);
    _takes.push({
      id: engineId != null ? engineId : Date.now(), file,
      trackId: tid,
      start: (startSamples || 0) / (_sr || 44100),
      inOff: 0, srcDur, dur: srcDur,   // 트림: inOff(소스 내 시작)·dur(가시 길이)·srcDur(전체)
      fadeIn: 0, fadeOut: 0,           // 페이드(초)
      svg: buildWaveSvg(ch, resolveColor(isAudio ? 'var(--stem-bass)' : 'var(--danger)')),
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
    el.className = 'daw-take-clip' + (_selClips.has(tk.id) ? ' sel' : '');
    el.style.left = (tk.start * _pxPerSec) + 'px';
    el.style.width = Math.max(3, tk.dur * _pxPerSec) + 'px';
    el.title = tk.file;
    // 파형 슬라이스: overflow 컨테이너 안에서 전체 소스 svg 를 inOff 만큼 밀기
    const wave = document.createElement('div');
    wave.className = 'daw-clip-wave';
    wave.style.left = (-tk.inOff * _pxPerSec) + 'px';
    wave.style.width = Math.max(3, tk.srcDur * _pxPerSec) + 'px';
    wave.innerHTML = tk.svg;
    el.appendChild(wave);
    // 페이드 오버레이(대각선) + 상단 코너 페이드 핸들
    const fgL = document.createElement('div'); fgL.className = 'daw-fade l';
    const fgR = document.createElement('div'); fgR.className = 'daw-fade r';
    const fhL = document.createElement('div'); fhL.className = 'daw-fadeh l';
    const fhR = document.createElement('div'); fhR.className = 'daw-fadeh r';
    el.appendChild(fgL); el.appendChild(fgR); el.appendChild(fhL); el.appendChild(fhR);
    const paintFades = () => {
      const wi = tk.fadeIn * _pxPerSec, wo = tk.fadeOut * _pxPerSec;
      fgL.style.width = wi + 'px'; fhL.style.left = wi + 'px';
      fgR.style.width = wo + 'px'; fhR.style.right = wo + 'px';
    };
    paintFades();
    wireFade(fhL, tk, paintFades, -1);
    wireFade(fhR, tk, paintFades, +1);
    // 좌·우 트림 핸들
    const hL = document.createElement('div'); hL.className = 'daw-trim l';
    const hR = document.createElement('div'); hR.className = 'daw-trim r';
    el.appendChild(hL); el.appendChild(hR);
    wireTrim(hL, tk, el, wave, -1);
    wireTrim(hR, tk, el, wave, +1);
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showTakeMenu(e.clientX, e.clientY, tk.id); });
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('daw-trim') || e.target.classList.contains('daw-fadeh')) return;   // 핸들은 트림·페이드
      e.preventDefault(); e.stopPropagation();
      // 선택 관리 — Ctrl/Cmd = 토글(멀티), 그 외 = 미선택이면 단독 선택
      if (e.ctrlKey || e.metaKey) {
        if (_selClips.has(tk.id)) _selClips.delete(tk.id); else _selClips.add(tk.id);
        _selClipId = tk.id; selectTrack(tk.trackId); renderTakes();
        return;   // Ctrl-클릭은 선택만
      }
      if (!_selClips.has(tk.id)) { _selClips = new Set([tk.id]); renderTakes(); }
      _selClipId = tk.id; selectTrack(tk.trackId);
      const multi = _selClips.size > 1;
      const startX = e.clientX, base = tk.start;
      // 그룹 이동 대상 + 이전 상태 스냅샷
      const group = multi ? _takes.filter(t => _selClips.has(t.id)) : [tk];
      const befores = group.map(t => ({ id: t.id, st: clipState(t), base: t.start }));
      const srcLane = el.closest('.daw-lane-rec');
      let target = srcLane, dragging = false;
      const move = (ev) => {
        if (!dragging && Math.abs(ev.clientX - startX) < 4) return;   // 임계값 전엔 클릭으로 취급
        dragging = true;
        const dSnap = snapSec(base + (ev.clientX - startX) / _pxPerSec, ev.altKey) - base;   // 스냅된 델타(주 클립 기준)
        group.forEach((t, i) => { t.start = Math.max(0, befores[i].base + dSnap); });
        if (multi) renderTakes();
        else el.style.left = (tk.start * _pxPerSec) + 'px';   // 단일은 가볍게
        // 단일 선택만 상하 트랙 이동 허용
        if (!multi) {
          const lane = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.daw-lane-rec');
          document.querySelectorAll('.daw-lane-rec.drop-target').forEach(l => l.classList.remove('drop-target'));
          if (lane) { target = lane; if (lane !== srcLane) lane.classList.add('drop-target'); }
        }
        showDragBadge(tk.start - base, ev.clientX, ev.clientY);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        hideDragBadge();
        document.querySelectorAll('.daw-lane-rec.drop-target').forEach(l => l.classList.remove('drop-target'));
        if (!dragging) { if (!_recArmed) seekToClientX(startX); return; }   // 클릭 = 재생선 이동(클립 위에서도)
        const sr = _sr || 44100;
        if (!multi) {
          const newId = target ? Number(target.dataset.recid) : tk.trackId;
          if (newId && newId !== tk.trackId) { tk.trackId = newId; api.engine.takeMove(tk.id, Math.round(tk.start * sr), newId); }
          else api.engine.takeMove(tk.id, Math.round(tk.start * sr), 0);
        } else group.forEach(t => api.engine.takeMove(t.id, Math.round(t.start * sr), 0));
        layout();   // 클립이 범위 밖으로 나가면 타임라인 연장 + 재배치
        const afters = group.map(t => ({ id: t.id, st: clipState(t) }));
        pushUndo(() => afters.forEach((a, i) => setClipState(befores[i].id, befores[i].st)),
                 () => afters.forEach(a => setClipState(a.id, a.st)), multi ? '클립 이동(다중)' : '클립 이동');
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    area.appendChild(el);
  }
}
const MIN_CLIP = 0.02;   // 최소 클립 길이(초)
// 트림 핸들: dir -1=좌, +1=우. 드래그로 inOff/dur 갱신, up 시 엔진 커밋
function wireTrim(handle, tk, el, wave, dir) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    selectTrack(tk.trackId); _selClipId = tk.id;
    const startX = e.clientX, bIn = tk.inOff, bDur = tk.dur, bStart = tk.start;
    const before = clipState(tk);
    const move = (ev) => {
      let d = (ev.clientX - startX) / _pxPerSec;   // 초
      if (dir < 0) {   // 좌측: inOff·start·dur 동시 이동
        d = Math.max(-bIn, Math.min(bDur - MIN_CLIP, d));
        tk.inOff = bIn + d; tk.start = bStart + d; tk.dur = bDur - d;
      } else {         // 우측: dur 만
        d = Math.max(MIN_CLIP - bDur, Math.min(tk.srcDur - bIn - bDur, d));
        tk.dur = bDur + d;
      }
      el.style.left = (tk.start * _pxPerSec) + 'px';
      el.style.width = Math.max(3, tk.dur * _pxPerSec) + 'px';
      wave.style.left = (-tk.inOff * _pxPerSec) + 'px';
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      commitTrim(tk); layout();
      const after = clipState(tk), id = tk.id;
      if (after.inOff !== before.inOff || after.dur !== before.dur || after.start !== before.start)
        pushUndo(() => setClipState(id, before), () => setClipState(id, after), '클립 트림');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
function commitTrim(tk) {
  const sr = _sr || 44100;
  api.engine.takeTrim(tk.id, Math.round(tk.start * sr), Math.round(tk.inOff * sr), Math.round(tk.dur * sr));
}
// 페이드 핸들: dir -1=인, +1=아웃. 코너 드래그로 길이 갱신, up 시 커밋
function wireFade(handle, tk, paint, dir) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    selectTrack(tk.trackId); _selClipId = tk.id;
    const startX = e.clientX, bIn = tk.fadeIn, bOut = tk.fadeOut;
    const before = clipState(tk);
    const move = (ev) => {
      const d = (ev.clientX - startX) / _pxPerSec;
      if (dir < 0) tk.fadeIn  = Math.max(0, Math.min(tk.dur, bIn + d));
      else         tk.fadeOut = Math.max(0, Math.min(tk.dur, bOut - d));
      paint();
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      commitFade(tk);
      const after = clipState(tk), id = tk.id;
      if (after.fadeIn !== before.fadeIn || after.fadeOut !== before.fadeOut)
        pushUndo(() => setClipState(id, before), () => setClipState(id, after), '페이드');
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
function commitFade(tk) {
  const sr = _sr || 44100;
  api.engine.takeFade(tk.id, Math.round(tk.fadeIn * sr), Math.round(tk.fadeOut * sr));
}
// 클립 복제 — 뒤로 dur 만큼 이어붙임
function duplicateClip(tk) {
  const id = nextClipId();
  const copy = { ...tk, id, start: tk.start + tk.dur };
  reAddClip(copy);
  pushUndo(() => removeClipById(id), () => reAddClip(copy), '클립 복제');
}
// 재생선 위치에서 선택 클립 분할
function splitSelectedAtPlayhead() {
  const tk = _takes.find(t => t.id === _selClipId); if (!tk) { flashTake('분할할 클립을 선택하세요.'); return; }
  splitClip(tk, _lastSec);
}
function splitClip(tk, atSec) {
  const rel = atSec - tk.start;
  if (rel <= MIN_CLIP || rel >= tk.dur - MIN_CLIP) { flashTake('클립 안쪽에서만 분할됩니다.'); return; }
  const sr = _sr || 44100;
  const newId = nextClipId();
  const origId = tk.id, origDur = tk.dur;
  // 뒷부분 = 새 클립
  const right = { ...tk, id: newId, start: tk.start + rel, inOff: tk.inOff + rel, dur: tk.dur - rel };
  tk.dur = rel;   // 앞부분
  _takes.push(right);
  api.engine.takeSplit(tk.id, Math.round(atSec * sr), newId);
  renderTakes();
  const doSplit = () => {   // 다시실행: 뒷조각 재생성 + 앞조각 길이 축소
    const o = _takes.find(t => t.id === origId); if (o) { o.dur = rel; api.engine.takeTrim(o.id, Math.round(o.start * sr), Math.round(o.inOff * sr), Math.round(rel * sr)); }
    reAddClip({ ...right });
  };
  pushUndo(() => {   // 실행취소: 뒷조각 제거 + 앞조각 원래 길이 복원
    removeClipById(newId);
    const o = _takes.find(t => t.id === origId); if (o) { o.dur = origDur; api.engine.takeTrim(o.id, Math.round(o.start * sr), Math.round(o.inOff * sr), Math.round(origDur * sr)); renderTakes(); layout(); }
  }, doSplit, '클립 분할');
}
function showTakeMenu(x, y, id) {
  document.querySelector('.daw-ctx')?.remove();
  const menu = document.createElement('div');
  menu.className = 'daw-ctx';
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.innerHTML = `<button class="split">재생선에서 분할</button><button class="dup">복제</button><button class="del">삭제</button>`;
  menu.querySelector('.split').addEventListener('click', () => {
    const tk = _takes.find(t => t.id === id); if (tk) splitClip(tk, _lastSec); menu.remove();
  });
  menu.querySelector('.dup').addEventListener('click', () => {
    const tk = _takes.find(t => t.id === id); if (tk) duplicateClip(tk); menu.remove();
  });
  menu.querySelector('.del').addEventListener('click', () => {
    const tk = _takes.find(t => t.id === id);
    const removed = tk ? { ...tk } : null;
    removeClipById(id); menu.remove();
    if (removed) pushUndo(() => reAddClip(removed), () => removeClipById(id), '클립 삭제');
  });
  document.body.appendChild(menu);
  const rc = menu.getBoundingClientRect(), mg = 8;
  if (rc.right > innerWidth - mg) menu.style.left = Math.max(mg, innerWidth - rc.width - mg) + 'px';
  if (rc.bottom > innerHeight - mg) menu.style.top = Math.max(mg, y - rc.height) + 'px';
  const close = (e) => { if (menu.contains(e.target)) return; menu.remove(); document.removeEventListener('mousedown', close); };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// 좌표에 드롭다운 메뉴 열기
function openDropdownAt(x, y, items) {
  document.querySelector('.daw-ctx')?.remove();
  const menu = document.createElement('div');
  menu.className = 'daw-ctx daw-dropdown';
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  items.forEach(it => {
    const b = document.createElement('button');
    b.textContent = it.label;
    b.addEventListener('click', () => { menu.remove(); it.fn(); });
    menu.appendChild(b);
  });
  document.body.appendChild(menu);
  // 화면 밖으로 나가지 않게 클램프
  const r = menu.getBoundingClientRect(), m = 8;
  if (r.right > innerWidth - m) menu.style.left = Math.max(m, innerWidth - r.width - m) + 'px';
  if (r.bottom > innerHeight - m) menu.style.top = Math.max(m, y - r.height) + 'px';
  const close = (ev) => { if (menu.contains(ev.target)) return; menu.remove(); document.removeEventListener('mousedown', close); };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}
// 앵커 버튼 아래 드롭다운 (툴바용)
function openDropdown(anchor, items) {
  const r = anchor.getBoundingClientRect();
  openDropdownAt(r.left, r.bottom + 4, items);
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
    id: r.id, type: r.type || 0, gain: r.gain != null ? r.gain : 1, mute: !!r.mute, solo: !!r.solo,
    name: r.name || '', color: r.color || '', height: r.height || 0,
    fxOrder: (_chainByTrack[r.id] || []).map(s => ({ id: s.id, index: s.index, bypass: s.bypass })),
  }));
  const takes = _takes.map(t => ({ id: t.id, file: t.file, start: Math.round(t.start * (_sr || 44100)), dur: t.dur, inOff: t.inOff || 0, srcDur: t.srcDur || t.dur, fadeIn: t.fadeIn || 0, fadeOut: t.fadeOut || 0, trackId: t.trackId }));
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
  return tracks.map(t => ({ id: t.id, type: t.type || 0, gain: t.gain, mute: t.mute, solo: t.solo, name: t.name || '', color: t.color || '', height: t.height || 0, fx: t.fxOrder.map(s => ({ index: s.index, bypass: s.bypass })) }));
}
function finishTakeSetGather() {
  const g = _takeSetGather; if (!g) return; _takeSetGather = null; clearTimeout(g._t);
  const tracks = g.tracks.map(t => ({
    id: t.id, type: t.type || 0, gain: t.gain, mute: t.mute, solo: t.solo,
    name: t.name || '', color: t.color || '', height: t.height || 0,
    fx: t.fxOrder.map(s => ({ index: s.index, bypass: s.bypass, data: g.states[s.id] })),
  }));
  persistTakeSet(g.name, tracks, g.takes);
}
function persistTakeSet(name, tracks, takes) {
  const a = getTakeSets(); a.push({ id: 't' + Date.now(), name, tracks, takes }); setTakeSets(a);
  flashTake('버전 저장됨: ' + name);
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
      api.engine.recTracksReset(ts.tracks.map(t => ({ type: t.type || 0, gain: t.gain, mute: t.mute, solo: t.solo })), gen);
      const ok = await waitRecTracks(gen);
      if (!ok) { flashTake('트랙 복원 시간 초과 — 다시 시도하세요.'); return; }
      idMap = {};   // 저장된 trackId(순서) → 새 트랙 id
      ts.tracks.forEach((t, i) => { if (_recTracks[i]) idMap[t.id] = _recTracks[i].id; });
      applyTrackMeta(ts.tracks);   // 이름·색·높이 복원
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
      // 트림·페이드 복원 (구버전 세트는 inOff/fade 없음)
      const tk = _takes.find(x => x.id === id);
      if (tk) {
        if (t.inOff || (t.srcDur && t.dur < t.srcDur - 1e-4)) { tk.inOff = t.inOff || 0; tk.dur = t.dur; commitTrim(tk); }
        if (t.fadeIn || t.fadeOut) { tk.fadeIn = t.fadeIn || 0; tk.fadeOut = t.fadeOut || 0; commitFade(tk); }
      }
    }
    renderTakes();
    clearUndo();
    flashTake('버전 불러옴: ' + ts.name);
  } finally { _loadingTakeSet = false; }
}

// ── 프로젝트(.yssproj) 저장/열기 — 라이브러리 탈종속 ──
let _fxGather = null;
let _chainGather = null;
// 모든 트랙의 FX 체인 목록을 엔진에서 받아와 _chainByTrack 채움(선택 안 된 트랙도).
// 저장 시 FX 누락 방지 — 이전엔 선택 트랙 체인만 알고 있었음.
function gatherChains(ids) {
  return new Promise((res) => {
    if (!ids.length) return res();
    _chainGather = { need: new Set(ids), res };
    ids.forEach(id => api.engine.fxChainReq(id));
    _chainGather._t = setTimeout(() => { const g = _chainGather; _chainGather = null; g.res(); }, 1500);
  });
}
function gatherFx(pairs) {   // pairs:[{track,id}] → Promise<{id:data}>
  return new Promise((res) => {
    if (!pairs.length) return res({});
    _fxGather = { need: pairs.map(p => p.id), states: {}, res };
    pairs.forEach(p => api.engine.fxSaveState(p.track, p.id));
    _fxGather._t = setTimeout(() => { const g = _fxGather; _fxGather = null; g.res(g.states); }, 2000);
  });
}
const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
function applyTrackMeta(savedTracks) {   // 저장 순서대로 이름·색·높이를 현재 트랙에 입힘
  savedTracks.forEach((t, i) => {
    if (!_recTracks[i]) return;
    if (t.name) _recTracks[i].name = t.name;
    if (t.color) _recTracks[i].color = t.color;
    if (t.height) _recTracks[i].height = t.height;
  });
  renderRecLanes();   // 이벤트 렌더는 메타 전이라 여기서 재렌더
}
async function buildProjectObject() {
  const sr = _sr || 44100;
  const master = Number($('mx-master')?.value ?? 100) / 100;
  const stemIds = _tracks.map(t => stemIdOf(t.engineIndex));
  await gatherChains([..._recTracks.map(r => r.id), ...stemIds]);   // 녹음+스템 FX 체인 확보(선택 안 된 것 포함)
  const pairs = [];
  _recTracks.forEach(r => (_chainByTrack[r.id] || []).forEach(s => pairs.push({ track: r.id, id: s.id })));
  stemIds.forEach(sid => (_chainByTrack[sid] || []).forEach(s => pairs.push({ track: sid, id: s.id })));
  const states = await gatherFx(pairs);
  const tracks = _recTracks.map(r => ({
    id: r.id, type: r.type || 0, gain: r.gain != null ? r.gain : 1, pan: r.pan != null ? r.pan : 0, mute: !!r.mute, solo: !!r.solo,
    name: r.name || '', color: r.color || '', height: r.height || 0,
    fx: (_chainByTrack[r.id] || []).map(s => ({ index: s.index, bypass: s.bypass, data: states[s.id] })),
  }));
  const takes = _takes.map(t => ({
    file: t.file, start: Math.round(t.start * sr), inOff: t.inOff || 0, dur: t.dur,
    srcDur: t.srcDur || t.dur, fadeIn: t.fadeIn || 0, fadeOut: t.fadeOut || 0, trackId: t.trackId,
  }));
  // 스템 트랙 믹스(볼륨·뮤트·솔로 + FX)까지 기록
  const stemMix = _tracks.map(t => {
    const sid = stemIdOf(t.engineIndex);
    return { key: t.key, gain: t.gain != null ? t.gain : 1, pan: t.pan != null ? t.pan : 0, mute: !!t.mute, solo: !!t.solo,
      fx: (_chainByTrack[sid] || []).map(s => ({ index: s.index, bypass: s.bypass, data: states[s.id] })) };
  });
  const stems = _stemPaths ? { paths: _stemPaths, offset: Math.round(_stemOffset * sr), videoPath: _videoPath || null, mix: stemMix } : null;
  return { kind: 'yssproj', version: 1, name: _songName || '프로젝트', savedAt: new Date().toISOString(), bpm: _bpm, detBpm: _detBpm, beatInterval: _beatInterval, gridOffset: _gridOffset, beats: _beats, master, stems, tracks, takes };
}
// 저장 상태 (프로젝트 경로 + 변경 여부)
let _projectPath = null;   // 저장된 .yssproj 경로 (없으면 미저장)
let _dirty = false;        // 마지막 저장 이후 변경 여부
let _suppressDirty = false;// 로드 중 dirty 표시 억제
function markDirty() { if (_suppressDirty) return; if (!_dirty) { _dirty = true; updateProjectLabel(); } }
function markClean() { _dirty = false; updateProjectLabel(); }
function updateProjectLabel() {
  const el = $('st-proj-name'); if (!el) return;
  const lab = el.querySelector('.pn-label'), dot = el.querySelector('.pn-dot');
  const name = _projectPath ? baseName(_projectPath) : (_songName ? _songName : '새 프로젝트');
  if (lab) lab.textContent = name + (_dirty ? ' •' : '');
  el.classList.toggle('dirty', _dirty);
  el.classList.toggle('unsaved', !_projectPath);
  el.title = (_projectPath ? name : '아직 저장 안 됨')
    + (_dirty ? ' — 저장되지 않은 변경 있음' : ' — 저장됨') + ' (Ctrl+S)';
}
// 저장: 경로 있으면 덮어쓰기, 없으면 새로 저장(다이얼로그)
async function saveProjectSmart() {
  if (!_stemPaths && !_takes.length && !_recTracks.length) { flashTake('저장할 내용이 없습니다.'); return; }
  const obj = await buildProjectObject();
  const r = await api.project.save(JSON.stringify(obj, null, 2), _songName || '프로젝트', _projectPath || undefined);
  if (r && r.ok) { _projectPath = r.path; _songName = baseName(r.path); markClean(); flashTake('저장됨: ' + r.path); }
  else if (!r || !r.canceled) flashTake('저장 실패');
}
const saveProject = saveProjectSmart;   // 드롭다운 '프로젝트 저장' 도 동일 로직
let _openingProject = false;
async function openProject() {
  if (_openingProject) return;
  const r = await api.project.open();
  if (!r || !r.ok) { if (r && r.error) flashTake('열기 실패: ' + r.error); return; }
  let p; try { p = JSON.parse(r.data); } catch { flashTake('프로젝트 파싱 실패'); return; }
  if (p.kind !== 'yssproj') { flashTake('올바른 프로젝트 파일이 아닙니다.'); return; }
  _openingProject = true;
  try { _songName = baseName(r.path); await applyProject(p); _projectPath = r.path; markClean(); }
  finally { _openingProject = false; }
}
async function applyProject(p) {
  const sr = _sr || 44100;
  _suppressDirty = true;
  api.engine.takeClear(); _takes = []; renderTakes();
  // 1) 스템 (있으면 로드, 없으면 스템 트랙 비움)
  if (p.stems && p.stems.paths && Object.keys(p.stems.paths).length) {
    await loadSong({ stemPaths: p.stems.paths, videoPath: p.stems.videoPath, name: p.name, id: p.name }, { autoBpm: false });
    _stemOffset = (p.stems.offset || 0) / sr;
    api.engine.stemOffset(Math.round(_stemOffset * sr));
    repositionStems();
    // 스템 트랙 믹스(볼륨·뮤트·솔로) 복원 — 파형 유지 위해 DOM 직접 갱신
    if (Array.isArray(p.stems.mix)) {
      p.stems.mix.forEach(m => {
        const t = _tracks.find(x => x.key === m.key); if (!t) return;
        t.gain = m.gain != null ? m.gain : 1; t.pan = m.pan != null ? m.pan : 0; t.mute = !!m.mute; t.solo = !!m.solo;
        api.engine.track(t.engineIndex, { gain: t.gain, pan: t.pan, mute: t.mute, solo: t.solo });
        const lane = document.querySelector(`.daw-lane[data-key="${t.key}"]`); if (!lane) return;
        const v = lane.querySelector('.daw-vol'); if (v) v.value = Math.round(t.gain * 100);
        const pn = lane.querySelector('.daw-pan'); if (pn) { const pv = Math.round(t.pan * 100); pn.value = pv; pn.classList.toggle('off', pv === 0); }
        const mb = lane.querySelector('[data-m="mute"]'); if (mb) { mb.classList.toggle('on', t.mute); mb.setAttribute('aria-pressed', String(t.mute)); }
        const sb = lane.querySelector('[data-m="solo"]'); if (sb) { sb.classList.toggle('on', t.solo); sb.setAttribute('aria-pressed', String(t.solo)); }
        if (Array.isArray(m.fx) && m.fx.length)   // 스템 FX 체인 복원
          api.engine.fxSetChain(stemIdOf(t.engineIndex), m.fx.map(s => ({ index: s.index, bypass: s.bypass, data: s.data })));
      });
      updateSoloDim();
    }
  } else {
    closeSong();
  }
  _songName = p.name || '';
  if (p.bpm) { _bpm = p.bpm; const b = $('st-bpm'); if (b) b.value = p.bpm; }
  _gridOffset = p.gridOffset || 0;
  _beats = Array.isArray(p.beats) ? p.beats.slice() : [];
  _detBpm = p.detBpm || 0; _beatInterval = p.beatInterval || 0;
  // 2) 녹음/오디오 트랙 레이아웃 + FX
  let idMap = null;
  if (Array.isArray(p.tracks) && p.tracks.length) {
    _recTracks = [];
    const gen = ++_recTracksGenReq;
    api.engine.recTracksReset(p.tracks.map(t => ({ type: t.type || 0, gain: t.gain, pan: t.pan || 0, mute: t.mute, solo: t.solo })), gen);
    const ok = await waitRecTracks(gen);
    if (!ok) { _suppressDirty = false; flashTake('트랙 복원 시간 초과 — 다시 시도하세요.'); return; }
    idMap = {};
    p.tracks.forEach((t, i) => { if (_recTracks[i]) idMap[t.id] = _recTracks[i].id; });
    applyTrackMeta(p.tracks);   // 이름·색·높이
    p.tracks.forEach((t, i) => {
      if (_recTracks[i] && Array.isArray(t.fx) && t.fx.length)
        api.engine.fxSetChain(_recTracks[i].id, t.fx.map(s => ({ index: s.index, bypass: s.bypass, data: s.data })));
    });
  }
  // 3) 클립 (트림·페이드 복원)
  for (const t of (p.takes || [])) {
    let tid = t.trackId;
    if (idMap && idMap[t.trackId] != null) tid = idMap[t.trackId];
    else if (!_recTracks.some(r => r.id === tid)) tid = armedRecId();
    const id = nextClipId();
    api.engine.takeLoad(t.file, t.start, tid, id);
    await renderTake(t.file, t.start, id, tid);
    const tk = _takes.find(x => x.id === id);
    if (tk) {
      if (t.inOff || (t.srcDur && t.dur < t.srcDur - 1e-4)) { tk.inOff = t.inOff || 0; tk.dur = t.dur; commitTrim(tk); }
      if (t.fadeIn || t.fadeOut) { tk.fadeIn = t.fadeIn || 0; tk.fadeOut = t.fadeOut || 0; commitFade(tk); }
    }
  }
  renderTakes();
  // 4) 마스터
  if (p.master != null) {
    api.engine.master(p.master);
    const v = Math.round(p.master * 100);
    const s = $('mx-master'); if (s) s.value = v;
    const mv = $('mx-master-val'); if (mv) mv.textContent = v;
  }
  layout();
  clearUndo();   // 새 상태 로드 → 히스토리 초기화
  _suppressDirty = false;
  flashTake('프로젝트 열림: ' + (p.name || ''));
}

// ── 실행취소/다시실행 (커맨드+역커맨드 스택) ──
let _undoStack = [], _redoStack = [];
const UNDO_MAX = 100;
function pushUndo(undo, redo, label) {
  _undoStack.push({ undo, redo, label });
  if (_undoStack.length > UNDO_MAX) _undoStack.shift();
  _redoStack = [];
  markDirty();   // 편집 발생 → 저장 필요 표시
  updateUndoUI();
}
function doUndo() { const a = _undoStack.pop(); if (!a) return; a.undo(); _redoStack.push(a); updateUndoUI(); markDirty(); flashTake('실행취소: ' + (a.label || '')); }
function doRedo() { const a = _redoStack.pop(); if (!a) return; a.redo(); _undoStack.push(a); updateUndoUI(); markDirty(); flashTake('다시실행: ' + (a.label || '')); }
function clearUndo() { _undoStack = []; _redoStack = []; updateUndoUI(); }
function updateUndoUI() {
  const u = $('st-undo'), r = $('st-redo');
  if (u) u.disabled = !_undoStack.length;
  if (r) r.disabled = !_redoStack.length;
}
// 클립 기하 스냅샷·복원 (엔진 커맨드로 재적용)
function clipState(tk) { return { start: tk.start, inOff: tk.inOff, dur: tk.dur, fadeIn: tk.fadeIn, fadeOut: tk.fadeOut, trackId: tk.trackId }; }
function setClipState(id, st) {
  const tk = _takes.find(t => t.id === id); if (!tk) return;
  Object.assign(tk, st);
  const sr = _sr || 44100;
  api.engine.takeMove(tk.id, Math.round(tk.start * sr), tk.trackId);
  api.engine.takeTrim(tk.id, Math.round(tk.start * sr), Math.round(tk.inOff * sr), Math.round(tk.dur * sr));
  api.engine.takeFade(tk.id, Math.round(tk.fadeIn * sr), Math.round(tk.fadeOut * sr));
  renderTakes(); layout();
}
function reAddClip(tkObj) {   // 삭제/분할 취소용 — 보관한 take 객체를 엔진·렌더러에 복구
  const sr = _sr || 44100;
  if (!_takes.some(t => t.id === tkObj.id)) _takes.push(tkObj);
  api.engine.takeLoad(tkObj.file, Math.round(tkObj.start * sr), tkObj.trackId, tkObj.id);
  api.engine.takeTrim(tkObj.id, Math.round(tkObj.start * sr), Math.round(tkObj.inOff * sr), Math.round(tkObj.dur * sr));
  api.engine.takeFade(tkObj.id, Math.round((tkObj.fadeIn || 0) * sr), Math.round((tkObj.fadeOut || 0) * sr));
  renderTakes(); layout();
}
function removeClipById(id) {
  api.engine.takeRemove(id);
  _takes = _takes.filter(t => t.id !== id);
  renderTakes(); layout();
}
// 트랙 이름 인라인 편집 시작 (라벨 → input)
function startRenameTrack(id) {
  const rt = _recTracks.find(r => r.id === id); if (!rt) return;
  const lbl = document.querySelector(`.daw-lane-rec[data-recid="${id}"] .lbl`); if (!lbl) return;
  const autoLabel = lbl.dataset.auto || '';
  const oldName = rt.name || '';
  const inp = document.createElement('input');
  inp.className = 'daw-nm-edit'; inp.value = rt.name || autoLabel;
  lbl.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const v = inp.value.trim();
    const nw = (v && v !== autoLabel) ? v : '';
    rt.name = nw;
    renderRecLanes(); updateFxPanel(); updateTrackFader();
    if (nw !== oldName) pushUndo(() => setTrackProp(rt.id, 'name', oldName), () => setTrackProp(rt.id, 'name', nw), '트랙 이름');
  };
  inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); else if (ev.key === 'Escape') { done = true; renderRecLanes(); } });
  inp.addEventListener('blur', commit);
}
function setTrackProp(id, key, val) {   // 이름·색·높이 (렌더러 전용 메타)
  const rt = _recTracks.find(r => r.id === id); if (!rt) return;
  rt[key] = val || (key === 'height' ? 0 : '');
  renderRecLanes(); updateFxPanel(); updateTrackFader();
}
function reorderTracks(orderIds) {
  _recTracks.sort((a, b) => orderIds.indexOf(a.id) - orderIds.indexOf(b.id));
  renderRecLanes(); renderTakes();
}
function setBpm(v) { _bpm = v; const b = $('st-bpm'); if (b) b.value = v; layout(); }
function setStemOffset(v) { _stemOffset = Math.max(0, v); repositionStems(); api.engine.stemOffset(Math.round(_stemOffset * (_sr || 44100))); layout(); }
// BPM 배수 보정 (감지가 ×2/÷2 로 틀릴 때)
function adjustBpm(factor) {
  const old = _bpm;
  const nw = Math.max(20, Math.min(300, Math.round(_bpm * factor)));
  if (nw === old) { flashTake('BPM 범위 밖입니다.'); return; }
  setBpm(nw);
  pushUndo(() => setBpm(old), () => setBpm(nw), 'BPM 보정');
}
// ── 다중선택 클립보드 (복사/잘라내기/붙여넣기/삭제) ──
function selectedTakes() { return _takes.filter(t => _selClips.has(t.id)); }
function clearClipSelection() { if (_selClips.size) { _selClips = new Set(); _selClipId = null; renderTakes(); } }
function copyClips() {
  const sel = selectedTakes(); if (!sel.length) return false;
  const minStart = Math.min(...sel.map(t => t.start));
  _clipboard = sel.map(t => ({ file: t.file, inOff: t.inOff, dur: t.dur, srcDur: t.srcDur, fadeIn: t.fadeIn, fadeOut: t.fadeOut, trackId: t.trackId, relStart: t.start - minStart, svg: t.svg }));
  flashTake(`복사됨: 클립 ${sel.length}개`);
  return true;
}
function cutClips() {
  const sel = selectedTakes(); if (!sel.length) return;
  copyClips();
  const removed = sel.map(t => ({ ...t }));
  removed.forEach(t => removeClipById(t.id));
  _selClips = new Set();
  pushUndo(() => { removed.forEach(reAddClip); }, () => { removed.forEach(t => removeClipById(t.id)); }, '잘라내기');
}
function pasteClips() {
  if (!_clipboard.length) { flashTake('붙여넣을 클립이 없습니다.'); return; }
  const at = _lastSec;
  // 현재 선택된 트랙에 붙여넣기 (선택 없으면 녹음 대상 트랙)
  const target = (_selTrack != null && _recTracks.some(r => r.id === _selTrack)) ? _selTrack : armedRecId();
  if (target == null) { flashTake('붙여넣을 트랙을 선택하세요.'); return; }
  const made = _clipboard.map((c) => {
    return { file: c.file, id: nextClipId(), trackId: target,
      start: at + c.relStart, inOff: c.inOff, dur: c.dur, srcDur: c.srcDur, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
      svg: c.svg || (_takes.find(t => t.file === c.file) || {}).svg || '' };
  });
  made.forEach(reAddClip);
  _selClips = new Set(made.map(m => m.id));
  renderTakes();
  pushUndo(() => { made.forEach(m => removeClipById(m.id)); }, () => { made.forEach(reAddClip); }, '붙여넣기');
  flashTake(`붙여넣음: 클립 ${made.length}개`);
}
function deleteSelectedClips() {
  const sel = selectedTakes(); if (!sel.length) return;
  const removed = sel.map(t => ({ ...t }));
  removed.forEach(t => removeClipById(t.id));
  _selClips = new Set();
  pushUndo(() => { removed.forEach(reAddClip); }, () => { removed.forEach(t => removeClipById(t.id)); }, '클립 삭제');
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
        <option value="range"${_exportRange ? '' : ' disabled'}>${_exportRange ? '선택 범위 (' + fmtTC(_exportRange.start) + '–' + fmtTC(_exportRange.end) + ')' : '선택 범위 (룰러에서 드래그)'}</option>
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
  if (!ps.length) { openModal('버전 불러오기 (이 곡)', '<div class="daw-modal-empty">이 곡에 저장된 버전이 없습니다.</div>', () => {}); return; }
  const host = $('daw-modal');
  const html = ps.map((p, i) => `<div class="daw-modal-item" data-idx="${i}">
    <div class="mt"><div class="n">${esc(p.name)}</div><div class="m">${p.takes.length} 테이크</div></div>
    <button class="daw-preset-del" data-id="${esc(p.id)}" title="삭제">✕</button></div>`).join('');
  openModal('버전 불러오기 (이 곡)', html, (idx) => loadTakeSet(ps[Number(idx)]));
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
      if (_chainGather && _chainGather.need.has(m.trackId)) {
        _chainGather.need.delete(m.trackId);
        if (!_chainGather.need.size) { const g = _chainGather; _chainGather = null; clearTimeout(g._t); g.res(); }
      }
      break;
    case 'fxState':
      if (_fxGather) {
        _fxGather.states[m.id] = m.data;
        if (_fxGather.need.every(id => _fxGather.states[id] != null)) { const g = _fxGather; _fxGather = null; clearTimeout(g._t); g.res(g.states); }
      }
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
    case 'trackMeter': onTrackMeter(m.list || []); break;
    case 'recTracks': {
      const prevMeta = new Map(_recTracks.map(r => [r.id, { name: r.name, color: r.color, height: r.height }]));
      _recTracks = (m.list || []).map(r => { const p = prevMeta.get(r.id); return p ? { ...r, ...p } : r; });   // 렌더러 전용 메타(이름·색·높이) id로 보존
      if (m.gen != null) _recTracksGen = m.gen;
      _takes = _takes.filter(t => _recTracks.some(r => r.id === t.trackId));   // 삭제된 트랙의 테이크 정리(고아 방지)
      renderRecLanes(); updateSoloDim();
      if (!selValid(_selTrack)) {   // 스템 선택은 유지
        const a = armedRecId() != null ? armedRecId() : (_recTracks[0] && _recTracks[0].id);   // 녹음 대상 우선, 없으면 아무 트랙
        selectTrack(a != null ? a : null);
      } else { syncSelection(); updateFxPanel(); }
      markDirty();
      break;
    }
    case 'take':
      clearRecLive();
      flashTake(`녹음 저장: ${m.file}`);
      renderTake(m.file, m.timelineStart || 0, m.id, m.trackId);
      markDirty();
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
  $('st-close-song').addEventListener('click', closeSong);

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
    const vt = Math.max(0, Math.min(_dur, ((e.clientX - r.left) / r.width) * _dur));   // 영상 시간
    const t = vt + _stemOffset;   // 재생 위치 = 영상시간 + 스템 오프셋
    api.engine.seek(Math.round(t * _sr)); syncVideo(t); updatePlayhead(t);
  });

  $('st-play').addEventListener('click', play);
  $('st-stop').addEventListener('click', stopAll);

  // 단축키: Space=재생/정지, R=녹음, S=분할, Ctrl+Z/Y=실행취소/다시실행
  document.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const isUndoKey = ctrl && e.code === 'KeyZ' && !e.shiftKey;
    const isRedoKey = ctrl && (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey));
    const isClip = ctrl && (e.code === 'KeyC' || e.code === 'KeyX' || e.code === 'KeyV');
    const isSaveKey = ctrl && e.code === 'KeyS';   // Ctrl+S = 프로젝트 저장
    const isDel = e.code === 'Delete' || e.code === 'Backspace';
    if (e.code !== 'Space' && e.code !== 'KeyR' && !(e.code === 'KeyS' && !ctrl) && !isSaveKey && !isUndoKey && !isRedoKey && !isClip && !isDel) return;
    const main = document.querySelector('main[data-view="studio"]');
    if (!main || main.hidden || !_started) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    e.preventDefault();
    if (isSaveKey) saveProjectSmart();
    else if (isRedoKey) doRedo();
    else if (isUndoKey) doUndo();
    else if (e.code === 'KeyC' && ctrl) copyClips();
    else if (e.code === 'KeyX' && ctrl) cutClips();
    else if (e.code === 'KeyV' && ctrl) pasteClips();
    else if (isDel) deleteSelectedClips();
    else if (e.code === 'Space') { if (_playing) stopAll(); else play(); }
    else if (e.code === 'KeyS') splitSelectedAtPlayhead();   // S = 재생선에서 분할
    else { if (_recArmed) stopAll(); else { const id = _selTrack != null ? _selTrack : armedRecId(); if (id != null) api.engine.recArm(id); armRecPlay(); } }
  });
  // 마스터 볼륨 — 좌측 믹서 페이더 (하단바 슬라이더는 제거됨)
  const applyMaster = (v) => { api.engine.master(v / 100); $('mx-master').value = v; $('mx-master-val').textContent = v; markDirty(); };
  $('mx-master').addEventListener('input', (e) => applyMaster(Number(e.target.value)));
  $('mx-master').addEventListener('dblclick', () => applyMaster(100));   // 더블클릭 = 100 (유니티)
  // 선택 트랙 볼륨 페이더 (믹서 우측)
  const applyTrackVol = (v) => {
    if (!selValid(_selTrack)) return;
    applySelTrackGain(_selTrack, v / 100);   // 스템=track(index)·녹음=recTrack(id) 라우팅
    $('mx-track').value = v; $('mx-track-val').textContent = v;
    const lv = document.querySelector(`.daw-lane[data-selid="${_selTrack}"] .daw-vol`); if (lv) lv.value = v;
  };
  $('mx-track').addEventListener('input', (e) => applyTrackVol(Number(e.target.value)));
  $('mx-track').addEventListener('dblclick', () => applyTrackVol(100));   // 더블클릭 = 100
  $('st-seek0').addEventListener('click', () => { if (_recArmed) return; api.engine.seek(0); syncVideo(0); updatePlayhead(0); });
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
    const sc = $('daw-tscroll');
    if (e.ctrlKey) {                       // Ctrl+휠 = 배율(커서 기준)
      e.preventDefault();
      const rect = $('daw-lanes').getBoundingClientRect();
      const cursorX = e.clientX - rect.left - HEAD_W + sc.scrollLeft;
      const tAt = cursorX / _pxPerSec;
      const factor = Math.exp(-e.deltaY * 0.0015);
      _pxPerSec = Math.max(2, Math.min(200, _pxPerSec * factor));
      layout();
      sc.scrollLeft = Math.max(0, tAt * _pxPerSec - (e.clientX - rect.left - HEAD_W));
    } else if (e.target.closest('.daw-head, .daw-addrec-head')) {
      return;   // 트랙 컨트롤부 위 = 위아래 스크롤(native 세로)
    } else {                               // 타임라인 위 = 가로 스크롤(촘촘하게)
      e.preventDefault();
      sc.scrollLeft += (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * 0.4;
      updatePlayhead(_lastSec);
    }
  }, { passive: false });

  $('daw-tscroll').addEventListener('scroll', () => updatePlayhead(_lastSec));

  // 오디오 파일 임포트 — 버튼 + 타임라인 드래그드롭
  $('st-file-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    openDropdown(e.currentTarget, [
      { label: '오디오 임포트…', fn: pickImportAudio },
      { label: '프로젝트 열기 (.yssproj)…', fn: openProject },
      { label: '프로젝트 저장 (독립 파일)…', fn: saveProject },
    ]);
  });
  $('st-undo').addEventListener('click', doUndo);
  $('st-redo').addEventListener('click', doRedo);
  $('st-bpm').addEventListener('change', (e) => {
    const old = _bpm;
    const v = Math.max(20, Math.min(300, Number(e.target.value) || 120));
    setBpm(v); e.target.value = v;
    if (v !== old) pushUndo(() => setBpm(old), () => setBpm(v), 'BPM');
  });
  $('st-bpm-half').addEventListener('click', () => adjustBpm(0.5));
  $('st-bpm-double').addEventListener('click', () => adjustBpm(2));
  const tscroll = $('daw-tscroll');
  ['dragenter', 'dragover'].forEach(ev => tscroll.addEventListener(ev, (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; tscroll.classList.add('drop-hi'); }));
  tscroll.addEventListener('dragleave', (e) => { if (e.target === tscroll) tscroll.classList.remove('drop-hi'); });
  tscroll.addEventListener('drop', (e) => {
    e.preventDefault(); tscroll.classList.remove('drop-hi');
    const audio = [...(e.dataTransfer?.files || [])].map(f => ({ name: f.name, path: api.pathForFile(f) }))
      .filter(f => f.path && /\.(wav|mp3|flac|ogg|aif|aiff|m4a|aac)$/i.test(f.name));
    if (!audio.length) return;
    const rect = $('daw-lanes').getBoundingClientRect();
    const startSec = Math.max(0, (e.clientX - rect.left - HEAD_W) / _pxPerSec);
    const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.daw-lane-rec');
    importAudio(audio.map(f => f.path), startSec, lane ? Number(lane.dataset.recid) : null);
  });

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
  // 트랙 빈 곳 드래그 = 팬(가로 스크롤), 클릭 = 재생선 이동 + 트랙 선택
  $('daw-lanes').addEventListener('pointerdown', (e) => {
    const area = e.target.closest('.daw-area');
    if (!area || e.target.closest('.daw-clip, .daw-take-clip, .daw-drag-badge')) return;
    const lane = area.closest('.daw-lane-rec');
    if (lane) selectTrack(Number(lane.dataset.recid));
    grabPan(e);
  });
  // 룰러: 드래그 = 팬(스크롤) · 클릭 = 재생선 이동 · Shift+드래그 = 내보내기 범위
  document.querySelector('.daw-ruler-ctrl')?.addEventListener('pointerdown', (e) => e.stopPropagation());   // 코너에서 스크럽 방지
  $('daw-ruler-wrap').addEventListener('pointerdown', (e) => {
    if (e.target.closest('.daw-ruler-ctrl, .daw-eh')) return;   // 토글 셀·범위핸들은 각자 처리
    if (!_dur && !_takes.length && !_recTracks.length) return;   // 임포트만 있어도 동작
    e.preventDefault();
    const wrap = $('daw-ruler-wrap'), sc = $('daw-tscroll');
    const toSec = (cx) => { const r = wrap.getBoundingClientRect(); return Math.max(0, Math.min(fullSec(), (cx - r.left - HEAD_W + sc.scrollLeft) / _pxPerSec)); };
    if (_rangeMode || e.shiftKey) {   // 영역 선택 모드(또는 Shift) = 내보내기 범위
      const a = toSec(e.clientX); let b = a;
      const mv = (ev) => { b = toSec(ev.clientX); _exportRange = { start: Math.min(a, b), end: Math.max(a, b) }; renderExportRange(); };
      const up = () => {
        document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
        if (Math.abs(b - a) < 0.08) { _exportRange = null; renderExportRange(); }
        else flashTake(`영역: ${fmtTC(_exportRange.start)}–${fmtTC(_exportRange.end)}`);
      };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    } else {   // 룰러 클릭·드래그 = 재생선 따라오기(스크럽)
      grabPan(e);
    }
  });
  $('st-range-mode').addEventListener('click', () => {
    _rangeMode = !_rangeMode;
    $('st-range-mode').classList.toggle('on', _rangeMode);
    $('st-range-mode').setAttribute('aria-pressed', String(_rangeMode));
    $('daw-ruler-wrap').classList.toggle('range-mode', _rangeMode);
    flashTake(_rangeMode ? '영역 선택 모드 — 룰러를 드래그하세요' : '영역 선택 모드 해제');
  });
  $('st-add-rec').addEventListener('click', () => api.engine.recTrackAdd());   // 코너 ＋ = 녹음 트랙 추가
  // 트랙 빈 영역(레인 스크롤) 우클릭 = 트랙 추가
  $('daw-tscroll').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.daw-lane-rec, .daw-take-clip, .daw-clip')) return;   // 트랙/클립 위는 각자 메뉴
    if (!_started) return;
    e.preventDefault();
    openDropdownAt(e.clientX, e.clientY, [{ label: '녹음 트랙 추가', fn: () => api.engine.recTrackAdd() }]);
  });
  $('st-engine-stop').addEventListener('click', () => { api.engine.quit(); });
  $('st-audio-settings').addEventListener('click', () => { _devOpen = true; api.engine.listDevices(); });
  $('st-proj-name').addEventListener('click', saveProjectSmart);   // 이름 클릭 = 저장
  updateProjectLabel();

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

  // 튜너 기준음 칩
  const refBox = $('st-tuner-ref');
  if (refBox) { refBox.querySelectorAll('button').forEach(b => b.addEventListener('click', () => setTunerRef(Number(b.dataset.hz)))); setTunerRef(_tunerRef); }
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
