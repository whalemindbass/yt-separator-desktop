// 스튜디오 DAW — 대형 영상 + 스템/녹음 트랙 + 저지연 엔진(JUCE)
//   엔진(오디오)이 마스터 클럭. 영상은 muted 로 playhead 를 따라감(드리프트 보정).
import { Library } from './library.js';
import { toYtsepUrl } from './player.js';

const api = window.yssApi;
const $ = (id) => document.getElementById(id);

const STEM_COLOR = {
  vocals: 'var(--stem-vocals)', drums: 'var(--stem-drums)',
  bass: 'var(--stem-bass)', other: 'var(--stem-other)',
  guitar: 'var(--stem-other)', piano: 'var(--stem-drums)', mine: 'var(--accent)',
};
const STEM_LABEL = {
  vocals: '보컬', drums: '드럼', bass: '베이스', other: '기타/기타',
  guitar: '기타', piano: '피아노',
};

let _wired = false, _started = false;
let _sr = 44100, _dur = 0, _pxPerSec = 12;
let _playing = false, _recArmed = false;
let _tracks = [];          // [{key,label,color}] (record 트랙 포함)
let _fxLoaded = null;      // 로드된 FX 이름
let _songKey = null;       // FX 영속화 키(videoPath)

const HEAD_W = 140;
const fmtTC = (sec) => {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
};
const contentW = () => Math.max(1, _dur * _pxPerSec);

// ── 렌더 ──────────────────────────────────────────
function renderTracks() {
  const lanes = $('daw-lanes');
  lanes.innerHTML = '';
  for (const t of _tracks) {
    const lane = document.createElement('div');
    lane.className = 'daw-lane';
    lane.style.setProperty('--c', t.color);
    lane.innerHTML = `
      <div class="daw-head">
        <div class="nm"><i></i>${t.label}${t.key === 'mine' ? ' <span style="color:var(--danger);font-size:9px">●REC</span>' : ''}</div>
        <div class="ctrls">
          <button class="daw-ms" data-m="mute">M</button>
          <button class="daw-ms" data-m="solo">S</button>
        </div>
      </div>
      <div class="daw-area">${t.key === 'mine' ? '' : `<div class="daw-clip"></div>`}</div>`;
    lanes.appendChild(lane);
  }
  layout();
}

function layout() {
  const w = contentW();
  $('daw-lanes').style.width = (HEAD_W + w) + 'px';
  document.querySelectorAll('.daw-lane').forEach(l => { l.style.width = (HEAD_W + w) + 'px'; });
  document.querySelectorAll('.daw-clip').forEach(c => { c.style.left = '0px'; c.style.right = '0px'; });
  // ruler
  const ruler = $('daw-ruler');
  ruler.style.width = w + 'px';
  ruler.innerHTML = '';
  const step = _pxPerSec >= 24 ? 5 : _pxPerSec >= 12 ? 10 : 20;   // 초 간격
  for (let s = 0; s <= _dur; s += step) {
    const tk = document.createElement('span');
    tk.className = 'tk';
    tk.style.left = (s * _pxPerSec) + 'px';
    tk.textContent = fmtTC(s).replace(/\.000$/, '');
    ruler.appendChild(tk);
  }
  updatePlayhead(currentSec());
}

let _lastSec = 0;
function currentSec() { return _lastSec; }
function updatePlayhead(sec) {
  _lastSec = sec;
  const ph = $('daw-playhead');
  const lanesH = $('daw-lanes').offsetHeight || 0;
  ph.hidden = _tracks.length === 0;
  ph.style.left = (HEAD_W + sec * _pxPerSec) + 'px';
  ph.style.height = lanesH + 'px';
  $('st-pos').textContent = fmtTC(sec);
  // ruler 를 스크롤과 동기
  const sc = $('daw-tscroll');
  $('daw-ruler').style.transform = `translateX(${-sc.scrollLeft}px)`;
}

// ── 동기 ──────────────────────────────────────────
function onPos(samples) {
  const t = (samples || 0) / (_sr || 44100);
  updatePlayhead(t);
  const v = $('daw-video');
  if (v && _playing && isFinite(v.duration)) {
    if (Math.abs(v.currentTime - t) > 0.15) v.currentTime = t;   // 드리프트 보정
  }
  // 재생 헤드가 화면 밖이면 스크롤 따라가기
  const sc = $('daw-tscroll');
  const x = HEAD_W + t * _pxPerSec;
  if (x < sc.scrollLeft + HEAD_W || x > sc.scrollLeft + sc.clientWidth - 40)
    sc.scrollLeft = Math.max(0, x - sc.clientWidth / 2);
}

// ── 컨트롤 활성화 ──────────────────────────────────
function setEnabled(on) {
  ['st-load-song', 'st-seek0', 'st-play', 'st-stop', 'st-rec', 'st-zoom-in', 'st-zoom-out', 'st-fx-toggle', 'st-export']
    .forEach(id => { const el = $(id); if (el) el.disabled = !on; });
}

// ── 곡 로드 ────────────────────────────────────────
function loadSong() {
  const it = Library.getSelected();
  if (!it) { flashTake('라이브러리에서 곡을 먼저 선택하세요.'); return; }
  const paths = Object.values(it.stemPaths || {}).filter(Boolean);
  if (!paths.length) { flashTake('이 곡에 스템 파일이 없습니다.'); return; }
  _songKey = String(it.videoPath || it.id);

  // 트랙 구성 (스템 + 내 녹음)
  _tracks = Object.keys(it.stemPaths || {}).map(k => ({
    key: k, label: STEM_LABEL[k] || k, color: STEM_COLOR[k] || 'var(--accent)',
  }));
  _tracks.push({ key: 'mine', label: '내 녹음', color: STEM_COLOR.mine });
  renderTracks();

  // 영상
  const v = $('daw-video');
  $('daw-video-empty').hidden = true;
  if (it.videoPath) { v.src = toYtsepUrl(it.videoPath); v.load(); }

  // 엔진에 스템 전달
  api.engine.loadStems(paths);
  $('daw-badge') && ($('daw-badge').hidden = true);
  flashTake(`불러옴: ${it.name}`);

  // 곡별 FX 복원 (스캔 필요)
  api.engine.scanPlugins();
}

function flashTake(msg) { const el = $('st-take'); el.hidden = false; el.textContent = msg; }

// ── 이벤트 ─────────────────────────────────────────
function onEngineEvent(m) {
  switch (m.ev) {
    case 'ready':
      _started = true;
      $('st-engine-status').textContent = '엔진 실행 중';
      $('st-engine-dot').classList.add('on');
      $('st-engine-start').disabled = true;
      setEnabled(true);
      break;
    case 'device':
      _sr = m.sr || 44100;
      $('st-engine-status').textContent = `${m.name} · ${Number(m.roundtripMs).toFixed(2)}ms`;
      break;
    case 'plugins': {
      const sel = $('st-fx-list');
      sel.innerHTML = '<option value="">VST3 선택…</option>';
      for (const p of m.list) {
        const o = document.createElement('option');
        o.value = String(p.index); o.textContent = `${p.name} — ${p.manufacturer}`;
        sel.appendChild(o);
      }
      sel.disabled = m.list.length === 0;
      $('st-fx-add').disabled = m.list.length === 0;
      // 곡별 저장된 FX 복원
      const saved = _songKey && loadFxPref(_songKey);
      if (saved != null && m.list[saved]) api.engine.loadFx(saved);
      break;
    }
    case 'fx':
      _fxLoaded = m.name;
      renderFxSlots(m.hasEditor);
      break;
    case 'pos':
      onPos(m.samples);
      break;
    case 'take':
      flashTake(`녹음 저장: ${m.file}  ·  정렬 ${fmtTC(m.timelineStart / (_sr || 44100))}  (PDC ${m.roundtripComp} samp)`);
      break;
    case 'exit':
      _started = false; _playing = false;
      $('st-engine-status').textContent = '엔진 종료됨';
      $('st-engine-dot').classList.remove('on');
      $('st-engine-start').disabled = false;
      setEnabled(false);
      break;
    case 'error':
      $('st-engine-status').textContent = '엔진 오류';
      break;
  }
}

function renderFxSlots(hasEditor) {
  const box = $('st-fx-slots');
  box.innerHTML = '';
  if (!_fxLoaded) return;
  const slot = document.createElement('div');
  slot.className = 'daw-fx-slot';
  slot.innerHTML = `<div class="info"><div class="n">${_fxLoaded}</div></div>
    <button class="ed" ${hasEditor ? '' : 'disabled'}>에디터</button>`;
  slot.querySelector('.ed').addEventListener('click', () => api.engine.showEditor());
  box.appendChild(slot);
}

// 곡별 FX 인덱스 영속화 (경량 — 추후 전체 상태 직렬화로 확장)
function fxKey(k) { return 'yss:studio-fx:' + String(k).replace(/\\/g, '/').toLowerCase(); }
function saveFxPref(k, index) { try { localStorage.setItem(fxKey(k), String(index)); } catch {} }
function loadFxPref(k) { try { const v = localStorage.getItem(fxKey(k)); return v == null ? null : parseInt(v, 10); } catch { return null; } }

// ── 배선 ───────────────────────────────────────────
function wire() {
  if (_wired) return; _wired = true;
  api.engine.onEvent(onEngineEvent);

  $('st-engine-start').addEventListener('click', async () => {
    $('st-engine-start').disabled = true;
    $('st-engine-status').textContent = '시작 중…';
    const r = await api.engine.start([]);
    if (!r.ok) { $('st-engine-status').textContent = '엔진 실행 파일 없음'; $('st-engine-start').disabled = false; }
  });

  $('st-load-song').addEventListener('click', loadSong);

  const video = $('daw-video');
  video.addEventListener('loadedmetadata', () => { _dur = video.duration || 0; layout(); });

  $('st-play').addEventListener('click', () => {
    _playing = true; api.engine.play(); video.play().catch(() => {});
  });
  $('st-stop').addEventListener('click', () => {
    _playing = false; api.engine.stop(); video.pause();
  });
  $('st-seek0').addEventListener('click', () => { api.engine.seek(0); video.currentTime = 0; updatePlayhead(0); });

  $('st-rec').addEventListener('click', () => {
    _recArmed = !_recArmed;
    $('st-rec').classList.toggle('armed', _recArmed);
    if (_recArmed) api.engine.recordArm(); else api.engine.recordStop();
  });

  $('st-zoom-in').addEventListener('click', () => { _pxPerSec = Math.min(120, _pxPerSec * 1.5); layout(); });
  $('st-zoom-out').addEventListener('click', () => { _pxPerSec = Math.max(3, _pxPerSec / 1.5); layout(); });

  // 타임라인 클릭 → 이동
  $('daw-tscroll').addEventListener('click', (e) => {
    if (!_dur) return;
    if (e.target.closest('.daw-head')) return;   // 헤더 클릭 무시
    const rect = $('daw-lanes').getBoundingClientRect();
    const x = e.clientX - rect.left - HEAD_W;
    if (x < 0) return;
    const t = Math.max(0, Math.min(_dur, x / _pxPerSec));
    api.engine.seek(Math.round(t * _sr));
    video.currentTime = t;
    updatePlayhead(t);
  });
  $('daw-tscroll').addEventListener('scroll', () => updatePlayhead(currentSec()));

  // FX 드로어
  $('st-fx-toggle').addEventListener('click', () => { const d = $('daw-fx'); d.hidden = !d.hidden; });
  $('st-fx-close').addEventListener('click', () => { $('daw-fx').hidden = true; });
  $('st-fx-add').addEventListener('click', () => {
    const idx = parseInt($('st-fx-list').value, 10);
    if (isNaN(idx)) return;
    api.engine.loadFx(idx);
    if (_songKey) saveFxPref(_songKey, idx);
  });
  $('st-fx-save').addEventListener('click', () => {
    const idx = parseInt($('st-fx-list').value, 10);
    if (!isNaN(idx) && _songKey) { saveFxPref(_songKey, idx); flashTake('FX 저장됨 (이 곡)'); }
  });
  $('st-fx-load').addEventListener('click', () => api.engine.scanPlugins());
}

export async function initStudio() { wire(); }
