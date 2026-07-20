'use strict';
// Player — <video>(무음) + Web Audio API로 stem mixing
// Video 이벤트(play/pause/seek/ratechange)에 stem source를 sync.

import { pitchShiftStereo } from './pitch-shift.js';

export const STEM_META = {
  vocals: { label: '보컬',    color: '#e15b5b', icon: 'stem_vocals.png' },
  drums:  { label: '드럼',    color: '#e6c33a', icon: 'stem_drums.png' },
  bass:   { label: '베이스',  color: '#4b7bff', icon: 'stem_bass.png' },
  other:  { label: '기타(그외)', color: '#e75ea0', icon: 'stem_other.png' },
  guitar: { label: '기타',    color: '#f97316', icon: 'stem_other.png' },   // 6-stem guitar는 확장에서 stem_other.png 재사용
  piano:  { label: '피아노',  color: '#a78bfa', icon: 'stem_piano.png' },
};
export const STEM_ORDER   = ['vocals', 'bass', 'drums', 'other'];
export const STEM_ORDER_6 = ['vocals', 'guitar', 'bass', 'drums', 'piano', 'other'];
export function stemOrderFor(modelKey) {
  return modelKey === '6stem' ? STEM_ORDER_6 : STEM_ORDER;
}
/** 6-stem 모드에서는 other 아이콘을 stem_other_6.png 로 오버라이드 */
export function stemIconFor(name, modelKey) {
  if (name === 'other' && modelKey === '6stem') return './assets/stem-icons/stem_other_6.png';
  return './assets/stem-icons/' + (STEM_META[name]?.icon || `stem_${name}.png`);
}

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

/** Float32 stereo → 16-bit PCM WAV ArrayBuffer */
function encodeWavAB(L, R, sr) {
  const n = Math.min(L.length, R.length);
  const dataBytes = n * 2 * 2;
  const ab = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(ab);
  const wr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true);
  wr(8, 'WAVE'); wr(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true);
  v.setUint16(32, 4, true);  v.setUint16(34, 16, true);
  wr(36, 'data'); v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, L[i]));
    const r = Math.max(-1, Math.min(1, R[i]));
    v.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7FFF, true);
    v.setInt16(off + 2, r < 0 ? r * 0x8000 : r * 0x7FFF, true);
    off += 4;
  }
  return ab;
}

export class Player {
  static _cache = new WeakMap();  // videoEl → { ctx, source }

  /**
   * @param {HTMLVideoElement} videoEl
   * @param {string} videoUrl file:// URL
   * @param {Record<string,[Float32Array,Float32Array]>} stems
   * @param {number} sampleRate
   * @param {Record<string,string>} [stemUrls] — 각 stem의 ytsep URL. 제공되면 배속 시 피치 보존.
   */
  constructor(videoEl, videoUrl, stems, sampleRate, stemUrls) {
    this.videoEl = videoEl;
    if (!this.videoEl.crossOrigin) this.videoEl.crossOrigin = 'anonymous';
    this.videoEl.src = videoUrl;
    this.videoEl.muted = false;
    this.videoEl.volume = 1;

    // MediaElementSource는 video 요소당 1회만 생성 가능 → ctx+source 캐시
    let cache = Player._cache.get(videoEl);
    if (cache && cache.ctx.state === 'closed') cache = null;
    if (cache) {
      this.audioCtx = cache.ctx;
      this.videoSource = cache.source;
    } else {
      try { this.audioCtx = new AudioContext({ sampleRate }); }
      catch { this.audioCtx = new AudioContext(); }
      try {
        this.videoSource = this.audioCtx.createMediaElementSource(this.videoEl);
      } catch (e) { console.warn('[Player] MES', e.message); this.videoSource = null; }
      Player._cache.set(videoEl, { ctx: this.audioCtx, source: this.videoSource });
    }
    this._sampleRate = sampleRate;
    console.log(`[Player] ctx state=${this.audioCtx.state} ctxSR=${this.audioCtx.sampleRate} bufSR=${sampleRate}`);

    // 그래프: masterGain → destination
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.audioCtx.destination);

    // 스템 → stemMixGain → masterGain
    this.stemMixGain = this.audioCtx.createGain();
    this.stemMixGain.gain.value = 1.0;
    this.stemMixGain.connect(this.masterGain);

    // 원본 오디오 → origMixGain → masterGain
    this.origMixGain = this.audioCtx.createGain();
    this.origMixGain.gain.value = 0;
    if (this.videoSource) {
      try { this.videoSource.disconnect(); } catch {}
      this.videoSource.connect(this.origMixGain);
    } else {
      // MES 실패 → 원본 오디오 제어 불가 → 안전하게 mute
      this.videoEl.muted = true;
      this.videoEl.volume = 0;
    }
    this.origMixGain.connect(this.masterGain);

    // 원본 Float32 (pitch shift 재처리용) 복사 저장 + 현재 재생중 pitched Float32
    this.stemsOrig    = {};
    this.stemsCurrent = {};
    for (const name of Object.keys(stems)) {
      if (!stems[name]) continue;
      const [L, R] = stems[name];
      this.stemsOrig[name]    = [new Float32Array(L), new Float32Array(R)];
      this.stemsCurrent[name] = [new Float32Array(L), new Float32Array(R)];
    }
    this._currentKey = 0;

    // ── 스템 재생 백엔드 결정 ─────────────────────────
    // stemUrls 제공 → HTMLAudioElement 기반 (preservesPitch = true, 배속 시 피치 유지)
    // 없으면 AudioBufferSourceNode 폴백 (피치가 배속 따라 이동)
    this.stemUrls    = stemUrls || null;
    this.usePitchPreserve = !!this.stemUrls && Object.keys(this.stemUrls).length > 0;

    this.stemAudios  = {};
    this.stemBuffers = {};
    this.stemGains   = {};
    this.stemVolumes = {};
    this.stemMuted   = {};
    this.stemSolo    = {};
    this._stemBlobUrls = {};

    for (const name of Object.keys(stems)) {
      const arr = stems[name];
      if (!arr) continue;
      const [L, R] = arr;

      // stem 원본 SR로 buffer 생성 (export/pitch shift 용, 재생용은 아니지만 유지)
      const buf = this.audioCtx.createBuffer(2, L.length, sampleRate);
      buf.copyToChannel(L, 0);
      buf.copyToChannel(R, 1);
      this.stemBuffers[name] = buf;

      const g = this.audioCtx.createGain();
      g.gain.value = 1.0;

      if (this.usePitchPreserve) {
        // <audio> 요소 + MediaElementSource
        const audio = new Audio();
        audio.crossOrigin = 'anonymous';
        audio.preservesPitch = true;
        audio.mozPreservesPitch = true;
        audio.webkitPreservesPitch = true;
        audio.preload = 'auto';
        audio.src = this.stemUrls[name];
        audio.load();
        try {
          const src = this.audioCtx.createMediaElementSource(audio);
          src.connect(g);
        } catch (e) {
          console.warn(`[Player] MES failed for stem ${name}`, e.message);
        }
        this.stemAudios[name] = audio;
      }

      g.connect(this.stemMixGain);
      this.stemGains[name] = g;
      this.stemVolumes[name] = 1.0;
      this.stemMuted[name] = false;
      this.stemSolo[name]  = false;
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
    // A-B 구간 반복
    this._loopA = null;
    this._loopB = null;
    this._loopEnabled = false;
    this._onTimeUpdateL = () => {
      if (!this._loopEnabled) return;
      if (this._loopA == null || this._loopB == null) return;
      if (this._loopB <= this._loopA) return;
      // B에 도달하면 A로 seek (video seek → stem audios 자동 sync)
      if (v.currentTime >= this._loopB - 0.05) {
        v.currentTime = Math.max(0, this._loopA);
      }
    };

    this._onRateL   = () => {
      const r = v.playbackRate || 1;
      if (this.usePitchPreserve) {
        for (const a of Object.values(this.stemAudios)) {
          try { a.preservesPitch = true; a.playbackRate = r; } catch {}
        }
      } else {
        for (const src of Object.values(this.sources)) {
          try { src.playbackRate.setValueAtTime(r, this.audioCtx.currentTime); } catch {}
        }
      }
    };
    this._onVolL = () => {
      if (this.videoSource) {
        // MES 경유 라우팅 — video 자체는 반드시 unmuted 여야 원본 오디오가 그래프로 들어옴.
        // controls의 mute/volume 조작은 되돌림 (실제 볼륨은 origMixGain으로 제어)
        if (v.muted || v.volume < 1) { v.muted = false; v.volume = 1; }
      } else {
        // MES 실패 시 → 그래프로 못 잡음 → 안전하게 mute (double audio 방지)
        if (!v.muted || v.volume > 0) { v.muted = true; v.volume = 0; }
      }
    };
    v.addEventListener('play',         this._onPlayL);
    v.addEventListener('pause',        this._onPauseL);
    v.addEventListener('seeked',       this._onSeekedL);
    v.addEventListener('ended',        this._onEndedL);
    v.addEventListener('ratechange',   this._onRateL);
    v.addEventListener('volumechange', this._onVolL);
    v.addEventListener('timeupdate',   this._onTimeUpdateL);
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
    if (this._onTimeUpdateL) v.removeEventListener('timeupdate', this._onTimeUpdateL);
  }

  /** A-B 구간 반복 제어 */
  setLoopA(t)         { this._loopA = (t == null) ? null : Math.max(0, +t); }
  setLoopB(t)         { this._loopB = (t == null) ? null : Math.max(0, +t); }
  setLoopEnabled(v)   { this._loopEnabled = !!v; }
  getLoopState()      { return { a: this._loopA, b: this._loopB, enabled: this._loopEnabled }; }
  resetLoop()         { this._loopA = null; this._loopB = null; this._loopEnabled = false; }

  _startAll(offset) {
    const rate = this.videoEl.playbackRate || 1;
    if (this.usePitchPreserve) {
      // HTMLAudioElement 모드 — 배속 시 피치 유지
      let started = 0;
      for (const [name, audio] of Object.entries(this.stemAudios)) {
        try {
          audio.preservesPitch = true;
          audio.playbackRate = rate;
          audio.currentTime = Math.max(0, offset || 0);
          audio.play().catch(err => console.warn('[Player] audio.play', name, err.message));
          started++;
        } catch (e) { console.error('[Player] audio start failed', name, e); }
      }
      console.log(`[Player] started ${started} audio elements @ ${offset.toFixed(3)}s rate=${rate}`);
      return;
    }
    // BufferSource 폴백
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
    console.log('[Player] started sources:', started, 'offset:', offset);
  }

  _stopAll() {
    if (this.usePitchPreserve) {
      for (const audio of Object.values(this.stemAudios)) {
        try { audio.pause(); } catch {}
      }
      return;
    }
    for (const src of Object.values(this.sources)) {
      try { src.stop(); } catch {}
    }
    this.sources = {};
  }

  setMasterVolume(v) {
    this.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(2, v)), this.audioCtx.currentTime, 0.02);
  }

  /** 원본/스템 crossfade — 0 = 스템 only, 1 = 원본 only, 사이는 blend */
  setOriginalMix(v) {
    const mix = Math.max(0, Math.min(1, v));
    // 등파워 크로스페이드: stem = cos(mix·π/2), orig = sin(mix·π/2)
    const stemG = Math.cos(mix * Math.PI / 2);
    const origG = Math.sin(mix * Math.PI / 2);
    const t = this.audioCtx.currentTime;
    this.stemMixGain.gain.setTargetAtTime(stemG, t, 0.02);
    this.origMixGain.gain.setTargetAtTime(origG, t, 0.02);
  }

  /** 키 변경 — encoder-worker로 pitch shift 후 buffer 교체
   * @param {number} semitones -6..+6 정수
   * @param {Worker} encoderWorker — 사용자가 관리하는 encoder-worker 인스턴스
   */
  async setKeyShift(semitones, encoderWorker) {
    semitones = Math.max(-6, Math.min(6, Math.round(semitones)));
    if (semitones === this._currentKey) return;
    let newStems;
    if (semitones === 0) {
      newStems = {};
      for (const [n, [L, R]] of Object.entries(this.stemsOrig)) {
        newStems[n] = [new Float32Array(L), new Float32Array(R)];
      }
    } else {
      const SKIP = new Set(['drums']);   // 드럼은 피치 시 부자연스러움
      newStems = {};
      // Signalsmith Stretch 로 개별 스템 병렬 처리 (offline audio context 렌더링)
      const tasks = [];
      for (const [n, [L, R]] of Object.entries(this.stemsOrig)) {
        if (SKIP.has(n)) {
          newStems[n] = [new Float32Array(L), new Float32Array(R)];
          continue;
        }
        // 보컬만 formant 보존 (베이스·기타는 formant 개념 없음 → 처리 부담 절감)
        const formant = (n === 'vocals');
        tasks.push(
          pitchShiftStereo(L, R, this._sampleRate, semitones, { formantCompensation: formant })
            .then(({ L: nL, R: nR }) => { newStems[n] = [nL, nR]; })
        );
      }
      await Promise.all(tasks);
    }

    // 재생 중이면 잠시 정지 → 재시작
    const wasPlaying = this._playing;
    const seekTo = this.videoEl.currentTime;
    if (wasPlaying) this._stopAll();

    const sr = this._sampleRate;
    for (const [n, [L, R]] of Object.entries(newStems)) {
      // stemsCurrent 갱신 (export 등에 사용)
      this.stemsCurrent[n] = [new Float32Array(L), new Float32Array(R)];
      // AudioBuffer 갱신 (BufferSource 폴백 시 사용)
      const buf = this.audioCtx.createBuffer(2, L.length, sr);
      buf.copyToChannel(this.stemsCurrent[n][0], 0);
      buf.copyToChannel(this.stemsCurrent[n][1], 1);
      this.stemBuffers[n] = buf;

      // HTMLAudioElement 모드: WAV blob 인코딩 후 src 교체
      if (this.usePitchPreserve && this.stemAudios[n]) {
        const wavAB = encodeWavAB(this.stemsCurrent[n][0], this.stemsCurrent[n][1], sr);
        const blob  = new Blob([wavAB], { type: 'audio/wav' });
        const url   = URL.createObjectURL(blob);
        if (this._stemBlobUrls[n]) { try { URL.revokeObjectURL(this._stemBlobUrls[n]); } catch {} }
        this._stemBlobUrls[n] = url;
        const a = this.stemAudios[n];
        a.src = url;
        a.load();
      }
    }
    this._currentKey = semitones;
    if (wasPlaying) {
      this._startAll(seekTo);
      this._playStartCtxTime = this.audioCtx.currentTime;
      this._playStartOffset  = seekTo;
    }
  }

  /** Solo가 하나라도 켜져있으면 mute solo되지 않은 트랙. mute > solo 우선순위.
   *  @returns {number} 해당 stem의 실제 적용 gain 값 */
  _effectiveGainFor(name) {
    if (this.stemMuted[name]) return 0;
    const anySolo = Object.values(this.stemSolo || {}).some(Boolean);
    if (anySolo && !this.stemSolo[name]) return 0;
    return this.stemVolumes[name] ?? 1;
  }
  _applyEffectiveGain(name) {
    if (!this.stemGains[name]) return;
    const v = this._effectiveGainFor(name);
    this.stemGains[name].gain.setTargetAtTime(v, this.audioCtx.currentTime, 0.02);
  }
  _applyAllStemGains() {
    for (const name of Object.keys(this.stemGains)) this._applyEffectiveGain(name);
  }

  setStemVolume(name, v) {
    if (!this.stemGains[name]) return;
    this.stemVolumes[name] = Math.max(0, Math.min(2, v));
    this._applyEffectiveGain(name);
  }

  toggleMute(name) {
    if (!this.stemGains[name]) return this.stemMuted[name] || false;
    this.stemMuted[name] = !this.stemMuted[name];
    this._applyEffectiveGain(name);
    return this.stemMuted[name];
  }

  toggleSolo(name) {
    if (!this.stemGains[name]) return this.stemSolo[name] || false;
    this.stemSolo[name] = !this.stemSolo[name];
    // Solo 상태 변경은 모든 stem에 영향 (다른 stem들도 mute 여부 재계산)
    this._applyAllStemGains();
    return this.stemSolo[name];
  }

  isSolo(name)   { return !!(this.stemSolo && this.stemSolo[name]); }
  isAnySolo()    { return Object.values(this.stemSolo || {}).some(Boolean); }
  clearSolos()   {
    for (const n of Object.keys(this.stemSolo)) this.stemSolo[n] = false;
    this._applyAllStemGains();
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

  /** 현재 stemsCurrent (pitched 반영) Float32 [L,R]로 반환 (내보내기용) */
  getStemsForExport() {
    const out = {};
    for (const [name, [L, R]] of Object.entries(this.stemsCurrent)) {
      out[name] = [new Float32Array(L), new Float32Array(R)];
    }
    return { stems: out, sampleRate: this._sampleRate };
  }

  /** 현재 mixer 상태(볼륨/뮤트) 기반 가중치 반환 */
  getCurrentWeights() {
    const w = {};
    for (const name of Object.keys(this.stemBuffers)) {
      w[name] = this.stemMuted[name] ? 0 : this.stemVolumes[name];
    }
    return w;
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
    // stem audio 요소 정리
    for (const a of Object.values(this.stemAudios || {})) {
      try { a.pause(); a.removeAttribute('src'); a.load(); } catch {}
    }
    // blob URL 회수
    for (const u of Object.values(this._stemBlobUrls || {})) {
      try { URL.revokeObjectURL(u); } catch {}
    }
    // ctx는 재사용하기 위해 close하지 않음 (MediaElementSource 재바인딩 방지)
    try { this.stemMixGain?.disconnect(); } catch {}
    try { this.origMixGain?.disconnect(); } catch {}
    try { this.masterGain?.disconnect(); } catch {}
    for (const g of Object.values(this.stemGains)) { try { g.disconnect(); } catch {} }
    try { this.videoEl.pause(); this.videoEl.removeAttribute('src'); this.videoEl.load(); } catch {}
  }
}
