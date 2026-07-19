'use strict';
// YT Separator Desktop — Electron main process

const { app, BrowserWindow, ipcMain, shell, protocol, net, clipboard, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

/** userData/downloads (기본) — 사용자가 설정에서 변경했으면 커스텀 경로 */
function downloadsDir() {
  const s = readSettings();
  let dir = s.downloadsDir;
  if (!dir || typeof dir !== 'string') {
    dir = path.join(app.getPath('userData'), 'downloads');
  }
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
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
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
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
    title: '다운로드 폴더 선택',
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
  return { ok: true, filePath: res.filePath };
});
ipcMain.handle('dialog:pickFolder', async (_ev, title) => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: title || '폴더 선택',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, dir: res.filePaths[0] };
});
ipcMain.handle('fs:copyFile', async (_ev, src, dst) => {
  try { fs.copyFileSync(src, dst); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('fs:writeBuffer', async (_ev, path, data) => {
  try { fs.writeFileSync(path, Buffer.from(data)); return { ok: true }; }
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

ipcMain.handle('update:check',    () => { checkForUpdates(); return { ok: true }; });
ipcMain.handle('update:download', async () => {
  try { await autoUpdater.downloadUpdate(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('update:install',  () => { autoUpdater.quitAndInstall(true, true); return { ok: true }; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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
  if (activeDownload) return { ok: false, error: '이미 다운로드 중입니다' };
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
          send({ phase: 'merge', ratio: 0.98 });
        } else if (/^\[download\] Destination: /.test(line)) {
          // "video"→"audio" 전환 감지
          if (lastFile) phase = 'audio';
          lastFile = line.replace(/^\[download\] Destination: /, '').trim();
        }
      });
    });
    proc.stderr.on('data', (d) => {
      const s = String(d);
      // yt-dlp의 안내/에러 로그
      if (/ERROR|error/i.test(s)) send({ phase: 'error', message: s.slice(0, 500) });
    });
    proc.on('close', (code) => {
      activeDownload = null;
      if (code !== 0) return resolve({ ok: false, error: `yt-dlp exit ${code}` });
      // 우리가 지정한 base로 시작하는 파일 찾기
      try {
        const files = fs.readdirSync(outDir)
          .filter((f) => f.startsWith(base) && /\.(mp4|mkv|webm)$/i.test(f))
          .map((f) => ({ f, m: fs.statSync(path.join(outDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        const filePath = files[0] ? path.join(outDir, files[0].f) : null;
        send({ phase: 'done', ratio: 1, filePath });
        resolve({ ok: true, filePath });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
    proc.on('error', (err) => {
      activeDownload = null;
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
    const outDir = path.join(downloadsDir(), 'stems');
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
  const stemDir = path.join(dlDir, 'stems');
  const isInside = (parent, child) => {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
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
  const stemDir = path.join(dlDir, 'stems');
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
    try { fs.rmSync(it.outDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(it.videoPath, { force: true }); } catch {}
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
