'use strict';
// 클립에 추적 키프레임(clip.trackKeyframes)이 있으면 buildEDL 이 그 시각들을 세그먼트
// 경계로 잘게 쪼개서, 시간에 따라 오버레이가 실제로 움직이며 내보내지는지 검증한다
// (main.js 는 새 코드 없이 기존 layers/PIP 파이프라인을 그대로 탄다 — {x,y,w,h} 형식만
// 새로 받는다). 렌더러 드래그 시뮬레이션 없이 .dsvproj 를 직접 만들어 "열기"로 불러온다
// (videoprojectfile.test.js 와 같은 패턴).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrack-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrack-'));
const BG = path.join(TMP, 'bg.mp4');
const OVERLAY_IMG = path.join(TMP, 'overlay.png');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BG], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=yellow:size=40x40', '-frames:v', '1', OVERLAY_IMG], { stdio: 'ignore' });
if (!fs.existsSync(BG) || !fs.existsSync(OVERLAY_IMG)) throw new Error('ffmpeg 로 테스트 파일 생성 실패');

const PROJ = {
  tracks: [
    { id: 2, name: '', color: '#4a90d9', height: 72, hidden: false, kind: 'video', transform: null },
    { id: 1, name: '', color: '#35d1a6', height: 72, hidden: false, kind: 'video', transform: null },
  ],
  clips: [
    { id: 1, trackId: 1, file: BG, name: 'bg.mp4', start: 0, inOff: 0, srcDur: 2, dur: 2, w: W, h: H, hasAudio: false, isAudioOnly: false, effects: [] },
    {
      id: 2, trackId: 2, file: OVERLAY_IMG, name: 'overlay.png', start: 0, inOff: 0, srcDur: 86400, dur: 2, w: 40, h: 40,
      hasAudio: false, isAudioOnly: false, effects: [], isImage: true,
      // 왼쪽위(0.05,0.05)에서 오른쪽아래(0.7,0.7)로 2초에 걸쳐 이동 — 키프레임 2개(시작/끝)뿐이면
      // buildEDL 이 쪼갤 중간 경계가 없어서 구간 전체가 "중간값 하나"로 뭉개진다(실측으로 확인한
      // 버그 아닌 동작) — 실제 추적처럼 여러 지점을 촘촘히 넣어야 애니메이션(잘게 쪼갠 세그먼트)이
      // 제대로 나온다.
      trackKeyframes: Array.from({ length: 11 }, (_, i) => {
        const m = i / 10;
        return { t: m * 2, x: 0.05 + (0.7 - 0.05) * m, y: 0.05 + (0.7 - 0.05) * m, w: 0.15, h: 0.2 };
      }),
    },
  ],
  resolution: { w: W, h: H },
};
fs.writeFileSync(path.join(TMP, 'track.dsvproj'), JSON.stringify(PROJ));

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(TMP, 'track.dsvproj')] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function samplePixel(file, t, x, y) {
  const raw = file + `.${t}.${x}.${y}.raw`;
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (y * W + x) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}
const isYellow = (p) => p.r > 180 && p.g > 180 && p.b < 100;

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) .dsvproj 열기 — 추적 키프레임 가진 오버레이 클립 복원');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-open-project').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  expect('클립 2개 복원됨', await js(`document.querySelectorAll('.ve-clip').length`), 2);

  section('2) 내보내기 — 시작 지점(좌상단)과 끝 지점(우하단)에 실제로 노란색이 따라 움직였는지');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    // t=0.1초: 좌상단(0.05*320≈16, 0.05*240≈12) 근처 + 박스 중앙쯤(24,24) 노란색.
    const start = samplePixel(OUT, 0.1, 30, 30);
    expect('시작 시점엔 좌상단 쪽에 노란 오버레이', isYellow(start), true);
    // 시작 시점엔 우하단(0.7*320≈224, 0.7*240≈168)에는 없어야 함.
    const startFar = samplePixel(OUT, 0.1, 260, 200);
    expect('시작 시점엔 우하단은 그냥 배경(검정)', isYellow(startFar), false);

    // t=1.8초(끝 무렵): 우하단 쪽에 노란색, 좌상단엔 없어야 함.
    const end = samplePixel(OUT, 1.8, 250, 190);
    expect('끝 시점엔 우하단 쪽에 노란 오버레이(따라 움직임)', isYellow(end), true);
    const endFar = samplePixel(OUT, 1.8, 20, 20);
    expect('끝 시점엔 좌상단은 그냥 배경(검정)', isYellow(endFar), false);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
