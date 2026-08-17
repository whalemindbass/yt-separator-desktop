'use strict';
// 제보: 없는 오디오 장치로 setDevice 를 보내면 앱 전체가 죽었다.
//
// 엔진이 {ev:"error", ...} 를 보내면, engine-client.js 가 msg.ev 를 그대로 이벤트 이름으로도
// emit 했다(this.emit(msg.ev, msg)) — 아무도 안 듣는 죽은 코드였는데, 'error' 는 Node 의
// EventEmitter 가 예약해 둔 이름이라 리스너가 하나도 없으면 emit 자체가 예외를 던진다.
// main.js 는 이 인스턴스에 'error' 리스너를 안 달아 뒀어서, 그 순간 uncaughtException 이 뜬다.
//
// main.js 최상단에 이미 process.on('uncaughtException', ...) 가 있어서 프로세스 자체는
// 안 죽는다(그래서 "앱이 응답하는가" 만으로는 이 버그를 못 잡는다 — 실제로 처음 짠 검사가
// 그랬고, 버그를 되돌려도 통과했다). 그 핸들러가 하는 일은 noteCrash() 로 크래시 기록을
// 남기는 것뿐이다 — 그러니 진짜 신호는 "이 조작 하나로 크래시 기록이 새로 생겼는가" 다.
//
// setDevice 실패를 렌더러에 알리려고 오늘 처음 emit("error") 를 엔진에 추가했는데, 그게
// 이 죽은 줄을 처음으로 실제 위험하게 만들었다. 고침: 그 죽은 emit 줄 삭제 + main.js 에
// 안전망으로 'error' 리스너 추가(이중 방어).

const { bootMain, expect, wait, finish, skip } = require('./harness');

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });
  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);

  const engineOn = () => js(`document.getElementById('st-engine-dot')?.classList.contains('on')`);
  let ready = false;
  for (let i = 0; i < 30; i++) { if (await engineOn()) { ready = true; break; } await wait(300); }
  if (!ready) {
    skip('이 컴퓨터의 오디오 장치가 시간 안에 안 열렸다 — 판정 불능');
    finish(app);
    return;
  }
  await wait(500);

  await js(`window.yssApi.takeLastCrash()`);   // 이 세션에서 이미 쌓인 게 있으면 비워 둔다

  // 존재하지 않는 장치로 보내서 실제 에러 응답을 받는다 — 지어낸 값이 아니라 진짜 실패 경로.
  await js(`window.__err = null; window.yssApi.engine.onEvent(m => { if (m.ev === 'error') window.__err = m; });
    window.yssApi.engine.setDevice({ type: 'ASIO', output: '없는장치XYZ123' }); true`);

  let gotError = false;
  for (let i = 0; i < 20; i++) { if (await js(`!!window.__err`)) { gotError = true; break; } await wait(300); }
  expect('실패 응답이 렌더러까지 옴', gotError, true);

  await wait(1000);   // uncaughtException 이 있다면 이 사이에 noteCrash 가 파일을 쓴다
  const crash = await js(`window.yssApi.takeLastCrash()`);
  expect('그 사이 크래시 기록 없음', crash, null);

  // main 프로세스 응답 확인 — 정말 죽었으면 이 IPC 도 안 돌아온다
  const version = await js(`window.yssApi.getVersion()`).catch(() => null);
  expect('main 프로세스 응답함', typeof version === 'string' && version.length > 0, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
