'use strict';
// Library view — 좌측 리스트 + 우측 플레이어

import { Player, STEM_META, stemOrderFor, stemIconFor, loadStemFilesToBuffers, toYtsepUrl } from './player.js';
import { t, getLocale } from './i18n.js';

const api = window.yssApi;
const $ = (id) => document.getElementById(id);

const listEl        = $('lib-list');
const emptyEl       = $('lib-empty');
const refreshBtn    = $('lib-refresh');
const searchEl      = $('lib-search');
const sortEl        = $('lib-sort');
const collapseBtn   = $('lib-collapse');
const expandBtn     = $('lib-expand');
const playerEmpty   = $('player-empty');
const playerSection = $('player-section');
const playerVideo   = $('player-video');
const playerProv    = $('player-provider');
const playerName    = $('player-name');
const playerDel     = $('player-delete');
const playerLoading = $('player-loading');
const playerErr     = $('player-err');
const mixerTracks   = $('mixer-tracks');
const masterVol     = $('master-vol');
const masterVal     = $('master-val');

let items = [];
let selectedId = null;
let currentPlayer = null;
let _mountId = 0;   // race guard: mountPlayer가 await 중일 때 사용자가 다른 곡을 클릭해도 stale mount가 Player를 만들지 않도록

// ── 곡별 설정 영속화 (videoPath 키로 4/6-stem 형제 공유) ────────
const SONG_SETTINGS_PREFIX = 'yss:song-settings:';
let _currentSongKey = null;
let _restoringSettings = false;   // 복원 중엔 save 안 함 (echo 방지)

function songKeyOf(item) {
  const p = String(item?.videoPath || '').replace(/\\/g, '/').toLowerCase();
  return p ? (SONG_SETTINGS_PREFIX + p) : null;
}
function loadSongSettings(item) {
  const k = songKeyOf(item);
  if (!k) return null;
  try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) : null; }
  catch { return null; }
}
function _mutateSettings(fn) {
  if (_restoringSettings || !_currentSongKey) return;
  let cur = {};
  try { cur = JSON.parse(localStorage.getItem(_currentSongKey) || '{}') || {}; } catch {}
  fn(cur);
  cur.updatedAt = Date.now();
  try { localStorage.setItem(_currentSongKey, JSON.stringify(cur)); } catch {}
}
const saveMaster    = (v)         => _mutateSettings(s => { s.masterVol = v; });
const saveSpeed     = (v)         => _mutateSettings(s => { s.speed = v; });
const saveSource    = (src)       => _mutateSettings(s => { s.source = src; });
const saveKey       = (k)         => _mutateSettings(s => { s.keyShift = k; });
const saveLoop      = (a, b, en)  => _mutateSettings(s => { s.loopA = a; s.loopB = b; s.loopEnabled = !!en; });
const saveTrackVol  = (stem, vol) => _mutateSettings(s => { (s.trackVols  = s.trackVols  || {})[stem] = vol; });
const saveTrackMute = (stem, mu)  => _mutateSettings(s => { (s.trackMutes = s.trackMutes || {})[stem] = !!mu; });
const saveTrackSolo = (stem, so)  => _mutateSettings(s => { (s.trackSolos = s.trackSolos || {})[stem] = !!so; });

function setErr(msg) {
  if (!msg) { playerErr.hidden = true; playerErr.textContent = ''; return; }
  playerErr.hidden = false; playerErr.textContent = msg;
}
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function refresh() {
  items = await api.library.list();
  renderList();
}

function starSvg(filled) {
  return filled
    ? `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.6l1.9 4 4.4.6-3.2 3 .8 4.3L8 11.6 4.1 13.5l.8-4.3-3.2-3 4.4-.6z"/></svg>`
    : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.6l1.9 4 4.4.6-3.2 3 .8 4.3L8 11.6 4.1 13.5l.8-4.3-3.2-3 4.4-.6z"/></svg>`;
}

// ── 검색 / 정렬 상태 (localStorage 유지) ─────────────
let _searchQuery = '';
let _sortMode = (() => {
  try { return localStorage.getItem('yss:lib-sort') || 'group'; } catch { return 'group'; }
})();
if (sortEl) sortEl.value = _sortMode;

searchEl?.addEventListener('input', () => {
  _searchQuery = searchEl.value.trim().toLowerCase();
  renderList();
});
sortEl?.addEventListener('change', () => {
  _sortMode = sortEl.value;
  try { localStorage.setItem('yss:lib-sort', _sortMode); } catch {}
  renderList();
});

// ── 사이드바 접기 / 펼치기 ──────────────────────────
const libBody = document.querySelector('.library-body');
const sideEl  = document.querySelector('.lib-side');
let _sideCollapsed = (() => {
  try { return localStorage.getItem('yss:lib-collapsed') === '1'; } catch { return false; }
})();
function applySideCollapsed() {
  libBody?.classList.toggle('side-collapsed', _sideCollapsed);
  sideEl?.classList.toggle('collapsed', _sideCollapsed);
  if (expandBtn) expandBtn.hidden = !_sideCollapsed;
}
applySideCollapsed();
collapseBtn?.addEventListener('click', () => {
  _sideCollapsed = true;
  try { localStorage.setItem('yss:lib-collapsed', '1'); } catch {}
  applySideCollapsed();
});
expandBtn?.addEventListener('click', () => {
  _sideCollapsed = false;
  try { localStorage.setItem('yss:lib-collapsed', '0'); } catch {}
  applySideCollapsed();
});

function groupSort(a, b) {
  // 즐겨찾기 최우선, 그룹 이름 순, 그 다음 최신순
  if ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)) return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
  const ga = a.group || 'ᆢ'; const gb = b.group || 'ᆢ';   // 그룹 없는 것을 뒤로
  if (ga !== gb) return ga < gb ? -1 : 1;
  return (b.createdAt || 0) - (a.createdAt || 0);
}

/** videoPath 기준 중복 제거 — 같은 영상의 4/6-stem 중 대표 하나만 반환
 *  선택된 항목이 있으면 그것을 대표로, 없으면 최신 createdAt. */
function representativeItems() {
  const byVideo = new Map();
  for (const it of items) {
    const key = it.videoPath || it.id;
    const cur = byVideo.get(key);
    if (!cur) { byVideo.set(key, it); continue; }
    if (it.id === selectedId)  { byVideo.set(key, it); continue; }
    if (cur.id === selectedId) { continue; }
    if ((it.createdAt || 0) > (cur.createdAt || 0)) byVideo.set(key, it);
  }
  return [...byVideo.values()];
}

function renderList() {
  listEl.innerHTML = '';
  if (!items.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  // 검색 필터 + 정렬 모드 적용
  let filtered = representativeItems();
  if (_searchQuery) {
    filtered = filtered.filter(it =>
      (it.name || '').toLowerCase().includes(_searchQuery) ||
      (it.group || '').toLowerCase().includes(_searchQuery)
    );
  }
  const sortFn = ({
    group: groupSort,
    date:  (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    name:  (a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }),
  })[_sortMode] || groupSort;
  const sorted = filtered.sort(sortFn);
  const useGroupHeaders = _sortMode === 'group';

  let lastHeader = null;
  const addHeader = (label) => {
    if (lastHeader === label) return;
    lastHeader = label;
    const h = document.createElement('li');
    h.className = 'lib-group-head';
    h.textContent = label;
    listEl.appendChild(h);
  };

  const isEn = getLocale() === 'en';
  for (const it of sorted) {
    if (useGroupHeaders) {
      const header = it.favorite ? (isEn ? '★  Favorites' : '★  즐겨찾기') : (it.group ? it.group : (isEn ? 'Other' : '기타'));
      addHeader(header);
    }

    const li = document.createElement('li');
    li.className = 'lib-item' + (it.id === selectedId ? ' on' : '');
    li.dataset.id = it.id;
    li.innerHTML = `
      <div class="lib-item-row">
        <div class="lib-item-titles">
          <div class="lib-item-title"></div>
          <div class="lib-item-sub"></div>
        </div>
        <button class="lib-fav ${it.favorite ? 'on' : ''}" title="${isEn ? 'Favorite' : '즐겨찾기'}">${starSvg(!!it.favorite)}</button>
      </div>
    `;
    const titleEl = li.querySelector('.lib-item-title');
    const subEl   = li.querySelector('.lib-item-sub');
    titleEl.textContent = it.name;
    subEl.textContent = fmtDate(it.createdAt);

    // 클릭 시 선택 / 더블클릭 시 인라인 rename
    li.addEventListener('click', (e) => {
      // 별/이름 편집 중 클릭은 무시
      if (e.target.closest('.lib-fav')) return;
      if (e.target.closest('.lib-item-rename')) return;
      selectItem(it.id);
    });
    titleEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startInlineRename(li, it);
    });

    // 즐겨찾기 토글 (sibling 동기화)
    li.querySelector('.lib-fav').addEventListener('click', async (e) => {
      e.stopPropagation();
      const nowFav = !it.favorite;
      const res = await api.library.setFavorite(it.id, nowFav);
      if (res.ok) {
        syncSiblings(it.videoPath, { favorite: !!res.favorite });
        renderList();
      }
    });

    listEl.appendChild(li);
  }
}

function startInlineRename(li, item) {
  const titleEl = li.querySelector('.lib-item-title');
  const input = document.createElement('input');
  input.className = 'lib-item-rename';
  input.value = item.name;
  input.spellcheck = false;
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  const finish = async (save) => {
    const newName = input.value.trim();
    if (save && newName && newName !== item.name) {
      const res = await api.library.rename(item.id, newName);
      if (res.ok) {
        syncSiblings(item.videoPath, { name: newName });
        if (item.id === selectedId) playerName.value = newName;
      }
    }
    renderList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

async function selectItem(id) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  selectedId = id;
  renderList();
  await mountPlayer(it);
}

function destroyPlayer() {
  if (currentPlayer) { try { currentPlayer.destroy(); } catch {} currentPlayer = null; }
  mixerTracks.innerHTML = '';
  mixerTracks.classList.remove('has-solo');
}

async function mountPlayer(item) {
  const myMountId = ++_mountId;
  destroyPlayer();
  setErr('');
  playerEmpty.hidden = true;
  playerSection.hidden = false;
  playerLoading.hidden = false;

  _currentSongKey = songKeyOf(item);
  _restoringSettings = true;   // 아래 초기화들이 저장을 덮어쓰지 않도록 guard 켜기 — restoreSongSettings 에서 최종 해제

  playerName.value = item.name;
  playerProv.textContent = `SR ${item.sampleRate || 44100}`;

  try {
    const { stems, sampleRate } = await loadStemFilesToBuffers(item.stemPaths);
    // 사용자가 로드 중에 다른 곡을 선택했으면 이 mount는 중단 (이후 Player를 만들면 leak)
    if (myMountId !== _mountId) { _restoringSettings = false; return; }
    const videoUrl = toYtsepUrl(item.videoPath);
    // 각 stem의 ytsep URL — HTMLAudioElement로 스트리밍 (배속 시 피치 보존)
    const stemUrls = {};
    for (const [name, p] of Object.entries(item.stemPaths || {})) {
      stemUrls[name] = toYtsepUrl(p);
    }
    currentPlayer = new Player(playerVideo, videoUrl, stems, sampleRate, stemUrls);

    // 믹서 트랙
    for (const name of stemOrderFor(item.modelKey || '4stem')) {
      if (!stems[name]) continue;
      const meta = STEM_META[name];
      const iconUrl = stemIconFor(name, item.modelKey || '4stem');
      const row = document.createElement('div');
      row.className = 'mixer-track';
      row.dataset.stem = name;
      row.innerHTML = `
        <div class="mixer-track-name">
          <img class="mixer-track-icon" src="${iconUrl}" alt="" style="--stem-color:${meta.color}" />
          <span>${meta.label}</span>
        </div>
        <button class="mixer-solo" data-stem="${name}" title="Solo — 이 트랙만 재생">S</button>
        <button class="mixer-mute" data-stem="${name}" title="Mute">M</button>
        <input class="mixer-slider" type="range" min="0" max="150" value="100" data-stem="${name}" />
        <span class="mixer-val" data-val="${name}">100%</span>
      `;
      mixerTracks.appendChild(row);
    }
    mixerTracks.querySelectorAll('.mixer-slider').forEach(sl => {
      sl.addEventListener('input', () => {
        const stem = sl.dataset.stem;
        const v = Number(sl.value) / 100;
        currentPlayer.setStemVolume(stem, v);
        const valEl = mixerTracks.querySelector(`[data-val="${stem}"]`);
        if (valEl) valEl.textContent = sl.value + '%';
        saveTrackVol(stem, Number(sl.value));
      });
    });
    mixerTracks.querySelectorAll('.mixer-mute').forEach(btn => {
      btn.addEventListener('click', () => {
        const stem = btn.dataset.stem;
        const muted = currentPlayer.toggleMute(stem);
        btn.classList.toggle('on', muted);
        const row = mixerTracks.querySelector(`.mixer-track[data-stem="${stem}"]`);
        row?.classList.toggle('muted', muted);
        saveTrackMute(stem, muted);
      });
    });
    mixerTracks.querySelectorAll('.mixer-solo').forEach(btn => {
      btn.addEventListener('click', () => {
        const stem = btn.dataset.stem;
        const soloed = currentPlayer.toggleSolo(stem);
        btn.classList.toggle('on', soloed);
        const row = mixerTracks.querySelector(`.mixer-track[data-stem="${stem}"]`);
        row?.classList.toggle('soloed', soloed);
        mixerTracks.classList.toggle('has-solo', currentPlayer.isAnySolo());
        saveTrackSolo(stem, soloed);
      });
    });

    // master / source / speed / loop / key / group / reseparate 초기화
    masterVol.value = 100; masterVal.textContent = '100%';
    resetSourceToggle();
    resetSpeedUI();
    resetLoopUI();
    resetKeyUI();
    updateGroupPickerLabel();
    updateReseparateAndToggle(item);

    // 저장된 곡별 설정 복원
    await restoreSongSettings(item);
  } catch (e) {
    console.error(e);
    setErr('로드 실패: ' + e.message);
    _restoringSettings = false;   // 로드 실패 시 guard 해제 (안 그러면 다음부터 save 안 됨)
  } finally {
    playerLoading.hidden = true;
  }
}

async function restoreSongSettings(item) {
  const s = loadSongSettings(item);
  if (!s) { _restoringSettings = false; return; }
  try {
    // Master
    if (typeof s.masterVol === 'number') {
      masterVol.value = s.masterVol;
      masterVal.textContent = s.masterVol + '%';
      currentPlayer?.setMasterVolume(s.masterVol / 100);
    }
    // 트랙 볼륨
    if (s.trackVols) {
      for (const [stem, vol] of Object.entries(s.trackVols)) {
        const sl = mixerTracks.querySelector(`.mixer-slider[data-stem="${stem}"]`);
        const valEl = mixerTracks.querySelector(`[data-val="${stem}"]`);
        if (sl) sl.value = vol;
        if (valEl) valEl.textContent = vol + '%';
        currentPlayer?.setStemVolume(stem, Number(vol) / 100);
      }
    }
    // 트랙 뮤트
    if (s.trackMutes) {
      for (const [stem, muted] of Object.entries(s.trackMutes)) {
        if (!muted) continue;
        const nowMuted = currentPlayer?.toggleMute(stem);
        const btn = mixerTracks.querySelector(`.mixer-mute[data-stem="${stem}"]`);
        const row = mixerTracks.querySelector(`.mixer-track[data-stem="${stem}"]`);
        btn?.classList.toggle('on', !!nowMuted);
        row?.classList.toggle('muted', !!nowMuted);
      }
    }
    // 트랙 Solo
    if (s.trackSolos) {
      for (const [stem, soloed] of Object.entries(s.trackSolos)) {
        if (!soloed) continue;
        const nowSolo = currentPlayer?.toggleSolo(stem);
        const btn = mixerTracks.querySelector(`.mixer-solo[data-stem="${stem}"]`);
        const row = mixerTracks.querySelector(`.mixer-track[data-stem="${stem}"]`);
        btn?.classList.toggle('on', !!nowSolo);
        row?.classList.toggle('soloed', !!nowSolo);
      }
      mixerTracks.classList.toggle('has-solo', !!currentPlayer?.isAnySolo());
    }
    // Source
    if (s.source === 'orig' && srcToggle) {
      srcToggle.querySelectorAll('.source-btn').forEach(b => b.classList.toggle('on', b.dataset.src === 'orig'));
      currentPlayer?.setOriginalMix(1);
    }
    // Speed
    if (typeof s.speed === 'number' && s.speed !== 100) {
      applySpeed(s.speed);
    }
    // Loop
    if (s.loopA != null || s.loopB != null) {
      if (s.loopA != null) currentPlayer?.setLoopA(s.loopA);
      if (s.loopB != null) currentPlayer?.setLoopB(s.loopB);
      if (s.loopEnabled) currentPlayer?.setLoopEnabled(true);
      refreshLoopUI();
    }
    // Key shift (비동기 · 오래 걸림)
    if (typeof s.keyShift === 'number' && s.keyShift !== 0) {
      keyTarget = s.keyShift;
      updateKeyUI();
      const isEn = getLocale() === 'en';
      keyStatus.textContent = isEn ? 'Restoring key…' : '이전 키 복원 중…';
      keyProcessing = true;
      updateKeyUI();
      currentPlayer.setKeyShift(s.keyShift, ensureEncoderWorker())
        .then(() => { keyStatus.textContent = ''; })
        .catch(e => { keyStatus.textContent = (isEn ? 'Restore failed: ' : '복원 실패: ') + e.message; })
        .finally(() => { keyProcessing = false; updateKeyUI(); });
    }
  } finally {
    _restoringSettings = false;
  }
}

masterVol.addEventListener('input', () => {
  const v = Number(masterVol.value) / 100;
  masterVal.textContent = masterVol.value + '%';
  currentPlayer?.setMasterVolume(v);
  saveMaster(Number(masterVol.value));
});

// ── 재분리 (같은/다른 모델) + 모델 토글 ─────────────
const reseparateBtn      = $('player-reseparate');
const reseparateLabelEl  = $('player-reseparate-label');
const reseparateMenu     = $('reseparate-menu');
const modelToggle        = $('player-model-toggle');

function siblingItem(item) {
  if (!item?.videoPath) return null;
  const curKey = item.modelKey || '4stem';
  return items.find(x =>
    x.id !== item.id &&
    x.videoPath === item.videoPath &&
    (x.modelKey || '4stem') !== curKey
  );
}

function updateReseparateAndToggle(item) {
  const cur = item?.modelKey || '4stem';
  const sib = siblingItem(item);
  // 재분리 버튼은 항상 노출 (같은/다른 모델 선택 가능)
  if (sib) {
    // 두 모델 다 있음 → 토글 표시
    modelToggle.hidden = false;
    modelToggle.querySelectorAll('.model-tog-btn').forEach(b => b.classList.toggle('on', b.dataset.key === cur));
  } else {
    modelToggle.hidden = true;
  }
  reseparateBtn.hidden = false;
  if (reseparateLabelEl) {
    const isEn = getLocale() === 'en';
    reseparateLabelEl.textContent = isEn ? 'Reseparate' : '다시 분리';
  }
  reseparateBtn.dataset.targetModel = cur;   // 기본값 (메뉴에서 선택 가능)
}

modelToggle?.addEventListener('click', (e) => {
  const btn = e.target.closest('.model-tog-btn');
  if (!btn || btn.classList.contains('on')) return;
  const targetKey = btn.dataset.key;
  const it = currentItem();
  if (!it) return;
  const sib = siblingItem(it);
  if (sib && (sib.modelKey || '4stem') === targetKey) {
    selectItem(sib.id);
  }
});
function triggerReseparation(targetModel) {
  const it = currentItem();
  if (!it) return;
  const isEn = getLocale() === 'en';
  const label = targetModel === '6stem' ? '6-stem' : '4-stem';
  const msg = isEn
    ? `Reseparate this video with the ${label} model.\n\nThe "New" tab will be opened and prepared. Continue?`
    : `이 영상을 ${label} 모델로 다시 분리합니다.\n\n"새 분리" 탭으로 이동하고 준비 상태로 세팅됩니다. 계속할까요?`;
  if (!confirm(msg)) return;
  document.dispatchEvent(new CustomEvent('yss:preload-separation', {
    detail: {
      videoPath: it.videoPath,
      baseName: (it.videoPath || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, ''),
      probe: {
        id:        (it.meta && it.meta.id) || 'local-' + Math.random().toString(36).slice(2, 8),
        title:     it.name,
        uploader:  (it.meta && it.meta.uploader) || (isEn ? '(library reseparate)' : '(라이브러리 재분리)'),
        duration:  (it.meta && it.meta.duration) || 0,
        thumbnail: (it.meta && it.meta.thumbnail) || null,
      },
      modelKey: targetModel,
    },
  }));
}
reseparateBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!reseparateMenu) return;
  reseparateMenu.hidden = !reseparateMenu.hidden;
});
reseparateMenu?.addEventListener('click', (e) => {
  e.stopPropagation();
  const li = e.target.closest('li[data-model]');
  if (!li) return;
  reseparateMenu.hidden = true;
  triggerReseparation(li.dataset.model);
});
document.addEventListener('click', (e) => {
  if (!reseparateMenu || reseparateMenu.hidden) return;
  if (reseparateMenu.contains(e.target)) return;
  if (reseparateBtn?.contains(e.target)) return;
  reseparateMenu.hidden = true;
});

// ── A-B 구간 반복 ─────────────────────────────
const loopABtn    = $('loop-a-btn');
const loopBBtn    = $('loop-b-btn');
const loopAVal    = $('loop-a-val');
const loopBVal    = $('loop-b-val');
const loopToggle  = $('loop-toggle');
const loopReset   = $('loop-reset');

function fmtLoopTime(t) {
  if (t == null || isNaN(t)) return '—';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const c = Math.floor((t - Math.floor(t)) * 10);   // 소수점 1자리 (100ms 단위)
  return `${m}:${String(s).padStart(2, '0')}.${c}`;
}
function refreshLoopUI() {
  const st = currentPlayer?.getLoopState() || { a: null, b: null, enabled: false };
  loopAVal.textContent = fmtLoopTime(st.a);
  loopBVal.textContent = fmtLoopTime(st.b);
  loopToggle.classList.toggle('on', !!st.enabled);
  saveLoop(st.a, st.b, st.enabled);
}
function resetLoopUI() {
  currentPlayer?.resetLoop();
  refreshLoopUI();
}
loopABtn?.addEventListener('click', () => {
  if (!currentPlayer) return;
  currentPlayer.setLoopA(playerVideo.currentTime);
  refreshLoopUI();
});
loopBBtn?.addEventListener('click', () => {
  if (!currentPlayer) return;
  currentPlayer.setLoopB(playerVideo.currentTime);
  refreshLoopUI();
});
loopToggle?.addEventListener('click', () => {
  if (!currentPlayer) return;
  const st = currentPlayer.getLoopState();
  // 활성화하려면 A와 B가 모두 설정되고 B > A 여야 함
  if (!st.enabled && (st.a == null || st.b == null || st.b <= st.a)) {
    alert(getLocale() === 'en'
      ? 'Set both A and B first (B must be after A).'
      : 'A와 B 지점을 먼저 설정하세요 (B는 A보다 뒤).');
    return;
  }
  currentPlayer.setLoopEnabled(!st.enabled);
  refreshLoopUI();
});
loopReset?.addEventListener('click', () => {
  currentPlayer?.resetLoop();
  refreshLoopUI();
});

// ── 재생 속도 (5% 단위, 50% ~ 200%) ────────────────
const speedSlider = $('speed-slider');
const speedVal    = $('speed-val');
const speedDown   = $('speed-down');
const speedUp     = $('speed-up');
const speedReset  = $('speed-reset');

function applySpeed(pct) {
  pct = Math.max(50, Math.min(200, Math.round(pct / 5) * 5));   // 5% 스냅
  speedSlider.value = pct;
  speedVal.textContent = pct + '%';
  if (playerVideo) {
    // ratechange 이벤트 → Player가 stem audio들을 자동 sync
    playerVideo.playbackRate = pct / 100;
  }
  saveSpeed(pct);
}
function resetSpeedUI() { applySpeed(100); }
speedSlider?.addEventListener('input', () => applySpeed(Number(speedSlider.value)));
speedDown  ?.addEventListener('click', () => applySpeed(Number(speedSlider.value) - 5));
speedUp    ?.addEventListener('click', () => applySpeed(Number(speedSlider.value) + 5));
speedReset ?.addEventListener('click', () => applySpeed(100));

// ── 오디오 소스 토글 (스템 / 원본) ────────────────
const srcToggle = $('source-toggle');
srcToggle?.addEventListener('click', (e) => {
  const btn = e.target.closest('.source-btn');
  if (!btn || btn.classList.contains('on')) return;
  srcToggle.querySelectorAll('.source-btn').forEach(b => b.classList.toggle('on', b === btn));
  const isOrig = btn.dataset.src === 'orig';
  currentPlayer?.setOriginalMix(isOrig ? 1 : 0);
  saveSource(isOrig ? 'orig' : 'stem');
});
function resetSourceToggle() {
  srcToggle?.querySelectorAll('.source-btn').forEach(b => b.classList.toggle('on', b.dataset.src === 'stem'));
}

// ── 키 변경: 타겟 설정 → 적용 버튼 ──────────────────
const keyDown    = $('key-down');
const keyUp      = $('key-up');
const keyTargetEl = $('key-target');
const keyApply   = $('key-apply');
const keyStatus  = $('key-status');
let encoderWorker = null;
let keyProcessing = false;
let keyTarget = 0;
function ensureEncoderWorker() {
  if (encoderWorker) return encoderWorker;
  encoderWorker = new Worker(new URL('../workers/encoder-worker.js', import.meta.url), { type: 'module' });
  return encoderWorker;
}
function fmtKey(n) { return (n > 0 ? '+' : '') + n; }
function updateKeyUI() {
  const cur = currentPlayer?._currentKey ?? 0;
  keyTargetEl.textContent = fmtKey(keyTarget);
  keyDown.disabled = keyProcessing || keyTarget <= -6;
  keyUp.disabled   = keyProcessing || keyTarget >=  6;
  keyApply.disabled = keyProcessing || keyTarget === cur;
  const isEn = getLocale() === 'en';
  keyApply.textContent = keyTarget === cur ? (isEn ? 'Applied' : '적용됨') : (isEn ? 'Apply' : '적용');
  const failPrefix = isEn ? 'Failed' : '실패';
  if (!keyProcessing && !keyStatus.textContent.startsWith(failPrefix)) {
    keyStatus.textContent = cur !== 0 ? (isEn ? `Now ${fmtKey(cur)}` : `현재 ${fmtKey(cur)}`) : '';
  }
}
keyDown?.addEventListener('click', () => { keyTarget = Math.max(-6, keyTarget - 1); updateKeyUI(); });
keyUp  ?.addEventListener('click', () => { keyTarget = Math.min( 6, keyTarget + 1); updateKeyUI(); });
keyApply?.addEventListener('click', async () => {
  if (!currentPlayer || keyProcessing) return;
  if (keyTarget === currentPlayer._currentKey) return;
  keyProcessing = true;
  updateKeyUI();
  const isEn = getLocale() === 'en';
  keyStatus.textContent = isEn ? 'Processing…' : '처리 중…';
  try {
    await currentPlayer.setKeyShift(keyTarget, ensureEncoderWorker());
    keyStatus.textContent = '';
    saveKey(keyTarget);
  } catch (e) {
    keyStatus.textContent = (isEn ? 'Failed: ' : '실패: ') + e.message;
  } finally {
    keyProcessing = false;
    updateKeyUI();
  }
});
function resetKeyUI() {
  keyTarget = currentPlayer?._currentKey ?? 0;
  updateKeyUI();
}

// ── 그룹 지정 (플레이어 헤더) ──────────────────────
const groupBtn    = $('group-picker-btn');
const groupMenu   = $('group-picker-menu');
const groupVal    = $('group-picker-val');

function collectGroups() {
  const set = new Set();
  for (const it of items) if (it.group) set.add(it.group);
  return [...set].sort();
}
function currentItem() {
  return items.find(x => x.id === selectedId) || null;
}
function renderGroupMenu() {
  const groups = collectGroups();
  const cur = currentItem()?.group || '';
  groupMenu.innerHTML = '';
  const isEn = getLocale() === 'en';
  const mkItem = (label, value, isDivider, isNew) => {
    const li = document.createElement('li');
    if (isDivider) li.className = 'divider';
    else if (isNew) li.className = 'group-new';
    if (!isDivider && value === cur) li.classList.add('on');
    li.textContent = label;
    if (!isDivider) li.addEventListener('click', (e) => {
      e.stopPropagation();
      if (value === '__new__') showNewGroupInput();
      else handleGroupPick(value);
    });
    groupMenu.appendChild(li);
  };
  const mkGroupItem = (name) => {
    const li = document.createElement('li');
    li.className = 'group-item';
    if (name === cur) li.classList.add('on');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'group-name';
    nameSpan.textContent = name;
    const delBtn = document.createElement('button');
    delBtn.className = 'group-del';
    delBtn.type = 'button';
    delBtn.textContent = '×';
    delBtn.title = isEn ? 'Delete this group' : '이 그룹 삭제';
    li.appendChild(nameSpan);
    li.appendChild(delBtn);
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      handleGroupPick(name);
    });
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handleGroupDelete(name);
    });
    groupMenu.appendChild(li);
  };
  mkItem(isEn ? '(No group)' : '(그룹 없음)', '');
  if (groups.length) {
    mkItem(isEn ? 'Existing groups' : '기존 그룹', null, true);
    for (const g of groups) mkGroupItem(g);
  }
  mkItem(isEn ? 'New' : '신규', null, true);
  mkItem(isEn ? '+ Create new group…' : '+ 새 그룹 만들기…', '__new__', false, true);
}

async function handleGroupDelete(groupName) {
  if (!groupName) return;
  const isEn = getLocale() === 'en';
  const affected = items.filter(x => x.group === groupName);
  const count = new Set(affected.map(x => x.videoPath)).size;   // 4/6-stem sibling 중복 제거
  const msg = isEn
    ? `Delete the group "${groupName}"?\n${count} item(s) will be moved to "No group".`
    : `"${groupName}" 그룹을 삭제할까요?\n이 그룹에 속한 ${count}개 항목이 "그룹 없음"으로 이동합니다.`;
  if (!confirm(msg)) return;

  // 각 아이템(중복 videoPath 포함)에서 그룹 제거. syncSiblings 로 4/6-stem 동시 반영.
  const processed = new Set();
  for (const it of affected) {
    if (processed.has(it.videoPath)) continue;
    processed.add(it.videoPath);
    const res = await api.library.setGroup(it.id, '');
    if (res.ok) syncSiblings(it.videoPath, { group: null });
  }
  updateGroupPickerLabel();
  renderList();
  renderGroupMenu();   // 메뉴가 열린 상태면 즉시 갱신
}

function showNewGroupInput() {
  groupMenu.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'group-input-row';
  li.innerHTML = `<input class="group-input" placeholder="${getLocale() === 'en' ? 'Group name' : '그룹 이름'}" maxlength="80" />`;
  li.addEventListener('click', (e) => e.stopPropagation());
  groupMenu.appendChild(li);
  const input = li.querySelector('input');
  input.focus();
  const commit = async () => {
    const name = input.value.trim();
    if (!name) { groupMenu.hidden = true; return; }
    await handleGroupPick(name);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { groupMenu.hidden = true; }
  });
  input.addEventListener('blur', () => {
    // 클릭 취소 등으로 loose focus 시 무효 처리
    setTimeout(() => { if (!groupMenu.hidden) groupMenu.hidden = true; }, 120);
  });
}

function syncSiblings(videoPath, patch) {
  for (const x of items) {
    if (x.videoPath !== videoPath) continue;
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined || v === '') delete x[k];
      else x[k] = v;
    }
  }
}

async function handleGroupPick(value) {
  groupMenu.hidden = true;
  const it = currentItem();
  if (!it) return;
  const group = String(value || '').trim();
  const res = await api.library.setGroup(it.id, group);
  if (res.ok) {
    syncSiblings(it.videoPath, { group: group || null });
    updateGroupPickerLabel();
    renderList();
  }
}
function updateGroupPickerLabel() {
  const it = currentItem();
  groupVal.textContent = it?.group || t('player.group.none');
}
// ── 저장 (개별 스템 · 믹스 · 폴더 열기) ─────────────
const downloadBtn  = $('player-download-btn');
const downloadMenu = $('download-menu');

function sanitizeFileName(s) {
  return String(s || 'export').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim().slice(0, 80) || 'export';
}

async function handleDownload(action) {
  const it = currentItem();
  if (!it || !currentPlayer) return;
  const baseName = sanitizeFileName(it.name);

  if (action === 'folder') {
    if (it.outDir) await api.openPath(it.outDir);
    return;
  }

  if (action === 'stems') {
    const isEn = getLocale() === 'en';
    const res = await api.dialog.pickFolder(isEn ? 'Choose folder for individual stems' : '개별 스템 저장 폴더 선택');
    if (!res.ok) return;
    const dir = res.dir;
    const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
    let ok = 0, fail = 0;
    for (const [name, src] of Object.entries(it.stemPaths || {})) {
      const dst = `${dir}${sep}${baseName}_${name}.wav`;
      const r = await api.fs.copyFile(src, dst);
      if (r.ok) ok++; else fail++;
    }
    alert(isEn
      ? `Stems saved — ${ok} succeeded${fail ? `, ${fail} failed` : ''}`
      : `스템 저장 완료 — 성공 ${ok}개${fail ? `, 실패 ${fail}개` : ''}`);
    return;
  }

  if (action === 'mix') {
    const res = await api.dialog.saveAs(`${baseName}_mix.wav`, ['wav']);
    if (!res.ok) return;
    const savePath = res.filePath;

    // encoder-worker 재사용
    const w = ensureEncoderWorker();
    const { stems, sampleRate } = currentPlayer.getStemsForExport();
    const weights = currentPlayer.getCurrentWeights();

    const isEn = getLocale() === 'en';
    downloadBtn.disabled = true;
    downloadBtn.querySelector('span').textContent = isEn ? 'Mixing…' : '믹싱 중…';
    try {
      const wavBuf = await new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2);
        const onMsg = (e) => {
          if (e.data?.id !== id) return;
          w.removeEventListener('message', onMsg);
          if (e.data.error) reject(new Error(e.data.error));
          else if (e.data.data) resolve(e.data.data);
          else reject(new Error('unexpected response'));
        };
        w.addEventListener('message', onMsg);
        const transferables = [];
        const stemsForWorker = {};
        for (const [n, [L, R]] of Object.entries(stems)) {
          const Lc = new Float32Array(L);
          const Rc = new Float32Array(R);
          stemsForWorker[n] = [Lc, Rc];
          transferables.push(Lc.buffer, Rc.buffer);
        }
        w.postMessage({ type: 'mixAndEncode', id, stems: stemsForWorker, weights, sampleRate }, transferables);
      });
      const bytes = new Uint8Array(wavBuf);
      const saveRes = await api.fs.writeBuffer(savePath, bytes);
      if (!saveRes.ok) throw new Error(saveRes.error);
      alert(isEn ? `Mix saved\n${savePath}` : `믹스 저장 완료\n${savePath}`);
    } catch (e) {
      alert(isEn ? `Mix failed: ${e.message}` : `믹스 실패: ${e.message}`);
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.querySelector('span').textContent = t('player.save');
    }
    return;
  }
}

downloadBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  downloadMenu.hidden = !downloadMenu.hidden;
});
downloadMenu?.addEventListener('click', (e) => {
  e.stopPropagation();
  const li = e.target.closest('li');
  if (!li || li.classList.contains('divider')) return;
  downloadMenu.hidden = true;
  handleDownload(li.dataset.action);
});
document.addEventListener('click', (e) => {
  if (!downloadMenu) return;
  if (downloadMenu.contains(e.target)) return;
  if (downloadBtn?.contains(e.target)) return;
  downloadMenu.hidden = true;
});

groupBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!groupMenu.hidden) { groupMenu.hidden = true; return; }
  renderGroupMenu();
  groupMenu.hidden = false;
});
document.addEventListener('click', (e) => {
  if (!groupMenu) return;
  if (groupMenu.contains(e.target)) return;
  if (groupBtn?.contains(e.target)) return;
  groupMenu.hidden = true;
});


// 이름 변경 (sibling 동기화)
async function commitRename() {
  if (!selectedId) return;
  const name = playerName.value.trim() || 'Untitled';
  const item = items.find(x => x.id === selectedId);
  if (item && item.name === name) return;
  const res = await api.library.rename(selectedId, name);
  if (res.ok && item) {
    syncSiblings(item.videoPath, { name });
    renderList();
  }
}
playerName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); playerName.blur(); }
  if (e.key === 'Escape') {
    const item = items.find(x => x.id === selectedId);
    if (item) playerName.value = item.name;
    playerName.blur();
  }
});
playerName.addEventListener('blur', commitRename);

// 삭제
playerDel.addEventListener('click', async () => {
  if (!selectedId) return;
  const item = items.find(x => x.id === selectedId);
  if (!item) return;
  const isEn = getLocale() === 'en';
  const yes = confirm(isEn
    ? `Remove "${item.name}" from the library?\n\nOriginal files (video, stem wavs) are deleted too.`
    : `"${item.name}" 을(를) 라이브러리에서 제거하시겠습니까?\n\n원본 파일(영상, 스템 wav)도 함께 삭제됩니다.`);
  if (!yes) return;
  await api.library.remove(selectedId, true);
  // 형제(4/6-stem sibling)가 없으면 이 videoPath의 저장 설정도 제거
  const sib = siblingItem(item);
  if (!sib) {
    const k = songKeyOf(item);
    if (k) { try { localStorage.removeItem(k); } catch {} }
  }
  destroyPlayer();
  playerSection.hidden = true;
  playerEmpty.hidden = false;
  selectedId = null;
  await refresh();
});

refreshBtn.addEventListener('click', refresh);

const cleanupBtn = $('lib-cleanup');
cleanupBtn?.addEventListener('click', async () => {
  // Step 1: 라이브러리 중복만 정리 (안전)
  const dupRes = await api.library.cleanup();
  // Step 2: disk의 orphan 파일 미리보기 (삭제는 개별 승인)
  const preview = await api.library.previewOrphans();

  const isEn = getLocale() === 'en';
  const dupMsg = dupRes.removed > 0
    ? (isEn
        ? `Merged ${dupRes.removed} duplicate(s) · deleted ${dupRes.removedFiles} file(s) (${(dupRes.freedBytes/1024/1024).toFixed(1)} MB)`
        : `라이브러리 중복 ${dupRes.removed}개 통합 · 파일 ${dupRes.removedFiles}개 삭제 (${(dupRes.freedBytes/1024/1024).toFixed(1)} MB)`)
    : (isEn ? 'No library duplicates' : '라이브러리에 중복 없음');

  const orphans = [...(preview.videos || []), ...(preview.stems || [])];
  if (orphans.length === 0) {
    await refresh();
    alert(`${dupMsg}\n\n${isEn ? 'No orphan files — all clean.' : '라이브러리에 없는 파일 없음 — 깨끗함.'}`);
    return;
  }

  const totalMb = (orphans.reduce((s, x) => s + x.size, 0) / 1024 / 1024).toFixed(1);
  const list = orphans.slice(0, 30).map(x => `  · ${x.path.split(/[\\/]/).pop()}  (${(x.size/1024/1024).toFixed(1)} MB)`).join('\n');
  const suffix = orphans.length > 30 ? (isEn ? `\n  ... and ${orphans.length - 30} more` : `\n  ... 외 ${orphans.length - 30}개`) : '';
  const msg = isEn
    ? `${dupMsg}\n\n${orphans.length} orphan file(s) (${totalMb} MB reclaimable):\n${list}${suffix}\n\nDelete all of these?\n(Files currently in the library will never be deleted)`
    : `${dupMsg}\n\n라이브러리에 등록되지 않은 파일 ${orphans.length}개 (${totalMb} MB 확보 가능):\n${list}${suffix}\n\n이 파일들을 모두 삭제할까요?\n(현재 라이브러리에 있는 파일은 절대 삭제되지 않습니다)`;

  if (!confirm(msg)) {
    await refresh();
    return;
  }
  let ok = 0, freed = 0;
  for (const o of orphans) {
    const r = await api.library.deleteOrphan(o.path);
    if (r.ok) { ok++; freed += r.freedBytes; }
  }
  await refresh();
  alert(isEn
    ? `Cleanup complete: ${ok} file(s), ${(freed/1024/1024).toFixed(1)} MB reclaimed`
    : `추가 정리 완료: ${ok}개 파일, ${(freed/1024/1024).toFixed(1)} MB 확보`);
});

export const Library = {
  refresh,
  selectItem,
};

// 뷰 첫 진입 시 자동 로드
document.addEventListener('DOMContentLoaded', () => { refresh(); });
