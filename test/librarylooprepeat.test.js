'use strict';
// 라이브러리(연습) 화면 A-B 구간반복 — "쓰는 법을 모르겠다"는 제보를 받고, 버튼만 있던
// 걸 재생바 아래 띠(#vc-loop-rail)를 드래그해서 만드는 방식으로 바꿨다. 실제 포인터
// 드래그(pointerdown/move/up)를 그대로 흉내 내서 A/B 값·활성화·핸들 위치까지 확인한다.
// 재생바 폭(px) 계산이 실제 재생 길이(duration)를 알아야 하므로, librarycountin.test.js
// 와 달리 실제로 디코드 가능한 파일을 스템·영상 자리에 둔다. videoPath는 <video> 가
// duration을 바로 아는 실제 mp4(wav를 그대로 넣으면 Chromium이 duration=Infinity로
// 보고해서 range 재생이 시작돼야만 확정된다 — 실측으로 확인)로, 스템은 사인파 wav로.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-libloop-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-libloop-'));
const WAV = path.join(TMP, 'tone.wav');   // 스템(보컬)용 4초 사인파
const MP4 = path.join(TMP, 'video.mp4');  // videoPath 용 4초 영상+오디오
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', WAV], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y',
  '-f', 'lavfi', '-i', 'color=gray:size=320x240:duration=4:rate=10',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', MP4,
], { stdio: 'ignore' });
if (!fs.existsSync(WAV)) throw new Error('ffmpeg 로 테스트 wav 생성 실패');
if (!fs.existsSync(MP4)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const { bootRenderer, expect, near, section, wait, finish } = require('./harness');

const LIB = [
  { id: 'song1', name: '테스트 곡', modelKey: '4stem', createdAt: Date.now(),
    videoPath: MP4, stemPaths: { vocals: WAV }, meta: {} },
];
const SETTINGS_KEY = 'yss:song-settings:' + MP4.replace(/\\/g, '/').toLowerCase();
const readSettings = (js) => js(`JSON.parse(localStorage.getItem(${JSON.stringify(SETTINGS_KEY)}) || '{}')`);

async function rectOf(js, id) {
  return JSON.parse(await js(`JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`));
}
// 레일 위에서 fracA → fracB 로 드래그(0~1, 재생바 폭 비율)
async function dragRail(js, fracA, fracB) {
  const r = await rectOf(js, 'vc-loop-rail');
  const xA = r.left + r.width * fracA, xB = r.left + r.width * fracB, y = r.top + r.height / 2;
  await js(`(() => {
    const el = document.getElementById('vc-loop-rail');
    const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: ${y}, pointerId: 1, bubbles: true, cancelable: true });
    el.dispatchEvent(mk('pointerdown', ${xA}));
    el.dispatchEvent(mk('pointermove', ${(xA + xB) / 2}));
    el.dispatchEvent(mk('pointerup', ${xB}));
  })(); true`);
}
// 핸들(A 또는 B)을 잡고 재생바 폭 기준 fracTarget 위치까지 드래그
async function dragHandle(js, handleId, fracTarget) {
  const wrap = await rectOf(js, 'vc-seek-wrap');
  const handle = await rectOf(js, handleId);
  const startX = handle.left + handle.width / 2;
  const endX = wrap.left + wrap.width * fracTarget;
  const y = wrap.top + wrap.height / 2;
  await js(`(() => {
    const el = document.getElementById(${JSON.stringify(handleId)});
    const mk = (type, x) => new PointerEvent(type, { clientX: x, clientY: ${y}, pointerId: 2, bubbles: true, cancelable: true });
    el.dispatchEvent(mk('pointerdown', ${startX}));
    el.dispatchEvent(mk('pointermove', ${(startX + endX) / 2}));
    el.dispatchEvent(mk('pointerup', ${endX}));
  })(); true`);
}

(async () => {
  const { app, js, errors } = await bootRenderer({ stubs: { 'library:list': () => LIB } });

  await js(`document.querySelector('.tab[data-view="library"]').click(); true`);
  await wait(300);
  await js(`document.querySelector('.lib-item[data-id="song1"]')?.click(); true`);
  let dur = 0;
  for (let i = 0; i < 40; i++) {
    dur = Number(await js(`document.getElementById('player-video')?.duration || 0`));
    if (dur > 0) break;
    await wait(200);
  }
  expect('재생 길이(4초) 로딩됨', Math.round(dur), 4);

  section('1) 재생바 아래 드래그용 띠(#vc-loop-rail)가 있고, 처음엔 A/B 핸들이 숨겨져 있다');
  expect('레일 존재', await js(`!!document.getElementById('vc-loop-rail')`), true);
  expect('A 핸들 처음엔 숨김', await js(`document.getElementById('vc-loop-handle-a')?.hidden`), true);
  expect('B 핸들 처음엔 숨김', await js(`document.getElementById('vc-loop-handle-b')?.hidden`), true);
  expect('레일에 안내 툴팁이 있음(빈 문자열 아님)', (await js(`document.getElementById('vc-loop-rail')?.title || ''`)).length > 0, true);

  section('2) 살짝 누르기만 하면(거의 안 끌면) 클릭으로 취급해서 아무 구간도 안 만든다');
  await dragRail(js, 0.5, 0.5);
  await wait(80);
  let saved = await readSettings(js);
  expect('아주 짧은 드래그는 A/B 없음(취소)', saved.loopA == null && saved.loopB == null, true);
  expect('핸들 여전히 숨김', await js(`document.getElementById('vc-loop-handle-a')?.hidden`), true);

  section('3) 20%→60% 드래그 — A~B 구간이 만들어지고 바로 반복이 켜진다');
  await dragRail(js, 0.2, 0.6);
  await wait(80);
  saved = await readSettings(js);
  near('A ≈ 0.8초(4초의 20%)', saved.loopA, 0.8, 0.1);
  near('B ≈ 2.4초(4초의 60%)', saved.loopB, 2.4, 0.1);
  expect('드래그로 직접 만들면 자동으로 반복 켜짐', saved.loopEnabled, true);
  expect('반복 버튼도 켜짐 표시', await js(`document.getElementById('loop-toggle')?.classList.contains('on')`), true);
  expect('A 핸들 보임', await js(`document.getElementById('vc-loop-handle-a')?.hidden`), false);
  expect('B 핸들 보임', await js(`document.getElementById('vc-loop-handle-b')?.hidden`), false);
  expect('구간 음영(#vc-loop-region) 보임', await js(`document.getElementById('vc-loop-region')?.hidden`), false);

  section('4) B 핸들만 끌면 A는 그대로, B만 바뀐다');
  await dragHandle(js, 'vc-loop-handle-b', 0.9);
  await wait(80);
  saved = await readSettings(js);
  near('A 그대로 ≈0.8초', saved.loopA, 0.8, 0.1);
  near('B가 3.6초(4초의 90%)로 이동', saved.loopB, 3.6, 0.15);

  section('5) A 핸들을 B 너머로 끌어도 B를 못 지나친다(역전 방지)');
  await dragHandle(js, 'vc-loop-handle-a', 0.98);
  await wait(80);
  saved = await readSettings(js);
  expect('A가 B를 넘지 않음(A < B)', saved.loopA < saved.loopB, true);
  near('A가 B 바로 앞에서 멈춤', saved.loopA, saved.loopB - 0.05, 0.05);

  section('6) 초기화 버튼 — A/B 지우고 핸들도 다시 숨긴다');
  await js(`document.getElementById('loop-reset')?.click(); true`);
  await wait(80);
  saved = await readSettings(js);
  expect('초기화 후 A 없음', saved.loopA, null);
  expect('초기화 후 B 없음', saved.loopB, null);
  expect('초기화 후 반복 꺼짐', saved.loopEnabled, false);
  expect('초기화 후 A 핸들 숨김', await js(`document.getElementById('vc-loop-handle-a')?.hidden`), true);
  expect('초기화 후 B 핸들 숨김', await js(`document.getElementById('vc-loop-handle-b')?.hidden`), true);

  section('7) 기존 A/B 버튼(정밀 조정용)도 그대로 동작한다');
  // offscreen 렌더링(bootRenderer)에서는 일시정지 상태로 currentTime 을 바로 대입해도
  // 디코더가 실제로 그 위치까지 안 움직인다(재생 중일 때만 프레임이 갱신됨 — 실측 확인).
  // 그래서 재생을 걸어 놓고 원하는 시각 근처에서 멈추는 방식으로 우회한다.
  async function seekTo(t) {
    await js(`document.getElementById('player-video').play().catch(() => {})`);
    for (let i = 0; i < 60; i++) {
      const cur = Number(await js(`document.getElementById('player-video').currentTime`));
      if (cur >= t) break;
      await wait(50);
    }
    await js(`document.getElementById('player-video').pause()`);
  }
  await seekTo(1);
  await js(`document.getElementById('loop-a-btn')?.click(); true`);
  await seekTo(3);
  await js(`document.getElementById('loop-b-btn')?.click(); true`);
  await wait(80);
  saved = await readSettings(js);
  near('버튼으로 설정한 A ≈1초', saved.loopA, 1, 0.3);
  near('버튼으로 설정한 B ≈3초', saved.loopB, 3, 0.3);
  expect('버튼만으로는 아직 반복 안 켜짐(드래그 생성 때와 달리 명시적 토글 필요)', saved.loopEnabled, false);
  await js(`document.getElementById('loop-toggle')?.click(); true`);
  await wait(80);
  saved = await readSettings(js);
  expect('반복 토글 클릭하면 켜짐', saved.loopEnabled, true);

  section('8) 콘솔 오류 없음');
  if (errors.length) { console.log('  실패 콘솔 오류:', errors.slice(0, 3).join(' | ')); process.exitCode = 1; }
  expect('콘솔 오류 없음', errors.length, 0);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
