'use strict';
// 미리보기와 내보내기 결과 일치성(총점검) — PIP(트랙 겹침) 레이어에 페이드인/아웃을
// 걸면, 미리보기는 진짜 투명도로 밑 트랙이 비쳐 보이는데(opacity 기반) 내보내기는
// fade 필터가 밝기만 죽이고 그 화소를 그대로 불투명하게 overlay 해서 검은 사각형이
// 덮인 것처럼 보였다 — 화면 전체를 채우는 클립(밑에 아무 것도 없음)만 쓰던 기존
// videofade.test.js 는 이 차이를 못 잡았다. main.js 의 fadeFrag(kind,obj,{alpha:true})
// + format=yuva420p 로 PIP 레이어만 알파를 페이드하게 고친 뒤, 실제로 페이드 시작
// 지점(알파≈0)에서 PIP 자리에 검은색이 아니라 "밑 트랙 색"이 비치는지로 검증한다.
// buildEDL() 드래그 시뮬레이션 없이 video:export 계약(segments.layers)만 떼어 확인
// (videopip.test.js 와 같은 방식).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vepipfade-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vepipfade-'));
const WHITE = path.join(TMP, 'white.mp4');   // PIP 전경(페이드 걸림)
const GREEN = path.join(TMP, 'green.mp4');   // 배경(풀프레임, 페이드 없음)
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

function makeClip(file, color, seconds) {
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=${color}:size=${W}x${H}:duration=${seconds}:rate=15`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(WHITE, 'white', 2);
makeClip(GREEN, 'green', 2);

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function pxAt(file, tSec, x, y) {
  const raw = path.join(TMP, `f_${tSec}_${x}_${y}.raw`);
  spawnSync(FFMPEG, ['-y', '-ss', String(tSec), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (y * W + x) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}
function isNearBlack(p) { return p.r < 25 && p.g < 25 && p.b < 25; }
function isNearGreen(p) { return p.g > 80 && p.r < 60 && p.b < 60; }   // ffmpeg 'green'=RGB(0,128,0), YUV 왕복하면 g≈128~140
function isNearWhite(p) { return p.r > 200 && p.g > 200 && p.b > 200; }

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 1500 });

  section('1) PIP(흰색, 페이드인 1초) + 배경(초록, 풀프레임) 세그먼트로 내보내기');
  // PIP 상자: x=0.1,y=0.1,scale=0.5 → 320x240 기준 (32,24)~(192,144), 중심 (112,84).
  const segments = [{
    layers: [
      { file: WHITE, start: 0, end: 2, transform: { x: 0.1, y: 0.1, scale: 0.5 }, fadeInD: 1, fadeInSt: 0 },
      { file: GREEN, start: 0, end: 2, transform: null },
    ],
    audioSources: [],
    refW: W, refH: H, dur: 2,
  }];
  const res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments, outPath: OUT })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('내보내기 성공', res?.ok, true);
  if (!res?.ok) console.log('  export error:', res?.error);
  expect('출력 파일 생김', fs.existsSync(OUT), true);

  if (fs.existsSync(OUT)) {
    section('2) 페이드 시작 직후(알파≈0) — PIP 자리는 검정이 아니라 밑(배경 초록)이 비쳐야 함');
    const early = pxAt(OUT, 0.05, 112, 84);
    console.log('  t=0.05 PIP 중심 픽셀:', JSON.stringify(early));
    expect('검은 사각형이 아님(알파 합성)', isNearBlack(early), false);
    expect('배경(초록)이 비쳐 보임', isNearGreen(early), true);

    section('3) 페이드 끝난 뒤(알파=1) — PIP 자리는 완전히 흰색');
    const late = pxAt(OUT, 1.9, 112, 84);
    console.log('  t=1.9 PIP 중심 픽셀:', JSON.stringify(late));
    expect('페이드 끝 — 흰색 그대로 보임', isNearWhite(late), true);

    section('4) 배경만 있는 자리(PIP 밖)는 그대로 초록');
    const bg = pxAt(OUT, 0.05, 250, 200);
    expect('PIP 밖은 배경 초록', isNearGreen(bg), true);
  }

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
