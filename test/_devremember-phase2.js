'use strict';
// devremember.test.js 의 2차 부팅 — Electron app 은 프로세스당 하나뿐이라 같은 파일 안에서
// bootMain() 을 두 번 부를 수 없다. 그래서 별도 프로세스로 띄운다.
// 인자로 받은 {type, output} 로 재연결됐는지만 stdout 에 JSON 한 줄로 찍고 끝난다.
//
// process.stdout 이 부모로 파이프될 때는 쓰기가 비동기다. app.exit() 은 그 쓰기가 끝나기
// 전에 프로세스를 끊어버려서, console.log 로 찍은 결과 줄이 부모(spawnSync)에 통째로
// 안 보이는 문제가 있었다 — write 의 콜백이 불려야 실제로 나간 것이다.
const { bootMain, wait } = require('./harness');

function report(obj) {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(obj) + '\n', () => resolve());
  });
}

async function waitEngineOn(js, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(`document.getElementById('st-engine-dot')?.classList.contains('on')`)) return true;
    await wait(300);
  }
  return false;
}

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });
  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);
  if (!await waitEngineOn(js, 20000)) {
    await report({ ok: false, reason: 'no-device' });
    await js(`localStorage.removeItem('yss.deviceConfig'); true`);
    app.exit(0); return;
  }
  // ready -> listDevices -> reconnectSavedDevice -> setDevice -> 새 device 이벤트, 순서로 일어난다.
  // 타입을 통째로 바꾸는 재연결(ASIO 닫고 Windows Audio 열기 등)이라 몇 초 걸릴 수 있다 —
  // 한 번 묻고 끝내는 대신 값이 더 안 바뀔 때까지 반복해서 묻는다.
  await js(`window.yssApi.engine.onEvent(m => { if (m.ev === 'devices') window.__rt = m; }); true`);
  let last = null, stableCount = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && stableCount < 3) {
    await js(`window.__rt = null; true`);
    await js(`window.yssApi.engine.listDevices(); true`);
    let d = null;
    for (let i = 0; i < 15; i++) { d = await js(`window.__rt`); if (d) break; await wait(200); }
    const key = d && (d.currentType + '|' + d.output);
    if (key && key === last) stableCount++; else stableCount = 0;
    last = key;
    if (d) global.__lastDevices = d;
    await wait(500);
  }
  const d = global.__lastDevices;
  await report({ ok: true, currentType: d && d.currentType, output: d && d.output });
  await js(`localStorage.removeItem('yss.deviceConfig'); true`);   // 다음 실행에 영향 안 주게 여기서 청소
  app.exit(0);
})().catch(async (e) => { await report({ ok: false, reason: String(e) }); process.exit(1); });
