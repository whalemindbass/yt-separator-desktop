// 오류 제보 — 사용자가 겪은 문제를 진단 정보와 함께 메일로 보낸다.
// 평소에는 아무것도 저장하지 않고, 최근 오류만 메모리에 들고 있다가 보낼 때만 첨부한다.
'use strict';

const api = window.yssApi;
const $ = (id) => document.getElementById(id);
const ENDPOINT = 'https://ytseparator.com/community/api/feedback';

// ── 최근 오류 링버퍼 (메모리에만, 최대 20개) ────────────────
const MAX_ERRORS = 20;
const _errors = [];
function noteError(source, message) {
  const text = String(message || '').slice(0, 400);
  if (!text) return;
  const last = _errors[_errors.length - 1];
  if (last && last.source === source && last.text === text) { last.count++; return; }   // 연속 중복은 묶음
  _errors.push({ at: Date.now(), source, text, count: 1 });
  if (_errors.length > MAX_ERRORS) _errors.shift();
}
export { noteError };

window.addEventListener('error', (e) => noteError('js', e.message));
window.addEventListener('unhandledrejection', (e) => noteError('promise', e.reason?.message || e.reason));

// ── 진단 정보 ──────────────────────────────────────────────
let _appInfo = null;
async function diagnostics() {
  if (!_appInfo) {
    try { _appInfo = await api.settings.appInfo(); } catch { _appInfo = {}; }
  }
  let studio = null;
  try { studio = (await import('./studio.js')).studioDiagnostics(); } catch {}
  return {
    app: _appInfo?.appVersion || 'unknown',
    os: `${navigator.platform || ''} ${(navigator.userAgent.match(/Windows NT [\d.]+/) || [''])[0]}`.trim(),
    lang: document.documentElement.lang || 'ko',
    view: document.querySelector('.view:not([hidden])')?.dataset.view || '-',
    studio,
    recentErrors: _errors.slice(-10).map(e => ({
      t: new Date(e.at).toISOString().slice(11, 19),
      from: e.source,
      msg: e.text,
      ...(e.count > 1 ? { repeated: e.count } : {}),
    })),
  };
}

// ── 다이얼로그 ─────────────────────────────────────────────
let _busy = false;

async function open() {
  const dlg = $('report-dialog');
  if (!dlg) return;
  $('report-err').hidden = true;
  $('report-err').className = 'report-err';
  $('report-diag-view').hidden = true;
  $('report-send').disabled = false;
  $('report-send').textContent = '보내기';
  dlg.hidden = false;
  $('report-body').focus();
}

function close() { const d = $('report-dialog'); if (d) d.hidden = true; }

function showError(msg, ok = false) {
  const el = $('report-err');
  el.hidden = false;
  el.className = 'report-err' + (ok ? ' report-ok' : '');
  el.textContent = msg;
}

async function send() {
  if (_busy) return;
  const body = $('report-body').value.trim();
  if (!body) { showError('무슨 일이 있었는지 한 줄이라도 적어 주세요.'); $('report-body').focus(); return; }

  _busy = true;
  $('report-send').disabled = true;
  $('report-send').textContent = '보내는 중…';
  showError('', true);
  $('report-err').hidden = true;

  const payload = {
    intent: $('report-intent').value.trim().slice(0, 120),
    body: body.slice(0, 1500),
    contact: $('report-contact').value.trim().slice(0, 120),
    diag: $('report-diag-on').checked ? await diagnostics() : null,
  };

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `서버 응답 ${res.status}`);
    showError('보냈습니다. 확인하고 고치겠습니다. 감사합니다.', true);
    $('report-intent').value = ''; $('report-body').value = '';
    setTimeout(close, 1600);
  } catch (e) {
    showError('전송 실패: ' + (e?.message || e) + ' — 인터넷 연결을 확인하거나 whalemindbass@gmail.com 으로 보내 주세요.');
  } finally {
    _busy = false;
    $('report-send').disabled = false;
    $('report-send').textContent = '보내기';
  }
}

export function initReport() {
  $('report-btn')?.addEventListener('click', open);
  $('s-report')?.addEventListener('click', open);
  $('report-cancel')?.addEventListener('click', close);
  $('report-send')?.addEventListener('click', send);
  $('report-dialog')?.addEventListener('click', (e) => { if (e.target.id === 'report-dialog') close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('report-dialog')?.hidden) close();
  });
  $('report-diag-show')?.addEventListener('click', async () => {
    const v = $('report-diag-view');
    if (!v.hidden) { v.hidden = true; return; }
    v.textContent = JSON.stringify(await diagnostics(), null, 2);
    v.hidden = false;
  });

  checkLastCrash();
}

/**
 * 지난 실행이 비정상 종료했으면 알린다.
 *
 * 전에는 예외가 콘솔로만 가서 아무 데도 남지 않았다. 사용자는 앱이 사라진 것만 알고
 * 나는 아무것도 모른다. 이제 마지막 한 건이 남고, 그것을 여기서 꺼내 보여 준다.
 * 내용은 제보 본문에 미리 채운다 — 숨겨 보내는 진단 정보가 아니라 사용자가 읽고 보내는 글이다.
 */
async function checkLastCrash() {
  let rec = null;
  try { rec = await api.takeLastCrash?.(); } catch {}
  if (!rec) return;

  const at = new Date(rec.at || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const when = `${at.getFullYear()}.${p(at.getMonth() + 1)}.${p(at.getDate())} ${p(at.getHours())}:${p(at.getMinutes())}`;

  noteError('lastrun', `[${rec.kind}] ${rec.message || ''}`);   // 진단 정보에도 실리게

  open();
  $('report-intent').value = `지난 실행이 예기치 않게 종료됨 (${when})`;
  $('report-body').value =
    '앱이 갑자기 종료됐습니다. 무엇을 하던 중이었는지 적어 주시면 큰 도움이 됩니다.\n\n' +
    '── 자동으로 채워진 정보 ──\n' +
    `종류: ${rec.kind} · 버전: ${rec.version || '-'}\n` +
    `${rec.message || ''}\n${rec.stack || ''}`.trim();
  $('report-body').focus();
  $('report-body').setSelectionRange(0, 0);
}
