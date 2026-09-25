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

  section('2) 키보드 연주 모드 — 진짜 키 입력');
  await js(`document.querySelector('.daw-lane-instr [data-m="kb"]').click(); true`);
  await wait(300);
  expect('HUD 표시', await js(`!!document.getElementById('daw-kb-hud')`), true);
  expect('하단 ⌨ 버튼 켜짐', await js(`document.getElementById('st-kb').classList.contains('on')`), true);
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
  await key(null, 'Left', 'keyDown'); await key(null, 'Left', 'keyUp');

  section('3) MIDI 녹음 → 클립');
  sent.length = 0;
  await js(`document.getElementById('st-rec').click(); true`);
  await wait(200);
  const arm = cmds('recordArm')[0];
  expect('recordArm 에 midiTracks 포함', !!(arm && arm.midiTracks && arm.midiTracks.length === 1), true);
  await js(`document.getElementById('st-play').click(); true`);
  await wait(500);
  await tap('Z', 200); await wait(150); await tap('C', 200); await wait(150); await tap('B', 300);
  await wait(200);
  await js(`document.getElementById('st-stop').click(); true`);
  for (let i = 0; i < 30 && !(await js(`!!document.querySelector('.daw-midi-clip')`)); i++) await wait(150);
  expect('MIDI 클립 생김', await js(`document.querySelectorAll('.daw-midi-clip').length`), 1);
  expect('노트 3개 그려짐', await js(`document.querySelectorAll('.daw-midi-clip .daw-midi-notes i').length`), 3);
  const clipCmd = cmds('midiClip').pop();
  expect('엔진에 클립 전송(노트 48,52,55)', clipCmd && clipCmd.notes.map(n => n[2]).join(','), '48,52,55');

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

  fs.writeFileSync(path.join(os.tmpdir(), 'yss-studiomidi.png'), (await win.webContents.capturePage()).toPNG());
  finish(app);
})().catch(e => { console.error(e); process.exit(1); });
