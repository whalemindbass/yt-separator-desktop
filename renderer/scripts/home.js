'use strict';
// 홈 — 로고를 누르면 오는 화면. 공지 · 업데이트 · 사용 가이드 · FAQ.
//
// 읽기 전용이다. 커뮤니티(community.js)와 다르다: 로그인도, 글쓰기도, 댓글도 없다.
// 공지는 운영자가 D1 에 넣고 앱은 가져다 보여주기만 한다.

import { t, getLocale } from './i18n.js';

const API = 'https://ytseparator.com/community/api';
const CACHE_KEY = 'yss:notices';        // 오프라인·서버 지연에도 지난 공지는 보이게
const CACHE_TTL = 10 * 60 * 1000;       // 10분 안에 다시 열면 네트워크를 다시 타지 않는다
// 디스코드 초대 주소는 아직 없다. 생기면 푸터 링크로 붙인다 — 죽은 링크를 미리 두지 않는다.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

let booted = false;

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

const kindLabel = (k) => t(k === 'tip' ? 'home.kind.tip' : k === 'update' ? 'home.kind.update' : 'home.kind.notice');

/** 공지 목록 — 업데이트 종류는 오른쪽 칸이 따로 가져가므로 여기서는 뺀다 */
function paintNotices(all) {
  const box = $('home-notices');
  if (!box) return;
  const list = all.filter(n => n.kind !== 'update');
  if (!list.length) {
    box.innerHTML = `<div class="notice-empty muted">${esc(t('home.notices.none'))}</div>`;
    return;
  }
  box.innerHTML = list.map(n => `
    <article class="notice${n.pinned ? ' pinned' : ''}">
      <div class="notice-row">
        <span class="notice-kind k-${esc(n.kind)}">${esc(kindLabel(n.kind))}</span>
        <b class="notice-title">${esc(n.title)}</b>
        <time class="notice-date">${esc(fmtDate(n.publishedAt))}</time>
      </div>
      <div class="notice-body">${renderBody(n.body)}</div>
    </article>`).join('');
}

/** 최신 업데이트 — kind=update 인 공지를 버전 이력처럼 보여준다 */
function paintUpdates(all) {
  const box = $('home-updates');
  if (!box) return;
  const list = all.filter(n => n.kind === 'update').slice(0, 4);
  if (!list.length) {
    box.innerHTML = `<div class="notice-empty muted">${esc(t('home.updates.none'))}</div>`;
    return;
  }
  box.innerHTML = list.map((n, i) => `
    <article class="upd">
      <div class="upd-ver">
        <b>${esc(n.title)}</b>
        ${i === 0 ? `<span class="upd-new">${esc(t('home.new'))}</span>` : ''}
        <time>${esc(fmtDate(n.publishedAt))}</time>
      </div>
      <div class="upd-body">${renderBody(n.body)}</div>
    </article>`).join('');
}

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return c && Array.isArray(c.notices) ? c : null;
  } catch { return null; }
}

async function loadNotices(force = false) {
  const cached = readCache();
  if (cached) { paintNotices(cached.notices); paintUpdates(cached.notices); }
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return;

  try {
    const res = await fetch(`${API}/notices?lang=${encodeURIComponent(getLocale())}&limit=30`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data.notices) ? data.notices : [];
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), notices: list }));
    paintNotices(list); paintUpdates(list);
  } catch {
    // 못 가져오면 지난 공지를 그대로 둔다 — 아무것도 없을 때만 안내한다
    if (!cached) {
      const msg = `<div class="notice-empty muted">${esc(t('home.notices.failed'))}</div>`;
      if ($('home-notices')) $('home-notices').innerHTML = msg;
      if ($('home-updates')) $('home-updates').innerHTML = msg;
    }
  }
}

/** 사용 가이드 — 앱에 실제로 있는 기능만 적는다. 없는 문서로 보내지 않는다. */
const GUIDE = [
  { key: 'sep',     go: 'separate' },
  { key: 'library', go: 'library' },
  { key: 'studio',  go: 'studio' },
  { key: 'record',  go: 'studio' },
  { key: 'export',  go: 'studio' },
];

function paintGuide(switchView) {
  const box = $('home-guide');
  if (!box) return;
  box.innerHTML = GUIDE.map(g => `
    <button class="guide-card" data-go="${g.go}">
      <span class="guide-ico g-${g.key}"></span>
      <b>${esc(t('home.guide.' + g.key))}</b>
      <span class="guide-sub">${esc(t('home.guide.' + g.key + 'Sub'))}</span>
      <span class="guide-more">${esc(t('home.guide.more'))} →</span>
    </button>`).join('');
  box.querySelectorAll('[data-go]').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.go)));
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

/** 히어로의 파형 — 장식이라 데이터가 아니라 결정적 난수로 그린다 */
function paintWave() {
  const box = $('home-wave');
  if (!box || box.childElementCount) return;
  const N = 68;
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  box.innerHTML = Array.from({ length: N }, (_, i) => {
    const center = 1 - Math.abs(i - (N - 1) / 2) / ((N - 1) / 2);   // 가운데가 높다
    const h = Math.max(6, (center ** 2.2 * 78 + rnd() * 16));
    return `<i style="height:${h.toFixed(1)}%;opacity:${(0.25 + center * 0.75).toFixed(2)}"></i>`;
  }).join('');
}

/** 사이드바 — 해당 구역으로 스크롤하고 표시를 옮긴다 */
function initNav() {
  const items = document.querySelectorAll('.home-nav-item[data-sec]');
  items.forEach(b => b.addEventListener('click', () => {
    items.forEach(x => x.classList.toggle('on', x === b));
    const sec = b.dataset.sec;
    const main = document.querySelector('.home-main');
    if (sec === 'home') { main.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    document.querySelector(`[data-sec-block="${sec}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

/**
 * @param {(view:string)=>void} switchView 탭 전환 (app.js 가 넘겨준다)
 */
export function initHome(switchView) {
  if (booted) { loadNotices(); return; }
  booted = true;

  const api = window.yssApi;
  paintWave();
  paintGuide(switchView);
  paintFaq();
  initNav();

  $('home-notice-reload')?.addEventListener('click', () => loadNotices(true));
  $('home-all-releases')?.addEventListener('click', () =>
    api?.openExternal?.('https://github.com/whalemindbass/yt-separator-releases/releases'));
  $('home-contact')?.addEventListener('click', () => $('report-btn')?.click());
  $('home-check-update')?.addEventListener('click', () => {
    const el = $('home-update-status');
    if (el) el.textContent = t('common.checking');
    api?.update?.check?.();
  });

  // 바깥으로 나가는 링크는 한 곳에서 처리한다 — 공지 본문의 링크도 여기로 온다
  document.querySelector('[data-view="home"]')?.addEventListener('click', (e) => {
    const el = e.target.closest('[data-ext]');
    if (!el) return;
    e.preventDefault();
    api?.openExternal?.(el.dataset.ext);
  });

  api?.settings?.appInfo?.()
    .then(info => {
      if (info?.appVersion) {
        const v = $('home-version'); if (v) v.textContent = 'v' + info.appVersion;
      }
      const c = $('home-copy');
      if (c) c.textContent = `© ${new Date().getFullYear()} Dr.studio`;
    })
    .catch(() => {});

  loadNotices();
}

export { loadNotices };
