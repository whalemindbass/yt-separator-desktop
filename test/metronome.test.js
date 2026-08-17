'use strict';
// 요청: "스튜디오에서도 메트로놈 쓸 수 있게 해줘" — 엔진(Main.cpp)엔 setMetro/click 재생이 이미
// 다 있었는데 스튜디오 화면 어디서도 부르는 곳이 없었다(preload 에만 api.engine.metro 로 노출).
// 툴바 주석에도 "BPM · 메트로놈 · 배율" 이라고 자리를 미리 잡아 둔 흔적이 있었다 — 버튼만 안
// 달려 있었다.
//
// 실제로 소리가 나는지는(오디오 캡처 없인) 확인 못 하니, 버튼이 엔진에 보내는 'metro' 명령이
// 올바른 bpm/phase/interval 을 담고 있는지 + on/off 가 localStorage 에 남는지를 잰다.
//
// window.yssApi 는 contextBridge 로 노출돼 있어 렌더러 쪽에서 함수를 바꿔치기해도 안 먹는다
// (isolated world 라 조용히 무시된다) — 그래서 엔진으로 나가는 명령을 렌더러가 아니라
// main 프로세스 쪽 AudioEngine.send() 를 가로채서 잡는다. main.js 가 engine-client.js 를
// require 하기 *전에* 이 파일에서 먼저 require 해서 prototype 을 바꿔 두면, 모듈 캐시가
// 같은 객체를 돌려주므로 main.js 도 바뀐 걸 그대로 쓴다.
const path = require('path');
const { bootMain, expect, wait, finish, skip, ROOT } = require('./harness');
const { AudioEngine } = require(path.join(ROOT, 'engine-client.js'));

const sent = [];
const origSend = AudioEngine.prototype.send;
AudioEngine.prototype.send = function (cmd) { sent.push(cmd); return origSend.call(this, cmd); };
const metroCmds = () => sent.filter((c) => c.cmd === 'metro');

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });
  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);

  const engineOn = () => js(`document.getElementById('st-engine-dot')?.classList.contains('on')`);
  let ready = false;
  for (let i = 0; i < 30; i++) { if (await engineOn()) { ready = true; break; } await wait(300); }
  if (!ready) { skip('이 컴퓨터의 오디오 장치가 시간 안에 안 열렸다 — 판정 불능'); finish(app); return; }
  await wait(500);

  await js(`localStorage.removeItem('yss:metroOn'); true`);
  sent.length = 0;

  expect('버튼 잠금 풀림', await js(`document.getElementById('st-metro')?.disabled`), false);
  expect('시작은 꺼짐', await js(`document.getElementById('st-metro')?.classList.contains('on')`), false);

  await js(`document.getElementById('st-metro')?.click(); true`);
  await wait(300);

  expect('켰을 때 표시', await js(`document.getElementById('st-metro')?.classList.contains('on')`), true);
  expect('aria-pressed', await js(`document.getElementById('st-metro')?.getAttribute('aria-pressed')`), 'true');
  expect('저장됨', await js(`localStorage.getItem('yss:metroOn')`), '1');

  let cmds = metroCmds();
  const afterOn = cmds[cmds.length - 1];
  expect('on 으로 보냄', afterOn && afterOn.on, true);
  expect('기본 BPM 120', afterOn && afterOn.bpm, 120);
  expect('곡 없으면 phase 0', afterOn && afterOn.phase, 0);

  // BPM 을 바꾸면 켜진 채로 새 BPM 이 다시 밀어 넣어져야 한다.
  sent.length = 0;
  await js(`(() => { const el = document.getElementById('st-bpm'); el.value = 140; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await wait(300);
  cmds = metroCmds();
  const afterBpm = cmds[cmds.length - 1];
  expect('BPM 변경 뒤에도 on', afterBpm && afterBpm.on, true);
  expect('새 BPM 반영', afterBpm && afterBpm.bpm, 140);

  // 끄면 off 로 보내고, localStorage 도 지운다.
  sent.length = 0;
  await js(`document.getElementById('st-metro')?.click(); true`);
  await wait(300);
  expect('껐을 때 표시 꺼짐', await js(`document.getElementById('st-metro')?.classList.contains('on')`), false);
  expect('저장값 꺼짐', await js(`localStorage.getItem('yss:metroOn')`), '0');
  cmds = metroCmds();
  const afterOff = cmds[cmds.length - 1];
  expect('off 로 보냄', afterOff && afterOff.on, false);

  await js(`localStorage.removeItem('yss:metroOn'); true`);
  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
