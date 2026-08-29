'use strict';
// "프로그램 시작했을 때 빈 프로젝트여야 하는데 항상 끄기 전에 있던 것들이 불러와짐" —
// userData 에 이전 세션의 자동 저장(videoProject.json)이 실제로 남아 있어도, 부팅 직후
// 영상 탭은 항상 빈 프로젝트여야 한다(자동 복원 제거). 저장 자체는 안전망으로 계속
// 되니(scheduleSave), 그 파일이 여전히 쓰이는지도 같이 확인한다 — "복원만 안 한다"이지
// "저장 자체를 없앤다"가 아니다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { app } = require('electron');

const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vebootempty-profile-'));
app.setPath('userData', PROFILE);
// 실제 있었을 법한 "이전 세션" 자동 저장을 미리 심어둔다.
fs.writeFileSync(path.join(PROFILE, 'videoProject.json'), JSON.stringify({
  tracks: [{ id: 1, name: '', color: '#35d1a6', height: 72, hidden: false, kind: 'video' }],
  clips: [{ id: 1, trackId: 1, file: 'C:\\nowhere\\old.mp4', name: 'old.mp4', start: 0, inOff: 0, srcDur: 5, dur: 5, w: 320, h: 240, hasAudio: false, isAudioOnly: false, effects: [] }],
  resolution: null,
}));

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 이전 세션 자동 저장이 있어도 부팅 직후엔 빈 프로젝트');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  expect('클립 0개', await js(`document.querySelectorAll('.ve-clip').length`), 0);
  expect('영상 트랙도 0개', await js(`document.querySelectorAll('.ve-lane').length`), 0);
  expect('빈 상태 안내 문구가 보임', await js(`document.getElementById('ve-empty')?.hidden`), false);

  section('2) 그래도 자동 저장(안전망)은 계속 동작함 — 뭔가 편집하면 새로 써짐');
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await wait(1000);   // scheduleSave 디바운스(600ms)
  const projFile = path.join(PROFILE, 'videoProject.json');
  const saved = JSON.parse(fs.readFileSync(projFile, 'utf-8'));
  expect('편집하면 자동 저장 파일이 새 상태로 갱신됨(예전 old.mp4 클립은 없음)', (saved.clips || []).length, 0);
  expect('새로 만든 트랙 1개가 저장됨', (saved.tracks || []).length, 1);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
