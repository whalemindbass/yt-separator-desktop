'use strict';
// Library view — 좌측 리스트 + 우측 플레이어

import { Player, STEM_META, stemOrderFor, stemIconFor, loadStemFilesToBuffers, toYtsepUrl } from './player.js';
import { t, getLocale } from './i18n.js';
import { detectBeats } from './beat-detect.js';
import { FADER_POS, FADER_UNITY_POS, pctToFader, faderToPct, dbText } from './fader.js';
import { TabView, transcribeBass, toMono } from './tabview.js';
import { buildScore, beatAccents } from '../workers/tab-score.js';

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
const playerLoading = $('player-loading-overlay');   // 스템 로드 중 영상 위 오버레이 (클릭 차단)
const playerErr     = $('player-err');
const mixerTracks   = $('mixer-tracks');
const masterVol     = $('master-vol');
const masterVal     = $('master-val');
const metroToggleEl = $('metro-toggle');
const metroBpmEl    = $('metro-bpm');
const metroVolEl    = $('metro-vol');
const metroHalfEl   = $('metro-half');
const metroDoubleEl = $('metro-double');
const countInToggleEl = $('countin-toggle');
const countInOverlay  = $('countin-overlay');
const countInNumberEl = $('countin-number');

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
const saveMetro     = (patch)     => _mutateSettings(s => { s.metro = { ...(s.metro || {}), ...patch }; });
const saveCountIn   = (patch)     => _mutateSettings(s => { s.countIn = { ...(s.countIn || {}), ...patch }; });
const saveTrim      = (patch)     => _mutateSettings(s => { s.trim = { ...(s.trim || {}), ...patch }; });
const saveCheckpoints = (list)    => _mutateSettings(s => { s.checkpoints = list; });
const saveBeatCache = (tempo, beats, beatInterval, downbeat, fitStdMs, audioStart) => _mutateSettings(s => {
  s.beatCache = { tempo, beats, beatInterval, downbeat, fitStdMs, audioStart, at: Date.now() };
});

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

  const isEn = getLocale() === 'en';
  let lastHeader = null;
  const addHeader = (label, groupName) => {
    if (lastHeader === label) return;
    lastHeader = label;
    const h = document.createElement('li');
    h.className = 'lib-group-head' + (groupName ? ' renamable' : '');
    h.textContent = label;
    if (groupName) {
      h.title = isEn ? 'Click to rename group' : '클릭하여 그룹 이름 변경';
      h.addEventListener('click', (e) => { e.stopPropagation(); startGroupRename(h, groupName); });
    }
    listEl.appendChild(h);
  };

  for (const it of sorted) {
    if (useGroupHeaders) {
      const isRealGroup = !it.favorite && !!it.group;
      const header = it.favorite ? (isEn ? '★  Favorites' : '★  즐겨찾기') : (it.group ? it.group : (isEn ? 'Other' : '기타'));
      addHeader(header, isRealGroup ? it.group : null);
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

// 그룹 헤더 클릭 → 인라인으로 그룹 이름 변경 (해당 그룹의 모든 항목에 반영)
function startGroupRename(headEl, groupName) {
  const input = document.createElement('input');
  input.className = 'lib-group-rename';
  input.value = groupName;
  input.spellcheck = false;
  headEl.textContent = '';
  headEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const newName = input.value.trim();
    if (save && newName && newName !== groupName) {
      // 같은 그룹의 모든 항목(4/6-stem sibling 포함) 이름 변경. 기존 그룹명과 겹치면 자연스럽게 병합됨.
      const affected = items.filter(x => x.group === groupName);
      for (const it of affected) {
        const res = await api.library.setGroup(it.id, newName);
        if (res.ok) syncSiblings(it.videoPath, { group: newName });
      }
      updateGroupPickerLabel();
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
  // 메트로놈 · 카운트인 UI 리셋
  if (metroToggleEl) metroToggleEl.classList.remove('on');
  if (metroBpmEl) { metroBpmEl.textContent = '—'; metroBpmEl.classList.remove('detected'); }
  if (metroHalfEl)   metroHalfEl.hidden = true;
  if (metroDoubleEl) metroDoubleEl.hidden = true;
  if (countInToggleEl) countInToggleEl.classList.remove('on');
  if (countInOverlay)  countInOverlay.hidden = true;
  // 트림 리셋 (새 곡 로드 시 복원 전 기본값)
  _trimStart = 0; _trimEnd = null;
  // 파형 초기화
  _wavePeaks = null;
  if (vcWaveform) { const c = vcWaveform.getContext('2d'); c && c.clearRect(0, 0, vcWaveform.width, vcWaveform.height); }
  updateTrimUI();
}

// ── 메트로놈 (곡 sync 자동) ───────────────────────
// BPM 표시 갱신 + octave 버튼 노출
function updateBpmDisplay() {
  if (!metroBpmEl) return;
  const info = currentPlayer?.getMetronomeInfo?.();
  const tempo = info?.tempo || 0;
  const has = tempo > 0;
  metroBpmEl.textContent = has ? `${Math.round(tempo)} BPM` : '—';
  metroBpmEl.classList.toggle('detected', has);
  if (metroHalfEl)   metroHalfEl.hidden   = !has;
  if (metroDoubleEl) metroDoubleEl.hidden = !has;
}

async function prepareMetronome(item, stems, sampleRate) {
  if (!currentPlayer || !metroBpmEl) return;
  const settings = loadSongSettings(item) || {};
  const cached = settings.beatCache;
  const wantEnabled = !!(settings.metro && settings.metro.enabled);
  const manualBpm = (settings.metro && typeof settings.metro.manualBpm === 'number') ? settings.metro.manualBpm : null;
  // 볼륨: 저장값이 없으면 슬라이더 현재값 (default 60) 을 Player 로 sync
  if (!(settings.metro && typeof settings.metro.volume === 'number') && metroVolEl) {
    currentPlayer.setMetronomeVolume(Number(metroVolEl.value) / 100);
  }

  // 캐시된 beats 우선 사용 — audioStart 필드까지 있어야 v3 캐시 (시작점 감지 포함)
  const cacheValid = cached && Array.isArray(cached.beats) && cached.beats.length > 0
                     && typeof cached.downbeat === 'number'
                     && 'audioStart' in cached;
  if (cacheValid) {
    currentPlayer.setBeats(cached.beats, cached.beatInterval, cached.tempo, cached.downbeat, cached.audioStart);
    if (manualBpm) currentPlayer.setManualTempo(manualBpm);   // 사용자 보정 우선
    updateBpmDisplay();
    if (wantEnabled) {
      currentPlayer.setMetronomeEnabled(true);
      metroToggleEl?.classList.add('on');
    }
    return;
  }
  // 없으면 drums 스템에서 백그라운드 감지
  const drums = stems?.drums;
  if (!drums || !drums[0] || !drums[1]) {
    // 감지 불가여도 수동 BPM 있으면 반영
    if (manualBpm) { currentPlayer.setManualTempo(manualBpm); updateBpmDisplay(); }
    else { metroBpmEl.textContent = '—'; metroBpmEl.classList.remove('detected'); }
    return;
  }
  // fallback: 모든 스템 합쳐 재시도용 mix 생성
  let fbL = null, fbR = null;
  for (const arr of Object.values(stems)) {
    if (!arr || !arr[0] || !arr[1]) continue;
    if (!fbL) { fbL = new Float32Array(arr[0]); fbR = new Float32Array(arr[1]); continue; }
    const n = Math.min(fbL.length, arr[0].length);
    for (let i = 0; i < n; i++) { fbL[i] += arr[0][i]; fbR[i] += arr[1][i]; }
  }
  metroBpmEl.textContent = '분석 중…';
  metroBpmEl.classList.remove('detected');
  try {
    const cur = item;
    const res = await detectBeats(drums[0], drums[1], sampleRate, fbL ? [fbL, fbR] : null);
    // 완료 시점 다른 곡이면 캐시만 저장 · 현재 세션에 반영 X
    if (currentItem()?.id !== cur.id) {
      const oldKey = songKeyOf(cur);
      if (oldKey) {
        try {
          const raw = localStorage.getItem(oldKey);
          const s = raw ? JSON.parse(raw) : {};
          s.beatCache = { tempo: res.tempo, beats: res.beats, beatInterval: res.beatInterval, downbeat: res.downbeat, fitStdMs: res.fitStdMs, audioStart: res.audioStart, at: Date.now() };
          localStorage.setItem(oldKey, JSON.stringify(s));
        } catch {}
      }
      return;
    }
    saveBeatCache(res.tempo, res.beats, res.beatInterval, res.downbeat, res.fitStdMs, res.audioStart);
    currentPlayer.setBeats(res.beats, res.beatInterval, res.tempo, res.downbeat, res.audioStart);
    if (manualBpm) currentPlayer.setManualTempo(manualBpm);
    updateBpmDisplay();
    if (wantEnabled) {
      currentPlayer.setMetronomeEnabled(true);
      metroToggleEl?.classList.add('on');
    }
  } catch (e) {
    console.warn('[beat-detect]', e);
    // 감지 실패해도 수동 입력 가능하도록 클릭 가능한 상태 유지
    if (manualBpm) { currentPlayer.setManualTempo(manualBpm); updateBpmDisplay(); }
    else metroBpmEl.textContent = '감지 실패';
  }
}

// ── BPM 직접 편집 · octave 교정 ──────────────────
function commitManualBpm(bpm) {
  if (!currentPlayer) return;
  const applied = currentPlayer.setManualTempo(bpm);
  saveMetro({ manualBpm: applied });
  updateBpmDisplay();
}
metroBpmEl?.addEventListener('click', () => {
  if (!currentPlayer) return;
  const info = currentPlayer.getMetronomeInfo();
  const cur = Math.round(info.tempo || 120);
  // input 으로 교체
  const input = document.createElement('input');
  input.type = 'number'; input.min = '40'; input.max = '300';
  input.value = String(cur);
  input.className = 'metro-bpm-input';
  metroBpmEl.replaceWith(input);
  input.focus(); input.select();
  const finish = (save) => {
    input.replaceWith(metroBpmEl);
    if (save) {
      const v = parseInt(input.value, 10);
      if (v >= 40 && v <= 300) commitManualBpm(v);
    }
    updateBpmDisplay();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
});
metroHalfEl?.addEventListener('click', () => {
  if (!currentPlayer) return;
  commitManualBpm(currentPlayer.getMetronomeInfo().tempo / 2);
});
metroDoubleEl?.addEventListener('click', () => {
  if (!currentPlayer) return;
  commitManualBpm(currentPlayer.getMetronomeInfo().tempo * 2);
});

metroToggleEl?.addEventListener('click', () => {
  if (!currentPlayer) return;
  const info = currentPlayer.getMetronomeInfo();
  if (!info.hasBeats) return;   // 아직 분석 중이거나 실패
  const next = !info.enabled;
  currentPlayer.setMetronomeEnabled(next);
  metroToggleEl.classList.toggle('on', next);
  saveMetro({ enabled: next });
});

metroVolEl?.addEventListener('input', () => {
  const v = Number(metroVolEl.value);
  currentPlayer?.setMetronomeVolume(v / 100);
  saveMetro({ volume: v });
});

countInToggleEl?.addEventListener('click', () => {
  if (!currentPlayer) return;
  const info = currentPlayer.getCountInInfo();
  const next = !info.enabled;
  currentPlayer.setCountInEnabled(next);
  countInToggleEl.classList.toggle('on', next);
  saveCountIn({ enabled: next, beats: 4 });
});

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

    // 베이스 TAB — 곡이 바뀌면 이전 결과를 비우고, 이번 곡의 베이스 스템을 쥐고 있는다
    setTabSource(stems, sampleRate);

    // 파형 peaks 계산 (스템 합산 진폭)
    computeWavePeaks(stems);
    drawWaveform();

    // 카운트인 오버레이 콜백
    currentPlayer.setCountInCallback((remaining, _total) => {
      updateVcPlayIcon();   // 카운트인 시작·종료 시 재생 아이콘 반영
      if (!countInOverlay || !countInNumberEl) return;
      if (remaining <= 0) {
        countInOverlay.hidden = true;
      } else {
        countInNumberEl.textContent = String(remaining);
        countInOverlay.hidden = false;
        // pop 애니메이션 재트리거를 위해 CSS 클래스 리셋
        countInNumberEl.style.animation = 'none';
        // eslint-disable-next-line no-unused-expressions
        countInNumberEl.offsetHeight;
        countInNumberEl.style.animation = '';
      }
    });

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
        <input class="mixer-slider" type="range" min="0" max="${FADER_POS}" value="${FADER_UNITY_POS}" data-stem="${name}" />
        <span class="mixer-val" data-val="${name}">100%</span>
      `;
      mixerTracks.appendChild(row);
    }
    mixerTracks.querySelectorAll('.mixer-slider').forEach(sl => {
      // pos = 슬라이더 위치, pct = 저장·표시용 퍼센트 (설정 파일 호환을 위해 퍼센트로 남긴다)
      const applyVol = (pos) => {
        const stem = sl.dataset.stem;
        const pct = faderToPct(pos);
        sl.value = pos;
        currentPlayer.setStemVolume(stem, pct / 100);
        const valEl = mixerTracks.querySelector(`[data-val="${stem}"]`);
        if (valEl) valEl.textContent = dbText(pct / 100);
        saveTrackVol(stem, pct);
      };
      sl.addEventListener('input', () => applyVol(Number(sl.value)));
      // 더블클릭 → 기본값(100%) 리셋
      sl.addEventListener('dblclick', () => applyVol(FADER_UNITY_POS));
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
    masterVol.value = FADER_UNITY_POS; masterVal.textContent = dbText(1);
    resetSourceToggle();
    resetSpeedUI();
    resetLoopUI();
    resetKeyUI();
    updateGroupPickerLabel();
    updateReseparateAndToggle(item);
    _checkpoints = []; renderCheckpoints();

    // 저장된 곡별 설정 복원
    await restoreSongSettings(item);

    // 메트로놈: 캐시된 beats 있으면 즉시 세팅, 없으면 백그라운드로 감지 후 저장
    prepareMetronome(item, stems, sampleRate);
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
      masterVol.value = pctToFader(s.masterVol);
      masterVal.textContent = dbText(Number(s.masterVol) / 100);
      currentPlayer?.setMasterVolume(s.masterVol / 100);
    }
    // 트랙 볼륨
    if (s.trackVols) {
      for (const [stem, vol] of Object.entries(s.trackVols)) {
        const sl = mixerTracks.querySelector(`.mixer-slider[data-stem="${stem}"]`);
        const valEl = mixerTracks.querySelector(`[data-val="${stem}"]`);
        if (sl) sl.value = pctToFader(vol);
        if (valEl) valEl.textContent = dbText(Number(vol) / 100);
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
    // 메트로놈 볼륨·활성 상태 (beats 는 prepareMetronome 에서 별도 세팅)
    if (s.metro) {
      if (typeof s.metro.volume === 'number') {
        currentPlayer?.setMetronomeVolume(s.metro.volume / 100);
        if (metroVolEl) metroVolEl.value = s.metro.volume;
      }
    }
    // 카운트인 (곡별 상태 · 즉시 반영 가능)
    if (s.countIn) {
      if (typeof s.countIn.beats === 'number') currentPlayer?.setCountInBeats(s.countIn.beats);
      if (s.countIn.enabled) {
        currentPlayer?.setCountInEnabled(true);
        countInToggleEl?.classList.add('on');
      }
    }
    // 트림 (재생 범위)
    if (s.trim) {
      _trimStart = (typeof s.trim.start === 'number') ? s.trim.start : 0;
      _trimEnd   = (typeof s.trim.end === 'number') ? s.trim.end : null;
      currentPlayer?.setTrimStart(_trimStart);
      currentPlayer?.setTrimEnd(_trimEnd);
      updateTrimUI();
    }
    // 체크포인트
    if (Array.isArray(s.checkpoints)) {
      _checkpoints = s.checkpoints
        .filter(cp => cp && typeof cp.t === 'number')
        .map(cp => ({ t: cp.t, name: String(cp.name || fmtVcTime(cp.t)) }))
        .sort((a, b) => a.t - b.t);
      renderCheckpoints();
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

function applyMasterVol(pos) {
  const pct = faderToPct(pos);
  masterVol.value = pos;
  masterVal.textContent = dbText(pct / 100);
  currentPlayer?.setMasterVolume(pct / 100);
  saveMaster(pct);
}
masterVol.addEventListener('input', () => applyMasterVol(Number(masterVol.value)));
masterVol.addEventListener('dblclick', () => applyMasterVol(FADER_UNITY_POS));

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
  pct = Math.max(10, Math.min(200, Math.round(pct / 5) * 5));   // 5% 스냅, 10%~200%
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

// ── 커스텀 비디오 컨트롤 바 ──────────────────────
const vcRestart    = $('vc-restart');
const vcPlay       = $('vc-play');
const vcTime       = $('vc-time');
const vcSeek       = $('vc-seek');
const vcDuration   = $('vc-duration');
const vcFullscreen = $('vc-fullscreen');
const vcPlayIco    = vcPlay?.querySelector('.ico-play');
const vcPauseIco   = vcPlay?.querySelector('.ico-pause');
const vcTrimStart  = $('vc-trim-start');
const vcTrimEnd    = $('vc-trim-end');
const vcTrimReset  = $('vc-trim-reset');
const vcWaveform   = $('vc-waveform');

// ── 체크포인트 (곡별 저장, 영상 우측 패널) ──────────
const cpBtn      = $('vc-checkpoints');
const cpPanel    = $('checkpoint-panel');
const cpClose    = $('cp-close');
const cpListEl   = $('cp-list');
const cpEmptyEl  = $('cp-empty');
const cpAddTime  = $('cp-add-time');
const cpAddName  = $('cp-add-name');
const cpAddBtn   = $('cp-add-btn');
let _checkpoints = [];   // [{ t:number, name:string }] — t 오름차순 유지

function renderCheckpoints() {
  if (!cpListEl) return;
  cpListEl.innerHTML = '';
  if (cpEmptyEl) cpEmptyEl.hidden = _checkpoints.length > 0;
  const isEn = getLocale() === 'en';
  _checkpoints.forEach((cp, i) => {
    const li = document.createElement('li');
    li.className = 'cp-item';
    li.innerHTML = `<span class="cp-time"></span><span class="cp-name"></span>`
      + `<button class="cp-del" title="${isEn ? 'Delete' : '삭제'}">✕</button>`;
    li.querySelector('.cp-time').textContent = fmtVcTime(cp.t);
    li.querySelector('.cp-name').textContent = cp.name;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.cp-del')) return;
      playerVideo.currentTime = cp.t;
      updateVcProgress();
      showControlsTemporarily();
    });
    li.querySelector('.cp-del').addEventListener('click', (e) => {
      e.stopPropagation();
      _checkpoints.splice(i, 1);
      saveCheckpoints(_checkpoints);
      renderCheckpoints();
      drawWaveform();
    });
    cpListEl.appendChild(li);
  });
}

// "m:ss" / "h:mm:ss" / 초 문자열 → 초. 형식 오류면 null.
function parseTimeInput(str) {
  str = String(str ?? '').trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':').map(p => p.trim());
  if (parts.some(p => p === '' || isNaN(Number(p)))) return null;
  return parts.reduce((sec, p) => sec * 60 + Number(p), 0);
}

function addCheckpoint() {
  const dur = playerVideo.duration || 0;
  let t = parseTimeInput(cpAddTime?.value);
  if (t == null || isNaN(t)) t = playerVideo.currentTime || 0;
  t = Math.max(0, dur > 0 ? Math.min(dur, t) : t);   // 영상 범위 [0, 길이] 로 클램프
  const name = (cpAddName?.value || '').trim() || fmtVcTime(t);
  _checkpoints.push({ t, name });
  _checkpoints.sort((a, b) => a.t - b.t);
  saveCheckpoints(_checkpoints);
  if (cpAddName) cpAddName.value = '';
  if (cpAddTime) cpAddTime.value = fmtVcTime(playerVideo.currentTime || 0);
  renderCheckpoints();
  drawWaveform();
}

// ── 베이스 TAB ──────────────────────────────────────────────
let _tabView = null;
let _tabBass = null;      // [L, R] — 현재 곡의 베이스 스템
let _tabDrums = null;     // [L, R] — 박자 감지용 드럼 스템
let _tabMix = null;       // [L, R] — 스템을 전부 합친 것. 드럼만으로 템포가 안 잡힐 때 쓴다
let _tabSr = 44100;
let _tabBusy = false;
// 마디 시작을 옮길 때 다시 채보하지 않으려고 결과를 들고 있는다
let _tabNotes = null, _tabTuning = '4', _tabBeats = null, _tabAccent = null;
let _tabPhase = null;     // null = 자동 판정

function tabEls() {
  return {
    view: $('lib-tab-view'), status: $('lib-tab-status'), run: $('lib-tab-run'),
    tuning: $('lib-tab-tuning'), barPrev: $('lib-tab-bar-prev'), barNext: $('lib-tab-bar-next'),
  };
}

function setTabSource(stems, sampleRate) {
  _tabBass = (stems && stems.bass) || null;
  _tabDrums = (stems && stems.drums) || null;
  _tabSr = sampleRate || 44100;
  _tabNotes = null; _tabBeats = null; _tabAccent = null; _tabPhase = null;

  // 스템 합 = 원본 믹스. 드럼만으로 템포가 안 잡히는 곡이 있어 폴백으로 준다.
  _tabMix = null;
  if (stems) {
    const parts = Object.values(stems).filter(s => s && s[0] && s[1]);
    if (parts.length > 1) {
      const n = Math.min(...parts.map(p => p[0].length));
      const L = new Float32Array(n), R = new Float32Array(n);
      for (const p of parts) for (let i = 0; i < n; i++) { L[i] += p[0][i]; R[i] += p[1][i]; }
      _tabMix = [L, R];
    }
  }

  const { status, run } = tabEls();
  if (_tabView) _tabView.clear();
  if (run) run.disabled = !_tabBass || _tabBusy;
  updateTabBarButtons();
  if (status) {
    status.classList.remove('err');
    status.textContent = _tabBass ? t('tab.hintLibrary') : t('tab.noBass');
  }
}

function updateTabBarButtons() {
  const { barPrev, barNext } = tabEls();
  const on = !!(_tabBeats && _tabNotes);
  if (barPrev) barPrev.disabled = !on;
  if (barNext) barNext.disabled = !on;
}

/** 마디 시작을 박 단위로 옮긴다. 채보는 그대로 두고 마디선만 다시 그린다. */
function shiftTabBars(delta) {
  if (!_tabNotes || !_tabBeats || !_tabView) return;
  const sc = buildScore(_tabNotes, _tabBeats, { beatAccent: _tabAccent, phase: _tabPhase });
  const base = _tabPhase != null ? _tabPhase : (sc ? sc.phase : 0);
  _tabPhase = ((base + delta) % 4 + 4) % 4;
  _tabView.setScore(buildScore(_tabNotes, _tabBeats, { phase: _tabPhase }));
}

async function runTabTranscribe() {
  const { view, status, run, tuning } = tabEls();
  if (!view || _tabBusy) return;
  if (!_tabBass) { if (status) { status.textContent = t('tab.noBass'); status.classList.add('err'); } return; }

  _tabBusy = true;
  if (run) run.disabled = true;
  if (status) { status.classList.remove('err'); status.textContent = t('tab.working', { pct: 0 }); }

  try {
    if (!_tabView) _tabView = new TabView(view, { onSeek: (sec) => { playerVideo.currentTime = sec; } });
    const mono = toMono(_tabBass[0], _tabBass[1]);
    const tun = tuning ? tuning.value : '4';
    // 드럼 스템이 있으면 박자를 먼저 잡아 노트를 격자에 붙이고 마디를 나눈다
    let beats = null;
    if (_tabDrums) {
      try {
        const b = await detectBeats(_tabDrums[0], _tabDrums[1], _tabSr, _tabMix);
        if (b && Array.isArray(b.beats) && b.beats.length > 1) beats = b.beats;
      } catch { /* 박자 감지 실패 — 격자도 마디도 없이 진행 */ }
    }
    const r = await transcribeBass(mono, _tabSr, { tuning: tun, beats },
      (pct, phase) => {
        if (status) status.textContent = t(phase === 'bp' ? 'tab.workingBp' : 'tab.working', { pct });
      });
    _tabView.setNotes(r.notes, r.tuning);

    // 마디 — 박이 있을 때만. 첫 박은 드럼 킥으로 추정하고, 틀리면 사용자가 옮긴다.
    _tabNotes = r.notes; _tabTuning = r.tuning; _tabBeats = beats; _tabPhase = null;
    _tabAccent = beats && _tabDrums ? beatAccents(toMono(_tabDrums[0], _tabDrums[1]), _tabSr, beats) : null;
    _tabView.setScore(beats ? buildScore(r.notes, beats, { beatAccent: _tabAccent }) : null);
    updateTabBarButtons();
    if (status) status.textContent = r.cross && r.cross.agreed != null
      ? t('tab.doneCross', { n: r.notes.length, agreed: r.cross.agreed })
      : t('tab.done', { n: r.notes.length });
    if (run) run.textContent = t('tab.rerun');
  } catch (e) {
    if (status) { status.textContent = t('tab.failed', { err: (e && e.message) || e }); status.classList.add('err'); }
  } finally {
    _tabBusy = false;
    if (run) run.disabled = !_tabBass;
  }
}

function initTabPanel() {
  const { run, barPrev, barNext } = tabEls();
  if (run) run.addEventListener('click', runTabTranscribe);
  if (barPrev) barPrev.addEventListener('click', () => shiftTabBars(-1));
  if (barNext) barNext.addEventListener('click', () => shiftTabBars(1));
  setTabSource(null, 44100);
  // 재생 위치 추적은 독립 루프로 둔다 — 파형 그리기(drawWaveform)는
  // 캔버스가 없으면 일찍 반환하므로 거기에 얹으면 같이 죽는다.
  const tick = () => {
    if (_tabView) _tabView.setTime(playerVideo.currentTime || 0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function toggleCheckpointPanel(force) {
  if (!cpPanel) return;
  const show = force != null ? force : cpPanel.hidden;
  cpPanel.hidden = !show;
  cpBtn?.classList.toggle('on', show);
  if (show) {
    if (cpAddTime) cpAddTime.value = fmtVcTime(playerVideo.currentTime || 0);
    renderCheckpoints(); cpAddName?.focus();
  }
  // 패널 열림/닫힘으로 영상·시크바 폭이 바뀌므로 파형 다시 그림
  requestAnimationFrame(drawWaveform);
}

cpBtn?.addEventListener('click', () => toggleCheckpointPanel());
cpClose?.addEventListener('click', () => toggleCheckpointPanel(false));
cpAddBtn?.addEventListener('click', addCheckpoint);
cpAddName?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCheckpoint(); } });
cpAddTime?.addEventListener('focus', () => cpAddTime.select());
cpAddTime?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCheckpoint(); } });
cpAddTime?.addEventListener('blur', () => {
  // 입력값을 영상 범위로 클램프해 정규화 표시. 비우면 현재 위치로 복귀.
  const dur = playerVideo.duration || 0;
  let t = parseTimeInput(cpAddTime.value);
  if (t == null || isNaN(t)) t = playerVideo.currentTime || 0;
  cpAddTime.value = fmtVcTime(Math.max(0, dur > 0 ? Math.min(dur, t) : t));
});

// ── 파형 ────────────────────────────────────────
let _wavePeaks = null;   // Float32Array (0~1), 곡 전체 진폭 다운샘플
const WAVE_BUCKETS = 900;
// 파형 표시 여부 (기본 꺼짐 → 일자 막대). 설정에서 토글.
let _waveformOn = localStorage.getItem('waveformDisplay') === '1';
window.addEventListener('waveform-pref-changed', () => {
  _waveformOn = localStorage.getItem('waveformDisplay') === '1';
  drawWaveform();
});

/** stems({name:[L,R]}) 합산 → mono 진폭을 WAVE_BUCKETS 개로 다운샘플 */
function computeWavePeaks(stems) {
  const arrs = Object.values(stems || {}).filter(a => a && a[0] && a[1]);
  if (!arrs.length) { _wavePeaks = null; return; }
  const len = arrs[0][0].length;
  const bucketSize = Math.max(1, Math.floor(len / WAVE_BUCKETS));
  const peaks = new Float32Array(WAVE_BUCKETS);
  let globalMax = 1e-6;
  for (let b = 0; b < WAVE_BUCKETS; b++) {
    const start = b * bucketSize;
    const end = Math.min(len, start + bucketSize);
    let mx = 0;
    // 스템 합산 후 절대값 최대 (샘플 간격 두고 스캔 — 성능)
    const step = Math.max(1, Math.floor((end - start) / 400));
    for (let i = start; i < end; i += step) {
      let s = 0;
      for (const [L, R] of arrs) s += (L[i] + R[i]) * 0.5;
      const a = Math.abs(s);
      if (a > mx) mx = a;
    }
    peaks[b] = mx;
    if (mx > globalMax) globalMax = mx;
  }
  // 정규화
  for (let b = 0; b < WAVE_BUCKETS; b++) peaks[b] = Math.min(1, peaks[b] / globalMax);
  _wavePeaks = peaks;
}

function drawWaveform() {
  if (!vcWaveform) return;
  const wrap = vcWaveform.parentElement;
  const W = Math.max(1, Math.round(wrap.clientWidth));
  const H = Math.max(1, Math.round(wrap.clientHeight));
  const dpr = window.devicePixelRatio || 1;
  if (vcWaveform.width !== W * dpr || vcWaveform.height !== H * dpr) {
    vcWaveform.width = W * dpr; vcWaveform.height = H * dpr;
  }
  const ctx = vcWaveform.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const dur = playerVideo.duration || 0;
  const cur = playerVideo.currentTime || 0;
  const progX = dur > 0 ? (cur / dur) * W : 0;
  const trimAX = dur > 0 ? ((_trimStart || 0) / dur) * W : 0;
  const trimBX = dur > 0 ? ((_trimEnd != null ? _trimEnd : dur) / dur) * W : W;

  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const accent = cssVar('--accent') || '#35d1a6';
  const mid = H / 2;

  if (!_waveformOn || !_wavePeaks) {
    // 일자(플랫) 막대 — 파형 꺼짐이거나 아직 파형 미계산
    const trackH = 4;
    const y = Math.round(mid - trackH / 2);
    ctx.fillStyle = 'rgba(255,255,255,.12)';               // 트림 밖(제외): 항상 흐리게
    ctx.fillRect(0, y, W, trackH);
    if (trimBX > trimAX) {
      ctx.fillStyle = 'rgba(255,255,255,.42)';             // 트림 안 · 미재생: 회색
      ctx.fillRect(trimAX, y, trimBX - trimAX, trackH);
      // 트림 안 · 재생됨: accent (progX 를 트림 범위로 클램프 → 제외 구간을 덮지 않음)
      const playedEnd = Math.max(trimAX, Math.min(progX, trimBX));
      if (playedEnd > trimAX) { ctx.fillStyle = accent; ctx.fillRect(trimAX, y, playedEnd - trimAX, trackH); }
    }
  } else {
    const n = _wavePeaks.length;
    const barW = W / n;
    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const h = Math.max(1, _wavePeaks[i] * (H * 0.9));
      const inTrim = x >= trimAX - 0.5 && x <= trimBX + 0.5;
      const played = x <= progX;
      if (!inTrim)      ctx.fillStyle = 'rgba(255,255,255,.10)';   // 트림 밖: 매우 흐리게
      else if (played)  ctx.fillStyle = accent;                     // 재생됨: accent
      else              ctx.fillStyle = 'rgba(255,255,255,.42)';    // 미재생: 밝은 회색
      ctx.fillRect(x, mid - h / 2, Math.max(1, barW - 0.5), h);
    }
  }
  // 체크포인트 눈금 (상단에 삼각 표식)
  if (dur > 0 && _checkpoints.length) {
    ctx.fillStyle = cssVar('--tx-2') || 'rgba(255,255,255,.7)';
    for (const cp of _checkpoints) {
      const x = (cp.t / dur) * W;
      ctx.beginPath();
      ctx.moveTo(x - 3, 0); ctx.lineTo(x + 3, 0); ctx.lineTo(x, 4);
      ctx.closePath(); ctx.fill();
      ctx.fillRect(x - 0.5, 0, 1, H);
    }
  }
  // A-B 루프 마커
  const st = currentPlayer?.getLoopState?.();
  if (st && dur > 0) {
    ctx.fillStyle = accent;
    if (st.a != null) ctx.fillRect((st.a / dur) * W - 1, 0, 2, H);
    if (st.b != null) ctx.fillRect((st.b / dur) * W - 1, 0, 2, H);
  }
}

// 트림 상태 (라이브러리 레벨에서 UI 반영용 — Player 가 실제 재생 제어)
let _trimStart = 0;
let _trimEnd = null;   // null = 끝까지

function fmtVcTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
let _vcSeeking = false;

const videoWrap = $('player-video-wrap');
let _vcHideTimer = null;

function updateVcPlayIcon() {
  if (!vcPlay) return;
  // 카운트인 진행 중이면 재생 의도로 간주 → pause 아이콘 표시
  const countingIn = !!currentPlayer?.isCountingIn?.();
  const showingPause = !playerVideo.paused || countingIn;
  vcPlay.classList.toggle('playing', showingPause);
  // 정지 상태(카운트인 아님)면 컨트롤 항상 표시
  videoWrap?.classList.toggle('paused', playerVideo.paused && !countingIn);
}

// 마우스 움직임 → 컨트롤 잠깐 표시, 2초 후 자동 숨김 (재생 중일 때만 숨김)
// 재생 중으로 취급할지 (카운트인 진행 중도 포함 → 컨트롤 자동 숨김 대상)
function vcIsActivePlayback() {
  return !playerVideo.paused || !!currentPlayer?.isCountingIn?.();
}
function showControlsTemporarily() {
  if (!videoWrap) return;
  videoWrap.classList.add('controls-active');
  clearTimeout(_vcHideTimer);
  _vcHideTimer = setTimeout(() => {
    if (vcIsActivePlayback()) videoWrap.classList.remove('controls-active');
  }, 2000);
}
function effectiveDur() {
  const dur = playerVideo.duration || 0;
  const end = _trimEnd != null ? _trimEnd : dur;
  return Math.max(0, end - (_trimStart || 0));
}
function updateVcProgress() {
  if (_vcSeeking) return;
  const dur = playerVideo.duration || 0;
  const cur = playerVideo.currentTime || 0;
  // 트림 시작점 기준 상대시간 표시
  vcTime.textContent = fmtVcTime(Math.max(0, cur - (_trimStart || 0)));
  if (dur > 0) vcSeek.value = String(Math.round(cur / dur * 1000));
  // 편집 중이 아닐 때만 현재 위치로 자동 갱신
  if (cpAddTime && cpPanel && !cpPanel.hidden && document.activeElement !== cpAddTime)
    cpAddTime.value = fmtVcTime(cur);
  drawWaveform();
}
function updateVcDuration() {
  vcDuration.textContent = fmtVcTime(effectiveDur());
}
// 시크바 트림 범위 음영 + 버튼 상태 + 초기화 버튼 표시
function updateTrimUI() {
  const dur = playerVideo.duration || 0;
  const aPct = dur > 0 ? (_trimStart / dur * 100) : 0;
  const bPct = dur > 0 ? ((_trimEnd != null ? _trimEnd : dur) / dur * 100) : 100;
  vcSeek?.style.setProperty('--trim-a', aPct + '%');
  vcSeek?.style.setProperty('--trim-b', bPct + '%');
  const hasS = (_trimStart || 0) > 0.05;
  const hasE = _trimEnd != null;
  vcTrimStart?.classList.toggle('set', hasS);
  vcTrimEnd?.classList.toggle('set', hasE);
  if (vcTrimReset) vcTrimReset.hidden = !(hasS || hasE);
  updateVcDuration();
  drawWaveform();
}

function togglePlayback() {
  if (playerVideo.paused) playerVideo.play().catch(() => {});
  else playerVideo.pause();
}
// 현재 재생 위치를 delta(초)만큼 이동 — 트림 구간 [start, end] 안으로 클램프
function seekBy(delta) {
  const dur = playerVideo.duration || 0;
  if (!dur) return;
  const lo = _trimStart || 0;
  const hi = _trimEnd != null ? _trimEnd : dur;
  playerVideo.currentTime = Math.max(lo, Math.min(hi, (playerVideo.currentTime || 0) + delta));
  updateVcProgress();
  showControlsTemporarily();
}
vcPlay?.addEventListener('click', togglePlayback);
vcRestart?.addEventListener('click', () => {
  playerVideo.currentTime = _trimStart || 0;   // 트림 시작점 = 새 0:00
});
vcSeek?.addEventListener('input', () => {
  _vcSeeking = true;
  const dur = playerVideo.duration || 0;
  const t = (Number(vcSeek.value) / 1000) * dur;
  vcTime.textContent = fmtVcTime(Math.max(0, t - (_trimStart || 0)));
});
vcSeek?.addEventListener('change', () => {
  const dur = playerVideo.duration || 0;
  playerVideo.currentTime = (Number(vcSeek.value) / 1000) * dur;
  _vcSeeking = false;
});

// ── 트림 버튼 ──
vcTrimStart?.addEventListener('click', () => {
  const t = playerVideo.currentTime || 0;
  if (_trimEnd != null && t >= _trimEnd - 0.1) return;   // 끝점보다 뒤면 무시
  _trimStart = t;
  currentPlayer?.setTrimStart(t);
  saveTrim({ start: t });
  updateTrimUI(); updateVcProgress();
});
vcTrimEnd?.addEventListener('click', () => {
  const t = playerVideo.currentTime || 0;
  if (t <= (_trimStart || 0) + 0.1) return;   // 시작점보다 앞이면 무시
  _trimEnd = t;
  currentPlayer?.setTrimEnd(t);
  saveTrim({ end: t });
  updateTrimUI();
});
vcTrimReset?.addEventListener('click', () => {
  _trimStart = 0; _trimEnd = null;
  currentPlayer?.resetTrim();
  saveTrim({ start: 0, end: null });
  updateTrimUI(); updateVcProgress();
});
vcFullscreen?.addEventListener('click', () => {
  const wrap = playerVideo.closest('.player-video-wrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else (wrap || playerVideo).requestFullscreen?.();
});

playerVideo.addEventListener('play',           updateVcPlayIcon);
playerVideo.addEventListener('pause',          updateVcPlayIcon);
playerVideo.addEventListener('timeupdate',     updateVcProgress);

// 컨트롤 표시/숨김 — 마우스 움직임·hover
videoWrap?.addEventListener('mousemove', showControlsTemporarily);
videoWrap?.addEventListener('mouseleave', () => {
  clearTimeout(_vcHideTimer);
  if (vcIsActivePlayback()) videoWrap.classList.remove('controls-active');
});
// 영상 클릭 시 재생/정지 (컨트롤 바 버튼 클릭은 제외)
playerVideo.addEventListener('click', togglePlayback);

// 키보드 단축키 — 라이브러리 뷰가 보이고 트랙이 로드됐을 때만.
// 입력창(그룹/이름/BPM 편집, 슬라이더 등) 포커스 시엔 네이티브 동작 우선.
document.addEventListener('keydown', (e) => {
  if (!currentPlayer) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const libView = document.querySelector('main[data-view="library"]');
  if (!libView || libView.hidden) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  switch (e.key) {
    case ' ': case 'Spacebar':   e.preventDefault(); togglePlayback(); break;
    case 'ArrowLeft':            e.preventDefault(); seekBy(-5); break;
    case 'ArrowRight':           e.preventDefault(); seekBy(5); break;
  }
});
playerVideo.addEventListener('loadedmetadata', () => {
  updateVcProgress();
  updateVcPlayIcon();
  updateTrimUI();   // duration 확정 후 트림 음영·상대길이 반영
});
// 창 크기 변경 시 파형 다시 그리기 (디바운스)
let _waveResizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_waveResizeTimer);
  _waveResizeTimer = setTimeout(drawWaveform, 100);
});
playerVideo.addEventListener('durationchange', () => {
  updateTrimUI();
});

export const Library = {
  refresh,
  selectItem,
  getSelected: () => currentItem(),
  getItems: () => items.slice(),
};

// 뷰 첫 진입 시 자동 로드
document.addEventListener('DOMContentLoaded', () => { refresh(); initTabPanel(); });
