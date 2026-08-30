'use strict';
// 라이브러리(연습) 화면의 카운트인 "정렬" 옵션 + 메트로놈 볼륨/클릭 패턴 — 실제 DOM 클릭/입력이
// 곡별 설정(localStorage yss:song-settings:...)까지 정확히 저장되는지로 검증한다. 저장은
// Player 메서드 호출과 같은 핸들러 안에서 함께 일어나므로(saveCountIn/saveMetro), 저장된
// 값을 보면 그 호출이 올바른 인자로 실제 실행됐다는 걸 간접적으로 확인할 수 있다 — 내부
// 클로저를 직접 찌르지 않고 이 코드베이스의 다른 테스트들과 같은 방식(DOM·영속 상태 관찰)을
// 따른다. 실제 오디오/영상 파일 없이도(스템 없음, 존재하지 않는 videoPath) UI 배선만
// 확인하면 되므로 bootRenderer 로 가볍게 띄운다(엔진·ffmpeg 불필요 — home.test.js 와 같은 패턴).

const { bootRenderer, expect, section, wait, finish } = require('./harness');

const VIDEO_PATH = 'X:/nonexistent.mp4';
const LIB = [
  { id: 'song1', name: '테스트 곡', modelKey: '4stem', createdAt: Date.now(),
    videoPath: VIDEO_PATH, stemPaths: {}, meta: {} },
];
const SETTINGS_KEY = 'yss:song-settings:' + VIDEO_PATH.toLowerCase();
const readSettings = (js) => js(`JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}) || '{}')`);

(async () => {
  const { app, js } = await bootRenderer({ stubs: { 'library:list': () => LIB } });

  await js(`document.querySelector('.tab[data-view="library"]').click(); true`);
  await wait(300);
  await js(`document.querySelector('.lib-item[data-id="song1"]')?.click(); true`);
  await wait(500);

  section('1) 카운트인 끈 상태 — "정렬" 서브 버튼은 숨겨져 있다');
  expect('카운트인 기본 꺼짐', await js(`document.getElementById('countin-toggle')?.classList.contains('on')`), false);
  expect('정렬 버튼 기본 숨김', await js(`document.getElementById('countin-smart-toggle')?.hidden`), true);

  section('2) 카운트인 켜면 "정렬" 버튼이 나타난다(여전히 꺼진 채로 — 기본은 0초 시작)');
  await js(`document.getElementById('countin-toggle')?.click(); true`);
  await wait(80);
  expect('카운트인 켜짐', await js(`document.getElementById('countin-toggle')?.classList.contains('on')`), true);
  expect('정렬 버튼 보임', await js(`document.getElementById('countin-smart-toggle')?.hidden`), false);
  expect('정렬 버튼은 여전히 꺼짐(기본값)', await js(`document.getElementById('countin-smart-toggle')?.classList.contains('on')`), false);
  let saved = await readSettings(js);
  expect('저장된 설정에도 enabled:true 반영', saved.countIn?.enabled, true);
  expect('저장된 설정엔 smartAlign 아직 없음(기본값 = 꺼짐)', saved.countIn?.smartAlign, undefined);

  section('3) "정렬" 클릭 — Player.setCountInSmartAlign(true) 호출 + 저장까지 반영');
  await js(`document.getElementById('countin-smart-toggle')?.click(); true`);
  await wait(80);
  expect('정렬 버튼이 켜짐 표시로 바뀜', await js(`document.getElementById('countin-smart-toggle')?.classList.contains('on')`), true);
  saved = await readSettings(js);
  expect('저장된 설정에 smartAlign:true 반영', saved.countIn?.smartAlign, true);

  section('4) 메트로놈 볼륨 — 슬라이더 상한이 150(예전 100 에서 늘어남), 150 으로 두면 그대로 저장');
  expect('슬라이더 max=150', await js(`document.getElementById('metro-vol')?.max`), '150');
  await js(`(() => {
    const el = document.getElementById('metro-vol');
    el.value = '150';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(80);
  saved = await readSettings(js);
  expect('저장된 볼륨 150', saved.metro?.volume, 150);

  section('5) 클릭 패턴 셀렉트 — 옵션 3개(모든 박 동일/첫박만/1·3 만), 바꾸면 저장까지 반영');
  const accentOptions = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('#metro-accent option')].map(o => o.value))`));
  expect('옵션 3개(none/first/onethree)', accentOptions.join(','), 'none,first,onethree');
  expect('기본 선택값은 none(모든 박 동일 — 예전 동작과 같음)', await js(`document.getElementById('metro-accent')?.value`), 'none');
  await js(`(() => {
    const el = document.getElementById('metro-accent');
    el.value = 'onethree';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  await wait(80);
  expect('셀렉트 값이 실제로 바뀜', await js(`document.getElementById('metro-accent').value`), 'onethree');
  saved = await readSettings(js);
  expect('저장된 accent 패턴 onethree', saved.metro?.accent, 'onethree');

  section('6) 곡을 다시 선택(리마운트 — destroyPlayer 로 UI 리셋 후 재복원)해도 저장된 값이 정확히 돌아오는지');
  await js(`document.querySelector('.lib-item[data-id="song1"]')?.click(); true`);
  await wait(500);
  expect('재선택 시 카운트인 켜짐 복원', await js(`document.getElementById('countin-toggle')?.classList.contains('on')`), true);
  expect('재선택 시 정렬 버튼도 보이고 켜짐 복원', await js(`document.getElementById('countin-smart-toggle')?.classList.contains('on')`), true);
  expect('재선택 시 볼륨 슬라이더 150 복원', await js(`document.getElementById('metro-vol')?.value`), '150');
  expect('재선택 시 클릭 패턴 onethree 복원', await js(`document.getElementById('metro-accent')?.value`), 'onethree');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
