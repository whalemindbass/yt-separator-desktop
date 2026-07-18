'use strict';
// Renderer main:
//   - 탭 라우팅 (separate / library)
//   - 새 분리 뷰의 URL 입력 → 다운로드 → 스템 분리 → 라이브러리 등록
//   - 재생 UI는 library.js가 담당

import { separatePipeline, probeProviders, setProviderPreference, getUsedProvider, cancelSeparation } from './separator.js';
import { Library } from './library.js';

const $ = (id) => document.getElementById(id);
const api = window.yssApi;

// ── 앱 메타 표시 ───────────────────────────────
(async () => {
  try {
    const [v, p] = await Promise.all([api.getVersion(), api.getPlatform()]);
    $('v').textContent = 'v' + v;
    $('platform').textContent = p;
  } catch (err) { console.error(err); }
})();

// ── Titlebar: window controls ───────────────────
const titlebarEl = document.querySelector('.titlebar');
$('win-min')  .addEventListener('click', () => api.window.minimize());
$('win-max')  .addEventListener('click', () => api.window.maxToggle());
$('win-close').addEventListener('click', () => api.window.close());
api.window.isMaximized().then(m => titlebarEl.classList.toggle('maximized', m));
api.window.onState(({ maximized }) => titlebarEl.classList.toggle('maximized', maximized));

// ── Theme toggle (dark/light) ───────────────────
(function initTheme() {
  const saved = localStorage.getItem('theme');
  const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = saved || (sysDark ? 'dark' : 'light');
  document.documentElement.dataset.theme = initial;
})();
$('theme-toggle').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || 'dark';
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
});

// ── 탭 라우팅 ─────────────────────────────────
const tabs = document.querySelectorAll('.tab');
const views = document.querySelectorAll('main.view');
function switchView(name) {
  tabs.forEach(t => t.classList.toggle('on', t.dataset.view === name));
  views.forEach(v => v.hidden = v.dataset.view !== name);
  if (name === 'library') Library.refresh().catch(console.error);
}
tabs.forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

// ── 처리 장치 (Provider) 선택 ──────────────────
const providerPills = document.querySelectorAll('#provider-pills .pill');
const providerStatus = $('provider-status');
(async () => {
  const info = await probeProviders();
  const pref = info.preference;
  const blocked = localStorage.getItem('webgpuBlocked') === '1';
  providerPills.forEach(b => b.classList.toggle('on', b.dataset.provider === pref));
  const webgpuBtn = document.querySelector('#provider-pills [data-provider="webgpu"]');
  if (!info.webgpuAvailable) {
    if (webgpuBtn) webgpuBtn.disabled = true;
    providerStatus.textContent = 'WebGPU 미지원 시스템 — CPU만 사용 가능';
  } else if (blocked) {
    if (webgpuBtn) webgpuBtn.disabled = false;
    providerStatus.textContent = '이전 세션에서 WebGPU NaN 발생 → CPU 권장 (WebGPU 다시 시도 가능)';
  } else {
    providerStatus.textContent = pref === 'auto' ? 'WebGPU 자동 사용' : (pref === 'webgpu' ? 'WebGPU 강제 사용' : 'CPU 강제 사용');
  }
})();
// ── 모델 선택 (4-stem / 6-stem) ────────────────
const modelPills   = document.querySelectorAll('#model-pills .pill');
const modelStatus  = $('model-status');
const modelDlDialog= $('model-dl-dialog');
const modelDlTitle = $('model-dl-title');
const modelDlBody  = $('model-dl-body');
const modelDlFill  = $('model-dl-fill');
const modelDlInfo  = $('model-dl-info');
const modelDlCancel= $('model-dl-cancel');

let currentModelKey = localStorage.getItem('modelKey') || '4stem';
let modelsInfo = {};

modelPills.forEach(b => b.classList.toggle('on', b.dataset.model === currentModelKey));

async function refreshModelStatus() {
  try {
    const res = await api.stem.models();
    if (!res.ok) return;
    modelsInfo = res.models;
    updateModelStatusLabel();
  } catch (e) { console.error(e); }
}
function updateModelStatusLabel() {
  const info = modelsInfo[currentModelKey];
  if (!info) { modelStatus.textContent = ''; return; }
  if (info.downloaded) modelStatus.textContent = '준비됨';
  else modelStatus.textContent = `첫 사용 시 ${(info.size/1024/1024).toFixed(0)}MB 다운로드`;
}
refreshModelStatus();

modelPills.forEach(btn => {
  btn.addEventListener('click', () => {
    modelPills.forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    currentModelKey = btn.dataset.model;
    localStorage.setItem('modelKey', currentModelKey);
    updateModelStatusLabel();
  });
});

let modelDlUnsub = null;
async function ensureModelBeforeSeparation(modelKey) {
  const info = modelsInfo[modelKey];
  if (info && info.downloaded) return true;

  modelDlTitle.textContent = `${modelKey === '6stem' ? '6-stem' : '4-stem'} 모델 다운로드`;
  const mb = info ? (info.size / 1024 / 1024).toFixed(0) : '?';
  modelDlBody.textContent = `첫 사용을 위해 모델 파일(약 ${mb}MB)을 다운로드합니다.\n인터넷 연결이 필요합니다.`;
  modelDlFill.style.width = '0%';
  modelDlInfo.textContent = '';
  modelDlDialog.hidden = false;

  modelDlUnsub?.();
  modelDlUnsub = api.stem.onDownloadProgress((d) => {
    if (d.key !== modelKey) return;
    if (d.phase === 'progress' && d.total) {
      const pct = Math.max(0, Math.min(100, Math.round(d.received / d.total * 100)));
      modelDlFill.style.width = pct + '%';
      const mbr = (d.received / 1024 / 1024).toFixed(1);
      const mbt = (d.total    / 1024 / 1024).toFixed(1);
      modelDlInfo.textContent = `${mbr} / ${mbt} MB (${pct}%)`;
    }
    if (d.phase === 'done') {
      modelDlFill.style.width = '100%';
      modelDlInfo.textContent = '완료';
    }
  });

  const res = await api.stem.ensureModel(modelKey);
  modelDlUnsub?.(); modelDlUnsub = null;
  modelDlDialog.hidden = true;
  if (!res.ok) throw new Error('모델 다운로드 실패: ' + res.error);
  await refreshModelStatus();
  return true;
}
modelDlCancel.addEventListener('click', async () => {
  await api.stem.cancelDownload(currentModelKey);
  modelDlDialog.hidden = true;
});

// Video quality selection
const qualityPills = document.querySelectorAll('#quality-pills .pill');
let currentQuality = localStorage.getItem('videoQuality') || '1080';
qualityPills.forEach(b => b.classList.toggle('on', b.dataset.quality === currentQuality));
qualityPills.forEach(btn => {
  btn.addEventListener('click', () => {
    qualityPills.forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    currentQuality = btn.dataset.quality;
    localStorage.setItem('videoQuality', currentQuality);
  });
});

providerPills.forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    providerPills.forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    // 사용자가 명시적으로 provider를 골랐으니 blocked flag 해제 (WebGPU 다시 시도 가능)
    localStorage.removeItem('webgpuBlocked');
    setProviderPreference(btn.dataset.provider);
    probeProviders().then(info => {
      if (!info.webgpuAvailable && btn.dataset.provider !== 'wasm') {
        providerStatus.textContent = 'WebGPU 미지원 — CPU로 fallback';
      } else {
        providerStatus.textContent = ({
          auto: 'WebGPU 자동 사용',
          webgpu: 'WebGPU 강제 사용',
          wasm: 'CPU 강제 사용',
        })[btn.dataset.provider];
      }
    });
  });
});

// ── DOM 참조 ───────────────────────────────────
const urlInput = $('url');
const probeBtn = $('probe-btn');
const dlBtn = $('dl-btn');
const errBox = $('err');
const progWrap = $('progress-wrap');
const progFill = $('progress-fill');
const progPct = $('progress-pct');
const progPhase = $('progress-phase');
const progSpeed = $('progress-speed');
const progInfo = $('progress-info');
const cancelBtn = $('cancel-btn');
const doneCard = $('done-card');
const donePath = $('done-path');
const openFolderBtn = $('open-folder-btn');
const separateBtn = $('separate-btn');
const sepWrap = $('sep-wrap');
const sepFill = $('sep-fill');
const sepPct = $('sep-pct');
const sepPhase = $('sep-phase');
const sepDetail = $('sep-detail');
const sepInfo = $('sep-info');
const sepCancelBtn = $('sep-cancel-btn');
const stemsDone = $('stems-done');
const stemsList = $('stems-list');
const openStemsBtn = $('open-stems-btn');
const goLibraryBtn = $('go-library-btn');

let currentProbe = null;
let currentVideoPath = null;
let currentBaseName = null;
let lastRegisteredId = null;

// ── 유틸 ───────────────────────────────────────
function setError(msg) {
  if (!msg) { errBox.hidden = true; errBox.textContent = ''; return; }
  errBox.hidden = false; errBox.textContent = msg;
}
function isValidUrl(s) { return /^https?:\/\/[^\s]+$/.test(s.trim()); }
function fmtDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
}
function fmtBytes(b) {
  if (!b || b < 0) return '';
  const u = ['B','KB','MB','GB']; let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + u[i];
}

// ── URL probe ──────────────────────────────────
const existingBanner = $('existing-banner');
const existingSub    = $('existing-banner-sub');
const existingOpen   = $('existing-open-btn');
let existingLibItemId = null;

function resetSeparateView(alsoClearUrl = false) {
  if (alsoClearUrl) { urlInput.value = ''; lastClipboardSeen = ''; }
  probeBtn.disabled = !isValidUrl(urlInput.value);
  dlBtn.disabled = true;
  $('probe-result').hidden = true;
  doneCard.hidden = true;
  stemsDone.hidden = true;
  progWrap.hidden = true;
  sepWrap.hidden = true;
  existingBanner.hidden = true;
  errBox.hidden = true; errBox.textContent = '';
  currentProbe = null;
  currentVideoPath = null;
  currentBaseName = null;
  existingLibItemId = null;
  lastRegisteredId = null;
}

urlInput.addEventListener('input', () => resetSeparateView(false));
$('reset-btn').addEventListener('click', () => { resetSeparateView(true); urlInput.focus(); });

// ── 로컬 파일로 분리 ─────────────────────────────
$('local-btn').addEventListener('click', async () => {
  const res = await api.dialog.pickMedia();
  if (!res.ok) return;
  const filePath = res.filePath;
  const fileName = filePath.split(/[\\/]/).pop();
  const base = fileName.replace(/\.[^.]+$/, '');
  resetSeparateView(true);
  currentVideoPath = filePath;
  currentBaseName  = base;
  currentProbe = {
    id:       'local-' + Math.random().toString(36).slice(2, 8),
    title:    base,
    uploader: '(로컬 파일)',
    duration: 0,
    thumbnail: null,
  };
  donePath.textContent = filePath;
  doneCard.hidden = false;
  urlInput.value = '';
});
probeBtn.disabled = true;
urlInput.addEventListener('paste', () => {
  setTimeout(() => { if (isValidUrl(urlInput.value)) probeBtn.click(); }, 30);
});

// ── 클립보드 YouTube 링크 자동 감지 ───────────
const YT_RE = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/i;
let lastClipboardSeen = '';

async function tryPasteFromClipboard() {
  // 다운로드/분리 진행 중이면 방해 X
  if (urlInput.disabled) return;
  // 이미 입력창에 뭔가 있으면 방해 X
  if (urlInput.value.trim()) return;

  let text = '';
  try { text = (await api.clipboard.read() || '').trim(); } catch { return; }
  if (!text || text === lastClipboardSeen) return;
  lastClipboardSeen = text;
  if (!YT_RE.test(text)) return;

  urlInput.value = text;
  urlInput.dispatchEvent(new Event('input'));  // input 이벤트로 다른 리스너 갱신 (probeBtn 활성화 등)
  // 자동 probe
  if (!probeBtn.disabled) probeBtn.click();
}
api.window.onFocus(() => tryPasteFromClipboard());
document.addEventListener('DOMContentLoaded', () => tryPasteFromClipboard());
// 첫 실행 (모듈 로드 시점) — DOMContentLoaded는 module의 경우 이미 지나갔을 수 있어 즉시도 호출
tryPasteFromClipboard();

probeBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  if (!isValidUrl(url)) return;
  setError('');
  probeBtn.disabled = true;
  probeBtn.textContent = '확인 중…';
  const res = await api.ytdlp.probe(url);
  probeBtn.disabled = false;
  probeBtn.textContent = '확인';
  if (!res.ok) { setError('영상 정보를 가져오지 못했습니다: ' + res.error); return; }
  currentProbe = res.info;
  renderProbe(res.info);
  dlBtn.disabled = false;

  // 라이브러리 중복 검사
  existingBanner.hidden = true;
  existingLibItemId = null;
  if (res.info?.id) {
    const existing = await api.library.findByVideoId(res.info.id);
    if (existing) {
      existingLibItemId = existing.id;
      existingSub.textContent = `${existing.name} · ${new Date(existing.createdAt).toLocaleDateString()}`;
      existingBanner.hidden = false;
      dlBtn.textContent = '다시 다운로드';
    } else {
      dlBtn.textContent = '다운로드';
    }
  }
});

existingOpen.addEventListener('click', async () => {
  if (!existingLibItemId) return;
  switchView('library');
  await Library.refresh();
  await Library.selectItem(existingLibItemId);
});

function renderProbe(info) {
  const thumb = $('probe-thumb');
  if (info.thumbnail) { thumb.src = info.thumbnail; thumb.style.display = ''; } else thumb.style.display = 'none';
  $('probe-title').textContent = info.title || info.id;
  const parts = [];
  if (info.uploader) parts.push(info.uploader);
  if (typeof info.duration === 'number' && info.duration > 0) parts.push(fmtDuration(info.duration));
  parts.push(info.id);
  $('probe-sub').textContent = parts.join(' · ');
  $('probe-result').hidden = false;
}

// ── yt-dlp 다운로드 ────────────────────────────
const PHASE_LABELS_DL = { video: '영상 다운로드', audio: '오디오 다운로드', merge: 'MP4 병합', done: '완료', error: '오류' };
let unsubProgress = null;

dlBtn.addEventListener('click', async () => {
  if (!currentProbe) return;
  setError('');
  doneCard.hidden = true; stemsDone.hidden = true;
  progWrap.hidden = false;
  progFill.style.width = '0%'; progPct.textContent = '0%';
  progPhase.textContent = PHASE_LABELS_DL.video;
  progSpeed.textContent = ''; progInfo.textContent = '';
  cancelBtn.hidden = false;
  dlBtn.disabled = true; probeBtn.disabled = true; urlInput.disabled = true;

  unsubProgress?.();
  unsubProgress = api.ytdlp.onProgress((p) => {
    if (p.phase === 'error') { setError('yt-dlp: ' + (p.message || 'unknown')); return; }
    if (p.phase && PHASE_LABELS_DL[p.phase]) progPhase.textContent = PHASE_LABELS_DL[p.phase];
    if (typeof p.ratio === 'number') {
      const pct = Math.max(0, Math.min(100, Math.round(p.ratio * 100)));
      progFill.style.width = pct + '%'; progPct.textContent = pct + '%';
    }
    const bits = [];
    if (p.dl && p.total) bits.push(`${fmtBytes(p.dl)} / ${fmtBytes(p.total)}`);
    if (p.speed) bits.push(fmtBytes(p.speed) + '/s');
    if (typeof p.eta === 'number' && p.eta > 0) bits.push('ETA ' + fmtDuration(p.eta));
    progInfo.textContent = bits.join(' · ');
    if (p.speed) progSpeed.textContent = fmtBytes(p.speed) + '/s';
  });

  const res = await api.ytdlp.download(urlInput.value.trim(), {
    title: currentProbe?.title, id: currentProbe?.id, quality: currentQuality,
  });
  unsubProgress?.(); unsubProgress = null;
  cancelBtn.hidden = true;
  dlBtn.disabled = false; probeBtn.disabled = false; urlInput.disabled = false;

  if (!res.ok) { setError('다운로드 실패: ' + res.error); progWrap.hidden = true; return; }
  currentVideoPath = res.filePath;
  currentBaseName = res.filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  donePath.textContent = res.filePath;
  doneCard.hidden = false;
});

cancelBtn.addEventListener('click', async () => { await api.ytdlp.cancel(); });
openFolderBtn.addEventListener('click', async () => {
  const dir = await api.getDownloadsDir();
  await api.openPath(dir);
});

// ── 스템 분리 ──────────────────────────────────
const PHASE_LABELS_SEP = {
  init: '워커 초기화',
  model: '모델 로드',
  extract: '오디오 추출',
  separate: '스템 분리',
  save: 'WAV 저장',
  done: '완료',
};

sepCancelBtn.addEventListener('click', () => {
  cancelSeparation();
  sepInfo.textContent = '취소 중…';
});

separateBtn.addEventListener('click', async () => {
  if (!currentVideoPath) return;
  setError('');
  stemsDone.hidden = true;
  sepWrap.hidden = false;
  sepFill.style.width = '0%'; sepPct.textContent = '0%';
  sepPhase.textContent = PHASE_LABELS_SEP.init;
  sepDetail.textContent = ''; sepInfo.textContent = '';
  separateBtn.disabled = true;
  sepCancelBtn.hidden = false;

  const t0 = performance.now();
  try {
    await ensureModelBeforeSeparation(currentModelKey);
    const result = await separatePipeline(currentVideoPath, currentBaseName, (phase, ratio, detail) => {
      if (PHASE_LABELS_SEP[phase]) sepPhase.textContent = PHASE_LABELS_SEP[phase];
      if (typeof ratio === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        sepFill.style.width = pct + '%'; sepPct.textContent = pct + '%';
      }
      if (detail) sepInfo.textContent = detail;
    }, { modelKey: currentModelKey });
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    const ep = getUsedProvider() || '?';
    sepInfo.textContent = `${dt}s 소요 · ${ep === 'webgpu' ? 'WebGPU' : 'CPU (WASM)'} 사용`;
    stemsList.innerHTML = '';
    for (const [name, p] of Object.entries(result.stemPaths)) {
      const div = document.createElement('div');
      div.textContent = `${name}: ${p}`;
      stemsList.appendChild(div);
    }
    stemsDone.hidden = false;
    openStemsBtn.dataset.dir = result.outDir;

    // 라이브러리 등록
    const displayName = currentProbe?.title || currentBaseName;
    const reg = await api.library.register({
      name: displayName,
      videoPath: currentVideoPath,
      stemPaths: result.stemPaths,
      outDir: result.outDir,
      sampleRate: result.sampleRate,
      modelKey: currentModelKey,
      meta: {
        title: currentProbe?.title,
        uploader: currentProbe?.uploader,
        duration: currentProbe?.duration,
        id: currentProbe?.id,
        thumbnail: currentProbe?.thumbnail,
      },
    });
    lastRegisteredId = reg.id;
  } catch (err) {
    console.error(err);
    if (err.message === '취소됨') {
      setError('');
      sepPhase.textContent = '취소됨';
      sepInfo.textContent = '';
    } else {
      setError('스템 분리 실패: ' + err.message);
    }
  } finally {
    separateBtn.disabled = false;
    sepCancelBtn.hidden = true;
  }
});

openStemsBtn.addEventListener('click', async () => {
  const dir = openStemsBtn.dataset.dir;
  if (dir) await api.openPath(dir);
});

goLibraryBtn.addEventListener('click', async () => {
  switchView('library');
  await Library.refresh();
  if (lastRegisteredId) await Library.selectItem(lastRegisteredId);
});

// ── 라이브러리에서 "다른 모델로 재분리" 요청 ────────
document.addEventListener('yss:preload-separation', (ev) => {
  const { videoPath, baseName, probe, modelKey } = ev.detail || {};
  if (!videoPath) return;
  resetSeparateView(true);
  currentVideoPath = videoPath;
  currentBaseName  = baseName;
  currentProbe     = probe;
  // 모델 pill 설정
  if (modelKey && ['4stem', '6stem'].includes(modelKey)) {
    currentModelKey = modelKey;
    localStorage.setItem('modelKey', modelKey);
    modelPills.forEach(b => b.classList.toggle('on', b.dataset.model === modelKey));
    updateModelStatusLabel();
  }
  donePath.textContent = videoPath;
  doneCard.hidden = false;
  switchView('separate');
  // 사용자 검토 후 클릭할 수 있도록 안내
  setError('');
  // 자동 스크롤 유도
  doneCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
});

// ── Auto-updater UI ────────────────────────────────
const updBadge   = $('update-badge');
const updDialog  = $('update-dialog');
const updTitle   = $('update-dialog-title');
const updBody    = $('update-dialog-body');
const updProg    = $('update-dialog-progress');
const updFill    = $('update-fill');
const updInfo    = $('update-info');
const updClose   = $('update-close');
const updDownload= $('update-download');
const updInstall = $('update-install');

let updState = 'idle';
let updVersion = null;

function showDialog() { updDialog.hidden = false; }
function hideDialog() { updDialog.hidden = true; }

updClose.addEventListener('click', hideDialog);
updBadge.addEventListener('click', showDialog);
updDialog.addEventListener('click', (e) => { if (e.target === updDialog) hideDialog(); });

updDownload.addEventListener('click', async () => {
  updDownload.hidden = true;
  updState = 'downloading';
  updProg.hidden = false;
  updBody.textContent = '업데이트 다운로드 중…';
  const res = await api.update.download();
  if (!res.ok) {
    updBody.textContent = '다운로드 실패: ' + res.error;
    updDownload.hidden = false;
  }
});
updInstall.addEventListener('click', async () => {
  await api.update.install();
});

api.update.onEvent((d) => {
  switch (d.type) {
    case 'available':
      updVersion = d.version;
      updState = 'available';
      updBadge.textContent = `v${d.version} 사용 가능`;
      updBadge.hidden = false;
      updTitle.textContent = `새 버전 v${d.version} 있음`;
      // GitHub 릴리즈 노트는 마크다운→HTML로 변환되어 옴. 태그를 렌더링해 표시.
      if (typeof d.notes === 'string' && d.notes) {
        const looksHtml = /<[a-z][\s\S]*>/i.test(d.notes);
        if (looksHtml) updBody.innerHTML = d.notes;
        else updBody.textContent = d.notes;
      } else {
        updBody.textContent = '릴리즈 노트 없음.';
      }
      updDownload.hidden = false;
      updInstall.hidden = true;
      updProg.hidden = true;
      break;
    case 'not-available':
      updState = 'idle';
      break;
    case 'progress': {
      const pct = Math.round(d.percent || 0);
      updFill.style.width = pct + '%';
      const speed = d.speed ? (d.speed / 1024 / 1024).toFixed(1) + ' MB/s' : '';
      updInfo.textContent = `${pct}% · ${speed}`;
      break;
    }
    case 'downloaded':
      updState = 'downloaded';
      updBadge.textContent = `v${d.version} 준비됨`;
      updBadge.hidden = false;
      updTitle.textContent = `v${d.version} 설치 준비 완료`;
      updBody.textContent = '앱을 재시작해 업데이트를 적용합니다.';
      updProg.hidden = true;
      updDownload.hidden = true;
      updInstall.hidden = false;
      showDialog();
      break;
    case 'error':
      console.error('[update]', d.message);
      if (updDialog.hidden === false) {
        updBody.textContent = '오류: ' + d.message;
      }
      break;
    case 'portable-hint':
      // portable exe는 자동 업데이트 없음 — badge 안 띄움
      console.log('[update] portable build, auto-update disabled');
      break;
  }
});
