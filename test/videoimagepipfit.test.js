'use strict';
// 이미지 클립 PIP 상자 초기 크기 — 출력 해상도와 다른 비율의 이미지를 트랙 PIP 없이 두면
// CSS object-fit:contain 이 원본 비율대로 레터박스(좌우 여백)해서 보여준다. 그런데 PIP
// 상자는 항상 풀프레임(0,0,100%,100%)으로 열려서, 상자와 실제로 보이는 그림 크기가
// 서로 달랐다 — 그 상태에서 상자를 살짝만 옮겨도(비율 고정을 켜 놨어도) track.transform 이
// 생기는 순간 object-fit 이 contain→fill 로 바뀌면서 그림이 상자 크기(풀프레임)로 그냥
// 늘어나 버렸다("클릭하자마자 이미지가 좌우로 늘어나는 현상" 피드백). PIP 상자를 처음부터
// 이미지의 실제 레터박스 자리(원본 비율 반영)로 열어야 그 점프가 없다는 게 요청 방향이다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veimgpip-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veimgpip-'));
const BG = path.join(TMP, 'bg.mp4');       // 320x240(4:3) — 해상도를 이걸로 고정시킬 배경
const IMG = path.join(TMP, 'square.png');  // 240x240(1:1) — 배경과 다른 비율

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=320x240:duration=3:rate=10', BG], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=blue:size=240x240', '-frames:v', '1', IMG], { stdio: 'ignore' });
if (!fs.existsSync(BG) || !fs.existsSync(IMG)) throw new Error('ffmpeg 로 테스트 픽스처 생성 실패');

const { bootMain, expect, near, section, wait, finish } = require('./harness');

// videocanvashandles.test.js 와 같은 방식 — pointerdown 은 대상 엘리먼트에, pointermove/up
// 은 document 에 보내야 한다(createResizeBox 가 실제로 그렇게 리스너를 건다).
async function dragBy(js, selector, dx, dy) {
  const err = await js(`(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return 'NO_EL';
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: cx, clientY: cy, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 1 }));
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: cx + ${dx}, clientY: cy + ${dy}, pointerId: 1 }));
      return null;
    } catch (e) { return String(e && (e.stack || e.message || e)); }
  })()`);
  if (err) console.log('  dragBy error:', err);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) 배경 영상(320x240, 4:3) 임포트 — 이게 해상도를 결정한다');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG] });
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  section('2) 정사각형(240x240) 이미지를 "+트랙"→이미지로 임포트 — 배경과 다른 비율, 새 트랙에 들어감');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [IMG] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="image"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }
  expect('이미지 클립 생김', await js(`document.querySelectorAll('.ve-clip.image').length`), 1);
  expect('영상 트랙 2개(배경 + 이미지 각자)', await js(`document.querySelectorAll('.ve-lane:not(.audio):not(.text)').length`), 2);
  await wait(200);

  section('3) 이미지가 실제로 레터박스(좌우 여백)로 보이는지 — object-fit:contain, 아직 .ve-stretch 없음');
  const beforeOpen = JSON.parse(await js(`JSON.stringify((() => {
    const img = document.querySelector('.ve-video-layers .ve-layer-slot img:not([hidden])');
    const slot = img?.closest('.ve-layer-slot');
    return slot ? { width: slot.style.width, stretched: slot.classList.contains('ve-stretch') } : null;
  })())`));
  expect('아직 PIP 를 안 건드렸으니 풀프레임(100%) 로 스타일이 잡힘', beforeOpen.width, '100%');
  expect('아직 stretch 없음(레터박스는 CSS object-fit:contain 이 처리 중)', beforeOpen.stretched, false);

  section('4) 이미지 트랙의 PIP 팝오버를 연다 — 상자가 처음부터 이미지의 실제 레터박스 자리(75%/100%, x≈12.5%)로 잡혀야 함');
  await js(`(() => {
    const slot = document.querySelector('.ve-video-layers .ve-layer-slot img:not([hidden])').closest('.ve-layer-slot');
    // 어느 트랙인지는 z-index 로 구분할 필요 없이, 그 이미지 클립이 속한 레인의 PIP 버튼을 직접 찾는다.
    const imageClipEl = document.querySelector('.ve-clip.image');
    const lane = imageClipEl.closest('.ve-lane');
    lane.querySelector('.ve-pip').click();
  })(); true`);
  await wait(100);
  expect('팝오버 열림', await js(`!!document.querySelector('.ve-pip-pop')`), true);
  expect('초기 폭 75%(풀프레임 100%가 아님)', await js(`document.getElementById('pip-w').value`), '75');
  expect('초기 높이 100%', await js(`document.getElementById('pip-h').value`), '100');
  expect('초기 가로 위치 ≈12.5%(레터박스 왼쪽 여백만큼)', await js(`document.getElementById('pip-x').value`), '13');
  expect('초기 세로 위치 0%', await js(`document.getElementById('pip-y').value`), '0');
  const boxStyle = JSON.parse(await js(`JSON.stringify((() => { const b = document.querySelector('.ve-pip-box'); return { left: b.style.left, width: b.style.width }; })())`));
  expect('상자 자체도 정확히 75% 폭으로 그려짐(반올림 없이)', boxStyle.width, '75%');
  expect('상자 왼쪽 위치도 정확히 12.5%', boxStyle.left, '12.5%');

  section('5) 상자를 살짝 옮기기(위치만, 크기 변경 없음) — 실제 렌더 크기가 그대로 유지돼야 함(점프 없음)');
  await dragBy(js, '.ve-pip-box', 5, 0);
  await wait(80);
  const dragResult = JSON.parse(await js(`JSON.stringify((() => {
    const img = document.querySelector('.ve-video-layers .ve-layer-slot img:not([hidden])');
    const slot = img.closest('.ve-layer-slot');
    return { width: slot.style.width, height: slot.style.height, stretched: slot.classList.contains('ve-stretch') };
  })())`));
  expect('드래그 후 transform 이 생겨 stretch 모드로 바뀜(설명 필드 참고용)', dragResult.stretched, true);
  expect('그래도 렌더 폭은 여전히 75%(100%로 안 튐 — 점프 버그 없음)', dragResult.width, '75%');
  expect('렌더 높이도 여전히 100%', dragResult.height, '100%');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
