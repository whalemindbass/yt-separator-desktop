'use strict';
// 홈 화면 — 페이지 전환 · 최근 작업 · 바로 시작 · 글꼴 · 줄 호버 모양.
// 공지는 캐시에 심어 서버 없이 실제 렌더를 태운다.

const { bootRenderer, expect, near, section, wait, finish, expectNoConsoleErrors } = require('./harness');

const DAY = 86400e3;
const NOTICES = [
  { id: 'a', kind: 'notice', title: '디스코드 서버 준비 중', pinned: true, publishedAt: Date.now() - 3600e3,
    body: '자리가 잡히면 여기에 **링크**를 올리겠습니다. [공식 웹사이트](https://ytseparator.com)를 참고해 주세요.' },
  { id: 'b', kind: 'notice', title: '스템 저장 위치 안내', pinned: false, publishedAt: Date.now() - DAY, body: '설정에서 바꿉니다.' },
  { id: 'c', kind: 'update', title: 'v9.9.9', pinned: false, publishedAt: Date.now() - 2 * DAY, body: '- 시험용 항목' },
];
const LIB = [
  { id: 'a1', name: '아주 긴 곡 제목이 두 줄로 넘어가는지 보기 위한 이름입니다', modelKey: '6stem',
    createdAt: Date.now() - 3600e3, videoPath: 'X:/none1.mp4', stemPaths: {}, meta: {} },
  { id: 'a2', name: 'Yesterday Take 2', modelKey: '4stem', createdAt: Date.now() - DAY, videoPath: 'X:/none2.mp4', stemPaths: {}, meta: {} },
  { id: 'a3', name: '사흘 전 작업', modelKey: '4stem', createdAt: Date.now() - 3 * DAY, videoPath: 'X:/none3.mp4', stemPaths: {}, meta: {} },
  { id: 'a4', name: '오래된 곡', modelKey: '6stem', createdAt: Date.now() - 40 * DAY, videoPath: 'X:/none4.mp4', stemPaths: {}, meta: {} },
  { id: 'a5', name: '다섯 번째 — 넘치면 안 보여야 한다', modelKey: '4stem', createdAt: Date.now() - 90 * DAY, videoPath: 'X:/none5.mp4', stemPaths: {}, meta: {} },
];

let lib = [];

(async () => {
  const { app, js, errors } = await bootRenderer({ stubs: { 'library:list': () => lib } });
  const home = () => js('document.getElementById("brand-home").click(); true');

  await js(`localStorage.setItem("yss:notices", ${JSON.stringify(JSON.stringify({ at: Date.now(), notices: NOTICES }))}); true`);

  section('1) 라이브러리가 비었을 때');
  await home(); await wait(1200);
  let s = await js(`({
    페이지: [...document.querySelectorAll('.home-page')].find(p=>p.classList.contains('on'))?.dataset.page,
    바로시작: document.querySelectorAll('.quick-card').length,
    최근숨김: document.getElementById('home-recent-panel').hidden,
    미리보기: document.querySelectorAll('#home-notices .notice-row-btn').length,
    디스코드숨김: getComputedStyle(document.querySelector('.home-nav-discord')).display === 'none',
    버전카드: !!document.querySelector('.home-nav-card'),
  })`);
  expect('홈 페이지    ', s.페이지, 'home');
  expect('바로 시작 4개', s.바로시작, 4);
  expect('최근 패널 숨김', s.최근숨김, true);
  expect('공지 미리보기', s.미리보기, 2);
  expect('디스코드 숨김', s.디스코드숨김, true);
  expect('버전 카드 제거', s.버전카드, false);

  section('2) 바로 시작 → 탭 이동');
  await js('document.querySelector(\'.quick-card[data-view-go="library"]\').click(); true');
  await wait(700);
  expect('라이브러리로 ', await js('document.querySelector("main.view:not([hidden])")?.dataset.view'), 'library');

  section('3) 곡이 생기면 이어서 하기가 뜬다');
  lib = LIB;
  await home(); await wait(1300);
  s = await js(`(()=>{const c=[...document.querySelectorAll('.recent-card')];return {
    보임: !document.getElementById('home-recent-panel').hidden,
    카드: c.length,
    모델: c[0]?.querySelector('.recent-model')?.textContent.trim(),
    언제: c.map(x=>x.querySelector('time')?.textContent.trim()).slice(0,3).join('|'),
    두줄: getComputedStyle(c[0].querySelector('b')).webkitLineClamp,
    칸높이같음: new Set([...document.querySelectorAll('.recent-thumb')].map(t=>Math.round(t.getBoundingClientRect().height))).size,
  };})()`);
  expect('패널 보임    ', s.보임, true);
  expect('카드 4개까지 ', s.카드, 4);
  expect('모델 뱃지    ', s.모델, '6stem');
  expect('상대 날짜    ', s.언제, '오늘|어제|3일 전');
  expect('제목 두 줄   ', s.두줄, 2);
  expect('썸네일 높이 일정', s.칸높이같음, 1);

  section('4) 곡을 누르면 라이브러리에서 열린다');
  await js('document.querySelector(\'.recent-card[data-song="a2"]\').click(); true');
  await wait(1400);
  expect('라이브러리로 ', await js('document.querySelector("main.view:not([hidden])")?.dataset.view'), 'library');

  section('5) 사이드바 → 게시판 → 글 열기');
  await home(); await wait(900);
  await js('[...document.querySelectorAll(".home-nav-item")].find(b=>b.dataset.page==="notices").click(); true');
  await wait(500);
  expect('게시판 줄    ', await js('document.querySelectorAll(".board-row").length'), 2);
  await js('document.querySelector(".board-row").click(); true');
  await wait(400);
  const d = await js(`({
    보임: !document.getElementById('board-detail').hidden,
    제목: document.getElementById('detail-title').textContent,
    굵게: !!document.querySelector('#detail-body strong'),
    링크: document.querySelector('#detail-body a')?.dataset.ext || '없음',
  })`);
  expect('상세 열림    ', d.보임, true);
  expect('제목         ', d.제목, '디스코드 서버 준비 중');
  expect('굵게 처리    ', d.굵게, true);
  expect('링크만 허용  ', d.링크, 'https://ytseparator.com');

  section('6) 줄 호버 모양 — 배경은 둥글고 구분선은 곧다');
  const r = await js(`(()=>{const b=document.querySelector('.board-row');const cs=getComputedStyle(b);
    return { 반지름: cs.borderRadius, 위치: cs.position, 테두리위: cs.borderTopWidth,
             선높이: getComputedStyle(document.querySelectorAll('.board-row')[1],'::before').height };})()`);
  expect('배경 반지름  ', r.반지름, '8px');
  expect('border-top 없음', r.테두리위, '0px');
  expect('구분선 유지  ', r.선높이, '1px');

  section('7) 글꼴 — 버튼이 UA 기본을 쓰면 안 된다');
  const f = await js(`(()=>{const first=(s)=>s.split(',')[0].replace(/["']/g,'').trim();
    const body=first(getComputedStyle(document.body).fontFamily);
    const of=(sel)=>first(getComputedStyle(document.querySelector(sel)).fontFamily);
    return { body, 푸터: of('.home-foot-link'), 사이드바: of('.home-nav-item'),
             게시판: of('.board-row'), 브랜드: of('.brand') };})()`);
  for (const k of ['푸터', '사이드바', '게시판', '브랜드']) expect(`${k} 글꼴`.padEnd(13), f[k], f.body);

  section('8) 로고 글자색 — 테마 따라 바뀌어야 한다');
  for (const [th, want] of [['dark', true], ['light', false]]) {
    await js(`document.documentElement.setAttribute('data-theme','${th}'); true`);
    await wait(250);
    const c = await js('getComputedStyle(document.querySelector(".brand .titles h1")).color');
    const v = (c.match(/\d+/g) || []).map(Number);
    expect(`${th} 밝은 글자`.padEnd(13), (v[0] + v[1] + v[2]) / 3 > 120, want);
  }

  expectNoConsoleErrors(errors);
  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
