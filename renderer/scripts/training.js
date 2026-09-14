'use strict';
// 트레이닝 뷰 — 곡·프로젝트와 무관한 연습 도구 모음. 원래 스튜디오 도구창 안에 있던
// 연습 메트로놈을 여기로 옮겼다 — 순전히 연습만 하려는데 DAW 엔진까지 켜야 닿을 수
// 있던 게 불필요한 무게였다. 새 도구를 추가할 자리이기도 하다.
// (튜너만 예외 — 엔진의 ASIO pitch 분석을 그대로 쓰므로 엔진이 켜져 있어야 한다.)

import { t, getLocale } from './i18n.js';
import { usageSetIdle, usageGetLog, usageGetGoals, usageSetGoals, usageReady } from './usage.js';
import { getPresets, upsertPreset } from './fx-presets.js';
import { toYtsepUrl } from './player.js';
import { esc } from './studio/util.js';

const $ = (id) => document.getElementById(id);
const api = window.yssApi;

// ── 연습 기록 ──
// usage.js 가 뷰별 체류 시간을 날짜별·카테고리별로 실제 파일(usageLog.json)에 이미
// 누적해 둔다(집계 로직은 거기 하나뿐) — 여기서는 그 값을 읽어 달력만 그린다.
// 칸 하나하나가 활동 링처럼 그날 일일 목표 대비 진행률을 카테고리별 색으로
// 나눈 도넛으로 보여준다(목표를 채우면 가득 참). 칸을 고르면 아래 상세에서 카테고리별
// 막대·분(分)을 숫자로도 보여준다 — 링만으론 정확한 분 단위까지는 못 읽으니까.
const LOG_CAT_COLORS = { studio: 'var(--accent)', library: '#4f8fd1', training: '#d98e42' };
let _logYear = 0, _logMonth = 0;   // 0-indexed month
let _logSelectedDate = '';   // 지금 상세/메모가 보여주는 날짜(logShowDetail 이 세팅)

// ── 연습 기록 메모 ──
// usageLog.json 과 같은 이유(localStorage 는 통째로 날아갈 수 있고 업데이트에도
// library.json 같은 실제 파일만큼 안전하지 않다)로 trainingNotes.json 에 저장한다.
// usage.js 와 달리 이 화면 하나에서만 쓰므로 별도 모듈로 안 뺐다.
let _notes = [];
const notesReady = (async () => {
  try {
    const d = await api?.notes?.load();
    if (Array.isArray(d)) _notes = d;
  } catch { /* 파일이 없거나 깨졌으면 빈 상태로 시작 */ }
})();
function notesPersist() { notesReady.then(() => api?.notes?.save(_notes)); }
function notesForDate(dateKey) {
  return _notes.filter(n => n.date === dateKey).sort((a, b) => b.createdAt - a.createdAt);
}
function notesAdd(date, title, body) {
  const n = {
    id: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()),
    date, title, body, createdAt: Date.now(), updatedAt: Date.now(),
  };
  _notes.push(n);
  notesPersist();
  return n;
}
function notesUpdate(id, title, body) {
  const n = _notes.find(x => x.id === id);
  if (!n) return;
  n.title = title; n.body = body; n.updatedAt = Date.now();
  notesPersist();
}
function notesDelete(id) {
  _notes = _notes.filter(n => n.id !== id);
  notesPersist();
}
function noteItemHTML(n, showDate) {
  const title = (n.title || '').trim() || (n.body || '').split('\n')[0].trim() || t('training.log.noteUntitled');
  return `<div class="log-notes-item" data-id="${esc(n.id)}">
    <div class="log-notes-item-main">
      <div class="log-notes-item-title">${esc(title)}</div>
      ${showDate ? `<div class="log-notes-item-date">${esc(n.date)}</div>` : ''}
    </div>
    <button class="log-notes-item-del" type="button" data-id="${esc(n.id)}" aria-label="delete">✕</button>
  </div>`;
}
function renderDailyNotes() {
  const box = $('log-notes-daily-list');
  if (!box) return;
  const list = notesForDate(_logSelectedDate);
  box.innerHTML = list.length ? list.map(n => noteItemHTML(n, false)).join('') : `<div class="log-notes-empty">${t('training.log.noteEmpty')}</div>`;
}
let _notesSearch = '', _notesPeriod = 'all', _notesSort = 'date', _notesFrom = '', _notesTo = '';
function notesFilteredAll() {
  const now = new Date();
  const todayKey = logDateKey(now.getFullYear(), now.getMonth(), now.getDate());
  let from = null, to = null;
  if (_notesPeriod === '7d') {
    const d = new Date(now); d.setDate(d.getDate() - 6);
    from = logDateKey(d.getFullYear(), d.getMonth(), d.getDate()); to = todayKey;
  } else if (_notesPeriod === 'month') {
    from = logDateKey(_logYear, _logMonth, 1);
    to = logDateKey(_logYear, _logMonth, new Date(_logYear, _logMonth + 1, 0).getDate());
  } else if (_notesPeriod === 'custom') {
    from = _notesFrom || null; to = _notesTo || null;
  }
  const q = _notesSearch.trim().toLowerCase();
  const list = _notes.filter(n => {
    if (from && n.date < from) return false;
    if (to && n.date > to) return false;
    if (q && !((n.title || '').toLowerCase().includes(q) || (n.body || '').toLowerCase().includes(q))) return false;
    return true;
  });
  list.sort((a, b) => _notesSort === 'updated'
    ? b.updatedAt - a.updatedAt
    : (b.date.localeCompare(a.date) || b.createdAt - a.createdAt));
  return list;
}
function renderAllNotes() {
  const box = $('log-notes-all-list');
  if (!box) return;
  box.innerHTML = notesFilteredAll().map(n => noteItemHTML(n, true)).join('')
    || `<div class="log-notes-empty">${t('training.log.noteEmpty')}</div>`;
}
function notesAllTabOn() { return document.querySelector('.log-notes-tab[data-mode="all"]')?.classList.contains('on'); }
function notesRefreshVisible() { renderDailyNotes(); if (notesAllTabOn()) renderAllNotes(); }
// 메모 작성 페이지 — .log-main(달력) 자리를 대신 차지한다(같은 그리드 셀).
let _noteEditId = null;     // null = 새 메모, 아니면 편집 중인 메모 id
let _noteEditDate = '';     // 그 메모(또는 새로 만들 메모)가 속한 날짜 — 달력 배지 갱신용
function noteEditorOpen(existing) {
  _noteEditId = existing ? existing.id : null;
  _noteEditDate = existing ? existing.date : _logSelectedDate;
  $('log-main').hidden = true;
  $('log-note-editor').hidden = false;
  $('log-note-editor-date').textContent = _noteEditDate;
  $('log-note-title').value = existing ? (existing.title || '') : '';
  $('log-note-body').value = existing ? (existing.body || '') : '';
  $('log-note-delete').hidden = !existing;
  $('log-note-title').focus();
}
function noteEditorClose() {
  $('log-note-editor').hidden = true;
  $('log-main').hidden = false;
  _noteEditId = null;
}
function noteEditorSave() {
  const title = $('log-note-title').value.trim();
  const body = $('log-note-body').value;
  if (!title && !body.trim()) { noteEditorClose(); return; }   // 빈 메모는 그냥 취소 취급
  if (_noteEditId) notesUpdate(_noteEditId, title, body);
  else notesAdd(_noteEditDate, title, body);
  const date = _noteEditDate;
  noteEditorClose();
  notesRefreshVisible();
  logRefreshDayNotes(date);
}
function noteEditorDelete() {
  if (!_noteEditId) { noteEditorClose(); return; }
  if (!confirm(t('training.log.noteDeleteConfirm'))) return;
  notesDelete(_noteEditId);
  const date = _noteEditDate;
  noteEditorClose();
  notesRefreshVisible();
  logRefreshDayNotes(date);
}
// 목록(일일/전체)의 ✕ 버튼으로 지우는 경로 — 지우려는 메모가 지금 편집기에 열려 있는
// 바로 그 메모면 편집기도 같이 닫는다(이미 사라진 메모를 붙들고 있으면 안 되니까).
function noteListDelete(note) {
  if (!note || !confirm(t('training.log.noteDeleteConfirm'))) return;
  if (_noteEditId === note.id) noteEditorClose();
  notesDelete(note.id);
  notesRefreshVisible();
  logRefreshDayNotes(note.date);
}
// 전체 그리드를 새로 안 그리고(달력 선택 상태가 날아간다) 배지 하나만 갱신한다.
function logRefreshDayNotes(dateKey) {
  const cell = document.querySelector(`.log-cell[data-date="${dateKey}"]`);
  const box = cell?.querySelector('.log-daybox');
  if (!box) return;
  const n = notesForDate(dateKey).length;
  let badge = box.querySelector('.log-notecount');
  if (n > 0) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'log-notecount'; box.appendChild(badge); }
    badge.textContent = `${t('training.log.noteCountLabel')} : ${n}`;
  } else {
    badge?.remove();
  }
}
function logDateKey(y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function logLoad() { return usageGetLog(); }
function logIntlLocale() { return getLocale() === 'en' ? 'en-US' : 'ko-KR'; }
function logWeekdayLabels() {
  const fmt = new Intl.DateTimeFormat(logIntlLocale(), { weekday: 'short' });
  const labels = [];
  for (let i = 0; i < 7; i++) labels.push(fmt.format(new Date(2023, 0, 1 + i)));   // 2023-01-01 은 일요일
  return labels;
}
function logMonthLabel(y, m) {
  return new Intl.DateTimeFormat(logIntlLocale(), { year: 'numeric', month: 'long' }).format(new Date(y, m, 1));
}
function logMinutes(sec) { return Math.round((sec || 0) / 60); }
// 활동 링 — 배경 원 하나 위에 카테고리별 호(arc)를 이어 그린다. 목표를 다 채우면
// (분 합 ≥ 일일 목표) 링이 완전히 닫히고, 못 채웠으면 그만큼만 채워지고 나머지는 배경색.
// 목표를 넘긴 카테고리 비율은 유지한 채로 전체를 1(=한 바퀴)에 맞게 눌러 담는다 — 그래야
// 목표 초과일도 "가득 찬 링" 하나로 보이지, 링이 두 바퀴 겹쳐 지저분해지지 않는다.
function logRingHTML(rec) {
  const r = 24, cx = 28, cy = 28, sw = 5.5;
  const C = 2 * Math.PI * r;
  const goalSec = usageGetGoals().dailyMin * 60;
  const cats = ['studio', 'library', 'training'];
  const vals = cats.map(c => rec[c] || 0);
  const fracs = goalSec > 0 ? vals.map(v => v / goalSec) : [0, 0, 0];
  const sum = fracs.reduce((a, b) => a + b, 0);
  const scaled = sum > 1 ? fracs.map(f => f / sum) : fracs;
  let acc = 0;
  const arcs = cats.map((c, i) => {
    const f = Math.max(0, scaled[i]);
    const dash = `${(f * C).toFixed(2)} ${(C - f * C).toFixed(2)}`;
    const offset = (-acc * C).toFixed(2);
    acc += f;
    if (f <= 0) return '';
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${LOG_CAT_COLORS[c]}" stroke-width="${sw}" stroke-dasharray="${dash}" stroke-dashoffset="${offset}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`;
  }).join('');
  return `<svg class="log-ring" viewBox="0 0 56 56" aria-hidden="true">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--elev-2)" stroke-width="${sw}"/>` +
    arcs + `</svg>`;
}
function logShowDetail(dateKey) {
  _logSelectedDate = dateKey;
  renderDailyNotes();
  const log = logLoad();
  const rec = log[dateKey] || {};
  const dateEl = $('log-detail-date'); if (dateEl) dateEl.textContent = dateKey;
  const s = rec.studio || 0, li = rec.library || 0, tr = rec.training || 0;
  const total = s + li + tr;
  $('log-detail-studio').textContent = total ? logMinutes(s) + t('training.log.min') : t('training.log.none');
  $('log-detail-library').textContent = total ? logMinutes(li) + t('training.log.min') : '';
  $('log-detail-training').textContent = total ? logMinutes(tr) + t('training.log.min') : '';
  const bar = $('log-detail-bar');
  if (bar) {
    bar.innerHTML = total
      ? `<span class="seg seg-studio" style="width:${s / total * 100}%"></span>` +
        `<span class="seg seg-library" style="width:${li / total * 100}%"></span>` +
        `<span class="seg seg-training" style="width:${tr / total * 100}%"></span>`
      : '';
  }
}
function logRenderMonthProgress() {
  const daysInMonth = new Date(_logYear, _logMonth + 1, 0).getDate();
  const log = logLoad();
  let totalSec = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const rec = log[logDateKey(_logYear, _logMonth, d)];
    if (rec) totalSec += (rec.studio || 0) + (rec.library || 0) + (rec.training || 0);
  }
  const doneMin = logMinutes(totalSec);
  const monthlyMin = usageGetGoals().monthlyMin;
  const label = $('log-month-progress-label');
  if (label) label.textContent = t('training.log.monthProgress', { done: doneMin, goal: monthlyMin });
  const fill = $('log-month-progress-fill');
  if (fill) fill.style.width = (monthlyMin > 0 ? Math.min(100, doneMin / monthlyMin * 100) : 0) + '%';
}
function logRenderMonth() {
  const label = $('log-month-label'); if (label) label.textContent = logMonthLabel(_logYear, _logMonth);
  const wdBox = $('log-weekdays');
  if (wdBox && !wdBox.childElementCount) {
    logWeekdayLabels().forEach(w => { const s = document.createElement('span'); s.textContent = w; wdBox.appendChild(s); });
  }
  const grid = $('log-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const log = logLoad();
  const firstDow = new Date(_logYear, _logMonth, 1).getDay();
  const daysInMonth = new Date(_logYear, _logMonth + 1, 0).getDate();
  const now = new Date();
  const todayKey = logDateKey(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < firstDow; i++) {
    const empty = document.createElement('span'); empty.className = 'log-cell empty'; grid.appendChild(empty);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = logDateKey(_logYear, _logMonth, d);
    const rec = log[key] || {};
    const total = (rec.studio || 0) + (rec.library || 0) + (rec.training || 0);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'log-cell' + (total > 0 ? ' has' : '') + (key === todayKey ? ' today' : '');
    cell.dataset.date = key;
    const noteCount = notesForDate(key).length;
    cell.innerHTML = logRingHTML(rec) +
      `<span class="log-daybox"><span class="log-daynum">${d}</span>` +
      (noteCount ? `<span class="log-notecount">${esc(t('training.log.noteCountLabel'))} : ${noteCount}</span>` : '') +
      `</span>`;
    grid.appendChild(cell);
  }
  logRenderMonthProgress();
  // 오늘이 지금 보고 있는 달 안에 있을 때만 자동으로 골라 보여준다 — 지난달로 넘겨 봤는데
  // 상세는 계속 "오늘" 걸 보여주면 지금 뭘 보고 있는지 헷갈린다.
  const isCurrentMonth = _logYear === now.getFullYear() && _logMonth === now.getMonth();
  if (isCurrentMonth) {
    logShowDetail(todayKey);
    document.querySelectorAll('.log-cell').forEach(c => c.classList.toggle('sel', c.dataset.date === todayKey));
  } else {
    logShowDetail(logDateKey(_logYear, _logMonth, 1));
    document.querySelectorAll('.log-cell').forEach(c => c.classList.remove('sel'));
  }
}
function logEnter() {
  const now = new Date();
  if (!_logYear) { _logYear = now.getFullYear(); _logMonth = now.getMonth(); }
  logRenderMonth();
}

// ── 연습 메트로놈 ──
// 엔진 쪽 metro() 는 재생 중일 때만 울리고(playing 조건) 악센트·박자표 개념이 아예 없는
// 균일 클릭이라(engine/src/Main.cpp) 이 용도엔 못 쓴다 — 렌더러 자체 Web Audio 로 독립
// 스케줄링한다. look-ahead 패턴(짧은 간격으로 깨어나 앞으로 올 클릭들을 AudioContext 시간
// 으로 미리 예약)을 안 쓰고 클릭마다 setTimeout 하나씩 걸면 그 지연·지터가 쌓여 박자가
// 밀린다 — 그래서 25ms 마다 깨어나 앞으로 100ms 안의 클릭을 미리 예약해 둔다.
const PM_LOOKAHEAD_MS = 25;
const PM_SCHEDULE_AHEAD = 0.1;   // 초
// 세분화는 예전엔 그냥 "박 안에 몇 등분" 이라 균등 나눗셈 하나로 됐는데, 바운스(스윙)는
// 등분이 아니라 길게-짧게(2:1) 라서 그 가정이 깨진다 — 그래서 "몇 등분" 대신 "박 하나를
// 채우는 상대 길이 배열"(합이 1) 로 일반화한다. 등분할 종류는 그냥 다 같은 길이로 채운 배열.
const PM_SUBDIV_PATTERNS = {
  1: [1],
  2: [0.5, 0.5],
  3: [1 / 3, 1 / 3, 1 / 3],           // 8분음표 3연음(셋잇단음표) — 한 박에 3개
  4: [0.25, 0.25, 0.25, 0.25],
  6: [1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6, 1 / 6], // 16분음표 3연음 — 한 박에 6개(3연음의 2배 빠르기)
  swing: [2 / 3, 1 / 3],              // 바운스 — 길게(2/3)-짧게(1/3), 스윙 8분음표
};
function pmSubdivKey(v) { return PM_SUBDIV_PATTERNS[v] ? v : '1'; }
let _pmCtx = null, _pmGain = null, _pmTimer = null;
let _pmNextTime = 0, _pmBeat = 0, _pmSub = 0, _pmPlaying = false;
let _pmBpm = Number(localStorage.getItem('yss:pmBpm')) || 120;
let _pmSig = Number(localStorage.getItem('yss:pmSig')) || 4;
let _pmSubdiv = pmSubdivKey(localStorage.getItem('yss:pmSubdiv'));
let _pmVol = Number(localStorage.getItem('yss:pmVol'));
if (!(_pmVol >= 0 && _pmVol <= 1)) _pmVol = 0.6;
let _pmTapTimes = [];

function pmEnsureCtx() {
  if (!_pmCtx) {
    _pmCtx = new (window.AudioContext || window.webkitAudioContext)();
    _pmGain = _pmCtx.createGain();
    _pmGain.gain.value = _pmVol;
    _pmGain.connect(_pmCtx.destination);
  }
  if (_pmCtx.state === 'suspended') _pmCtx.resume();
  return _pmCtx;
}
// 박 표시 새로 그리기 — 박자표·세분화 바뀔 때마다. 큰 점은 박(첫 박만 accent),
// 그 사이 작은 눈금은 세분화 중간 클릭 — 소리만으론 800Hz 클릭이 1000Hz 박과
// 헷갈리기 쉬워서 눈으로도 "지금 세분화가 실제로 더 들어가고 있다"를 보여준다.
function renderBeatDots(boxId, sig, subdiv) {
  const box = $(boxId);
  if (!box) return;
  const steps = (PM_SUBDIV_PATTERNS[subdiv] || PM_SUBDIV_PATTERNS[1]).length;
  box.innerHTML = '';
  for (let i = 0; i < sig; i++) {
    const d = document.createElement('span');
    d.className = 'pm-beat-dot' + (i === 0 ? ' accent' : '');
    d.dataset.beat = String(i);
    box.appendChild(d);
    for (let s = 1; s < steps; s++) {
      const tick = document.createElement('span');
      tick.className = 'pm-beat-tick';
      tick.dataset.beat = String(i);
      tick.dataset.sub = String(s);
      box.appendChild(tick);
    }
  }
}
function pmRenderBeats() { renderBeatDots('pm-beats', _pmSig, _pmSubdiv); }
// AudioContext 시간에 맞춰 예약된 클릭이 실제로 울릴 때 해당 표시를 짧게 밝힌다.
// setTimeout 이라 화면 표시는 오디오만큼 샘플-정확하진 않지만 눈으로 박자 따라가는
// 용도로는 충분하고, 클릭 스케줄링 자체(오디오)에는 영향을 주지 않는다.
function pmFlashEl(el, holdMs) {
  if (!el) return;
  el.classList.add('active');
  clearTimeout(el._pmFlashT);
  el._pmFlashT = setTimeout(() => el.classList.remove('active'), holdMs);
}
function pmFlashBeat(beatIdx, delayMs) {
  const hold = Math.min(140, (60000 / _pmBpm) * 0.6);
  setTimeout(() => pmFlashEl(document.querySelector(`#pm-beats .pm-beat-dot[data-beat="${beatIdx}"]`), hold), delayMs);
}
function pmFlashTick(beatIdx, subIdx, delayMs) {
  const pattern = PM_SUBDIV_PATTERNS[_pmSubdiv] || PM_SUBDIV_PATTERNS[1];
  const w = pattern[subIdx] ?? (1 / pattern.length);
  const hold = Math.min(90, w * (60000 / _pmBpm) * 0.6);
  setTimeout(() => pmFlashEl(document.querySelector(`#pm-beats .pm-beat-tick[data-beat="${beatIdx}"][data-sub="${subIdx}"]`), hold), delayMs);
}
function pmClick(time, kind, beatIdx, subIdx) {
  // kind: 'accent'(강박) | 'beat'(보통 박) | 'sub'(세분화 중간 클릭 — 더 낮고 짧은 톤)
  const osc = _pmCtx.createOscillator();
  const g = _pmCtx.createGain();
  osc.frequency.value = kind === 'accent' ? 1500 : kind === 'beat' ? 1000 : 650;
  const peak = kind === 'sub' ? 0.4 : (kind === 'accent' ? 1 : 0.6);
  const decay = kind === 'sub' ? 0.025 : 0.05;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  osc.connect(g); g.connect(_pmGain);
  osc.start(time); osc.stop(time + 0.06);
  const delayMs = Math.max(0, (time - _pmCtx.currentTime) * 1000);
  if (kind === 'sub') pmFlashTick(beatIdx, subIdx, delayMs);
  else pmFlashBeat(beatIdx, delayMs);
}
function pmScheduler() {
  const pattern = PM_SUBDIV_PATTERNS[_pmSubdiv] || PM_SUBDIV_PATTERNS[1];
  while (_pmNextTime < _pmCtx.currentTime + PM_SCHEDULE_AHEAD) {
    const isBeat = _pmSub === 0;
    const isAccent = isBeat && _pmBeat === 0;
    pmClick(_pmNextTime, isAccent ? 'accent' : isBeat ? 'beat' : 'sub', _pmBeat, _pmSub);
    _pmNextTime += pattern[_pmSub] * (60 / _pmBpm);
    _pmSub = (_pmSub + 1) % pattern.length;
    if (_pmSub === 0) _pmBeat = (_pmBeat + 1) % _pmSig;
  }
}
function pmStart() {
  if (_pmPlaying) return;
  pmEnsureCtx();
  _pmPlaying = true; _pmBeat = 0; _pmSub = 0;
  _pmNextTime = _pmCtx.currentTime + 0.05;
  _pmTimer = setInterval(pmScheduler, PM_LOOKAHEAD_MS);
  const btn = $('pm-playstop'); if (btn) { btn.classList.add('on'); btn.textContent = t('training.pm.stop'); }
  syncTrainingActivity();
}
function pmStop() {
  if (!_pmPlaying) return;
  _pmPlaying = false;
  clearInterval(_pmTimer); _pmTimer = null;
  document.querySelectorAll('#pm-beats .pm-beat-dot, #pm-beats .pm-beat-tick').forEach(d => {
    clearTimeout(d._pmFlashT); d.classList.remove('active');
  });
  const btn = $('pm-playstop'); if (btn) { btn.classList.remove('on'); btn.textContent = t('training.pm.start'); }
  syncTrainingActivity();
}
function pmSetBpm(v) {
  _pmBpm = Math.max(20, Math.min(300, Math.round(v)));
  localStorage.setItem('yss:pmBpm', String(_pmBpm));
  const el = $('pm-bpm'); if (el) el.value = _pmBpm;
}
function pmSetVol(v01) {
  _pmVol = Math.max(0, Math.min(1, v01));
  localStorage.setItem('yss:pmVol', String(_pmVol));
  if (_pmGain) _pmGain.gain.value = _pmVol;
}
function pmTap() {
  // 마지막 탭에서 2초 넘게 지나면(딴 데 갔다 온 것) 새로 센다. 최근 몇 번만 평균 내서
  // 손 떨림 한두 번에 확 튀지 않게 한다.
  const now = performance.now();
  if (_pmTapTimes.length && now - _pmTapTimes[_pmTapTimes.length - 1] > 2000) _pmTapTimes = [];
  _pmTapTimes.push(now);
  if (_pmTapTimes.length > 6) _pmTapTimes.shift();
  if (_pmTapTimes.length >= 2) {
    const gaps = [];
    for (let i = 1; i < _pmTapTimes.length; i++) gaps.push(_pmTapTimes[i] - _pmTapTimes[i - 1]);
    const avgMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    pmSetBpm(60000 / avgMs);
  }
}

// ── 튜너 ──
// 스튜디오 튜너는 엔진(JUCE, ASIO)이 분석한 pitch 를 IPC 로 보내주는 방식이다. 독립
// 마이크 캡처(getUserMedia+자기상관)로 따로 구현해봤지만 ASIO 오인페가 배타 모드로 열려
// 있으면 getUserMedia 가 신호를 못 받는 경우가 있어서, 같은 엔진 pitch 이벤트를 그대로
// 받는 쪽으로 되돌렸다 — 그래서 오디오 엔진이 켜져 있어야만 쓸 수 있고, 꺼져 있으면
// 안내 문구 + 스튜디오로 이동 버튼만 보여준다.
// 노트/센트 계산과 바늘 보간 공식은 스튜디오 튜너와 동일(studio.js updateTuner/tunerRAF 참고)
// — 같은 악기를 스튜디오에서 재던 트레이닝에서 재던 눈금이 똑같이 읽혀야 하니까.
const TUN_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
let _engineOn = false, _tunToolActive = false, _tunRAF = null;
let _tunRef = Number(localStorage.getItem('yss:tunerRef')) || 440;
let _tunNeedle = 50, _tunTarget = 50, _tunSmoothBuf = [], _tunLastHit = 0;

function tunRAFStep() {
  const needle = $('trn-tuner-needle');
  if (needle) {
    const d = _tunTarget - _tunNeedle;
    _tunNeedle += d * 0.22;
    if (Math.abs(d) < 0.05) _tunNeedle = _tunTarget;
    needle.style.transform = `translateX(-50%) translateX(${((_tunNeedle - 50) * 0.01) * (needle.parentElement?.clientWidth || 200)}px)`;
  }
  _tunRAF = requestAnimationFrame(tunRAFStep);
}
function tunUpdateUI(freq) {
  const noteEl = $('trn-tuner-note'), needle = $('trn-tuner-needle'), centsEl = $('trn-tuner-cents');
  if (!noteEl) return;
  const octEl = $('trn-tuner-oct'), freqEl = $('trn-tuner-freq'), flat = $('trn-tuner-flat'), sharp = $('trn-tuner-sharp');
  const card = $('tool-trn-tuner');
  if (!freq || freq < 25) {
    _tunSmoothBuf.length = 0;
    if (Date.now() - _tunLastHit > 900) {
      noteEl.textContent = '—'; if (octEl) octEl.textContent = ''; centsEl.textContent = '—'; if (freqEl) freqEl.textContent = '';
      flat && flat.classList.remove('on'); sharp && sharp.classList.remove('on');
      card && card.classList.remove('in-tune');
      needle && needle.classList.remove('in-tune');
      _tunTarget = 50;
    }
    return;
  }
  _tunLastHit = Date.now();
  _tunSmoothBuf.push(freq); if (_tunSmoothBuf.length > 5) _tunSmoothBuf.shift();
  const sorted = [..._tunSmoothBuf].sort((a, b) => a - b);
  const f = sorted[sorted.length >> 1];

  const n = 69 + 12 * Math.log2(f / _tunRef);
  const nearest = Math.round(n);
  const cents = (n - nearest) * 100;
  const name = TUN_NOTE_NAMES[((nearest % 12) + 12) % 12];
  const oct = Math.floor(nearest / 12) - 1;
  noteEl.textContent = name;
  if (octEl) octEl.textContent = oct;
  const inTune = Math.abs(cents) <= 4;
  noteEl.classList.toggle('in-tune', inTune);
  card && card.classList.toggle('in-tune', inTune);
  centsEl.textContent = (cents > 0 ? '+' : '') + cents.toFixed(0) + '¢';
  if (freqEl) freqEl.textContent = f.toFixed(1) + ' Hz';
  flat && flat.classList.toggle('on', cents < -4);
  sharp && sharp.classList.toggle('on', cents > 4);
  needle.classList.toggle('in-tune', inTune);
  _tunTarget = Math.max(0, Math.min(100, 50 + cents));
}
function tunResetDisplay() {
  const noteEl = $('trn-tuner-note'), octEl = $('trn-tuner-oct'), centsEl = $('trn-tuner-cents'), freqEl = $('trn-tuner-freq');
  if (noteEl) noteEl.textContent = '—';
  if (octEl) octEl.textContent = '';
  if (centsEl) centsEl.textContent = '—';
  if (freqEl) freqEl.textContent = '';
  $('tool-trn-tuner')?.classList.remove('in-tune');
  $('trn-tuner-needle')?.classList.remove('in-tune');
  _tunTarget = 50; _tunNeedle = 50;
  const needle = $('trn-tuner-needle'); if (needle) needle.style.transform = 'translateX(-50%) translateX(0px)';
  _tunSmoothBuf.length = 0;
}
function tunSetRef(hz) {
  _tunRef = hz; localStorage.setItem('yss:tunerRef', String(hz));
  document.querySelectorAll('#trn-tuner-ref button').forEach(b => b.classList.toggle('on', Number(b.dataset.hz) === hz));
  _tunSmoothBuf.length = 0;
}
function tunRenderAvailability() {
  const card = $('tool-trn-tuner'), notice = $('trn-tuner-notice');
  if (card) card.hidden = !_engineOn;
  if (notice) notice.hidden = _engineOn;
}
function tunActivate() {
  if (_tunRAF) return;
  api?.engine?.tuner(true);
  _tunRAF = requestAnimationFrame(tunRAFStep);
}
function tunDeactivate() {
  if (_tunRAF) { cancelAnimationFrame(_tunRAF); _tunRAF = null; api?.engine?.tuner(false); }
  tunResetDisplay();
}
// 다른 도구로 넘어갈 때(showTool)와 엔진 상태가 바뀔 때(onEvent, 화면에 없어도 이벤트는
// 계속 온다) 양쪽에서 호출 — 지금 튜너 도구가 열려 있는지(_tunToolActive)와 엔진이
// 켜져 있는지(_engineOn)를 조합해 안내문/카드 표시와 pitch 분석 on/off 를 맞춘다.
function tunEnter() {
  _tunToolActive = true;
  tunRenderAvailability();
  if (_engineOn) tunActivate();
}
function tunLeave() {
  _tunToolActive = false;
  tunDeactivate();
}
function tunOnEngineChange() {
  tunRenderAvailability();
  if (_tunToolActive) { if (_engineOn) tunActivate(); else tunDeactivate(); }
}
let _engineReadyWaiters = [];
api?.engine?.onEvent((m) => {
  if (m.ev === 'ready') { _engineOn = true; tunOnEngineChange(); fbOnEngineChange(); _engineReadyWaiters.splice(0).forEach(r => r()); }
  else if (m.ev === 'exit') { _engineOn = false; tunOnEngineChange(); fbOnEngineChange(); }
  else if (m.ev === 'pitch' && _tunToolActive) tunUpdateUI(m.freq);
  else if (m.ev === 'pitch' && _fbSession?.cfg?.quizMode === 'play' && _fbSession.awaitingAnswer) fbOnPitch(m.freq);
});
function waitEngineReady(timeoutMs) {
  if (_engineOn) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(_engineOn), timeoutMs);
    _engineReadyWaiters.push(() => { clearTimeout(t); resolve(true); });
  });
}

// ── 지판 암기 ──
// 프렛보드 음이름 암기 트레이너. 네 모드: 보고 맞히기(see, 한 자리 보고 음이름 맞히기)/듣고
// 찾기(hear, 음이름 듣고 자리 하나 찾기)/스케일 찾기(scale, 매 문제마다 근음을 무작위로
// 바꿔가며 그 스케일에 속하는 음을 전부 골라 확인)는 오디오와 무관하고, 실전 연주 인식(play)
// 만 튜너와 같은 엔진 pitch 이벤트를 재사용해 실제로 그 자리를 연주하는지 확인한다(그래서
// 엔진이 꺼져 있으면 play 모드일 때만 안내 화면으로 대체된다) — "연주" 자체가 의미 없는
// 스케일 찾기는 이 모드 대상에서 뺀다. 정답률은 위치별로 fretboardStats.json 에 영구
// 저장해서, 약한 자리가 다음에도 더 자주 나오게 가중치를 준다(스케일 찾기는 한 문제에 정답
// 위치가 여럿이라 이 위치별 통계 대상에서는 제외한다).
const FB_INSTRUMENTS = {
  guitar6: { strings: [40, 45, 50, 55, 59, 64], fretMaxCap: 22, defaultFretMax: 12 }, // E2 A2 D3 G3 B3 E4
  bass4:   { strings: [28, 33, 38, 43],         fretMaxCap: 20, defaultFretMax: 12 }, // E1 A1 D2 G2
  bass5:   { strings: [23, 28, 33, 38, 43],     fretMaxCap: 20, defaultFretMax: 12 }, // B0 E1 A1 D2 G2
};
const FB_NOTE_NAMES = TUN_NOTE_NAMES; // 튜너와 표기를 통일(샵만, 자연음 필터로 온음 구분)
const FB_NATURAL_IDX = new Set([0, 2, 4, 5, 7, 9, 11]); // C D E F G A B
const FB_SCALES = {
  major:      { intervals: [0, 2, 4, 5, 7, 9, 11] },
  minor:      { intervals: [0, 2, 3, 5, 7, 8, 10] },
  majorPenta: { intervals: [0, 2, 4, 7, 9] },
  minorPenta: { intervals: [0, 3, 5, 7, 10] },
};

let _fbStats = { positions: {} };
const fbStatsReady = (async () => {
  try {
    const d = await api?.fretboard?.load();
    if (d?.positions && typeof d.positions === 'object') _fbStats.positions = d.positions;
  } catch { /* 파일이 없거나 깨졌으면 빈 상태로 시작 */ }
})();
function fbPersistStats() { fbStatsReady.then(() => api?.fretboard?.save(_fbStats)); }

function fbClampInt(v, min, max, fallback) {
  // localStorage.getItem() 은 값이 없으면 null 을 주는데 Number(null) === 0(유한수) 이라
  // 아래 isFinite 체크를 그냥 통과해버린다 — 그러면 "기본값 없음" 이 "0으로 클램프" 로
  // 둔갑해서, 처음 켠 앱에서 프렛 범위가 0~0, 세션 길이가 5(문항수 최소값)로 나온다.
  if (v === null || v === undefined || v === '') return fallback;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

let _fbInstrument = FB_INSTRUMENTS[localStorage.getItem('yss:fbInstrument')] ? localStorage.getItem('yss:fbInstrument') : 'guitar6';
let _fbFretMin = fbClampInt(localStorage.getItem('yss:fbFretMin'), 0, FB_INSTRUMENTS[_fbInstrument].fretMaxCap, 0);
let _fbFretMax = fbClampInt(localStorage.getItem('yss:fbFretMax'), 0, FB_INSTRUMENTS[_fbInstrument].fretMaxCap, FB_INSTRUMENTS[_fbInstrument].defaultFretMax);
if (_fbFretMax < _fbFretMin) _fbFretMax = _fbFretMin;
let _fbStrings = (() => {
  try {
    const arr = JSON.parse(localStorage.getItem('yss:fbStrings') || 'null');
    if (Array.isArray(arr) && arr.length) return arr.filter((i) => i >= 0 && i < FB_INSTRUMENTS[_fbInstrument].strings.length);
  } catch { /* 무시 — 아래 기본값으로 */ }
  return FB_INSTRUMENTS[_fbInstrument].strings.map((_, i) => i);
})();
let _fbNaturalsOnly = localStorage.getItem('yss:fbNaturalsOnly') === '1';
let _fbSessionMode = localStorage.getItem('yss:fbSessionMode') === 'timed' ? 'timed' : 'count';
let _fbSessionValue = fbClampInt(localStorage.getItem('yss:fbSessionValue'), 5, 600, _fbSessionMode === 'timed' ? 120 : 20);
let _fbQuizMode = ['see', 'hear', 'scale', 'play'].includes(localStorage.getItem('yss:fbQuizMode')) ? localStorage.getItem('yss:fbQuizMode') : 'see';
let _fbScaleType = FB_SCALES[localStorage.getItem('yss:fbScaleType')] ? localStorage.getItem('yss:fbScaleType') : 'major';
let _fbScaleBox = localStorage.getItem('yss:fbScaleBox') === '1';

let _fbScreen = 'config'; // 'config' | 'quiz' | 'summary'
let _fbSession = null;    // null = 설정 화면, 세션 시작하면 _fbCfgSnapshot() 을 고정해 담는다
let _fbTimerInterval = null;
let _fbPlayListening = false;
let _fbPlaySmoothBuf = [], _fbPlayStableHits = 0, _fbPlayLastMidi = null;
let _fbPlayTimeout = null;

function fbCfgSnapshot() {
  return {
    instrument: _fbInstrument,
    fretMin: _fbFretMin, fretMax: _fbFretMax,
    strings: _fbStrings.slice(),
    naturalsOnly: _fbNaturalsOnly,
    sessionMode: _fbSessionMode, sessionValue: _fbSessionValue,
    quizMode: _fbQuizMode, scaleType: _fbScaleType, scaleBox: _fbScaleBox,
  };
}
function fbCandidatePositions(cfg) {
  const inst = FB_INSTRUMENTS[cfg.instrument];
  const out = [];
  for (const s of cfg.strings) {
    if (s < 0 || s >= inst.strings.length) continue;
    for (let fret = cfg.fretMin; fret <= cfg.fretMax; fret++) {
      const midi = inst.strings[s] + fret;
      const pc = ((midi % 12) + 12) % 12;
      if (cfg.naturalsOnly && !FB_NATURAL_IDX.has(pc)) continue;
      out.push({ stringIdx: s, fret, midi, pc, noteName: FB_NOTE_NAMES[pc], key: `${cfg.instrument}:${s}:${fret}` });
    }
  }
  return out;
}
// 정답률이 낮은 자리일수록 훨씬 자주 뽑히게(간격반복 라이트) — 세션을 넘어 누적된
// _fbStats 기준이라 여러 세션에 걸쳐서도 약점이 계속 우선 출제된다.
function fbWeightOf(pos) {
  const rec = _fbStats.positions[pos.key];
  if (!rec || !rec.attempts) return 1.6; // 미출제 위치는 살짝 우대해 커버리지를 넓힌다
  const acc = rec.correct / rec.attempts;
  return 1 + 4 * Math.pow(1 - acc, 2);
}
function fbPickNext(session) {
  const full = fbCandidatePositions(session.cfg);
  // 후보가 몇 개 안 되면(범위를 좁게 잡은 경우) 직전 반복 방지 필터가 약점 가중치를
  // 통째로 눌러버린다 — 후보 2~3개짜리에서 "직전 것만 빼고" 를 적용하면 사실상 강제
  // 교대가 돼서 가중 재출제가 무력화된다. 후보가 충분히 많을 때만 필터를 건다.
  let pool = full.length > 4 ? full.filter((p) => !session.recentKeys.includes(p.key)) : full;
  if (!pool.length) pool = full;
  if (!pool.length) return null;
  const weights = pool.map(fbWeightOf);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) { r -= weights[i]; if (r <= 0) return pool[i]; }
  return pool[pool.length - 1];
}
function fbNoteChoicesPool(cfg) {
  const idxs = cfg.naturalsOnly ? [...FB_NATURAL_IDX] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  return idxs.map((i) => FB_NOTE_NAMES[i]);
}
function fbShuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
// 스케일 찾기 — 근음(rootPc)을 문제마다 무작위로 바꿔가며, 그 스케일에 속하는 음이름을
// 가진 자리를 전부 모은다. naturalsOnly 는 여기선 안 따진다(스케일 소속 여부 자체가 이미
// 음 종류를 정해주니까). 위치별 정답률(fbWeightOf/fbPickNext) 은 문제 하나에 정답 위치가
// 여럿이라 안 맞아서, 스케일 모드는 그 통계 대상에서 뺀다.
const FB_SCALE_LABEL_KEY = {
  major: 'training.fb.scaleMajor', minor: 'training.fb.scaleMinor',
  majorPenta: 'training.fb.scaleMajorPenta', minorPenta: 'training.fb.scaleMinorPenta',
};
function fbScaleCorrectSet(cfg, rootPc, scaleKey, fretMin, fretMax) {
  const pcSet = new Set(FB_SCALES[scaleKey].intervals.map((iv) => (rootPc + iv) % 12));
  const inst = FB_INSTRUMENTS[cfg.instrument];
  const set = new Set();
  for (const s of cfg.strings) {
    for (let fret = fretMin; fret <= fretMax; fret++) {
      const pc = ((inst.strings[s] + fret) % 12 + 12) % 12;
      if (pcSet.has(pc)) set.add(`${s}:${fret}`);
    }
  }
  return set;
}
function fbPickScaleRoot(session) {
  let root = Math.floor(Math.random() * 12);
  if (session.lastScaleRoot != null && root === session.lastScaleRoot) root = (root + 1 + Math.floor(Math.random() * 11)) % 12;
  return root;
}
// "포지션 박스 단위" 옵션 — 넥 전체(설정한 프렛 범위 전체)에서 스케일 음을 한꺼번에 찾게
// 하면 자리가 많아서(특히 범위를 넓게 잡으면) 한눈에 안 들어온다. 켜면 매 문제마다 고정폭
// (한 손 포지션에 흔히 들어가는 4프렛)짜리 구간을 무작위로 골라 그 안에서만 찾게 한다.
// CAGED 처럼 스케일 타입별로 정확한 손모양 박스를 정의하진 않는다(기타 전용이 되고, 베이스엔
// 안 맞는다) — 대신 악기 무관하게 넥을 기계적으로 잘라 쓰는 더 단순하고 범용적인 방식.
const FB_SCALE_BOX_WIDTH = 4;
function fbPickScaleBoxRange(cfg) {
  const span = cfg.fretMax - cfg.fretMin + 1;
  if (span <= FB_SCALE_BOX_WIDTH) return { boxMin: cfg.fretMin, boxMax: cfg.fretMax };
  const maxStart = cfg.fretMax - FB_SCALE_BOX_WIDTH + 1;
  const boxMin = cfg.fretMin + Math.floor(Math.random() * (maxStart - cfg.fretMin + 1));
  return { boxMin, boxMax: boxMin + FB_SCALE_BOX_WIDTH - 1 };
}

// ── 프렛보드 다이어그램(SVG) ──
// 실제 프렛 간격(x_n = L·(1-1/2^(n/12)))으로 그려야 지판처럼 보인다 — DOM 그리드로는
// 이 비선형 간격을 못 낸다. 설정 범위 밖 프렛/현은 지우지 않고 흐리게만 표시해서
// 전체 넥 안에서의 위치 감각을 유지한다. 최저음 현(stringIdx 0)을 위쪽에 그린다
// (실제로 기타/베이스를 들고 내려다볼 때 보이는 배치).
function fbFretX(n, neckFrets, width) {
  const scale = (fret) => 1 - Math.pow(2, -fret / 12);
  const full = scale(neckFrets) || 1;
  return (scale(n) / full) * width;
}
function fbRenderDiagram(target, opts = {}) {
  const container = $('fb-diagram');
  if (!container || !_fbSession) return;
  const cfg = _fbSession.cfg;
  const inst = FB_INSTRUMENTS[cfg.instrument];
  const neckFrets = Math.max(cfg.fretMax, 12);
  const W = 640, padL = 26, padR = 26, padT = 20, padB = 26;
  const innerW = W - padL - padR;
  const stringGap = 34;
  const H = padT + padB + stringGap * (inst.strings.length - 1);
  const midOf = (f) => padL + (fbFretX(f, neckFrets, innerW) + fbFretX(f - 1, neckFrets, innerW)) / 2;

  let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">`;
  svg += `<rect class="fret-neck-bg" x="0" y="0" width="${W}" height="${H}" rx="8"></rect>`;
  // 포지션 박스(스케일 찾기, "박스 단위" 옵션) — 넥 배경 위, 프렛/음표 점들 아래에 반투명
  // 사각형으로 이번 문제가 어느 구간인지 눈에 띄게 표시한다.
  if (opts.mode === 'scale' && opts.boxMin != null) {
    const bx1 = opts.boxMin <= 0 ? 0 : padL + fbFretX(opts.boxMin - 1, neckFrets, innerW);
    const bx2 = padL + fbFretX(opts.boxMax, neckFrets, innerW);
    svg += `<rect class="fret-box" x="${bx1}" y="${padT - 14}" width="${bx2 - bx1}" height="${H - padT - padB + 28}" rx="6"></rect>`;
  }
  for (let f = 0; f <= neckFrets; f++) {
    const x = padL + fbFretX(f, neckFrets, innerW);
    svg += `<line class="${f === 0 ? 'fret-nut' : 'fret-line'}" x1="${x}" y1="${padT - 10}" x2="${x}" y2="${H - padB + 10}"></line>`;
    if (f > 0 && [3, 5, 7, 9, 12, 15, 17, 19, 21].includes(f)) {
      svg += `<circle class="fret-inlay" cx="${midOf(f)}" cy="${H - 8}" r="3"></circle>`;
      svg += `<text class="fret-fretnum" x="${midOf(f)}" y="${padT - 12}" text-anchor="middle">${f}</text>`;
    }
  }
  // TAB 표기 관례: 맨 위 줄이 1번 현(가장 가는/높은 음 현), 아래로 갈수록 번호가 커진다.
  // 내부 stringIdx 는 그대로 FB_INSTRUMENTS.strings 배열 순서(낮은음→높은음, 0=최저음)를
  // 쓴다 — 데이터 모델/통계 키는 안 건드리고 그리는 위치와 번호 라벨만 뒤집는다.
  const nStrings = inst.strings.length;
  inst.strings.forEach((openMidi, sIdx) => {
    const y = padT + (nStrings - 1 - sIdx) * stringGap;
    const enabled = cfg.strings.includes(sIdx);
    svg += `<text class="fret-stringnum" x="13" y="${y + 4}" text-anchor="middle">${nStrings - sIdx}</text>`;
    svg += `<line class="fret-string-line${enabled ? '' : ' off'}" x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}"></line>`;
    for (let f = 0; f <= neckFrets; f++) {
      const x = f === 0 ? padL : midOf(f);
      const inRange = enabled && f >= cfg.fretMin && f <= cfg.fretMax;
      const key = `${sIdx}:${f}`;
      let cls = 'fret-pos-dot';
      if (opts.mode === 'scale') {
        const outOfBox = opts.boxMin != null && (f < opts.boxMin || f > opts.boxMax);
        if (!inRange || outOfBox) cls += ' dim';
        const isCorrect = !!opts.correctSet?.has(key);
        const isSelected = !!opts.selected?.has(key);
        if (opts.submitted) {
          if (isSelected && isCorrect) cls += ' correct';
          else if (isSelected && !isCorrect) cls += ' wrong';
          else if (isCorrect) cls += ' target'; // 선택 안 했는데 정답이던 자리(놓침)
        } else if (isSelected) {
          cls += ' selected';
        }
      } else {
        const isTarget = !!(opts.reveal && target && target.stringIdx === sIdx && target.fret === f);
        const isResult = !!opts.resultKeys?.includes(key);
        // 결과 표시 자리는 설정 범위(꺼둔 현 등) 밖이라도 흐리게 죽이지 않는다 — 실제로
        // 거기서 연주했다는 사실 자체가 중요한 정보라(특히 실전 연주 인식 모드).
        if (!inRange && !isResult) cls += ' dim';
        if (isResult) cls += opts.resultCorrect ? ' correct' : ' wrong';
        else if (isTarget) cls += ' target';
      }
      svg += `<g class="fret-pos" data-string="${sIdx}" data-fret="${f}"><circle class="${cls}" cx="${x}" cy="${y}" r="9"></circle></g>`;
    }
  });
  svg += '</svg>';
  container.innerHTML = svg;
}

function fbRenderStringToggles() {
  const box = $('fb-strings');
  if (!box) return;
  const inst = FB_INSTRUMENTS[_fbInstrument];
  box.innerHTML = inst.strings.map((openMidi, i) => {
    const label = FB_NOTE_NAMES[((openMidi % 12) + 12) % 12];
    return `<button class="fb-string-toggle${_fbStrings.includes(i) ? ' on' : ''}" type="button" data-idx="${i}">${label}</button>`;
  }).join('');
}
function fbSetInstrument(id) {
  if (!FB_INSTRUMENTS[id] || id === _fbInstrument) return;
  _fbInstrument = id;
  localStorage.setItem('yss:fbInstrument', id);
  const inst = FB_INSTRUMENTS[id];
  _fbFretMax = Math.min(_fbFretMax, inst.fretMaxCap);
  if (_fbFretMax < _fbFretMin) { _fbFretMin = 0; _fbFretMax = inst.defaultFretMax; }
  _fbStrings = inst.strings.map((_, i) => i); // 악기가 바뀌면 전체 현으로 리셋
  localStorage.setItem('yss:fbStrings', JSON.stringify(_fbStrings));
  localStorage.setItem('yss:fbFretMin', String(_fbFretMin));
  localStorage.setItem('yss:fbFretMax', String(_fbFretMax));
  const minInput = $('fb-fret-min'), maxInput = $('fb-fret-max');
  if (minInput) { minInput.max = String(inst.fretMaxCap); minInput.value = String(_fbFretMin); }
  if (maxInput) { maxInput.max = String(inst.fretMaxCap); maxInput.value = String(_fbFretMax); }
  fbRenderStringToggles();
}
function fbSetFretRange(min, max) {
  const cap = FB_INSTRUMENTS[_fbInstrument].fretMaxCap;
  min = fbClampInt(min, 0, cap, _fbFretMin);
  max = fbClampInt(max, 0, cap, _fbFretMax);
  if (min > max) { const tmp = min; min = max; max = tmp; }
  _fbFretMin = min; _fbFretMax = max;
  localStorage.setItem('yss:fbFretMin', String(min));
  localStorage.setItem('yss:fbFretMax', String(max));
  const minInput = $('fb-fret-min'), maxInput = $('fb-fret-max');
  if (minInput) minInput.value = String(min);
  if (maxInput) maxInput.value = String(max);
}
function fbToggleString(idx) {
  const i = _fbStrings.indexOf(idx);
  if (i >= 0) { if (_fbStrings.length <= 1) return; _fbStrings.splice(i, 1); }
  else _fbStrings.push(idx);
  localStorage.setItem('yss:fbStrings', JSON.stringify(_fbStrings));
  fbRenderStringToggles();
}
function fbSetNaturalsOnly(v) { _fbNaturalsOnly = !!v; localStorage.setItem('yss:fbNaturalsOnly', v ? '1' : '0'); }
function fbSetSessionMode(mode) {
  mode = mode === 'timed' ? 'timed' : 'count';
  if (mode === _fbSessionMode) return;
  const prevDefault = _fbSessionMode === 'timed' ? 120 : 20;
  _fbSessionMode = mode;
  localStorage.setItem('yss:fbSessionMode', mode);
  if (_fbSessionValue === prevDefault) fbSetSessionValue(mode === 'timed' ? 120 : 20);
}
function fbSetSessionValue(v) {
  _fbSessionValue = fbClampInt(v, 5, 600, _fbSessionValue);
  localStorage.setItem('yss:fbSessionValue', String(_fbSessionValue));
  const el = $('fb-session-value'); if (el) el.value = String(_fbSessionValue);
}
function fbSetQuizMode(mode) {
  if (!['see', 'hear', 'scale', 'play'].includes(mode)) return;
  _fbQuizMode = mode;
  localStorage.setItem('yss:fbQuizMode', mode);
  document.querySelectorAll('#fb-mode-tabs .fb-mode-tab').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
}
function fbSetScaleType(key) {
  if (!FB_SCALES[key]) return;
  _fbScaleType = key;
  localStorage.setItem('yss:fbScaleType', key);
}
function fbSetScaleBox(v) { _fbScaleBox = !!v; localStorage.setItem('yss:fbScaleBox', v ? '1' : '0'); }

function fbShowScreen(name) {
  const cfgEl = $('fb-config'), quizEl = $('fb-quiz'), sumEl = $('fb-summary'), noticeEl = $('fb-play-notice');
  const playBlocked = name === 'quiz' && _fbSession?.cfg?.quizMode === 'play' && !_engineOn;
  if (cfgEl) cfgEl.hidden = name !== 'config';
  if (quizEl) quizEl.hidden = !(name === 'quiz' && !playBlocked);
  if (sumEl) sumEl.hidden = name !== 'summary';
  if (noticeEl) noticeEl.hidden = !playBlocked;
}
function fbUpdateScoreUI() {
  if (!_fbSession) return;
  const s = $('fb-score'); if (s) s.textContent = `${_fbSession.score.correct}/${_fbSession.score.total}`;
  const st = $('fb-streak-num'); if (st) st.textContent = String(_fbSession.streak.current);
}
function fbShowFeedback(correct, noteName) {
  const el = $('fb-feedback'); if (!el) return;
  // noteName 이 없으면(스케일 모드 — 정답이 하나가 아니라 지판에 통째로 표시된다) 전용 문구.
  el.textContent = correct ? t('training.fb.feedbackCorrect')
    : (noteName ? t('training.fb.feedbackWrong', { note: noteName }) : t('training.fb.feedbackWrongScale'));
  el.classList.toggle('ok', correct);
  el.classList.toggle('bad', !correct);
}

function fbClearPlayTimeout() { if (_fbPlayTimeout) { clearTimeout(_fbPlayTimeout); _fbPlayTimeout = null; } }
function fbPlayEnter() {
  if (_fbPlayListening) return;
  _fbPlayListening = true;
  _fbPlaySmoothBuf.length = 0; _fbPlayStableHits = 0; _fbPlayLastMidi = null;
  api?.engine?.tuner(true);
}
function fbPlayExit() {
  if (!_fbPlayListening) return;
  _fbPlayListening = false;
  api?.engine?.tuner(false);
}
function fbOnPitch(freq) {
  if (!freq || freq < 25) { _fbPlayStableHits = 0; return; }
  _fbPlaySmoothBuf.push(freq); if (_fbPlaySmoothBuf.length > 5) _fbPlaySmoothBuf.shift();
  const sorted = [..._fbPlaySmoothBuf].sort((a, b) => a - b);
  const f = sorted[sorted.length >> 1];
  const midi = Math.round(69 + 12 * Math.log2(f / _tunRef));
  if (midi === _fbPlayLastMidi) _fbPlayStableHits++; else { _fbPlayLastMidi = midi; _fbPlayStableHits = 1; }
  if (_fbPlayStableHits < 2) return; // 프레임 하나로 오탐하지 않게 2연속 요구(레이턴시 감안)
  const target = _fbSession?.current;
  if (!target || !_fbSession.awaitingAnswer) return;
  // 자리가 아니라 음이름만 묻는 모드라(아래 fbNextQuestion 참고) 옥타브/현은 안 따지고
  // 음이름(pitch class)만 맞으면 정답 처리한다.
  const pc = ((midi % 12) + 12) % 12;
  if (pc !== target.pc) return; // 오답은 여기서 확정하지 않는다 — 다른 음을 계속 연주해보다 맞힐 수 있으니, 오답은 타임아웃에서만.
  // 어느 현을 짚었는지는 피치만으론 하나로 못 좁히지만(같은 음이 여러 현/프렛에 있을 수 있다),
  // 지금 연주한 정확한 음(옥타브 포함)과 일치하는 자리를 지판 위에서 전부 찾아 보여준다 —
  // 그중 하나가 실제로 짚은 자리다. 설정에서 꺼둔 현도 포함해서 찾는다(실제로 거기서 쳤을 수
  // 있으니까).
  const inst = FB_INSTRUMENTS[_fbSession.cfg.instrument];
  const neckFrets = Math.max(_fbSession.cfg.fretMax, 12);
  const keys = [];
  inst.strings.forEach((openMidi, sIdx) => {
    for (let fret = 0; fret <= neckFrets; fret++) {
      if (openMidi + fret === midi) keys.push(`${sIdx}:${fret}`);
    }
  });
  fbRecordResult(true, { keys, correct: true });
}
function fbOnEngineChange() {
  fbShowScreen(_fbScreen);
  if (_fbSession && _fbSession.cfg.quizMode === 'play') {
    if (_engineOn && _fbSession.awaitingAnswer) fbPlayEnter(); else fbPlayExit();
  }
}

function fbRecordResult(correct, diagramResult) {
  if (!_fbSession || !_fbSession.current || !_fbSession.awaitingAnswer) return;
  fbClearPlayTimeout();
  const target = _fbSession.current;
  const rec = _fbStats.positions[target.key] || (_fbStats.positions[target.key] = { attempts: 0, correct: 0, lastSeenAt: 0 });
  rec.attempts++; if (correct) rec.correct++;
  rec.lastSeenAt = Date.now();
  fbPersistStats();

  _fbSession.score.total++;
  if (correct) {
    _fbSession.score.correct++;
    _fbSession.streak.current++;
    _fbSession.streak.best = Math.max(_fbSession.streak.best, _fbSession.streak.current);
  } else {
    _fbSession.streak.current = 0;
  }
  _fbSession.awaitingAnswer = false;
  if (diagramResult) fbRenderDiagram(target, { reveal: true, resultKeys: diagramResult.keys, resultCorrect: diagramResult.correct });
  fbShowFeedback(correct, target.noteName);
  fbUpdateScoreUI();
  if (_fbSession.cfg.quizMode === 'play') fbPlayExit();
  setTimeout(() => { if (_fbSession) fbNextQuestion(); }, 700);
}
// 스케일 찾기 전용 — 정답 위치가 여러 개라 fbRecordResult(위치별 통계 대상 하나 가정) 와는
// 따로 둔다. fbStats(약점 재출제용 위치별 정답률)는 건드리지 않는다.
function fbRecordScaleResult(correct) {
  if (!_fbSession || !_fbSession.awaitingAnswer) return;
  _fbSession.awaitingAnswer = false;
  _fbSession.score.total++;
  if (correct) {
    _fbSession.score.correct++;
    _fbSession.streak.current++;
    _fbSession.streak.best = Math.max(_fbSession.streak.best, _fbSession.streak.current);
  } else {
    _fbSession.streak.current = 0;
  }
  fbShowFeedback(correct, null);
  fbUpdateScoreUI();
  // 시간제한 없이 지판에 표시된 정답을 원하는 만큼 들여다보다가, 준비되면 직접 "다음"을 누르게 한다.
  const nextBtn = $('fb-scale-next'); if (nextBtn) nextBtn.hidden = false;
  const skipBtn = $('fb-skip'); if (skipBtn) skipBtn.hidden = true; // 이 시점엔 건너뛸 문제가 없다 — "다음"으로 통일
}
function fbRenderChoices(target) {
  const box = $('fb-choices'); if (!box) return;
  const pool = fbShuffle(fbNoteChoicesPool(_fbSession.cfg).filter((n) => n !== target.noteName));
  const choices = fbShuffle([target.noteName, ...pool.slice(0, 3)]);
  box.innerHTML = choices.map((n) => `<button class="fb-choice-btn" type="button" data-note="${n}">${n}</button>`).join('');
}
function fbHandleSeeAnswer(name, btn) {
  if (!_fbSession || !_fbSession.awaitingAnswer || !_fbSession.current) return;
  const target = _fbSession.current;
  const correct = name === target.noteName;
  document.querySelectorAll('#fb-choices .fb-choice-btn').forEach((b) => {
    if (b.dataset.note === target.noteName) b.classList.add('correct');
    else if (b === btn && !correct) b.classList.add('wrong');
  });
  fbRecordResult(correct);
}
function fbHandleDiagramClick(e) {
  if (!_fbSession || !_fbSession.awaitingAnswer) return;
  const posEl = e.target.closest('.fret-pos');
  if (!posEl) return;
  const stringIdx = Number(posEl.dataset.string), fret = Number(posEl.dataset.fret);
  const cfg = _fbSession.cfg;
  if (!cfg.strings.includes(stringIdx) || fret < cfg.fretMin || fret > cfg.fretMax) return; // 흐리게 표시된 자리는 무시
  if (cfg.quizMode === 'hear') {
    const inst = FB_INSTRUMENTS[cfg.instrument];
    const midi = inst.strings[stringIdx] + fret;
    const noteName = FB_NOTE_NAMES[((midi % 12) + 12) % 12];
    const target = _fbSession.current;
    const correct = noteName === target.noteName;
    fbRecordResult(correct, { keys: [`${stringIdx}:${fret}`], correct });
  } else if (cfg.quizMode === 'scale') {
    const { boxMin, boxMax } = _fbSession.current;
    if (cfg.scaleBox && (fret < boxMin || fret > boxMax)) return; // 박스 밖은 이번 문제 대상이 아니다
    const key = `${stringIdx}:${fret}`;
    if (_fbSession.selected.has(key)) _fbSession.selected.delete(key); else _fbSession.selected.add(key);
    fbRenderDiagram(null, { mode: 'scale', selected: _fbSession.selected, correctSet: _fbSession.current.correctSet, submitted: false, boxMin: cfg.scaleBox ? boxMin : null, boxMax: cfg.scaleBox ? boxMax : null });
  }
}
function fbHandleScaleConfirm() {
  if (!_fbSession || _fbSession.cfg.quizMode !== 'scale' || !_fbSession.awaitingAnswer) return;
  const { correctSet, boxMin, boxMax } = _fbSession.current;
  const scaleBox = _fbSession.cfg.scaleBox;
  const selected = _fbSession.selected;
  let correct = selected.size === correctSet.size;
  if (correct) for (const k of selected) { if (!correctSet.has(k)) { correct = false; break; } }
  fbRenderDiagram(null, { mode: 'scale', selected, correctSet, submitted: true, boxMin: scaleBox ? boxMin : null, boxMax: scaleBox ? boxMax : null });
  const confirmBtn = $('fb-scale-confirm'); if (confirmBtn) confirmBtn.hidden = true;
  fbRecordScaleResult(correct);
}
function fbSkipQuestion() {
  if (!_fbSession || !_fbSession.awaitingAnswer) return;
  _fbSession.awaitingAnswer = false;
  fbClearPlayTimeout();
  fbPlayExit();
  const confirmBtn = $('fb-scale-confirm'); if (confirmBtn) confirmBtn.hidden = true;
  fbNextQuestion();
}

function fbNextQuestion() {
  if (!_fbSession) return;
  fbClearPlayTimeout();
  const cfg = _fbSession.cfg;
  if (cfg.sessionMode === 'count' && _fbSession.score.total >= cfg.sessionValue) { fbEndSession(); return; }
  if (cfg.sessionMode === 'timed' && Date.now() >= _fbSession.deadlineAt) { fbEndSession(); return; }

  const fb = $('fb-feedback'); if (fb) { fb.textContent = ''; fb.classList.remove('ok', 'bad'); }
  const choices = $('fb-choices'); if (choices) choices.innerHTML = '';
  const confirmBtn = $('fb-scale-confirm'); if (confirmBtn) confirmBtn.hidden = true;
  const nextBtn = $('fb-scale-next'); if (nextBtn) nextBtn.hidden = true;
  const skipBtn = $('fb-skip'); if (skipBtn) skipBtn.hidden = false;
  const prompt = $('fb-prompt');

  if (cfg.quizMode === 'scale') {
    const rootPc = fbPickScaleRoot(_fbSession);
    _fbSession.lastScaleRoot = rootPc;
    let boxMin = cfg.fretMin, boxMax = cfg.fretMax;
    if (cfg.scaleBox) ({ boxMin, boxMax } = fbPickScaleBoxRange(cfg));
    const correctSet = fbScaleCorrectSet(cfg, rootPc, cfg.scaleType, boxMin, boxMax);
    _fbSession.current = { rootPc, scaleKey: cfg.scaleType, correctSet, boxMin, boxMax };
    _fbSession.selected = new Set();
    _fbSession.awaitingAnswer = true;
    const root = FB_NOTE_NAMES[rootPc], scale = t(FB_SCALE_LABEL_KEY[cfg.scaleType]);
    if (prompt) prompt.textContent = cfg.scaleBox
      ? t('training.fb.promptScaleBox', { root, scale, from: boxMin, to: boxMax })
      : t('training.fb.promptScale', { root, scale });
    fbRenderDiagram(null, { mode: 'scale', selected: _fbSession.selected, correctSet, submitted: false, boxMin: cfg.scaleBox ? boxMin : null, boxMax: cfg.scaleBox ? boxMax : null });
    if (confirmBtn) confirmBtn.hidden = false;
    return;
  }

  const pos = fbPickNext(_fbSession);
  if (!pos) { fbEndSession(); return; } // 후보가 없음(설정 이상) — 방어적으로 종료
  _fbSession.current = pos;
  _fbSession.recentKeys.push(pos.key); if (_fbSession.recentKeys.length > 2) _fbSession.recentKeys.shift();
  _fbSession.awaitingAnswer = true;

  if (cfg.quizMode === 'see') {
    if (prompt) prompt.textContent = t('training.fb.promptSee');
    fbRenderDiagram(pos, { reveal: true });
    fbRenderChoices(pos);
  } else if (cfg.quizMode === 'hear') {
    if (prompt) prompt.textContent = t('training.fb.promptHear', { note: pos.noteName });
    fbRenderDiagram(pos, { reveal: false });
  } else {
    // 자리를 미리 보여주면 음이름을 안 떠올려도 그냥 따라 짚으면 되니 암기 훈련이 안 된다 —
    // 듣고 찾기처럼 음이름만 주고, 실제 연주로 맞는지 확인한다(자리는 숨김).
    if (prompt) prompt.textContent = t('training.fb.promptPlay', { note: pos.noteName });
    fbRenderDiagram(pos, { reveal: false });
    fbOnEngineChange();
    if (_engineOn) {
      _fbPlayTimeout = setTimeout(() => {
        if (_fbSession?.awaitingAnswer) fbRecordResult(false, { keys: [`${pos.stringIdx}:${pos.fret}`], correct: false });
      }, 10000);
    }
  }
}
function fbStartTimerUI() {
  fbStopTimerUI();
  if (_fbSession?.cfg?.sessionMode !== 'timed') return;
  _fbTimerInterval = setInterval(() => {
    if (!_fbSession) { fbStopTimerUI(); return; }
    if (Date.now() >= _fbSession.deadlineAt) fbEndSession();
  }, 1000);
}
function fbStopTimerUI() { if (_fbTimerInterval) { clearInterval(_fbTimerInterval); _fbTimerInterval = null; } }
function fbStartSession() {
  const cfg = fbCfgSnapshot();
  if (!cfg.strings.length || cfg.fretMax < cfg.fretMin) return; // 방어: 뭐라도 있어야 시작
  _fbSession = {
    cfg,
    score: { correct: 0, total: 0 },
    streak: { current: 0, best: 0 },
    startedAt: Date.now(),
    deadlineAt: cfg.sessionMode === 'timed' ? Date.now() + cfg.sessionValue * 1000 : null,
    current: null,
    recentKeys: [],
    lastScaleRoot: null,
    selected: null,
    awaitingAnswer: false,
  };
  _fbScreen = 'quiz';
  fbUpdateScoreUI();
  fbShowScreen('quiz');
  fbStartTimerUI();
  syncTrainingActivity();
  fbNextQuestion();
}
function fbEndSession() {
  fbClearPlayTimeout();
  fbStopTimerUI();
  fbPlayExit();
  const s = _fbSession;
  _fbScreen = 'summary';
  fbShowScreen('summary');
  if (s) {
    const pct = s.score.total ? Math.round((s.score.correct / s.score.total) * 100) : 0;
    const line = $('fb-summary-line');
    if (line) line.textContent = t('training.fb.summaryLine', { correct: s.score.correct, total: s.score.total, pct });
    const streak = $('fb-summary-streak');
    if (streak) streak.textContent = t('training.fb.summaryStreak', { n: s.streak.best });
  }
  _fbSession = null;
  syncTrainingActivity();
}
// showTool()/MutationObserver 에서 호출 — 세션 상태는 그대로 두고 화면만 다시 맞춘다
// (다른 도구로 갔다 와도 진행 중이던 세션이 안 사라진다). 실전 연주 인식은 엔진 리스닝만
// 붙였다 뗐다 한다(튜너와 같은 원칙).
function fbEnter() {
  fbRenderStringToggles();
  fbShowScreen(_fbScreen);
  if (_fbSession?.cfg?.quizMode === 'play' && _engineOn && _fbSession.awaitingAnswer) fbPlayEnter();
}
function fbLeave() { fbPlayExit(); }

// ── BPM 트레이너 ──
// 정해진 마디 수마다 템포가 자동으로 조금씩 빨라지는 연습 모드. 메트로놈과 같은 look-ahead
// 스케줄러 패턴(PM_LOOKAHEAD_MS/PM_SCHEDULE_AHEAD, 박 표시 점+세분화 눈금)을 그대로 따라
// 별도 상태로 하나 더 돌린다. 모든 컨트롤(시작/목표/증가량/증가주기/박자표/세분화)은
// 재생 중에도 값이 바뀌는 즉시 다음 스케줄 틱에 반영된다 — 스케줄러가 매번 module 상태를
// 새로 읽지, 재생 시작 시점 값을 캐시해 두지 않기 때문(연습 메트로놈과 같은 방식).
let _btStart = Number(localStorage.getItem('yss:btStart')) || 80;
let _btTarget = Number(localStorage.getItem('yss:btTarget')) || 140;
let _btStep = Number(localStorage.getItem('yss:btStep')) || 2;
let _btEvery = Number(localStorage.getItem('yss:btEvery')) || 2;
let _btSig = Number(localStorage.getItem('yss:btSig')) || 4;
let _btSubdiv = pmSubdivKey(localStorage.getItem('yss:btSubdiv'));
let _btVol = Number(localStorage.getItem('yss:btVol'));
if (!(_btVol >= 0 && _btVol <= 1)) _btVol = 0.6;
let _btCurBpm = _btStart, _btMeasureCount = 0, _btBeat = 0, _btSub = 0, _btPlaying = false;
let _btCtx = null, _btGain = null, _btTimer = null, _btNextTime = 0;

function btRenderBeats() { renderBeatDots('bt-beats', _btSig, _btSubdiv); }
function btFlashEl(el, holdMs) {
  if (!el) return;
  el.classList.add('active');
  clearTimeout(el._btFlashT);
  el._btFlashT = setTimeout(() => el.classList.remove('active'), holdMs);
}
function btFlashBeat(beatIdx, delayMs) {
  const hold = Math.min(140, (60000 / _btCurBpm) * 0.6);
  setTimeout(() => btFlashEl(document.querySelector(`#bt-beats .pm-beat-dot[data-beat="${beatIdx}"]`), hold), delayMs);
}
function btFlashTick(beatIdx, subIdx, delayMs) {
  const pattern = PM_SUBDIV_PATTERNS[_btSubdiv] || PM_SUBDIV_PATTERNS[1];
  const w = pattern[subIdx] ?? (1 / pattern.length);
  const hold = Math.min(90, w * (60000 / _btCurBpm) * 0.6);
  setTimeout(() => btFlashEl(document.querySelector(`#bt-beats .pm-beat-tick[data-beat="${beatIdx}"][data-sub="${subIdx}"]`), hold), delayMs);
}
function btUpdateBpmDisplay() {
  const el = $('bt-bpm-now'); if (el) el.textContent = _btCurBpm;
}
function btClick(time, kind, beatIdx, subIdx) {
  const osc = _btCtx.createOscillator();
  const g = _btCtx.createGain();
  osc.frequency.value = kind === 'accent' ? 1500 : kind === 'beat' ? 1000 : 650;
  const peak = kind === 'sub' ? 0.4 : (kind === 'accent' ? 1 : 0.6);
  const decay = kind === 'sub' ? 0.025 : 0.05;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  osc.connect(g); g.connect(_btGain);
  osc.start(time); osc.stop(time + 0.06);
  const delayMs = Math.max(0, (time - _btCtx.currentTime) * 1000);
  if (kind === 'sub') btFlashTick(beatIdx, subIdx, delayMs);
  else btFlashBeat(beatIdx, delayMs);
}
function btScheduler() {
  const pattern = PM_SUBDIV_PATTERNS[_btSubdiv] || PM_SUBDIV_PATTERNS[1];
  while (_btNextTime < _btCtx.currentTime + PM_SCHEDULE_AHEAD) {
    const isBeat = _btSub === 0;
    const isAccent = isBeat && _btBeat === 0;
    btClick(_btNextTime, isAccent ? 'accent' : isBeat ? 'beat' : 'sub', _btBeat, _btSub);
    _btNextTime += pattern[_btSub] * (60 / _btCurBpm);
    _btSub = (_btSub + 1) % pattern.length;
    if (_btSub === 0) {
      _btBeat = (_btBeat + 1) % _btSig;
      if (_btBeat === 0) {
        _btMeasureCount++;
        if (_btMeasureCount % _btEvery === 0 && _btCurBpm < _btTarget) {
          _btCurBpm = Math.min(_btTarget, _btCurBpm + _btStep);
          btUpdateBpmDisplay();
        }
      }
    }
  }
}
function btSetStart(v) {
  _btStart = Math.max(20, Math.min(300, Math.round(v) || 80));
  localStorage.setItem('yss:btStart', String(_btStart));
  const el = $('bt-start'); if (el) el.value = _btStart;
  if (_btPlaying) { _btCurBpm = _btStart; btUpdateBpmDisplay(); }   // 재생 중엔 "시작"을 바꾸면 그 템포로 바로 되돌아간다
}
function btSetTarget(v) {
  _btTarget = Math.max(20, Math.min(300, Math.round(v) || 140));
  localStorage.setItem('yss:btTarget', String(_btTarget));
  const el = $('bt-target'); if (el) el.value = _btTarget;
}
function btSetStep(v) { _btStep = Number(v) || 2; localStorage.setItem('yss:btStep', String(_btStep)); }
function btSetEvery(v) { _btEvery = Number(v) || 2; localStorage.setItem('yss:btEvery', String(_btEvery)); }
function btSetSig(v) {
  _btSig = Number(v) || 4;
  localStorage.setItem('yss:btSig', String(_btSig));
  _btBeat = 0;
  btRenderBeats();
}
function btSetSubdiv(v) {
  _btSubdiv = pmSubdivKey(v);
  localStorage.setItem('yss:btSubdiv', String(_btSubdiv));
  _btSub = 0;
  btRenderBeats();
}
function btSetVol(v01) {
  _btVol = Math.max(0, Math.min(1, v01));
  localStorage.setItem('yss:btVol', String(_btVol));
  if (_btGain) _btGain.gain.value = _btVol;
}
function btStart() {
  if (_btPlaying) return;
  if (!_btCtx) {
    _btCtx = new (window.AudioContext || window.webkitAudioContext)();
    _btGain = _btCtx.createGain();
    _btGain.gain.value = _btVol;
    _btGain.connect(_btCtx.destination);
  }
  if (_btCtx.state === 'suspended') _btCtx.resume();
  _btPlaying = true;
  _btCurBpm = _btStart; _btMeasureCount = 0; _btBeat = 0; _btSub = 0;
  btUpdateBpmDisplay();
  _btNextTime = _btCtx.currentTime + 0.05;
  _btTimer = setInterval(btScheduler, PM_LOOKAHEAD_MS);
  const btn = $('bt-playstop'); if (btn) { btn.classList.add('on'); btn.textContent = t('training.pm.stop'); }
  syncTrainingActivity();
}
function btStop() {
  if (!_btPlaying) return;
  _btPlaying = false;
  clearInterval(_btTimer); _btTimer = null;
  document.querySelectorAll('#bt-beats .pm-beat-dot, #bt-beats .pm-beat-tick').forEach(d => {
    clearTimeout(d._btFlashT); d.classList.remove('active');
  });
  const btn = $('bt-playstop'); if (btn) { btn.classList.remove('on'); btn.textContent = t('training.pm.start'); }
  syncTrainingActivity();
}

// 메트로놈·BPM 트레이너는 "재생 중이냐"로 실제 사용 여부를 바로 알 수 있어서, 열어만
// 두고 재생은 안 하는 동안은 연습 기록에 안 잡히게 한다(usage.js 의 idle 신호). 튜너·
// 연습 기록처럼 그렇게 판단하기 애매한 화면은 탭이 열려 있으면 그냥 사용중으로 친다.
function syncTrainingActivity() {
  const activeTool = document.querySelector('.training-nav-item.on')?.dataset.tool;
  if (activeTool === 'metro-practice') usageSetIdle(!_pmPlaying, 'training');
  else if (activeTool === 'bpm-trainer') usageSetIdle(!_btPlaying, 'training');
  else if (activeTool === 'fretboard') usageSetIdle(_fbScreen !== 'quiz', 'training');
  else usageSetIdle(false, 'training');
}

// ── 사이드바 도구 전환 ──
// home-nav 와 같은 패턴 — 다음 도구를 추가할 때 이 자리에 항목만 늘리면 되게 한다.
// 재생 중인 도구를 벗어나면 그 도구의 소리부터 끈다(동시에 두 도구가 울리면 안 되니까).
function showTool(name) {
  document.querySelectorAll('.training-nav-item[data-tool]').forEach(b =>
    b.classList.toggle('on', b.dataset.tool === name));
  document.querySelectorAll('.training-panel[data-tool]').forEach(p =>
    p.classList.toggle('on', p.dataset.tool === name));
  if (name !== 'metro-practice') pmStop();
  if (name !== 'bpm-trainer') btStop();
  if (name === 'tuner') tunEnter(); else tunLeave();
  if (name === 'fretboard') fbEnter(); else fbLeave();
  if (name === 'log') logEnter();
  syncTrainingActivity();
}

let _booted = false;
export function initTraining() {
  if (_booted) return;
  _booted = true;

  document.querySelector('.training-nav')?.addEventListener('click', (e) => {
    const nav = e.target.closest('.training-nav-item[data-tool]');
    if (nav) showTool(nav.dataset.tool);
  });

  const logGoalDailyEl = $('log-goal-daily'), logGoalMonthlyEl = $('log-goal-monthly');
  if (logGoalDailyEl) logGoalDailyEl.value = usageGetGoals().dailyMin;
  if (logGoalMonthlyEl) logGoalMonthlyEl.value = usageGetGoals().monthlyMin;
  logGoalDailyEl?.addEventListener('change', () => {
    usageSetGoals({ dailyMin: Math.max(0, Number(logGoalDailyEl.value) || 0) });
    logRenderMonth();   // 링이 일일 목표를 기준으로 그려지므로 다시 그린다
  });
  logGoalMonthlyEl?.addEventListener('change', () => {
    usageSetGoals({ monthlyMin: Math.max(0, Number(logGoalMonthlyEl.value) || 0) });
    logRenderMonthProgress();
  });

  logEnter();   // 연습 기록이 기본으로 열려 있는 도구라 첫 진입에도 바로 채워 둔다
  // usage.js 의 파일 로드는 비동기라, 이 시점엔 아직 안 끝났을 수 있다 — 끝나면
  // 목표값·달력을 한 번 더 정확하게 채운다(그 사이엔 빈 값으로 잠깐 보일 뿐, 안전).
  usageReady.then(() => {
    if (logGoalDailyEl) logGoalDailyEl.value = usageGetGoals().dailyMin;
    if (logGoalMonthlyEl) logGoalMonthlyEl.value = usageGetGoals().monthlyMin;
    if (document.querySelector('.training-nav-item.on')?.dataset.tool === 'log') logRenderMonth();
  });
  $('log-prev')?.addEventListener('click', () => {
    _logMonth--; if (_logMonth < 0) { _logMonth = 11; _logYear--; }
    logRenderMonth();
  });
  $('log-next')?.addEventListener('click', () => {
    _logMonth++; if (_logMonth > 11) { _logMonth = 0; _logYear++; }
    logRenderMonth();
  });
  $('log-grid')?.addEventListener('click', (e) => {
    const cell = e.target.closest('.log-cell:not(.empty)');
    if (!cell) return;
    document.querySelectorAll('.log-cell.sel').forEach(c => c.classList.remove('sel'));
    cell.classList.add('sel');
    logShowDetail(cell.dataset.date);
  });

  // 연습 기록 메모
  document.querySelector('.log-notes-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.log-notes-tab');
    if (!btn) return;
    document.querySelectorAll('.log-notes-tab').forEach(b => b.classList.toggle('on', b === btn));
    document.querySelectorAll('.log-notes-panel').forEach(p => { p.hidden = p.dataset.mode !== btn.dataset.mode; });
    if (btn.dataset.mode === 'all') renderAllNotes();
  });
  $('log-note-add')?.addEventListener('click', () => noteEditorOpen(null));
  $('log-note-cancel')?.addEventListener('click', noteEditorClose);
  $('log-note-save')?.addEventListener('click', noteEditorSave);
  $('log-note-delete')?.addEventListener('click', noteEditorDelete);
  const noteListClick = (list, e) => {
    const del = e.target.closest('.log-notes-item-del');
    if (del) { noteListDelete(list.find(x => x.id === del.dataset.id)); return; }
    const item = e.target.closest('.log-notes-item');
    if (item) { const n = list.find(x => x.id === item.dataset.id); if (n) noteEditorOpen(n); }
  };
  $('log-notes-daily-list')?.addEventListener('click', (e) => noteListClick(notesForDate(_logSelectedDate), e));
  $('log-notes-all-list')?.addEventListener('click', (e) => noteListClick(notesFilteredAll(), e));
  $('log-notes-search')?.addEventListener('input', () => { _notesSearch = $('log-notes-search').value; renderAllNotes(); });
  $('log-notes-period')?.addEventListener('change', () => {
    _notesPeriod = $('log-notes-period').value;
    $('log-notes-range').hidden = _notesPeriod !== 'custom';
    renderAllNotes();
  });
  $('log-notes-sort')?.addEventListener('change', () => { _notesSort = $('log-notes-sort').value; renderAllNotes(); });
  $('log-notes-from')?.addEventListener('change', () => { _notesFrom = $('log-notes-from').value; renderAllNotes(); });
  $('log-notes-to')?.addEventListener('change', () => { _notesTo = $('log-notes-to').value; renderAllNotes(); });
  notesReady.then(() => {
    notesRefreshVisible();
    // 달력 배지(메모 개수)도 로드 전엔 0으로 그려졌을 수 있다 — 로드 끝나면 다시 그린다.
    if (document.querySelector('.training-nav-item.on')?.dataset.tool === 'log') logRenderMonth();
  });

  const pmBpmEl = $('pm-bpm'), pmSigEl = $('pm-sig'), pmSubdivEl = $('pm-subdiv'), pmVolEl = $('pm-vol');
  if (pmBpmEl) pmBpmEl.value = _pmBpm;
  if (pmSigEl) pmSigEl.value = String(_pmSig);
  if (pmSubdivEl) pmSubdivEl.value = String(_pmSubdiv);
  if (pmVolEl) pmVolEl.value = String(Math.round(_pmVol * 100));
  pmRenderBeats();
  pmBpmEl?.addEventListener('change', () => pmSetBpm(Number(pmBpmEl.value) || 120));
  $('pm-bpm-dn5')?.addEventListener('click', () => pmSetBpm(_pmBpm - 5));
  $('pm-bpm-dn1')?.addEventListener('click', () => pmSetBpm(_pmBpm - 1));
  $('pm-bpm-up1')?.addEventListener('click', () => pmSetBpm(_pmBpm + 1));
  $('pm-bpm-up5')?.addEventListener('click', () => pmSetBpm(_pmBpm + 5));
  pmSigEl?.addEventListener('change', () => {
    _pmSig = Number(pmSigEl.value) || 4;
    localStorage.setItem('yss:pmSig', String(_pmSig));
    _pmBeat = 0;
    pmRenderBeats();
  });
  pmSubdivEl?.addEventListener('change', () => {
    _pmSubdiv = pmSubdivKey(pmSubdivEl.value);
    localStorage.setItem('yss:pmSubdiv', String(_pmSubdiv));
    _pmSub = 0;
    pmRenderBeats();
  });
  pmVolEl?.addEventListener('input', () => pmSetVol(Number(pmVolEl.value) / 100));
  $('pm-tap')?.addEventListener('click', pmTap);
  $('pm-playstop')?.addEventListener('click', () => { if (_pmPlaying) pmStop(); else pmStart(); });

  const tunRefBox = $('trn-tuner-ref');
  if (tunRefBox) {
    tunRefBox.querySelectorAll('button').forEach(b => b.addEventListener('click', () => tunSetRef(Number(b.dataset.hz))));
    tunSetRef(_tunRef);
  }
  tunRenderAvailability();
  $('trn-tuner-goto-studio')?.addEventListener('click', () => {
    document.querySelector('.tab[data-view="studio"]')?.click();
  });

  fbRenderStringToggles();
  const fbInstEl = $('fb-instrument'), fbMinEl = $('fb-fret-min'), fbMaxEl = $('fb-fret-max'),
        fbNaturalsEl = $('fb-naturals'), fbSessModeEl = $('fb-session-mode'), fbSessValEl = $('fb-session-value'),
        fbScaleTypeEl = $('fb-scale-type'), fbScaleBoxEl = $('fb-scale-box');
  if (fbInstEl) fbInstEl.value = _fbInstrument;
  if (fbMinEl) { fbMinEl.max = String(FB_INSTRUMENTS[_fbInstrument].fretMaxCap); fbMinEl.value = String(_fbFretMin); }
  if (fbMaxEl) { fbMaxEl.max = String(FB_INSTRUMENTS[_fbInstrument].fretMaxCap); fbMaxEl.value = String(_fbFretMax); }
  if (fbNaturalsEl) fbNaturalsEl.value = _fbNaturalsOnly ? '1' : '0';
  if (fbSessModeEl) fbSessModeEl.value = _fbSessionMode;
  if (fbSessValEl) fbSessValEl.value = String(_fbSessionValue);
  if (fbScaleTypeEl) fbScaleTypeEl.value = _fbScaleType;
  if (fbScaleBoxEl) fbScaleBoxEl.value = _fbScaleBox ? '1' : '0';
  document.querySelectorAll('#fb-mode-tabs .fb-mode-tab').forEach(b => b.classList.toggle('on', b.dataset.mode === _fbQuizMode));
  fbShowScreen(_fbScreen);

  fbInstEl?.addEventListener('change', () => fbSetInstrument(fbInstEl.value));
  fbMinEl?.addEventListener('change', () => fbSetFretRange(fbMinEl.value, fbMaxEl.value));
  fbMaxEl?.addEventListener('change', () => fbSetFretRange(fbMinEl.value, fbMaxEl.value));
  $('fb-strings')?.addEventListener('click', (e) => {
    const b = e.target.closest('.fb-string-toggle'); if (!b) return;
    fbToggleString(Number(b.dataset.idx));
  });
  fbNaturalsEl?.addEventListener('change', () => fbSetNaturalsOnly(fbNaturalsEl.value === '1'));
  fbSessModeEl?.addEventListener('change', () => fbSetSessionMode(fbSessModeEl.value));
  fbSessValEl?.addEventListener('change', () => fbSetSessionValue(fbSessValEl.value));
  fbScaleTypeEl?.addEventListener('change', () => fbSetScaleType(fbScaleTypeEl.value));
  fbScaleBoxEl?.addEventListener('change', () => fbSetScaleBox(fbScaleBoxEl.value === '1'));
  $('fb-mode-tabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('.fb-mode-tab'); if (!b) return;
    fbSetQuizMode(b.dataset.mode);
  });
  $('fb-start')?.addEventListener('click', fbStartSession);
  $('fb-end')?.addEventListener('click', () => { if (_fbSession) fbEndSession(); });
  $('fb-skip')?.addEventListener('click', fbSkipQuestion);
  $('fb-diagram')?.addEventListener('click', fbHandleDiagramClick);
  $('fb-choices')?.addEventListener('click', (e) => {
    const b = e.target.closest('.fb-choice-btn'); if (!b) return;
    fbHandleSeeAnswer(b.dataset.note, b);
  });
  $('fb-scale-confirm')?.addEventListener('click', fbHandleScaleConfirm);
  $('fb-scale-next')?.addEventListener('click', () => { if (_fbSession) fbNextQuestion(); });
  $('fb-summary-restart')?.addEventListener('click', () => { _fbScreen = 'config'; fbShowScreen('config'); fbStartSession(); });
  $('fb-summary-config')?.addEventListener('click', () => { _fbScreen = 'config'; fbShowScreen('config'); });
  $('fb-play-goto-studio')?.addEventListener('click', () => {
    document.querySelector('.tab[data-view="studio"]')?.click();
  });

  const btStartEl = $('bt-start'), btTargetEl = $('bt-target'), btStepEl = $('bt-step'), btEveryEl = $('bt-every'),
        btSigEl = $('bt-sig'), btSubdivEl = $('bt-subdiv'), btVolEl = $('bt-vol');
  if (btStartEl) btStartEl.value = _btStart;
  if (btTargetEl) btTargetEl.value = _btTarget;
  if (btStepEl) btStepEl.value = String(_btStep);
  if (btEveryEl) btEveryEl.value = String(_btEvery);
  if (btSigEl) btSigEl.value = String(_btSig);
  if (btSubdivEl) btSubdivEl.value = String(_btSubdiv);
  if (btVolEl) btVolEl.value = String(Math.round(_btVol * 100));
  btUpdateBpmDisplay();
  btRenderBeats();
  btStartEl?.addEventListener('change', () => btSetStart(Number(btStartEl.value)));
  btTargetEl?.addEventListener('change', () => btSetTarget(Number(btTargetEl.value)));
  btStepEl?.addEventListener('change', () => btSetStep(btStepEl.value));
  btEveryEl?.addEventListener('change', () => btSetEvery(btEveryEl.value));
  btSigEl?.addEventListener('change', () => btSetSig(btSigEl.value));
  btSubdivEl?.addEventListener('change', () => btSetSubdiv(btSubdivEl.value));
  btVolEl?.addEventListener('input', () => btSetVol(Number(btVolEl.value) / 100));
  $('bt-playstop')?.addEventListener('click', () => { if (_btPlaying) btStop(); else btStart(); });

  // 사이드바 안에서 도구를 바꿀 때는 showTool() 이 소리를 끄지만, 트레이닝 탭 자체를
  // 벗어날 때(다른 최상단 탭 클릭)는 그걸 호출하는 곳이 없다 — app.js 는 각 뷰의 hidden
  // 속성만 토글하지 뷰별 onLeave 훅이 없어서, 여기서 직접 그 속성 변화를 지켜본다.
  // 이게 없으면 메트로놈/BPM 트레이너가 화면 밖에서 계속 클릭을 내고, 튜너는 엔진 pitch
  // 분석을 계속 켜 둔 채로 남는다.
  const trainingView = document.querySelector('main[data-view="training"]');
  if (trainingView) {
    new MutationObserver(() => {
      if (trainingView.hidden) {
        pmStop(); btStop(); tunLeave(); fbLeave();
      } else {
        const activeTool = document.querySelector('.training-nav-item.on')?.dataset.tool;
        if (activeTool === 'tuner') tunEnter();   // 튜너는 재생 상태가 아니라 그냥 "보여주는" 도구라 돌아오면 바로 다시 켠다
        else if (activeTool === 'fretboard') fbEnter();
        syncTrainingActivity();
      }
    }).observe(trainingView, { attributes: true, attributeFilter: ['hidden'] });
  }
}
