'use strict';
// 자막 배경 상자 곡률(bgRadius) — main.js 가 별도 반투명 둥근 사각형을 overlay 로 얹고
// 그 위에 box 없이 drawtext 만 그리는 경로(roundedBoxLabel)를 검증한다. 진짜 코너
// (라운딩 원 밖)는 배경이 비쳐 보이고, 상자 안쪽(코너 아닌 자리)은 반투명 검정이 실제로
// 덮여야 한다 — buildEDL 드래그 시뮬레이션 없이 video:export 계약(segments.texts)만
// 떼어 확인(videopipfadealpha.test.js 와 같은 방식). boxW/boxH 는 렌더러의 캔버스 측정
// 대신 테스트에서 직접 고정값으로 줘서 좌표를 정확히 계산할 수 있게 한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetxtradius-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetxtradius-'));
const GREEN = path.join(TMP, 'green.mp4');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=green:size=${W}x${H}:duration=2:rate=15`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', GREEN], { stdio: 'ignore' });
if (!fs.existsSync(GREEN)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

function pxAt(file, tSec, x, y) {
  const raw = path.join(TMP, `f_${tSec}_${x}_${y}.raw`);
  spawnSync(FFMPEG, ['-y', '-ss', String(tSec), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (y * W + x) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}
function isNearGreen(p) { return p.g > 80 && p.r < 60 && p.b < 60; }

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 1500 });

  section('1) 배경(초록) + 자막(둥근 배경 상자, boxW=160/boxH=60/radius=20, 중앙)으로 내보내기');
  // 박스 x:[80,240] y:[90,150] (320x240 기준 중앙, 160x60). radius=20.
  const segments = [{
    file: GREEN, start: 0, end: 2,
    texts: [{ content: 'TEST', x: 0.5, y: 0.5, size: 24, color: '#ffffff', fontKey: 'malgun', bg: true, bgRadius: 20, boxW: 160, boxH: 60 }],
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
    section('2) 박스 진짜 코너(라운딩 원 밖) — 배경(초록)이 비쳐 보여야 함');
    // 코너 원 중심(100,110), r=20. (82,92)는 중심까지 거리 hypot(18,18)=25.4 > 20 → 원 밖.
    const corner = pxAt(OUT, 1, 82, 92);
    console.log('  코너 픽셀(82,92):', JSON.stringify(corner));
    expect('코너는 배경(초록)', isNearGreen(corner), true);

    section('3) 박스 안쪽(코너 아닌 자리) — 반투명 검정이 실제로 덮여 초록이 아니어야 함');
    // y=120 은 코너 제외 구간(90+20~150-20). x=85 는 왼쪽 가장자리 근처지만 y 가 중간
    // 밴드라 코너 규칙 자체가 적용 안 됨 — 항상 보여야 함.
    const side = pxAt(OUT, 1, 85, 120);
    console.log('  안쪽 가장자리 픽셀(85,120):', JSON.stringify(side));
    expect('상자 안쪽은 초록이 아님(반투명 검정 덮임)', isNearGreen(side), false);

    section('4) 박스 밖(멀리 떨어진 자리)은 그대로 배경 초록');
    const far = pxAt(OUT, 1, 10, 10);
    expect('박스 밖은 배경 초록', isNearGreen(far), true);
  }

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
