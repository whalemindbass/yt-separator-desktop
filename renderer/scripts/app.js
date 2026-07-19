'use strict';
// Renderer main:
//   - 탭 라우팅 (separate / library)
//   - 새 분리 뷰의 URL 입력 → 다운로드 → 스템 분리 → 라이브러리 등록
//   - 재생 UI는 library.js가 담당

import { separatePipeline, probeProviders, setProviderPreference, getUsedProvider, cancelSeparation } from './separator.js';
import { Library } from './library.js';
import { t, setLocale, getLocale, applyI18n, onLocaleChange } from './i18n.js';

// 최초 로드 즉시 i18n 적용
applyI18n(document);

const $ = (id) => document.getElementById(id);
const api = window.yssApi;

/** GitHub 릴리즈 노트의 마크다운을 간단 HTML로 렌더. XSS 방지 위해 HTML 이스케이프 먼저. */
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = esc(md);
  const lines = out.split('\n');
  const rendered = [];
  let listBuf = [];
  const flushList = () => {
    if (listBuf.length) {
      rendered.push('<ul>' + listBuf.map(l => '<li>' + l + '</li>').join('') + '</ul>');
      listBuf = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^###\s+/.test(line))      { flushList(); rendered.push('<h3>' + line.replace(/^###\s+/, '') + '</h3>'); continue; }
    if (/^##\s+/.test(line))       { flushList(); rendered.push('<h2>' + line.replace(/^##\s+/, '')  + '</h2>'); continue; }
    if (/^#\s+/.test(line))        { flushList(); rendered.push('<h1>' + line.replace(/^#\s+/, '')   + '</h1>'); continue; }
    if (/^[-*]\s+/.test(line))     { listBuf.push(line.replace(/^[-*]\s+/, '')); continue; }
    if (/^\d+\.\s+/.test(line))    { listBuf.push(line.replace(/^\d+\.\s+/, '')); continue; }
    flushList();
    if (line === '') { rendered.push(''); continue; }
    rendered.push('<p>' + line + '</p>');
  }
  flushList();
  let html = rendered.join('\n');
  // 인라인
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`]+?)`/g, '<code>$1</code>');
  html = html.replace(/\[([^\]]+?)\]\((https?:[^)]+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return html;
}

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

// ── 설정 뷰 ──────────────────────────────────────
function fmtBytes2(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = n || 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 ? 2 : (v < 100 ? 1 : 0)) + ' ' + u[i];
}

const sLangPills     = document.querySelectorAll('#s-lang-pills .pill');
const sModelPills    = document.querySelectorAll('#s-model-pills .pill');
const sProviderPills = document.querySelectorAll('#s-provider-pills .pill');
const sQualityPills  = document.querySelectorAll('#s-quality-pills .pill');
const sClipboardCB   = $('s-clipboard-detect');
const sDownloadsDir  = $('s-downloads-dir');
const sDownloadsOpen = $('s-downloads-open');
const sDownloadsChg  = $('s-downloads-change');
const sDiskUsage     = $('s-disk-usage');
const sDiskRefresh   = $('s-disk-refresh');
const sCleanup       = $('s-cleanup');
const sModels        = $('s-models');
const sAutoUpdateCB  = $('s-auto-update');
const sCheckUpdate   = $('s-check-update');
const sUpdateStatus  = $('s-update-status');
const sAppInfo       = $('s-app-info');
const sReleaseNotes  = $('s-release-notes');

async function refreshSettingsView() {
  // 언어 pill sync
  const curLang = getLocale();
  sLangPills.forEach(b => b.classList.toggle('on', b.dataset.lang === curLang));

  // 모델 pill sync (localStorage와 통일)
  const modelKey = localStorage.getItem('modelKey') || '4stem';
  sModelPills.forEach(b => b.classList.toggle('on', b.dataset.model === modelKey));

  const provider = localStorage.getItem('executionProvider') || 'auto';
  sProviderPills.forEach(b => b.classList.toggle('on', b.dataset.provider === provider));

  const quality = localStorage.getItem('videoQuality') || '1080';
  sQualityPills.forEach(b => b.classList.toggle('on', b.dataset.quality === quality));

  sClipboardCB.checked = localStorage.getItem('clipboardAutoDetect') !== '0';

  // Main-side settings
  try {
    const s = await api.settings.get();
    sAutoUpdateCB.checked = s.autoUpdateEnabled !== false;
  } catch {}

  // Downloads dir
  try {
    const dir = await api.settings.downloadsDir();
    sDownloadsDir.textContent = dir;
  } catch (e) { sDownloadsDir.textContent = t('common.error') + ': ' + e.message; }

  // Disk usage
  refreshDiskUsage();

  // Models list
  refreshModelsList();

  // App info
  try {
    const info = await api.settings.appInfo();
    sAppInfo.textContent = `v${info.appVersion} · Electron ${info.electronVersion} · Chromium ${info.chromeVersion} · Node ${info.nodeVersion}`;
    sUpdateStatus.textContent = (getLocale() === 'en' ? 'Current: v' : '현재 버전 v') + info.appVersion;
  } catch {}
}

sLangPills.forEach(btn => btn.addEventListener('click', () => {
  const lang = btn.dataset.lang;
  setLocale(lang);   // data-i18n 요소들 자동 갱신 + 'yss:locale-change' 이벤트 dispatch
  sLangPills.forEach(b => b.classList.toggle('on', b.dataset.lang === lang));
  refreshSettingsView();
  refreshModelsList();
  updateModelStatusLabel();
  // provider status 갱신
  const pref = localStorage.getItem('executionProvider') || 'auto';
  const blocked = localStorage.getItem('webgpuBlocked') === '1';
  if (providerStatus) {
    if (blocked) providerStatus.textContent = t('prov.webgpu.nan');
    else providerStatus.textContent = pref === 'auto' ? t('prov.auto') : (pref === 'webgpu' ? t('prov.webgpu') : t('prov.cpu'));
  }
  // 현재 선택된 라이브러리 아이템 있으면 다시 렌더링
  if (Library && typeof Library.refresh === 'function') Library.refresh().catch(()=>{});
}));

async function refreshDiskUsage() {
  sDiskUsage.textContent = t('progress.calculating');
  try {
    const u = await api.settings.calcDiskUsage();
    const isEn = getLocale() === 'en';
    sDiskUsage.textContent = isEn
      ? `Total ${fmtBytes2(u.total)} (downloads ${fmtBytes2(u.downloads)} + models ${fmtBytes2(u.models)})`
      : `총 ${fmtBytes2(u.total)} (다운로드 ${fmtBytes2(u.downloads)} + 모델 ${fmtBytes2(u.models)})`;
  } catch (e) { sDiskUsage.textContent = t('common.error'); }
}

async function refreshModelsList() {
  sModels.innerHTML = '';
  const isEn = getLocale() === 'en';
  const L = {
    downloaded:    isEn ? 'Downloaded'    : '다운로드됨',
    notDownloaded: isEn ? 'Not downloaded': '미다운로드',
    delete:        isEn ? 'Delete'        : '삭제',
    downloadNow:   isEn ? 'Download now'  : '지금 다운로드',
  };
  try {
    const res = await api.stem.models();
    if (!res.ok) return;
    for (const [key, m] of Object.entries(res.models)) {
      const row = document.createElement('div');
      row.className = 'settings-model';
      row.innerHTML = `
        <div class="settings-model-info">
          <div class="settings-model-name">${m.label}</div>
          <div class="settings-model-meta">${fmtBytes2(m.size)}</div>
        </div>
        <span class="settings-model-status ${m.downloaded ? 'on' : 'off'}">${m.downloaded ? L.downloaded : L.notDownloaded}</span>
        <div class="settings-actions">
          ${m.downloaded
            ? `<button class="btn" data-act="delete" data-key="${key}">${L.delete}</button>`
            : `<button class="btn" data-act="download" data-key="${key}">${L.downloadNow}</button>`}
        </div>
      `;
      sModels.appendChild(row);
    }
  } catch (e) { console.error(e); }
}

sModels?.addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const key = btn.dataset.key;
  const act = btn.dataset.act;
  if (act === 'delete') {
    if (!confirm(t('err.delete.confirm'))) return;
    await api.settings.deleteModel(key);
    await refreshModelsList();
    await refreshDiskUsage();
  } else if (act === 'download') {
    try {
      await ensureModelBeforeSeparation(key);
      await refreshModelsList();
      await refreshDiskUsage();
    } catch (e) { alert(t('err.download.fail') + ': ' + e.message); }
  }
});

sModelPills.forEach(btn => btn.addEventListener('click', () => {
  sModelPills.forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  localStorage.setItem('modelKey', btn.dataset.model);
  currentModelKey = btn.dataset.model;
  modelPills.forEach(b => b.classList.toggle('on', b.dataset.model === currentModelKey));
  updateModelStatusLabel();
}));
sProviderPills.forEach(btn => btn.addEventListener('click', () => {
  sProviderPills.forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  setProviderPreference(btn.dataset.provider);
  providerPills.forEach(b => b.classList.toggle('on', b.dataset.provider === btn.dataset.provider));
}));
sQualityPills.forEach(btn => btn.addEventListener('click', () => {
  sQualityPills.forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  currentQuality = btn.dataset.quality;
  localStorage.setItem('videoQuality', currentQuality);
  qualityPills.forEach(b => b.classList.toggle('on', b.dataset.quality === currentQuality));
}));
sClipboardCB?.addEventListener('change', () => {
  localStorage.setItem('clipboardAutoDetect', sClipboardCB.checked ? '1' : '0');
});
sAutoUpdateCB?.addEventListener('change', async () => {
  await api.settings.set({ autoUpdateEnabled: sAutoUpdateCB.checked });
});
sDownloadsOpen?.addEventListener('click', async () => {
  const dir = await api.settings.downloadsDir();
  await api.openPath(dir);
});
sDownloadsChg?.addEventListener('click', async () => {
  const res = await api.settings.pickDownloadsDir();
  if (res.ok) {
    sDownloadsDir.textContent = res.dir;
    refreshDiskUsage();
  }
});
sDiskRefresh?.addEventListener('click', refreshDiskUsage);
sCleanup?.addEventListener('click', async () => {
  await Library.refresh();
  const dupRes = await api.library.cleanup();
  const preview = await api.library.previewOrphans();
  const orphans = [...(preview.videos || []), ...(preview.stems || [])];
  const isEn = getLocale() === 'en';
  const dupMsg = dupRes.removed > 0
    ? (isEn ? `${dupRes.removed} duplicate(s) merged.` : `중복 ${dupRes.removed}개 통합됨.`)
    : (isEn ? 'No duplicates.' : '중복 없음.');
  if (!orphans.length) {
    alert(`${dupMsg}\n${isEn ? 'No orphan files either — all clean.' : '라이브러리에 없는 파일도 없음 — 깨끗함.'}`);
    refreshDiskUsage(); return;
  }
  const totalMb = (orphans.reduce((s,x)=>s+x.size,0)/1024/1024).toFixed(1);
  const prompt = isEn
    ? `${dupMsg}\nDelete ${orphans.length} orphan file(s) (${totalMb} MB)?`
    : `${dupMsg}\n라이브러리에 없는 파일 ${orphans.length}개 (${totalMb} MB)를 삭제할까요?`;
  if (confirm(prompt)) {
    for (const o of orphans) await api.library.deleteOrphan(o.path);
    alert(isEn ? 'Cleanup complete' : '정리 완료');
  }
  refreshDiskUsage();
});
sCheckUpdate?.addEventListener('click', () => {
  sUpdateStatus.textContent = t('common.checking');
  api.update.check();
});
sReleaseNotes?.addEventListener('click', () => {
  api.openExternal('https://github.com/whalemindbass/yt-separator-releases/releases');
});

// 설정 뷰 진입 시 상태 갱신
const _origSwitchView = switchView;
switchView = function(name) {
  _origSwitchView(name);
  if (name === 'settings') refreshSettingsView();
};

// 클립보드 감지 토글 반영 (기본 감지 로직에 체크 추가)
const _origTryPaste = tryPasteFromClipboard;
tryPasteFromClipboard = async function() {
  if (localStorage.getItem('clipboardAutoDetect') === '0') return;
  return _origTryPaste();
};

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
    providerStatus.textContent = t('prov.webgpu.unsupported');
  } else if (blocked) {
    if (webgpuBtn) webgpuBtn.disabled = false;
    providerStatus.textContent = t('prov.webgpu.nan');
  } else {
    providerStatus.textContent = pref === 'auto' ? t('prov.auto') : (pref === 'webgpu' ? t('prov.webgpu') : t('prov.cpu'));
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
  if (info.downloaded) modelStatus.textContent = t('model.state.ready');
  else modelStatus.textContent = t('model.state.willDl', { size: (info.size/1024/1024).toFixed(0) });
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

  const isEn = getLocale() === 'en';
  const kLabel = modelKey === '6stem' ? '6-stem' : '4-stem';
  modelDlTitle.textContent = isEn ? `${kLabel} model download` : `${kLabel} 모델 다운로드`;
  const mb = info ? (info.size / 1024 / 1024).toFixed(0) : '?';
  modelDlBody.textContent = isEn
    ? `Downloading the model file (~${mb}MB) for first use.\nInternet connection required.`
    : `첫 사용을 위해 모델 파일(약 ${mb}MB)을 다운로드합니다.\n인터넷 연결이 필요합니다.`;
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
      modelDlInfo.textContent = t('common.done');
    }
  });

  const res = await api.stem.ensureModel(modelKey);
  modelDlUnsub?.(); modelDlUnsub = null;
  modelDlDialog.hidden = true;
  if (!res.ok) throw new Error((isEn ? 'Model download failed: ' : '모델 다운로드 실패: ') + res.error);
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
        providerStatus.textContent = t('prov.fallback');
      } else {
        providerStatus.textContent = ({
          auto:   t('prov.auto'),
          webgpu: t('prov.webgpu'),
          wasm:   t('prov.cpu'),
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
    uploader: getLocale() === 'en' ? '(local file)' : '(로컬 파일)',
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
  probeBtn.textContent = t('sep.probing');
  const res = await api.ytdlp.probe(url);
  probeBtn.disabled = false;
  probeBtn.textContent = t('sep.probe');
  if (!res.ok) {
    const isEn = getLocale() === 'en';
    setError((isEn ? 'Could not fetch video info: ' : '영상 정보를 가져오지 못했습니다: ') + res.error);
    return;
  }
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
      dlBtn.textContent = t('sep.redownload');
    } else {
      dlBtn.textContent = t('sep.download');
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
const phaseLabelsDl = () => ({
  video: t('phase.dl.video'),
  audio: t('phase.dl.audio'),
  merge: t('phase.dl.merge'),
  done:  t('phase.dl.done'),
  error: t('phase.dl.error'),
});
let unsubProgress = null;

dlBtn.addEventListener('click', async () => {
  if (!currentProbe) return;
  setError('');
  doneCard.hidden = true; stemsDone.hidden = true;
  progWrap.hidden = false;
  progFill.style.width = '0%'; progPct.textContent = '0%';
  const dlLabels = phaseLabelsDl();
  progPhase.textContent = dlLabels.video;
  progSpeed.textContent = ''; progInfo.textContent = '';
  cancelBtn.hidden = false;
  dlBtn.disabled = true; probeBtn.disabled = true; urlInput.disabled = true;

  unsubProgress?.();
  unsubProgress = api.ytdlp.onProgress((p) => {
    if (p.phase === 'error') { setError('yt-dlp: ' + (p.message || 'unknown')); return; }
    if (p.phase && dlLabels[p.phase]) progPhase.textContent = dlLabels[p.phase];
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

  if (!res.ok) { setError(t('err.dlpFailed') + ': ' + res.error); progWrap.hidden = true; return; }
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
const phaseLabelsSep = () => ({
  init:     t('phase.sep.init'),
  model:    t('phase.sep.model'),
  extract:  t('phase.sep.extract'),
  separate: t('phase.sep.separate'),
  save:     t('phase.sep.save'),
  done:     t('phase.sep.done'),
});

sepCancelBtn.addEventListener('click', () => {
  cancelSeparation();
  sepInfo.textContent = t('phase.sep.canceling');
});

separateBtn.addEventListener('click', async () => {
  if (!currentVideoPath) return;
  setError('');
  stemsDone.hidden = true;
  sepWrap.hidden = false;
  sepFill.style.width = '0%'; sepPct.textContent = '0%';
  const sepLabels = phaseLabelsSep();
  sepPhase.textContent = sepLabels.init;
  sepDetail.textContent = ''; sepInfo.textContent = '';
  separateBtn.disabled = true;
  sepCancelBtn.hidden = false;

  const t0 = performance.now();
  try {
    await ensureModelBeforeSeparation(currentModelKey);
    const result = await separatePipeline(currentVideoPath, currentBaseName, (phase, ratio, detail) => {
      if (sepLabels[phase]) sepPhase.textContent = sepLabels[phase];
      if (typeof ratio === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        sepFill.style.width = pct + '%'; sepPct.textContent = pct + '%';
      }
      if (detail) sepInfo.textContent = detail;
    }, { modelKey: currentModelKey });
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    const ep = getUsedProvider() || '?';
    sepInfo.textContent = t('sep.done.detail', { time: dt, provider: ep === 'webgpu' ? 'WebGPU' : 'CPU (WASM)' });
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
    if (err.message === '취소됨' || err.message === 'Canceled') {
      setError('');
      sepPhase.textContent = t('phase.sep.canceled');
      sepInfo.textContent = '';
    } else {
      setError(t('err.sepFailed') + ': ' + err.message);
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
  const portableUrl = updDownload.dataset.portableUrl;
  if (portableUrl) {
    await api.openExternal(portableUrl);
    hideDialog();
    return;
  }
  updDownload.hidden = true;
  updState = 'downloading';
  updProg.hidden = false;
  updBody.textContent = t('upd.downloading');
  const res = await api.update.download();
  if (!res.ok) {
    updBody.textContent = t('upd.dlFail') + ': ' + res.error;
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
      updBadge.textContent = t('upd.badge', { version: d.version });
      updBadge.hidden = false;
      updTitle.textContent = t('upd.newVersion', { version: d.version });
      // 릴리즈 노트 렌더링 — HTML이면 그대로, 마크다운이면 간단 변환
      if (typeof d.notes === 'string' && d.notes) {
        const looksHtml = /<[a-z][\s\S]*>/i.test(d.notes);
        updBody.innerHTML = looksHtml ? d.notes : mdToHtml(d.notes);
      } else {
        updBody.textContent = t('upd.notes.none');
      }
      updDownload.hidden = false;
      updInstall.hidden = true;
      updProg.hidden = true;
      if (d.portable && d.releaseUrl) {
        updDownload.textContent = t('upd.openPage');
        updDownload.dataset.portableUrl = d.releaseUrl;
      } else {
        updDownload.textContent = t('upd.download');
        delete updDownload.dataset.portableUrl;
      }
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
    case 'downloaded': {
      const isEn = getLocale() === 'en';
      updState = 'downloaded';
      updBadge.textContent = isEn ? `v${d.version} ready` : `v${d.version} 준비됨`;
      updBadge.hidden = false;
      updTitle.textContent = isEn ? `v${d.version} ready to install` : `v${d.version} 설치 준비 완료`;
      updBody.textContent = isEn
        ? 'Restart the app to apply the update.'
        : '앱을 재시작해 업데이트를 적용합니다.';
      updProg.hidden = true;
      updDownload.hidden = true;
      updInstall.hidden = false;
      showDialog();
      break;
    }
    case 'error':
      console.error('[update]', d.message);
      if (updDialog.hidden === false) {
        updBody.textContent = t('common.error') + ': ' + d.message;
      }
      break;
  }
});
