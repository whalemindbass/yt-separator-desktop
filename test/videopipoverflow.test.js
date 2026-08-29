'use strict';
// PIP 를 프레임 밖으로 끌어도(테두리에 안 묶인다) 미리보기/내보내기 둘 다 "잘려서" 자연스럽게
// 나오는지 확인한다 — 예전엔 x+scale<=1, y+scale<=1 로 묶여 있어서 아예 밖으로 못 나갔다.
// main.js 는 안 고쳤다(ffmpeg overlay 필터가 프레임 밖 좌표를 이미 알아서 잘라준다 — 실측으로
// 확인함, drawtext 때와 달리 이건 별도 우회가 필요 없었다) — 렌더러의 드래그/숫자칸 클램프만 풀었다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vepipof-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vepipof-'));
const SRC = path.join(TMP, 'blue.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=blue:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) scale=50% 로 두고 오른쪽 아래로 한참(프레임 절반 이상) 드래그');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await js(`document.querySelector('.ve-lane .ve-pip').click(); true`);
  await wait(100);
  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pip-scale', 50);
  })(); true`);
  await wait(80);
  // 미리보기 실제 폭 기준으로, "옛날 클램프였다면 최대 50%(=100-scale)까지만" 이었을 값을
  // 그 이상으로 밀어붙인다 — 드래그 델타를 미리보기 폭의 70% 만큼 오른쪽으로 준다.
  const dragOk = await js(`(() => {
    const box = document.querySelector('.ve-pip-box');
    const host = document.getElementById('ve-preview');
    if (!box || !host) return 'NO_EL';
    const r = box.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const dx = hr.width * 0.7, dy = hr.height * 0.7;
    box.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + dx, clientY: cy + dy, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + dx, clientY: cy + dy, pointerId: 1 }));
    return 'ok';
  })()`);
  expect('드래그 이벤트 정상 처리', dragOk, 'ok');
  await wait(80);
  const pipX = Number(await js(`document.getElementById('pip-x').value`));
  const pipY = Number(await js(`document.getElementById('pip-y').value`));
  const pipScale = Number(await js(`document.getElementById('pip-scale').value`));
  expect('scale=50 일 때 예전 클램프 상한(50)을 넘어감 — 테두리에 안 묶임', pipX > 50, true);
  expect('세로도 마찬가지로 상한을 넘어감', pipY > 50, true);
  expect('scale 자체는 안 바뀜(위치만 드래그)', pipScale, 50);

  section('2) export — 실제로 잘려서 나오는지(overlay 가 프레임 밖 좌표를 알아서 클리핑)');
  const OUT = path.join(TMP, 'out.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('프레임 밖으로 나간 PIP 도 export 성공', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const raw = path.join(TMP, 'frame.rgb');
    spawnSync(FFMPEG, ['-y', '-i', OUT, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
    const d = fs.readFileSync(raw);
    let blue = 0;
    for (let i = 0; i < d.length; i += 3) { if (d[i] < 80 && d[i + 1] < 80 && d[i + 2] > 150) blue++; }
    // 옛 클램프대로였다면(x,y 최대 50%) PIP 전체(가로세로 각 50%)가 프레임 안에 다 들어가서
    // blue 픽셀 = 0.5*0.5 = 25% 였을 것. 지금은 그보다 훨씬 잘려서 더 적어야 한다 —
    // "잘렸다"는 걸 픽셀 수로 직접 확인.
    const total = d.length / 3;
    expect('클램프 없었다면 나왔을 25%보다 훨씬 적게 보임(실제로 잘림)', blue < total * 0.2, true);
    expect('그래도 조금은 보임(완전히 사라지진 않음)', blue > 0, true);
    console.log(`  blue px ${blue} / ${total} (${(blue / total * 100).toFixed(1)}%) — pip-x=${pipX} pip-y=${pipY} scale=${pipScale}`);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
