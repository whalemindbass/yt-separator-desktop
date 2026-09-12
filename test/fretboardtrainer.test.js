'use strict';
// 지판 암기(fretboard) 트레이너 — 설정 화면, 퀴즈 네 모드(보고 맞히기/듣고 찾기/스케일 찾기/
// 실전 연주 인식), 자연음만 필터, 약점 가중 재출제를 검증한다.
//
// 약점 가중 재출제는 내부 함수를 노출하는 훅이 이 코드베이스 관례에 없어서(다른 테스트도
// 전부 화면만으로 검증), fretboardStats:load 스텁으로 정답률을 미리 심어 두고 실제 화면에서
// 뽑히는 위치 분포를 관찰하는 블랙박스 방식으로 검증한다. 관찰 루프는 "건너뛰기"만 눌러서
// 통계를 안 건드리고 순수하게 출제 분포만 잰다.
//
// 실전 연주 인식은 엔진 이벤트를 흉내만 낸다 — 마이크→ASIO→YIN 실물 경로 자체는 기존 튜너가
// 이미 실기기로 검증한 부분이라 범위 밖. 기타/베이스로 실제 검증할 땐 npm start 로 직접.
const { bootRenderer, expect, section, wait, finish } = require('./harness');

const $ = (id) => `document.getElementById(${JSON.stringify(id)})`;
// training.js 의 FB_NOTE_NAMES/FB_SCALES.major 와 동일 — 스케일 찾기 테스트에서 프롬프트의
// 근음 텍스트를 파싱해 "이 문제의 정답은 뭐여야 하는가" 를 테스트 쪽에서 직접 계산한다.
const FB_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FB_MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11];
const belongsToMajor = (pc, rootPc) => FB_MAJOR_INTERVALS.includes(((pc - rootPc) % 12 + 12) % 12);

(async () => {
  const { app, win, js } = await bootRenderer({
    stubs: {
      'fretboardStats:load': () => ({
        positions: {
          'guitar6:0:0': { attempts: 20, correct: 0, lastSeenAt: 1 },   // 개방 E — 정답률 0%(약점)
          'guitar6:0:1': { attempts: 20, correct: 20, lastSeenAt: 1 },  // 1프렛 F — 정답률 100%
        },
      }),
    },
  });

  // bootRenderer 는 매 실행마다 임시 프로필을 새로 쓰지 않는다(기존 metronome.test.js 도 같은
  // 이유로 localStorage.removeItem 을 직접 한다) — 지난 실행에서 남은 yss:fb* 값이 있으면
  // "기본값" 검증이 그 값으로 오염된다. training.js 의 기본값 계산은 모듈 최상단(로드 시점)에
  // 한 번만 일어나므로, 지우기만 해선 이미 메모리에 들어간 값엔 소급 적용이 안 된다 —
  // 지우고 나서 새로고침까지 해야 진짜 깨끗한 기본값으로 다시 초기화된다.
  await js(`['yss:fbInstrument','yss:fbFretMin','yss:fbFretMax','yss:fbStrings','yss:fbNaturalsOnly',
             'yss:fbSessionMode','yss:fbSessionValue','yss:fbQuizMode','yss:fbScaleType'].forEach(k => localStorage.removeItem(k)); true`);
  await js(`location.reload(); true`);
  await wait(1500);
  await js(`document.querySelector('.tab[data-view="training"]').click(); true`);
  await js(`document.querySelector('.training-nav-item[data-tool="fretboard"]').click(); true`);
  await wait(300);

  section('=== 설정 화면 ===');
  expect('기본 악기 guitar6', await js(`${$('fb-instrument')}.value`), 'guitar6');
  expect('기본 현 개수(기타 6개)', await js(`document.querySelectorAll('#fb-strings .fb-string-toggle').length`), 6);
  // localStorage 가 비어 있을 때(첫 실행) 기본값이 제대로 채워지는지 — Number(null)===0 이
  // fbClampInt 의 isFinite 체크를 통과해버려서 "기본값 없음" 이 "0" 으로 둔갑하던 회귀가 있었다.
  expect('기본 프렛 범위 최솟값 0', await js(`${$('fb-fret-min')}.value`), '0');
  expect('기본 프렛 범위 최댓값 12', await js(`${$('fb-fret-max')}.value`), '12');
  expect('기본 세션 길이(문항 수) 20', await js(`${$('fb-session-value')}.value`), '20');

  await js(`(() => { const el = ${$('fb-instrument')}; el.value = 'bass4'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await wait(100);
  expect('베이스4현으로 바꾸면 현 4개', await js(`document.querySelectorAll('#fb-strings .fb-string-toggle').length`), 4);
  expect('프렛맥스 캡 20으로 클램프', await js(`${$('fb-fret-max')}.max`), '20');

  // 이후 테스트는 재현성을 위해 guitar6, 0번줄만, 0~1프렛(E/F)만 쓰는 좁은 후보 공간으로 고정한다.
  await js(`(() => { const el = ${$('fb-instrument')}; el.value = 'guitar6'; el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await wait(100);
  // 클릭할 때마다 fbToggleString 이 #fb-strings 의 innerHTML 을 통째로 다시 그리므로,
  // 정적 NodeList 를 미리 잡아 순회하면 두 번째 클릭부터는 이미 떨어져 나간(detached) 옛
  // 엘리먼트를 건드리게 된다(이벤트 위임이라 detached 엘리먼트의 클릭은 버블링이 안 됨) —
  // 매 반복마다 살아있는 DOM 을 다시 querySelector 로 찾는다.
  await js(`(() => {
    for (let idx = 1; idx <= 5; idx++) {
      const b = document.querySelector('#fb-strings .fb-string-toggle[data-idx="' + idx + '"]');
      if (b && b.classList.contains('on')) b.click();
    }
    return true;
  })()`);
  await js(`(() => { ${$('fb-fret-min')}.value = 0; ${$('fb-fret-min')}.dispatchEvent(new Event('change', { bubbles: true }));
                     ${$('fb-fret-max')}.value = 1; ${$('fb-fret-max')}.dispatchEvent(new Event('change', { bubbles: true }));
                     ${$('fb-naturals')}.value = '0'; ${$('fb-naturals')}.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  expect('현은 0번줄만 켜짐', await js(`document.querySelectorAll('#fb-strings .fb-string-toggle.on').length`), 1);

  section('=== 약점 가중 재출제 ===');
  // guitar6:0:0(0/20, 정답률 0%) vs guitar6:0:1(20/20, 정답률 100%) — 뒤 섹션들이 실제 정답/오답을
  // 기록해 통계를 오염시키기 전에, 심어둔 통계 그대로 먼저 관찰한다. "건너뛰기"만 눌러 통계를
  // 더 안 건드리고 출제 분포만 잰다.
  await js(`document.querySelector('#fb-mode-tabs .fb-mode-tab[data-mode="see"]').click(); true`);
  await js(`document.getElementById('fb-start').click(); true`);
  await wait(150);
  let weakCount = 0;
  const total = 40;
  for (let i = 0; i < total; i++) {
    const f = await js(`document.querySelector('.fret-pos-dot.target')?.parentElement?.dataset.fret`);
    if (f === '0') weakCount++;
    await js(`document.getElementById('fb-skip').click(); true`);
    await wait(120);
  }
  console.log(`  약점(0프렛) 뽑힌 횟수: ${weakCount}/${total}`);
  expect('약점 위치가 균등분포(50%)보다 뚜렷하게 더 자주 뽑힘', weakCount > total * 0.65, true);
  await js(`document.getElementById('fb-end').click(); true`);
  await js(`document.getElementById('fb-summary-config').click(); true`);

  section('=== 보고 맞히기(see) — 정오답 흐름 ===');
  await js(`document.querySelector('#fb-mode-tabs .fb-mode-tab[data-mode="see"]').click(); true`);
  await js(`(() => { ${$('fb-session-mode')}.value = 'count'; ${$('fb-session-mode')}.dispatchEvent(new Event('change', { bubbles: true }));
                     ${$('fb-session-value')}.value = 40; ${$('fb-session-value')}.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await js(`document.getElementById('fb-start').click(); true`);
  await wait(150);

  expect('점수 0/0으로 시작', await js(`${$('fb-score')}.textContent`), '0/0');
  let fret = await js(`document.querySelector('.fret-pos-dot.target')?.parentElement?.dataset.fret`);
  await js(`document.querySelector('#fb-choices .fb-choice-btn[data-note="${fret === '0' ? 'E' : 'F'}"]').click(); true`);
  await wait(900);
  expect('정답 클릭 후 1/1', await js(`${$('fb-score')}.textContent`), '1/1');
  expect('스트릭 1', await js(`${$('fb-streak-num')}.textContent`), '1');

  // 오답 후보(distractor)는 매번 무작위 샘플이라 "E 아니면 F" 식으로 특정 음이 항상 선택지에
  // 있으리라 가정할 수 없다 — 정답이 아닌 버튼(4개 중 최소 3개는 항상 오답) 중 아무거나 클릭.
  fret = await js(`document.querySelector('.fret-pos-dot.target')?.parentElement?.dataset.fret`);
  const correctNote = fret === '0' ? 'E' : 'F';
  await js(`document.querySelector('#fb-choices .fb-choice-btn:not([data-note="${correctNote}"])').click(); true`);
  await wait(900);
  expect('오답 클릭 후 total만 증가(1/2)', await js(`${$('fb-score')}.textContent`), '1/2');
  expect('오답에 스트릭 리셋', await js(`${$('fb-streak-num')}.textContent`), '0');

  await js(`document.getElementById('fb-end').click(); true`);
  await js(`document.getElementById('fb-summary-config').click(); true`);

  section('=== 자연음만 옵션 — 선택지에 # 없어야 함 ===');
  // 0~1프렛(E/F)은 원래도 자연음이라 이 필터를 못 가린다 — 범위를 0~5프렛(F#, G# 포함)까지 잠깐 넓혀 확인.
  await js(`(() => { ${$('fb-fret-max')}.value = 5; ${$('fb-fret-max')}.dispatchEvent(new Event('change', { bubbles: true }));
                     ${$('fb-naturals')}.value = '1'; ${$('fb-naturals')}.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await js(`document.getElementById('fb-start').click(); true`);
  await wait(150);
  let sawSharp = false;
  for (let i = 0; i < 8; i++) {
    const choices = await js(`[...document.querySelectorAll('#fb-choices .fb-choice-btn')].map(b => b.dataset.note).join(',')`);
    if (choices.includes('#')) sawSharp = true;
    const note = await js(`document.querySelector('#fb-choices .fb-choice-btn')?.dataset.note`);
    await js(`document.querySelector('#fb-choices .fb-choice-btn[data-note="${note}"]').click(); true`);
    await wait(850);
  }
  expect('자연음만일 때 선택지에 # 없음', sawSharp, false);
  await js(`document.getElementById('fb-end').click(); true`);
  await js(`document.getElementById('fb-summary-config').click(); true`);

  // 다시 0~1프렛(E/F), 자연음 필터 해제 — 이후 섹션들의 재현 가능한 후보 공간으로 복귀.
  await js(`(() => { ${$('fb-fret-max')}.value = 1; ${$('fb-fret-max')}.dispatchEvent(new Event('change', { bubbles: true }));
                     ${$('fb-naturals')}.value = '0'; ${$('fb-naturals')}.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  section('=== 듣고 찾기(hear) — 클릭 위치의 실제 음이름 기준 판정 ===');
  await js(`document.querySelector('#fb-mode-tabs .fb-mode-tab[data-mode="hear"]').click(); true`);
  await js(`document.getElementById('fb-start').click(); true`);
  await wait(150);
  const promptText = await js(`${$('fb-prompt')}.textContent`);
  const wantFret = promptText.includes('F') ? '1' : '0';
  // .fret-pos 는 SVG <g> — SVGElement 엔 .click() 이 없어서 MouseEvent 를 직접 디스패치한다.
  await js(`document.querySelector('.fret-pos[data-string="0"][data-fret="${wantFret}"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
  await wait(900);
  expect('올바른 음 위치 클릭 → 1/1', await js(`${$('fb-score')}.textContent`), '1/1');
  await js(`document.getElementById('fb-end').click(); true`);
  await js(`document.getElementById('fb-summary-config').click(); true`);

  section('=== 스케일 찾기(scale) — 정답 전부 선택 / 오답 선택 ===');
  // 여전히 guitar6, 0번줄만, 0~1프렛(E=pc4, F=pc5) 로 좁혀진 상태 — 후보가 이 둘뿐이라
  // 프롬프트의 근음만 읽으면 정답 집합을 테스트 쪽에서 그대로 계산할 수 있다.
  await js(`(() => { ${$('fb-scale-type')}.value = 'major'; ${$('fb-scale-type')}.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await js(`document.querySelector('#fb-mode-tabs .fb-mode-tab[data-mode="scale"]').click(); true`);
  await js(`document.getElementById('fb-start').click(); true`);
  await wait(150);

  const readRootPc = async () => {
    const promptText = await js(`${$('fb-prompt')}.textContent`);
    const rootName = promptText.split(' ')[0];
    return FB_NOTE_NAMES.indexOf(rootName);
  };
  const clickPos = (fret) => js(`document.querySelector('.fret-pos[data-string="0"][data-fret="${fret}"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);

  let rootPc = await readRootPc();
  let wantE = belongsToMajor(4, rootPc), wantF = belongsToMajor(5, rootPc);
  if (wantE) await clickPos(0);
  if (wantF) await clickPos(1);
  await js(`document.getElementById('fb-scale-confirm').click(); true`);
  await wait(150);
  expect('정답 전부 선택 → 1/1', await js(`${$('fb-score')}.textContent`), '1/1');
  expect('확인 버튼 숨겨짐(제출 후)', await js(`${$('fb-scale-confirm')}.hidden`), true);
  // 스케일 모드는 자동으로 안 넘어간다 — "다음"을 직접 눌러야 다음 문제로 간다.
  expect('제출 후 "다음" 버튼 보임', await js(`${$('fb-scale-next')}.hidden`), false);
  expect('제출 후 건너뛰기 버튼은 숨김', await js(`${$('fb-skip')}.hidden`), true);
  await js(`document.getElementById('fb-scale-next').click(); true`);
  await wait(150);

  // 두 번째 문제 — 각 자리에서 정답의 정반대로 고른다(정답이면 일부러 안 고르고, 정답이
  // 아니면 일부러 고른다) — 후보가 E/F 둘뿐이라 이렇게 하면 근음이 뭐가 나오든 선택 집합이
  // 정답 집합과 반드시 달라진다(완전히 같은 경우가 나올 수 없음).
  rootPc = await readRootPc();
  wantE = belongsToMajor(4, rootPc); wantF = belongsToMajor(5, rootPc);
  if (!wantE) await clickPos(0);
  if (!wantF) await clickPos(1);
  await js(`document.getElementById('fb-scale-confirm').click(); true`);
  await wait(150);
  expect('오답 선택 후 total만 증가(1/2)', await js(`${$('fb-score')}.textContent`), '1/2');
  expect('오답에 스트릭 리셋', await js(`${$('fb-streak-num')}.textContent`), '0');
  await js(`document.getElementById('fb-scale-next').click(); true`);
  await wait(150);
  expect('"다음" 눌렀으니 다시 숨겨짐', await js(`${$('fb-scale-next')}.hidden`), true);
  expect('건너뛰기 버튼 다시 보임', await js(`${$('fb-skip')}.hidden`), false);

  await js(`document.getElementById('fb-end').click(); true`);
  section('=== 세션 종료 — 요약 화면 ===');
  expect('요약 화면 보임', await js(`${$('fb-summary')}.hidden`), false);
  await js(`document.getElementById('fb-summary-config').click(); true`);
  expect('설정으로 버튼 클릭 시 설정 화면 복귀', await js(`${$('fb-config')}.hidden`), false);

  section('=== 실전 연주 인식(play) — 엔진 off 안내 / on 시 pitch 판정 ===');
  // 여전히 guitar6, 0번줄만, 0~1프렛(E=MIDI40, F=MIDI41)로 좁혀진 상태.
  await js(`document.querySelector('#fb-mode-tabs .fb-mode-tab[data-mode="play"]').click(); true`);
  await js(`document.getElementById('fb-start').click(); true`);
  await wait(150);
  expect('엔진 꺼진 상태 — 안내 문구 보임', await js(`${$('fb-play-notice')}.hidden`), false);
  expect('엔진 꺼진 상태 — 퀴즈 화면 숨김', await js(`${$('fb-quiz')}.hidden`), true);

  win.webContents.send('engine:event', { ev: 'ready' });
  await wait(200);
  expect('엔진 켜지면 안내 숨고 퀴즈 보임', await js(`${$('fb-quiz')}.hidden`), false);
  expect('자리는 미리 안 보여줌(음이름만 보고 찾아야 암기가 됨)', await js(`!!document.querySelector('.fret-pos-dot.target')`), false);

  // 자리는 안 보여주고(암기 훈련이 안 되니까) 음이름만 프롬프트로 준다 — 옥타브/현은 안 따지고
  // pitch class 만 맞으면 정답이라, 테스트에서도 아무 옥타브(C4 기준)로 계산해서 보낸다.
  const playPromptText = await js(`${$('fb-prompt')}.textContent`);
  const playNote = playPromptText.split(' ')[0];
  const playPc = FB_NOTE_NAMES.indexOf(playNote);
  const playMidi = 60 + playPc; // C4 기준 아무 옥타브 — pc 비교라 옥타브는 무관
  const freq = 440 * Math.pow(2, (playMidi - 69) / 12);
  win.webContents.send('engine:event', { ev: 'pitch', freq });
  await wait(120);
  expect('1프레임 일치만으론 아직 미판정', await js(`${$('fb-score')}.textContent`), '0/0');
  win.webContents.send('engine:event', { ev: 'pitch', freq });
  await wait(300);
  expect('2연속 일치하면 정답 처리', await js(`${$('fb-score')}.textContent`), '1/1');
  // 실제로 연주한 정확한 음(C4 기준 옥타브)과 일치하는 자리를 지판에서 찾아 보여준다 —
  // 몇 개인지는 악기/설정에 따라 다르니 "적어도 하나는 초록으로 표시됨"만 확인한다.
  expect('연주한 자리가 지판에 정답(초록)으로 표시됨', await js(`document.querySelectorAll('.fret-pos-dot.correct').length > 0`), true);

  win.webContents.send('engine:event', { ev: 'exit' });
  await wait(200);
  expect('엔진 꺼지면 다시 안내로 전환', await js(`${$('fb-play-notice')}.hidden`), false);

  await js(`document.getElementById('fb-end').click(); true`);
  expect('실전연주 세션 종료 — 요약 화면 보임', await js(`${$('fb-summary')}.hidden`), false);
  await js(`document.getElementById('fb-summary-config').click(); true`);

  section('=== 스케일 찾기 — 포지션 박스 단위 ===');
  // 박스(4프렛)가 진짜로 좁혀지는 걸 보려면 범위를 4프렛보다 넓게 잡아야 한다.
  await js(`(() => { ${$('fb-fret-max')}.value = 11; ${$('fb-fret-max')}.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await js(`document.querySelector('#fb-mode-tabs .fb-mode-tab[data-mode="scale"]').click(); true`);
  await js(`(() => { ${$('fb-scale-box')}.value = '1'; ${$('fb-scale-box')}.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await js(`document.getElementById('fb-start').click(); true`);
  await wait(150);

  const boxPromptText = await js(`${$('fb-prompt')}.textContent`);
  const boxMatch = boxPromptText.match(/(\d+)~(\d+)프렛/);
  const boxFrom = Number(boxMatch[1]), boxTo = Number(boxMatch[2]);
  expect('박스 폭이 4프렛', boxTo - boxFrom + 1, 4);
  expect('박스 표시 사각형(.fret-box)이 그려짐', await js(`!!document.querySelector('.fret-box')`), true);

  const outsideFret = boxTo + 2 <= 11 ? boxTo + 2 : Math.max(0, boxFrom - 2);
  await js(`document.querySelector('.fret-pos[data-string="0"][data-fret="${outsideFret}"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
  expect('박스 밖 클릭은 무시됨(선택 안 됨)', await js(`!!document.querySelector('.fret-pos[data-string="0"][data-fret="${outsideFret}"] .fret-pos-dot.selected')`), false);

  await js(`document.querySelector('.fret-pos[data-string="0"][data-fret="${boxFrom}"]').dispatchEvent(new MouseEvent('click', { bubbles: true })); true`);
  expect('박스 안 클릭은 선택됨', await js(`!!document.querySelector('.fret-pos[data-string="0"][data-fret="${boxFrom}"] .fret-pos-dot.selected')`), true);

  await js(`document.getElementById('fb-end').click(); true`);
  await js(`(() => { ${$('fb-scale-box')}.value = '0'; ${$('fb-scale-box')}.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
