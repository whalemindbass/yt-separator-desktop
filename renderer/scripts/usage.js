'use strict';
// 사용 시간 자동 집계 — 트레이닝의 "연습 기록" 달력이 읽는 원본 데이터를 여기서 하나만
// 관리한다. 날짜별·카테고리별(studio/library/training)로 누적한다.
//
// localStorage 가 아니라 library.json 처럼 실제 파일(usageLog.json, main.js 의
// usage:load/usage:save IPC)에 저장한다 — localStorage 는 렌더러 코드 한 줄
// (removeItem)로 통째로 날아갈 수 있고(개발 중 테스트 스크립트가 실제로 그렇게
// 지웠다), 앱 업데이트에 안전하다는 보장도 진짜 파일만큼 강하지 않다. 다만 파일
// 로드는 비동기라, 메모리 캐시(_log/_goals)를 두고 그걸로 항상 동기 응답하고
// 디스크 반영은 뒤에서 비동기로 한다 — training.js 쪽 렌더링 코드가 await 없이
// 그대로 쓸 수 있게.
//
// app.js 는 탭이 바뀔 때 usageEnter(name) 을 불러 "지금 어느 카테고리를 보고 있는지"를
// 알려준다. 그것만으로는 "탭이 열려 있는 시간"과 "실제로 쓰는 시간"을 못 가른다 — 창을
// 최소화하거나 다른 앱으로 넘어가도 탭은 그대로 열려 있으니까. 그래서 두 가지를 더 본다:
//   1) 창이 포커스를 잃으면(blur) 그 사이는 아무 것도 재지 않는다.
//   2) 메트로놈·BPM 트레이너처럼 "재생 중이냐 아니냐"로 실제 사용 여부를 바로 알 수 있는
//      도구는, training.js 가 usageSetIdle(true/false) 로 그 판정을 넘겨준다. 튜너나
//      연습 기록 달력처럼 그렇게 판단하기 어려운 화면은 그냥 탭이 열려 있으면 사용중으로
//      친다(기존 방식 그대로).
const api = window.yssApi;
const USAGE_CATS = ['studio', 'library', 'training'];
let _cat = null, _start = 0, _timer = null, _blurred = false, _idle = false;
let _log = {};
let _goals = { dailyMin: 30, monthlyMin: 600 };

// 파일 로드가 끝나기 전에 이미 뭔가 쌓였을 수 있으니(부팅 직후부터 usageEnter 가
// 불릴 수 있다), 로드된 파일 내용 위에 지금까지 메모리에 쌓인 것만 더해 합친다 —
// 어느 쪽도 덮어써서 잃지 않는다.
export const usageReady = (async () => {
  try {
    const data = await api?.usage?.load();
    if (data && typeof data === 'object') {
      const loaded = (data.log && typeof data.log === 'object') ? data.log : {};
      for (const [day, cats] of Object.entries(_log)) {
        const merged = { ...(loaded[day] || {}) };
        for (const [cat, sec] of Object.entries(cats)) merged[cat] = (merged[cat] || 0) + sec;
        loaded[day] = merged;
      }
      _log = loaded;
      if (data.goals && typeof data.goals === 'object') {
        if (Number.isFinite(data.goals.dailyMin) && data.goals.dailyMin >= 0) _goals.dailyMin = data.goals.dailyMin;
        if (Number.isFinite(data.goals.monthlyMin) && data.goals.monthlyMin >= 0) _goals.monthlyMin = data.goals.monthlyMin;
      }
    }
  } catch { /* 파일이 없거나 깨졌으면 빈 상태로 시작 */ }
})();

function dateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function persist() {
  usageReady.then(() => api?.usage?.save({ log: _log, goals: _goals }));
}
function flush() {
  const now = performance.now();
  if (!_cat || _blurred || _idle) { _start = now; return; }
  const elapsedSec = (now - _start) / 1000;
  _start = now;   // 같은 카테고리에 계속 머물러 있으면 다음 flush 도 이어서 잰다
  if (elapsedSec < 1) return;
  const key = dateKey(new Date());
  if (!_log[key]) _log[key] = {};
  _log[key][_cat] = (_log[key][_cat] || 0) + elapsedSec;
  persist();
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
// training.js 의 연습 기록 달력이 읽는 자리 — 항상 동기로, 로드 전이면 빈 값을 준다.
export function usageGetLog() { return _log; }
export function usageGetGoals() { return _goals; }
export function usageSetGoals(next) {
  Object.assign(_goals, next);
  persist();
}
window.addEventListener('beforeunload', flush);
window.addEventListener('blur', () => { flush(); _blurred = true; });
window.addEventListener('focus', () => { _blurred = false; _start = performance.now(); });
