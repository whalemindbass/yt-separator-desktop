'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yssApi', {
  // 앱 메타
  getVersion:      () => ipcRenderer.invoke('app:version'),
  getPlatform:     () => ipcRenderer.invoke('app:platform'),
  getDownloadsDir: () => ipcRenderer.invoke('app:downloadsDir'),

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
    modelBytes:   () => ipcRenderer.invoke('stem:modelBytes'),
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
  },
});
