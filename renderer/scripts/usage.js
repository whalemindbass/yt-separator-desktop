'use strict';
// 사용 시간 자동 집계 — 트레이닝의 "연습 기록" 달력이 읽는 원본 데이터를 여기서 하나만
// 관리한다. 날짜별·카테고리별(studio/library/training)로 localStorage 에 누적한다.
//
// app.js 는 탭이 바뀔 때 usageEnter(name) 을 불러 "지금 어느 카테고리를 보고 있는지"를
// 알려준다. 그것만으로는 "탭이 열려 있는 시간"과 "실제로 쓰는 시간"을 못 가른다 — 창을
// 최소화하거나 다른 앱으로 넘어가도 탭은 그대로 열려 있으니까. 그래서 두 가지를 더 본다:
//   1) 창이 포커스를 잃으면(blur) 그 사이는 아무 것도 재지 않는다.
//   2) 메트로놈·BPM 트레이너처럼 "재생 중이냐 아니냐"로 실제 사용 여부를 바로 알 수 있는
//      도구는, training.js 가 usageSetIdle(true/false) 로 그 판정을 넘겨준다. 튜너나
//      연습 기록 달력처럼 그렇게 판단하기 어려운 화면은 그냥 탭이 열려 있으면 사용중으로
//      친다(기존 방식 그대로).
const USAGE_CATS = ['studio', 'library', 'training'];
let _cat = null, _start = 0, _timer = null, _blurred = false, _idle = false;

function dateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function load() {
  try { return JSON.parse(localStorage.getItem('yss:usageLog') || '{}'); } catch { return {}; }
}
function flush() {
  const now = performance.now();
  if (!_cat || _blurred || _idle) { _start = now; return; }
  const elapsedSec = (now - _start) / 1000;
  _start = now;   // 같은 카테고리에 계속 머물러 있으면 다음 flush 도 이어서 잰다
  if (elapsedSec < 1) return;
  const log = load();
  const key = dateKey(new Date());
  if (!log[key]) log[key] = {};
  log[key][_cat] = (log[key][_cat] || 0) + elapsedSec;
  localStorage.setItem('yss:usageLog', JSON.stringify(log));
}
export function usageEnter(name) {
  flush();   // 이전 카테고리 몫부터 정산
  _idle = false;   // 카테고리를 새로 들어오는 시점엔 일단 사용중으로 본다 — 필요하면 곧바로 usageSetIdle 이 덮어쓴다
  if (USAGE_CATS.includes(name)) {
    _cat = name; _start = performance.now();
    if (!_timer) _timer = setInterval(flush, 20000);
  } else {
    _cat = null;
    if (_timer) { clearInterval(_timer); _timer = null; }
  }
}
// 지금 카테고리는 그대로 두고 "실제로 쓰고 있냐"만 바꾼다 — 메트로놈/BPM 트레이너를
// 열어만 두고 재생은 안 하는 동안은 idle(true), 재생 중이면 idle(false).
export function usageSetIdle(idle) {
  flush();
  _idle = idle;
}
window.addEventListener('beforeunload', flush);
window.addEventListener('blur', () => { flush(); _blurred = true; });
window.addEventListener('focus', () => { _blurred = false; _start = performance.now(); });
