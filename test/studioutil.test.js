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

  // 확대해서 더 세밀하게 — N 을 키우면 실제로 좌표가 더 촘촘해져야 한다. 예전엔 클립 하나당
  // N 이 고정(1400)이라, 확대해도 SVG 가 같은 점을 넓게 늘려 보여줄 뿐이었다(viewBox 만 커짐).
  // 스튜디오 쪽(renderWaves/renderTakes)이 배율에 맞춰 다른 N 으로 다시 부르는 게 핵심이라
  // 여기서는 그 바탕이 되는 buildWaveSvg 가 N 을 실제로 반영하는지만 잰다.
  const ptsOf = (s) => (s.match(/,/g) || []).length;   // 좌표쌍 개수 ≈ 쉼표 개수
  const coarse = U.buildWaveSvg([L, R], '#3ddc97', 64);
  const fine = U.buildWaveSvg([L, R], '#3ddc97', 512);
  expect('N 커지면 좌표도 늚', ptsOf(fine) > ptsOf(coarse) * 5, true);
  expect('viewBox 도 N 따라감', fine.includes('viewBox="0 0 512 50"'), true);

  console.log('7) noteCrashAndCheckLoop — 반복 크래시 판정');
  {
    let ts = [];
    expect('1번째는 루프 아님', U.noteCrashAndCheckLoop(ts, 0), false);
    expect('2번째도 루프 아님', U.noteCrashAndCheckLoop(ts, 1000), false);
    expect('3번째(창 안)면 루프', U.noteCrashAndCheckLoop(ts, 2000), true);
  }
  {
    // 3번인데 창(30초)을 넘겨서 듬성듬성 — 오래된 것부터 잘려나가 루프로 안 봐야 한다
    let ts = [];
    U.noteCrashAndCheckLoop(ts, 0);
    U.noteCrashAndCheckLoop(ts, U.CRASH_LOOP_WINDOW_MS + 1000);   // 첫 번째가 이 시점엔 창 밖
    const looped = U.noteCrashAndCheckLoop(ts, U.CRASH_LOOP_WINDOW_MS + 2000);
    expect('창 넘겨 듬성듬성이면 루프 아님', looped, false);
    expect('오래된 타임스탬프는 정리됨', ts.length, 2);
  }
  {
    // 딱 창 끝(now - 첫 크래시 == CRASH_LOOP_WINDOW_MS)에 걸친 것도 아직 창 안(초과가 아니라
    // 같음)이라 안 잘려나간다 — 그 경계에서 3번째가 나오면 루프로 잡혀야 한다
    let ts = [];
    U.noteCrashAndCheckLoop(ts, 0);
    U.noteCrashAndCheckLoop(ts, U.CRASH_LOOP_WINDOW_MS / 2);
    const looped = U.noteCrashAndCheckLoop(ts, U.CRASH_LOOP_WINDOW_MS);
    expect('경계값 포함 3번째면 루프', looped, true);
  }

  console.log('8) inputConfigInRange — 채널 많은 인터페이스에서 저장된 입력 복원');
  {
    // 모노: chR 은 안 쓰니까 범위 밖이어도 무시돼야 한다(버그였던 부분)
    expect('모노, chR 이 커도 통과', U.inputConfigInRange({ mode: 0, chL: 0, chR: 9 }, 2), true);
    expect('모노, chL 자체가 범위 밖이면 막힘', U.inputConfigInRange({ mode: 0, chL: 9, chR: 0 }, 2), false);
    // 스테레오: chL·chR 둘 다 범위 안이어야 한다
    expect('스테레오, 둘 다 범위 안', U.inputConfigInRange({ mode: 1, chL: 0, chR: 1 }, 12), true);
    expect('스테레오, chR 만 범위 밖', U.inputConfigInRange({ mode: 1, chL: 0, chR: 9 }, 2), false);
    expect('스테레오, chL 만 범위 밖', U.inputConfigInRange({ mode: 1, chL: 9, chR: 0 }, 2), false);
    // 12채널 인터페이스에서 8/9번(인덱스 7/8) 스테레오로 쓰던 실사용 값
    expect('12채널 인터페이스 실사용 값', U.inputConfigInRange({ mode: 1, chL: 7, chR: 8 }, 12), true);
  }

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
