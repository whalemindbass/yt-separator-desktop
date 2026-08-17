'use strict';
// 저장해 둔 장치가 지금 붙은 기본 장치와 다를 때(=재연결이 실제로 전환을 일으킬 때), 부팅 중
// 상태 표시줄(#st-engine-status)에 "스쳐 지나가는 기본 장치 이름"이 잠깐이라도 보이면 안 된다
// — 사용자에겐 "저장한 장치가 왜 바로 안 뜨지" 로 보인다. 재연결이 끝날 때까지는
// "저장된 장치로 연결 중…" 으로 고정돼 있어야 하고, 끝나면 저장해 둔 장치 이름으로 바뀐다.
//
// 고정 간격 폴링으로는 못 잡는다 — status 를 썼다가 바로 다음 tick 에 다시 덮어쓰는 경우
// 150ms 간격 샘플링이 그 순간을 건너뛸 수 있다. 대신 studio.js 내부 리스너와 같은
// 'device' 이벤트를 듣는 리스너를 하나 더 등록해서, 그 이벤트로 studio.js 가 DOM 을 갱신한
// *직후*(같은 event 리스너 큐, 등록 순서상 studio.js 리스너 다음) status 를 그 자리에서
// 스냅샷 뜬다 — 그래야 실제로 무엇을 화면에 썼는지 놓치지 않는다. 이러려면 내 리스너가
// studio.js 의 wire() 가 자기 리스너를 다는 것보다 "나중에" 등록돼야 한다 — wire() 는 탭을
// studio 로 처음 전환할 때 동기적으로 도니, 탭 클릭이 끝난 뒤에 내 리스너를 단다.
//
// _devremember-phase1.js 가 심어 둔 값을 그대로 쓴다 — 별도 프로세스인 이유는 같은 파일 맨
// 위 주석 참고(단일 인스턴스 락).
const { bootMain, wait } = require('./harness');

function report(obj) {
  return new Promise((resolve) => { process.stdout.write(JSON.stringify(obj) + '\n', () => resolve()); });
}

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });
  const target = JSON.parse(await js(`localStorage.getItem('yss.deviceConfig')`) || 'null');
  if (!target) { await report({ ok: false, reason: 'no-seed' }); app.exit(0); return; }

  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);   // wire() 가 여기서 동기적으로 자기 리스너를 먼저 단다

  await js(`window.__devEvts = []; window.yssApi.engine.onEvent(m => {
    if (m.ev !== 'device') return;
    window.__devEvts.push({ t: Date.now(), name: m.name, statusRightAfter: document.getElementById('st-engine-status')?.textContent });
  }); true`);

  // 재연결까지 걸리는 시간(엔진이 실제로 장치를 닫았다 여는 시간) 여유 있게 기다린다.
  await wait(20000);

  const devEvts = await js(`window.__devEvts`);
  const finalStatus = await js(`document.getElementById('st-engine-status')?.textContent`);
  await report({ ok: true, target, finalStatus, devEvts });
  await js(`localStorage.removeItem('yss.deviceConfig'); true`);
  app.exit(0);
})().catch(async (e) => { await report({ ok: false, reason: String(e) }); process.exit(1); });
