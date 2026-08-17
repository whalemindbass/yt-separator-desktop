'use strict';
// 제보: "설정해둔 값을 로드하는데 시간이 좀 걸리네? 스튜디오가 켜지고나서 좀 지나야 로드되니까
// 사용자들이 헷갈릴 것 같아" — 저장해 둔 장치와 다른 타입으로 재연결이 필요할 때, 엔진이
// 부팅하며 먼저 여는 "기본 장치" 이름이 상태 표시줄에 잠깐 스쳐 지나간 뒤에야 저장해 둔 장치
// 이름으로 바뀌었다. 그 사이엔 "저장된 장치로 연결 중…" 으로 고정해 감추기로 했다
// (renderer/scripts/studio.js 의 _devReconnectPhase).
//
// _devremember.test.js 와 같은 이유로 순수 Node 오케스트레이터다 — main.js 의 단일 인스턴스
// 락 때문에 phase1(값 심기)과 phase2(부팅하며 상태 표시줄 샘플링)를 별도 프로세스로 나눈다.

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

  console.log('2) 다시 부팅 — 재연결 도중 상태 표시줄에 스쳐가는 이름이 없는가');
  const p2 = runPhase('_devreconnectstatus-phase2.js');
  if (!p2.ok) {
    skip(`2차 부팅 — ${p2.reason}`);
  } else {
    console.log(`   device 이벤트들: ${JSON.stringify(p2.devEvts)}`);
    // 저장해 둔 장치가 아닌 device 이벤트(=스쳐 지나가는 기본 장치)가 온 그 순간, 상태
    // 표시줄에 그 이름이 그대로 찍히면 안 된다 — 아직 재연결 중이라는 걸 알 수 있어야 한다.
    const leaked = (p2.devEvts || []).filter(e => e.name !== p1.target.output && e.statusRightAfter === e.name);
    expect('최종 상태 == 저장해 둔 장치', p2.finalStatus, p1.target.output);
    expect('스쳐가는 기본 장치 이름이 상태에 안 찍힘',
      leaked.length === 0 ? '없음' : leaked.map(e => e.name).join(','), '없음');
  }

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})();
