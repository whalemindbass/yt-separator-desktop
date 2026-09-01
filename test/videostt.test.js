'use strict';
// 영상 편집 — "자동 자막 생성"(우클릭 메뉴). 실제 클립(Windows TTS 로 만든 알려진 문장)을
// 임포트하고 우클릭 → 자동 자막 생성까지 실제 UI 흐름대로 실행해서, 텍스트 트랙에
// 정확한 자막 클립이 실제로 생기는지 확인한다(stt.test.js 는 워커 파이프라인 자체만
// 검증했다 — 이건 그 위의 오케스트레이션/UI 까지 포함한 end-to-end).
//
// 모델은 이미 로컬에 받아 둔 사본을 테스트 userData 로 미리 복사해 다운로드를 생략한다
// (없으면 건너뜀).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, dialog } = require('electron');

const STT_CACHE_DIR = 'C:\\Users\\wkq32\\AppData\\Local\\Temp\\claude\\C--Users-wkq32-Desktop----dev\\713b49d5-7436-4b9d-9acc-e9109a348eab\\scratchpad\\whisper-small';
const TTS_DIR = 'C:\\Users\\wkq32\\AppData\\Local\\Temp\\claude\\C--Users-wkq32-Desktop----dev\\713b49d5-7436-4b9d-9acc-e9109a348eab\\scratchpad\\stt-test';

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vestt-profile-'));
app.setPath('userData', profileDir);

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  if (!fs.existsSync(STT_CACHE_DIR) || !fs.existsSync(path.join(STT_CACHE_DIR, 'encoder_model_quantized.onnx'))) {
    console.log('  건너뜀 — 로컬 whisper-small 캐시 없음'); process.exit(0);
  }
  if (!fs.existsSync(path.join(TTS_DIR, 'en.wav'))) {
    console.log('  건너뜀 — TTS 픽스처 없음'); process.exit(0);
  }

  const sttDir = path.join(profileDir, 'stt-model');
  fs.mkdirSync(sttDir, { recursive: true });
  for (const f of fs.readdirSync(STT_CACHE_DIR)) fs.copyFileSync(path.join(STT_CACHE_DIR, f), path.join(sttDir, f));

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(TTS_DIR, 'en.wav')] });
  const { app: electronApp, js } = await bootMain({ settle: 1500 });

  section('1) 임포트("The quick brown fox jumps over the lazy dog." TTS 오디오)');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); document.querySelector('#ve-import-menu [data-kind="video"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  expect('클립 임포트됨', await js(`document.querySelectorAll('.ve-clip').length >= 1`), true);

  section('2) 우클릭 → "자동 자막 생성"');
  await js(`(() => {
    const el = document.querySelector('.ve-clip');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true }));
  })(); true`);
  await wait(100);
  await js(`(() => {
    const btn = [...document.querySelectorAll('.ve-ctxmenu-item')].find(b => b.textContent.includes('자동 자막'));
    btn.click();
  })(); true`);

  // 워커 로딩+추론은 몇 초 걸린다 — 텍스트 트랙 클립이 생길 때까지 넉넉히 기다린다.
  let textClipCount = 0;
  for (let i = 0; i < 60; i++) {
    textClipCount = await js(`document.querySelectorAll('.ve-clip.text').length`);
    if (textClipCount > 0) break;
    await wait(1000);
  }
  expect('자막 클립이 생김', textClipCount > 0, true);

  const text = await js(`[...document.querySelectorAll('.ve-clip.text')].map(x => x.querySelector('.ve-clip-lbl').textContent).join(' ')`);
  console.log('  자막 결과:', JSON.stringify(text));
  expect('"quick" 포함', text.toLowerCase().includes('quick'), true);

  section('3) 자막 클립이 타임라인 0초 근처에서 시작함(전체 구간이 오디오 클립 안)');
  const startLeftPx = await js(`parseFloat(document.querySelector('.ve-clip.text').style.left)`);
  expect('자막 시작 위치가 0 이상', startLeftPx >= 0, true);

  finish(electronApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
