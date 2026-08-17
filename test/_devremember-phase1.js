'use strict';
// devremember.test.js 의 1차 부팅 — 지금 어떤 장치에 붙는지 보고, 그와 다른 타입 하나를
// "마지막에 쓴 장치"로 localStorage 에 심어 둔다. 결과를 stdout 에 JSON 한 줄로 찍는다.
//
// 별도 프로세스인 이유: main.js 는 단일 인스턴스 락을 건다. 이 프로세스가 켜진 채로
// 2차 부팅(_devremember-phase2.js)을 또 띄우면 "이미 켜져 있다"고 보고 그쪽이 그냥 죽는다
// — 세 단계(심기·확인·청소)를 전부 끊어진 별도 프로세스로 나눠야 서로 안 걸린다.
const { bootMain, wait } = require('./harness');

function report(obj) {
  return new Promise((resolve) => { process.stdout.write(JSON.stringify(obj) + '\n', () => resolve()); });
}

async function waitEngineOn(js, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await js(`document.getElementById('st-engine-dot')?.classList.contains('on')`)) return true;
    await wait(300);
  }
  return false;
}

async function waitDevices(js) {
  await js(`window.__rt = null; window.yssApi.engine.onEvent(m => { if (m.ev === 'devices') window.__rt = m; }); true`);
  await js(`window.yssApi.engine.listDevices(); true`);
  for (let i = 0; i < 20; i++) { const d = await js(`window.__rt`); if (d) return d; await wait(300); }
  return null;
}

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });
  await js(`document.querySelector('.tab[data-view="studio"]').click(); true`);
  if (!await waitEngineOn(js, 20000)) { await report({ ok: false, reason: 'no-device' }); app.exit(0); return; }
  await wait(500);
  const d = await waitDevices(js);
  if (!d) { await report({ ok: false, reason: 'no-devices-response' }); app.exit(0); return; }

  const other = (d.types || []).find(t => t.name !== d.currentType && t.outputs && t.outputs.length);
  if (!other) { await report({ ok: false, reason: 'single-type' }); app.exit(0); return; }

  const target = { type: other.name, output: other.outputs[0] };
  await js(`localStorage.setItem('yss.deviceConfig', JSON.stringify({
    type: ${JSON.stringify(target.type)}, output: ${JSON.stringify(target.output)},
    input: ${JSON.stringify(target.output)}, sampleRate: 44100, bufferSize: 512,
  })); true`);
  await report({ ok: true, target });
  app.exit(0);
})().catch(async (e) => { await report({ ok: false, reason: String(e) }); process.exit(1); });
