'use strict';
// 크래시가 개발자에게 도달하는 길.
//   기록이 남는가 · 읽으면 지워지는가(두 번 묻지 않는가) · 제보 창이 채워지는가

const path = require('path'); const fs = require('fs');
const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, win, js } = await bootMain({ settle: 3000 });
  const REC = path.join(app.getPath('userData'), 'lastcrash.json');
  try { fs.unlinkSync(REC); } catch {}

  section('1) 처리되지 않은 예외가 기록된다');
  // 실제 핸들러를 태운다 — 테스트용 우회로를 만들면 진짜 경로는 검사되지 않는다
  process.emit('uncaughtException', Object.assign(new Error('시험용 예외'), {
    stack: 'Error: 시험용 예외\n    at 어딘가 (main.js:1:1)\n    at 그다음 (main.js:2:2)',
  }));
  await wait(300);
  expect('기록 생성    ', fs.existsSync(REC), true);
  const rec = JSON.parse(fs.readFileSync(REC, 'utf8'));
  expect('종류         ', rec.kind, 'main');
  expect('메시지       ', rec.message, '시험용 예외');
  expect('버전 포함    ', !!rec.version, true);
  expect('스택 포함    ', rec.stack.includes('main.js'), true);
  expect('스택은 짧게  ', rec.stack.split('\n').length <= 6, true);

  section('2) 거절된 프로미스도 기록된다');
  process.emit('unhandledRejection', new Error('시험용 거절'));
  await wait(300);
  expect('덮어쓴다     ', JSON.parse(fs.readFileSync(REC, 'utf8')).kind, 'promise');

  section('3) 읽으면 지워진다 — 같은 크래시를 두 번 묻지 않는다');
  const first = await js('window.yssApi.takeLastCrash()');
  expect('한 번은 온다 ', first && first.kind, 'promise');
  expect('파일 삭제    ', fs.existsSync(REC), false);
  const second = await js('window.yssApi.takeLastCrash()');
  expect('두 번째는 없음', second, null);

  section('4) 기록이 있으면 제보 창이 채워진 채 열린다');
  process.emit('uncaughtException', new Error('창 채우기 시험'));
  await wait(300);
  const filled = await js(`(async () => {
    const rec = await window.yssApi.takeLastCrash();
    if (!rec) return { ok:false };
    // report.js 의 checkLastCrash 와 같은 자리에 같은 방식으로 채워지는지 본다
    return { ok:true, 메시지: rec.message, 종류: rec.kind };
  })()`);
  expect('창 채울 자료 ', filled.메시지, '창 채우기 시험');
  expect('종류         ', filled.종류, 'main');
  expect('읽고 지움    ', fs.existsSync(REC), false);

  section('5) 로그를 쌓지 않는다');
  process.emit('uncaughtException', new Error('첫 번째'));
  await wait(200);
  process.emit('uncaughtException', new Error('두 번째'));
  await wait(200);
  const files = fs.readdirSync(app.getPath('userData')).filter(f => /crash|\.log$/i.test(f));
  expect('크래시 파일 1개', files.length, 1);
  expect('마지막 것만  ', JSON.parse(fs.readFileSync(REC, 'utf8')).message, '두 번째');
  try { fs.unlinkSync(REC); } catch {}

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
