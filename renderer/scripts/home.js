'use strict';
// 홈 — 로고를 누르면 오는 화면.
//
// 사이드바는 고정이고 오른쪽만 바뀐다. 홈 · 공지사항(게시판) · 업데이트 · 자주 묻는 질문.
// 읽기 전용이다. 커뮤니티(community.js)와 다르다: 로그인도, 글쓰기도, 댓글도 없다.
// 공지는 운영자가 D1 에 넣고 앱은 가져다 보여주기만 한다.

import { t, getLocale } from './i18n.js';
import { Library } from './library.js';

const API = 'https://ytseparator.com/community/api';
const CACHE_KEY = 'yss:notices';        // 오프라인·서버 지연에도 지난 공지는 보이게
const CACHE_TTL = 10 * 60 * 1000;       // 10분 안에 다시 열면 네트워크를 다시 타지 않는다

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

let booted = false;
let notices = [];                        // 마지막으로 받은 목록 — 상세 화면이 여기서 찾는다
let goView = null;                       // 탭 전환 — app.js 가 넘겨 준다

/** 공지 본문 — 굵게·링크·목록만 허용한다. 이스케이프가 먼저다. */
function renderBody(md) {
  const lines = esc(md).split('\n');
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push('<ul>' + list.map(x => `<li>${x}</li>`).join('') + '</ul>'); list = []; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (/^[-*]\s+/.test(line)) { list.push(line.replace(/^[-*]\s+/, '')); continue; }
    flush();
    if (line) out.push(`<p>${line}</p>`);
  }
  flush();
  let html = out.join('');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // 링크는 http(s) 만 — javascript: 같은 스킴이 끼어들 자리를 주지 않는다
  html = html.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+?)\)/g,
    (_m, text, href) => `<a href="${href}" data-ext="${href}">${text}</a>`);
  return html;
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

/** 최근 항목은 날짜보다 "얼마 전"이 읽기 쉽다. 일주일이 넘으면 날짜가 낫다. */
function fmtWhen(ms) {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return t('home.recent.today');
  if (days === 1) return t('home.recent.yesterday');
  if (days < 7) return t('home.recent.daysAgo', { n: days });
  return fmtDate(ms);
}

const kindLabel = (k) => t(k === 'tip' ? 'home.kind.tip' : k === 'update' ? 'home.kind.update' : 'home.kind.notice');
const isUpdate = (n) => n.kind === 'update';

// ── 그리기 ────────────────────────────────────────
const emptyBox = (key) => `<div class="notice-empty muted">${esc(t(key))}</div>`;

/** 홈의 공지 미리보기 — 최근 몇 개만, 본문 없이 */
function paintNoticePreview(list) {
  const box = $('home-notices');
  if (!box) return;
  const rows = list.filter(n => !isUpdate(n)).slice(0, 4);
  box.innerHTML = rows.length ? rows.map(n => `
    <button class="notice-row-btn" data-open="${esc(n.id)}">
      <span class="notice-kind k-${esc(n.kind)}${n.pinned ? ' pin' : ''}">${esc(kindLabel(n.kind))}</span>
      <b class="notice-title">${esc(n.title)}</b>
      <time class="notice-date">${esc(fmtDate(n.publishedAt))}</time>
    </button>`).join('') : emptyBox('home.notices.none');
}

/** 업데이트 이력 — 버전과 바뀐 점 */
function paintUpdates(list, boxId, limit) {
  const box = $(boxId);
  if (!box) return;
  const rows = list.filter(isUpdate).slice(0, limit);
  box.innerHTML = rows.length ? rows.map((n, i) => `
    <article class="upd">
      <div class="upd-ver">
        <b>${esc(n.title)}</b>
        ${i === 0 ? `<span class="upd-new">${esc(t('home.new'))}</span>` : ''}
        <time>${esc(fmtDate(n.publishedAt))}</time>
      </div>
      <div class="upd-body">${renderBody(n.body)}</div>
    </article>`).join('') : emptyBox('home.updates.none');
}

/** 공지 게시판 — 목록 */
function paintBoard(list) {
  const box = $('board-list');
  if (!box) return;
  const rows = list.filter(n => !isUpdate(n));
  box.innerHTML = rows.length ? rows.map(n => `
    <button class="board-row" data-open="${esc(n.id)}">
      <span class="notice-kind k-${esc(n.kind)}${n.pinned ? ' pin' : ''}">${esc(kindLabel(n.kind))}</span>
      <b>${esc(n.title)}</b>
      <time>${esc(fmtDate(n.publishedAt))}</time>
    </button>`).join('') : emptyBox('home.board.empty');
}

/** 공지 게시판 — 상세. 목록 자리를 대신 차지한다 */
function openDetail(id) {
  const n = notices.find(x => x.id === id);
  if (!n) return;
  $('detail-kind').textContent = kindLabel(n.kind);
  $('detail-kind').className = 'notice-kind k-' + n.kind + (n.pinned ? ' pin' : '');
  $('detail-title').textContent = n.title;
  $('detail-date').textContent = fmtDate(n.publishedAt);
  $('detail-body').innerHTML = renderBody(n.body);
  document.querySelector('.home-page[data-page="notices"] .board').hidden = true;
  $('board-detail').hidden = false;
  $('board-detail').scrollIntoView({ block: 'start' });
}

function closeDetail() {
  document.querySelector('.home-page[data-page="notices"] .board').hidden = false;
  $('board-detail').hidden = true;
}

/** 이어서 하기 — 라이브러리 최근 항목. 없으면 칸 자체를 숨긴다. */
async function paintRecent() {
  const panel = $('home-recent-panel');
  const box = $('home-recent');
  if (!panel || !box) return;
  let items = [];
  try { items = await window.yssApi?.library?.list?.() || []; } catch { items = []; }

  const rows = items.slice(0, 4);        // library:list 가 이미 최신 순으로 준다
  panel.hidden = rows.length === 0;
  if (!rows.length) { box.innerHTML = ''; return; }

  box.innerHTML = rows.map(it => {
    const thumb = it.meta && it.meta.thumbnail;
    return `
    <button class="recent-card" data-song="${esc(it.id)}" title="${esc(it.name || '')}">
      <span class="recent-thumb">
        <svg class="recent-ph" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 14v-4M8 17V7M12 20V4M16 17V7M20 14v-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        ${thumb ? `<img src="${esc(thumb)}" alt="" draggable="false" loading="lazy" />` : ''}
      </span>
      <b>${esc(it.name || t('home.recent.untitled'))}</b>
      <span class="recent-meta">
        <span class="recent-model">${esc(it.modelKey || '4stem')}</span>
        <time>${esc(fmtWhen(it.createdAt))}</time>
      </span>
    </button>`;
  }).join('');

  // CSP 가 인라인 핸들러를 막으므로 여기서 건다. 썸네일은 원격이라 못 받을 수 있고,
  // 깨진 그림 아이콘보다 빈 자리가 낫다.
  box.querySelectorAll('.recent-thumb img').forEach(img => {
    if (img.complete && img.naturalWidth) { img.classList.add('on'); return; }
    img.addEventListener('load',  () => img.classList.add('on'), { once: true });
    img.addEventListener('error', () => img.remove(), { once: true });
  });
}

/** 곡 하나를 라이브러리에서 연다 — 홈은 고르는 자리, 재생은 라이브러리 몫 */
async function openSong(id) {
  if (!goView) return;
  goView('library');
  try {
    await Library.refresh();             // 목록이 채워져야 selectItem 이 찾는다
    await Library.selectItem(id);
  } catch { /* 파일이 사라졌으면 라이브러리가 알아서 비워 보여 준다 */ }
}

function paintAll(list) {
  notices = list;
  paintNoticePreview(list);
  paintUpdates(list, 'home-updates', 3);
  paintUpdates(list, 'updates-full', 30);
  paintBoard(list);
}

// ── 자료 ──────────────────────────────────────────
function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return c && Array.isArray(c.notices) ? c : null;
  } catch { return null; }
}

async function loadNotices(force = false) {
  const cached = readCache();
  if (cached) paintAll(cached.notices);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return;

  try {
    const res = await fetch(`${API}/notices?lang=${encodeURIComponent(getLocale())}&limit=50`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data.notices) ? data.notices : [];
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), notices: list }));
    paintAll(list);
  } catch {
    // 못 가져오면 지난 공지를 그대로 둔다 — 아무것도 없을 때만 안내한다
    if (!cached) {
      for (const id of ['home-notices', 'home-updates', 'updates-full', 'board-list']) {
        if ($(id)) $(id).innerHTML = emptyBox('home.notices.failed');
      }
    }
  }
}

const FAQ_KEYS = ['offline', 'time', 'gpu', 'quality', 'where'];
function paintFaq() {
  const box = $('home-faq');
  if (!box) return;
  box.innerHTML = FAQ_KEYS.map(k => `
    <details class="faq">
      <summary>${esc(t('home.faq.' + k))}</summary>
      <div class="faq-a">${esc(t('home.faq.' + k + 'A'))}</div>
    </details>`).join('');
}

/** 히어로의 파형 — 장식이라 데이터가 아니라 고정 시드 난수로 그린다 */
function paintWave() {
  const box = $('home-wave');
  if (!box || box.childElementCount) return;
  const N = 68;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  box.innerHTML = Array.from({ length: N }, (_, i) => {
    const center = 1 - Math.abs(i - (N - 1) / 2) / ((N - 1) / 2);
    const h = Math.max(6, center ** 2.2 * 78 + rnd() * 16);
    return `<i style="height:${h.toFixed(1)}%;opacity:${(0.25 + center * 0.75).toFixed(2)}"></i>`;
  }).join('');
}

// ── 페이지 전환 ────────────────────────────────────
function showPage(name) {
  document.querySelectorAll('.home-nav-item[data-page]').forEach(b =>
    b.classList.toggle('on', b.dataset.page === name));
  document.querySelectorAll('.home-page').forEach(p =>
    p.classList.toggle('on', p.dataset.page === name));
  if (name === 'notices') closeDetail();     // 게시판은 항상 목록부터
  document.querySelector('.home-main')?.scrollTo({ top: 0 });
}

export function initHome(switchView) {
  if (typeof switchView === 'function') goView = switchView;
  // 홈에 다시 들어올 때마다 최근 목록은 새로 읽는다 — 그 사이 분리가 끝났을 수 있다
  if (booted) { loadNotices(); paintRecent(); return; }
  booted = true;

  const api = window.yssApi;
  paintWave();
  paintFaq();

  const root = document.querySelector('[data-view="home"]');

  // 사이드바 · "전체 보기" · 공지 열기 · 바깥 링크를 한자리에서 받는다
  root?.addEventListener('click', (e) => {
    const nav = e.target.closest('.home-nav-item[data-page]');
    if (nav) return showPage(nav.dataset.page);

    const goto = e.target.closest('[data-goto]');
    if (goto) return showPage(goto.dataset.goto);

    const song = e.target.closest('[data-song]');
    if (song) return void openSong(song.dataset.song);

    const view = e.target.closest('[data-view-go]');
    if (view) return void goView?.(view.dataset.viewGo);

    const open = e.target.closest('[data-open]');
    if (open) { showPage('notices'); openDetail(open.dataset.open); return; }

    const ext = e.target.closest('[data-ext]');
    if (ext) { e.preventDefault(); api?.openExternal?.(ext.dataset.ext); }
  });

  $('board-back')?.addEventListener('click', closeDetail);
  $('board-reload')?.addEventListener('click', () => loadNotices(true));
  $('home-all-releases')?.addEventListener('click', () =>
    api?.openExternal?.('https://github.com/whalemindbass/yt-separator-releases/releases'));
  $('home-contact')?.addEventListener('click', () => $('report-btn')?.click());

  // 버전은 설정 화면이 이미 보여 준다 — 여기서는 저작권 한 줄이면 되고, 그건 앱에 물어볼 것이 없다
  const c = $('home-copy');
  if (c) c.textContent = `© ${new Date().getFullYear()} Dr.studio`;

  loadNotices();
  paintRecent();
}

export { loadNotices };
