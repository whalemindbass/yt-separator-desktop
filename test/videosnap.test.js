'use strict';
// PIP 박스/텍스트를 미리보기에서 드래그로 옮길 때 프레임 정중앙(또는 다른 PIP박스·자막
// 중심)에 가까워지면 딱 붙고(snapCenter), 그 순간 가로/세로 안내선(.ve-snap-guide)이
// 뜨는지 확인한다. 리사이즈 핸들의 5% 격자 스냅(snapSize)과 Alt 로 스냅을 끄는 것도
// 같이 검증한다. 클립 임포트가 필요 없다 — PIP 박스는 트랙 kind==='video' 이면 뜨고
// (naturalTransform 이 클립 없을 때 기본값 0,0,1,1 을 준다), 텍스트는 트랙 추가만으로
// 클립이 자동 생성된다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vesnap-profile-')));

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) PIP 박스 — 프레임 중앙 근처로 끌면 스냅되고 안내선이 뜸');
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.querySelector('.ve-lane .ve-pip').click(); true`);
  await wait(100);
  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pip-x', 70); set('pip-y', 10); set('pip-w', 25); set('pip-h', 25);
  })(); true`);
  await wait(100);

  const pipDrag = await js(`(() => {
    const box = document.querySelector('.ve-pip-box');
    const host = document.getElementById('ve-preview');
    const br = box.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const startX = br.left + br.width / 2, startY = br.top + br.height / 2;
    const hostCx = hr.left + hr.width / 2, hostCy = hr.top + hr.height / 2;
    box.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: hostCx, clientY: hostCy, bubbles: true, pointerId: 1 }));
    const guideV = document.querySelector('.ve-snap-guide.v');
    const guideH = document.querySelector('.ve-snap-guide.h');
    const midDrag = { vShown: guideV ? !guideV.hidden : false, hShown: guideH ? !guideH.hidden : false };
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: hostCx, clientY: hostCy, bubbles: true, pointerId: 1 }));
    return {
      midDrag,
      afterVHidden: guideV ? guideV.hidden : null,
      afterHHidden: guideH ? guideH.hidden : null,
      pipX: Number(document.getElementById('pip-x').value),
      pipY: Number(document.getElementById('pip-y').value),
    };
  })()`);
  expect('드래그 중 정중앙 근처에선 세로 안내선이 뜸', pipDrag.midDrag.vShown, true);
  expect('드래그 중 정중앙 근처에선 가로 안내선이 뜸', pipDrag.midDrag.hShown, true);
  expect('드래그 끝나면 세로 안내선이 다시 숨음', pipDrag.afterVHidden, true);
  expect('드래그 끝나면 가로 안내선이 다시 숨음', pipDrag.afterHHidden, true);
  // w=h=25% 인 박스가 중앙(0.5,0.5)에 스냅되면 좌상단(x,y)은 50-12.5=37.5% 여야 함.
  near('스냅 후 pip-x ≈ 37.5%(박스 중심이 정중앙)', pipDrag.pipX, 37.5, 1);
  near('스냅 후 pip-y ≈ 37.5%(박스 중심이 정중앙)', pipDrag.pipY, 37.5, 1);

  section('2) 텍스트 — 프레임 중앙 근처로 끌면 스냅되고 안내선이 뜸');
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="text"]').click(); true`);
  await wait(150);
  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('tx-x', 15); set('tx-y', 80);
  })(); true`);
  await wait(100);

  const txDrag = await js(`(() => {
    const item = document.querySelector('.ve-text-item.sel');
    const host = document.getElementById('ve-preview');
    const br = item.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const startX = br.left + br.width / 2, startY = br.top + br.height / 2;
    const hostCx = hr.left + hr.width / 2, hostCy = hr.top + hr.height / 2;
    item.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, bubbles: true, pointerId: 2 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: hostCx, clientY: hostCy, bubbles: true, pointerId: 2 }));
    const guideV = document.querySelector('.ve-snap-guide.v');
    const guideH = document.querySelector('.ve-snap-guide.h');
    const midDrag = { vShown: guideV ? !guideV.hidden : false, hShown: guideH ? !guideH.hidden : false };
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: hostCx, clientY: hostCy, bubbles: true, pointerId: 2 }));
    const r2 = document.querySelector('.ve-text-item.sel').getBoundingClientRect();
    const hr2 = host.getBoundingClientRect();
    return {
      midDrag,
      afterVHidden: guideV ? guideV.hidden : null,
      afterHHidden: guideH ? guideH.hidden : null,
      txX: Number(document.getElementById('tx-x').value),
      txY: Number(document.getElementById('tx-y').value),
      centerOffX: (r2.left + r2.width / 2) - (hr2.left + hr2.width / 2),
      centerOffY: (r2.top + r2.height / 2) - (hr2.top + hr2.height / 2),
    };
  })()`);
  expect('드래그 중 정중앙 근처에선 세로 안내선이 뜸', txDrag.midDrag.vShown, true);
  expect('드래그 중 정중앙 근처에선 가로 안내선이 뜸', txDrag.midDrag.hShown, true);
  expect('드래그 끝나면 세로 안내선이 다시 숨음', txDrag.afterVHidden, true);
  expect('드래그 끝나면 가로 안내선이 다시 숨음', txDrag.afterHHidden, true);
  near('스냅 후 tx-x ≈ 50%', txDrag.txX, 50, 1);
  near('스냅 후 tx-y ≈ 50%', txDrag.txY, 50, 1);
  near('실제 화면상으로도 텍스트 중심이 프레임 중심과 거의 일치(가로)', txDrag.centerOffX, 0, 1.5);
  near('실제 화면상으로도 텍스트 중심이 프레임 중심과 거의 일치(세로)', txDrag.centerOffY, 0, 1.5);

  section('3) PIP 박스 — 프레임 중앙이 아니라 다른 PIP박스 중심에도 정렬 스냅됨');
  // 2)에서 텍스트 트랙을 다루는 동안 팝오버가 닫혔으니 트랙 A(첫 video 트랙) 걸 다시 연다.
  await js(`document.querySelectorAll('.ve-lane .ve-pip')[0].click(); true`);
  await wait(100);
  // 트랙 A를 프레임 중앙과는 뚜렷이 다른 자리(중심 22.5%)로.
  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pip-x', 10); set('pip-y', 10); set('pip-w', 25); set('pip-h', 25);
  })(); true`);
  await wait(100);
  // 트랙 B 추가 — 다른 자리(중심 82.5%)에서 시작, A 쪽으로 끌어본다.
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(150);
  await js(`document.querySelectorAll('.ve-lane .ve-pip')[0].click(); true`);   // 새 트랙이 맨 위 레인
  await wait(100);
  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pip-x', 70); set('pip-y', 70); set('pip-w', 25); set('pip-h', 25);
  })(); true`);
  await wait(100);

  const alignDrag = await js(`(() => {
    const box = document.querySelector('.ve-pip-box');
    const host = document.getElementById('ve-preview');
    const br = box.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const startX = br.left + br.width / 2, startY = br.top + br.height / 2;
    const targetX = hr.left + hr.width * 0.225, targetY = hr.top + hr.height * 0.225;   // 트랙 A 중심(22.5%)
    box.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, bubbles: true, pointerId: 3 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: targetX, clientY: targetY, bubbles: true, pointerId: 3 }));
    const guideV = document.querySelector('.ve-snap-guide.v');
    const guideH = document.querySelector('.ve-snap-guide.h');
    const mid = { vShown: !guideV.hidden, hShown: !guideH.hidden, guideLeftPct: parseFloat(guideV.style.left), guideTopPct: parseFloat(guideH.style.top) };
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: targetX, clientY: targetY, bubbles: true, pointerId: 3 }));
    return { mid, pipX: Number(document.getElementById('pip-x').value), pipY: Number(document.getElementById('pip-y').value) };
  })()`);
  expect('트랙A 근처로 끌면 세로 정렬선이 뜸', alignDrag.mid.vShown, true);
  expect('트랙A 근처로 끌면 가로 정렬선이 뜸', alignDrag.mid.hShown, true);
  near('정렬선이 프레임 중앙(50%)이 아니라 트랙A 중심(22.5%)에 그려짐(가로)', alignDrag.mid.guideLeftPct, 22.5, 1);
  near('정렬선이 프레임 중앙(50%)이 아니라 트랙A 중심(22.5%)에 그려짐(세로)', alignDrag.mid.guideTopPct, 22.5, 1);
  near('스냅 후 pip-x ≈ 10%(트랙A 와 중심이 같아짐)', alignDrag.pipX, 10, 1);
  near('스냅 후 pip-y ≈ 10%(트랙A 와 중심이 같아짐)', alignDrag.pipY, 10, 1);

  section('4) PIP 리사이즈 — 5% 단위 근처면 딱 붙고, 멀면 안 붙음');
  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pip-x', 0); set('pip-y', 0); set('pip-w', 20); set('pip-h', 20);
  })(); true`);
  await wait(100);
  const sizeSnap = await js(`(() => {
    const handle = document.querySelector('.ve-pip-box-handle');
    const host = document.getElementById('ve-preview');
    const br = handle.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const startX = br.left + br.width / 2, startY = br.top + br.height / 2;
    // 20% → 30.1% 로(격자 30%에서 0.1%p 밖, SNAP_PX 이내) — 붙어야 함.
    const nearX = startX + hr.width * 0.101;
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, bubbles: true, pointerId: 4 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: nearX, clientY: startY, bubbles: true, pointerId: 4 }));
    const wNear = Number(document.getElementById('pip-w').value);
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: nearX, clientY: startY, bubbles: true, pointerId: 4 }));
    return { wNear };
  })()`);
  expect('20%→30.1% 로 늘리면 30%(격자)에 붙음', sizeSnap.wNear, 30);

  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pip-x', 0); set('pip-y', 0); set('pip-w', 20); set('pip-h', 20);
  })(); true`);
  await wait(100);
  const sizeNoSnap = await js(`(() => {
    const handle = document.querySelector('.ve-pip-box-handle');
    const host = document.getElementById('ve-preview');
    const br = handle.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const startX = br.left + br.width / 2, startY = br.top + br.height / 2;
    // 20% → 22.5% 로(두 격자 20%/25% 사이 정중앙, 가장 안 붙기 쉬운 자리) — 안 붙어야 함.
    const farX = startX + hr.width * 0.025;
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, bubbles: true, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: farX, clientY: startY, bubbles: true, pointerId: 5 }));
    const wFar = Number(document.getElementById('pip-w').value);
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: farX, clientY: startY, bubbles: true, pointerId: 5 }));
    return { wFar };
  })()`);
  near('20%→22.5% 는 격자 사이라 그대로(±1%p)', sizeNoSnap.wFar, 22.5, 1);

  section('5) Alt 를 누른 채 드래그하면 스냅을 건너뜀');
  await js(`(() => {
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('pip-x', 35); set('pip-y', 35); set('pip-w', 25); set('pip-h', 25);
  })(); true`);
  await wait(100);
  const altDrag = await js(`(() => {
    const box = document.querySelector('.ve-pip-box');
    const host = document.getElementById('ve-preview');
    const br = box.getBoundingClientRect(), hr = host.getBoundingClientRect();
    const startX = br.left + br.width / 2, startY = br.top + br.height / 2;
    // 프레임 정중앙에서 2px 만 벗어난 자리(Alt 없으면 SNAP_PX=6px 이내라 무조건 붙었을 자리).
    const targetX = hr.left + hr.width / 2 + 2, targetY = hr.top + hr.height / 2 + 2;
    box.dispatchEvent(new PointerEvent('pointerdown', { clientX: startX, clientY: startY, bubbles: true, pointerId: 6, altKey: true }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: targetX, clientY: targetY, bubbles: true, pointerId: 6, altKey: true }));
    const guideV = document.querySelector('.ve-snap-guide.v');
    const guideH = document.querySelector('.ve-snap-guide.h');
    const mid = { vShown: !guideV.hidden, hShown: !guideH.hidden };
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: targetX, clientY: targetY, bubbles: true, pointerId: 6, altKey: true }));
    return { mid, pipX: Number(document.getElementById('pip-x').value), pipY: Number(document.getElementById('pip-y').value) };
  })()`);
  expect('Alt 누르고 있으면 정중앙 2px 이내로 가도 안내선이 안 뜸(세로)', altDrag.mid.vShown, false);
  expect('Alt 누르고 있으면 정중앙 2px 이내로 가도 안내선이 안 뜸(가로)', altDrag.mid.hShown, false);
  expect('Alt 누르고 있으면 정확히 37.5% 로 안 붙음(원본 위치대로 살짝 벗어남)', Math.abs(altDrag.pipX - 37.5) > 0.05, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
