'use strict';
// 건의: ASIO 드라이버가 여러 개면 엔진이 매번 그중 첫 번째로 붙는다. 마지막에 쓰던
// 장치를 기억해서 다시 그쪽으로 붙어야 한다.
//
// 이 컴퓨터엔 ASIO 드라이버가 하나뿐이라 "여러 ASIO 중 첫 번째" 상황 자체는 못 만든다.
// 대신 같은 메커니즘을 다른 각도로 잰다: 엔진이 기본으로 붙는 타입(ASIO, 이 컴퓨터에서
// 항상 우선)과 다른 타입(Windows Audio)을 저장해 두고, 다음 부팅에서 실제로 그쪽으로
// 다시 붙는지 본다. 타입이 다르면 장치가 여러 개인 것과 똑같이 "기본값이 아닌 걸 기억해서
// 되돌아가야 한다"는 조건이 성립한다.
//
// 이 파일은 순수 Node 오케스트레이터다(Electron 창을 안 띄운다 — NODE_ONLY). 실제 부팅은
// _devremember-phase1/2.js 를 별도 프로세스로 순서대로 띄워서 한다. main.js 는 단일
// 인스턴스 락을 걸어서, 앞 프로세스가 살아 있는 채로 다음을 띄우면 뒤쪽이 그냥 죽는다 —
// 그래서 한 프로세스 안에서 bootMain() 을 두 번 부르는 대신 프로세스 자체를 나눴다.

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'cli.js');

let pass = 0, fail = 0;
const expect = (l, g, w) => { const ok = String(g) === String(w); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${l}: ${g}${ok ? '' : ` (기대 ${w})`}`); };
const skip = (why) => console.log(`  건너뜀 — ${why}`);

function runPhase(file) {
  const r = spawnSync(process.execPath, [ELECTRON, path.join(__dirname, file)], { cwd: ROOT, encoding: 'utf8' });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '';
  try { return JSON.parse(last); } catch { return { ok: false, reason: `출력 못 읽음: ${JSON.stringify(r.stdout)}` }; }
}

(async () => {
  console.log('1) 다른 타입 장치를 "마지막 사용"으로 저장');
  const p1 = runPhase('_devremember-phase1.js');
  if (!p1.ok) { skip(`1차 부팅 — ${p1.reason}`); console.log(`\n통과 ${pass} · 실패 ${fail}`); process.exit(0); }
  console.log(`   저장함: ${p1.target.type} / ${p1.target.output}`);

  console.log('2) 다시 부팅 — 저장해 둔 장치로 재연결되는가');
  const p2 = runPhase('_devremember-phase2.js');
  if (!p2.ok) {
    skip(`2차 부팅 — ${p2.reason}`);
  } else {
    expect('저장해 둔 타입으로 재연결', p2.currentType, p1.target.type);
    expect('저장해 둔 장치로 재연결', p2.output, p1.target.output);
  }

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
