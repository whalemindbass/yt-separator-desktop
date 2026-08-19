'use strict';
// 제보: "EXPORT할때 저장위치 선택 시 파일형식에 WAV (*.mp3)로 보이는데 왜 그런 거야?"
//
// main.js 의 dialog:saveAs 핸들러가 필터 이름을 'WAV' 로 하드코딩해 뒀었다 — 확장자 목록은
// 호출부가 넘긴 값(exts)을 그대로 쓰면서, 이름표만 항상 "WAV" 였다. 스튜디오 export 창에서
// MP3 를 고르면 api.dialog.saveAs('mix.mp3', ['mp3']) 처럼 exts=['mp3'] 로 부르는데, 필터
// 이름은 여전히 "WAV" 로 남아 저장창에 "WAV (*.mp3)" 라는 앞뒤가 안 맞는 표시가 떴다.
//
// dialog.showSaveDialog 를 가로채서 실제로 넘어가는 filters 값을 검사한다 — 진짜 대화상자를
// 못 띄우니(automated 환경) 스텁으로 대체.
const { dialog } = require('electron');

const seen = [];
dialog.showSaveDialog = async (_win, opts) => { seen.push(opts.filters); return { canceled: true }; };

const { bootMain, expect, wait, finish } = require('./harness');

(async () => {
  const { app, win, js } = await bootMain({ settle: 2500 });

  await js(`window.yssApi.dialog.saveAs('mix.wav', ['wav'])`);
  await js(`window.yssApi.dialog.saveAs('mix.mp3', ['mp3'])`);
  await wait(200);

  const [wavFilters, mp3Filters] = seen;
  expect('wav 확장자', wavFilters?.[0]?.extensions?.[0], 'wav');
  expect('wav 이름표', wavFilters?.[0]?.name, 'WAV');
  expect('mp3 확장자', mp3Filters?.[0]?.extensions?.[0], 'mp3');
  expect('mp3 이름표는 WAV 아님', mp3Filters?.[0]?.name === 'WAV', false);
  expect('mp3 이름표', mp3Filters?.[0]?.name, 'MP3');

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
