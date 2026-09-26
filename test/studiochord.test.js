'use strict';
// 스튜디오 코드 트랙(작곡용) — 진짜 마우스·키 입력으로 추가·이름·이동·길이·삭제·실행취소·저장/열기까지.
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, dialog, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-studiochord-')));
const PROJ = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yss-studiochord-proj-')), 'chords.yssproj');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: PROJ });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PROJ] });
const { bootMain, expect, section, wait, finish, skip } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 2500, width: 1400, height: 900 });
  const win = BrowserWindow.getAllWindows()[0];
  win.focus(); win.webContents.focus();
  const mouse = async (type, x, y, extra = {}) => { win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra }); await wait(50); };
  const dbl = async (x, y) => { await mouse('mouseDown', x, y); await mouse('mouseUp', x, y); await mouse('mouseDown', x, y, { clickCount: 2 }); await mouse('mouseUp', x, y, { clickCount: 2 }); await wait(150); };
  const key = async (keyCode, mods) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: mods || [] }); await wait(30); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: mods || [] }); await wait(120); };
  const typeText = async (t) => { for (const ch of t) { win.webContents.sendInputEvent({ type: 'char', keyCode: ch }); await wait(15); } await wait(60); };
  const blocks = () => js(`[...document.querySelectorAll('.daw-chord')].map(e => ({ name: e.querySelector('b').textContent, left: Math.round(parseFloat(e.style.left)), width: Math.round(parseFloat(e.style.width)) })).sort((a, b) => a.left - b.left)`);
  const view = () => js(`(() => { const r = document.getElementById('daw-chord-view').getBoundingClientRect(); return { l: r.left, t: r.top, h: r.height }; })()`);
  // 눈금 라벨(마디 번호)과 위치로 마디 폭을 잰다 — 배율에 따라 라벨이 몇 마디 건너 찍힌다
  const pxPerBeat = () => js(`(() => { const r = [...document.querySelectorAll('#daw-ruler .tk')].filter(e => { const t = e.textContent.trim(); return t !== '' && String(Number(t)) === t; }); if (r.length < 2) return 0;
    const n0 = Number(r[0].textContent), n1 = Number(r[1].textContent); return (parseFloat(r[1].style.left) - parseFloat(r[0].style.left)) / (n1 - n0) / 4; })()`);

  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);
  for (let i = 0; i < 30 && !(await js(`document.getElementById('st-engine-dot')?.classList.contains('on')`)); i++) await wait(300);
  if (!(await js(`document.getElementById('st-engine-dot')?.classList.contains('on')`))) { skip('엔진이 시간 안에 안 떴다'); finish(app); return; }
  await wait(500);
  const v = await view();
  expect('코드 트랙 줄 보임', v.h > 10, true);
  const beat = await pxPerBeat();
  expect('눈금에서 박 폭 읽힘', beat > 5, true);
  const bar = beat * 4;

  section('1) 추가 · 이름 고르기');
  await dbl(v.l + bar * 1.3, v.t + v.h / 2);   // 2마디 안쪽
  expect('더블클릭 → 편집 창', await js(`!!document.querySelector('.daw-chord-pop')`), true);
  await js(`document.querySelector('.daw-chord-pop [data-root="A"]').click(); document.querySelector('.daw-chord-pop [data-qual="m7"]').click(); true`);
  expect('근음·종류 버튼 → Am7', await js(`document.querySelector('.daw-chord-pop .cp-in').value`), 'Am7');
  await key('Return');
  let bs = await blocks();
  expect('블록 1개 · 이름 Am7', bs.length === 1 && bs[0].name === 'Am7', true);
  expect('누른 마디 시작에 1마디 길이', Math.abs(bs[0].left - bar) <= 2 && Math.abs(bs[0].width - bar) <= 2, true);

  section('2) 직접 타이핑 · 이름 정리');
  await dbl(v.l + bar * 3.5, v.t + v.h / 2);
  expect('새 블록 기본 이름 = 앞 코드', await js(`document.querySelector('.daw-chord-pop .cp-in').value`), 'Am7');
  await js(`document.querySelector('.daw-chord-pop .cp-in').select(); true`);
  await typeText('g/b'); await key('Return');
  bs = await blocks();
  expect('g/b → G/B', bs.map(b => b.name).join(','), 'Am7,G/B');

  section('3) 이동 · 겹치지 않음 · 길이');
  // G/B 를 왼쪽으로 크게 끌어도 Am7 끝에서 멈춘다
  await mouse('mouseDown', v.l + bs[1].left + bs[1].width / 2, v.t + v.h / 2);
  await mouse('mouseMove', v.l + bs[1].left + bs[1].width / 2 - bar * 3, v.t + v.h / 2);
  await mouse('mouseUp', v.l + bs[1].left + bs[1].width / 2 - bar * 3, v.t + v.h / 2);
  bs = await blocks();
  expect('Am7 에 붙어 멈춤(겹침 없음)', Math.abs(bs[1].left - (bs[0].left + bs[0].width)) <= 2, true);
  // 오른쪽 끝을 2박 늘리기
  const rEdge = v.l + bs[1].left + bs[1].width - 2;
  await mouse('mouseDown', rEdge, v.t + v.h / 2); await mouse('mouseMove', rEdge + beat * 2, v.t + v.h / 2); await mouse('mouseUp', rEdge + beat * 2, v.t + v.h / 2);
  const bs2 = await blocks();
  expect('오른쪽 끝 → 2박 늘어남(박 단위)', Math.abs((bs2[1].width - bs[1].width) - beat * 2) <= 2, true);

  section('4) 삭제 · 실행취소');
  await mouse('mouseDown', v.l + bs2[0].left + 10, v.t + v.h / 2); await mouse('mouseUp', v.l + bs2[0].left + 10, v.t + v.h / 2);
  await key('Delete');
  expect('Delete → 1개', (await blocks()).length, 1);
  await key('Z', ['control']);
  expect('Ctrl+Z → 2개', (await blocks()).length, 2);
  await key('Z', ['control']);
  expect('Ctrl+Z → 길이도 되돌림', (await blocks())[1].width, bs[1].width);
  // 새로 만들다 Esc = 없던 일
  await dbl(v.l + bar * 6.5, v.t + v.h / 2);
  await key('Escape');
  expect('새 블록 Esc → 취소', (await blocks()).length, 2);

  section('5) 재생 위치 강조');
  const rr = await js(`(() => { const r = document.getElementById('daw-ruler-wrap').getBoundingClientRect(); return { t: r.top + r.height / 2 }; })()`);
  await mouse('mouseDown', v.l + bs[0].left + 12, rr.t); await mouse('mouseUp', v.l + bs[0].left + 12, rr.t);
  await wait(150);
  expect('재생선이 Am7 안 → Am7 강조', await js(`document.querySelector('.daw-chord.cur b')?.textContent`), 'Am7');

  section('5b) 피아노롤 연동 — 구성음 줄 · 코드 이름 · 코드로 채우기 · 키보드 가이드 코드톤');
  {
    // 악기 트랙 + 빈 클립(1마디 = Am7 자리)
    await js(`document.getElementById('st-add-instr').click(); true`);
    for (let i = 0; i < 20 && !(await js(`!!document.querySelector('.daw-lane-instr')`)); i++) await wait(150);
    const la = await js(`(() => { const r = document.querySelector('.daw-lane-instr .daw-area').getBoundingClientRect(); return { l: r.left, t: r.top + r.height / 2 }; })()`);
    const bb = await blocks();
    // 빈 MIDI 클립은 누른 마디에 1마디 — Am7 마디(bb[0])를 눌러 Am7 구간에 만든다
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(la.l + bb[0].left + 5), y: Math.round(la.t), button: 'right', clickCount: 1 }); await wait(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(la.l + bb[0].left + 5), y: Math.round(la.t), button: 'right', clickCount: 1 }); await wait(150);
    await js(`[...document.querySelectorAll('.daw-dropdown *')].find(e => e.children.length === 0 && /MIDI/.test(e.textContent))?.click(); true`);
    await wait(400);
    expect('피아노롤 열림', await js(`!!document.querySelector('.pr')`), true);
    expect('눈금자 아래 코드 이름 Am7', await js(`[...document.querySelectorAll('.pr-ruler-ch span')].map(e => e.textContent).join(',').includes('Am7')`), true);
    // Am7 구성음 A C E G — 한 옥타브(12줄)에 4줄, 근음 A 줄은 진하게
    const bandInfo = await js(`(() => { const endX = parseFloat(document.querySelector('.pr-end').style.left); const b = [...document.querySelectorAll('.pr-chords i')].filter(i => parseFloat(i.style.left) < endX - 1); const ph = parseFloat(document.querySelector('.pr-row').style.height); const pcs = new Set(b.map(i => (127 - Math.round(parseFloat(i.style.top) / ph)) % 12)); return { pcs: [...pcs].sort((a, c) => a - c).join(','), roots: [...new Set(b.filter(i => i.classList.contains('rt')).map(i => (127 - Math.round(parseFloat(i.style.top) / ph)) % 12))].join(',') }; })()`);
    expect('구성음 줄 = A C E G(0,4,7,9)', bandInfo.pcs, '0,4,7,9');
    expect('근음 줄 = A(9)', bandInfo.roots, '9');
    await js(`document.querySelector('.pr-fill').click(); true`); await wait(200);
    const ns = await js(`[...document.querySelectorAll('.pr-note')].map(e => 127 - Math.round((parseFloat(e.style.top) - 1) / parseFloat(document.querySelector('.pr-row').style.height))).sort((a, b) => a - b).join(',')`);
    expect('코드로 채우기 → Am7 = A2 + A3 C4 E4 G4', ns, '45,57,60,64,67');
    await key('Z', ['control']);
    expect('Ctrl+Z → 비움', await js(`document.querySelectorAll('.pr-note').length`), 0);
    // 키보드 가이드 — 재생선이 Am7 안이면 A·C·E·G 키가 코드톤
    await key('Escape'); await wait(100);
    await js(`document.querySelector('.daw-lane-instr [data-m="kb"]').click(); true`); await wait(200);
    const ctKeys = await js(`[...document.querySelectorAll('#daw-kb-hud .kbk.ct i')].map(e => e.textContent.replace(/[0-9-]/g, ''))`);
    expect('가이드 코드톤에 A·C·E·G 포함', ['A', 'C', 'E', 'G'].every(n => ctKeys.includes(n)) && !ctKeys.includes('D'), true);
    expect('가이드에 지금 코드 이름', await js(`document.querySelector('.kbg-chord')?.textContent`), 'Am7');
    // 피아노롤이 열려 있어도 가이드가 위에 보인다(가운데 지점을 덮는 게 가이드인지)
    expect('가이드가 피아노롤 위에 보임', await js(`(() => { const h = document.getElementById('daw-kb-hud'); if (!h) return false; const r = h.getBoundingClientRect(); const pr = document.querySelector('.pr'); const zH = +getComputedStyle(h).zIndex, zP = pr ? +getComputedStyle(pr).zIndex : 0; return r.width > 0 && zH > zP; })()`), true);
    await key('Escape'); await wait(100);
  }

  section('6) 저장 · 다시 열기');
  await key('S', ['control']);
  for (let i = 0; i < 40 && !fs.existsSync(PROJ); i++) await wait(150);
  await wait(300);
  const pj = fs.existsSync(PROJ) ? JSON.parse(fs.readFileSync(PROJ, 'utf8')) : {};
  expect('파일에 코드 2개', (pj.chordTrack || []).map(c => c.name).join(','), 'Am7,G/B');
  await js(`document.getElementById('empty-open-proj').click(); true`);
  for (let i = 0; i < 30 && (await blocks()).length !== 2; i++) await wait(200);
  await wait(300);
  expect('다시 열면 코드 2개 그대로', (await blocks()).map(b => b.name).join(','), 'Am7,G/B');

  fs.writeFileSync(path.join(os.tmpdir(), 'yss-studiochord.png'), (await win.webContents.capturePage()).toPNG());
  finish(app);
})().catch(e => { console.error(e); process.exit(1); });
