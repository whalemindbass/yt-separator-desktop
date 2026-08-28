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
let _veResolution = null;   // null = 자동(첫 클립 기준). 아니면 {w,h} — 사용자가 고른 렌더 해상도.
let _veExportRange = null;   // {start, end} 초 — 눈금자 드래그로 지정한 내보내기 구간(없으면 전체).
let _veRangeMode = false;    // true 면 눈금자 드래그가 재생선 이동 대신 구간 지정(Shift 없이도).
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
      tracks: _veTracks.map(({ id, name, color, height, hidden, kind, transform }) => ({ id, name, color, height, hidden, kind, transform })),
      clips: _veClips.map(({ id, trackId, file, name, start, inOff, srcDur, dur, w, h, hasAudio, isAudioOnly, groupId, flipH, flipV, fadeIn, fadeOut, color, hdr, fx }) =>
        ({ id, trackId, file, name, start, inOff, srcDur, dur, w, h, hasAudio, isAudioOnly, groupId, flipH, flipV, fadeIn, fadeOut, color, hdr, fx })),
      resolution: _veResolution,
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
    _veResolution = p.resolution || null;
    ensureLayers();
  }
  syncResUI();
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
  } else {
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    // rAF 를 멈추면 그걸로 끝이 아니다 — <video> 는 el.play() 로 일단 재생을 시작시켜 두면
    // 우리가 더 이상 손대지 않는 한 자기 혼자 계속 돈다. syncPreview 는 매 tick 마다
    // "_playing 이 꺼졌으면 pause" 를 하는데, 그 tick 자체가 이제 안 오니 한 번은 직접
    // 불러줘야 실제로 멈춘다 — 이걸 빼먹어서 정지해도 영상이 계속 재생되는 버그가 있었다.
    syncPreview(_playheadSec);
  }
}
function updatePlayheadUI() {
  // 위치는 이 transform 이 전부다 — CSS 쪽에 left 를 또 주면(예전에 그랬다) 172px 가
  // 두 번 더해져 트랙 위 클립보다 항상 오른쪽으로 밀려 보였다.
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
  // 오디오 트랙은 화면에 아무것도 안 그려야 한다(영상 트랙 위를 덮으면 안 됨) — opacity:0 으로
  // 고정해 두고 재생/정지만 다룬다(hidden 은 안 건드린다 — display:none 이 오디오까지 멈추는
  // 경우를 피하려고).
  _veTracks.forEach((t, i) => {
    let pair = _layerEls.get(t.id);
    if (!pair) {
      const isAudio = t.kind === 'audio';
      const mk = () => {
        const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto';
        if (isAudio) v.style.opacity = '0';
        host.appendChild(v); return v;
      };
      pair = { a: mk(), b: mk() };
      _layerEls.set(t.id, pair);
    }
    const z = String(_veTracks.length - i);
    pair.a.style.zIndex = z; pair.b.style.zIndex = z;
    applyTrackTransform(pair, t);
  });
}
// 트랙 단위 위치/크기(PIP) — 레이어 그림을 다루듯 구석에 작게 놓거나 확대할 수 있게.
// 애니메이션(키프레임)은 v1 범위 밖 — 트랙 전체에 고정값 하나만 적용한다.
function defaultTransform() { return { x: 0, y: 0, scale: 1 }; }
function applyTrackTransform(pair, track) {
  const tf = track.transform || defaultTransform();
  for (const el of [pair.a, pair.b]) {
    el.style.left = (tf.x * 100) + '%';
    el.style.top = (tf.y * 100) + '%';
    el.style.width = (tf.scale * 100) + '%';
    el.style.height = (tf.scale * 100) + '%';
  }
}
// ── PIP(위치/크기) 팝오버 — 트랙 헤더 우측 버튼에서 연다. 레이어처럼 구석에 작게 놓거나
// 확대할 수 있다. 애니메이션은 없다(트랙 전체에 고정값 하나).
let _pipPopoverEl = null;
function onOutsidePip(e) { if (_pipPopoverEl && !_pipPopoverEl.contains(e.target)) closePipPopover(); }
function closePipPopover() {
  if (!_pipPopoverEl) return;
  _pipPopoverEl.remove(); _pipPopoverEl = null;
  document.removeEventListener('pointerdown', onOutsidePip, true);
}
function openPipPopover(track, anchorEl) {
  closePipPopover();
  const tf = track.transform || defaultTransform();
  const r = anchorEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 've-pip-pop';
  pop.style.left = r.left + 'px'; pop.style.top = (r.bottom + 6) + 'px';
  pop.innerHTML = `
    <label>${tr('video.pipX')}<input type="number" id="pip-x" min="0" max="100" step="1" value="${Math.round(tf.x * 100)}">%</label>
    <label>${tr('video.pipY')}<input type="number" id="pip-y" min="0" max="100" step="1" value="${Math.round(tf.y * 100)}">%</label>
    <label>${tr('video.pipScale')}<input type="number" id="pip-scale" min="10" max="100" step="1" value="${Math.round(tf.scale * 100)}">%</label>
    <button class="mini" id="pip-reset">${tr('video.pipReset')}</button>`;
  document.body.appendChild(pop);
  _pipPopoverEl = pop;
  const apply = () => {
    const x = Math.max(0, Math.min(100, Number(pop.querySelector('#pip-x').value) || 0)) / 100;
    const y = Math.max(0, Math.min(100, Number(pop.querySelector('#pip-y').value) || 0)) / 100;
    const scale = Math.max(0.1, Math.min(1, (Number(pop.querySelector('#pip-scale').value) || 100) / 100));
    const isDefault = x === 0 && y === 0 && scale === 1;
    track.transform = isDefault ? null : { x, y, scale };
    const pair = _layerEls.get(track.id);
    if (pair) applyTrackTransform(pair, track);
    anchorEl.classList.toggle('on', !isDefault);
    scheduleSave();
  };
  pop.querySelector('#pip-x').addEventListener('input', apply);
  pop.querySelector('#pip-y').addEventListener('input', apply);
  pop.querySelector('#pip-scale').addEventListener('input', apply);
  pop.querySelector('#pip-reset').addEventListener('click', () => {
    pop.querySelector('#pip-x').value = 0; pop.querySelector('#pip-y').value = 0; pop.querySelector('#pip-scale').value = 100;
    apply();
  });
  setTimeout(() => document.addEventListener('pointerdown', onOutsidePip, true), 0);
}
// ── 색보정(밝기/대비/채도) — 클립 단위. 0 = 보정 없음. 미리보기는 CSS filter(brightness/
// contrast/saturate, 전부 "1 기준 배율"), 내보내기는 ffmpeg eq 필터로 같은 값을 쓴다 —
// 픽셀 단위로 완전히 똑같진 않지만(CPU/CSS 구현이 다르니) 같은 방향·정도로 보정된다.
let _colorPopoverEl = null;
function onOutsideColor(e) { if (_colorPopoverEl && !_colorPopoverEl.contains(e.target)) closeColorPopover(); }
function closeColorPopover() {
  if (!_colorPopoverEl) return;
  _colorPopoverEl.remove(); _colorPopoverEl = null;
  document.removeEventListener('pointerdown', onOutsideColor, true);
}
function colorFilterCss(color) {
  if (!color) return '';
  const b = 1 + (color.b || 0) / 100, c = 1 + (color.c || 0) / 100, s = 1 + (color.s || 0) / 100;
  if (b === 1 && c === 1 && s === 1) return '';
  return `brightness(${b}) contrast(${c}) saturate(${s})`;
}
// FX(대표 효과) — 흑백/세피아/블러. CSS 함수(grayscale/sepia/blur)가 그대로 있어서
// 내보내기 쪽(ffmpeg)도 같은 뜻의 필터로 맞추면 된다(색보정 때와 같은 방식).
function fxFilterCss(fx) {
  if (!fx) return '';
  const parts = [];
  if (fx.bw) parts.push('grayscale(1)');
  if (fx.sepia) parts.push('sepia(1)');
  if (fx.blur) parts.push(`blur(${fx.blur}px)`);
  return parts.join(' ');
}
function openColorPopover(clip, anchorEl) {
  closeColorPopover();
  const col = clip.color || { b: 0, c: 0, s: 0 };
  const fx = clip.fx || { bw: false, sepia: false, blur: 0 };
  const r = anchorEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 've-color-pop';
  pop.style.left = r.left + 'px'; pop.style.top = (r.bottom + 6) + 'px';
  pop.innerHTML = `
    <label><span>${tr('video.colorBrightness')}</span><input type="range" id="cc-b" min="-100" max="100" step="1" value="${col.b}"><span id="cc-b-v">${col.b}</span></label>
    <label><span>${tr('video.colorContrast')}</span><input type="range" id="cc-c" min="-100" max="100" step="1" value="${col.c}"><span id="cc-c-v">${col.c}</span></label>
    <label><span>${tr('video.colorSaturation')}</span><input type="range" id="cc-s" min="-100" max="100" step="1" value="${col.s}"><span id="cc-s-v">${col.s}</span></label>
    <div class="ve-color-sep"></div>
    <label class="ve-color-chk"><input type="checkbox" id="cc-bw" ${fx.bw ? 'checked' : ''}><span>${tr('video.fxBw')}</span></label>
    <label class="ve-color-chk"><input type="checkbox" id="cc-sepia" ${fx.sepia ? 'checked' : ''}><span>${tr('video.fxSepia')}</span></label>
    <label><span>${tr('video.fxBlur')}</span><input type="range" id="cc-blur" min="0" max="20" step="1" value="${fx.blur}"><span id="cc-blur-v">${fx.blur}</span></label>
    <button class="mini" id="cc-reset">${tr('video.pipReset')}</button>`;
  document.body.appendChild(pop);
  _colorPopoverEl = pop;
  const apply = () => {
    const b = Number(pop.querySelector('#cc-b').value) || 0;
    const c = Number(pop.querySelector('#cc-c').value) || 0;
    const s = Number(pop.querySelector('#cc-s').value) || 0;
    pop.querySelector('#cc-b-v').textContent = b; pop.querySelector('#cc-c-v').textContent = c; pop.querySelector('#cc-s-v').textContent = s;
    const isDefault = b === 0 && c === 0 && s === 0;
    clip.color = isDefault ? null : { b, c, s };

    const bw = pop.querySelector('#cc-bw').checked;
    const sepia = pop.querySelector('#cc-sepia').checked;
    const blur = Number(pop.querySelector('#cc-blur').value) || 0;
    pop.querySelector('#cc-blur-v').textContent = blur;
    const fxDefault = !bw && !sepia && !blur;
    clip.fx = fxDefault ? null : { bw, sepia, blur };

    anchorEl.classList.toggle('on', !isDefault || !fxDefault);
    syncPreview(nowSec());
    scheduleSave();
  };
  pop.querySelector('#cc-b').addEventListener('input', apply);
  pop.querySelector('#cc-c').addEventListener('input', apply);
  pop.querySelector('#cc-s').addEventListener('input', apply);
  pop.querySelector('#cc-bw').addEventListener('input', apply);
  pop.querySelector('#cc-sepia').addEventListener('input', apply);
  pop.querySelector('#cc-blur').addEventListener('input', apply);
  pop.querySelector('#cc-reset').addEventListener('click', () => {
    pop.querySelector('#cc-b').value = 0; pop.querySelector('#cc-c').value = 0; pop.querySelector('#cc-s').value = 0;
    pop.querySelector('#cc-bw').checked = false; pop.querySelector('#cc-sepia').checked = false; pop.querySelector('#cc-blur').value = 0;
    apply();
  });
  setTimeout(() => document.addEventListener('pointerdown', onOutsideColor, true), 0);
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
function driveLayer(el, clip, t, visual) {
  if (visual) {
    el.hidden = false;
    const sx = clip.flipH ? -1 : 1, sy = clip.flipV ? -1 : 1;
    el.style.transform = (sx !== 1 || sy !== 1) ? `scale(${sx}, ${sy})` : '';
    el.style.filter = [colorFilterCss(clip.color), fxFilterCss(clip.fx)].filter(Boolean).join(' ');
  }
  // 영상 클립이 짝(groupId, 오디오 트랙의 오디오 클립)을 가지고 있으면 소리는 그 짝이
  // 낸다 — 이 레이어는 화면만 그리고 무음이어야 한다(둘 다 소리 내면 겹쳐 들린다).
  // 짝이 없는(예전 프로젝트 등) 클립은 자기 소리를 그대로 낸다.
  el.muted = visual && !!clip.groupId;
  if (el.dataset.loadedSrc !== clip.file) { el.src = toYtsepUrl(clip.file); el.dataset.loadedSrc = clip.file; }
  const target = Math.min(clip.inOff + (t - clip.start), (el.duration || clip.srcDur) - 0.02);
  if (Math.abs(el.currentTime - target) > 0.1) { try { el.currentTime = Math.max(0, target); } catch {} }
  if (_playing && el.paused) el.play().catch(() => {});
  if (!_playing && !el.paused) el.pause();
}
function hideLayer(el, visual) { if (visual) { el.hidden = true; el.style.opacity = ''; } if (!el.paused) el.pause(); }
// 클립 자체 페이드인/아웃 배율(0~1) — 같은 트랙 크로스페이드 믹스와 곱해서 합성한다.
function fadeMul(clip, t) {
  let m = 1;
  const localT = t - clip.start;
  if (clip.fadeIn) m *= Math.max(0, Math.min(1, localT / clip.fadeIn));
  if (clip.fadeOut) m *= Math.max(0, Math.min(1, (clip.start + clip.dur - t) / clip.fadeOut));
  return m;
}
function syncPreview(t) {
  let any = false;
  for (const track of _veTracks) {
    const pair = _layerEls.get(track.id); if (!pair) continue;
    const { a, b } = pair;
    const visual = track.kind !== 'audio';   // 영상 트랙만 화면에 그린다 — 오디오 트랙은 소리만.
    if (track.hidden) { hideLayer(a, visual); hideLayer(b, visual); continue; }
    const here = clipsAt(track.id, t);
    if (here.length >= 2) {
      const outClip = here[0], inClip = here[1];   // outClip: 먼저 시작해 곧 끝남 · inClip: 나중에 들어와 이어감
      const overlapStart = inClip.start, overlapEnd = outClip.start + outClip.dur;
      const mix = overlapEnd > overlapStart ? Math.min(1, Math.max(0, (t - overlapStart) / (overlapEnd - overlapStart))) : 1;
      const fa = (1 - mix) * fadeMul(outClip, t), fb = mix * fadeMul(inClip, t);
      driveLayer(a, outClip, t, visual); if (visual) a.style.opacity = String(fa); a.volume = fa;
      driveLayer(b, inClip, t, visual); if (visual) b.style.opacity = String(fb); b.volume = fb;
      any = true;
    } else if (here.length === 1) {
      const f = fadeMul(here[0], t);
      driveLayer(a, here[0], t, visual); if (visual) a.style.opacity = String(f); a.volume = f;
      hideLayer(b, visual);
      any = true;
    } else {
      hideLayer(a, visual); hideLayer(b, visual);
    }
  }
  return any;
}

// ── 렌더(내보내기) 해상도 — buildEDL()/미리보기 프레임 크기가 여기서 나온다.
// 사용자가 고르지 않았으면 예전처럼 프로젝트의 첫 영상 클립 크기를 그대로 쓴다(자동).
function getResolution() {
  if (_veResolution) return _veResolution;
  const c = _veClips.find(c => !c.isAudioOnly && c.w && c.h);
  return c ? { w: c.w, h: c.h } : { w: 1280, h: 720 };
}
// _veResolution → 해상도 선택 UI(드롭다운/사용자 지정 칸) 표시를 맞춘다(프로젝트 복원 시 등).
function syncResUI() {
  const resSel = $('ve-res'), resCustom = $('ve-res-custom'), resW = $('ve-res-w'), resH = $('ve-res-h');
  if (!resSel) return;
  if (!_veResolution) { resSel.value = 'auto'; if (resCustom) resCustom.hidden = true; return; }
  const preset = `${_veResolution.w}x${_veResolution.h}`;
  if ([...resSel.options].some(o => o.value === preset)) {
    resSel.value = preset; if (resCustom) resCustom.hidden = true;
  } else {
    resSel.value = 'custom';
    if (resCustom) resCustom.hidden = false;
    if (resW) resW.value = _veResolution.w;
    if (resH) resH.value = _veResolution.h;
  }
}
// 미리보기 틀(#ve-preview) 크기를 실제 렌더 해상도 비율대로 정확히 맞춘다 — 이게 없으면
// 미리보기가 그냥 패널을 꽉 채워서, 어디까지가 진짜 출력 프레임이고 어디부터가 여백인지
// 구분이 안 됐다(PIP 위치도 이 틀 기준 퍼센트라 틀이 틀리면 미리보기와 실제 결과물이 어긋난다).
function sizePreviewFrame() {
  const wrap = $('ve-preview-wrap'), host = $('ve-preview');
  if (!wrap || !host) return;
  const availW = wrap.clientWidth, availH = wrap.clientHeight;
  if (!availW || !availH) return;
  const { w, h } = getResolution();
  const scale = Math.min(availW / w, availH / h);
  host.style.width = Math.max(1, Math.round(w * scale)) + 'px';
  host.style.height = Math.max(1, Math.round(h * scale)) + 'px';
}

// ── 내보내기 범위(눈금자에서 드래그로 지정) — 스튜디오와 같은 패턴 ──────
function veTracksHeight() { return _veTracks.reduce((s, t) => s + (t.height || DEFAULT_LANE_H), 0); }
function ensureExportEls() {
  const ruler = $('ve-ruler');
  if (ruler && !document.getElementById('ve-erange')) {
    const e = document.createElement('div'); e.id = 've-erange'; e.className = 've-erange'; e.hidden = true;
    e.innerHTML = `<div class="ve-eh l" data-i18n-title="video.adjustStart" title="${tr('video.adjustStart')}"></div><div class="ve-eh r" data-i18n-title="video.adjustEnd" title="${tr('video.adjustEnd')}"></div>`;
    ruler.appendChild(e);
    e.querySelector('.ve-eh.l').addEventListener('pointerdown', (ev) => dragExportEdge(ev, 'start'));
    e.querySelector('.ve-eh.r').addEventListener('pointerdown', (ev) => dragExportEdge(ev, 'end'));
    e.addEventListener('dblclick', (ev) => { ev.stopPropagation(); _veExportRange = null; renderExportRange(); flash(tr('video.rangeCleared')); });
  }
  const lanes = $('ve-lanes');
  let band = document.getElementById('ve-eband');
  if (lanes && (!band || band.parentElement !== lanes)) {
    if (band) band.remove();
    band = document.createElement('div'); band.id = 've-eband'; band.className = 've-eband'; band.hidden = true;
    lanes.appendChild(band);
  }
}
function dragExportEdge(e, which) {
  e.preventDefault(); e.stopPropagation();
  const ruler = $('ve-ruler');
  const toSec = (cx) => Math.max(0, Math.min(fullSec(), (cx - ruler.getBoundingClientRect().left) / _pxPerSec));
  const mv = (ev) => {
    const v = toSec(ev.clientX);
    if (which === 'start') _veExportRange.start = Math.min(v, _veExportRange.end - 0.02);
    else _veExportRange.end = Math.max(v, _veExportRange.start + 0.02);
    renderExportRange();
  };
  const up = () => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    flash(tr('video.rangeSet', { a: fmtTC(_veExportRange.start), b: fmtTC(_veExportRange.end) }));
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}
function renderExportRange() {
  const e = document.getElementById('ve-erange'), band = document.getElementById('ve-eband');
  if (!_veExportRange) { if (e) e.hidden = true; if (band) band.hidden = true; return; }
  const x = _veExportRange.start * _pxPerSec, w = (_veExportRange.end - _veExportRange.start) * _pxPerSec;
  if (e) { e.hidden = false; e.style.left = x + 'px'; e.style.width = w + 'px'; }
  if (band) { band.hidden = false; band.style.left = (HEAD_W + x) + 'px'; band.style.width = w + 'px'; band.style.height = veTracksHeight() + 'px'; }
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
  ensureExportEls(); renderExportRange();
  renderClips();
  updatePlayheadUI();
  sizePreviewFrame();
  syncPreview(nowSec());   // 임포트·트림·분할·삭제 등으로 배치가 바뀌면 미리보기도 바로 반영
  const empty = $('ve-empty'); if (empty) empty.hidden = _veClips.length > 0;
  if (_loaded) scheduleSave();   // 복원 도중(초기 렌더)엔 저장할 필요 없다
}

// ── 트랙/레인 ────────────────────────────────────────
function newVideoTrack(pushHistory = true) {
  const id = nextTrackId();
  const color = TRACK_COLORS[(_veTracks.length) % TRACK_COLORS.length];
  const track = { id, name: '', color, height: DEFAULT_LANE_H, hidden: false, kind: 'video' };
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
function newAudioTrack(pushHistory = true) {
  const id = nextTrackId();
  const color = TRACK_COLORS[(_veTracks.length) % TRACK_COLORS.length];
  const track = { id, name: '', color, height: DEFAULT_LANE_H, hidden: false, kind: 'audio' };
  // Vegas Pro 관례: 오디오 트랙은 영상 트랙 구역 아래(목록 맨 아래)에 자리한다.
  _veTracks.push(track);
  if (pushHistory) {
    pushUndo(
      () => { _veTracks = _veTracks.filter(t => t.id !== id); _veClips = _veClips.filter(c => c.trackId !== id); },
      () => { _veTracks.push(track); },
    );
  }
  ensureLayers();
  renderLanes();
  return id;
}
// 이름 없는 트랙의 기본 이름 — 영상/오디오 각자 자기 종류 안에서 순번을 센다
// (Vegas 처럼 영상 트랙 구역과 오디오 트랙 구역이 따로다).
function trackLabel(vt) {
  if (vt.name) return vt.name;
  const sameKind = _veTracks.filter(t => (t.kind === 'audio') === (vt.kind === 'audio'));
  const n = sameKind.indexOf(vt) + 1;
  return vt.kind === 'audio' ? tr('video.audioTrackN', { n }) : tr('video.trackN', { n });
}

function renderLanes() {
  const lanes = $('ve-lanes'); if (!lanes) return;
  lanes.querySelectorAll('.ve-lane').forEach(el => el.remove());
  _veTracks.forEach((vt) => {
    const lane = document.createElement('div');
    lane.className = 've-lane' + (vt.kind === 'audio' ? ' audio' : '');
    lane.style.setProperty('--c', vt.color);
    if (vt.height) lane.style.height = vt.height + 'px';
    lane.dataset.trackId = String(vt.id);
    lane.innerHTML = `
      <div class="ve-head">
        <div class="nm">
          <span class="ve-reorder" data-i18n-title="video.dragReorder" title="드래그로 순서 변경">⠿</span>
          <i data-i18n-title="video.changeColor" title="색 변경"></i>
          <span class="lbl" data-i18n-title="video.rename" title="이름 변경">${esc(trackLabel(vt))}</span>
        </div>
        <div class="ve-ctrls">
          ${vt.kind === 'audio' ? '' : `<button class="ve-hs ve-pip${vt.transform ? ' on' : ''}" data-i18n-title="video.pip" title="위치/크기(PIP)">▭</button>`}
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
    lane.querySelector('.ve-pip')?.addEventListener('click', (e) => { e.stopPropagation(); openPipPopover(vt, e.currentTarget); });
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
      const val = prompt(tr('video.rename'), trackLabel(vt));
      if (val != null) { vt.name = val.trim(); lbl.textContent = trackLabel(vt); }
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
      el.className = 've-clip' + (c.isAudioOnly ? ' audio' : '') + (c.id === _selClipId ? ' sel' : '');
      el.style.left = (c.start * _pxPerSec) + 'px';
      el.style.width = Math.max(4, c.dur * _pxPerSec) + 'px';
      el.dataset.clipId = String(c.id);
      // 오디오 전용(mp3/wav 등, 영상 트랙 없음) 클립은 캡처할 프레임 자체가 없다 —
      // 필름스트립 대신 음표 표시만 둔다.
      el.innerHTML = (c.isAudioOnly ? `<span class="ve-audio-icon">♪</span>` : `<div class="ve-thumbs"></div>`)
        + `<span class="ve-clip-lbl">${esc(c.name)}</span>
        <div class="ve-fade l"></div><div class="ve-fade r"></div>
        <div class="ve-fadeh l" title="${tr('video.fadeIn')}"></div><div class="ve-fadeh r" title="${tr('video.fadeOut')}"></div>
        <div class="ve-trim l"></div><div class="ve-trim r"></div>`;
      el.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('ve-trim') || e.target.classList.contains('ve-fadeh')) return;
        _selClipId = c.id;
        wireMove(e, c, el);
      });
      el.addEventListener('dblclick', () => { seekTo(c.start); });
      wireTrim(el.querySelector('.ve-trim.l'), c, el, 'l');
      wireTrim(el.querySelector('.ve-trim.r'), c, el, 'r');
      const paintFade = () => {
        const wi = (c.fadeIn || 0) * _pxPerSec, wo = (c.fadeOut || 0) * _pxPerSec;
        el.querySelector('.ve-fade.l').style.width = wi + 'px'; el.querySelector('.ve-fadeh.l').style.left = wi + 'px';
        el.querySelector('.ve-fade.r').style.width = wo + 'px'; el.querySelector('.ve-fadeh.r').style.right = wo + 'px';
      };
      paintFade();
      wireFade(el.querySelector('.ve-fadeh.l'), c, paintFade, -1);
      wireFade(el.querySelector('.ve-fadeh.r'), c, paintFade, +1);
      area.appendChild(el);
      if (!c.isAudioOnly) {
        const cached = getClipThumb(c, _pxPerSec, toYtsepUrl, paintThumbs);
        if (cached) paintThumbs(c);
      }
    }
  });
  updateClipToolbarUI();
}
// 영상 임포트 시 자동으로 짝지어진 오디오 클립(Vegas Pro 관례: groupId 공유) — 그룹인
// 클립은 이동/트림/분할/삭제가 서로 따라간다. "U" 로 그룹을 풀면 그때부턴 따로 논다.
function groupPartner(c) {
  if (c.groupId == null) return null;
  return _veClips.find(x => x !== c && x.groupId === c.groupId) || null;
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
  const partner = groupPartner(c);
  const partnerStart0 = partner?.start;
  const laneEls = [...document.querySelectorAll('.ve-lane')];
  _dragging = true;
  try { el.setPointerCapture(e.pointerId); } catch {}
  const mv = (ev) => {
    const dx = (ev.clientX - startX) / _pxPerSec;
    let ns = Math.max(0, snapSec(startStart + dx, c.id));
    c.start = ns;
    el.style.left = (c.start * _pxPerSec) + 'px';
    // 짝(그룹) 클립이 있으면 같은 시작점으로 실시간으로 따라온다(Vegas 관례) — 트랙은
    // 그대로 두고 시작 위치만 맞춘다(영상↔오디오 트랙이 다르니 트랙까지 옮기진 않는다).
    if (partner) {
      partner.start = ns;
      const pEl = document.querySelector(`.ve-clip[data-clip-id="${partner.id}"]`);
      if (pEl) pEl.style.left = (ns * _pxPerSec) + 'px';
    }
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
      const endPartnerStart = partner?.start;
      pushUndo(
        () => { c.start = startStart; c.trackId = startTrackId; if (partner) partner.start = partnerStart0; layout(); },
        () => { c.start = endStart; c.trackId = endTrackId; if (partner) partner.start = endPartnerStart; layout(); },
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
    const partner = groupPartner(c);
    // 소스 자체가 같은 파일·같은 트림 지점에서 갈라져 나온 짝이라 항상 start/dur/inOff 가
    // 동일하다 — 이번에 c 에 적용한 값을 그대로 partner 에도 복사하면 된다.
    const partnerEl = partner ? document.querySelector(`.ve-clip[data-clip-id="${partner.id}"]`) : null;
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
      if (partner) {
        partner.start = c.start; partner.dur = c.dur; partner.inOff = c.inOff;
        if (partnerEl) { partnerEl.style.left = el.style.left; partnerEl.style.width = el.style.width; }
      }
    };
    const up = () => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      if (c.start !== start0 || c.dur !== dur0) {
        const endStart = c.start, endDur = c.dur, endInOff = c.inOff;
        pushUndo(
          () => {
            c.start = start0; c.dur = dur0; c.inOff = inOff0;
            if (partner) { partner.start = start0; partner.dur = dur0; partner.inOff = inOff0; }
            layout();
          },
          () => {
            c.start = endStart; c.dur = endDur; c.inOff = endInOff;
            if (partner) { partner.start = endStart; partner.dur = endDur; partner.inOff = endInOff; }
            layout();
          },
        );
      }
      layout();
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
}
// 클립 상단 코너 페이드 핸들 — 대각선 오버레이만큼 페이드 구간이다(스튜디오와 같은 UX).
// dir -1 = 페이드인(왼쪽), +1 = 페이드아웃(오른쪽). 클립 길이를 넘어서거나 서로 겹치진
// 못한다(페이드인+페이드아웃 합이 dur 을 넘지 않게 제한).
function wireFade(handle, c, paint, dir) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    _selClipId = c.id;
    const startX = e.clientX;
    const bIn = c.fadeIn || 0, bOut = c.fadeOut || 0;
    const mv = (ev) => {
      const dx = (ev.clientX - startX) / _pxPerSec;
      if (dir < 0) c.fadeIn = Math.max(0, Math.min(c.dur - (c.fadeOut || 0), bIn + dx));
      else c.fadeOut = Math.max(0, Math.min(c.dur - (c.fadeIn || 0), bOut - dx));
      paint();
      syncPreview(nowSec());
    };
    const up = () => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      if (c.fadeIn !== bIn || c.fadeOut !== bOut) {
        const endIn = c.fadeIn, endOut = c.fadeOut;
        pushUndo(
          () => { c.fadeIn = bIn; c.fadeOut = bOut; layout(); },
          () => { c.fadeIn = endIn; c.fadeOut = endOut; layout(); },
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
  const partner = groupPartner(c);
  // 짝이 있으면 이 지점이 짝도 덮어야 같이 자른다 — 그룹이 서로 다른 길이로 어긋나는
  // 상황을 막는다(항상 동일한 start/dur 이어야 하는 불변조건).
  if (partner && (t <= partner.start || t >= partner.start + partner.dur)) return;

  const splitOne = (clip) => {
    const origDur = clip.dur;
    const rightDur = clip.start + clip.dur - t;
    const leftDur = t - clip.start;
    const right = { ...clip, id: nextClipId(), start: t, dur: rightDur, inOff: clip.inOff + (t - clip.start) };
    clip.dur = leftDur;
    _veClips.push(right);
    return { clip, right, origDur, leftDur };
  };

  const r1 = splitOne(c);
  let r2 = null;
  if (partner) {
    r2 = splitOne(partner);
    // 오른쪽 조각끼리 새 그룹으로 묶는다(왼쪽 조각들은 원래 groupId 를 그대로 쓴다).
    const newGroupId = r1.right.id;
    r1.right.groupId = newGroupId; r2.right.groupId = newGroupId;
  }

  pushUndo(
    () => {
      r1.clip.dur = r1.origDur; _veClips = _veClips.filter(x => x !== r1.right);
      if (r2) { r2.clip.dur = r2.origDur; _veClips = _veClips.filter(x => x !== r2.right); }
    },
    () => {
      r1.clip.dur = r1.leftDur; _veClips.push(r1.right);
      if (r2) { r2.clip.dur = r2.leftDur; _veClips.push(r2.right); }
    },
  );
  layout();
}
function deleteSelected() {
  if (_selClipId == null) return;
  const removed = _veClips.find(c => c.id === _selClipId); if (!removed) return;
  const partner = groupPartner(removed);
  const idx = _veClips.indexOf(removed);
  const pIdx = partner ? _veClips.indexOf(partner) : -1;
  pushUndo(
    () => { _veClips.splice(idx, 0, removed); if (partner) _veClips.splice(pIdx, 0, partner); },
    () => { _veClips = _veClips.filter(c => c !== removed && c !== partner); },
  );
  _veClips = _veClips.filter(c => c !== removed && c !== partner);
  _selClipId = null;
  layout();
}
function ungroupSelected() {
  if (_selClipId == null) return;
  const c = _veClips.find(x => x.id === _selClipId); if (!c || c.groupId == null) return;
  const partner = groupPartner(c);
  const before = { cg: c.groupId, pg: partner?.groupId };
  c.groupId = null; if (partner) partner.groupId = null;
  pushUndo(
    () => { c.groupId = before.cg; if (partner) partner.groupId = before.pg; },
    () => { c.groupId = null; if (partner) partner.groupId = null; },
  );
  flash(tr('video.ungrouped'));
}
// 좌우/상하 반전 — 클립 단위(트랙 전체가 아니라 선택된 클립 하나만). 색·이름·숨김과
// 같은 사소한 시각 속성 취급이라(PIP 위치와 같은 이유) undo 스택엔 안 담는다.
function flipSelected(axis) {
  if (_selClipId == null) return;
  const c = _veClips.find(x => x.id === _selClipId); if (!c || c.isAudioOnly) return;
  const key = axis === 'h' ? 'flipH' : 'flipV';
  c[key] = !c[key];
  syncPreview(nowSec());
  updateClipToolbarUI();
  scheduleSave();
}
function updateClipToolbarUI() {
  const c = _selClipId != null ? _veClips.find(x => x.id === _selClipId) : null;
  const canFlip = !!c && !c.isAudioOnly;
  const hBtn = $('ve-flip-h'), vBtn = $('ve-flip-v'), colorBtn = $('ve-color');
  if (hBtn) { hBtn.disabled = !canFlip; hBtn.classList.toggle('on', !!c?.flipH); }
  if (vBtn) { vBtn.disabled = !canFlip; vBtn.classList.toggle('on', !!c?.flipV); }
  if (colorBtn) { colorBtn.disabled = !canFlip; colorBtn.classList.toggle('on', !!c?.color || !!c?.fx); }
  closeColorPopover();   // 선택이 바뀌면(또는 목록이 다시 그려지면) 열려 있던 팝오버는 닫는다 — 다른 클립을 보여줄 순 없다
}

// ── 내보내기 ────────────────────────────────────────
// 트랙 목록 위→아래가 곧 화면 앞→뒤다. 맨 위(가장 앞) 트랙이 화면을 꽉 채우면(기본값,
// PIP 안 씀) 그 아래는 안 보이니 예전처럼 단순 컷 하나로 나간다 — 맨 위 트랙에 위치/크기
// (PIP) 를 줘서 화면 일부만 덮으면, 그 순간 살아있는 트랙 전부를 레이어로 겹쳐 넣는다.
// 오디오는 트랙 자체 오디오(레거시)+오디오 트랙들을 전부 모아서(여러 개면 main.js 가
// amix 로 섞는다) — 오디오 트랙은 이제 몇 개든 동시에 반영된다.
// v1 범위: 크로스페이드(같은 트랙 클립 겹침)는 PIP 레이어가 동시에 있는 구간에선 지원하지
// 않는다(그 순간엔 먼저 시작한 클립만 쓴다) — 흔치 않은 조합이라 다음 단계로 미룬다.
// 페이드는 클립 단위(초 단위 fadeIn/fadeOut)로 저장되지만, main.js 의 ffmpeg 필터는 각
// 구간(segment)이 아니라 "원본 파일의 절대 시각" 기준 st(시작점)/d(길이) 를 받는다 —
// trim 은 PTS 를 안 건드리니, setpts=PTS-STARTPTS 로 리셋하기 전에 fade 를 걸면 세그먼트가
// (다른 트랙・PIP・범위 지정 등으로) 잘게 쪼개져도 경계에서 끊기지 않고 이어진다.
function fadeFieldsFor(c) {
  const f = {};
  if (c.fadeIn) { f.fadeInSt = c.inOff; f.fadeInD = c.fadeIn; }
  if (c.fadeOut) { f.fadeOutSt = c.inOff + c.dur - c.fadeOut; f.fadeOutD = c.fadeOut; }
  return f;
}
function buildEDL() {
  // 오디오 전용(mp3/wav, 짝지어진 오디오 클립 포함) 구간은 영상 트랙이 없어서 내보낼 때
  // 검은 화면을 대신 채워야 한다 — 해상도는 사용자가 고른 값(getResolution) 을 그대로 쓴다.
  const { w: refW, h: refH } = getResolution();
  const videoTracks = _veTracks.filter(t => t.kind !== 'audio');
  const audioTracks = _veTracks.filter(t => t.kind === 'audio');

  // 눈금자에서 지정한 내보내기 구간 — 경계값 자체를 breakpoint 로 넣어 두면 그 지점에서
  // 정확히 구간이 갈라져서, 걸치는 클립을 따로 잘라 넣을 필요 없이 범위 밖 구간만 건너뛰면 된다.
  const range = _veExportRange;
  const bounds = new Set([0]);
  for (const c of _veClips) { bounds.add(c.start); bounds.add(c.start + c.dur); }
  if (range) { bounds.add(range.start); bounds.add(range.end); }
  const pts = [...bounds].sort((a, b) => a - b);
  const segs = [];
  let skipUntil = -Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b - a < 0.001) continue;
    if (a < skipUntil - 0.001) continue;   // 크로스페이드 구간을 이미 통째로 넣었다
    if (range && (b <= range.start + 0.0005 || a >= range.end - 0.0005)) continue;   // 범위 밖
    const mid = (a + b) / 2;

    const activeVideo = [];
    for (const track of videoTracks) {   // 배열 순서 = 목록 위→아래 = 화면 앞→뒤
      if (track.hidden) continue;
      const here = clipsAt(track.id, mid);
      if (here.length) activeVideo.push({ track, clips: here });
    }
    const top = activeVideo[0];
    const topFillsFrame = !top || !top.track.transform;   // 기본 transform = 화면 꽉 채움
    const relevantVideo = topFillsFrame ? (top ? [top] : []) : activeVideo;

    // 오디오 소스 모으기 — 화면에 실제로 반영되는 영상 트랙들의 자체 오디오(있으면) +
    // 오디오 트랙 전부(숨김 제외). 몇 개든 상관없이 다 담는다 — main.js 가 섞는다.
    const audioSources = [];
    for (const { clips } of relevantVideo) {
      const c = clips[0];
      if (c.hasAudio !== false) audioSources.push({ file: c.file, start: c.inOff + (a - c.start), end: c.inOff + (b - c.start), ...fadeFieldsFor(c) });
    }
    for (const track of audioTracks) {
      if (track.hidden) continue;
      const clip = clipAt(track.id, mid);
      if (clip && clip.hasAudio !== false) audioSources.push({ file: clip.file, start: clip.inOff + (a - clip.start), end: clip.inOff + (b - clip.start), ...fadeFieldsFor(clip) });
    }

    if (!topFillsFrame) {
      // PIP 등 화면을 꽉 채우지 않는 트랙이 맨 위에 있는 구간 — 다른 트랙과 안 겹쳐도(트랙이
      // 이거 하나뿐이어도) 검은 배경 위에 위치·크기를 반영해서 그려야 한다(미리보기와 맞추기).
      segs.push({
        layers: relevantVideo.map(({ track, clips }) => {
          const c = clips[0];
          return { file: c.file, start: c.inOff + (a - c.start), end: c.inOff + (b - c.start), transform: track.transform, flipH: c.flipH, flipV: c.flipV, color: c.color, fx: c.fx, hdr: c.hdr, ...fadeFieldsFor(c) };
        }),
        audioSources, refW, refH, dur: b - a,
      });
      continue;
    }

    if (relevantVideo.length === 1) {
      const { clips } = relevantVideo[0];
      if (clips.length >= 2) {
        // 같은 트랙 안 크로스페이드(겹쳐 끌어다 놓은 두 클립).
        const outC = clips[0], inC = clips[1];
        const overlapStart = inC.start, overlapEnd = outC.start + outC.dur;
        segs.push({
          xfade: true, dur: overlapEnd - overlapStart,
          fileA: outC.file, aIn: outC.inOff + (overlapStart - outC.start), hasAudioA: outC.hasAudio !== false, flipHA: outC.flipH, flipVA: outC.flipV, colorA: outC.color, fxA: outC.fx, hdrA: outC.hdr,
          fileB: inC.file, bIn: inC.inOff + (overlapStart - inC.start), hasAudioB: inC.hasAudio !== false, flipHB: inC.flipH, flipVB: inC.flipV, colorB: inC.color, fxB: inC.fx, hdrB: inC.hdr,
          refW, refH,
        });
        skipUntil = overlapEnd;
        continue;
      }
      const c = clips[0];
      segs.push({ file: c.file, start: c.inOff + (a - c.start), end: c.inOff + (b - c.start), audioSources, refW, refH, dur: b - a, flipH: c.flipH, flipV: c.flipV, color: c.color, fx: c.fx, hdr: c.hdr, ...fadeFieldsFor(c) });
      continue;
    }

    // 영상 트랙엔 아무도 없다 — 오디오 트랙만 있으면 검은 화면 + 그 오디오들로 채운다.
    if (!audioSources.length) continue;   // 아무것도 없는 구간은 건너뛴다(내보낸 결과엔 그 틈이 없다)
    segs.push({ isAudioOnly: true, audioSources, refW, refH, dur: b - a });
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
  const totalSec = segs.reduce((s, x) => s + (x.dur != null ? x.dur : (x.end - x.start)), 0) || 1;
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
// Vegas Pro 관례: 영상 파일(영상+오디오 둘 다 있는)을 임포트하면 영상 트랙엔 영상 클립,
// 오디오 트랙엔 그와 짝지어진(groupId 공유) 오디오 클립이 따로 생긴다 — 기본으로 그룹이라
// 서로 따라 움직이지만, 필요하면 U 로 그룹을 풀고 따로 삭제·편집할 수 있다.
async function importVideoFiles(paths, trackId) {
  let tid = trackId;
  const createdVideoTrack = tid == null;
  if (createdVideoTrack) tid = newVideoTrack(false);   // 되돌리기는 아래서 임포트 전체를 한 덩어리로 묶는다
  const videoTrackRef = createdVideoTrack ? _veTracks.find(t => t.id === tid) : null;
  let videoCursor = 0;
  for (const c of _veClips.filter(x => x.trackId === tid)) videoCursor = Math.max(videoCursor, c.start + c.dur);

  let audioTid = null, audioTrackRef = null, createdAudioTrack = false, audioCursor = 0;
  function ensureAudioTrack() {
    if (audioTid != null) return;
    const existing = _veTracks.find(t => t.kind === 'audio');
    if (existing) { audioTid = existing.id; }
    else { audioTid = newAudioTrack(false); audioTrackRef = _veTracks.find(t => t.id === audioTid); createdAudioTrack = true; }
    for (const c of _veClips.filter(x => x.trackId === audioTid)) audioCursor = Math.max(audioCursor, c.start + c.dur);
  }

  const added = [];
  for (const p of paths) {
    const meta = await probeVideo(p);
    if (!meta.dur) continue;
    const { hasAudio, isHDR } = await api.video.probeAudio(p);
    const name = p.split(/[\\/]/).pop();
    // 화면 크기가 0 이면(mp3/wav 등) 영상 트랙이 아예 없다 — 배경음악처럼 오디오만
    // 얹고 싶을 때를 위해 받되, 썸네일·내보내기는 이 클립엔 다르게 처리해야 한다.
    const isAudioOnly = !meta.w || !meta.h;

    if (isAudioOnly) {
      ensureAudioTrack();
      const clip = { id: nextClipId(), trackId: audioTid, file: p, name, start: audioCursor, inOff: 0, srcDur: meta.dur, dur: meta.dur, w: 0, h: 0, hasAudio, isAudioOnly: true };
      _veClips.push(clip); added.push(clip);
      audioCursor += meta.dur;
      continue;
    }

    // HDR(PQ/HLG) 소스 — 내보낼 때 SDR 로 그냥 바꾸면 화면이 씻겨나가서 톤매핑이 필요하다.
    // hdr 값은 false 아니면 ffprobe 의 color_transfer 이름 그대로('smpte2084'/'arib-std-b67')
    // — main.js 가 이 이름을 zscale 필터에 그대로 넘긴다.
    const vClip = { id: nextClipId(), trackId: tid, file: p, name, start: videoCursor, inOff: 0, srcDur: meta.dur, dur: meta.dur, w: meta.w, h: meta.h, hasAudio: false, isAudioOnly: false, hdr: isHDR || false };
    if (hasAudio) {
      ensureAudioTrack();
      const groupId = vClip.id;
      vClip.groupId = groupId;
      const aClip = { id: nextClipId(), trackId: audioTid, file: p, name, start: audioCursor, inOff: 0, srcDur: meta.dur, dur: meta.dur, w: 0, h: 0, hasAudio: true, isAudioOnly: true, groupId };
      _veClips.push(vClip); added.push(vClip);
      _veClips.push(aClip); added.push(aClip);
      audioCursor += meta.dur;
    } else {
      _veClips.push(vClip); added.push(vClip);
    }
    videoCursor += meta.dur;
  }

  const addedTracks = [];
  if (createdVideoTrack) addedTracks.push(videoTrackRef);
  if (createdAudioTrack) addedTracks.push(audioTrackRef);
  if (added.length) {
    pushUndo(
      () => {
        _veClips = _veClips.filter(c => !added.includes(c));
        _veTracks = _veTracks.filter(t => !addedTracks.includes(t));
      },
      () => {
        for (const t of addedTracks) { if (t.kind === 'audio') _veTracks.push(t); else _veTracks.unshift(t); }
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
  // 방금 만든(맨 위) 영상 트랙이 아직 비어 있으면 거기로, 아니면 새 트랙을 만든다 —
  // "+트랙" 누르고 바로 "임포트" 눌렀을 때 트랙이 두 개로 늘어나지 않도록.
  const top = _veTracks.find(t => t.kind !== 'audio');
  const reuse = top && !_veClips.some(c => c.trackId === top.id);
  importVideoFiles(r.filePaths, reuse ? top.id : null);
}
// "+오디오" 전용 임포트 — 항상 새 오디오 트랙을 만들어 그 안에만 채운다. 일반 "임포트"
// 버튼(pickImportVideo→importVideoFiles)의 ensureAudioTrack() 은 오디오 클립이 생길 때마다
// "이미 있는 오디오 트랙"을 재사용해서, 트랙을 여러 개 만들어 겹치게(배경음악+대사처럼
// 동시에 섞이게) 두는 방법이 없었다 — 버튼을 누를 때마다 매번 독립된 트랙이 생겨야
// 여러 오디오를 동시에 쓸 수 있다.
async function pickImportAudioTrack() {
  const r = await api.dialog.pickVideoFiles();
  if (!r || !r.ok || !r.filePaths?.length) return;
  await importAudioFiles(r.filePaths);
}
async function importAudioFiles(paths) {
  const tid = newAudioTrack(false);
  const trackRef = _veTracks.find(t => t.id === tid);
  let cursor = 0;
  const added = [];
  for (const p of paths) {
    const meta = await probeVideo(p);
    if (!meta.dur) continue;
    const { hasAudio } = await api.video.probeAudio(p);
    const name = p.split(/[\\/]/).pop();
    // 원본이 영상 파일이어도(w/h>0) 이 트랙은 오디오 전용 트랙이니 소리만 뽑아 쓴다
    // (ffmpeg 는 :a 스트림만 참조하므로 영상 스트림은 자동으로 무시된다).
    const clip = { id: nextClipId(), trackId: tid, file: p, name, start: cursor, inOff: 0, srcDur: meta.dur, dur: meta.dur, w: 0, h: 0, hasAudio, isAudioOnly: true };
    _veClips.push(clip); added.push(clip);
    cursor += meta.dur;
  }
  if (added.length) {
    pushUndo(
      () => { _veClips = _veClips.filter(c => !added.includes(c)); _veTracks = _veTracks.filter(t => t.id !== tid); },
      () => { _veTracks.push(trackRef); _veClips.push(...added); },
    );
  } else {
    _veTracks = _veTracks.filter(t => t.id !== tid);   // 아무것도 못 넣었으면 빈 트랙만 남기지 않는다
  }
  ensureLayers();
  layout();
  if (added.length) flash(tr('video.importing', { n: added.length })); else flash(tr('video.needImport'));
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
  $('ve-add-audio-track')?.addEventListener('click', () => pickImportAudioTrack());
  $('ve-import')?.addEventListener('click', () => pickImportVideo());
  $('ve-undo')?.addEventListener('click', () => doUndo());
  $('ve-redo')?.addEventListener('click', () => doRedo());
  $('ve-flip-h')?.addEventListener('click', () => flipSelected('h'));
  $('ve-flip-v')?.addEventListener('click', () => flipSelected('v'));
  $('ve-color')?.addEventListener('click', (e) => {
    const c = _selClipId != null ? _veClips.find(x => x.id === _selClipId) : null;
    if (!c || c.isAudioOnly) return;
    openColorPopover(c, e.currentTarget);
  });
  $('ve-empty-import')?.addEventListener('click', () => pickImportVideo());
  $('ve-seek0')?.addEventListener('click', () => seekTo(0));
  $('ve-play')?.addEventListener('click', () => setPlaying(!_playing));
  $('ve-zoom-in')?.addEventListener('click', () => { _pxPerSec = Math.min(400, _pxPerSec * 1.3); layout(); });
  $('ve-zoom-out')?.addEventListener('click', () => { _pxPerSec = Math.max(4, _pxPerSec / 1.3); layout(); });
  $('ve-export')?.addEventListener('click', () => runExport());
  // 눈금자(트랙 위 타임라인) 클릭·드래그로 재생선 이동 — 헤드 칸(172px) 밖에 있는
  // #ve-ruler 는 그 안에서의 x 좌표가 그대로 초 단위 위치와 대응한다(HEAD_W 보정 불필요).
  // Shift+드래그(또는 영역 선택 모드)면 재생선 대신 내보내기 구간을 지정한다(스튜디오와 동일).
  {
    const ruler = $('ve-ruler');
    const secAt = (clientX) => {
      const rect = ruler.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left) / _pxPerSec);
    };
    ruler?.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.ve-eh')) return;   // 범위 가장자리 핸들은 dragExportEdge 가 처리
      e.preventDefault();
      if (_veRangeMode || e.shiftKey) {
        const a = secAt(e.clientX); let b = a;
        const onMove = (ev) => { b = secAt(ev.clientX); _veExportRange = { start: Math.min(a, b), end: Math.max(a, b) }; renderExportRange(); };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp);
          if (Math.abs(b - a) < 0.08) { _veExportRange = null; renderExportRange(); }
          else flash(tr('video.rangeSet', { a: fmtTC(_veExportRange.start), b: fmtTC(_veExportRange.end) }));
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        return;
      }
      seekTo(secAt(e.clientX));
      const onMove = (ev) => seekTo(secAt(ev.clientX));
      const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp, { once: true });
    });
  }
  $('ve-range-mode')?.addEventListener('click', () => {
    _veRangeMode = !_veRangeMode;
    const btn = $('ve-range-mode');
    btn.classList.toggle('on', _veRangeMode);
    btn.setAttribute('aria-pressed', String(_veRangeMode));
    $('ve-ruler-wrap')?.classList.toggle('range-mode', _veRangeMode);
    flash(_veRangeMode ? tr('video.rangeModeOn') : tr('video.rangeModeOff'));
  });
  // 렌더 해상도 선택 — 프리셋 또는 사용자 지정. 미리보기 틀 크기·PIP 좌표 기준·내보내기
  // 결과물 크기가 전부 이걸 따른다(getResolution()).
  const resSel = $('ve-res'), resCustom = $('ve-res-custom'), resW = $('ve-res-w'), resH = $('ve-res-h');
  function applyResSelection() {
    const v = resSel?.value;
    if (v === 'custom') {
      if (resCustom) resCustom.hidden = false;
      // yuv420p 인코딩은 가로/세로가 홀수면 실패한다 — 짝수로 반올림.
      const w = Math.max(2, Math.round((Number(resW?.value) || 1920) / 2) * 2);
      const h = Math.max(2, Math.round((Number(resH?.value) || 1080) / 2) * 2);
      _veResolution = { w, h };
    } else if (v === 'auto') {
      if (resCustom) resCustom.hidden = true;
      _veResolution = null;
    } else {
      if (resCustom) resCustom.hidden = true;
      const [w, h] = (v || '').split('x').map(Number);
      _veResolution = (w && h) ? { w, h } : null;
    }
    sizePreviewFrame();
    syncPreview(nowSec());
    scheduleSave();
  }
  resSel?.addEventListener('change', applyResSelection);
  resW?.addEventListener('input', applyResSelection);
  resH?.addEventListener('input', applyResSelection);
  // 미리보기 패널 크기가 바뀔 때마다(창 크기 조절 등) 렌더 프레임 틀도 다시 맞춘다.
  const previewWrap = $('ve-preview-wrap');
  if (previewWrap) new ResizeObserver(() => sizePreviewFrame()).observe(previewWrap);
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
    else if (e.key === 'u' || e.key === 'U') ungroupSelected();   // Vegas Pro 와 같은 단축키
    else if (e.key === 'h' || e.key === 'H') flipSelected('h');
    else if (e.key === 'v' || e.key === 'V') flipSelected('v');
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
