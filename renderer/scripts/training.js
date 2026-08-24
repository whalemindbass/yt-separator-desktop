'use strict';
// 트레이닝 뷰 — 곡·프로젝트·오디오 엔진(JUCE 사이드카)과 완전히 무관한 연습 도구 모음.
// 원래 스튜디오 도구창 안에 있던 연습 메트로놈을 여기로 옮겼다 — 순전히 연습만 하려는데
// DAW 엔진까지 켜야 닿을 수 있던 게 불필요한 무게였다. 새 도구를 추가할 자리이기도 하다.

import { t } from './i18n.js';

const $ = (id) => document.getElementById(id);

// ── 연습 메트로놈 ──
// 엔진 쪽 metro() 는 재생 중일 때만 울리고(playing 조건) 악센트·박자표 개념이 아예 없는
// 균일 클릭이라(engine/src/Main.cpp) 이 용도엔 못 쓴다 — 렌더러 자체 Web Audio 로 독립
// 스케줄링한다. look-ahead 패턴(짧은 간격으로 깨어나 앞으로 올 클릭들을 AudioContext 시간
// 으로 미리 예약)을 안 쓰고 클릭마다 setTimeout 하나씩 걸면 그 지연·지터가 쌓여 박자가
// 밀린다 — 그래서 25ms 마다 깨어나 앞으로 100ms 안의 클릭을 미리 예약해 둔다.
const PM_LOOKAHEAD_MS = 25;
const PM_SCHEDULE_AHEAD = 0.1;   // 초
let _pmCtx = null, _pmGain = null, _pmTimer = null;
let _pmNextTime = 0, _pmBeat = 0, _pmSub = 0, _pmPlaying = false;
let _pmBpm = Number(localStorage.getItem('yss:pmBpm')) || 120;
let _pmSig = Number(localStorage.getItem('yss:pmSig')) || 4;
let _pmSubdiv = Number(localStorage.getItem('yss:pmSubdiv')) || 1;
let _pmVol = Number(localStorage.getItem('yss:pmVol'));
if (!(_pmVol >= 0 && _pmVol <= 1)) _pmVol = 0.6;
let _pmTapTimes = [];

function pmEnsureCtx() {
  if (!_pmCtx) {
    _pmCtx = new (window.AudioContext || window.webkitAudioContext)();
    _pmGain = _pmCtx.createGain();
    _pmGain.gain.value = _pmVol;
    _pmGain.connect(_pmCtx.destination);
  }
  if (_pmCtx.state === 'suspended') _pmCtx.resume();
  return _pmCtx;
}
// 박 표시 새로 그리기 — 박자표·세분화 바뀔 때마다. 큰 점은 박(첫 박만 accent),
// 그 사이 작은 눈금은 세분화 중간 클릭 — 소리만으론 800Hz 클릭이 1000Hz 박과
// 헷갈리기 쉬워서 눈으로도 "지금 세분화가 실제로 더 들어가고 있다"를 보여준다.
function pmRenderBeats() {
  const box = $('pm-beats');
  if (!box) return;
  box.innerHTML = '';
  for (let i = 0; i < _pmSig; i++) {
    const d = document.createElement('span');
    d.className = 'pm-beat-dot' + (i === 0 ? ' accent' : '');
    d.dataset.beat = String(i);
    box.appendChild(d);
    for (let s = 1; s < _pmSubdiv; s++) {
      const tick = document.createElement('span');
      tick.className = 'pm-beat-tick';
      tick.dataset.beat = String(i);
      tick.dataset.sub = String(s);
      box.appendChild(tick);
    }
  }
}
// AudioContext 시간에 맞춰 예약된 클릭이 실제로 울릴 때 해당 표시를 짧게 밝힌다.
// setTimeout 이라 화면 표시는 오디오만큼 샘플-정확하진 않지만 눈으로 박자 따라가는
// 용도로는 충분하고, 클릭 스케줄링 자체(오디오)에는 영향을 주지 않는다.
function pmFlashEl(el, holdMs) {
  if (!el) return;
  el.classList.add('active');
  clearTimeout(el._pmFlashT);
  el._pmFlashT = setTimeout(() => el.classList.remove('active'), holdMs);
}
function pmFlashBeat(beatIdx, delayMs) {
  const hold = Math.min(140, (60000 / _pmBpm) * 0.6);
  setTimeout(() => pmFlashEl(document.querySelector(`#pm-beats .pm-beat-dot[data-beat="${beatIdx}"]`), hold), delayMs);
}
function pmFlashTick(beatIdx, subIdx, delayMs) {
  const hold = Math.min(90, (60000 / _pmBpm / _pmSubdiv) * 0.6);
  setTimeout(() => pmFlashEl(document.querySelector(`#pm-beats .pm-beat-tick[data-beat="${beatIdx}"][data-sub="${subIdx}"]`), hold), delayMs);
}
function pmClick(time, kind, beatIdx, subIdx) {
  // kind: 'accent'(강박) | 'beat'(보통 박) | 'sub'(세분화 중간 클릭 — 더 낮고 짧은 톤)
  const osc = _pmCtx.createOscillator();
  const g = _pmCtx.createGain();
  osc.frequency.value = kind === 'accent' ? 1500 : kind === 'beat' ? 1000 : 650;
  const peak = kind === 'sub' ? 0.4 : (kind === 'accent' ? 1 : 0.6);
  const decay = kind === 'sub' ? 0.025 : 0.05;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  osc.connect(g); g.connect(_pmGain);
  osc.start(time); osc.stop(time + 0.06);
  const delayMs = Math.max(0, (time - _pmCtx.currentTime) * 1000);
  if (kind === 'sub') pmFlashTick(beatIdx, subIdx, delayMs);
  else pmFlashBeat(beatIdx, delayMs);
}
function pmScheduler() {
  while (_pmNextTime < _pmCtx.currentTime + PM_SCHEDULE_AHEAD) {
    const isBeat = _pmSub === 0;
    const isAccent = isBeat && _pmBeat === 0;
    pmClick(_pmNextTime, isAccent ? 'accent' : isBeat ? 'beat' : 'sub', _pmBeat, _pmSub);
    _pmNextTime += (60 / _pmBpm) / _pmSubdiv;
    _pmSub = (_pmSub + 1) % _pmSubdiv;
    if (_pmSub === 0) _pmBeat = (_pmBeat + 1) % _pmSig;
  }
}
function pmStart() {
  if (_pmPlaying) return;
  pmEnsureCtx();
  _pmPlaying = true; _pmBeat = 0; _pmSub = 0;
  _pmNextTime = _pmCtx.currentTime + 0.05;
  _pmTimer = setInterval(pmScheduler, PM_LOOKAHEAD_MS);
  const btn = $('pm-playstop'); if (btn) { btn.classList.add('on'); btn.textContent = t('training.pm.stop'); }
}
function pmStop() {
  if (!_pmPlaying) return;
  _pmPlaying = false;
  clearInterval(_pmTimer); _pmTimer = null;
  document.querySelectorAll('#pm-beats .pm-beat-dot, #pm-beats .pm-beat-tick').forEach(d => {
    clearTimeout(d._pmFlashT); d.classList.remove('active');
  });
  const btn = $('pm-playstop'); if (btn) { btn.classList.remove('on'); btn.textContent = t('training.pm.start'); }
}
function pmSetBpm(v) {
  _pmBpm = Math.max(20, Math.min(300, Math.round(v)));
  localStorage.setItem('yss:pmBpm', String(_pmBpm));
  const el = $('pm-bpm'); if (el) el.value = _pmBpm;
}
function pmSetVol(v01) {
  _pmVol = Math.max(0, Math.min(1, v01));
  localStorage.setItem('yss:pmVol', String(_pmVol));
  if (_pmGain) _pmGain.gain.value = _pmVol;
}
function pmTap() {
  // 마지막 탭에서 2초 넘게 지나면(딴 데 갔다 온 것) 새로 센다. 최근 몇 번만 평균 내서
  // 손 떨림 한두 번에 확 튀지 않게 한다.
  const now = performance.now();
  if (_pmTapTimes.length && now - _pmTapTimes[_pmTapTimes.length - 1] > 2000) _pmTapTimes = [];
  _pmTapTimes.push(now);
  if (_pmTapTimes.length > 6) _pmTapTimes.shift();
  if (_pmTapTimes.length >= 2) {
    const gaps = [];
    for (let i = 1; i < _pmTapTimes.length; i++) gaps.push(_pmTapTimes[i] - _pmTapTimes[i - 1]);
    const avgMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    pmSetBpm(60000 / avgMs);
  }
}

// ── 드론 노트 ──
// 기준음을 계속 울려서 그 위에 맞춰 노래하거나 연주하는 연습용. 미디 노트 번호를 그대로
// idx 로 써서(A4=69, 440Hz 기준) 옥타브·음이름 계산이 표준 공식 그대로 나오게 한다.
const DRN_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DRN_MIN = 36, DRN_MAX = 96;   // C2 ~ C7
let _drnIdx = Number(localStorage.getItem('yss:drnNote'));
if (!(_drnIdx >= DRN_MIN && _drnIdx <= DRN_MAX)) _drnIdx = 69;   // A4
let _drnWave = localStorage.getItem('yss:drnWave') || 'sine';
let _drnVol = Number(localStorage.getItem('yss:drnVol'));
if (!(_drnVol >= 0 && _drnVol <= 1)) _drnVol = 0.5;
let _drnCtx = null, _drnGain = null, _drnOsc1 = null, _drnOsc2 = null, _drnPlaying = false;

function drnFreq(idx) { return 440 * Math.pow(2, (idx - 69) / 12); }
function drnLabel(idx) { return DRN_NOTE_NAMES[((idx % 12) + 12) % 12] + (Math.floor(idx / 12) - 1); }
function drnEnsureCtx() {
  if (!_drnCtx) {
    _drnCtx = new (window.AudioContext || window.webkitAudioContext)();
    _drnGain = _drnCtx.createGain();
    _drnGain.gain.value = 0;
    _drnGain.connect(_drnCtx.destination);
  }
  if (_drnCtx.state === 'suspended') _drnCtx.resume();
  return _drnCtx;
}
function drnUpdateDisplay() {
  const el = $('drn-note'); if (el) el.textContent = drnLabel(_drnIdx);
}
function drnRetune() {
  if (!_drnPlaying) return;
  const f = drnFreq(_drnIdx);
  const now = _drnCtx.currentTime;
  _drnOsc1.frequency.setTargetAtTime(f, now, 0.05);
  _drnOsc2.frequency.setTargetAtTime(f * Math.pow(2, 6 / 1200), now, 0.05);   // 6센트 detune — 순수 사인 하나보단 덜 인공적
}
function drnStart() {
  if (_drnPlaying) return;
  drnEnsureCtx();
  _drnPlaying = true;
  const f = drnFreq(_drnIdx);
  _drnOsc1 = _drnCtx.createOscillator(); _drnOsc1.type = _drnWave; _drnOsc1.frequency.value = f;
  _drnOsc2 = _drnCtx.createOscillator(); _drnOsc2.type = _drnWave; _drnOsc2.frequency.value = f * Math.pow(2, 6 / 1200);
  _drnOsc1.connect(_drnGain); _drnOsc2.connect(_drnGain);
  _drnOsc1.start(); _drnOsc2.start();
  const now = _drnCtx.currentTime;
  _drnGain.gain.cancelScheduledValues(now);
  _drnGain.gain.setValueAtTime(0, now);
  _drnGain.gain.linearRampToValueAtTime(_drnVol, now + 0.15);   // 클릭음 없이 서서히 켜짐
  const btn = $('drn-playstop'); if (btn) { btn.classList.add('on'); btn.textContent = t('training.drn.stop'); }
}
function drnStop() {
  if (!_drnPlaying) return;
  _drnPlaying = false;
  const now = _drnCtx.currentTime;
  _drnGain.gain.cancelScheduledValues(now);
  _drnGain.gain.setValueAtTime(_drnGain.gain.value, now);
  _drnGain.gain.linearRampToValueAtTime(0, now + 0.12);
  const osc1 = _drnOsc1, osc2 = _drnOsc2;
  setTimeout(() => { osc1.stop(); osc2.stop(); }, 150);
  const btn = $('drn-playstop'); if (btn) { btn.classList.remove('on'); btn.textContent = t('training.drn.start'); }
}
function drnSetIdx(v) {
  _drnIdx = Math.max(DRN_MIN, Math.min(DRN_MAX, v));
  localStorage.setItem('yss:drnNote', String(_drnIdx));
  drnUpdateDisplay();
  drnRetune();
}
function drnSetVol(v01) {
  _drnVol = Math.max(0, Math.min(1, v01));
  localStorage.setItem('yss:drnVol', String(_drnVol));
  if (_drnPlaying) _drnGain.gain.setTargetAtTime(_drnVol, _drnCtx.currentTime, 0.05);
}
function drnSetWave(w) {
  _drnWave = w;
  localStorage.setItem('yss:drnWave', w);
  if (_drnPlaying) { _drnOsc1.type = w; _drnOsc2.type = w; }
}

// ── 튜너 ──
// 스튜디오 쪽 튜너는 엔진(JUCE, ASIO)이 분석해서 IPC 로 pitch 이벤트를 보내주는 방식이라
// 여기선 못 쓴다 — 렌더러가 직접 마이크를 잡아(getUserMedia) 자기상관(autocorrelation)으로
// 기본 주파수를 뽑는다. 노트/센트 계산과 바늘 보간은 스튜디오 튜너와 같은 공식을 쓴다
// (studio.js updateTuner/tunerRAF 참고) — 같은 악기를 스튜디오에서 재던 트레이닝에서 재던
// 눈금이 똑같이 읽혀야 하니까.
let _tunCtx = null, _tunStream = null, _tunAnalyser = null, _tunBuf = null;
let _tunTimer = null, _tunRAF = null, _tunActive = false;
let _tunRef = Number(localStorage.getItem('yss:tunerRef')) || 440;
let _tunNeedle = 50, _tunTarget = 50, _tunSmoothBuf = [], _tunLastHit = 0;

// 표준 자기상관 피치 검출 — 무음 구간을 앞뒤로 잘라내고(r1~r2) 자기상관 최댓값 위치를
// 포물선 보간으로 다듬어 정수 샘플 단위보다 더 정확한 주기(T0)를 구한다.
function tunAutoCorrelate(buf, sampleRate) {
  const SIZE = buf.length;
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1;

  let r1 = 0, r2 = SIZE - 1;
  const thres = 0.2;
  for (let i = 0; i < SIZE >> 1; i++) if (Math.abs(buf[i]) < thres) { r1 = i; break; }
  for (let i = 1; i < SIZE >> 1; i++) if (Math.abs(buf[SIZE - i]) < thres) { r2 = SIZE - i; break; }
  const trimmed = buf.slice(r1, r2);
  const n = trimmed.length;
  if (n < 8) return -1;

  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < n - i; j++) sum += trimmed[j] * trimmed[j + i];
    c[i] = sum;
  }
  let d = 0;
  while (d < n - 1 && c[d] > c[d + 1]) d++;
  let maxVal = -1, maxPos = -1;
  for (let i = d; i < n; i++) if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
  if (maxPos <= 0) return -1;
  let T0 = maxPos;
  const x1 = c[T0 - 1] || 0, x2 = c[T0], x3 = c[T0 + 1] || 0;
  const a = (x1 + x3 - 2 * x2) / 2, b = (x3 - x1) / 2;
  if (a) T0 -= b / (2 * a);
  return T0 > 0 ? sampleRate / T0 : -1;
}
function tunRAFStep() {
  const needle = $('trn-tuner-needle');
  if (needle) {
    const d = _tunTarget - _tunNeedle;
    _tunNeedle += d * 0.22;
    if (Math.abs(d) < 0.05) _tunNeedle = _tunTarget;
    needle.style.transform = `translateX(-50%) translateX(${((_tunNeedle - 50) * 0.01) * (needle.parentElement?.clientWidth || 200)}px)`;
  }
  _tunRAF = requestAnimationFrame(tunRAFStep);
}
function tunUpdateUI(freq) {
  const noteEl = $('trn-tuner-note'), needle = $('trn-tuner-needle'), centsEl = $('trn-tuner-cents');
  if (!noteEl) return;
  const octEl = $('trn-tuner-oct'), freqEl = $('trn-tuner-freq'), flat = $('trn-tuner-flat'), sharp = $('trn-tuner-sharp');
  const card = $('tool-trn-tuner');
  if (!freq || freq < 25) {
    _tunSmoothBuf.length = 0;
    if (Date.now() - _tunLastHit > 900) {
      noteEl.textContent = '—'; if (octEl) octEl.textContent = ''; centsEl.textContent = '—'; if (freqEl) freqEl.textContent = '';
      flat && flat.classList.remove('on'); sharp && sharp.classList.remove('on');
      card && card.classList.remove('in-tune');
      needle && needle.classList.remove('in-tune');
      _tunTarget = 50;
    }
    return;
  }
  _tunLastHit = Date.now();
  _tunSmoothBuf.push(freq); if (_tunSmoothBuf.length > 5) _tunSmoothBuf.shift();
  const sorted = [..._tunSmoothBuf].sort((a, b) => a - b);
  const f = sorted[sorted.length >> 1];

  const n = 69 + 12 * Math.log2(f / _tunRef);
  const nearest = Math.round(n);
  const cents = (n - nearest) * 100;
  const name = DRN_NOTE_NAMES[((nearest % 12) + 12) % 12];
  const oct = Math.floor(nearest / 12) - 1;
  noteEl.textContent = name;
  if (octEl) octEl.textContent = oct;
  const inTune = Math.abs(cents) <= 4;
  noteEl.classList.toggle('in-tune', inTune);
  card && card.classList.toggle('in-tune', inTune);
  centsEl.textContent = (cents > 0 ? '+' : '') + cents.toFixed(0) + '¢';
  if (freqEl) freqEl.textContent = f.toFixed(1) + ' Hz';
  flat && flat.classList.toggle('on', cents < -4);
  sharp && sharp.classList.toggle('on', cents > 4);
  needle.classList.toggle('in-tune', inTune);
  _tunTarget = Math.max(0, Math.min(100, 50 + cents));
}
function tunSetRef(hz) {
  _tunRef = hz; localStorage.setItem('yss:tunerRef', String(hz));
  document.querySelectorAll('#trn-tuner-ref button').forEach(b => b.classList.toggle('on', Number(b.dataset.hz) === hz));
  _tunSmoothBuf.length = 0;
}
async function tunStart() {
  if (_tunActive) return;
  const btn = $('trn-tuner-toggle');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch {
    if (btn) btn.textContent = t('training.tun.denied');
    return;
  }
  _tunStream = stream;
  _tunCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = _tunCtx.createMediaStreamSource(_tunStream);
  _tunAnalyser = _tunCtx.createAnalyser();
  _tunAnalyser.fftSize = 2048;
  _tunBuf = new Float32Array(_tunAnalyser.fftSize);
  src.connect(_tunAnalyser);
  _tunActive = true;
  _tunTimer = setInterval(() => {
    _tunAnalyser.getFloatTimeDomainData(_tunBuf);
    tunUpdateUI(tunAutoCorrelate(_tunBuf, _tunCtx.sampleRate));
  }, 50);
  _tunRAF = requestAnimationFrame(tunRAFStep);
  if (btn) { btn.classList.add('on'); btn.textContent = t('training.tun.stop'); }
}
function tunStop() {
  if (!_tunActive) return;
  _tunActive = false;
  clearInterval(_tunTimer); _tunTimer = null;
  if (_tunRAF) cancelAnimationFrame(_tunRAF); _tunRAF = null;
  _tunStream?.getTracks().forEach(tr => tr.stop()); _tunStream = null;
  _tunCtx?.close(); _tunCtx = null;
  const noteEl = $('trn-tuner-note'), octEl = $('trn-tuner-oct'), centsEl = $('trn-tuner-cents'), freqEl = $('trn-tuner-freq');
  if (noteEl) noteEl.textContent = '—';
  if (octEl) octEl.textContent = '';
  if (centsEl) centsEl.textContent = '—';
  if (freqEl) freqEl.textContent = '';
  $('tool-trn-tuner')?.classList.remove('in-tune');
  $('trn-tuner-needle')?.classList.remove('in-tune');
  _tunTarget = 50; _tunNeedle = 50;
  const needle = $('trn-tuner-needle'); if (needle) needle.style.transform = 'translateX(-50%) translateX(0px)';
  const btn = $('trn-tuner-toggle'); if (btn) { btn.classList.remove('on'); btn.textContent = t('training.tun.start'); }
}

// ── BPM 트레이너 ──
// 정해진 마디 수마다 템포가 자동으로 조금씩 빨라지는 연습 모드. 메트로놈과 같은 look-ahead
// 스케줄러 패턴(PM_LOOKAHEAD_MS/PM_SCHEDULE_AHEAD 재사용)을 별도 상태로 하나 더 돌린다 —
// 이 도구는 박자표를 고정 4/4 로만 쓰므로 pmScheduler 를 그대로 재사용하기보다
// 템포 램프 로직이 섞이지 않게 독립적으로 둔다.
const BT_SIG = 4;
let _btStart = Number(localStorage.getItem('yss:btStart')) || 80;
let _btTarget = Number(localStorage.getItem('yss:btTarget')) || 140;
let _btStep = Number(localStorage.getItem('yss:btStep')) || 2;
let _btEvery = Number(localStorage.getItem('yss:btEvery')) || 2;
let _btVol = Number(localStorage.getItem('yss:btVol'));
if (!(_btVol >= 0 && _btVol <= 1)) _btVol = 0.6;
let _btCurBpm = _btStart, _btMeasureCount = 0, _btBeat = 0, _btPlaying = false;
let _btCtx = null, _btGain = null, _btTimer = null, _btNextTime = 0;

function btRenderBeats() {
  const box = $('bt-beats');
  if (!box) return;
  box.innerHTML = '';
  for (let i = 0; i < BT_SIG; i++) {
    const d = document.createElement('span');
    d.className = 'pm-beat-dot' + (i === 0 ? ' accent' : '');
    d.dataset.beat = String(i);
    box.appendChild(d);
  }
}
function btFlashBeat(beatIdx, delayMs) {
  const hold = Math.min(140, (60000 / _btCurBpm) * 0.6);
  setTimeout(() => {
    const dot = document.querySelector(`#bt-beats .pm-beat-dot[data-beat="${beatIdx}"]`);
    if (!dot) return;
    dot.classList.add('active');
    clearTimeout(dot._btFlashT);
    dot._btFlashT = setTimeout(() => dot.classList.remove('active'), hold);
  }, delayMs);
}
function btUpdateBpmDisplay() {
  const el = $('bt-bpm-now'); if (el) el.textContent = _btCurBpm;
}
function btClick(time, isDownbeat, beatIdx) {
  const osc = _btCtx.createOscillator();
  const g = _btCtx.createGain();
  osc.frequency.value = isDownbeat ? 1500 : 1000;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(isDownbeat ? 1 : 0.6, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(g); g.connect(_btGain);
  osc.start(time); osc.stop(time + 0.06);
  btFlashBeat(beatIdx, Math.max(0, (time - _btCtx.currentTime) * 1000));
}
function btScheduler() {
  while (_btNextTime < _btCtx.currentTime + PM_SCHEDULE_AHEAD) {
    btClick(_btNextTime, _btBeat === 0, _btBeat);
    _btNextTime += 60 / _btCurBpm;
    _btBeat = (_btBeat + 1) % BT_SIG;
    if (_btBeat === 0) {
      _btMeasureCount++;
      if (_btMeasureCount % _btEvery === 0 && _btCurBpm < _btTarget) {
        _btCurBpm = Math.min(_btTarget, _btCurBpm + _btStep);
        btUpdateBpmDisplay();
      }
    }
  }
}
function btReadInputs() {
  _btStart = Math.max(20, Math.min(300, Number($('bt-start')?.value) || 80));
  _btTarget = Math.max(_btStart, Math.min(300, Number($('bt-target')?.value) || 140));
  _btStep = Number($('bt-step')?.value) || 2;
  _btEvery = Number($('bt-every')?.value) || 2;
  localStorage.setItem('yss:btStart', String(_btStart));
  localStorage.setItem('yss:btTarget', String(_btTarget));
  localStorage.setItem('yss:btStep', String(_btStep));
  localStorage.setItem('yss:btEvery', String(_btEvery));
}
function btSetVol(v01) {
  _btVol = Math.max(0, Math.min(1, v01));
  localStorage.setItem('yss:btVol', String(_btVol));
  if (_btGain) _btGain.gain.value = _btVol;
}
function btStart() {
  if (_btPlaying) return;
  btReadInputs();
  if (!_btCtx) {
    _btCtx = new (window.AudioContext || window.webkitAudioContext)();
    _btGain = _btCtx.createGain();
    _btGain.gain.value = _btVol;
    _btGain.connect(_btCtx.destination);
  }
  if (_btCtx.state === 'suspended') _btCtx.resume();
  _btPlaying = true;
  _btCurBpm = _btStart; _btMeasureCount = 0; _btBeat = 0;
  btUpdateBpmDisplay();
  _btNextTime = _btCtx.currentTime + 0.05;
  _btTimer = setInterval(btScheduler, PM_LOOKAHEAD_MS);
  const btn = $('bt-playstop'); if (btn) { btn.classList.add('on'); btn.textContent = t('training.pm.stop'); }
}
function btStop() {
  if (!_btPlaying) return;
  _btPlaying = false;
  clearInterval(_btTimer); _btTimer = null;
  document.querySelectorAll('#bt-beats .pm-beat-dot').forEach(d => {
    clearTimeout(d._btFlashT); d.classList.remove('active');
  });
  const btn = $('bt-playstop'); if (btn) { btn.classList.remove('on'); btn.textContent = t('training.pm.start'); }
}

// ── 이어트레이닝 ──
// 음정(interval) 듣고 맞히기. 표본 음원 없이 오실레이터로 근음 + 반음수만큼 위 음을
// 순서대로(멜로딕) 울린다. 정답을 12개 버튼 객관식으로 다 늘어놔서, 맞히지 못해도
// 정답 버튼이 초록으로 밝혀지며 "이게 그 음정이었구나"를 매 문제마다 익히게 한다.
let _etCtx = null, _etGain = null;
let _etRootMidi = 60, _etIntervalSt = 7, _etStreak = 0, _etAnswered = false;

function etEnsureCtx() {
  if (!_etCtx) {
    _etCtx = new (window.AudioContext || window.webkitAudioContext)();
    _etGain = _etCtx.createGain();
    _etGain.gain.value = 0.5;
    _etGain.connect(_etCtx.destination);
  }
  if (_etCtx.state === 'suspended') _etCtx.resume();
}
function etPlayNote(midi, time, dur) {
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = _etCtx.createOscillator();
  const g = _etCtx.createGain();
  osc.type = 'sine'; osc.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(1, time + 0.02);
  g.gain.setValueAtTime(1, time + dur - 0.08);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  osc.connect(g); g.connect(_etGain);
  osc.start(time); osc.stop(time + dur + 0.02);
}
function etPlayQuestion() {
  etEnsureCtx();
  const now = _etCtx.currentTime + 0.05;
  etPlayNote(_etRootMidi, now, 0.45);
  etPlayNote(_etRootMidi + _etIntervalSt, now + 0.55, 0.45);
}
function etUpdateStreak() {
  const el = $('et-streak'); if (el) el.textContent = t('training.et.streak') + ' ' + _etStreak;
}
function etNewQuestion(playNow) {
  _etRootMidi = 55 + Math.floor(Math.random() * 18);   // G3~D5 근처 — 너무 낮거나 높지 않게
  _etIntervalSt = 1 + Math.floor(Math.random() * 12);
  _etAnswered = false;
  const fb = $('et-feedback'); if (fb) { fb.textContent = ''; fb.className = 'et-feedback'; }
  document.querySelectorAll('.et-choice').forEach(b => { b.disabled = false; b.classList.remove('correct', 'wrong'); });
  if (playNow) etPlayQuestion();
}
function etAnswer(st) {
  if (_etAnswered) return;
  _etAnswered = true;
  const correct = st === _etIntervalSt;
  _etStreak = correct ? _etStreak + 1 : 0;
  etUpdateStreak();
  const fb = $('et-feedback');
  if (fb) { fb.textContent = t(correct ? 'training.et.correct' : 'training.et.wrong'); fb.className = 'et-feedback ' + (correct ? 'ok' : 'bad'); }
  document.querySelectorAll('.et-choice').forEach(b => {
    b.disabled = true;
    const bst = Number(b.dataset.st);
    if (bst === _etIntervalSt) b.classList.add('correct');
    else if (bst === st) b.classList.add('wrong');
  });
}
function etStop() {
  _etCtx?.close(); _etCtx = null; _etGain = null;
}

// ── 사이드바 도구 전환 ──
// home-nav 와 같은 패턴 — 다음 도구를 추가할 때 이 자리에 항목만 늘리면 되게 한다.
// 재생 중인 도구를 벗어나면 그 도구의 소리부터 끈다(동시에 두 도구가 울리면 안 되니까).
function showTool(name) {
  document.querySelectorAll('.training-nav-item[data-tool]').forEach(b =>
    b.classList.toggle('on', b.dataset.tool === name));
  document.querySelectorAll('.training-panel[data-tool]').forEach(p =>
    p.classList.toggle('on', p.dataset.tool === name));
  if (name !== 'metro-practice') pmStop();
  if (name !== 'drone') drnStop();
  if (name !== 'ear-training') etStop();
  if (name !== 'tuner') tunStop();
  if (name !== 'bpm-trainer') btStop();
}

let _booted = false;
export function initTraining() {
  if (_booted) return;
  _booted = true;

  document.querySelector('.training-nav')?.addEventListener('click', (e) => {
    const nav = e.target.closest('.training-nav-item[data-tool]');
    if (nav) showTool(nav.dataset.tool);
  });

  const pmBpmEl = $('pm-bpm'), pmSigEl = $('pm-sig'), pmSubdivEl = $('pm-subdiv'), pmVolEl = $('pm-vol');
  if (pmBpmEl) pmBpmEl.value = _pmBpm;
  if (pmSigEl) pmSigEl.value = String(_pmSig);
  if (pmSubdivEl) pmSubdivEl.value = String(_pmSubdiv);
  if (pmVolEl) pmVolEl.value = String(Math.round(_pmVol * 100));
  pmRenderBeats();
  pmBpmEl?.addEventListener('change', () => pmSetBpm(Number(pmBpmEl.value) || 120));
  $('pm-bpm-dn5')?.addEventListener('click', () => pmSetBpm(_pmBpm - 5));
  $('pm-bpm-dn1')?.addEventListener('click', () => pmSetBpm(_pmBpm - 1));
  $('pm-bpm-up1')?.addEventListener('click', () => pmSetBpm(_pmBpm + 1));
  $('pm-bpm-up5')?.addEventListener('click', () => pmSetBpm(_pmBpm + 5));
  pmSigEl?.addEventListener('change', () => {
    _pmSig = Number(pmSigEl.value) || 4;
    localStorage.setItem('yss:pmSig', String(_pmSig));
    _pmBeat = 0;
    pmRenderBeats();
  });
  pmSubdivEl?.addEventListener('change', () => {
    _pmSubdiv = Number(pmSubdivEl.value) || 1;
    localStorage.setItem('yss:pmSubdiv', String(_pmSubdiv));
    _pmSub = 0;
    pmRenderBeats();
  });
  pmVolEl?.addEventListener('input', () => pmSetVol(Number(pmVolEl.value) / 100));
  $('pm-tap')?.addEventListener('click', pmTap);
  $('pm-playstop')?.addEventListener('click', () => { if (_pmPlaying) pmStop(); else pmStart(); });

  const drnWaveEl = $('drn-wave'), drnVolEl = $('drn-vol');
  drnUpdateDisplay();
  if (drnWaveEl) drnWaveEl.value = _drnWave;
  if (drnVolEl) drnVolEl.value = String(Math.round(_drnVol * 100));
  $('drn-dn')?.addEventListener('click', () => drnSetIdx(_drnIdx - 1));
  $('drn-up')?.addEventListener('click', () => drnSetIdx(_drnIdx + 1));
  drnWaveEl?.addEventListener('change', () => drnSetWave(drnWaveEl.value));
  drnVolEl?.addEventListener('input', () => drnSetVol(Number(drnVolEl.value) / 100));
  $('drn-playstop')?.addEventListener('click', () => { if (_drnPlaying) drnStop(); else drnStart(); });

  const tunRefBox = $('trn-tuner-ref');
  if (tunRefBox) {
    tunRefBox.querySelectorAll('button').forEach(b => b.addEventListener('click', () => tunSetRef(Number(b.dataset.hz))));
    tunSetRef(_tunRef);
  }
  $('trn-tuner-toggle')?.addEventListener('click', () => { if (_tunActive) tunStop(); else tunStart(); });

  const btStartEl = $('bt-start'), btTargetEl = $('bt-target'), btStepEl = $('bt-step'), btEveryEl = $('bt-every'), btVolEl = $('bt-vol');
  if (btStartEl) btStartEl.value = _btStart;
  if (btTargetEl) btTargetEl.value = _btTarget;
  if (btStepEl) btStepEl.value = String(_btStep);
  if (btEveryEl) btEveryEl.value = String(_btEvery);
  if (btVolEl) btVolEl.value = String(Math.round(_btVol * 100));
  btUpdateBpmDisplay();
  btRenderBeats();
  btVolEl?.addEventListener('input', () => btSetVol(Number(btVolEl.value) / 100));
  $('bt-playstop')?.addEventListener('click', () => { if (_btPlaying) btStop(); else btStart(); });

  etUpdateStreak();
  etNewQuestion(false);
  $('et-replay')?.addEventListener('click', () => etPlayQuestion());
  $('et-next')?.addEventListener('click', () => etNewQuestion(true));
  document.getElementById('et-choices')?.addEventListener('click', (e) => {
    const b = e.target.closest('.et-choice');
    if (b) etAnswer(Number(b.dataset.st));
  });
}
