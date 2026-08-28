'use strict';
// 색보정(밝기/대비/채도) — 버튼→팝오버 슬라이더, 미리보기 CSS filter 반영, 실제 내보내기
// 결과물에서 밝기/채도가 진짜로 바뀌는지(회색 중간톤 소스로) 픽셀 검증.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vecolor-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vecolor-'));
// 중간 회색(128,128,128에 가깝게) — 밝기 변화를 양쪽(밝게/어둡게) 다 관찰하기 좋다.
const SRC = path.join(TMP, 'gray.mp4');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=gray:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function frameBrightness(file, t) {
  const raw = file + `.${t}.raw`;
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i];
  return sum / buf.length;
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트 + 선택 — 색보정 버튼이 선택 전엔 꺼져 있다가 켜짐');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  expect('선택 전 버튼 비활성', await js(`document.getElementById('ve-color').disabled`), true);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await js(`(() => {
    document.querySelector('.ve-clip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(100);
  expect('선택 후 버튼 활성', await js(`document.getElementById('ve-color').disabled`), false);

  section('2) 밝기 +60 — 팝오버 슬라이더 조작, 버튼 on, 미리보기 CSS filter 반영');
  await js(`document.getElementById('ve-color').click(); true`);
  await wait(100);
  expect('팝오버 열림', await js(`!!document.querySelector('.ve-color-pop')`), true);
  await js(`(() => {
    const el = document.getElementById('cc-b');
    el.value = 60;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  expect('색보정 버튼 on 표시', await js(`document.getElementById('ve-color').classList.contains('on')`), true);
  const filt = await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.filter`);
  expect('레이어에 CSS filter brightness(1.6) 반영', filt.includes('brightness(1.6)'), true);

  section('3) 내보내기 — 실제 결과물이 소스(회색)보다 밝아졌는가');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    // "확실히 밝아졌다" 정도의 느슨한 문턱값만 보면 안 된다 — ffmpeg eq=brightness 는
    // (겉보기와 달리) 배율이 아니라 -1~1 오프셋을 그대로 더하는 값이라, CSS brightness()
    // 와 같은 슬라이더 값을 넣어도 훨씬 과하게(거의 흰색으로 날아가도록) 밝아지는 버그가
    // 실제로 있었다 — 그 버그는 이 문턱값 검사를 그냥 통과했을 것이다. 미리보기가 쓰는
    // CSS brightness(1.6) 과 "정확히 같은 배율"인지(±허용오차) 직접 계산해서 비교한다.
    const srcB = frameBrightness(SRC, 0.5);
    const outB = frameBrightness(OUT, 0.5);
    const expected = Math.min(255, srcB * 1.6);   // CSS brightness(1.6) 와 같은 배율
    near('밝기 +60 결과물이 CSS brightness(1.6) 과 같은 배율(과하게 날아가지 않음)', outB, expected, 12);
  }

  section('4) 초기화 버튼 — 팝오버 값 되돌리고 버튼 off');
  await js(`document.getElementById('cc-reset').click(); true`);
  await wait(100);
  expect('색보정 버튼 off', await js(`document.getElementById('ve-color').classList.contains('on')`), false);
  expect('필터 비워짐', await js(`document.querySelector('#ve-preview video:not([hidden])')?.style.filter`), '');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
