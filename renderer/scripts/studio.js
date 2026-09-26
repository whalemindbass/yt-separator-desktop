// 스튜디오 DAW — 대형 영상 + 스템/녹음 트랙 + 저지연 엔진(JUCE)
//   엔진(오디오)=마스터 클럭. 영상은 muted 로 playhead 따라감(드리프트 보정).
import { Library } from './library.js';
import { toYtsepUrl, loadStemFilesToBuffers } from './player.js';
import { detectBeats } from './beat-detect.js';
import { FADER_POS, FADER_UNITY_POS, faderToGain, gainToFader, dbText } from './fader.js';
import { esc, fmtTC, fmtDelta, rgbToHex, meterPct, buildWaveSvg,
         METER_BLOCKS, METER_FLOOR_DB, METER_GATE, noteCrashAndCheckLoop, inputConfigInRange,
         pickInputConfig, mergeFxCache, latencyBreakdown,
         kbNoteFor, noteName, isTypingTarget, quantizeNotes, quantStepSec, QUANT_DIVS, clipFromMidiTake, midiClipForEngine } from './studio/util.js';
// 번역 함수는 tr 로 받는다 — 이 파일은 t 를 트랙·테이크 루프 변수로 많이 써서
// 같은 이름이면 함수가 가려진다(런타임 TypeError).
import { t as tr, getLocale, onLocaleChange } from './i18n.js';
import { TabView, transcribeBass, cancelTranscribe, toMono } from './tabview.js';
import { openPianoRoll } from './studio/pianoroll.js';
import { ChordStripView } from './chordstrip.js';
import { buildScore, beatAccents, estimateKey, computeBarChords } from '../workers/tab-score.js';
import { detectChords, phaseFromChords, NON_HARMONY_STEMS } from '../workers/tab-chord.js';
import { getPresets, setPresets, upsertPreset } from './fx-presets.js';
import { timeStretchStereo, pitchShiftStereo } from './pitch-shift.js';

const api = window.yssApi;
const $ = (id) => document.getElementById(id);
// innerHTML 삽입 전 외부/사용자 유래 문자열 이스케이프 (yt 영상 제목·VST명·프리셋명 등)

const STEM_COLOR = {
  vocals: 'var(--stem-vocals)', drums: 'var(--stem-drums)',
  bass: 'var(--stem-bass)', other: 'var(--stem-other)',
  guitar: 'var(--stem-other)', piano: 'var(--stem-drums)', mine: 'var(--accent)',
};
// 키만 두고 쓰는 곳에서 번역한다. 모듈 로드 시점에 굳히면 언어를 바꿔도
// 이미 만들어진 문자열이 그대로 남는다.
// other 와 guitar 는 한국어로 둘 다 '기타' 지만 뜻이 달라 키를 나눈다.
const STEM_LABEL_KEY = { vocals: 'studio.stem.vocals', drums: 'studio.stem.drums', bass: 'studio.stem.bass',
                         other: 'studio.stem.other', guitar: 'studio.stem.guitar', piano: 'studio.stem.piano' };
const stemLabel = (k) => (STEM_LABEL_KEY[k] ? tr(STEM_LABEL_KEY[k]) : k);

let _wired = false, _started = false;
// 엔진이 (재)연결될 때마다 녹음 트랙 목록을 한 번 스스로 알려온다(초기 동기화) — 사용자가
// 아무것도 안 해도 오는 이 첫 메시지까지 '변경'으로 세면, 스튜디오에 들어가기만 해도
// 닫을 때 저장하라고 뜬다. 그다음부터 오는 recTracks 는 추가·삭제 같은 실제 편집이다.
let _recTracksBaseline = false;
let _sr = 44100, _dur = 0, _pxPerSec = 12;
// 스템 일괄 재생 속도 — _baseDur(비디오 metadata 로 잰 원본 길이)를 그대로 두고, 실제로
// 쓰는 _dur 은 항상 _baseDur/_speed 로 다시 계산한다(느리게 하면 클립 길이도 늘어나야
// 한다는 요청 — 배속(engine playbackRate)이 아니라 진짜 타임스트레치라 파형·룰러 폭
// 자체가 늘어난다). _speedBase 는 처음 1배가 아닌 값으로 바꾸는 순간의 BPM/그리드를
// 얼려 둔 것 — 이후 몇 번을 다시 바꾸든 항상 이 기준에서 배율만 다시 계산해서, 반올림
// 오차가 계속 누적되지 않는다.
let _speed = 1, _speedBase = null, _speedBusy = false, _baseDur = 0, _speedCancelRequested = false;
// 마지막으로 실제로 늘인/줄인 스템 파일 경로(stemsDir 에 저장돼 계속 남는다) — 프로젝트에
// 같이 저장해 두면, 다음에 열 때 다시 늘일 필요 없이 이 파일들을 그대로 다시 불러오기만
// 하면 된다("불러오고 또 처리하느라 시간 걸린다" 신고 — 재처리 없이 즉시 복원하게 고침).
// _speedStemPaths 는 속도뿐 아니라 키(피치)까지 같이 반영해 처리한 결과물 캐시다 — 둘 다
// 항상 원본 _stemPaths 에서부터 함께 다시 만든다(applyTransform 하나로 합침).
let _speedStemPaths = null;
// 스템 일괄 키(피치) 조절 — 라이브러리 쪽 미리듣기 플레이어에는 이미 있던 기능(pitch-shift.js)을
// 스튜디오에도 추가한 것. 길이는 안 바뀌므로(녹음된 클립 위치와 무관) 속도와 달리 take 가
// 있어도 막지 않는다.
let _keySemitones = 0;
function recomputeDur() { _dur = _baseDur / (_speed || 1); }

// 시간은 초로 들고 다니고, 엔진 경계에서만 샘플로 바꾼다.
//
// 샘플 수를 그냥 숫자로 주고받으면 어느 레이트로 잰 것인지가 값에 붙어 다니지 않는다.
// 지난 버그 세 건(48kHz 에서 8.8% 빠른 재생 · 프로젝트 열면 클립만 밀림 · 레이트 바꾸면 어긋남)이
// 전부 그 하나에서 나왔다. 변환은 이 두 함수만 쓰고, 그래야 어디서 바뀌는지 한눈에 찾힌다.
function deviceSr() { return _sr || 44100; }
const secToSamples = (sec) => Math.round((sec || 0) * deviceSr());
const samplesToSec = (n)   => (n || 0) / deviceSr();
let _playing = false, _recArmed = false;
let _playStart = 0;   // 재생 시작점
let _returnOnStop = true;   // 정지 시 재생 시작 위치로 복귀 (옵션)
let _rangeMode = false;     // 영역 선택 모드(룰러 드래그 = 내보내기 구간)
let _magnetOn = true;       // 자석 스냅(그리드 + 클립 경계) — Alt 는 이 상태를 순간적으로 뒤집는다
let _marqueeOn = false;     // 마퀴 모드 — 켜져 있으면 트랙 빈 곳 드래그가 팬 대신 영역 다중선택
let _tracks = [];          // [{key,label,color,engineIndex}]
// 스템 일괄 볼륨 — 개별 스템 페이더(t.gain, 저장/undo 대상)는 안 건드리고, 엔진에
// 실제로 나가는 순간에만 이 배율을 곱한다. 프로젝트 파일엔 저장하지 않는(세션 전용)
// 편의 컨트롤 — 곡/프로젝트를 새로 열 때마다 1(0dB)로 리셋한다.
let _stemGroupGain = 1;
function stemGainOut(t) { return (t.gain != null ? t.gain : 1) * _stemGroupGain; }
function pushAllStemGains() { _tracks.forEach(t => api.engine.track(t.engineIndex, { gain: stemGainOut(t) })); }
function resetStemGroupGain() {   // 곡/프로젝트를 새로 열 때마다 — 이전 곡의 배율이 새 곡에 묻어가면 안 된다
  _stemGroupGain = 1;
  const s = $('mx-stem-group'); if (s) s.value = FADER_UNITY_POS;
  const v = $('mx-stem-group-val'); if (v) v.textContent = dbText(1);
}
let _chain = [];              // 선택된 트랙의 FX 체인 미러 (_chainByTrack[_selTrack])
let _chainByTrack = {};       // trackId → [{id,index,name,hasEditor,bypass}]
let _selTrack = null;         // 선택(편집 대상) 녹음 트랙 id — 이펙트 패널 대상
let _selClipId = null;        // 선택 클립 id — 분할(S) 대상(마지막 클릭=주 선택)
let _selClips = new Set();    // 다중 선택 클립 id 집합
let _clipboard = [];          // 복사/잘라낸 클립 스냅샷 [{file,inOff,dur,srcDur,fadeIn,fadeOut,trackId,relStart}]
let _activePresetId = null;
let _presetGather = null;     // 저장: {name,id?,states:{slotId:data},need:[ids],meta:[{index,bypass}],order:[ids]}
let _pendingPreset = null;    // 로드: {slots:[{index,bypass,data}]}

function startGather(opts) {   // 현재 트랙 체인 상태를 모아 프리셋 생성/갱신
  if (_selTrack == null) { flashTake(tr('studio.m.selectTrack')); return; }
  if (!_chain.length) { flashTake(tr('studio.m.noVst')); return; }
  _presetGather = { ...opts, states: {}, need: _chain.map(s => s.id), meta: _chain.map(s => ({ index: s.index, bypass: s.bypass })), order: _chain.map(s => s.id) };
  for (const s of _chain) api.engine.fxSaveState(_selTrack, s.id);
}
function loadPreset(p) {
  if (_selTrack == null) { flashTake(tr('studio.m.selectTrack')); return; }
  _activePresetId = p.id;
  showFxOverlay(tr('studio.m.loadingTone'));
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
      <input id="daw-name-in" class="daw-fx-select" style="margin:0" placeholder="${tr('studio.x.toneName')}" />
      <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end"><button class="mini" id="daw-name-ok">${tr('studio.x.save')}</button></div>
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
  if (!ps.length) { openModal(tr('studio.d.loadTone'), '<div class="daw-modal-empty">' + tr('studio.m.noTones') + '</div>', () => {}); return; }
  const html = ps.map((p, i) => `<div class="daw-modal-item" data-idx="${i}">
    <div class="mt"><div class="n">${esc(p.name)}</div><div class="m">${esc((_plugins[p.index] && _plugins[p.index].name) || ('VST ' + p.index))}</div></div>
    <button class="daw-preset-del" data-id="${esc(p.id)}" title="${tr('studio.t.delete')}">✕</button></div>`).join('');
  openModal(tr('studio.d.loadTone'), html, (idx) => loadPreset(ps[Number(idx)]));
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
let _modelKey = null;      // 현재 곡을 분리한 모델 — 4stem/4stem-2/6stem 전환 토글용

const HEAD_W = 172;
const DEFAULT_LANE_H = 82;   // CSS .daw-lane 기본 높이 — pan/meter 2번째 줄 수용
// 마디(bar) 기준 눈금 — 템포 가정(추후 감지/조절 가능). 120BPM·4/4 → 1마디 2초
const BEATS_PER_BAR = 4;
let _bpm = 120;         // 조절 가능(그리드·스냅·룰러에 반영). 곡 로드 시 자동 감지
let _gridOffset = 0;    // 마디 위상(초) — 첫 다운비트에 그리드 정렬
let _beats = [];        // 감지된 실제 비트 시각(초, 스템 로컬) — 참고용 저장
let _detBpm = 0;        // 감지 당시 BPM(반올림) — ÷2/×2 보정 시 클릭 간격 조정 기준
let _beatInterval = 0;  // 감지된 정밀 박 간격(초) — 메트로놈 균일 그리드용
const secPerBar = () => BEATS_PER_BAR * 60 / _bpm;
const secPerBeat = () => 60 / _bpm;
let _metroOn = false;
let _metroBake = false, _metroBeats = 4, _metroSubdiv = 1;   // 메트로놈도 녹음 / 박자표(마디당 박 수) / 세분화(박당 클릭 수, 1=없음)
function pushMetroExtra() {   // metro()와 별개 커맨드라 따로 보낸다 — 엔진 재시작 시에도 다시 밀어 넣어야 한다
  api.engine.metroBake(_metroBake);
  api.engine.metroPattern(_metroBeats, _metroSubdiv);
}
// 엔진에 지금 BPM·그리드 위상을 다시 밀어 넣는다 — bpm/그리드가 바뀔 때, 그리고 엔진이
// 새로 켜졌을 때(장치 재연결 등으로 프로세스가 새로 뜨면 엔진 쪽 메트로놈 상태는 기억 못 한다)
// 매번 호출한다. 켜져 있지 않아도 보낸다 — on=false 로 엔진 쪽을 확실히 꺼 둔다.
function updateMetro() {
  api.engine.metro(_metroOn, _bpm, secToSamples(_gridOffset), _beatInterval > 0 ? secToSamples(_beatInterval) : 0);
}
// 그리드 스냅 — 위상(_gridOffset) 기준 1/4박(16분음표) 격자에 5px 이내면 스냅.
// 그 밖은 연속(픽셀 단위) 이동 → 세밀 배치 가능. Alt 누르면 스냅 완전 해제.
function snapSec(sec, disable) {
  if (disable) return Math.max(0, sec);
  const g = secPerBeat() / 4;   // 16분음표 격자(촘촘)
  const near = _gridOffset + Math.round((sec - _gridOffset) / g) * g;
  return Math.abs(near - sec) * _pxPerSec <= 5 ? Math.max(0, near) : Math.max(0, sec);
}
// 툴바 자석 버튼 상태(_magnetOn)에 Alt 를 곱해 그 드래그 한 번만 뒤집는다 — 평소 켜져
// 있으면 Alt 로 잠깐 끄고, 버튼으로 꺼 뒀으면 Alt 로 잠깐 켠다(그래야 버튼이 늘 최신을
// 반영하면서도 Alt 단축키가 여전히 "순간 반대로" 라는 익숙한 의미를 유지한다).
function magnetActiveFor(ev) { return _magnetOn !== !!(ev && ev.altKey); }
// 클립 마그넷 — 이동 중인 클립의 시작/끝이 다른 클립(트랙 안 가리고 전부)의 시작/끝에
// 가까우면 거기 붙는다. 격자 스냅과 같은 5px 문턱. 격자보다 우선한다 — 사용자가 실제로
// 맞추려는 대상은 대개 옆 클립이지 그리드가 아니다. 반환값의 edgeAt 은 내 경계와 상대
// 경계가 겹치는 절대 시각 — 스냅선(showSnapLine)을 그 자리에 그리는 데 쓴다.
function snapClipStart(startCandidate, dur, excludeIds) {
  const endCandidate = startCandidate + dur;
  let bestStart = null, bestEdge = null, bestPx = 5;
  for (const t of _takes) {
    if (excludeIds.has(t.id)) continue;
    for (const edge of [t.start, t.start + t.dur]) {
      const dStart = Math.abs(startCandidate - edge) * _pxPerSec;
      if (dStart < bestPx) { bestPx = dStart; bestStart = edge; bestEdge = edge; }
      const dEnd = Math.abs(endCandidate - edge) * _pxPerSec;
      if (dEnd < bestPx) { bestPx = dEnd; bestStart = edge - dur; bestEdge = edge; }
    }
  }
  return bestStart != null ? { start: bestStart, edgeAt: bestEdge } : null;
}
// 오류 제보에 붙일 스튜디오 상태 — 파일 경로·곡 제목 같은 개인 정보는 담지 않는다
export function studioDiagnostics() {
  return {
    engineRunning: !!_started,
    device: _deviceInfo,
    pdc: { on: _pdcOn, ms: Number(_pdcMs.toFixed(1)) },
    stemTracks: _tracks.length,
    recTracks: _recTracks.length,
    clips: _takes.length,
    fxSlots: Object.values(_chainByTrack || {}).reduce((n, a) => n + (a ? a.length : 0), 0),
    automationLanes: [..._auto.values()].filter(a => a.pts.length).length,
    bpm: _bpm,
    playing: _playing,
    recArmed: _recArmed,
    zoomPxPerSec: Math.round(_pxPerSec),
  };
}

// ── 볼륨 자동화 ───────────────────────────────────────────
// selId(스템 90001+ / 녹음 트랙 id) → { on, open, pts:[{t:초, v:게인}] }
// 레인의 상·하한과 세로 배치는 페이더 테이퍼(faderToGain/gainToFader)가 그대로 정한다.
const AUTO_LANE_H = 46;        // 자동화 레인 높이(px)
let _auto = new Map();
function autoOf(id) {
  let a = _auto.get(id);
  if (!a) { a = { on: false, open: false, pts: [] }; _auto.set(id, a); }
  return a;
}
function autoPush(id) {   // 엔진에 현재 곡선·on 상태 전송
  const a = autoOf(id), sr = deviceSr();
  api.engine.automation(id, { on: !!a.on, points: a.pts.map(p => ({ s: Math.round(p.t * sr), v: p.v })) });
}
// ── 스템 자동화 ↔ 스템 오프셋 연동 ────────────────────────
// 스템 클립을 가로로 옮기면 볼륨 곡선도 같은 만큼 따라 움직여야 한다.
function snapshotStemAuto() {
  const snap = new Map();
  _tracks.forEach(t => {
    const id = stemIdOf(t.engineIndex);
    snap.set(id, autoOf(id).pts.map(p => ({ t: p.t, v: p.v })));
  });
  return snap;
}
function shiftStemAuto(baseSnap, delta) {
  baseSnap.forEach((pts, id) => {
    if (!pts.length) return;
    autoOf(id).pts = pts.map(p => ({ t: Math.max(0, p.t + delta), v: p.v }));
    renderAutoLane(id);
  });
}
function restoreStemAuto(snap) {
  snap.forEach((pts, id) => {
    autoOf(id).pts = pts.map(p => ({ t: p.t, v: p.v }));
    autoPush(id); renderAutoLane(id);
  });
}
function pushStemAuto() {
  _tracks.forEach(t => autoPush(stemIdOf(t.engineIndex)));
}

function autoValueAt(pts, t) {
  if (!pts.length) return 1;
  if (t <= pts[0].t) return pts[0].v;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m].t <= t) lo = m; else hi = m; }
  const a = pts[lo], b = pts[hi];
  return b.t <= a.t ? b.v : a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
}
let _pdcOn = true;     // 플러그인 지연 보정 on/off (엔진 통지로 동기)
let _deviceInfo = null;  // 오류 제보용 오디오 장치 정보
let _pdcMs = 0;
let _stemOffset = 0;   // 스템 전체 오프셋(초)
let _recTracks = [];   // 녹음 트랙 목록(엔진 동기) [{id,gain,mute,solo,armed}]
let _recTracksGen = 0, _recTracksGenReq = 0;   // 트랙 재구성 동기화 토큰
let _recTracksWaiters = [];   // waitRecTracks() 대기자 — recTracks 이벤트가 오면 폴링 없이 바로 깨운다
let _exporting = false, _exportMp3 = null, _exportTmp = null;   // export 진행 상태
// 녹음 대상 = 녹음(type 0) 트랙만
// 악기 트랙(type 2)은 오디오 녹음·임포트 대상이 아니다 — 파일이 아니라 노트를 녹음한다(armedMidiIds).
const isAudioRecTrack = (r) => (r.type || 0) === 0;
const armedRecId = () => (_recTracks.find(r => r.armed && isAudioRecTrack(r)) || _recTracks.find(isAudioRecTrack) || {}).id;
// 실제 녹음 시작 시 "어느 트랙들에 파일을 열지" 결정할 때만 쓴다(복수) — 임포트 대상 트랙
// 고르기 등 "대표 트랙 하나"가 필요한 나머지 자리는 전부 armedRecId() 그대로 쓴다(여러 곳에서
// 이미 그 의미로 쓰이고 있어 반환 타입을 바꾸면 다 깨진다 — 그래서 별도 헬퍼로 뺐다).
const armedRecIds = () => _recTracks.filter(r => r.armed && isAudioRecTrack(r)).map(r => r.id);
const armedMidiIds = () => _recTracks.filter(r => r.armed && r.type === 2).map(r => r.id);
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
  const left = (_stemOffset * _pxPerSec) + 'px';
  document.querySelectorAll('.daw-lane:not(.daw-lane-rec) .daw-clip').forEach(c => {
    c.style.left = left; c.style.width = w + 'px'; c.style.right = 'auto';
  });
  // 이름 배지(.daw-lane-namebar)는 클립과 별개 요소(형제)라 클립만 옮기면 제자리에
  // 남는다 — 드래그로 스템을 밀어도 이름은 안 따라간다는 제보. 클립과 같은 left/width 를
  // 그대로 줘서 같이 움직이게 한다(CSS 기본값 left:0;right:0 을 덮어써야 하니 right도 auto로).
  document.querySelectorAll('.daw-lane:not(.daw-lane-rec) .daw-lane-namebar').forEach(nb => {
    nb.style.left = left; nb.style.width = w + 'px'; nb.style.right = 'auto';
  });
}
// 트랙 빈 곳 클릭+유지 = 재생선 스크럽 (재생 위치 이동)
// 화면 x → 재생선 이동
function seekToClientX(cx) {
  const rect = $('daw-lanes').getBoundingClientRect();
  const t = Math.max(0, Math.min(fullSec(), (cx - rect.left - HEAD_W) / _pxPerSec));
  api.engine.seek(secToSamples(t)); syncVideo(t); updatePlayhead(t);
}
// 룰러/트랙 빈 곳 클릭·드래그 = 재생선 따라오기(스크럽). 좌우 스크롤은 휠
function grabPan(e) {
  if (e.button !== 0) return;   // 우클릭·가운데클릭은 재생선 이동 안 함 (컨텍스트 메뉴용)
  if (_recArmed) return;   // 녹음 중 재생위치 이동 금지
  clearClipSelection();    // 빈 곳 클릭 = 클립 선택 해제
  seekToClientX(e.clientX);
  const mv = (ev) => seekToClientX(ev.clientX);
  const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up); };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
}
const contentW = () => Math.max(1, _dur * _pxPerSec);

// ── 파형 해상도 ───────────────────────────────────
// 예전엔 클립 하나당 고정 1400개 점으로 그려서, 확대해도 그 점을 SVG 가 넓게 늘려 보여줄
// 뿐 실제로는 안 뜯렸다(막힌 폴리곤이 뭉개져 보이는 이유). 화면에 실제로 차지하는
// 픽셀 수에 맞춰 다시 그리면 확대할수록 그 안에 있던 디테일이 진짜로 드러난다.
const waveN = (durationSec) => Math.max(300, Math.min(8000, Math.round(Math.max(1, durationSec) * _pxPerSec)));
let _stemBuffers = null;   // renderWaves 가 마지막으로 받은 채널 버퍼 — 확대 시 다시 그리려고 들고 있는다
let _waveZoomAt = 0;       // 스템 파형을 마지막으로 그린 _pxPerSec — 바뀌었을 때만 다시 그린다

// ── 파형 SVG ──────────────────────────────────────

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
    const gPos = gainToFader(t.gain != null ? t.gain : 1);
    const p100 = Math.round((t.pan != null ? t.pan : 0) * 100);
    lane.innerHTML = `
      <div class="daw-head" title="${tr('studio.t.editStem')}">
        <div class="nm"><i></i><span class="lbl-t">${t.label}</span>
          <button class="daw-autotog${autoOf(stemIdOf(t.engineIndex)).open ? ' on' : ''}" title="${tr('studio.t.autoLane')}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11.5 5.5 7l3 2.5L14 4"/></svg>
          </button>
        </div>
        <div class="ctrls">
          <div class="daw-btn-grp">
            <button class="daw-ms${t.mute ? ' on' : ''}" data-m="mute" title="${tr('studio.t.mute')}" aria-pressed="${!!t.mute}">M</button>
            <button class="daw-ms${t.solo ? ' on' : ''}" data-m="solo" title="${tr('studio.t.solo')}" aria-pressed="${!!t.solo}">S</button>
          </div>
          <input class="daw-vol" type="range" min="0" max="${FADER_POS}" value="${gPos}" title="${tr('studio.t.volume')}">
        </div>
        <div class="daw-pan-row">
          <span class="lbl">PAN</span>
          <input class="daw-pan${p100 === 0 ? ' off' : ''}" type="range" min="-100" max="100" value="${p100}" title="${tr('studio.t.pan')}">
          <div class="daw-meter" data-mid="${stemIdOf(t.engineIndex)}"><i class="l"></i><i class="r"></i></div>
        </div>
      </div>
      <div class="daw-area-wrap">
        <div class="daw-area"><div class="daw-clip"></div></div>
        <div class="daw-lane-namebar"><div class="daw-lane-name">${esc(t.label)}</div></div>
      </div>`;
    lane.querySelector('.daw-head').addEventListener('pointerdown', () => selectTrack(stemIdOf(t.engineIndex)));
    const mBtn = lane.querySelector('[data-m="mute"]');
    const sBtn = lane.querySelector('[data-m="solo"]');
    const vol = lane.querySelector('.daw-vol');
    const pan = lane.querySelector('.daw-pan');
    mBtn.addEventListener('click', () => { const on = mBtn.classList.toggle('on'); mBtn.setAttribute('aria-pressed', String(on)); t.mute = on; api.engine.track(t.engineIndex, { mute: on }); markDirty(); });
    sBtn.addEventListener('click', () => { const on = sBtn.classList.toggle('on'); sBtn.setAttribute('aria-pressed', String(on)); t.solo = on; api.engine.track(t.engineIndex, { solo: on }); updateSoloDim(); markDirty(); });
    vol.addEventListener('input', () => {
      t.gain = faderToGain(vol.value); api.engine.track(t.engineIndex, { gain: stemGainOut(t) }); markDirty();
      if (stemIdOf(t.engineIndex) === _selTrack) { $('mx-track').value = vol.value; $('mx-track-val').textContent = dbText(t.gain); }   // 믹서 동기화
    });
    vol.addEventListener('dblclick', (e) => { e.stopPropagation(); vol.value = FADER_UNITY_POS; vol.dispatchEvent(new Event('input')); });
    pan.addEventListener('input', (e) => { e.stopPropagation(); const v = Number(pan.value); t.pan = v / 100; pan.classList.toggle('off', v === 0); api.engine.track(t.engineIndex, { pan: t.pan }); markDirty(); });
    pan.addEventListener('dblclick', (e) => { e.stopPropagation(); pan.value = 0; pan.classList.add('off'); t.pan = 0; api.engine.track(t.engineIndex, { pan: 0 }); markDirty(); });
    const atog = lane.querySelector('.daw-autotog');
    atog.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAutoLane(stemIdOf(t.engineIndex), t.label, t.color, lane, atog);
    });
    // 스템 클립 드래그 = 스템 전체 오프셋 (묶음 이동)
    const clip = lane.querySelector('.daw-clip');
    clip.addEventListener('click', (e) => e.stopPropagation());
    clip.addEventListener('pointerdown', (e) => {
      const base = _stemOffset;
      const autoBase = snapshotStemAuto();   // 자동화 곡선도 스템과 같이 움직인다
      dragClip(e, (dSec, cx, cy) => {
        _stemOffset = snapSec(base + dSec, !magnetActiveFor(e)); repositionStems();   // 0:00 뒤로 못 감 + 그리드 스냅
        shiftStemAuto(autoBase, _stemOffset - base);
        showDragBadge(_stemOffset - base, cx, cy);
      }, (moved) => {
        hideDragBadge(); api.engine.stemOffset(secToSamples(_stemOffset));
        if (moved && _stemOffset !== base) {
          const nw = _stemOffset;
          pushStemAuto();   // 이동 끝난 곡선을 엔진에 반영
          const autoAfter = snapshotStemAuto();
          pushUndo(() => { setStemOffset(base); restoreStemAuto(autoBase); },
                   () => { setStemOffset(nw);   restoreStemAuto(autoAfter); }, tr('studio.u.stemOffset'));
          markDirty();
        }
      });
    });
    lanes.appendChild(lane);
    const sid = stemIdOf(t.engineIndex);
    if (autoOf(sid).open) lanes.appendChild(buildAutoLane(sid, t.label, t.color));
  });
  renderRecLanes();
}

// 내 녹음 트랙 레인(여러 개) — 스템 레인은 건드리지 않음(파형 보존)
function renderRecLanes() {
  const lanes = $('daw-lanes');
  lanes.querySelectorAll('.daw-lane-rec, .daw-addrec-row, .daw-lanes-spacer').forEach(el => el.remove());
  // 녹음 트랙에 붙은 자동화 레인도 함께 제거(스템 레인의 것은 보존)
  lanes.querySelectorAll('.daw-auto-row').forEach(el => {
    const id = Number(el.dataset.autoid);
    if (!isStemId(id)) el.remove();
  });
  let recN = 0, audN = 0, insN = 0;
  _recTracks.forEach((rt, idx) => {
    const isAudio = rt.type === 1;
    const isInstr = rt.type === 2;
    const autoLabel = isAudio ? tr('studio.p.audioN', { n: ++audN }) : isInstr ? tr('studio.midi.instrN', { n: ++insN }) : tr('studio.p.recN', { n: ++recN });
    const label = rt.name || autoLabel;
    const defColor = isAudio ? 'var(--stem-bass)' : 'var(--accent)';
    const lane = document.createElement('div');
    lane.className = 'daw-lane daw-lane-rec' + (isAudio ? ' daw-lane-audio' : '') + (isInstr ? ' daw-lane-instr' : '');
    lane.style.setProperty('--c', rt.color || defColor);
    if (rt.height) lane.style.height = rt.height + 'px';
    lane.dataset.key = 'rec-' + rt.id;
    lane.dataset.recid = rt.id;
    lane.dataset.selid = rt.id;
    lane.dataset.type = isAudio ? 'audio' : isInstr ? 'instr' : 'rec';
    const rBtnHtml = isAudio ? '' : `<button class="daw-ms daw-rec-arm${rt.armed ? ' armed' : ''}" data-m="arm" title="${tr('studio.t.arm')}" aria-pressed="${!!rt.armed}">R</button>`;
    // 이 트랙의 입력 채널 배지 — 여러 트랙을 동시에 arm 해서 각자 다른 인풋으로 녹음할 때
    // (실사용 문의: 인풋1/인풋2 동시 녹음) 트랙마다 따로 지정할 수 있게. 오디오(임포트) 트랙은
    // 녹음 대상이 아니라 입력 채널 자체가 의미 없다.
    const inLabel = rt.inMode === 1 ? `${(rt.inChL ?? 0) + 1}/${(rt.inChR ?? 1) + 1}` : `${(rt.inChL ?? 0) + 1}`;
    // 악기 트랙은 입력 채널 대신 "키보드로 연주" 토글 — 켜면 타이핑 키보드가 이 트랙의 건반이 된다
    const inBtnHtml = isAudio ? '' : isInstr
      ? `<button class="daw-ms daw-kb-btn${_kbOn && kbTargetTrack()?.id === rt.id ? ' on' : ''}" data-m="kb" title="${tr('studio.midi.kbTitle')}" aria-pressed="${_kbOn && kbTargetTrack()?.id === rt.id}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8.5" rx="1.5"/><path d="M4 6.8h.01M6.3 6.8h.01M8.6 6.8h.01M10.9 6.8h.01M5 10h6"/></svg></button>`
      : `<button class="daw-ms daw-rec-in" data-m="in" title="${tr('studio.lbl.inputChannel')}">IN ${inLabel}</button>`;
    const rp100 = Math.round((rt.pan != null ? rt.pan : 0) * 100);
    lane.innerHTML = `
      <div class="daw-head" title="${tr('studio.t.editTrackFx')}">
        <div class="nm"><span class="daw-reorder" title="${tr('studio.t.dragReorder2')}">⠿</span><i title="${tr('studio.t.changeColor')}"></i><span class="lbl" title="${tr('studio.t.dblRename')}">${esc(label)}</span>
          <button class="daw-autotog${autoOf(rt.id).open ? ' on' : ''}" title="${tr('studio.t.autoLane')}">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 11.5 5.5 7l3 2.5L14 4"/></svg>
          </button>
        </div>
        <div class="ctrls">
          <div class="daw-btn-grp">
            ${rBtnHtml}
            ${inBtnHtml}
            <button class="daw-ms${rt.mute ? ' on' : ''}" data-m="mute" title="${tr('studio.t.mute')}" aria-pressed="${!!rt.mute}">M</button>
            <button class="daw-ms${rt.solo ? ' on' : ''}" data-m="solo" title="${tr('studio.t.solo')}" aria-pressed="${!!rt.solo}">S</button>
          </div>
          <input class="daw-vol" type="range" min="0" max="${FADER_POS}" value="${gainToFader(rt.gain != null ? rt.gain : 1)}" title="${tr('studio.t.volume')}">
          <button class="daw-ms daw-rec-del" data-m="del" title="${tr('studio.t.deleteTrack')}">✕</button>
        </div>
        <div class="daw-pan-row">
          <span class="lbl">PAN</span>
          <input class="daw-pan${rp100 === 0 ? ' off' : ''}" type="range" min="-100" max="100" value="${rp100}" title="${tr('studio.t.pan')}">
          <div class="daw-meter" data-mid="${rt.id}"><i class="l"></i><i class="r"></i></div>
        </div>
      </div>
      <div class="daw-area"></div>
      <div class="daw-lane-resize" title="${tr('studio.t.dragResize')}"></div>`;
    const rBtn = lane.querySelector('[data-m="arm"]');
    const inBtn = lane.querySelector('[data-m="in"]');
    const mBtn = lane.querySelector('[data-m="mute"]');
    const sBtn = lane.querySelector('[data-m="solo"]');
    const vol = lane.querySelector('.daw-vol');
    const pan = lane.querySelector('.daw-pan');
    const del = lane.querySelector('[data-m="del"]');
    // 헤드 클릭 = 트랙 선택 (버튼/슬라이더 조작은 각자 처리, 그래도 선택은 됨)
    lane.querySelector('.daw-head').addEventListener('pointerdown', () => selectTrack(rt.id));
    if (rBtn) rBtn.addEventListener('click', (e) => {   // R = 이 트랙을 녹음 대상으로 토글(arm) — 여러 트랙 동시 가능. 녹음 시작은 ● 또는 R키
      e.stopPropagation();
      selectTrack(rt.id);
      api.engine.recArm(rt.id);
    });
    // 악기 트랙 빈 곳 우클릭 = 빈 MIDI 클립(그 마디에 1마디짜리) — 만들고 바로 피아노롤로
    if (isInstr) {
      const areaEl = lane.querySelector('.daw-area');
      areaEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('.daw-take-clip')) return;
        e.preventDefault(); e.stopPropagation();
        const sec = Math.max(0, (e.clientX - areaEl.getBoundingClientRect().left) / _pxPerSec);
        openDropdownAt(e.clientX, e.clientY, [{ label: tr('studio.midi.addEmptyClip'), fn: () => addEmptyMidiClip(rt.id, sec) }]);
      });
    }
    const kbBtn = lane.querySelector('[data-m="kb"]');
    if (kbBtn) kbBtn.addEventListener('click', (e) => {   // ⌨ = 이 악기 트랙을 타이핑 키보드로 연주
      e.stopPropagation();
      const already = _kbOn && kbTargetTrack()?.id === rt.id;
      selectTrack(rt.id);
      setKbMode(!already);
    });
    if (inBtn) inBtn.addEventListener('click', (e) => {   // IN = 이 트랙만의 입력 채널(모노/스테레오+번호) 지정
      e.stopPropagation();
      selectTrack(rt.id);
      openTrackInputPopoverAt(rt, e.clientX, e.clientY);
    });
    mBtn.addEventListener('click', (e) => { e.stopPropagation(); const on = mBtn.classList.toggle('on'); mBtn.setAttribute('aria-pressed', String(on)); rt.mute = on; api.engine.recTrack(rt.id, { mute: on }); });
    sBtn.addEventListener('click', (e) => { e.stopPropagation(); const on = sBtn.classList.toggle('on'); sBtn.setAttribute('aria-pressed', String(on)); rt.solo = on; api.engine.recTrack(rt.id, { solo: on }); updateSoloDim(); });
    vol.addEventListener('input', () => {
      rt.gain = faderToGain(vol.value); api.engine.recTrack(rt.id, { gain: rt.gain });
      if (rt.id === _selTrack) { $('mx-track').value = vol.value; $('mx-track-val').textContent = dbText(rt.gain); }   // 믹서 동기화
    });
    vol.addEventListener('dblclick', (e) => { e.stopPropagation(); vol.value = FADER_UNITY_POS; vol.dispatchEvent(new Event('input')); });
    pan.addEventListener('input', (e) => { e.stopPropagation(); const v = Number(pan.value); rt.pan = v / 100; pan.classList.toggle('off', v === 0); api.engine.recTrack(rt.id, { pan: rt.pan }); markDirty(); });
    pan.addEventListener('dblclick', (e) => { e.stopPropagation(); pan.value = 0; pan.classList.add('off'); rt.pan = 0; api.engine.recTrack(rt.id, { pan: 0 }); markDirty(); });
    const atogR = lane.querySelector('.daw-autotog');
    atogR.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleAutoLane(rt.id, label, rt.color || defColor, lane, atogR);
    });
    // 삭제: 녹음이 있는 트랙은 2단계 확인 (실수 방지)
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const takesN = _takes.filter(t => t.trackId === rt.id).length + _midiClips.filter(c => c.trackId === rt.id).length;
      if (del.dataset.confirm || takesN === 0) { clearTimeout(del._t); api.engine.recTrackRemove(rt.id); return; }
      del.dataset.confirm = '1'; del.textContent = '‼'; del.classList.add('confirm');
      flashTake(tr('studio.p.delTrackWithTakes', { n: takesN }));
      del._t = setTimeout(() => { del.dataset.confirm = ''; del.textContent = '✕'; del.classList.remove('confirm'); }, 2500);
    });
    // 이름 변경 — 라벨 더블클릭 · 우클릭 메뉴 (autoLabel 기억)
    const lbl = lane.querySelector('.lbl');
    lbl.dataset.auto = autoLabel;
    lbl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRenameTrack(rt.id); });
    lane.querySelector('.daw-head').addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation(); selectTrack(rt.id);
      openDropdownAt(e.clientX, e.clientY, [
        { label: tr('studio.lbl.rename'), fn: () => startRenameTrack(rt.id) },
        { label: tr('studio.lbl.changeColor'), fn: () => lane.querySelector('.nm i').click() },
        { label: tr('studio.lbl.addRecTrack'), fn: () => api.engine.recTrackAdd(0, 'studio') },
        { label: tr('studio.midi.addInstr'), fn: () => api.engine.recTrackAdd(2, 'studio') },
        { label: tr('studio.lbl.deleteTrack'), fn: () => del.click() },
      ]);
    });
    // 색 변경 — 점 클릭 → 색상 선택기
    const dot = lane.querySelector('.nm i');
    dot.addEventListener('click', (e) => {
      e.stopPropagation();
      const ci = document.createElement('input');
      ci.type = 'color'; ci.value = rt.color ? rgbToHex(resolveColor(rt.color)) : rgbToHex(resolveColor(defColor));
      // 화면 밖(-9999px)에 두면 네이티브 색상 선택기도 그 근처(대개 화면 좌상단)에서 뜬다 —
      // 실제로 누른 점 위치에 숨겨 둬서 선택기가 거기서 뜨게 한다(안 보이긴 마찬가지, opacity:0).
      const dr = dot.getBoundingClientRect();
      ci.style.cssText = `position:fixed; left:${dr.left}px; top:${dr.top}px; width:${dr.width}px; height:${dr.height}px; opacity:0; pointer-events:none;`;
      document.body.appendChild(ci);
      void ci.offsetHeight;   // 강제로 레이아웃 확정 — 안 하면 click() 이 아직 배치 전 위치로 선택기를 띄운다
      const oldColor = rt.color || '';
      ci.addEventListener('input', () => {
        rt.color = ci.value; lane.style.setProperty('--c', ci.value);
        // 이 트랙 take 들의 파형 색도 같이 — waveColor/캐싱된 svg 그대로면 옛 색으로 남는다
        // (트랙 이동 때랑 같은 이유·같은 버그, 여긴 "이동"이 아니라 "색 변경"이라 또 새로 남).
        const nc = resolveColor(ci.value);
        for (const tk of _takes) if (tk.trackId === rt.id) { tk.waveColor = nc; tk.svg = null; }
        renderTakes();
      });
      ci.addEventListener('change', () => { const nw = rt.color; ci.remove(); if (nw !== oldColor) pushUndo(() => setTrackProp(rt.id, 'color', oldColor), () => setTrackProp(rt.id, 'color', nw), tr('studio.u.trackColor')); });
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
        if (nw !== oldH) pushUndo(() => setTrackProp(rt.id, 'height', oldH), () => setTrackProp(rt.id, 'height', nw), tr('studio.u.trackHeight'));
      };
      document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
    });
    // 순서 변경 — 그립 드래그로 리오더
    const reorder = lane.querySelector('.daw-reorder');
    reorder.addEventListener('pointerdown', (e) => wireReorder(e, rt, lane));
    lanes.appendChild(lane);
    if (autoOf(rt.id).open) lanes.appendChild(buildAutoLane(rt.id, label, rt.color || defColor));
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
  if (isBusId(id)) return tr('studio.p.busN', { n: BUS_NAMES[busIndexOf(id)] });
  if (isStemId(id)) { const t = stemForId(id); return t ? t.label : tr('studio.lbl.track'); }
  return document.querySelector(`.daw-lane-rec[data-recid="${id}"] .lbl`)?.textContent?.trim() || tr('studio.lbl.track');
}
function selTrackGain(id) { const o = selTrackObj(id); return o && o.gain != null ? o.gain : 1; }
function applySelTrackGain(id, g) {   // 볼륨 라우팅 — 스템=track(index), 녹음=recTrack(id)
  const o = selTrackObj(id); if (o) o.gain = g;
  if (isStemId(id)) api.engine.track(id - STEM_ID_BASE, { gain: g * _stemGroupGain });
  else api.engine.recTrack(id, { gain: g });
  markDirty();
}
// ── 센드 버스 A/B ─────────────────────────────────────────
// 엔진과 개수·id 를 맞춘다(Main.cpp 의 kNumBuses / kBusIdBase).
const BUS_ID_BASE = 95001;
const BUS_COUNT = 2;
const isBusId = (id) => id != null && id >= BUS_ID_BASE && id < BUS_ID_BASE + BUS_COUNT;
const busIndexOf = (id) => id - BUS_ID_BASE;
const BUS_NAMES = ['A', 'B'];
let _buses = [{ gain: 1, mute: false }, { gain: 1, mute: false }];
let _prevTrackSel = null;     // 버스를 편집하기 직전에 보고 있던 트랙 — 라벨 재클릭 시 복귀 대상
// 트랙의 센드량은 트랙 객체(sends:[a,b])에 둔다. 없으면 0.
const sendsOf = (o) => (o && Array.isArray(o.sends) ? o.sends : [0, 0]);
function pushSends(id, sends) {
  if (isStemId(id)) api.engine.track(id - STEM_ID_BASE, { sends });
  else api.engine.recTrack(id, { sends });
}

function selValid(id) {
  return id != null && (isBusId(id) || _recTracks.some(r => r.id === id) || stemForId(id) != null);
}
// 프로젝트의 버스 상태를 엔진·UI 에 반영. 항목이 없으면 기본값(0 dB, 뮤트 해제, FX 비움).
function applyBusState(list) {
  for (let i = 0; i < BUS_COUNT; i++) {
    const b = list[i] || {};
    const gain = b.gain != null ? b.gain : 1;
    _buses[i] = { gain, mute: !!b.mute };
    api.engine.bus(i, { gain, mute: !!b.mute });
    api.engine.fxSetChain(BUS_ID_BASE + i, (Array.isArray(b.fx) ? b.fx : []).map(s => ({ index: s.index, bypass: s.bypass, data: s.data })));
    const n = BUS_NAMES[i];
    const f = $(`mx-bus${n}`); if (f) f.value = gainToFader(gain);
    const v = $(`mx-bus${n}-val`); if (v) v.textContent = dbText(gain);
  }
}
function selectTrack(id) {
  if (!selValid(id)) id = null;
  _selTrack = id;
  if (id != null) { _chain = _chainByTrack[id] || []; api.engine.fxChainReq(id); }
  else _chain = [];
  syncSelection();
  renderFxSlots();
  updateFxPanel();
  updateKbButtons();
}
function syncSelection() {   // 재렌더 후 선택 하이라이트 재적용 (data-selid: 녹음=id, 스템=stemId)
  if (!selValid(_selTrack)) _selTrack = null;
  document.querySelectorAll('.daw-lane').forEach(l =>
    l.classList.toggle('selected', l.dataset.selid != null && Number(l.dataset.selid) === _selTrack));
}
// 버스는 트랙과 달리 '선택' 개념이 없다. 대신 보낼 트랙이 하나도 없으면 의미가 없으므로
// 그때만 잠근다. 트랙이 있으면 어떤 트랙을 선택했든 버스는 항상 만질 수 있다(믹서 채널이므로).
function updateBusStrips() {
  const hasTracks = _tracks.length > 0 || _recTracks.length > 0;
  for (let i = 0; i < BUS_COUNT; i++) {
    const n = BUS_NAMES[i];
    const f = $(`mx-bus${n}`); if (f) f.disabled = !hasTracks;
    const lb = $(`mx-bus${n}-lbl`); if (lb) lb.disabled = !hasTracks;
  }
  if (!hasTracks && isBusId(_selTrack)) selectTrack(null);   // 트랙이 사라졌는데 버스 FX 편집 중이면 해제
}
function updateFxPanel() {   // 선택된 트랙 있을 때만 이펙트 표시
  const left = document.querySelector('.daw-left');
  if (!left) return;
  const has = _selTrack != null;
  left.classList.toggle('empty', !has);
  // 버스는 레인이 없어 어느 트랙도 선택 표시가 안 뜬다 → 패널 자체로 대상을 알린다
  left.classList.toggle('bus-edit', isBusId(_selTrack));
  const h = $('daw-left-h');
  if (h) h.textContent = has ? tr('studio.p.trackFx', { name: selTrackLabel(_selTrack) }) : tr('studio.lbl.inputFx');
  updateTrackFader();
}
// 믹서 페이더 왼쪽 dB 눈금자. 눈금 위치는 CSS 가 아니라 테이퍼가 정한다 —
// 상수를 바꾸면 눈금도 같이 따라오도록 gainToFader 로 계산해서 --at(0~1) 로 넘긴다.
const FADER_SCALE_DB = [10, 0, -6, -12, -24, -40];
function buildFaderScales() {
  for (const sc of document.querySelectorAll('.mx-scale')) {
    if (sc.childElementCount) continue;
    sc.innerHTML = FADER_SCALE_DB.map(db => {
      const at = gainToFader(Math.pow(10, db / 20)) / FADER_POS;
      const label = db === 0 ? '0' : (db > 0 ? `+${db}` : String(db));
      return `<i class="${db === 0 ? 'unity' : ''}" style="--at:${at.toFixed(4)}"><b>${label}</b></i>`;
    }).join('');
  }
}
// 선택 트랙의 센드 슬라이더 2개 갱신. 트랙이 아닌 대상(버스/없음)이면 잠근다.
function updateSendRows() {
  const o = (!isBusId(_selTrack) && selValid(_selTrack)) ? selTrackObj(_selTrack) : null;
  const sv = sendsOf(o);
  for (let i = 0; i < BUS_COUNT; i++) {
    const key = BUS_NAMES[i].toLowerCase();
    const sl = $(`mx-send-${key}`), lb = $(`mx-send-${key}-val`);
    if (!sl) continue;
    sl.disabled = !o;
    sl.value = Math.round((o ? sv[i] : 0) * 100);
    if (lb) lb.textContent = sl.value;
  }
}
function updateTrackFader() {   // 믹서 우측 = 선택 트랙 볼륨
  updateSendRows();
  const f = $('mx-track'), val = $('mx-track-val'), lbl = $('mx-track-lbl'); if (!f) return;
  // 버스를 선택했을 땐 버스 전용 스트립이 따로 있으므로 트랙 페이더는 비활성
  if (isBusId(_selTrack)) {
    f.disabled = true; f.value = FADER_UNITY_POS; val.textContent = '—';
    lbl.textContent = selTrackLabel(_selTrack);
    for (let i = 0; i < BUS_COUNT; i++)
      $(`mx-bus${BUS_NAMES[i]}-lbl`)?.classList.toggle('on', busIndexOf(_selTrack) === i);
    return;
  }
  for (const n of BUS_NAMES) $(`mx-bus${n}-lbl`)?.classList.remove('on');
  if (selValid(_selTrack)) {
    const g = selTrackGain(_selTrack);
    f.disabled = false; f.value = gainToFader(g); val.textContent = dbText(g);
    lbl.textContent = selTrackLabel(_selTrack);
  } else { f.disabled = true; f.value = FADER_UNITY_POS; val.textContent = '—'; lbl.textContent = tr('studio.lbl.track'); }
}

// ── 자동화 레인 렌더 ──────────────────────────────────────
// 헤더(HEAD_W) + 그래프. 클릭=점 추가, 드래그=이동, 우클릭=삭제, 더블클릭(빈 곳)=점 추가
// 레인 열기/닫기 — 전체 재렌더 대신 DOM 직접 삽입·제거.
// (재렌더하면 스템 파형이 날아가고 스크롤이 맨 위로 튐)
function toggleAutoLane(selId, label, color, laneEl, btn) {
  const a = autoOf(selId);
  a.open = !a.open;
  if (btn) btn.classList.toggle('on', a.open);
  const existing = document.querySelector(`.daw-auto-row[data-autoid="${selId}"]`);
  if (a.open) {
    if (!existing) laneEl.insertAdjacentElement('afterend', buildAutoLane(selId, label, color));
  } else if (existing) {
    existing.remove();
  }
  layout();   // 폭·재생선·범위밴드만 갱신 (스크롤·파형 보존)
}

function buildAutoLane(selId, label, color) {
  const a = autoOf(selId);
  const row = document.createElement('div');
  row.className = 'daw-auto-row';
  row.dataset.autoid = selId;
  row.style.setProperty('--c', color);
  row.innerHTML = `
    <div class="daw-auto-head">
      <span class="lb">${tr('studio.x.volAuto')}</span>
      <button class="daw-auto-on${a.on ? ' on' : ''}" title="${tr('studio.t.autoOnOff')}">${a.on ? 'ON' : 'OFF'}</button>
      <button class="daw-auto-clr" title="${tr('studio.t.autoReset')}">${tr('studio.x.reset')}</button>
      <button class="daw-auto-close" title="${tr('studio.t.closeLane')}">✕</button>
    </div>
    <div class="daw-auto-area"><svg class="daw-auto-svg" preserveAspectRatio="none"></svg></div>`;
  const area = row.querySelector('.daw-auto-area');
  const svg = row.querySelector('.daw-auto-svg');

  row.querySelector('.daw-auto-on').addEventListener('click', (e) => {
    e.stopPropagation();
    const before = a.on;
    a.on = !a.on;
    autoPush(selId); renderAutoLane(selId);
    pushUndo(() => { autoOf(selId).on = before; autoPush(selId); renderAutoLane(selId); },
             () => { autoOf(selId).on = !before; autoPush(selId); renderAutoLane(selId); }, tr('studio.u.autoToggle'));
  });
  row.querySelector('.daw-auto-close').addEventListener('click', (e) => {
    e.stopPropagation();
    a.open = false;
    // 해당 트랙 헤드의 자동화 토글 버튼도 꺼진 상태로
    document.querySelectorAll('.daw-lane').forEach(l => {
      if (Number(l.dataset.selid) === selId) l.querySelector('.daw-autotog')?.classList.remove('on');
    });
    row.remove();
    layout();
  });
  row.querySelector('.daw-auto-clr').addEventListener('click', (e) => {
    e.stopPropagation();
    const before = a.pts.map(p => ({ ...p }));
    if (!before.length) return;
    a.pts = []; autoPush(selId); renderAutoLane(selId); markDirty();
    pushUndo(() => { autoOf(selId).pts = before.map(p => ({ ...p })); autoPush(selId); renderAutoLane(selId); },
             () => { autoOf(selId).pts = []; autoPush(selId); renderAutoLane(selId); }, tr('studio.u.autoClear'));
  });

  // 빈 곳 클릭 = 점 추가
  area.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (e.target.classList.contains('ap')) return;   // 점은 아래 핸들러가 처리
    e.stopPropagation();
    const r = area.getBoundingClientRect();
    const t = Math.max(0, (e.clientX - r.left) / _pxPerSec);
    const v = valFromY(e.clientY - r.top, r.height);
    const before = a.pts.map(p => ({ ...p }));
    a.pts.push({ t: snapSec(t, !magnetActiveFor(e)), v });
    a.pts.sort((x, y) => x.t - y.t);
    if (!a.on) { a.on = true; }   // 첫 점을 찍으면 자동으로 켬
    autoPush(selId); renderAutoLane(selId); markDirty();
    const after = a.pts.map(p => ({ ...p }));
    pushUndo(() => { const o = autoOf(selId); o.pts = before.map(p => ({ ...p })); autoPush(selId); renderAutoLane(selId); },
             () => { const o = autoOf(selId); o.pts = after.map(p => ({ ...p })); autoPush(selId); renderAutoLane(selId); }, tr('studio.u.autoAdd'));
  });
  area.addEventListener('contextmenu', (e) => e.preventDefault());

  renderAutoLaneInto(row, selId);
  return row;
}
// 레인 세로축도 페이더와 같은 dB 테이퍼. 선형이면 유니티가 바닥 근처(1/3.16 높이)로
// 내려앉아 대부분의 편집이 아래쪽에 뭉친다. 같은 함수를 쓰면 유니티가 항상 72% 높이.
const valFromY = (y, h) => faderToGain((1 - y / Math.max(1, h)) * FADER_POS);
const yFromVal = (v, h) => (1 - gainToFader(v) / FADER_POS) * h;

function renderAutoLane(selId) {
  const row = document.querySelector(`.daw-auto-row[data-autoid="${selId}"]`);
  if (row) renderAutoLaneInto(row, selId);
}
function renderAutoLaneInto(row, selId) {
  const a = autoOf(selId);
  const svg = row.querySelector('.daw-auto-svg');
  const area = row.querySelector('.daw-auto-area');
  const onBtn = row.querySelector('.daw-auto-on');
  if (onBtn) { onBtn.classList.toggle('on', !!a.on); onBtn.textContent = a.on ? 'ON' : 'OFF'; }
  row.classList.toggle('off', !a.on);

  const W = Math.max(1, timelineW()), H = AUTO_LANE_H - 2;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.style.width = W + 'px';
  const pts = a.pts;
  // 유니티(1.0) 기준선
  const unityY = yFromVal(1, H).toFixed(1);
  let g = `<line x1="0" y1="${unityY}" x2="${W}" y2="${unityY}" class="au-unity"/>`;
  if (pts.length) {
    const xs = pts.map(p => (p.t * _pxPerSec));
    const ys = pts.map(p => yFromVal(p.v, H));
    let d = `M0 ${ys[0].toFixed(1)}`;
    xs.forEach((x, i) => { d += ` L${x.toFixed(1)} ${ys[i].toFixed(1)}`; });
    d += ` L${W} ${ys[ys.length - 1].toFixed(1)}`;
    g += `<path class="au-fill" d="${d} L${W} ${H} L0 ${H} Z"/><path class="au-line" d="${d}"/>`;
    xs.forEach((x, i) => {
      g += `<circle class="ap" cx="${x.toFixed(1)}" cy="${ys[i].toFixed(1)}" r="4.5" data-i="${i}"/>`;
    });
  } else {
    g += `<text x="8" y="${(H / 2 + 3).toFixed(0)}" class="au-hint">${tr('studio.x.autoHint')}</text>`;
  }
  svg.innerHTML = g;

  // 점 드래그 / 우클릭 삭제
  svg.querySelectorAll('.ap').forEach((c) => {
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const i = Number(c.dataset.i);
      const before = a.pts.map(p => ({ ...p }));
      const r = area.getBoundingClientRect();
      const move = (ev) => {
        const t = Math.max(0, (ev.clientX - r.left) / _pxPerSec);
        a.pts[i].t = snapSec(t, !magnetActiveFor(ev));
        a.pts[i].v = valFromY(ev.clientY - r.top, r.height);
        a.pts.sort((x, y) => x.t - y.t);
        renderAutoLane(selId);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        autoPush(selId); markDirty();
        const after = a.pts.map(p => ({ ...p }));
        pushUndo(() => { const o = autoOf(selId); o.pts = before.map(p => ({ ...p })); autoPush(selId); renderAutoLane(selId); },
                 () => { const o = autoOf(selId); o.pts = after.map(p => ({ ...p })); autoPush(selId); renderAutoLane(selId); }, tr('studio.u.autoMove'));
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation();
      const i = Number(c.dataset.i);
      const before = a.pts.map(p => ({ ...p }));
      a.pts.splice(i, 1);
      autoPush(selId); renderAutoLane(selId); markDirty();
      const after = a.pts.map(p => ({ ...p }));
      pushUndo(() => { const o = autoOf(selId); o.pts = before.map(p => ({ ...p })); autoPush(selId); renderAutoLane(selId); },
               () => { const o = autoOf(selId); o.pts = after.map(p => ({ ...p })); autoPush(selId); renderAutoLane(selId); }, tr('studio.u.autoDelete'));
    });
  });
}

// ── 트랙 미터 (엔진 10Hz emit + 렌더러 rAF 감쇠) ──
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
// ── 영상 높이 조절 ────────────────────────────────────────────
// 곡마다 영상을 크게 보고 싶을 때와 트랙을 넓게 쓰고 싶을 때가 다르다.
// 높이는 px 로 기억한다 — vh 로 두면 창 크기를 바꿀 때마다 고른 값이 흔들린다.
const HERO_H_KEY = 'yss:studio-hero-h';
const HERO_MIN_H = 200;      // CSS 의 min-height 와 같은 값
// 타임라인이 남겨야 할 최소 높이. CSS 의 .daw-tracks min-height 와 같아야 한다 —
// 여기서 더 크게 잡으면 CSS 가 허용하는 것보다 먼저 막혀 영상을 덜 키우게 되고,
// 더 작게 잡으면 CSS 가 안 줄어들어 계산과 실제 크기가 어긋난다.
// 24px 룰러 + 트랙 한 줄이 보이는 높이.
const TRACKS_MIN_H = 120;

function heroMaxH() {
  const content = document.querySelector('.daw-content');
  return Math.max(HERO_MIN_H, (content?.clientHeight || 900) - TRACKS_MIN_H);
}
function setHeroHeight(px, save = true) {
  const hero = document.getElementById('daw-hero');
  if (!hero) return;
  const h = Math.round(Math.min(heroMaxH(), Math.max(HERO_MIN_H, px)));
  hero.style.height = h + 'px';
  if (save) { try { localStorage.setItem(HERO_H_KEY, String(h)); } catch {} }
  layout();
}
function resetHeroHeight() {
  const hero = document.getElementById('daw-hero');
  if (hero) hero.style.height = '';   // CSS 기본값(46vh)으로 되돌린다
  try { localStorage.removeItem(HERO_H_KEY); } catch {}
  layout();
}
function wireHeroResize() {
  const grip = document.getElementById('daw-hero-resize');
  const hero = document.getElementById('daw-hero');
  const content = document.querySelector('.daw-content');
  if (!grip || !hero) return;

  let saved = 0;
  try { saved = Number(localStorage.getItem(HERO_H_KEY)) || 0; } catch {}
  if (saved > 0) setHeroHeight(saved, false);

  // 손잡이는 7px 이라 조금만 빠르게 끌어도 포인터가 밖으로 나간다.
  // 그동안의 움직임은 window 에서 받는다 — 캡처는 되면 좋고 안 돼도 동작해야 한다.
  let startY = 0, startH = 0, dragging = false;
  const onMove = (e) => { if (dragging) setHeroHeight(startH + (e.clientY - startY)); };
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endDrag);
    window.removeEventListener('pointercancel', endDrag);
    grip.classList.remove('dragging');
    content?.classList.remove('resizing');
  };
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dragging = true;
    startY = e.clientY;
    startH = hero.getBoundingClientRect().height;
    try { grip.setPointerCapture(e.pointerId); } catch {}
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    grip.classList.add('dragging');
    content?.classList.add('resizing');
  });
  grip.addEventListener('dblclick', resetHeroHeight);
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setHeroHeight(hero.getBoundingClientRect().height + (e.key === 'ArrowUp' ? -step : step));
  });

  // 창이 작아지면 기억해 둔 높이가 한도를 넘는다 — 그때만 줄이고, 고른 값은 그대로 둔다
  window.addEventListener('resize', () => {
    if (!hero.style.height) return;
    const cur = hero.getBoundingClientRect().height;
    const max = heroMaxH();
    if (cur > max) { hero.style.height = Math.round(max) + 'px'; layout(); }
  });
}

/**
 * 영상 접기/펴기.
 *
 * 끌어서 정한 높이는 인라인 style 로 들어간다. 인라인은 클래스 선택자를 언제나 이기므로
 * `.video-collapsed { height: 28px }` 가 먹지 않는다 — 영상만 사라지고 영역은 그대로 남았다.
 * 접을 때 인라인 값을 비워 CSS 에 넘기고, 펼 때 기억해 둔 높이로 되돌린다.
 */
function setVideoCollapsed(on) {
  const hero = document.getElementById('daw-hero');
  if (!hero) return;
  hero.classList.toggle('video-collapsed', on);
  if (on) {
    hero.style.height = '';
  } else {
    let saved = 0;
    try { saved = Number(localStorage.getItem(HERO_H_KEY)) || 0; } catch {}
    if (saved > 0) setHeroHeight(saved, false);   // 없으면 CSS 기본값(46vh) 그대로
  }
  syncHeroState();
  layout();
}

function syncHeroState() {   // hero 클래스에 도구 오픈 여부 반영 — 접힘 + 도구 열림 = 도구가 hero 전체 폭 채움
  const hero = document.getElementById('daw-hero'); if (!hero) return;
  const toolsOpen = !document.getElementById('daw-tools')?.hidden;
  hero.classList.toggle('tools-open', toolsOpen);
}
// 미터 스케일 — 선형 진폭을 그대로 쓰면 노이즈 플로어(-60dB 수준)도 첫 LED를 켜서
// 무음일 때 깜빡이는 것처럼 보인다. dB 로 매핑하고 게이트 + 블록 단위 양자화로 고정.
function applyMeter(el, st) {
  const iL = el.children[0], iR = el.children[1];
  iL.style.setProperty('--v', meterPct(st.curL) + '%');
  iR.style.setProperty('--v', meterPct(st.curR) + '%');
  el.classList.toggle('clip', st.holdL >= 1.0 || st.holdR >= 1.0);   // 잠깐 클립 유지용으로 holdL/R 는 계속 씀
}
let _metersRafOn = false, _metersLast = 0;
function _metersTick(ts) {
  const dt = Math.min(0.05, (ts - _metersLast) / 1000 || 0.016);
  _metersLast = ts;
  const decay = Math.exp(-dt * 5);
  const holdMs = 800;
  const holdDecay = Math.exp(-dt * 3);
  let anyLive = false;
  _meters.forEach((st, id) => {
    st.curL *= decay; st.curR *= decay;
    if (st.curL < METER_GATE) st.curL = 0;   // 게이트 이하는 0 으로 스냅 — 잔여값이 계속 깜빡이는 것 방지
    if (st.curR < METER_GATE) st.curR = 0;
    if (ts - st.holdLTs > holdMs) st.holdL *= holdDecay;
    if (ts - st.holdRTs > holdMs) st.holdR *= holdDecay;
    if (st.curL > 0 || st.curR > 0 || st.holdL > 0.001 || st.holdR > 0.001) anyLive = true;
    const els = document.querySelectorAll(`[data-mid="${id}"]`);   // .daw-meter (헤드) + .mx-meter (사이드바 마스터)
    els.forEach(el => applyMeter(el, st));
  });
  // 사이드바 트랙 미터 — 선택 트랙 상태 표시
  const trackMx = document.getElementById('mx-meter-track');
  if (trackMx) {
    const st = _selTrack != null ? _meters.get(_selTrack) : null;
    if (st) { applyMeter(trackMx, st); if (st.curL > 0.001 || st.curR > 0.001) anyLive = true; }
    else { applyMeter(trackMx, { curL: 0, curR: 0, holdL: 0, holdR: 0 }); }
  }
  if (anyLive) requestAnimationFrame(_metersTick);
  else _metersRafOn = false;
}

// ── 드래그 이동량 배지 (+0:07) ──
// 커서를 따라다니는 배지 (트랙 뒤쪽에서 이동해도 보이게 화면 고정)
function showDragBadge(deltaSec, cx, cy) {
  let b = document.getElementById('daw-drag-badge');
  if (!b) { b = document.createElement('div'); b.id = 'daw-drag-badge'; b.className = 'daw-drag-badge'; document.body.appendChild(b); }
  b.textContent = fmtDelta(deltaSec);
  b.style.left = (cx + 14) + 'px'; b.style.top = (cy - 26) + 'px';
}
function hideDragBadge() { document.getElementById('daw-drag-badge')?.remove(); }

// ── 클립 자석 스냅선 — 어느 클립 경계에 붙었는지 트랙 전체 높이로 보여준다 ──
// 시각(초) → 화면 clientX. dragExportEdge()/seekToClientX() 와 같은 변환식(반대 방향) —
// 커서 위치(ev.clientX)를 그대로 쓰면 안 된다. 클립은 보통 왼쪽 끝이 아니라 몸통 아무
// 데서나 잡고 끄는데, 커서 기준으로 계산하면 그 잡은 위치만큼 선이 항상 어긋난다.
function timeToClientX(sec) {
  const wrap = $('daw-ruler-wrap'), sc = $('daw-tscroll');
  if (!wrap || !sc) return null;
  return wrap.getBoundingClientRect().left + HEAD_W - sc.scrollLeft + sec * _pxPerSec;
}
function showSnapLine(sec) {
  const x = timeToClientX(sec);
  const sc = $('daw-tscroll'); if (x == null || !sc) return;
  const r = sc.getBoundingClientRect();
  let l = document.getElementById('daw-snap-line');
  if (!l) { l = document.createElement('div'); l.id = 'daw-snap-line'; l.className = 'daw-snap-line'; document.body.appendChild(l); }
  l.style.left = x + 'px';
  l.style.top = r.top + 'px';
  l.style.height = r.height + 'px';
}
function hideSnapLine() { document.getElementById('daw-snap-line')?.remove(); }

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
        pushUndo(() => reorderTracks(oldOrder), () => reorderTracks(newOrder), tr('studio.u.trackOrder'));
      }
    }
  };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
}
function renderWaves(buffers) {
  if (buffers) _stemBuffers = buffers;   // 확대할 때 다시 그리려고 들고 있는다
  if (!_stemBuffers) return;
  const n = waveN(_dur);
  _tracks.forEach((t) => {
    if (t.key === 'mine') return;
    const lane = document.querySelector(`.daw-lane[data-key="${t.key}"]`);
    const clip = lane && lane.querySelector('.daw-clip');
    const ch = _stemBuffers[t.key];
    if (clip && ch) clip.innerHTML = buildWaveSvg(ch, resolveColor(t.color), n);
  });
  _waveZoomAt = _pxPerSec;
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
    e.innerHTML = `<div class="daw-eh l" title="${tr('studio.t.adjustStart')}"></div><div class="daw-eh r" title="${tr('studio.t.adjustEnd')}"></div>`;
    ruler.appendChild(e);
    e.querySelector('.daw-eh.l').addEventListener('pointerdown', (ev) => dragExportEdge(ev, 'start'));
    e.querySelector('.daw-eh.r').addEventListener('pointerdown', (ev) => dragExportEdge(ev, 'end'));
    e.addEventListener('dblclick', (ev) => { ev.stopPropagation(); _exportRange = null; renderExportRange(); flashTake(tr('studio.m.exportRangeCleared')); });
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
  const up = () => { document.removeEventListener('pointermove', mv); document.removeEventListener('pointerup', up); flashTake(tr('studio.p.exportRange', { a: fmtTC(_exportRange.start), b: fmtTC(_exportRange.end) })); };
  document.addEventListener('pointermove', mv); document.addEventListener('pointerup', up);
}
function renderExportRange() {
  const e = document.getElementById('daw-erange'), band = document.getElementById('daw-eband');
  if (!_exportRange) { if (e) e.hidden = true; if (band) band.hidden = true; return; }
  const x = _exportRange.start * _pxPerSec, w = (_exportRange.end - _exportRange.start) * _pxPerSec;
  if (e) { e.hidden = false; e.style.left = x + 'px'; e.style.width = w + 'px'; }
  if (band) { band.hidden = false; band.style.left = (HEAD_W + x) + 'px'; band.style.width = w + 'px'; band.style.height = tracksHeight() + 'px'; }
}
const fmtBar = (sec) => tr('studio.lbl.barPrefix') + (Math.floor((sec - _gridOffset) / secPerBar()) + 1);

// 타임라인 총 길이(초) — 소스 길이 + 여유(뷰포트는 채우되 무한 아님), 마디 단위로 반올림
function fullSec() {
  const sc = $('daw-tscroll');
  const vw = sc ? sc.clientWidth - HEAD_W : 1000;
  let content = _dur + _stemOffset;   // 오프셋된 스템 끝
  for (const t of _takes) content = Math.max(content, t.start + t.dur);   // 녹음 테이크 끝
  for (const c of _midiClips) content = Math.max(content, c.start + c.dur);   // MIDI 클립 끝
  const base = Math.max(content, vw / _pxPerSec) + 8;   // 콘텐츠보다 조금 더 길게
  return Math.ceil(base / secPerBar()) * secPerBar();
}
const timelineW = () => Math.max(1, fullSec() * _pxPerSec);

function layout() {
  const w = timelineW();   // 타임라인 전체 폭 (오른쪽 회색 여백 제거)
  $('daw-lanes').style.width = (HEAD_W + w) + 'px';
  document.querySelectorAll('.daw-lane').forEach(l => { l.style.width = (HEAD_W + w) + 'px'; });
  document.querySelectorAll('.daw-auto-row').forEach(r => {
    r.style.width = (HEAD_W + w) + 'px';
    renderAutoLaneInto(r, Number(r.dataset.autoid));   // 배율 변경 시 곡선 다시 그림
  });
  const ruler = $('daw-ruler');
  ruler.style.width = w + 'px'; ruler.innerHTML = '';
  const spb = secPerBar();
  const barPx = spb * _pxPerSec;
  const phase = ((_gridOffset % spb) + spb) % spb;   // 첫 마디선 위치(0~1마디)
  $('daw-lanes').style.setProperty('--grid', barPx + 'px');   // 마디마다 그리드선
  $('daw-lanes').style.setProperty('--grid-off', (phase * _pxPerSec) + 'px');   // 다운비트 정렬
  const lblEvery = barPx >= 60 ? 1 : barPx >= 30 ? 2 : barPx >= 15 ? 4 : 8;   // 라벨 간격(마디)

  // 박·16분음표 세부선 — 칼박 편집은 확대해서 박 경계를 눈으로 봐야 맞출 수 있는데,
  // 지금까진 마디선만 있어서 한 마디 안에서는 감으로 놓아야 했다.
  // 글자·선이 서로 붙지 않을 만큼 벌어졌을 때만 켠다.
  const sbeat = secPerBeat();
  const beatPx = sbeat * _pxPerSec;
  const showBeats = beatPx >= 22;              // 박 눈금(2·3·4번째 박) — 숫자 없이 선만
  const show16th = beatPx >= 140;               // 16분음표 눈금(스냅 격자와 같은 촘촘함)
  $('daw-lanes').classList.toggle('show-beat-grid', showBeats);
  $('daw-lanes').style.setProperty('--gridb', beatPx + 'px');
  $('daw-lanes').style.setProperty('--gridb-off', ((phase % sbeat) * _pxPerSec) + 'px');

  const end = fullSec();
  let bar = Math.round((phase - _gridOffset) / spb) + 1;   // 첫 선의 마디 번호
  for (let s = phase; s <= end + 0.001; s += spb, bar++) {
    const isLabel = bar >= 1 && (bar - 1) % lblEvery === 0;
    const tk = document.createElement('span');
    tk.className = 'tk' + (isLabel ? '' : ' minor');
    tk.style.left = (s * _pxPerSec) + 'px';
    if (isLabel) tk.textContent = bar;
    ruler.appendChild(tk);

    if (!showBeats) continue;
    // bt 는 이 마디 안의 박 경계(1~BEATS_PER_BAR-1)에 더해, 마지막 박의 16분음표를 재려고
    // BEATS_PER_BAR(= 다음 마디선)까지 한 번 더 돈다 — 거기엔 눈금을 새로 안 그린다,
    // 다음 마디의 bar 눈금이 이미 그 자리를 그린다.
    for (let bt = 1; bt <= BEATS_PER_BAR; bt++) {
      const bs = s + bt * sbeat;
      if (bs > end + 0.001) break;
      if (bt < BEATS_PER_BAR) {
        const btk = document.createElement('span');
        btk.className = 'tk beat';
        btk.style.left = (bs * _pxPerSec) + 'px';
        ruler.appendChild(btk);
      }
      if (!show16th) continue;
      const beatStart = bs - sbeat;   // 이 박의 시작(= 앞 눈금)
      for (let q = 1; q < 4; q++) {
        const qs = beatStart + q * (sbeat / 4);
        if (qs > end + 0.001) continue;
        const qtk = document.createElement('span');
        qtk.className = 'tk beat16';
        qtk.style.left = (qs * _pxPerSec) + 'px';
        ruler.appendChild(qtk);
      }
    }
  }
  ensurePlayhead();   // 재생선을 lanes 안에 유지(헤드보다 아래 z → 컨트롤 컬럼에 안 비침)
  ensureExportEls(); renderExportRange();
  renderTakes();
  repositionStems();
  if (_stemBuffers && _pxPerSec !== _waveZoomAt) renderWaves();   // 확대·축소 때만 다시 그린다
  updatePlayhead(_lastSec);
  const zv = $('st-zoom-val'); if (zv) zv.textContent = Math.round(_pxPerSec) + ' px/s';
  const te = $('daw-tracks-empty'); if (te) te.hidden = _tracks.length > 0 || _recTracks.length > 0;
  updateBusStrips();
}

let _lastSec = 0;
// 트랙 영역 높이 — 하단 여유 스페이서 제외(재생선·범위밴드가 빈칸으로 안 나가게)
function tracksHeight() {
  const lanes = $('daw-lanes'); if (!lanes) return 0;
  return lanes.offsetHeight || 0;   // spacer 포함 — 재생선·범위선이 아래 여백까지 자연스럽게 이어짐
}
// ── 베이스 TAB (도구 탭) ─────────────────────────────────────
let _tabView = null;
let _chordStrip = null;     // 마디별 코드명 한 줄 — TAB 과 같은 buildScore() 결과를 그린다
let _tabBusy = false;
let _tabSongKey = null;    // 어느 곡의 결과인지 — 곡이 바뀌면 비운다
// 마디 시작을 옮길 때 다시 채보하지 않으려고 결과를 들고 있는다
let _tabNotes = null, _tabTuning = '4', _tabBeats = null, _tabAccent = null, _tabBarPhase = null;
let _tabPhase = null;      // null = 자동 판정
let _tabKey = null;        // estimateKey() 결과 — 음이름 표기(#/b)에 쓴다
// detectChords() 결과 — 마디 첫 박 판정(phaseFromChords)에도, 마디별 코드 라벨
// (computeBarChords)에도 이걸 그대로 쓴다. 마디 경계(_tabPhase)가 바뀌어도 이
// 자체는 안 바뀐다(박마다 이미 다 구해 둔 값이라) — shiftTabBars() 에서 다시 안 만든다.
let _tabChords = null;
// detectChords() 입력 — 마디 옮길 때(shiftTabBars) 다시 디코드하지 않으려고 들고
// 있는다. 원본 오디오라 스템 경로별로 남기지 않고 통째로 하나만 든다.
let _tabHarmonyMono = null, _tabHarmonySr = 44100;
let _tabBarChords = null;  // computeBarChords() 결과 — 코드 스트립에 표시
let _libraryItemId = null; // 현재 곡의 라이브러리 id — 채보 결과를 여기 저장/복원한다(api.library.setTab)

function updateTabBarButtons() {
  const on = !!(_tabBeats && _tabNotes);
  const p = $('st-tab-bar-prev'), n = $('st-tab-bar-next');
  if (p) p.disabled = !on;
  if (n) n.disabled = !on;
}

/** 마디 시작을 박 단위로 옮긴다. 채보는 그대로 두고 마디선만 다시 그린다. */
function shiftTabBars(delta) {
  if (!_tabNotes || !_tabBeats || !_tabView) return;
  const auto = buildScore(_tabNotes, _tabBeats, { beatAccent: _tabAccent, barPhase: _tabBarPhase, phase: _tabPhase });
  const base = _tabPhase != null ? _tabPhase : (auto ? auto.phase : 0);
  _tabPhase = ((base + delta) % 4 + 4) % 4;
  const score = buildScore(_tabNotes, _tabBeats, { phase: _tabPhase });
  _tabView.setScore(score);
  _tabBarChords = computeBarChords(score, _tabKey, _tabHarmonyMono, _tabHarmonySr, _tabChords);
  if (_chordStrip) _chordStrip.render(score, _tabKey, _tabBarChords);
  persistTabToLibrary();
}

/**
 * 채보 결과를 라이브러리 항목에 저장 — 다음에 이 곡을 열 때 재채보 없이 바로 보이게.
 * barChords(마디별 코드 라벨)도 같이 저장한다 — 스튜디오는 라이브러리와 달리 이 탭
 * 기능만을 위해 화성 스템을 fetch+decode 부터 다시 해야 해서(라이브러리는 플레이어가
 * 이미 재생용으로 디코드해 둔 버퍼를 그대로 재사용한다), 그 결과 없이 매번 새로 열 때마다
 * 몇 초~수십 초씩 코드가 "–"로 비어 보이다 뒤늦게 채워졌다(실사용 제보: 안 온 걸로 착각함).
 * 캐시해 두면 다시 열 때 그 값을 즉시 보여주고, 정확한 값은 여전히 백그라운드에서
 * recomputeTabChordsAsync() 로 다시 맞춰 넣는다(마디 옮기기 등에 화성 오디오가 필요해서).
 */
function persistTabToLibrary() {
  if (!_libraryItemId) return;
  const tab = { notes: _tabNotes, tuning: _tabTuning, beats: _tabBeats, accent: _tabAccent, phase: _tabPhase, barPhase: _tabBarPhase, barChords: _tabBarChords };
  Library.patchTab(_libraryItemId, tab);   // 같은 세션 안에서 바로 반영 — disk 저장과 별개
  api.library.setTab(_libraryItemId, tab).catch(() => {});
}

function refreshTabPanel() {
  const status = $('st-tab-status'), run = $('st-tab-run');
  const bass = _stemPaths && _stemPaths.bass;
  if (_tabSongKey && _tabSongKey !== (_stemPaths && _stemPaths.bass)) {
    if (_tabView) _tabView.clear();
    if (_chordStrip) _chordStrip.clear();
    _tabSongKey = null;
    _tabNotes = null; _tabTuning = '4'; _tabBeats = null; _tabAccent = null; _tabPhase = null; _tabBarPhase = null; _tabKey = null; _tabChords = null;
    _tabHarmonyMono = null; _tabBarChords = null;
    updateTabBarButtons();
    if (run) run.textContent = tr('tab.run');
  }
  if (run) run.disabled = !bass || _tabBusy;
  if (status && !_tabBusy) {
    status.classList.remove('err');
    status.textContent = !_stemPaths ? tr('tab.noSong') : (bass ? '' : tr('tab.noBass'));
  }
}

/**
 * TAB/코드 스트립이 다루는 노트·마디 시각은 항상 채보 당시(원본 베이스 스템 파일 자체,
 * 0초 = 파일 맨 앞, 배속 1x) 기준이다. 반면 엔진의 재생 위치(sec)는 타임라인 좌표라
 * 어긋나는 원인이 둘이다:
 *   1) 배속(_speed) — applySpeed() 는 엔진에 올릴 오디오만 새로 늘리지 _stemPaths.bass
 *      원본은 안 건드린다. syncVideo() 의 vt*_speed 변환과 같은 관계: 원본시각 = 늘어난
 *      시각 * _speed.
 *   2) 스템 오프셋(_stemOffset) — 스템 블록을 타임라인 위에서 드래그해 옮기면(빈 트랙
 *      영역 드래그) 그만큼 늦게 재생되기 시작한다. 원본 파일 시각으로 보려면 그 밀린
 *      만큼을 먼저 빼야 한다.
 * 합쳐서: 원본시각 = (엔진시각 − _stemOffset) * _speed. 노트를 클릭해 되감을 때는
 * 반대 순서로 풀어야 한다 — 안 그러면 배속이나 스템 오프셋이 걸린 채로 TAB 을 보면
 * 표시 위치와 실제 들리는 소리가 어긋난다(둘 다 실사용 제보로 발견).
 */
function tabSeekTo(origSec) {
  if (_recArmed) return;                       // 녹음 중엔 재생 위치를 옮기지 않는다
  // origSec 은 베이스 파일 자체의 시각(0초 = 파일 맨 앞) — 그런데 스템 블록을 타임라인
  // 위에서 드래그해 옮겼으면(_stemOffset) 실제로 그 소리가 나는 엔진 시각은 그만큼
  // 밀려 있다. 배속 변환과 순서가 겹치면 안 된다 — 늘리기 전 시각에 옮긴 만큼 더해야
  // 타임라인 위치가 맞는다(_stemOffset 자체는 이미 타임라인 좌표라 배속 배율을 안 탄다).
  const stretched = origSec / (_speed || 1) + _stemOffset;
  const t = Math.max(0, Math.min(fullSec(), stretched));
  api.engine.seek(secToSamples(t)); syncVideo(t); updatePlayhead(t);
}

/** TAB/코드 스트립 뷰를 처음 쓸 때 만든다 — 채보 실행 때도, 프로젝트 복원 때도 필요해 공용으로 뺐다. */
function ensureTabViews() {
  const view = $('st-tab-view');
  if (view && !_tabView) _tabView = new TabView(view, { onSeek: tabSeekTo });
  const chordEl = $('st-chord-strip');
  if (chordEl && !_chordStrip) _chordStrip = new ChordStripView(chordEl, { onSeek: tabSeekTo });
}

/**
 * 베이스 TAB 상태를 저장해 둔 데이터로 되돌린다(재채보 안 함) — 프로젝트 파일 복원, 그리고
 * 라이브러리 곡을 다시 열었을 때(loadSong) 둘 다 여기를 쓴다. tab 이 없거나 비어 있으면
 * 그냥 비운다 — 이전에 열려 있던 다른 곡의 채보가 남아 보이는 걸 막는다.
 * @param {{notes:Array, tuning?:string, beats?:number[], accent?:number[], phase?:number, barPhase?:number}|null} tab
 */
function restoreTabData(tab) {
  if (_tabView) _tabView.clear();
  if (_chordStrip) _chordStrip.clear();
  _tabNotes = null; _tabTuning = '4'; _tabBeats = null; _tabAccent = null; _tabPhase = null;
  _tabBarPhase = null; _tabKey = null; _tabChords = null; _tabHarmonyMono = null; _tabBarChords = null;
  _tabSongKey = null;
  updateTabBarButtons();
  if (!(tab && Array.isArray(tab.notes) && tab.notes.length && _stemPaths)) return;

  ensureTabViews();
  _tabNotes = tab.notes; _tabTuning = tab.tuning || '4';
  _tabBeats = Array.isArray(tab.beats) ? tab.beats : null;
  _tabAccent = Array.isArray(tab.accent) ? tab.accent : null;
  _tabPhase = tab.phase != null ? tab.phase : null;
  _tabBarPhase = tab.barPhase != null ? tab.barPhase : null;
  _tabSongKey = _stemPaths.bass || null;
  _tabView.setNotes(_tabNotes, _tabTuning);
  const key = estimateKey(_tabNotes);
  _tabKey = key;
  const score = _tabBeats ? buildScore(_tabNotes, _tabBeats, { beatAccent: _tabAccent, barPhase: _tabBarPhase, phase: _tabPhase }) : null;
  _tabView.setScore(score);
  // 캐시돼 있으면(barChords) 오디오를 다시 디코드할 때까지 기다리지 않고 즉시 보여준다 —
  // 화성 스템을 fetch+decode 하는 recomputeTabChordsAsync() 는 곡에 따라 몇 초~수십 초
  // 걸려서, 캐시 없이 매번 "–"만 한참 보이면 사용자가 "복원이 안 된다"고 오해한다(실사용
  // 제보). 정확한 값은 그래도 아래서 백그라운드로 다시 맞춰 둔다(마디 옮기기 등에
  // 화성 오디오가 필요해서) — 같은 입력이면 같은 결과라 화면이 눈에 띄게 바뀌진 않는다.
  _tabBarChords = Array.isArray(tab.barChords) && tab.barChords.length === (score ? score.bars.length : 0) ? tab.barChords : null;
  if (_chordStrip) _chordStrip.render(score, key, _tabBarChords);
  updateTabBarButtons();
  const run = $('st-tab-run'); if (run) run.textContent = tr('tab.rerun');
  recomputeTabChordsAsync();
}

/**
 * 마디 위 코드 라벨만 다시 만든다 — 프로젝트 복원 직후 쓴다. 채보(notes)는 이미 저장돼
 * 있어 그대로 쓰고, 코드는 원본 오디오가 있어야만 나오니 화성 스템만 가볍게 디코드한다.
 * 화성 스템이 하나도 없으면(2-스템 분리 등) 조용히 포기한다 — 코드 라벨 없이도 TAB·
 * TAB·코드 스트립 자체는 이미 복원돼 있다.
 */
async function recomputeTabChordsAsync() {
  if (!_stemPaths || !_tabBeats || !_tabNotes) return;
  try {
    const decode = async (p) => {
      const rr = await fetch(toYtsepUrl(p));
      const c = new AudioContext();
      try { return await c.decodeAudioData(await rr.arrayBuffer()); } finally { try { c.close(); } catch {} }
    };
    const decoded = [];
    for (const [k, p] of Object.entries(_stemPaths)) {
      if (NON_HARMONY_STEMS.has(k) || !p) continue;
      const a2 = await decode(p);
      const aL = a2.getChannelData(0);
      decoded.push({ L: aL, R: a2.numberOfChannels > 1 ? a2.getChannelData(1) : aL, sr: a2.sampleRate });
    }
    if (!decoded.length) return;
    const n = Math.min(...decoded.map(p => p.L.length));
    const mL = new Float32Array(n), mR = new Float32Array(n);
    for (const p of decoded) for (let i = 0; i < n; i++) { mL[i] += p.L[i]; mR[i] += p.R[i]; }
    _tabHarmonyMono = toMono(mL, mR); _tabHarmonySr = decoded[0].sr;
    _tabChords = detectChords(_tabHarmonyMono, _tabHarmonySr, _tabBeats);
    const score = buildScore(_tabNotes, _tabBeats, { beatAccent: _tabAccent, barPhase: _tabBarPhase, phase: _tabPhase });
    _tabBarChords = computeBarChords(score, _tabKey, _tabHarmonyMono, _tabHarmonySr, _tabChords);
    if (_chordStrip) _chordStrip.render(score, _tabKey, _tabBarChords);
    persistTabToLibrary();   // 이번에 처음 계산됐으면(캐시 없던 레거시 데이터) 다음엔 바로 뜨게 저장해 둔다
  } catch { /* 코드 라벨은 부가 정보다 — 실패해도 채보 자체는 이미 복원돼 있다 */ }
}

async function runStudioTab() {
  const view = $('st-tab-view'), status = $('st-tab-status'), run = $('st-tab-run');
  const tuningSel = $('st-tab-tuning');
  const bassPath = _stemPaths && _stemPaths.bass;
  if (!view || _tabBusy) return;
  if (!bassPath) { if (status) { status.textContent = tr(_stemPaths ? 'tab.noBass' : 'tab.noSong'); status.classList.add('err'); } return; }

  _tabBusy = true;
  if (run) run.disabled = true;
  const cancelBtn = $('st-tab-cancel'); if (cancelBtn) cancelBtn.hidden = false;
  if (status) { status.classList.remove('err'); status.textContent = tr('tab.working', { pct: 0 }); }
  try {
    ensureTabViews();
    // 스템은 파일로만 들고 있으므로 여기서 디코드한다
    const res = await fetch(toYtsepUrl(bassPath));
    const buf = await res.arrayBuffer();
    const ctx = new AudioContext();
    let audio;
    try { audio = await ctx.decodeAudioData(buf); } finally { try { ctx.close(); } catch {} }
    const L = audio.getChannelData(0);
    const R = audio.numberOfChannels > 1 ? audio.getChannelData(1) : L;
    const mono = toMono(L, R);

    // 드럼 스템이 있으면 박자를 잡아 격자에 붙이고 마디를 나눈다
    const decode = async (p) => {
      const rr = await fetch(toYtsepUrl(p));
      const c = new AudioContext();
      try { return await c.decodeAudioData(await rr.arrayBuffer()); } finally { try { c.close(); } catch {} }
    };
    let beats = null, drumsMono = null, drumsSr = audio.sampleRate;
    _tabChords = null; _tabHarmonyMono = null;
    if (_stemPaths.drums) {
      try {
        const daudio = await decode(_stemPaths.drums);
        const dL = daudio.getChannelData(0);
        const dR = daudio.numberOfChannels > 1 ? daudio.getChannelData(1) : dL;
        drumsMono = toMono(dL, dR); drumsSr = daudio.sampleRate;

        // 드럼만으로 템포가 안 잡히는 곡이 있다 — 스템을 합쳐 원본 믹스를 폴백으로 준다
        let mix = null, harmonyMix = null;
        try {
          // 베이스는 이미 위에서 디코드해 뒀다(L/R) — 다시 fetch 안 하고 그대로 쓴다.
          const decoded = [{ k: 'bass', L, R }];
          for (const [k, p] of Object.entries(_stemPaths)) {
            if (k === 'drums' || k === 'bass' || !p) continue;
            const a2 = await decode(p);
            const aL = a2.getChannelData(0);
            decoded.push({ k, L: aL, R: a2.numberOfChannels > 1 ? a2.getChannelData(1) : aL });
          }
          const sum = (list) => {
            if (!list.length) return null;
            const n = Math.min(...list.map(p => p.L.length));
            const mL = new Float32Array(n), mR = new Float32Array(n);
            for (const p of list) for (let i = 0; i < n; i++) { mL[i] += p.L[i]; mR[i] += p.R[i]; }
            return [mL, mR];
          };
          mix = sum([{ L: dL, R: dR }, ...decoded]);
          // 코드는 드럼만 빼고 나머지 전부(베이스 포함) 합쳐서 읽는다(사용자 지시).
          // chromaAt() 자체가 110Hz 밑(베이스 기본파 대역)은 이미 걸러서 읽으니, 베이스를
          // 섞어도 그 저음이 코드 판정을 한쪽으로 쏠리게 하진 않는다.
          harmonyMix = sum(decoded.filter(d => !NON_HARMONY_STEMS.has(d.k))) || mix;
        } catch { /* 믹스를 못 만들면 드럼만으로 시도한다 */ }

        const b = await detectBeats(dL, dR, daudio.sampleRate, mix);
        if (b && Array.isArray(b.beats) && b.beats.length > 1) beats = b.beats;
        // 마디 첫 박은 화성이 바뀌는 자리로 잡는다 — 킥보다 훨씬 잘 갈린다.
        // 코드열 자체도 코드 스트립 표시에 그대로 재활용한다.
        if (harmonyMix) {
          _tabHarmonyMono = toMono(harmonyMix[0], harmonyMix[1]);
          _tabHarmonySr = daudio.sampleRate;
        }
        if (beats && harmonyMix) {
          try {
            const chords = detectChords(_tabHarmonyMono, _tabHarmonySr, beats);
            _tabChords = chords;
            const ph = phaseFromChords(chords);
            if (ph) _tabBarPhase = ph.phase;
          } catch { /* 코드 검출 실패 — 킥·베이스 단서로 내려간다 */ }
        }
      } catch { /* 박자 감지 실패 — 격자도 마디도 없이 진행 */ }
    }

    // CREPE(lab/tab/README.md 11번 절) — 클린·분리 후 둘 다 YIN 을 이긴 유일한 경로라
    // 지금 시험 삼아 기본으로 켜 둔다. 아직 한 곡·튜닝 전 상수 기준이라 이 상태로
    // 굳히기 전에 실제 화면에서 한 번 보는 것이 이번 확인의 목적이다.
    const r = await transcribeBass(mono, audio.sampleRate, { tuning: tuningSel ? tuningSel.value : '4', beats, pitchTracker: 'crepe' },
      (pct, phase) => {
        if (status) status.textContent = tr(phase === 'bp' ? 'tab.workingBp' : 'tab.working', { pct });
      });
    _tabView.setNotes(r.notes, r.tuning);
    _tabSongKey = bassPath;

    // 마디 — 박이 있을 때만. 첫 박은 드럼 킥으로 추정하고, 틀리면 사용자가 옮긴다.
    _tabNotes = r.notes; _tabTuning = r.tuning; _tabBeats = beats; _tabPhase = null;
    _tabAccent = beats && drumsMono ? beatAccents(drumsMono, drumsSr, beats) : null;
    // 조성 — 표기(F#/Gb)에 쓴다. 정확도에는 쓰지 않는다: 실측에서 조 밖 음 15개는
    // 하나도 틀리지 않았고, 오검출 41개는 전부 조 안이었다(옥타브 오류는 정의상 조 안이다).
    const key = estimateKey(r.notes);
    _tabKey = key;
    const score = beats ? buildScore(r.notes, beats, { beatAccent: _tabAccent, barPhase: _tabBarPhase }) : null;
    _tabView.setScore(score);
    _tabBarChords = computeBarChords(score, key, _tabHarmonyMono, _tabHarmonySr, _tabChords);
    if (_chordStrip) _chordStrip.render(score, key, _tabBarChords);
    updateTabBarButtons();
    if (status) status.textContent = r.cross && r.cross.agreed != null
      ? tr('tab.doneCross', { n: r.notes.length, agreed: r.cross.agreed })
      : (key ? tr('tab.doneKey', { n: r.notes.length, key: key.name })
             : tr('tab.done', { n: r.notes.length }));
    if (run) run.textContent = tr('tab.rerun');
    // 다음에 이 곡을 열 때 재채보 없이 바로 보이게 — CREPE 가 제일 오래 걸리는 부분이다.
    persistTabToLibrary();
  } catch (e) {
    if (status) {
      if (e && e.cancelled) { status.classList.remove('err'); status.textContent = tr('tab.cancelled'); }
      else { status.textContent = tr('tab.failed', { err: (e && e.message) || e }); status.classList.add('err'); }
    }
  } finally {
    _tabBusy = false;
    if (run) run.disabled = !(_stemPaths && _stemPaths.bass);
    if (cancelBtn) cancelBtn.hidden = true;
  }
}

function updatePlayhead(sec) {
  _lastSec = sec; _phEmitTs = performance.now(); _phEmitSec = sec;
  // 엔진(타임라인) 시각 → 채보(원본 베이스 파일) 시각, tabSeekTo() 와 반대 방향.
  // 스템 블록을 드래그해 옮긴 만큼(_stemOffset) 먼저 빼야 파일 자체의 시각이 나온다.
  const tabSec = (sec - _stemOffset) * (_speed || 1);
  if (_tabView) _tabView.setTime(tabSec);
  if (_chordStrip) _chordStrip.setTime(tabSec);
  const ph = $('daw-playhead');
  if (!ph) return;
  ph.hidden = _tracks.length === 0 && _recTracks.length === 0;
  const x = Math.round(HEAD_W + sec * _pxPerSec);   // 정수화 → 서브픽셀 스냅 튐 방지
  ph.style.transform = `translate3d(${x}px, 0, 0)`;
  ph.style.height = tracksHeight() + 'px';
  const pos = $('st-pos'); if (pos) pos.textContent = fmtTC(sec);
  $('daw-ruler').style.transform = `translateX(${-$('daw-tscroll').scrollLeft}px)`;
  if (_playing && !_phRafOn) { _phRafOn = true; requestAnimationFrame(_phTick); }
}
// 재생 중 20Hz pos 사이를 rAF 로 부드럽게 진행 — 마지막 emit 시각·값 기준으로 초당 1초씩 앞으로
let _phEmitTs = 0, _phEmitSec = 0, _phRafOn = false;
function _phTick(ts) {
  if (!_playing) { _phRafOn = false; return; }
  const sec = _phEmitSec + (ts - _phEmitTs) / 1000;
  const ph = $('daw-playhead'); if (ph) {
    const x = Math.round(HEAD_W + sec * _pxPerSec);
    ph.style.transform = `translate3d(${x}px, 0, 0)`;
    const p = $('st-pos'); if (p) p.textContent = fmtTC(sec);
  }
  const tabSec = (sec - _stemOffset) * (_speed || 1);
  if (_tabView) _tabView.setTime(tabSec);   // 엔진 pos 는 20Hz — 여기서 보간해야 부드럽다
  if (_chordStrip) _chordStrip.setTime(tabSec);
  requestAnimationFrame(_phTick);
}

// ── 트랜스포트 (모듈 스코프 — 어디서든 호출 가능) ──
function updatePlayIcon() {
  // _playing 만 보고 껐다 켰다 하면, 영상 없이 내 트랙만 녹음/재생하는 세션에서도 정지할
  // 때마다 오버레이가 다시 나타났다(사용자 제보) — 애초에 영상이 없으면 재생 상태와
  // 무관하게 계속 숨어 있어야 한다.
  const el = $('daw-vplay'); if (el) el.hidden = _playing || !_videoPath;
  const pb = $('st-play');
  if (pb) { pb.classList.toggle('on', _playing); pb.setAttribute('aria-pressed', String(_playing)); }
}
function playStudio() {
  setTimeout(() => _pr?.setPlaying(_playing), 0);   // 피아노롤 재생 버튼 표시 동기화
  _playStart = _lastSec;   // 재생 시작점 기억(정지 시 복귀)
  _playing = true; api.engine.play(); syncVideo(_playStart); updatePlayIcon();
}
function stopStudio() {
  setTimeout(() => _pr?.setPlaying(_playing), 0);   // 피아노롤 재생 버튼 표시 동기화
  _playing = false; api.engine.stop(); const v = $('daw-video'); if (v) v.pause(); updatePlayIcon();
  if (_recArmed) { _recArmed = false; $('st-rec').classList.remove('armed'); $('st-rec').setAttribute('aria-pressed', 'false'); api.engine.recordStop(); }
  clearRecLive();
  if (_returnOnStop) {   // 정지 시 재생 시작 위치로 복귀(옵션)
    const back = Math.max(0, _playStart || 0);
    api.engine.seek(secToSamples(back));
    syncVideo(back);
    updatePlayhead(back);
  }
}
function armRecPlay() {   // R: 즉시 녹음 준비 + 재생 시작
  if (!armedRecIds().length && !armedMidiIds().length && !armedRecId()) { flashTake(tr('studio.m.addRecTrackFirst')); return; }
  if (!_recArmed) { _recArmed = true; $('st-rec').classList.add('armed'); $('st-rec').setAttribute('aria-pressed', 'true'); api.engine.recordArm(_projectPath, armedRecIds(), 'studio', armedMidiIds()); midiRecAssist(); }
  if (!_playing) playStudio();
  // 녹음 버튼이 켜지고 재생이 시작되는 것으로 이미 보인다 — 알림은 겹칠 뿐이다
}

// ── 동기 ──────────────────────────────────────────
let _recStartSec = null;
// 녹음 중 실시간 파형 — 엔진이 이미 20Hz 로 스트리밍하는 입력 peak('level' 이벤트, 튜너·VU
// 미터가 쓰는 바로 그 값)를 시간순으로 쌓아 뒀다가, 화면에 그릴 때 그 순간의 배율(_pxPerSec)
// 기준 픽셀 폭만큼 버킷으로 나눠 그린다. 원본 PCM 은 녹음이 끝나야 파일에서 읽을 수 있어
// (renderTake) 이 동안은 이 peak 스트림이 얻을 수 있는 전부다 — 정밀한 파형은 아니지만
// 녹음되고 있다는 것과 대략의 레벨은 실시간으로 보여준다.
// _recLiveCols[i] = 그 픽셀 열에서 지금까지 본 최대 peak — 열 번호는 "녹음 시작부터 몇
// 픽셀째냐"로 한 번 정해지면 그 열은 다시 안 건드린다(같은 열에 또 peak 이 오면 더 큰
// 값으로만 갱신). 예전엔 매번 전체 peak 배열을 통째로 다시 n 개 구간으로 나눠 그렸는데,
// 표본 개수와 픽셀 폭이 서로 다른 속도로 늘어나다 보니 그 나누는 경계가 매 프레임 조금씩
// 밀려서 이미 그린 막대까지 값이 바뀌어 자글자글 흔들려 보였다(사용자 제보). 열을 한 번
// 쓰면 고정해 두면 그 흔들림이 없다.
//
// 높이는 "지금까지 본 최댓값" 대비 상대 스케일이 아니라 고정 기준(REC_LIVE_REF_PEAK)
// 대비로 잰다. 상대 스케일은 두 번 실패했다 — 최댓값을 0 가까이서 시작하면 잡음까지
// 꽉 차 보였고(1차 수정으로 바닥을 뒀었다), 바닥을 둬도 녹음 내내 더 큰 소리가 나올
// 때마다 이미 그린 막대들까지 전부 비율이 다시 줄어들어 계속 출렁였다(사용자 제보:
// "상대적 크기로 유동적으로 변화해"). 고정 기준이면 한 번 그린 막대는 무슨 일이 있어도
// 다신 안 바뀐다 — 대신 녹음이 끝나 실제 파형(그 클립 자신의 최댓값 기준)으로 바뀔 때
// 크기가 살짝 달라질 순 있는데, 그 정도 1회성 전환은 녹음 내내 계속 출렁이는 것보다 낫다.
const REC_LIVE_REF_PEAK = 0.35;   // 대략 -9dBFS — 적당히 게인 잡은 녹음의 흔한 피크 수준
let _recLiveCols = [];
function pushRecLivePeak(elapsedSec, peak) {
  const col = Math.max(0, Math.floor(elapsedSec * _pxPerSec));
  if (peak > (_recLiveCols[col] || 0)) _recLiveCols[col] = peak;
}
function buildLiveWaveSvg(cols, widthPx, color) {
  const n = Math.max(1, Math.round(widthPx));
  const head = `<svg width="100%" height="100%" viewBox="0 0 ${n} 24" preserveAspectRatio="none">`;
  if (!cols.length) return head + '</svg>';
  const heights = new Array(n);
  for (let i = 0; i < n; i++) heights[i] = Math.min(1, (cols[i] || 0) / REC_LIVE_REF_PEAK) * 11;
  let a = '', b = '';
  for (let i = 0; i < n; i++) a += `${i},${(12 - heights[i]).toFixed(1)} `;
  for (let i = n - 1; i >= 0; i--) b += `${i},${(12 + heights[i]).toFixed(1)} `;
  return `${head}<polygon points="${a}${b}" fill="${color}" fill-opacity=".85"/></svg>`;
}
function updateRecLive(t) {
  if (!recLiveHasAudio()) return;   // 악기 트랙만 녹음 중이면 오디오 파형 미리보기가 없다(노트는 멈추면 클립으로 뜬다)
  const lane = document.querySelector(`.daw-lane-rec[data-recid="${armedRecId()}"]`) || document.querySelector('.daw-lane-rec');
  const area = lane && lane.querySelector('.daw-area');
  if (!area) return;
  if (_recStartSec == null) _recStartSec = t;
  let el = area.querySelector('.daw-rec-live');
  if (!el) { el = document.createElement('div'); el.className = 'daw-rec-live'; area.appendChild(el); }
  const wPx = Math.max(2, (t - _recStartSec) * _pxPerSec);
  el.style.left = (_recStartSec * _pxPerSec) + 'px';
  el.style.width = wPx + 'px';
  const armedRt = _recTracks.find(r => r.id === armedRecId()) || {};
  el.innerHTML = buildLiveWaveSvg(_recLiveCols, wPx, resolveColor(armedRt.color || 'var(--danger)'));
}
function recLiveHasAudio() { return armedRecIds().length > 0; }
function clearRecLive() { _recStartSec = null; _recLiveCols = []; document.querySelector('.daw-rec-live')?.remove(); clearMidiLive(); }

// 영상 동기 — 스템 오프셋 반영. 영상시간 = 재생위치 - 스템오프셋 (스템이 시작되면 영상 재생)
function syncVideo(t) {
  const v = $('daw-video'); if (!v || !isFinite(v.duration)) return;
  const vt = t - _stemOffset;
  if (vt < 0) { if (!v.paused) v.pause(); if (Math.abs(v.currentTime) > 0.05) v.currentTime = 0; return; }
  // vt 는 스템 타임라인 초(_speed!=1 이면 실제로 늘어난/줄어든 길이) — 비디오 자신의
  // 원본 길이 기준으로 보려면 배속을 다시 곱해야 한다(느려졌으면 vt 가 더 크게 흐르니까
  // 그만큼 곱해서 도로 짧은 원본 시간으로 되돌린다). playbackRate 도 같이 맞춰야 이
  // currentTime 보정 없이도 계속 같은 속도로 따라간다.
  if (Math.abs(v.playbackRate - _speed) > 0.001) v.playbackRate = _speed;
  const target = Math.min(vt * _speed, v.duration);
  if (Math.abs(v.currentTime - target) > 0.15) v.currentTime = target;
  if (_playing && v.paused && vt <= v.duration) v.play().catch(() => {});
}
function onPos(samples) {
  const t = samplesToSec(samples || 0);
  updatePlayhead(t);
  if (_recArmed && _playing) { updateRecLive(t); updateMidiLive(t); }
  if (_pr) { const pc = _midiClips.find(x => x.id === _pr.clipId); if (pc) _pr.setPlayhead(t - pc.start); }
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
  if (!freq || freq < 25) {   // 엔진과 같은 하한 — 5현 로우 B(30.87Hz)가 여기서 잘리면 안 된다
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
  // 스무딩: 최근 프레임 중앙값(스파이크 제거). 엔진이 20Hz 로 올리므로 5프레임이면 250ms.
  _tunerBuf.push(freq); if (_tunerBuf.length > 5) _tunerBuf.shift();
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
  // st-audio-settings 는 일부러 뺐다 — VST 폴더 하나가 스캔 중 엔진을 죽이면(scanPlugins
  // 는 'ready' 마다 자동으로 돎, onEngineEvent 참고) 재시작할 때마다 다시 크래시하는
  // 루프에 빠지는데, 이 목록에 껴 있으면 그때마다 오디오 설정도 같이 잠겨서 방금 넣은
  // 그 폴더를 빼러 들어갈 방법이 없어진다(실제 제보). VST 폴더 관리(api.settings.vstDirs*)
  // 는 엔진과 무관한 설정 파일 조작이라 엔진이 죽어 있어도 안전하게 쓸 수 있다.
  ['st-load-song', 'st-file-menu', 'st-proj-name', 'st-bpm', 'st-bpm-half', 'st-bpm-double', 'st-speed-btn', 'st-key-btn', 'st-metro', 'st-metro-cfg', 'st-seek0', 'st-play', 'st-stop', 'st-rec', 'st-return', 'st-range-mode', 'st-magnet', 'st-marquee', 'st-clip-opacity', 'st-add-rec', 'st-add-instr', 'st-zoom-in', 'st-zoom-out', 'st-tools-toggle', 'st-export', 'mx-master', 'mx-stem-group', 'st-fx-add', 'st-fx-save', 'st-fx-saveas', 'st-fx-load', 'st-fx-bypassall', 'st-monitor']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
  updateKbButtons();
  updateCloseSongBtn();   // 곡 닫기는 스템 곡 로드 시에만
}
// 곡 닫기 버튼 — 라이브러리 스템 곡을 불러온 경우에만 활성화
function updateCloseSongBtn() {
  const el = $('st-close-song'); if (el) el.disabled = !(_started && _stemPaths);
  const sp = $('st-speed-btn');
  if (sp) { sp.hidden = !(_started && _stemPaths); updateSpeedBtnLabel(); }
  const kp = $('st-key-btn');
  if (kp) { kp.hidden = !(_started && _stemPaths); updateKeyBtnLabel(); }
}
function updateSpeedBtnLabel() {
  const sp = $('st-speed-btn'); if (!sp) return;
  const pct = Math.round((_speed || 1) * 100);
  sp.textContent = pct === 100 ? tr('studio.h.speedBtn') : tr('studio.h.speedBtnPct', { pct });
}
function updateKeyBtnLabel() {
  const kp = $('st-key-btn'); if (!kp) return;
  kp.textContent = _keySemitones === 0 ? tr('studio.h.keyBtn') : tr('studio.h.keyBtnSemi', { semi: (_keySemitones > 0 ? '+' : '') + _keySemitones });
}

// ── 파일 임포트 (내 파일로 편집 — DAW) ──────────────
let _clipSeq = Date.now() * 1000;   // 단조증가 → 루프·같은 ms 에도 항상 고유
function nextClipId() { return ++_clipSeq; }
async function newAudioTrack() {   // 오디오(임포트) 트랙 생성 후 새 id 반환
  const before = _recTracks.length;
  api.engine.recTrackAdd(1, 'studio');   // type 1 = 오디오(녹음 불가)
  await new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { if (_recTracks.length > before || Date.now() - t0 > 2000) { clearInterval(iv); res(); } }, 25); });
  return _recTracks.length ? _recTracks[_recTracks.length - 1].id : null;
}
async function importAudio(paths, startSec, trackId) {
  if (!_started) { flashTake(tr('studio.m.startAudioFirst')); return; }
  // 대상: 드롭한 오디오 레인이면 그 트랙, 아니면 새 오디오 트랙
  const dropTrack = _recTracks.find(t => t.id === trackId && t.type === 1);
  const tid = dropTrack ? dropTrack.id : await newAudioTrack();
  if (tid == null) { flashTake(tr('studio.m.trackCreateFail')); return; }
  const startS = secToSamples(Math.max(0, startSec || 0));
  for (const p of paths) {
    const id = nextClipId();
    api.engine.takeLoad(p, startS, tid, id);
    await renderTake(p, startS, id, tid);
  }
  layout();   // 임포트 클립이 범위 밖이면 타임라인 연장
  markDirty();
  flashTake(tr('studio.p.audioImported', { n: paths.length }));
}
async function pickImportAudio() {
  const r = await api.dialog.pickAudioFiles();
  if (r && r.ok && r.filePaths?.length) importAudio(r.filePaths, _lastSec, null);
}

// 불러온 스템 곡 닫기(되돌리기) — 스템·영상 비움, 내 녹음/임포트 트랙은 유지
function closeSong() {
  api.engine.loadStems([]);
  _tracks = []; _stemOffset = 0; _dur = 0; _baseDur = 0; _speed = 1; _speedBase = null; _speedStemPaths = null; _keySemitones = 0; _songKey = null; _auto = new Map();
  updateSpeedBtnLabel();
  resetStemGroupGain();
  _stemPaths = null; _videoPath = null; _stemBuffers = null; _waveZoomAt = 0; _modelKey = null; _libraryItemId = null;
  const v = $('daw-video'); if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
  const em = $('daw-video-empty'); if (em) em.hidden = false;
  const vp = $('daw-vplay'); if (vp) vp.hidden = true;   // 곡 없이도 재생 버튼이 남아 있던 것(사용자 제보)
  renderTracks();
  updateCloseSongBtn();
  updateStudioModelToggle();
  restoreTabData(null);
  flashTake(tr('studio.m.songClosed'));
}

// ── 곡 로드 ────────────────────────────────────────
let _loadingSong = false;
async function loadSong(item, opts) {
  if (_loadingSong) return;   // 재진입 차단 (더블클릭 시 전역상태 오염)
  const it = item || Library.getSelected();
  if (!it) return;
  const autoBpm = !(opts && opts.autoBpm === false);   // 프로젝트 복원 시엔 감지 생략
  const paths = Object.values(it.stemPaths || {}).filter(Boolean);
  if (!paths.length) { flashTake(tr('studio.m.noStemFiles')); return; }
  _loadingSong = true;
  _songKey = String(it.videoPath || it.id);
  _stemPaths = it.stemPaths || null; _songName = it.name || ''; _videoPath = it.videoPath || null;
  _modelKey = it.modelKey || '4stem';
  _libraryItemId = it.id || null;   // 채보 결과를 이 id 로 라이브러리에 저장/복원한다
  _takes = []; _midiClips = []; _selMidi = null; api.engine.midiClear?.(); _stemOffset = 0; _gridOffset = 0; _beats = []; _detBpm = 0; _beatInterval = 0; _auto = new Map(); clearUndo();
  _speed = 1; _speedBase = null; _speedStemPaths = null; _keySemitones = 0; _baseDur = 0;
  updateSpeedBtnLabel();
  _projectPath = null; markClean();   // 라이브러리 곡 = 미저장 새 편집 상태
  resetStemGroupGain();

  const keys = Object.keys(it.stemPaths || {});
  _tracks = keys.map((k, i) => ({ key: k, label: stemLabel(k), color: STEM_COLOR[k] || 'var(--accent)', engineIndex: i }));
  renderTracks();
  updateCloseSongBtn();
  updateStudioModelToggle();
  // 베이스 TAB — 이 곡을 예전에 채보해 뒀으면(라이브러리에 저장돼 있으면) 재채보 없이 바로 보여준다.
  restoreTabData(it.tab);

  const v = $('daw-video');
  $('daw-video-empty').hidden = true;
  if (it.videoPath) { v.src = toYtsepUrl(it.videoPath); v.load(); }

  api.engine.loadStems(paths);
  api.engine.scanPlugins();
  flashTake(tr('studio.p.loaded', { name: it.name }));

  // 파형 (렌더러에서 디코드)
  flashTake(tr('studio.p.loadedAnalyzing', { name: it.name }));
  try {
    const { stems, sampleRate } = await loadStemFilesToBuffers(it.stemPaths);
    renderWaves(stems);
    flashTake(tr('studio.p.loaded', { name: it.name }));
    if (autoBpm) detectSongBpm(stems, sampleRate || deviceSr());   // drums 에서 BPM·박자 감지(비동기)
  } catch (e) { flashTake(tr('studio.p.waveDecodeFail', { err: (e && e.message) || e })); }
  finally { _loadingSong = false; }
}
/** 같은 videoPath 를 공유하는 모든 변형(자기 자신 포함) — library.js 의 siblingItems() 와 같은 발상 */
function siblingItemsFor(videoPath) {
  if (!videoPath) return [];
  return Library.getItems().filter(x => x.videoPath === videoPath);
}

/** 상단 4stem/4stem-2/6stem 토글 — 이미 갈린 변형끼리는 즉시 전환, 안 갈린 건 재분리로 보낸다 */
function updateStudioModelToggle() {
  const toggle = $('st-model-toggle');
  if (!toggle) return;
  const variants = siblingItemsFor(_videoPath);
  if (!_videoPath || variants.length <= 1) { toggle.hidden = true; return; }
  const keysHave = new Set(variants.map(x => x.modelKey || '4stem'));
  toggle.hidden = false;
  toggle.querySelectorAll('.model-tog-btn').forEach(b => {
    const k = b.dataset.key;
    b.classList.toggle('on', k === _modelKey);
    b.classList.toggle('unavailable', !keysHave.has(k));
  });
}

$('st-model-toggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.model-tog-btn');
  if (!btn || btn.classList.contains('on')) return;
  const targetKey = btn.dataset.key;
  if (btn.classList.contains('unavailable')) {
    // 이 영상은 아직 이 모델로 안 갈렸다 — library.js 재분리와 같은 흐름으로 "새 분리" 탭에 준비해 둔다.
    const label = btn.textContent.trim();
    const isEn = getLocale() === 'en';
    const msg = isEn
      ? `Reseparate this video with the ${label} model.\n\nThe "New" tab will be opened and prepared. Continue?`
      : `이 영상을 ${label} 모델로 다시 분리합니다.\n\n"새 분리" 탭으로 이동하고 준비 상태로 세팅됩니다. 계속할까요?`;
    if (!confirm(msg)) return;
    document.dispatchEvent(new CustomEvent('yss:preload-separation', {
      detail: {
        videoPath: _videoPath,
        baseName: (_videoPath || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, ''),
        probe: {
          id: 'local-' + Math.random().toString(36).slice(2, 8),
          title: _songName,
          uploader: isEn ? '(studio reseparate)' : '(스튜디오 재분리)',
          duration: 0,
          thumbnail: null,
        },
        modelKey: targetKey,
      },
    }));
    return;
  }
  const sib = siblingItemsFor(_videoPath).find(x => (x.modelKey || '4stem') === targetKey);
  if (sib) loadSong(sib);
});

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
    _gridOffset = 0;   // Bar 1 = time 0. 다운비트 자동 정렬은 룰러 앞쪽 빈 공간 만들어서 뺌
    layout();
    updateMetro();
    flashTake(tr('studio.p.bpmDetected', { bpm: _bpm }));
  } catch (e) { /* 감지 실패 — 수동 BPM 유지 */ }
}

// ── 스템 일괄 속도 조절 ──────────────────────────────
// 재생 배율(video.playbackRate 같은 것)이 아니라 진짜 타임스트레치다 — signalsmith-stretch 로
// 모든 스템을 오프라인으로 다시 렌더링해서(음정은 유지) 파일 자체를 늘리거나 줄이고, 그
// 결과를 stem:saveStems 로 디스크에 새로 써서 엔진에 다시 물린다(엔진은 파일 경로만 받지
// PCM 을 직접 못 받는다 — pitch-shift.js 의 기존 오프라인 처리와 같은 라이브러리, 같은
// OfflineAudioContext 패턴을 재사용). 항상 원본(_stemPaths) 에서부터 다시 늘린다 — 이미
// 늘려 놓은 결과를 또 늘리면 매번 음질이 깎이고 오차도 쌓인다.
//
// 녹음된 클립(take)이 있으면 막는다 — take 의 시작/길이는 절대 초 단위로 저장돼 있는데,
// 속도를 바꾸면 그 뒤로 스템 타임라인 전체가 늘거나 줄어서 이미 녹음해 둔 클립들이
// 엉뚱한 자리에서 울리게 된다. 되돌릴 방법(클립까지 같이 재배치)이 아직 없어서, 지금은
// "녹음하기 전에만 속도를 정한다"로 범위를 좁힌다.
// 프로젝트를 열 때, 저장해 둔 pathsObj(이전에 늘인 스템 파일들)가 아직 디스크에 남아 있으면
// 다시 늘이지 않고 그대로 불러오기만 한다 — applySpeed() 의 "저장 이후" 부분만 떼어낸
// 셈이지만, BPM/그리드/beats 는 applyProject() 가 이 함수를 부르기 전에 이미 저장된(그
// 배속 기준으로 스케일된) 값 그대로 세팅해 놨으므로 여기서 따로 다시 계산하지 않는다.
async function restoreSpeedFromCache(pathsObj, factor, semitones = 0) {
  try {
    const paths = _tracks.map(t => pathsObj[t.key]).filter(Boolean);
    if (paths.length !== _tracks.length) return false;   // 트랙 구성이 바뀌었으면(스템 종류 등) 그냥 재처리로
    const { stems } = await loadStemFilesToBuffers(pathsObj);
    api.engine.loadStems(paths);
    _tracks.forEach(t => api.engine.track(t.engineIndex, { gain: stemGainOut(t), pan: t.pan || 0, mute: !!t.mute, solo: !!t.solo, sends: t.sends || [0, 0] }));
    renderWaves(stems);
    _speedStemPaths = pathsObj;
    _speed = factor;
    _keySemitones = semitones;
    recomputeDur();
    const v = $('daw-video'); if (v) v.playbackRate = _speed;
    layout();
    updateSpeedBtnLabel();
    updateKeyBtnLabel();
    return true;
  } catch { return false; }
}
// 속도(타임스트레치)와 키(피치시프트)를 한 파이프라인으로 합쳐 처리한다 — 매번 원본
// _stemPaths 에서부터 둘 다 다시 만든다(캐시 하나 _speedStemPaths 공유, 따로 두면 어느 쪽을
// 마지막으로 바꿨는지에 따라 서로의 처리 결과가 덮어써지는 문제가 생긴다). applySpeed/
// applyKeyShift 는 이 함수를 부르는 얇은 래퍼일 뿐이다.
//
// 드럼은 피치를 건드리지 않는다(타악기 피치시프트는 부자연스럽다 — 라이브러리 미리듣기
// 플레이어의 기존 규칙과 동일, player.js 의 SKIP 참고). 보컬만 formant 보존을 켠다.
//
// 녹음된 클립(take)이 있으면 "속도"가 실제로 바뀔 때만 막는다 — take 의 시작/길이는 절대
// 초 단위라 속도를 바꾸면 타임라인 전체가 늘거나 줄어 클립이 엉뚱한 자리에서 울린다. 키만
// 바꿀 땐 길이가 그대로라 이 문제가 없어서 take 유무와 무관하게 허용한다.
//
// opts.onProgress(doneSteps, totalSteps, label) — 스템 하나 끝낼 때마다 호출(+ 저장 단계 1개
// 더). opts.isCancelled() — 매 안전 지점(스템 시작 전/저장 직전)마다 확인해서, true 면 그
// 순간까지 만든 결과를 전부 버리고 이전 상태 그대로 둔 채 'cancelled' 를 돌려준다(엔진/화면
// 어느 것도 안 건드렸으니 취소해도 항상 처리 시작 전 상태 그대로). 반환값: 'ok'|'cancelled'|'error'.
async function applyTransform(factor, semitones, opts = {}) {
  factor = Math.max(0.25, Math.min(2, factor || 1));
  semitones = Math.max(-6, Math.min(6, Math.round(semitones || 0)));
  if (!_stemPaths) return 'error';
  const speedChanging = factor !== _speed;
  if (speedChanging && _takes.length && !opts.fromLoad) { flashTake(tr('studio.m.speedBlockedByTakes')); return 'error'; }
  if (_speedBusy) return 'error';
  _speedBusy = true;
  const isCancelled = opts.isCancelled || (() => false);
  const report = (i, total, label) => { if (opts.onProgress) opts.onProgress(i, total, label); };
  try {
    // 처음으로 1배를 벗어나는 순간의 BPM/그리드를 기준으로 얼려 둔다 — 그 뒤로 배속을
    // 몇 번을 바꾸든 항상 이 기준에서 다시 계산해서 반올림 오차가 안 쌓인다.
    if (!_speedBase) _speedBase = { bpm: _bpm, beatInterval: _beatInterval, gridOffset: _gridOffset, beats: _beats.slice() };
    const { stems, sampleRate } = await loadStemFilesToBuffers(_stemPaths);
    if (isCancelled()) return 'cancelled';
    const names = Object.keys(stems);
    const total = names.length + 1;   // +1 = 저장·엔진 재적용 단계
    // 원래대로(100% · 키 0)로 되돌리는 경우 — 처리할 게 없다. 예전엔 이때도 모든 스템을 다시
    // 돌리고(실제론 그대로 통과) 원본과 똑같은 사본을 또 저장했다. 원본 파일을 그대로 다시 물린다.
    const identity = factor === 1 && semitones === 0;
    const processed = identity ? stems : {};
    const t0 = performance.now();
    for (let i = 0; !identity && i < names.length; i++) {
      if (isCancelled()) return 'cancelled';
      const name = names[i];
      // 남은 시간 — 첫 스템이 끝나야 한 개당 걸리는 시간을 알 수 있다(스템 길이는 모두 같다)
      const perStem = i > 0 ? (performance.now() - t0) / i : 0;
      const eta = perStem > 0 ? Math.max(1, Math.round(perStem * (names.length - i) / 1000)) : 0;
      const label = tr('studio.p.speedStretching', { name: stemLabel(name), i: i + 1, n: names.length });
      report(i, total, eta ? `${label} · ${tr('studio.p.speedEta', { s: eta })}` : label);
      let [L, R] = stems[name];
      if (semitones && name !== 'drums') {
        const r = await pitchShiftStereo(L, R, sampleRate, semitones, { formantCompensation: name === 'vocals' });
        L = r.L; R = r.R;
      }
      if (factor !== 1) {
        const r2 = await timeStretchStereo(L, R, sampleRate, factor);
        L = r2.L; R = r2.R;
      }
      processed[name] = [L, R];
    }
    if (isCancelled()) return 'cancelled';
    report(names.length, total, tr('studio.p.speedSaving'));
    let newPaths;
    if (identity) {
      newPaths = null;   // 원본을 그대로 쓴다 — 처리본 없음
    } else {
      const save = await api.stem.saveStems(processed, `speedtmp_${Date.now()}`, sampleRate);
      if (!save || !save.ok) throw new Error((save && save.error) || 'saveStems failed');
      newPaths = save.stemPaths;
    }
    if (isCancelled()) {
      // 방금 저장한 처리본은 아무도 안 쓴다 — 남겨 두면 stemsDir 에 고아 파일로 쌓인다
      if (newPaths) for (const p of Object.values(newPaths)) api.library.deleteOrphan(p).catch(() => {});
      return 'cancelled';
    }
    // 이전에 처리해 둔 파일이 있으면 여기서 치운다 — 안 그러면 속도·키 바꿀 때마다 처리한
    // 파일이 stemsDir 에 계속 쌓인다(프로젝트에 저장해서 다음에 열 때 재사용하려고 남기는
    // 거라 지울 수가 없었는데, "이번" 걸 새로 남기니 "저번" 건 이제 필요 없다).
    if (_speedStemPaths) { for (const p of Object.values(_speedStemPaths)) api.library.deleteOrphan(p).catch(() => {}); }
    _speedStemPaths = newPaths;
    const src = newPaths || _stemPaths;
    const paths = _tracks.map(t => src[t.key]).filter(Boolean);
    api.engine.loadStems(paths);
    // loadStems 는 엔진 쪽 트랙을 기본값으로 되돌린다 — 볼륨/팬/뮤트/솔로/센드를 다시 밀어 넣는다.
    _tracks.forEach(t => api.engine.track(t.engineIndex, { gain: stemGainOut(t), pan: t.pan || 0, mute: !!t.mute, solo: !!t.solo, sends: t.sends || [0, 0] }));
    renderWaves(processed);
    _speed = factor;
    _keySemitones = semitones;
    recomputeDur();
    _bpm = Math.max(20, Math.min(300, Math.round(_speedBase.bpm * factor)));
    _beatInterval = _speedBase.beatInterval > 0 ? _speedBase.beatInterval / factor : 0;
    _gridOffset = _speedBase.gridOffset / factor;
    _beats = _speedBase.beats.map(t => t / factor);
    const bpmEl = $('st-bpm'); if (bpmEl) bpmEl.value = _bpm;
    updateMetro();
    _exportRange = null; renderExportRange();
    const v = $('daw-video'); if (v) v.playbackRate = _speed;
    layout();
    updateSpeedBtnLabel();
    updateKeyBtnLabel();
    const doneMsg = speedChanging
      ? tr('studio.p.speedApplied', { pct: Math.round(factor * 100) })
      : tr('studio.p.keyApplied', { semi: (semitones > 0 ? '+' : '') + semitones });
    report(total, total, doneMsg);
    if (!opts.fromLoad) { markDirty(); flashTake(doneMsg); }
    return 'ok';
  } catch (e) {
    flashTake(tr('studio.m.speedFail', { err: (e && e.message) || e }));
    return 'error';
  } finally { _speedBusy = false; }
}
async function applySpeed(factor, opts = {}) { return applyTransform(factor, _keySemitones, opts); }
async function applyKeyShift(semitones, opts = {}) { return applyTransform(_speed, semitones, opts); }
// 단축키 버튼 왼쪽의 "스템 속도" 버튼 — 팝업(daw-modal, 전체를 덮어서 처리 중엔 다른 조작이
// 안 되게 막는다)에서 속도를 먼저 정하고 "처리 시작"을 눌러야 실제로 돈다(숫자 스핀 화살표
// 누를 때마다 매번 다시 늘이던 예전 방식은 원하지 않는 값에서도 무겁게 여러 번 돎).
function openSpeedModal() {
  if (!_stemPaths) return;
  const host = $('daw-modal');
  const pct0 = Math.round((_speed || 1) * 100);
  host.innerHTML = `<div class="daw-modal-box daw-speed-modal">
    <div class="daw-modal-h"><span>${tr('studio.h.speedBtn')}</span><button class="x" id="stsp-close">✕</button></div>
    <div class="daw-speed-body">
      <div id="stsp-setup">
        <div class="daw-speed-row">
          <span class="daw-speed-lab">${tr('studio.d.speedLabel')}</span>
          <input type="number" id="stsp-val" min="50" max="150" step="5" value="${pct0}">
          <span class="daw-speed-pct">%</span>
          <button id="stsp-start" class="btn pri">${tr('studio.d.speedStart')}</button>
        </div>
        <div id="stsp-err" class="daw-speed-err" hidden></div>
      </div>
      <div id="stsp-progress" hidden>
        <div class="daw-speed-barwrap"><div id="stsp-bar" class="daw-speed-bar"></div></div>
        <div id="stsp-status" class="daw-speed-status"></div>
        <button id="stsp-cancel" class="btn">${tr('studio.d.speedCancel')}</button>
      </div>
    </div>
  </div>`;
  host.hidden = false;
  const close = () => { host.hidden = true; };
  // onclick(할당) 을 쓴다 — addEventListener 로 매번 열 때마다 새로 걸면(#daw-modal 자체는
  // innerHTML 이 바뀔 뿐 계속 같은 엘리먼트라) 리스너가 쌓여서, 몇 번 여닫은 뒤엔 예전
  // 호출(그땐 아직 안 막혔던)까지 섞여 뜻대로 안 닫히는 경우가 생길 수 있었다 — 할당은
  // 항상 마지막 것 하나로 덮어써서 그럴 일이 없다.
  $('stsp-close').onclick = () => { if (!_speedBusy) close(); };
  // 배경 클릭으로 닫기 — 처리 중엔 취소 버튼으로만 나가게 막는다.
  host.onclick = (e) => { if (e.target === host && !_speedBusy) close(); };
  $('stsp-start').addEventListener('click', async () => {
    const v = Math.max(50, Math.min(150, Number($('stsp-val').value) || 100));
    $('stsp-val').value = v;
    if (_takes.length) {
      const err = $('stsp-err'); err.textContent = tr('studio.m.speedBlockedByTakes'); err.hidden = false;
      return;
    }
    $('stsp-setup').hidden = true;
    $('stsp-progress').hidden = false;
    _speedCancelRequested = false;
    setEnabled(false);   // 완료·취소 전까지 다른 조작 다 막는다(요청)
    const ok = await applySpeed(v / 100, {
      onProgress: (done, total, label) => {
        $('stsp-bar').style.width = Math.round((done / total) * 100) + '%';
        $('stsp-status').textContent = label;
      },
      isCancelled: () => _speedCancelRequested,
    });
    setEnabled(_started);   // 엔진이 그새 끊기지 않았으면 원래대로 다시 켠다
    if (ok === 'cancelled') $('stsp-status').textContent = tr('studio.p.speedCancelled');
    setTimeout(close, ok === 'cancelled' ? 500 : 400);
  });
  $('stsp-cancel').addEventListener('click', () => {
    _speedCancelRequested = true;
    $('stsp-cancel').disabled = true;
    $('stsp-status').textContent = tr('studio.p.speedCancelling');
  });
}
// "스템 키" 버튼 — openSpeedModal 과 같은 패턴(daw-modal 팝업에서 값을 먼저 정하고
// "처리 시작"을 눌러야 실제로 돈다). 라이브러리 미리듣기 플레이어에 이미 있던
// 반음 단위 키 조절(pitch-shift.js)을 스튜디오 스템 전체에도 그대로 적용한 것 —
// 비디오·원곡에는 영향 없이 스템 오디오에만 반영된다.
function openKeyModal() {
  if (!_stemPaths) return;
  const host = $('daw-modal');
  const semi0 = _keySemitones || 0;
  host.innerHTML = `<div class="daw-modal-box daw-speed-modal">
    <div class="daw-modal-h"><span>${tr('studio.h.keyBtn')}</span><button class="x" id="stky-close">✕</button></div>
    <div class="daw-speed-body">
      <div id="stky-setup">
        <div class="daw-speed-row">
          <span class="daw-speed-lab">${tr('studio.d.keyLabel')}</span>
          <input type="number" id="stky-val" min="-6" max="6" step="1" value="${semi0}">
          <span class="daw-speed-pct">${tr('studio.d.keyUnit')}</span>
          <button id="stky-start" class="btn pri">${tr('studio.d.speedStart')}</button>
        </div>
        <div id="stky-err" class="daw-speed-err" hidden></div>
      </div>
      <div id="stky-progress" hidden>
        <div class="daw-speed-barwrap"><div id="stky-bar" class="daw-speed-bar"></div></div>
        <div id="stky-status" class="daw-speed-status"></div>
        <button id="stky-cancel" class="btn">${tr('studio.d.speedCancel')}</button>
      </div>
    </div>
  </div>`;
  host.hidden = false;
  const close = () => { host.hidden = true; };
  $('stky-close').onclick = () => { if (!_speedBusy) close(); };
  host.onclick = (e) => { if (e.target === host && !_speedBusy) close(); };
  $('stky-start').addEventListener('click', async () => {
    const v = Math.max(-6, Math.min(6, Math.round(Number($('stky-val').value) || 0)));
    $('stky-val').value = v;
    $('stky-setup').hidden = true;
    $('stky-progress').hidden = false;
    _speedCancelRequested = false;
    setEnabled(false);
    const ok = await applyKeyShift(v, {
      onProgress: (done, total, label) => {
        $('stky-bar').style.width = Math.round((done / total) * 100) + '%';
        $('stky-status').textContent = label;
      },
      isCancelled: () => _speedCancelRequested,
    });
    setEnabled(_started);
    if (ok === 'cancelled') $('stky-status').textContent = tr('studio.p.speedCancelled');
    setTimeout(close, ok === 'cancelled' ? 500 : 400);
  });
  $('stky-cancel').addEventListener('click', () => {
    _speedCancelRequested = true;
    $('stky-cancel').disabled = true;
    $('stky-status').textContent = tr('studio.p.speedCancelling');
  });
}

function flashTake(msg) {   // 하단 로그 대신 잠깐 뜨는 토스트
  let t = document.getElementById('daw-toast');
  if (!t) { t = document.createElement('div'); t.id = 'daw-toast'; t.className = 'daw-toast'; (document.querySelector('.daw') || document.body).appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

let _takes = [];   // [{ id, file, start(sec), dur(sec), svg }]

// ── 악기 트랙 · MIDI 클립 · 타이핑 키보드 ─────────────────────────────
// 클립·노트 시간은 초 단위로 들고 있다가 엔진엔 샘플로 바꿔 보낸다(midiClipForEngine). 노트 t 는
// 클립 시작 기준. 편집은 클립 통째로(이동·복제·삭제·퀀타이즈) — 노트 하나하나는 2차(피아노롤).
let _midiClips = [];   // [{ id, trackId, start, dur, notes:[{t,d,p,v}] }]
let _selMidi = null;   // 선택된 MIDI 클립 id(오디오 클립 선택과는 따로 — 둘 중 하나만)
const QUANT_KEY = 'yss:midiQuant';
let _quant = (() => {
  const def = { div: '1/16', strength: 1, onRec: false };
  try { const v = JSON.parse(localStorage.getItem(QUANT_KEY) || '{}'); return { ...def, ...v, div: QUANT_DIVS[v.div] ? v.div : def.div }; } catch { return def; }
})();
function saveQuant() { try { localStorage.setItem(QUANT_KEY, JSON.stringify(_quant)); } catch {} }
const midiSnapshot = (c) => ({ ...c, notes: c.notes.map(n => ({ ...n })) });
function pushMidiClip(c) { api.engine.midiClip(midiClipForEngine(c, deviceSr())); }
function addMidiClip(c, id) {
  const clip = { trackId: c.trackId, start: Math.max(0, c.start), dur: Math.max(0.05, c.dur), notes: c.notes.map(n => ({ ...n })), id: id != null ? id : nextClipId() };
  _midiClips.push(clip); pushMidiClip(clip);
  return clip;
}
function removeMidiClip(id) {
  if (_pr && _pr.clipId === id) _pr.close();
  _midiClips = _midiClips.filter(c => c.id !== id);
  api.engine.midiClipRemove(id);
  if (_selMidi === id) _selMidi = null;
}
// 실행취소용 — 스냅샷 그대로 되돌린다(없으면 다시 만든다)
function setMidiClipState(snap) {
  const v = midiSnapshot(snap);
  const i = _midiClips.findIndex(c => c.id === v.id);
  if (i >= 0) _midiClips[i] = v; else _midiClips.push(v);
  pushMidiClip(v); renderTakes(); layout(); markDirty();
}
function selectMidiClip(id) {
  if (_selClips.size) { _selClips = new Set(); _selClipId = null; }
  _selMidi = id;
  document.querySelectorAll('.daw-take-clip.sel').forEach(x => x.classList.remove('sel'));
  document.querySelector(`.daw-midi-clip[data-midi-id="${id}"]`)?.classList.add('sel');
}
function renderMidiClips(areas) {
  for (const c of _midiClips) {
    const area = areas[c.trackId]; if (!area) continue;
    const el = document.createElement('div');
    el.className = 'daw-take-clip daw-midi-clip' + (_selMidi === c.id ? ' sel' : '');
    el.dataset.midiId = String(c.id);
    el.style.left = (c.start * _pxPerSec) + 'px';
    el.style.width = Math.max(3, c.dur * _pxPerSec) + 'px';
    const nameBar = document.createElement('div');
    nameBar.className = 'daw-clip-namebar';
    const nameLbl = document.createElement('div');
    nameLbl.className = 'daw-clip-name';
    nameLbl.textContent = tr('studio.midi.clipName', { n: c.notes.length });
    nameBar.appendChild(nameLbl);
    el.appendChild(nameBar);
    // 노트 미리보기 — 클립 안에서 가장 낮은 음~높은 음을 세로로 펼친다(최소 1옥타브 폭)
    const box = document.createElement('div');
    box.className = 'daw-midi-notes';
    if (c.notes.length) {
      let lo = 127, hi = 0;
      for (const n of c.notes) { if (n.p < lo) lo = n.p; if (n.p > hi) hi = n.p; }
      const span = Math.max(12, hi - lo + 1);
      const top = hi + Math.floor((span - (hi - lo + 1)) / 2);
      const hPct = 100 / span;
      let html = '';
      for (const n of c.notes) {
        if (n.t >= c.dur) continue;
        const w = Math.max(2, Math.min(n.d, c.dur - n.t) * _pxPerSec);
        html += `<i style="left:${(n.t * _pxPerSec).toFixed(1)}px;width:${w.toFixed(1)}px;top:${((top - n.p) * hPct).toFixed(2)}%;height:max(2px,${hPct.toFixed(2)}%)"></i>`;
      }
      box.innerHTML = html;
    }
    el.appendChild(box);
    el.title = tr('studio.midi.clipTitle');
    el.addEventListener('click', (e) => e.stopPropagation());
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); selectMidiClip(c.id); showMidiMenu(e.clientX, e.clientY, c.id); });
    el.addEventListener('dblclick', (e) => { e.stopPropagation(); openMidiEditor(c.id); });
    // 오른쪽 끝 = 클립 길이(격자 스냅). 넘치는 노트는 클립 끝에서 끊겨 들린다.
    const hR = document.createElement('div'); hR.className = 'daw-trim r'; el.appendChild(hR);
    hR.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      selectMidiClip(c.id);
      const startX = e.clientX, dur0 = c.dur, before = midiSnapshot(c);
      const move = (ev) => {
        const endAbs = snapSec(c.start + dur0 + (ev.clientX - startX) / _pxPerSec, !magnetActiveFor(ev));
        c.dur = Math.max(0.1, endAbs - c.start);
        el.style.width = Math.max(3, c.dur * _pxPerSec) + 'px';
      };
      const up = () => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
        if (c.dur === dur0) return;
        pushMidiClip(c); renderTakes(); layout();
        const after = midiSnapshot(c);
        pushUndo(() => setMidiClipState(before), () => setMidiClipState(after), tr('studio.u.clipTrim'));
        markDirty();
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      selectMidiClip(c.id); selectTrack(c.trackId);
      const startX = e.clientX, base = c.start, before = midiSnapshot(c);
      let dragging = false;
      const move = (ev) => {
        if (!dragging && Math.abs(ev.clientX - startX) < 4) return;
        dragging = true;
        c.start = snapSec(base + (ev.clientX - startX) / _pxPerSec, !magnetActiveFor(ev));
        el.style.left = (c.start * _pxPerSec) + 'px';
        showDragBadge(c.start - base, ev.clientX, ev.clientY);
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        document.removeEventListener('pointercancel', up);
        hideDragBadge();
        if (!dragging) { if (!_recArmed) seekToClientX(startX); return; }
        if (c.start === base) return;
        pushMidiClip(c); layout();
        const after = midiSnapshot(c);
        pushUndo(() => setMidiClipState(before), () => setMidiClipState(after), tr('studio.u.clipMove'));
        markDirty();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    area.appendChild(el);
  }
}
function showMidiMenu(x, y, id) {
  openDropdownAt(x, y, [
    { label: tr('studio.midi.openPianoRoll'), fn: () => openMidiEditor(id) },
    { label: tr('studio.midi.quantizeNow', { div: _quant.div }), fn: () => quantizeMidiClip(id) },
    { label: tr('studio.midi.quantSettings'), fn: () => openQuantPopoverAt(x, y) },
    { label: tr('studio.midi.duplicate'), fn: () => duplicateMidiClip(id) },
    { label: tr('studio.midi.delete'), fn: () => { _selMidi = id; deleteSelectedMidi(); } },
  ]);
}
function quantizeMidiClip(id) {
  const c = _midiClips.find(x => x.id === id); if (!c || !c.notes.length) return;
  const before = midiSnapshot(c);
  c.notes = quantizeNotes(c.notes, c.start, _gridOffset, quantStepSec(_quant.div, secPerBeat()), _quant.strength);
  pushMidiClip(c); renderTakes();
  const after = midiSnapshot(c);
  pushUndo(() => setMidiClipState(before), () => setMidiClipState(after), tr('studio.midi.quantize'));
  markDirty();
  flashTake(tr('studio.midi.quantized', { div: _quant.div }));
}
function duplicateMidiClip(id) {
  const c = _midiClips.find(x => x.id === id); if (!c) return;
  const nc = addMidiClip({ ...c, start: c.start + c.dur });
  selectMidiClip(nc.id); renderTakes(); layout();
  const snap = midiSnapshot(nc);
  pushUndo(() => { removeMidiClip(snap.id); renderTakes(); }, () => setMidiClipState(snap), tr('studio.midi.duplicate'));
  markDirty();
}
function deleteSelectedMidi() {
  const c = _midiClips.find(x => x.id === _selMidi); if (!c) return false;
  const snap = midiSnapshot(c);
  removeMidiClip(c.id); renderTakes(); layout();
  pushUndo(() => setMidiClipState(snap), () => { removeMidiClip(snap.id); renderTakes(); }, tr('studio.u.clipDelete'));
  markDirty();
  return true;
}
// 엔진이 모은 녹음 노트 → 클립 하나. 음을 하나도 안 쳤으면 클립을 만들지 않는다.
function onMidiTake(m) {
  clearMidiLive();
  const clip = clipFromMidiTake(m, deviceSr());
  if (!clip || !_recTracks.some(r => r.id === m.trackId)) return;
  if (_quant.onRec) clip.notes = quantizeNotes(clip.notes, clip.start, _gridOffset, quantStepSec(_quant.div, secPerBeat()), _quant.strength);
  const c = addMidiClip({ trackId: m.trackId, ...clip });
  renderTakes(); layout();
  const snap = midiSnapshot(c);
  pushUndo(() => { removeMidiClip(snap.id); renderTakes(); layout(); }, () => setMidiClipState(snap), tr('studio.lbl.record'));
  markDirty();
}
function openQuantPopoverAt(x, y) {
  document.querySelector('.daw-ctx')?.remove();
  const divOpts = Object.keys(QUANT_DIVS).map(d => `<option value="${d}" ${d === _quant.div ? 'selected' : ''}>${d.replace('T', ' ' + tr('studio.midi.triplet'))}</option>`).join('');
  const pop = document.createElement('div');
  pop.className = 'daw-ctx daw-in-pop';
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  pop.innerHTML = `
    <div class="daw-op-row"><span class="lbl">${tr('studio.midi.grid')}</span><select class="q-div">${divOpts}</select></div>
    <div class="daw-op-row"><span class="lbl">${tr('studio.midi.strength')}</span><input class="q-str" type="range" min="10" max="100" step="10" value="${Math.round(_quant.strength * 100)}"><span class="q-str-v">${Math.round(_quant.strength * 100)}%</span></div>
    <div class="daw-op-row"><label><input type="checkbox" class="q-rec" ${_quant.onRec ? 'checked' : ''}> ${tr('studio.midi.quantOnRec')}</label></div>`;
  document.body.appendChild(pop);
  const r = pop.getBoundingClientRect(), m = 8;
  if (r.right > innerWidth - m) pop.style.left = Math.max(m, innerWidth - r.width - m) + 'px';
  if (r.bottom > innerHeight - m) pop.style.top = Math.max(m, y - r.height) + 'px';
  pop.querySelector('.q-div').addEventListener('change', (e) => { _quant.div = e.target.value; saveQuant(); });
  pop.querySelector('.q-str').addEventListener('input', (e) => { _quant.strength = Number(e.target.value) / 100; pop.querySelector('.q-str-v').textContent = e.target.value + '%'; saveQuant(); });
  pop.querySelector('.q-rec').addEventListener('change', (e) => { _quant.onRec = e.target.checked; saveQuant(); });
  const close = (ev) => { if (pop.contains(ev.target)) return; pop.remove(); document.removeEventListener('mousedown', close); };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// 타이핑 키보드 연주 — 켜져 있는 동안 건반 키는 스튜디오 단축키(S 분할·R 녹음 등)보다 먼저 가로챈다.
// Space(재생)·Delete·Ctrl 조합(실행취소·저장)은 그대로 둔다. ←/→ 옥타브, Esc 끄기.
let _kbOn = false, _kbOct = 0;
const _kbHeld = new Map();   // code → { track, pitch } — 뗄 때 같은 음을 끄려고(옥타브를 바꿔도)
// 연주 대상 = 지금 선택한 악기 트랙. 다른(녹음·오디오·스템) 트랙을 고르면 연주 모드도 꺼진다.
function kbTargetTrack() { return _recTracks.find(r => r.id === _selTrack && r.type === 2) || null; }
// 하단바 ⌨·Q 버튼 — 악기 트랙을 선택했을 때만 켠다(일반 녹음 트랙엔 의미가 없다)
function updateKbButtons() {
  const ok = !!(_started && kbTargetTrack());
  for (const id of ['st-kb', 'st-kb-cfg']) { const el = $(id); if (el) el.disabled = !ok; }
  if (!ok && _kbOn) { setKbMode(false); return; }
  syncKbButtons(); renderKbHud();   // 다른 악기 트랙을 고르면 켜짐 표시·HUD 도 그 트랙으로
}
// 켜짐 표시만 갈아끼운다 — 레인을 다시 그리면 헤드를 누르는 도중(선택→여기) 버튼 클릭이 씹힌다
function syncKbButtons() {
  const tid = _kbOn ? kbTargetTrack()?.id : null;
  const b = $('st-kb'); if (b) { b.classList.toggle('on', _kbOn); b.setAttribute('aria-pressed', String(_kbOn)); }
  document.querySelectorAll('.daw-lane-instr [data-m="kb"]').forEach(btn => {
    const on = tid != null && Number(btn.closest('.daw-lane')?.dataset.recid) === tid;
    btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on));
  });
}
// 악기 트랙을 골라 두고 녹음을 켰을 때 — 연주 모드가 꺼져 있으면 쳐도 아무것도 안 들어가고,
// R 을 꺼 뒀으면(새 악기 트랙은 켜진 채 시작해서, "녹음 켜기"로 눌렀다가 오히려 끄기 쉽다)
// 그 트랙엔 기록이 안 된다. 둘 다 "녹음이 가끔 안 된다"로 보였던 경우라 여기서 잡아 준다.
function addEmptyMidiClip(trackId, atSec) {
  const bar = secPerBar();
  let start = _gridOffset + Math.floor((atSec - _gridOffset) / bar) * bar;   // 누른 자리의 마디 시작
  if (start < 0) start += bar * Math.ceil(-start / bar);
  const c = addMidiClip({ trackId, start, dur: bar, notes: [] });
  selectTrack(trackId); selectMidiClip(c.id); renderTakes(); layout();
  const snap = midiSnapshot(c);
  pushUndo(() => { removeMidiClip(snap.id); renderTakes(); layout(); }, () => setMidiClipState(snap), tr('studio.midi.addEmptyClip'));
  markDirty();
  openMidiEditor(c.id);
}
// ── 피아노롤 ──
let _pr = null;   // 열려 있는 피아노롤(하나만)
function openMidiEditor(id) {
  _pr?.close();
  const find = () => _midiClips.find(x => x.id === id);
  const c0 = find(); if (!c0) return;
  const rt = _recTracks.find(r => r.id === c0.trackId) || {};
  selectMidiClip(id); selectTrack(c0.trackId);
  _pr = openPianoRoll({
    host: document.querySelector('.daw-content'),
    getClip: find,
    color: resolveColor(rt.color || 'var(--accent)'),
    stepSec: () => quantStepSec(_quant.div, secPerBeat()),
    origin: () => _gridOffset,
    secPerBar,
    divs: Object.keys(QUANT_DIVS),
    quantLabel: () => _quant.div,
    setDiv: (d) => { _quant.div = d; saveQuant(); },
    title: () => { const cc = find(); return cc ? `${selTrackLabel(cc.trackId)} · ${tr('studio.midi.clipName', { n: cc.notes.length })}` : ''; },
    tr,
    onCommit: (before) => {
      const c = find(); if (!c) return;
      pushMidiClip(c); renderTakes(); layout();
      const after = midiSnapshot(c);
      pushUndo(() => setMidiClipState(before), () => setMidiClipState(after), tr('studio.pr.edit'));
      markDirty();
    },
    onPreview: (p, on, v) => { const c = find(); if (!c) return; if (on) api.engine.noteOn(c.trackId, p, v || 0.8); else api.engine.noteOff(c.trackId, p); },
    onQuantize: () => quantizeMidiClip(id),
    flash: (m) => flashTake(m),
    onSeek: (sec) => {   // 피아노롤 눈금자 — 녹음 중엔 재생 위치를 못 옮긴다(타임라인과 같은 규칙)
      if (_recArmed) return;
      const t = Math.max(0, sec);
      api.engine.seek(secToSamples(t)); syncVideo(t); updatePlayhead(t);
      const c = find(); if (c) _pr?.setPlayhead(t - c.start);
    },
    onPlay: () => {
      if (_playing) { stopStudio(); return; }
      const c = find(); if (!c) return;
      if (!_recArmed) { api.engine.seek(secToSamples(c.start)); syncVideo(c.start); updatePlayhead(c.start); }
      playStudio();
    },
    // 임시 솔로 — 엔진에만 보낸다. 트랙의 저장된 솔로 상태(rt.solo)는 안 바꾸고, 끌 때 그 값으로 되돌린다.
    onSolo: (on) => {
      const c = find(); if (!c) return;
      const rt = _recTracks.find(r => r.id === c.trackId); if (!rt) return;
      api.engine.recTrack(rt.id, { solo: on ? true : !!rt.solo });
    },
    onClose: () => { _pr = null; },
  });
  if (_pr) { const c = find(); _pr.setPlayhead((_lastSec || 0) - c.start); _pr.setPlaying(_playing); }
}
// S = 재생선 위치에서 선택한 MIDI 클립을 둘로. 걸쳐 있는 노트는 앞 클립에서 자르고 뒤 클립엔 안 넣는다.
function splitSelectedMidi() {
  const c = _midiClips.find(x => x.id === _selMidi); if (!c) return false;
  const cut = (_lastSec || 0) - c.start;
  if (cut <= 0.01 || cut >= c.dur - 0.01) { flashTake(tr('studio.m.selectClipToSplit')); return true; }
  const before = midiSnapshot(c);
  const right = { trackId: c.trackId, start: c.start + cut, dur: c.dur - cut,
    notes: c.notes.filter(n => n.t >= cut).map(n => ({ ...n, t: n.t - cut })) };
  c.notes = c.notes.filter(n => n.t < cut).map(n => ({ ...n, d: Math.min(n.d, cut - n.t) }));
  c.dur = cut;
  pushMidiClip(c);
  const nc = addMidiClip(right);
  renderTakes(); layout();
  const leftAfter = midiSnapshot(c), rightSnap = midiSnapshot(nc);
  pushUndo(() => { removeMidiClip(rightSnap.id); setMidiClipState(before); },
           () => { setMidiClipState(leftAfter); setMidiClipState(rightSnap); }, tr('studio.u.clipSplit'));
  markDirty();
  return true;
}

// ── MIDI 녹음 실시간 미리보기 ──
// 엔진은 녹음을 멈춰야 노트를 넘겨준다(midiTake). 그 전까지는 치는 대로 여기서 그려 둔다 —
// 오디오 녹음의 실시간 파형(updateRecLive)과 같은 역할. 멈추면 진짜 클립으로 갈아끼운다.
let _midiLive = null;   // { trackId, start, now, at, notes:[{p,t0,t1}] } — 초
let _midiLiveRaf = 0;
function midiLiveTrack() { const t = kbTargetTrack(); return t && t.armed ? t : null; }
function midiLiveNow() { const L = _midiLive; return L ? L.now + (_playing ? (performance.now() - L.at) / 1000 : 0) : 0; }
function updateMidiLive(t) {
  const lt = midiLiveTrack(); if (!lt) return;
  if (!_midiLive || _midiLive.trackId !== lt.id) _midiLive = { trackId: lt.id, start: t, now: t, at: performance.now(), notes: [] };
  _midiLive.now = t; _midiLive.at = performance.now();
  drawMidiLive();   // 창이 가려져 rAF 가 멈춰도 재생 위치(20Hz)마다는 그린다
  if (!_midiLiveRaf) {   // 재생 위치는 20Hz 로 오지만 막대는 매 프레임 늘려야 매끄럽다
    const tick = () => { if (!_midiLive || !_recArmed || !_playing) { _midiLiveRaf = 0; return; } drawMidiLive(); _midiLiveRaf = requestAnimationFrame(tick); };
    _midiLiveRaf = requestAnimationFrame(tick);
  }
}
function drawMidiLive() {
  const L = _midiLive; if (!L) return;
  const area = document.querySelector(`.daw-lane-rec[data-recid="${L.trackId}"] .daw-area`); if (!area) return;
  let el = area.querySelector('.daw-midi-live');
  if (!el) { el = document.createElement('div'); el.className = 'daw-take-clip daw-midi-clip daw-midi-live'; el.innerHTML = '<div class="daw-midi-notes"></div>'; area.appendChild(el); }
  const now = midiLiveNow();
  el.style.left = (L.start * _pxPerSec) + 'px';
  el.style.width = Math.max(3, (now - L.start) * _pxPerSec) + 'px';
  const box = el.firstChild;
  if (!L.notes.length) { box.innerHTML = ''; return; }
  let lo = 127, hi = 0;
  for (const n of L.notes) { if (n.p < lo) lo = n.p; if (n.p > hi) hi = n.p; }
  const span = Math.max(12, hi - lo + 1), top = hi + Math.floor((span - (hi - lo + 1)) / 2), hPct = 100 / span;
  box.innerHTML = L.notes.map(n => {
    const x0 = (n.t0 - L.start) * _pxPerSec, w = Math.max(2, ((n.t1 != null ? n.t1 : now) - n.t0) * _pxPerSec);
    return `<i style="left:${x0.toFixed(1)}px;width:${w.toFixed(1)}px;top:${((top - n.p) * hPct).toFixed(2)}%;height:max(2px,${hPct.toFixed(2)}%)"></i>`;
  }).join('');
}
function midiLiveNote(pitch, on) {
  if (!_recArmed || !_playing) return;
  if (!_midiLive) updateMidiLive(_lastSec || 0);
  if (!_midiLive) return;
  const now = midiLiveNow();
  if (on) _midiLive.notes.push({ p: pitch, t0: now, t1: null });
  else { for (let i = _midiLive.notes.length - 1; i >= 0; i--) { const n = _midiLive.notes[i]; if (n.p === pitch && n.t1 == null) { n.t1 = now; break; } } }
  drawMidiLive();
}
function clearMidiLive() { _midiLive = null; document.querySelectorAll('.daw-midi-live').forEach(e => e.remove()); }
function midiRecAssist() {
  const sel = _recTracks.find(r => r.id === _selTrack && r.type === 2);
  if (!sel) return;
  if (!sel.armed) { flashTake(tr('studio.midi.recNotArmed')); return; }
  if (!_kbOn) setKbMode(true);
}
function kbReleaseAll() { for (const [code, h] of _kbHeld) { api.engine.noteOff(h.track, h.pitch); markKbKey(code, false); } _kbHeld.clear(); }
async function setKbMode(on) {
  if (on && !kbTargetTrack()) return;   // 악기 트랙을 선택했을 때만(버튼도 그때만 켜진다)
  _kbOn = !!on;
  if (!_kbOn) kbReleaseAll();
  syncKbButtons();
  renderKbHud();
  if (_kbOn) try { document.activeElement?.blur?.(); } catch {}   // 슬라이더에 포커스가 남아 있으면 화살표가 거기로 간다
}
// 실제 키보드 배열 가이드 — 어느 키가 어느 음인지 보여 주고, 누르는 키는 불이 들어온다.
// 줄마다 실제 키보드처럼 조금씩 밀려 있다(단위 = 키 폭).
const KB_GUIDE_ROWS = [
  { off: 0,    keys: [['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'], ['Minus', '-'], ['Equal', '=']] },
  { off: 0.5,  keys: [['KeyQ', 'Q'], ['KeyW', 'W'], ['KeyE', 'E'], ['KeyR', 'R'], ['KeyT', 'T'], ['KeyY', 'Y'], ['KeyU', 'U'], ['KeyI', 'I'], ['KeyO', 'O'], ['KeyP', 'P'], ['BracketLeft', '['], ['BracketRight', ']']] },
  { off: 0.75, keys: [['KeyA', 'A'], ['KeyS', 'S'], ['KeyD', 'D'], ['KeyF', 'F'], ['KeyG', 'G'], ['KeyH', 'H'], ['KeyJ', 'J'], ['KeyK', 'K'], ['KeyL', 'L'], ['Semicolon', ';'], ['Quote', "'"]] },
  { off: 1.25, keys: [['KeyZ', 'Z'], ['KeyX', 'X'], ['KeyC', 'C'], ['KeyV', 'V'], ['KeyB', 'B'], ['KeyN', 'N'], ['KeyM', 'M'], ['Comma', ','], ['Period', '.'], ['Slash', '/']] },
];
function kbGuideHtml() {
  return KB_GUIDE_ROWS.map(row => `<div class="kbg-row" style="--off:${row.off}">${row.keys.map(([code, cap]) => {
    const n = kbNoteFor(code, _kbOct);
    if (n == null) return `<span class="kbk none" data-code="${code}"><b>${esc(cap)}</b></span>`;
    const nm = noteName(n), black = nm.includes('#');
    const label = nm.startsWith('C') && !black ? nm : nm.replace(/-?\d+$/, '');   // 옥타브 숫자는 C 에만
    return `<span class="kbk ${black ? 'black' : 'white'}${_kbHeld.has(code) ? ' down' : ''}" data-code="${code}"><b>${esc(cap)}</b><i>${label}</i></span>`;
  }).join('')}</div>`).join('');
}
function markKbKey(code, down) { document.querySelector(`#daw-kb-hud .kbk[data-code="${code}"]`)?.classList.toggle('down', down); }
function renderKbHud() {
  let hud = $('daw-kb-hud');
  if (!_kbOn) { hud?.remove(); return; }
  if (!hud) { hud = document.createElement('div'); hud.id = 'daw-kb-hud'; hud.className = 'daw-kb-hud'; document.querySelector('.daw-tracks')?.appendChild(hud); }
  const t = kbTargetTrack();
  const lo = kbNoteFor('KeyZ', _kbOct), hi = kbNoteFor('BracketRight', _kbOct);
  hud.innerHTML = `<div class="kbg">${kbGuideHtml()}</div>`
    + `<div class="kbg-bar"><b>⌨ ${esc(t ? selTrackLabel(t.id) : '')}</b><span>${lo != null ? noteName(lo) : ''}–${hi != null ? noteName(hi) : 'G9'}</span>`
    + `<span class="k">←/→ ${tr('studio.midi.octave')}</span><span class="k">Esc ${tr('studio.midi.off')}</span></div>`;
}
function kbStudioActive() { const main = document.querySelector('main[data-view="studio"]'); return !!(main && !main.hidden && _started); }
const KB_SWALLOW = /^(Key|Digit|Comma|Period|Slash|Semicolon|Quote|Bracket|Minus|Equal|Backslash|Backquote)/;
function wireKeyboardPlay() {
  document.addEventListener('keydown', (e) => {
    if (!kbStudioActive()) return;
    const t = e.target;
    if (isTypingTarget(t)) return;   // 슬라이더에 포커스가 남아 있어도 단축키·연주는 된다
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!_kbOn) {   // 연주 모드가 아닐 땐 Q = 선택한 MIDI 클립 퀀타이즈만
      if (e.code === 'KeyQ' && _selMidi != null && !e.repeat) { e.preventDefault(); quantizeMidiClip(_selMidi); }
      return;
    }
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
    if (e.code === 'Escape') { stop(); setKbMode(false); return; }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      stop(); if (e.repeat) return;
      kbReleaseAll();
      _kbOct = Math.max(-3, Math.min(3, _kbOct + (e.code === 'ArrowRight' ? 1 : -1)));
      renderKbHud(); return;
    }
    const pitch = kbNoteFor(e.code, _kbOct);
    if (pitch == null) { if (KB_SWALLOW.test(e.code)) stop(); return; }
    stop();
    if (e.repeat || _kbHeld.has(e.code)) return;
    const tt = kbTargetTrack(); if (!tt) return;
    _kbHeld.set(e.code, { track: tt.id, pitch });
    api.engine.noteOn(tt.id, pitch, 0.8);
    markKbKey(e.code, true);
    midiLiveNote(pitch, true);
  }, true);
  document.addEventListener('keyup', (e) => {
    const h = _kbHeld.get(e.code); if (!h) return;
    _kbHeld.delete(e.code);
    api.engine.noteOff(h.track, h.pitch);
    markKbKey(e.code, false);
    midiLiveNote(h.pitch, false);
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);
  window.addEventListener('blur', () => { if (_kbHeld.size) kbReleaseAll(); });
}
async function renderTake(file, startSamples, engineId, trackId) {
  try {
    // 길이는 디코드한 버퍼가 실제로 몇 Hz 인지로 나눠야 한다. 그 레이트는 AudioContext 가 정하는 것이라
    // 엔진 장치 레이트와 다를 수 있고, 장치 레이트로 나누면 그 비율만큼 클립 길이가 틀어진다.
    const { stems, sampleRate: bufSr } = await loadStemFilesToBuffers({ take: file });
    const ch = stems.take;
    const tid = trackId != null ? trackId : armedRecId();
    const rt = _recTracks.find(r => r.id === tid) || {};
    const isAudio = rt.type === 1;   // 오디오 트랙 클립 = 다른 색
    const srcDur = ch[0].length / (bufSr || deviceSr());
    _takes.push({
      id: engineId != null ? engineId : Date.now(), file,
      trackId: tid,
      start: samplesToSec(startSamples || 0),
      inOff: 0, srcDur, dur: srcDur,   // 트림: inOff(소스 내 시작)·dur(가시 길이)·srcDur(전체)
      fadeIn: 0, fadeOut: 0,           // 페이드(초)
      // 파형은 svg 로 굳혀 두지 않는다 — waveCh(원본 채널)를 들고 있다가, 화면에 그릴 때
      // 지금 배율(waveAt)로 그렸는지 보고 바뀌었으면 그때 다시 그린다(renderTakes 안).
      waveCh: ch, waveColor: resolveColor(rt.color || (isAudio ? 'var(--stem-bass)' : 'var(--danger)')), svg: null, waveAt: 0,
    });
    renderTakes();
  } catch (e) { flashTake(tr('studio.m.takeWaveFail') + (e && e.message || e)); }
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
    el.dataset.clipId = String(tk.id);   // 선택 시 renderTakes() 가 DOM 을 통째로 새로 만들어서, 그 뒤에 이 요소를 다시 찾아야 한다
    el.style.left = (tk.start * _pxPerSec) + 'px';
    el.style.width = Math.max(3, tk.dur * _pxPerSec) + 'px';
    el.title = tk.file;
    // 파형 슬라이스: overflow 컨테이너 안에서 전체 소스 svg 를 inOff 만큼 밀기.
    // renderTakes 는 선택·드래그 같은 확대와 무관한 이유로도 자주 불린다 — 배율이 그대로면
    // 다시 그리지 않고 굳혀 둔 svg 를 그대로 쓴다. 바뀌었을 때만 이 take 하나만 새로 그린다.
    if (!tk.svg || tk.waveAt !== _pxPerSec) {
      tk.svg = tk.waveCh ? buildWaveSvg(tk.waveCh, tk.waveColor, waveN(tk.srcDur)) : '';
      tk.waveAt = _pxPerSec;
    }
    const wave = document.createElement('div');
    wave.className = 'daw-clip-wave';
    wave.style.left = (-tk.inOff * _pxPerSec) + 'px';
    wave.style.width = Math.max(3, tk.srcDur * _pxPerSec) + 'px';
    wave.innerHTML = tk.svg;
    el.appendChild(wave);
    // 클립에 저장된 실제 파일명(take_130.mp3 등) — 위쪽 이름 띠 안에, sticky 라 클립을
    // 오른쪽으로 스크롤해서 봐도(그 클립 구간 안에 있는 한) 계속 보인다.
    const nameBar = document.createElement('div');
    nameBar.className = 'daw-clip-namebar';
    const nameLbl = document.createElement('div');
    nameLbl.className = 'daw-clip-name';
    nameLbl.textContent = tk.file ? tk.file.replace(/\\/g, '/').split('/').pop() : '';
    nameBar.appendChild(nameLbl);
    el.appendChild(nameBar);
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
      // 핸들은 트림·페이드 — 단 Ctrl/Cmd 클릭은 다중선택이 우선이라 핸들이어도 그냥 통과시킨다
      if ((e.target.classList.contains('daw-trim') || e.target.classList.contains('daw-fadeh')) && !(e.ctrlKey || e.metaKey)) return;
      if (e.button !== 0) return;   // 우클릭은 컨텍스트 메뉴만 — 재생선·선택 건드리지 않음
      e.preventDefault(); e.stopPropagation();
      // 선택 관리 — Ctrl/Cmd = 토글(멀티), 그 외 = 미선택이면 단독 선택
      if (e.ctrlKey || e.metaKey) {
        if (_selClips.has(tk.id)) _selClips.delete(tk.id); else _selClips.add(tk.id);
        _selClipId = tk.id; selectTrack(tk.trackId); renderTakes();
        return;   // Ctrl-클릭은 선택만
      }
      // renderTakes() 는 DOM 을 통째로 지우고 새로 만든다 — 방금 그게 불렸다면 el 은 이미
      // 문서에서 떨어져 나간 죽은 노드다(el.style.left 를 계속 써도 화면엔 안 보이고,
      // el.closest(...) 는 항상 null). 새로 그려진 같은 클립 요소를 다시 찾아 그걸 쓴다.
      let liveEl = el;
      if (!_selClips.has(tk.id)) {
        _selClips = new Set([tk.id]); renderTakes();
        liveEl = document.querySelector(`.daw-take-clip[data-clip-id="${tk.id}"]`) || el;
      }
      _selClipId = tk.id; selectTrack(tk.trackId);
      const multi = _selClips.size > 1;
      const startX = e.clientX, base = tk.start;
      // 그룹 이동 대상 + 이전 상태 스냅샷
      const group = multi ? _takes.filter(t => _selClips.has(t.id)) : [tk];
      const befores = group.map(t => ({ id: t.id, st: clipState(t), base: t.start }));
      const excludeIds = new Set(group.map(t => t.id));   // 자기 자신·같이 끄는 클립엔 안 붙는다
      const srcLane = liveEl.closest('.daw-lane-rec');
      let target = srcLane, dragging = false;
      const move = (ev) => {
        if (!dragging && Math.abs(ev.clientX - startX) < 4) return;   // 임계값 전엔 클릭으로 취급
        dragging = true;
        const rawStart = base + (ev.clientX - startX) / _pxPerSec;
        // 대표(anchor) 클립 기준으로 자석을 계산하고, 그룹 전체엔 같은 델타를 적용한다
        // (격자 스냅도 원래 이 방식 — 델타 하나로 그룹을 같이 옮긴다).
        const active = magnetActiveFor(ev);
        const clipSnap = active ? snapClipStart(rawStart, tk.dur, excludeIds) : null;
        const dSnap = (clipSnap ? clipSnap.start : snapSec(rawStart, !active)) - base;
        group.forEach((t, i) => { t.start = Math.max(0, befores[i].base + dSnap); });
        if (clipSnap) showSnapLine(clipSnap.edgeAt);
        else hideSnapLine();
        if (multi) renderTakes();
        else liveEl.style.left = (tk.start * _pxPerSec) + 'px';   // 단일은 가볍게
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
        hideSnapLine();
        document.querySelectorAll('.daw-lane-rec.drop-target').forEach(l => l.classList.remove('drop-target'));
        if (!dragging) { if (!_recArmed) seekToClientX(startX); return; }   // 클릭 = 재생선 이동(클립 위에서도)
        const sr = deviceSr();
        if (!multi) {
          const newId = target ? Number(target.dataset.recid) : tk.trackId;
          if (newId && newId !== tk.trackId) {
            tk.trackId = newId;
            // 파형 색은 만들 때 트랙 색으로 굳혀서 캐싱해 둔다(svg 문자열에 fill 로 박혀 있다) —
            // 트랙만 바꾸고 이 캐시를 안 지우면 새 트랙 색이 반영 안 된 채 옛 색으로 계속
            // 그려진다(제보). 새 트랙 색으로 다시 계산하고 캐시를 비워 다시 그리게 한다.
            const nt = _recTracks.find(r => r.id === newId);
            if (nt) { tk.waveColor = resolveColor(nt.color || (nt.type === 1 ? 'var(--stem-bass)' : 'var(--danger)')); tk.svg = null; }
            api.engine.takeMove(tk.id, Math.round(tk.start * sr), newId);
          }
          else api.engine.takeMove(tk.id, Math.round(tk.start * sr), 0);
        } else group.forEach(t => api.engine.takeMove(t.id, Math.round(t.start * sr), 0));
        renderTakes();   // 새 트랙(레인)으로 DOM 도 옮기고, 색 캐시 비운 파형도 다시 그린다
        layout();   // 클립이 범위 밖으로 나가면 타임라인 연장 + 재배치
        const afters = group.map(t => ({ id: t.id, st: clipState(t) }));
        pushUndo(() => afters.forEach((a, i) => setClipState(befores[i].id, befores[i].st)),
                 () => afters.forEach(a => setClipState(a.id, a.st)), multi ? tr('studio.u.clipMoveMulti') : tr('studio.u.clipMove'));
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
      document.addEventListener('pointercancel', up);
    });
    area.appendChild(el);
  }
  renderMidiClips(areas);
  _pr?.refresh();   // 실행취소·퀀타이즈 등으로 클립이 바뀌면 열려 있는 피아노롤도 따라간다
}
const MIN_CLIP = 0.02;   // 최소 클립 길이(초)
// 트림 핸들: dir -1=좌, +1=우. 드래그로 inOff/dur 갱신, up 시 엔진 커밋
function wireTrim(handle, tk, el, wave, dir) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.ctrlKey || e.metaKey) return;   // Ctrl/Cmd 클릭은 트림 대신 다중선택으로 (버블시켜 클립 pointerdown 이 처리)
    e.preventDefault(); e.stopPropagation();
    selectTrack(tk.trackId); _selClipId = tk.id;
    const startX = e.clientX, bIn = tk.inOff, bDur = tk.dur, bStart = tk.start;
    // 움직이는 쪽 끝점의 원래 절대 시각 — 클립 이동과 같은 방식으로 여기에 그리드 스냅을 건다.
    // 스냅된 절대 위치에서 델타를 뽑아야, 이미 있던 경계 clamp(inOff<0 방지 등)를 그대로 쓸 수 있다.
    const anchorAbs = dir < 0 ? bStart : bStart + bDur;
    const before = clipState(tk);
    const move = (ev) => {
      const rawAbs = anchorAbs + (ev.clientX - startX) / _pxPerSec;
      let d = snapSec(rawAbs, !magnetActiveFor(ev)) - anchorAbs;   // 초, 그리드에 붙인 델타 (Alt = 해제)
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
      showDragBadge(d, ev.clientX, ev.clientY);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      hideDragBadge();
      commitTrim(tk); layout();
      const after = clipState(tk), id = tk.id;
      if (after.inOff !== before.inOff || after.dur !== before.dur || after.start !== before.start)
        pushUndo(() => setClipState(id, before), () => setClipState(id, after), tr('studio.u.clipTrim'));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
function commitTrim(tk) {
  const sr = deviceSr();
  api.engine.takeTrim(tk.id, Math.round(tk.start * sr), Math.round(tk.inOff * sr), Math.round(tk.dur * sr));
}
// 페이드 핸들: dir -1=인, +1=아웃. 코너 드래그로 길이 갱신, up 시 커밋
function wireFade(handle, tk, paint, dir) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.ctrlKey || e.metaKey) return;   // Ctrl/Cmd 클릭은 페이드 대신 다중선택으로 (버블시켜 클립 pointerdown 이 처리)
    e.preventDefault(); e.stopPropagation();
    selectTrack(tk.trackId); _selClipId = tk.id;
    const startX = e.clientX, bIn = tk.fadeIn, bOut = tk.fadeOut;
    // 페이드 안쪽 끝점(페이드가 끝나는 자리)의 절대 시각을 그리드에 붙인다 — 트림과 같은 방식.
    const anchorAbs = dir < 0 ? tk.start + bIn : tk.start + tk.dur - bOut;
    const before = clipState(tk);
    const move = (ev) => {
      const rawAbs = anchorAbs + (ev.clientX - startX) / _pxPerSec;
      const snappedAbs = snapSec(rawAbs, !magnetActiveFor(ev));
      if (dir < 0) tk.fadeIn  = Math.max(0, Math.min(tk.dur, snappedAbs - tk.start));
      else         tk.fadeOut = Math.max(0, Math.min(tk.dur, tk.start + tk.dur - snappedAbs));
      paint();
      showDragBadge(dir < 0 ? tk.fadeIn - bIn : tk.fadeOut - bOut, ev.clientX, ev.clientY);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      hideDragBadge();
      commitFade(tk);
      const after = clipState(tk), id = tk.id;
      if (after.fadeIn !== before.fadeIn || after.fadeOut !== before.fadeOut)
        pushUndo(() => setClipState(id, before), () => setClipState(id, after), tr('studio.u.fade'));
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
}
function commitFade(tk) {
  const sr = deviceSr();
  api.engine.takeFade(tk.id, Math.round(tk.fadeIn * sr), Math.round(tk.fadeOut * sr));
}
// 클립 복제 — 뒤로 dur 만큼 이어붙임
function duplicateClip(tk) {
  const id = nextClipId();
  const copy = { ...tk, id, start: tk.start + tk.dur };
  reAddClip(copy);
  pushUndo(() => removeClipById(id), () => reAddClip(copy), tr('studio.u.clipDuplicate'));
}
// 재생선 위치에서 선택 클립 분할
function splitSelectedAtPlayhead() {
  if (_selMidi != null && splitSelectedMidi()) return;
  const tk = _takes.find(t => t.id === _selClipId); if (!tk) { flashTake(tr('studio.m.selectClipToSplit')); return; }
  splitClip(tk, _lastSec);
}
function splitClip(tk, atSec) {
  const rel = atSec - tk.start;
  if (rel <= MIN_CLIP || rel >= tk.dur - MIN_CLIP) { flashTake(tr('studio.m.splitInsideOnly')); return; }
  const sr = deviceSr();
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
  }, doSplit, tr('studio.u.clipSplit'));
}
function showTakeMenu(x, y, id) {
  document.querySelector('.daw-ctx')?.remove();
  const menu = document.createElement('div');
  menu.className = 'daw-ctx';
  menu.style.left = x + 'px'; menu.style.top = y + 'px';
  menu.innerHTML = `<button class="split">${tr('studio.x.splitAtPlayhead')}</button><button class="dup">${tr('studio.x.duplicate')}</button><button class="del">${tr('studio.x.delete')}</button>`;
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
    if (removed) pushUndo(() => reAddClip(removed), () => removeClipById(id), tr('studio.u.clipDelete'));
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
// 클립 카드 투명도 — 룰러 위 버튼줄(자석 옆) ◐ 버튼을 클릭한 위치에 슬라이더 팝오버.
// 모든 트랙에 일괄 적용되는 화면 표시 설정이라(프로젝트 데이터 아님) #daw-lanes 에
// CSS 변수 하나로 걸고 localStorage 에 남겨 다음에 열어도 유지한다.
let _clipOpacity = Number(localStorage.getItem('yss:clipOpacity'));
if (!(_clipOpacity >= 0.15 && _clipOpacity <= 1)) _clipOpacity = 1;
function applyClipOpacity() { $('daw-lanes')?.style.setProperty('--op', _clipOpacity); }
function setClipOpacity(v) {
  _clipOpacity = Math.max(0.15, Math.min(1, v));
  localStorage.setItem('yss:clipOpacity', String(_clipOpacity));
  applyClipOpacity();
}
function openOpacityPopoverAt(x, y) {
  document.querySelector('.daw-ctx')?.remove();
  const pop = document.createElement('div');
  pop.className = 'daw-ctx daw-op-pop';
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  const v0 = Math.round(_clipOpacity * 100);
  pop.innerHTML = `<div class="daw-op-row">
    <span class="lbl">${tr('studio.t.clipOpacity')}</span>
    <input type="range" min="15" max="100" value="${v0}" class="daw-op-slider">
    <span class="val">${v0}%</span>
  </div>`;
  document.body.appendChild(pop);
  const r = pop.getBoundingClientRect(), m = 8;
  if (r.right > innerWidth - m) pop.style.left = Math.max(m, innerWidth - r.width - m) + 'px';
  if (r.bottom > innerHeight - m) pop.style.top = Math.max(m, y - r.height) + 'px';
  const slider = pop.querySelector('.daw-op-slider'), val = pop.querySelector('.val');
  slider.addEventListener('input', () => {
    val.textContent = slider.value + '%';
    setClipOpacity(Number(slider.value) / 100);
  });
  const close = (ev) => { if (pop.contains(ev.target)) return; pop.remove(); document.removeEventListener('mousedown', close); };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}
// 트랙별 입력 채널 팝오버 — 오디오 설정 모달의 모노/스테레오+채널 선택(openDevModal,
// dv-inmode/dv-chl/dv-chr)과 같은 모양을 트랙 하나에만 적용하는 축소판. 여러 트랙을
// 동시에 arm 해서 각자 다른 인풋으로 녹음할 때(실사용 문의) 이걸로 트랙마다 지정한다.
function openTrackInputPopoverAt(rt, x, y) {
  document.querySelector('.daw-ctx')?.remove();
  const chNames = (_inCfg.names && _inCfg.names.length)
    ? _inCfg.names
    : Array.from({ length: Math.max(1, _deviceInfo?.in || 1) }, (_, i) => tr('studio.p.inputN', { n: i + 1 }));
  const chOpts = (cur) => chNames.map((n, i) =>
    `<option value="${i}" ${i === cur ? 'selected' : ''}>${i + 1}. ${esc(n)}</option>`).join('');
  const mode = rt.inMode === 1 ? 1 : 0, chL = rt.inChL || 0, chR = rt.inChR != null ? rt.inChR : 1;
  const pop = document.createElement('div');
  pop.className = 'daw-ctx daw-in-pop';
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  pop.innerHTML = `
    <div class="daw-op-row"><span class="lbl">${tr('studio.x.inputMode')}</span>
      <select class="in-mode">
        <option value="0" ${mode === 1 ? '' : 'selected'}>${tr('studio.x.modeMono')}</option>
        <option value="1" ${mode === 1 ? 'selected' : ''}>${tr('studio.x.modeStereo')}</option>
      </select>
    </div>
    <div class="daw-op-row"><span class="lbl in-chl-lb">${mode === 1 ? tr('studio.lbl.leftChannel') : tr('studio.lbl.inputChannel')}</span>
      <select class="in-chl">${chOpts(chL)}</select>
    </div>
    <div class="daw-op-row in-chr-row" ${mode === 1 ? '' : 'hidden'}><span class="lbl">${tr('studio.x.rightChannel')}</span>
      <select class="in-chr">${chOpts(chR)}</select>
    </div>`;
  document.body.appendChild(pop);
  const r = pop.getBoundingClientRect(), m = 8;
  if (r.right > innerWidth - m) pop.style.left = Math.max(m, innerWidth - r.width - m) + 'px';
  if (r.bottom > innerHeight - m) pop.style.top = Math.max(m, y - r.height) + 'px';
  const push = () => api.engine.recTrackSetInput(rt.id, {
    mode: Number(pop.querySelector('.in-mode').value),
    chL: Number(pop.querySelector('.in-chl').value),
    chR: Number(pop.querySelector('.in-chr').value),
  });
  pop.querySelector('.in-mode').addEventListener('change', (e) => {
    const st = e.target.value === '1';
    pop.querySelector('.in-chr-row').hidden = !st;
    pop.querySelector('.in-chl-lb').textContent = st ? tr('studio.lbl.leftChannel') : tr('studio.lbl.inputChannel');
    push();
  });
  pop.querySelector('.in-chl').addEventListener('change', push);
  pop.querySelector('.in-chr').addEventListener('change', push);
  const close = (ev) => { if (pop.contains(ev.target)) return; pop.remove(); document.removeEventListener('mousedown', close); };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}
// 메트로놈 설정 팝오버 — 메트로놈도 녹음 여부 + 박자표(마디당 박 수) + 세분화(박 사이 잔클릭).
// openTrackInputPopoverAt 과 같은 뼈대(.daw-ctx, 바깥 클릭 시 닫힘).
function openMetroPopoverAt(x, y) {
  document.querySelector('.daw-ctx')?.remove();
  const beatOpts = Array.from({ length: 7 }, (_, i) => i + 2)   // 2박~8박
    .map(n => `<option value="${n}" ${n === _metroBeats ? 'selected' : ''}>${n}${tr('studio.x.beatsSuffix')}</option>`).join('');
  const subOpts = [
    [1, tr('studio.x.subdivNone')], [2, tr('studio.x.subdiv8th')],
    [3, tr('studio.x.subdivTriplet')], [4, tr('studio.x.subdiv16th')],
  ].map(([v, label]) => `<option value="${v}" ${v === _metroSubdiv ? 'selected' : ''}>${label}</option>`).join('');
  const pop = document.createElement('div');
  pop.className = 'daw-ctx daw-in-pop';
  pop.style.left = x + 'px'; pop.style.top = y + 'px';
  pop.innerHTML = `
    <div class="daw-op-row"><label><input type="checkbox" class="mt-bake" ${_metroBake ? 'checked' : ''}> ${tr('studio.x.metroBake')}</label></div>
    <div class="daw-op-row"><span class="lbl">${tr('studio.x.timeSig')}</span><select class="mt-beats">${beatOpts}</select></div>
    <div class="daw-op-row"><span class="lbl">${tr('studio.x.subdivision')}</span><select class="mt-subdiv">${subOpts}</select></div>`;
  document.body.appendChild(pop);
  const r = pop.getBoundingClientRect(), m = 8;
  if (r.right > innerWidth - m) pop.style.left = Math.max(m, innerWidth - r.width - m) + 'px';
  if (r.bottom > innerHeight - m) pop.style.top = Math.max(m, y - r.height) + 'px';
  pop.querySelector('.mt-bake').addEventListener('change', (e) => {
    _metroBake = e.target.checked;
    localStorage.setItem('yss:metroBake', _metroBake ? '1' : '0');
    api.engine.metroBake(_metroBake);
  });
  const pushPattern = () => {
    localStorage.setItem('yss:metroBeats', String(_metroBeats));
    localStorage.setItem('yss:metroSubdiv', String(_metroSubdiv));
    api.engine.metroPattern(_metroBeats, _metroSubdiv);
  };
  pop.querySelector('.mt-beats').addEventListener('change', (e) => { _metroBeats = Number(e.target.value); pushPattern(); });
  pop.querySelector('.mt-subdiv').addEventListener('change', (e) => { _metroSubdiv = Number(e.target.value); pushPattern(); });
  const close = (ev) => { if (pop.contains(ev.target)) return; pop.remove(); document.removeEventListener('mousedown', close); };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}
// ── 모달 ───────────────────────────────────────────
// 단축키 안내. 예전엔 트랙이 비어 있을 때만 뜨는 한 줄짜리 힌트(studio.e.shortcuts)뿐이라
// 곡을 불러온 뒤에는 다시 볼 방법이 없었고, 그마저도 Ctrl+C/X/V·Delete·Ctrl+Y·Ctrl+S 가
// 빠져 있었다. 여기 목록은 실제 keydown 처리기(아래 document.addEventListener)와 손으로
// 맞춰 둔 것이라 코드가 바뀌면 같이 고쳐야 한다 — 자동으로 뽑아내는 자리가 아니다.
function openShortcutsModal() {
  const rows = [
    ['Space', 'studio.sc.play'],
    ['R', 'studio.sc.record'],
    ['S', 'studio.sc.split'],
    ['⌨', 'studio.sc.kbPlay'],
    ['Q', 'studio.sc.quantize'],
    ['Delete', 'studio.sc.delete'],
    ['Ctrl+Z', 'studio.sc.undo'],
    ['Ctrl+Shift+Z', 'studio.sc.redo'],   // Ctrl+Y 도 그대로 먹지만(위 keydown 처리기), 더 널리 쓰는 쪽을 적는다
    ['Ctrl+C', 'studio.sc.copy'],
    ['Ctrl+X', 'studio.sc.cut'],
    ['Ctrl+V', 'studio.sc.paste'],
    ['Ctrl+S', 'studio.sc.save'],
    [tr('studio.sc.multiSelectKey'), 'studio.sc.multiSelect'],
    [tr('studio.sc.zoomKey'), 'studio.sc.zoom'],
    [tr('studio.sc.noSnapKey'), 'studio.sc.noSnap'],
  ];
  const html = rows.map(([key, descKey]) =>
    `<div class="daw-modal-kv"><kbd>${esc(key)}</kbd><span>${esc(tr(descKey))}</span></div>`).join('');
  openModal(tr('studio.sc.title'), html, () => {});
}
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
  // 같은 영상을 여러 모델로 분리해 둔 중복은 라이브러리 사이드바와 똑같은 기준(가장
  // 먼저 분리한 변형)으로 대표를 골라야 한다 — 예전엔 여기서 따로 만든 중복 제거가
  // 순서상 우연히 걸리는 아무 변형이나 대표로 골라서, 채보를 해 둔 변형이 아니라 채보
  // 안 된 다른 변형이 뜨는 사고가 났다(실사용 제보).
  const items = Library.getRepresentativeItems();
  if (!items.length) { openModal(tr('studio.d.pickSong'), `<div class="daw-modal-empty">${tr('studio.x.libEmpty')}</div>`, () => {}); return; }
  const groups = [...new Set(items.map(it => it.group).filter(Boolean))];
  const hasFav = items.some(it => it.favorite);
  // 즐겨찾기는 라이브러리 사이드바와 같은 관례로(library.js) 진짜 그룹이 아니라
  // "★ 즐겨찾기"라는 가상 그룹처럼 전체 다음에 얹는다.
  const chips = (groups.length || hasFav)
    ? `<div class="daw-modal-tabs"><button class="daw-mtab on" data-g="__all">${tr('studio.x.all')}</button>${
        hasFav ? `<button class="daw-mtab" data-g="__fav">${tr('studio.x.favorites')}</button>` : ''
      }${groups.map(g => `<button class="daw-mtab" data-g="${esc(g)}">${esc(g)}</button>`).join('')}</div>`
    : '';
  const row = (it, i) => `<div class="daw-modal-item" data-idx="${i}" data-g="${esc(it.group || '')}" data-fav="${it.favorite ? '1' : '0'}"><div class="mt"><div class="n">${it.favorite ? '★ ' : ''}${esc(it.name)}</div>
      <div class="m">${tr('studio.p.stemCount', { n: Object.keys(it.stemPaths || {}).length })}${it.group ? ' · ' + esc(it.group) : ''}</div></div></div>`;
  const host = $('daw-modal');
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>${tr('studio.d.pickSong')}</span><button class="x">✕</button></div>${chips}<div class="daw-modal-list">${items.map(row).join('')}</div></div>`;
  host.hidden = false;
  host.querySelector('.x').addEventListener('click', () => host.hidden = true);
  host.addEventListener('click', (e) => { if (e.target === host) host.hidden = true; }, { once: true });
  host.querySelectorAll('.daw-modal-item').forEach(el => el.addEventListener('click', () => { host.hidden = true; loadSong(items[Number(el.dataset.idx)]); }));
  host.querySelectorAll('.daw-mtab').forEach(b => b.addEventListener('click', () => {
    host.querySelectorAll('.daw-mtab').forEach(x => x.classList.remove('on')); b.classList.add('on');
    const g = b.dataset.g;
    host.querySelectorAll('.daw-modal-item').forEach(el => {
      const show = g === '__all' || (g === '__fav' ? el.dataset.fav === '1' : el.dataset.g === g);
      el.style.display = show ? '' : 'none';
    });
  }));
  // 칩이 넘칠 때(overflow-x:auto) 가로 스크롤바만 있고 세로 휠·드래그로는 안 움직이던 것
  // — 세로 휠을 가로로 돌려주고, 빈 자리를 잡고 끌면 스크롤되게 한다(사용자 제보).
  const tabsEl = host.querySelector('.daw-modal-tabs');
  if (tabsEl) {
    tabsEl.addEventListener('wheel', (e) => {
      if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;   // 넘칠 때만 가로채기 — 안 그러면 세로 스크롤이 필요한 다른 상황을 막는다
      e.preventDefault();
      tabsEl.scrollLeft += e.deltaY || e.deltaX;
    }, { passive: false });
    // pointerdown 에서 바로 setPointerCapture 를 잡으면(예전 버전) 칩을 그냥 클릭만
    // 해도(움직임 없이) 캡처가 걸려 그 밑 버튼의 click 합성이 안 되는 경우가 있다
    // (사용자 제보 — 그룹 칩이 눌러도 반응 없어짐). 그래서 실제로 문턱(4px)을 넘어
    // "진짜 드래그"로 확정된 순간에만 캡처를 잡는다 — 제자리 클릭은 캡처 자체가
    // 안 걸려서 버튼의 click 이 그대로 정상 발생한다.
    let pid = null, dragging = false, startX = 0, startLeft = 0;
    tabsEl.addEventListener('pointerdown', (e) => {
      pid = e.pointerId; dragging = false; startX = e.clientX; startLeft = tabsEl.scrollLeft;
    });
    tabsEl.addEventListener('pointermove', (e) => {
      if (pid == null || e.pointerId !== pid) return;
      const dx = e.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < 4) return;
        dragging = true;
        try { tabsEl.setPointerCapture(pid); } catch {}
      }
      tabsEl.scrollLeft = startLeft - dx;
    });
    const endDrag = (e) => {
      if (dragging) { try { tabsEl.releasePointerCapture(e.pointerId); } catch {} }
      pid = null; dragging = false;
    };
    tabsEl.addEventListener('pointerup', endDrag);
    tabsEl.addEventListener('pointercancel', endDrag);
  }
}

function openVstPicker() {
  if (_selTrack == null) { flashTake(tr('studio.m.selectRecTrack')); return; }
  if (!_plugins.length) { openModal(tr('studio.d.addVst'), `<div class="daw-modal-empty">${tr('studio.x.noVstFound')}</div>`, () => {}); return; }
  // 악기 VST 는 악기 트랙에서만 — 오디오 트랙에 넣으면 입력 소리를 지워 버린다. 악기 트랙에선 악기를 먼저 보여 준다.
  const selRt = _recTracks.find(r => r.id === _selTrack);
  const instrTrack = !!(selRt && selRt.type === 2);
  const list = instrTrack ? [..._plugins.filter(p => p.instrument), ..._plugins.filter(p => !p.instrument)] : _plugins.filter(p => !p.instrument);
  if (!list.length) { openModal(tr('studio.d.addVst'), `<div class="daw-modal-empty">${tr('studio.x.noVstFound')}</div>`, () => {}); return; }
  const html = list.map(p =>
    `<div class="daw-modal-item" data-idx="${p.index}"><div class="mt"><div class="n">${esc(p.name)}</div>
      <div class="m">${p.instrument ? tr('studio.midi.instrTag') + ' · ' : ''}${esc(p.manufacturer)}</div></div></div>`).join('');
  openModal(tr('studio.d.addVst'), html, (idx) => api.engine.fxAdd(_selTrack, Number(idx)));   // 선택 트랙에 추가
}

// ── 녹음(테이크 세트) 저장/불러오기 — 곡별, 이름 지정 ──
function takesetKey(k) { return 'yss:takesets:' + String(k).replace(/\\/g, '/').toLowerCase(); }
function getTakeSets() { if (!_songKey) return []; try { return JSON.parse(localStorage.getItem(takesetKey(_songKey)) || '[]'); } catch { return []; } }
function setTakeSets(a) { if (!_songKey) return; try { localStorage.setItem(takesetKey(_songKey), JSON.stringify(a)); } catch {} }
let _takeSetGather = null;
function saveTakeSet(name) {
  if (!_takes.length && !_midiClips.length) { flashTake(tr('studio.m.noRecordingToSave')); return; }
  // 트랙 레이아웃(개수·게인·뮤트·솔로) + 트랙별 FX 체인까지 통째로 저장
  const tracks = _recTracks.map(r => ({
    id: r.id, type: r.type || 0, gain: r.gain != null ? r.gain : 1, mute: !!r.mute, solo: !!r.solo,
    name: r.name || '', color: r.color || '', height: r.height || 0,
    fxOrder: (_chainByTrack[r.id] || []).map(s => ({ id: s.id, index: s.index, bypass: s.bypass })),
  }));
  const takes = _takes.map(t => ({ id: t.id, file: t.file, start: secToSamples(t.start), dur: t.dur, inOff: t.inOff || 0, srcDur: t.srcDur || t.dur, fadeIn: t.fadeIn || 0, fadeOut: t.fadeOut || 0, trackId: t.trackId }));
  const need = [];
  tracks.forEach(t => t.fxOrder.forEach(s => need.push({ track: t.id, id: s.id })));
  if (!need.length) { persistTakeSet(name, stripFxOrder(tracks), takes); return; }   // FX 없으면 바로 저장
  // FX 슬롯 상태(노브값)를 비동기로 모은 뒤 저장
  _takeSetGather = { name, tracks, takes, need: need.map(n => n.id), states: {} };
  flashTake(tr('studio.m.savingTakesFx'));
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
  // 프로젝트 파일과 같은 이유로 잰 레이트를 함께 남긴다 — takes[].start 가 샘플 단위다
  // MIDI 클립은 초 단위(레이트 무관) — 프로젝트 파일과 같은 형식
  const midiClips = _midiClips.map(c => ({ trackId: c.trackId, start: c.start, dur: c.dur, notes: c.notes.map(n => [n.t, n.d, n.p, n.v]) }));
  const a = getTakeSets(); a.push({ id: 't' + Date.now(), name, sampleRate: deviceSr(), tracks, takes, midiClips }); setTakeSets(a);
  flashTake(tr('studio.m.takeSetSaved') + name);
}
// recTracksReset 후 새 트랙 목록(generation 에코)까지 대기 — setInterval 폴링이 아니라
// recTracks 이벤트가 직접 깨운다. 창이 포커스를 잃으면(예: 파일 연결로 다른 프로그램 위에
// 열렸을 때) 크로미움이 배경 탭의 setInterval/setTimeout 을 강하게 죽인다 — 20ms 폴링은
// 몇 틱 돌다 그대로 멈춰서(실측: 601ms/30틱에서 멈춤) 이 함수가 사실상 영원히 응답이
// 없어 보였다. 엔진 IPC 메시지 도착은 이 타이머 제한을 안 타므로, 이벤트로 직접 풀면
// 창 포커스와 무관하게 즉시 풀린다. 폴백 setTimeout 도 마찬가지로 느려질 수 있지만,
// 정상 상황(엔진이 실제로 응답)에서는 그 폴백에 의존할 일이 없다.
function waitRecTracks(gen) {
  if (_recTracksGen === gen) return Promise.resolve(true);
  return new Promise((res) => {
    const w = { gen, done: false };
    w.resolve = (ok) => {
      if (w.done) return;
      w.done = true;
      clearTimeout(w.timer);
      _recTracksWaiters = _recTracksWaiters.filter(x => x !== w);
      res(ok);
    };
    // 2500ms 이던 걸 늘렸다 — "이어서 하기"(홈에서 최근 스튜디오 프로젝트 바로 열기)
    // 처럼 스튜디오 탭에 막 들어오자마자 프로젝트를 여는 경로에서는, 엔진이 아직 오디오
    // 장치도 못 연 상태로 이 recTracksReset 이 날아간다(엔진 시작은 initStudio() 안에서
    // await 없이 fire-and-forget). 그 상태에서 응답이 2.5초를 넘기면 여기서 통째로 포기하고
    // applyProject() 가 조기 return 해버려 뒤의 3) 클립(takes) 복원을 아예 안 탄다 —
    // 트랙은 비어 보이고 녹음 클립이 통째로 안 불러와지는 버그(실사용 제보)의 원인이었다.
    // 실측상 장치 연결에 5초 넘게 걸리는 경우가 있어 10초로 넉넉히 잡는다.
    w.timer = setTimeout(() => w.resolve(_recTracksGen === gen), 10000);
    _recTracksWaiters.push(w);
  });
}
let _loadingTakeSet = false;
async function loadTakeSet(ts) {
  if (_loadingTakeSet) return;   // 재진입 차단 (더블클릭 시 전역상태 오염 방지)
  _loadingTakeSet = true;
  const setSr = ts.sampleRate > 0 ? ts.sampleRate : 44100;   // 레이트를 안 적던 세트는 44.1k 로 본다
  try {
    api.engine.takeClear();
    _takes = []; _midiClips = []; _selMidi = null; api.engine.midiClear?.(); renderTakes();

    // 트랙 레이아웃 복원 (구버전 세트는 tracks 없음 → 현재 트랙 유지)
    let idMap = null;
    if (Array.isArray(ts.tracks) && ts.tracks.length) {
      _recTracks = [];   // stale 값으로 즉시 resolve 되지 않도록 비우고 이벤트로만 채움
      const gen = ++_recTracksGenReq;
      api.engine.recTracksReset(ts.tracks.map(t => ({ type: t.type || 0, gain: t.gain, mute: t.mute, solo: t.solo })), gen);
      const ok = await waitRecTracks(gen);
      if (!ok) { flashTake(tr('studio.m.trackRestoreTimeout')); return; }
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
      const startSamples = secToSamples((t.start || 0) / setSr);
      api.engine.takeLoad(t.file, startSamples, tid, id);
      await renderTake(t.file, startSamples, id, tid);
      // 트림·페이드 복원 (구버전 세트는 inOff/fade 없음)
      const tk = _takes.find(x => x.id === id);
      if (tk) {
        if (t.inOff || (t.srcDur && t.dur < t.srcDur - 1e-4)) { tk.inOff = t.inOff || 0; tk.dur = t.dur; commitTrim(tk); }
        if (t.fadeIn || t.fadeOut) { tk.fadeIn = t.fadeIn || 0; tk.fadeOut = t.fadeOut || 0; commitFade(tk); }
      }
    }
    for (const c of (Array.isArray(ts.midiClips) ? ts.midiClips : [])) {
      const tid = idMap && idMap[c.trackId] != null ? idMap[c.trackId] : c.trackId;
      if (!_recTracks.some(r => r.id === tid && r.type === 2)) continue;
      addMidiClip({ trackId: tid, start: c.start || 0, dur: c.dur || 1, notes: (c.notes || []).map(n => ({ t: n[0], d: n[1], p: n[2], v: n[3] })) });
    }
    renderTakes();
    clearUndo();
    flashTake(tr('studio.m.takeSetLoaded') + ts.name);
  } finally { _loadingTakeSet = false; }
}

// ── 프로젝트(.yssproj) 저장/열기 — 라이브러리 탈종속 ──
let _fxGather = null;
let _chainGather = null;
// _chainGather/_fxGather 는 전역 한 자리라 두 수집이 겹치면(수동 저장 중에 자동 저장 등)
// 뒤에 온 것이 앞의 것을 덮어쓴다. 예전엔 그때 앞의 것의 타임아웃이 "지금 자리에 있는"
// 뒤의 것을 반만 채운 채 끝내 버리고, 앞의 promise 는 영원히 안 끝났다 — 자동 저장이면
// _autosaving 이 true 로 굳어 그 뒤로 자동 저장이 영영 멈췄다. 수집은 이 락으로 한 번에
// 하나씩만 돌리고, 타임아웃은 자기 객체만 건드리게 한다.
let _fxLock = Promise.resolve();
function withFxLock(fn) {
  const run = _fxLock.then(fn, fn);
  _fxLock = run.catch(() => {});
  return run;
}
// 모든 트랙의 FX 체인 목록을 엔진에서 받아와 _chainByTrack 채움(선택 안 된 트랙도).
// 저장 시 FX 누락 방지 — 이전엔 선택 트랙 체인만 알고 있었음.
function gatherChains(ids) {
  return new Promise((res) => {
    if (!ids.length) return res();
    const g = { need: new Set(ids), res };
    _chainGather = g;
    ids.forEach(id => api.engine.fxChainReq(id));
    g._t = setTimeout(() => { if (_chainGather === g) _chainGather = null; g.res(); }, 1500);
  });
}
function gatherFx(pairs) {   // pairs:[{track,id}] → Promise<{id:data}>
  return new Promise((res) => {
    if (!pairs.length) return res({});
    const g = { need: pairs.map(p => p.id), states: {}, res };
    _fxGather = g;
    pairs.forEach(p => api.engine.fxSaveState(p.track, p.id));
    g._t = setTimeout(() => { if (_fxGather === g) _fxGather = null; g.res(g.states); }, 2000);
  });
}
// ── 크래시 복구용 FX 노브값 캐시 ───────────────────────────────
// 엔진이 죽으면 노브값은 엔진만 알고 있어 같이 사라진다(예전엔 복구하면 플러그인은 다시
// 올라오지만 전부 기본값이었다). 살아 있는 동안 주기적으로 받아 둔다(디스크에 쓰지 않음).
// 슬롯 id 는 엔진 프로세스가 매기는 번호라 엔진이 다시 뜨면 같은 번호가 다른 플러그인을
// 가리킬 수 있다 — 그래서 캐시는 엔진 프로세스 하나 동안만 유효하고, 'exit' 에서 비운다.
let _fxStateCache = {};
let _engineGen = 0;   // 엔진 프로세스 세대 — 'exit' 마다 올린다(캐시가 어느 프로세스 것인지 구분)
const FX_SNAPSHOT_MS = 30000;
let _fxSnapshotTimer = null;
function allFxPairs() {
  const pairs = [];
  const ids = [..._recTracks.map(r => r.id), ..._tracks.map(t => stemIdOf(t.engineIndex)), ...BUS_NAMES.map((_, i) => BUS_ID_BASE + i)];
  ids.forEach(tid => (_chainByTrack[tid] || []).forEach(s => pairs.push({ track: tid, id: s.id })));
  return pairs;
}
async function snapshotFxStates() {
  if (!_started || _crashRecovering || (_recArmed && _playing)) return;   // 녹음 중엔 비켜 준다
  if (!allFxPairs().length) return;
  await withFxLock(async () => {
    const gen = _engineGen;
    const ids = [..._recTracks.map(r => r.id), ..._tracks.map(t => stemIdOf(t.engineIndex)), ...BUS_NAMES.map((_, i) => BUS_ID_BASE + i)];
    await gatherChains(ids);
    if (gen !== _engineGen || !_started) return;   // 수집 도중 엔진이 죽었다 — 캐시를 건드리지 않는다
    const pairs = allFxPairs();
    const states = await gatherFx(pairs);
    if (gen !== _engineGen || !_started) return;
    _fxStateCache = mergeFxCache(_fxStateCache, pairs.map(p => p.id), states);
  });
}
function startFxSnapshots() {
  if (_fxSnapshotTimer) return;
  _fxSnapshotTimer = setInterval(() => { snapshotFxStates().catch(() => {}); }, FX_SNAPSHOT_MS);
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
// opts.skipFx — 엔진에 묻지 않고 지금 알고 있는 것만으로 만든다(동기적으로 끝난다 — 엔진
// 'exit' 처리에서 트랙 목록을 비우기 전에 떠야 해서 await 가 한 번도 걸리면 안 된다).
// 엔진이 죽은 뒤 구조를 뜰 때 쓰고, 노브값은 살아 있을 때 받아 둔 캐시(_fxStateCache)로 채운다.
async function buildProjectObject(opts = {}) {
  const sr = deviceSr();
  const master = faderToGain($('mx-master')?.value ?? FADER_UNITY_POS);
  const stemIds = _tracks.map(t => stemIdOf(t.engineIndex));
  const busIds = BUS_NAMES.map((_, i) => BUS_ID_BASE + i);
  let states;
  if (opts.skipFx) {
    states = _fxStateCache;
  } else {
    states = await withFxLock(async () => {
      const gen = _engineGen;
      await gatherChains([..._recTracks.map(r => r.id), ...stemIds, ...busIds]);
      const p = allFxPairs();
      const fresh = await gatherFx(p);
      // 응답이 늦은 슬롯은 캐시 값으로 채운다 — 예전엔 그 플러그인만 노브값 없이 저장됐다.
      const merged = mergeFxCache(_fxStateCache, p.map(x => x.id), fresh);
      // 수집 도중 엔진이 죽었다 살아났으면 이 id 들은 이미 죽은 프로세스의 것 — 캐시엔 안 넣는다.
      if (gen === _engineGen) _fxStateCache = merged;
      return merged;
    });
  }
  const autoOut = (id) => { const a = _auto.get(id); return a && (a.pts.length || a.on)
    ? { on: !!a.on, open: !!a.open, pts: a.pts.map(p => ({ t: p.t, v: p.v })) } : null; };
  const tracks = _recTracks.map(r => ({
    id: r.id, type: r.type || 0, gain: r.gain != null ? r.gain : 1, pan: r.pan != null ? r.pan : 0, mute: !!r.mute, solo: !!r.solo,
    name: r.name || '', color: r.color || '', height: r.height || 0,
    auto: autoOut(r.id), sends: sendsOf(r).slice(),
    fx: (_chainByTrack[r.id] || []).map(s => ({ index: s.index, bypass: s.bypass, data: states[s.id] })),
  }));
  const buses = _buses.map((b, i) => ({
    gain: b.gain != null ? b.gain : 1, mute: !!b.mute,
    fx: (_chainByTrack[BUS_ID_BASE + i] || []).map(s => ({ index: s.index, bypass: s.bypass, data: states[s.id] })),
  }));
  const takes = _takes.map(t => ({
    file: t.file, start: Math.round(t.start * sr), inOff: t.inOff || 0, dur: t.dur,
    srcDur: t.srcDur || t.dur, fadeIn: t.fadeIn || 0, fadeOut: t.fadeOut || 0, trackId: t.trackId,
  }));
  // MIDI 클립은 초 단위 그대로 — 샘플레이트와 무관하다
  const midiClips = _midiClips.map(c => ({ trackId: c.trackId, start: c.start, dur: c.dur, notes: c.notes.map(n => [n.t, n.d, n.p, n.v]) }));
  // 스템 트랙 믹스(볼륨·뮤트·솔로 + FX)까지 기록
  const stemMix = _tracks.map(t => {
    const sid = stemIdOf(t.engineIndex);
    return { key: t.key, gain: t.gain != null ? t.gain : 1, pan: t.pan != null ? t.pan : 0, mute: !!t.mute, solo: !!t.solo,
      auto: autoOut(sid), sends: sendsOf(t).slice(),
      fx: (_chainByTrack[sid] || []).map(s => ({ index: s.index, bypass: s.bypass, data: states[s.id] })) };
  });
  const stems = _stemPaths ? { paths: _stemPaths, offset: Math.round(_stemOffset * sr), videoPath: _videoPath || null, mix: stemMix } : null;
  // 베이스 TAB — 채보(CREPE)가 제일 오래 걸리는 부분이라 그 결과(notes)만은 반드시 남긴다.
  // 마디 위 코드 라벨(_tabBarChords)은 원본 오디오가 있어야 다시 만들 수 있어 여기 안 남기고
  // 로드 후 재계산한다(가벼운 편이라 다시 하는 게 용량을 불리는 것보다 낫다).
  const tab = (_tabNotes && _tabNotes.length)
    ? { notes: _tabNotes, tuning: _tabTuning, beats: _tabBeats, accent: _tabAccent, phase: _tabPhase, barPhase: _tabBarPhase }
    : null;
  // sampleRate 를 같이 적는다. takes[].start 와 stems.offset 만 샘플 단위라,
  // 어느 레이트로 잰 샘플인지 모르면 다른 레이트로 연 사람에게서 그 비율만큼 어긋난다.
  return { kind: 'yssproj', version: 2, sampleRate: sr, name: _songName || tr('studio.lbl.project'), savedAt: new Date().toISOString(), bpm: _bpm, detBpm: _detBpm, beatInterval: _beatInterval, gridOffset: _gridOffset, beats: _beats, speed: _speed, speedBase: _speedBase, speedStemPaths: _speedStemPaths, keySemitones: _keySemitones, master, buses, stems, tracks, takes, midiClips, tab };
}
// 저장 상태 (프로젝트 경로 + 변경 여부)
let _projectPath = null;   // 저장된 .yssproj 경로 (없으면 미저장)
let _dirty = false;        // 마지막 저장 이후 변경 여부
let _suppressDirty = false;// 로드 중 dirty 표시 억제
function markDirty() { if (_suppressDirty) return; if (!_dirty) { _dirty = true; updateProjectLabel(); notifyDirty(); } }
function markClean() {
  _dirty = false;
  updateProjectLabel();
  notifyDirty();
  api.project?.autosaveClear?.(_projectPath);   // 제대로 저장했으면 복구본은 쓸모가 없다
}
/** 창을 닫을 때 물어볼지 판단하도록 메인에 알린다 */
function notifyDirty() { try { api.project?.setDirty?.(_dirty); } catch {} }
function updateProjectLabel() {
  const el = $('st-proj-name'); if (!el) return;
  const lab = el.querySelector('.pn-label'), dot = el.querySelector('.pn-dot');
  const name = _projectPath ? baseName(_projectPath) : (_songName ? _songName : tr('studio.lbl.newProject'));
  if (lab) lab.textContent = name + (_dirty ? ' •' : '');
  el.classList.toggle('dirty', _dirty);
  el.classList.toggle('unsaved', !_projectPath);
  el.title = (_projectPath ? name : tr('studio.lbl.notSavedYet'))
    + (_dirty ? tr('studio.lbl.hasUnsaved') : tr('studio.lbl.savedSuffix')) + ' (Ctrl+S)';
}
// 스템도 클립도 녹음 트랙도 없으면 저장할 것이 없다 — 저장 가드와 충돌 복구가 같이 쓴다.
// 이게 갈라져 있던 탓에, 빈 상태로 엔진이 재시작하면 복구는 dirty 를 켰는데
// 저장은 "저장할 게 없다"며 끄지 않아 사용자가 저장 안내에 갇혔다.
const hasSaveableContent = () => !!(_stemPaths || _takes.length || _midiClips.length || _recTracks.length);

// 저장 전엔 take 가 "저장 안 한 프로젝트" 임시 세션 폴더에 있었을 수 있다(녹음부터 하고
// 나중에 저장하는 흔한 순서) — 저장 경로가 정해지면 그 프로젝트의 media/ 로 옮기고,
// 옮긴 게 있으면 바뀐 경로가 반영된 최신 JSON 으로 조용히 한 번 더 저장한다(다이얼로그 없음).
// 엔진에 이미 로드된 참조는 안 건드린다 — 이번 세션 재생엔 옛 경로로도 아무 문제 없고,
// 다음에 프로젝트를 다시 열 때만 새 경로가 쓰인다.
async function migrateTakesIfNeeded() {
  if (!_takes.length) return;
  const files = [...new Set(_takes.map(t => t.file).filter(Boolean))];
  if (!files.length) return;
  let res; try { res = await api.project?.migrateTakes?.(files, _projectPath); } catch {}
  if (!res || !res.ok || !res.map) return;
  let moved = false;
  for (const t of _takes) {
    const nf = res.map[t.file];
    if (nf && nf !== t.file) { t.file = nf; moved = true; }
  }
  if (!moved) return;
  renderTakes();   // 파일명 라벨(.daw-clip-name)이 새 경로를 반영하게
  const obj = await buildProjectObject();
  await api.project.save(JSON.stringify(obj, null, 2), _songName, _projectPath);
}

// 저장: 경로 있으면 덮어쓰기, 없으면 새로 저장(다이얼로그)
async function saveProjectSmart() {
  if (!hasSaveableContent()) { flashTake(tr('studio.m.nothingToSave')); return; }
  const obj = await buildProjectObject();
  const r = await api.project.save(JSON.stringify(obj, null, 2), _songName || tr('studio.lbl.project'), _projectPath || undefined);
  if (r && r.ok) {
    _projectPath = r.path; _songName = baseName(r.path);
    await migrateTakesIfNeeded();
    markClean(); flashTake(tr('studio.m.savedTo') + r.path);
  }
  else if (!r || !r.canceled) flashTake(tr('studio.m.saveFail'));
}
const saveProject = saveProjectSmart;   // 드롭다운 tr('studio.d.saveProjectShort') 도 동일 로직

// 프로젝트 닫기 — closeSong() 은 스템만 비우고 녹음 트랙·클립·버스·되돌리기 기록은 남긴다.
// 이건 그 전부를 빈 상태로 되돌린다. 빈 프로젝트를 applyProject() 로 "여는" 경로를 그대로
// 타면 recTracksReset 무조건 호출 등 이미 검증된 초기화 로직을 새로 만들 필요가 없다
// (사용자 제보: 프로젝트 이동 시 드라이버 충돌 — 원인은 이 리셋이 조건부였던 탓, 이미 수정됨).
async function closeProject() {
  if (!hasSaveableContent() && !_projectPath) { flashTake(tr('studio.m.nothingToClose')); return; }
  await applyProject({ kind: 'yssproj', version: 2, bpm: 120, gridOffset: 0, beats: [], detBpm: 0, beatInterval: 0, master: 1, buses: [], stems: null, tracks: [], takes: [], tab: null });
  _projectPath = null; _songName = '';
  markClean();
  flashTake(tr('studio.m.projectClosed'));
}

// ── 자동 저장 · 복구 ──────────────────────────────────────────
// 사용자가 고른 .yssproj 는 절대 자동으로 덮어쓰지 않는다. 별도 스냅샷만 남기고,
// 제대로 저장했거나 사용자가 버리기로 하면 지운다.
const AUTOSAVE_MS = 60000;
let _autosaveTimer = null;
let _autosaving = false;

function hasWork() { return !!_stemPaths || _takes.length > 0 || _recTracks.length > 0; }

async function autosaveNow() {
  if (_autosaving || !_dirty || !hasWork()) return;
  if (_recArmed && _playing) return;   // 녹음 중에는 비켜 준다 — 지금 끊기면 안 되는 순간이다
  _autosaving = true;
  try {
    const obj = await buildProjectObject();
    await api.project?.autosaveWrite?.(JSON.stringify(obj), {
      projectPath: _projectPath || null,
      name: _songName || null,
    });
  } catch { /* 다음 주기에 다시 시도한다 */ }
  finally { _autosaving = false; }
}

function startAutosave() {
  if (_autosaveTimer) return;
  _autosaveTimer = setInterval(autosaveNow, AUTOSAVE_MS);
}

// ── 엔진이 죽었을 때 ──────────────────────────────────────────
// 오디오 엔진은 별도 프로세스이고 그 안에서 남의 VST 가 돈다. 죽는 것은 드문 일이 아니라
// 예정된 일에 가깝다. 죽은 채로 두면 아무것도 안 되는 화면이 남고, 녹음 중이었다면
// 디스크에 쓰다 만 파일이 남는데 앱은 그걸 모른다.
let _crashRecovering = false;
// 반복 크래시(루프) 감지용 — 고장난 VST·드라이버 충돌처럼 근본적으로 깨진 상황에서
// 무조건 즉시 재시작을 반복하면 드라이버가 더 지치고 크래시 저널만 쌓인다.
// 판정 로직 자체는 studio/util.js 의 noteCrashAndCheckLoop(순수 함수, 기기 없이 테스트됨).
let _crashTimestamps = [];
let _crashLoopClearTimer = null;

async function handleEngineCrash(m) {
  if (_crashRecovering) return;
  _crashRecovering = true;
  try {
    if (noteCrashAndCheckLoop(_crashTimestamps, Date.now())) {
      // 자동 재시작을 멈춘다 — _engineTried 는 그대로 둔다(이미 true라 daw-boot-retry
      // 수동 버튼의 startEngine(true) 흐름은 그대로 살아있다).
      _crashTimestamps = [];
      flashTake(tr('studio.crash.loop'));
      showBoot('crashloop');
      return;
    }

    // 엔진이 없으므로 이펙트 노브 값은 못 가져온다. 나머지 구조는 이쪽이 다 알고 있다.
    const snap = await buildProjectObject({ skipFx: true }).catch(() => null);

    flashTake(tr('studio.crash.restarting'));
    _engineTried = false;                     // 자동 시작 1회 제한을 푼다
    if (!await startEngine(true)) { flashTake(tr('studio.crash.failed')); return; }
    // startEngine(true) 는 성공(스폰까지만) 이어도 showBoot('loading') 을 띄운 채로 반환한다
    // — 실제로 'ready' 가 안 오면(장치가 안 열리거나 응답이 없는 경우) 여기서 12초 기다리다
    // 포기하는데, 그때 daw-boot 를 그대로 두면 로딩 스피너가 영원히 멈춘 채 남고 재시도
    // 버튼도 없어서(반복 크래시 감지 분기와 같은 문제) 사용자는 화면이 멈췄다고만 느낀다
    // (실사용 제보: 오디오 설정·녹음트랙추가 눌러도 반응 없음 — 원인이 이거였다).
    if (!await waitEngineReady(12000)) { flashTake(tr('studio.crash.failed')); showBoot('failed'); return; }

    // 안정적으로 다시 떴다 — 한참 뒤(60초)에도 안 죽어 있으면 이번 창을 잊는다.
    // 그래야 한참 뒤에 벌어진 무관한 크래시가 예전 창에 누적돼 억울하게 반복-크래시로
    // 오판되지 않는다.
    clearTimeout(_crashLoopClearTimer);
    _crashLoopClearTimer = setTimeout(() => { _crashTimestamps = []; }, 60000);

    if (snap) {
      await applyProject(snap);
      // 캐시는 방금 비워졌다 — 30초 주기를 기다리지 말고 곧 한 번 받아 둔다(복구 직후 또 죽는 경우 대비).
      setTimeout(() => { snapshotFxStates().catch(() => {}); }, 5000);
      // 곡을 열기도 전에 엔진이 죽었다 살아난 경우(예: 드라이버 충돌) 는 되살릴 것이 없다.
      // 그때도 무조건 dirty 를 켜면, 저장 버튼은 "저장할 게 없다"며 아무 일도 안 하는데
      // 종료할 때는 계속 저장하라고 붙잡는 모순이 생긴다.
      if (hasSaveableContent()) markDirty();
    }
    if (m.take && m.take.file) offerCrashTake(m.take);
    else flashTake(tr('studio.crash.restored'));
  } finally { _crashRecovering = false; }
}

function waitEngineReady(ms) {
  return new Promise((res) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (_started || Date.now() - t0 > ms) { clearInterval(iv); res(_started); }
    }, 100);
  });
}

/** 쓰다 만 녹음 파일을 되살릴지 묻는다 */
function offerCrashTake(take) {
  const secs = Math.max(0, Math.round(take.seconds || 0));
  openModal(tr('studio.crash.takeTitle'), `
    <div class="daw-modal-item" data-idx="1">
      <div class="mt"><div class="n">${esc(tr('studio.crash.takeAdd'))}</div>
      <div class="m">${esc(tr('studio.crash.takeLen', { s: secs }))}</div></div></div>
    <div class="daw-modal-item" data-idx="0">
      <div class="mt"><div class="n">${esc(tr('studio.crash.takeShow'))}</div>
      <div class="m">${esc(take.file)}</div></div></div>`,
    async (idx) => {
      if (idx !== '1') { api.openPath(take.file); return; }
      const tid = armedRecId();
      const id = nextClipId();
      // 어느 시점에 녹음이 시작됐는지는 알 수 없다 — 맨 앞에 놓고 옮기게 한다
      api.engine.takeLoad(take.file, 0, tid, id);
      await renderTake(take.file, 0, id, tid);
      markDirty();
      flashTake(tr('studio.crash.takeAdded'));
    });
}

/** 지난번에 저장하지 못하고 끝났으면 복구를 제안한다 */
async function offerRecovery() {
  let r = null;
  try { r = await api.project?.autosaveRead?.(); } catch {}
  if (!r || !r.ok || !r.data) return;

  const at = r.meta?.at ? new Date(r.meta.at) : null;
  const p = (n) => String(n).padStart(2, '0');
  const when = at ? `${at.getFullYear()}.${p(at.getMonth() + 1)}.${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}` : '';
  const name = r.meta?.name || r.meta?.projectPath || tr('studio.lbl.project');

  openModal(tr('studio.rec.title'), `
    <div class="daw-modal-item" data-idx="1">
      <div class="mt"><div class="n">${esc(String(name))}</div>
      <div class="m">${esc(when)} · ${esc(tr('studio.rec.restoreSub'))}</div></div></div>
    <div class="daw-modal-item" data-idx="0">
      <div class="mt"><div class="n">${esc(tr('studio.rec.discard'))}</div>
      <div class="m">${esc(tr('studio.rec.discardSub'))}</div></div></div>`,
    async (idx) => {
      if (idx !== '1') { api.project?.autosaveClear?.(r.key, r.legacy); return; }
      try {
        const obj = JSON.parse(r.data);
        await applyProject(obj);
        _projectPath = r.meta?.projectPath || null;
        _songName = r.meta?.name || _songName;
        if (hasSaveableContent()) markDirty();   // 복구본은 아직 파일에 저장된 상태가 아니다
        if (r.legacy) api.project?.autosaveClear?.(null, true);   // 예전 전역 자동저장은 옮겨왔으니 정리
        flashTake(tr('studio.rec.restored'));
      } catch {
        flashTake(tr('studio.rec.failed'));
      }
    });
}
let _openingProject = false;
async function openProject() {
  if (_openingProject) return;
  const r = await api.project.open();
  if (!r || !r.ok) { if (r && r.error) flashTake(tr('studio.m.openFail') + r.error); return; }
  await loadProjectData(r.path, r.data);
}

/** 이미 읽어 둔 내용으로 연다 — 파일 선택창으로 고른 경우와 더블클릭으로 들어온 경우가 같이 쓴다 */
export async function loadProjectData(filePath, raw) {
  if (_openingProject) return false;
  let p;
  try { p = JSON.parse(raw); } catch { flashTake(tr('studio.m.projectParseFail')); return false; }
  if (p.kind !== 'yssproj') { flashTake(tr('studio.m.notProjectFile')); return false; }
  _openingProject = true;
  try {
    _songName = baseName(filePath);
    await applyProject(p);
    _projectPath = filePath;
    markClean();
    return true;
  } finally { _openingProject = false; }
}
async function applyProject(p) {
  resetStemGroupGain();
  const sr = deviceSr();
  // 저장 당시 레이트로 잰 샘플을 지금 레이트로 옮긴다. 44.1k 로 저장한 것을 48k 로 열면
  // 환산 없이는 모든 클립이 44100/48000 배 자리로 가 통째로 당겨진 것처럼 들린다.
  //
  // 레이트를 안 적던 시절 파일은 44100 으로 본다. 그때는 스템 리샘플이 없어서
  // 44.1k 가 아닌 레이트로는 반주 자체가 어긋나 재생됐다 — 쓸 만한 프로젝트는 44.1k 에서 나왔다.
  const savedSr = p.sampleRate > 0 ? p.sampleRate : 44100;
  const toNow = (samples) => Math.round(((samples || 0) / savedSr) * sr);
  _suppressDirty = true;
  api.engine.takeClear(); _takes = []; _midiClips = []; _selMidi = null; api.engine.midiClear?.(); renderTakes();
  // 1) 스템 (있으면 로드, 없으면 스템 트랙 비움)
  if (p.stems && p.stems.paths && Object.keys(p.stems.paths).length) {
    await loadSong({ stemPaths: p.stems.paths, videoPath: p.stems.videoPath, name: p.name, id: p.name }, { autoBpm: false });
    _stemOffset = (p.stems.offset || 0) / savedSr;
    api.engine.stemOffset(Math.round(_stemOffset * sr));
    repositionStems();
    // 스템 트랙 믹스(볼륨·뮤트·솔로) 복원 — 파형 유지 위해 DOM 직접 갱신
    if (Array.isArray(p.stems.mix)) {
      p.stems.mix.forEach(m => {
        const t = _tracks.find(x => x.key === m.key); if (!t) return;
        t.gain = m.gain != null ? m.gain : 1; t.pan = m.pan != null ? m.pan : 0; t.mute = !!m.mute; t.solo = !!m.solo;
        t.sends = Array.isArray(m.sends) ? m.sends.slice(0, BUS_COUNT) : [0, 0];
        api.engine.track(t.engineIndex, { gain: stemGainOut(t), pan: t.pan, mute: t.mute, solo: t.solo, sends: t.sends });
        const lane = document.querySelector(`.daw-lane[data-key="${t.key}"]`); if (!lane) return;
        const v = lane.querySelector('.daw-vol'); if (v) v.value = gainToFader(t.gain);
        const pn = lane.querySelector('.daw-pan'); if (pn) { const pv = Math.round(t.pan * 100); pn.value = pv; pn.classList.toggle('off', pv === 0); }
        const mb = lane.querySelector('[data-m="mute"]'); if (mb) { mb.classList.toggle('on', t.mute); mb.setAttribute('aria-pressed', String(t.mute)); }
        const sb = lane.querySelector('[data-m="solo"]'); if (sb) { sb.classList.toggle('on', t.solo); sb.setAttribute('aria-pressed', String(t.solo)); }
        if (m.auto) {   // 스템 볼륨 자동화 복원
          const sid = stemIdOf(t.engineIndex);
          const a = autoOf(sid);
          a.on = !!m.auto.on; a.open = !!m.auto.open;
          a.pts = (m.auto.pts || []).map(p => ({ t: p.t, v: p.v }));
          autoPush(sid);
        }
        if (Array.isArray(m.fx) && m.fx.length)   // 스템 FX 체인 복원
          api.engine.fxSetChain(stemIdOf(t.engineIndex), m.fx.map(s => ({ index: s.index, bypass: s.bypass, data: s.data })));
      });
      updateSoloDim();
    }
  } else {
    closeSong();
  }
  _songName = p.name || '';
  // 베이스 TAB 복원 — 프로젝트 파일에 저장해 둔 채보를 그대로 쓴다(재채보 안 함).
  restoreTabData(p.tab);
  if (p.bpm) { _bpm = p.bpm; const b = $('st-bpm'); if (b) b.value = p.bpm; }
  _gridOffset = p.gridOffset || 0;
  _beats = Array.isArray(p.beats) ? p.beats.slice() : [];
  _detBpm = p.detBpm || 0; _beatInterval = p.beatInterval || 0;
  updateMetro();
  // 속도가 1배가 아니었던 프로젝트 — 저장해 둔 기준(speedBase)에서 다시 늘려/줄여서
  // 스템을 재생성한다(생성된 파일 자체는 프로젝트에 안 남기고, 열 때마다 원본에서 다시 만든다 —
  // 관리해야 할 파일이 안 늘어난다). p.stems 가 없으면(스템 없는 프로젝트) 건너뛴다.
  if (p.stems && ((p.speed && p.speed !== 1) || p.keySemitones)) {
    if (p.speedBase) _speedBase = { bpm: p.speedBase.bpm, beatInterval: p.speedBase.beatInterval, gridOffset: p.speedBase.gridOffset, beats: Array.isArray(p.speedBase.beats) ? p.speedBase.beats.slice() : [] };
    // 저장해 둔 처리 파일이 아직 있으면(stemsDir 에 남겨 둔다) 그걸 그대로 다시 불러오기만
    // 한다 — 처음 만들 때만 오래 걸리고, 그다음부터 프로젝트를 열 때마다 매번 다시 처리하지
    // 않는다("불러오고 또 처리하느라 시간 걸린다" 신고 반영). 파일이 없어졌을 때만(다른
    // 컴퓨터로 옮겼다거나) 처음부터 다시 만든다.
    const restored = p.speedStemPaths && typeof p.speedStemPaths === 'object'
      ? await restoreSpeedFromCache(p.speedStemPaths, p.speed || 1, p.keySemitones || 0)
      : false;
    if (!restored) await applyTransform(p.speed || 1, p.keySemitones || 0, { fromLoad: true });
  }
  // 2) 녹음/오디오 트랙 레이아웃 + FX
  // recTracksReset 은 항상 부른다 — 예전엔 새 프로젝트에 트랙이 하나도 없으면 이 블록
  // 전체를 건너뛰어서, 엔진 쪽에 이전 프로젝트의 녹음 트랙이 그대로 남아 있었다(사용자
  // 제보: 프로젝트 이동 시 "드라이버 충돌"). 빈 배열이라도 넘겨서 엔진을 확실히 비운다.
  let idMap = null;
  {
    // 엔진이 아직 시작 중일 때(홈 "이어서 하기"로 스튜디오 진입과 동시에 여는 경로 등)
    // 첫 시도가 타임아웃 날 수 있다 — 그땐 엔진이 그새 붙었을 가능성이 높으니 한 번 더
    // 시도해서(합쳐 최대 20초) 클립(takes) 복원을 계속 포기하지 않게 한다.
    const reqTracks = (p.tracks || []).map(t => ({ type: t.type || 0, gain: t.gain, pan: t.pan || 0, mute: t.mute, solo: t.solo, sends: Array.isArray(t.sends) ? t.sends : [0, 0] }));
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      _recTracks = [];
      const gen = ++_recTracksGenReq;
      api.engine.recTracksReset(reqTracks, gen);
      ok = await waitRecTracks(gen);
    }
    if (!ok) { _suppressDirty = false; flashTake(tr('studio.m.trackRestoreTimeout')); return; }
  }
  if (Array.isArray(p.tracks) && p.tracks.length) {
    idMap = {};
    p.tracks.forEach((t, i) => { if (_recTracks[i]) idMap[t.id] = _recTracks[i].id; });
    applyTrackMeta(p.tracks);   // 이름·색·높이
    p.tracks.forEach((t, i) => {
      if (!_recTracks[i]) return;
      if (t.auto) {   // 녹음 트랙 볼륨 자동화 복원 (새 id 기준)
        const a = autoOf(_recTracks[i].id);
        a.on = !!t.auto.on; a.open = !!t.auto.open;
        a.pts = (t.auto.pts || []).map(x => ({ t: x.t, v: x.v }));
        autoPush(_recTracks[i].id);
      }
      _recTracks[i].sends = Array.isArray(t.sends) ? t.sends.slice(0, BUS_COUNT) : [0, 0];
      if (Array.isArray(t.fx) && t.fx.length)
        api.engine.fxSetChain(_recTracks[i].id, t.fx.map(s => ({ index: s.index, bypass: s.bypass, data: s.data })));
    });
  }
  // 3) 클립 (트림·페이드 복원)
  for (const t of (p.takes || [])) {
    let tid = t.trackId;
    if (idMap && idMap[t.trackId] != null) tid = idMap[t.trackId];
    else if (!_recTracks.some(r => r.id === tid)) tid = armedRecId();
    const id = nextClipId();
    const startSamples = toNow(t.start);
    api.engine.takeLoad(t.file, startSamples, tid, id);
    await renderTake(t.file, startSamples, id, tid);
    const tk = _takes.find(x => x.id === id);
    if (tk) {
      if (t.inOff || (t.srcDur && t.dur < t.srcDur - 1e-4)) { tk.inOff = t.inOff || 0; tk.dur = t.dur; commitTrim(tk); }
      if (t.fadeIn || t.fadeOut) { tk.fadeIn = t.fadeIn || 0; tk.fadeOut = t.fadeOut || 0; commitFade(tk); }
    }
  }
  // 3-1) MIDI 클립
  for (const c of (Array.isArray(p.midiClips) ? p.midiClips : [])) {
    let tid = c.trackId;
    if (idMap && idMap[c.trackId] != null) tid = idMap[c.trackId];
    if (!_recTracks.some(r => r.id === tid && r.type === 2)) continue;   // 악기 트랙이 없으면 버린다
    addMidiClip({ trackId: tid, start: c.start || 0, dur: c.dur || 1,
      notes: (c.notes || []).map(n => ({ t: n[0], d: n[1], p: n[2], v: n[3] })) });
  }
  renderTakes();
  // 4) 마스터
  if (p.master != null) {
    api.engine.master(p.master);
    const s = $('mx-master'); if (s) s.value = gainToFader(p.master);
    const mv = $('mx-master-val'); if (mv) mv.textContent = dbText(p.master);
  }
  // 5) 센드 버스 — 없으면(구 프로젝트) 기본값으로 되돌린다
  applyBusState(Array.isArray(p.buses) ? p.buses : []);
  updateSendRows();
  layout();
  clearUndo();   // 새 상태 로드 → 히스토리 초기화
  _suppressDirty = false;
  flashTake(tr('studio.m.projectOpened') + (p.name || ''));
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
function doUndo() { const a = _undoStack.pop(); if (!a) return; a.undo(); _redoStack.push(a); updateUndoUI(); markDirty(); flashTake(tr('studio.m.undid') + (a.label || '')); }
function doRedo() { const a = _redoStack.pop(); if (!a) return; a.redo(); _undoStack.push(a); updateUndoUI(); markDirty(); flashTake(tr('studio.m.redid') + (a.label || '')); }
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
  const sr = deviceSr();
  api.engine.takeMove(tk.id, Math.round(tk.start * sr), tk.trackId);
  api.engine.takeTrim(tk.id, Math.round(tk.start * sr), Math.round(tk.inOff * sr), Math.round(tk.dur * sr));
  api.engine.takeFade(tk.id, Math.round(tk.fadeIn * sr), Math.round(tk.fadeOut * sr));
  renderTakes(); layout();
}
/**
 * 장치 샘플레이트가 바뀌었을 때 엔진 쪽을 다시 맞춘다.
 *
 * 엔진이 들고 있는 값은 전부 샘플 단위라 장치가 다시 열리면 옛 레이트 기준으로 남는다.
 * 스템은 장치가 열릴 때 엔진이 스스로 다시 잡지만, 녹음 클립은 그때의 레이트로 변환해 둔
 * 버퍼와 위치를 그대로 쥐고 있어 속도도 자리도 어긋난다. 이쪽은 초로 들고 있으니 기준이 된다.
 */
function repushForSampleRate() {
  const sr = deviceSr();
  if (_stemPaths) api.engine.stemOffset(Math.round(_stemOffset * sr));
  if (_takes.length) {
    api.engine.takeClear();                 // 새 레이트로 파일을 다시 읽게 한다
    for (const tk of _takes) {
      api.engine.takeLoad(tk.file, Math.round(tk.start * sr), tk.trackId, tk.id);
      api.engine.takeTrim(tk.id, Math.round(tk.start * sr), Math.round((tk.inOff || 0) * sr), Math.round(tk.dur * sr));
      api.engine.takeFade(tk.id, Math.round((tk.fadeIn || 0) * sr), Math.round((tk.fadeOut || 0) * sr));
    }
  }
  for (const c of _midiClips) pushMidiClip(c);   // MIDI 클립도 샘플 단위로 보냈으니 새 레이트로 다시
  api.engine.seek(Math.round((_lastSec || 0) * sr));   // 재생 위치도 시간 기준으로 다시
}

function reAddClip(tkObj) {   // 삭제/분할 취소용 — 보관한 take 객체를 엔진·렌더러에 복구
  const sr = deviceSr();
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
    if (nw !== oldName) pushUndo(() => setTrackProp(rt.id, 'name', oldName), () => setTrackProp(rt.id, 'name', nw), tr('studio.u.trackName'));
  };
  inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); else if (ev.key === 'Escape') { done = true; renderRecLanes(); } });
  inp.addEventListener('blur', commit);
}
function setTrackProp(id, key, val) {   // 이름·색·높이 (렌더러 전용 메타)
  const rt = _recTracks.find(r => r.id === id); if (!rt) return;
  rt[key] = val || (key === 'height' ? 0 : '');
  if (key === 'color') {   // 되돌리기/다시실행으로 색이 바뀔 때도 파형 색 캐시를 같이 갱신
    const nc = resolveColor(rt.color || (rt.type === 1 ? 'var(--stem-bass)' : 'var(--danger)'));
    for (const tk of _takes) if (tk.trackId === id) { tk.waveColor = nc; tk.svg = null; }
    renderTakes();
  }
  renderRecLanes(); updateFxPanel(); updateTrackFader();
}
function reorderTracks(orderIds) {
  _recTracks.sort((a, b) => orderIds.indexOf(a.id) - orderIds.indexOf(b.id));
  renderRecLanes(); renderTakes();
}
function setBpm(v) { _bpm = v; const b = $('st-bpm'); if (b) b.value = v; layout(); updateMetro(); }
function setStemOffset(v) { _stemOffset = Math.max(0, v); repositionStems(); api.engine.stemOffset(secToSamples(_stemOffset)); layout(); }
// BPM 배수 보정 (감지가 ×2/÷2 로 틀릴 때)
function adjustBpm(factor) {
  const old = _bpm;
  const nw = Math.max(20, Math.min(300, Math.round(_bpm * factor)));
  if (nw === old) { flashTake(tr('studio.m.bpmOutOfRange')); return; }
  setBpm(nw);
  pushUndo(() => setBpm(old), () => setBpm(nw), tr('studio.u.bpmAdjust'));
}
// 마퀴(영역 드래그) 다중선택 — 뷰포트 좌표 기준 사각형과 클립 요소의 겹침만 보면 되니
// 스크롤/줌 오프셋 계산이 필요 없다(둘 다 실제 화면 rect 로 비교).
function startMarquee(e) {
  e.preventDefault();
  const box = document.createElement('div');
  box.className = 'daw-marquee';
  document.body.appendChild(box);
  const x0 = e.clientX, y0 = e.clientY;
  const additive = e.ctrlKey || e.metaKey || e.shiftKey;   // 기존 선택에 더하기
  const baseSel = additive ? new Set(_selClips) : new Set();
  const move = (ev) => {
    const l = Math.min(x0, ev.clientX), t = Math.min(y0, ev.clientY);
    const w = Math.abs(ev.clientX - x0), h = Math.abs(ev.clientY - y0);
    box.style.left = l + 'px'; box.style.top = t + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
    const r1 = { left: l, top: t, right: l + w, bottom: t + h };
    const picked = new Set(baseSel);
    document.querySelectorAll('.daw-take-clip').forEach(el => {
      const r2 = el.getBoundingClientRect();
      if (r1.left < r2.right && r1.right > r2.left && r1.top < r2.bottom && r1.bottom > r2.top) {
        const id = Number(el.dataset.clipId);
        if (id) picked.add(id);
      }
    });
    if (picked.size !== _selClips.size || [...picked].some(id => !_selClips.has(id))) {
      _selClips = picked; renderTakes();
    }
  };
  const up = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.removeEventListener('pointercancel', up);
    box.remove();
    _selClipId = _selClips.size === 1 ? [..._selClips][0] : (_selClips.size ? _selClipId : null);
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up);
  document.addEventListener('pointercancel', up);
}
// ── 다중선택 클립보드 (복사/잘라내기/붙여넣기/삭제) ──
function selectedTakes() { return _takes.filter(t => _selClips.has(t.id)); }
function clearClipSelection() {
  // MIDI 클립 선택도 같이 푼다 — 안 그러면 빈 곳을 눌러 선택이 풀린 것처럼 보여도 Delete 가 그 클립을 지운다
  if (_selMidi != null) { _selMidi = null; document.querySelectorAll('.daw-midi-clip.sel').forEach(x => x.classList.remove('sel')); }
  if (_selClips.size) { _selClips = new Set(); _selClipId = null; renderTakes(); }
}
// MIDI 클립 클립보드 — 오디오 클립보드(_clipboard)와 따로 둔다. 마지막으로 복사한 쪽이 붙는다.
let _midiClipboard = null, _clipKind = 'audio';
function copyClips() {
  if (_selMidi != null) {
    const c = _midiClips.find(x => x.id === _selMidi); if (!c) return false;
    _midiClipboard = midiSnapshot(c); _clipKind = 'midi';
    flashTake(tr('studio.p.copied', { n: 1 }));
    return true;
  }
  const sel = selectedTakes(); if (!sel.length) return false;
  _clipKind = 'audio';
  const minStart = Math.min(...sel.map(t => t.start));
  _clipboard = sel.map(t => ({ file: t.file, inOff: t.inOff, dur: t.dur, srcDur: t.srcDur, fadeIn: t.fadeIn, fadeOut: t.fadeOut, trackId: t.trackId, relStart: t.start - minStart, waveCh: t.waveCh, waveColor: t.waveColor }));
  flashTake(tr('studio.p.copied', { n: sel.length }));
  return true;
}
function cutClips() {
  if (_selMidi != null) { if (copyClips()) deleteSelectedMidi(); return; }
  const sel = selectedTakes(); if (!sel.length) return;
  copyClips();
  const removed = sel.map(t => ({ ...t }));
  removed.forEach(t => removeClipById(t.id));
  _selClips = new Set();
  pushUndo(() => { removed.forEach(reAddClip); }, () => { removed.forEach(t => removeClipById(t.id)); }, tr('studio.u.cut'));
}
function pasteClips() {
  if (_clipKind === 'midi' && _midiClipboard) {
    // 선택한 악기 트랙에, 없으면 복사해 온 트랙에(아직 있으면) — 재생선 위치로
    const sel = _recTracks.find(r => r.id === _selTrack && r.type === 2);
    const tid = sel ? sel.id : (_recTracks.some(r => r.id === _midiClipboard.trackId && r.type === 2) ? _midiClipboard.trackId : null);
    if (tid == null) { flashTake(tr('studio.midi.pasteTarget')); return; }
    const nc = addMidiClip({ ..._midiClipboard, trackId: tid, start: _lastSec || 0 });
    selectMidiClip(nc.id); renderTakes(); layout();
    const snap = midiSnapshot(nc);
    pushUndo(() => { removeMidiClip(snap.id); renderTakes(); layout(); }, () => setMidiClipState(snap), tr('studio.u.paste'));
    markDirty();
    flashTake(tr('studio.p.pasted', { n: 1 }));
    return;
  }
  if (!_clipboard.length) { flashTake(tr('studio.m.noClipToPaste')); return; }
  const at = _lastSec;
  // 현재 선택된 트랙에 붙여넣기 (선택 없으면 녹음 대상 트랙)
  const target = (_selTrack != null && _recTracks.some(r => r.id === _selTrack)) ? _selTrack : armedRecId();
  if (target == null) { flashTake(tr('studio.m.selectPasteTarget')); return; }
  const made = _clipboard.map((c) => {
    const src = c.waveCh ? c : (_takes.find(t => t.file === c.file) || {});
    return { file: c.file, id: nextClipId(), trackId: target,
      start: at + c.relStart, inOff: c.inOff, dur: c.dur, srcDur: c.srcDur, fadeIn: c.fadeIn, fadeOut: c.fadeOut,
      waveCh: src.waveCh, waveColor: src.waveColor, svg: null, waveAt: 0 };
  });
  made.forEach(reAddClip);
  _selClips = new Set(made.map(m => m.id));
  renderTakes();
  pushUndo(() => { made.forEach(m => removeClipById(m.id)); }, () => { made.forEach(reAddClip); }, tr('studio.u.paste'));
  flashTake(tr('studio.p.pasted', { n: made.length }));
}
function deleteSelectedClips() {
  if (_selMidi != null && deleteSelectedMidi()) return;
  const sel = selectedTakes(); if (!sel.length) return;
  const removed = sel.map(t => ({ ...t }));
  removed.forEach(t => removeClipById(t.id));
  _selClips = new Set();
  pushUndo(() => { removed.forEach(reAddClip); }, () => { removed.forEach(t => removeClipById(t.id)); }, tr('studio.u.clipDelete'));
}
// ── Export: 포맷·품질 선택 ──
const EXPORT_QUAL = {
  wav:  [['24', '24-bit'], ['16', '16-bit'], ['32', '32-bit float']],
  aiff: [['24', '24-bit'], ['16', '16-bit'], ['32', '32-bit float']],
  flac: [['24', '24-bit'], ['16', '16-bit']],
  mp3:  [['320', '320 kbps'], ['256', '256 kbps'], ['192', '192 kbps'], ['128', '128 kbps']],
};
function openExportModal() {
  if (!_tracks.length && !_recTracks.length) { flashTake(tr('studio.m.nothingToExport')); return; }
  if (_exporting) { flashTake(tr('studio.m.exportBusy')); return; }
  const host = $('daw-modal');
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>${tr('studio.x.export')}</span><button class="x">✕</button></div>
    <div class="daw-modal-list" style="padding:16px">
      <div class="dev-field"><span>${tr('studio.x.scope')}</span><select id="exp-scope">
        <option value="mix">${tr('studio.x.scopeMix')}</option>
        <option value="mine">${tr('studio.x.scopeMine')}</option>
      </select></div>
      <div class="dev-field" style="margin-top:10px"><span>${tr('studio.x.format')}</span><select id="exp-fmt">
        <option value="wav">${tr('studio.x.fmtWav')}</option>
        <option value="flac">${tr('studio.x.fmtFlac')}</option>
        <option value="aiff">${tr('studio.x.fmtAiff')}</option>
        <option value="mp3">${tr('studio.x.fmtMp3')}</option>
      </select></div>
      <div class="dev-field" style="margin-top:10px"><span>${tr('studio.x.quality')}</span><select id="exp-q"></select></div>
      <div class="dev-field" style="margin-top:10px"><span>${tr('studio.x.span')}</span><select id="exp-span">
        <option value="full">${tr('studio.x.spanFull')}</option>
        <option value="range"${_exportRange ? '' : ' disabled'}>${_exportRange ? tr('studio.lbl.rangeSel') + ' (' + fmtTC(_exportRange.start) + '–' + fmtTC(_exportRange.end) + ')' : tr('studio.lbl.rangeHint')}</option>
      </select></div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="mini" id="exp-go">${tr('studio.x.export')}</button></div>
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
  if (_exporting) { flashTake(tr('studio.m.exportBusy')); return; }
  const base = mineOnly ? 'recording' : 'mix';
  const res = await api.dialog.saveAs(base + '.' + format, [format]);
  if (!res || !res.ok || !res.filePath) return;
  const rg = (useRange && _exportRange) ? _exportRange : { start: 0, end: 0 };   // end 0 = 끝까지
  _exporting = true;
  flashTake(tr('studio.m.exporting0'));
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
  if (!ps.length) { openModal(tr('studio.d.loadTakeSet'), '<div class="daw-modal-empty">' + tr('studio.m.noTakeSets') + '</div>', () => {}); return; }
  const host = $('daw-modal');
  const html = ps.map((p, i) => `<div class="daw-modal-item" data-idx="${i}">
    <div class="mt"><div class="n">${esc(p.name)}</div><div class="m">${tr('studio.p.takeCount', { n: p.takes.length })}</div></div>
    <button class="daw-preset-del" data-id="${esc(p.id)}" title="${tr('studio.t.delete')}">✕</button></div>`).join('');
  openModal(tr('studio.d.loadTakeSet'), html, (idx) => loadTakeSet(ps[Number(idx)]));
  host.querySelectorAll('.daw-preset-del').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    setTakeSets(getTakeSets().filter(p => p.id !== b.dataset.id));
    openTakeSetPicker();
  }));
}

// ── 오디오 설정 모달 ──
let _devOpen = false;
// 장치를 여러 개 쓰는 사용자 — 엔진은 매번 그 타입의 "첫 번째" 장치로 붙는다(ASIO 드라이버가
// 여럿이면 특히 눈에 띈다). 마지막으로 고른 장치를 기억해 뒀다가 다시 그쪽으로 붙인다.
//
// 엔진은 부팅하면서 일단 자기 기본 장치부터 연다 — 그 잠깐의 기본 장치 이름이 상태 표시줄에
// 스쳐 지나간 뒤에야 저장해 둔 장치 이름으로 바뀐다. 사용자에겐 "왜 저장한 장치가 바로 안
// 뜨지" 로 보인다. 그 사이엔 상태를 "저장된 장치로 연결 중…" 으로 고정해 감춘다.
// 'idle'     — 재연결과 무관, device 이벤트가 오면 그대로 상태에 반영한다
// 'checking' — 'ready' 는 왔지만 아직 listDevices() 응답을 못 받아 재연결이 필요한지도 모른다
// 'switching'— 저장해 둔 장치가 지금과 달라 setDevice 를 보냈다 — 그 결과 device 이벤트를 기다린다
let _devReconnectPhase = 'idle';
const DEV_CFG_KEY = 'yss.deviceConfig';
function saveDevConfig(cfg) {
  try { localStorage.setItem(DEV_CFG_KEY, JSON.stringify(cfg)); } catch {}
}
function loadDevConfig() {
  try { return JSON.parse(localStorage.getItem(DEV_CFG_KEY) || 'null'); } catch { return null; }
}
// 'devices' 응답을 받은 뒤 호출된다 — 그래야 저장해 둔 장치가 지금도 실제로 있는지 확인할 수
// 있다. 없는 장치로 억지로 붙으려 하면 (뽑아버린 인터페이스 등) setDevice 가 이미 기본 장치로
// 되돌리는 안전장치를 갖고 있다(엔진 쪽 fallback) — 여기서는 "다를 때만" 요청해 무한 재연결을
// 만들지 않는다.
// 실제로 setDevice 를 보냈으면 true — 호출부가 그 결과 device 이벤트를 기다려야 하는지 안다.
function reconnectSavedDevice(d) {
  const saved = loadDevConfig();
  if (!saved || !saved.type || !saved.output) return false;
  const already = saved.type === d.currentType && saved.output === d.output
    && (saved.input == null || saved.input === d.input);
  if (already) return false;
  const type = (d.types || []).find(t => t.name === saved.type);
  if (!type || !type.outputs.includes(saved.output)) return false;   // 그 타입에 그 장치가 지금 없다
  api.engine.setDevice({
    type: saved.type, output: saved.output,
    input: type.inputs.includes(saved.input) ? saved.input : undefined,
    sampleRate: saved.sampleRate, bufferSize: saved.bufferSize,
  });
  return true;
}
let _devModalGen = 0;   // 'devices' 이벤트마다 다시 부르므로, 늦게 도착한 렌더가 새 걸 덮어쓰지 않게
async function openDevModal(d) {
  const gen = ++_devModalGen;
  const host = $('daw-modal');
  const vstDirs = await api.settings.vstDirs();
  if (gen !== _devModalGen) return;   // 그 사이 다시 불렸으면(새 'devices' 이벤트 등) 이 렌더는 버린다
  const opts = (arr, cur) => (arr || []).map(v => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${v}</option>`).join('');
  const curType = (d.types || []).find(t => t.name === d.currentType) || (d.types || [])[0] || { outputs: [], inputs: [] };
  const rates = (d.rates && d.rates.length ? d.rates : [44100, 48000, 96000]).map(r => Math.round(r));
  // 입력 채널 목록 — 엔진이 준 이름(활성 입력만, 콜백 순서와 동일)이 없으면 번호로
  const chNames = (_inCfg.names && _inCfg.names.length)
    ? _inCfg.names
    : Array.from({ length: Math.max(1, _deviceInfo?.in || 1) }, (_, i) => tr('studio.p.inputN', { n: i + 1 }));
  const chOpts = (cur) => chNames.map((n, i) =>
    `<option value="${i}" ${i === cur ? 'selected' : ''}>${i + 1}. ${esc(n)}</option>`).join('');
  host.innerHTML = `<div class="daw-modal-box"><div class="daw-modal-h"><span>${tr('studio.x.audioSettings')}</span><button class="x">✕</button></div>
    <div class="daw-modal-list" style="padding:16px;display:flex;flex-direction:column;gap:12px">
      <label class="dev-field"><span>${tr('studio.x.driver')}</span><select id="dv-type">${opts((d.types || []).map(t => t.name), d.currentType)}</select></label>
      <label class="dev-field"><span>${tr('studio.x.outDevice')}</span><select id="dv-out">${opts(curType.outputs, d.output)}</select></label>
      <label class="dev-field"><span>${tr('studio.x.inDevice')}</span><select id="dv-in">${opts(curType.inputs, d.input)}</select></label>
      <label class="dev-field"><span>${tr('studio.x.sampleRate')}</span><select id="dv-sr">${opts(rates, Math.round(d.sampleRate))}</select></label>
      <label class="dev-field"><span>${tr('studio.x.bufferSize')}</span><select id="dv-buf">${opts(d.buffers && d.buffers.length ? d.buffers : [128, 256, 512], d.bufferSize)}</select></label>
      ${(() => {
        // 지금 열린 장치 기준(버퍼를 위에서 바꿨다면 적용 뒤에 다시 계산된다)
        const lat = latencyText();
        if (!lat) return '';
        return `<div class="dev-field dev-latency"><span>${tr('studio.x.latency')}</span><div>
          <div>${esc(tr('studio.x.latencyDetail', lat))}</div>
        </div></div>`;
      })()}
      <div class="dev-sep"></div>
      <label class="dev-field"><span>${tr('studio.x.inputMode')}</span><select id="dv-inmode">
        <option value="0" ${_inCfg.mode === 1 ? '' : 'selected'}>${tr('studio.x.modeMono')}</option>
        <option value="1" ${_inCfg.mode === 1 ? 'selected' : ''}>${tr('studio.x.modeStereo')}</option>
      </select></label>
      <label class="dev-field"><span id="dv-chl-lb">${_inCfg.mode === 1 ? tr('studio.lbl.leftChannel') : tr('studio.lbl.inputChannel')}</span><select id="dv-chl">${chOpts(_inCfg.chL)}</select></label>
      <label class="dev-field" id="dv-chr-row" ${_inCfg.mode === 1 ? '' : 'hidden'}><span>${tr('studio.x.rightChannel')}</span><select id="dv-chr">${chOpts(_inCfg.chR)}</select></label>
      <div class="dev-field"><span>${tr('studio.x.inputSignal')}</span><div class="dev-inmeters" id="dv-inmeters">${
        chNames.map((n, i) => `<div class="dev-inm"><b>${i + 1}</b><i data-ch="${i}"></i><em>${esc(n)}</em></div>`).join('')
      }</div></div>
      <div class="dev-sep"></div>
      <div class="dev-field" style="flex-direction:column;align-items:stretch;gap:6px">
        <span>${tr('studio.x.vstFolders')}</span>
        <div style="font-size:11px;opacity:.6">${tr('studio.x.vstFolderHint')}</div>
        <div id="dv-vst-list" style="display:flex;flex-direction:column;gap:4px">${
          vstDirs.length ? vstDirs.map(dir => `<div class="dev-vst-row" style="display:flex;align-items:center;gap:6px">
              <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px" title="${esc(dir)}">${esc(dir)}</span>
              <button class="mini dv-vst-rm" data-dir="${esc(dir)}">✕</button>
            </div>`).join('')
            : `<div style="font-size:12px;opacity:.5">${tr('studio.x.vstFolderEmpty')}</div>`
        }</div>
        <button class="mini" id="dv-vst-add" style="align-self:flex-start">${tr('studio.x.vstFolderAdd')}</button>
      </div>
      <div style="display:flex;justify-content:flex-end"><button class="mini" id="dv-apply">${tr('studio.x.apply')}</button></div>
    </div></div>`;
  host.hidden = false;
  host.querySelector('.x').addEventListener('click', () => host.hidden = true);
  $('dv-vst-add').addEventListener('click', async () => {
    const res = await api.settings.vstDirsAdd();
    if (res.canceled) return;
    api.engine.scanPlugins();       // 새 폴더 포함해 다시 스캔 (main 이 저장된 목록을 자동으로 실어 보냄)
    openDevModal(d);                // 목록 다시 그림
  });
  host.querySelectorAll('.dv-vst-rm').forEach(btn => btn.addEventListener('click', async () => {
    await api.settings.vstDirsRemove(btn.dataset.dir);
    api.engine.scanPlugins();
    openDevModal(d);
  }));
  // 모노/스테레오 전환 — 스테레오일 때만 오른쪽 채널을 고른다
  $('dv-inmode').addEventListener('change', (e) => {
    const st = e.target.value === '1';
    $('dv-chr-row').hidden = !st;
    $('dv-chl-lb').textContent = st ? tr('studio.lbl.leftChannel') : tr('studio.lbl.inputChannel');
  });
  // 드라이버 변경 → 즉시 전환 후 목록 갱신.
  // 타입 전환은 장치를 닫았다 다시 여는 것이라 몇백 ms ~ 몇 초 걸린다. 그 사이에 Apply 를
  // 누르면 dv-out 이 아직 "이전 타입"의 출력 목록을 보여 준 채라 — 그중 하나가 새 타입의
  // 목록에도 우연히 같은 이름으로 있으면(예: 서로 다른 드라이버가 같은 장치명을 쓰는 경우)
  // 실제로 연결된 장치가 아닌 엉뚱한 이름이 저장된다. 새 'devices' 응답으로 모달이 다시
  // 그려질 때까지 잠가서 그 경합을 없앤다(re-render 는 case 'devices' 가 이미 하고 있다).
  $('dv-type').addEventListener('change', (e) => {
    api.engine.setDevice({ type: e.target.value });
    $('dv-out').disabled = true;
    $('dv-in').disabled = true;
    $('dv-apply').disabled = true;
    $('dv-apply').textContent = tr('studio.x.connecting');
  });
  $('dv-apply').addEventListener('click', () => {
    const cfg = {
      type: $('dv-type').value, output: $('dv-out').value, input: $('dv-in').value,
      sampleRate: Number($('dv-sr').value), bufferSize: Number($('dv-buf').value),
    };
    const inCfg = {
      mode: Number($('dv-inmode').value),
      chL: Number($('dv-chl').value),
      chR: Number($('dv-chr').value),
    };
    // 장치를 바꾸는 중이면 지금 고른 채널은 "새 장치" 몫이다 — 아직 열려 있는 이전 장치
    // 이름으로 저장하면 이전 장치의 채널 설정을 덮어쓴다. 새 장치가 실제로 열린 뒤
    // device 이벤트에서 저장·적용한다(_pendingInCfg).
    const switching = cfg.type !== d.currentType || cfg.output !== d.output;
    _pendingInCfg = switching ? { target: cfg.output, cfg: inCfg } : null;
    api.engine.setDevice(cfg);
    saveDevConfig(cfg);   // 다음에 켤 때 이 장치로 다시 붙는다
    if (!switching) applyInputConfig(inCfg);
    host.hidden = true;
  });
}
// ── 입력 구성 (모노/스테레오 · 채널 선택) ────────────────
// 장치를 다시 열면 엔진 기본값으로 돌아가므로 여기 값을 다시 밀어 넣는다.
let _inCfg = { mode: 0, chL: 0, chR: 1, names: [] };
// 입력 채널은 장치 이름별로 저장한다(pickInputConfig 설명 참고). IN_CFG_KEY 는 예전 형식
// (장치 구분 없는 값 하나) — 새로 쓰지는 않고, 장치별 기록이 없을 때 한 번 이어받는 데만 쓴다.
const IN_CFG_KEY = 'yss.inputConfig';
const IN_CFG_DEV_KEY = 'yss.inputConfigByDevice';
// 설정 창에서 장치를 바꾸면서 채널도 같이 고른 경우 — 그 채널은 "새 장치"의 것인데, 적용
// 순간엔 아직 이전 장치가 열려 있다. 새 장치의 device 이벤트가 올 때까지 들고 있다가 그
// 장치 이름으로 저장한다. { target: 요청한 장치 이름, cfg }
let _pendingInCfg = null;
function readStoredJson(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function saveInputConfigFor(name, cfg) {
  if (!name) return;
  const map = readStoredJson(IN_CFG_DEV_KEY);
  const next = map && typeof map === 'object' ? map : {};
  next[name] = { mode: cfg.mode | 0, chL: cfg.chL | 0, chR: cfg.chR | 0 };
  try { localStorage.setItem(IN_CFG_DEV_KEY, JSON.stringify(next)); } catch {}
}
function applyInputConfig(cfg) {
  _inCfg = { ..._inCfg, ...cfg };
  api.engine.inputConfig({ mode: _inCfg.mode, chL: _inCfg.chL, chR: _inCfg.chR });
  saveInputConfigFor(_deviceInfo?.name, _inCfg);
}
// 설정 창이 열려 있을 때만 채널별 입력 미터를 갱신한다.
function updateInputChannelMeters(chans) {
  if (!Array.isArray(chans)) return;
  const host = document.getElementById('dv-inmeters');
  if (!host) return;
  for (const el of host.querySelectorAll('i[data-ch]')) {
    const v = chans[Number(el.dataset.ch)] || 0;
    el.style.setProperty('--v', meterPct(v) + '%');
  }
}
// ── 이벤트 ─────────────────────────────────────────
function onEngineEvent(m) {
  switch (m.ev) {
    case 'ready':
      _started = true;
      _recTracksBaseline = true;   // 이 연결에서 처음 오는 recTracks 는 편집이 아니라 동기화다
      // device 이벤트가 먼저 오는 경우가 있고, 재연결 중이면 그 표시를 유지해야 한다 —
      // 둘 다 'ready' 보다 더 정확한 상태이므로 덮어쓰지 않는다.
      if (_engStatus.kind !== 'device' && _devReconnectPhase !== 'checking') setEngineStatus('ready');
      showBoot('hide');   // 여기서부터 실제로 조작 가능 → 막 걷기
      $('st-engine-dot').classList.add('on');
      $('st-engine-start').hidden = true; $('st-engine-stop').hidden = false;
      setEnabled(true);
      api.engine.scanPlugins();   // 미리 스캔 → 톤 불러오기·VST 추가 즉시 가능
      updateMetro();   // 새로 뜬 엔진 프로세스는 메트로놈 on/off 를 기억 못 한다 — 다시 밀어 넣는다
      pushMetroExtra();   // 메트로놈도 녹음/박자표/세분화도 마찬가지로 다시 밀어 넣는다
      // 장치가 여러 개면 엔진은 그중 첫 번째로 붙는다(ASIO 드라이버가 여럿일 때 특히) —
      // 저장해 둔 게 있으면 그쪽으로 다시 붙인다. 목록을 받아야 실제로 있는 장치인지
      // 확인할 수 있으므로 'devices' 응답에서 처리한다(reconnectSavedDevice). phase 는
      // startEngine() 에서 이미 'checking' 으로 잠가 뒀다 — 여기서는 실제 요청만 보낸다.
      if (_devReconnectPhase === 'checking') api.engine.listDevices();
      break;
    case 'device': {
      const prevSr = _sr;
      _sr = m.sr || 44100;
      // srMismatch 는 더 이상 경고가 아니다 — 엔진이 스템을 장치 레이트로 맞춰 읽는다.
      // 사용자가 할 일이 없으므로 화면에는 띄우지 않고, 제보에 실리도록 진단에만 남긴다.
      _deviceInfo = { name: m.name, sr: m.sr, stemSr: m.stemSr, block: m.block, in: m.in, out: m.out,
                      roundtripMs: m.roundtripMs, srMismatch: !!m.srMismatch };
      _inCfg.names = Array.isArray(m.inNames) ? m.inNames : [];
      // 설정 창에서 장치를 바꾸며 고른 채널 — 실제로 그 장치가 열렸을 때만 그 장치 몫으로
      // 저장한다. 이름이 다른 device 이벤트(전환 전 장치가 닫히며 한 번 더 오는 경우 등)는
      // 건너뛰고 기다린다. 전환이 실패해 다른 장치로 되돌아갔으면 'deviceFallback' 에서 버린다
      // — 엉뚱한 장치의 저장값을 덮어쓰지 않는 게 우선이다.
      if (_pendingInCfg && m.name === _pendingInCfg.target) {
        saveInputConfigFor(m.name, _pendingInCfg.cfg);
        _pendingInCfg = null;
      }
      // 이 장치 몫으로 저장된 채널을 쓴다(없으면 기본값). 예전 형식(장치 구분 없는 값)은
      // 장치별 기록이 하나도 없을 때만 이어받는데, 재연결 확인 중('checking')에 스쳐 가는
      // 기본 장치 이벤트에는 저장하지 않는다 — 안 그러면 그 임시 장치가 예전 값을 차지해
      // 버려 정작 저장된 장치로 넘어갔을 땐 기본값으로 시작하게 된다.
      {
        const picked = pickInputConfig(readStoredJson(IN_CFG_DEV_KEY), readStoredJson(IN_CFG_KEY), m.name);
        _inCfg = { ..._inCfg, ...picked.cfg };
        if (picked.source === 'legacy' && _devReconnectPhase !== 'checking') saveInputConfigFor(m.name, picked.cfg);
      }
      // 장치를 새로 열면 엔진이 기본값(모노 1번)으로 돌아간다 → 저장해둔 설정을 다시 밀어 넣는다.
      // 이미 같은 값이면 보내지 않아 device 이벤트가 무한히 되돌아오는 것을 막는다.
      const want = _inCfg;
      const same = (m.inMode | 0) === want.mode && (m.inChL | 0) === want.chL && (m.inChR | 0) === want.chR;
      if (!same && inputConfigInRange(want, m.in)) api.engine.inputConfig({ mode: want.mode, chL: want.chL, chR: want.chR });
      // 재연결 확인/전환이 끝나지 않았으면 이 device 이벤트는 아직 스쳐 지나가는 기본 장치다 —
      // 상태 표시는 그대로 "저장된 장치로 연결 중…" 에 고정해 둔다. 'switching' 중에 온
      // device 이벤트는 그 전환의 결과이므로 여기서 phase 를 끝낸다.
      if (_devReconnectPhase === 'switching') _devReconnectPhase = 'idle';
      if (_devReconnectPhase === 'idle') setEngineStatus('device', { name: m.name, ms: m.roundtripMs });
      // 레이트가 실제로 달라졌을 때만 — 같은 값으로 다시 열리는 경우가 잦다
      if (prevSr && _sr !== prevSr) repushForSampleRate();
      break;
    }
    case 'fxError':
      if (m.reason === 'channels' && m.plugin) flashTake(tr('studio.p.fxLoadFailChannels', { name: m.plugin }));
      else flashTake(tr('studio.p.fxLoadFail', { n: m.failed }));
      break;
    case 'exportProgress':
      flashTake(tr('studio.p.exporting', { pct: Math.round(m.pct) }));
      break;
    case 'exportDone':
      if (_exportMp3) {   // 임시 WAV 렌더 끝 → MP3 변환
        const job = _exportMp3, tmp = _exportTmp; _exportMp3 = null; _exportTmp = null;
        flashTake(tr('studio.m.mp3Converting'));
        api.audio.transcode(tmp, job.dst, { bitrate: job.bitrate }).then((r) => {
          _exporting = false;
          if (r && r.ok) { flashTake(tr('studio.m.exportDone') + job.dst); api.openPath(job.dst); }
          else flashTake(tr('studio.m.mp3Fail') + (r && r.error || ''));
        });
      } else {
        _exporting = false;
        flashTake(tr('studio.m.exportDone') + (m.file || ''));
        if (m.file) api.openPath(m.file);
      }
      break;
    case 'exportError':
      _exporting = false; _exportMp3 = null; _exportTmp = null;
      flashTake(tr('studio.m.exportFail') + (m.msg || ''));
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
          if (!g.id) flashTake(tr('studio.m.toneSaved') + preset.name);
        }
      }
      break;
    case 'devices':
      if (_devReconnectPhase === 'checking') {
        const switching = reconnectSavedDevice(m);
        if (switching) {
          _devReconnectPhase = 'switching';   // setDevice 를 보냈다 — 그 결과 device 이벤트를 기다린다
        } else {
          _devReconnectPhase = 'idle';   // 저장된 장치가 없거나 이미 그 장치다 — 더 기다릴 게 없다
          if (_deviceInfo) setEngineStatus('device', { name: _deviceInfo.name, ms: _deviceInfo.roundtripMs });
        }
      }
      if (_devOpen) { openDevModal(m); _devOpen = false; }
      // "열려있으면 갱신"은 열려있는 게 오디오 설정 모달 자신일 때만 해야 한다 — 부팅
      // 직후 저장된 장치 재연결 체크도 listDevices() 를 부르는데(_devReconnectPhase),
      // 그 응답이 하필 사용자가 방금 연 다른 모달(곡 고르기 등) 위로 도착하면 예전엔
      // "뭐든 열려있으면" 조건이라 그 모달을 통째로 오디오 설정으로 덮어써 버렸다
      // (실사용 제보: 스튜디오 로딩 끝나자마자 곡 불러오기를 누르면 가끔 오디오 설정
      // 모달이 뜸). #dv-out 은 openDevModal() 이 그릴 때만 존재하는 요소라 지금 열려있는
      // 게 오디오 설정 모달인지 정확히 가려낸다.
      else if (!$('daw-modal').hidden && $('dv-out')) openDevModal(m);
      break;
    case 'pos': onPos(m.samples); break;
    case 'level':
      updateVU(m.peak); updateInputChannelMeters(m.chans);
      if (_recArmed && _playing && _recStartSec != null) pushRecLivePeak(_lastSec - _recStartSec, m.peak || 0);   // 녹음 중 실시간 파형용 — 아래 updateRecLive() 참고
      break;
    case 'pitch': updateTuner(m.freq); break;
    case 'trackMeter': onTrackMeter(m.list || []); break;
    case 'pdc': {   // 플러그인 지연 보정 — 보정할 지연이 있을 때만 표시. 클릭으로 on/off
      const el = document.getElementById('daw-pdc');
      if (el) {
        _pdcOn = m.on !== false;
        const ms = Number(m.ms || 0);
        _pdcMs = ms;
        el.hidden = ms < 0.5;                       // 보정할 지연 자체가 없으면 숨김
        el.classList.toggle('on', _pdcOn);
        el.textContent = _pdcOn ? tr('studio.p.pdcOn', { ms: ms.toFixed(1) }) : tr('studio.p.pdcOff', { ms: ms.toFixed(1) });
        el.title = _pdcOn
          ? tr('studio.p.pdcTitle', { n: Math.round(m.samples || 0), ms: ms.toFixed(1) })
          : tr('studio.lbl.pdcOffWarn');
      }
      renderEngineStatus();   // 상태 표시의 지연 툴팁에 보정분이 들어간다
      break;
    }
    case 'recTracks': {
      const prevMeta = new Map(_recTracks.map(r => [r.id, { name: r.name, color: r.color, height: r.height }]));
      const RECPAL = ['var(--rec-c1)', 'var(--rec-c2)', 'var(--rec-c3)', 'var(--rec-c4)', 'var(--rec-c5)'];
      let recColorIdx = _recTracks.filter(r => r.type !== 1 && r.color).length;   // 이미 배정된 녹음 트랙 수만큼 팔레트 순번을 이어간다
      _recTracks = (m.list || []).map(r => {
        const p = prevMeta.get(r.id);
        if (p) return { ...r, ...p };   // 기존 트랙(사용자가 고른 색 포함) 보존
        if (r.type !== 1) return { ...r, color: RECPAL[recColorIdx++ % RECPAL.length] };   // 처음 보는 녹음 트랙엔 팔레트 색을 순환 배정(Ableton/Logic 관례)
        return r;   // 오디오(임포트) 트랙은 스템 색 계열 기본값을 그대로 씀
      });   // 렌더러 전용 메타(이름·색·높이) id로 보존
      if (m.gen != null) {
        _recTracksGen = m.gen;
        _recTracksWaiters.filter(w => w.gen === m.gen).forEach(w => w.resolve(true));
      }
      _takes = _takes.filter(t => _recTracks.some(r => r.id === t.trackId));   // 삭제된 트랙의 테이크 정리(고아 방지)
      _midiClips = _midiClips.filter(c => _recTracks.some(r => r.id === c.trackId));
      updateKbButtons();
      renderRecLanes(); updateSoloDim();
      if (!selValid(_selTrack)) {   // 스템 선택은 유지
        const a = armedRecId() != null ? armedRecId() : (_recTracks[0] && _recTracks[0].id);   // 녹음 대상 우선, 없으면 아무 트랙
        selectTrack(a != null ? a : null);
      } else { syncSelection(); updateFxPanel(); }
      if (_recTracksBaseline) _recTracksBaseline = false; else markDirty();
      break;
    }
    case 'take':
      clearRecLive();
      // 이미 가지고 있는 id 면 새로 녹음된 것이 아니라 다시 실은 것이다.
      // 장치 레이트가 프로젝트와 다르면 repushForSampleRate() 가 클립을 전부 다시 싣는데,
      // 그것까지 녹음으로 치면 방금 연 프로젝트가 "변경됨"이 되고 실행취소 스택에도
      // 하지 않은 녹음이 클립 수만큼 쌓인다.
      const reloaded = _takes.some(t => t.id === m.id);
      // 녹음된 클립이 타임라인에 나타나는 것이 곧 확인이다. 파일 경로는 알림으로 띄울 정보가 아니다.
      (async () => {
        await renderTake(m.file, m.timelineStart || 0, m.id, m.trackId);
        if (reloaded) return;
        const tk = _takes.find(t => t.id === m.id);
        if (tk) {
          const snap = { ...tk };   // undo용 스냅샷 (파형·트림·페이드 유지)
          pushUndo(() => removeClipById(m.id), () => reAddClip(snap), tr('studio.lbl.record'));
        }
        markDirty();
      })();
      break;
    case 'midiTake': onMidiTake(m); break;
    case 'exit':
      // handleEngineCrash 의 복구 스냅샷(buildProjectObject({skipFx:true}), await 없이
      // 동기 실행됨)은 반드시 아래 _recTracks 등을 비우기 전에 먼저 시작해야 한다 —
      // 순서가 뒤바뀌어 있던 예전 코드는 스냅샷이 이미 빈 배열을 찍어서, 크래시 직후
      // 되살아난 엔진에 녹음 트랙이 통째로 사라졌다(실제 제보: 새 녹음트랙 만들고
      // 싱크룸 VST 로드 → 엔진이 크래시로 재시작되며 방금 만든 트랙이 없어짐).
      if (m.crashed) handleEngineCrash(m);   // 우리가 끝낸 것이 아니면 되살린다
      // 위 복구 스냅샷은 이미 동기적으로 캐시를 읽어 갔다 — 이제 이 캐시는 죽은 프로세스의
      // 슬롯 번호라 다음 프로세스에선 엉뚱한 플러그인을 가리킬 수 있다. 비우고 세대를 올린다.
      _fxStateCache = {}; _engineGen++;
      _started = false; _playing = false;
      setEngineStatus('off');
      $('st-engine-dot').classList.remove('on');
      $('st-engine-start').hidden = false; $('st-engine-start').disabled = false;
      $('st-engine-stop').hidden = true;
      _chain = []; _chainByTrack = {}; _selTrack = null; _recTracks = [];
      _recArmed = false; $('st-rec').classList.remove('armed'); clearRecLive();   // 재시작 후 녹음버튼 잔상 방지
      _activePresetId = null; renderFxSlots(); renderRecLanes(); updateFxPanel();
      setEnabled(false);
      break;
    case 'error': setEngineStatus('error'); break;
    // ASIO 로 못 갈아타서 되돌아왔다. 조용히 넘어가면 사용자는 왜 지연이 큰지,
    // 왜 자기 오인페가 안 잡히는지 알 방법이 없다.
    case 'deviceFallback': _pendingInCfg = null; flashTake(tr('studio.m.asioFallback')); break;
    case 'log':
      // 엔진 로그는 개발자용 영문이라 사용자에게 띄우지 않는다.
      // (녹음 준비·파일 쓰기 같은 정상 동작까지 걸려 알림으로 새어 나왔다)
      // 실제 실패는 'error' 이벤트와 각 동작의 자체 안내로 전달된다.
      break;
  }
}

function renderFxSlots() {
  const pb = $('st-fx-bypassall');   // 전원 토글: 하나라도 켜져 있으면 active(초록)
  if (pb) { pb.classList.toggle('active', _chain.length > 0 && _chain.some(s => !s.bypass)); }
  const box = $('st-fx-slots'); if (!box) return;
  box.innerHTML = '';
  // 악기 트랙인데 맨 앞이 악기 VST 가 아니면 엔진의 내장 신스가 소리를 낸다 — 목록에 보이게
  const selRt = _recTracks.find(r => r.id === _selTrack);
  if (selRt && selRt.type === 2 && !(_chain[0] && _chain[0].instrument)) {
    const b = document.createElement('div');
    b.className = 'daw-fx-slot daw-fx-builtin';
    b.innerHTML = `<span class="pw on"></span><div class="info"><div class="n">${tr('studio.midi.builtin')}</div><div class="m">${tr('studio.midi.builtinHint')}</div></div>`;
    box.appendChild(b);
  }
  _chain.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'daw-fx-slot' + (s.bypass ? ' bypassed' : '');
    row.draggable = true; row.dataset.id = s.id;
    const wideTag = s.wideOut > 2 ? `<span class="fx-wide-tag" title="${esc(tr('studio.t.fxWideHint', { n: s.wideOut }))}">${tr('studio.t.fxWideBadge')}</span>` : '';
    row.innerHTML = `<span class="drag" title="${tr('studio.t.dragReorder')}">⠿</span>
      <span class="pw ${s.bypass ? '' : 'on'}" title="${tr('studio.t.clickToggle')}"></span>
      <div class="info"><div class="n">${s.name}${wideTag}</div></div>
      <button class="ed" title="${tr('studio.t.edit')}" ${s.hasEditor ? '' : 'disabled'}>✎</button>
      <button class="del" title="${tr('studio.t.delete')}">✕</button>`;
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

// ── 엔진 상태 표시 ─────────────────────────────────
// 문자열을 바로 넣지 않고 상태를 보관했다가 그린다. 언어를 바꾸면 applyI18n 이
// data-i18n 요소의 textContent 를 덮어쓰는데, 여기는 장치명·지연처럼 실시간 값이
// 들어가는 자리라 그러면 "오디오 꺼짐" 으로 되돌아가 버린다.
let _engStatus = { kind: 'off' };
function setEngineStatus(kind, extra) { _engStatus = { kind, ...(extra || {}) }; renderEngineStatus(); }
function renderEngineStatus() {
  const el = $('st-engine-status'); if (!el) return;
  const s = _engStatus;
  el.textContent =
    s.kind === 'device'      ? String(s.name || '')
  : s.kind === 'ready'       ? tr('studio.lbl.audioReady')
  : s.kind === 'connect'     ? tr('studio.lbl.connecting')
  : s.kind === 'reconnect'   ? tr('studio.lbl.reconnecting')
  : s.kind === 'failed'      ? tr('studio.lbl.audioOpenFail')
  : s.kind === 'error'       ? tr('studio.lbl.audioError')
  :                            tr('studio.lbl.audioOff');
  // 장치가 열려 있으면 지연 내역을 툴팁으로 — 숫자 하나로는 어디서 늦어지는지 알 수 없다
  const lat = s.kind === 'device' ? latencyText() : null;
  el.title = lat ? tr('studio.lbl.latencyTitle', lat) : '';
}
// 지연 내역을 화면 문구용 값으로(ms, 소수 1자리). 장치 정보가 없으면 null.
function latencyText() {
  const d = _deviceInfo;
  if (!d || !(d.sr > 0)) return null;
  const b = latencyBreakdown({ sr: d.sr, block: d.block, roundtripMs: d.roundtripMs, pdcMs: _pdcMs, pdcOn: _pdcOn });
  const f = (v) => v.toFixed(1);
  return { total: f(b.monitorMs), buf: f(b.bufferMs), drv: f(b.driverMs), pdc: f(b.pdcMs) };
}

// ── 오디오 엔진 시작 ───────────────────────────────
// 스튜디오에 들어오면 자동으로 켠다. 예전엔 수동이라 처음 온 사람이 재생·녹음·Export 가
// 전부 회색인 화면을 먼저 보게 됐다(setEnabled 가 컨트롤 24개를 막는다).
// 실패했을 땐 자동 재시도하지 않는다 — 장치를 못 잡는 상황에서 탭을 오갈 때마다
// 다시 붙잡으려 들면 다른 DAW 와 계속 충돌한다. 그때는 버튼으로 직접 누르게 둔다.
// 진입 시 자동으로 여는 동안 화면을 덮는다 — 조작되는 것처럼 보이는 상태를 막는다.
function showBoot(state) {
  const box = $('daw-boot'); if (!box) return;
  if (state === 'hide') { box.hidden = true; return; }
  // 'crashloop' — 반복 크래시로 자동 재시작을 포기했을 때. 이 시점엔 이미 최초 부팅을
  // 지나 daw-boot 가 숨겨져 있던 상태라(실사용 중), 여기서 다시 띄워 주지 않으면
  // setEnabled(false)로 잠긴 화면만 남고 왜 멈췄는지 · 어떻게 풀어야 하는지 보여줄 데가
  // 없다(사용자 제보: 버튼 눌러도 반응 없음 — flashTake 토스트는 몇 초 뒤 사라져 버려서
  // 원인·해결법이 화면에 안 남았다).
  const failed = state === 'failed' || state === 'crashloop';
  box.hidden = false;
  $('daw-boot-spin').hidden = failed;
  $('daw-boot-title').textContent = tr(state === 'crashloop' ? 'studio.crash.loop.title' : (failed ? 'studio.boot.failTitle' : 'studio.boot.title'));
  $('daw-boot-sub').textContent = tr(state === 'crashloop' ? 'studio.crash.loop' : (failed ? 'studio.boot.failSub' : 'studio.boot.sub'));
  $('daw-boot-retry').hidden = !failed;
}

let _engineTried = false;
async function startEngine(manual) {
  if (_started) { showBoot('hide'); return true; }
  if (_engineTried && !manual) return false;   // 자동은 한 번만
  _engineTried = true;
  const btn = $('st-engine-start');
  if (btn) btn.disabled = true;
  // 저장해 둔 장치가 있으면 엔진이 자기 기본 장치로 먼저 붙는 그 순간부터 잠가 둔다 —
  // 그 device 이벤트가 'ready' 보다 먼저 오는 경우가 있어서(엔진이 부팅하며 곧장 여니까),
  // 'ready' 핸들러에서 잠그면 이미 한 번 새 나간 뒤가 될 수 있다.
  _devReconnectPhase = loadDevConfig() ? 'checking' : 'idle';
  setEngineStatus(_devReconnectPhase === 'checking' ? 'reconnect' : 'connect');
  showBoot('loading');
  const r = await api.engine.start([], 'studio').catch(() => ({ ok: false }));
  if (!r || !r.ok) {
    setEngineStatus('failed');
    showBoot('failed');
    if (btn) { btn.disabled = false; btn.hidden = false; btn.textContent = tr('studio.lbl.audioRetry'); }
    if (r && r.busy) flashTake(tr('studio.m.trainingBusy'));
    return false;
  }
  // 성공해도 'ready' 이벤트가 와야 실제로 쓸 수 있다 → 막은 거기서 걷는다
  return true;
}

// ── 배선 ───────────────────────────────────────────
function wire() {
  if (_wired) return; _wired = true;
  api.engine.onEvent(onEngineEvent);

  $('st-engine-start').addEventListener('click', () => startEngine(true));
  $('daw-boot-retry')?.addEventListener('click', () => startEngine(true));

  $('st-load-song').addEventListener('click', openSongPicker);
  $('st-close-song').addEventListener('click', closeSong);

  const video = $('daw-video');
  video.addEventListener('loadedmetadata', () => { _baseDur = video.duration || 0; recomputeDur(); video.playbackRate = _speed || 1; layout(); $('daw-vplay').hidden = false; });

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
    if (isTypingTarget(t)) return;   // 슬라이더에 포커스가 남아 있어도 단축키·연주는 된다
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
    else { if (_recArmed) stopAll(); else { if (!armedRecIds().length && !armedMidiIds().length) { const id = _selTrack != null ? _selTrack : armedRecId(); if (id != null) api.engine.recArm(id); } armRecPlay(); } }
  });
  // 언어를 바꾸면 이미 그려둔 스템 라벨·패널 문구가 옛 언어로 남는다 → 다시 그린다
  onLocaleChange(() => {
    _tracks.forEach(tk => { tk.label = stemLabel(tk.key); });   // tr 은 번역 함수라 가리면 안 됨
    renderTracks(); updateFxPanel(); updateTrackFader();
    // renderTracks() 가 .daw-lane 을 통째로 새로 그려서 .daw-clip 도 빈 채로 새로 생긴다 —
    // 파형은 줌 배율 바뀔 때(1249줄)처럼 캐시된 _stemBuffers 로 다시 그려 줘야 한다
    // (안 그러면 언어 바꿀 때마다 스템 트랙 파형만 사라지는 버그 — 사용자 제보).
    renderWaves();
    renderEngineStatus();   // 실시간 값이 들어가는 자리라 data-i18n 대상이 아니다 → 직접 다시 그림
  });
  buildFaderScales();
  updateBusStrips();   // 트랙이 없는 첫 화면에선 버스도 잠금
  // 마스터 볼륨 — 좌측 믹서 페이더 (하단바 슬라이더는 제거됨)
  const applyMaster = (pos) => {
    const g = faderToGain(pos);
    api.engine.master(g); $('mx-master').value = pos; $('mx-master-val').textContent = dbText(g); markDirty();
  };
  $('mx-master').addEventListener('input', (e) => applyMaster(Number(e.target.value)));
  $('mx-master').addEventListener('dblclick', () => applyMaster(FADER_UNITY_POS));   // 더블클릭 = 100% (유니티)
  // 스템 일괄 볼륨 — 개별 스템 페이더는 그대로 두고 엔진에 나가는 gain만 이 배율만큼 스케일
  const applyStemGroup = (pos) => {
    _stemGroupGain = faderToGain(pos);
    $('mx-stem-group').value = pos; $('mx-stem-group-val').textContent = dbText(_stemGroupGain);
    pushAllStemGains();
  };
  $('mx-stem-group').addEventListener('input', (e) => applyStemGroup(Number(e.target.value)));
  $('mx-stem-group').addEventListener('dblclick', () => applyStemGroup(FADER_UNITY_POS));
  // 선택 트랙 볼륨 페이더 (믹서 우측)
  const applyTrackVol = (pos) => {
    if (!selValid(_selTrack)) return;
    const g = faderToGain(pos);
    applySelTrackGain(_selTrack, g);   // 스템=track(index)·녹음=recTrack(id) 라우팅
    $('mx-track').value = pos; $('mx-track-val').textContent = dbText(g);
    const lv = document.querySelector(`.daw-lane[data-selid="${_selTrack}"] .daw-vol`); if (lv) lv.value = pos;
  };
  $('mx-track').addEventListener('input', (e) => applyTrackVol(Number(e.target.value)));
  $('mx-track').addEventListener('dblclick', () => applyTrackVol(FADER_UNITY_POS));   // 더블클릭 = 100%

  // ── 센드 버스 A/B ──
  for (let i = 0; i < BUS_COUNT; i++) {
    const n = BUS_NAMES[i];
    const f = $(`mx-bus${n}`);
    const applyBus = (pos) => {
      const g = faderToGain(pos);
      _buses[i].gain = g;
      api.engine.bus(i, { gain: g });
      f.value = pos; $(`mx-bus${n}-val`).textContent = dbText(g);
      markDirty();
    };
    f?.addEventListener('input', (e) => applyBus(Number(e.target.value)));
    f?.addEventListener('dblclick', () => applyBus(FADER_UNITY_POS));
    // 라벨 클릭 = 이 버스를 이펙트 편집 대상으로. 같은 걸 다시 누르면 직전 트랙으로 돌아온다
    // (버스에는 레인이 없어서 그냥 두면 트랙 이펙트로 되돌아갈 길이 없다).
    $(`mx-bus${n}-lbl`)?.addEventListener('click', () => {
      const id = BUS_ID_BASE + i;
      if (_selTrack === id) { selectTrack(_prevTrackSel); return; }
      if (!isBusId(_selTrack)) _prevTrackSel = _selTrack;
      selectTrack(id);
    });
  }
  // 선택 트랙 → 버스 센드량
  for (let i = 0; i < BUS_COUNT; i++) {
    const key = BUS_NAMES[i].toLowerCase();
    $(`mx-send-${key}`)?.addEventListener('input', (e) => {
      const o = selTrackObj(_selTrack); if (!o) return;
      const v = Number(e.target.value) / 100;
      const sends = sendsOf(o).slice(); sends[i] = v;
      o.sends = sends;
      pushSends(_selTrack, sends);
      $(`mx-send-${key}-val`).textContent = Math.round(v * 100);
      markDirty();
    });
    $(`mx-send-${key}`)?.addEventListener('dblclick', (e) => { e.target.value = 0; e.target.dispatchEvent(new Event('input')); });
  }
  $('st-seek0').addEventListener('click', () => {
    if (_recArmed) return;
    api.engine.seek(0); syncVideo(0); updatePlayhead(0);
    // 재생선만 옮기고 화면은 그대로라, 멈춘 상태에선 재생선이 안 보였다(요청) — 타임라인도 맨 앞으로
    const sc = $('daw-tscroll'); if (sc) sc.scrollLeft = 0;
  });
  $('st-rec').addEventListener('click', () => {
    if (!_recArmed && !armedRecIds().length && !armedMidiIds().length) { flashTake(tr('studio.m.addRecTrackAndArm')); return; }
    _recArmed = !_recArmed;
    $('st-rec').classList.toggle('armed', _recArmed);
    $('st-rec').setAttribute('aria-pressed', String(_recArmed));
    if (_recArmed) { api.engine.recordArm(_projectPath, armedRecIds(), 'studio', armedMidiIds()); midiRecAssist(); } else { api.engine.recordStop(); clearRecLive(); }
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
    } else if (e.target.closest('.daw-head, .daw-addrec-head, .sp-head, .daw-auto-head')) {
      return;   // 트랙 컨트롤부(하단 spacer 컨트롤 영역 포함) = 위아래 스크롤(native 세로)
    } else {                               // 타임라인 위 = 가로 스크롤(촘촘하게)
      e.preventDefault();
      sc.scrollLeft += (Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * 0.4;
      updatePlayhead(_lastSec);
    }
  }, { passive: false });

  $('daw-tscroll').addEventListener('scroll', () => updatePlayhead(_lastSec));
  wireHScroll();

  // 오디오 파일 임포트 — 버튼 + 타임라인 드래그드롭
  $('st-file-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    openDropdown(e.currentTarget, [
      { label: tr('studio.d.importAudio'), fn: pickImportAudio },
      { label: tr('studio.d.openProject'), fn: openProject },
      { label: tr('studio.d.saveProject'), fn: saveProject },
      { label: tr('studio.d.closeProject'), fn: closeProject },
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
  $('st-speed-btn')?.addEventListener('click', openSpeedModal);
  $('st-key-btn')?.addEventListener('click', openKeyModal);
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
    if (!_chain.length) { flashTake(tr('studio.m.noVst')); return; }
    const p = _activePresetId && getPresets().find(x => x.id === _activePresetId);
    if (p) { startGather({ id: p.id, name: p.name }); flashTake(tr('studio.m.toneOverwritten') + p.name); }   // 활성 톤 덮어쓰기
    else openNameModal(tr('studio.d.saveTone'), '', (name) => startGather({ name }));                       // 활성 없으면 새로
  });
  $('st-fx-saveas').addEventListener('click', () => {
    if (!_chain.length) { flashTake(tr('studio.m.noVst')); return; }
    openNameModal(tr('studio.d.saveToneAs'), '', (name) => startGather({ name }));
  });
  $('st-fx-load').addEventListener('click', openPresetPicker);
  // 이펙트 일괄 끄기/켜기 (선택 트랙)
  $('st-fx-bypassall').addEventListener('click', () => {
    if (_selTrack == null || !_chain.length) { flashTake(tr('studio.m.noVst')); return; }
    const allOff = _chain.every(s => s.bypass);   // 전부 꺼져있으면 → 켜기, 아니면 → 끄기
    api.engine.fxBypassAll(_selTrack, !allOff);
  });
  // 트랙 빈 곳 드래그 = 팬(가로 스크롤), 클릭 = 재생선 이동 + 트랙 선택
  $('daw-lanes').addEventListener('pointerdown', (e) => {
    const area = e.target.closest('.daw-area');
    if (!area || e.target.closest('.daw-clip, .daw-take-clip, .daw-drag-badge')) return;
    if (_marqueeOn && e.button === 0) { startMarquee(e); return; }
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
        else flashTake(tr('studio.p.rangeSet', { a: fmtTC(_exportRange.start), b: fmtTC(_exportRange.end) }));
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
    flashTake(_rangeMode ? tr('studio.m.rangeModeOn') : tr('studio.m.rangeModeOff'));
  });
  $('st-add-rec').addEventListener('click', () => api.engine.recTrackAdd(0, 'studio'));   // 코너 ＋ = 녹음 트랙 추가
  $('st-add-instr')?.addEventListener('click', () => api.engine.recTrackAdd(2, 'studio'));   // 🎹 = 악기(MIDI) 트랙 추가
  $('st-kb')?.addEventListener('click', () => setKbMode(!_kbOn));
  $('st-kb-cfg')?.addEventListener('click', (e) => { e.stopPropagation(); openQuantPopoverAt(e.clientX, e.clientY); });
  wireKeyboardPlay();
  // 빈 화면의 행동 버튼 — 기존 메뉴와 같은 동작을 그대로 부른다(동작이 갈라지지 않게)
  $('empty-load-song')?.addEventListener('click', openSongPicker);
  $('empty-open-proj')?.addEventListener('click', () => openProject());
  $('empty-add-rec')?.addEventListener('click', () => api.engine.recTrackAdd(0, 'studio'));
  $('empty-add-audio')?.addEventListener('click', pickImportAudio);
  // 트랙 빈 영역(레인 스크롤) 우클릭 = 트랙 추가
  $('daw-tscroll').addEventListener('contextmenu', (e) => {
    if (e.target.closest('.daw-lane-rec, .daw-take-clip, .daw-clip')) return;   // 트랙/클립 위는 각자 메뉴
    if (!_started) return;
    e.preventDefault();
    openDropdownAt(e.clientX, e.clientY, [{ label: tr('studio.lbl.addRecTrack'), fn: () => api.engine.recTrackAdd(0, 'studio') },
      { label: tr('studio.midi.addInstr'), fn: () => api.engine.recTrackAdd(2, 'studio') }]);
  });
  $('st-engine-stop').addEventListener('click', () => { api.engine.quit(); });
  $('st-audio-settings').addEventListener('click', () => { _devOpen = true; api.engine.listDevices(); });
  $('st-shortcuts').addEventListener('click', openShortcutsModal);
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
    flashTake(_returnOnStop ? tr('studio.lbl.returnOn') : tr('studio.lbl.returnOff'));
  });

  // 자석 스냅 on/off (설정 유지) — Alt 는 이 상태와 무관하게 그 드래그 한 번만 뒤집는다
  _magnetOn = localStorage.getItem('yss:magnetOn') !== '0';
  $('st-magnet').classList.toggle('on', _magnetOn);
  $('st-magnet').setAttribute('aria-pressed', String(_magnetOn));
  $('st-magnet').addEventListener('click', () => {
    _magnetOn = !_magnetOn;
    localStorage.setItem('yss:magnetOn', _magnetOn ? '1' : '0');
    $('st-magnet').classList.toggle('on', _magnetOn);
    $('st-magnet').setAttribute('aria-pressed', String(_magnetOn));
    flashTake(_magnetOn ? tr('studio.lbl.magnetOn') : tr('studio.lbl.magnetOff'));
  });

  // 마퀴(영역 드래그 다중선택) 모드 on/off — 세션 동안만 유지(자석처럼 저장 안 함, st-range-mode 와 동일 패턴)
  $('st-marquee').addEventListener('click', () => {
    _marqueeOn = !_marqueeOn;
    $('st-marquee').classList.toggle('on', _marqueeOn);
    $('st-marquee').setAttribute('aria-pressed', String(_marqueeOn));
    $('daw-lanes').classList.toggle('marquee-mode', _marqueeOn);
    flashTake(_marqueeOn ? tr('studio.lbl.marqueeOn') : tr('studio.lbl.marqueeOff'));
  });

  // 클립 카드 투명도(모든 트랙 일괄) — 클릭 위치에 슬라이더 팝오버
  applyClipOpacity();
  $('st-clip-opacity').addEventListener('click', (e) => {
    e.stopPropagation();
    openOpacityPopoverAt(e.clientX, e.clientY);
  });

  // 메트로놈 on/off (설정 유지)
  _metroOn = localStorage.getItem('yss:metroOn') === '1';
  $('st-metro').classList.toggle('on', _metroOn);
  $('st-metro').setAttribute('aria-pressed', String(_metroOn));
  $('st-metro').addEventListener('click', () => {
    _metroOn = !_metroOn;
    localStorage.setItem('yss:metroOn', _metroOn ? '1' : '0');
    $('st-metro').classList.toggle('on', _metroOn);
    $('st-metro').setAttribute('aria-pressed', String(_metroOn));
    updateMetro();
    flashTake(_metroOn ? tr('studio.lbl.metroOn') : tr('studio.lbl.metroOff'));
  });

  // 메트로놈 설정(메트로놈도 녹음 / 박자표 / 세분화) — 설정 유지
  _metroBake = localStorage.getItem('yss:metroBake') === '1';
  _metroBeats = Number(localStorage.getItem('yss:metroBeats')) || 4;
  _metroSubdiv = Number(localStorage.getItem('yss:metroSubdiv')) || 1;
  pushMetroExtra();
  $('st-metro-cfg').addEventListener('click', (e) => { e.stopPropagation(); openMetroPopoverAt(e.clientX, e.clientY); });

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
  $('daw-pdc').addEventListener('click', () => { _pdcOn = !_pdcOn; api.engine.pdc(_pdcOn); });
  $('st-tools-toggle').addEventListener('click', () => { const d = $('daw-tools'); d.hidden = !d.hidden; syncHeroState(); });
  $('st-tools-close').addEventListener('click', () => { $('daw-tools').hidden = true; syncHeroState(); });
  // 영상 접기/펴기
  $('daw-video-collapse').addEventListener('click', () => setVideoCollapsed(true));
  $('daw-hero-expand').addEventListener('click', () => setVideoCollapsed(false));
  syncHeroState();
  wireHeroResize();
  const selectTool = (name) => {
    document.querySelectorAll('.daw-tool-tab').forEach(b => b.classList.toggle('on', b.dataset.tool === name));
    // #daw-tools 로 스코프 — 트레이닝 탭 도구 카드들도 같은 배경/테두리 스타일을 쓰려고
    // .daw-tool 클래스를 그대로 재사용하는데, 스코프 없이 문서 전체를 뒤지면 그 카드들까지
    // 여기 딸려서 hidden 처리된다(스튜디오를 처음 열 때 selectTool(null) 이 모든 .daw-tool
    // 을 숨기면서 트레이닝 쪽 메트로놈/BPM 트레이너 카드까지 사라지던 버그의 원인).
    document.querySelectorAll('#daw-tools .daw-tool').forEach(el => { el.hidden = el.dataset.tool !== name; });
    // #tool-tab(베이스 TAB 패널)은 영상 폭 그대로 쓰려고 #daw-tools 밖으로 뺀 자리라
    // 위 스코프된 sweep 에 안 걸린다 — 따로 켜고 꺼야 한다.
    const tabPanel = $('tool-tab'); if (tabPanel) tabPanel.hidden = name !== 'tab';
    const empty = $('tool-empty'); if (empty) empty.hidden = !!name;
    // 피치 검출은 무거우므로 튜너가 열려 있을 때만 돌린다
    api.engine.tuner(name === 'tuner');
    if (name === 'tab') refreshTabPanel();
  };
  const tabRun = $('st-tab-run');
  if (tabRun) tabRun.addEventListener('click', runStudioTab);
  $('st-tab-cancel')?.addEventListener('click', cancelTranscribe);
  $('st-tab-bar-prev')?.addEventListener('click', () => shiftTabBars(-1));
  $('st-tab-bar-next')?.addEventListener('click', () => shiftTabBars(1));
  // TAB(프렛보드) 뷰는 기본으로 꺼져 있다 — 코드 스트립만으로 부족할 때만 켠다.
  $('st-tab-toggle')?.addEventListener('click', (e) => {
    const view = $('st-tab-view'); if (!view) return;
    view.hidden = !view.hidden;
    e.currentTarget.classList.toggle('on', !view.hidden);
  });
  document.querySelectorAll('.daw-tool-tab').forEach(b =>
    b.addEventListener('click', () => selectTool(b.classList.contains('on') ? null : b.dataset.tool)));   // 다시 누르면 닫기
  selectTool(null);   // 처음엔 아무 도구도 안 열림
}

let _studioBooted = false;
// 트랙 하단 가로 스크롤바 — #daw-tscroll 의 기본 가로바는 sticky 트랙 컨트롤 칸 밑까지 깔려서
// 숨겨 두고(CSS), 컨트롤 칸 오른쪽부터 시작하는 별도 바(#daw-hscroll)를 둔다. 폭·위치는
// 타임라인 쪽이 기준이고, 바를 끌면 거꾸로 타임라인을 옮긴다. 서로 scroll 이벤트를 부르니
// 같은 값이면 쓰지 않아서 되먹임이 멈춘다.
function wireHScroll() {
  const sc = $('daw-tscroll'), bar = $('daw-hscroll'), inner = $('daw-hscroll-inner');
  if (!sc || !bar || !inner) return;
  const sync = () => {
    const over = sc.scrollWidth - sc.clientWidth;
    bar.hidden = over <= 1;
    if (bar.hidden) return;
    bar.style.right = (sc.offsetWidth - sc.clientWidth) + 'px';   // 세로 스크롤바 폭만큼 비켜서 끝을 맞춘다
    inner.style.width = (sc.scrollWidth - HEAD_W) + 'px';
    if (bar.scrollLeft !== sc.scrollLeft) bar.scrollLeft = sc.scrollLeft;
  };
  sc.addEventListener('scroll', sync);
  bar.addEventListener('scroll', () => { if (sc.scrollLeft !== bar.scrollLeft) sc.scrollLeft = bar.scrollLeft; });
  const ro = new ResizeObserver(sync);
  ro.observe(sc);
  if ($('daw-lanes')) ro.observe($('daw-lanes'));
  sync();
}

export async function initStudio() {
  wire();
  startEngine(false).catch(() => {});   // 탭에 들어오면 알아서 연결 (실패 시 버튼으로 재시도)
  if (_studioBooted) return;            // 아래는 스튜디오에 처음 들어왔을 때 한 번만
  _studioBooted = true;
  api.telemetry?.step('studio_open');   // 익명 통계 — 처음 한 번만 실제로 보내진다(main 이 판단)
  startAutosave();
  startFxSnapshots();
  offerRecovery();                      // 지난번에 저장하지 못하고 끝났으면 여기서 제안한다

  // 창을 닫으려 할 때 메인이 저장을 시킨다. 끝났는지 알려 주어야 닫힐지가 정해진다.
  api.project?.onSaveRequest?.(async () => {
    try { await saveProjectSmart(); } catch {}
    api.project?.saveResult?.(!_dirty);   // 아직 dirty 면 저장이 취소·실패한 것이다
  });
}
