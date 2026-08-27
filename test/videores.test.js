'use strict';
// 영상 편집 — 렌더 해상도 선택(#ve-res) + 미리보기 프레임(#ve-preview) 이 실제 렌더 영역
// 비율대로 표시되는지, 고른 해상도가 실제 내보내기 결과물 크기에 그대로 반영되는지 검증.
// 소스 클립(320x240)과 다른 해상도를 일부러 골라서 "선택값이 진짜로 쓰이는지"까지 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veres-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veres-'));
const SRC = path.join(TMP, 'src.mp4');
const OUT_V = path.join(TMP, 'out_vertical.mp4');
const OUT_C = path.join(TMP, 'out_custom.mp4');

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=15',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 임포트(소스 320x240, 4:3)');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) {
    if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break;
    await wait(300);
  }

  section('2) 세로(9:16, 1080x1920) 프리셋 선택 — 미리보기 틀 비율이 즉시 바뀌어야 함');
  await js(`(() => {
    const sel = document.getElementById('ve-res');
    sel.value = '1080x1920';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  await wait(200);
  const box = await js(`(() => {
    const r = document.getElementById('ve-preview').getBoundingClientRect();
    return { w: r.width, h: r.height };
  })()`);
  near('미리보기 틀 비율이 9:16 (세로로 김)', box.w / box.h, 1080 / 1920, 0.03);
  expect('세로 프레임이 실제로 폭보다 높이가 큼', box.h > box.w, true);

  section('3) 세로 해상도로 내보내기 — 결과물이 실제로 1080x1920 인지');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_V });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_V)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT_V), true);
  if (fs.existsSync(OUT_V)) {
    const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'default=noprint_wrappers=1', OUT_V], { encoding: 'utf-8' });
    const out = r.stdout || '';
    expect('결과물 해상도가 1080x1920(소스는 320x240 이었는데도)', out.includes('width=1080') && out.includes('height=1920'), true);
  }

  section('4) 사용자 지정 640x640 — 입력칸 나타나고 내보내기에도 반영됨');
  await js(`(() => {
    const sel = document.getElementById('ve-res');
    sel.value = 'custom';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('ve-res-w').value = 640;
    document.getElementById('ve-res-w').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('ve-res-h').value = 640;
    document.getElementById('ve-res-h').dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(200);
  const customHidden = await js(`document.getElementById('ve-res-custom').hidden`);
  expect('사용자 지정 칸이 보임', customHidden, false);

  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_C });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_C)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  if (fs.existsSync(OUT_C)) {
    const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height', '-of', 'default=noprint_wrappers=1', OUT_C], { encoding: 'utf-8' });
    const out = r.stdout || '';
    expect('사용자 지정 해상도(640x640)가 결과물에 반영됨', out.includes('width=640') && out.includes('height=640'), true);
  }

  section('5) 자동 다시 선택 — 소스 클립 해상도로 되돌아감');
  await js(`(() => {
    const sel = document.getElementById('ve-res');
    sel.value = 'auto';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  await wait(200);
  const box2 = await js(`(() => {
    const r = document.getElementById('ve-preview').getBoundingClientRect();
    return { w: r.width, h: r.height };
  })()`);
  near('자동으로 돌아가면 미리보기 틀이 다시 4:3(소스 비율)', box2.w / box2.h, 320 / 240, 0.03);

  section('6) 자동 저장 — resolution 필드가 실제로 남는가');
  await js(`(() => {
    const sel = document.getElementById('ve-res');
    sel.value = '1080x1080';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  await wait(1000);
  const projFile = path.join(app.getPath('userData'), 'videoProject.json');
  let proj = null;
  try { proj = JSON.parse(fs.readFileSync(projFile, 'utf-8')); } catch {}
  expect('videoProject.json 에 resolution 1080x1080 저장됨', JSON.stringify(proj?.resolution), JSON.stringify({ w: 1080, h: 1080 }));

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
