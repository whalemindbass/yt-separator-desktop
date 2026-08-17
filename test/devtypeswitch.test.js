'use strict';
// 제보: "오디오 설정에서 Windows Audio 로 적용하고 껐다 키면 다시 ASIO 로 돌아가 있다."
//
// 원인: 설정 창에서 드라이버(dv-type)를 바꾸면 즉시 setDevice({type})를 보내지만, 실제 장치
// 전환(ASIO 를 닫고 WASAPI 를 여는 것)은 몇 초 걸린다. 그 사이 dv-out <select> 는 아직 "이전
// 타입"의 출력 목록을 그대로 보여 주고 있었다 — 그 목록 중 하나가 새 타입의 목록에도 우연히
// 같은 문자열로 있으면(서로 다른 드라이버가 같은 장치명을 쓰는 경우) 사용자가 Apply 를 누르는
// 순간 그 스테일 값이 저장된다. 그 값은 실제로 새 타입에 존재하지 않는 장치명이므로, 다음 부팅
// 때 reconnectSavedDevice() 가 "그 타입에 그 장치가 없다" 판단해 재연결을 포기하고 엔진 기본값
// (ASIO)에 남는다 — 이게 "다시 ASIO로 돌아가있다"로 보인 것.
//
// 고침: dv-type 변경 시 dv-out/dv-in/dv-apply 를 잠그고, 엔진이 실제로 전환을 끝내고 보내는
// 새 'devices' 응답(= case 'devices' 의 openDevModal 재렌더)이 올 때까지 Apply 를 누를 수
// 없게 한다. 그래야 저장되는 값이 항상 "그 순간 실제로 연결된" 장치와 일치한다.

const { bootMain, expect, wait, finish, skip } = require('./harness');

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });
  await js(`localStorage.removeItem('yss.deviceConfig'); true`);   // 이전 실행 잔여값이 재연결 경합을 만들지 않게
  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);

  const engineOn = () => js(`document.getElementById('st-engine-dot')?.classList.contains('on')`);
  let ready = false;
  for (let i = 0; i < 30; i++) { if (await engineOn()) { ready = true; break; } await wait(300); }
  if (!ready) { skip('이 컴퓨터의 오디오 장치가 시간 안에 안 열렸다 — 판정 불능'); finish(app); return; }
  await wait(500);

  await js(`document.getElementById('st-audio-settings')?.click(); true`);
  let opened = false;
  for (let i = 0; i < 20; i++) { if (await js(`!!document.getElementById('dv-type')`)) { opened = true; break; } await wait(300); }
  expect('설정 창 열림', opened, true);
  if (!opened) { finish(app); return; }

  const typeCount = await js(`document.getElementById('dv-type')?.options.length`);
  if (typeCount < 2) {
    skip('이 컴퓨터엔 오디오 드라이버 타입이 하나뿐이라 전환을 재현할 수 없다');
    finish(app);
    return;
  }

  const otherType = await js(`(() => {
    const sel = document.getElementById('dv-type');
    for (const o of sel.options) if (o.value !== sel.value) return o.value;
    return null;
  })()`);

  // 드라이버 타입을 바꾼다 — 실제 사용자 조작과 동일하게 change 이벤트를 발생시킨다.
  await js(`(() => {
    const sel = document.getElementById('dv-type');
    sel.value = ${JSON.stringify(otherType)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);

  // 전환 도중엔 잠겨 있어야 저장 시점의 스테일 값 경합이 없다.
  const lockedRightAfter = await js(`document.getElementById('dv-apply')?.disabled`);
  expect('전환 시작 직후 Apply 잠김', lockedRightAfter, true);

  // 실제 전환(엔진이 새 'devices' 를 보내 모달을 다시 그릴 때)까지 최대 15초 기다린다.
  let unlocked = false;
  for (let i = 0; i < 50; i++) { if (await js(`document.getElementById('dv-apply')?.disabled === false`)) { unlocked = true; break; } await wait(300); }
  expect('전환 끝난 뒤 Apply 풀림', unlocked, true);

  // 잠금이 풀렸다면, dv-out 은 이제 "이전 타입"이 아니라 "지금 선택된 타입"의 출력 목록 중
  // 하나를 보여 주고 있어야 한다 — 이게 이번에 고친 핵심 불변식이다.
  const state = await js(`({
    type: document.getElementById('dv-type')?.value,
    outOptions: [...(document.getElementById('dv-out')?.options || [])].map(o => o.value),
    out: document.getElementById('dv-out')?.value,
  })`);
  expect('바뀐 타입이 유지됨', state.type, otherType);
  expect('dv-out 값이 새 타입 목록 안에 있음', state.outOptions.includes(state.out), true);

  // Apply → 저장된 값이 "그 순간 실제로 연결된" 장치와 일치하는지 확인한다.
  await js(`document.getElementById('dv-apply')?.click(); true`);
  await wait(1000);

  const saved = JSON.parse(await js(`localStorage.getItem('yss.deviceConfig')`) || 'null');

  await js(`window.__rt = null; window.yssApi.engine.onEvent(m => { if (m.ev === 'devices') window.__rt = m; }); window.yssApi.engine.listDevices(); true`);
  let d = null;
  for (let i = 0; i < 20; i++) { d = await js(`window.__rt`); if (d) break; await wait(300); }

  expect('저장된 타입 == 실제 연결된 타입', saved && saved.type, d && d.currentType);
  expect('저장된 출력 == 실제 연결된 출력', saved && saved.output, d && d.output);

  await js(`localStorage.removeItem('yss.deviceConfig'); true`);   // 다음 실행에 영향 안 주게 청소
  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
