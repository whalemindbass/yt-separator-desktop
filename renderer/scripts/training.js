'use strict';
// 트레이닝 뷰 — 곡·프로젝트와 무관한 연습 도구 모음. 원래 스튜디오 도구창 안에 있던
// 연습 메트로놈을 여기로 옮겼다 — 순전히 연습만 하려는데 DAW 엔진까지 켜야 닿을 수
// 있던 게 불필요한 무게였다. 새 도구를 추가할 자리이기도 하다.
// (튜너만 예외 — 엔진의 ASIO pitch 분석을 그대로 쓰므로 엔진이 켜져 있어야 한다.)

import { t, getLocale } from './i18n.js';

const $ = (id) => document.getElementById(id);
const api = window.yssApi;

// ── 연습 기록 ──
// app.js 가 뷰별 체류 시간을 날짜별·카테고리별로 localStorage(yss:usageLog) 에 이미
// 누적해 둔다(집계 로직은 거기 하나뿐) — 여기서는 그 값을 읽어 달력만 그린다.
// 칸 하나하나가 애플워치 활동 링처럼 그날 일일 목표 대비 진행률을 카테고리별 색으로
// 나눈 도넛으로 보여준다(목표를 채우면 가득 참). 칸을 고르면 아래 상세에서 카테고리별
// 막대·분(分)을 숫자로도 보여준다 — 링만으론 정확한 분 단위까지는 못 읽으니까.
const LOG_CAT_COLORS = { studio: 'var(--accent)', library: '#4f8fd1', training: '#d98e42' };
let _logYear = 0, _logMonth = 0;   // 0-indexed month
let _logDailyGoalMin = 30, _logMonthlyGoalMin = 600;   // 기본값 — 목표를 아직 안 정했어도 뭔가는 보여준다
function logDateKey(y, m, d) {
  return y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function logLoad() {
  try { return JSON.parse(localStorage.getItem('yss:usageLog') || '{}'); } catch { return {}; }
}
function logLoadGoals() {
  try {
    const g = JSON.parse(localStorage.getItem('yss:usageGoals') || '{}');
    if (Number.isFinite(g.dailyMin) && g.dailyMin >= 0) _logDailyGoalMin = g.dailyMin;
    if (Number.isFinite(g.monthlyMin) && g.monthlyMin >= 0) _logMonthlyGoalMin = g.monthlyMin;
  } catch { /* 기본값 유지 */ }
}
function logSaveGoals() {
  localStorage.setItem('yss:usageGoals', JSON.stringify({ dailyMin: _logDailyGoalMin, monthlyMin: _logMonthlyGoalMin }));
}
function logIntlLocale() { return getLocale() === 'en' ? 'en-US' : 'ko-KR'; }
function logWeekdayLabels() {
  const fmt = new Intl.DateTimeFormat(logIntlLocale(), { weekday: 'short' });
  const labels = [];
  for (let i = 0; i < 7; i++) labels.push(fmt.format(new Date(2023, 0, 1 + i)));   // 2023-01-01 은 일요일
  return labels;
}
function logMonthLabel(y, m) {
  return new Intl.DateTimeFormat(logIntlLocale(), { year: 'numeric', month: 'long' }).format(new Date(y, m, 1));
}
function logMinutes(sec) { return Math.round((sec || 0) / 60); }
// 애플워치 활동 링 — 배경 원 하나 위에 카테고리별 호(arc)를 이어 그린다. 목표를 다 채우면
// (분 합 ≥ 일일 목표) 링이 완전히 닫히고, 못 채웠으면 그만큼만 채워지고 나머지는 배경색.
// 목표를 넘긴 카테고리 비율은 유지한 채로 전체를 1(=한 바퀴)에 맞게 눌러 담는다 — 그래야
// 목표 초과일도 "가득 찬 링" 하나로 보이지, 링이 두 바퀴 겹쳐 지저분해지지 않는다.
function logRingHTML(rec) {
  const r = 24, cx = 28, cy = 28, sw = 5.5;
  const C = 2 * Math.PI * r;
  const goalSec = _logDailyGoalMin * 60;
  const cats = ['studio', 'library', 'training'];
  const vals = cats.map(c => rec[c] || 0);
  const fracs = goalSec > 0 ? vals.map(v => v / goalSec) : [0, 0, 0];
  const sum = fracs.reduce((a, b) => a + b, 0);
  const scaled = sum > 1 ? fracs.map(f => f / sum) : fracs;
  let acc = 0;
  const arcs = cats.map((c, i) => {
    const f = Math.max(0, scaled[i]);
    const dash = `${(f * C).toFixed(2)} ${(C - f * C).toFixed(2)}`;
    const offset = (-acc * C).toFixed(2);
    acc += f;
    if (f <= 0) return '';
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${LOG_CAT_COLORS[c]}" stroke-width="${sw}" stroke-dasharray="${dash}" stroke-dashoffset="${offset}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})"/>`;
  }).join('');
  return `<svg class="log-ring" viewBox="0 0 56 56" aria-hidden="true">` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--elev-2)" stroke-width="${sw}"/>` +
    arcs + `</svg>`;
}
function logShowDetail(dateKey) {
  const log = logLoad();
  const rec = log[dateKey] || {};
  const dateEl = $('log-detail-date'); if (dateEl) dateEl.textContent = dateKey;
  const s = rec.studio || 0, li = rec.library || 0, tr = rec.training || 0;
  const total = s + li + tr;
  $('log-detail-studio').textContent = total ? logMinutes(s) + t('training.log.min') : t('training.log.none');
  $('log-detail-library').textContent = total ? logMinutes(li) + t('training.log.min') : '';
  $('log-detail-training').textContent = total ? logMinutes(tr) + t('training.log.min') : '';
  const bar = $('log-detail-bar');
  if (bar) {
    bar.innerHTML = total
      ? `<span class="seg seg-studio" style="width:${s / total * 100}%"></span>` +
        `<span class="seg seg-library" style="width:${li / total * 100}%"></span>` +
        `<span class="seg seg-training" style="width:${tr / total * 100}%"></span>`
      : '';
  }
}
function logRenderMonthProgress() {
  const daysInMonth = new Date(_logYear, _logMonth + 1, 0).getDate();
  const log = logLoad();
  let totalSec = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const rec = log[logDateKey(_logYear, _logMonth, d)];
    if (rec) totalSec += (rec.studio || 0) + (rec.library || 0) + (rec.training || 0);
  }
  const doneMin = logMinutes(totalSec);
  const label = $('log-month-progress-label');
  if (label) label.textContent = t('training.log.monthProgress', { done: doneMin, goal: _logMonthlyGoalMin });
  const fill = $('log-month-progress-fill');
  if (fill) fill.style.width = (_logMonthlyGoalMin > 0 ? Math.min(100, doneMin / _logMonthlyGoalMin * 100) : 0) + '%';
}
function logRenderMonth() {
  const label = $('log-month-label'); if (label) label.textContent = logMonthLabel(_logYear, _logMonth);
  const wdBox = $('log-weekdays');
  if (wdBox && !wdBox.childElementCount) {
    logWeekdayLabels().forEach(w => { const s = document.createElement('span'); s.textContent = w; wdBox.appendChild(s); });
  }
  const grid = $('log-grid');
  if (!grid) return;
  grid.innerHTML = '';
  const log = logLoad();
  const firstDow = new Date(_logYear, _logMonth, 1).getDay();
  const daysInMonth = new Date(_logYear, _logMonth + 1, 0).getDate();
  const now = new Date();
  const todayKey = logDateKey(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = 0; i < firstDow; i++) {
    const empty = document.createElement('span'); empty.className = 'log-cell empty'; grid.appendChild(empty);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const key = logDateKey(_logYear, _logMonth, d);
    const rec = log[key] || {};
    const total = (rec.studio || 0) + (rec.library || 0) + (rec.training || 0);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'log-cell' + (total > 0 ? ' has' : '') + (key === todayKey ? ' today' : '');
    cell.dataset.date = key;
    cell.innerHTML = logRingHTML(rec) + `<span class="log-daynum">${d}</span>`;
    grid.appendChild(cell);
  }
  logRenderMonthProgress();
  // 오늘이 지금 보고 있는 달 안에 있을 때만 자동으로 골라 보여준다 — 지난달로 넘겨 봤는데
  // 상세는 계속 "오늘" 걸 보여주면 지금 뭘 보고 있는지 헷갈린다.
  const isCurrentMonth = _logYear === now.getFullYear() && _logMonth === now.getMonth();
  if (isCurrentMonth) {
    logShowDetail(todayKey);
    document.querySelectorAll('.log-cell').forEach(c => c.classList.toggle('sel', c.dataset.date === todayKey));
  } else {
    logShowDetail(logDateKey(_logYear, _logMonth, 1));
    document.querySelectorAll('.log-cell').forEach(c => c.classList.remove('sel'));
  }
}
function logEnter() {
  const now = new Date();
  if (!_logYear) { _logYear = now.getFullYear(); _logMonth = now.getMonth(); }
  logRenderMonth();
}

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
function renderBeatDots(boxId, sig, subdiv) {
  const box = $(boxId);
  if (!box) return;
  box.innerHTML = '';
  for (let i = 0; i < sig; i++) {
    const d = document.createElement('span');
    d.className = 'pm-beat-dot' + (i === 0 ? ' accent' : '');
    d.dataset.beat = String(i);
    box.appendChild(d);
    for (let s = 1; s < subdiv; s++) {
      const tick = document.createElement('span');
      tick.className = 'pm-beat-tick';
      tick.dataset.beat = String(i);
      tick.dataset.sub = String(s);
      box.appendChild(tick);
    }
  }
}
function pmRenderBeats() { renderBeatDots('pm-beats', _pmSig, _pmSubdiv); }
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

// ── 튜너 ──
// 스튜디오 튜너는 엔진(JUCE, ASIO)이 분석한 pitch 를 IPC 로 보내주는 방식이다. 독립
// 마이크 캡처(getUserMedia+자기상관)로 따로 구현해봤지만 ASIO 오인페가 배타 모드로 열려
// 있으면 getUserMedia 가 신호를 못 받는 경우가 있어서, 같은 엔진 pitch 이벤트를 그대로
// 받는 쪽으로 되돌렸다 — 그래서 오디오 엔진이 켜져 있어야만 쓸 수 있고, 꺼져 있으면
// 안내 문구 + 스튜디오로 이동 버튼만 보여준다.
// 노트/센트 계산과 바늘 보간 공식은 스튜디오 튜너와 동일(studio.js updateTuner/tunerRAF 참고)
// — 같은 악기를 스튜디오에서 재던 트레이닝에서 재던 눈금이 똑같이 읽혀야 하니까.
const TUN_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
let _engineOn = false, _tunToolActive = false, _tunRAF = null;
let _tunRef = Number(localStorage.getItem('yss:tunerRef')) || 440;
let _tunNeedle = 50, _tunTarget = 50, _tunSmoothBuf = [], _tunLastHit = 0;

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
  const name = TUN_NOTE_NAMES[((nearest % 12) + 12) % 12];
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
function tunResetDisplay() {
  const noteEl = $('trn-tuner-note'), octEl = $('trn-tuner-oct'), centsEl = $('trn-tuner-cents'), freqEl = $('trn-tuner-freq');
  if (noteEl) noteEl.textContent = '—';
  if (octEl) octEl.textContent = '';
  if (centsEl) centsEl.textContent = '—';
  if (freqEl) freqEl.textContent = '';
  $('tool-trn-tuner')?.classList.remove('in-tune');
  $('trn-tuner-needle')?.classList.remove('in-tune');
  _tunTarget = 50; _tunNeedle = 50;
  const needle = $('trn-tuner-needle'); if (needle) needle.style.transform = 'translateX(-50%) translateX(0px)';
  _tunSmoothBuf.length = 0;
}
function tunSetRef(hz) {
  _tunRef = hz; localStorage.setItem('yss:tunerRef', String(hz));
  document.querySelectorAll('#trn-tuner-ref button').forEach(b => b.classList.toggle('on', Number(b.dataset.hz) === hz));
  _tunSmoothBuf.length = 0;
}
function tunRenderAvailability() {
  const card = $('tool-trn-tuner'), notice = $('trn-tuner-notice');
  if (card) card.hidden = !_engineOn;
  if (notice) notice.hidden = _engineOn;
}
function tunActivate() {
  if (_tunRAF) return;
  api?.engine?.tuner(true);
  _tunRAF = requestAnimationFrame(tunRAFStep);
}
function tunDeactivate() {
  if (_tunRAF) { cancelAnimationFrame(_tunRAF); _tunRAF = null; api?.engine?.tuner(false); }
  tunResetDisplay();
}
// 다른 도구로 넘어갈 때(showTool)와 엔진 상태가 바뀔 때(onEvent, 화면에 없어도 이벤트는
// 계속 온다) 양쪽에서 호출 — 지금 튜너 도구가 열려 있는지(_tunToolActive)와 엔진이
// 켜져 있는지(_engineOn)를 조합해 안내문/카드 표시와 pitch 분석 on/off 를 맞춘다.
function tunEnter() {
  _tunToolActive = true;
  tunRenderAvailability();
  if (_engineOn) tunActivate();
}
function tunLeave() {
  _tunToolActive = false;
  tunDeactivate();
}
function tunOnEngineChange() {
  tunRenderAvailability();
  if (_tunToolActive) { if (_engineOn) tunActivate(); else tunDeactivate(); }
}
api?.engine?.onEvent((m) => {
  if (m.ev === 'ready') { _engineOn = true; tunOnEngineChange(); }
  else if (m.ev === 'exit') { _engineOn = false; tunOnEngineChange(); }
  else if (m.ev === 'pitch' && _tunToolActive) tunUpdateUI(m.freq);
});

// ── BPM 트레이너 ──
// 정해진 마디 수마다 템포가 자동으로 조금씩 빨라지는 연습 모드. 메트로놈과 같은 look-ahead
// 스케줄러 패턴(PM_LOOKAHEAD_MS/PM_SCHEDULE_AHEAD, 박 표시 점+세분화 눈금)을 그대로 따라
// 별도 상태로 하나 더 돌린다. 모든 컨트롤(시작/목표/증가량/증가주기/박자표/세분화)은
// 재생 중에도 값이 바뀌는 즉시 다음 스케줄 틱에 반영된다 — 스케줄러가 매번 module 상태를
// 새로 읽지, 재생 시작 시점 값을 캐시해 두지 않기 때문(연습 메트로놈과 같은 방식).
let _btStart = Number(localStorage.getItem('yss:btStart')) || 80;
let _btTarget = Number(localStorage.getItem('yss:btTarget')) || 140;
let _btStep = Number(localStorage.getItem('yss:btStep')) || 2;
let _btEvery = Number(localStorage.getItem('yss:btEvery')) || 2;
let _btSig = Number(localStorage.getItem('yss:btSig')) || 4;
let _btSubdiv = Number(localStorage.getItem('yss:btSubdiv')) || 1;
let _btVol = Number(localStorage.getItem('yss:btVol'));
if (!(_btVol >= 0 && _btVol <= 1)) _btVol = 0.6;
let _btCurBpm = _btStart, _btMeasureCount = 0, _btBeat = 0, _btSub = 0, _btPlaying = false;
let _btCtx = null, _btGain = null, _btTimer = null, _btNextTime = 0;

function btRenderBeats() { renderBeatDots('bt-beats', _btSig, _btSubdiv); }
function btFlashEl(el, holdMs) {
  if (!el) return;
  el.classList.add('active');
  clearTimeout(el._btFlashT);
  el._btFlashT = setTimeout(() => el.classList.remove('active'), holdMs);
}
function btFlashBeat(beatIdx, delayMs) {
  const hold = Math.min(140, (60000 / _btCurBpm) * 0.6);
  setTimeout(() => btFlashEl(document.querySelector(`#bt-beats .pm-beat-dot[data-beat="${beatIdx}"]`), hold), delayMs);
}
function btFlashTick(beatIdx, subIdx, delayMs) {
  const hold = Math.min(90, (60000 / _btCurBpm / _btSubdiv) * 0.6);
  setTimeout(() => btFlashEl(document.querySelector(`#bt-beats .pm-beat-tick[data-beat="${beatIdx}"][data-sub="${subIdx}"]`), hold), delayMs);
}
function btUpdateBpmDisplay() {
  const el = $('bt-bpm-now'); if (el) el.textContent = _btCurBpm;
}
function btClick(time, kind, beatIdx, subIdx) {
  const osc = _btCtx.createOscillator();
  const g = _btCtx.createGain();
  osc.frequency.value = kind === 'accent' ? 1500 : kind === 'beat' ? 1000 : 650;
  const peak = kind === 'sub' ? 0.4 : (kind === 'accent' ? 1 : 0.6);
  const decay = kind === 'sub' ? 0.025 : 0.05;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(peak, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + decay);
  osc.connect(g); g.connect(_btGain);
  osc.start(time); osc.stop(time + 0.06);
  const delayMs = Math.max(0, (time - _btCtx.currentTime) * 1000);
  if (kind === 'sub') btFlashTick(beatIdx, subIdx, delayMs);
  else btFlashBeat(beatIdx, delayMs);
}
function btScheduler() {
  while (_btNextTime < _btCtx.currentTime + PM_SCHEDULE_AHEAD) {
    const isBeat = _btSub === 0;
    const isAccent = isBeat && _btBeat === 0;
    btClick(_btNextTime, isAccent ? 'accent' : isBeat ? 'beat' : 'sub', _btBeat, _btSub);
    _btNextTime += (60 / _btCurBpm) / _btSubdiv;
    _btSub = (_btSub + 1) % _btSubdiv;
    if (_btSub === 0) {
      _btBeat = (_btBeat + 1) % _btSig;
      if (_btBeat === 0) {
        _btMeasureCount++;
        if (_btMeasureCount % _btEvery === 0 && _btCurBpm < _btTarget) {
          _btCurBpm = Math.min(_btTarget, _btCurBpm + _btStep);
          btUpdateBpmDisplay();
        }
      }
    }
  }
}
function btSetStart(v) {
  _btStart = Math.max(20, Math.min(300, Math.round(v) || 80));
  localStorage.setItem('yss:btStart', String(_btStart));
  const el = $('bt-start'); if (el) el.value = _btStart;
  if (_btPlaying) { _btCurBpm = _btStart; btUpdateBpmDisplay(); }   // 재생 중엔 "시작"을 바꾸면 그 템포로 바로 되돌아간다
}
function btSetTarget(v) {
  _btTarget = Math.max(20, Math.min(300, Math.round(v) || 140));
  localStorage.setItem('yss:btTarget', String(_btTarget));
  const el = $('bt-target'); if (el) el.value = _btTarget;
}
function btSetStep(v) { _btStep = Number(v) || 2; localStorage.setItem('yss:btStep', String(_btStep)); }
function btSetEvery(v) { _btEvery = Number(v) || 2; localStorage.setItem('yss:btEvery', String(_btEvery)); }
function btSetSig(v) {
  _btSig = Number(v) || 4;
  localStorage.setItem('yss:btSig', String(_btSig));
  _btBeat = 0;
  btRenderBeats();
}
function btSetSubdiv(v) {
  _btSubdiv = Number(v) || 1;
  localStorage.setItem('yss:btSubdiv', String(_btSubdiv));
  _btSub = 0;
  btRenderBeats();
}
function btSetVol(v01) {
  _btVol = Math.max(0, Math.min(1, v01));
  localStorage.setItem('yss:btVol', String(_btVol));
  if (_btGain) _btGain.gain.value = _btVol;
}
function btStart() {
  if (_btPlaying) return;
  if (!_btCtx) {
    _btCtx = new (window.AudioContext || window.webkitAudioContext)();
    _btGain = _btCtx.createGain();
    _btGain.gain.value = _btVol;
    _btGain.connect(_btCtx.destination);
  }
  if (_btCtx.state === 'suspended') _btCtx.resume();
  _btPlaying = true;
  _btCurBpm = _btStart; _btMeasureCount = 0; _btBeat = 0; _btSub = 0;
  btUpdateBpmDisplay();
  _btNextTime = _btCtx.currentTime + 0.05;
  _btTimer = setInterval(btScheduler, PM_LOOKAHEAD_MS);
  const btn = $('bt-playstop'); if (btn) { btn.classList.add('on'); btn.textContent = t('training.pm.stop'); }
}
function btStop() {
  if (!_btPlaying) return;
  _btPlaying = false;
  clearInterval(_btTimer); _btTimer = null;
  document.querySelectorAll('#bt-beats .pm-beat-dot, #bt-beats .pm-beat-tick').forEach(d => {
    clearTimeout(d._btFlashT); d.classList.remove('active');
  });
  const btn = $('bt-playstop'); if (btn) { btn.classList.remove('on'); btn.textContent = t('training.pm.start'); }
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
  if (name !== 'bpm-trainer') btStop();
  if (name === 'tuner') tunEnter(); else tunLeave();
  if (name === 'log') logEnter();
}

let _booted = false;
export function initTraining() {
  if (_booted) return;
  _booted = true;

  document.querySelector('.training-nav')?.addEventListener('click', (e) => {
    const nav = e.target.closest('.training-nav-item[data-tool]');
    if (nav) showTool(nav.dataset.tool);
  });

  logLoadGoals();
  const logGoalDailyEl = $('log-goal-daily'), logGoalMonthlyEl = $('log-goal-monthly');
  if (logGoalDailyEl) logGoalDailyEl.value = _logDailyGoalMin;
  if (logGoalMonthlyEl) logGoalMonthlyEl.value = _logMonthlyGoalMin;
  logGoalDailyEl?.addEventListener('change', () => {
    _logDailyGoalMin = Math.max(0, Number(logGoalDailyEl.value) || 0);
    logSaveGoals();
    logRenderMonth();   // 링이 일일 목표를 기준으로 그려지므로 다시 그린다
  });
  logGoalMonthlyEl?.addEventListener('change', () => {
    _logMonthlyGoalMin = Math.max(0, Number(logGoalMonthlyEl.value) || 0);
    logSaveGoals();
    logRenderMonthProgress();
  });

  logEnter();   // 연습 기록이 기본으로 열려 있는 도구라 첫 진입에도 바로 채워 둔다
  $('log-prev')?.addEventListener('click', () => {
    _logMonth--; if (_logMonth < 0) { _logMonth = 11; _logYear--; }
    logRenderMonth();
  });
  $('log-next')?.addEventListener('click', () => {
    _logMonth++; if (_logMonth > 11) { _logMonth = 0; _logYear++; }
    logRenderMonth();
  });
  $('log-grid')?.addEventListener('click', (e) => {
    const cell = e.target.closest('.log-cell:not(.empty)');
    if (!cell) return;
    document.querySelectorAll('.log-cell.sel').forEach(c => c.classList.remove('sel'));
    cell.classList.add('sel');
    logShowDetail(cell.dataset.date);
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

  const tunRefBox = $('trn-tuner-ref');
  if (tunRefBox) {
    tunRefBox.querySelectorAll('button').forEach(b => b.addEventListener('click', () => tunSetRef(Number(b.dataset.hz))));
    tunSetRef(_tunRef);
  }
  tunRenderAvailability();
  $('trn-tuner-goto-studio')?.addEventListener('click', () => {
    document.querySelector('.tab[data-view="studio"]')?.click();
  });

  const btStartEl = $('bt-start'), btTargetEl = $('bt-target'), btStepEl = $('bt-step'), btEveryEl = $('bt-every'),
        btSigEl = $('bt-sig'), btSubdivEl = $('bt-subdiv'), btVolEl = $('bt-vol');
  if (btStartEl) btStartEl.value = _btStart;
  if (btTargetEl) btTargetEl.value = _btTarget;
  if (btStepEl) btStepEl.value = String(_btStep);
  if (btEveryEl) btEveryEl.value = String(_btEvery);
  if (btSigEl) btSigEl.value = String(_btSig);
  if (btSubdivEl) btSubdivEl.value = String(_btSubdiv);
  if (btVolEl) btVolEl.value = String(Math.round(_btVol * 100));
  btUpdateBpmDisplay();
  btRenderBeats();
  btStartEl?.addEventListener('change', () => btSetStart(Number(btStartEl.value)));
  btTargetEl?.addEventListener('change', () => btSetTarget(Number(btTargetEl.value)));
  btStepEl?.addEventListener('change', () => btSetStep(btStepEl.value));
  btEveryEl?.addEventListener('change', () => btSetEvery(btEveryEl.value));
  btSigEl?.addEventListener('change', () => btSetSig(btSigEl.value));
  btSubdivEl?.addEventListener('change', () => btSetSubdiv(btSubdivEl.value));
  btVolEl?.addEventListener('input', () => btSetVol(Number(btVolEl.value) / 100));
  $('bt-playstop')?.addEventListener('click', () => { if (_btPlaying) btStop(); else btStart(); });

  // 사이드바 안에서 도구를 바꿀 때는 showTool() 이 소리를 끄지만, 트레이닝 탭 자체를
  // 벗어날 때(다른 최상단 탭 클릭)는 그걸 호출하는 곳이 없다 — app.js 는 각 뷰의 hidden
  // 속성만 토글하지 뷰별 onLeave 훅이 없어서, 여기서 직접 그 속성 변화를 지켜본다.
  // 이게 없으면 메트로놈/BPM 트레이너가 화면 밖에서 계속 클릭을 내고, 튜너는 엔진 pitch
  // 분석을 계속 켜 둔 채로 남는다.
  const trainingView = document.querySelector('main[data-view="training"]');
  if (trainingView) {
    new MutationObserver(() => {
      if (trainingView.hidden) {
        pmStop(); btStop(); tunLeave();
      } else if (document.querySelector('.training-nav-item.on')?.dataset.tool === 'tuner') {
        tunEnter();   // 튜너는 재생 상태가 아니라 그냥 "보여주는" 도구라 돌아오면 바로 다시 켠다
      }
    }).observe(trainingView, { attributes: true, attributeFilter: ['hidden'] });
  }
}
