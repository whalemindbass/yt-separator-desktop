'use strict';
// Renderer main:
//   - 탭 라우팅 (separate / library)
//   - 새 분리 뷰의 URL 입력 → 다운로드 → 스템 분리 → 라이브러리 등록
//   - 재생 UI는 library.js가 담당

import { separatePipeline, probeProviders, setProviderPreference, getUsedProvider } from './separator.js';
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

urlInput.addEventListener('input', () => {
  const ok = isValidUrl(urlInput.value);
  probeBtn.disabled = !ok;
  $('probe-result').hidden = true;
  doneCard.hidden = true;
  stemsDone.hidden = true;
  dlBtn.disabled = true;
  currentProbe = null;
  existingBanner.hidden = true;
  existingLibItemId = null;
});
probeBtn.disabled = true;
urlInput.addEventListener('paste', () => {
  setTimeout(() => { if (isValidUrl(urlInput.value)) probeBtn.click(); }, 30);
});

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
    title: currentProbe?.title, id: currentProbe?.id,
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

separateBtn.addEventListener('click', async () => {
  if (!currentVideoPath) return;
  setError('');
  stemsDone.hidden = true;
  sepWrap.hidden = false;
  sepFill.style.width = '0%'; sepPct.textContent = '0%';
  sepPhase.textContent = PHASE_LABELS_SEP.init;
  sepDetail.textContent = ''; sepInfo.textContent = '';
  separateBtn.disabled = true;

  const t0 = performance.now();
  try {
    const result = await separatePipeline(currentVideoPath, currentBaseName, (phase, ratio, detail) => {
      if (PHASE_LABELS_SEP[phase]) sepPhase.textContent = PHASE_LABELS_SEP[phase];
      if (typeof ratio === 'number') {
        const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        sepFill.style.width = pct + '%'; sepPct.textContent = pct + '%';
      }
      if (detail) sepInfo.textContent = detail;
    });
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
    setError('스템 분리 실패: ' + err.message);
  } finally {
    separateBtn.disabled = false;
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
      updBody.textContent = (typeof d.notes === 'string' && d.notes) ? d.notes : '릴리즈 노트 없음.';
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
