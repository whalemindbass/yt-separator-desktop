'use strict';
// 테스트 공용 준비물.
//
// 두 가지 모드가 있다.
//   bootRenderer() — 화면만 띄운다. 엔진·라이브러리는 흉내만 내므로 오디오 장치가 없어도 돈다.
//   bootMain()     — 진짜 main.js 를 그대로 올린다. IPC·다이얼로그·파일까지 실제 경로를 탄다.
//
// 각 테스트 파일은 electron 프로세스 하나를 통째로 쓴다. 하나가 죽어도 나머지에 번지지 않고,
// 창을 닫아 앱이 종료되는 검사(저장 확인 등)도 그대로 쓸 수 있다.

const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── 판정 ────────────────────────────────────────────────
let pass = 0, fail = 0;

function expect(label, got, want) {
  const ok = String(got) === String(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}: ${got}${ok ? '' : ` (기대 ${want})`}`);
  return ok;
}

function near(label, got, want, tol) {
  const ok = Math.abs(Number(got) - Number(want)) <= tol;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}: ${got}${ok ? '' : ` (기대 ${want}±${tol})`}`);
  return ok;
}

function section(t) { console.log(t); }
function skip(why) { console.log(`  건너뜀 — ${why}`); }

const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** 결과를 찍고 종료 코드를 정한다. 실패가 없으면 0. */
function finish(app) {
  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  app.exit(fail ? 1 : 0);
}

// ── 렌더러만 띄우기 ──────────────────────────────────────
// 엔진과 라이브러리는 흉내만 낸다. 실제 오디오 장치가 없는 곳에서도 돌아야 하기 때문이다.
const DEFAULT_STUBS = {
  'engine:cmd': () => ({ ok: true }),
  'engine:start': () => ({ ok: true }),
  'library:list': () => ([]),
  'window:isMaximized': () => false,
  'stem:models': () => ({}),
  'clipboard:read': () => '',
  'settings:get': () => ({}),
  'settings:appInfo': () => ({ appVersion: '0.0.0-test' }),
  'app:version': () => '0.0.0-test',
  'app:platform': () => 'win32',
  'shell:openExternal': () => true,
  // 프로젝트 저장·복구는 main 이 맡는다. 화면만 띄우는 모드에서도 스튜디오가 부르므로 흉내를 낸다.
  'project:autosaveRead':  () => ({ ok: false }),
  'project:autosaveWrite': () => ({ ok: true }),
  'project:autosaveClear': () => ({ ok: true }),
  'crash:take': () => null,
  // 연습 기록도 main 이 실제 파일(usageLog.json)로 관리한다 — 화면만 띄우는 모드에서도
  // 트레이닝 탭이 부팅 때부터 부르므로(usage.js 모듈 최상단) 흉내를 낸다.
  'usage:load': () => ({ log: {}, goals: {} }),
  'usage:save': () => true,
};

async function bootRenderer(opts = {}) {
  const { app, BrowserWindow, ipcMain, protocol, net } = require('electron');
  app.disableHardwareAcceleration();
  protocol.registerSchemesAsPrivileged([{
    scheme: 'ytsep',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true },
  }]);
  await app.whenReady();
  protocol.handle('ytsep', (req) =>
    net.fetch('file:///' + decodeURI(new URL(req.url).pathname.replace(/^\/+/, ''))));

  for (const [ch, fn] of Object.entries({ ...DEFAULT_STUBS, ...(opts.stubs || {}) })) {
    try { ipcMain.handle(ch, fn); } catch { /* 이미 등록됨 */ }
  }

  const win = new BrowserWindow({
    width: opts.width || 1440, height: opts.height || 940, show: false,
    webPreferences: { offscreen: true, webSecurity: false, preload: path.join(ROOT, 'preload.js') },
  });

  // 콘솔 오류도 실패로 본다 — 화면은 멀쩡해 보여도 뒤에서 터지고 있을 수 있다.
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    const s = String(msg);
    if (level >= 2 && !/powerPreference|Security Warning|severe security|available adapters|ERR_|net::/i.test(s)) {
      errors.push(s.slice(0, 200));
    }
  });

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await wait(opts.settle ?? 1800);

  const js = (code) => win.webContents.executeJavaScript(code);
  return { app, win, js, errors };
}

/** 진짜 main.js 를 올린다. 창·IPC·다이얼로그가 모두 실제 코드다. */
async function bootMain(opts = {}) {
  const { app, BrowserWindow } = require('electron');
  require(path.join(ROOT, 'main.js'));
  await app.whenReady();
  await wait(opts.settle ?? 2500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) throw new Error('창이 뜨지 않았다');
  const js = (code) => win.webContents.executeJavaScript(code);
  return { app, win, js };
}

/** 콘솔 오류가 있으면 실패로 기록한다 */
function expectNoConsoleErrors(errors) {
  if (!errors.length) { pass++; console.log('  OK   콘솔 오류 없음'); return; }
  fail++;
  console.log(`  실패 콘솔 오류 ${errors.length}건: ${errors.slice(0, 3).join(' | ')}`);
}

module.exports = { ROOT, expect, near, section, skip, wait, finish, bootRenderer, bootMain, expectNoConsoleErrors };
