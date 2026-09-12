'use strict';
// 연습 메트로놈(트레이닝 탭, pm-*)/BPM 트레이너(bt-*) — 렌더러 자체 Web Audio 스케줄러다
// (스튜디오의 st-metro 와 다르다, 그건 네이티브 엔진 기반 — metronome.test.js 가 따로 본다).
//
// 세분화가 예전엔 "몇 등분"(균등 나눗셈) 하나였는데, 바운스(스윙)는 길게-짧게(2:1)라 등분이
// 아니다 — 그래서 PM_SUBDIV_PATTERNS(박 하나를 채우는 상대 길이 배열)로 일반화했다. 실제
// 오디오 타이밍 정확도는 여기서 못 재니, 세분화별로 박 표시 눈금 개수가 맞는지 + 재생해도
// 콘솔 오류 없이 도는지만 확인한다.
const { bootRenderer, expect, section, wait, finish, expectNoConsoleErrors } = require('./harness');

const $ = (id) => `document.getElementById(${JSON.stringify(id)})`;
// training.js 의 PM_SUBDIV_PATTERNS 와 동일 — 세분화 값마다 한 박에 몇 스텝(점+눈금)이어야
// 하는지 테스트 쪽에서 검증용으로 안다.
const STEPS = { '1': 1, '2': 2, '3': 3, '6': 6, '4': 4, 'swing': 2 };

(async () => {
  const { app, js, errors } = await bootRenderer();

  await js(`document.querySelector('.tab[data-view="training"]').click(); true`);
  await js(`document.querySelector('.training-nav-item[data-tool="metro-practice"]').click(); true`);
  await wait(300);

  section('=== 세분화별 박 표시 눈금 개수 ===');
  for (const [value, steps] of Object.entries(STEPS)) {
    await js(`(() => { const el = ${$('pm-subdiv')}; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await wait(80);
    const sig = Number(await js(`${$('pm-sig')}.value`));
    const ticks = await js(`document.querySelectorAll('#pm-beats .pm-beat-tick').length`);
    const dots = await js(`document.querySelectorAll('#pm-beats .pm-beat-dot').length`);
    expect(`세분화=${value} 박 점 개수(박자표 그대로)`, dots, sig);
    expect(`세분화=${value} 중간 눈금 개수((${steps}-1)*박자표)`, ticks, (steps - 1) * sig);
  }

  section('=== 재생 — 세분화 바꿔가며 돌려도 콘솔 오류 없음 ===');
  for (const value of Object.keys(STEPS)) {
    await js(`(() => { const el = ${$('pm-subdiv')}; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await js(`document.getElementById('pm-playstop').click(); true`); // 시작
    await wait(200);
    await js(`document.getElementById('pm-playstop').click(); true`); // 정지
    await wait(80);
  }

  section('=== BPM 트레이너도 같은 세분화 옵션 ===');
  await js(`document.querySelector('.training-nav-item[data-tool="bpm-trainer"]').click(); true`);
  await wait(150);
  await js(`(() => { const el = ${$('bt-subdiv')}; el.value = 'swing'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await wait(80);
  const btSig = Number(await js(`${$('bt-sig')}.value`));
  expect('BPM 트레이너 바운스 — 눈금 개수(sig개, 2등분이라 하나씩)', await js(`document.querySelectorAll('#bt-beats .pm-beat-tick').length`), btSig);
  await js(`document.getElementById('bt-playstop').click(); true`);
  await wait(200);
  await js(`document.getElementById('bt-playstop').click(); true`);
  await wait(80);
  expectNoConsoleErrors(errors);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
