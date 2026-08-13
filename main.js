'use strict';
// YT Separator Desktop — Electron main process

const { app, BrowserWindow, ipcMain, shell, protocol, net, clipboard, dialog, session } = require('electron');
const { autoUpdater } = require('electron-updater');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');

// 예상 못한 예외로 프로세스가 조용히 죽는 것 방지 — 로그만 남기고 유지
process.on('uncaughtException', (e) => { try { console.error('[uncaught]', e && e.stack || e); } catch {} });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', e); } catch {} });
const crypto = require('crypto');
const { spawn } = require('child_process');

// 작업표시줄 고정·창 그룹화·알림이 쓰는 앱 식별자.
// 설치 시 NSIS 바로가기에는 electron-builder 가 package.json 의 build.appId 를 심는데,
// 앱이 같은 값을 쓰지 않으면 Windows 가 실행 경로 기반의 다른 ID 를 붙인다. 그러면
// 업데이트로 exe 가 교체될 때마다 고정이 끊긴다. 두 값은 반드시 같아야 한다.
if (process.platform === 'win32') app.setAppUserModelId('com.whalemindbass.yt-separator');

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  return {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
  }[ext] || 'application/octet-stream';
}

/** 안전한 파일 base name — Windows 금지 문자 제거, 앞에서 60자, 6자 랜덤 suffix */
function makeFileBase(title, fallback = 'video') {
  let clean = String(title || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f%]/g, '')  // Windows 금지 + %(yt-dlp template char)
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length > 60) clean = clean.slice(0, 60).trim();
  clean = clean.replace(/[.\s]+$/, '') || fallback;
  const random = crypto.randomBytes(3).toString('hex'); // 6자 hex
  return `${clean}-${random}`;
}

const isDev = !app.isPackaged;

// WebGPU / GPU 안정화 (Electron 32 = Chromium 128의 알려진 이슈 완화)
app.commandLine.appendSwitch('enable-unsafe-webgpu');
app.commandLine.appendSwitch('enable-features', 'Vulkan,WebGPU');
app.commandLine.appendSwitch('disable-dawn-features', 'disallow_unsafe_apis');

// ── 커스텀 protocol: ytsep:// — <video>에서 로컬 mp4 스트리밍 ──
// 반드시 app ready 전에 register.
protocol.registerSchemesAsPrivileged([
  { scheme: 'ytsep', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: false } },
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** vendor 바이너리 위치 — 개발 시엔 프로젝트, 패키지 후엔 process.resourcesPath */
function vendorPath(...parts) {
  const base = isDev ? __dirname : process.resourcesPath;
  return path.join(base, 'vendor', ...parts);
}
const YTDLP_BIN  = vendorPath('yt-dlp', 'yt-dlp.exe');
const FFMPEG_BIN = vendorPath('ffmpeg', 'ffmpeg.exe');
const FFMPEG_DIR = vendorPath('ffmpeg');

// 진단 로그 — main 프로세스 콘솔에만. 파일 기록·렌더러 전달 없음
function dlog(...args) { console.log(...args); }

// ── 사용자 설정 (userData/settings.json) ────────────────
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf-8')); }
  catch { return {}; }
}
function writeSettings(obj) {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(obj, null, 2), 'utf-8'); return true; }
  catch { return false; }
}

/** 영상 다운로드 폴더 — userData/downloads (기본), 설정에서 변경 가능 */
function downloadsDir() {
  const s = readSettings();
  let dir = s.downloadsDir;
  if (!dir || typeof dir !== 'string') {
    dir = path.join(app.getPath('userData'), 'downloads');
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
/** 스템 저장 폴더 — 기본은 영상폴더/stems (하위호환), 설정에서 별도 지정 가능 */
function stemsDir() {
  const s = readSettings();
  let dir = s.stemsDir;
  if (!dir || typeof dir !== 'string') {
    dir = path.join(downloadsDir(), 'stems');
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
/** child 가 parent 안(하위)에 있는지 */
function isInsideDir(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f1114',
    show: false,
    frame: false,                    // 자체 titlebar 사용
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'renderer/assets/app-icon.png'),   // 작업표시줄·창 아이콘 명시
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
      webviewTag: true,            // 커뮤니티 임베드용
    },
  });
  mainWindow.on('maximize',   () => mainWindow.webContents.send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', { maximized: false }));
  mainWindow.on('focus',      () => mainWindow.webContents.send('window:focus'));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  // F12 로 DevTools 토글 (패키지 빌드에서도 디버깅 가능)
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
  // 저장하지 않은 작업이 있으면 닫기 전에 묻는다.
  // 창이 닫힌 뒤에 도는 'closed' 로는 늦다 — 그때는 이미 되돌릴 수 없다.
  let closeConfirmed = false;
  mainWindow.on('close', (e) => {
    if (closeConfirmed || !unsavedWork) return;
    e.preventDefault();
    (async () => {
      const win = mainWindow;
      if (!win) return;
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['저장하고 닫기', '저장하지 않고 닫기', '취소'],
        defaultId: 0, cancelId: 2, noLink: true,
        message: '저장하지 않은 작업이 있습니다',
        detail: '지금 닫으면 마지막 저장 이후의 변경을 잃습니다.',
      });
      if (response === 2) return;                       // 취소 — 그대로 둔다
      if (response === 0 && !(await requestRendererSave())) return;   // 저장 취소·실패 시에도 닫지 않는다
      // 여기까지 왔으면 저장했거나 버리기로 한 것이다 — 복구본을 남겨 둘 이유가 없다
      for (const p of [autosavePath(), autosaveMetaPath()]) { try { fs.unlinkSync(p); } catch {} }
      closeConfirmed = true;
      win.close();
    })();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

/** 렌더러에 저장을 시키고 끝났는지 기다린다. 응답이 없으면 닫지 않는 쪽으로 판단한다. */
function requestRendererSave() {
  return new Promise((resolve) => {
    if (!mainWindow) return resolve(true);
    const done = (_e, ok) => { clearTimeout(timer); ipcMain.removeListener('project:save-result', done); resolve(!!ok); };
    const timer = setTimeout(() => { ipcMain.removeListener('project:save-result', done); resolve(false); }, 30000);
    ipcMain.on('project:save-result', done);
    mainWindow.webContents.send('project:save-request');
  });
}

// 데스크톱 Chrome UA — 커뮤니티 webview 에서 Google OAuth 임베드 차단 회피
const DESKTOP_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() === 'webview') {
    // webview 요청에 데스크톱 UA 적용 (Google 로그인 허용)
    try { contents.setUserAgent(DESKTOP_CHROME_UA); } catch {}
    // window.open / target=_blank → 기본 브라우저로
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) { shell.openExternal(url); }
      return { action: 'deny' };
    });
    // ytseparator.com · google · youtube 외 네비게이션은 외부로
    contents.on('will-navigate', (ev, url) => {
      const ok = /^https:\/\/(ytseparator\.com|accounts\.google\.com|[^/]*\.google\.com|[^/]*\.googleusercontent\.com|www\.youtube\.com|youtube\.com|youtu\.be|[^/]*\.gstatic\.com)/i.test(url);
      if (!ok) { ev.preventDefault(); shell.openExternal(url); }
    });
  }
});
app.on('will-attach-webview', (_e, webPreferences, params) => {
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  // preload 제거 (커뮤니티 페이지엔 앱 API 노출 안 함)
  delete webPreferences.preload;
});

app.whenReady().then(() => {
  // 커뮤니티 YouTube iframe 임베드: file:// 오리진이라 Referer 가 없어 오류(153) → 유효한 Referer 주입
  try {
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'] },
      (details, cb) => {
        const h = details.requestHeaders;
        // 커뮤니티 iframe 임베드 문서 로드에만 유효한 제3자 Referer 주입
        // (file:// 오리진은 무효라 오류 153/152 발생. 플레이어 내부 요청은 건드리지 않음)
        if (details.resourceType === 'subFrame') h['Referer'] = 'https://ytseparator.com/';
        cb({ requestHeaders: h });
      }
    );
  } catch (e) { console.warn('[yt-referer]', e); }

  // ytsep://f/<encoded absolute path> → 파일 스트리밍 응답
  //   호스트('f')는 무시, pathname('/C:/...')만 사용
  // HTTP Range 지원 — <video> seek 필수. 브라우저가 Range 요청 보내면 206으로 응답.
  protocol.handle('ytsep', async (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname);
      if (p.startsWith('/')) p = p.slice(1);
      if (process.platform === 'win32') p = p.replace(/\//g, '\\');

      const stat = fs.statSync(p);
      const size = stat.size;
      const type = mimeFor(p);

      const commonHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Accept-Ranges': 'bytes',
        'Content-Type': type,
      };

      const rangeHdr = req.headers.get('range');
      const m = rangeHdr && /^bytes=(\d+)-(\d+)?$/.exec(rangeHdr);
      if (m) {
        const start = parseInt(m[1], 10);
        const end   = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : (size - 1);
        if (isNaN(start) || start > end || start >= size) {
          return new Response(null, {
            status: 416, headers: { ...commonHeaders, 'Content-Range': `bytes */${size}` },
          });
        }
        const chunk = end - start + 1;
        const stream = Readable.toWeb(fs.createReadStream(p, { start, end }));
        return new Response(stream, {
          status: 206,
          headers: {
            ...commonHeaders,
            'Content-Length': String(chunk),
            'Content-Range':  `bytes ${start}-${end}/${size}`,
          },
        });
      }

      // 전체 요청
      const stream = Readable.toWeb(fs.createReadStream(p));
      return new Response(stream, {
        status: 200,
        headers: { ...commonHeaders, 'Content-Length': String(size) },
      });
    } catch (e) {
      return new Response('not found: ' + e.message, { status: 404 });
    }
  });
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  // 앱이 뜨고 3초 뒤 업데이트 조회 (사용자가 disable 했으면 skip)
  setTimeout(() => {
    const s = readSettings();
    if (s.autoUpdateEnabled === false) return;
    checkForUpdates();
  }, 3000);
});

// ── Auto-updater ────────────────────────────────────────
// electron-updater가 GitHub Releases에서 latest.yml + Setup.exe 조회.
// dev (unpackaged) 또는 portable 실행 시엔 update path가 없으니 skip.
autoUpdater.autoDownload = false;                 // 사용자에게 알린 뒤 명시 다운로드
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdate(payload) {
  if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('update:event', payload);
  }
}

autoUpdater.on('checking-for-update', () => sendUpdate({ type: 'checking' }));
autoUpdater.on('update-available',    (info) => sendUpdate({ type: 'available', version: info.version, notes: info.releaseNotes || null }));
autoUpdater.on('update-not-available',(info) => sendUpdate({ type: 'not-available', version: info?.version }));
autoUpdater.on('download-progress',   (p)    => sendUpdate({ type: 'progress', percent: p.percent, speed: p.bytesPerSecond, transferred: p.transferred, total: p.total }));
autoUpdater.on('update-downloaded',   (info) => sendUpdate({ type: 'downloaded', version: info.version }));
autoUpdater.on('error',               (err)  => sendUpdate({ type: 'error', message: err?.message || String(err) }));

function isPortableBuild() {
  // electron-builder Portable 타겟이 부여하는 env var. execPath는 임시폴더로 확장돼 부정확.
  return !!process.env.PORTABLE_EXECUTABLE_FILE;
}

function cmpVer(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function checkForUpdatesPortable() {
  try {
    const res = await net.fetch(`https://api.github.com/repos/whalemindbass/yt-separator-releases/releases/latest`, {
      headers: { 'User-Agent': 'yt-separator-desktop', 'Accept': 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const rel = await res.json();
    const latest  = (rel.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();
    if (cmpVer(latest, current) > 0) {
      sendUpdate({
        type: 'available',
        version: latest,
        notes: rel.body || null,
        portable: true,
        releaseUrl: rel.html_url || `https://github.com/whalemindbass/yt-separator-releases/releases/tag/${rel.tag_name}`,
      });
    } else {
      sendUpdate({ type: 'not-available', version: current });
    }
  } catch (e) {
    sendUpdate({ type: 'error', message: e.message });
  }
}

function checkForUpdates() {
  if (isDev) { console.log('[updater] skip in dev'); return; }
  if (isPortableBuild()) {
    checkForUpdatesPortable();
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => sendUpdate({ type: 'error', message: err.message }));
}

// Window controls (frameless)
ipcMain.handle('window:minimize',   () => { mainWindow?.minimize(); });
ipcMain.handle('window:maxToggle',  () => {
  if (!mainWindow) return { maximized: false };
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { maximized: mainWindow.isMaximized() };
});
ipcMain.handle('window:close',      () => { mainWindow?.close(); });
ipcMain.handle('window:isMaximized',() => !!mainWindow?.isMaximized());
ipcMain.handle('clipboard:read',    () => clipboard.readText() || '');

// ── 설정 IPC ─────────────────────────────────────────
ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_ev, obj) => {
  const cur = readSettings();
  const merged = { ...cur, ...obj };
  return { ok: writeSettings(merged), settings: merged };
});
ipcMain.handle('settings:pickDownloadsDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: '영상 다운로드 폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: downloadsDir(),
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  const dir = res.filePaths[0];
  const merged = { ...readSettings(), downloadsDir: dir };
  writeSettings(merged);
  return { ok: true, dir };
});
ipcMain.handle('settings:downloadsDir', () => downloadsDir());
ipcMain.handle('settings:pickStemsDir', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: '스템 저장 폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: stemsDir(),
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  const dir = res.filePaths[0];
  const merged = { ...readSettings(), stemsDir: dir };
  writeSettings(merged);
  return { ok: true, dir };
});
ipcMain.handle('settings:stemsDir', () => stemsDir());
ipcMain.handle('settings:calcDiskUsage', () => {
  const dlDir  = downloadsDir();
  const modDir = path.join(app.getPath('userData'), 'models');
  let total = 0, downloads = 0, models = 0;
  const walk = (dir) => {
    let sum = 0;
    if (!fs.existsSync(dir)) return sum;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) sum += walk(p);
        else { try { sum += fs.statSync(p).size; } catch {} }
      }
    } catch {}
    return sum;
  };
  downloads = walk(dlDir);
  const stDir = stemsDir();
  if (!isInsideDir(dlDir, stDir) && path.normalize(stDir) !== path.normalize(dlDir)) downloads += walk(stDir);
  models = walk(modDir);
  total = downloads + models;
  return { downloads, models, total, downloadsDir: dlDir, modelsDir: modDir };
});
ipcMain.handle('settings:deleteModel', (_ev, key) => {
  const m = MODELS[key];
  if (!m) return { ok: false, error: 'unknown model: ' + key };
  const p = path.join(app.getPath('userData'), 'models', m.file);
  try { if (fs.existsSync(p)) fs.rmSync(p, { force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('settings:appInfo', () => ({
  appVersion:      app.getVersion(),
  electronVersion: process.versions.electron,
  chromeVersion:   process.versions.chrome,
  nodeVersion:     process.versions.node,
  platform:        process.platform,
  arch:            process.arch,
}));
ipcMain.handle('settings:openUserData', async () => {
  await shell.openPath(app.getPath('userData'));
  return true;
});
ipcMain.handle('dialog:saveAs', async (_ev, defaultName, exts) => {
  const filters = [{ name: 'WAV', extensions: exts || ['wav'] }];
  const res = await dialog.showSaveDialog(mainWindow || null, {
    title: '저장 위치 선택',
    defaultPath: defaultName || 'export.wav',
    filters,
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  grantWrite(res.filePath);
  return { ok: true, filePath: res.filePath };
});
// 프로젝트(.yssproj) — 사용자가 고른 임의 경로에 JSON 저장/열기
ipcMain.handle('project:save', async (_ev, json, name, existingPath) => {
  let target = existingPath;
  if (!target) {   // 경로 없으면 새로 저장(다이얼로그)
    const res = await dialog.showSaveDialog(mainWindow || null, {
      title: '프로젝트 저장',
      defaultPath: (name || '프로젝트') + '.yssproj',
      filters: [{ name: 'YSS Project', extensions: ['yssproj'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    target = res.filePath;
  }
  try { fs.writeFileSync(target, String(json), 'utf8'); return { ok: true, path: target }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// ── 자동 저장 ────────────────────────────────────────────────
// 저장 안 한 작업을 잃지 않기 위한 최소 장치. 사용자가 고른 .yssproj 는 건드리지 않고
// 별도 파일에 스냅샷만 남긴다 — 자동 저장이 원본을 덮어쓰면 그게 더 큰 사고다.
function autosavePath() { return path.join(app.getPath('userData'), 'autosave.yssproj'); }
function autosaveMetaPath() { return path.join(app.getPath('userData'), 'autosave.json'); }

ipcMain.handle('project:autosaveWrite', (_ev, json, meta) => {
  try {
    // 임시 파일에 쓰고 바꿔치기한다. 쓰는 도중 죽으면 지난 스냅샷이라도 남아야 한다.
    const tmp = autosavePath() + '.tmp';
    fs.writeFileSync(tmp, String(json), 'utf8');
    fs.renameSync(tmp, autosavePath());
    fs.writeFileSync(autosaveMetaPath(), JSON.stringify({ ...(meta || {}), at: Date.now() }), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('project:autosaveRead', () => {
  try {
    if (!fs.existsSync(autosavePath())) return { ok: false };
    const meta = JSON.parse(fs.readFileSync(autosaveMetaPath(), 'utf8'));
    return { ok: true, data: fs.readFileSync(autosavePath(), 'utf8'), meta };
  } catch { return { ok: false }; }
});

ipcMain.handle('project:autosaveClear', () => {
  for (const p of [autosavePath(), autosaveMetaPath()]) { try { fs.unlinkSync(p); } catch {} }
  return { ok: true };
});

// 저장 안 한 변경이 있는지 렌더러가 알려 준다 — 창을 닫을 때 물어보기 위해서다
let unsavedWork = false;
ipcMain.on('project:dirty', (_ev, v) => { unsavedWork = !!v; });

ipcMain.handle('project:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: '프로젝트 열기',
    properties: ['openFile'],
    filters: [{ name: 'YSS Project', extensions: ['yssproj'] }],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  try { return { ok: true, path: res.filePaths[0], data: fs.readFileSync(res.filePaths[0], 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('dialog:pickFolder', async (_ev, title) => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: title || '폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  grantWriteDir(res.filePaths[0]);
  return { ok: true, dir: res.filePaths[0] };
});

// 사용자가 대화상자에서 직접 고른 위치.
//   렌더러는 이 값을 스스로 만들어낼 수 없다 — 사람이 네이티브 창에서 고른 것만 들어온다.
//   그래서 허용 폴더 밖이라도 여기 담긴 곳에는 쓸 수 있다. 이게 없으면 저장 위치를
//   설정의 영상/스템 폴더 밖으로 고른 순간 "path not allowed" 로 막혔다.
const grantedFiles = new Set();
const grantedDirs  = new Set();
const norm = (p) => { try { return path.normalize(p).replace(/[\/]+$/, '').toLowerCase(); } catch { return null; } };
function grantWrite(p)    { const n = norm(p); if (n) grantedFiles.add(n); }
function grantWriteDir(p) { const n = norm(p); if (n) grantedDirs.add(n); }

// 렌더러가 쓰기 요청하는 경로는 허용 폴더(다운로드/스템/userData) 하위이거나,
// 사용자가 직접 고른 곳이어야 한다.
function allowedWriteTarget(p) {
  if (typeof p !== 'string' || !p) return false;
  const n = norm(p);
  if (n && grantedFiles.has(n)) return true;
  if (n && grantedDirs.has(norm(path.dirname(p)))) return true;   // 고른 폴더 바로 아래
  const roots = [downloadsDir(), stemsDir(), app.getPath('userData')];
  return roots.some(r => { try { return path.normalize(p) === path.normalize(r) || isInsideDir(r, p); } catch { return false; } });
}
ipcMain.handle('fs:copyFile', async (_ev, src, dst) => {
  if (!allowedWriteTarget(dst)) return { ok: false, error: 'destination not allowed' };
  try { fs.copyFileSync(src, dst); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:writeBuffer', async (_ev, p, data) => {
  if (!allowedWriteTarget(p)) return { ok: false, error: 'path not allowed' };
  try { fs.writeFileSync(p, Buffer.from(data)); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('dialog:pickMedia', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: '분리할 영상/오디오 파일 선택',
    properties: ['openFile'],
    filters: [
      { name: '영상/오디오', extensions: ['mp4','mkv','webm','mov','avi','m4a','mp3','wav','flac','aac','ogg'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, filePath: res.filePaths[0] };
});
// 스튜디오: 오디오 파일 여러 개 임포트 (트랙 클립)
ipcMain.handle('dialog:pickAudioFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: '오디오 파일 임포트',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '오디오', extensions: ['wav','mp3','flac','ogg','aif','aiff','m4a','aac'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, filePaths: res.filePaths };
});
// 스튜디오: 비디오 파일 임포트
ipcMain.handle('dialog:pickVideoFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: '영상 파일 임포트',
    properties: ['openFile'],
    filters: [
      { name: '영상', extensions: ['mp4','mkv','webm','mov','avi','m4v'] },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, filePath: res.filePaths[0] };
});

ipcMain.handle('update:check',    () => { checkForUpdates(); return { ok: true }; });
ipcMain.handle('update:download', async () => {
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:install',  () => { autoUpdater.quitAndInstall(true, true); return { ok: true }; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── 실시간 오디오 엔진(JUCE 사이드카) 브리지 ──────────────
const { AudioEngine } = require('./engine-client');
let audioEngine = null;
let lastRecordFile = null;   // 마지막으로 녹음을 걸어 둔 파일 — 엔진이 죽었을 때 되살릴 대상

/**
 * 쓰다 만 WAV 의 길이 필드를 실제 파일 크기로 고친다.
 *
 * 녹음 중 엔진이 죽으면 오디오 데이터는 디스크에 남지만 RIFF·data 크기가 처음 값 그대로라
 * 대부분의 프로그램이 "길이 0" 으로 읽는다. 소리는 멀쩡히 있는데 못 여는 상태다.
 * 청크를 훑어 data 를 찾고 두 크기를 파일 크기에서 되계산한다.
 */
function repairWav(file) {
  try {
    const size = fs.statSync(file).size;
    if (size < 64) { try { fs.unlinkSync(file); } catch {} return null; }   // 헤더뿐 — 건질 것이 없다

    const fd = fs.openSync(file, 'r+');
    try {
      const head = Buffer.alloc(Math.min(size, 4096));
      fs.readSync(fd, head, 0, head.length, 0);
      if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;

      let pos = 12, dataAt = -1, fmt = null;
      while (pos + 8 <= head.length) {
        const id = head.toString('latin1', pos, pos + 4);
        const len = head.readUInt32LE(pos + 4);
        if (id === 'fmt ') fmt = { channels: head.readUInt16LE(pos + 10), rate: head.readUInt32LE(pos + 12), bits: head.readUInt16LE(pos + 22) };
        if (id === 'data') { dataAt = pos; break; }
        pos += 8 + len + (len & 1);
      }
      if (dataAt < 0) return null;

      const dataBytes = size - (dataAt + 8);
      if (dataBytes <= 0) { try { fs.unlinkSync(file); } catch {} return null; }

      const four = Buffer.alloc(4);
      four.writeUInt32LE(size - 8, 0);      fs.writeSync(fd, four, 0, 4, 4);            // RIFF 크기
      four.writeUInt32LE(dataBytes, 0);     fs.writeSync(fd, four, 0, 4, dataAt + 4);   // data 크기

      const bytesPerFrame = Math.max(1, (fmt?.channels || 1) * Math.ceil((fmt?.bits || 16) / 8));
      const seconds = dataBytes / bytesPerFrame / (fmt?.rate || 44100);
      return seconds >= 0.5 ? { file, seconds } : null;   // 0.5초 미만은 되살릴 값이 없다
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}
function getEngine() {
  if (!audioEngine) {
    audioEngine = new AudioEngine();
    audioEngine.on('event', (m) => { try { mainWindow?.webContents.send('engine:event', m); } catch {} });
    audioEngine.on('log',   (s) => { try { mainWindow?.webContents.send('engine:event', { ev: 'log', msg: String(s) }); } catch {} });
    audioEngine.on('exit',  (c, crashed) => {
      // 죽었는데 녹음 중이었다면 쓰다 만 WAV 가 남아 있다. 헤더를 고쳐 되살릴 수 있게 넘긴다.
      let take = null;
      if (crashed && lastRecordFile) take = repairWav(lastRecordFile);
      lastRecordFile = null;
      try { mainWindow?.webContents.send('engine:event', { ev: 'exit', code: c, crashed: !!crashed, take }); } catch {}
    });
  }
  return audioEngine;
}
ipcMain.handle('engine:start', (_e, stems) => {
  const eng = getEngine();
  return { ok: eng.start(Array.isArray(stems) ? stems : []), exe: eng.exePath };
});
ipcMain.handle('engine:cmd',  (_e, cmd) => {
  // 정상적으로 멈췄으면 파일은 엔진이 마무리한다 — 되살릴 대상이 아니다
  if (cmd && cmd.cmd === 'recordStop') lastRecordFile = null;
  return { ok: getEngine().send(cmd) };
});
ipcMain.handle('engine:recordArm', () => {
  const dir = path.join(downloadsDir(), 'takes');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, `take-${Date.now()}.wav`);
  lastRecordFile = file;   // 엔진이 죽으면 이 파일을 되살려야 한다
  return { ok: getEngine().send({ cmd: 'recordArm', file }), file };
});
// Export MP3: 엔진이 렌더한 임시 WAV → ffmpeg 로 MP3 변환 후 임시 삭제
ipcMain.handle('audio:transcode', async (_ev, src, dst, opts) => {
  if (typeof src !== 'string' || !fs.existsSync(src)) return { ok: false, error: '원본 없음' };
  if (typeof dst !== 'string' || !dst) return { ok: false, error: '대상 경로 없음' };
  const o = opts || {};
  const br = String(Math.max(64, Math.min(320, parseInt(o.bitrate, 10) || 320)));
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', src,
    '-codec:a', 'libmp3lame', '-b:a', br + 'k', '-y', dst];
  return await new Promise((resolve) => {
    let proc; try { proc = spawn(FFMPEG_BIN, args, { windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: String(e.message || e) }); }
    let stderr = '';
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    proc.on('close', (code) => {
      try { fs.unlinkSync(src); } catch {}   // 임시 WAV 정리
      if (code === 0) resolve({ ok: true, dst });
      else resolve({ ok: false, error: 'ffmpeg exit ' + code + ': ' + stderr.slice(-200) });
    });
  });
});
ipcMain.handle('engine:quit', () => { audioEngine?.quit(); return { ok: true }; });
// 종료 시 엔진 자식 프로세스가 orphan 으로 남지 않도록 exit 까지 기다림 (Windows 는 자동 종료 안 됨)
let _quitting = false;
app.on('will-quit', (e) => {
  if (_quitting || !audioEngine) return;
  e.preventDefault();
  _quitting = true;
  const eng = audioEngine;
  const done = () => { audioEngine = null; try { app.quit(); } catch {} };
  try { eng.once('exit', done); } catch {}
  eng.quit();               // quit 명령 + 800ms 후 kill (engine-client)
  setTimeout(done, 1500);   // 안전망: exit 이벤트 없어도 강제 진행
});

// ── IPC: 앱 메타 ──────────────────────────────────────
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:platform', () => process.platform);
ipcMain.handle('app:downloadsDir', () => downloadsDir());
ipcMain.handle('shell:openExternal', async (_ev, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return false;
  await shell.openExternal(url);
  return true;
});
ipcMain.handle('shell:openPath', async (_ev, p) => {
  if (typeof p !== 'string') return false;
  await shell.openPath(p);
  return true;
});

// ── yt-dlp: probe (영상 메타만 조회) ─────────────────
// URL이 유효하고 접근 가능한지 + 제목/썸네일 등 표시
ipcMain.handle('ytdlp:probe', async (_ev, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return { ok: false, error: '올바른 URL이 아닙니다' };
  }
  return await new Promise((resolve) => {
    const args = ['--dump-single-json', '--no-warnings', '--skip-download', '--no-playlist', url];
    const proc = spawn(YTDLP_BIN, args, { windowsHide: true });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => stdout += d);
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ ok: false, error: stderr.slice(-400) || `yt-dlp exit ${code}` });
      try {
        const info = JSON.parse(stdout);
        resolve({
          ok: true,
          info: {
            id:         info.id,
            title:      info.title,
            uploader:   info.uploader || info.channel,
            duration:   info.duration,
            thumbnail:  info.thumbnail,
            webpage_url: info.webpage_url || url,
          },
        });
      } catch (err) {
        resolve({ ok: false, error: 'JSON parse 실패: ' + err.message });
      }
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// ── yt-dlp: download (video+audio, mp4로 merge) ──────
// 진행률은 webContents.send('ytdlp:progress', {...}) 로 renderer에 push
/** @type {import('child_process').ChildProcess | null} */
let activeDownload = null;

ipcMain.handle('ytdlp:download', async (_ev, url, opts = {}) => {
  // 스테일 참조 정리 — 이전 proc 이 이미 죽었지만 close 이벤트가 lost 된 경우 방어
  if (activeDownload && (activeDownload.exitCode !== null || activeDownload.killed || !activeDownload.pid)) {
    activeDownload = null;
  }
  if (activeDownload) {
    dlog('[yt-dlp] busy — pid=' + activeDownload.pid + ' exitCode=' + activeDownload.exitCode);
    return { ok: false, error: '이미 다운로드 중입니다 (진행 취소 후 재시도)' };
  }
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    return { ok: false, error: '올바른 URL이 아닙니다' };
  }

  const outDir = downloadsDir();
  const base = makeFileBase(opts.title, opts.id || 'video');
  const outTemplate = path.join(outDir, base + '.%(ext)s');
  const progressTpl = 'PROG {"status":"downloading","dl":%(progress.downloaded_bytes)s,"total":%(progress.total_bytes)s,"tot_est":%(progress.total_bytes_estimate)s,"speed":%(progress.speed)s,"eta":%(progress.eta)s}';

  // 화질 선택 (용량 절약)
  const quality = String(opts.quality || '1080').toLowerCase();
  const heightCap = ({ '2160': 2160, '1440': 1440, '1080': 1080, '720': 720, '480': 480, '360': 360 })[quality] || 1080;
  const formatSpec = `bv*[height<=${heightCap}][ext=mp4]+ba[ext=m4a]/b[height<=${heightCap}]/best`;

  const args = [
    '--newline',
    '--no-warnings',
    '--no-playlist',
    '-f', formatSpec,
    '--merge-output-format', 'mp4',
    '--ffmpeg-location', FFMPEG_DIR,
    '-o', outTemplate,
    '--progress-template', progressTpl,
    url,
  ];

  return await new Promise((resolve) => {
    const proc = spawn(YTDLP_BIN, args, { windowsHide: true });
    activeDownload = proc;
    let lastFile = null;
    let phase = 'video'; // yt-dlp는 video 다음에 audio 처리
    const send = (data) => { try { mainWindow?.webContents?.send('ytdlp:progress', data); } catch {} };

    let mergedFile = null;   // [Merger] 가 알려주는 최종 결과 경로 (가장 신뢰도 높음)
    proc.stdout.on('data', (chunk) => {
      String(chunk).split(/\r?\n/).forEach((line) => {
        if (!line) return;
        if (line.startsWith('PROG ')) {
          try {
            const j = JSON.parse(line.slice(5));
            const total = j.total || j.tot_est || 0;
            const ratio = total > 0 ? j.dl / total : 0;
            send({
              phase,
              ratio,
              dl: j.dl,
              total,
              speed: j.speed,
              eta: j.eta,
            });
          } catch {}
        } else if (/^\[Merger\]/.test(line)) {
          phase = 'merge';
          // [Merger] Merging formats into "C:\path\file.mp4"
          const m = line.match(/into\s+"([^"]+)"/);
          if (m) mergedFile = m[1];
          send({ phase: 'merge', ratio: 0.98 });
        } else if (/^\[download\] Destination: /.test(line)) {
          // "video"→"audio" 전환 감지
          if (lastFile) phase = 'audio';
          lastFile = line.replace(/^\[download\] Destination: /, '').trim();
        }
      });
    });
    let stderrBuf = '', stdoutTail = '';   // 실패 시 원인 파악용
    proc.stderr.on('data', (d) => {
      const s = String(d);
      stderrBuf += s; if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
      if (/ERROR|error/i.test(s)) send({ phase: 'error', message: s.slice(0, 500) });
    });
    proc.stdout.on('data', (d) => {
      const s = String(d);
      stdoutTail += s; if (stdoutTail.length > 4000) stdoutTail = stdoutTail.slice(-4000);
      // 진행률 라인 아닌 실제 로그만 콘솔 (PROG spam 방지)
    });
    // 결과 파일 확정 — [Merger] 경로 > [download] Destination > outDir 스캔 순으로 신뢰
    const resolveOutputFile = () => {
      for (const cand of [mergedFile, lastFile]) {
        if (!cand) continue;
        const p = path.isAbsolute(cand) ? cand : path.join(outDir, cand);
        if (fs.existsSync(p) && /\.(mp4|mkv|webm|m4a|mp3|wav)$/i.test(p)) return p;
      }
      // 폴백 1: base 로 시작하는 파일. 폴백 2: outDir 에서 가장 최근 미디어 파일
      try {
        const media = fs.readdirSync(outDir)
          .filter((f) => /\.(mp4|mkv|webm)$/i.test(f))
          .map((f) => ({ f, m: fs.statSync(path.join(outDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        const byBase = media.find((x) => x.f.startsWith(base));
        const pick = byBase || media[0];
        // 폴백 2는 방금(2분 이내) 생성된 것만 채택 — 엉뚱한 옛 파일 반환 방지
        if (pick && (byBase || Date.now() - pick.m < 120000)) return path.join(outDir, pick.f);
      } catch {}
      return null;
    };

    // close 는 자식(ffmpeg)이 파이프를 물고 있으면 영영 안 올 수 있음 → exit 로 확정하고 grace 만 줌
    let settled = false;
    const finalize = (code, why) => {
      if (settled) return;
      settled = true;
      activeDownload = null;
      if (code !== 0) {
        const errTail = (stderrBuf || stdoutTail || '').split(/\r?\n/).filter(l => l.trim()).slice(-8).join(' | ');
        const msg = `yt-dlp exit ${code}${errTail ? ' — ' + errTail : ''}`;
        dlog('[yt-dlp] FAILED:', msg);
        send({ phase: 'error', message: msg.slice(0, 800) });
        return resolve({ ok: false, error: msg.slice(0, 800) });
      }
      try {
        const filePath = resolveOutputFile();
        if (!filePath) {
          const msg = `다운로드는 끝났지만 결과 파일을 찾지 못함 (base="${base}", dir="${outDir}")`;
          dlog('[yt-dlp]', msg);
          send({ phase: 'error', message: msg });
          return resolve({ ok: false, error: msg });
        }
        send({ phase: 'done', ratio: 1, filePath });
        resolve({ ok: true, filePath });
      } catch (err) {
        dlog('[yt-dlp] finalize error:', String(err));
        resolve({ ok: false, error: err.message });
      }
    };

    // exit = 프로세스 종료 즉시. stdout 잔여 flush 위해 250ms 만 기다렸다 확정
    proc.on('exit', (code) => setTimeout(() => finalize(code ?? 0, 'exit'), 250));
    // close 가 먼저 오면 그걸로 확정 (정상 케이스)
    proc.on('close', (code) => finalize(code ?? 0, 'close'));
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      activeDownload = null;
      dlog('[yt-dlp] spawn error:', String(err));
      resolve({ ok: false, error: err.message });
    });
  });
});

ipcMain.handle('ytdlp:cancel', () => {
  if (activeDownload) {
    try { activeDownload.kill(); } catch {}
    activeDownload = null;
    return true;
  }
  return false;
});

// ── STEM: 모델 관리 ─────────────────────────────────────
// 각 모델은 GitHub Release 'models-v1'에서 on-demand 다운로드.
// 저장 위치: userData/models/<file>. 앱 업데이트 후에도 유지됨.
const MODELS = {
  '4stem': {
    key:      '4stem',
    label:    '4-stem (htdemucs)',
    file:     'htdemucs_core.onnx',
    sources:  4,
    stems:    ['drums', 'bass', 'other', 'vocals'],
    size:     174735359,    // 대략 크기 (진행률용). 실제 크기가 달라도 무해.
    url:      'https://github.com/whalemindbass/yt-separator-releases/releases/download/models-v1/htdemucs_core.onnx',
  },
  '6stem': {
    key:      '6stem',
    label:    '6-stem (htdemucs_6s)',
    file:     'htdemucs_6s.onnx',
    sources:  6,
    stems:    ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'],
    size:     115343360,
    url:      'https://github.com/whalemindbass/yt-separator-releases/releases/download/models-v1/htdemucs_6s.onnx',
  },
};
const DEFAULT_MODEL_KEY = '4stem';

function modelsDir() {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function modelPath(key) {
  const m = MODELS[key] || MODELS[DEFAULT_MODEL_KEY];
  return path.join(modelsDir(), m.file);
}
/** 이전 번들 위치(installed/dev)에서 userData로 마이그레이션 (있으면 복사) */
function migrateBundledModel(key) {
  const dest = modelPath(key);
  if (fs.existsSync(dest)) return;
  const m = MODELS[key];
  const bundledBase = isDev ? __dirname : process.resourcesPath;
  const bundled = path.join(bundledBase, 'models', m.file);
  if (fs.existsSync(bundled)) {
    try {
      fs.copyFileSync(bundled, dest);
      console.log(`[model] migrated bundled ${key} → ${dest}`);
    } catch (e) { console.warn('[model] migrate failed', e.message); }
  }
}

/** 진행률을 renderer로 forward */
function sendModelProgress(key, payload) {
  if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('stem:modelDownloadProgress', { key, ...payload });
  }
}

const activeDownloads = new Map();  // key → { req, canceled }

/** 모델 파일 확보 (없으면 다운로드). 성공 시 파일 경로 반환 */
async function ensureModel(key) {
  migrateBundledModel(key);
  const dest = modelPath(key);
  if (fs.existsSync(dest)) return dest;

  const m = MODELS[key];
  if (!m) throw new Error('unknown model: ' + key);

  if (activeDownloads.has(key)) throw new Error('이미 다운로드 중');

  sendModelProgress(key, { phase: 'start', total: m.size });
  const tmp = dest + '.part';
  try { fs.unlinkSync(tmp); } catch {}

  return await new Promise((resolve, reject) => {
    const state = { req: null, canceled: false };
    activeDownloads.set(key, state);

    const fetchOnce = (url, redirects = 0) => {
      if (redirects > 5) { activeDownloads.delete(key); return reject(new Error('too many redirects')); }
      const https = require('https');
      const req = https.get(url, { headers: { 'User-Agent': 'yt-separator' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume();
          return fetchOnce(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) {
          activeDownloads.delete(key);
          return reject(new Error(`HTTP ${res.statusCode} 모델 다운로드 실패`));
        }
        const total = parseInt(res.headers['content-length'] || m.size, 10);
        let received = 0;
        const out = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
          if (state.canceled) { res.destroy(); out.destroy(); return; }
          received += chunk.length;
          sendModelProgress(key, { phase: 'progress', received, total });
        });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => {
            activeDownloads.delete(key);
            if (state.canceled) { try { fs.unlinkSync(tmp); } catch {} return reject(new Error('취소됨')); }
            try { fs.renameSync(tmp, dest); } catch (e) { return reject(e); }
            sendModelProgress(key, { phase: 'done' });
            resolve(dest);
          });
        });
        out.on('error', (e) => { activeDownloads.delete(key); reject(e); });
      });
      req.on('error', (e) => { activeDownloads.delete(key); reject(e); });
      state.req = req;
    };
    fetchOnce(m.url);
  });
}

ipcMain.handle('stem:models', () => {
  const out = {};
  for (const [k, m] of Object.entries(MODELS)) {
    const p = modelPath(k);
    let downloaded = fs.existsSync(p);
    if (!downloaded) { migrateBundledModel(k); downloaded = fs.existsSync(p); }
    out[k] = {
      key: k, label: m.label, sources: m.sources, stems: m.stems, size: m.size,
      downloaded,
      downloading: activeDownloads.has(k),
    };
  }
  return { ok: true, models: out, defaultKey: DEFAULT_MODEL_KEY };
});

ipcMain.handle('stem:ensureModel', async (_ev, key) => {
  try {
    const p = await ensureModel(key);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('stem:cancelModelDownload', (_ev, key) => {
  const s = activeDownloads.get(key);
  if (!s) return { ok: false, error: 'not downloading' };
  s.canceled = true;
  try { s.req.destroy(); } catch {}
  activeDownloads.delete(key);
  return { ok: true };
});

/** 렌더러에게 ArrayBuffer 전달. 모델이 없으면 다운로드 유도 (에러 반환) */
ipcMain.handle('stem:modelBytes', async (_ev, key = DEFAULT_MODEL_KEY) => {
  const m = MODELS[key];
  if (!m) return { ok: false, error: 'unknown model: ' + key };
  const p = modelPath(key);
  if (!fs.existsSync(p)) return { ok: false, error: `model not downloaded: ${m.label}`, needDownload: true };
  const buf = fs.readFileSync(p);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { ok: true, bytes: ab, sources: m.sources, stems: m.stems };
});

// ── STEM: audio 추출 (ffmpeg → raw f32 stereo 44100Hz) ─
ipcMain.handle('stem:extractAudio', async (_ev, videoPath) => {
  if (typeof videoPath !== 'string' || !fs.existsSync(videoPath)) {
    return { ok: false, error: '파일이 존재하지 않음: ' + videoPath };
  }
  const tmp = path.join(app.getPath('temp'), 'yss-' + crypto.randomBytes(4).toString('hex') + '.raw');
  const args = [
    '-nostdin', '-hide_banner', '-loglevel', 'error',
    '-i', videoPath,
    '-f', 'f32le',
    '-acodec', 'pcm_f32le',
    '-ar', '44100',
    '-ac', '2',
    '-y', tmp,
  ];
  return await new Promise((resolve) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('close', (code) => {
      if (code !== 0) {
        try { fs.unlinkSync(tmp); } catch {}
        return resolve({ ok: false, error: 'ffmpeg exit ' + code + ': ' + stderr.slice(-300) });
      }
      try {
        const buf = fs.readFileSync(tmp);
        fs.unlinkSync(tmp);
        // interleaved f32 stereo → 두 Float32Array로 분리
        const total = buf.byteLength / 8; // 4 bytes/sample × 2ch
        const left  = new Float32Array(total);
        const right = new Float32Array(total);
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        for (let i = 0; i < total; i++) {
          left[i]  = view.getFloat32(i * 8,     true);
          right[i] = view.getFloat32(i * 8 + 4, true);
        }
        resolve({
          ok: true,
          sampleRate: 44100,
          totalSamples: total,
          left:  left.buffer,
          right: right.buffer,
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// ── STEM: WAV 저장 (44100Hz Int16 stereo) ─────────────
// stems: { drums:[L,R], bass:[L,R], other:[L,R], vocals:[L,R] } (Float32Array)
// baseName: 파일 base (예: "IU - Through the Night-a3f7b2")
// 반환: { stemPaths: { drums: '...', bass: '...', ... } }
ipcMain.handle('stem:saveStems', async (_ev, stems, baseName, sampleRate) => {
  try {
    if (!stems || typeof stems !== 'object') return { ok: false, error: 'invalid stems' };
    const outDir = stemsDir();
    fs.mkdirSync(outDir, { recursive: true });
    const sr = sampleRate || 44100;
    const stemPaths = {};
    const dbg = [];
    for (const [name, ch] of Object.entries(stems)) {
      if (!Array.isArray(ch) || ch.length < 2) continue;
      const L = new Float32Array(ch[0]);
      const R = new Float32Array(ch[1]);
      // 진단: 받은 데이터 peak
      let peak = 0, nan = 0;
      const step = Math.max(1, Math.floor(L.length / 100000));
      for (let i = 0; i < L.length; i += step) {
        const v = L[i];
        if (Number.isNaN(v)) nan++;
        else { const a = Math.abs(v); if (a > peak) peak = a; }
      }
      dbg.push(`${name}: len=${L.length} peak=${peak.toFixed(4)} nan=${nan} bufBytes=${ch[0].byteLength || (ch[0] && ch[0].length) || '?'} ch0type=${ch[0]?.constructor?.name}`);
      const filePath = path.join(outDir, `${baseName}_${name}.wav`);
      writeWav16(filePath, L, R, sr);
      stemPaths[name] = filePath;
    }
    return { ok: true, stemPaths, outDir, dbg };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── IPC: 라이브러리 ──────────────────────────────────
function libraryFile() {
  return path.join(app.getPath('userData'), 'library.json');
}
function readLibrary() {
  try {
    const raw = fs.readFileSync(libraryFile(), 'utf-8');
    const j = JSON.parse(raw);
    return Array.isArray(j.items) ? j.items : [];
  } catch { return []; }
}
function writeLibrary(items) {
  fs.writeFileSync(libraryFile(), JSON.stringify({ items }, null, 2), 'utf-8');
}

ipcMain.handle('library:list', () => {
  // 파일이 실제로 존재하는 것만 반환
  const items = readLibrary().filter(it => {
    try { return fs.existsSync(it.videoPath); } catch { return false; }
  });

  // 정규화: 같은 videoPath 를 공유하는 항목들의 name/favorite/group 을 통일
  //   기준: createdAt 최대인 항목의 값 (가장 최근에 사용자가 편집했을 확률 높음).
  //   차이가 있으면 자동으로 파일에 반영해 저장.
  const groups = new Map();
  for (const it of items) {
    const k = it.videoPath;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  let dirty = false;
  for (const [, arr] of groups) {
    if (arr.length < 2) continue;
    // 대표 값 선택 (createdAt 최대)
    const rep = arr.reduce((a, b) => (a.createdAt || 0) >= (b.createdAt || 0) ? a : b);
    const canonName = rep.name;
    const canonFav  = !!rep.favorite;
    const canonGrp  = rep.group;
    for (const it of arr) {
      if (it.name !== canonName)                     { it.name = canonName; dirty = true; }
      if (!!it.favorite !== canonFav)                { it.favorite = canonFav; dirty = true; }
      if ((it.group || '') !== (canonGrp || ''))     {
        if (canonGrp) it.group = canonGrp; else delete it.group;
        dirty = true;
      }
    }
  }
  if (dirty) {
    // 원본에도 반영 (필터에서 제외된 항목 유지)
    const raw = readLibrary();
    for (const r of raw) {
      const canon = items.find(it => it.id === r.id);
      if (!canon) continue;
      r.name = canon.name;
      r.favorite = canon.favorite;
      if (canon.group) r.group = canon.group; else delete r.group;
    }
    writeLibrary(raw);
  }

  return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
});

/** YouTube video id로 이미 처리된 항목 찾기 */
ipcMain.handle('library:findByVideoId', (_ev, videoId) => {
  if (!videoId) return null;
  const items = readLibrary().filter(it => {
    try { return fs.existsSync(it.videoPath); } catch { return false; }
  });
  return items.find(it => it.meta && it.meta.id === videoId) || null;
});

ipcMain.handle('library:register', (_ev, entry) => {
  const items = readLibrary();
  const id = entry.id || crypto.randomBytes(6).toString('hex');
  const rec = {
    id,
    name: entry.name || 'Untitled',
    videoPath: entry.videoPath,
    stemPaths: entry.stemPaths || {},
    outDir: entry.outDir || '',
    sampleRate: entry.sampleRate || 44100,
    modelKey: entry.modelKey || '4stem',
    createdAt: Date.now(),
    meta: entry.meta || {},
  };
  // 같은 videoPath + 같은 modelKey 조합만 덮어쓰기.
  // videoPath 같아도 modelKey 다르면 새 항목 (4-stem/6-stem 동시 보유).
  const recKey = rec.modelKey || '4stem';
  const idx = items.findIndex(it => it.videoPath === rec.videoPath && (it.modelKey || '4stem') === recKey);
  if (idx >= 0) items[idx] = { ...items[idx], ...rec, createdAt: items[idx].createdAt || rec.createdAt };
  else items.push(rec);
  writeLibrary(items);
  return { ok: true, id: rec.id };
});

/** 같은 videoPath 를 공유하는 모든 항목의 인덱스 반환 (4/6-stem sibling 포함) */
function siblingIndices(items, videoPath) {
  if (!videoPath) return [];
  return items
    .map((it, i) => (it.videoPath === videoPath ? i : -1))
    .filter(i => i >= 0);
}

ipcMain.handle('library:rename', (_ev, id, name) => {
  const items = readLibrary();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  const newName = String(name || 'Untitled').slice(0, 200);
  for (const i of siblingIndices(items, items[idx].videoPath)) items[i].name = newName;
  writeLibrary(items);
  return { ok: true };
});

/** 즐겨찾기 토글 — 같은 영상의 모든 변형에 동일 적용 */
ipcMain.handle('library:setFavorite', (_ev, id, fav) => {
  const items = readLibrary();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  const val = !!fav;
  for (const i of siblingIndices(items, items[idx].videoPath)) items[i].favorite = val;
  writeLibrary(items);
  return { ok: true, favorite: val };
});

/** 그룹 지정 — 같은 영상의 모든 변형에 동일 적용 */
ipcMain.handle('library:setGroup', (_ev, id, group) => {
  const items = readLibrary();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  const g = String(group || '').slice(0, 80).trim();
  for (const i of siblingIndices(items, items[idx].videoPath)) {
    if (g) items[i].group = g; else delete items[i].group;
  }
  writeLibrary(items);
  return { ok: true };
});

/**
 * 정리 — orphan 삭제는 위험해서 완전히 제외.
 *
 * "정리"의 정의를 아래로 국한:
 *   - library.json 내부에서 meta.id 중복 항목만 제거
 *   - 삭제되는 항목의 videoPath / stemPaths 파일도 함께 삭제 (안전 경로 검사 포함)
 *
 *  disk 상의 orphan 파일은 별도 API `library:preview`로 나열만 하고, 삭제는 사용자가 개별 확인해야 함.
 */
function safeDeleteInDownloads(p) {
  const dlDir   = downloadsDir();
  const stemDir = stemsDir();
  const isInside = isInsideDir;
  const abs = path.normalize(String(p || ''));
  if (!abs) return null;
  if (!isInside(dlDir, abs) && !isInside(stemDir, abs)) return null;
  try {
    if (!fs.existsSync(abs)) return null;
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const size = st.size;
    fs.rmSync(abs, { force: true });
    return { path: abs, size };
  } catch { return null; }
}

ipcMain.handle('library:cleanup', () => {
  const rawItems = readLibrary();
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: true, removed: 0, removedFiles: 0, freedBytes: 0, deletedPaths: [] };
  }

  // (meta.id + modelKey) 조합으로 그룹화 — 4/6-stem 공존은 dedup 대상 아님
  const byId = new Map();
  rawItems.forEach((it, i) => {
    const id = it && it.meta && it.meta.id;
    if (!id) return;
    const key = `${id}::${it.modelKey || '4stem'}`;
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(i);
  });
  const toRemoveIdx = new Set();
  for (const [, idxs] of byId) {
    if (idxs.length < 2) continue;
    let keepIdx = idxs[0];
    for (const i of idxs) {
      if ((rawItems[i].createdAt || 0) > (rawItems[keepIdx].createdAt || 0)) keepIdx = i;
    }
    for (const i of idxs) if (i !== keepIdx) toRemoveIdx.add(i);
  }

  const deletedPaths = [];
  let removed = 0, removedFiles = 0, freedBytes = 0;
  const keptItems = [];

  rawItems.forEach((it, i) => {
    if (!toRemoveIdx.has(i)) { keptItems.push(it); return; }
    const paths = [it.videoPath, ...Object.values(it.stemPaths || {})];
    for (const p of paths) {
      const r = safeDeleteInDownloads(p);
      if (r) { deletedPaths.push(r.path); freedBytes += r.size; removedFiles++; }
    }
    removed++;
  });

  writeLibrary(keptItems);
  return { ok: true, removed, removedFiles, freedBytes, deletedPaths, libraryCount: keptItems.length };
});

/**
 * 미리보기 — disk에 있는 파일 중 library에서 참조되지 않는 것을 나열 (삭제 안 함).
 * UI에서 개별 확인 후 사용자가 원하면 별도 삭제.
 */
ipcMain.handle('library:previewOrphans', () => {
  const rawItems = readLibrary();
  const dlDir = downloadsDir();
  const stemDir = stemsDir();
  const normKey = (p) => {
    if (!p) return '';
    const abs = path.normalize(String(p));
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const referenced = new Set();
  rawItems.forEach(it => {
    if (it.videoPath) referenced.add(normKey(it.videoPath));
    Object.values(it.stemPaths || {}).forEach(p => p && referenced.add(normKey(p)));
  });
  const collect = (dir, extRe) => {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      if (extRe && !extRe.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (referenced.has(normKey(full))) continue;
      try { out.push({ path: full, size: fs.statSync(full).size }); } catch {}
    }
    return out;
  };
  return {
    ok: true,
    libraryCount: rawItems.length,
    videos: collect(dlDir,   /\.(mp4|webm|mkv|m4a)$/i),
    stems:  collect(stemDir, /\.wav$/i),
  };
});

/** 개별 orphan 파일 삭제 (allowed dir 내부만) */
ipcMain.handle('library:deleteOrphan', (_ev, p) => {
  const r = safeDeleteInDownloads(p);
  return r ? { ok: true, freedBytes: r.size } : { ok: false, error: '삭제 실패 또는 경로 불허' };
});

ipcMain.handle('library:delete', (_ev, id, alsoFiles) => {
  const items = readLibrary();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  const it = items[idx];
  if (alsoFiles) {
    // outDir 은 여러 항목의 stem 파일을 공유하는 폴더일 수 있으므로 절대 recursive 삭제 금지.
    // 대상 항목의 stemPaths 만 개별 삭제.
    for (const p of Object.values(it.stemPaths || {})) {
      try { fs.rmSync(p, { force: true }); } catch {}
    }
    // videoPath 는 4/6-stem sibling 이 공유 → 다른 형제가 남아있으면 유지
    const otherRefs = items.filter((x, i) => i !== idx && x.videoPath === it.videoPath);
    if (otherRefs.length === 0) {
      try { fs.rmSync(it.videoPath, { force: true }); } catch {}
    }
  }
  items.splice(idx, 1);
  writeLibrary(items);
  return { ok: true };
});

/** Int16 stereo WAV 저장 */
function writeWav16(filePath, L, R, sampleRate) {
  const numFrames = Math.min(L.length, R.length);
  const dataBytes = numFrames * 2 * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);
  let off = 44;
  for (let i = 0; i < numFrames; i++) {
    let l = Math.max(-1, Math.min(1, L[i]));
    let r = Math.max(-1, Math.min(1, R[i]));
    buffer.writeInt16LE(l < 0 ? l * 0x8000 : l * 0x7FFF, off);
    buffer.writeInt16LE(r < 0 ? r * 0x8000 : r * 0x7FFF, off + 2);
    off += 4;
  }
  fs.writeFileSync(filePath, buffer);
}
