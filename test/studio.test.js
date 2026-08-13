'use strict';
// 스튜디오 — 영상 높이 조절. 엔진 없이도 되는 화면 동작만 본다.

const { bootRenderer, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, win, js } = await bootRenderer({ settle: 2000 });

  await js('localStorage.removeItem("yss:studio-hero-h"); true');
  await win.webContents.reload();
  await wait(2200);
  await js('document.querySelector(\'.tab[data-view="studio"]\').click(); true');
  await wait(1800);
  // 이 테스트는 엔진을 흉내만 내 device 이벤트가 오지 않는다 → 준비 화면이 걷히지 않는다.
  // 실제 앱에서는 걷히는 화면이므로 치워 두고 잰다.
  await js('document.getElementById("daw-boot").hidden = true; true');
  await wait(200);

  const heroH = () => js('document.getElementById("daw-hero").getBoundingClientRect().height');
  const grip = () => js(`(()=>{const r=document.getElementById('daw-hero-resize').getBoundingClientRect();
    return {x:r.x+r.width/2, y:r.y+r.height/2, h:r.height};})()`);

  const drag = async (dy) => {
    const g = await grip();
    await js(`(()=>{const el=document.getElementById('daw-hero-resize');
      const o=(y)=>({bubbles:true,cancelable:true,composed:true,pointerId:1,pointerType:'mouse',
                     isPrimary:true,button:0,buttons:1,clientX:${Math.round(g.x)},clientY:y});
      el.dispatchEvent(new PointerEvent('pointerdown', o(${Math.round(g.y)})));
      for (let i=1;i<=6;i++) window.dispatchEvent(new PointerEvent('pointermove', o(${Math.round(g.y)} + ${dy}*i/6)));
      window.dispatchEvent(new PointerEvent('pointerup', {...o(${Math.round(g.y)} + ${dy}), buttons:0}));
      return true;})()`);
    await wait(250);
  };

  section('1) 손잡이가 실제로 잡히는가');
  const g0 = await grip();
  const base = await heroH();
  expect('손잡이 높이  ', g0.h > 0, true);
  expect('가운데 히트  ', await js(`(()=>{const r=document.getElementById('daw-hero-resize').getBoundingClientRect();
    const el=document.elementFromPoint(r.x+r.width/2, r.y+r.height/2);
    return el ? (el.id || el.className) : '없음';})()`), 'daw-hero-resize');

  section('2) 끌면 따라온다');
  await drag(120);
  near('아래로 120  ', Math.round(await heroH()), Math.round(base) + 120, 6);

  section('3) 한계에서 멈춘다');
  await drag(-400);
  expect('영상 최소 200', Math.round(await heroH()), 200);
  await drag(5000);
  const s = await js(`(()=>{const c=document.querySelector('.daw-content').getBoundingClientRect();
    const h=document.getElementById('daw-hero').getBoundingClientRect();
    const t=document.querySelector('.daw-tracks').getBoundingClientRect();
    return { 남은: Math.round(c.height-h.height), 트랙: Math.round(t.height),
             룰러: document.getElementById('daw-ruler-wrap').getBoundingClientRect().height >= 24 };})()`);
  near('타임라인 확보', s.남은, 120, 8);
  near('트랙 실제 높이', s.트랙, 120, 8);
  expect('룰러 보임    ', s.룰러, true);

  section('4) 저장 · 더블클릭 복귀');
  near('저장값       ', await js('Number(localStorage.getItem("yss:studio-hero-h"))'), await heroH(), 2);
  await js('document.getElementById("daw-hero-resize").dispatchEvent(new MouseEvent("dblclick",{bubbles:true})); true');
  await wait(400);
  near('기본 복귀    ', Math.round(await heroH()), Math.round(base), 4);
  expect('저장값 삭제  ', await js('localStorage.getItem("yss:studio-hero-h")'), null);

  section('5) 영상 접으면 손잡이도 사라진다');
  await js('document.getElementById("daw-video-collapse").click(); true');
  await wait(300);
  expect('숨김         ', await js('getComputedStyle(document.getElementById("daw-hero-resize")).display'), 'none');
  await js('document.getElementById("daw-hero-expand").click(); true');
  await wait(300);
  expect('펴면 복귀    ', await js('getComputedStyle(document.getElementById("daw-hero-resize")).display !== "none"'), true);

  section('6) 기억한 높이로 다시 뜬다');
  await js('localStorage.setItem("yss:studio-hero-h","520"); true');
  await win.webContents.reload();
  await wait(2200);
  await js('document.querySelector(\'.tab[data-view="studio"]\').click(); true');
  await wait(1800);
  near('복원된 높이  ', Math.round(await heroH()), 520, 3);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
