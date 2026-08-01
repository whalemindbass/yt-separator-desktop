// 스튜디오 뷰 — 실시간 오디오 엔진(JUCE 사이드카) 컨트롤
//   api.engine.* 로 엔진 제어, onEvent 로 상태 수신.
const api = window.yssApi;
const $ = (id) => document.getElementById(id);

let _wired = false;
let _started = false;
let _fx = null;          // 로드된 FX 이름
let _sr = 44100;         // 위치 표시용 샘플레이트

function fmtPos(samples) {
  const sec = (samples || 0) / (_sr || 44100);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function setTransportEnabled(on) {
  ['st-play', 'st-stop', 'st-seek0', 'st-rec', 'st-recstop', 'st-scan'].forEach(id => {
    const el = $(id); if (el) el.disabled = !on;
  });
}

function onEngineEvent(m) {
  switch (m.ev) {
    case 'ready':
      $('st-engine-status').textContent = '엔진 실행 중';
      $('st-engine-dot').classList.add('on');
      $('st-engine-start').disabled = true;
      setTransportEnabled(true);
      break;
    case 'device':
      _sr = m.sr || 44100;
      $('st-device').classList.remove('muted');
      $('st-device').textContent =
        `${m.name} · ${m.sr}Hz · buffer ${m.block} · 왕복 ${Number(m.roundtripMs).toFixed(2)}ms`;
      break;
    case 'plugins': {
      const sel = $('st-fx-list');
      sel.innerHTML = '';
      if (!m.list.length) {
        sel.innerHTML = '<option value="">설치된 VST3 없음</option>';
        sel.disabled = true;
      } else {
        for (const p of m.list) {
          const o = document.createElement('option');
          o.value = String(p.index);
          o.textContent = `${p.name} — ${p.manufacturer}`;
          sel.appendChild(o);
        }
        sel.disabled = false;
      }
      break;
    }
    case 'fx':
      _fx = m.name;
      $('st-fx-current').textContent = `로드됨: ${m.name}`;
      $('st-editor').disabled = !m.hasEditor;
      break;
    case 'stems':
      break;
    case 'pos':
      $('st-pos').textContent = fmtPos(m.samples);
      break;
    case 'take': {
      const el = $('st-take');
      el.hidden = false;
      el.textContent = `테이크 저장: ${m.file} (정렬 위치 ${fmtPos(m.timelineStart)}, PDC ${m.roundtripComp} samp)`;
      break;
    }
    case 'exit':
      _started = false;
      $('st-engine-status').textContent = '엔진 종료됨';
      $('st-engine-dot').classList.remove('on');
      $('st-engine-start').disabled = false;
      setTransportEnabled(false);
      break;
    case 'error':
      $('st-engine-status').textContent = '엔진 오류';
      break;
  }
}

function wire() {
  if (_wired) return;
  _wired = true;

  api.engine.onEvent(onEngineEvent);

  $('st-engine-start').addEventListener('click', async () => {
    $('st-engine-start').disabled = true;
    $('st-engine-status').textContent = '시작 중…';
    const r = await api.engine.start([]);
    if (!r.ok) {
      $('st-engine-status').textContent = '엔진 실행 파일 없음';
      $('st-engine-start').disabled = false;
    } else { _started = true; }
  });

  $('st-play').addEventListener('click', () => api.engine.play());
  $('st-stop').addEventListener('click', () => api.engine.stop());
  $('st-seek0').addEventListener('click', () => api.engine.seek(0));
  $('st-rec').addEventListener('click', () => api.engine.recordArm());
  $('st-recstop').addEventListener('click', () => api.engine.recordStop());
  $('st-scan').addEventListener('click', () => api.engine.scanPlugins());
  $('st-fx-list').addEventListener('change', (e) => {
    const idx = parseInt(e.target.value, 10);
    if (!isNaN(idx)) api.engine.loadFx(idx);
  });
  $('st-editor').addEventListener('click', () => api.engine.showEditor());
}

export async function initStudio() {
  wire();
}
