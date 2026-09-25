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

  console.log('9) pickInputConfig — 장치별 입력 채널 저장');
  {
    const map = { 'ASIO Fireface USB': { mode: 1, chL: 7, chR: 8 }, 'Focusrite USB ASIO': { mode: 0, chL: 1, chR: 1 } };
    const a = U.pickInputConfig(map, null, 'ASIO Fireface USB');
    expect('자기 장치 값을 씀      ', `${a.source}:${a.cfg.mode}/${a.cfg.chL}/${a.cfg.chR}`, 'device:1/7/8');
    const b = U.pickInputConfig(map, null, 'Focusrite USB ASIO');
    expect('다른 장치는 자기 값    ', `${b.source}:${b.cfg.chL}`, 'device:1');
    // 기록이 있는 상태에서 처음 보는 장치 — 다른 장치 채널(7/8)을 끌어오면 안 된다
    const c = U.pickInputConfig(map, { mode: 1, chL: 7, chR: 8 }, 'Realtek');
    expect('처음 보는 장치는 기본값', `${c.source}:${c.cfg.mode}/${c.cfg.chL}/${c.cfg.chR}`, 'default:0/0/1');
    // 업데이트 직후 — 장치별 기록이 아직 없으면 예전 값 하나를 이어받는다
    const d = U.pickInputConfig({}, { mode: 0, chL: 3, chR: 9 }, 'ASIO Fireface USB');
    expect('예전 형식 이어받기     ', `${d.source}:${d.cfg.chL}/${d.cfg.chR}`, 'legacy:3/9');
    const e = U.pickInputConfig(null, null, 'X');
    expect('아무것도 없으면 기본값 ', e.source, 'default');
    const f = U.pickInputConfig(map, null, '');
    expect('장치 이름 없으면 기본값', f.source, 'default');
    // 반환값을 고쳐도 기본값 상수가 오염되면 안 된다
    f.cfg.chL = 5;
    expect('기본값 상수 불변       ', U.INPUT_CFG_DEFAULT.chL, 0);
  }

  console.log('10) mergeFxCache — 크래시 복구용 FX 노브값 캐시');
  {
    const prev = { 1: 'A-old', 2: 'B-old', 9: 'gone' };
    const m = U.mergeFxCache(prev, [1, 2, 3], { 1: 'A-new', 3: 'C-new' });
    expect('새 값 우선            ', m[1], 'A-new');
    expect('응답 없던 슬롯은 유지 ', m[2], 'B-old');
    expect('새로 생긴 슬롯 추가   ', m[3], 'C-new');
    expect('지운 슬롯은 버림      ', 9 in m, false);
    const empty = U.mergeFxCache(prev, [1, 2], {});
    expect('전부 타임아웃이어도 유지', `${empty[1]}/${empty[2]}`, 'A-old/B-old');
    expect('둘 다 없으면 키 없음  ', Object.keys(U.mergeFxCache(null, [5], null)).length, 0);
  }

  console.log('11) latencyBreakdown — 지연 내역');
  {
    const r1 = U.latencyBreakdown({ sr: 48000, block: 256, roundtripMs: 11.8, pdcMs: 0, pdcOn: true });
    expect('버퍼 2×256/48k       ', r1.bufferMs.toFixed(2), '10.67');
    expect('드라이버 추가분      ', r1.driverMs.toFixed(2), '1.13');
    expect('보정 없으면 모니터=왕복', r1.monitorMs.toFixed(1), '11.8');
    const r2 = U.latencyBreakdown({ sr: 48000, block: 256, roundtripMs: 11.8, pdcMs: 42.7, pdcOn: true });
    expect('PDC 켜짐 → 모니터에 더해짐', r2.monitorMs.toFixed(1), '54.5');
    const r3 = U.latencyBreakdown({ sr: 48000, block: 256, roundtripMs: 11.8, pdcMs: 42.7, pdcOn: false });
    expect('PDC 꺼짐 → 안 더해짐 ', `${r3.pdcMs}/${r3.monitorMs.toFixed(1)}`, '0/11.8');
    // 드라이버가 버퍼보다 작게 보고하는 이상한 경우 — 음수로 안 내려간다
    const r4 = U.latencyBreakdown({ sr: 48000, block: 512, roundtripMs: 5, pdcMs: 0, pdcOn: false });
    expect('드라이버분 음수 없음 ', r4.driverMs, 0);
    const r5 = U.latencyBreakdown({});
    expect('값 없으면 0          ', `${r5.bufferMs}/${r5.monitorMs}`, '0/0');
  }

  console.log('12) buildWaveSvgFromEnvelope — 요약 파형(영상편집)');
  {
    // 앞 절반은 큰 소리, 뒤 절반은 무음인 400버킷
    const P = new Float32Array(400), Rm = new Float32Array(400);
    for (let i = 0; i < 200; i++) { P[i] = 0.8; Rm[i] = 0.5; }
    const loud = U.buildWaveSvgFromEnvelope(P, Rm, 0, 200, '#fff', 100);
    const quiet = U.buildWaveSvgFromEnvelope(P, Rm, 200, 400, '#fff', 100);
    expect('svg 로 시작          ', loud.startsWith('<svg'), true);
    expect('폴리곤 둘            ', (loud.match(/<polygon/g) || []).length, 2);
    expect('viewBox = N          ', loud.includes('viewBox="0 0 100 50"'), true);
    // 무음 구간은 중앙선(25)에서 안 벗어나고, 소리 구간은 꽉 찬다(자기 최대로 정규화 → 3.0/47.0)
    expect('무음 구간은 평평     ', /\b(3\.0|47\.0)\b/.test(quiet), false);
    expect('소리 구간은 꽉 참    ', loud.includes(',3.0 ') && loud.includes(',47.0 '), true);
    // 크게 확대(버킷보다 점이 많음) — 같은 버킷을 나눠 써도 NaN 이 없어야 한다
    const zoom = U.buildWaveSvgFromEnvelope(P, Rm, 10, 13, '#fff', 300);
    expect('확대해도 NaN 없음    ', zoom.includes('NaN'), false);
    expect('빈 구간은 빈 문자    ', U.buildWaveSvgFromEnvelope(P, Rm, 50, 50, '#fff'), '');
    expect('범위 밖은 잘라냄     ', U.buildWaveSvgFromEnvelope(P, Rm, 390, 999, '#fff', 10).startsWith('<svg'), true);
    expect('입력 없으면 빈 문자  ', U.buildWaveSvgFromEnvelope(null, null, 0, 10, '#fff'), '');
  }

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
