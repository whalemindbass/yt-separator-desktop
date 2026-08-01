'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yssApi', {
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
    saveAs:     (name, exts)     => ipcRenderer.invoke('dialog:saveAs', name, exts),
    pickFolder: (title)          => ipcRenderer.invoke('dialog:pickFolder', title),
  },
  fs: {
    copyFile:    (src, dst)      => ipcRenderer.invoke('fs:copyFile', src, dst),
    writeBuffer: (path, data)    => ipcRenderer.invoke('fs:writeBuffer', path, data),
  },

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
    loadFx:      (index)  => ipcRenderer.invoke('engine:cmd', { cmd: 'loadFx', index }),
    showEditor:  ()       => ipcRenderer.invoke('engine:cmd', { cmd: 'showEditor' }),
    recordArm:   (file)   => ipcRenderer.invoke('engine:cmd', { cmd: 'recordArm', file }),
    recordStop:  ()       => ipcRenderer.invoke('engine:cmd', { cmd: 'recordStop' }),
    onEvent:     (fn)     => {
      const h = (_ev, m) => fn(m);
      ipcRenderer.on('engine:event', h);
      return () => ipcRenderer.off('engine:event', h);
    },
  },
});
