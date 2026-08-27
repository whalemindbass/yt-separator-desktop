'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('yssApi', {
  // 드래그드롭 파일 → 절대경로 (Electron 43: File.path 제거됨 → webUtils)
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  // 앱 메타
  getVersion:      () => ipcRenderer.invoke('app:version'),
  getPlatform:     () => ipcRenderer.invoke('app:platform'),
  getDownloadsDir: () => ipcRenderer.invoke('app:downloadsDir'),

  // Window controls (frameless titlebar)
  window: {
    minimize:    () => ipcRenderer.invoke('window:minimize'),
    maxToggle:   () => ipcRenderer.invoke('window:maxToggle'),
    close:       () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onState: (fn) => {
      const h = (_ev, data) => fn(data);
      ipcRenderer.on('window:state', h);
      return () => ipcRenderer.off('window:state', h);
    },
    onFocus: (fn) => {
      const h = () => fn();
      ipcRenderer.on('window:focus', h);
      return () => ipcRenderer.off('window:focus', h);
    },
  },

  // 클립보드
  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
  },

  // 설정
  settings: {
    get:              ()          => ipcRenderer.invoke('settings:get'),
    set:              (obj)       => ipcRenderer.invoke('settings:set', obj),
    downloadsDir:     ()          => ipcRenderer.invoke('settings:downloadsDir'),
    pickDownloadsDir: ()          => ipcRenderer.invoke('settings:pickDownloadsDir'),
    stemsDir:         ()          => ipcRenderer.invoke('settings:stemsDir'),
    pickStemsDir:     ()          => ipcRenderer.invoke('settings:pickStemsDir'),
    calcDiskUsage:    ()          => ipcRenderer.invoke('settings:calcDiskUsage'),
    deleteModel:      (key)       => ipcRenderer.invoke('settings:deleteModel', key),
    appInfo:          ()          => ipcRenderer.invoke('settings:appInfo'),
    openUserData:     ()          => ipcRenderer.invoke('settings:openUserData'),
  },

  // 로컬 파일/폴더 선택 · 저장
  dialog: {
    pickMedia:  ()               => ipcRenderer.invoke('dialog:pickMedia'),
    pickMediaFiles: ()           => ipcRenderer.invoke('dialog:pickMediaFiles'),
    pickAudioFiles: ()           => ipcRenderer.invoke('dialog:pickAudioFiles'),
    pickVideoFile:  ()           => ipcRenderer.invoke('dialog:pickVideoFile'),
    pickVideoFiles: ()           => ipcRenderer.invoke('dialog:pickVideoFiles'),
    saveAs:     (name, exts)     => ipcRenderer.invoke('dialog:saveAs', name, exts),
    pickFolder: (title)          => ipcRenderer.invoke('dialog:pickFolder', title),
  },
  fs: {
    copyFile:    (src, dst)      => ipcRenderer.invoke('fs:copyFile', src, dst),
    writeBuffer: (path, data)    => ipcRenderer.invoke('fs:writeBuffer', path, data),
  },
  project: {
    save: (json, name, path) => ipcRenderer.invoke('project:save', json, name, path),
    open: ()           => ipcRenderer.invoke('project:open'),
    // 자동 저장 — 사용자가 고른 파일이 아니라 별도 스냅샷에 쓴다
    autosaveWrite: (json, meta) => ipcRenderer.invoke('project:autosaveWrite', json, meta),
    autosaveRead:  ()           => ipcRenderer.invoke('project:autosaveRead'),
    autosaveClear: ()           => ipcRenderer.invoke('project:autosaveClear'),
    // 저장 안 한 변경 여부를 알려 두면 창을 닫을 때 메인이 묻는다
    setDirty:      (v)  => ipcRenderer.send('project:dirty', !!v),
    // 닫기 전 저장 요청 → 끝나면 결과를 돌려준다
    onSaveRequest: (fn) => ipcRenderer.on('project:save-request', () => fn()),
    saveResult:    (ok) => ipcRenderer.send('project:save-result', !!ok),
    // .yssproj 를 더블클릭해 들어온 경우.
    // 수신을 등록한 그 자리에서 main 에 알린다 — 등록 전에 보낸 것은 아무도 받지 못하고
    // 그대로 사라진다. 예전에는 화면 로드 후 400ms 를 기다려 보냈는데, 느린 컴퓨터에서는
    // 그 사이에 등록이 안 끝나 더블클릭이 아무 일도 하지 않는 것처럼 보였다.
    onOpenFile:    (fn) => { ipcRenderer.on('project:open-file', (_e, p) => fn(p)); ipcRenderer.send('project:open-ready'); },
  },
  audio: {
    transcode: (src, dst, opts) => ipcRenderer.invoke('audio:transcode', src, dst, opts),
  },
  videoProject: {
    load: ()     => ipcRenderer.invoke('videoProject:load'),
    save: (data) => ipcRenderer.invoke('videoProject:save', data),
  },
  video: {
    probeAudio: (file) => ipcRenderer.invoke('video:probeAudio', file),
    export: (payload) => ipcRenderer.invoke('video:export', payload),
    onExportProgress: (fn) => {
      const h = (_ev, data) => fn(data);
      ipcRenderer.on('video:exportProgress', h);
      return () => ipcRenderer.off('video:exportProgress', h);
    },
  },

  // 지난 실행이 비정상 종료했는지 — 읽으면 지워진다
  takeLastCrash: () => ipcRenderer.invoke('crash:take'),

  // OS 가 그리는 파일 선택창·경고창도 같은 언어로 뜨게 한다
  setLocale: (loc) => ipcRenderer.send('app:locale', loc),

  // 외부
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openPath:     (p)   => ipcRenderer.invoke('shell:openPath', p),

  // yt-dlp
  ytdlp: {
    probe:    (url) => ipcRenderer.invoke('ytdlp:probe', url),
    download: (url, opts) => ipcRenderer.invoke('ytdlp:download', url, opts),
    cancel:   ()    => ipcRenderer.invoke('ytdlp:cancel'),
    onProgress: (fn) => {
      const h = (_ev, data) => fn(data);
      ipcRenderer.on('ytdlp:progress', h);
      return () => ipcRenderer.off('ytdlp:progress', h);
    },
  },

  // stem 분리
  stem: {
    models:        ()      => ipcRenderer.invoke('stem:models'),
    ensureModel:   (key)   => ipcRenderer.invoke('stem:ensureModel', key),
    cancelDownload:(key)   => ipcRenderer.invoke('stem:cancelModelDownload', key),
    onDownloadProgress: (fn) => {
      const h = (_ev, data) => fn(data);
      ipcRenderer.on('stem:modelDownloadProgress', h);
      return () => ipcRenderer.off('stem:modelDownloadProgress', h);
    },
    modelBytes:   (key)    => ipcRenderer.invoke('stem:modelBytes', key),
    extractAudio: (videoPath) => ipcRenderer.invoke('stem:extractAudio', videoPath),
    saveStems:    (stems, baseName, sampleRate) => ipcRenderer.invoke('stem:saveStems', stems, baseName, sampleRate),
  },

  // 자동 업데이트
  update: {
    check:    () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install:  () => ipcRenderer.invoke('update:install'),
    onEvent: (fn) => {
      const h = (_ev, data) => fn(data);
      ipcRenderer.on('update:event', h);
      return () => ipcRenderer.off('update:event', h);
    },
  },

  // 라이브러리
  library: {
    list:            ()                => ipcRenderer.invoke('library:list'),
    register:        (entry)           => ipcRenderer.invoke('library:register', entry),
    rename:          (id, name)        => ipcRenderer.invoke('library:rename', id, name),
    remove:          (id, alsoFiles)   => ipcRenderer.invoke('library:delete', id, alsoFiles),
    findByVideoId:   (id)              => ipcRenderer.invoke('library:findByVideoId', id),
    cleanup:         ()                => ipcRenderer.invoke('library:cleanup'),
    previewOrphans:  ()                => ipcRenderer.invoke('library:previewOrphans'),
    deleteOrphan:    (p)               => ipcRenderer.invoke('library:deleteOrphan', p),
    setFavorite:     (id, fav)         => ipcRenderer.invoke('library:setFavorite', id, fav),
    setGroup:        (id, group)       => ipcRenderer.invoke('library:setGroup', id, group),
    setTab:          (id, tab)         => ipcRenderer.invoke('library:setTab', id, tab),
  },

  // 연습 기록(사용 시간) — library.json 처럼 실제 파일에 저장(usageLog.json)
  usage: {
    load: ()     => ipcRenderer.invoke('usage:load'),
    save: (data) => ipcRenderer.invoke('usage:save', data),
  },

  // 실시간 오디오 엔진 (JUCE 사이드카)
  engine: {
    start:       (stems)  => ipcRenderer.invoke('engine:start', stems),
    cmd:         (c)      => ipcRenderer.invoke('engine:cmd', c),
    quit:        ()       => ipcRenderer.invoke('engine:quit'),
    loadStems:   (paths)  => ipcRenderer.invoke('engine:cmd', { cmd: 'loadStems', paths }),
    play:        ()       => ipcRenderer.invoke('engine:cmd', { cmd: 'play' }),
    stop:        ()       => ipcRenderer.invoke('engine:cmd', { cmd: 'stop' }),
    seek:        (pos)    => ipcRenderer.invoke('engine:cmd', { cmd: 'seek', pos }),
    scanPlugins: ()       => ipcRenderer.invoke('engine:cmd', { cmd: 'scanPlugins' }),
    track:       (index, opts) => ipcRenderer.invoke('engine:cmd', { cmd: 'track', index, ...(opts || {}) }),
    automation:  (track, opts) => ipcRenderer.invoke('engine:cmd', { cmd: 'automation', track, ...(opts || {}) }),
    pdc:         (on)   => ipcRenderer.invoke('engine:cmd', { cmd: 'pdc', on }),
    master:      (gain)   => ipcRenderer.invoke('engine:cmd', { cmd: 'master', gain }),
    bus:         (index, opts) => ipcRenderer.invoke('engine:cmd', { cmd: 'bus', index, ...(opts || {}) }),
    monitor:     (gain)   => ipcRenderer.invoke('engine:cmd', { cmd: 'monitor', gain }),
    inputMonitor:(on)     => ipcRenderer.invoke('engine:cmd', { cmd: 'inputMonitor', on }),
    tuner:       (on)     => ipcRenderer.invoke('engine:cmd', { cmd: 'tuner', on }),
    inputConfig: (opts)   => ipcRenderer.invoke('engine:cmd', { cmd: 'inputConfig', ...(opts || {}) }),
    metro:       (on, bpm, phase, interval)=> ipcRenderer.invoke('engine:cmd', { cmd: 'metro', on, bpm, phase: phase || 0, interval: interval || 0 }),
    listDevices: ()       => ipcRenderer.invoke('engine:cmd', { cmd: 'listDevices' }),
    setDevice:   (opts)   => ipcRenderer.invoke('engine:cmd', { cmd: 'setDevice', ...(opts || {}) }),
    fxAdd:       (track, index)     => ipcRenderer.invoke('engine:cmd', { cmd: 'fxAdd', track, index }),
    fxRemove:    (track, slot)      => ipcRenderer.invoke('engine:cmd', { cmd: 'fxRemove', track, slot }),
    fxReorder:   (track, order)     => ipcRenderer.invoke('engine:cmd', { cmd: 'fxReorder', track, order }),
    fxSetChain:  (track, plugins)   => ipcRenderer.invoke('engine:cmd', { cmd: 'fxSetChain', track, plugins }),
    fxBypass:    (track, slot, on)  => ipcRenderer.invoke('engine:cmd', { cmd: 'fxBypass', track, slot, on }),
    fxBypassAll: (track, on)        => ipcRenderer.invoke('engine:cmd', { cmd: 'fxBypassAll', track, on }),
    fxEditor:    (track, slot)      => ipcRenderer.invoke('engine:cmd', { cmd: 'fxEditor', track, slot }),
    fxSaveState: (track, slot)      => ipcRenderer.invoke('engine:cmd', { cmd: 'fxSaveState', track, slot }),
    fxSetState:  (track, slot, data)=> ipcRenderer.invoke('engine:cmd', { cmd: 'fxSetState', track, slot, data }),
    fxChainReq:  (track)            => ipcRenderer.invoke('engine:cmd', { cmd: 'fxChainReq', track }),
    recordArm:   ()       => ipcRenderer.invoke('engine:recordArm'),
    recordStop:  ()       => ipcRenderer.invoke('engine:cmd', { cmd: 'recordStop' }),
    takeRemove:  (id)     => ipcRenderer.invoke('engine:cmd', { cmd: 'takeRemove', id }),
    takeClear:   ()       => ipcRenderer.invoke('engine:cmd', { cmd: 'takeClear' }),
    takeLoad:    (file, start, trackId, id) => ipcRenderer.invoke('engine:cmd', { cmd: 'takeLoad', file, start, trackId, id }),
    takeMove:    (id, start, trackId) => ipcRenderer.invoke('engine:cmd', { cmd: 'takeMove', id, start, trackId }),
    takeTrim:    (id, start, inOffset, len) => ipcRenderer.invoke('engine:cmd', { cmd: 'takeTrim', id, start, inOffset, len }),
    takeSplit:   (id, at, newId) => ipcRenderer.invoke('engine:cmd', { cmd: 'takeSplit', id, at, newId }),
    takeFade:    (id, fadeIn, fadeOut) => ipcRenderer.invoke('engine:cmd', { cmd: 'takeFade', id, fadeIn, fadeOut }),
    stemOffset:  (samples) => ipcRenderer.invoke('engine:cmd', { cmd: 'stemOffset', samples }),
    recTrackAdd:    (type)    => ipcRenderer.invoke('engine:cmd', { cmd: 'recTrackAdd', type: type || 0 }),
    recTrackRemove: (id)      => ipcRenderer.invoke('engine:cmd', { cmd: 'recTrackRemove', id }),
    recArm:         (id)      => ipcRenderer.invoke('engine:cmd', { cmd: 'recArm', id }),
    recTrack:       (id, opts)=> ipcRenderer.invoke('engine:cmd', { cmd: 'recTrack', id, ...(opts || {}) }),
    recTracksReq:   ()        => ipcRenderer.invoke('engine:cmd', { cmd: 'recTracks' }),
    recTracksReset: (tracks, gen) => ipcRenderer.invoke('engine:cmd', { cmd: 'recTracksReset', tracks, gen }),
    onEvent:     (fn)     => {
      const h = (_ev, m) => fn(m);
      ipcRenderer.on('engine:event', h);
      return () => ipcRenderer.off('engine:event', h);
    },
  },
});
