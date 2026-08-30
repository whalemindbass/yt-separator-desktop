'use strict';
// "가로세로 비율 고정" 체크박스(tf.lock) — 트랙 PIP 팝오버와 도형 팝오버 둘 다 같은
// 위치/크기 박스(createResizeBox)를 쓴다. 체크 여부에 따라:
//   꺼짐(기본) — 모서리 손잡이/숫자칸으로 가로·세로를 완전히 따로 조절할 수 있다.
//   켜짐      — 어느 쪽을 조작해도(드래그든 숫자칸이든) 폭:높이 비율이 그대로 유지된다.
// 실제 화면 이벤트(포인터 드래그·input 이벤트)로 두 상태를 다 검증한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veaspectlock-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veaspectlock-'));
const SRC = path.join(TMP, 'red.mp4');

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:duration=3:rate=10',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, near, section, wait, finish } = require('./harness');

async function dragBy(js, selector, dx, dy) {
  await js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 3 }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 3 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 3 }));
  })(); true`);
}
const setField = async (js, id, v) => js(`(() => {
  const el = document.getElementById(${JSON.stringify(id)});
  el${typeof v === 'boolean' ? '.checked' : '.value'} = ${JSON.stringify(v)};
  el.dispatchEvent(new Event(${JSON.stringify(typeof v === 'boolean' ? 'change' : 'input')}, { bubbles: true }));
})(); true`);

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 트랙 PIP 팝오버 — 기본은 잠금 꺼짐: 모서리 드래그로 가로세로 따로 늘어남');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await js(`document.querySelector('.ve-lane .ve-pip').click(); true`);
  await wait(100);
  expect('잠금 체크박스가 기본은 꺼져 있음', await js(`document.getElementById('pip-lock').checked`), false);
  await setField(js, 'pip-w', 40);
  await setField(js, 'pip-h', 40);
  await wait(80);
  // 가로로만 60px, 세로로는 안 움직이는 드래그.
  await dragBy(js, '.ve-pip-box-handle', 60, 0);
  await wait(80);
  const wUnlocked = Number(await js(`document.getElementById('pip-w').value`));
  const hUnlocked = Number(await js(`document.getElementById('pip-h').value`));
  expect('잠금 꺼진 상태 — 폭은 늘어남', wUnlocked > 40, true);
  expect('잠금 꺼진 상태 — 높이는 거의 그대로(가로세로 안 묶임)', Math.abs(hUnlocked - 40) <= 2, true);

  section('2) 잠금 체크 — 이제 모서리를 가로로만 끌어도 세로도 같이 늘어남(비율 유지)');
  await setField(js, 'pip-w', 40);
  await setField(js, 'pip-h', 20);   // 2:1 비율로 리셋
  await setField(js, 'pip-lock', true);
  await wait(80);
  expect('잠금 체크됨', await js(`document.getElementById('pip-lock').checked`), true);
  await dragBy(js, '.ve-pip-box-handle', 60, 0);
  await wait(80);
  const wLocked = Number(await js(`document.getElementById('pip-w').value`));
  const hLocked = Number(await js(`document.getElementById('pip-h').value`));
  expect('잠긴 상태 — 폭 늘어남', wLocked > 40, true);
  expect('잠긴 상태 — 가로만 끌었는데 높이도 같이 늘어남(비율 유지)', hLocked > 20, true);
  const ratio = wLocked / hLocked;
  near('폭:높이 비율이 2:1 그대로 유지됨', ratio, 2, 0.15);

  section('3) 숫자 입력칸도 잠금 상태를 지킨다 — 폭만 바꿔도 높이가 같은 비율로 따라옴');
  await setField(js, 'pip-w', 60);
  await wait(80);
  const hAfterWEdit = Number(await js(`document.getElementById('pip-h').value`));
  near('폭을 60으로 바꾸면 높이도 2:1 비율(30)로 같이 바뀜', hAfterWEdit, 30, 2);

  section('4) 도형 팝오버에도 같은 잠금 체크박스가 있다');
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="shape"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }
  expect('도형 팝오버에 sh-lock 체크박스 있음', await js(`!!document.getElementById('sh-lock')`), true);
  expect('도형은 기본 잠금 꺼짐(독립 리사이즈)', await js(`document.getElementById('sh-lock').checked`), false);
  await setField(js, 'sh-w', 40);
  await setField(js, 'sh-h', 20);
  await setField(js, 'sh-lock', true);
  await wait(80);
  await setField(js, 'sh-w', 80);
  await wait(80);
  const shH = Number(await js(`document.getElementById('sh-h').value`));
  near('도형도 잠그면 폭 바꿀 때 높이가 비율대로 같이 바뀜', shH, 40, 2);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
