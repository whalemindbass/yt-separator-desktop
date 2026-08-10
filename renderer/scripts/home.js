'use strict';
// 홈 — 로고를 누르면 오는 화면. 공지·바로가기·디스코드.
//
// 읽기 전용이다. 커뮤니티(community.js)와 다르다: 여기에는 로그인도, 글쓰기도, 댓글도 없다.
// 공지는 운영자가 D1 에 넣고 앱은 가져다 보여주기만 한다.

import { t, getLocale } from './i18n.js';

const API = 'https://ytseparator.com/community/api';
// 디스코드 초대 주소. 아직 정해지지 않아 비워 둔다 — 채우면 홈에 카드가 나타난다.
const DISCORD_INVITE = '';
const CACHE_KEY = 'yss:notices';        // 오프라인·서버 지연에도 지난 공지는 보이게
const CACHE_TTL = 10 * 60 * 1000;       // 10분 안에 다시 열면 네트워크를 다시 타지 않는다

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
    (_m, text, href) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`);
  return html;
}

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

function kindLabel(kind) {
  return t(kind === 'update' ? 'home.kind.update' : kind === 'tip' ? 'home.kind.tip' : 'home.kind.notice');
}

function paint(notices) {
  const box = $('home-notices');
  if (!box) return;
  if (!notices.length) {
    box.innerHTML = `<div class="notice-empty muted">${esc(t('home.notices.none'))}</div>`;
    return;
  }
  box.innerHTML = notices.map(n => `
    <article class="notice${n.pinned ? ' pinned' : ''}">
      <header>
        <span class="notice-kind k-${esc(n.kind)}">${esc(kindLabel(n.kind))}</span>
        <b class="notice-title">${esc(n.title)}</b>
        <time class="notice-date">${esc(fmtDate(n.publishedAt))}</time>
      </header>
      <div class="notice-body">${renderBody(n.body)}</div>
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
  if (cached) paint(cached.notices);                 // 있으면 먼저 보여주고 뒤에서 갱신
  if (!force && cached && Date.now() - cached.at < CACHE_TTL) return;

  const box = $('home-notices');
  if (!cached && box) box.innerHTML = `<div class="notice-empty muted">${esc(t('home.notices.loading'))}</div>`;

  try {
    const res = await fetch(`${API}/notices?lang=${encodeURIComponent(getLocale())}&limit=20`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const list = Array.isArray(data.notices) ? data.notices : [];
    localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), notices: list }));
    paint(list);
  } catch {
    // 못 가져오면 지난 공지를 그대로 둔다 — 아무것도 없을 때만 안내한다
    if (!cached && box) box.innerHTML = `<div class="notice-empty muted">${esc(t('home.notices.failed'))}</div>`;
  }
}

/**
 * @param {(view:string)=>void} switchView 탭 전환 (app.js 가 넘겨준다)
 */
export function initHome(switchView) {
  if (booted) { loadNotices(); return; }
  booted = true;

  $('home-notice-reload')?.addEventListener('click', () => loadNotices(true));
  document.querySelectorAll('.home-link[data-go]').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.go)));

  // 디스코드 초대 주소가 생기면 그때 보여준다. 없는 동안 죽은 버튼을 두지 않는다.
  if (DISCORD_INVITE) {
    $('home-discord').hidden = false;
    $('home-discord-btn')?.addEventListener('click', () => window.yssApi?.openExternal?.(DISCORD_INVITE));
  }

  // 버전 — 홈에서 지금 쓰는 것이 몇 버전인지 바로 보이게
  window.yssApi?.settings?.appInfo?.()
    .then(info => { const el = $('home-version'); if (el && info?.appVersion) el.textContent = 'v' + info.appVersion; })
    .catch(() => {});

  loadNotices();
}

export { loadNotices };
