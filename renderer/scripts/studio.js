// 스튜디오 DAW — 대형 영상 + 스템/녹음 트랙 + 저지연 엔진(JUCE)
//   엔진(오디오)=마스터 클럭. 영상은 muted 로 playhead 따라감(드리프트 보정).
import { Library } from './library.js';
import { toYtsepUrl, loadStemFilesToBuffers } from './player.js';

const api = window.yssApi;
const $ = (id) => document.getElementById(id);

const STEM_COLOR = {
  vocals: 'var(--stem-vocals)', drums: 'var(--stem-drums)',
  bass: 'var(--stem-bass)', other: 'var(--stem-other)',
  guitar: 'var(--stem-other)', piano: 'var(--stem-drums)', mine: 'var(--accent)',
};
const STEM_LABEL = { vocals: '보컬', drums: '드럼', bass: '베이스', other: '기타', guitar: '기타', piano: '피아노' };

let _wired = false, _started = false;
let _sr = 44100, _dur = 0, _pxPerSec = 12;
let _playing = false, _recArmed = false;
let _tracks = [];          // [{key,label,color,engineIndex}]
let _chain = [];              // [{id,index,name,hasEditor,bypass}] — 엔진 FX 체인 미러
let _activePresetId = null;
let _presetGather = null;     // 저장: {name,id?,states:{slotId:data},need:[ids],meta:[{index,bypass}],order:[ids]}
let _pendingPreset = null;    // 로드: {slots:[{index,bypass,data}]}

// ── FX 프리셋(톤) — 체인 전체 스냅샷 ──
function getPresets() { try { return JSON.parse(localStorage.getItem('yss:fx-presets') || '[]'); } catch { return []; } }
function setPresets(a) { try { localStorage.setItem('yss:fx-presets', JSON.stringify(a)); } catch {} }
function upsertPreset(p) { const a = getPresets(); const i = a.findIndex(x => x.id === p.id); if (i >= 0) a[i] = p; else a.push(p); setPresets(a); }

function startGather(opts) {   // 현재 체인 상태를 모아 프리셋 생성/갱신
  if (!_chain.length) { flashTake('추가된 VST가 없습니다.'); return; }
  _presetGather = { ...opts, states: {}, need: _chain.map(s => s.id), meta: _chain.map(s => ({ index: s.index, bypass: s.bypass })), order: _chain.map(s => s.id) };
  for (const s of _chain) api.engine.fxSaveState(s.id);
}
function loadPreset(p) {
  _activePresetId = p.id;
  showFxOverlay('톤 불러오는 중…');
  // 엔진이 체인을 한 번에 재구성 (원자적) → fxChain 이벤트 오면 overlay 해제
  api.engine.fxSetChain(p.slots.map(s => ({ index: s.index, data: s.data, bypass: s.bypass })));
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
    <div class="mt"><div class="n">${p.name}</div><div class="m">${(_plugins[p.index] && _plugins[p.index].name) || ('VST ' + p.index)}</div></div>
    <button class="daw-preset-del" data-id="${p.id}" title="삭제">✕</button></div>`).join('');
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
  const peaks = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const start = i * bucket, end = Math.min(len, start + bucket);
    let p = 0;
    const step = Math.max(1, Math.floor((end - start) / 200));
    for (let j = start; j < end; j += step) { const a = Math.abs((L[j] + R[j]) * 0.5); if (a > p) p = a; }
    peaks[i] = p; if (p > mx) mx = p;
  }
  for (let i = 0; i < N; i++) {
    const h = Math.min(1, peaks[i] / mx) * 22;
    pts += `${i},${(25 - h).toFixed(1)} `;
  }
  let pts2 = '';
  for (let i = N - 1; i >= 0; i--) { const h = Math.min(1, peaks[i] / mx) * 22; pts2 += `${i},${(25 + h).toFixed(1)} `; }
  return `<svg viewBox="0 0 ${N} 50" preserveAspectRatio="none"><polygon points="${pts}${pts2}" fill="${color}" fill-opacity=".55"/></svg>`;
}

// ── 렌더 ──────────────────────────────────────────
function renderTracks() {
  const lanes = $('daw-lanes');
  lanes.innerHTML = '';
  _tracks.forEach((t) => {
    const lane = document.createElement('div');
    lane.className = 'daw-lane';
    lane.style.setProperty('--c', t.color);
    lane.dataset.key = t.key;
    lane.innerHTML = `
      <div class="daw-head">
        <div class="nm"><i></i>${t.label}${t.key === 'mine' ? ' <span style="color:var(--danger);font-size:9px">●REC</span>' : ''}</div>
        <div class="ctrls">
          <button class="daw-ms" data-m="mute" title="뮤트">M</button>
          <button class="daw-ms" data-m="solo" title="솔로">S</button>
          <input class="daw-vol" type="range" min="0" max="150" value="100" title="볼륨">
        </div>
      </div>
      <div class="daw-area">${t.key === 'mine' ? '' : '<div class="daw-clip"></div>'}</div>`;
    // 버튼/슬라이더 배선
    const mBtn = lane.querySelector('[data-m="mute"]');
    const sBtn = lane.querySelector('[data-m="solo"]');
    const vol = lane.querySelector('.daw-vol');
    if (t.key === 'mine') {
      // 내 녹음(입력 모니터) — monitor 게인 제어
      sBtn.disabled = true;
      vol.addEventListener('input', () => api.engine.monitor(mBtn.classList.contains('on') ? 0 : Number(vol.value) / 100));
      mBtn.addEventListener('click', () => { const on = mBtn.classList.toggle('on'); api.engine.monitor(on ? 0 : Number(vol.value) / 100); });
    } else {
      mBtn.addEventListener('click', () => { const on = mBtn.classList.toggle('on'); api.engine.track(t.engineIndex, { mute: on }); });
      sBtn.addEventListener('click', () => { sBtn.classList.toggle('on'); api.engine.track(t.engineIndex, { solo: sBtn.classList.contains('on') }); updateSoloDim(); });
      vol.addEventListener('input', () => api.engine.track(t.engineIndex, { gain: Number(vol.value) / 100 }));
    }
    lanes.appendChild(lane);
  });
  layout();
}

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

function layout() {
  const w = contentW();
  $('daw-lanes').style.width = (HEAD_W + w) + 'px';
  document.querySelectorAll('.daw-lane').forEach(l => { l.style.width = (HEAD_W + w) + 'px'; });
  const ruler = $('daw-ruler');
  ruler.style.width = w + 'px'; ruler.innerHTML = '';
  const step = _pxPerSec >= 40 ? 2 : _pxPerSec >= 20 ? 5 : _pxPerSec >= 10 ? 10 : 20;
  for (let s = 0; s <= _dur; s += step) {
    const tk = document.createElement('span');
    tk.className = 'tk'; tk.style.left = (s * _pxPerSec) + 'px';
    tk.textContent = fmtTC(s).replace(/\.000$/, '');
    ruler.appendChild(tk);
  }
  renderTakes();
  updatePlayhead(_lastSec);
}

let _lastSec = 0;
function updatePlayhead(sec) {
  _lastSec = sec;
  const ph = $('daw-playhead');
  ph.hidden = _tracks.length === 0;
  ph.style.left = (HEAD_W + sec * _pxPerSec) + 'px';
  ph.style.height = ($('daw-lanes').offsetHeight || 0) + 'px';
  $('st-pos').textContent = fmtTC(sec);
  $('daw-ruler').style.transform = `translateX(${-$('daw-tscroll').scrollLeft}px)`;
}

// ── 동기 ──────────────────────────────────────────
let _recStartSec = null;
function updateRecLive(t) {
  const area = document.querySelector('.daw-lane[data-key="mine"] .daw-area');
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
  ['st-load-song', 'st-seek0', 'st-play', 'st-stop', 'st-rec', 'st-zoom-in', 'st-zoom-out', 'st-tools-toggle', 'st-export', 'st-master', 'st-fx-add', 'st-fx-save', 'st-fx-saveas', 'st-fx-load', 'st-audio-settings', 'st-monitor', 'st-take-save', 'st-take-load']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
}

// ── 곡 로드 ────────────────────────────────────────
async function loadSong(item) {
  const it = item || Library.getSelected();
  if (!it) return;
  const paths = Object.values(it.stemPaths || {}).filter(Boolean);
  if (!paths.length) { flashTake('이 곡에 스템 파일이 없습니다.'); return; }
  _songKey = String(it.videoPath || it.id);
  _takes = [];

  const keys = Object.keys(it.stemPaths || {});
  _tracks = keys.map((k, i) => ({ key: k, label: STEM_LABEL[k] || k, color: STEM_COLOR[k] || 'var(--accent)', engineIndex: i }));
  _tracks.push({ key: 'mine', label: '내 녹음', color: STEM_COLOR.mine, engineIndex: -1 });
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
}

function flashTake(msg) {   // 하단 로그 대신 잠깐 뜨는 토스트
  let t = document.getElementById('daw-toast');
  if (!t) { t = document.createElement('div'); t.id = 'daw-toast'; t.className = 'daw-toast'; (document.querySelector('.daw') || document.body).appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

let _takes = [];   // [{ id, file, start(sec), dur(sec), svg }]
async function renderTake(file, startSamples, engineId) {
  try {
    const { stems } = await loadStemFilesToBuffers({ take: file });
    const ch = stems.take;
    _takes.push({
      id: engineId != null ? engineId : Date.now(), file,
      start: (startSamples || 0) / (_sr || 44100),
      dur: ch[0].length / (_sr || 44100),
      svg: buildWaveSvg(ch, resolveColor('var(--danger)')),
    });
    renderTakes();
  } catch (e) { flashTake('녹음 파형 실패: ' + (e && e.message || e)); }
}
function renderTakes() {
  const area = document.querySelector('.daw-lane[data-key="mine"] .daw-area');
  if (!area) return;
  area.innerHTML = '';
  for (const tk of _takes) {
    const el = document.createElement('div');
    el.className = 'daw-take-clip';
    el.style.left = (tk.start * _pxPerSec) + 'px';
    el.style.width = Math.max(3, tk.dur * _pxPerSec) + 'px';
    el.innerHTML = tk.svg;
    el.title = tk.file;
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); showTakeMenu(e.clientX, e.clientY, tk.id); });
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
  const html = items.map((it, i) =>
    `<div class="daw-modal-item" data-idx="${i}"><div class="mt"><div class="n">${it.name}</div>
      <div class="m">${Object.keys(it.stemPaths || {}).length} 스템${it.group ? ' · ' + it.group : ''}</div></div></div>`).join('');
  openModal('곡 선택', html, (idx) => loadSong(items[Number(idx)]));
}

function openVstPicker() {
  if (!_plugins.length) { openModal('VST3 추가', `<div class="daw-modal-empty">감지된 VST3 없음. 상단 FX·스캔 필요.</div>`, () => {}); return; }
  const html = _plugins.map(p =>
    `<div class="daw-modal-item" data-idx="${p.index}"><div class="mt"><div class="n">${p.name}</div>
      <div class="m">${p.manufacturer}</div></div></div>`).join('');
  openModal('VST3 추가', html, (idx) => api.engine.fxAdd(Number(idx)));   // 여러 개 추가 가능
}

// ── 녹음(테이크 세트) 저장/불러오기 — 곡별, 이름 지정 ──
function takesetKey(k) { return 'yss:takesets:' + String(k).replace(/\\/g, '/').toLowerCase(); }
function getTakeSets() { if (!_songKey) return []; try { return JSON.parse(localStorage.getItem(takesetKey(_songKey)) || '[]'); } catch { return []; } }
function setTakeSets(a) { if (!_songKey) return; try { localStorage.setItem(takesetKey(_songKey), JSON.stringify(a)); } catch {} }
function saveTakeSet(name) {
  if (!_takes.length) { flashTake('저장할 녹음이 없습니다.'); return; }
  const takes = _takes.map(t => ({ file: t.file, start: Math.round(t.start * (_sr || 44100)), dur: t.dur }));
  const a = getTakeSets(); a.push({ id: 't' + Date.now(), name, takes }); setTakeSets(a);
  flashTake('녹음 저장됨: ' + name);
}
async function loadTakeSet(ts) {
  api.engine.takeClear();
  _takes = []; renderTakes();
  for (const t of ts.takes) {
    api.engine.takeLoad(t.file, t.start);
    await renderTake(t.file, t.start, t.start);   // start(samples) 로 클립·엔진 id 일치
  }
  flashTake('녹음 불러옴: ' + ts.name);
}
function openTakeSetPicker() {
  const ps = getTakeSets();
  if (!ps.length) { openModal('녹음 불러오기', '<div class="daw-modal-empty">이 곡에 저장된 녹음이 없습니다.</div>', () => {}); return; }
  const host = $('daw-modal');
  const html = ps.map((p, i) => `<div class="daw-modal-item" data-idx="${i}">
    <div class="mt"><div class="n">${p.name}</div><div class="m">${p.takes.length} 테이크</div></div>
    <button class="daw-preset-del" data-id="${p.id}" title="삭제">✕</button></div>`).join('');
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
      break;
    case 'plugins':
      _plugins = m.list || [];
      $('st-fx-add').disabled = false;
      break;
    case 'fxChain':
      _chain = m.list || [];
      renderFxSlots();
      hideFxOverlay();
      break;
    case 'fxState':
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
    case 'take':
      clearRecLive();
      flashTake(`녹음 저장: ${m.file}`);
      renderTake(m.file, m.timelineStart || 0, m.id);
      break;
    case 'exit':
      _started = false; _playing = false;
      $('st-engine-status').textContent = '오디오 꺼짐';
      $('st-engine-dot').classList.remove('on');
      $('st-engine-start').hidden = false; $('st-engine-start').disabled = false;
      $('st-engine-stop').hidden = true;
      _chain = []; _activePresetId = null; renderFxSlots();
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
  const box = $('st-fx-slots'); if (!box) return;
  box.innerHTML = '';
  _chain.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'daw-fx-slot' + (s.bypass ? ' bypassed' : '');
    row.draggable = true; row.dataset.id = s.id;
    row.innerHTML = `<span class="drag" title="드래그로 순서 변경">⠿</span>
      <span class="pw ${s.bypass ? '' : 'on'}" title="On/Off"></span>
      <div class="info"><div class="n">${s.name}</div></div>
      <button class="ed" title="편집" ${s.hasEditor ? '' : 'disabled'}>✎</button>
      <button class="del" title="삭제">✕</button>`;
    row.querySelector('.pw').addEventListener('click', () => {
      const ns = !s.bypass; s.bypass = ns;                     // 낙관적 갱신 (엔진 fxChain 로 재확정)
      row.classList.toggle('bypassed', ns);
      row.querySelector('.pw').classList.toggle('on', !ns);
      api.engine.fxBypass(s.id, ns);
    });
    row.querySelector('.ed').addEventListener('click', () => api.engine.fxEditor(s.id));
    row.querySelector('.del').addEventListener('click', () => api.engine.fxRemove(s.id));
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
  api.engine.fxReorder(ids);
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

  const play = () => { _playing = true; api.engine.play(); video.play().catch(() => {}); updatePlayIcon(); };
  const stopAll = () => {
    _playing = false; api.engine.stop(); video.pause(); updatePlayIcon();
    if (_recArmed) { _recArmed = false; $('st-rec').classList.remove('armed'); api.engine.recordStop(); }
    clearRecLive();
  };
  const updatePlayIcon = () => { $('daw-vplay').hidden = _playing; };
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
  $('st-master').addEventListener('input', (e) => api.engine.master(Number(e.target.value) / 100));
  $('st-seek0').addEventListener('click', () => { if (_recArmed) return; api.engine.seek(0); video.currentTime = 0; updatePlayhead(0); });
  $('st-rec').addEventListener('click', () => {
    _recArmed = !_recArmed; $('st-rec').classList.toggle('armed', _recArmed);
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
  $('st-engine-stop').addEventListener('click', () => { api.engine.quit(); });
  $('st-audio-settings').addEventListener('click', () => { _devOpen = true; api.engine.listDevices(); });
  $('st-take-save').addEventListener('click', () => {
    if (!_songKey) { flashTake('곡을 먼저 불러오세요.'); return; }
    if (!_takes.length) { flashTake('저장할 녹음이 없습니다.'); return; }
    openNameModal('녹음 저장', '', (name) => saveTakeSet(name));
  });
  $('st-take-load').addEventListener('click', openTakeSetPicker);

  // 내 소리 모니터 on/off
  let _monOn = true;
  $('st-monitor').addEventListener('click', () => {
    _monOn = !_monOn;
    $('st-monitor').classList.toggle('on', _monOn);
    api.engine.inputMonitor(_monOn);
  });

  // 도구 드로어 (레벨·튜너) — 간헐 토글
  $('st-tools-toggle').addEventListener('click', () => { const d = $('daw-tools'); d.hidden = !d.hidden; });
  $('st-tools-close').addEventListener('click', () => { $('daw-tools').hidden = true; });
}

export async function initStudio() { wire(); }
