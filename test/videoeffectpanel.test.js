'use strict';
// 미리보기 왼쪽 효과 체인 패널 — 실제 DOM 클릭/입력으로 추가·재배치·on/off·삭제가
// 저장 파일(videoProject.json)의 clip.effects[] 에 정확히 반영되는지 검증한다.
// (효과 자체의 픽셀 정확도는 videoeffects.test.js 에서 이미 검증됨 — 여긴 UI→데이터만.)

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefxpanel-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefxpanel-'));
const SRC = path.join(TMP, 'white.mp4');
const W = 320, H = 240;

// 영상+오디오 둘 다 있는 파일 — 임포트하면 영상 클립(효과 대상)과 짝지어진 오디오 전용
// 클립(효과 비활성 대상)이 동시에 생긴다.
spawnSync(FFMPEG, ['-y',
  '-f', 'lavfi', '-i', `color=white:size=${W}x${H}:duration=3:rate=10`,
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function selectClip(selector, pid) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: ${pid} }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${pid} }));
    return true;
  })()`;
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  const projFile = path.join(app.getPath('userData'), 'videoProject.json');
  const readSaved = () => { try { return JSON.parse(fs.readFileSync(projFile, 'utf-8')); } catch { return null; } };

  section('1) 선택 전 — 패널이 빈 상태, 추가 버튼 비활성');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  expect('선택 전 패널 텍스트 = 빈 상태 안내', await js(`document.querySelector('#ve-fx-body .ve-fx-empty')?.textContent`), '클립을 선택하세요');
  expect('선택 전 추가 버튼 비활성', await js(`document.getElementById('ve-fx-add-btn').disabled`), true);

  section('2) 임포트 + 영상 클립 선택 — 빈 체인 상태, 추가 버튼 활성');
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  expect('영상+오디오 클립 둘 다 생김', await js(`document.querySelectorAll('.ve-clip').length`), 2);
  expect('영상 클립 선택됨', await js(selectClip('.ve-clip:not(.audio)', 1)), true);
  await wait(150);
  expect('빈 체인 안내', await js(`document.querySelector('#ve-fx-body .ve-fx-empty')?.textContent`), '적용된 효과가 없습니다');
  expect('선택 후 추가 버튼 활성', await js(`document.getElementById('ve-fx-add-btn').disabled`), false);

  section('3) 밝기 효과 추가 — 행 1개, 슬라이더로 값 조절');
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(100);
  expect('추가 메뉴 열림', await js(`!document.getElementById('ve-fx-add-menu').hidden`), true);
  await js(`(() => {
    const items = [...document.querySelectorAll('.ve-fx-add-item')];
    const btn = items.find(b => b.textContent === '밝기');
    btn.click();
  })(); true`);
  await wait(100);
  expect('행 1개 생김', await js(`document.querySelectorAll('.ve-fx-row').length`), 1);
  expect('메뉴 닫힘', await js(`document.getElementById('ve-fx-add-menu').hidden`), true);
  await js(`(() => {
    const slider = document.querySelector('.ve-fx-row .ve-fx-slider');
    slider.value = 40;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  expect('값 표시가 슬라이더 입력을 따라감', await js(`document.querySelector('.ve-fx-row .ve-fx-val')?.textContent`), '+40');
  await wait(1000);   // scheduleSave 디바운스(600ms)
  let saved = readSaved();
  expect('저장된 클립 effects[0] = brightness', saved?.clips?.[0]?.effects?.[0]?.type, 'brightness');
  expect('저장된 brightness 값 = 40(슬라이더로 조절)', saved?.clips?.[0]?.effects?.[0]?.value, 40);
  expect('저장된 brightness enabled = true', saved?.clips?.[0]?.effects?.[0]?.enabled, true);

  section('4) 대비 효과 추가 — 추가한 순서대로 체인에 쌓임(밝기, 대비)');
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(100);
  await js(`(() => {
    const items = [...document.querySelectorAll('.ve-fx-add-item')];
    const btn = items.find(b => b.textContent === '대비');
    btn.click();
  })(); true`);
  await wait(100);
  expect('행 2개', await js(`document.querySelectorAll('.ve-fx-row').length`), 2);
  expect('첫 행 = 밝기(먼저 추가)', await js(`document.querySelectorAll('.ve-fx-row .ve-fx-name')[0]?.textContent`), '밝기');
  expect('둘째 행 = 대비(나중 추가)', await js(`document.querySelectorAll('.ve-fx-row .ve-fx-name')[1]?.textContent`), '대비');
  await wait(1000);
  saved = readSaved();
  let types = (saved?.clips?.[0]?.effects || []).map(e => e.type);
  expect('저장된 순서 = [brightness, contrast]', types.join(','), 'brightness,contrast');

  section('5) 재배치 — 첫 행(밝기)을 아래로 이동 → [대비, 밝기]로 바뀜');
  await js(`(() => {
    const row = document.querySelectorAll('.ve-fx-row')[0];
    row.querySelector('.ve-fx-mv[data-dir="1"]').click();
  })(); true`);
  await wait(100);
  expect('첫 행 = 대비(재배치 후)', await js(`document.querySelectorAll('.ve-fx-row .ve-fx-name')[0]?.textContent`), '대비');
  expect('둘째 행 = 밝기(재배치 후)', await js(`document.querySelectorAll('.ve-fx-row .ve-fx-name')[1]?.textContent`), '밝기');
  await wait(1000);
  saved = readSaved();
  types = (saved?.clips?.[0]?.effects || []).map(e => e.type);
  expect('저장된 순서도 실제로 바뀜 = [contrast, brightness]', types.join(','), 'contrast,brightness');

  section('6) 밝기(현재 둘째 행) 끄기 — enabled:false 로 저장되지만 목록엔 그대로 남음');
  await js(`(() => {
    const row = document.querySelectorAll('.ve-fx-row')[1];
    row.querySelector('.ve-fx-onoff').click();
  })(); true`);
  await wait(100);
  expect('행에 off 클래스 붙음', await js(`document.querySelectorAll('.ve-fx-row')[1]?.classList.contains('off')`), true);
  expect('토글해도 행 개수는 그대로(2개)', await js(`document.querySelectorAll('.ve-fx-row').length`), 2);
  await wait(1000);
  saved = readSaved();
  const effs = saved?.clips?.[0]?.effects || [];
  expect('여전히 2개 항목(삭제되지 않음)', effs.length, 2);
  const brightnessEntry = effs.find(e => e.type === 'brightness');
  expect('밝기 enabled = false 로 저장됨', brightnessEntry?.enabled, false);
  expect('대비는 그대로 enabled = true', effs.find(e => e.type === 'contrast')?.enabled, true);

  section('7) 대비(첫 행) 삭제 — 체인이 1개로 줄어듦');
  await js(`(() => {
    const row = document.querySelectorAll('.ve-fx-row')[0];
    row.querySelector('.ve-fx-del').click();
  })(); true`);
  await wait(100);
  expect('행 1개로 줆', await js(`document.querySelectorAll('.ve-fx-row').length`), 1);
  expect('남은 행 = 밝기', await js(`document.querySelectorAll('.ve-fx-row .ve-fx-name')[0]?.textContent`), '밝기');
  await wait(1000);
  saved = readSaved();
  expect('저장된 effects 도 1개로 줆', (saved?.clips?.[0]?.effects || []).length, 1);
  expect('남은 항목 = brightness', saved?.clips?.[0]?.effects?.[0]?.type, 'brightness');

  section('8) 오디오 전용(짝) 클립 선택 — 비활성 안내로 바뀌고, 이전 클립의 행이 남아있지 않음');
  expect('오디오 클립 선택됨', await js(selectClip('.ve-clip.audio', 2)), true);
  await wait(150);
  expect('오디오 전용 안내 문구', await js(`document.querySelector('#ve-fx-body .ve-fx-empty')?.textContent`), '오디오 클립에는 효과를 적용할 수 없습니다');
  expect('추가 버튼 다시 비활성', await js(`document.getElementById('ve-fx-add-btn').disabled`), true);
  expect('이전 클립의 효과 행이 남아있지 않음(stale 데이터 없음)', await js(`document.querySelectorAll('.ve-fx-row').length`), 0);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
