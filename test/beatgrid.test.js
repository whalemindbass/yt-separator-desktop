'use strict';
// 건의: 트랙을 확대하면 마디 안의 박(4.1 4.2 4.3 4.4)까지 눈금·글자로 보이면 좋겠다.
//
// 예전엔 박 세분선이 배율과 무관하게 항상 켜져 있어서 지저분하다고 뺐다(a80864d,
// "확대 배율과 무관하게 촘촘해져 지저분해서 뺐다"). 이번엔 확대했을 때만 켜지므로
// 같은 불만이 재발하지 않는지, 그리고 저배율에서는 정말 꺼져 있는지를 같이 잰다.

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
    labelSample: (document.querySelector('#daw-ruler .tk.beat') || {}).textContent || '',
    downbeatSample: (document.querySelector('#daw-ruler .tk:not(.minor):not(.beat):not(.beat16)') || {}).textContent || '',
  })`);

  const base = await counts();
  expect('저배율 — 박 눈금 없음', base.beat === 0 && !base.showClass, true);

  for (let i = 0; i < 20; i++) await js(`document.getElementById('st-zoom-in')?.click(); true`);
  await wait(400);
  const zoomed = await counts();
  expect('확대 — 박 눈금 켜짐', zoomed.beat > 0 && zoomed.showClass, true);
  expect('박 라벨 "마디.박" 꼴', /^\d+\.[2-4]$/.test(zoomed.labelSample), true);
  expect('다운비트도 "마디.1"', /^\d+\.1$/.test(zoomed.downbeatSample), true);

  // 제보: 박 글자 아래가 잘려 보였다. .tk.beat 의 font-size 만 따로 덮어썼는데, 상위 .tk 가
  // font 축약형(font: 600 9.5px/24px ...)으로 line-height 까지 같이 정했던 터라 24px 가
  // 그대로 남았다 — 자기 상자(13px)보다 큰 줄상자로 텍스트를 그리며 룰러의
  // overflow:hidden 에 밑부분이 잘렸다. getBoundingClientRect() 는 박스 자체(13px 로 고정)
  // 만 재서 못 잡는다 — line-height 계산값을 직접 봐야 한다.
  const lh = await js(`(() => {
    const tk = document.querySelector('#daw-ruler .tk.beat');
    return tk ? getComputedStyle(tk).lineHeight : null;
  })()`);
  expect('줄높이가 상자(13px)를 안 넘음', lh ? parseFloat(lh) <= 13 : null, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
