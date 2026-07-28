'use strict';
// 앱 네이티브 커뮤니티 — 아이디/비밀번호 인증 + 피드/상세/작성/댓글/좋아요.
// Bearer 토큰(localStorage) 로 인증. YouTube 는 iframe 임베드.

import { getLocale } from './i18n.js';

const API = 'https://ytseparator.com/community/api';
const TOKEN_KEY = 'yss:comm-token';
const root = document.getElementById('community-root');

let token = null;
let me = null;
let _booted = false;
let view = { name: 'feed', postId: null };
let feedState = { sort: 'recent', song: '' };

const isEn = () => { try { return getLocale() === 'en'; } catch { return false; } };
const L = (ko, en) => (isEn() ? en : ko);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const INST = { vocals: L('보컬','Vocals'), guitar: L('기타','Guitar'), bass: L('베이스','Bass'), drums: L('드럼','Drums'), piano: L('피아노','Piano'), other: L('그외','Other') };

function fmtWhen(ts) {
  const d = Date.now() - ts;
  if (d < 60_000) return L('방금 전','just now');
  if (d < 3600_000) return Math.floor(d/60_000) + L('분 전','m ago');
  if (d < 86400_000) return Math.floor(d/3600_000) + L('시간 전','h ago');
  if (d < 7*86400_000) return Math.floor(d/86400_000) + L('일 전','d ago');
  const dt = new Date(ts);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}

// ── API 호출 ──
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  let res, data;
  try {
    res = await fetch(API + path, { ...opts, headers });
    data = await res.json().catch(() => null);
  } catch (e) {
    return { status: 0, data: null, netError: true };
  }
  return { status: res.status, data };
}

function saveToken(t) { token = t; try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch {} }

// ── 진입 ──
export async function initCommunity() {
  if (!root) return;
  if (!_booted) {
    _booted = true;
    try { token = localStorage.getItem(TOKEN_KEY) || null; } catch {}
  }
  await refreshMe();
  render();
}

async function refreshMe() {
  if (!token) { me = null; return; }
  const r = await api('/me');
  me = r.data?.user || null;
  if (!me) saveToken(null);   // 만료/무효 토큰 정리
}

// ── 라우팅 렌더 ──
function render() {
  if (view.name === 'post' && view.postId) return renderPost(view.postId);
  return renderFeed();
}
function go(name, postId) { view = { name, postId: postId || null }; render(); }

// ── 헤더 (공통) ──
function headerHtml() {
  const right = me
    ? `<div class="cm-user"><span class="cm-uname">${esc(me.name || me.username)}</span>
         <button class="cm-btn ghost" id="cm-logout">${L('로그아웃','Log out')}</button></div>`
    : `<button class="cm-btn primary" id="cm-login-open">${L('로그인 / 가입','Log in / Sign up')}</button>`;
  return `
    <div class="cm-header">
      <div class="cm-brand">
        <span class="cm-brand-title">${L('커버 공유','Cover Share')}</span>
        <span class="cm-brand-sub">${L('앱 사용자 커뮤니티','App community')}</span>
      </div>
      <div class="cm-header-actions">${right}</div>
    </div>`;
}
function bindHeader() {
  document.getElementById('cm-login-open')?.addEventListener('click', () => openAuthModal('login'));
  document.getElementById('cm-logout')?.addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' });
    saveToken(null); me = null; render();
  });
}

// ── 피드 ──
async function renderFeed() {
  root.innerHTML = headerHtml() + `
    <div class="cm-toolbar">
      <div class="cm-chips">
        <button class="cm-chip ${feedState.sort==='recent'?'on':''}" data-sort="recent">${L('최신','Recent')}</button>
        <button class="cm-chip ${feedState.sort==='popular'?'on':''}" data-sort="popular">${L('인기','Popular')}</button>
      </div>
      <input class="cm-search" id="cm-search" placeholder="${L('곡 이름 검색…','Search song…')}" value="${esc(feedState.song)}" />
      ${me ? `<button class="cm-btn primary" id="cm-new">${L('+ 커버 공유','+ Share cover')}</button>` : ''}
    </div>
    <div class="cm-feed" id="cm-feed"><div class="cm-loading">${L('로드 중…','Loading…')}</div></div>`;
  bindHeader();
  document.querySelectorAll('.cm-chip[data-sort]').forEach(c => c.addEventListener('click', () => {
    feedState.sort = c.dataset.sort; renderFeed();
  }));
  let t;
  document.getElementById('cm-search')?.addEventListener('input', (e) => {
    clearTimeout(t); t = setTimeout(() => { feedState.song = e.target.value.trim(); loadFeedList(); }, 300);
  });
  document.getElementById('cm-new')?.addEventListener('click', () => { if (requireLogin()) openComposeModal(); });
  loadFeedList();
}

async function loadFeedList() {
  const feed = document.getElementById('cm-feed');
  if (!feed) return;
  const p = new URLSearchParams({ sort: feedState.sort });
  if (feedState.song) p.set('song', feedState.song);
  const r = await api('/posts?' + p.toString());
  if (r.netError) { feed.innerHTML = `<div class="cm-empty">${L('연결에 실패했습니다.','Failed to connect.')}</div>`; return; }
  const items = r.data?.items || [];
  if (!items.length) { feed.innerHTML = `<div class="cm-empty">${L('아직 공유된 커버가 없어요.','No covers shared yet.')}</div>`; return; }
  feed.innerHTML = items.map(cardHtml).join('');
  feed.querySelectorAll('.cm-card').forEach(c => c.addEventListener('click', () => go('post', c.dataset.id)));
}

function cardHtml(p) {
  const thumb = `https://i.ytimg.com/vi/${esc(p.video_id)}/mqdefault.jpg`;
  const inst = p.instrument ? `<span class="cm-inst">${INST[p.instrument] || p.instrument}</span>` : '';
  return `
    <div class="cm-card" data-id="${esc(p.id)}">
      <div class="cm-thumb"><img src="${thumb}" alt="" loading="lazy" /></div>
      <div class="cm-cbody">
        <div class="cm-ctitle">${esc(p.title)}</div>
        <div class="cm-csong">${esc(p.song_name)}${p.song_artist ? ' · ' + esc(p.song_artist) : ''} ${inst}</div>
        <div class="cm-cmeta">
          <span>${esc(p.author?.name || '')}</span><span class="sep">·</span>
          <span>${fmtWhen(p.created_at)}</span><span class="sep">·</span>
          <span>♥ ${p.like_count}</span><span class="sep">·</span><span>💬 ${p.comment_count}</span>
        </div>
      </div>
    </div>`;
}

// ── 상세 ──
async function renderPost(id) {
  root.innerHTML = headerHtml() + `<div class="cm-detail"><div class="cm-loading">${L('로드 중…','Loading…')}</div></div>`;
  bindHeader();
  const box = root.querySelector('.cm-detail');
  const r = await api('/posts/' + encodeURIComponent(id));
  if (r.status === 404) { box.innerHTML = backBtn() + `<div class="cm-empty">${L('삭제되었거나 없는 게시글입니다.','Post not found.')}</div>`; bindBack(); return; }
  if (!r.data || r.data.ok === false) { box.innerHTML = backBtn() + `<div class="cm-empty">${esc(r.data?.error || 'error')}</div>`; bindBack(); return; }
  const p = r.data;
  const inst = p.instrument ? `<span class="cm-inst">${INST[p.instrument] || p.instrument}</span>` : '';
  box.innerHTML = `
    ${backBtn()}
    <div class="cm-video"><iframe src="https://www.youtube.com/embed/${encodeURIComponent(p.video_id)}?rel=0" allowfullscreen
      referrerpolicy="strict-origin-when-cross-origin"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe></div>
    <div class="cm-phead">
      <h1 class="cm-ptitle">${esc(p.title)}</h1>
      <div class="cm-pactions">
        <button class="cm-btn ${p.liked_by_me?'liked':''}" id="cm-like">♥ <span id="cm-like-n">${p.like_count}</span></button>
        ${p.is_mine ? `<button class="cm-btn danger" id="cm-del">${L('삭제','Delete')}</button>` : ''}
      </div>
    </div>
    <div class="cm-pmeta">
      <span>${esc(p.author?.name || '')}</span><span class="sep">·</span>
      <span>${esc(p.song_name)}${p.song_artist ? ' · ' + esc(p.song_artist) : ''}</span>
      ${inst ? `<span class="sep">·</span>${inst}` : ''}<span class="sep">·</span><span>${fmtWhen(p.created_at)}</span>
    </div>
    ${p.description ? `<div class="cm-desc">${esc(p.description)}</div>` : ''}
    <div class="cm-comments">
      <h3>${L('댓글','Comments')} <span class="cm-cc" id="cm-cc">${p.comment_count}</span></h3>
      <div id="cm-cform"></div>
      <div class="cm-clist" id="cm-clist"><div class="cm-loading">${L('로드 중…','Loading…')}</div></div>
    </div>`;
  bindBack();
  document.getElementById('cm-like')?.addEventListener('click', () => toggleLike(p.id));
  document.getElementById('cm-del')?.addEventListener('click', () => deletePost(p.id));
  renderCommentForm(p.id);
  loadComments(p.id);
}
function backBtn() { return `<button class="cm-back" id="cm-back">← ${L('목록으로','Back')}</button>`; }
function bindBack() { document.getElementById('cm-back')?.addEventListener('click', () => go('feed')); }

function renderCommentForm(postId) {
  const slot = document.getElementById('cm-cform');
  if (!slot) return;
  if (!me) { slot.innerHTML = `<div class="cm-cform-guest">${L('댓글을 쓰려면','To comment,')} <a href="#" id="cm-login-inline">${L('로그인','log in')}</a></div>`;
    document.getElementById('cm-login-inline')?.addEventListener('click', (e) => { e.preventDefault(); openAuthModal('login'); });
    return;
  }
  slot.innerHTML = `<div class="cm-cform">
    <textarea id="cm-cinput" maxlength="500" placeholder="${L('응원·팁·감상 (500자)','Encouragement, tips (500 chars)')}"></textarea>
    <button class="cm-btn primary" id="cm-csubmit">${L('등록','Post')}</button></div>`;
  document.getElementById('cm-csubmit')?.addEventListener('click', () => submitComment(postId));
}

async function loadComments(postId) {
  const list = document.getElementById('cm-clist');
  if (!list) return;
  const r = await api(`/posts/${postId}/comments`);
  const items = r.data?.items || [];
  if (!items.length) { list.innerHTML = `<div class="cm-empty small">${L('첫 댓글을 남겨보세요.','Be the first to comment.')}</div>`; return; }
  // 트리
  const roots = [], childrenOf = new Map(), byId = new Map(items.map(c => [c.id, c]));
  for (const c of items) {
    if (c.parent_id && byId.has(c.parent_id)) { (childrenOf.get(c.parent_id) || childrenOf.set(c.parent_id, []).get(c.parent_id)).push(c); }
    else roots.push(c);
  }
  list.innerHTML = roots.map(rt => {
    const replies = (childrenOf.get(rt.id) || []).sort((a,b)=>a.created_at-b.created_at);
    return commentHtml(rt, false) + (replies.length ? `<div class="cm-replies">${replies.map(x => commentHtml(x, true)).join('')}</div>` : '');
  }).join('');
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm(L('이 댓글을 삭제할까요?','Delete this comment?'))) return;
    await api(`/comments/${b.dataset.del}`, { method: 'DELETE' }); loadComments(postId); bumpCommentCount(-1);
  }));
  list.querySelectorAll('[data-reply]').forEach(b => b.addEventListener('click', () => openReplyForm(b.dataset.reply, postId)));
}
function commentHtml(c, isReply) {
  const mine = me && me.id === c.author.id;
  const acts = [];
  if (me && !isReply) acts.push(`<button data-reply="${esc(c.id)}">${L('답글','Reply')}</button>`);
  if (mine) acts.push(`<button data-del="${esc(c.id)}" class="del">${L('삭제','Delete')}</button>`);
  return `<div class="cm-comment ${isReply?'reply':''}">
    <div class="cm-chead"><span class="cm-cname">${esc(c.author.name)}</span><span class="cm-cwhen">${fmtWhen(c.created_at)}</span></div>
    <div class="cm-ctext">${esc(c.body)}</div>
    ${acts.length ? `<div class="cm-cacts">${acts.join('')}</div>` : ''}
    <div class="cm-reply-slot" data-slot="${esc(c.id)}"></div></div>`;
}
function openReplyForm(parentId, postId) {
  document.querySelectorAll('.cm-reply-slot').forEach(s => s.innerHTML = '');
  const slot = document.querySelector(`.cm-reply-slot[data-slot="${parentId}"]`);
  if (!slot) return;
  slot.innerHTML = `<div class="cm-cform reply"><textarea maxlength="500" placeholder="${L('답글','Reply')}"></textarea>
    <button class="cm-btn primary">${L('등록','Post')}</button></div>`;
  const ta = slot.querySelector('textarea'); ta.focus();
  slot.querySelector('button').addEventListener('click', async () => {
    const body = ta.value.trim(); if (!body) return;
    const r = await api(`/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ body, parent_id: parentId }) });
    if (r.data?.ok) { loadComments(postId); bumpCommentCount(1); } else alert(r.data?.error || 'error');
  });
}
async function submitComment(postId) {
  const input = document.getElementById('cm-cinput');
  const body = input.value.trim(); if (!body) return;
  const btn = document.getElementById('cm-csubmit'); btn.disabled = true;
  const r = await api(`/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ body }) });
  btn.disabled = false;
  if (r.data?.ok) { input.value = ''; loadComments(postId); bumpCommentCount(1); }
  else alert(r.data?.error || 'error');
}
function bumpCommentCount(d) { const el = document.getElementById('cm-cc'); if (el) el.textContent = Math.max(0, (Number(el.textContent)||0) + d); }

async function toggleLike(postId) {
  if (!requireLogin()) return;
  const r = await api(`/posts/${postId}/like`, { method: 'POST' });
  if (r.data) {
    const n = document.getElementById('cm-like-n'); if (n) n.textContent = r.data.like_count;
    document.getElementById('cm-like')?.classList.toggle('liked', r.data.liked);
  }
}
async function deletePost(postId) {
  if (!confirm(L('이 게시글을 삭제할까요?','Delete this post?'))) return;
  const r = await api(`/posts/${postId}`, { method: 'DELETE' });
  if (r.data?.ok) go('feed'); else alert(r.data?.error || 'error');
}

// ── 모달 공용 마운트 ──
// 1) no-drag 로 Electron drag-region 이 입력을 삼키지 않게 함
// 2) 포커스 트랩 — 크로스오리진 YouTube iframe 이 비동기로 포커스를 가로채도
//    다시 모달 안으로 끌어와 입력창이 죽지 않게 함 (간헐적 입력 불가 방지)
// 3) append 이후 첫 필드에 포커스 (분리 상태에서 focus() 는 무효라 rAF 로 처리)
// 4) Escape 로 닫기
function mountModal(back, firstSel) {
  back.style.setProperty('-webkit-app-region', 'no-drag');
  document.body.appendChild(back);
  const firstField = () => back.querySelector(firstSel) || back.querySelector('input,textarea,select,button');
  const onFocusIn = (e) => {
    if (back.isConnected && !back.contains(e.target)) { const f = firstField(); if (f) f.focus(); }
  };
  const onKey = (e) => { if (e.key === 'Escape') back.remove(); };
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('keydown', onKey, true);
  const origRemove = back.remove.bind(back);
  back.remove = () => {
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('keydown', onKey, true);
    origRemove();
  };
  requestAnimationFrame(() => { const f = firstField(); if (f) f.focus(); });
}

// ── 로그인/가입 모달 ──
function requireLogin() { if (me) return true; openAuthModal('login'); return false; }
function openAuthModal(mode) {
  const back = document.createElement('div');
  back.className = 'cm-modal-back';
  const render = (m) => {
    back.innerHTML = `<div class="cm-modal">
      <div class="cm-tabs">
        <button class="cm-tab ${m==='login'?'on':''}" data-m="login">${L('로그인','Log in')}</button>
        <button class="cm-tab ${m==='register'?'on':''}" data-m="register">${L('회원가입','Sign up')}</button>
      </div>
      <div class="cm-mbody">
        <div class="cm-merr" id="cm-merr" hidden></div>
        <input id="cm-username" placeholder="${L('아이디 (영문·숫자 3~20자)','Username (3-20 chars)')}" autocomplete="off" />
        ${m==='register' ? `<input id="cm-nick" placeholder="${L('표시 이름 (선택)','Display name (optional)')}" autocomplete="off" />` : ''}
        <input id="cm-password" type="password" placeholder="${L('비밀번호 (6자 이상)','Password (6+ chars)')}" />
      </div>
      <div class="cm-mactions">
        <button class="cm-btn ghost" id="cm-cancel">${L('취소','Cancel')}</button>
        <button class="cm-btn primary" id="cm-submit">${m==='login'?L('로그인','Log in'):L('가입하기','Sign up')}</button>
      </div>
    </div>`;
    back.querySelectorAll('.cm-tab').forEach(t => t.addEventListener('click', () => render(t.dataset.m)));
    back.querySelector('#cm-cancel').addEventListener('click', () => back.remove());
    const submit = back.querySelector('#cm-submit');
    const doSubmit = () => authSubmit(m, back);
    submit.addEventListener('click', doSubmit);
    back.querySelector('#cm-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSubmit(); });
  };
  render(mode);
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  mountModal(back, '#cm-username');
}
async function authSubmit(mode, back) {
  const username = back.querySelector('#cm-username').value.trim();
  const password = back.querySelector('#cm-password').value;
  const nick = back.querySelector('#cm-nick')?.value.trim();
  const err = back.querySelector('#cm-merr');
  const showErr = (msg) => { err.textContent = msg; err.hidden = false; };
  if (!username || !password) return showErr(L('아이디와 비밀번호를 입력하세요.','Enter username and password.'));
  const submit = back.querySelector('#cm-submit'); submit.disabled = true;
  const path = mode === 'register' ? '/auth/register' : '/auth/login';
  const body = mode === 'register' ? { username, password, display_name: nick || username } : { username, password };
  const r = await api(path, { method: 'POST', body: JSON.stringify(body) });
  submit.disabled = false;
  if (r.data?.ok && r.data.token) {
    saveToken(r.data.token); me = r.data.user; back.remove(); render();
  } else {
    showErr(r.data?.error || L('실패했습니다.','Failed.'));
  }
}

// ── 작성 모달 ──
function openComposeModal() {
  const back = document.createElement('div');
  back.className = 'cm-modal-back';
  back.innerHTML = `<div class="cm-modal wide">
    <div class="cm-mtitle">${L('커버 공유하기','Share a cover')}</div>
    <div class="cm-mbody">
      <div class="cm-merr" id="cm-cerr" hidden></div>
      <label class="cm-field"><span>${L('YouTube 링크','YouTube link')}</span>
        <input id="cp-url" placeholder="https://www.youtube.com/watch?v=…" /></label>
      <label class="cm-field"><span>${L('곡 이름','Song')}</span><input id="cp-song" maxlength="120" /></label>
      <label class="cm-field"><span>${L('아티스트 (선택)','Artist (optional)')}</span><input id="cp-artist" maxlength="120" /></label>
      <label class="cm-field"><span>${L('파트','Part')}</span>
        <select id="cp-inst"><option value="">${L('지정 안 함','None')}</option>
          <option value="vocals">${INST.vocals}</option><option value="guitar">${INST.guitar}</option>
          <option value="bass">${INST.bass}</option><option value="drums">${INST.drums}</option>
          <option value="piano">${INST.piano}</option><option value="other">${INST.other}</option></select></label>
      <label class="cm-field"><span>${L('코멘트 (선택)','Comment (optional)')}</span><textarea id="cp-desc" maxlength="2000"></textarea></label>
    </div>
    <div class="cm-mactions">
      <button class="cm-btn ghost" id="cp-cancel">${L('취소','Cancel')}</button>
      <button class="cm-btn primary" id="cp-submit">${L('공유','Share')}</button>
    </div></div>`;
  back.querySelector('#cp-cancel').addEventListener('click', () => back.remove());
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  back.querySelector('#cp-submit').addEventListener('click', async () => {
    const err = back.querySelector('#cm-cerr');
    const url = back.querySelector('#cp-url').value.trim();
    const song = back.querySelector('#cp-song').value.trim();
    if (!url || !song) { err.textContent = L('링크와 곡 이름은 필수입니다.','Link and song are required.'); err.hidden = false; return; }
    const btn = back.querySelector('#cp-submit'); btn.disabled = true;
    const r = await api('/posts', { method: 'POST', body: JSON.stringify({
      url, song_name: song,
      song_artist: back.querySelector('#cp-artist').value.trim() || null,
      instrument: back.querySelector('#cp-inst').value || null,
      description: back.querySelector('#cp-desc').value.trim() || null,
    }) });
    btn.disabled = false;
    if (r.data?.ok) { back.remove(); if (view.name === 'feed') loadFeedList(); else go('feed'); }
    else { err.textContent = r.data?.error || L('실패했습니다.','Failed.'); err.hidden = false; }
  });
  mountModal(back, '#cp-url');
}
