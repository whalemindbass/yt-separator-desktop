'use strict';
// 제보: 스튜디오에 들어가서 아무것도 안 했는데도 닫을 때 "저장하지 않은 변경사항" 이 떴다.
//
// 원인: 엔진이 (재)연결될 때마다 녹음 트랙 목록을 스스로 한 번 알려온다(초기 동기화,
// Main.cpp 의 engine.emitRecTracks() — 'ready' 직후 자동으로 온다). studio.js 의
// 'recTracks' 처리기는 그 메시지를 편집으로 보고 무조건 markDirty() 를 불렀다 — 즉
// 스튜디오에 들어가기만 해도 100% 재현되는 문제였다(엔진 크래시조차 필요 없다).
//
// 이 검사는 진짜 오디오 장치를 열어야 해서 크래시 테스트만큼은 아니어도 환경 의존적이다.
// 다만 강제종료를 안 쓰므로 그쪽보다 훨씬 안정적이다.

const { bootMain, expect, wait, finish, skip } = require('./harness');

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });

  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);
  const engineOn = () => js(`document.getElementById('st-engine-dot')?.classList.contains('on')`);
  let ready = false;
  for (let i = 0; i < 30; i++) { if (await engineOn()) { ready = true; break; } await wait(300); }

  if (!ready) {
    skip('이 컴퓨터의 오디오 장치가 시간 안에 안 열렸다 — 판정 불능');
  } else {
    await wait(1500);   // recTracks 초기 동기화까지 여유
    await js('document.getElementById("daw-boot").hidden = true; true');
    const title = await js(`document.querySelector('#st-proj-name .pn-label')?.textContent || ''`);
    expect('아무것도 안 했으면 안 더럽다', title.includes('•'), false);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
