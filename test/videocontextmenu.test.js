'use strict';
// 클립/트랙 우클릭 컨텍스트 메뉴 — "우클릭하면 trim 등 사용할 수 있는 기능들 목록 뜨게
// 해줘" 요청. 예전엔 클립 우클릭이 도형/텍스트에만(설정 팝오버) 반응하고 일반 영상
// 클립·트랙 헤드는 아무 반응이 없어서(단축키 S/U/H/V/Delete 를 몰랐다는 피드백), 커서
// 위치에 뜨는 버튼 목록으로 각 동작을 눈에 보이게 했다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vectxmenu-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vectxmenu-'));
const RED = path.join(TMP, 'red.mp4');   // 3초

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', RED], { stdio: 'ignore' });
if (!fs.existsSync(RED)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [RED] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function menuLabels(js) {
  return js(`JSON.stringify([...document.querySelectorAll('.ve-ctxmenu-item')].map(b => b.textContent))`);
}
function clickMenuItem(js, label) {
  return js(`(() => {
    const b = [...document.querySelectorAll('.ve-ctxmenu-item')].find(x => x.textContent === ${JSON.stringify(label)});
    b?.click();
    return !!b;
  })()`);
}
function rightClick(js, selector) {
  return js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 10, clientY: r.top + 5, bubbles: true, cancelable: true }));
  })(); true`);
}
function seekViaArea(js, selector, xOffset) {
  return js(`(() => {
    const clip = document.querySelector(${JSON.stringify(selector)});
    const r = clip.getBoundingClientRect();
    clip.closest('.ve-lane').querySelector('.ve-area').dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + ${xOffset}, clientY: r.top + 5, bubbles: true }));
  })(); true`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await wait(150);

  section('1) 재생헤드가 클립 밖(0초, 클립 시작점) — 우클릭 메뉴는 뜨지만 분할/트림은 비활성');
  await rightClick(js, '.ve-clip');
  await wait(80);
  expect('메뉴가 뜸', await js(`!!document.querySelector('.ve-ctxmenu')`), true);
  const labels1 = JSON.parse(await menuLabels(js));
  expect('분할 항목 있음', labels1.includes('분할'), true);
  expect('시작점 트림 항목 있음', labels1.includes('재생헤드까지 트림(시작점)'), true);
  expect('끝점 트림 항목 있음', labels1.includes('재생헤드까지 트림(끝점)'), true);
  expect('삭제 항목 있음', labels1.includes('삭제'), true);
  expect('분할은 비활성(재생헤드가 클립 경계)', await js(`[...document.querySelectorAll('.ve-ctxmenu-item')].find(b => b.textContent === '분할')?.disabled`), true);

  section('2) 바깥을 클릭하면 메뉴가 닫힘');
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { clientX: 2, clientY: 2, bubbles: true })); true`);
  await wait(80);
  expect('메뉴 닫힘', await js(`!document.querySelector('.ve-ctxmenu')`), true);

  section('3) 재생헤드를 클립 중간(1.5초 근처)으로 옮기고 우클릭 — 분할 클릭하면 실제로 둘로 나뉨');
  await seekViaArea(js, '.ve-clip', 60);   // 40px/초 기준 ≈1.5초 근처
  await wait(80);
  await rightClick(js, '.ve-clip');
  await wait(80);
  expect('이번엔 분할이 활성', await js(`[...document.querySelectorAll('.ve-ctxmenu-item')].find(b => b.textContent === '분할')?.disabled`), false);
  const countBeforeSplit = await js(`document.querySelectorAll('.ve-clip').length`);
  await clickMenuItem(js, '분할');
  await wait(80);
  expect('메뉴 클릭 후 닫힘', await js(`!document.querySelector('.ve-ctxmenu')`), true);
  const countAfterSplit = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('메뉴의 분할로 클립이 둘로 나뉨', countAfterSplit, countBeforeSplit + 1);

  section('4) 두 조각 중 첫 조각을 우클릭 — 끝점 트림 클릭하면 폭이 줄어듦');
  const firstClipSel = `[...document.querySelectorAll('.ve-clip')].sort((a,b) => parseFloat(a.style.left) - parseFloat(b.style.left))[0]`;
  const widthBeforeTrim = await js(`parseFloat((${firstClipSel}).style.width)`);
  // 방금 분할해서 재생헤드가 정확히 그 경계(=첫 조각의 끝)에 있다 — 그 자리에서 끝점
  // 트림은 이미 그 자리라 아무 일도 안 한다(정상). 첫 조각 안쪽(경계보다 앞)으로
  // 재생헤드를 다시 옮겨야 실제로 잘릴 여지가 생긴다.
  await js(`(() => {
    const clip = ${firstClipSel};
    const r = clip.getBoundingClientRect();
    clip.closest('.ve-lane').querySelector('.ve-area').dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left + 20, clientY: r.top + 5, bubbles: true }));
  })(); true`);
  await wait(80);
  await js(`(() => {
    const el = ${firstClipSel};
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 10, clientY: r.top + 5, bubbles: true, cancelable: true }));
  })(); true`);
  await wait(80);
  await clickMenuItem(js, '재생헤드까지 트림(끝점)');
  await wait(80);
  const widthAfterTrim = await js(`parseFloat((${firstClipSel}).style.width)`);
  expect('트림(끝점)으로 첫 조각 폭이 줄어듦', widthAfterTrim < widthBeforeTrim, true);

  section('5) 좌우 반전 — 효과 체인에 추가되는지');
  await js(`(() => {
    const el = ${firstClipSel};
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true, cancelable: true }));
  })(); true`);
  await wait(80);
  await clickMenuItem(js, '좌우 반전');
  await wait(80);
  expect('효과 목록에 좌우 반전 행 생김', await js(`document.querySelector('.ve-fx-row .ve-fx-name')?.textContent`), '좌우 반전');

  section('6) 삭제 — 메뉴로 클립 제거');
  const countBeforeDel = await js(`document.querySelectorAll('.ve-clip').length`);
  await js(`(() => {
    const el = ${firstClipSel};
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true, cancelable: true }));
  })(); true`);
  await wait(80);
  await clickMenuItem(js, '삭제');
  await wait(80);
  const countAfterDel = await js(`document.querySelectorAll('.ve-clip').length`);
  expect('메뉴의 삭제로 클립 하나 줆', countAfterDel, countBeforeDel - 1);

  section('7) 트랙 헤드 우클릭 — 이름변경/색변경/숨기기/PIP/삭제 목록');
  await rightClick(js, '.ve-head');
  await wait(80);
  const trackLabels = JSON.parse(await menuLabels(js));
  expect('이름 변경 항목 있음', trackLabels.includes('이름 변경'), true);
  expect('색 변경 항목 있음', trackLabels.includes('색 변경'), true);
  expect('숨기기 항목 있음(아직 안 숨겨짐)', trackLabels.includes('숨기기'), true);
  expect('위치/크기(PIP) 항목 있음(영상 트랙)', trackLabels.includes('위치/크기(PIP)'), true);
  expect('트랙 삭제 항목 있음', trackLabels.includes('트랙 삭제'), true);

  section('8) 메뉴의 숨기기 클릭 — 실제로 트랙이 숨겨지고, 다시 열면 "보이기"로 바뀜');
  await clickMenuItem(js, '숨기기');
  await wait(80);
  expect('트랙 헤드에 숨김 표시(on 클래스)', await js(`document.querySelector('.ve-hide')?.classList.contains('on')`), true);
  await rightClick(js, '.ve-head');
  await wait(80);
  const trackLabels2 = JSON.parse(await menuLabels(js));
  expect('숨긴 뒤엔 "보이기"로 바뀜', trackLabels2.includes('보이기'), true);
  expect('"숨기기" 문구는 더 이상 없음', trackLabels2.includes('숨기기'), false);
  await clickMenuItem(js, '보이기');   // 원상복구
  await wait(80);

  section('9) 메뉴의 트랙 삭제 — 실제로 트랙이 사라짐');
  await rightClick(js, '.ve-head');
  await wait(80);
  await clickMenuItem(js, '트랙 삭제');
  await wait(80);
  expect('트랙이 사라짐', await js(`document.querySelectorAll('.ve-lane').length`), 0);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
