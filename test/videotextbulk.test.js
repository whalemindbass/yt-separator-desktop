'use strict';
// 자막(텍스트) 클립 스타일 — 효과 패널(미리보기 왼쪽)에서 일괄/개별 두 가지로 편집할 수
// 있어야 한다: 텍스트 "트랙"(헤드)을 선택하면 그 트랙의 자막 전부가 한 번에 바뀌고,
// 클립 하나를 선택하면 그 클립만 따로 바뀐다. 팝오버(더블클릭 편집창)와 패널이 같은
// 클립을 동시에 가리킬 때 값이 서로 어긋나 보이지 않는지도 함께 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetextbulk-profile-')));

const { bootMain, expect, section, wait, finish } = require('./harness');

// 클립 선택 — 실제 코드는 pointerdown 에서 선택하고(wireMove), pointerup(드래그 없어도
// 항상 옴)에서 layout() 을 돌려 패널을 갱신한다. 스크립트로 흉내낼 땐 이 두 이벤트를
// 그대로 순서대로 보내야 한다(진짜 클릭처럼 브라우저가 알아서 합성해 주지 않는다).
function selectEl(selector, pid) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: ${pid} }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${pid} }));
    return true;
  })()`;
}
// 트랙 헤드 선택은 'click' 리스너다(다른 헤드 버튼들과 같은 관례) — pointerdown/up 을
// 스크립트로 보내도 진짜 클릭처럼 'click' 이 자동 합성되지 않으므로 따로 보낸다.
function clickEl(selector) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`;
}
function setField(id, value, evt) {
  return `(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event(${JSON.stringify(evt)}, { bubbles: true }));
  })(); true`;
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  const projFile = path.join(app.getPath('userData'), 'videoProject.json');
  const readSaved = () => { try { return JSON.parse(fs.readFileSync(projFile, 'utf-8')); } catch { return null; } };
  const waitSaved = async (pred, tries = 30) => {
    for (let i = 0; i < tries; i++) { const p = readSaved(); if (p && pred(p)) return p; await wait(200); }
    return readSaved();
  };

  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) "+텍스트" 두 번 — 같은 텍스트 트랙에 자막 클립 2개');
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="text"]').click(); true`);
  await wait(150);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="text"]').click(); true`);
  await wait(150);
  expect('텍스트 클립 2개', await js(`document.querySelectorAll('.ve-clip.text').length`), 2);
  expect('텍스트 트랙은 1개(재사용됨)', await js(`document.querySelectorAll('.ve-lane.text').length`), 1);
  // dataset.clipId 는 항상 문자열이다 — 저장된 프로젝트 JSON 의 clip.id 는 숫자라
  // Number 로 바꿔둬야 find(c => c.id === id1) 비교가 제대로 맞는다.
  const ids = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.ve-clip.text')].map(el => el.dataset.clipId))`)).map(Number);
  const [id1, id2] = ids;

  section('2) 바깥 클릭으로 팝오버 닫고, 텍스트 트랙 헤드 선택 — 일괄 편집 모드로 전환');
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await wait(80);
  await js(clickEl('.ve-lane.text .ve-head'));
  await wait(80);
  expect('트랙 헤드에 선택 표시(sel-track)', await js(`document.querySelector('.ve-lane.text').classList.contains('sel-track')`), true);
  expect('효과 패널에 일괄 안내 문구가 보임', await js(`!!document.querySelector('#ve-fx-body > p.ve-fx-empty')`), true);
  expect('일괄 안내에 클립 개수(2) 포함', await js(`document.querySelector('#ve-fx-body > p.ve-fx-empty')?.textContent.includes('2')`), true);
  expect('스타일 입력칸(크기)이 보임', await js(`!!document.getElementById('vt-size')`), true);

  section('3) 일괄 편집 — 크기를 60으로 바꾸면 두 클립 모두 반영');
  await js(setField('vt-size', '60', 'input'));
  let saved = await waitSaved(p => p?.clips?.every(c => !c.isText || c.size === 60));
  const sizes = saved.clips.filter(c => c.isText).map(c => c.size);
  expect('두 클립 모두 크기 60으로 바뀜', sizes.every(s => s === 60), true);

  section('4) 클립 하나만 선택 — 개별 편집 모드로 전환(일괄 모드 해제)');
  await js(selectEl(`.ve-clip[data-clip-id="${id1}"]`, 2));
  await wait(80);
  expect('선택하면 트랙의 sel-track 표시가 풀림', await js(`document.querySelector('.ve-lane.text').classList.contains('sel-track')`), false);
  expect('일괄 안내 문구는 더 이상 안 보임(개별 모드)', await js(`!!document.querySelector('#ve-fx-body > p.ve-fx-empty')`), false);
  expect('개별 모드에도 스타일 입력칸이 보임', await js(`!!document.getElementById('vt-color')`), true);

  section('5) 개별 편집 — 색상을 클립1만 바꾸면 클립2는 그대로');
  await js(setField('vt-color', '#ff00ff', 'input'));
  saved = await waitSaved(p => p?.clips?.find(c => c.id === id1)?.color === '#ff00ff');
  const c1 = saved.clips.find(c => c.id === id1), c2 = saved.clips.find(c => c.id === id2);
  expect('클립1 색상만 바뀜', c1.color, '#ff00ff');
  expect('클립2 색상은 그대로(기본값)', c2.color, '#ffffff');
  expect('클립1 크기는 앞서 일괄 적용된 60 그대로 유지', c1.size, 60);

  section('6) 팝오버(더블클릭)와 패널이 같은 클립을 동시에 편집해도 값이 어긋나지 않음');
  await js(`document.querySelector('.ve-clip[data-clip-id="${id1}"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
  await wait(100);
  expect('팝오버가 열림', await js(`!!document.querySelector('.ve-text-pop')`), true);
  expect('팝오버가 패널과 같은 크기(60)를 보여줌', await js(`document.getElementById('tx-size').value`), '60');
  await js(setField('tx-size', '90', 'input'));
  await wait(80);
  expect('팝오버에서 바꾼 값이 패널 입력칸에도 바로 반영됨', await js(`document.getElementById('vt-size').value`), '90');
  await js(setField('vt-x', '20', 'input'));
  await wait(80);
  expect('패널에서 바꾼 값이 팝오버 입력칸에도 바로 반영됨', await js(`document.getElementById('tx-x').value`), '20');
  saved = await waitSaved(p => p?.clips?.find(c => c.id === id1)?.size === 90);
  expect('저장 파일에도 최종 값(크기 90) 반영', saved.clips.find(c => c.id === id1).size, 90);
  expect('저장 파일에도 최종 값(x 20%) 반영', saved.clips.find(c => c.id === id1).xPct, 0.2);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
