'use strict';
// YT Separator Desktop — Electron main process

const { app, BrowserWindow, ipcMain, shell, protocol, net, clipboard, dialog, session } = require('electron');
// 테스트 실행 중인지 — test/run.js 가 electron 에 <이름>.test.js 경로를 인자로 넘긴다.
// 테스트가 창을 계속 띄우는데, 모니터가 여러 대면 항상 주 모니터에 떠서 작업을 방해한다 —
// 보조 모니터가 있으면 거기로 보낸다(없으면 그냥 평소대로, 실사용에는 전혀 영향 없다).
const isTestRun = process.argv.some(a => /\.test\.js$/i.test(a));
const { autoUpdater } = require('electron-updater');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const path = require('path');
const fs = require('fs');

// 예상 못한 예외로 프로세스가 조용히 죽는 것 방지 — 기록을 남기고 유지.
//
// 콘솔로만 보내면 사용자 화면에도 파일에도 남지 않아 사실상 사라진다. 그렇다고 로그를
// 쌓아 두지는 않는다 — 마지막 한 건만 덮어쓰고, 다음 실행 때 보여 준 뒤 지운다.
process.on('uncaughtException',  (e) => { try { console.error('[uncaught]', e && e.stack || e); } catch {} noteCrash('main', e); });
process.on('unhandledRejection', (e) => { try { console.error('[unhandledRejection]', e); } catch {} noteCrash('promise', e); });
const crypto = require('crypto');
const { spawn } = require('child_process');

// 작업표시줄 고정·창 그룹화·알림이 쓰는 앱 식별자.
// 설치 시 NSIS 바로가기에는 electron-builder 가 package.json 의 build.appId 를 심는데,
// 앱이 같은 값을 쓰지 않으면 Windows 가 실행 경로 기반의 다른 ID 를 붙인다. 그러면
// 업데이트로 exe 가 교체될 때마다 고정이 끊긴다. 두 값은 반드시 같아야 한다.
if (process.platform === 'win32') app.setAppUserModelId('com.whalemindbass.yt-separator');

// ── .yssproj 더블클릭으로 열기 ──────────────────────────────
// 파일 연결만 등록하고 여는 처리를 안 하면, 아이콘은 붙었는데 눌러도 아무 일이 없다.
// 그건 연결이 없는 것보다 나쁘다.
let pendingProject = null;   // 창이 준비되기 전에 들어온 것

function projectFromArgv(argv) {
  return (argv || []).find(a => typeof a === 'string' && a.toLowerCase().endsWith('.yssproj')) || null;
}

// 렌더러가 project:open-file 수신을 등록했는가. 등록 전에 보낸 것은 아무도 받지 못하고
// 사라지므로, 그때까지는 pendingProject 에 들고 있는다.
let rendererOpenReady = false;

/** 렌더러가 받을 준비가 됐고 창이 살아 있으면 보낸다. 아니면 들고 있는다. */
function flushPendingProject() {
  if (!pendingProject || !rendererOpenReady) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = pendingProject;
  pendingProject = null;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
  mainWindow.webContents.send('project:open-file', payload);
}

/** 준비돼 있으면 바로 보내고, 아니면 준비될 때까지 들고 있는다 */
function deliverProject(file) {
  if (!file) return;
  try {
    if (!fs.existsSync(file)) return;
    pendingProject = { path: file, data: fs.readFileSync(file, 'utf8') };
    flushPendingProject();
  } catch { /* 못 읽으면 조용히 넘어간다 — 앱은 평소대로 뜬다 */ }
}

// 두 번째로 띄우면 새 창을 만들지 않고 원래 창에서 연다.
// 없으면 프로젝트를 열 때마다 앱이 하나씩 더 뜬다.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => deliverProject(projectFromArgv(argv)));
}

// ── 네이티브 대화상자 문구 ──────────────────────────────────
// 파일 선택창·저장창은 OS 가 그리므로 화면 쪽 번역이 닿지 않는다. 언어를 영어로 바꿔도
// 여기가 한국어로 남아 있었다. 화면이 고른 언어를 알려 주면 그대로 따른다.
let uiLocale = 'ko';
ipcMain.on('app:locale', (_e, loc) => { if (loc === 'ko' || loc === 'en') uiLocale = loc; });

const DIALOG_TEXT = {
  ko: {
    saveClose: '저장하고 닫기', discardClose: '저장하지 않고 닫기', cancel: '취소',
    unsavedTitle: '저장하지 않은 작업이 있습니다',
    unsavedDetail: '지금 닫으면 마지막 저장 이후의 변경을 잃습니다.',
    pickVideoDir: '영상 다운로드 폴더 선택', pickStemDir: '스템 저장 폴더 선택',
    pickSaveTo: '저장 위치 선택', pickFolder: '폴더 선택',
    projectSave: '프로젝트 저장', projectOpen: '프로젝트 열기',
    pickMedia: '분리할 영상/오디오 파일 선택',
    pickMediaFiles: '분리할 영상/오디오 파일 선택 (여러 개 가능)',
    importAudio: '오디오 파일 임포트', importVideo: '영상 파일 임포트',
    importVideoFiles: '영상 파일 임포트 (여러 개 가능)',
    importImageFiles: '이미지 파일 임포트 (여러 개 가능)',
    fMedia: '영상/오디오', fAudio: '오디오', fVideo: '영상', fImage: '이미지', fAll: '모든 파일', fProject: 'YSS 프로젝트',
    fVideoProject: 'Dr.studio 영상 프로젝트',
  },
  en: {
    saveClose: 'Save and close', discardClose: 'Close without saving', cancel: 'Cancel',
    unsavedTitle: 'You have unsaved work',
    unsavedDetail: 'Closing now loses everything changed since the last save.',
    pickVideoDir: 'Choose the download folder', pickStemDir: 'Choose the stem folder',
    pickSaveTo: 'Choose where to save', pickFolder: 'Choose a folder',
    projectSave: 'Save project', projectOpen: 'Open project',
    pickMedia: 'Choose a video or audio file to separate',
    pickMediaFiles: 'Choose video/audio files to separate (multiple allowed)',
    importAudio: 'Import audio file', importVideo: 'Import video file',
    importVideoFiles: 'Import video files (multiple allowed)',
    importImageFiles: 'Import image files (multiple allowed)',
    fMedia: 'Video / audio', fAudio: 'Audio', fVideo: 'Video', fImage: 'Image', fAll: 'All files', fProject: 'YSS project',
    fVideoProject: 'Dr.studio video project',
  },
};
const td = (k) => (DIALOG_TEXT[uiLocale] || DIALOG_TEXT.ko)[k] || k;

function mimeFor(p) {
  const ext = path.extname(p).toLowerCase();
  return {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.gif': 'image/gif',
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
const FFPROBE_BIN = vendorPath('ffmpeg', 'ffprobe.exe');

// ── 텍스트/타이틀 오버레이용 폰트 — 우리 폰트를 새로 번들하는 대신 Windows 에 이미 깔린
// 파일을 그대로 참조한다(재배포 없이 참조만 — 라이선스 문제 없음). 키는 렌더러
// (video-editor.js 의 TEXT_FONTS)와 짝이 맞아야 한다 — 렌더러는 미리보기 CSS
// font-family/드롭다운 표시용, 여긴 실제 내보내기용 실파일 경로 해석용. 한쪽만 고치면
// "미리보기랑 결과물 폰트가 다르다" 버그가 난다.
const TEXT_FONT_FILES = {
  malgun: 'malgun.ttf', malgunbd: 'malgunbd.ttf', nanum: 'NanumGothic.ttf',
  impact: 'impact.ttf', georgia: 'georgia.ttf', consolas: 'consola.ttf',
};
const FONTS_DIR = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');
const _fontPathCache = new Map();   // key → 경로(string) | null(못 찾음, malgun 도 없단 뜻)
// 고른 폰트가 이 컴퓨터에 없으면(드물지만 있을 수 있다) 조용히 맑은 고딕으로 대체한다 —
// export 전체를 막기보단 최대한 결과물을 낸다. 맑은 고딕조차 없으면 그때 null.
function resolveTextFont(key) {
  const k = TEXT_FONT_FILES[key] ? key : 'malgun';
  if (_fontPathCache.has(k)) return _fontPathCache.get(k);
  const p = path.join(FONTS_DIR, TEXT_FONT_FILES[k]);
  let found = fs.existsSync(p) ? p : null;
  if (!found && k !== 'malgun') found = resolveTextFont('malgun');
  _fontPathCache.set(k, found);
  return found;
}

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
  const winOpts = {
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
  };
  mainWindow = new BrowserWindow(winOpts);
  // 화면이 통째로 죽는 경우 — 자바스크립트 예외로는 잡히지 않는다
  mainWindow.webContents.on('render-process-gone', (_e, d) => {
    noteCrash('renderer', null, { message: `화면 프로세스 종료: ${d.reason}`, reason: d.reason, exitCode: d.exitCode });
  });
  mainWindow.on('maximize',   () => mainWindow.webContents.send('window:state', { maximized: true }));
  mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:state', { maximized: false }));
  mainWindow.on('focus',      () => mainWindow.webContents.send('window:focus'));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!mainWindow) return;
    // 테스트 중엔 아예 안 띄운다 — 테스트는 executeJavaScript 로만 조작해서 창이 보일
    // 필요가 없다. 예전엔 showInactive() 로 보조 모니터에 띄웠는데, 모니터가 하나뿐이거나
    // 창이 뜨고 옮겨지는 그 짧은 순간에도 화면이 깜빡여 거슬린다는 지적이 있었다 — 안
    // 띄우면 그 자체가 원천적으로 안 생긴다. devtools 도 당연히 안 띄운다.
    if (isTestRun) return;
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  // 파일을 더블클릭해 실행한 경우 — 렌더러가 "받을 준비가 됐다"고 말할 때 건넨다.
  // did-finish-load 는 화면이 그려졌다는 뜻일 뿐 수신 등록이 끝났다는 뜻이 아니다.
  rendererOpenReady = false;   // 창을 새로 만들면 다시 기다린다
  mainWindow.webContents.once('did-finish-load', () => {
    if (pendingProject) return;                      // 이미 들고 있으면 그대로 둔다
    const f = projectFromArgv(process.argv);
    if (!f) return;
    try { pendingProject = { path: f, data: fs.readFileSync(f, 'utf8') }; } catch { /* 못 읽으면 평소대로 뜬다 */ }
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
        buttons: [td('saveClose'), td('discardClose'), td('cancel')],
        defaultId: 0, cancelId: 2, noLink: true,
        message: td('unsavedTitle'),
        detail: td('unsavedDetail'),
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
      // bytes=시작-끝 뿐 아니라 bytes=-N("끝에서부터 N바이트") 도 와야 한다 — moov 가 파일
      // 끝에 있는(faststart 안 한) mp4 를 크롬이 seek 가능하게 만들 때 꼭 이 형식으로 먼저
      // 찾으러 온다. 이걸 놓치면(예전엔 놓쳤다) "전체 요청"으로 새 버려 큰 파일 전체를
      // 잘못 돌려주고, 크롬은 그 응답을 못 알아듣고 포기해서 seekable 이 통째로 비어버린다
      // — 몇 분짜리 실제 영상만 임포트하면 seek 이 전혀 안 먹혀서 필름스트립이 죄다
      // 첫 프레임(검게 나온 경우도 있었다)으로 굳어 보이던 원인이 이거였다.
      const suffixM = rangeHdr && /^bytes=-(\d+)$/.exec(rangeHdr);
      const normalM = rangeHdr && /^bytes=(\d+)-(\d+)?$/.exec(rangeHdr);
      if (suffixM || normalM) {
        const start = suffixM ? Math.max(0, size - parseInt(suffixM[1], 10)) : parseInt(normalM[1], 10);
        const end   = suffixM ? (size - 1) : (normalM[2] ? Math.min(parseInt(normalM[2], 10), size - 1) : (size - 1));
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
    title: td('pickVideoDir'),
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
    title: td('pickStemDir'),
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
  const extList = exts && exts.length ? exts : ['wav'];
  const filters = [{ name: extList.map(e => e.toUpperCase()).join('/'), extensions: extList }];
  const res = await dialog.showSaveDialog(mainWindow || null, {
    title: td('pickSaveTo'),
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
      title: td('projectSave'),
      defaultPath: (name || '프로젝트') + '.yssproj',
      filters: [{ name: td('fProject'), extensions: ['yssproj'] }],
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
    title: td('projectOpen'),
    properties: ['openFile'],
    filters: [{ name: td('fProject'), extensions: ['yssproj'] }],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  try { return { ok: true, path: res.filePaths[0], data: fs.readFileSync(res.filePaths[0], 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// 영상 편집 프로젝트(.dsvproj) — 스튜디오의 .yssproj(project:save/open) 와 같은 패턴이지만
// 확장자가 다르고, videoProject:save/load(사용자가 못 보는 자동 저장, userData 안)와도
// 별개다 — 이건 사용자가 "저장" 을 직접 눌러서 원하는 위치에 남기는 파일.
ipcMain.handle('video:project:save', async (_ev, json, name, existingPath) => {
  let target = existingPath;
  if (!target) {
    const res = await dialog.showSaveDialog(mainWindow || null, {
      title: td('projectSave'),
      defaultPath: (name || '영상 프로젝트') + '.dsvproj',
      filters: [{ name: td('fVideoProject'), extensions: ['dsvproj'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    target = res.filePath;
  }
  try { fs.writeFileSync(target, String(json), 'utf8'); return { ok: true, path: target }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('video:project:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: td('projectOpen'),
    properties: ['openFile'],
    filters: [{ name: td('fVideoProject'), extensions: ['dsvproj'] }],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  try { return { ok: true, path: res.filePaths[0], data: fs.readFileSync(res.filePaths[0], 'utf8') }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// 클립이 가리키는 원본 파일이 그새 삭제/이동됐는지 — 여러 개를 한 번에 확인(임포트 때마다
// 매번 IPC 왕복하지 않게). 결과는 그 순간의 스냅샷일 뿐 캐시하지 않는다(파일은 언제든
// 다시 사라지거나 나타날 수 있다).
ipcMain.handle('fs:checkExists', (_ev, paths) => {
  const out = {};
  for (const p of paths || []) { try { out[p] = fs.existsSync(p); } catch { out[p] = false; } }
  return out;
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
// 도형(사각형/타원) 오버레이 — 렌더러가 <canvas> 로 그려서 PNG 로 넘기면, 그걸 그냥
// 일반 "이미지 클립"처럼 파일로 저장해 둔다(같은 clip id 로 계속 덮어쓴다 — 색·모양을
// 바꿀 때마다 새 파일이 쌓이지 않는다). 그 뒤로는 이미지 임포트 파이프라인을 100% 그대로 탄다
// (PIP 위치/크기, 효과, -loop 1 내보내기까지 새 코드 없이 재사용).
ipcMain.handle('video:saveShapeImage', async (_ev, key, data) => {
  try {
    const dir = path.join(app.getPath('userData'), 'shapes');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}.png`);
    fs.writeFileSync(p, Buffer.from(data));
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('dialog:pickMedia', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: td('pickMedia'),
    properties: ['openFile'],
    filters: [
      { name: td('fMedia'), extensions: ['mp4','mkv','webm','mov','avi','m4a','mp3','wav','flac','aac','ogg'] },
      { name: td('fAll'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, filePath: res.filePaths[0] };
});
// 새 분리: 영상/오디오 파일 여러 개 (일괄 처리 대기열에 한 번에 추가)
ipcMain.handle('dialog:pickMediaFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: td('pickMediaFiles'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: td('fMedia'), extensions: ['mp4','mkv','webm','mov','avi','m4a','mp3','wav','flac','aac','ogg'] },
      { name: td('fAll'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, filePaths: res.filePaths };
});
// 스튜디오: 오디오 파일 여러 개 임포트 (트랙 클립)
ipcMain.handle('dialog:pickAudioFiles', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: td('importAudio'),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: td('fAudio'), extensions: ['wav','mp3','flac','ogg','aif','aiff','m4a','aac'] },
      { name: td('fAll'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, filePaths: res.filePaths };
});
// 스튜디오: 비디오 파일 임포트
ipcMain.handle('dialog:pickVideoFile', async () => {
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: td('importVideo'),
    properties: ['openFile'],
    filters: [
      { name: td('fVideo'), extensions: ['mp4','mkv','webm','mov','avi','m4v'] },
      { name: td('fAll'), extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, filePath: res.filePaths[0] };
});
// 영상 편집: 비디오/오디오 파일 임포트 (트랙 클립) — 트랙 종류에 안 맞는 파일을 넣으면
// 아무것도 재생되지 않는데(영상 트랙에 오디오 파일 넣으면 화면도 소리도 안 남,
// 반대도 마찬가지) 그걸 굳이 필터로 허용해 둘 이유가 없다 — kind 로 트랙에 맞는
// 확장자만 보여준다.
ipcMain.handle('dialog:pickVideoFiles', async (_ev, kind) => {
  const videoExts = ['mp4','mkv','webm','mov','avi','m4v'];
  const audioExts = ['mp3','wav','flac','ogg','aif','aiff','m4a','aac'];
  const imageExts = ['png','jpg','jpeg','webp','bmp','gif'];
  const filters = kind === 'audio'
    ? [
        { name: td('fAudio'), extensions: audioExts },
        // 오디오 트랙은 영상 파일에서도 소리만 뽑아 쓸 수 있다(:a 스트림만 참조) — 그래서
        // 영상 확장자도 옵션으로 남겨둔다(기본은 아니다).
        { name: td('fVideo'), extensions: videoExts },
        { name: td('fAll'), extensions: ['*'] },
      ]
    : kind === 'image'
    ? [
        { name: td('fImage'), extensions: imageExts },
        { name: td('fAll'), extensions: ['*'] },
      ]
    : [
        { name: td('fVideo'), extensions: videoExts },
        { name: td('fAll'), extensions: ['*'] },
      ];
  const res = await dialog.showOpenDialog(mainWindow || null, {
    title: kind === 'image' ? td('importImageFiles') : td('importVideoFiles'),
    properties: ['openFile', 'multiSelections'],
    filters,
  });
  if (res.canceled || !res.filePaths?.length) return { ok: false, canceled: true };
  return { ok: true, filePaths: res.filePaths };
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

// ── 마지막 크래시 한 건 ────────────────────────────────────
// 로그를 쌓지 않는다는 원칙은 그대로다. 파일 하나를 덮어쓰고, 다음 실행 때 보여 준 뒤 지운다.
function crashPath() { return path.join(app.getPath('userData'), 'lastcrash.json'); }

function noteCrash(kind, err, extra) {
  try {
    fs.writeFileSync(crashPath(), JSON.stringify({
      at: Date.now(),
      kind,
      version: app.getVersion(),
      message: String((err && err.message) || err || '').slice(0, 400),
      // 스택은 위쪽 몇 줄이면 어디서 났는지 알기 충분하다. 경로에 사용자 이름이 섞이므로 길게 담지 않는다.
      stack: String((err && err.stack) || '').split('\n').slice(1, 7).map(s => s.trim()).join('\n').slice(0, 900),
      ...(extra || {}),
    }), 'utf8');
  } catch { /* 크래시를 적다가 또 죽지는 않게 */ }
}

// 읽으면 지운다 — 같은 크래시를 두 번 묻지 않는다
ipcMain.handle('crash:take', () => {
  try {
    if (!fs.existsSync(crashPath())) return null;
    const rec = JSON.parse(fs.readFileSync(crashPath(), 'utf8'));
    fs.unlinkSync(crashPath());
    return rec;
  } catch { return null; }
});

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
    // Node 의 EventEmitter 는 'error' 를 예약해 뒀다 — 리스너가 하나도 없으면 emit 이 조용히
    // 무시되는 게 아니라 던져져서 이 프로세스(= 앱 전체)를 죽인다. 실제 오류 전달은 위
    // 'event' 리스너가 이미 하고 있으니, 여기 리스너는 그 크래시를 막는 것 말고 할 일이 없다.
    audioEngine.on('error', (e) => { console.error('[engine] error event:', e); });
    audioEngine.on('exit',  (c, crashed) => {
      // 죽었는데 녹음 중이었다면 쓰다 만 WAV 가 남아 있다. 헤더를 고쳐 되살릴 수 있게 넘긴다.
      let take = null;
      if (crashed && lastRecordFile) take = repairWav(lastRecordFile);
      lastRecordFile = null;
      // 엔진(네이티브 프로세스)이 비정상 종료하면 JS 스택트레이스가 없다 — 재현 없이는 원인을
      // 알 방법이 없었다. 직전에 보낸 명령이라도 남겨두면 다음에 같은 크래시가 나도 실마리가 된다.
      if (crashed) noteCrash('engine', null, { message: `오디오 엔진 비정상 종료`, exitCode: c, lastCmd: lastEngineCmd });
      try { mainWindow?.webContents.send('engine:event', { ev: 'exit', code: c, crashed: !!crashed, take }); } catch {}
    });
  }
  return audioEngine;
}
ipcMain.handle('engine:start', (_e, stems) => {
  const eng = getEngine();
  return { ok: eng.start(Array.isArray(stems) ? stems : []), exe: eng.exePath };
});
// 엔진이 죽었을 때 "직전에 뭘 시켰는지" 알 수 있게 마지막 명령을 남겨둔다(크래시 진단용).
// base64 프리셋 데이터처럼 큰 값은 크기만 남기고 실제 값은 버린다.
let lastEngineCmd = null;
function summarizeCmd(cmd) {
  if (!cmd || typeof cmd !== 'object') return cmd ?? null;
  const out = {};
  for (const [k, v] of Object.entries(cmd)) out[k] = (typeof v === 'string' && v.length > 80) ? `<${v.length}B>` : v;
  return out;
}
ipcMain.handle('engine:cmd',  (_e, cmd) => {
  // 정상적으로 멈췄으면 파일은 엔진이 마무리한다 — 되살릴 대상이 아니다
  if (cmd && cmd.cmd === 'recordStop') lastRecordFile = null;
  lastEngineCmd = summarizeCmd(cmd);
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
// 영상 편집 탭: 소스에 오디오 스트림이 있는지 — 브라우저 <video> 쪽에서 믿을 만하게 알 방법이
// 없어서(오디오 트랙 목록 API 가 이 크롬 빌드엔 없다) ffprobe 로 확인한다. 실패하면 있다고
// 본다 — 없는데 있다고 착각하면 내보내기가 에러로 죽지만, 있는데 없다고 착각하면 진짜
// 오디오가 조용히 빠져버린다. 안전한 쪽으로 기운다.
ipcMain.handle('video:probeAudio', async (_ev, file) => {
  if (typeof file !== 'string' || !fs.existsSync(file)) return { hasAudio: true, isHDR: false };
  return await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(FFPROBE_BIN, ['-v', 'error', '-show_entries', 'stream=codec_type,color_transfer', '-of', 'json', file], { windowsHide: true });
    } catch { return resolve({ hasAudio: true, isHDR: false }); }
    let out = '';
    proc.stdout.on('data', (d) => out += d);
    proc.on('error', () => resolve({ hasAudio: true, isHDR: false }));
    proc.on('close', (code) => {
      if (code !== 0) return resolve({ hasAudio: true, isHDR: false });
      // isHDR: false 아니면 ffprobe 의 color_transfer 이름 그대로('smpte2084' PQ 또는
      // 'arib-std-b67' HLG) — 이 이름이 export 쪽 zscale 필터의 transfer= 값으로 그대로 들어간다.
      let hasAudio = false, isHDR = false;
      try {
        const streams = JSON.parse(out).streams || [];
        for (const s of streams) {
          if (s.codec_type === 'audio') hasAudio = true;
          if (s.codec_type === 'video' && (s.color_transfer === 'smpte2084' || s.color_transfer === 'arib-std-b67')) isHDR = s.color_transfer;
        }
      } catch {}
      resolve({ hasAudio, isHDR });
    });
  });
});
// 영상 편집 탭 내보내기(v2) — 컷 편집 + 트랙 겹침(PIP overlay) + 여러 오디오 트랙 믹스.
// 렌더러 buildEDL() 이 구간별로 layers(겹친 영상 트랙들)/audioSources(N개 오디오 트랙)를
// 미리 계산해서 넘긴다 — 여기선 그 구간 정보를 filter_complex 로 옮기기만 한다.
ipcMain.handle('video:export', async (event, payload) => {
  const { segments, outPath, format, res, fps } = payload || {};
  if (!Array.isArray(segments) || !segments.length) return { ok: false, error: '내보낼 구간이 없습니다' };
  if (typeof outPath !== 'string' || !outPath) return { ok: false, error: '저장 경로 없음' };
  const fmt = ['mp4', 'webm'].includes(format) ? format : 'mp4';
  // CRF 는 고정값 — 이전 기본값(mp4=20/webm=32) 그대로. "화질" 은 이제 이 CRF 를 고르는 대신
  // 아래 res(해상도)로 명확하게(720p/1080p 처럼) 표현한다.
  const crf = { h264: 20, vp9: 32 };
  // 해상도 낮춰 내보내기 — 원본(프로젝트 캔버스) 해상도보다 큰 값은 업스케일하지 않고 무시한다.
  const RES_HEIGHTS = { '2160': 2160, '1440': 1440, '1080': 1080, '720': 720, '480': 480 };
  const targetH = RES_HEIGHTS[res];

  // 텍스트/타이틀 오버레이 — 하나라도 있으면 폰트를 확인하고, drawtext 가 상대경로로
  // fontfile/textfile 을 찾을 수 있게 전용 임시 폴더를 만든다. 드라이브 문자가 들어간
  // 절대경로("C:\...")를 filter_complex 문자열 안에 넣으면 이스케이프를 어떻게 해도
  // (\: 이스케이프, 작은따옴표 감싸기 다 시도해봤다) 이 ffmpeg 빌드의 옵션 파서가
  // 드라이브 콜론에서 깨진다 — 실측으로 확인한 우회법은 ffmpeg 의 cwd 를 그 폴더로 두고
  // 파일명만(콜론 없이) 넘기는 것뿐이었다.
  const hasTexts = segments.some(s => s.texts && s.texts.length);
  let drawtextDir = null;
  const _copiedFonts = new Set();   // 실제로 쓰인 폰트만, 중복 복사 안 함
  function ensureFontCopied(key) {
    const src = resolveTextFont(key);
    if (!src) return null;
    const name = path.basename(src);
    if (!_copiedFonts.has(name)) { fs.copyFileSync(src, path.join(drawtextDir, name)); _copiedFonts.add(name); }
    return name;
  }
  if (hasTexts) {
    if (!resolveTextFont('malgun')) return { ok: false, error: '텍스트 오버레이용 폰트를 찾을 수 없습니다(맑은 고딕 없음)' };
    drawtextDir = path.join(app.getPath('temp'), 'yss-drawtext-' + crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(drawtextDir, { recursive: true });
  }
  let _capSeq = 0;
  function writeCaptionFile(content) {
    const name = `cap${_capSeq++}.txt`;
    fs.writeFileSync(path.join(drawtextDir, name), content || '', 'utf-8');
    return name;
  }
  // 세그먼트에 텍스트가 있으면 그 세그먼트의 최종 [vN] 라벨 위에 drawtext 를 하나 더
  // 쌓고, 새 라벨을 돌려준다(같은 라벨을 두 번 정의할 수 없어서) — 없으면 원래 라벨 그대로.
  function textFrag(texts, w, h, srcLabel, i) {
    // 내용이 빈 캡션은 걸러낸다 — drawtext 의 textfile 이 빈 파일을 가리키면 "could not be
    // read or is empty" 로 필터그래프 전체가 죽는다(실측으로 확인).
    const active = (texts || []).filter(t => (t.content || '').trim());
    if (!active.length) return srcLabel;
    const dstLabel = `${srcLabel}_txt`;
    // PIP 와 같은 자유도 — 프레임 테두리에 자리를 묶지 않는다, 밖으로 나간 만큼은
    // 그냥 잘려 보인다(drawtext 가 프레임 밖 좌표를 알아서 클리핑, PIP overlay 때와
    // 동일하게 실측 확인됨). 폭이 줄어들지 않는 건 이 위치 계산과는 별개 문제였다 —
    // 렌더러 쪽 CSS shrink-to-fit 버그(positionTextItem 주석 참고)가 원인이었고 거긴
    // 이미 고쳐져 있다. 여긴 그냥 중심 좌표 그대로.
    const stages = active.map((t) => {
      const file = writeCaptionFile(t.content);
      const fontFile = ensureFontCopied(t.fontKey) || 'malgun.ttf';
      const size = Math.max(1, Math.round(t.size || 42));
      const x = `w*${(t.x ?? 0.5).toFixed(4)}-text_w/2`;
      const y = `h*${(t.y ?? 0.85).toFixed(4)}-text_h/2`;
      // 반투명 검정 배경(box)은 기본이 아니다 — 렌더러 팝오버에서 켠 클립만 넣는다.
      const box = t.bg ? ':box=1:boxcolor=#000000@0.45:boxborderw=8' : '';
      return `drawtext=fontfile=${fontFile}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=${t.color || '#ffffff'}:x=${x}:y=${y}${box}`;
    });
    parts.push(`[${srcLabel}]${stages.join(',')}[${dstLabel}]`);
    return dstLabel;
  }

  const allFiles = new Set();
  for (const s of segments) {
    if (s.xfade) { allFiles.add(s.fileA); allFiles.add(s.fileB); }
    if (s.file) allFiles.add(s.file);
    if (s.layers) for (const l of s.layers) allFiles.add(l.file);
    if (s.audioSources) for (const a of s.audioSources) allFiles.add(a.file);
  }
  for (const f of allFiles) if (!fs.existsSync(f)) return { ok: false, error: '원본 없음: ' + f };

  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  let nextInput = 0;
  // 같은 파일이 여러 구간·레이어·오디오소스에서 반복 참조될 수 있다 — 파일당 -i 하나만 열고
  // filter_complex 안에서 같은 입력 인덱스를 여러 번(다른 trim 범위로) 재사용한다.
  const fileIdx = new Map();
  const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);
  function inputIndexFor(file) {
    if (fileIdx.has(file)) return fileIdx.get(file);
    // 이미지는 -loop 1 로 무한 스트림처럼 열어야 trim=start:end 가 어떤 구간을 요청해도
    // (클립을 몇 초짜리로 늘려 놨든) 항상 프레임이 있다 — 정지 이미지는 어차피 어디를
    // 잘라도 같은 그림이라 이 방식이 실제 seek 와 동일하게 동작한다.
    if (IMAGE_EXTS.has(path.extname(file).toLowerCase())) args.push('-loop', '1', '-framerate', '30', '-i', file);
    else args.push('-i', file);
    const idx = nextInput++;
    fileIdx.set(file, idx);
    return idx;
  }
  const idxs = segments.map((s) => (s.xfade ? { a: inputIndexFor(s.fileA), b: inputIndexFor(s.fileB) } : null));

  // 오디오 스트림이 없는 소스·오디오소스가 0개인 구간을 위한 공용 무음 입력(지연 생성).
  let silentIdx = -1;
  function ensureSilent() {
    if (silentIdx < 0) { args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'); silentIdx = nextInput++; }
    return silentIdx;
  }
  // 영상 트랙이 없는 구간(mp3/wav 단독, PIP 배경)을 위한 공용 검은 화면 입력(지연 생성).
  let blackIdx = -1;
  function ensureBlack(w, h) {
    if (blackIdx < 0) { args.push('-f', 'lavfi', '-i', `color=black:size=${w || 1280}x${h || 720}:rate=30`); blackIdx = nextInput++; }
    return blackIdx;
  }
  // 구간마다 소스 해상도가 다를 수 있다(사용자가 고른 렌더 해상도와도 다를 수 있고) — concat 은
  // 모든 [vN] 이 같은 크기여야 하니, 비율은 유지한 채(왜곡 없이) 검은 여백으로 맞춰 넣는다.
  function scalePad(w, h) {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
  }
  // HDR(PQ/HLG) 소스를 SDR 로 그냥 변환하면 화면이 허옇게 씻겨나간다 — 표준 톤매핑
  // 체인(zscale 로 선형 변환 → tonemap(hable) → 다시 bt709/tv 로) 을 거쳐야 한다.
  // trim 바로 다음(원본 픽셀 그대로일 때) 걸어야 한다 — 밝기/대비 등 우리 자체 보정은
  // 이미 SDR 로 바뀐 결과에 적용되는 게 맞다(그래야 슬라이더 값이 익숙한 범위로 먹힌다).
  function hdrFrag(hdrTransfer) {
    if (!hdrTransfer) return '';
    // 소스 파일에 색 정보 태그가 없는 경우(흔하다 — 실제로 우리 테스트 픽스처도 그랬다)
    // zscale 이 "no path between colorspaces" 로 죽는다 — setparams 로 우리가 이미 probe 로
    // 알고 있는 실제 전송특성(PQ/HLG)을 프레임에 먼저 태그해 준 다음 zscale 이 그걸 읽게 한다.
    return `,setparams=color_trc=${hdrTransfer}:colorspace=bt2020nc:color_primaries=bt2020,zscale=transfer=linear:npl=100,format=gbrpf32le,zscale=primaries=bt709,tonemap=tonemap=hable:desat=0,zscale=transfer=bt709:matrix=bt709:range=tv,format=yuv420p`;
  }
  // 클립 단위 좌우/상하 반전 — 필터 체인에 끼워 넣을 조각(없으면 빈 문자열).
  function flipFrag(flipH, flipV) {
    const fs = [];
    if (flipH) fs.push('hflip');
    if (flipV) fs.push('vflip');
    return fs.length ? ',' + fs.join(',') : '';
  }
  // 클립 페이드인/아웃 — buildEDL() 이 원본 파일의 절대 시각 기준 st(시작)/d(길이) 로 넘겨준다.
  // trim/atrim 은 PTS 를 안 건드리므로, asetpts/setpts 로 리셋하기 *전에* 걸어야 세그먼트가
  // 잘게 쪼개져도(다른 트랙・PIP・구간 지정 등으로) 페이드 경계에서 끊기지 않고 이어진다.
  // 클립 효과 체인(밝기/대비/채도/흑백/세피아/블러) — 렌더러의 EFFECT_TYPES/effects[] 와
  // 1:1 대응. 미리보기는 CSS filter 함수를 체인 순서 그대로 적용하니, 여기서도 같은 순서로
  // 필터를 하나씩 쌓는다(효과 순서가 바뀌면 결과도 달라진다 — 흑백 다음 세피아 ≠ 세피아
  // 다음 흑백). 각 효과의 ffmpeg 등가식은 크로미움 실제 CSS 필터 출력과 직접 대조해
  // 정확히 맞춘 것들이다(밝기: eq 의 brightness 는 배율이 아니라 오프셋이라 다르게
  // 보이던 버그가 있었다 — colorchannelmixer 로 교체. 대비・채도: eq 는 YUV 기준이라 컬러
  // 영상에서 어긋났다 — RGB 공간에서 CSS 명세식 그대로 계산).
  function effectFrag(eff) {
    const type = eff.type, v = eff.value;
    if (type === 'brightness') {
      if (!v) return '';
      const B = Math.max(0, 1 + v / 100);
      return `colorchannelmixer=rr=${B}:gg=${B}:bb=${B}`;
    }
    if (type === 'contrast') {
      if (!v) return '';
      const C = 1 + v / 100;
      const expr = `clip((val-128)*${C}+128\\,0\\,255)`;
      return `lutrgb=r='${expr}':g='${expr}':b='${expr}'`;
    }
    if (type === 'saturation') {
      if (!v) return '';
      const S = 1 + v / 100;
      const rr = (0.213 + 0.787 * S).toFixed(4), rg = (0.715 - 0.715 * S).toFixed(4), rb = (0.072 - 0.072 * S).toFixed(4);
      const gr = (0.213 - 0.213 * S).toFixed(4), gg = (0.715 + 0.285 * S).toFixed(4), gb = (0.072 - 0.072 * S).toFixed(4);
      const br = (0.213 - 0.213 * S).toFixed(4), bg = (0.715 - 0.715 * S).toFixed(4), bb = (0.072 + 0.928 * S).toFixed(4);
      return `colorchannelmixer=rr=${rr}:rg=${rg}:rb=${rb}:gr=${gr}:gg=${gg}:gb=${gb}:br=${br}:bg=${bg}:bb=${bb}`;
    }
    if (type === 'bw') return 'colorchannelmixer=rr=0.213:rg=0.715:rb=0.072:gr=0.213:gg=0.715:gb=0.072:br=0.213:bg=0.715:bb=0.072';
    if (type === 'sepia') return 'colorchannelmixer=rr=0.393:rg=0.769:rb=0.189:gr=0.349:gg=0.686:gb=0.168:br=0.272:bg=0.534:bb=0.131';
    if (type === 'blur') return v ? `gblur=sigma=${(v / 2).toFixed(2)}` : '';
    return '';
  }
  function chainFrag(effects) {
    if (!effects || !effects.length) return '';
    const active = (effects || []).filter(e => e.enabled !== false);
    const stages = active.map(effectFrag).filter(Boolean);
    if (!stages.length) return '';
    return ',format=rgb24,' + stages.join(',');
  }
  function fadeFrag(kind, obj) {
    const name = kind === 'v' ? 'fade' : 'afade';
    const fs = [];
    if (obj.fadeInD) fs.push(`${name}=t=in:st=${obj.fadeInSt.toFixed(3)}:d=${obj.fadeInD.toFixed(3)}`);
    if (obj.fadeOutD) fs.push(`${name}=t=out:st=${obj.fadeOutSt.toFixed(3)}:d=${obj.fadeOutD.toFixed(3)}`);
    return fs.length ? ',' + fs.join(',') : '';
  }

  const parts = [];
  // 오디오 소스 배열(0개=무음, 1개=그대로, N개=amix 로 동시 믹스) → 라벨 하나. 모든 구간 종류가 공용으로 쓴다.
  function buildAudio(sources, dur, label) {
    const d = dur.toFixed(3);
    if (!sources || !sources.length) {
      parts.push(`[${ensureSilent()}:a]atrim=duration=${d},asetpts=PTS-STARTPTS[${label}]`);
      return;
    }
    if (sources.length === 1) {
      const s = sources[0];
      parts.push(`[${inputIndexFor(s.file)}:a]atrim=start=${s.start}:end=${s.end}${fadeFrag('a', s)},asetpts=PTS-STARTPTS[${label}]`);
      return;
    }
    const subs = sources.map((s, j) => {
      const lb = `${label}_s${j}`;
      parts.push(`[${inputIndexFor(s.file)}:a]atrim=start=${s.start}:end=${s.end}${fadeFrag('a', s)},asetpts=PTS-STARTPTS[${lb}]`);
      return `[${lb}]`;
    });
    parts.push(`${subs.join('')}amix=inputs=${subs.length}:duration=longest[${label}]`);
  }

  const vLabels = segments.map((_, i) => `v${i}`);   // textFrag() 가 텍스트 있는 세그먼트만 바꿔치기한다
  segments.forEach((s, i) => {
    if (s.xfade) {
      // 같은 트랙에서 클립 두 개가 겹치도록 끌어다 놓은 구간 — 각자 겹친 부분만큼만 잘라서
      // xfade(영상)/acrossfade(오디오)로 섞는다. 둘 다 정확히 dur 길이로 잘랐으니 offset=0.
      const ix = idxs[i];
      const dur = s.dur.toFixed(3);
      const xw = s.refW || 1280, xh = s.refH || 720;
      parts.push(`[${ix.a}:v]trim=start=${s.aIn}:duration=${dur}${hdrFrag(s.hdrA)},setpts=PTS-STARTPTS${flipFrag(s.flipHA, s.flipVA)}${chainFrag(s.effectsA)},${scalePad(xw, xh)}[xva${i}]`);
      parts.push(`[${ix.b}:v]trim=start=${s.bIn}:duration=${dur}${hdrFrag(s.hdrB)},setpts=PTS-STARTPTS${flipFrag(s.flipHB, s.flipVB)}${chainFrag(s.effectsB)},${scalePad(xw, xh)}[xvb${i}]`);
      parts.push(`[xva${i}][xvb${i}]xfade=transition=fade:duration=${dur}:offset=0[v${i}]`);
      parts.push(s.hasAudioA === false
        ? `[${ensureSilent()}:a]atrim=duration=${dur},asetpts=PTS-STARTPTS[xaa${i}]`
        : `[${ix.a}:a]atrim=start=${s.aIn}:duration=${dur},asetpts=PTS-STARTPTS[xaa${i}]`);
      parts.push(s.hasAudioB === false
        ? `[${ensureSilent()}:a]atrim=duration=${dur},asetpts=PTS-STARTPTS[xab${i}]`
        : `[${ix.b}:a]atrim=start=${s.bIn}:duration=${dur},asetpts=PTS-STARTPTS[xab${i}]`);
      parts.push(`[xaa${i}][xab${i}]acrossfade=d=${dur}[a${i}]`);
      vLabels[i] = textFrag(s.texts, xw, xh, `v${i}`, i);
    } else if (s.layers) {
      // 트랙 겹침(PIP) — 검은 배경부터 시작해 아래→위 순서로 overlay 를 쌓는다.
      // s.layers 는 위(화면 앞)→아래 순서로 와 있으니 뒤집어서 처리.
      const w = s.refW || 1280, h = s.refH || 720;
      const bIdx = ensureBlack(w, h);
      let base = `v${i}_base`;
      parts.push(`[${bIdx}:v]trim=duration=${s.dur.toFixed(3)},setpts=PTS-STARTPTS,scale=${w}:${h}[${base}]`);
      [...s.layers].reverse().forEach((layer, li) => {
        const raw = `v${i}_l${li}`;
        const tf = layer.transform;
        const lw = tf ? Math.max(2, Math.round(w * tf.scale)) : w;
        const lh = tf ? Math.max(2, Math.round(h * tf.scale)) : h;
        const lx = tf ? Math.round(w * tf.x) : 0;
        const ly = tf ? Math.round(h * tf.y) : 0;
        parts.push(`[${inputIndexFor(layer.file)}:v]trim=start=${layer.start}:end=${layer.end}${hdrFrag(layer.hdr)}${fadeFrag('v', layer)},setpts=PTS-STARTPTS${flipFrag(layer.flipH, layer.flipV)}${chainFrag(layer.effects)},scale=${lw}:${lh}[${raw}]`);
        const next = `v${i}_s${li}`;
        parts.push(`[${base}][${raw}]overlay=${lx}:${ly}[${next}]`);
        base = next;
      });
      parts.push(`[${base}]null[v${i}]`);
      buildAudio(s.audioSources, s.dur, `a${i}`);
      vLabels[i] = textFrag(s.texts, w, h, `v${i}`, i);
    } else if (s.isAudioOnly) {
      // 영상 트랙이 없는 구간(mp3/wav 단독) — 공용 검은 화면을 이 구간 길이만큼 잘라 쓴다.
      const w = s.refW || 1280, h = s.refH || 720;
      const bIdx = ensureBlack(w, h);
      const dur = s.dur != null ? s.dur : (s.end - s.start);
      parts.push(`[${bIdx}:v]trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      buildAudio(s.audioSources, dur, `a${i}`);
      vLabels[i] = textFrag(s.texts, w, h, `v${i}`, i);
    } else {
      const dur = s.dur != null ? s.dur : (s.end - s.start);
      const w = s.refW || 1280, h = s.refH || 720;
      parts.push(`[${inputIndexFor(s.file)}:v]trim=start=${s.start}:end=${s.end}${hdrFrag(s.hdr)}${fadeFrag('v', s)},setpts=PTS-STARTPTS${flipFrag(s.flipH, s.flipV)}${chainFrag(s.effects)},${scalePad(w, h)}[v${i}]`);
      buildAudio(s.audioSources, dur, `a${i}`);
      vLabels[i] = textFrag(s.texts, w, h, `v${i}`, i);
    }
  });
  const concatIn = segments.map((_, i) => `[${vLabels[i]}][a${i}]`).join('');
  parts.push(`${concatIn}concat=n=${segments.length}:v=1:a=1[outv][outa]`);
  // fps 강제 지정 — 출력 -r 대신 필터로 건다(프레임 보간/드롭이 필터그래프 안에서 확실히
  // 끝나야 뒤이은 concat 라벨 매핑과 어긋나지 않는다).
  let outvLabel = 'outv';
  const fpsNum = Number(fps);
  if (fps && fps !== 'auto' && Number.isFinite(fpsNum) && fpsNum > 0) {
    parts.push(`[${outvLabel}]fps=${fpsNum}[outvfps]`);
    outvLabel = 'outvfps';
  }
  if (targetH) {
    const curH = Math.max(1, ...segments.map(s => s.refH || 0));
    if (targetH < curH) {   // 원본보다 낮을 때만 — 업스케일은 화질만 나빠지고 의미 없다
      parts.push(`[${outvLabel}]scale=-2:${targetH}[outvres]`);
      outvLabel = 'outvres';
    }
  }
  args.push('-filter_complex', parts.join(';'), '-map', `[${outvLabel}]`, '-map', '[outa]');

  if (fmt === 'webm') {
    args.push('-c:v', 'libvpx-vp9', '-crf', String(crf.vp9), '-b:v', '0', '-c:a', 'libopus', '-b:a', '128k');
  } else {   // mp4 — h264+aac
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf.h264), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k');
  }
  args.push('-progress', 'pipe:1', outPath);

  // drawtextDir(폰트 사본 + 캡션 txt) 은 이 export 안에서만 필요하다 — 끝나면(성공/실패
  // 상관없이) 지운다. cwd 를 여기로 두는 게 드라이브 콜론 이스케이프 문제를 피하는
  // 유일하게 검증된 방법이라(위 주석 참고), 텍스트가 있는 export 만 cwd 가 바뀐다.
  function cleanupDrawtextDir() { if (drawtextDir) { try { fs.rmSync(drawtextDir, { recursive: true, force: true }); } catch {} } }
  return await new Promise((resolve) => {
    let proc; try { proc = spawn(FFMPEG_BIN, args, { windowsHide: true, cwd: drawtextDir || undefined }); }
    catch (e) { cleanupDrawtextDir(); return resolve({ ok: false, error: String(e.message || e) }); }
    let stderr = '', outBuf = '';
    proc.stdout.on('data', (d) => {
      outBuf += d;
      const m = /out_time_ms=(\d+)/.exec(outBuf);
      const nl = outBuf.lastIndexOf('\n');
      if (nl >= 0) outBuf = outBuf.slice(nl + 1);
      if (m && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('video:exportProgress', { outTimeMs: Number(m[1]) });
      }
    });
    proc.stderr.on('data', (d) => stderr += d);
    proc.on('error', (e) => { cleanupDrawtextDir(); resolve({ ok: false, error: String(e.message || e) }); });
    proc.on('close', (code) => {
      cleanupDrawtextDir();
      if (code === 0) { grantWrite(outPath); resolve({ ok: true, outPath }); }
      else resolve({ ok: false, error: 'ffmpeg exit ' + code + ': ' + stderr.slice(-300) });
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
// 렌더러가 project:open-file 수신을 등록했다. 들고 있던 것이 있으면 지금 보낸다.
ipcMain.on('project:open-ready', (ev) => {
  if (mainWindow && !mainWindow.isDestroyed() && ev.sender === mainWindow.webContents) {
    rendererOpenReady = true;
    flushPendingProject();
  }
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
  // SCNet(10.6M 파라미터, MUSDB18 학습, MIT) 기반 4-stem 대안 모델. htdemucs 대비
  // SDR +17%(10.51 vs 9.00 dB) — 정확도 우선용. 대신 htdemucs보다 느리다(실측 확인됨).
  '4stem-2': {
    key:      '4stem-2',
    label:    '4-stem+ (정확도 우선)',
    file:     'scnet_base.onnx',
    sources:  4,
    stems:    ['drums', 'bass', 'other', 'vocals'],
    size:     44516685,
    url:      'https://github.com/whalemindbass/yt-separator-releases/releases/download/models-v1/scnet_base.onnx',
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
  // videoPath 같아도 modelKey 다르면 새 항목 (4-stem/4-stem+/6-stem 동시 보유).
  const recKey = rec.modelKey || '4stem';
  const idx = items.findIndex(it => it.videoPath === rec.videoPath && (it.modelKey || '4stem') === recKey);
  if (idx >= 0) {
    items[idx] = { ...items[idx], ...rec, createdAt: items[idx].createdAt || rec.createdAt };
  } else {
    // 새로 만드는 변형 — 같은 영상의 기존 변형이 있으면 즐겨찾기·그룹을 물려받는다.
    // 안 그러면 새 모델로 재분리한 순간 그 자리에서만 별이 꺼진 것처럼 보인다(라이브러리
    // 목록은 최초 변형을 대표로 쓰지만, 재생 중인 변형 자체의 데이터는 이걸 따로 들고 있다).
    const sibling = items.find(it => it.videoPath === rec.videoPath);
    if (sibling) {
      if (sibling.favorite) rec.favorite = true;
      if (sibling.group) rec.group = sibling.group;
    }
    items.push(rec);
  }
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
 * 베이스 채보(TAB) 결과 저장 — CREPE 가 제일 오래 걸리는 부분이라, 같은 곡을 다시 열 때마다
 * 재채보하지 않게 이 항목에 붙여 둔다. 즐겨찾기·그룹과 달리 형제 변형(4-stem/6-stem 등)에
 * 동기화하지 않는다 — 변형마다 베이스 스템 오디오 자체가 달라 채보 결과도 따로다.
 */
ipcMain.handle('library:setTab', (_ev, id, tab) => {
  const items = readLibrary();
  const idx = items.findIndex(it => it.id === id);
  if (idx < 0) return { ok: false, error: 'not found' };
  if (tab) items[idx].tab = tab; else delete items[idx].tab;
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

// ── IPC: 연습 기록(사용 시간) ──────────────────────────
// library.json 과 같은 이유로 localStorage 대신 실제 파일에 둔다 — localStorage 는
// 렌더러 코드 한 줄(removeItem)로 통째로 날아갈 수 있어서(실제로 이번 개발 중 테스트
// 스크립트가 그렇게 날려 먹었다), 그리고 브라우저 저장소는 앱 데이터로서의 보장이
// library.json 같은 진짜 파일보다 약하다. 업데이트(NSIS)는 userData 폴더를 건드리지
// 않으니 이 파일도 library.json 처럼 업데이트에 안전하다.
function usageFile() {
  return path.join(app.getPath('userData'), 'usageLog.json');
}
ipcMain.handle('usage:load', () => {
  try {
    const raw = fs.readFileSync(usageFile(), 'utf-8');
    const j = JSON.parse(raw);
    return {
      log: (j.log && typeof j.log === 'object') ? j.log : {},
      goals: (j.goals && typeof j.goals === 'object') ? j.goals : {},
    };
  } catch { return { log: {}, goals: {} }; }
});
ipcMain.handle('usage:save', (_ev, data) => {
  try {
    fs.writeFileSync(usageFile(), JSON.stringify({ log: data?.log || {}, goals: data?.goals || {} }));
    return true;
  } catch { return false; }
});
// 영상 편집 탭 — library.json/usageLog.json 과 같은 패턴. 프로젝트가 하나뿐이라(여러 개
// 관리하는 라이브러리 개념은 아직 없다) "저장" 버튼 없이 편집할 때마다 자동 저장하고,
// 탭에 들어올 때 그대로 복원한다 — 탭을 나가거나 앱을 껐다 켜도 작업이 안 사라진다.
function videoProjectFile() {
  return path.join(app.getPath('userData'), 'videoProject.json');
}
ipcMain.handle('videoProject:load', () => {
  try {
    const j = JSON.parse(fs.readFileSync(videoProjectFile(), 'utf-8'));
    return {
      tracks: Array.isArray(j.tracks) ? j.tracks : [],
      clips: Array.isArray(j.clips) ? j.clips : [],
      resolution: (j.resolution && j.resolution.w && j.resolution.h) ? j.resolution : null,
    };
  } catch { return { tracks: [], clips: [] }; }
});
ipcMain.handle('videoProject:save', (_ev, data) => {
  try {
    fs.writeFileSync(videoProjectFile(), JSON.stringify({ tracks: data?.tracks || [], clips: data?.clips || [], resolution: data?.resolution || null }));
    return true;
  } catch { return false; }
});
