'use strict';
// Player — <video>(무음) + Web Audio API로 stem mixing
// Video 이벤트(play/pause/seek/ratechange)에 stem source를 sync.

export const STEM_META = {
  vocals: { label: '보컬',   color: '#e15b5b' },
  drums:  { label: '드럼',   color: '#e6c33a' },
  bass:   { label: '베이스', color: '#4b7bff' },
  other:  { label: '기타',   color: '#e75ea0' },
};
export const STEM_ORDER = ['vocals', 'bass', 'drums', 'other'];

/** 파일 시스템 경로 → ytsep://f/... URL */
export function toYtsepUrl(p) {
  const s = String(p).replace(/\\/g, '/');
  return 'ytsep://f/' + encodeURI(s);
}

/** stemPaths({name: fsPath}) → 각 name에 대해 [Float32 L, Float32 R] + sampleRate */
export async function loadStemFilesToBuffers(stemPaths) {
  const ctx = new AudioContext();
  try {
    const out = {};
    let sampleRate = ctx.sampleRate;
    for (const [name, p] of Object.entries(stemPaths)) {
      const url = toYtsepUrl(p);
      console.log(`[loadStems] fetching ${name}: ${url}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch stem ${name} failed: ${res.status} (${p})`);
      const ab = await res.arrayBuffer();
      console.log(`[loadStems] ${name} fetched, bytes=${ab.byteLength}`);
      let audioBuf;
      try {
        audioBuf = await ctx.decodeAudioData(ab);
      } catch (e) {
        throw new Error(`decodeAudioData failed for ${name}: ${e.message}`);
      }
      sampleRate = audioBuf.sampleRate;
      console.log(`[loadStems] ${name} decoded, ch=${audioBuf.numberOfChannels}, sr=${audioBuf.sampleRate}, samples=${audioBuf.length}`);
      const L = audioBuf.getChannelData(0);
      const R = audioBuf.numberOfChannels > 1 ? audioBuf.getChannelData(1) : audioBuf.getChannelData(0);
      out[name] = [new Float32Array(L), new Float32Array(R)];
    }
    return { stems: out, sampleRate };
  } finally {
    try { ctx.close(); } catch {}
  }
}

export class Player {
  /**
   * @param {HTMLVideoElement} videoEl
   * @param {string} videoUrl file:// URL
   * @param {Record<string,[Float32Array,Float32Array]>} stems
   * @param {number} sampleRate
   */
  constructor(videoEl, videoUrl, stems, sampleRate) {
    this.videoEl = videoEl;
    this.videoEl.src = videoUrl;
    this.videoEl.muted = true;
    this.videoEl.volume = 0;

    // 시스템 기본 sampleRate 사용 — mismatch가 있어도 AudioBufferSource가 자동 리샘플
    // 확장에서 검증된 방식: buffer SR과 매칭해서 리샘플 이슈 배제
    // (일부 시스템에서 44100 buffer → 48000 ctx 리샘플 시 무음 이슈)
    try {
      this.audioCtx = new AudioContext({ sampleRate });
    } catch {
      this.audioCtx = new AudioContext();
    }
    console.log(`[Player] AudioContext state=${this.audioCtx.state} ctxSR=${this.audioCtx.sampleRate} bufSR=${sampleRate}`);

    // Master gain — 직접 destination에 연결 (limiter 제거해서 무음 원인 배제)
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.audioCtx.destination);

    // 각 stem AudioBuffer + GainNode
    this.stemBuffers = {};
    this.stemGains   = {};
    this.stemVolumes = {};
    this.stemMuted   = {};
    for (const name of STEM_ORDER) {
      const arr = stems[name];
      if (!arr) continue;
      const [L, R] = arr;
      // stem 원본 SR로 buffer 생성 — playback 시 자동 리샘플
      const buf = this.audioCtx.createBuffer(2, L.length, sampleRate);
      buf.copyToChannel(L, 0);
      buf.copyToChannel(R, 1);
      // Peak — 전체 스캔 (일부만 보면 drop-in silence 못 잡음)
      let peak = 0;
      const step = Math.max(1, Math.floor(L.length / 100000));
      for (let i = 0; i < L.length; i += step) {
        const av = Math.abs(L[i]);
        if (av > peak) peak = av;
      }
      console.log(`[Player] stem "${name}" samples=${L.length} duration=${buf.duration.toFixed(2)}s peak=${peak.toFixed(3)} ctxSR=${this.audioCtx.sampleRate} bufSR=${buf.sampleRate}`);
      this.stemBuffers[name] = buf;
      const g = this.audioCtx.createGain();
      g.gain.value = 1.0;
      g.connect(this.masterGain);
      this.stemGains[name] = g;
      this.stemVolumes[name] = 1.0;
      this.stemMuted[name] = false;
    }

    this.sources = {};
    this._playing = false;
    this._bindVideoEvents();
  }

  _bindVideoEvents() {
    const v = this.videoEl;
    this._playStartCtxTime = null;   // startAll 시점의 audioCtx.currentTime
    this._playStartOffset  = 0;      // 그때 video.currentTime

    // start/stop 요청 debounce — 짧은 시간에 몰려오는 play/seeked 이벤트에 반응하지 않음
    let syncTimer = null;
    const scheduleSync = (reason) => {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncTimer = null;
        this._syncNow(reason);
      }, 80);
    };
    let stopTimer = null;
    const cancelStop = () => { if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; } };
    const scheduleStop = () => {
      cancelStop();
      stopTimer = setTimeout(() => {
        stopTimer = null;
        this._stopAll();
        this._playing = false;
        this._playStartCtxTime = null;
      }, 100);
    };

    this._onPlayL   = () => { cancelStop(); scheduleSync('play'); };
    this._onSeekedL = () => { if (!v.paused) scheduleSync('seek'); };
    this._onPauseL  = () => { if (v.ended) return this._onEndedL(); scheduleStop(); };
    this._onEndedL  = () => { cancelStop(); this._stopAll(); this._playing = false; };
    this._onRateL   = () => {
      const r = v.playbackRate || 1;
      for (const src of Object.values(this.sources)) {
        try { src.playbackRate.setValueAtTime(r, this.audioCtx.currentTime); } catch {}
      }
    };
    this._onVolL = () => {
      if (!v.muted || v.volume > 0) { v.muted = true; v.volume = 0; }
    };
    v.addEventListener('play',         this._onPlayL);
    v.addEventListener('pause',        this._onPauseL);
    v.addEventListener('seeked',       this._onSeekedL);
    v.addEventListener('ended',        this._onEndedL);
    v.addEventListener('ratechange',   this._onRateL);
    v.addEventListener('volumechange', this._onVolL);
  }

  /** debounce 후 video 위치에 맞춰 stem을 재동기화 */
  async _syncNow(reason) {
    const v = this.videoEl;
    if (v.paused) return;
    if (this.audioCtx.state === 'suspended') {
      try { await this.audioCtx.resume(); } catch (e) { console.error('[Player] resume', e); }
    }
    // stems가 이미 돌고 있으면 drift 확인
    if (this._playing && this._playStartCtxTime != null) {
      const stemTime = this._playStartOffset + (this.audioCtx.currentTime - this._playStartCtxTime);
      const drift = Math.abs(stemTime - v.currentTime);
      if (drift < 0.3) {
        // 이미 sync 상태 — 재시작 안 함 (audible glitch 방지)
        return;
      }
      console.log(`[Player] resync (${reason}) drift=${drift.toFixed(3)}s`);
      this._stopAll();
    }
    this._startAll(v.currentTime);
    this._playing = true;
    this._playStartCtxTime = this.audioCtx.currentTime;
    this._playStartOffset  = v.currentTime;
  }
  _unbindVideoEvents() {
    const v = this.videoEl;
    if (this._onPlayL)   v.removeEventListener('play',         this._onPlayL);
    if (this._onPauseL)  v.removeEventListener('pause',        this._onPauseL);
    if (this._onSeekedL) v.removeEventListener('seeked',       this._onSeekedL);
    if (this._onEndedL)  v.removeEventListener('ended',        this._onEndedL);
    if (this._onRateL)   v.removeEventListener('ratechange',   this._onRateL);
    if (this._onVolL)    v.removeEventListener('volumechange', this._onVolL);
  }

  _startAll(offset) {
    const rate = this.videoEl.playbackRate || 1;
    let started = 0;
    for (const [name, buf] of Object.entries(this.stemBuffers)) {
      const src = this.audioCtx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(this.stemGains[name]);
      const off = Math.max(0, Math.min(offset || 0, buf.duration - 0.001));
      try { src.start(0, off); started++; }
      catch (e) { console.error('[Player] source start failed', name, e); }
      this.sources[name] = src;
    }
    console.log('[Player] started sources:', started, 'offset:', offset,
                'masterGain:', this.masterGain.gain.value);
  }

  _stopAll() {
    for (const src of Object.values(this.sources)) {
      try { src.stop(); } catch {}
    }
    this.sources = {};
  }

  setMasterVolume(v) {
    this.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(2, v)), this.audioCtx.currentTime, 0.02);
  }

  setStemVolume(name, v) {
    if (!this.stemGains[name]) return;
    this.stemVolumes[name] = Math.max(0, Math.min(2, v));
    if (!this.stemMuted[name]) {
      this.stemGains[name].gain.setTargetAtTime(this.stemVolumes[name], this.audioCtx.currentTime, 0.02);
    }
  }

  toggleMute(name) {
    if (!this.stemGains[name]) return this.stemMuted[name] || false;
    this.stemMuted[name] = !this.stemMuted[name];
    const val = this.stemMuted[name] ? 0 : this.stemVolumes[name];
    this.stemGains[name].gain.setTargetAtTime(val, this.audioCtx.currentTime, 0.02);
    return this.stemMuted[name];
  }

  /** 진단: vocals stem을 destination에 직접 연결해 3초 재생. 들리면 buffer/graph는 정상 */
  async testStemDirect() {
    if (this.audioCtx.state === 'suspended') {
      try { await this.audioCtx.resume(); } catch (e) { console.error('[Player] stem-test resume failed', e); }
    }
    const buf = this.stemBuffers.vocals || this.stemBuffers.drums || Object.values(this.stemBuffers)[0];
    if (!buf) { console.warn('[Player] no stem buffer for direct test'); return; }
    const src = this.audioCtx.createBufferSource();
    src.buffer = buf;
    // 완전 우회 — stemGain/masterGain 안 거치고 direct
    src.connect(this.audioCtx.destination);
    const now = this.audioCtx.currentTime;
    src.start(now, 0);
    src.stop(now + 3);
    console.log(`[Player] direct stem test scheduled, buf.duration=${buf.duration.toFixed(2)}s buf.sampleRate=${buf.sampleRate} ctx.sampleRate=${this.audioCtx.sampleRate}`);
  }

  /** 진단: masterGain 경유로 500ms 440Hz sine. 들리면 audio graph 자체는 정상 */
  async testBeep() {
    if (this.audioCtx.state === 'suspended') {
      try { await this.audioCtx.resume(); } catch (e) { console.error('[Player] beep resume failed', e); }
    }
    const osc = this.audioCtx.createOscillator();
    const g = this.audioCtx.createGain();
    osc.frequency.value = 440;
    g.gain.value = 0.15;
    osc.connect(g).connect(this.masterGain);
    const now = this.audioCtx.currentTime;
    osc.start(now);
    osc.stop(now + 0.5);
    console.log('[Player] beep scheduled, ctx.state=', this.audioCtx.state,
                'masterGain=', this.masterGain.gain.value,
                'destination.maxChannels=', this.audioCtx.destination.maxChannelCount);
  }

  getStatus() {
    return {
      ctxState: this.audioCtx.state,
      ctxSampleRate: this.audioCtx.sampleRate,
      playing: this._playing,
      activeSources: Object.values(this.sources).filter(Boolean).length,
      videoTime: this.videoEl.currentTime.toFixed(2),
      videoPaused: this.videoEl.paused,
      videoReadyState: this.videoEl.readyState,
      masterGain: this.masterGain.gain.value.toFixed(2),
    };
  }

  destroy() {
    this._stopAll();
    this._unbindVideoEvents();
    try { this.audioCtx.close(); } catch {}
    try { this.videoEl.pause(); this.videoEl.removeAttribute('src'); this.videoEl.load(); } catch {}
  }
}
