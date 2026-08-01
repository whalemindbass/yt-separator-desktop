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
let _fxLoaded = null, _fxBypass = false, _fxHasEditor = false;
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
      <div class="daw-area"><div class="daw-clip"></div></div>`;
    // 버튼/슬라이더 배선
    const mBtn = lane.querySelector('[data-m="mute"]');
    const sBtn = lane.querySelector('[data-m="solo"]');
    const vol = lane.querySelector('.daw-vol');
    if (t.engineIndex < 0) { mBtn.disabled = sBtn.disabled = vol.disabled = true; }
    mBtn.addEventListener('click', () => { const on = mBtn.classList.toggle('on'); api.engine.track(t.engineIndex, { mute: on }); });
    sBtn.addEventListener('click', () => { sBtn.classList.toggle('on'); api.engine.track(t.engineIndex, { solo: sBtn.classList.contains('on') }); updateSoloDim(); });
    vol.addEventListener('input', () => api.engine.track(t.engineIndex, { gain: Number(vol.value) / 100 }));
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
function onPos(samples) {
  const t = (samples || 0) / (_sr || 44100);
  updatePlayhead(t);
  const v = $('daw-video');
  if (v && _playing && isFinite(v.duration) && Math.abs(v.currentTime - t) > 0.15) v.currentTime = t;
  const sc = $('daw-tscroll'), x = HEAD_W + t * _pxPerSec;
  if (x < sc.scrollLeft + HEAD_W || x > sc.scrollLeft + sc.clientWidth - 40)
    sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2);
}

function setEnabled(on) {
  ['st-load-song', 'st-seek0', 'st-play', 'st-stop', 'st-rec', 'st-zoom-in', 'st-zoom-out', 'st-fx-toggle', 'st-export']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
}

// ── 곡 로드 ────────────────────────────────────────
async function loadSong(item) {
  const it = item || Library.getSelected();
  if (!it) return;
  const paths = Object.values(it.stemPaths || {}).filter(Boolean);
  if (!paths.length) { flashTake('이 곡에 스템 파일이 없습니다.'); return; }
  _songKey = String(it.videoPath || it.id);

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

function flashTake(msg) { const el = $('st-take'); el.hidden = false; el.textContent = msg; }

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
  openModal('VST3 추가', html, (idx) => { api.engine.loadFx(Number(idx)); if (_songKey) saveFxPref(_songKey, Number(idx)); });
}

// ── 이벤트 ─────────────────────────────────────────
function onEngineEvent(m) {
  switch (m.ev) {
    case 'ready':
      _started = true;
      $('st-engine-status').textContent = '엔진 실행 중';
      $('st-engine-dot').classList.add('on');
      $('st-engine-start').disabled = true; setEnabled(true);
      break;
    case 'device':
      _sr = m.sr || 44100;
      $('st-engine-status').textContent = `${m.name} · ${Number(m.roundtripMs).toFixed(2)}ms`;
      break;
    case 'plugins':
      _plugins = m.list || [];
      { const saved = _songKey && loadFxPref(_songKey); if (saved != null && _plugins[saved]) api.engine.loadFx(saved); }
      break;
    case 'fx':
      _fxLoaded = m.name; _fxHasEditor = !!m.hasEditor; _fxBypass = false;
      renderFxSlots();
      break;
    case 'pos': onPos(m.samples); break;
    case 'take': flashTake(`녹음 저장: ${m.file}  ·  정렬 ${fmtTC(m.timelineStart / (_sr || 44100))}  (PDC ${m.roundtripComp} samp)`); break;
    case 'exit':
      _started = false; _playing = false;
      $('st-engine-status').textContent = '엔진 종료됨';
      $('st-engine-dot').classList.remove('on');
      $('st-engine-start').disabled = false; setEnabled(false);
      break;
    case 'error': $('st-engine-status').textContent = '엔진 오류'; break;
  }
}

function renderFxSlots() {
  const box = $('st-fx-slots'); box.innerHTML = '';
  if (!_fxLoaded) return;
  const slot = document.createElement('div');
  slot.className = 'daw-fx-slot' + (_fxBypass ? ' bypassed' : '');
  slot.innerHTML = `<span class="pw ${_fxBypass ? '' : 'on'}" title="On/Off"></span>
    <div class="info"><div class="n">${_fxLoaded}</div><div class="sub">입력 체인</div></div>
    <button class="ed" ${_fxHasEditor ? '' : 'disabled'}>에디터</button>`;
  slot.querySelector('.pw').addEventListener('click', () => {
    _fxBypass = !_fxBypass; api.engine.fxBypass(_fxBypass); renderFxSlots();
  });
  slot.querySelector('.ed').addEventListener('click', () => api.engine.showEditor());
  box.appendChild(slot);
}

function fxKey(k) { return 'yss:studio-fx:' + String(k).replace(/\\/g, '/').toLowerCase(); }
function saveFxPref(k, i) { try { localStorage.setItem(fxKey(k), String(i)); } catch {} }
function loadFxPref(k) { try { const v = localStorage.getItem(fxKey(k)); return v == null ? null : parseInt(v, 10); } catch { return null; } }

// ── 배선 ───────────────────────────────────────────
function wire() {
  if (_wired) return; _wired = true;
  api.engine.onEvent(onEngineEvent);

  $('st-engine-start').addEventListener('click', async () => {
    $('st-engine-start').disabled = true; $('st-engine-status').textContent = '시작 중…';
    const r = await api.engine.start([]);
    if (!r.ok) { $('st-engine-status').textContent = '엔진 실행 파일 없음'; $('st-engine-start').disabled = false; }
  });

  $('st-load-song').addEventListener('click', openSongPicker);

  const video = $('daw-video');
  video.addEventListener('loadedmetadata', () => { _dur = video.duration || 0; layout(); });

  $('st-play').addEventListener('click', () => { _playing = true; api.engine.play(); video.play().catch(() => {}); });
  $('st-stop').addEventListener('click', () => { _playing = false; api.engine.stop(); video.pause(); });
  $('st-seek0').addEventListener('click', () => { api.engine.seek(0); video.currentTime = 0; updatePlayhead(0); });
  $('st-rec').addEventListener('click', () => {
    _recArmed = !_recArmed; $('st-rec').classList.toggle('armed', _recArmed);
    if (_recArmed) api.engine.recordArm(); else api.engine.recordStop();
  });

  $('st-zoom-in').addEventListener('click', () => { _pxPerSec = Math.min(200, _pxPerSec * 1.4); layout(); });
  $('st-zoom-out').addEventListener('click', () => { _pxPerSec = Math.max(2, _pxPerSec / 1.4); layout(); });

  // 휠 줌 (커서 위치 기준, 세밀)
  $('daw-tscroll').addEventListener('wheel', (e) => {
    if (!_dur) return;
    e.preventDefault();
    const sc = $('daw-tscroll');
    const rect = $('daw-lanes').getBoundingClientRect();
    const cursorX = e.clientX - rect.left - HEAD_W + sc.scrollLeft;   // content px
    const tAt = cursorX / _pxPerSec;
    const factor = Math.exp(-e.deltaY * 0.0015);                     // 유기적
    _pxPerSec = Math.max(2, Math.min(200, _pxPerSec * factor));
    layout();
    sc.scrollLeft = Math.max(0, tAt * _pxPerSec - (e.clientX - rect.left - HEAD_W));
  }, { passive: false });

  // 타임라인 클릭 → 이동
  $('daw-tscroll').addEventListener('click', (e) => {
    if (!_dur || e.target.closest('.daw-head')) return;
    const rect = $('daw-lanes').getBoundingClientRect();
    const x = e.clientX - rect.left - HEAD_W;
    if (x < 0) return;
    const t = Math.max(0, Math.min(_dur, x / _pxPerSec));
    api.engine.seek(Math.round(t * _sr)); video.currentTime = t; updatePlayhead(t);
  });
  $('daw-tscroll').addEventListener('scroll', () => updatePlayhead(_lastSec));

  $('st-fx-toggle').addEventListener('click', () => { const d = $('daw-fx'); d.hidden = !d.hidden; });
  $('st-fx-close').addEventListener('click', () => { $('daw-fx').hidden = true; });
  $('st-fx-add').addEventListener('click', openVstPicker);
  $('st-fx-save').addEventListener('click', () => { flashTake('FX 저장됨 (이 곡)'); });
  $('st-fx-load').addEventListener('click', () => api.engine.scanPlugins());
  // add 버튼은 스캔 후 활성화
  api.engine.onEvent((m) => { if (m.ev === 'plugins') $('st-fx-add').disabled = false; });
}

export async function initStudio() { wire(); }
