'use strict';
// 건의: 트랙을 확대하면 마디 안의 박이 눈금으로 보이면 좋겠다.
//
// 예전엔 박 세분선이 배율과 무관하게 항상 켜져 있어서 지저분하다고 뺐다(a80864d,
// "확대 배율과 무관하게 촘촘해져 지저분해서 뺐다"). 이번엔 확대했을 때만 켜지므로
// 같은 불만이 재발하지 않는지, 그리고 저배율에서는 정말 꺼져 있는지를 같이 잰다.
//
// 처음엔 박 자리에 "마디.박"(예: 4.2) 글자도 넣었는데, 다운비트까지 "4" 대신 "4.1"로
// 바뀌는 게 오히려 산만하다는 피드백을 받아 글자는 빼고 선만 남겼다.

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
  await js('document.getElementById("daw-boot").hidden = true; true');

  const counts = () => js(`({
    beat: document.querySelectorAll('#daw-ruler .tk.beat').length,
    showClass: document.getElementById('daw-lanes')?.classList.contains('show-beat-grid'),
    beatLabel: (document.querySelector('#daw-ruler .tk.beat') || {}).textContent || '',
    downbeatLabel: (document.querySelector('#daw-ruler .tk:not(.minor):not(.beat):not(.beat16)') || {}).textContent || '',
  })`);

  const base = await counts();
  expect('저배율 — 박 눈금 없음', base.beat === 0 && !base.showClass, true);

  for (let i = 0; i < 20; i++) await js(`document.getElementById('st-zoom-in')?.click(); true`);
  await wait(400);
  const zoomed = await counts();
  expect('확대 — 박 눈금 켜짐', zoomed.beat > 0 && zoomed.showClass, true);
  expect('박 눈금엔 글자 없음', zoomed.beatLabel, '');
  expect('다운비트는 마디 번호 그대로', /^\d+$/.test(zoomed.downbeatLabel), true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
