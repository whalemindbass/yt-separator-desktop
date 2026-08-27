'use strict';
// Renderer main:
//   - 탭 라우팅 (separate / library)
//   - 새 분리 뷰의 URL 입력 → 다운로드 → 스템 분리 → 라이브러리 등록
//   - 재생 UI는 library.js가 담당

import { separatePipeline, probeProviders, setProviderPreference, getUsedProvider, cancelSeparation } from './separator.js';
import { Library } from './library.js';
import { initCommunity } from './community.js';
import { initStudio, loadProjectData } from './studio.js';
import { initHome } from './home.js';
import { initTraining } from './training.js';
import { initVideoEditor } from './video-editor.js';
import { t, setLocale, getLocale, applyI18n, onLocaleChange } from './i18n.js';
import { initReport, noteError } from './report.js';
import { usageEnter } from './usage.js';

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
  // 프로 툴 정체성 — 기본 다크 (저장된 선택은 존중).
  // 중간 톤 테마를 시험했다가 뺐으므로, 그때 저장된 값은 다크로 되돌린다.
  const initial = saved === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = initial;
  if (saved && saved !== initial) localStorage.setItem('theme', initial);
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
  usageEnter(name);
  if (name === 'library') Library.refresh().catch(console.error);
  if (name === 'community') initCommunity().catch(console.error);
  if (name === 'studio') initStudio().catch(console.error);
  if (name === 'training') initTraining();
  if (name === 'video') initVideoEditor().catch(console.error);
  if (name === 'home') initHome(switchView);
  // 홈은 탭이 아니라 로고로 들어온다 — 홈일 때는 어떤 탭도 켜져 있으면 안 된다
  document.getElementById('brand-home')?.classList.toggle('on', name === 'home');
}
$('brand-home').addEventListener('click', () => switchView('home'));
tabs.forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

initReport();   // 오류 제보 (상단바 · 설정)

// .yssproj 를 더블클릭해 들어온 경우 — 스튜디오로 옮기고 그대로 연다.
// 파일을 눌렀는데 홈 화면이 뜨면 무엇이 열린 것인지 알 수 없다.
api.project?.onOpenFile?.(async ({ path, data }) => {
  switchView('studio');
  await initStudio();
  await loadProjectData(path, data);
});

// ── 초기 뷰: 라이브러리에 항목이 있으면 라이브러리로, 없으면 새 분리 ──
(async () => {
  try {
    const items = await api.library.list();
    if (Array.isArray(items) && items.length > 0) {
      switchView('library');
    }
  } catch (e) { /* 실패 시 기본(새 분리) 유지 */ }
})();

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
const sWaveformCB    = $('s-waveform');
const sVstScan       = $('s-vst-scan');
const sVstStatus     = $('s-vst-status');
sVstScan?.addEventListener('click', async () => {
  if (sVstStatus) sVstStatus.textContent = '오디오 엔진 시작 · 스캔 중…';
  try { await api.engine.start([]); api.engine.scanPlugins(); } catch {}
});
api.engine?.onEvent?.((m) => { if (m.ev === 'plugins' && sVstStatus) sVstStatus.textContent = `감지된 VST: ${(m.list || []).length}개`; });
const sDownloadsDir  = $('s-downloads-dir');
const sDownloadsOpen = $('s-downloads-open');
const sDownloadsChg  = $('s-downloads-change');
const sStemsDir      = $('s-stems-dir');
const sStemsOpen     = $('s-stems-open');
const sStemsChg      = $('s-stems-change');
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
  if (sWaveformCB) sWaveformCB.checked = localStorage.getItem('waveformDisplay') === '1';

  // Main-side settings
  try {
    const s = await api.settings.get();
    sAutoUpdateCB.checked = s.autoUpdateEnabled !== false;
  } catch {}

  // Downloads dir (영상) / Stems dir (스템)
  try {
    const dir = await api.settings.downloadsDir();
    sDownloadsDir.textContent = dir;
  } catch (e) { sDownloadsDir.textContent = t('common.error') + ': ' + e.message; }
  try {
    const sdir = await api.settings.stemsDir();
    if (sStemsDir) sStemsDir.textContent = sdir;
  } catch (e) { if (sStemsDir) sStemsDir.textContent = t('common.error') + ': ' + e.message; }

  // Disk usage
  refreshDiskUsage();

  // Models list
  refreshModelsList();

  // App info
  try {
    const info = await api.settings.appInfo();
    sAppInfo.textContent = `v${info.appVersion}`;
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
sWaveformCB?.addEventListener('change', () => {
  localStorage.setItem('waveformDisplay', sWaveformCB.checked ? '1' : '0');
  window.dispatchEvent(new Event('waveform-pref-changed'));
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
sStemsOpen?.addEventListener('click', async () => {
  const dir = await api.settings.stemsDir();
  await api.openPath(dir);
});
sStemsChg?.addEventListener('click', async () => {
  const res = await api.settings.pickStemsDir();
  if (res.ok) {
    if (sStemsDir) sStemsDir.textContent = res.dir;
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
// ── 모델 선택 (4-stem / 4-stem+ / 6-stem) ────────────────
const modelPills   = document.querySelectorAll('#model-pills .pill');
const MODEL_KEYS   = [...modelPills].map(b => b.dataset.model);   // pill 목록에서 그대로 뽑는다 — 하드코딩 안 함
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
  if (!info) { modelStatus.textContent = ''; modelStatus.classList.remove('hint-warn'); return; }
  let s = info.downloaded ? t('model.state.ready') : t('model.state.willDl', { size: (info.size/1024/1024).toFixed(0) });
  // 4-stem+ 는 정확도 대신 시간을 쓴다 — pill 을 고른 그 자리에서 바로 보여야 나중에 놀라지 않는다
  modelStatus.classList.toggle('hint-warn', currentModelKey === '4stem-2');
  if (currentModelKey === '4stem-2') s += ' · ' + t('model.4stem2.hint');
  modelStatus.textContent = s;
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
  const kLabel = (info && info.label) || modelKey;
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
  noteError('app', msg);   // 제보 시 첨부할 최근 오류로 기록 (메모리에만)
  errBox.hidden = false; errBox.textContent = msg;
  // 화면 밖(하단)에 떠서 못 보는 일 방지 — 항상 보이게 스크롤
  try { errBox.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
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

// probe 성공한 URL — 동일 값 input 이벤트로 상태 날리지 않기 위한 기준
let probedUrl = '';
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
  // 감추는 것으로 끝내면 안 된다 — 카드 안의 옛 내용이 남아, 다음에 그 카드가 뜰 때
  // 새 값을 넣기 전 한 순간 지난 파일 경로·제목이 비친다.
  donePath.textContent = '';
  $('probe-title').textContent = '';
  $('probe-sub').textContent = '';
  $('probe-thumb').removeAttribute('src');
  $('existing-banner-sub').textContent = '';
  currentProbe = null;
  currentVideoPath = null;
  currentBaseName = null;
  existingLibItemId = null;
  lastRegisteredId = null;
  probedUrl = '';
}

// URL 이 실제로 바뀐 경우에만 초기화 — 클립보드 자동감지가 dispatch 하는 합성 input 이벤트나
// 값이 그대로인 input 으로 currentProbe 가 날아가서 "다운로드 눌러도 무반응" 되던 문제 방지
urlInput.addEventListener('input', () => {
  if (urlInput.value.trim() === probedUrl && probedUrl) { probeBtn.disabled = false; return; }
  resetSeparateView(false);
});
$('reset-btn').addEventListener('click', async () => {
  try { await api.ytdlp.cancel(); } catch {}   // 백엔드 프로세스 잔재 청소 (activeDownload 스테일 방지)
  resetSeparateView(true); urlInput.focus();
});

// ── 분리할 대상 고르기 (링크 / 내 파일) ─────────
// 고른 쪽에 필요한 것만 남긴다 — 내 파일은 이미 손에 있으니 주소 칸도, 받아올 화질도 쓸 데가 없다.
const srcLink = $('src-link'), srcFile = $('src-file');
const linkRow = $('link-row'), qualityRow = $('quality-row');
let srcMode = 'link';

/** 다운로드나 스템 분리가 돌고 있는가 — 화면만 갈아치우면 뒤에서 계속 돈다 */
function jobRunning() { return !progWrap.hidden || !sepWrap.hidden; }

/**
 * 입력 방식을 바꾼다.
 * 실제로 바뀔 때는 앞의 결과를 지운다 — 파일을 고른 뒤 링크로 옮기면 그 파일의
 * "다운로드 완료" 카드가 남아 있어서, 링크와 상관없는 파일이 분리 대상으로 잡혔다.
 * @returns {boolean} 바뀌었거나 이미 그 모드면 true, 진행 중이라 막혔으면 false
 */
function setSource(mode, fromUser = false) {
  const changed = mode !== srcMode;
  if (fromUser && changed && jobRunning()) { setError(t('sep.src.busy')); return false; }
  if (fromUser && changed) resetSeparateView(false);   // 주소 입력은 남기고 결과만 지운다
  srcMode = mode;

  const isLink = mode === 'link';
  srcLink.classList.toggle('on', isLink);
  srcFile.classList.toggle('on', !isLink);
  srcLink.setAttribute('aria-pressed', String(isLink));
  srcFile.setAttribute('aria-pressed', String(!isLink));
  linkRow.hidden = !isLink;
  qualityRow.hidden = !isLink;
  return true;
}
srcLink.addEventListener('click', () => { if (setSource('link', true)) urlInput.focus(); });
setSource('link');

// ── 로컬 파일로 분리 ─────────────────────────────
srcFile.addEventListener('click', async () => {
  if (!setSource('file', true)) return;
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
  // 내 파일 분리 중이면 손대지 않는다 — 주소 칸이 접혀 있는데 클립보드 링크를 물어와
  // 미리보기 블록이 혼자 튀어나오던 문제. 사용자가 고른 입력 방식을 뒤집으면 안 된다.
  if (srcMode !== 'link') return;
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
  probedUrl = url;              // 이 URL 로 probe 성공 — 동일 값 input 이벤트로는 리셋 안 함
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
  // 무반응 금지 — 상태 없으면 이유를 알려주고, URL 있으면 probe 부터 자동 수행
  if (!currentProbe) {
    const u = urlInput.value.trim();
    if (isValidUrl(u)) { setError(''); probeBtn.click(); return; }
    setError(getLocale() === 'en'
      ? 'Paste a video address and press Check first.'
      : '먼저 YouTube 주소를 붙여넣고 “확인”을 눌러 주세요.');
    return;
  }
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

  const opts = { title: currentProbe?.title, id: currentProbe?.id, quality: currentQuality };
  let res;
  try {
    res = await api.ytdlp.download(urlInput.value.trim(), opts);
    // 백엔드가 "이미 다운로드 중" 이면 잔재 프로세스 정리 후 1회 자동 재시도
    if (res && !res.ok && /이미 다운로드 중/.test(res.error || '')) {
      try { await api.ytdlp.cancel(); } catch {}
      res = await api.ytdlp.download(urlInput.value.trim(), opts);
    }
  } catch (e) {
    res = { ok: false, error: 'IPC 실패: ' + (e && e.message || e) };
  }
  unsubProgress?.(); unsubProgress = null;
  cancelBtn.hidden = true;
  dlBtn.disabled = false; probeBtn.disabled = false; urlInput.disabled = false;

  if (!res || !res.ok) { setError(t('err.dlpFailed') + ': ' + (res?.error || 'unknown')); progWrap.hidden = true; return; }
  currentVideoPath = res.filePath;
  currentBaseName = res.filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  donePath.textContent = res.filePath;
  doneCard.hidden = false;
  try { doneCard.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch {}
  progWrap.hidden = true;   // 다운로드 progress 는 완료됐으니 감춤 — done-card 만 남겨 흐름 명확화
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
  // 스템 분리 진입: 다운로드 완료 카드는 감춤 (중복 정보 · "폴더 열기" 오클릭 방지)
  doneCard.hidden = true;
  progWrap.hidden = true;
  existingBanner.hidden = true;
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
    sepWrap.hidden = true;    // 분리 완료 → progress 는 감춤, 완료 카드만 남김
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
    // 분리 취소·실패 시 → 이전 단계(다운로드 완료) 복원해서 재시도 가능하게
    sepWrap.hidden = true;
    doneCard.hidden = false;
    if (err.message === '취소됨' || err.message === 'Canceled') {
      setError('');
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

// ── 단일 / 일괄 처리 방식 전환 ──────────────────────
// 두 방식은 화면 구성이 아예 달라(단일=진행률·완료 카드, 일괄=대기열 목록) 한 화면에
// 같이 두면 지금 뭘 보고 있는지 헷갈린다 — 고른 쪽만 보인다.
const modeSingleBtn = $('mode-single');
const modeBatchBtn  = $('mode-batch');
const singleModePanel  = $('single-mode-panel');
const singleModeExtras = $('single-mode-extras');
const batchModePanel   = $('batch-mode-panel');
function setSepMode(mode) {
  const isBatch = mode === 'batch';
  modeSingleBtn.classList.toggle('on', !isBatch);
  modeSingleBtn.setAttribute('aria-pressed', String(!isBatch));
  modeBatchBtn.classList.toggle('on', isBatch);
  modeBatchBtn.setAttribute('aria-pressed', String(isBatch));
  // single-mode-panel/extras 는 hidden 을 강제로 껐다 켰다 하지 않는다 — 그 안 카드들은
  // (프로브 성공/완료 등) 각자 독립적인 hidden 상태를 갖고 있어서, 여기서 false 로 덮으면
  // 아직 안 떠야 할 카드까지 보여버린다. 부모만 감춰서 자손의 hidden 은 그대로 존중한다.
  singleModePanel.hidden = isBatch;
  singleModeExtras.hidden = isBatch;
  batchModePanel.hidden = !isBatch;
}
modeSingleBtn.addEventListener('click', () => setSepMode('single'));
modeBatchBtn.addEventListener('click', () => setSepMode('batch'));

// ── 일괄 처리 대기열 ──────────────────────────────
// 링크 여러 개 또는 파일 여러 개를 모아 뒀다가 순서대로 자동으로 다운로드→분리한다.
// 위쪽 단일 처리 흐름(다운로드/분리 버튼)과는 별도 상태를 쓴다 — currentVideoPath 등을
// 같이 쓰면, 배치 도는 중에 사용자가 단일 처리를 건드릴 때 서로 덮어쓴다. 대신 배치가 도는
// 동안은 단일 처리 버튼을 잠가서 다운로드/취소 같은 전역 상태가 부딪히지 않게 한다.
const batchUrlInput    = $('batch-url');
const batchAddLinkBtn  = $('batch-add-link');
const batchAddFilesBtn = $('batch-add-files');
const batchCountEl     = $('batch-count');
const batchListEl      = $('batch-list');
const batchEmptyEl     = $('batch-empty');
const batchStartBtn    = $('batch-start');
const batchClearBtn    = $('batch-clear');

let batchQueue = [];   // [{ id, kind:'link'|'file', source, title, status, error, probeInfo?, existing? }]
let batchRunning = false;
let batchCancelRequested = false;
let batchSeq = 0;

function renderBatchQueue() {
  batchCountEl.textContent = t('sep.batch.count', { n: batchQueue.length });
  batchListEl.hidden = batchQueue.length === 0;
  batchEmptyEl.hidden = batchQueue.length !== 0;
  batchListEl.innerHTML = '';
  for (const item of batchQueue) {
    const li = document.createElement('li');
    li.className = 'batch-item st-' + item.status;
    const row = document.createElement('div');
    row.className = 'batch-item-row';
    const label = document.createElement('span');
    label.className = 'batch-item-label';
    label.textContent = item.title + (item.existing ? ' · ' + t('sep.batch.dupTag') : '');
    row.appendChild(label);
    const st = document.createElement('span');
    st.className = 'batch-item-status';
    const hasPct = typeof item.progress === 'number' && (item.status === 'downloading' || item.status === 'separating');
    st.textContent = item.status === 'error'
      ? t('sep.batch.st.error') + (item.error ? ': ' + item.error : '')
      : t('sep.batch.st.' + item.status) + (hasPct ? ` ${item.progress}%` : '');
    row.appendChild(st);
    // 도는 중엔 빼기 버튼을 숨긴다 — runBatchQueue() 의 for...of 는 시작 시점의 배열을
    // 그대로 들고 도므로, 도중에 여기서 배열을 필터링해 봐야 이미 시작된 순회에는 반영이
    // 안 된다(목록에선 사라져 보이는데 뒤에서 계속 처리되다가 결국 라이브러리에 등록되는
    // 앞뒤가 안 맞는 상태가 됐었다). 안전하게 도는 동안은 못 빼게 막는다.
    if (item.status === 'pending' && !batchRunning) {
      const rm = document.createElement('button');
      rm.className = 'batch-item-remove'; rm.type = 'button';
      rm.title = t('sep.batch.remove.title'); rm.textContent = '✕';
      rm.addEventListener('click', () => { batchQueue = batchQueue.filter(x => x.id !== item.id); renderBatchQueue(); });
      row.appendChild(rm);
    }
    li.appendChild(row);
    if (hasPct) {
      const bar = document.createElement('div'); bar.className = 'batch-item-bar';
      const fill = document.createElement('div'); fill.className = 'batch-item-bar-fill';
      fill.style.width = Math.max(0, Math.min(100, item.progress)) + '%';
      bar.appendChild(fill);
      li.appendChild(bar);
    }
    batchListEl.appendChild(li);
  }
  // 도는 중엔 "시작" 버튼이 "취소" 버튼으로 바뀐다(같은 자리, 같은 버튼 — 새로 안 만든다).
  batchStartBtn.disabled = !batchRunning && !batchQueue.some(x => x.status === 'pending');
  batchStartBtn.textContent = batchRunning ? t('common.cancel') : t('sep.batch.start');
  batchStartBtn.classList.toggle('primary', !batchRunning);
  batchClearBtn.disabled = batchRunning || !batchQueue.some(x => x.status === 'done' || x.status === 'error' || x.status === 'canceled');
  batchAddLinkBtn.disabled = batchRunning;
  batchAddFilesBtn.disabled = batchRunning;
}

// 대기열에 넣기 전에 실제로 그 영상이 맞는지 확인(프로브)하고, 이미 분리해 둔 영상이면
// 물어본다 — 단일 처리가 다운로드 전에 프로브·중복 배너로 확인시키는 것과 같은 안전장치를
// 여기도 넣는다. URL 문자열만 덜렁 큐에 넣던 예전 방식은 오타·엉뚱한 링크를 그대로
// 다운로드해 버릴 때까지 아무도 몰랐다.
async function addBatchLink() {
  const url = batchUrlInput.value.trim();
  if (!url) { setError(t('sep.batch.needUrl')); return; }
  if (!isValidUrl(url)) { setError(t('sep.batch.badUrl')); return; }
  setError('');
  batchAddLinkBtn.disabled = true;
  batchAddLinkBtn.textContent = t('sep.probing');
  try {
    const probe = await api.ytdlp.probe(url);
    if (!probe || !probe.ok) {
      const isEn = getLocale() === 'en';
      setError((isEn ? 'Could not fetch video info: ' : '영상 정보를 가져오지 못했습니다: ') + (probe?.error || '?'));
      return;
    }
    const info = probe.info;
    let existing = null;
    if (info?.id) {
      existing = await api.library.findByVideoId(info.id);
      if (existing) {
        const when = new Date(existing.createdAt).toLocaleDateString();
        if (!confirm(t('sep.batch.dupConfirm', { name: existing.name, when }))) return;
      }
    }
    batchQueue.push({
      id: ++batchSeq, kind: 'link', source: url,
      title: info?.title || url, status: 'pending', probeInfo: info, existing: !!existing,
    });
    batchUrlInput.value = '';
  } finally {
    batchAddLinkBtn.disabled = false;
    batchAddLinkBtn.textContent = t('sep.batch.addLink');
    renderBatchQueue();
  }
}
batchAddLinkBtn.addEventListener('click', () => { addBatchLink().catch(console.error); });
batchUrlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBatchLink().catch(console.error); });

batchAddFilesBtn.addEventListener('click', async () => {
  const res = await api.dialog.pickMediaFiles();
  if (!res.ok || !res.filePaths?.length) return;
  for (const p of res.filePaths) {
    const name = p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    batchQueue.push({ id: ++batchSeq, kind: 'file', source: p, title: name, status: 'pending' });
  }
  renderBatchQueue();
});

batchClearBtn.addEventListener('click', () => {
  batchQueue = batchQueue.filter(x => x.status !== 'done' && x.status !== 'error' && x.status !== 'canceled');
  renderBatchQueue();
});

batchStartBtn.addEventListener('click', () => {
  if (batchRunning) {
    // 지금 도는 항목까지 바로 멈춘다 — 다음 항목으로 안 넘기고 끝나기를 기다리는 게 아니라,
    // 진행 중인 다운로드/분리 자체를 취소한다(둘 다 안 도는 중이면 아무 효과 없이 조용히 넘어간다).
    batchCancelRequested = true;
    api.ytdlp.cancel().catch(() => {});
    cancelSeparation();
    batchStartBtn.disabled = true;
    return;
  }
  runBatchQueue().catch(console.error);
});

async function runBatchQueue() {
  if (batchRunning) return;
  batchRunning = true;
  batchCancelRequested = false;
  dlBtn.disabled = true; probeBtn.disabled = true; separateBtn.disabled = true;
  renderBatchQueue();
  try {
    for (const item of batchQueue) {
      if (item.status !== 'pending') continue;
      if (batchCancelRequested) { item.status = 'canceled'; renderBatchQueue(); continue; }
      item.status = 'downloading'; item.progress = 0; renderBatchQueue();
      try {
        let videoPath, baseName;
        let meta = item.probeInfo || {};
        if (item.kind === 'link') {
          if (!meta.id) {   // addBatchLink 를 거치지 않고 들어온 경우를 위한 보험(정상 경로는 이미 프로브됨)
            try { const probe = await api.ytdlp.probe(item.source); if (probe?.ok && probe.info) meta = probe.info; } catch {}
          }
          let unsubBatchDl = api.ytdlp.onProgress((p) => {
            if (typeof p.ratio === 'number') { item.progress = Math.round(p.ratio * 100); renderBatchQueue(); }
          });
          let dl;
          try { dl = await api.ytdlp.download(item.source, { title: meta.title, id: meta.id, quality: currentQuality }); }
          finally { unsubBatchDl?.(); unsubBatchDl = null; }
          if (batchCancelRequested) { item.status = 'canceled'; item.progress = null; renderBatchQueue(); continue; }
          if (!dl || !dl.ok) throw new Error(dl?.error || 'download failed');
          videoPath = dl.filePath;
          baseName = dl.filePath.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
        } else {
          videoPath = item.source;
          baseName = item.title;
        }
        item.status = 'separating'; item.progress = 0; renderBatchQueue();
        await ensureModelBeforeSeparation(currentModelKey);
        const result = await separatePipeline(videoPath, baseName, (phase, ratio) => {
          if (typeof ratio === 'number') { item.progress = Math.round(ratio * 100); renderBatchQueue(); }
        }, { modelKey: currentModelKey });
        if (batchCancelRequested) { item.status = 'canceled'; item.progress = null; renderBatchQueue(); continue; }
        await api.library.register({
          name: meta.title || baseName,
          videoPath, stemPaths: result.stemPaths, outDir: result.outDir,
          sampleRate: result.sampleRate, modelKey: currentModelKey,
          meta: {
            title: meta.title || baseName, uploader: meta.uploader,
            duration: meta.duration, id: meta.id, thumbnail: meta.thumbnail,
          },
        });
        item.status = 'done';
      } catch (e) {
        item.status = (e && e.message === '취소됨') || (e && e.message === 'Canceled') || batchCancelRequested
          ? 'canceled' : 'error';
        if (item.status === 'error') item.error = (e && e.message) || String(e);
      }
      item.progress = null;   // 끝났으면(완료·실패·취소) 퍼센트 표시는 그만
      renderBatchQueue();
    }
  } finally {
    batchRunning = false;
    batchCancelRequested = false;
    dlBtn.disabled = false; probeBtn.disabled = false; separateBtn.disabled = false;
    renderBatchQueue();
  }
}
renderBatchQueue();   // 카운트·빈 상태 표시를 초기값으로 맞춰 둔다

goLibraryBtn.addEventListener('click', async () => {
  switchView('library');
  await Library.refresh();
  if (lastRegisteredId) await Library.selectItem(lastRegisteredId);
});

$('new-song-btn')?.addEventListener('click', () => {
  resetSeparateView(true);
  urlInput.focus();
  urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
  if (modelKey && MODEL_KEYS.includes(modelKey)) {
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
  // 설정 · 지금 확인 상태 라벨 갱신 (available / not-available / error 시)
  const isEn = getLocale() === 'en';
  if (sUpdateStatus) {
    if (d.type === 'available') {
      sUpdateStatus.textContent = isEn ? `v${d.version} available` : `v${d.version} 사용 가능`;
    } else if (d.type === 'not-available') {
      sUpdateStatus.textContent = isEn
        ? `Up to date (v${d.version || ''})`
        : `최신 버전입니다 (v${d.version || ''})`;
    } else if (d.type === 'error') {
      sUpdateStatus.textContent = (isEn ? 'Check failed: ' : '확인 실패: ') + (d.message || '');
    } else if (d.type === 'downloaded') {
      sUpdateStatus.textContent = isEn ? `v${d.version} ready to install` : `v${d.version} 설치 준비 완료`;
    }
  }
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
