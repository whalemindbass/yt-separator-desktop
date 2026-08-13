'use strict';
// 저장 안 한 작업 보호 — 진짜 main.js 를 올려 IPC·다이얼로그·파일 경로를 그대로 태운다.
// 네이티브 대화상자는 자동화할 수 없으므로 showMessageBox 를 가로채 답을 정해 준다.

const path = require('path'); const fs = require('fs');
const { dialog } = require('electron');

let answer = 2;                 // 0 저장하고 닫기 · 1 저장 안 함 · 2 취소
const asked = [];
let saveDialogs = 0;
dialog.showMessageBox = async (_win, opts) => { asked.push(opts.message); return { response: answer }; };
dialog.showSaveDialog = async () => { saveDialogs++; return { canceled: true }; };

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, win, js } = await bootMain({ settle: 3000 });
  const userData = app.getPath('userData');
  const AUTO = path.join(userData, 'autosave.yssproj');
  const META = path.join(userData, 'autosave.json');
  for (const p of [AUTO, META]) { try { fs.unlinkSync(p); } catch {} }

  section('1) 스냅샷을 쓴다');
  await js(`window.yssApi.project.autosaveWrite(
    JSON.stringify({kind:'yssproj',version:2,name:'테스트곡'}),
    {name:'테스트곡', projectPath:'C:/x/테스트곡.yssproj'})`);
  await wait(300);
  expect('스냅샷 생성  ', fs.existsSync(AUTO), true);
  expect('메타 생성    ', fs.existsSync(META), true);
  expect('임시 파일 없음', fs.existsSync(AUTO + '.tmp'), false);
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  expect('메타 이름    ', meta.name, '테스트곡');
  expect('메타 시각    ', typeof meta.at === 'number' && meta.at > 0, true);

  section('2) 다시 읽는다');
  const read = await js('window.yssApi.project.autosaveRead()');
  expect('읽기 성공    ', read.ok, true);
  expect('내용 보존    ', JSON.parse(read.data).name, '테스트곡');

  section('3) 저장 안 한 상태로 닫으려 하면 묻는다 — 취소하면 남는다');
  await js('window.yssApi.project.setDirty(true); true');
  await wait(200);
  answer = 2;
  win.close();
  await wait(800);
  expect('창 유지      ', win.isDestroyed(), false);
  expect('물어봤다     ', asked.length >= 1, true);
  expect('문구         ', asked[asked.length - 1], '저장하지 않은 작업이 있습니다');

  section('4) 언어를 영어로 두면 대화상자도 영어로 뜬다');
  await js('window.yssApi.setLocale("en"); true');
  await wait(200);
  answer = 2;
  win.close();
  await wait(800);
  expect('영어 문구    ', asked[asked.length - 1], 'You have unsaved work');
  await js('window.yssApi.setLocale("ko"); true');
  await wait(200);

  section('5) "저장하지 않고 닫기" — 닫히고 복구본도 지운다');
  // 창이 닫히면 앱이 곧 종료되므로 검사도 그 순간에 한다
  win.on('closed', () => {
    expect('스냅샷 삭제  ', fs.existsSync(AUTO), false);
    expect('메타 삭제    ', fs.existsSync(META), false);
    expect('저장 창 안 뜸', saveDialogs, 0);
    finish(app);
  });
  answer = 1;
  win.close();
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
