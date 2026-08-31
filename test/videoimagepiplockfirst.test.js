'use strict';
// "비율 고정" 체크박스를 켰는데도 크기를 한 번도 안 바꾼 상태(=풀프레임 100%/100%)에서는
// 그 체크가 조용히 무시되고, 리사이즈를 한 번 해야만(그 다음부터) 비로소 비율이 지켜지던
// 버그. 원인: PIP 상자의 setTf() 가 "x=0,y=0,w=1,h=1 이면 그냥 기본값이니 track.transform 을
// null 로 되돌린다"는 판정에서 lock 플래그를 안 봤다 — 이미지가 처음 임포트돼 자기 크기
// 그대로 해상도가 잡히면(가장 흔한 "이미지 하나만 불러온" 경우) PIP 상자는 정확히
// 풀프레임(100%/100%)으로 열리는데, 그 상태에서 잠금만 체크해도 w/h/x/y 는 여전히
// 기본값이라 "기본값이니 null" 판정에 걸려 방금 켠 lock:true 가 통째로 버려졌다. 그러니
// 그 다음 첫 드래그가 잠금 없는 상태(defaultTransform, lock:false)에서 시작해 비율이
// 안 지켜졌다. — 이 테스트는 정확히 그 전제(크기 안 바꾸고 잠금만 체크 → 첫 드래그)를
// 실제 DOM 이벤트로 재현해서 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veimglockfirst-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veimglockfirst-'));
const IMG = path.join(TMP, 'square.png');   // 320x240 — 이 이미지 하나만 임포트하면
                                             // getResolution() 이 이 크기 그대로 해상도로 잡는다
                                             // (풀프레임 = 정확히 100%/100%, 버그 재현 전제).

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=teal:size=320x240', '-frames:v', '1', IMG], { stdio: 'ignore' });
if (!fs.existsSync(IMG)) throw new Error('ffmpeg 로 테스트 PNG 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [IMG] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

async function dragBy(js, selector, dx, dy) {
  await js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 5 }));
  })(); true`);
}
const setField = async (js, id, v) => js(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  el${typeof v === 'boolean' ? '.checked' : '.value'} = ${JSON.stringify(v)};
  el.dispatchEvent(new Event(${JSON.stringify(typeof v === 'boolean' ? 'change' : 'input')}, { bubbles: true }));
})(); true`);

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) 이미지 하나만 임포트 — 해상도가 이 이미지 크기 그대로 잡혀서 PIP 상자가 정확히 풀프레임(100%/100%)');
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="image"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }
  expect('이미지 클립 생김', await js(`document.querySelectorAll('.ve-clip.image').length`), 1);

  await js(`document.querySelector('.ve-lane .ve-pip').click(); true`);
  await wait(100);
  expect('팝오버 열림', await js(`!!document.querySelector('.ve-pip-pop')`), true);
  expect('폭이 정확히 100%(버그 재현 전제)', await js(`document.getElementById('pip-w').value`), '100');
  expect('높이도 정확히 100%(버그 재현 전제)', await js(`document.getElementById('pip-h').value`), '100');
  expect('잠금은 기본 꺼짐', await js(`document.getElementById('pip-lock').checked`), false);

  section('2) 크기를 한 번도 안 바꾸고 "비율 고정"만 체크 — 그 상태로 바로 모서리 드래그(첫 리사이즈)');
  await setField(js, 'pip-lock', true);
  await wait(80);
  expect('잠금 체크됨', await js(`document.getElementById('pip-lock').checked`), true);
  await dragBy(js, '.ve-pip-box-handle', 60, 0);   // 가로로만 끌었다 — 세로는 안 건드림
  await wait(80);
  const w1 = Number(await js(`document.getElementById('pip-w').value`));
  const h1 = Number(await js(`document.getElementById('pip-h').value`));
  expect('폭은 늘어남', w1 > 100, true);
  expect('첫 드래그부터 이미 비율 고정이 먹혀서 높이도 같이 늘어남(버그면 100 근처에 머무름)', h1 > 105, true);
  near('폭:높이 비율이 1:1(체크 당시 값) 그대로 유지됨', w1 / h1, 1, 0.1);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
