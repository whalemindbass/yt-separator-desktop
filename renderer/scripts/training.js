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

// ── 사이드바 도구 전환 ──
// 지금은 메트로놈 하나뿐이라 없어도 동작은 같지만, home-nav 와 같은 패턴으로 미리 잡아
// 둬서 다음 도구를 추가할 때 이 자리에 항목만 늘리면 되게 한다.
function showTool(name) {
  document.querySelectorAll('.training-nav-item[data-tool]').forEach(b =>
    b.classList.toggle('on', b.dataset.tool === name));
  document.querySelectorAll('.training-panel[data-tool]').forEach(p =>
    p.classList.toggle('on', p.dataset.tool === name));
  if (name !== 'metro-practice') pmStop();
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
}
