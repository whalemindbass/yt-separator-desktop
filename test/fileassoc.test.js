'use strict';
// .yssproj 연결 — 아이콘·등록 정보와, 더블클릭으로 들어온 파일이 실제로 열리는가.

const path = require('path'); const fs = require('fs');
const { bootMain, expect, section, wait, finish } = require('./harness');
const ROOT = path.resolve(__dirname, '..');

const PROJECT = {
  kind: 'yssproj', version: 2, sampleRate: 48000,
  name: '연결 시험곡', bpm: 100, beats: [], master: 1,
  buses: [], stems: null, tracks: [], takes: [],
};

(async () => {
  section('1) 빌드 설정에 연결이 등록돼 있는가');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const fa = (pkg.build.fileAssociations || [])[0];
  expect('연결 항목    ', !!fa, true);
  expect('확장자       ', fa && fa.ext, 'yssproj');
  expect('아이콘 지정  ', fa && fa.icon, 'build/yssproj.ico');
  expect('편집기 역할  ', fa && fa.role, 'Editor');

  section('2) 아이콘 파일이 실제로 있고 여러 크기를 담았는가');
  const ico = path.join(ROOT, 'build', 'yssproj.ico');
  expect('파일 존재    ', fs.existsSync(ico), true);
  const buf = fs.readFileSync(ico);
  expect('ICO 서명     ', buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1, true);
  const count = buf.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const w = buf[6 + i * 16] || 256;
    sizes.push(w);
  }
  console.log('   담긴 크기:', sizes.sort((a, b) => a - b).join(', '));
  expect('크기 여러 개 ', count >= 6, true);
  expect('16px 포함    ', sizes.includes(16), true);
  expect('256px 포함   ', sizes.includes(256), true);

  section('3) 더블클릭으로 들어온 파일이 스튜디오에서 열리는가');
  const { app, win, js } = await bootMain({ settle: 3000 });
  const file = path.join(app.getPath('temp'), '연결시험.yssproj');
  fs.writeFileSync(file, JSON.stringify(PROJECT), 'utf8');

  // main 이 보내는 것과 같은 모양으로 넣는다
  win.webContents.send('project:open-file', { path: file, data: fs.readFileSync(file, 'utf8') });
  await wait(3500);

  const st = await js(`({
    화면: document.querySelector('main.view:not([hidden])')?.dataset.view,
    제목: document.querySelector('#st-proj-name .pn-label')?.textContent || '',
  })`);
  console.log('   화면:', st.화면, '· 제목:', st.제목);
  expect('스튜디오로 이동', st.화면, 'studio');
  expect('파일 이름 표시', st.제목.includes('연결시험'), true);
  expect('저장됨 표시  ', st.제목.includes('•'), false);   // 방금 연 것은 변경 없음

  try { fs.unlinkSync(file); } catch {}
  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
