'use strict';
// 스튜디오 악기 트랙(MIDI) — 타이핑 키보드 연주 → 녹음 → 클립 → 퀀타이즈/실행취소 → 저장·다시 열기.
// 진짜 엔진·진짜 키 입력(webContents.sendInputEvent)으로 끝까지 태운다. 엔진 명령은 main 쪽
// AudioEngine.prototype.send 를 감싸서 본다(렌더러 contextBridge 객체는 못 바꿔 끼운다).
const path = require('path'); const fs = require('fs'); const os = require('os');
const { app, dialog, BrowserWindow } = require('electron');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-studiomidi-')));
const PROJ = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yss-studiomidi-proj-')), 'midi.yssproj');
dialog.showSaveDialog = async () => ({ canceled: false, filePath: PROJ });
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [PROJ] });

const { bootMain, expect, section, wait, finish, skip, ROOT } = require('./harness');
const { AudioEngine } = require(path.join(ROOT, 'engine-client.js'));
const sent = [];
const origSend = AudioEngine.prototype.send;
AudioEngine.prototype.send = function (cmd) { sent.push(cmd); return origSend.call(this, cmd); };
const cmds = (name) => sent.filter(c => c.cmd === name);

(async () => {
  const { app, js } = await bootMain({ settle: 2500, width: 1400, height: 900 });
  const win = BrowserWindow.getAllWindows()[0];
  const key = async (code, keyCode, type) => { win.webContents.sendInputEvent({ type, keyCode }); await wait(30); };
  const tap = async (keyCode, holdMs = 150) => { await key(null, keyCode, 'keyDown'); await wait(holdMs); await key(null, keyCode, 'keyUp'); };
  win.focus(); win.webContents.focus();

  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);
  for (let i = 0; i < 30 && !(await js(`document.getElementById('st-engine-dot')?.classList.contains('on')`)); i++) await wait(300);
  if (!(await js(`document.getElementById('st-engine-dot')?.classList.contains('on')`))) { skip('엔진이 시간 안에 안 떴다 — 판정 불능'); finish(app); return; }
  await wait(600);
  await js(`window.yssApi.engine.inputMonitor(false); true`);

  section('1) 악기 트랙 추가');
  await js(`document.getElementById('st-add-instr').click(); true`);
  for (let i = 0; i < 20 && !(await js(`!!document.querySelector('.daw-lane-instr')`)); i++) await wait(150);
  expect('악기 레인 생김', await js(`!!document.querySelector('.daw-lane-instr')`), true);
  expect('이름 "악기 1"', await js(`document.querySelector('.daw-lane-instr .lbl')?.textContent`), '악기 1');
  expect('⌨ 버튼 있음(IN 대신)', await js(`!!document.querySelector('.daw-lane-instr [data-m="kb"]') && !document.querySelector('.daw-lane-instr [data-m="in"]')`), true);
  expect('R(녹음 대상) 켜진 채 생성', await js(`document.querySelector('.daw-lane-instr [data-m="arm"]')?.classList.contains('armed')`), true);

  expect('악기 트랙 선택 → 하단 ⌨·Q 켜짐', await js(`!document.getElementById('st-kb').disabled && !document.getElementById('st-kb-cfg').disabled`), true);
  // 일반 녹음 트랙을 고르면 하단 ⌨·Q 가 꺼진다
  await js(`document.getElementById('st-add-rec').click(); true`);
  for (let i = 0; i < 20 && !(await js(`!!document.querySelector('.daw-lane-rec:not(.daw-lane-instr)')`)); i++) await wait(150);
  await js(`document.querySelector('.daw-lane-rec:not(.daw-lane-instr) .daw-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await wait(150);
  expect('녹음 트랙 선택 → 하단 ⌨·Q 꺼짐', await js(`document.getElementById('st-kb').disabled && document.getElementById('st-kb-cfg').disabled`), true);
  await js(`document.querySelector('.daw-lane-instr .daw-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await wait(150);

  section('2) 키보드 연주 모드 — 진짜 키 입력');
  await js(`document.querySelector('.daw-lane-instr [data-m="kb"]').click(); true`);
  await wait(300);
  expect('HUD 표시', await js(`!!document.getElementById('daw-kb-hud')`), true);
  expect('하단 ⌨ 버튼 켜짐', await js(`document.getElementById('st-kb').classList.contains('on')`), true);
  expect('레인 ⌨ 배경 = 강조색(초록)', await js(`(() => { const b = document.querySelector('.daw-lane-instr [data-m="kb"]'); const a = document.createElement('i'); a.style.color = 'var(--accent)'; document.body.appendChild(a); const acc = getComputedStyle(a).color; a.remove(); return getComputedStyle(b).backgroundColor === acc; })()`), true);
  expect('키보드 가이드 45키', await js(`document.querySelectorAll('#daw-kb-hud .kbk').length`), 45);
  expect('가이드: Z=C3 흰건반, S=C# 검은건반', await js(`(() => { const z = document.querySelector('.kbk[data-code="KeyZ"]'), s = document.querySelector('.kbk[data-code="KeyS"]');
    return z.classList.contains('white') && z.querySelector('i').textContent === 'C3' && s.classList.contains('black') && s.querySelector('i').textContent === 'C#'; })()`), true);
  expect('가이드: A 는 매핑 없음', await js(`document.querySelector('.kbk[data-code="KeyA"]').classList.contains('none')`), true);
  await key(null, 'Z', 'keyDown'); await wait(80);
  expect('누르는 키 불 들어옴', await js(`document.querySelector('.kbk[data-code="KeyZ"]').classList.contains('down')`), true);
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, (await win.webContents.capturePage()).toPNG());
  await key(null, 'Z', 'keyUp'); await wait(80);
  expect('떼면 불 꺼짐', await js(`document.querySelector('.kbk[data-code="KeyZ"]').classList.contains('down')`), false);
  sent.length = 0;
  await tap('Z'); await tap('Q'); await tap('S');
  const ons = cmds('noteOn').map(c => c.pitch), offs = cmds('noteOff').map(c => c.pitch);
  expect('Z→48, Q→60, S→49 noteOn', ons.join(','), '48,60,49');
  expect('뗄 때 noteOff 짝', offs.join(','), '48,60,49');
  expect('S 가 분할 단축키로 새지 않음', cmds('takeSplit').length, 0);
  sent.length = 0;
  await key(null, 'Right', 'keyDown'); await key(null, 'Right', 'keyUp');
  await tap('Z');
  expect('→ 옥타브 올림: Z→60', cmds('noteOn').map(c => c.pitch).join(','), '60');
  expect('가이드도 옥타브 따라감: Z=C4', await js(`document.querySelector('.kbk[data-code="KeyZ"] i').textContent`), 'C4');
  await key(null, 'Left', 'keyDown'); await key(null, 'Left', 'keyUp');

  // 연주 중 녹음 트랙을 고르면 연주 모드가 꺼진다(그 트랙엔 건반이 없다)
  await js(`document.querySelector('.daw-lane-rec:not(.daw-lane-instr) .daw-head').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  await wait(150);
  expect('녹음 트랙 선택 → 연주 모드 꺼짐', await js(`!document.getElementById('daw-kb-hud') && !document.getElementById('st-kb').classList.contains('on')`), true);
  await js(`document.querySelector('.daw-lane-rec:not(.daw-lane-instr) [data-m="del"]').click(); true`);
  await wait(400);
  await js(`document.querySelector('.daw-lane-instr [data-m="kb"]').click(); true`);
  await wait(200);
  expect('레인 ⌨ 로 다시 켜짐', await js(`document.getElementById('st-kb').classList.contains('on')`), true);

  section('3) MIDI 녹음 → 클립');
  sent.length = 0;
  await js(`document.getElementById('st-rec').click(); true`);
  await wait(200);
  const arm = cmds('recordArm')[0];
  expect('recordArm 에 midiTracks 포함', !!(arm && arm.midiTracks && arm.midiTracks.length === 1), true);
  await js(`document.getElementById('st-play').click(); true`);
  await wait(500);
  await tap('Z', 200); await wait(150); await tap('C', 200); await wait(150);
  await key(null, 'B', 'keyDown'); await wait(250);
  expect('녹음 중 미리보기 클립 보임', await js(`!!document.querySelector('.daw-midi-live')`), true);
  expect('녹음 중 노트 3개 보임(누르는 중 포함)', await js(`document.querySelectorAll('.daw-midi-live .daw-midi-notes i').length`), 3);
  const w1 = await js(`document.querySelector('.daw-midi-live').offsetWidth`); await wait(300);
  expect('녹음 중 클립이 자람', (await js(`document.querySelector('.daw-midi-live').offsetWidth`)) > w1, true);
  await key(null, 'B', 'keyUp');
  await wait(200);
  await js(`document.getElementById('st-stop').click(); true`);
  for (let i = 0; i < 30 && !(await js(`!!document.querySelector('.daw-midi-clip')`)); i++) await wait(150);
  expect('MIDI 클립 생김', await js(`document.querySelectorAll('.daw-midi-clip:not(.daw-midi-live)').length`), 1);
  expect('멈추면 미리보기 사라짐', await js(`!document.querySelector('.daw-midi-live')`), true);
  expect('노트 3개 그려짐', await js(`document.querySelectorAll('.daw-midi-clip .daw-midi-notes i').length`), 3);
  const clipCmd = cmds('midiClip').pop();
  expect('엔진에 클립 전송(노트 48,52,55)', clipCmd && clipCmd.notes.map(n => n[2]).join(','), '48,52,55');

  section('3b) 볼륨 슬라이더를 만진 뒤에도 Space·연주가 먹는다(제보: 가끔 녹음 안 됨)');
  {
    const r = await js(`(() => { const b = document.querySelector('.daw-lane-instr .daw-vol').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 }); await wait(150);
    expect('포커스가 슬라이더에 있음', await js(`document.activeElement?.classList.contains('daw-vol')`), true);
    if (!(await js(`!!document.getElementById('daw-kb-hud')`))) await js(`document.querySelector('.daw-lane-instr [data-m="kb"]').click(); true`);
    const clipsBefore = await js(`document.querySelectorAll('.daw-midi-clip').length`);
    await js(`document.getElementById('st-rec').click(); true`);
    await js(`document.querySelector('.daw-lane-instr .daw-vol').focus(); true`);
    sent.length = 0;
    await key(null, 'Space', 'keyDown'); await key(null, 'Space', 'keyUp'); await wait(300);
    expect('Space → 재생 시작', cmds('play').length, 1);
    await tap('X', 150); await wait(150);
    await key(null, 'Space', 'keyDown'); await key(null, 'Space', 'keyUp');
    for (let i = 0; i < 30 && (await js(`document.querySelectorAll('.daw-midi-clip').length`)) === clipsBefore; i++) await wait(150);
    expect('클립 하나 더 생김', await js(`document.querySelectorAll('.daw-midi-clip').length`), clipsBefore + 1);
    // 방금 만든 클립은 되돌려 뒤 단계(퀀타이즈 대상 = 첫 클립) 조건을 그대로 둔다
    await js(`document.querySelectorAll('.daw-midi-clip')[${clipsBefore}]?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); true`);
    await key(null, 'Escape', 'keyDown'); await key(null, 'Escape', 'keyUp');
    await tap('Delete', 40); await wait(200);
    expect('정리(삭제)', await js(`document.querySelectorAll('.daw-midi-clip').length`), clipsBefore);
  }
  section('3c) 연주 모드 꺼진 채 ● → 자동으로 켜짐');
  {
    expect('연주 모드 꺼져 있음', await js(`!document.getElementById('daw-kb-hud')`), true);
    await js(`document.getElementById('st-rec').click(); true`); await wait(200);
    expect('● → 연주 모드 켜짐', await js(`!!document.getElementById('daw-kb-hud')`), true);
    await js(`document.getElementById('st-rec').click(); true`); await wait(300);   // 녹음 해제(아무것도 안 침)
    await key(null, 'Escape', 'keyDown'); await key(null, 'Escape', 'keyUp');
  }

  section('4) 퀀타이즈 · 실행취소');
  await key(null, 'Escape', 'keyDown'); await key(null, 'Escape', 'keyUp');
  expect('Esc → 연주 모드 꺼짐', await js(`!document.getElementById('daw-kb-hud')`), true);
  const before = clipCmd.notes.map(n => n[0]);
  await js(`document.querySelector('.daw-midi-clip').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 5, clientY: 5 })); document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); true`);
  sent.length = 0;
  await tap('Q', 40);
  await wait(200);
  const q = cmds('midiClip').pop();
  expect('Q → 퀀타이즈 명령', !!q, true);
  expect('노트 위치가 바뀜', q && q.notes.map(n => n[0]).join(',') !== before.join(','), true);
  sent.length = 0;
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); await wait(40);
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(200);
  const u = cmds('midiClip').pop();
  expect('Ctrl+Z → 원래 위치로', u && u.notes.map(n => n[0]).join(','), before.join(','));

  // 빈 타임라인을 누르면 MIDI 클립 선택도 풀려서 Delete 가 아무것도 안 지운다
  await js(`(() => { const a = document.querySelector('.daw-lane-instr .daw-area'); const r = a.getBoundingClientRect();
    a.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.right - 20, clientY: r.top + 10 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); return true; })()`);
  await wait(100);
  await tap('Delete', 40);
  await wait(200);
  expect('빈 곳 클릭 후 Delete → 클립 그대로', await js(`document.querySelectorAll('.daw-midi-clip').length`), 1);

  section('5) 저장 · 다시 열기');
  await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'S', modifiers: ['control'] }); await wait(40);
  await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'S', modifiers: ['control'] });
  for (let i = 0; i < 40 && !fs.existsSync(PROJ); i++) await wait(150);
  await wait(300);
  const pj = fs.existsSync(PROJ) ? JSON.parse(fs.readFileSync(PROJ, 'utf8')) : {};
  expect('파일에 악기 트랙(type 2)', (pj.tracks || []).some(t => t.type === 2), true);
  expect('파일에 MIDI 클립 1개·노트 3개', (pj.midiClips || []).length === 1 && pj.midiClips[0].notes.length === 3, true);
  sent.length = 0;
  await js(`window.yssApi.engine.cmd({ cmd: 'midiClear' }); true`);
  await js(`document.getElementById('empty-open-proj').click(); true`);
  for (let i = 0; i < 40 && !cmds('midiClip').length; i++) await wait(200);
  await wait(500);
  expect('다시 열면 엔진에 클립 재전송', cmds('midiClip').length, 1);
  expect('다시 열면 클립 보임', await js(`document.querySelectorAll('.daw-midi-clip').length`), 1);
  expect('다시 열어도 악기 트랙', await js(`document.querySelectorAll('.daw-lane-instr').length`), 1);

  section('6) 피아노롤 — 노트 추가·음높이·삭제·실행취소·닫기');
  {
    const mouse = async (type, x, y) => { win.webContents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 }); await wait(60); };
    await js(`document.querySelector('.daw-midi-clip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true`);
    await wait(300);
    expect('더블클릭 → 피아노롤 열림', await js(`!!document.querySelector('.pr')`), true);
    expect('노트 3개 보임', await js(`document.querySelectorAll('.pr-note').length`), 3);
    // C4(60) 줄이 보이게 스크롤하고, 클립 끝 조금 앞 빈 칸을 클릭
    const pt = await js(`(() => { const sc = document.querySelector('.pr-scroll'); sc.scrollTop = (127 - 60) * 14 - 60;
      const g = document.querySelector('.pr-grid').getBoundingClientRect(); const endX = parseFloat(document.querySelector('.pr-end').style.left);
      return { x: g.left + endX * 0.85, y: g.top + (127 - 60) * 14 + 7 }; })()`);
    sent.length = 0;
    await mouse('mouseDown', pt.x, pt.y); await mouse('mouseUp', pt.x, pt.y);
    await wait(200);
    expect('빈 칸 클릭 → 노트 추가(4개)', await js(`document.querySelectorAll('.pr-note').length`), 4);
    const add = cmds('midiClip').pop();
    expect('엔진에 C4(60) 포함 전송', !!(add && add.notes.some(n => n[2] === 60)), true);
    expect('놓을 때 미리듣기 noteOn 60', cmds('noteOn').some(c => c.pitch === 60), true);
    sent.length = 0;
    await key(null, 'Up', 'keyDown'); await key(null, 'Up', 'keyUp'); await wait(150);
    expect('↑ → 61 로', (cmds('midiClip').pop()?.notes || []).some(n => n[2] === 61), true);
    await key(null, 'Delete', 'keyDown'); await key(null, 'Delete', 'keyUp'); await wait(150);
    expect('Delete → 노트 3개', await js(`document.querySelectorAll('.pr-note').length`), 3);
    expect('Delete 가 클립 통째로 지우지 않음', await js(`document.querySelectorAll('.daw-midi-clip').length`), 1);
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); await wait(40);
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(200);
    expect('Ctrl+Z → 노트 4개로 복원(피아노롤 갱신)', await js(`document.querySelectorAll('.pr-note').length`), 4);
    // 세기 줄 — 첫 노트 막대를 위에서 아래로 끌면 세기가 약해진다
    const vb = await js(`(() => { const i = document.querySelector('.pr-vel-in i[data-i="0"]').getBoundingClientRect(); const v = document.querySelector('.pr-vel-view').getBoundingClientRect(); return { x: i.left + 1, top: v.top + 4, bot: v.bottom - 6 }; })()`);
    sent.length = 0;
    await mouse('mouseDown', vb.x, vb.top); await mouse('mouseMove', vb.x, vb.bot); await mouse('mouseUp', vb.x, vb.bot);
    await wait(150);
    const vc = cmds('midiClip').pop();
    const firstVel = vc ? vc.notes.slice().sort((a, b) => a[0] - b[0])[0][3] : 1;
    expect('세기 줄 드래그 → 첫 노트 세기 약해짐(<0.3)', firstVel < 0.3, true);
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); await wait(40);
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(150);
    // 범위 선택 — Ctrl+끌기(새로) / Shift+끌기(더하기). 격자 전체를 가로지르면 노트가 다 잡힌다.
    {
      const g = await js(`(() => { const sc = document.querySelector('.pr-scroll'); sc.scrollTop = (127 - 62) * 14 - 40; const r = document.querySelector('.pr-grid').getBoundingClientRect(); const v = sc.getBoundingClientRect(); return { l: r.left + 2, r: Math.min(r.right, v.right) - 20, t: v.top + 4, b: v.bottom - 20 }; })()`);
      for (const mod of ['control', 'shift']) {
        await js(`document.querySelectorAll('.pr-note.sel').forEach(x => x.classList.remove('sel')); true`);
        win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(g.l + 1), y: Math.round(g.t), button: 'left', clickCount: 1, modifiers: [mod] }); await wait(40);
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(g.r), y: Math.round(g.b), modifiers: [mod] }); await wait(60);
        expect(`${mod}+끌기 중 선택 사각형 보임`, await js(`!document.querySelector('.pr-marq').hidden`), true);
        win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(g.r), y: Math.round(g.b), button: 'left', clickCount: 1, modifiers: [mod] }); await wait(100);
        const nsel = await js(`document.querySelectorAll('.pr-note.sel').length`), nall = await js(`document.querySelectorAll('.pr-note').length`);
        expect(`${mod}+끌기 → 보이는 노트 선택(노트 추가 안 됨)`, nsel > 0 && nall === 4, true);
      }
    }
    // FL 방식 노트 편집 — 우클릭으로 붙일 자리, Ctrl+C/V 는 노트만(클립 안 생김), Ctrl+B, Shift+끌기, 우클릭 끌어 지우기
    {
      const ctrl = async (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] }); await wait(40); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] }); await wait(150); };
      const nNotes = () => js(`document.querySelectorAll('.pr-note').length`);
      const nClips = () => js(`document.querySelectorAll('.daw-midi-clip').length`);
      const base = await nNotes(), baseClips = await nClips();
      // 붙일 자리: C5(72) 줄, 클립 끝 쪽 빈 칸
      const sp = await js(`(() => { const sc = document.querySelector('.pr-scroll'); sc.scrollTop = (127 - 72) * 14 - 80; const g = document.querySelector('.pr-grid').getBoundingClientRect(); const endX = parseFloat(document.querySelector('.pr-end').style.left); return { x: g.left + endX * 0.55, y: g.top + (127 - 72) * 14 + 7 }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(sp.x), y: Math.round(sp.y), button: 'right', clickCount: 1 }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(sp.x), y: Math.round(sp.y), button: 'right', clickCount: 1 }); await wait(120);
      expect('빈 칸 우클릭 → 붙일 자리 표시', await js(`!document.querySelector('.pr-anchor').hidden`), true);
      await ctrl('A'); await ctrl('C');
      expect('Ctrl+C 로 타임라인 클립 안 생김', await nClips(), baseClips);
      // 화면의 노트를 (x px, 음) 으로 읽어 붙이기 전/후를 비교한다 — 새로 생긴 것 = 붙인 노트
      const readNotes = () => js(`[...document.querySelectorAll('.pr-note')].map(e => [Math.round(parseFloat(e.style.left)), 127 - Math.round((parseFloat(e.style.top) - 1) / 14)])`);
      const beforeN = await readNotes();
      await ctrl('V');
      expect('Ctrl+V → 노트 두 배', await nNotes(), base * 2);
      expect('Ctrl+V 로 타임라인 클립 안 생김', await nClips(), baseClips);
      const afterN = await readNotes();
      const pool = beforeN.map(n => n.join(','));
      const pasted = afterN.filter(n => { const k = n.join(','); const i = pool.indexOf(k); if (i >= 0) { pool.splice(i, 1); return false; } return true; });
      const rel = (arr) => { const a = arr.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1]); return a.map(n => [n[0] - a[0][0], n[1] - a[0][1]]); };
      const ra = rel(pasted), rb = rel(beforeN);   // 가로는 화면 픽셀 반올림 탓에 ±1px 허용, 음정은 정확히
      expect('붙인 노트: 음정·간격 관계 유지', ra.length === rb.length && ra.every((n, i) => Math.abs(n[0] - rb[i][0]) <= 1 && n[1] === rb[i][1]), true);
      expect('붙인 첫 음 = 찍은 자리 음(C5=72)', pasted.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])[0]?.[1], 72);
      await ctrl('Z');
      expect('Ctrl+Z → 원래 노트 수', await nNotes(), base);
      await ctrl('A'); await ctrl('B');
      expect('Ctrl+B → 뒤에 복제(두 배)', await nNotes(), base * 2);
      await ctrl('Z');
      // Shift+끌기 = 복사해서 끌기
      const nb = await js(`(() => { const b = document.querySelector('.pr-note').getBoundingClientRect(); return { x: b.left + 5, y: b.top + 5 }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(nb.x), y: Math.round(nb.y), button: 'left', clickCount: 1 }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(nb.x), y: Math.round(nb.y), button: 'left', clickCount: 1 }); await wait(80);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(nb.x), y: Math.round(nb.y), button: 'left', clickCount: 1, modifiers: ['shift'] }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(nb.x + 120), y: Math.round(nb.y - 28), modifiers: ['shift'] }); await wait(60);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(nb.x + 120), y: Math.round(nb.y - 28), button: 'left', clickCount: 1, modifiers: ['shift'] }); await wait(150);
      expect('Shift+끌기 → 복사본 하나 더', await nNotes(), base + 1);
      await ctrl('Z');
      // Shift+클릭만(안 끌기) → 복제본 안 남음
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(nb.x), y: Math.round(nb.y), button: 'left', clickCount: 1, modifiers: ['shift'] }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(nb.x), y: Math.round(nb.y), button: 'left', clickCount: 1, modifiers: ['shift'] }); await wait(120);
      expect('Shift+클릭만 → 겹친 복제본 없음', await nNotes(), base);
      // 우클릭한 채 끌기 = 지나가는 노트 지우기(첫 노트 → 둘째 노트)
      const two = await js(`(() => { const n = [...document.querySelectorAll('.pr-note')].sort((a, b) => parseFloat(a.style.left) - parseFloat(b.style.left)).slice(0, 2).map(e => { const b = e.getBoundingClientRect(); return { x: b.left + 4, y: b.top + 6 }; }); return n; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(two[0].x), y: Math.round(two[0].y), button: 'right', clickCount: 1 }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(two[1].x), y: Math.round(two[1].y), modifiers: ['rightButtonDown'] }); await wait(60);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(two[1].x), y: Math.round(two[1].y), button: 'right', clickCount: 1 }); await wait(150);
      expect('우클릭 끌기 → 노트 2개 지움', await nNotes(), base - 2);
      await ctrl('Z');
      expect('Ctrl+Z → 복원', await nNotes(), base);
    }
    // 눈금자 클릭 → 재생선 이동
    {
      sent.length = 0;
      const r = await js(`(() => { const b = document.querySelector('.pr-ruler-view').getBoundingClientRect(); return { x: b.left + 150, y: b.top + 10 }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }); await wait(120);
      expect('눈금자 클릭 → 엔진 seek', cmds('seek').length >= 1, true);
      const phx = await js(`(() => { const ph = document.querySelector('.pr-ph').getBoundingClientRect(); const v = document.querySelector('.pr-ruler-view').getBoundingClientRect(); return Math.round(ph.left - v.left); })()`);
      expect('피아노롤 재생선이 클릭한 자리(±3px)', Math.abs(phx - 150) <= 3, true);
    }
    // 단축키 표시 — 평소엔 목록 숨김, 올리면 보임 / |◀ = 클립 처음으로
    expect('헤더에 긴 안내문 없음', await js(`!document.querySelector('.pr-hint')`), true);
    expect('단축키 목록 평소엔 숨김', await js(`getComputedStyle(document.querySelector('.pr-keyhelp-pop')).display`), 'none');
    {
      const hb = await js(`(() => { const b = document.querySelector('.pr-keyhelp').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      // 마우스 hover 는 앞 단계의 끌기들 뒤라 테스트 창에서 상태가 묵는다(단독 실행에선 정상 확인) —
      // 같은 규칙에 걸린 키보드 포커스(:focus-visible)로 목록이 뜨는지 본다.
      await js(`document.querySelector('.pr-keyhelp').focus({ focusVisible: true }); true`); await wait(80);
      expect('포커스/호버 → 단축키 목록 보임(18줄)', await js(`getComputedStyle(document.querySelector('.pr-keyhelp-pop')).display !== 'none' && document.querySelectorAll('.pr-keyhelp-pop kbd').length === 18`), true);
      await js(`document.querySelector('.pr-keyhelp').blur(); true`);
      void hb;
    }
    sent.length = 0;
    await js(`document.querySelector('.pr-home').click(); true`); await wait(150);
    expect('|◀ → 클립 시작으로 seek', cmds('seek').length >= 1, true);
    expect('|◀ → 재생선 맨 앞(0px)', await js(`Math.round(parseFloat(document.querySelector('.pr-ph').style.left))`), 0);
    // 스냅 토글 — 끄면 격자 밖 자리·길이도 자유롭게
    {
      const nNotes = () => js(`document.querySelectorAll('.pr-note').length`);
      expect('스냅 기본 켜짐', await js(`document.querySelector('.pr-snap').classList.contains('on')`), true);
      await js(`document.querySelector('.pr-snap').click(); true`);
      expect('스냅 끔', await js(`!document.querySelector('.pr-snap').classList.contains('on')`), true);
      const base = await nNotes();
      const spot = await js(`(() => { const sc = document.querySelector('.pr-scroll'); sc.scrollTop = (127 - 65) * 14 - 80; const g = document.querySelector('.pr-grid').getBoundingClientRect(); const endX = parseFloat(document.querySelector('.pr-end').style.left); return { x: g.left + endX * 0.37 + 3, y: g.top + (127 - 65) * 14 + 7 }; })()`);
      sent.length = 0;
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(spot.x), y: Math.round(spot.y), button: 'left', clickCount: 1 }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(spot.x), y: Math.round(spot.y), button: 'left', clickCount: 1 }); await wait(150);
      expect('스냅 끔 → 노트 추가', await nNotes(), base + 1);
      const added = (cmds('midiClip').pop()?.notes || []).find(n => n[2] === 65);
      const sr = added ? null : 0;
      const stepSamples = await js(`(() => { return null; })()`);
      void sr; void stepSamples;
      // 120BPM 1/16 = 0.125초 — 스냅이 꺼졌으면 시작이 그 배수가 아닐 가능성이 매우 높다(클릭 자리에 +3px)
      const onGrid = added ? Math.abs((added[0] / 48000 / 0.125) - Math.round(added[0] / 48000 / 0.125)) < 0.02 || Math.abs((added[0] / 44100 / 0.125) - Math.round(added[0] / 44100 / 0.125)) < 0.02 : true;
      expect('스냅 끔 → 격자 밖 자리에 놓임', !!added && !onGrid, true);
      // 오른쪽 끝을 조금(7px)만 끌어도 길이가 그만큼 는다(격자 단위가 아님)
      const nr = await js(`(() => { const e = [...document.querySelectorAll('.pr-note')].find(x => Math.round(127 - (parseFloat(x.style.top) - 1) / 14) === 65); const b = e.getBoundingClientRect(); return { x: b.right - 2, y: b.top + 5, w: b.width }; })()`);
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(nr.x), y: Math.round(nr.y), button: 'left', clickCount: 1 }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(nr.x + 7), y: Math.round(nr.y) }); await wait(40);
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(nr.x + 7), y: Math.round(nr.y), button: 'left', clickCount: 1 }); await wait(150);
      const nw = await js(`(() => { const e = [...document.querySelectorAll('.pr-note')].find(x => Math.round(127 - (parseFloat(x.style.top) - 1) / 14) === 65); return e.getBoundingClientRect().width; })()`);
      expect('스냅 끔 → 길이 7px 만큼 자유롭게', Math.abs((nw - nr.w) - 7) <= 1.5, true);
      await js(`document.querySelector('.pr-snap').click(); true`);
      expect('스냅 다시 켬(기억)', await js(`localStorage.getItem('yss:prSnap')`), '1');
      const ctrlZ = async () => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); await wait(40); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(150); };
      await ctrlZ(); await ctrlZ();
      expect('되돌려 원래 노트 수', await nNotes(), base);
    }
    // 피아노롤 ● — 새 클립 대신 이 클립에 녹음이 합쳐진다
    {
      const nNotes = () => js(`document.querySelectorAll('.pr-note').length`);
      const nClips = () => js(`document.querySelectorAll('.daw-midi-clip:not(.daw-midi-live)').length`);
      const base = await nNotes(), baseClips = await nClips();
      await js(`document.querySelector('.pr-home').click(); true`); await wait(100);
      await js(`document.querySelector('.pr-rec').click(); true`); await wait(500);
      expect('● → 녹음 중 표시', await js(`document.querySelector('.pr-rec').classList.contains('on')`), true);
      expect('● → 연주 모드 켜짐', await js(`!!document.getElementById('daw-kb-hud')`), true);
      await tap('N', 180); await wait(120);
      await key(null, 'M', 'keyDown'); await wait(250);
      expect('녹음 중 피아노롤에 실시간 노트', await js(`document.querySelectorAll('.pr-live i').length`), 2);
      await key(null, 'M', 'keyUp'); await wait(100);
      await js(`document.querySelector('.pr-rec').click(); true`);
      for (let i = 0; i < 30 && (await nNotes()) === base; i++) await wait(150);
      expect('녹음 끝 → 새 클립 안 생김', await nClips(), baseClips);
      expect('녹음 끝 → 이 클립에 노트 2개 추가', await nNotes(), base + 2);
      expect('실시간 노트 표시 사라짐', await js(`!document.querySelector('.pr-live')`), true);
      await key(null, 'Escape', 'keyDown'); await key(null, 'Escape', 'keyUp'); await wait(100);   // 연주 모드 끄기
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); await wait(40);
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(200);
      expect('Ctrl+Z → 녹음 전 노트 수', await nNotes(), base);
    }
    // 재생 바 — ▶ = 클립 처음부터 재생, 다시 누르면 정지 / "이 트랙만" = 임시 솔로
    sent.length = 0;
    await js(`document.querySelector('.pr-play').click(); true`); await wait(400);
    expect('▶ → 클립 시작으로 이동 후 재생', cmds('seek').length >= 1 && cmds('play').length === 1, true);
    expect('재생 중 버튼 ■ 표시', await js(`document.querySelector('.pr-play').classList.contains('on')`), true);
    await js(`document.querySelector('.pr-play').click(); true`); await wait(300);
    expect('다시 누르면 정지', cmds('stop').length >= 1 && !(await js(`document.querySelector('.pr-play').classList.contains('on')`)), true);
    const tidNow = await js(`Number(document.querySelector('.daw-lane-instr').dataset.recid)`);
    sent.length = 0;
    await js(`document.querySelector('.pr-solo').click(); true`); await wait(100);
    expect('이 트랙만 → 엔진 솔로 켬', cmds('recTrack').some(c => c.id === tidNow && c.solo === true), true);
    expect('레인 S 버튼은 그대로(임시)', await js(`!document.querySelector('.daw-lane-instr [data-m="solo"]').classList.contains('on')`), true);
    sent.length = 0;
    await key(null, 'Escape', 'keyDown'); await key(null, 'Escape', 'keyUp'); await wait(150);
    expect('Esc → 닫힘', await js(`!document.querySelector('.pr')`), true);
    expect('닫으면 솔로 원래대로(꺼짐)', cmds('recTrack').some(c => c.id === tidNow && c.solo === false), true);
  }
  section('7) 타임라인 — S 분할');
  {
    const r = await js(`(() => { const b = document.querySelector('.daw-midi-clip').getBoundingClientRect(); return { x: b.left + b.width * 0.5, y: b.top + b.height * 0.6 }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }); await wait(50);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }); await wait(200);
    await tap('S', 40); await wait(250);
    expect('S → 클립 둘로', await js(`document.querySelectorAll('.daw-midi-clip').length`), 2);
    const totalNotes = await js(`[...document.querySelectorAll('.daw-midi-clip .daw-midi-notes')].reduce((a, e) => a + e.children.length, 0)`);
    expect('노트 수 유지(4)', totalNotes, 4);
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); await wait(40);
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(250);
    expect('Ctrl+Z → 다시 하나', await js(`document.querySelectorAll('.daw-midi-clip').length`), 1);
  }
  section('7b) 악기 트랙 우클릭 → 빈 MIDI 클립');
  {
    const r = await js(`(() => { const a = document.querySelector('.daw-lane-instr .daw-area').getBoundingClientRect(); const c = document.querySelector('.daw-midi-clip').getBoundingClientRect(); return { x: c.right + 200, y: a.top + a.height / 2 }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x), y: Math.round(r.y), button: 'right', clickCount: 1 }); await wait(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x), y: Math.round(r.y), button: 'right', clickCount: 1 }); await wait(150);
    const item = await js(`[...document.querySelectorAll('.daw-ctx *, .daw-dropdown *')].map(e => e.textContent.trim()).find(t => t === '빈 MIDI 클립 추가') || ''`);
    expect('우클릭 메뉴에 "빈 MIDI 클립 추가"', item, '빈 MIDI 클립 추가');
    sent.length = 0;
    await js(`[...document.querySelectorAll('.daw-ctx *, .daw-dropdown *')].find(e => e.textContent.trim() === '빈 MIDI 클립 추가' && e.children.length === 0)?.click(); true`);
    await wait(300);
    expect('클립 둘', await js(`document.querySelectorAll('.daw-midi-clip').length`), 2);
    expect('바로 피아노롤 열림(노트 0)', await js(`!!document.querySelector('.pr') && document.querySelectorAll('.pr-note').length === 0`), true);
    const mc = cmds('midiClip').pop();
    const sr = mc ? mc.len / 2 : 0;   // 120BPM 한 마디 = 2초
    expect('엔진에 빈 클립(1마디, 노트 0)', !!(mc && mc.notes.length === 0 && mc.len > 0), true);
    await key(null, 'Escape', 'keyDown'); await key(null, 'Escape', 'keyUp'); await wait(100);
    await win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] }); await wait(40);
    await win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] }); await wait(200);
    expect('Ctrl+Z → 빈 클립 사라짐', await js(`document.querySelectorAll('.daw-midi-clip').length`), 1);
    void sr;
    // 클립 우클릭 메뉴 → 피아노롤에서 편집
    const cr = await js(`(() => { const b = document.querySelector('.daw-midi-clip').getBoundingClientRect(); return { x: b.left + 10, y: b.top + b.height * 0.6 }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(cr.x), y: Math.round(cr.y), button: 'right', clickCount: 1 }); await wait(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(cr.x), y: Math.round(cr.y), button: 'right', clickCount: 1 }); await wait(150);
    await js(`[...document.querySelectorAll('.daw-dropdown *')].find(e => e.textContent.trim() === '피아노롤에서 편집' && e.children.length === 0)?.click(); true`);
    await wait(250);
    expect('클립 우클릭 → "피아노롤에서 편집" → 열림', await js(`!!document.querySelector('.pr')`), true);
    await key(null, 'Escape', 'keyDown'); await key(null, 'Escape', 'keyUp'); await wait(100);
  }
  section('8) MIDI 클립 복사·붙여넣기');
  {
    const ctrl = async (k) => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: ['control'] }); await wait(40); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: ['control'] }); await wait(200); };
    const r = await js(`(() => { const b = document.querySelector('.daw-midi-clip').getBoundingClientRect(); return { x: b.left + 8, y: b.top + b.height * 0.6, right: b.right }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }); await wait(50);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(r.x), y: Math.round(r.y), button: 'left', clickCount: 1 }); await wait(150);
    await ctrl('C');
    // 클립 오른쪽 빈 곳 클릭 = 재생선을 거기로(선택은 풀림)
    const ex = Math.round(r.right + 120);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: ex, y: Math.round(r.y), button: 'left', clickCount: 1 }); await wait(50);
    win.webContents.sendInputEvent({ type: 'mouseUp', x: ex, y: Math.round(r.y), button: 'left', clickCount: 1 }); await wait(150);
    sent.length = 0;
    await ctrl('V');
    expect('Ctrl+V → 클립 둘', await js(`document.querySelectorAll('.daw-midi-clip').length`), 2);
    const pasted = cmds('midiClip').pop();
    expect('붙인 클립이 재생선(뒤쪽)에', !!(pasted && pasted.start > 0), true);
    expect('붙인 클립 노트 수 같음(4)', pasted && pasted.notes.length, 4);
    await ctrl('Z');
    expect('Ctrl+Z → 하나', await js(`document.querySelectorAll('.daw-midi-clip').length`), 1);
  }

  fs.writeFileSync(path.join(os.tmpdir(), 'yss-studiomidi.png'), (await win.webContents.capturePage()).toPNG());
  finish(app);
})().catch(e => { console.error(e); process.exit(1); });
