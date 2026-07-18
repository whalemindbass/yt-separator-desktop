'use strict';
// Library view — 좌측 리스트 + 우측 플레이어

import { Player, STEM_META, STEM_ORDER, loadStemFilesToBuffers, toYtsepUrl } from './player.js';

const api = window.yssApi;
const $ = (id) => document.getElementById(id);

const listEl        = $('lib-list');
const emptyEl       = $('lib-empty');
const refreshBtn    = $('lib-refresh');
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

function groupSort(a, b) {
  // 즐겨찾기 최우선, 그룹 이름 순, 그 다음 최신순
  if ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)) return (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0);
  const ga = a.group || 'ᆢ'; const gb = b.group || 'ᆢ';   // 그룹 없는 것을 뒤로
  if (ga !== gb) return ga < gb ? -1 : 1;
  return (b.createdAt || 0) - (a.createdAt || 0);
}

function renderList() {
  listEl.innerHTML = '';
  if (!items.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;

  const sorted = items.slice().sort(groupSort);
  let lastHeader = null;
  const addHeader = (label) => {
    if (lastHeader === label) return;
    lastHeader = label;
    const h = document.createElement('li');
    h.className = 'lib-group-head';
    h.textContent = label;
    listEl.appendChild(h);
  };

  for (const it of sorted) {
    const header = it.favorite ? '★  즐겨찾기' : (it.group ? it.group : '기타');
    addHeader(header);

    const li = document.createElement('li');
    li.className = 'lib-item' + (it.id === selectedId ? ' on' : '');
    li.dataset.id = it.id;
    li.innerHTML = `
      <div class="lib-item-row">
        <div class="lib-item-titles">
          <div class="lib-item-title"></div>
          <div class="lib-item-sub"></div>
        </div>
        <button class="lib-fav ${it.favorite ? 'on' : ''}" title="즐겨찾기">${starSvg(!!it.favorite)}</button>
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

    // 즐겨찾기 토글
    li.querySelector('.lib-fav').addEventListener('click', async (e) => {
      e.stopPropagation();
      const nowFav = !it.favorite;
      const res = await api.library.setFavorite(it.id, nowFav);
      if (res.ok) {
        it.favorite = res.favorite;
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
        item.name = newName;
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
}

async function mountPlayer(item) {
  destroyPlayer();
  setErr('');
  playerEmpty.hidden = true;
  playerSection.hidden = false;
  playerLoading.hidden = false;

  playerName.value = item.name;
  playerProv.textContent = `SR ${item.sampleRate || 44100}`;

  try {
    const { stems, sampleRate } = await loadStemFilesToBuffers(item.stemPaths);
    const videoUrl = toYtsepUrl(item.videoPath);
    currentPlayer = new Player(playerVideo, videoUrl, stems, sampleRate);

    // 믹서 트랙
    for (const name of STEM_ORDER) {
      if (!stems[name]) continue;
      const meta = STEM_META[name];
      const row = document.createElement('div');
      row.className = 'mixer-track';
      row.dataset.stem = name;
      row.innerHTML = `
        <div class="mixer-track-name">
          <span class="mixer-track-dot" style="background:${meta.color}"></span>
          <span>${meta.label}</span>
        </div>
        <button class="mixer-mute" data-stem="${name}">M</button>
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
      });
    });
    mixerTracks.querySelectorAll('.mixer-mute').forEach(btn => {
      btn.addEventListener('click', () => {
        const stem = btn.dataset.stem;
        const muted = currentPlayer.toggleMute(stem);
        btn.classList.toggle('on', muted);
        const row = mixerTracks.querySelector(`.mixer-track[data-stem="${stem}"]`);
        row?.classList.toggle('muted', muted);
      });
    });

    // master / source / key / group 초기화
    masterVol.value = 100; masterVal.textContent = '100%';
    resetSourceToggle();
    resetKeyUI();
    updateGroupPickerLabel();
  } catch (e) {
    console.error(e);
    setErr('로드 실패: ' + e.message);
  } finally {
    playerLoading.hidden = true;
  }
}

masterVol.addEventListener('input', () => {
  const v = Number(masterVol.value) / 100;
  masterVal.textContent = masterVol.value + '%';
  currentPlayer?.setMasterVolume(v);
});

// ── 오디오 소스 토글 (스템 / 원본) ────────────────
const srcToggle = $('source-toggle');
srcToggle?.addEventListener('click', (e) => {
  const btn = e.target.closest('.source-btn');
  if (!btn || btn.classList.contains('on')) return;
  srcToggle.querySelectorAll('.source-btn').forEach(b => b.classList.toggle('on', b === btn));
  const isOrig = btn.dataset.src === 'orig';
  currentPlayer?.setOriginalMix(isOrig ? 1 : 0);
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
  keyApply.textContent = keyTarget === cur ? '적용됨' : '적용';
  if (!keyProcessing && !keyStatus.textContent.startsWith('실패')) {
    keyStatus.textContent = cur !== 0 ? `현재 ${fmtKey(cur)}` : '';
  }
}
keyDown?.addEventListener('click', () => { keyTarget = Math.max(-6, keyTarget - 1); updateKeyUI(); });
keyUp  ?.addEventListener('click', () => { keyTarget = Math.min( 6, keyTarget + 1); updateKeyUI(); });
keyApply?.addEventListener('click', async () => {
  if (!currentPlayer || keyProcessing) return;
  if (keyTarget === currentPlayer._currentKey) return;
  keyProcessing = true;
  updateKeyUI();
  keyStatus.textContent = '처리 중…';
  try {
    await currentPlayer.setKeyShift(keyTarget, ensureEncoderWorker());
    keyStatus.textContent = '';
  } catch (e) {
    keyStatus.textContent = '실패: ' + e.message;
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
  mkItem('(그룹 없음)', '');
  if (groups.length) {
    mkItem('기존 그룹', null, true);
    for (const g of groups) mkItem(g, g);
  }
  mkItem('신규', null, true);
  mkItem('+ 새 그룹 만들기…', '__new__', false, true);
}

function showNewGroupInput() {
  groupMenu.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'group-input-row';
  li.innerHTML = `<input class="group-input" placeholder="그룹 이름" maxlength="80" />`;
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

async function handleGroupPick(value) {
  groupMenu.hidden = true;
  const it = currentItem();
  if (!it) return;
  const group = String(value || '').trim();
  const res = await api.library.setGroup(it.id, group);
  if (res.ok) {
    if (group) it.group = group; else delete it.group;
    updateGroupPickerLabel();
    renderList();
  }
}
function updateGroupPickerLabel() {
  const it = currentItem();
  groupVal.textContent = it?.group || '그룹 없음';
}
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


// 이름 변경
async function commitRename() {
  if (!selectedId) return;
  const name = playerName.value.trim() || 'Untitled';
  const item = items.find(x => x.id === selectedId);
  if (item && item.name === name) return;
  const res = await api.library.rename(selectedId, name);
  if (res.ok) {
    if (item) item.name = name;
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
  const yes = confirm(`"${item.name}" 을(를) 라이브러리에서 제거하시겠습니까?\n\n원본 파일(영상, 스템 wav)도 함께 삭제됩니다.`);
  if (!yes) return;
  await api.library.remove(selectedId, true);
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

  const dupMsg = dupRes.removed > 0
    ? `라이브러리 중복 ${dupRes.removed}개 통합 · 파일 ${dupRes.removedFiles}개 삭제 (${(dupRes.freedBytes/1024/1024).toFixed(1)} MB)`
    : '라이브러리에 중복 없음';

  const orphans = [...(preview.videos || []), ...(preview.stems || [])];
  if (orphans.length === 0) {
    await refresh();
    alert(`${dupMsg}\n\n라이브러리에 없는 파일 없음 — 깨끗함.`);
    return;
  }

  const totalMb = (orphans.reduce((s, x) => s + x.size, 0) / 1024 / 1024).toFixed(1);
  const list = orphans.slice(0, 30).map(x => `  · ${x.path.split(/[\\/]/).pop()}  (${(x.size/1024/1024).toFixed(1)} MB)`).join('\n');
  const suffix = orphans.length > 30 ? `\n  ... 외 ${orphans.length - 30}개` : '';
  const msg = `${dupMsg}\n\n라이브러리에 등록되지 않은 파일 ${orphans.length}개 (${totalMb} MB 확보 가능):\n${list}${suffix}\n\n이 파일들을 모두 삭제할까요?\n(현재 라이브러리에 있는 파일은 절대 삭제되지 않습니다)`;

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
  alert(`추가 정리 완료: ${ok}개 파일, ${(freed/1024/1024).toFixed(1)} MB 확보`);
});

export const Library = {
  refresh,
  selectItem,
};

// 뷰 첫 진입 시 자동 로드
document.addEventListener('DOMContentLoaded', () => { refresh(); });
