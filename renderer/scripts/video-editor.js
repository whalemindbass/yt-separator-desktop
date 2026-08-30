'use strict';
// 영상 편집 탭 — 멀티트랙 비디오 타임라인. 스튜디오(오디오 DAW)와는 완전히 분리된 화면이다.
//   - JUCE 엔진과 무관하다: 재생/합성은 전부 Chromium 의 <video> 로 렌더러 안에서 처리한다.
//   - 트랙/클립 상태는 이 모듈 로컬에만 있다(엔진에 동기화할 대상이 없다).
//   - 시간은 전부 초 단위로만 다룬다 — 엔진 경계가 없으니 샘플 변환도 없다.
import { t as tr } from './i18n.js';
import { esc } from './studio/util.js';
import { toYtsepUrl } from './player.js';
import { getClipThumb } from './video-thumbs.js';
import { getFilePeaks, drawWaveform } from './video-waveform.js';
import { BoxTracker } from './video-tracker.js';

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
let _veExtraSec = 0;   // 오른쪽 끝까지 스크롤해서 유기적으로 늘어난 여유분(초) — growTimelineIfNeeded()
let _selClipId = null;
let _veResolution = null;   // null = 자동(첫 클립 기준). 아니면 {w,h} — 사용자가 고른 렌더 해상도.
let _veExportRange = null;   // {start, end} 초 — 눈금자 드래그로 지정한 내보내기 구간(없으면 전체).
let _veRangeMode = false;    // true 면 눈금자 드래그가 재생선 이동 대신 구간 지정(Shift 없이도).
let _dragging = false;   // 드래그 중엔 rebuild 로 DOM 을 통째로 갈지 않는다(포인터 이벤트가 끊긴다)

// ── 가사 타이밍 맞추기 — 재생하면서 Enter 를 누르면 그 순간 재생선 위치가 "지금 armed 된
// 줄"의 시작 시각으로 찍히고 다음 줄로 넘어간다(카라오케 타이밍 툴과 같은 방식). 다 찍으면
// 텍스트 트랙에 자막 클립으로 한 번에 만들어진다.
let _lyricTiming = false;
let _lyricLines = [];
let _lyricStarts = [];
let _lyricIdx = 0;

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
// tracks/clips 를 저장 가능한 순수 객체로 뽑는다 — 조용한 자동 저장(scheduleSave)과
// 사용자가 직접 누르는 .dsvproj 저장(saveProjectAs)이 같은 모양을 쓴다.
function buildVideoProjectData() {
  return {
    tracks: _veTracks.map(({ id, name, color, height, hidden, kind, transform }) => ({ id, name, color, height, hidden, kind, transform })),
    clips: _veClips.map(({ id, trackId, file, name, start, inOff, srcDur, dur, w, h, hasAudio, isAudioOnly, groupId, fadeIn, fadeOut, effects, hdr, isText, text, xPct, yPct, size, color, fontKey, bg, isImage, isShape, shapeType, wPct, hPct, fillColor, strokeColor, strokeWidth, transform, trackKeyframes }) =>
      ({ id, trackId, file, name, start, inOff, srcDur, dur, w, h, hasAudio, isAudioOnly, groupId, fadeIn, fadeOut, effects, hdr, isText, text, xPct, yPct, size, color, fontKey, bg, isImage, isShape, shapeType, wPct, hPct, fillColor, strokeColor, strokeWidth, transform, trackKeyframes })),
    resolution: _veResolution,
  };
}
function scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => api.videoProject.save(buildVideoProjectData()), 600);
}
// 불러온 데이터(자동 저장이든 .dsvproj 든 모양이 같다)를 실제 상태로 반영 — 시퀀스 번호도
// 다시 맞춰야 새로 만드는 트랙/클립/효과 id 가 기존 것과 안 겹친다.
function applyVideoProjectData(p) {
  if (!p?.tracks?.length) return false;
  _veTracks = p.tracks;
  _veClips = p.clips || [];
  _trackSeq = Math.max(0, ..._veTracks.map(t => t.id));
  _clipSeq = Math.max(0, ..._veClips.map(c => c.id));
  _veResolution = p.resolution || null;
  _veExtraSec = 0;
  for (const t of _veTracks) migrateTrackTransform(t);
  for (const c of _veClips) { migrateClipEffects(c); migrateClipFlip(c); migrateClipShapeTransform(c); }
  _effectSeq = Math.max(0, ..._veClips.flatMap(c => (c.effects || []).map(e => e.id)));
  ensureLayers();
  return true;
}
let _loaded = false;
async function loadProject() {
  // 프로그램을 새로 시작하면 항상 빈 프로젝트다 — 예전엔 조용한 자동 저장(userData 의
  // videoProject.json)을 여기서 그대로 불러왔는데, "언제 뭘 열었는지" 사용자가 통제할 수
  // 없어 혼란스러웠다(요청). 이제 그 자동 저장은 그냥 안전망으로 계속 쓰기만 하고(기록은
  // 남지만) 시작할 때 자동으로 반영하지 않는다 — 진짜로 불러오려면 "열기" 로 .dsvproj 를
  // 직접 골라야 한다.
  if (_loaded) return; _loaded = true;
  syncResUI();
}
// 불러온(자동 복원이든 .dsvproj 열기든) 클립이 가리키는 원본 파일이 그새 삭제/이동됐는지
// 확인한다 — 타임라인에서 빨간 X로 바로 보여야 "왜 이 클립이 안 나오지" 헤매지 않는다.
// 텍스트 클립은 파일이 없으니 대상에서 뺀다.
async function checkMissingFiles() {
  const files = [...new Set(_veClips.filter(c => c.file && !c.isText).map(c => c.file))];
  if (!files.length) return;
  let result;
  try { result = await api.fs.checkExists(files); } catch { return; }
  let changed = false;
  for (const c of _veClips) {
    if (!c.file || c.isText) continue;
    const missing = result[c.file] === false;
    if (c.fileMissing !== missing) { c.fileMissing = missing; changed = true; }
  }
  if (changed) renderClips();
}

// ── 프로젝트 저장(.dsvproj)/열기 — 조용한 자동 저장(scheduleSave, userData 안)과 별개로
// 사용자가 원하는 위치에 파일로 남긴다. 같은 세션에서 "저장"을 다시 누르면(경로를 이미
// 안다) 대화상자 없이 그 파일에 덮어쓴다 — 다른 파일에 저장하려면 지금은 이 세션을
// 새로 시작하는 수밖에 없다(별도 "다른 이름으로 저장"은 요청 범위 밖).
let _dsvprojPath = null;
async function saveProjectAs() {
  const json = JSON.stringify(buildVideoProjectData(), null, 2);
  const res = await api.videoProject.saveAs(json, '영상 프로젝트', _dsvprojPath);
  if (!res?.ok) return;
  _dsvprojPath = res.path;
  flash(tr('video.projectSaved'));
}
async function openProjectFile() {
  const res = await api.videoProject.open();
  if (!res?.ok) return;
  let data;
  try { data = JSON.parse(res.data); } catch { return; }
  if (!applyVideoProjectData(data)) return;
  _dsvprojPath = res.path;
  _undoStack = []; _redoStack = [];   // 다른 프로젝트로 바꿨으니 이전 히스토리는 의미 없다
  _selClipId = null;
  syncResUI();
  renderLanes();   // 트랙 개수 자체가 바뀌었을 수 있다 — layout() 만으론 레인 DOM 이 안 갱신된다
  flash(tr('video.projectOpened'));
  checkMissingFiles();
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
// 영상/PIP 만 프레임 밖으로 못 나가게 자르는 전용 래퍼(overflow:hidden, CSS 에서) — PIP
// 박스·핸들·텍스트 오버레이는 이 안에 넣지 않는다(#ve-preview 에 직접 붙인다). 그래야
// PIP 를 프레임 밖으로 드래그해도(요청대로 "잘려도 상관없이" 자유롭게) 손잡이가 항상
// 보여서 다시 끌고 돌아올 수 있다 — 화면(영상)만 export 의 overlay 클리핑과 똑같이 잘린다.
function ensureVideoLayersHost() {
  const host = $('ve-preview'); if (!host) return null;
  let wrap = host.querySelector(':scope > .ve-video-layers');
  if (!wrap) { wrap = document.createElement('div'); wrap.className = 've-video-layers'; host.appendChild(wrap); }
  return wrap;
}
function ensureLayers() {
  const host = $('ve-preview'); if (!host) return;
  const videoHost = ensureVideoLayersHost(); if (!videoHost) return;
  const wanted = new Set(_veTracks.map(t => t.id));
  for (const [id, pair] of _layerEls) {
    if (wanted.has(id)) continue;
    if (pair.text) pair.text.remove(); else { pair.a.remove(); pair.b.remove(); }
    _layerEls.delete(id);
  }
  // Vegas Pro 관례: 트랙 목록 맨 위(배열 0번)가 합성에서 맨 앞(최상위 레이어)이 된다.
  // 오디오 트랙은 화면에 아무것도 안 그려야 한다(영상 트랙 위를 덮으면 안 됨) — opacity:0 으로
  // 고정해 두고 재생/정지만 다룬다(hidden 은 안 건드린다 — display:none 이 오디오까지 멈추는
  // 경우을 피하려고). 텍스트 트랙은 <video> 가 아니라 절대위치 컨테이너 하나 — 클립 텍스트를
  // syncPreview() 가 그때그때 채워 넣는다(크로스페이드용 이중 버퍼가 필요 없다).
  _veTracks.forEach((t, i) => {
    let pair = _layerEls.get(t.id);
    if (!pair) {
      if (t.kind === 'text') {
        const div = document.createElement('div');
        div.className = 've-text-layer';
        host.appendChild(div);
        pair = { text: div };
      } else {
        const isAudio = t.kind === 'audio';
        // 슬롯 하나 = <video> + <img> 를 같이 담는 래퍼. 그 순간 활성 클립이 영상이냐
        // 이미지냐에 따라 driveLayer() 가 둘 중 하나만 보여준다(둘 다 같은 위치/크기를
        // 받아야 하므로 PIP transform 은 이 래퍼에 건다 — applyTrackTransform 참고).
        const mk = () => {
          const wrap = document.createElement('div'); wrap.className = 've-layer-slot';
          const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto';
          // crossOrigin 없이 로드하면(ytsep:// 커스텀 프로토콜이 Access-Control-Allow-Origin: *
          // 를 줘도) 캔버스가 "tainted by cross-origin data" 로 막힌다 — 히스토그램처럼
          // drawImage+getImageData 로 프레임을 읽어야 하는 기능은 이게 없으면 조용히 아무것도
          // 못 그리고 예외만 삼킨다(실측하다 잡은 버그).
          v.crossOrigin = 'anonymous';
          const img = document.createElement('img'); img.hidden = true; img.crossOrigin = 'anonymous';
          wrap.appendChild(v); wrap.appendChild(img);
          if (isAudio) wrap.style.opacity = '0';
          videoHost.appendChild(wrap); return wrap;
        };
        pair = { a: mk(), b: mk() };
      }
      _layerEls.set(t.id, pair);
    }
    const z = String(_veTracks.length - i);
    if (pair.text) { pair.text.style.zIndex = z; return; }
    pair.a.style.zIndex = z; pair.b.style.zIndex = z;
    applyTrackTransform(pair, t);
  });
}
// 트랙 단위 위치/크기(PIP) — 레이어 그림을 다루듯 구석에 작게 놓거나 확대할 수 있게.
// 애니메이션(키프레임)은 v1 범위 밖 — 트랙 전체에 고정값 하나만 적용한다. w/h 를 따로
// 가진다(항상 정사각 비율로만 확대·축소하던 예전 scale 방식에서 바꿈 — "가로세로 비율을
// 못 바꾼다"는 요청 반영) — lock 이 켜졌을 때만 비율을 유지한다.
function defaultTransform() { return { x: 0, y: 0, w: 1, h: 1, lock: false }; }
function applyTrackTransform(pair, track) {
  const tf = track.transform || defaultTransform();
  for (const el of [pair.a, pair.b]) {
    el.style.left = (tf.x * 100) + '%';
    el.style.top = (tf.y * 100) + '%';
    el.style.width = (tf.w * 100) + '%';
    el.style.height = (tf.h * 100) + '%';
    // 기본값(트랙 전체 채움)일 땐 CSS object-fit:contain 이 main.js 의 scalePad(비율 유지
    // 레터박스)와 맞는다. 트랙 PIP 가 걸리면 main.js 는 그 자리에 scale=lw:lh 로 그냥
    // 늘려 넣는다(비율 무시) — 미리보기도 똑같이 늘려야 실제 결과랑 어긋나지 않는다.
    el.classList.toggle('ve-stretch', !!track.transform);
  }
}
// 클립 단위(이미지/도형 개별 배치, 추적 키프레임) 위치 — 매 tick 마다 다시 계산해야
// 한다(트랙 PIP 와 달리 시간에 따라 바뀔 수 있어서, ensureLayers 때 한 번만 하면 안 된다).
// 우선순위: 추적 키프레임(보간) > 클립 자체 transform > 트랙 전체 PIP > 기본(풀프레임).
function applyClipTransform(el, clip, track, t) {
  let tf;
  const hasKf = clip.trackKeyframes && clip.trackKeyframes.length;
  if (hasKf) tf = interpolateKeyframes(clip.trackKeyframes, t - clip.start);
  else tf = clip.transform || track.transform || defaultTransform();
  const w = tf.w != null ? tf.w : (tf.scale != null ? tf.scale : 1);
  const h = tf.h != null ? tf.h : (tf.scale != null ? tf.scale : 1);
  el.style.left = (tf.x * 100) + '%';
  el.style.top = (tf.y * 100) + '%';
  el.style.width = (w * 100) + '%';
  el.style.height = (h * 100) + '%';
  // applyTrackTransform 과 같은 이유 — 실제로 뭔가 걸려 있으면(키프레임/클립 자체
  // 위치/트랙 PIP) main.js 는 그 자리에서 비율 무시하고 늘려 넣는다.
  el.classList.toggle('ve-stretch', !!(hasKf || clip.transform || track.transform));
}
// ── 위치/크기 박스 — 미리보기 위에서 직접 드래그(이동)·모서리 드래그(크기)할 수 있다.
// 트랙 PIP(비디오 레이어 전체)와 도형/이미지 클립 개별 배치가 똑같은 박스·손잡이 UI 를
// 쓴다 — get()/set() 으로 어느 transform 을 다루는지만 다르게 넘긴다. "가로세로 비율
// 고정" 은 이제 선택 사항(tf.lock) — 켜져 있으면 손잡이를 어느 방향으로 끌어도 시작
// 시점의 w/h 비율을 그대로 유지하고(예전 scale 방식과 같은 감각), 꺼져 있으면 가로/세로를
// 완전히 따로 늘릴 수 있다(도형처럼 원본 비율에 안 묶여도 되는 경우를 위한 요청 반영).
let _boxEl = null;
function closeResizeBox() { if (_boxEl) { _boxEl.remove(); _boxEl = null; } }
function syncResizeBox(getTf) {
  if (!_boxEl) return;
  const tf = getTf();
  _boxEl.style.left = (tf.x * 100) + '%'; _boxEl.style.top = (tf.y * 100) + '%';
  _boxEl.style.width = (tf.w * 100) + '%'; _boxEl.style.height = (tf.h * 100) + '%';
}
function createResizeBox(getTf, setTf, onChange) {
  const host = $('ve-preview'); if (!host) return;
  const box = document.createElement('div');
  box.className = 've-pip-box';
  box.innerHTML = `<div class="ve-pip-box-handle"></div>`;
  host.appendChild(box);
  _boxEl = box;
  syncResizeBox(getTf);
  box.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('ve-pip-box-handle')) return;
    e.preventDefault(); e.stopPropagation();
    const hostRect = host.getBoundingClientRect();
    const tf0 = getTf();
    const startX = e.clientX, startY = e.clientY;
    try { box.setPointerCapture(e.pointerId); } catch {}
    const mv = (ev) => {
      // 프레임 테두리에 안 묶는다(요청대로) — 밖으로 나간 만큼은 export 의 overlay 와
      // 똑같이 그냥 잘려 보인다(.ve-video-layers 의 overflow:hidden). 박스/손잡이 자체는
      // #ve-preview 바로 밑이라 안 잘리니 언제든 다시 끌고 돌아올 수 있다.
      const nx = tf0.x + (ev.clientX - startX) / hostRect.width;
      const ny = tf0.y + (ev.clientY - startY) / hostRect.height;
      setTf({ ...tf0, x: nx, y: ny });
      syncResizeBox(getTf);
      onChange(false);
    };
    const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); onChange(true); };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
  box.querySelector('.ve-pip-box-handle').addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const hostRect = host.getBoundingClientRect();
    const tf0 = getTf();
    const startX = e.clientX, startY = e.clientY;
    try { e.target.setPointerCapture(e.pointerId); } catch {}
    const mv = (ev) => {
      const dxF = (ev.clientX - startX) / hostRect.width;
      const dyF = (ev.clientY - startY) / hostRect.height;
      let w, h;
      if (tf0.lock) {
        // 대각선 이동량 평균을 확대율처럼 써서 가로세로를 같은 비율로 늘린다(예전 scale
        // 방식과 같은 감각) — w/h 비율 자체는 드래그를 시작한 시점 값을 그대로 지킨다.
        const factor = 1 + (dxF + dyF) / Math.max(0.02, tf0.w + tf0.h);
        w = Math.max(0.02, tf0.w * factor); h = Math.max(0.02, tf0.h * factor);
      } else {
        w = Math.max(0.02, tf0.w + dxF); h = Math.max(0.02, tf0.h + dyF);
      }
      setTf({ ...tf0, w, h });
      syncResizeBox(getTf);
      onChange(false);
    };
    const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); onChange(true); };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
}
// ── PIP(위치/크기) 팝오버 — 트랙 헤더 우측 버튼에서 연다.
let _pipPopoverEl = null;
function onOutsidePip(e) {
  if (_pipPopoverEl && !_pipPopoverEl.contains(e.target) && !(_boxEl && _boxEl.contains(e.target))) closePipPopover();
}
function closePipPopover() {
  closeResizeBox();
  if (!_pipPopoverEl) return;
  _pipPopoverEl.remove(); _pipPopoverEl = null;
  document.removeEventListener('pointerdown', onOutsidePip, true);
}
function syncPipPopoverFields(tf) {
  if (!_pipPopoverEl) return;
  _pipPopoverEl.querySelector('#pip-x').value = Math.round(tf.x * 100);
  _pipPopoverEl.querySelector('#pip-y').value = Math.round(tf.y * 100);
  _pipPopoverEl.querySelector('#pip-w').value = Math.round(tf.w * 100);
  _pipPopoverEl.querySelector('#pip-h').value = Math.round(tf.h * 100);
}
function openPipPopover(track, anchorEl) {
  closePipPopover(); closeShapePopover();
  const tf = track.transform || defaultTransform();
  const r = anchorEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 've-pip-pop';
  pop.style.left = r.left + 'px'; pop.style.top = (r.bottom + 6) + 'px';
  pop.innerHTML = `
    <label>${tr('video.pipX')}<input type="number" id="pip-x" min="-200" max="200" step="1" value="${Math.round(tf.x * 100)}">%</label>
    <label>${tr('video.pipY')}<input type="number" id="pip-y" min="-200" max="200" step="1" value="${Math.round(tf.y * 100)}">%</label>
    <label>${tr('video.shapeW')}<input type="number" id="pip-w" min="2" max="400" step="1" value="${Math.round(tf.w * 100)}">%</label>
    <label>${tr('video.shapeH')}<input type="number" id="pip-h" min="2" max="400" step="1" value="${Math.round(tf.h * 100)}">%</label>
    <label class="ve-pip-lock">${tr('video.lockAspect')}<input type="checkbox" id="pip-lock" ${tf.lock ? 'checked' : ''}></label>
    <button class="mini" id="pip-reset">${tr('video.pipReset')}</button>`;
  document.body.appendChild(pop);
  _pipPopoverEl = pop;
  const getTf = () => track.transform || defaultTransform();
  const setTf = (nextTf) => {
    const isDefault = nextTf.x === 0 && nextTf.y === 0 && nextTf.w === 1 && nextTf.h === 1;
    track.transform = isDefault ? null : nextTf;
    const pair = _layerEls.get(track.id);
    if (pair) applyTrackTransform(pair, track);
    anchorEl.classList.toggle('on', !isDefault);
  };
  // whichChanged 를 알아야 락 상태에서 반대쪽 값을 그 비율로 계산할 수 있다(폭을 바꿨으면
  // 높이를 그 비율로, 높이를 바꿨으면 폭을 그 비율로 — 드래그 손잡이와 같은 감각).
  const applyFromInputs = (whichChanged) => {
    const prev = getTf();
    const x = (Number(pop.querySelector('#pip-x').value) || 0) / 100;
    const y = (Number(pop.querySelector('#pip-y').value) || 0) / 100;
    const lock = pop.querySelector('#pip-lock').checked;
    let w = Math.max(0.02, (Number(pop.querySelector('#pip-w').value) || 100) / 100);
    let h = Math.max(0.02, (Number(pop.querySelector('#pip-h').value) || 100) / 100);
    if (lock && whichChanged && prev.w > 0 && prev.h > 0) {
      if (whichChanged === 'w') h = w * (prev.h / prev.w); else w = h * (prev.w / prev.h);
      pop.querySelector('#pip-w').value = Math.round(w * 100);
      pop.querySelector('#pip-h').value = Math.round(h * 100);
    }
    setTf({ x, y, w, h, lock });
    syncResizeBox(getTf);
    scheduleSave();
  };
  pop.querySelector('#pip-x').addEventListener('input', () => applyFromInputs(null));
  pop.querySelector('#pip-y').addEventListener('input', () => applyFromInputs(null));
  pop.querySelector('#pip-w').addEventListener('input', () => applyFromInputs('w'));
  pop.querySelector('#pip-h').addEventListener('input', () => applyFromInputs('h'));
  pop.querySelector('#pip-lock').addEventListener('change', () => applyFromInputs(null));
  pop.querySelector('#pip-reset').addEventListener('click', () => {
    pop.querySelector('#pip-x').value = 0; pop.querySelector('#pip-y').value = 0;
    pop.querySelector('#pip-w').value = 100; pop.querySelector('#pip-h').value = 100;
    applyFromInputs(null);
  });
  // 박스를 드래그/리사이즈했을 때 숫자 입력칸도 같이 맞춘다(반대 방향 동기화).
  createResizeBox(getTf, (nextTf) => { setTf(nextTf); syncPipPopoverFields(nextTf); }, (committed) => { if (committed) scheduleSave(); });
  setTimeout(() => document.addEventListener('pointerdown', onOutsidePip, true), 0);
}
// ── 클립 효과 체인 — 밝기/대비/채도/흑백/세피아/블러를 순서 있는 목록으로 추가·제거·
// 재배치·on/off 할 수 있다(리졸브/프리미어의 이펙트 스택과 같은 개념). 순서가 결과에
//영향을 준다(흑백 다음 세피아 vs 세피아 다음 흑백은 다른 그림이 나온다). 미리보기는 CSS
// filter 함수, 내보내기는 크로미움 실측과 맞춘 ffmpeg 필터(main.js) — 정밀도는 이미
// 각각 검증되어 있다(밝기/대비/채도·흑백/세피아 전부 오차 0~1픽셀 이내).
// UI(왼쪽 패널)는 이 함수들만 호출하면 된다 — 매번 syncPreview+scheduleSave 까지 알아서 한다.
const EFFECT_TYPES = {
  brightness: { i18n: 'video.colorBrightness', kind: 'range', min: -100, max: 100, def: 0 },
  contrast:   { i18n: 'video.colorContrast',   kind: 'range', min: -100, max: 100, def: 0 },
  saturation: { i18n: 'video.colorSaturation', kind: 'range', min: -100, max: 100, def: 0 },
  bw:         { i18n: 'video.fxBw',    kind: 'toggle' },
  sepia:      { i18n: 'video.fxSepia', kind: 'toggle' },
  blur:       { i18n: 'video.fxBlur',  kind: 'range', min: 0, max: 20, def: 0 },
  // 좌우/상하 반전 — 예전엔 툴바 버튼 두 개(클립당 켜짐/꺼짐 하나씩)였는데, 다른 색보정
  // 효과들처럼 체인에 여러 번 넣었다 뺐다 할 수 있어야 한다는 요청으로 효과 목록에
  // 편입했다. CSS filter 가 아니라 transform 이라 effectsChainCss 엔 안 들어간다 —
  // chainFlip() 이 체인을 스캔해서 따로 뽑는다.
  flipH: { i18n: 'video.flipH', kind: 'toggle' },
  flipV: { i18n: 'video.flipV', kind: 'toggle' },
};
let _effectSeq = 0;
function nextEffectId() { return ++_effectSeq; }
function effectCssFrag(eff) {
  const def = EFFECT_TYPES[eff.type]; if (!def) return '';
  if (def.kind === 'toggle') return eff.type === 'bw' ? 'grayscale(1)' : eff.type === 'sepia' ? 'sepia(1)' : '';
  const v = eff.value ?? def.def;
  if (!v) return '';
  if (eff.type === 'brightness') return `brightness(${1 + v / 100})`;
  if (eff.type === 'contrast') return `contrast(${1 + v / 100})`;
  if (eff.type === 'saturation') return `saturate(${1 + v / 100})`;
  if (eff.type === 'blur') return `blur(${v}px)`;
  return '';
}
function effectsChainCss(effects) {
  if (!effects || !effects.length) return '';
  return effects.filter(e => e.enabled !== false).map(effectCssFrag).filter(Boolean).join(' ');
}
// 반전은 CSS filter 가 아니라 transform 이라 위 함수엔 안 들어간다 — 체인에서 켜진
// flipH/flipV 항목 개수로 홀짝을 따진다(두 번 뒤집으면 원래대로 — 실제 CSS transform:
// scaleX(-1) 을 두 번 곱하면 1이 되는 것과 같은 동작이라 자연스럽다).
function chainFlip(effects) {
  let h = false, v = false;
  for (const e of effects || []) {
    if (e.enabled === false) continue;
    if (e.type === 'flipH') h = !h;
    else if (e.type === 'flipV') v = !v;
  }
  return { h, v };
}
// 클립에 새 효과 추가 — 같은 타입 여러 개도 허용한다(예: 블러 두 번 겹쳐 더 강하게).
function addClipEffect(clip, type) {
  if (!EFFECT_TYPES[type]) return;
  clip.effects = clip.effects || [];
  clip.effects.push({ id: nextEffectId(), type, value: EFFECT_TYPES[type].def, enabled: true });
  syncPreview(nowSec()); scheduleSave();
}
function removeClipEffect(clip, effectId) {
  if (!clip.effects) return;
  clip.effects = clip.effects.filter(e => e.id !== effectId);
  syncPreview(nowSec()); scheduleSave();
}
function toggleClipEffect(clip, effectId) {
  const e = clip.effects?.find(x => x.id === effectId); if (!e) return;
  e.enabled = !e.enabled;
  syncPreview(nowSec()); scheduleSave();
}
// h/v 단축키 편의 — 체인에 flipH/flipV 항목이 이미 있으면 켜고 끄고, 없으면 새로 넣는다.
// 매번 새 항목을 추가하면 키를 여러 번 누를수록 체인만 계속 길어진다(효과 자체는 상쇄돼
// 화면엔 안 보여도 목록이 지저분해진다) — 있는 걸 재사용한다.
function toggleClipFlip(clip, type) {
  if (!clip || clip.isAudioOnly || clip.isText) return;
  const existing = (clip.effects || []).find(e => e.type === type);
  if (existing) toggleClipEffect(clip, existing.id);
  else addClipEffect(clip, type);
}
function setClipEffectValue(clip, effectId, value) {
  const e = clip.effects?.find(x => x.id === effectId); if (!e) return;
  e.value = value;
  syncPreview(nowSec()); scheduleSave();
}
// dir: -1 = 체인에서 앞으로(먼저 적용) · +1 = 뒤로(나중 적용)
function moveClipEffect(clip, effectId, dir) {
  if (!clip.effects) return;
  const i = clip.effects.findIndex(e => e.id === effectId); if (i < 0) return;
  const j = i + dir; if (j < 0 || j >= clip.effects.length) return;
  [clip.effects[i], clip.effects[j]] = [clip.effects[j], clip.effects[i]];
  syncPreview(nowSec()); scheduleSave();
}
// 예전 clip.color/clip.fx(고정 슬롯 3+3개) 프로젝트를 새 effects[] 체인으로 한 번만 옮긴다.
function migrateClipEffects(clip) {
  if (clip.effects || clip.isText) return;   // 텍스트 클립엔 효과 체인 개념이 없다
  const list = [];
  if (clip.color) {
    if (clip.color.b) list.push({ id: nextEffectId(), type: 'brightness', value: clip.color.b, enabled: true });
    if (clip.color.c) list.push({ id: nextEffectId(), type: 'contrast', value: clip.color.c, enabled: true });
    if (clip.color.s) list.push({ id: nextEffectId(), type: 'saturation', value: clip.color.s, enabled: true });
  }
  if (clip.fx) {
    if (clip.fx.bw) list.push({ id: nextEffectId(), type: 'bw', enabled: true });
    if (clip.fx.sepia) list.push({ id: nextEffectId(), type: 'sepia', enabled: true });
    if (clip.fx.blur) list.push({ id: nextEffectId(), type: 'blur', value: clip.fx.blur, enabled: true });
  }
  clip.effects = list;
  delete clip.color; delete clip.fx;
}
// 예전 clip.flipH/clip.flipV(불리언 두 개, 툴바 버튼 시절) → 체인의 flipH/flipV 토글
// 항목으로. migrateClipEffects() 와 달리 clip.effects 가 이미 있어도(색보정 마이그레이션
// 이후 이 세션 내내 그래왔다) 실행해야 한다 — 그래서 별도 함수, 별도 가드(플래그
// 자체가 남아있는지)로 뗐다.
function migrateClipFlip(clip) {
  if (clip.isText) return;
  if (clip.flipH) { clip.effects = clip.effects || []; clip.effects.push({ id: nextEffectId(), type: 'flipH', enabled: true }); }
  if (clip.flipV) { clip.effects = clip.effects || []; clip.effects.push({ id: nextEffectId(), type: 'flipV', enabled: true }); }
  delete clip.flipH; delete clip.flipV;
}
// 예전 도형 클립엔 위치 기본값이 없었다 — transform 이 없으면(트랙 PIP 도 안 걸려 있으면)
// buildEDL 이 "화면 꽉 채움" 취급해서 도형의 작은 그림을 프레임 전체로 억지로 늘려 붙였다
// (위아래 시커먼 여백이 그렇게 생겼다 — 실측으로 확인). 새로 만드는 도형은
// addShapeClipAt 에서 처음부터 transform 을 주지만, 이미 저장된 예전 프로젝트를 열 때도
// 여기서 같은 기본값을 채워 넣는다.
function migrateClipShapeTransform(clip) {
  if (!clip.isShape || clip.transform || (clip.trackKeyframes && clip.trackKeyframes.length)) return;
  clip.transform = { x: 0.35, y: 0.4, w: clip.wPct || 0.3, h: clip.hPct || 0.2, lock: false };
}
// 예전 트랙 PIP 은 {x,y,scale}(항상 정사각 비율) 이었다 — 지금은 {x,y,w,h,lock} 이다.
// scale 을 w=h 로 그대로 옮기고, 예전엔 선택지 없이 항상 비율이 고정돼 있었으니 lock:true
// 로 시작한다(사용자가 이미 맞춰 둔 비율을 프로젝트를 열자마자 망가뜨리지 않기 위해).
function migrateTrackTransform(track) {
  const tf = track.transform;
  if (!tf || tf.w != null) return;
  track.transform = { x: tf.x, y: tf.y, w: tf.scale, h: tf.scale, lock: true };
}

// ── 효과 체인 프리셋 — 클립이 아니라 앱 전역(localStorage)에 저장한다. 프로젝트를
// 넘나들며 "밝기+세피아+블러" 같은 조합에 이름 붙여 재사용하는 용도라 프로젝트 파일에
// 넣을 이유가 없다(테마/모델 선택 등 다른 전역 설정도 전부 localStorage 를 쓴다).
const FX_PRESET_KEY = 've.effectPresets';
function loadEffectPresets() {
  try { const raw = JSON.parse(localStorage.getItem(FX_PRESET_KEY) || '[]'); return Array.isArray(raw) ? raw : []; }
  catch { return []; }
}
function saveEffectPresetsToStorage(list) {
  try { localStorage.setItem(FX_PRESET_KEY, JSON.stringify(list)); } catch {}
}
let _effectPresets = loadEffectPresets();
function saveEffectPreset(name, effects) {
  const clean = (effects || []).map(e => ({ type: e.type, value: e.value, enabled: e.enabled !== false }));
  _effectPresets.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), name, effects: clean });
  saveEffectPresetsToStorage(_effectPresets);
}
function deleteEffectPreset(id) {
  _effectPresets = _effectPresets.filter(p => p.id !== id);
  saveEffectPresetsToStorage(_effectPresets);
}
// 프리셋을 클립에 적용 — 지금 있는 효과는 전부 갈아치운다(덧붙이지 않는다), id 는
// 전역 시퀀스로 새로 발급(프리셋 저장 시점의 id 를 그대로 쓰면 같은 프리셋을 두 번
// 적용했을 때 클립 안에서 id 가 겹친다).
function applyEffectPreset(clip, preset) {
  if (!clip || !preset) return;
  clip.effects = preset.effects.map(e => ({ id: nextEffectId(), type: e.type, value: e.value, enabled: e.enabled !== false }));
  syncPreview(nowSec()); scheduleSave();
}

// ── 효과 체인 패널(미리보기 왼쪽, 상시 표시) ──────────────────────────
// updateClipToolbarUI() 가 선택이 바뀔 때마다(또는 목록이 다시 그려질 때마다) 이 함수를
// 호출한다. 여긴 항상 DOM 을 통째로 다시 그린다 — 구조 변경(추가/삭제/재배치/on-off)이
// 잦은 편이라 부분 갱신보다 단순함이 이득이다. 다만 슬라이더 드래그 중(input 이벤트)엔
// 여길 다시 부르지 않는다(포커스/드래그가 끊긴다) — 값 표시만 그 자리에서 직접 갱신.
function closeFxAddMenu() {
  const menu = $('ve-fx-add-menu');
  if (menu) menu.hidden = true;
  document.removeEventListener('pointerdown', _onFxAddOutside, true);
}
function _onFxAddOutside(e) {
  const menu = $('ve-fx-add-menu'), btn = $('ve-fx-add-btn');
  if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== btn) closeFxAddMenu();
}
function toggleFxAddMenu(clip) {
  const menu = $('ve-fx-add-menu'); if (!menu || !clip || clip.isAudioOnly || clip.isText) return;
  if (!menu.hidden) { closeFxAddMenu(); return; }
  menu.innerHTML = '';
  // 따라다니기 — 색보정과 다른 종류라 위에 따로 하나 놓는다. 이미지/도형에만 있고(영상
  // 자체를 추적 대상 삼는 건 범위 밖), 이미 추적 중이면 "추가"가 아니라 패널의 "다시
  // 지정" 버튼을 쓰게 하므로 메뉴엔 안 보인다.
  if ((clip.isImage || clip.isShape) && !(clip.trackKeyframes && clip.trackKeyframes.length)) {
    const tb = document.createElement('button');
    tb.type = 'button'; tb.className = 've-fx-add-item'; tb.textContent = tr('video.trackFollowTitle');
    tb.addEventListener('click', () => { closeFxAddMenu(); startTrackDrawMode(clip); });
    menu.appendChild(tb);
  }
  Object.keys(EFFECT_TYPES).forEach((type) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 've-fx-add-item'; b.textContent = tr(EFFECT_TYPES[type].i18n);
    b.addEventListener('click', () => { addClipEffect(clip, type); closeFxAddMenu(); renderEffectPanel(clip); });
    menu.appendChild(b);
  });
  menu.hidden = false;
  setTimeout(() => document.addEventListener('pointerdown', _onFxAddOutside, true), 0);
}
function closeFxPresetMenu() {
  const menu = $('ve-fx-preset-menu');
  if (menu) menu.hidden = true;
  document.removeEventListener('pointerdown', _onFxPresetOutside, true);
}
function _onFxPresetOutside(e) {
  const menu = $('ve-fx-preset-menu'), btn = $('ve-fx-preset-btn');
  if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== btn) closeFxPresetMenu();
}
// 프리셋 메뉴 = 저장 행(이름 입력 + 저장 버튼) + 저장된 프리셋 목록(클릭=적용, ×=삭제).
// 저장 버튼은 (a) 이름이 비었거나 (b) 지금 클립에 적용된 효과가 하나도 없으면 막는다
// — 빈 이름/빈 체인 프리셋은 나중에 목록만 어지럽힌다.
function buildFxPresetMenu(clip) {
  const menu = $('ve-fx-preset-menu'); if (!menu) return;
  menu.innerHTML = '';
  const saveRow = document.createElement('div');
  saveRow.className = 've-fx-preset-save-row';
  saveRow.innerHTML = `<input type="text" maxlength="40" placeholder="${esc(tr('video.fxPresetNamePh'))}">
    <button type="button">${esc(tr('video.fxPresetSave'))}</button>`;
  const input = saveRow.querySelector('input'), saveBtn = saveRow.querySelector('button');
  const hasEffects = !!(clip.effects && clip.effects.length);
  const syncSaveBtn = () => { saveBtn.disabled = !hasEffects || !input.value.trim(); };
  syncSaveBtn();
  if (!hasEffects) saveBtn.title = tr('video.fxPresetNoEffects');
  input.addEventListener('input', syncSaveBtn);
  saveBtn.addEventListener('click', () => {
    const name = input.value.trim(); if (!name || !hasEffects) return;
    saveEffectPreset(name, clip.effects);
    closeFxPresetMenu();
  });
  menu.appendChild(saveRow);
  if (_effectPresets.length) {
    const sep = document.createElement('div'); sep.className = 've-fx-preset-sep'; menu.appendChild(sep);
    _effectPresets.forEach((p) => {
      const row = document.createElement('div'); row.className = 've-fx-preset-row';
      const apply = document.createElement('button');
      apply.type = 'button'; apply.className = 've-fx-preset-apply'; apply.textContent = p.name; apply.title = tr('video.fxPresetApplyTitle');
      apply.addEventListener('click', () => { applyEffectPreset(clip, p); closeFxPresetMenu(); renderEffectPanel(clip); });
      const del = document.createElement('button');
      del.type = 'button'; del.className = 've-fx-preset-del'; del.textContent = '×'; del.title = tr('video.fxPresetDeleteTitle');
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteEffectPreset(p.id); buildFxPresetMenu(clip); });
      row.appendChild(apply); row.appendChild(del);
      menu.appendChild(row);
    });
  } else {
    const empty = document.createElement('p'); empty.className = 've-fx-preset-empty'; empty.textContent = tr('video.fxPresetEmpty');
    menu.appendChild(empty);
  }
}
function toggleFxPresetMenu(clip) {
  const menu = $('ve-fx-preset-menu'); if (!menu || !clip || clip.isAudioOnly || clip.isText) return;
  if (!menu.hidden) { closeFxPresetMenu(); return; }
  buildFxPresetMenu(clip);
  menu.hidden = false;
  setTimeout(() => document.addEventListener('pointerdown', _onFxPresetOutside, true), 0);
}
function renderEffectPanel(clip) {
  const body = $('ve-fx-body'), addBtn = $('ve-fx-add-btn'), presetBtn = $('ve-fx-preset-btn');
  if (!body) return;
  closeFxAddMenu(); closeFxPresetMenu();
  if (!clip) {
    if (addBtn) addBtn.disabled = true;
    if (presetBtn) presetBtn.disabled = true;
    body.innerHTML = `<p class="ve-fx-empty">${esc(tr('video.fxNoClip'))}</p>`;
    return;
  }
  if (clip.isAudioOnly || clip.isText) {
    if (addBtn) addBtn.disabled = true;
    if (presetBtn) presetBtn.disabled = true;
    body.innerHTML = `<p class="ve-fx-empty">${esc(tr(clip.isText ? 'video.fxNoText' : 'video.fxAudioOnly'))}</p>`;
    return;
  }
  if (addBtn) addBtn.disabled = false;
  if (presetBtn) presetBtn.disabled = false;
  body.innerHTML = '';
  // "+" 메뉴로 골라서 실제로 추적을 마쳐야만(clip.trackKeyframes 가 생겨야만) 이 섹션이
  // 보인다 — 이미지/도형이라고 무조건 보이던 것에서 바꿈(요청).
  if ((clip.isImage || clip.isShape) && clip.trackKeyframes && clip.trackKeyframes.length) {
    body.appendChild(renderTrackSection(clip));
  }
  const list = clip.effects || [];
  if (!list.length) {
    body.insertAdjacentHTML('beforeend', `<p class="ve-fx-empty">${esc(tr('video.fxEmpty'))}</p>`);
    return;
  }
  list.forEach((eff, i) => {
    const def = EFFECT_TYPES[eff.type]; if (!def) return;
    const isRange = def.kind === 'range';
    const val = eff.value ?? def.def ?? 0;
    const enabled = eff.enabled !== false;
    const row = document.createElement('div');
    row.className = 've-fx-row' + (enabled ? '' : ' off');
    row.dataset.id = String(eff.id);
    row.innerHTML = `
      <div class="ve-fx-row-top">
        <button type="button" class="ve-fx-onoff" aria-pressed="${enabled}" title="${esc(tr('video.fxToggleTitle'))}"></button>
        <span class="ve-fx-name">${esc(tr(def.i18n))}</span>
        ${isRange ? `<span class="ve-fx-val">${val > 0 ? '+' : ''}${val}</span>` : ''}
        <div class="ve-fx-order">
          <button type="button" class="ve-fx-mv" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="${esc(tr('video.fxMoveUp'))}">▲</button>
          <button type="button" class="ve-fx-mv" data-dir="1" ${i === list.length - 1 ? 'disabled' : ''} title="${esc(tr('video.fxMoveDown'))}">▼</button>
        </div>
        <button type="button" class="ve-fx-del" title="${esc(tr('video.fxRemove'))}">×</button>
      </div>
      ${isRange ? `<input type="range" class="ve-fx-slider" min="${def.min}" max="${def.max}" step="1" value="${val}">` : ''}
    `;
    row.querySelector('.ve-fx-onoff').addEventListener('click', () => { toggleClipEffect(clip, eff.id); renderEffectPanel(clip); });
    row.querySelectorAll('.ve-fx-mv').forEach((b) => {
      b.addEventListener('click', () => { moveClipEffect(clip, eff.id, Number(b.dataset.dir)); renderEffectPanel(clip); });
    });
    row.querySelector('.ve-fx-del').addEventListener('click', () => { removeClipEffect(clip, eff.id); renderEffectPanel(clip); });
    const slider = row.querySelector('.ve-fx-slider');
    if (slider) {
      const valEl = row.querySelector('.ve-fx-val');
      slider.addEventListener('input', () => {
        const v = Number(slider.value);
        setClipEffectValue(clip, eff.id, v);
        if (valEl) valEl.textContent = (v > 0 ? '+' : '') + v;
      });
    }
    body.appendChild(row);
  });
}

// ── 따라다니기(추적) ────────────────────────────────────
// 소스 영상의 자연 해상도(sw,sh) 가 출력 캔버스(cw,ch) 안에서 letterbox 로 어떻게 앉는지
// (ffmpeg scalePad 의 force_original_aspect_ratio=decrease + pad 중앙정렬과 동일한 계산) —
// 미리보기 화면 좌표 ↔ 소스 픽셀 좌표를 서로 바꿀 때 이 하나로 양쪽 다 쓴다.
function letterboxRect(sw, sh, cw, ch) {
  const scale = Math.min(cw / sw, ch / sh);
  const dispW = sw * scale, dispH = sh * scale;
  return { scale, offX: (cw - dispW) / 2, offY: (ch - dispH) / 2 };
}
// 이 오버레이 클립 시작 시각에, 그 아래(트랙 순서상 뒤) 깔린 영상 클립 — 추적 대상.
// 자기 트랙보다 뒤(배열 인덱스가 큰) 트랙들 중 맨 앞(가장 작은 인덱스)의 활성 클립.
function findTrackingSource(overlayClip) {
  const myIdx = _veTracks.findIndex(t => t.id === overlayClip.trackId);
  for (let i = myIdx + 1; i < _veTracks.length; i++) {
    const t = _veTracks[i];
    if (t.kind !== 'video' || t.hidden) continue;
    const c = clipAt(t.id, overlayClip.start);
    if (c && !c.isText && c.w && c.h) return c;
  }
  return null;
}
let _trackDrawClip = null;
function cancelTrackDrawMode() {
  if (!_trackDrawClip) return;
  _trackDrawClip = null;
  const host = $('ve-preview');
  host?.classList.remove('ve-track-draw-mode');
  $('ve-track-draw-box')?.remove();
}
// "추적할 영역 지정" 누르면 클립 시작 시각으로 이동하고, 미리보기 위에서 드래그로 박스
// 하나를 그리게 한다 — 놓는 즉시 분석을 시작한다(확인 단계 없이 바로).
function startTrackDrawMode(clip) {
  const source = findTrackingSource(clip);
  if (!source) { flash(tr('video.trackNoSource')); return; }
  cancelTrackDrawMode();
  seekTo(clip.start);
  _trackDrawClip = clip;
  const host = $('ve-preview');
  host.classList.add('ve-track-draw-mode');
  flash(tr('video.trackDrawHint'));
  const box = document.createElement('div'); box.id = 've-track-draw-box'; box.hidden = true;
  host.appendChild(box);
  const onDown = (e) => {
    if (_trackDrawClip !== clip) return;
    e.preventDefault();
    const hostRect = host.getBoundingClientRect();
    const startX = e.clientX - hostRect.left, startY = e.clientY - hostRect.top;
    box.hidden = false;
    const paint = (x0, y0, x1, y1) => {
      box.style.left = Math.min(x0, x1) + 'px'; box.style.top = Math.min(y0, y1) + 'px';
      box.style.width = Math.abs(x1 - x0) + 'px'; box.style.height = Math.abs(y1 - y0) + 'px';
    };
    paint(startX, startY, startX, startY);
    const mv = (ev) => paint(startX, startY, ev.clientX - hostRect.left, ev.clientY - hostRect.top);
    const up = (ev) => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      const endX = ev.clientX - hostRect.left, endY = ev.clientY - hostRect.top;
      const cssBox = { x: Math.min(startX, endX), y: Math.min(startY, endY), w: Math.abs(endX - startX), h: Math.abs(endY - startY) };
      host.removeEventListener('pointerdown', onDown);
      host.classList.remove('ve-track-draw-mode');
      box.remove();
      _trackDrawClip = null;
      if (cssBox.w < 6 || cssBox.h < 6) return;   // 너무 작게 그리면 취소로 본다
      runTracking(clip, source, host.getBoundingClientRect(), cssBox);
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  };
  host.addEventListener('pointerdown', onDown);
}
// 숨은 <video> 로 소스 파일을 프레임마다 seek 해가며 트래커를 돌린다 — video-thumbs.js 의
// 썸네일용 풀과는 별개 인스턴스(동시에 쓰이면 서로 seek 를 가로챈다).
let _trackVideo = null;
function ensureTrackVideo() {
  if (_trackVideo) return _trackVideo;
  const v = document.createElement('video');
  v.preload = 'auto'; v.muted = true; v.playsInline = true; v.crossOrigin = 'anonymous';
  v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;';
  document.body.appendChild(v);
  _trackVideo = v;
  return v;
}
function seekVideoOnce(v, t) {
  return new Promise((resolve) => {
    const onSeeked = () => { v.removeEventListener('seeked', onSeeked); resolve(); };
    v.addEventListener('seeked', onSeeked);
    try { v.currentTime = t; } catch { resolve(); }
  });
}
function loadVideoOnce(v, src) {
  if (v.dataset.src === src && v.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    const onMeta = () => { v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('error', onErr); resolve(); };
    const onErr = () => { v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('error', onErr); resolve(); };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('error', onErr);
    v.src = src; v.dataset.src = src;
  });
}
const TRACK_SAMPLE_INTERVAL = 0.3;   // 초 — 실측해보니 프레임 seek(디코드) 자체가 느려서(샘플당 대략 0.3~0.8초)
// 이보다 촘촘하면 짧은 클립도 분석에 십수 초가 걸린다. 성기면 애니메이션이 계단져 보이지만
// 이 정도면 완만한 움직임엔 충분하다.
async function runTracking(clip, source, previewHostRect, cssBox) {
  const { w: cw, h: ch } = getResolution();
  // 미리보기 화면 좌표(cssBox, #ve-preview 기준) → 소스 영상 자연 해상도 픽셀 좌표.
  // #ve-preview 자체가 이미 출력 해상도 비율 그대로(sizePreviewFrame) 니, CSS px → 캔버스
  // 프랙션은 그냥 hostRect 로 나누면 되고, 거기서 소스 픽셀로는 letterbox 역산.
  const previewLb = letterboxRect(source.w, source.h, previewHostRect.width, previewHostRect.height);
  const srcBox0 = {
    x: (cssBox.x - previewLb.offX) / previewLb.scale,
    y: (cssBox.y - previewLb.offY) / previewLb.scale,
    w: cssBox.w / previewLb.scale,
    h: cssBox.h / previewLb.scale,
  };
  const v = ensureTrackVideo();
  await loadVideoOnce(v, toYtsepUrl(source.file));
  const canvas = document.createElement('canvas'); canvas.width = source.w; canvas.height = source.h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const n = Math.max(1, Math.round(clip.dur / TRACK_SAMPLE_INTERVAL));
  const btn = document.querySelector('.ve-track-start-btn');
  if (btn) btn.disabled = true;
  const outLb = letterboxRect(source.w, source.h, cw, ch);   // 소스 픽셀 → 최종 출력 캔버스 프랙션
  const toCanvasFrac = (b) => ({
    x: (outLb.offX + b.x * outLb.scale) / cw, y: (outLb.offY + b.y * outLb.scale) / ch,
    w: (b.w * outLb.scale) / cw, h: (b.h * outLb.scale) / ch,
  });
  const keyframes = [];
  let tracker = null;
  try {
    for (let i = 0; i <= n; i++) {
      const localT = Math.min(clip.dur, i * TRACK_SAMPLE_INTERVAL);
      // 오버레이 클립의 로컬 시각 → 절대 시각 → 소스 클립 자신의(inOff 반영) 재생 시각.
      const absT = clip.start + localT;
      const srcT = Math.max(0, Math.min((v.duration || source.srcDur || clip.dur) - 0.02, source.inOff + (absT - source.start)));
      await seekVideoOnce(v, srcT);
      ctx.drawImage(v, 0, 0, source.w, source.h);
      let box;
      if (!tracker) { tracker = new BoxTracker(ctx, srcBox0); box = { ...srcBox0 }; }
      else box = tracker.update(ctx);
      keyframes.push({ t: localT, ...toCanvasFrac(box) });
      if (btn) btn.textContent = tr('video.trackAnalyzing', { pct: Math.round((i / n) * 100) });
      // 프레임마다 렌더러가 완전히 멈추지 않도록 한 틱 양보한다.
      await new Promise((r) => requestAnimationFrame(r));
    }
  } catch { /* 분석 중 실패하면 그때까지 모은 키프레임만 쓴다 */ }
  if (keyframes.length >= 2) {
    clip.trackKeyframes = keyframes;
    clip.transform = null;   // 키프레임이 있으면 정적 transform 은 안 쓴다(clipTransformAt 우선순위)
  }
  syncPreview(nowSec());
  renderClips();
  renderEffectPanel(clip);
  scheduleSave();
  flash(tr('video.trackDone'));
}
// 효과 패널 맨 위에 붙는 "따라다니기" 섹션 — "+" 효과 추가 메뉴에서 골라야만 생긴다(요청:
// 기본으로 항상 보이게 두지 말 것). renderEffectPanel 이 clip.trackKeyframes 가 실제로
// 있을 때만 이걸 부른다 — 그래서 여긴 "이미 추적 중" 상태(다시 지정/해제)만 다룬다.
function renderTrackSection(clip) {
  const wrap = document.createElement('div');
  wrap.className = 've-track-section';
  wrap.innerHTML = `
    <div class="ve-track-head">${esc(tr('video.trackFollowTitle'))}</div>
    <div class="ve-track-status">${esc(tr('video.trackActive', { n: clip.trackKeyframes.length }))}</div>
    <div class="ve-track-btns">
      <button type="button" class="mini ve-track-start-btn">${esc(tr('video.trackRedo'))}</button>
      <button type="button" class="mini ve-track-clear-btn">${esc(tr('video.trackClear'))}</button>
    </div>`;
  wrap.querySelector('.ve-track-start-btn').addEventListener('click', () => startTrackDrawMode(clip));
  wrap.querySelector('.ve-track-clear-btn').addEventListener('click', () => {
    clip.trackKeyframes = null;
    syncPreview(nowSec()); renderEffectPanel(clip); scheduleSave();
  });
  return wrap;
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
// el 은 슬롯 래퍼(.ve-layer-slot, <video>+<img> 둘 다 담음) — 클립이 이미지면 <img> 를,
// 아니면 <video> 를 보여준다. 나머지 하나는 숨기고(이미지면 비디오는 멈춰 둔다) 반대로.
function layerVideo(el) { return el.querySelector('video'); }
function driveLayer(el, clip, t, visual) {
  const v = el.querySelector('video'), img = el.querySelector('img');
  if (visual) el.hidden = false;
  if (clip.isImage) {
    if (visual) {
      v.hidden = true; img.hidden = false;
      const flip = chainFlip(clip.effects);
      const sx = flip.h ? -1 : 1, sy = flip.v ? -1 : 1;
      img.style.transform = (sx !== 1 || sy !== 1) ? `scale(${sx}, ${sy})` : '';
      img.style.filter = effectsChainCss(clip.effects);
    }
    if (!v.paused) v.pause();
    const key = clip.file + ':' + (clip._imgRev || 0);
    if (img.dataset.loadedSrc !== key) { img.src = shapeImgUrl(clip); img.dataset.loadedSrc = key; }
    return;
  }
  if (visual) {
    img.hidden = true; v.hidden = false;
    const flip = chainFlip(clip.effects);
    const sx = flip.h ? -1 : 1, sy = flip.v ? -1 : 1;
    v.style.transform = (sx !== 1 || sy !== 1) ? `scale(${sx}, ${sy})` : '';
    v.style.filter = effectsChainCss(clip.effects);
  }
  // 영상 클립이 짝(groupId, 오디오 트랙의 오디오 클립)을 가지고 있으면 소리는 그 짝이
  // 낸다 — 이 레이어는 화면만 그리고 무음이어야 한다(둘 다 소리 내면 겹쳐 들린다).
  // 짝이 없는(예전 프로젝트 등) 클립은 자기 소리를 그대로 낸다.
  v.muted = visual && !!clip.groupId;
  if (v.dataset.loadedSrc !== clip.file) { v.src = toYtsepUrl(clip.file); v.dataset.loadedSrc = clip.file; }
  const target = Math.min(clip.inOff + (t - clip.start), (v.duration || clip.srcDur) - 0.02);
  if (Math.abs(v.currentTime - target) > 0.1) { try { v.currentTime = Math.max(0, target); } catch {} }
  if (_playing && v.paused) v.play().catch(() => {});
  if (!_playing && !v.paused) v.pause();
}
function hideLayer(el, visual) {
  const v = el.querySelector('video'), img = el.querySelector('img');
  // 래퍼(el)뿐 아니라 안쪽 태그 자체의 hidden 도 맞춰 둔다 — video:not([hidden]) 같은
  // 자손 셀렉터는 조상이 hidden 이어도 그 태그 자신의 속성만 본다.
  if (visual) { el.hidden = true; el.style.opacity = ''; v.hidden = true; img.hidden = true; }
  if (!v.paused) v.pause();
}
// 클립 자체 페이드인/아웃 배율(0~1) — 같은 트랙 크로스페이드 믹스와 곱해서 합성한다.
function fadeMul(clip, t) {
  let m = 1;
  const localT = t - clip.start;
  if (clip.fadeIn) m *= Math.max(0, Math.min(1, localT / clip.fadeIn));
  if (clip.fadeOut) m *= Math.max(0, Math.min(1, (clip.start + clip.dur - t) / clip.fadeOut));
  return m;
}
// 텍스트 트랙 컨테이너 갱신 — 그 순간 재생 위치를 덮는 텍스트 클립들을 (보통 0~1개,
// 겹쳐 놓았으면 여러 개) 그려 넣는다. 페이드 핸들은 텍스트 클립엔 안 붙이므로(내보내기가
// 아직 못 따라가는 반쪽 기능은 만들지 않는다) opacity 는 항상 1. 항목 자체를 미리보기
// 위에서 바로 드래그(위치)·모서리 핸들 드래그(크기)할 수 있게 만든다 — CapCut/Canva 류
// 편집기처럼, 숫자 입력칸(팝오버)에 의존하지 않고도 조정 가능해야 한다는 요청 반영.
// clip.size 는 "내보내기 실제 해상도 기준 px" 다(main.js 가 fontsize= 에 그대로 쓴다).
// #ve-preview 는 그 해상도를 화면 크기에 맞춰 축소해서 보여주는 창일 뿐이라, CSS
// font-size 에 raw px 를 그대로 넣으면 미리보기 프레임이 작을 때(거의 항상 그렇다 —
// 1080p 출력이 화면엔 수백 px 로만 뜬다) 실제 결과물보다 글자가 훨씬 커 보인다. 이
// 배율로 나눠서(=화면에 맞게 줄여서) 넣어야 미리보기와 export 글자 크기가 같은 비율로
// 보인다.
function previewScale() {
  const host = $('ve-preview'); if (!host || !host.clientWidth) return 1;
  const { w } = getResolution();
  return w ? host.clientWidth / w : 1;
}
function syncTextLayer(container, track, t) {
  const here = clipsAt(track.id, t);
  container.innerHTML = '';
  const scale = previewScale();
  for (const c of here) {
    const font = TEXT_FONTS[c.fontKey] || TEXT_FONTS.malgun;
    const el = document.createElement('div');
    el.className = 've-text-item' + (c.bg ? ' bg' : '') + (c.id === _selClipId ? ' sel' : '');
    el.style.fontSize = ((c.size || 42) * scale) + 'px';
    el.style.color = c.color || '#ffffff';
    el.style.fontFamily = font.css;
    el.style.fontWeight = font.weight || '400';
    el.textContent = c.text || '';
    wireTextItemDrag(el, c);
    if (c.id === _selClipId) {
      const handle = document.createElement('div');
      handle.className = 've-text-item-rs';
      el.appendChild(handle);
      wireTextItemResize(handle, c);
    }
    container.appendChild(el);
    positionTextItem(el, c.xPct, c.yPct);   // fontSize·글꼴이 다 적용된 뒤라야 실제 크기를 잴 수 있다
  }
}
// PIP 박스와 같은 자유도 — 프레임 테두리에 위치를 묶지 않는다, 밖으로 드래그해서
// 잘려 보여도 상관없다(자연스러운 결과, main.js 의 drawtext 도 똑같이 그냥 잘라준다).
//
// 크기가 줄어드는 건 위치와는 별개 문제였다 — position:absolute + width:auto 인
// 엘리먼트는 CSS 스펙상 "containing block 폭 - left 값" 을 shrink-to-fit 계산의 가용
// 폭으로 쓴다. left:0 에서 자연 크기를 재고 최종 위치의 left/top 만 다시 넣어봤지만
// (지난 시도), width 를 auto 로 그냥 두면 브라우저가 그 "최종" left 값으로 또다시
// shrink-to-fit 을 재계산한다 — 화면 밖 멀리(예: 프레임 절반 밖) 보낼수록 left 가 커져서
// (혹은 음수여서) 가용폭이 계속 좁게 나와 매번 다시 줄바꿈됐다(실측으로 재현: 위치를
// 옮길 때마다 폭이 또 줄어듦). 그래서 자연 크기를 잰 뒤 width 를 px 로 고정해서 박아
// 넣는다 — 그러면 브라우저가 shrink-to-fit 을 다시 계산할 일 자체가 없다. box-sizing:
// border-box(CSS) 라 이 width 가 getBoundingClientRect() 값과 그대로 맞는다.
function positionTextItem(el, xPct, yPct) {
  const host = $('ve-preview'); if (!host) return;
  const hostRect = host.getBoundingClientRect();
  el.style.width = 'auto'; el.style.left = '0px'; el.style.top = '0px';
  const natural = el.getBoundingClientRect();
  el.style.width = natural.width + 'px';
  const left = xPct * hostRect.width - natural.width / 2;
  const top = yPct * hostRect.height - natural.height / 2;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}
// 본문 드래그 = 위치(xPct/yPct) 이동. #ve-preview 크기를 기준으로 비율 델타를 계산해서
// 미리보기 해상도가 바뀌어도(세로 프리셋 등) 항상 맞게 움직인다.
function wireTextItemDrag(el, c) {
  el.addEventListener('pointerdown', (e) => {
    if (e.target.classList.contains('ve-text-item-rs')) return;
    e.preventDefault(); e.stopPropagation();
    const wasSel = _selClipId === c.id;
    _selClipId = c.id;
    // 다른 클립을 고르는 거면 그 클립용으로 열려 있던 팝오버(있다면)는 닫는다 — 안 닫으면
    // renderClips() 가 타임라인을 다시 그리면서 팝오버가 붙잡고 있던 라벨 엘리먼트가 붕 뜬다.
    if (!wasSel) { closeTextPopover(); renderClips(); syncPreview(nowSec()); }
    const host = $('ve-preview'); if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const x0 = c.xPct, y0 = c.yPct;
    const startX = e.clientX, startY = e.clientY;
    try { el.setPointerCapture(e.pointerId); } catch {}
    const mv = (ev) => {
      c.xPct = x0 + (ev.clientX - startX) / hostRect.width;
      c.yPct = y0 + (ev.clientY - startY) / hostRect.height;
      positionTextItem(el, c.xPct, c.yPct);
      syncTextPopoverFields(c);
    };
    const up = () => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      if (c.xPct !== x0 || c.yPct !== y0) scheduleSave();
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
  el.addEventListener('dblclick', (e) => { e.stopPropagation(); openTextPopover(c, el); });
}
// 모서리 핸들 드래그 = 글자 크기. 대각선으로 움직인 픽셀만큼 fontsize 를 늘리고 줄인다
// (모서리에서 멀어지면 커짐, 가까워지면 작아짐 — 다른 편집기의 리사이즈 핸들과 같은 감각).
function wireTextItemResize(handle, c) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault(); e.stopPropagation();
    const size0 = c.size || 42;
    const startX = e.clientX, startY = e.clientY;
    const scale = previewScale() || 1;   // 화면 드래그 픽셀 ↔ 실제(출력 해상도 기준) size 단위 환산
    try { handle.setPointerCapture(e.pointerId); } catch {}
    const mv = (ev) => {
      const d = (ev.clientX - startX) + (ev.clientY - startY);
      c.size = Math.max(8, Math.min(300, Math.round(size0 + d / 2 / scale)));
      const el = handle.parentElement;
      if (el) { el.style.fontSize = (c.size * scale) + 'px'; positionTextItem(el, c.xPct, c.yPct); }   // 크기 바뀌면 클램프도 다시
      syncTextPopoverFields(c);
    };
    const up = () => {
      document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up);
      if (c.size !== size0) scheduleSave();
    };
    document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
  });
}
// 미리보기 위 드래그 결과를 열려 있는 편집 팝오버(있고, 지금 그 클립 것이면)의 숫자
// 입력칸에도 실시간 반영 — input 이벤트를 다시 쏘진 않는다(무한 루프 방지, 그리고 어차피
// apply() 는 이미 clip 필드를 직접 바꿔놨다).
function syncTextPopoverFields(c) {
  if (!_textPopoverEl || _textPopoverCurrentId !== c.id) return;
  const xEl = _textPopoverEl.querySelector('#tx-x'), yEl = _textPopoverEl.querySelector('#tx-y'), sEl = _textPopoverEl.querySelector('#tx-size');
  if (xEl) xEl.value = Math.round(c.xPct * 100);
  if (yEl) yEl.value = Math.round(c.yPct * 100);
  if (sEl) sEl.value = c.size;
}
function syncPreview(t) {
  let any = false;
  for (const track of _veTracks) {
    const pair = _layerEls.get(track.id); if (!pair) continue;
    if (pair.text) {
      if (track.hidden) { pair.text.innerHTML = ''; continue; }
      syncTextLayer(pair.text, track, t);
      continue;
    }
    const { a, b } = pair;
    const visual = track.kind !== 'audio';   // 영상 트랙만 화면에 그린다 — 오디오 트랙은 소리만.
    if (track.hidden) { hideLayer(a, visual); hideLayer(b, visual); continue; }
    const here = clipsAt(track.id, t);
    if (here.length >= 2) {
      const outClip = here[0], inClip = here[1];   // outClip: 먼저 시작해 곧 끝남 · inClip: 나중에 들어와 이어감
      const overlapStart = inClip.start, overlapEnd = outClip.start + outClip.dur;
      const mix = overlapEnd > overlapStart ? Math.min(1, Math.max(0, (t - overlapStart) / (overlapEnd - overlapStart))) : 1;
      const fa = (1 - mix) * fadeMul(outClip, t), fb = mix * fadeMul(inClip, t);
      driveLayer(a, outClip, t, visual); if (visual) { a.style.opacity = String(fa); applyClipTransform(a, outClip, track, t); } layerVideo(a).volume = fa;
      driveLayer(b, inClip, t, visual); if (visual) { b.style.opacity = String(fb); applyClipTransform(b, inClip, track, t); } layerVideo(b).volume = fb;
      any = true;
    } else if (here.length === 1) {
      const f = fadeMul(here[0], t);
      driveLayer(a, here[0], t, visual); if (visual) { a.style.opacity = String(f); applyClipTransform(a, here[0], track, t); } layerVideo(a).volume = f;
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
  return Math.max(content + 4 + _veExtraSec, vw / _pxPerSec);
}
const timelineW = () => Math.max(1, fullSec() * _pxPerSec);
// 오른쪽 끝까지 가로 스크롤하면 트랙(타임라인)이 유기적으로 더 늘어난다 — 클립 길이에
// 맞춰 미리 다 그려두는 대신, 끝에 가까워질 때만 여유분을 얹고 다시 그린다.
function growTimelineIfNeeded() {
  const sc = $('ve-tscroll');
  if (!sc) return;
  if (sc.scrollLeft + sc.clientWidth < sc.scrollWidth - 200) return;   // 아직 끝에서 여유 있음
  _veExtraSec += 20;
  layout();
}

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
// "+트랙" 하나로 통일 — 영상/오디오/텍스트 세 종류를 따로 버튼 세 개 두지 않고 클릭하면
// 뜨는 메뉴에서 고른다(효과 추가 메뉴, toggleFxAddMenu 와 같은 패턴).
function closeAddTrackMenu() {
  const menu = $('ve-add-track-menu');
  if (menu) menu.hidden = true;
  document.removeEventListener('pointerdown', _onAddTrackMenuOutside, true);
}
function _onAddTrackMenuOutside(e) {
  const menu = $('ve-add-track-menu'), btn = $('ve-add-track-btn');
  if (menu && !menu.hidden && !menu.contains(e.target) && e.target !== btn) closeAddTrackMenu();
}
function toggleAddTrackMenu() {
  const menu = $('ve-add-track-menu'); if (!menu) return;
  if (!menu.hidden) { closeAddTrackMenu(); return; }
  menu.hidden = false;
  setTimeout(() => document.addEventListener('pointerdown', _onAddTrackMenuOutside, true), 0);
}
function newVideoTrack(pushHistory = true, append = false) {
  const id = nextTrackId();
  const color = TRACK_COLORS[(_veTracks.length) % TRACK_COLORS.length];
  const track = { id, name: '', color, height: DEFAULT_LANE_H, hidden: false, kind: 'video' };
  // Vegas Pro 관례: 새 비디오 트랙은 목록 맨 위(= 합성 맨 앞)에 들어간다 — "+트랙" 버튼 등
  // 일반적인 경우. append=true 는 임포트가 영상+오디오 쌍을 이어 붙일 때만 쓴다(맨 위로
  // 튀어 올라가면 이미 만든 앞선 쌍들 사이에 끼어들어 순서가 뒤섞인다).
  if (append) _veTracks.push(track); else _veTracks.unshift(track);
  if (pushHistory) {
    pushUndo(
      () => { _veTracks = _veTracks.filter(t => t.id !== id); _veClips = _veClips.filter(c => c.trackId !== id); },
      () => { if (append) _veTracks.push(track); else _veTracks.unshift(track); },
    );
  }
  ensureLayers();
  renderLanes();
  return id;
}
function newAudioTrack(pushHistory = true, afterTrackId = null) {
  const id = nextTrackId();
  const color = TRACK_COLORS[(_veTracks.length) % TRACK_COLORS.length];
  const track = { id, name: '', color, height: DEFAULT_LANE_H, hidden: false, kind: 'audio' };
  // 기본은 Vegas Pro 관례대로 맨 아래. afterTrackId 를 주면(임포트가 영상 하나에 짝지어진
  // 오디오를 만들 때) 그 영상 트랙 바로 다음 자리에 끼워 넣는다 — "영1 오1 영2 오2" 처럼
  // 쌍이 서로 붙어 있어야 한다는 요청 반영(기본 맨 아래로만 쌓으면 "영1 영2 오1 오2" 가
  // 되어 버린다).
  let idx = _veTracks.length;
  if (afterTrackId != null) {
    const vi = _veTracks.findIndex(t => t.id === afterTrackId);
    if (vi >= 0) idx = vi + 1;
  }
  _veTracks.splice(idx, 0, track);
  if (pushHistory) {
    pushUndo(
      () => { _veTracks = _veTracks.filter(t => t.id !== id); _veClips = _veClips.filter(c => c.trackId !== id); },
      () => { _veTracks.splice(idx, 0, track); },
    );
  }
  ensureLayers();
  renderLanes();
  return id;
}
// 텍스트/타이틀 트랙 — 영상 트랙처럼 맨 위(합성 맨 앞, 화면 최상단)에 들어간다. 텍스트는
// 항상 다른 모든 레이어(PIP 포함) 위에 그려져야 자막·타이틀 구실을 한다.
function newTextTrack(pushHistory = true) {
  const id = nextTrackId();
  const color = TRACK_COLORS[(_veTracks.length) % TRACK_COLORS.length];
  const track = { id, name: '', color, height: DEFAULT_LANE_H, hidden: false, kind: 'text' };
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
// 이름 없는 트랙의 기본 이름 — 영상/오디오/텍스트 각자 자기 종류 안에서 순번을 센다
// (Vegas 처럼 영상 트랙 구역과 오디오 트랙 구역이 따로다).
function trackLabel(vt) {
  if (vt.name) return vt.name;
  const sameKind = _veTracks.filter(t => t.kind === vt.kind);
  const n = sameKind.indexOf(vt) + 1;
  if (vt.kind === 'audio') return tr('video.audioTrackN', { n });
  if (vt.kind === 'text') return tr('video.textTrackN', { n });
  return tr('video.trackN', { n });
}

function renderLanes() {
  const lanes = $('ve-lanes'); if (!lanes) return;
  lanes.querySelectorAll('.ve-lane').forEach(el => el.remove());
  _veTracks.forEach((vt) => {
    const lane = document.createElement('div');
    lane.className = 've-lane' + (vt.kind === 'audio' ? ' audio' : vt.kind === 'text' ? ' text' : '');
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
          ${vt.kind === 'video' ? `<button class="ve-hs ve-pip${vt.transform ? ' on' : ''}" data-i18n-title="video.pip" title="위치/크기(PIP)">▭</button>` : ''}
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
// ── 텍스트/타이틀 클립 ────────────────────────────────
// 고를 수 있는 글꼴 — main.js 의 TEXT_FONT_FILES 와 키가 짝이 맞아야 한다(거긴 실제
// export 용 실파일 경로, 여긴 미리보기 CSS font-family/드롭다운 표시용). 전부 Windows
// 기본 설치 폰트 — 번들 없이 참조만 하니 라이선스 문제 없음. 처음 3개는 한글 지원,
// 나머지 3개는 영문 캡션용 스타일 옵션(임팩트=밈 자막, Georgia=세리프, Consolas=고정폭).
const TEXT_FONTS = {
  malgun:   { label: '맑은 고딕',        css: "'Malgun Gothic', sans-serif" },
  malgunbd: { label: '맑은 고딕 (굵게)', css: "'Malgun Gothic', sans-serif", weight: '700' },
  nanum:    { label: '나눔고딕',          css: "'Nanum Gothic', sans-serif" },
  impact:   { label: 'Impact',           css: "Impact, sans-serif" },
  georgia:  { label: 'Georgia',          css: "Georgia, serif" },
  consolas: { label: 'Consolas',         css: "Consolas, monospace" },
};
// srcDur 를 넉넉히 큰 값으로 잡아둔다 — wireTrim 의 오른쪽 트림 상한(c.srcDur - c.inOff)이
// 영상 클립처럼 "소스 길이"를 의미 있게 가질 필요가 텍스트·이미지엔 없어서, 사실상 무제한으로
// 늘릴 수 있게 하는 값이다(Infinity 는 JSON.stringify 가 null 로 뭉개버려 프로젝트 저장이 깨진다).
const HUGE_CLIP_SRC_DUR = 86400;
function addTextClipAt(trackId, atSec) {
  const clip = {
    id: nextClipId(), trackId, isText: true, start: Math.max(0, atSec), dur: 3, inOff: 0, srcDur: HUGE_CLIP_SRC_DUR,
    text: tr('video.textDefault'), xPct: 0.5, yPct: 0.85, size: 42, color: '#ffffff', fontKey: 'malgun', bg: false,
  };
  _veClips.push(clip);
  pushUndo(
    () => { _veClips = _veClips.filter(x => x !== clip); },
    () => { _veClips.push(clip); },
  );
  _selClipId = clip.id;
  layout();
  return clip;
}
// "+텍스트" 툴바 버튼 — 이미 텍스트 트랙이 있으면 거기 재사용(오디오처럼 매번 새 트랙을
// 만들면 클릭할 때마다 자막 레인이 늘어난다), 없으면 새로 만든다. 만들자마자 편집
// 팝오버를 열어서 바로 타이핑할 수 있게 한다 — "추가 → 뭐라고 써야 하지" 텀을 없앤다.
function addText() {
  let tid = _veTracks.find(t => t.kind === 'text')?.id;
  if (tid == null) tid = newTextTrack();
  const clip = addTextClipAt(tid, nowSec());
  const el = document.querySelector(`.ve-clip[data-clip-id="${clip.id}"]`);
  if (el) openTextPopover(clip, el);
}
let _textPopoverEl = null, _textPopoverCurrentId = null;
function onOutsideTextPopover(e) {
  // 미리보기 위 텍스트 아이템(같은 클립이든 다른 클립이든) 클릭·드래그는 "바깥 클릭"이
  // 아니다 — wireTextItemDrag 가 선택 전환·팝오버 정리를 자기 안에서 이미 알아서 한다.
  // 여기서도 같이 닫아버리면 드래그를 시작하는 순간 숫자 입력칸이 사라진다.
  if (e.target.closest && e.target.closest('.ve-text-item')) return;
  if (_textPopoverEl && !_textPopoverEl.contains(e.target)) closeTextPopover();
}
function closeTextPopover() {
  if (!_textPopoverEl) return;
  _textPopoverEl.remove(); _textPopoverEl = null; _textPopoverCurrentId = null;
  document.removeEventListener('pointerdown', onOutsideTextPopover, true);
}
// 텍스트 클립 더블클릭 시 여는 속성 편집 팝오버 — PIP 팝오버(openPipPopover)와 같은 패턴.
// 내용은 입력하는 대로 바로 미리보기/저장에 반영(디바운스 없음 — 텍스트 편집은 PIP 숫자
// 슬라이더만큼 잦지 않다).
function openTextPopover(clip, anchorEl) {
  closeTextPopover(); closePipPopover();
  const r = anchorEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 've-text-pop';
  pop.style.left = Math.max(4, r.left) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
  const fontOptions = Object.entries(TEXT_FONTS).map(([key, f]) =>
    `<option value="${key}" ${key === (clip.fontKey || 'malgun') ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
  pop.innerHTML = `
    <textarea id="tx-content" rows="2" maxlength="200">${esc(clip.text || '')}</textarea>
    <label class="ve-text-pop-full">${tr('video.textFont')}<select id="tx-font">${fontOptions}</select></label>
    <div class="ve-text-pop-row">
      <label>${tr('video.textX')}<input type="number" id="tx-x" min="-200" max="200" step="1" value="${Math.round(clip.xPct * 100)}"></label>
      <label>${tr('video.textY')}<input type="number" id="tx-y" min="-200" max="200" step="1" value="${Math.round(clip.yPct * 100)}"></label>
    </div>
    <div class="ve-text-pop-row">
      <label>${tr('video.textSize')}<input type="number" id="tx-size" min="8" max="200" step="1" value="${clip.size}"></label>
      <label>${tr('video.textColor')}<input type="color" id="tx-color" value="${clip.color}"></label>
    </div>
    <label class="ve-text-pop-full">${tr('video.textBg')}<input type="checkbox" id="tx-bg" ${clip.bg ? 'checked' : ''}></label>
    <button class="ve-text-pop-del" id="tx-delete">${tr('video.fxRemove')}</button>`;
  document.body.appendChild(pop);
  _textPopoverEl = pop; _textPopoverCurrentId = clip.id;
  const lblEl = anchorEl.querySelector('.ve-clip-lbl');
  const apply = () => {
    clip.text = pop.querySelector('#tx-content').value;
    clip.fontKey = pop.querySelector('#tx-font').value;
    // 테두리 기준 상한 없음(PIP 와 같은 자유도) — 프레임 밖으로 나가면 그냥 잘려 보인다.
    clip.xPct = (Number(pop.querySelector('#tx-x').value) || 0) / 100;
    clip.yPct = (Number(pop.querySelector('#tx-y').value) || 0) / 100;
    clip.size = Math.max(1, Number(pop.querySelector('#tx-size').value) || 42);
    clip.color = pop.querySelector('#tx-color').value;
    clip.bg = pop.querySelector('#tx-bg').checked;
    if (lblEl) lblEl.textContent = (clip.text || '').split('\n')[0] || tr('video.textDefault');
    syncPreview(nowSec());
    scheduleSave();
  };
  pop.querySelector('#tx-content').addEventListener('input', apply);
  pop.querySelector('#tx-font').addEventListener('change', apply);
  pop.querySelector('#tx-x').addEventListener('input', apply);
  pop.querySelector('#tx-y').addEventListener('input', apply);
  pop.querySelector('#tx-size').addEventListener('input', apply);
  pop.querySelector('#tx-color').addEventListener('input', apply);
  pop.querySelector('#tx-bg').addEventListener('change', apply);
  pop.querySelector('#tx-delete').addEventListener('click', () => {
    closeTextPopover();
    _selClipId = clip.id;
    deleteSelected();
  });
  pop.querySelector('#tx-content').focus();
  setTimeout(() => document.addEventListener('pointerdown', onOutsideTextPopover, true), 0);
}

// ── 도형(사각형/타원) — 트랙 순서=z-index 원칙을 그대로 따라야 해서(요청) 텍스트처럼
// 항상 맨 위 고정이 아니라 "이미지 클립"으로 만든다 — <canvas> 로 그린 걸 PNG 로 저장해
// 실제 이미지 파일처럼 취급하면, 위치/크기(PIP)·효과·-loop 1 내보내기까지 새 코드 없이
// 이미지 파이프라인을 그대로 탄다. 색·모양이 바뀔 때마다 같은 파일을 덮어쓴다.
function renderShapeDataUrl(clip, pxW, pxH) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.round(pxW)); canvas.height = Math.max(2, Math.round(pxH));
  const ctx = canvas.getContext('2d');
  const sw = Math.max(0, Number(clip.strokeWidth) || 0);
  const inset = sw / 2;
  ctx.lineWidth = sw;
  if (clip.shapeType === 'ellipse') {
    ctx.beginPath();
    ctx.ellipse(canvas.width / 2, canvas.height / 2, Math.max(0.5, canvas.width / 2 - inset), Math.max(0.5, canvas.height / 2 - inset), 0, 0, Math.PI * 2);
    if (clip.fillColor) { ctx.fillStyle = clip.fillColor; ctx.fill(); }
    if (clip.strokeColor && sw > 0) { ctx.strokeStyle = clip.strokeColor; ctx.stroke(); }
  } else {
    const w = Math.max(1, canvas.width - sw), h = Math.max(1, canvas.height - sw);
    if (clip.fillColor) { ctx.fillStyle = clip.fillColor; ctx.fillRect(inset, inset, w, h); }
    if (clip.strokeColor && sw > 0) { ctx.strokeStyle = clip.strokeColor; ctx.strokeRect(inset, inset, w, h); }
  }
  return canvas.toDataURL('image/png');
}
// 실제 파일로 저장해야 이미지 파이프라인(내보내기 -loop 1 등)을 그대로 탄다 — data: URL 은
// ffmpeg -i 가 못 읽는다. 클립 id 를 파일명으로 써서 다시 그릴 때마다 같은 파일을 덮어쓴다.
async function regenerateShapeFile(clip) {
  const { w: rw, h: rh } = getResolution();
  const pxW = Math.max(4, Math.round(rw * (clip.wPct || 0.3)));
  const pxH = Math.max(4, Math.round(rh * (clip.hPct || 0.2)));
  const dataUrl = renderShapeDataUrl(clip, pxW, pxH);
  const base64 = dataUrl.split(',')[1] || '';
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const res = await api.video.saveShapeImage(`shape-${clip.id}`, bytes);
  // 매번 같은 경로에 덮어쓰므로 파일명만으로는 브라우저가 "이미 봤다"며 새로 안 읽어온다
  // (실측 확인 — 색·모양을 바꿔도 화면엔 예전 그림 그대로였다). _imgRev 를 올려서 아래
  // toShapeImgUrl() 이 그때그때 다른 쿼리스트링을 붙이게 한다(파일 경로 자체는 안 바뀐다
  // — main.js 의 ytsep:// 핸들러는 pathname 만 읽고 querystring 은 무시한다).
  if (res?.ok) { clip.file = res.path; clip.w = pxW; clip.h = pxH; clip._imgRev = (clip._imgRev || 0) + 1; }
}
// 이미지 클립 <img> src — 도형이면 _imgRev 를 캐시버스터로 붙인다(파일이 같은 경로에서
// 계속 덮어써지므로). 일반 임포트 이미지는 파일 자체가 안 바뀌니 그대로.
function shapeImgUrl(clip) {
  const base = toYtsepUrl(clip.file);
  return clip.isShape ? base + '?v=' + (clip._imgRev || 0) : base;
}
function addShapeClipAt(trackId, atSec) {
  const wPct = 0.3, hPct = 0.2;
  const clip = {
    id: nextClipId(), trackId, isShape: true, isImage: true, shapeType: 'rect',
    name: tr('video.shapeRect'), start: Math.max(0, atSec), dur: 3, inOff: 0, srcDur: HUGE_CLIP_SRC_DUR,
    wPct, hPct, fillColor: '#35d1a6', strokeColor: '', strokeWidth: 0,
    // 위치를 처음부터 정해 둔다 — 없으면(트랙 PIP 도 없으면) buildEDL 이 "화면 꽉 채움"으로
    // 보고 이 작은 그림을 프레임 전체로 늘려버린다(위아래 여백 버그의 원인이었다).
    transform: { x: 0.35, y: 0.4, w: wPct, h: hPct },
    hasAudio: false, isAudioOnly: false, effects: [], file: null, w: 0, h: 0,
  };
  _veClips.push(clip);
  pushUndo(
    () => { _veClips = _veClips.filter(x => x !== clip); },
    () => { _veClips.push(clip); },
  );
  _selClipId = clip.id;
  layout();
  return clip;
}
// "+트랙" 메뉴의 "도형" 항목 — 항상 새 영상 트랙을 만든다(위치/크기는 그 트랙의 기존
// PIP 버튼으로 조정하므로, 다른 클립과 트랙을 공유하면 그 클립까지 같이 움직여 버린다).
async function addShape() {
  const tid = newVideoTrack();
  const clip = addShapeClipAt(tid, nowSec());
  await regenerateShapeFile(clip);
  ensureLayers(); syncPreview(nowSec()); renderClips();
  const el = document.querySelector(`.ve-clip[data-clip-id="${clip.id}"]`);
  if (el) openShapePopover(clip, el);
}
let _shapePopoverEl = null;
function onOutsideShapePopover(e) {
  if (_shapePopoverEl && !_shapePopoverEl.contains(e.target) && !(_boxEl && _boxEl.contains(e.target))) closeShapePopover();
}
function closeShapePopover() {
  closeResizeBox();
  if (!_shapePopoverEl) return;
  _shapePopoverEl.remove(); _shapePopoverEl = null;
  document.removeEventListener('pointerdown', onOutsideShapePopover, true);
}
function shapeTransform(clip) {
  return clip.transform || { x: 0.35, y: 0.4, w: clip.wPct || 0.3, h: clip.hPct || 0.2, lock: false };
}
function syncShapePopoverFields(tf) {
  if (!_shapePopoverEl) return;
  _shapePopoverEl.querySelector('#sh-x').value = Math.round(tf.x * 100);
  _shapePopoverEl.querySelector('#sh-y').value = Math.round(tf.y * 100);
  _shapePopoverEl.querySelector('#sh-w').value = Math.round(tf.w * 100);
  _shapePopoverEl.querySelector('#sh-h').value = Math.round(tf.h * 100);
}
function openShapePopover(clip, anchorEl) {
  closeShapePopover(); closeTextPopover(); closePipPopover();
  seekTo(clip.start);
  const r = anchorEl.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 've-text-pop';   // 텍스트 팝오버와 같은 상자 스타일 재사용
  pop.style.left = Math.max(4, r.left) + 'px'; pop.style.top = (r.bottom + 6) + 'px';
  const tf = shapeTransform(clip);
  pop.innerHTML = `
    <label class="ve-text-pop-full">${tr('video.shapeType')}<select id="sh-type">
      <option value="rect" ${clip.shapeType === 'rect' ? 'selected' : ''}>${tr('video.shapeRect')}</option>
      <option value="ellipse" ${clip.shapeType === 'ellipse' ? 'selected' : ''}>${tr('video.shapeEllipse')}</option>
    </select></label>
    <div class="ve-text-pop-row">
      <label>${tr('video.shapeFill')}<input type="color" id="sh-fill" value="${clip.fillColor || '#35d1a6'}"></label>
      <label>${tr('video.shapeStroke')}<input type="color" id="sh-stroke" value="${clip.strokeColor || '#ffffff'}"></label>
    </div>
    <label class="ve-text-pop-full">${tr('video.shapeStrokeWidth')}<input type="number" id="sh-sw" min="0" max="60" step="1" value="${clip.strokeWidth || 0}"></label>
    <div class="ve-text-pop-row">
      <label>${tr('video.pipX')}<input type="number" id="sh-x" min="-200" max="200" step="1" value="${Math.round(tf.x * 100)}"></label>
      <label>${tr('video.pipY')}<input type="number" id="sh-y" min="-200" max="200" step="1" value="${Math.round(tf.y * 100)}"></label>
    </div>
    <div class="ve-text-pop-row">
      <label>${tr('video.shapeW')}<input type="number" id="sh-w" min="2" max="400" step="1" value="${Math.round(tf.w * 100)}"></label>
      <label>${tr('video.shapeH')}<input type="number" id="sh-h" min="2" max="400" step="1" value="${Math.round(tf.h * 100)}"></label>
    </div>
    <label class="ve-text-pop-full ve-pip-lock">${tr('video.lockAspect')}<input type="checkbox" id="sh-lock" ${tf.lock ? 'checked' : ''}></label>
    <button class="ve-text-pop-del" id="sh-delete">${tr('video.fxRemove')}</button>`;
  document.body.appendChild(pop);
  _shapePopoverEl = pop;
  const lblEl = anchorEl.querySelector('.ve-clip-lbl');
  const getTf = () => shapeTransform(clip);
  // 모양·색·테두리 변경 — 그림 파일 자체를 다시 그려야 하니 무겁다(renderClips 로 썸네일도
  // 새로 붙인다).
  const applyLook = async () => {
    clip.shapeType = pop.querySelector('#sh-type').value;
    clip.fillColor = pop.querySelector('#sh-fill').value;
    const sw = Math.max(0, Number(pop.querySelector('#sh-sw').value) || 0);
    clip.strokeColor = sw > 0 ? pop.querySelector('#sh-stroke').value : '';
    clip.strokeWidth = sw;
    clip.name = clip.shapeType === 'ellipse' ? tr('video.shapeEllipse') : tr('video.shapeRect');
    if (lblEl) lblEl.textContent = clip.name;
    await regenerateShapeFile(clip);
    syncPreview(nowSec());
    renderClips();
    scheduleSave();
  };
  // 위치/크기 변경 — 그림 파일은 그대로, 배치만 바뀐다(가볍다, renderClips 불필요).
  // whichChanged — 락 상태에서 반대쪽 값을 그 비율로 계산하려면 뭐가 바뀌었는지 알아야 한다.
  const applyTransform = (whichChanged) => {
    const prev = getTf();
    const x = (Number(pop.querySelector('#sh-x').value) || 0) / 100;
    const y = (Number(pop.querySelector('#sh-y').value) || 0) / 100;
    const lock = pop.querySelector('#sh-lock').checked;
    let w = Math.max(0.02, (Number(pop.querySelector('#sh-w').value) || 30) / 100);
    let h = Math.max(0.02, (Number(pop.querySelector('#sh-h').value) || 20) / 100);
    if (lock && whichChanged && prev.w > 0 && prev.h > 0) {
      if (whichChanged === 'w') h = w * (prev.h / prev.w); else w = h * (prev.w / prev.h);
      pop.querySelector('#sh-w').value = Math.round(w * 100);
      pop.querySelector('#sh-h').value = Math.round(h * 100);
    }
    clip.transform = { x, y, w, h, lock };
    syncResizeBox(getTf);
    syncPreview(nowSec());
    scheduleSave();
  };
  pop.querySelector('#sh-type').addEventListener('change', applyLook);
  pop.querySelector('#sh-fill').addEventListener('input', applyLook);
  pop.querySelector('#sh-stroke').addEventListener('input', applyLook);
  pop.querySelector('#sh-sw').addEventListener('input', applyLook);
  pop.querySelector('#sh-x').addEventListener('input', () => applyTransform(null));
  pop.querySelector('#sh-y').addEventListener('input', () => applyTransform(null));
  pop.querySelector('#sh-w').addEventListener('input', () => applyTransform('w'));
  pop.querySelector('#sh-h').addEventListener('input', () => applyTransform('h'));
  pop.querySelector('#sh-lock').addEventListener('change', () => applyTransform(null));
  pop.querySelector('#sh-delete').addEventListener('click', () => {
    closeShapePopover();
    _selClipId = clip.id;
    deleteSelected();
  });
  createResizeBox(getTf, (nextTf) => { clip.transform = nextTf; syncShapePopoverFields(nextTf); syncPreview(nowSec()); }, (committed) => { if (committed) scheduleSave(); });
  setTimeout(() => document.addEventListener('pointerdown', onOutsideShapePopover, true), 0);
}

function renderClips() {
  document.querySelectorAll('.ve-lane').forEach(lane => {
    const trackId = Number(lane.dataset.trackId);
    const area = lane.querySelector('.ve-area');
    area.innerHTML = '';
    for (const c of _veClips.filter(x => x.trackId === trackId)) {
      const el = document.createElement('div');
      el.className = 've-clip' + (c.isAudioOnly ? ' audio' : '') + (c.isText ? ' text' : '') + (c.isImage ? ' image' : '') + (c.id === _selClipId ? ' sel' : '');
      el.style.left = (c.start * _pxPerSec) + 'px';
      el.style.width = Math.max(4, c.dur * _pxPerSec) + 'px';
      el.dataset.clipId = String(c.id);
      if (c.isText) {
        // 텍스트 클립엔 소스 파일이 없다 — 썸네일/페이드 핸들 없이 내용 미리보기 라벨과
        // 트림 핸들만. 페이드는 내보내기(main.js drawtext)가 아직 못 따라가므로 일부러 뺐다
        // (미리보기만 되고 내보내기엔 안 먹히는 반쪽짜리를 만들지 않으려고).
        el.innerHTML = `<span class="ve-clip-lbl">${esc((c.text || '').split('\n')[0] || tr('video.textDefault'))}</span>
          <div class="ve-trim l"></div><div class="ve-trim r"></div>`;
      } else {
        // 오디오 전용(mp3/wav 등, 영상 트랙 없음) 클립은 캡처할 프레임 자체가 없다 —
        // 필름스트립 대신 음표 표시만 둔다.
        el.innerHTML = (c.isAudioOnly ? `<span class="ve-audio-icon">♪</span><canvas class="ve-wave"></canvas>` : `<div class="ve-thumbs"></div>`)
          + `<span class="ve-clip-lbl">${esc(c.name)}</span>
          ${c.fileMissing ? `<span class="ve-clip-missing" title="${esc(tr('video.fileMissing'))}">✕</span>` : ''}
          <div class="ve-fade l"></div><div class="ve-fade r"></div>
          <div class="ve-fadeh l" title="${tr('video.fadeIn')}"></div><div class="ve-fadeh r" title="${tr('video.fadeOut')}"></div>
          <div class="ve-trim l"></div><div class="ve-trim r"></div>`;
      }
      el.addEventListener('pointerdown', (e) => {
        if (e.target.classList.contains('ve-trim') || e.target.classList.contains('ve-fadeh')) return;
        _selClipId = c.id;
        wireMove(e, c, el);
      });
      el.addEventListener('dblclick', () => { if (c.isText) openTextPopover(c, el); else if (c.isShape) openShapePopover(c, el); else seekTo(c.start); });
      // 우클릭으로도 같은 설정 팝오버가 뜨게 한다 — 더블클릭을 몰라서 매번 클립을 새로
      // 만들었다는 피드백 반영(도형/텍스트는 이걸로 이미 만든 클립을 다시 편집할 수 있다).
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        _selClipId = c.id; updateClipToolbarUI();
        if (c.isText) openTextPopover(c, el);
        else if (c.isShape) openShapePopover(c, el);
      });
      wireTrim(el.querySelector('.ve-trim.l'), c, el, 'l');
      wireTrim(el.querySelector('.ve-trim.r'), c, el, 'r');
      if (!c.isText) {
        const paintFade = () => {
          const wi = (c.fadeIn || 0) * _pxPerSec, wo = (c.fadeOut || 0) * _pxPerSec;
          el.querySelector('.ve-fade.l').style.width = wi + 'px'; el.querySelector('.ve-fadeh.l').style.left = wi + 'px';
          el.querySelector('.ve-fade.r').style.width = wo + 'px'; el.querySelector('.ve-fadeh.r').style.right = wo + 'px';
        };
        paintFade();
        wireFade(el.querySelector('.ve-fadeh.l'), c, paintFade, -1);
        wireFade(el.querySelector('.ve-fadeh.r'), c, paintFade, +1);
      }
      area.appendChild(el);
      if (c.isImage) {
        // 이미지는 정지 그림 하나뿐이라 필름스트립(여러 프레임 seek) 대신 그 그림 자체를
        // 통째로 채워 넣는다 — getClipThumb 은 <video> seek 전제라 이미지엔 안 맞는다.
        const box = el.querySelector('.ve-thumbs');
        if (box) box.innerHTML = `<img src="${esc(shapeImgUrl(c))}">`;
      } else if (!c.isAudioOnly && !c.isText) {
        const cached = getClipThumb(c, _pxPerSec, toYtsepUrl, paintThumbs);
        if (cached) paintThumbs(c);
      } else if (c.isAudioOnly) {
        paintWave(c);
      }
    }
  });
  updateClipToolbarUI();
}
// 오디오 클립 파형 — video-thumbs.js 의 paintThumbs 와 같은 패턴(캐시 있으면 바로 그리고,
// 없으면 디코드가 끝난 뒤 다시 불려서 그린다). 캔버스 크기는 클립 엘리먼트의 실제 렌더
// 크기(줌·트랙 높이)를 그대로 따라간다 — 고정 크기로 미리 만들어두면 확대/축소 때마다 흐리거나
// 잘려 보인다.
function paintWave(c) {
  const clipEl = document.querySelector(`.ve-clip[data-clip-id="${c.id}"]`);
  const canvas = clipEl?.querySelector('.ve-wave');
  if (!canvas) return;
  const rect = clipEl.getBoundingClientRect();
  const w = Math.max(4, Math.round(rect.width)), h = Math.max(4, Math.round(rect.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const peaks = getFilePeaks(c, toYtsepUrl, paintWave);
  if (peaks) drawWaveform(canvas, peaks, c.inOff, c.dur);
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
      // 텍스트 클립엔 file 이 없다 — 비디오/오디오 트랙으로 넘어가면 video 태그 src 가
      // undefined 로 깨진다. 반대로 텍스트 트랙은 video 클립을 받을 그림도 없다. 클립
      // 종류와 트랙 종류가 맞을 때만(텍스트↔텍스트, 그 외↔그 외) 옮긴다.
      const targetTrack = _veTracks.find(t => t.id === tid);
      const kindMatches = targetTrack && (c.isText ? targetTrack.kind === 'text' : targetTrack.kind !== 'text');
      if (tid !== c.trackId && kindMatches) {
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
// 좌우/상하 반전은 이제 툴바 버튼이 아니라 효과 체인의 토글 항목(flipH/flipV,
// EFFECT_TYPES) 이다 — addClipEffect(clip,'flipH') 로 켠다. 다른 색보정 효과처럼 순서
// 상관없이 여러 번 넣었다 뺐다 할 수 있고(두 번 넣으면 서로 상쇄), 효과 패널에서만
// 다룬다. 여기 있던 별도 flipSelected()/툴바 상태 갱신은 그래서 다 지웠다.
function updateClipToolbarUI() {
  const c = _selClipId != null ? _veClips.find(x => x.id === _selClipId) : null;
  // 효과 체인 패널(미리보기 왼쪽) — 선택이 바뀌거나 목록이 다시 그려질 때마다 여기서
  // 같이 새로고침한다. 패널 자체의 렌더 함수는 UI 쪽에서 정의.
  if (typeof renderEffectPanel === 'function') renderEffectPanel(c);
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
// 키프레임(clip.trackKeyframes, 클립 로컬 시각 t 기준 {t,x,y,w,h} 배열)에서 임의 시각의
// 위치를 선형보간한다 — 배열은 이미 시간순으로 쌓인다(트래킹이 프레임 순서대로 채운다).
function interpolateKeyframes(kfs, t) {
  if (!kfs.length) return null;
  if (t <= kfs[0].t) return kfs[0];
  if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1];
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i], b = kfs[i + 1];
    if (t >= a.t && t <= b.t) {
      const m = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return { x: a.x + (b.x - a.x) * m, y: a.y + (b.y - a.y) * m, w: a.w + (b.w - a.w) * m, h: a.h + (b.h - a.h) * m };
    }
  }
  return kfs[kfs.length - 1];
}
// 이 클립이 그 절대 시각(absT)에 화면 어디에 놓이는지 — 추적 키프레임이 있으면 보간값,
// 없으면 클립 자체 위치(도형/이미지 개별 배치), 그것도 없으면 트랙 전체 PIP 위치.
function clipTransformAt(c, track, absT) {
  if (c.trackKeyframes && c.trackKeyframes.length) return interpolateKeyframes(c.trackKeyframes, absT - c.start);
  if (c.transform) return c.transform;
  return track.transform;
}
function buildEDL() {
  // 오디오 전용(mp3/wav, 짝지어진 오디오 클립 포함) 구간은 영상 트랙이 없어서 내보낼 때
  // 검은 화면을 대신 채워야 한다 — 해상도는 사용자가 고른 값(getResolution) 을 그대로 쓴다.
  const { w: refW, h: refH } = getResolution();
  const videoTracks = _veTracks.filter(t => t.kind === 'video');
  const audioTracks = _veTracks.filter(t => t.kind === 'audio');
  const textTracks = _veTracks.filter(t => t.kind === 'text');
  // 텍스트 트랙은 화면 합성(PIP/크로스페이드)과 완전히 독립된 오버레이라, 세그먼트가 어떤
  // 모양(plain/xfade/layers/audioOnly)이든 상관없이 그 세그먼트의 실제 중간 시각 하나로
  // 샘플링해서 붙인다 — sampleT 는 호출부가 그 세그먼트의 진짜 [start,end) 중간을 넘긴다
  // (크로스페이드는 여러 breakpoint 창을 하나로 합치므로 바깥 루프의 mid 와 다를 수 있다).
  function collectTexts(sampleT) {
    const out = [];
    for (const track of textTracks) {
      if (track.hidden) continue;
      for (const tc of clipsAt(track.id, sampleT)) {
        out.push({ content: tc.text || '', x: tc.xPct, y: tc.yPct, size: tc.size, color: tc.color, fontKey: tc.fontKey, bg: tc.bg });
      }
    }
    return out;
  }

  // 눈금자에서 지정한 내보내기 구간 — 경계값 자체를 breakpoint 로 넣어 두면 그 지점에서
  // 정확히 구간이 갈라져서, 걸치는 클립을 따로 잘라 넣을 필요 없이 범위 밖 구간만 건너뛰면 된다.
  const range = _veExportRange;
  const bounds = new Set([0]);
  for (const c of _veClips) {
    bounds.add(c.start); bounds.add(c.start + c.dur);
    // 추적 결과(키프레임)가 있으면 그 시각들도 경계로 넣는다 — 그래야 그 사이마다 세그먼트가
    // 잘게 갈라져서 각자 다른(보간된) 위치로 내보내진다("애니메이션"은 여기, 잘게 쪼갠 정적
    // PIP 세그먼트를 이어붙이는 걸로 구현한다 — ffmpeg 쪽엔 새 코드가 필요 없다).
    if (c.trackKeyframes) for (const kf of c.trackKeyframes) bounds.add(c.start + kf.t);
  }
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
    // 기본(트랙 PIP·클립 개별 위치·추적 키프레임 다 없음) = 화면 꽉 채움.
    const topFillsFrame = !top || !clipTransformAt(top.clips[0], top.track, mid);
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
          const flip = chainFlip(c.effects);
          return { file: c.file, start: c.inOff + (a - c.start), end: c.inOff + (b - c.start), transform: clipTransformAt(c, track, mid), flipH: flip.h, flipV: flip.v, effects: c.effects, hdr: c.hdr, ...fadeFieldsFor(c) };
        }),
        audioSources, refW, refH, dur: b - a, texts: collectTexts(mid),
      });
      continue;
    }

    if (relevantVideo.length === 1) {
      const { clips } = relevantVideo[0];
      if (clips.length >= 2) {
        // 같은 트랙 안 크로스페이드(겹쳐 끌어다 놓은 두 클립).
        const outC = clips[0], inC = clips[1];
        const overlapStart = inC.start, overlapEnd = outC.start + outC.dur;
        const flipA = chainFlip(outC.effects), flipB = chainFlip(inC.effects);
        segs.push({
          xfade: true, dur: overlapEnd - overlapStart,
          fileA: outC.file, aIn: outC.inOff + (overlapStart - outC.start), hasAudioA: outC.hasAudio !== false, flipHA: flipA.h, flipVA: flipA.v, effectsA: outC.effects, hdrA: outC.hdr,
          fileB: inC.file, bIn: inC.inOff + (overlapStart - inC.start), hasAudioB: inC.hasAudio !== false, flipHB: flipB.h, flipVB: flipB.v, effectsB: inC.effects, hdrB: inC.hdr,
          refW, refH, texts: collectTexts((overlapStart + overlapEnd) / 2),
        });
        skipUntil = overlapEnd;
        continue;
      }
      const c = clips[0];
      const flip = chainFlip(c.effects);
      segs.push({ file: c.file, start: c.inOff + (a - c.start), end: c.inOff + (b - c.start), audioSources, refW, refH, dur: b - a, flipH: flip.h, flipV: flip.v, effects: c.effects, hdr: c.hdr, texts: collectTexts(mid), ...fadeFieldsFor(c) });
      continue;
    }

    // 영상 트랙엔 아무도 없다 — 오디오 트랙만 있으면 검은 화면 + 그 오디오들로 채운다.
    const texts = collectTexts(mid);
    if (!audioSources.length && !texts.length) continue;   // 아무것도 없는 구간은 건너뛴다(내보낸 결과엔 그 틈이 없다)
    segs.push({ isAudioOnly: true, audioSources, refW, refH, dur: b - a, texts });
  }
  return segs;
}
const VIDEO_FPS_OPTS = ['auto', '24', '30', '60'];
const VIDEO_RES_OPTS = [['2160', '2160p (4K)'], ['1440', '1440p (2K)'], ['1080', '1080p'], ['720', '720p'], ['480', '480p']];
// ── 가사(SRT 자막) ────────────────────────────────
function srtTimestamp(sec) {
  sec = Math.max(0, sec || 0);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
// 텍스트 트랙의 클립을 표준 .srt 로 저장 — 가사 타이밍 도구로 만든 것이든 "+텍스트"로
// 하나씩 손으로 만든 것이든 가리지 않는다(둘 다 결국 같은 isText 클립).
async function exportSrt() {
  const clips = _veClips.filter(c => c.isText).sort((a, b) => a.start - b.start);
  if (!clips.length) { flash(tr('video.srtEmpty')); return; }
  const body = clips.map((c, i) =>
    `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.start + c.dur)}\n${(c.text || '').trim()}\n`
  ).join('\n');
  const r = await api.dialog.saveAs('subtitle.srt', ['srt']);
  if (!r || !r.ok) return;
  const res = await api.fs.writeBuffer(r.filePath, new TextEncoder().encode(body));
  flash(res.ok ? tr('video.srtDone') : tr('video.srtFail'));
}
function openLyricsModal() {
  const host = $('ve-modal');
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>${tr('video.lyrics')}</span><button class="x">✕</button></div>
    <div class="daw-modal-list" id="ve-lyric-body" style="padding:16px"></div></div>`;
  host.hidden = false;
  _lyricTiming = false; _lyricLines = []; _lyricStarts = []; _lyricIdx = 0;
  renderLyricPanel();
  host.querySelector('.x').addEventListener('click', () => { finishLyricTiming(true); });
  host.addEventListener('click', (e) => { if (e.target === host) finishLyricTiming(true); }, { once: true });
}
function renderLyricPanel() {
  const body = $('ve-lyric-body'); if (!body) return;
  if (!_lyricTiming) {
    body.innerHTML = `
      <p class="ve-lyric-hint">${tr('video.lyricPasteHint')}</p>
      <textarea id="ve-lyric-text" rows="10" placeholder="${esc(tr('video.lyricPlaceholder'))}"></textarea>
      <div style="display:flex;justify-content:space-between;margin-top:12px;gap:8px">
        <button class="mini" id="ve-lyric-srt">${tr('video.srtExport')}</button>
        <button class="mini" id="ve-lyric-start">${tr('video.lyricStart')}</button>
      </div>`;
    body.querySelector('#ve-lyric-start').addEventListener('click', startLyricTiming);
    body.querySelector('#ve-lyric-srt').addEventListener('click', exportSrt);
  } else {
    const rows = _lyricLines.map((line, i) => {
      const done = i < _lyricIdx, cur = i === _lyricIdx;
      const ts = _lyricStarts[i] != null ? fmtTC(_lyricStarts[i]) : '';
      return `<div class="ve-lyric-row${cur ? ' cur' : ''}${done ? ' done' : ''}"><span class="ve-lyric-ts">${ts}</span><span class="ve-lyric-txt">${esc(line)}</span></div>`;
    }).join('');
    body.innerHTML = `
      <p class="ve-lyric-hint">${tr('video.lyricTimingHint')}</p>
      <div class="ve-lyric-list" id="ve-lyric-list">${rows}</div>
      <div style="display:flex;justify-content:flex-end;margin-top:12px">
        <button class="mini" id="ve-lyric-cancel">${tr('video.cancel')}</button>
      </div>`;
    body.querySelector('#ve-lyric-cancel').addEventListener('click', () => finishLyricTiming(true));
    body.querySelector('.ve-lyric-row.cur')?.scrollIntoView({ block: 'nearest' });
  }
}
function startLyricTiming() {
  const raw = document.getElementById('ve-lyric-text')?.value || '';
  const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) { flash(tr('video.lyricEmpty')); return; }
  _lyricLines = lines; _lyricStarts = []; _lyricIdx = 0; _lyricTiming = true;
  // 텍스트칸에 포커스가 남아 있으면 전역 keydown 가드(INPUT/TEXTAREA 는 단축키 무시)가
  // Enter/Esc 를 막아버린다 — 타이밍을 시작하는 순간 포커스를 놓는다.
  document.activeElement?.blur?.();
  renderLyricPanel();
}
// Enter — "지금 armed 된 줄"이 바로 이 순간(재생선 위치)부터 시작한다고 찍고 다음 줄로.
// 줄 수만큼 누르면 끝(마지막 줄의 끝은 다음 줄이 없으니 기본 3초로 채운다 — finishLyricTiming).
function stepLyricTiming() {
  if (!_lyricTiming) return;
  _lyricStarts[_lyricIdx] = nowSec();
  _lyricIdx++;
  if (_lyricIdx >= _lyricLines.length) { finishLyricTiming(false); return; }
  renderLyricPanel();
}
function finishLyricTiming(cancel) {
  if (!_lyricTiming && !cancel) return;
  _lyricTiming = false;
  if (!cancel && _lyricStarts.length) {
    let tid = _veTracks.find(t => t.kind === 'text')?.id;
    const createdTrack = tid == null;
    if (createdTrack) tid = newTextTrack(false);
    const trackRef = createdTrack ? _veTracks.find(t => t.id === tid) : null;
    const created = [];
    for (let i = 0; i < _lyricStarts.length; i++) {
      const start = _lyricStarts[i];
      const nextStart = _lyricStarts[i + 1];
      const dur = Math.max(0.3, (nextStart != null ? nextStart : start + 3) - start);
      const clip = {
        id: nextClipId(), trackId: tid, isText: true, start, dur, inOff: 0, srcDur: HUGE_CLIP_SRC_DUR,
        text: _lyricLines[i], xPct: 0.5, yPct: 0.85, size: 42, color: '#ffffff', fontKey: 'malgun', bg: false,
      };
      _veClips.push(clip); created.push(clip);
    }
    pushUndo(
      () => { _veClips = _veClips.filter(c => !created.includes(c)); if (createdTrack) _veTracks = _veTracks.filter(t => t.id !== tid); },
      () => { if (createdTrack) _veTracks.unshift(trackRef); _veClips.push(...created); },
    );
    ensureLayers(); layout();
    flash(tr('video.lyricDone', { n: created.length }));
  }
  const host = $('ve-modal'); if (host) host.hidden = true;
}

function openExportModal() {
  if (!_veClips.length) { flash(tr('video.needImport')); return; }
  const host = $('ve-modal');
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>${tr('video.export')}</span><button class="x">✕</button></div>
    <div class="daw-modal-list" style="padding:16px">
      <div class="dev-field"><span>${tr('video.exportFormat')}</span><select id="ve-exp-fmt">
        <option value="mp4">MP4 · H.264</option>
        <option value="webm">WebM · VP9</option>
      </select></div>
      <div class="dev-field" style="margin-top:10px"><span>${tr('video.exportRes')}</span><select id="ve-exp-res">
        <option value="source" selected>${tr('video.exportResSource')}</option>
        ${VIDEO_RES_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select></div>
      <div class="dev-field" style="margin-top:10px"><span>${tr('video.exportFps')}</span><select id="ve-exp-fps">
        ${VIDEO_FPS_OPTS.map(v => `<option value="${v}">${v === 'auto' ? tr('video.fpsAuto') : v}</option>`).join('')}
      </select></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="mini" id="ve-exp-go">${tr('video.export')}</button></div>
    </div></div>`;
  host.hidden = false;
  host.querySelector('.x').addEventListener('click', () => host.hidden = true);
  host.addEventListener('click', (e) => { if (e.target === host) host.hidden = true; }, { once: true });
  $('ve-exp-go').addEventListener('click', () => {
    host.hidden = true;
    runExport($('ve-exp-fmt').value, $('ve-exp-res').value, $('ve-exp-fps').value);
  });
}
async function runExport(format, res, fps) {
  const segs = buildEDL();
  if (!segs.length) { flash(tr('video.needImport')); return; }
  format = format || 'mp4';
  const r = await api.dialog.saveAs(`export.${format}`, [format]);
  if (!r || !r.ok) return;
  setPlaying(false);
  const btn = $('ve-export');
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '0%'; }
  const totalSec = segs.reduce((s, x) => s + (x.dur != null ? x.dur : (x.end - x.start)), 0) || 1;
  const off = api.video.onExportProgress(({ outTimeMs }) => {
    if (btn) btn.textContent = Math.max(0, Math.min(99, Math.round((outTimeMs / 1e6) / totalSec * 100))) + '%';
  });
  let result;
  try { result = await api.video.export({ segments: segs, outPath: r.filePath, format, res, fps }); }
  finally { off?.(); if (btn) { btn.disabled = false; btn.textContent = label; } }
  flash(result.ok ? tr('video.exportDone') : tr('video.exportFail', { err: result.error || '' }));
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
  // append=true — 이 트랙은 맨 위로 튀어 오르면 안 된다. 반복해서(파일 하나씩) 임포트할
  // 때마다 앞서 만든 "영상N/오디오N" 쌍 사이에 새로 끼어들면 순서가 뒤섞이고, 기존
  // 트랙들의 위치가 밀리면서 번호(trackLabel 이 목록 위치로 매기는 순번)까지 바뀌어
  // 버린다 — 항상 맨 아래에 이어 붙여야 "영1 오1 영2 오2..." 순서와 기존 번호가 지켜진다.
  if (createdVideoTrack) tid = newVideoTrack(false, true);   // 되돌리기는 아래서 임포트 전체를 한 덩어리로 묶는다
  const videoTrackRef = createdVideoTrack ? _veTracks.find(t => t.id === tid) : null;
  let videoCursor = 0;
  for (const c of _veClips.filter(x => x.trackId === tid)) videoCursor = Math.max(videoCursor, c.start + c.dur);

  let audioTid = null, audioTrackRef = null, createdAudioTrack = false, audioCursor = 0;
  function ensureAudioTrack() {
    if (audioTid != null) return;
    // 같은 임포트 배치 안에서는 트랙을 같이 쓴다(영상들을 순서대로 이어붙일 때 그 오디오도
    // 나란히 이어져야 자연스럽다) — 단, 그 오디오 트랙이 "완전히 비어 있을 때만" 재사용한다.
    // 예전엔 kind==='audio' 인 트랙을 무조건 재사용해서, 서로 다른(따로따로 실행한) 임포트
    // 호출의 오디오가 전부 그 하나의 트랙에 계속 쌓였다(영상은 각자 새 트랙이 생기는데
    // 오디오만 계속 합쳐지는 버그 — 트랙이 이미 비어 있는지를 video 쪽과 똑같은 기준으로
    // 확인해야 한다).
    const existing = _veTracks.find(t => t.kind === 'audio' && !_veClips.some(c => c.trackId === t.id));
    if (existing) { audioTid = existing.id; }
    // afterTrackId=tid — 이 영상 트랙(tid) 바로 다음 자리에 끼워서 "영1 오1" 처럼 붙어
    // 있게 한다(요청: "영1 오1 영2 오2" 여야 하는데 "영1 영2 오1 오2" 로 나왔다).
    else { audioTid = newAudioTrack(false, tid); audioTrackRef = _veTracks.find(t => t.id === audioTid); createdAudioTrack = true; }
    for (const c of _veClips.filter(x => x.trackId === audioTid)) audioCursor = Math.max(audioCursor, c.start + c.dur);
  }

  const added = [];
  let importedFileCount = 0;   // 토스트에 쓸 "파일 개수" — 영상 1개가 클립 2개(영상+짝지어진
                                // 오디오)를 만들어도 사용자가 고른 건 1개다("2개가 임포트됐다"고
                                // 잘못 뜨던 버그).
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
      _veClips.push(clip); added.push(clip); importedFileCount++;
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
    importedFileCount++;
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
        // addedTracks 는 [영상(있으면), 오디오(있으면)] 순서로 쌓여 있다 — 영상을 먼저
        // 되살려야 오디오를 그 바로 다음 자리에 다시 끼워 넣을 기준(tid)을 찾을 수 있다.
        for (const t of addedTracks) {
          if (t.kind === 'audio') {
            const vi = _veTracks.findIndex(x => x.id === tid);
            _veTracks.splice(vi >= 0 ? vi + 1 : _veTracks.length, 0, t);
          } else {
            _veTracks.push(t);
          }
        }
        _veClips.push(...added);
      },
    );
  }
  ensureLayers();
  layout();
  if (importedFileCount) flash(tr('video.importing', { n: importedFileCount }));
  else flash(tr('video.needImport'));
}
async function pickImportVideo() {
  const r = await api.dialog.pickVideoFiles('video');
  if (!r || !r.ok || !r.filePaths?.length) return;
  // 방금 만든(맨 위) 영상 트랙이 아직 비어 있으면 거기로, 아니면 새 트랙을 만든다 —
  // "+트랙" 누르고 바로 "임포트" 눌렀을 때 트랙이 두 개로 늘어나지 않도록.
  const top = _veTracks.find(t => t.kind === 'video');
  const reuse = top && !_veClips.some(c => c.trackId === top.id);
  importVideoFiles(r.filePaths, reuse ? top.id : null);
}
const IMAGE_CLIP_DEFAULT_DUR = 5;   // 이미지는 영상과 달리 고유 길이가 없다 — 기본 5초, 트림으로 늘리고 줄인다.
function probeImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth || 0, h: img.naturalHeight || 0 });
    img.onerror = () => resolve({ w: 0, h: 0 });
    img.src = toYtsepUrl(file);
  });
}
// 이미지는 영상 트랙 위 클립으로 들어간다(별도 트랙 종류를 안 둔다) — PIP 위치/크기·
// 트랙 순서=z-index·효과 체인(밝기/대비/반전 등)을 전부 그대로 물려받는다. 소스 길이가
// 없어(HUGE_CLIP_SRC_DUR) 트림으로 원하는 만큼 늘리거나 줄일 수 있다.
async function importImageFiles(paths, trackId) {
  let tid = trackId;
  const createdVideoTrack = tid == null;
  if (createdVideoTrack) tid = newVideoTrack(false);
  const videoTrackRef = createdVideoTrack ? _veTracks.find(t => t.id === tid) : null;
  let cursor = 0;
  for (const c of _veClips.filter(x => x.trackId === tid)) cursor = Math.max(cursor, c.start + c.dur);

  const added = [];
  for (const p of paths) {
    const meta = await probeImage(p);
    if (!meta.w || !meta.h) continue;
    const name = p.split(/[\\/]/).pop();
    const clip = {
      id: nextClipId(), trackId: tid, isImage: true, file: p, name,
      start: cursor, inOff: 0, srcDur: HUGE_CLIP_SRC_DUR, dur: IMAGE_CLIP_DEFAULT_DUR,
      w: meta.w, h: meta.h, hasAudio: false, isAudioOnly: false, effects: [],
    };
    _veClips.push(clip); added.push(clip);
    cursor += IMAGE_CLIP_DEFAULT_DUR;
  }

  if (added.length) {
    pushUndo(
      () => {
        _veClips = _veClips.filter(c => !added.includes(c));
        if (createdVideoTrack) _veTracks = _veTracks.filter(t => t !== videoTrackRef);
      },
      () => {
        if (createdVideoTrack) _veTracks.unshift(videoTrackRef);
        _veClips.push(...added);
      },
    );
  }
  ensureLayers();
  layout();
  if (added.length) flash(tr('video.importing', { n: added.length }));
  else flash(tr('video.needImport'));
}
async function pickImportImage() {
  const r = await api.dialog.pickVideoFiles('image');
  if (!r || !r.ok || !r.filePaths?.length) return;
  const top = _veTracks.find(t => t.kind === 'video');
  const reuse = top && !_veClips.some(c => c.trackId === top.id);
  importImageFiles(r.filePaths, reuse ? top.id : null);
}
// "+오디오" 전용 임포트 — 항상 새 오디오 트랙을 만들어 그 안에만 채운다. 일반 "임포트"
// 버튼(pickImportVideo→importVideoFiles)의 ensureAudioTrack() 은 오디오 클립이 생길 때마다
// "이미 있는 오디오 트랙"을 재사용해서, 트랙을 여러 개 만들어 겹치게(배경음악+대사처럼
// 동시에 섞이게) 두는 방법이 없었다 — 버튼을 누를 때마다 매번 독립된 트랙이 생겨야
// 여러 오디오를 동시에 쓸 수 있다.
async function pickImportAudioTrack() {
  const r = await api.dialog.pickVideoFiles('audio');
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
  $('ve-add-track-btn')?.addEventListener('click', () => toggleAddTrackMenu());
  $('ve-add-track-menu')?.querySelectorAll('[data-kind]').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeAddTrackMenu();
      const kind = btn.dataset.kind;
      if (kind === 'video') newVideoTrack();
      else if (kind === 'audio') pickImportAudioTrack();
      else if (kind === 'text') addText();
      else if (kind === 'image') pickImportImage();
      else if (kind === 'shape') addShape();
    });
  });
  $('ve-import')?.addEventListener('click', () => pickImportVideo());
  $('ve-save-project')?.addEventListener('click', () => saveProjectAs());
  $('ve-open-project')?.addEventListener('click', () => openProjectFile());
  $('ve-undo')?.addEventListener('click', () => doUndo());
  $('ve-redo')?.addEventListener('click', () => doRedo());
  $('ve-fx-add-btn')?.addEventListener('click', () => {
    const c = _selClipId != null ? _veClips.find(x => x.id === _selClipId) : null;
    toggleFxAddMenu(c);
  });
  $('ve-fx-preset-btn')?.addEventListener('click', () => {
    const c = _selClipId != null ? _veClips.find(x => x.id === _selClipId) : null;
    toggleFxPresetMenu(c);
  });
  $('ve-empty-import')?.addEventListener('click', () => pickImportVideo());
  $('ve-seek0')?.addEventListener('click', () => seekTo(0));
  $('ve-play')?.addEventListener('click', () => setPlaying(!_playing));
  $('ve-zoom-in')?.addEventListener('click', () => { _pxPerSec = Math.min(400, _pxPerSec * 1.3); layout(); });
  $('ve-zoom-out')?.addEventListener('click', () => { _pxPerSec = Math.max(4, _pxPerSec / 1.3); layout(); });
  $('ve-export')?.addEventListener('click', () => openExportModal());
  $('ve-lyrics')?.addEventListener('click', () => openLyricsModal());
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
  // Ctrl+휠 = 배율. 트랙 컨트롤(헤드) 위 = 네이티브 세로 스크롤(트랙 많을 때 목록 훑기용).
  // 그 외(타임라인 위) = 가로 스크롤 — 스튜디오와 같은 패턴.
  $('ve-tscroll')?.addEventListener('wheel', (e) => {
    const sc = $('ve-tscroll');
    if (e.ctrlKey) {
      e.preventDefault();
      _pxPerSec = Math.max(4, Math.min(400, _pxPerSec * (e.deltaY < 0 ? 1.08 : 0.93)));
      layout();
      return;
    }
    if (e.target.closest('.ve-head, .ve-ruler-ctrl')) return;
    e.preventDefault();
    sc.scrollLeft += (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX);
    growTimelineIfNeeded();
  }, { passive: false });
  // 스크롤바를 직접 끌 때도(휠이 아니어도) 끝에 가까워지면 마찬가지로 늘어나야 한다.
  $('ve-tscroll')?.addEventListener('scroll', () => growTimelineIfNeeded());
  document.addEventListener('keydown', (e) => {
    const view = document.querySelector('.video-body');
    if (!view || view.hidden) return;
    // 가사 타이밍 모드 — 재생/정지(Space)는 평소처럼 쓸 수 있어야 하니 그대로 두고,
    // Enter/Esc 만 여기서 가로챈다. INPUT/TEXTAREA 포커스 가드보다 먼저 확인한다 —
    // startLyricTiming() 이 포커스를 놓지만(blur), 혹시 남아있어도 이 두 키는 살아있어야 한다.
    if (_lyricTiming) {
      if (e.key === 'Enter') { e.preventDefault(); stepLyricTiming(); return; }
      if (e.key === 'Escape') { e.preventDefault(); finishLyricTiming(true); return; }
    }
    if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.code === 'Space') { e.preventDefault(); setPlaying(!_playing); }
    else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); doRedo(); }
    else if (e.key === 's' || e.key === 'S') splitAtPlayhead();
    else if (e.key === 'u' || e.key === 'U') ungroupSelected();   // Vegas Pro 와 같은 단축키
    else if (e.key === 'h' || e.key === 'H') { const c = _veClips.find(x => x.id === _selClipId); toggleClipFlip(c, 'flipH'); renderEffectPanel(c); }
    else if (e.key === 'v' || e.key === 'V') { const c = _veClips.find(x => x.id === _selClipId); toggleClipFlip(c, 'flipV'); renderEffectPanel(c); }
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
