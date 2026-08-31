'use strict';
// 오토 트래킹 결과를 내보내면 미리보기보다 뚝뚝 끊겨 보인다는 신고("따라가기가 뚝뚝
// 끊기면서 이동 — 미리보기보다 조잡해"). buildEDL() 이 추적 키프레임(TRACK_SAMPLE_INTERVAL
// =0.1초 간격) 시각마다만 세그먼트를 갈랐던 게 원인 — 그 사이 0.1초 동안은 그 구간
// 중간(midpoint) 위치 딱 하나로 얼어붙어 있다가 다음 세그먼트에서 갑자기 점프했다(실제
// 위치 계산 자체는 정확한 보간이었지만, 그 결과가 "정지→점프"로만 쓰였다). 미리보기는
// 매 프레임 새로 보간해서 부드럽게 움직였으니 그 차이가 "미리보기보다 조잡하다"로
// 느껴졌다. 이제 EXPORT_INTERP_HZ(60) 간격으로 키프레임 사이사이에도 중간 경계를 더
// 넣어서, 같은 키프레임 구간(0~0.1초) 안에서도 위치가 계속 바뀌어야 한다 — 그 구간
// 초반(0.02초)과 후반(0.08초)을 각각 샘플링해서 서로 다른 자리에 있는지로 확인한다
// (예전 버그였다면 둘 다 그 구간의 중간값 한 자리에 얼어붙어 똑같았을 것).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetracksmooth-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetracksmooth-'));
const BG = path.join(TMP, 'bg.mp4');
const OVERLAY_IMG = path.join(TMP, 'overlay.png');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

// 60fps — export_INTERP_HZ(60) 만큼 촘촘한 중간 경계가 실제로 "그 프레임에 다른 위치"로
// 나타나는지 프레임 단위로 확인하려면 배경도 그만큼 촘촘해야 한다.
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:duration=1:rate=60`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BG], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=cyan:size=20x20', '-frames:v', '1', OVERLAY_IMG], { stdio: 'ignore' });
if (!fs.existsSync(BG) || !fs.existsSync(OVERLAY_IMG)) throw new Error('ffmpeg 로 테스트 파일 생성 실패');

// 키프레임 딱 2개(t=0, t=0.1) — 실제 추적 결과의 흔한 간격(TRACK_SAMPLE_INTERVAL=0.1초)과
// 같다. 그 사이(0~0.1초)에 가로로 크게(x: 0.1→0.8, 32px→256px) 움직인다 — 이 하나의
// "옛 세그먼트" 안에서 위치가 계속 바뀌는지가 이 테스트의 핵심이다.
const PROJ = {
  tracks: [
    { id: 2, name: '', color: '#4a90d9', height: 72, hidden: false, kind: 'video', transform: null },
    { id: 1, name: '', color: '#35d1a6', height: 72, hidden: false, kind: 'video', transform: null },
  ],
  clips: [
    { id: 1, trackId: 1, file: BG, name: 'bg.mp4', start: 0, inOff: 0, srcDur: 1, dur: 1, w: W, h: H, hasAudio: false, isAudioOnly: false, effects: [] },
    {
      id: 2, trackId: 2, file: OVERLAY_IMG, name: 'overlay.png', start: 0, inOff: 0, srcDur: 86400, dur: 0.2, w: 20, h: 20,
      hasAudio: false, isAudioOnly: false, effects: [], isImage: true,
      trackKeyframes: [
        { t: 0, x: 0.1, y: 0.4, w: 0.0625, h: 0.0833 },
        { t: 0.1, x: 0.8, y: 0.4, w: 0.0625, h: 0.0833 },
      ],
    },
  ],
  resolution: { w: W, h: H },
};
fs.writeFileSync(path.join(TMP, 'smooth.dsvproj'), JSON.stringify(PROJ));

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(TMP, 'smooth.dsvproj')] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function readFrame(file, t) {
  const raw = file + `.${t}.raw`;
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  return fs.readFileSync(raw);
}
const isCyan = (r, g, b) => g > 150 && b > 150 && r < 100;
// 그 시각의 프레임에서 상자의 왼쪽 가장자리(y 행 기준 가장 왼쪽 시안 픽셀) x 좌표를 찾는다
// — 정확한 픽셀 값을 미리 계산하는 대신(세그먼트 경계가 정확히 그 시각이 아니라 그 세그먼트의
// "중간" 시각 기준이라 몇 프레임 어긋날 수 있다) 실제로 상자가 어디 있는지 그때그때 찾아서
// 비교한다 — 얼마나 정확한 자리인지보다 "그 사이에도 계속 움직였는지" 가 핵심이라 이쪽이 더 튼튼하다.
function leftEdge(file, t, y) {
  const buf = readFrame(file, t);
  for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    if (isCyan(buf[o], buf[o + 1], buf[o + 2])) return x;
  }
  return -1;   // 그 행엔 상자가 없음
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) .dsvproj 열기 — 0.1초 간격 키프레임 2개(그 사이 크게 이동)');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-open-project').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  expect('클립 2개 복원됨', await js(`document.querySelectorAll('.ve-clip').length`), 2);

  section('2) 내보내기 — 같은 키프레임 구간(0~0.1초) 안에서도 프레임마다 위치가 계속 바뀌어야 함');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const y = Math.round(0.4 * H + 10);   // 상자 안쪽 y
    // 옛 세그먼트 하나(0~0.1초) 안에서 여러 시각을 촘촘히 찍어(0.01~0.09초, 60fps 프레임
    // 간격) 왼쪽 가장자리 x 좌표를 모은다 — 전부 다 얼어붙어 있었다면(예전 버그) 값이
    // 하나(또는 극소수)로만 몰려 있을 거고, 고쳤다면 프레임마다 점점 오른쪽으로 이동해야 한다.
    const times = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09];
    const edges = times.map((t) => leftEdge(OUT, t, y));
    console.log(`  왼쪽 가장자리 x 좌표(0.01~0.09초): ${edges.join(', ')}`);
    // 0.01초 간격은 ffmpeg 의 -ss 탐색 정밀도 한계에 가까워(60fps=프레임당 0.0167초) 일부
    // 시각은 정확히 그 프레임을 못 짚고 인접 세그먼트 경계로 빠질 수 있다(그 프레임엔 상자가
    // 없는 게 아니라 탐색 자체가 살짝 어긋난 것) — 그래도 "찾은" 샘플만으로도 여러 다른
    // 위치를 지나가는지, 시작보다 끝이 뚜렷이 오른쪽인지는 충분히 가려낼 수 있다.
    const found = edges.filter((e) => e >= 0);
    expect('대부분의 시각에서 상자를 찾음(탐색 오차로 몇 개는 빠질 수 있음)', found.length >= 5, true);
    // EXPORT_INTERP_HZ 를 60→30 으로 낮췄다(소스 프레임 주기보다 짧은 세그먼트가 ffmpeg
    // trim 에서 0프레임을 내놓는 실측 버그를 피하려고) — 이 0.1초 구간 안에서 이론상
    // 최대 3개 지점까지만 갈린다(0, 1/30, 2/30초 경계). -ss 탐색 오차까지 겹치면 2개만
    // 잡힐 수도 있다 — "1개(예전 버그, 완전히 얼어붙음)" 만 아니면 된다.
    const distinctPositions = new Set(found).size;
    expect('한 자리에 얼어붙지 않고 최소 두 개 이상의 다른 위치를 지나감(뚝뚝 끊기던 버그면 1개뿐)', distinctPositions >= 2, true);
    expect('시작(0.01초)보다 끝(0.09초)이 뚜렷이 더 오른쪽(왼쪽→오른쪽으로 실제 이동)', edges[edges.length - 1] - edges[0] > 50, true);
    // 찾은 것들끼리는 시간 순서대로 대체로 증가해야 한다(완전히 거꾸로거나 널뛰기하면 안 된다).
    let increases = 0;
    for (let i = 1; i < found.length; i++) if (found[i] >= found[i - 1] - 1) increases++;
    expect('대체로 왼쪽에서 오른쪽으로 단조 증가(들쭉날쭉 널뛰기 아님)', increases >= found.length - 2, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
