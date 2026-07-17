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
const playerBeep    = $('player-beep');
const playerStemTest = $('player-stem-test');
const playerStatus  = $('player-status');
const mixerTracks   = $('mixer-tracks');
const masterVol     = $('master-vol');
const masterVal     = $('master-val');

let items = [];
let selectedId = null;
let currentPlayer = null;
let statusTimer = null;

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

function renderList() {
  listEl.innerHTML = '';
  if (!items.length) { emptyEl.hidden = false; return; }
  emptyEl.hidden = true;
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'lib-item' + (it.id === selectedId ? ' on' : '');
    li.dataset.id = it.id;
    li.innerHTML = `
      <div class="lib-item-title"></div>
      <div class="lib-item-sub"></div>
    `;
    li.querySelector('.lib-item-title').textContent = it.name;
    li.querySelector('.lib-item-sub').textContent = fmtDate(it.createdAt);
    li.addEventListener('click', () => selectItem(it.id));
    listEl.appendChild(li);
  }
}

async function selectItem(id) {
  const it = items.find(x => x.id === id);
  if (!it) return;
  selectedId = id;
  renderList();
  await mountPlayer(it);
}

function destroyPlayer() {
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  if (currentPlayer) { try { currentPlayer.destroy(); } catch {} currentPlayer = null; }
  mixerTracks.innerHTML = '';
  playerStatus.textContent = '';
}

function updateStatus() {
  if (!currentPlayer) return;
  const s = currentPlayer.getStatus();
  playerStatus.textContent =
    `ctx=${s.ctxState} sr=${s.ctxSampleRate} · playing=${s.playing} sources=${s.activeSources} · ` +
    `video=${s.videoPaused ? 'paused' : 'play'} t=${s.videoTime}s ready=${s.videoReadyState} · master=${s.masterGain}`;
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

    // master 초기화
    masterVol.value = 100; masterVal.textContent = '100%';

    // 상태 라이브 갱신
    updateStatus();
    statusTimer = setInterval(updateStatus, 500);
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

playerBeep.addEventListener('click', async () => {
  if (!currentPlayer) return;
  try {
    await currentPlayer.testBeep();
    setErr('');
  } catch (e) {
    setErr('톤 테스트 실패: ' + e.message);
  }
});

playerStemTest.addEventListener('click', async () => {
  if (!currentPlayer) return;
  try {
    await currentPlayer.testStemDirect();
    setErr('');
  } catch (e) {
    setErr('stem direct 테스트 실패: ' + e.message);
  }
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

export const Library = {
  refresh,
  selectItem,
};

// 뷰 첫 진입 시 자동 로드
document.addEventListener('DOMContentLoaded', () => { refresh(); });
