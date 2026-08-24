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
let _pmNextTime = 0, _pmBeat = 0, _pmPlaying = false;
let _pmBpm = Number(localStorage.getItem('yss:pmBpm')) || 120;
let _pmSig = Number(localStorage.getItem('yss:pmSig')) || 4;
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
function pmClick(time, accent) {
  const osc = _pmCtx.createOscillator();
  const g = _pmCtx.createGain();
  osc.frequency.value = accent ? 1500 : 1000;   // 1박(다운비트)만 더 높은 음
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 1 : 0.6, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(g); g.connect(_pmGain);
  osc.start(time); osc.stop(time + 0.06);
}
function pmScheduler() {
  while (_pmNextTime < _pmCtx.currentTime + PM_SCHEDULE_AHEAD) {
    pmClick(_pmNextTime, _pmBeat === 0);
    _pmNextTime += 60 / _pmBpm;
    _pmBeat = (_pmBeat + 1) % _pmSig;
  }
}
function pmStart() {
  if (_pmPlaying) return;
  pmEnsureCtx();
  _pmPlaying = true; _pmBeat = 0;
  _pmNextTime = _pmCtx.currentTime + 0.05;
  _pmTimer = setInterval(pmScheduler, PM_LOOKAHEAD_MS);
  const btn = $('pm-playstop'); if (btn) { btn.classList.add('on'); btn.textContent = t('training.pm.stop'); }
}
function pmStop() {
  if (!_pmPlaying) return;
  _pmPlaying = false;
  clearInterval(_pmTimer); _pmTimer = null;
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

  const pmBpmEl = $('pm-bpm'), pmSigEl = $('pm-sig'), pmVolEl = $('pm-vol');
  if (pmBpmEl) pmBpmEl.value = _pmBpm;
  if (pmSigEl) pmSigEl.value = String(_pmSig);
  if (pmVolEl) pmVolEl.value = String(Math.round(_pmVol * 100));
  pmBpmEl?.addEventListener('change', () => pmSetBpm(Number(pmBpmEl.value) || 120));
  $('pm-bpm-dn5')?.addEventListener('click', () => pmSetBpm(_pmBpm - 5));
  $('pm-bpm-dn1')?.addEventListener('click', () => pmSetBpm(_pmBpm - 1));
  $('pm-bpm-up1')?.addEventListener('click', () => pmSetBpm(_pmBpm + 1));
  $('pm-bpm-up5')?.addEventListener('click', () => pmSetBpm(_pmBpm + 5));
  pmSigEl?.addEventListener('change', () => { _pmSig = Number(pmSigEl.value) || 4; localStorage.setItem('yss:pmSig', String(_pmSig)); _pmBeat = 0; });
  pmVolEl?.addEventListener('input', () => pmSetVol(Number(pmVolEl.value) / 100));
  $('pm-tap')?.addEventListener('click', pmTap);
  $('pm-playstop')?.addEventListener('click', () => { if (_pmPlaying) pmStop(); else pmStart(); });
}
