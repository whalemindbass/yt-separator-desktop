'use strict';
// 가사 타이밍 맞추기 — 재생선(플레이헤드) 기준으로 Enter 를 누를 때마다 "지금 armed 된 줄"이
// 그 순간부터 시작한다고 찍히고 다음 줄로 넘어간다(카라오케 타이밍 툴 방식). 줄 수만큼 다
// 찍으면 텍스트 트랙에 자막 클립으로 자동 생성된다. SRT 내보내기는 그 결과(텍스트 클립)를
// 표준 자막 파일로 저장한다 — 둘 다 실제 DOM 조작(눈금자 클릭으로 재생선 이동 + keydown)과
// 실제 파일 IO 로 검증한다(코드만 읽어서는 타이밍 계산이 맞는지 알 수 없다).
//
// 패널은 화면을 덮는 모달이 아니라 미리보기 오른쪽에 나란히 붙는 도크다("배경이 어두우니까
// 어떻게 쓰는지 모를 수 있음" 피드백 — 재생 중에 영상을 보면서 눌러야 하는데 모달이 그
// 화면 자체를 가리면 못 쓴다) — 열려 있어도 미리보기가 계속 보이는지도 실측 확인한다.
// "한 번에 보여줄 줄 수"(1~3)로 여러 줄을 한 자막 덩어리로 묶을 수도 있다.

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
function panelHidden(js) { return js(`document.getElementById('ve-lyric-panel').hidden`); }

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

  section('2) "가사" 패널 — 모달이 아니라 미리보기 옆 도크. 열려 있어도 미리보기가 안 가려짐');
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(100);
  expect('패널이 열림', await panelHidden(js), false);
  const previewStillVisible = await js(`(() => {
    const prev = document.getElementById('ve-preview-wrap').getBoundingClientRect();
    const panel = document.getElementById('ve-lyric-panel').getBoundingClientRect();
    // 도크라면 미리보기 폭이 그대로 남아있고(0이 아님) 패널이 그 오른쪽에 나란히 있다.
    return prev.width > 0 && panel.left >= prev.right - 1;
  })()`);
  expect('패널이 미리보기를 덮지 않고 오른쪽에 나란히 붙음', previewStillVisible, true);
  await js(`document.getElementById('ve-lyrics').click(); true`);   // 토글로 다시 닫기
  await wait(80);
  expect('같은 버튼을 다시 누르면 닫힘(토글)', await panelHidden(js), true);

  section('3) 3줄 붙여넣기 → 타이밍 시작(줄당 1개, 기본값)');
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(100);
  await js(`(() => {
    const ta = document.getElementById('ve-lyric-text');
    ta.value = '첫째 줄\\n둘째 줄\\n셋째 줄';
  })(); true`);
  await js(`document.getElementById('ve-lyric-start').click(); true`);
  await wait(100);
  const timingUi = await js(`!!document.querySelector('.ve-lyric-list')`);
  expect('타이밍 모드로 전환(줄 목록이 보임)', timingUi, true);

  section('4) 재생선을 1초 → Enter(첫째 줄 시작), 3초 → Enter(둘째 줄 시작), 6초 → Enter(셋째 줄 시작·자동 완료)');
  await seekViaRuler(js, 1, pxPerSec);
  await pressEnter(js);
  await wait(80);
  await seekViaRuler(js, 3, pxPerSec);
  await pressEnter(js);
  await wait(80);
  await seekViaRuler(js, 6, pxPerSec);
  await pressEnter(js);
  await wait(200);

  expect('세 번째(마지막 줄) Enter 로 자동 완료 — 패널이 닫힘', await panelHidden(js), true);

  const clips = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.ve-clip.text')].map(el => ({
    left: parseFloat(el.style.left), width: parseFloat(el.style.width), label: el.querySelector('.ve-clip-lbl')?.textContent,
  })))`));
  expect('줄당 1개 — 자막 클립 3개 생성됨', clips.length, 3);
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

  section('5) Esc 로 취소 — 자막이 추가로 안 생겨야 함');
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(100);
  await js(`(() => { document.getElementById('ve-lyric-text').value = '취소될 줄'; })(); true`);
  await js(`document.getElementById('ve-lyric-start').click(); true`);
  await wait(100);
  await js(`document.querySelector('.video-body').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await wait(100);
  const afterCancelCount = await js(`document.querySelectorAll('.ve-clip.text').length`);
  expect('취소하면 자막 클립이 늘지 않음(여전히 3개)', afterCancelCount, 3);
  expect('취소 후 패널도 닫힘', await panelHidden(js), true);

  section('6) 닫기(✕) 버튼 — 다시 열었다가 그 버튼으로 닫히는지');
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(80);
  expect('다시 열림', await panelHidden(js), false);
  await js(`document.getElementById('ve-lyric-close').click(); true`);
  await wait(80);
  expect('✕ 버튼으로 닫힘', await panelHidden(js), true);

  section('7) "한 번에 보여줄 줄 수"=2 — Enter 한 번에 2줄씩 통째로 넘어감(4줄 → Enter 2번만)');
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(100);
  await js(`(() => { document.getElementById('ve-lyric-lpc').value = '2';
    document.getElementById('ve-lyric-lpc').dispatchEvent(new Event('change', { bubbles: true })); })(); true`);
  await js(`(() => { document.getElementById('ve-lyric-text').value = 'A줄\\nB줄\\nC줄\\nD줄'; })(); true`);
  await js(`document.getElementById('ve-lyric-start').click(); true`);
  await wait(100);
  const hint2 = await js(`document.querySelector('.ve-lyric-hint')?.textContent`);
  expect('안내 문구가 "2줄씩" 넘어간다고 알려줌', hint2?.includes('2줄'), true);
  await seekViaRuler(js, 10, pxPerSec); await pressEnter(js); await wait(80);   // A+B 덩어리
  const curAfter1 = await js(`[...document.querySelectorAll('.ve-lyric-row.cur')].map(el => el.querySelector('.ve-lyric-txt').textContent)`);
  expect('첫 Enter 한 번으로 다음 덩어리(C,D 두 줄)가 한꺼번에 강조됨', curAfter1, ['C줄', 'D줄']);
  await seekViaRuler(js, 15, pxPerSec); await pressEnter(js); await wait(200);  // C+D 덩어리(마지막 → 자동 완료)

  const grouped = JSON.parse(await js(`JSON.stringify([...document.querySelectorAll('.ve-clip.text')].map(el => ({
    left: parseFloat(el.style.left), width: parseFloat(el.style.width),
  })))`));
  const newOnes = grouped.filter(c => c.left >= 9 * pxPerSec).sort((a, b) => a.left - b.left);
  expect('4줄을 2줄씩 묶어서 자막 2개만 새로 생김(Enter 2번으로 끝)', newOnes.length, 2);
  near('첫 덩어리(A+B) 시작 ≈ 10초(첫 Enter 시각)', newOnes[0].left / pxPerSec, 10, 0.15);
  near('첫 덩어리 길이 ≈ 5초(둘째 덩어리 Enter 시각까지)', newOnes[0].width / pxPerSec, 5, 0.15);
  near('둘째 덩어리(C+D) 시작 ≈ 15초(둘째 Enter 시각)', newOnes[1].left / pxPerSec, 15, 0.15);
  near('마지막 덩어리 길이 = 기본 3초(다음이 없어서)', newOnes[1].width / pxPerSec, 3, 0.15);

  section('8) SRT로 내보내기 — 표준 타임코드 형식으로 실제 파일에 저장되는지(그룹 자막의 여러 줄도 포함)');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: SRT_OUT });
  await js(`document.getElementById('ve-lyrics').click(); true`);
  await wait(100);
  await js(`document.getElementById('ve-lyric-srt').click(); true`);
  for (let i = 0; i < 30; i++) { if (fs.existsSync(SRT_OUT)) break; await wait(200); }
  expect('SRT 파일이 실제로 생김', fs.existsSync(SRT_OUT), true);
  const srt = fs.readFileSync(SRT_OUT, 'utf8');
  expect('첫 블록 번호 1', /^1\r?\n/.test(srt), true);
  expect('줄당 1개로 찍은 첫째 줄 타임코드(00:00:01,000 --> 00:00:03,000)', srt.includes('00:00:01,000 --> 00:00:03,000'), true);
  expect('묶은 덩어리(A줄+B줄) 두 줄이 한 블록 안에 같이 있음', srt.includes('A줄\r\nB줄') || srt.includes('A줄\nB줄'), true);
  expect('묶은 덩어리 타임코드(00:00:10,000 --> 00:00:15,000)', srt.includes('00:00:10,000 --> 00:00:15,000'), true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
