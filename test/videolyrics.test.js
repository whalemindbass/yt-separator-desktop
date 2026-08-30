'use strict';
// 가사 타이밍 맞추기 — 재생선(플레이헤드) 기준으로 Enter 를 누를 때마다 "지금 armed 된 줄"이
// 그 순간부터 시작한다고 찍히고 다음 줄로 넘어간다(카라오케 타이밍 툴 방식). 줄 수만큼 다
// 찍으면 텍스트 트랙에 자막 클립으로 자동 생성된다. SRT 내보내기는 그 결과(텍스트 클립)를
// 표준 자막 파일로 저장한다 — 둘 다 실제 DOM 조작(눈금자 클릭으로 재생선 이동 + keydown)과
// 실제 파일 IO 로 검증한다(코드만 읽어서는 타이밍 계산이 맞는지 알 수 없다).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-velyrics-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-velyrics-'));
const VIDEO = path.join(TMP, 'bg.mp4');
const SRT_OUT = path.join(TMP, 'out.srt');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:duration=10:rate=10', VIDEO], { stdio: 'ignore' });
if (!fs.existsSync(VIDEO)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function seekViaRuler(js, sec, pxPerSec) {
  return js(`(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    const ev = new PointerEvent('pointerdown', { clientX: rect.left + ${sec} * ${pxPerSec}, clientY: rect.top + 5, bubbles: true });
    ruler.dispatchEvent(ev);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  })(); true`);
}
function pressEnter(js) {
  return js(`document.querySelector('.video-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) 배경 영상 임포트(재생선을 옮길 타임라인이 필요)');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [VIDEO] });
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  const pxPerSec = await js(`(() => {
    const el = document.querySelector('.ve-clip:not(.audio):not(.text)');
    return el ? parseFloat(el.style.width) / 10 : 40;
  })()`);

  section('2) "가사" 모달 열고 3줄 붙여넣기 → 타이밍 시작');
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(100);
  const modalOpen = await js(`!document.getElementById('ve-modal').hidden`);
  expect('모달이 열림', modalOpen, true);
  await js(`(() => {
    const ta = document.getElementById('ve-lyric-text');
    ta.value = '첫째 줄\\n둘째 줄\\n셋째 줄';
  })(); true`);
  await js(`document.getElementById('ve-lyric-start').click(); true`);
  await wait(100);
  const timingUi = await js(`!!document.querySelector('.ve-lyric-list')`);
  expect('타이밍 모드로 전환(줄 목록이 보임)', timingUi, true);

  section('3) 재생선을 1초 → Enter(첫째 줄 시작), 3초 → Enter(둘째 줄 시작), 6초 → Enter(셋째 줄 시작·자동 완료)');
  await seekViaRuler(js, 1, pxPerSec);
  await pressEnter(js);
  await wait(80);
  await seekViaRuler(js, 3, pxPerSec);
  await pressEnter(js);
  await wait(80);
  await seekViaRuler(js, 6, pxPerSec);
  await pressEnter(js);
  await wait(200);

  const modalClosedAfter = await js(`document.getElementById('ve-modal').hidden`);
  expect('세 번째(마지막 줄) Enter 로 자동 완료 — 모달이 닫힘', modalClosedAfter, true);

  const clips = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.ve-clip.text')].map(el => ({
    left: parseFloat(el.style.left), width: parseFloat(el.style.width), label: el.querySelector('.ve-clip-lbl')?.textContent,
  })))`));
  expect('자막 클립 3개 생성됨', clips.length, 3);
  const byLeft = clips.slice().sort((a, b) => a.left - b.left);
  near('첫째 줄 시작 ≈ 1초', byLeft[0].left / pxPerSec, 1, 0.15);
  near('첫째 줄 길이 ≈ 2초(다음 줄 시작까지)', byLeft[0].width / pxPerSec, 2, 0.15);
  expect('첫째 줄 내용', byLeft[0].label, '첫째 줄');
  near('둘째 줄 시작 ≈ 3초', byLeft[1].left / pxPerSec, 3, 0.15);
  near('둘째 줄 길이 ≈ 3초(다음 줄 시작까지)', byLeft[1].width / pxPerSec, 3, 0.15);
  expect('둘째 줄 내용', byLeft[1].label, '둘째 줄');
  near('셋째(마지막) 줄 시작 ≈ 6초', byLeft[2].left / pxPerSec, 6, 0.15);
  near('마지막 줄 길이 = 기본 3초(다음 줄이 없어서)', byLeft[2].width / pxPerSec, 3, 0.15);
  expect('셋째 줄 내용', byLeft[2].label, '셋째 줄');

  section('4) Esc 로 취소 — 자막이 추가로 안 생겨야 함');
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(100);
  await js(`(() => { document.getElementById('ve-lyric-text').value = '취소될 줄'; })(); true`);
  await js(`document.getElementById('ve-lyric-start').click(); true`);
  await wait(100);
  await js(`document.querySelector('.video-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await wait(100);
  const afterCancelCount = await js(`document.querySelectorAll('.ve-clip.text').length`);
  expect('취소하면 자막 클립이 늘지 않음(여전히 3개)', afterCancelCount, 3);
  const modalClosedAfterCancel = await js(`document.getElementById('ve-modal').hidden`);
  expect('취소 후 모달도 닫힘', modalClosedAfterCancel, true);

  section('5) SRT로 내보내기 — 표준 타임코드 형식으로 실제 파일에 저장되는지');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: SRT_OUT });
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(100);
  await js(`document.getElementById('ve-lyric-srt').click(); true`);
  for (let i = 0; i < 30; i++) { if (fs.existsSync(SRT_OUT)) break; await wait(200); }
  expect('SRT 파일이 실제로 생김', fs.existsSync(SRT_OUT), true);
  const srt = fs.readFileSync(SRT_OUT, 'utf8');
  expect('첫 블록 번호 1', /^1\r?\n/.test(srt), true);
  expect('첫째 줄 타임코드(00:00:01,000 --> 00:00:03,000)', srt.includes('00:00:01,000 --> 00:00:03,000'), true);
  expect('첫째 줄 텍스트 포함', srt.includes('첫째 줄'), true);
  expect('마지막 줄(셋째) 타임코드(00:00:06,000 --> 00:00:09,000)', srt.includes('00:00:06,000 --> 00:00:09,000'), true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
