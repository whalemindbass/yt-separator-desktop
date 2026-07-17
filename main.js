'use strict';
// YT Separator Desktop — Electron main process

const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const { pathToFileURL } = require('url');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

/** userData/downloads — 사용자별 다운로드 저장 위치 */
function downloadsDir() {
  const dir = path.join(app.getPath('userData'), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0f0f0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });
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
  protocol.handle('ytsep', async (req) => {
    try {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname);
      if (p.startsWith('/')) p = p.slice(1);
      if (process.platform === 'win32') p = p.replace(/\//g, '\\');
      const fileUrl = pathToFileURL(p).toString();
      const res = await net.fetch(fileUrl);
      // CORS 헤더 추가 (Electron 43+ 필수)
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      headers.set('Access-Control-Allow-Headers', '*');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch (e) {
      return new Response('not found: ' + e.message, { status: 404 });
    }
  });
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  // 앱이 뜨고 3초 뒤 업데이트 조회 (portable/dev에서는 no-op)
  setTimeout(() => { checkForUpdates(); }, 3000);
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

function checkForUpdates() {
  if (isDev) { console.log('[updater] skip in dev'); return; }
  // portable exe는 파일명 규칙으로 감지 — 자동 업데이트 대신 알림만
  const exe = process.execPath || '';
  if (/Portable/i.test(exe)) {
    sendUpdate({ type: 'portable-hint' });
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => sendUpdate({ type: 'error', message: err.message }));
}

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
  // 파일명: <제목-앞60자>-<6자hex>.<ext>  (중복 방지)
  const base = makeFileBase(opts.title, opts.id || 'video');
  const outTemplate = path.join(outDir, base + '.%(ext)s');
  // 진행률을 파싱하기 쉬운 형식으로
  const progressTpl = 'PROG {"status":"downloading","dl":%(progress.downloaded_bytes)s,"total":%(progress.total_bytes)s,"tot_est":%(progress.total_bytes_estimate)s,"speed":%(progress.speed)s,"eta":%(progress.eta)s}';

  const args = [
    '--newline',
    '--no-warnings',
    '--no-playlist',
    '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/best',
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

// ── STEM: 모델 로드 (renderer에게 ArrayBuffer 넘겨줌) ────
function modelPath() {
  const base = isDev ? __dirname : process.resourcesPath;
  return path.join(base, 'models', 'htdemucs_core.onnx');
}
ipcMain.handle('stem:modelBytes', async () => {
  const p = modelPath();
  if (!fs.existsSync(p)) return { ok: false, error: 'model file missing: ' + p };
  const buf = fs.readFileSync(p);
  // Transferable로 넘기기 위해 ArrayBuffer 반환 (Buffer.buffer는 pool이라 slice)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { ok: true, bytes: ab };
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
    createdAt: Date.now(),
    meta: entry.meta || {},
  };
  // 같은 videoPath는 중복 방지 (덮어쓰기)
  const idx = items.findIndex(it => it.videoPath === rec.videoPath);
  if (idx >= 0) items[idx] = { ...items[idx], ...rec, createdAt: items[idx].createdAt || rec.createdAt };
  else items.push(rec);
  writeLibrary(items);
  return { ok: true, id: rec.id };
});

ipcMain.handle('library:rename', (_ev, id, name) => {
  const items = readLibrary();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  items[idx].name = String(name || 'Untitled').slice(0, 200);
  writeLibrary(items);
  return { ok: true };
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
