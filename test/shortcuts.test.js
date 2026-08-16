'use strict';
// 건의: 단축키 안내가 트랙 비었을 때 한 줄로만 잠깐 보이고, Ctrl+C/X/V·Delete·Ctrl+Y·Ctrl+S 도
// 빠져 있었다. 오디오 설정 왼쪽에 상시 버튼을 두고 모달로 전체 목록을 보여주게 고쳤다.
//
// 이 버튼은 엔진이 켜지지 않아도 눌러야 하므로(오디오 시작 전에도 참고할 수 있어야 값어치가
// 있다), 오디오 장치를 열 필요 없이 잰다 — 이 스위트에서 유일하게 실제 장치가 필요 없는 검사.

const { bootMain, expect, wait, finish } = require('./harness');

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });

  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);
  await wait(1000);

  expect('오디오 없이도 버튼 활성', await js(`!document.getElementById('st-shortcuts')?.disabled`), true);

  await js(`document.getElementById('st-shortcuts')?.click(); true`);
  await wait(300);

  const state = await js(`(() => {
    const host = document.getElementById('daw-modal');
    const rows = [...document.querySelectorAll('.daw-modal-kv')];
    return {
      visible: host && !host.hidden,
      rowCount: rows.length,
      hasCopy: rows.some(r => r.querySelector('kbd')?.textContent === 'Ctrl+C'),
      hasSave: rows.some(r => r.querySelector('kbd')?.textContent === 'Ctrl+S'),
      hasRedo: rows.some(r => r.querySelector('kbd')?.textContent === 'Ctrl+Shift+Z'),
      hasDelete: rows.some(r => r.querySelector('kbd')?.textContent === 'Delete'),
      emptyDesc: rows.some(r => !r.querySelector('span')?.textContent?.trim()),
    };
  })()`);
  expect('모달 열림    ', state.visible, true);
  expect('행 12개 이상 ', state.rowCount >= 12, true);
  expect('복사 있음    ', state.hasCopy, true);
  expect('저장 있음    ', state.hasSave, true);
  expect('다시실행 있음', state.hasRedo, true);
  expect('삭제 있음    ', state.hasDelete, true);
  expect('빈 설명 없음 ', state.emptyDesc, false);

  await js(`document.querySelector('#daw-modal .x')?.click(); true`);
  await wait(200);
  expect('닫으면 숨김  ', await js(`document.getElementById('daw-modal')?.hidden`), true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
