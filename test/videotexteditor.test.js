'use strict';
// 텍스트/타이틀 오버레이 — "+텍스트" 툴바 버튼부터 실제 UI 로 눌러가며 확인한다.
// 1) 클립 생성 + 편집 팝오버가 곧바로 열리는지, 2) 입력한 값이 타임라인 라벨/미리보기
// 오버레이에 반영되는지, 3) 프로젝트 저장 파일에 실제로 남는지, 4) 영상 클립을 하나도
// 안 넣은 순수 텍스트만 있는 프로젝트도 진짜 export 버튼으로 내보내지는지(타이틀 카드)
// — main.js 필터그래프 쪽 픽셀 검증은 videotext.test.js 에서 이미 끝냈으니, 여긴 그
// main.js 를 실제로 호출하는 렌더러 경로(버튼 클릭→buildEDL→export)만 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetexted-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetexted-'));

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  const projFile = path.join(app.getPath('userData'), 'videoProject.json');
  const readSaved = () => { try { return JSON.parse(fs.readFileSync(projFile, 'utf-8')); } catch { return null; } };

  section('1) "+텍스트" — 트랙+클립 생성, 편집 팝오버 바로 열림, 기본값 확인');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-text').click(); true`);
  await wait(150);
  expect('텍스트 클립 1개 생김', await js(`document.querySelectorAll('.ve-clip.text').length`), 1);
  expect('편집 팝오버 열림', await js(`!!document.querySelector('.ve-text-pop')`), true);
  expect('기본 가로 위치 50%', await js(`document.getElementById('tx-x').value`), '50');
  expect('기본 세로 위치 85%', await js(`document.getElementById('tx-y').value`), '85');
  expect('기본 크기 42', await js(`document.getElementById('tx-size').value`), '42');

  section('2) 내용/위치/크기/색 편집 — 타임라인 라벨 + 미리보기 오버레이에 바로 반영');
  await js(`(() => {
    const ta = document.getElementById('tx-content');
    ta.value = '자막 테스트';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(80);
  expect('타임라인 라벨이 입력한 내용으로 바뀜', await js(`document.querySelector('.ve-clip.text .ve-clip-lbl')?.textContent`), '자막 테스트');
  expect('미리보기에 같은 텍스트가 보임(재생선이 클립 구간 안)', await js(`document.querySelector('.ve-text-item')?.textContent`), '자막 테스트');

  await js(`(() => {
    document.getElementById('tx-size').value = '60';
    document.getElementById('tx-size').dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('tx-color').value = '#ff00ff';
    document.getElementById('tx-color').dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(80);
  // clip.size 는 "출력 해상도 기준 px" 라 미리보기 CSS font-size 는 화면 축소 배율만큼
  // 줄어서 렌더된다(videotextsize.test.js 에서 이 배율 자체를 검증함) — 여긴 그 배율을
  // 반영한 값으로 실제 반영됐는지만 본다.
  const fsInfo = await js(`(() => {
    const host = document.getElementById('ve-preview');
    const el = document.querySelector('.ve-text-item');
    return JSON.stringify({ previewW: host.clientWidth, css: parseFloat(getComputedStyle(el).fontSize) });
  })()`);
  const { previewW: fsPreviewW, css: fsCss } = JSON.parse(fsInfo);
  near('미리보기 폰트 크기 반영(60 × 화면축소배율)', fsCss, 60 * (fsPreviewW / 1280), 0.5);
  expect('미리보기 색상 반영', await js(`document.querySelector('.ve-text-item')?.style.color`), 'rgb(255, 0, 255)');

  section('3) 저장 파일에 텍스트 클립 필드가 실제로 남는가');
  await wait(1000);   // scheduleSave 디바운스(600ms)
  const saved = readSaved();
  const savedClip = (saved?.clips || []).find(c => c.isText);
  expect('저장된 텍스트 클립 있음', !!savedClip, true);
  expect('내용 저장됨', savedClip?.text, '자막 테스트');
  expect('크기 저장됨', savedClip?.size, 60);
  expect('색상 저장됨', savedClip?.color, '#ff00ff');
  expect('트랙 kind=text 로 저장됨', (saved?.tracks || []).some(t => t.kind === 'text'), true);

  section('4) 팝오버 바깥 클릭하면 닫힘');
  await js(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 })); true`);
  await wait(50);
  expect('팝오버 닫힘', await js(`!document.querySelector('.ve-text-pop')`), true);

  section('5) 영상 클립 없이 텍스트만 있는 프로젝트 — 실제 내보내기 버튼으로 타이틀 카드 export');
  const OUT = path.join(TMP, 'titlecard.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('영상 클립 없이도 텍스트 클립만으로 export 성공', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const dur = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', OUT], { encoding: 'utf-8' }).stdout.trim();
    expect('길이 ≈ 텍스트 클립 길이(3초)', Math.abs(parseFloat(dur) - 3) < 0.5, true);
    const raw = path.join(TMP, 'frame.rgb');
    spawnSync(FFMPEG, ['-y', '-i', OUT, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { stdio: 'ignore' });
    const d = fs.readFileSync(raw);
    let magenta = 0;
    for (let i = 0; i < d.length; i += 3) { if (d[i] > 200 && d[i + 1] < 80 && d[i + 2] > 200) magenta++; }
    expect('자홍색(#ff00ff) 텍스트 픽셀 실제로 있음', magenta > 20, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
