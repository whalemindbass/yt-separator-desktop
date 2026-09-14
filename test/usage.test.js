'use strict';
// 연습 시간 자동 집계(usage.js) — 화면 없이 값만 넣어 확인한다. window/performance 를
// 흉내내는 최소 전역만 깔고, 모듈을 매번 새 쿼리스트링으로 다시 import 해서 시나리오마다
// 독립된 _log/_cat 상태로 시작한다(실제 벽시계 대기 없이 performance.now() 를 직접 조작
// 해서 결정적으로 검증한다).

const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const expect = (label, got, want) => {
  const ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}: ${got}${ok ? '' : ` (기대 ${want})`}`);
};
const near = (label, got, want, tol) => {
  const ok = Math.abs(Number(got) - Number(want)) <= tol; ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}: ${got}${ok ? '' : ` (기대 ${want}±${tol})`}`);
};

function dateKey(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const MODULE_PATH = pathToFileURL(path.resolve(__dirname, '..', 'renderer', 'scripts', 'usage.js')).href;

/** usage.js 를 매번 새 전역(window/performance)과 함께 새 모듈 인스턴스로 올린다. */
async function loadFreshModule(loadImpl, saveImpl) {
  let now = 0;
  global.performance = { now: () => now };
  const listeners = {};
  global.window = {
    yssApi: { usage: { load: loadImpl, save: saveImpl || (async () => true) } },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
  };
  const mod = await import(MODULE_PATH + '?t=' + Date.now() + '_' + Math.random());
  return { mod, tick: (sec) => { now += sec * 1000; }, listeners };
}

(async () => {
  console.log('1) 누적 — 다른 카테고리로 넘어갈 때(usageEnter) 그 전 몫을 정산한다');
  {
    const { mod, tick } = await loadFreshModule(async () => ({ log: {}, goals: {} }));
    await mod.usageReady;
    mod.usageEnter('studio');
    tick(5);
    mod.usageEnter('library');
    near('5초 사용 → studio 누적', mod.usageGetLog()[dateKey(new Date())]?.studio, 5, 0.05);
  }

  console.log('2) idle 동안은 안 쌓인다(메트로놈 정지 등)');
  {
    const { mod, tick } = await loadFreshModule(async () => ({ log: {}, goals: {} }));
    await mod.usageReady;
    mod.usageEnter('training');
    tick(3);
    mod.usageSetIdle(true, 'training');   // 여기까지 3초 정산 후 idle 진입
    tick(10);                              // idle 10초 — 안 쌓여야 함
    mod.usageSetIdle(false, 'training');
    tick(4);
    mod.usageEnter('other');               // 마지막 4초 정산 트리거
    near('idle 구간 빼고 3+4=7초만 누적', mod.usageGetLog()[dateKey(new Date())]?.training, 7, 0.05);
  }

  console.log('3) forCat 가드 — 탭을 이미 떠난 뒤 늦게 도착한 idle 판정은 무시된다');
  {
    // training.js 의 MutationObserver(탭 hidden 감지)는 마이크로태스크라, 트레이닝 탭을
    // 벗어나 다음 탭의 usageEnter() 가 먼저 실행된 "다음"에 도착할 수 있다. forCat 가드
    // 없이 그 늦은 usageSetIdle(true) 가 그대로 적용되면 이미 전환된 다음 탭이 잘못
    // idle 처리돼서 시간이 하나도 안 쌓인다 — 실제로 있었던 버그, 회귀 방지용.
    const { mod, tick } = await loadFreshModule(async () => ({ log: {}, goals: {} }));
    await mod.usageReady;
    mod.usageEnter('training');
    tick(1);
    mod.usageEnter('studio');                 // 실제 탭 전환 — idle 은 false 로 리셋됨
    mod.usageSetIdle(true, 'training');       // training 탭을 늦게 떠나며 온 stale 판정
    tick(5);
    mod.usageEnter('other');
    near('늦게 온 training idle 판정이 studio 를 오염시키지 않는다', mod.usageGetLog()[dateKey(new Date())]?.studio, 5, 0.05);
  }

  console.log('3-1) forCat 없이 부르면(기존 호출부 호환) 카테고리 안 가리고 그대로 적용');
  {
    const { mod, tick } = await loadFreshModule(async () => ({ log: {}, goals: {} }));
    await mod.usageReady;
    mod.usageEnter('training');
    tick(2);
    mod.usageSetIdle(true);   // forCat 생략 — 무조건 적용
    tick(10);
    mod.usageEnter('other');
    near('forCat 생략 시엔 idle 이 그대로 걸린다(2초만 누적)', mod.usageGetLog()[dateKey(new Date())]?.training, 2, 0.05);
  }

  console.log('4) blur/focus — 창이 비활성인 동안은 안 쌓인다');
  {
    const { mod, tick, listeners } = await loadFreshModule(async () => ({ log: {}, goals: {} }));
    await mod.usageReady;
    mod.usageEnter('studio');
    tick(2);
    listeners.blur[0]();
    tick(20);
    listeners.focus[0]();
    tick(3);
    mod.usageEnter('other');
    near('blur 구간 빼고 2+3=5초만 누적', mod.usageGetLog()[dateKey(new Date())]?.studio, 5, 0.05);
  }

  console.log('5) 로드-병합 — 디스크 파일을 읽는 동안 이미 메모리에 쌓인 몫을 잃지 않는다');
  {
    let resolveLoad;
    const loadPromise = new Promise((r) => { resolveLoad = r; });
    const key = dateKey(new Date());
    const { mod, tick } = await loadFreshModule(() => loadPromise);
    // 파일 로드가 끝나기 전부터 이미 사용 중(부팅 직후 흔한 경우)
    mod.usageEnter('studio');
    tick(4);
    mod.usageEnter('other');   // 4초 정산 — 디스크 값은 아직 없음
    resolveLoad({ log: { [key]: { studio: 100, library: 20 } }, goals: { dailyMin: 45, monthlyMin: 900 } });
    await mod.usageReady;
    near('디스크의 오늘치 studio(100) + 로드 전 누적(4) 합산', mod.usageGetLog()[key]?.studio, 104, 0.05);
    expect('같은 날짜의 다른 카테고리(library)는 그대로 보존', mod.usageGetLog()[key]?.library, 20);
    expect('목표값도 로드됨(dailyMin)', mod.usageGetGoals().dailyMin, 45);
    expect('목표값도 로드됨(monthlyMin)', mod.usageGetGoals().monthlyMin, 900);
  }

  console.log('6) usageSetGoals — 변경 즉시 저장 IPC 로 전달된다');
  {
    let saved = null;
    const { mod } = await loadFreshModule(async () => ({ log: {}, goals: {} }), async (data) => { saved = data; return true; });
    await mod.usageReady;
    mod.usageSetGoals({ dailyMin: 60 });
    await new Promise((r) => setTimeout(r, 10));
    expect('설정 변경이 저장 데이터에 반영됨', saved?.goals?.dailyMin, 60);
  }

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
