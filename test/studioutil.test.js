'use strict';
// 스튜디오 순수 도우미 — 화면 없이 값만 넣어 확인한다.
// studio.js 안에 있을 때는 창을 띄우지 않고는 검사할 방법이 없었다.

const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
const expect = (label, got, want) => {
  const ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}: ${got}${ok ? '' : ` (기대 ${want})`}`);
};

(async () => {
  const url = pathToFileURL(path.resolve(__dirname, '..', 'renderer', 'scripts', 'studio', 'util.js')).href;
  const U = await import(url);

  console.log('1) esc — 삽입 전 이스케이프');
  expect('꺾쇠·따옴표  ', U.esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  expect('null 은 빈 문자', U.esc(null), '');
  expect('숫자도 문자로', U.esc(0), '0');

  console.log('2) fmtTC — 재생 위치');
  expect('0초          ', U.fmtTC(0), '0:00.000');
  expect('61.5초       ', U.fmtTC(61.5), '1:01.500');
  expect('음수는 0 으로', U.fmtTC(-5), '0:00.000');
  expect('없는 값      ', U.fmtTC(undefined), '0:00.000');

  console.log('3) fmtDelta — 이동량');
  expect('양수         ', U.fmtDelta(7.25), '+0:07.25');
  expect('음수는 −     ', U.fmtDelta(-7.25), '−0:07.25');
  expect('분 넘김      ', U.fmtDelta(65.5), '+1:05.50');
  expect('0            ', U.fmtDelta(0), '+0:00.00');

  console.log('4) rgbToHex — 색상 input 이 받는 꼴로');
  expect('rgb()        ', U.rgbToHex('rgb(255, 16, 0)'), '#ff1000');
  expect('#rgb 확장    ', U.rgbToHex('#abc'), '#aabbcc');
  expect('#rrggbb 유지 ', U.rgbToHex('#12ab34'), '#12ab34');
  expect('알 수 없으면 ', U.rgbToHex('tomato'), '#888888');

  console.log('5) meterPct — 게이트 아래는 완전히 꺼진다');
  expect('무음         ', U.meterPct(0), 0);
  expect('게이트 바로 아래', U.meterPct(U.METER_GATE * 0.9), 0);
  expect('최대치       ', U.meterPct(1), 100);
  const mid = U.meterPct(0.1);
  expect('중간은 0~100 ', mid > 0 && mid < 100, true);
  // 블록 경계로 내림 — 같은 블록 안에서는 값이 흔들려도 표시가 같아야 한다
  expect('블록 단위    ', (mid / 100 * U.METER_BLOCKS) % 1, 0);
  expect('단조 증가    ', U.meterPct(0.5) >= mid, true);

  console.log('6) buildWaveSvg — 파형');
  const n = 4096;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = Math.sin(i / 20) * 0.8; R[i] = L[i]; }
  const svg = U.buildWaveSvg([L, R], '#3ddc97', 64);
  expect('svg 로 시작  ', svg.startsWith('<svg'), true);
  expect('색 반영      ', svg.includes('#3ddc97'), true);
  expect('폴리곤 둘    ', (svg.match(/<polygon/g) || []).length, 2);
  expect('viewBox 폭   ', svg.includes('viewBox="0 0 64 50"'), true);
  expect('빈 입력      ', U.buildWaveSvg(null, '#fff'), '');
  expect('모노도 됨    ', U.buildWaveSvg([L], '#fff', 32).startsWith('<svg'), true);

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
