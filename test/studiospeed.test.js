'use strict';
// 스튜디오 — 스템 일괄 재생 속도 조절(요청: "속도 느리게 하면 클립 길이도 늘어나도록").
// 배속(playbackRate) 흉내가 아니라 진짜 타임스트레치인지를 확인해야 하므로, 그 결과인
// "전체 길이(_dur, 룰러/타임라인 폭에 그대로 반영됨)가 실제로 늘어나는지"를 잰다.
// library.json 을 직접 심어서(main.js 가 실제로 읽는 파일) 진짜 곡 하나를 스튜디오에
// 불러온 뒤, 배속 50%로 내리면 폭이 2배가 되고 100%로 되돌리면 원래대로 오는지 확인한다.
// 실제 오디오 장치+엔진이 있어야 해서 bootMain 을 쓴다(디바이스 민감 — run.js 가 순차 실행).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-stspeed-profile-'));
app.setPath('userData', PROFILE);

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-stspeed-'));
// fullSec()/timelineW() 은 "내용 길이 vs 화면 폭" 중 큰 쪽을 쓴다(짧은 곡이어도 타임라인이
// 화면을 꽉 채우게) — 곡이 너무 짧으면 속도를 바꿔 길이가 늘어나도 여전히 "화면 폭" 쪽이
// 이겨서 룰러 폭에 차이가 안 보인다. 60초로 두고(오프라인 타임스트레치라 테스트 시간
// 안에는 끝난다) 확대(zoom-in)까지 몇 번 해서 확실히 "내용 길이" 쪽이 이기게 만든다.
const DUR = 60;
const VIDEO = path.join(TMP, 'song.mp4');
const STEMS = {
  drums: path.join(TMP, 'drums.wav'),
  bass: path.join(TMP, 'bass.wav'),
  vocals: path.join(TMP, 'vocals.wav'),
  other: path.join(TMP, 'other.wav'),
};
const FREQ = { drums: 80, bass: 110, vocals: 440, other: 660 };

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=320x240:duration=${DUR}:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', VIDEO], { stdio: 'ignore' });
for (const [name, file] of Object.entries(STEMS)) {
  spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `sine=frequency=${FREQ[name]}:duration=${DUR}`,
    '-ac', '2', '-c:a', 'pcm_s16le', file], { stdio: 'ignore' });
}
if (!fs.existsSync(VIDEO) || Object.values(STEMS).some(f => !fs.existsSync(f))) {
  throw new Error('ffmpeg 로 테스트 픽스처 생성 실패');
}

// main.js 가 실제로 읽는 library.json 을 직접 심는다(라이브러리 UI/분리 과정 없이).
fs.writeFileSync(path.join(PROFILE, 'library.json'), JSON.stringify({
  items: [{
    id: 'test-song-1', name: '속도테스트곡', videoPath: VIDEO, stemPaths: STEMS,
    modelKey: '4stem', createdAt: Date.now(),
  }],
}, null, 2));

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 2000 });

  section('1) 스튜디오 진입(엔진 자동 시작) + 준비 대기');
  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);
  const engineOn = () => js(`document.getElementById('st-engine-dot')?.classList.contains('on')`);
  let ready = false;
  for (let i = 0; i < 40; i++) { if (await engineOn()) { ready = true; break; } await wait(300); }
  expect('엔진 준비됨', ready, true);
  if (!ready) {
    console.log('  DEBUG dot classes:', await js(`document.getElementById('st-engine-dot')?.className`));
    finish(eApp); return;
  }
  await wait(300);
  await js('document.getElementById("daw-boot").hidden = true; true');

  section('2) 라이브러리 새로고침 후 스튜디오에서 곡 불러오기');
  await js(`document.querySelector('.tab[data-view="library"]').click(); true`);
  await wait(500);
  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('st-load-song').click(); true`);
  await wait(200);
  await js(`document.querySelector('.daw-modal-item')?.click(); true`);
  let loaded = false;
  for (let i = 0; i < 40; i++) {
    if (await js(`!document.getElementById('daw-vplay').hidden`)) { loaded = true; break; }
    await wait(300);
  }
  expect('곡 로드됨(영상 재생 버튼 나타남 = _dur 잡힘)', loaded, true);

  // 확대해서 "내용 길이"가 "화면 폭 채우기" 최소값을 확실히 이기게 만든다(위 DUR 주석 참고).
  for (let i = 0; i < 6; i++) await js(`document.getElementById('st-zoom-in')?.click(); true`);
  await wait(300);

  const rulerW = () => js(`parseFloat(document.getElementById('daw-ruler').style.width) || 0`);
  const w100 = await rulerW();
  expect('초기 타임라인 폭이 0보다 큼', w100 > 0, true);

  // 버튼(단축키 왼쪽) → 팝업에서 값 정하고 "처리 시작" → 진행바 → 완료. 요청대로 값만
  // 바꾼다고 바로 처리되면 안 되고, 반드시 시작 버튼을 눌러야 돈다.
  const openModal = async () => {
    expect('스템 속도 버튼 보임', await js(`!document.getElementById('st-speed-btn').hidden`), true);
    await js(`document.getElementById('st-speed-btn').click(); true`);
    await wait(150);
    expect('설정 화면(값+시작 버튼) 보임', await js(`!document.getElementById('stsp-setup').hidden`), true);
  };
  const setAndStart = async (pct) => {
    await js(`(() => { const el = document.getElementById('stsp-val'); el.value = ${pct}; })(); true`);
    await js(`document.getElementById('stsp-start').click(); true`);
    await wait(150);
  };
  const waitDone = async (maxMs) => {
    for (let i = 0; i < maxMs / 500; i++) {
      if (await js(`document.getElementById('daw-modal').hidden`)) return true;
      await wait(500);
    }
    return false;
  };

  section('3) 속도 50% — 값만 바꿔선 안 되고 "처리 시작"을 눌러야 돈다 + 처리 중엔 다른 조작 막힘');
  await openModal();
  await setAndStart(50);
  expect('시작 누르면 설정 화면 숨고 진행바 화면 보임', await js(`document.getElementById('stsp-progress').hidden`), false);
  expect('처리 중엔 재생 버튼도 막힘(다른 조작 불가)', await js(`document.getElementById('st-play').disabled`), true);
  expect('처리 중엔 곡 불러오기도 막힘', await js(`document.getElementById('st-load-song').disabled`), true);
  const done50 = await waitDone(90000);
  expect('처리 끝나면 팝업이 닫힘', done50, true);
  expect('처리 끝나면 재생 버튼도 다시 풀림', await js(`document.getElementById('st-play').disabled`), false);
  const w50 = await rulerW();
  near('50% 속도 — 폭이 약 2배', w50, w100 * 2, w100 * 0.2);
  expect('버튼 라벨에도 현재 속도가 붙음', await js(`document.getElementById('st-speed-btn').textContent`), '스템 속도 · 50%');

  section('4) 100%로 다시 바꾸는 도중 취소 — 50% 상태 그대로 남아야 함');
  await openModal();
  await setAndStart(100);
  await js(`document.getElementById('stsp-cancel').click(); true`);
  const doneCancel = await waitDone(90000);
  expect('취소해도 결국 팝업이 닫힘', doneCancel, true);
  expect('취소 후에도 재생 버튼 다시 풀림', await js(`document.getElementById('st-play').disabled`), false);
  const wAfterCancel = await rulerW();
  near('취소 — 폭이 50% 상태(약 2배) 그대로 유지됨(100%로 안 바뀜)', wAfterCancel, w100 * 2, w100 * 0.2);
  expect('버튼 라벨도 50% 그대로', await js(`document.getElementById('st-speed-btn').textContent`), '스템 속도 · 50%');

  section('4-1) 50% 상태로 프로젝트 저장 — .yssproj 에 speed 가 실제로 들어가는가');
  const PROJ = path.join(TMP, 'proj.yssproj');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: PROJ });
  await js(`document.getElementById('st-file-menu').click(); true`);
  await wait(150);
  await js(`[...document.querySelectorAll('.daw-dropdown button')].find(b => b.textContent.includes('프로젝트 저장'))?.click(); true`);
  let saved = false;
  for (let i = 0; i < 20; i++) { if (fs.existsSync(PROJ)) { saved = true; break; } await wait(300); }
  expect('프로젝트 파일 생성됨', saved, true);
  if (saved) {
    const savedJson = JSON.parse(fs.readFileSync(PROJ, 'utf-8'));
    near('저장된 파일의 speed 가 0.5', savedJson.speed, 0.5, 0.001);
    expect('speedBase 도 같이 저장됨(bpm 있음)', typeof savedJson.speedBase?.bpm, 'number');
  }

  section('4-2) 다른 프로젝트로 리셋 후, 방금 저장한 걸 다시 열면 속도(및 길이)가 복원돼야 함');
  await js(`document.getElementById('st-file-menu').click(); true`);
  await wait(150);
  await js(`[...document.querySelectorAll('.daw-dropdown button')].find(b => b.textContent.includes('프로젝트 닫기'))?.click(); true`);
  await wait(300);
  expect('닫은 뒤엔 스템 속도 버튼도 숨음', await js(`document.getElementById('st-speed-btn').hidden`), true);

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PROJ] });
  const reopenStartedAt = Date.now();
  await js(`document.getElementById('st-file-menu').click(); true`);
  await wait(150);
  await js(`[...document.querySelectorAll('.daw-dropdown button')].find(b => b.textContent.includes('프로젝트 열기'))?.click(); true`);
  // applyProject() 는 곡을 다시 불러온 뒤(_speed=1 로 리셋됨) speed!=1 이었으면 저장해 둔
  // speedStemPaths(이전에 늘여서 stemsDir 에 남겨 둔 파일)가 아직 있는지 먼저 본다 —
  // 있으면 재처리 없이 그대로 불러오기만 하고(빠름), 없을 때만 처음부터 다시 늘인다.
  // "재처리로 시간이 또 든다"는 신고 반영 — 여기서 빠르게 끝나는지(재처리와 확실히
  // 구분될 만큼 짧은 시간 안에) 까지 같이 잰다.
  let reopened = false;
  for (let i = 0; i < 120; i++) {
    if (await js(`document.getElementById('st-speed-btn').textContent`) === '스템 속도 · 50%') { reopened = true; break; }
    await wait(500);
  }
  const reopenMs = Date.now() - reopenStartedAt;
  expect('다시 열려서 버튼 라벨에 50% 복원됨', reopened, true);
  console.log(`  다시 열기 소요 시간: ${reopenMs}ms`);
  expect('재처리 없이 캐시된 파일을 바로 씀(재처리라면 훨씬 오래 걸림)', reopenMs < 8000, true);
  const wReopened = await rulerW();
  near('길이(룰러 폭)도 50% 속도 상태(약 2배)로 복원됨', wReopened, w100 * 2, w100 * 0.25);

  section('5) 다시 100% — 끝까지 진행하면 원래 폭으로 돌아옴');
  await openModal();
  await setAndStart(100);
  const done100 = await waitDone(90000);
  expect('처리 끝나면 팝업이 닫힘', done100, true);
  const w100b = await rulerW();
  near('100% 로 되돌리면 폭도 원래대로', w100b, w100, w100 * 0.2);
  expect('버튼 라벨도 기본으로 돌아옴(퍼센트 안 붙음)', await js(`document.getElementById('st-speed-btn').textContent`), '스템 속도');

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
