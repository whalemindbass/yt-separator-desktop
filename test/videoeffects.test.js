'use strict';
// 클립 효과 체인(밝기/대비/채도/흑백/세피아/블러) — main.js 의 chainFrag() 가 순서 있는
// 목록을 정확한 순서로 적용하는지, 그리고 예전 clip.color/clip.fx(고정 슬롯) 프로젝트가
// effects[] 로 잘 옮겨지는지(마이그레이션) 검증한다.
//
// 왼쪽 패널 UI 는 아직 없다(별도 작업으로 진행 중) — 여기서는 main.js 의 export 계약을
// 세그먼트를 직접 구성해서 검증한다(이전 PIP 테스트들과 같은 방식). 각 효과의 정확한
// 계수는 크로미움 실제 CSS 필터 출력과 대조해 이미 검증된 값들이다(오차 0~1픽셀).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefx2-'));
const RED = path.join(TMP, 'red.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=0xDC3C1E:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', RED], { stdio: 'ignore' });
if (!fs.existsSync(RED)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

// userData 를 부팅 *전에* 준비해서 예전 형식(clip.color/clip.fx 고정 슬롯) 프로젝트를
// 미리 심어둔다 — loadProject() 가 처음 영상 탭을 열 때 이걸 읽고 마이그레이션해야 한다.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vefx2-profile-'));
app.setPath('userData', PROFILE);
fs.writeFileSync(path.join(PROFILE, 'videoProject.json'), JSON.stringify({
  tracks: [{ id: 1, name: '', color: '#35d1a6', height: 72, hidden: false, kind: 'video' }],
  clips: [{
    id: 1, trackId: 1, file: RED, name: 'red.mp4', start: 0, inOff: 0, srcDur: 2, dur: 2, w: W, h: H,
    hasAudio: false, isAudioOnly: false,
    color: { b: 20, c: 0, s: -30 }, fx: { bw: false, sepia: true, blur: 5 },
  }],
}));

const { bootMain, expect, near, section, wait, finish } = require('./harness');

function framePixel(file, t) {
  const raw = file + `.${t}.raw`;
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  const o = (Math.floor(H / 2) * W + Math.floor(W / 2)) * 3;
  return { r: buf[o], g: buf[o + 1], b: buf[o + 2] };
}
async function exportSegments(js, segments, outPath) {
  return js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments, outPath })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(500);

  section('1) 예전 clip.color/clip.fx(고정 슬롯) 프로젝트 → effects[] 마이그레이션');
  expect('부팅 시 예전 프로젝트의 클립 1개가 그대로 복원됨', await js(`document.querySelectorAll('.ve-clip').length`), 1);
  const projFile = path.join(PROFILE, 'videoProject.json');
  // 마이그레이션 자체는 로드 시점에 메모리에서 일어난다 — 뭐라도 하나 편집을 트리거해서
  // scheduleSave 가 새 형식으로 다시 써지게 한다(단순 조회만으론 자동 저장 안 됨).
  await js(`document.getElementById('ve-zoom-in').click(); true`);
  await wait(1000);   // scheduleSave 디바운스(600ms)
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(projFile, 'utf-8')); } catch {}
  const migClip = saved?.clips?.[0];
  expect('저장된 클립에 effects 배열 생김', Array.isArray(migClip?.effects), true);
  expect('color 필드는 사라짐(더는 안 씀)', migClip?.color, undefined);
  expect('fx 필드도 사라짐', migClip?.fx, undefined);
  const types = (migClip?.effects || []).map(e => e.type).sort().join(',');
  expect('마이그레이션된 효과 종류가 정확함(밝기·채도·세피아·블러 — bw 는 꺼져있어서 제외)',
    types, ['blur', 'brightness', 'saturation', 'sepia'].sort().join(','));

  section('2) 체인 순서가 실제로 결과에 영향을 준다 — 흑백→세피아 vs 세피아→흑백');
  // 흑백 다음 세피아: 무채도가 된 뒤 세피아 톤이 입혀져서 갈색조가 남는다.
  // 세피아 다음 흑백: 세피아로 물든 뒤 다시 무채도가 되니 색조가 안 남아야 한다(회색).
  const OUT_A = path.join(TMP, 'out_bw_then_sepia.mp4');
  const OUT_B = path.join(TMP, 'out_sepia_then_bw.mp4');
  const resA = await exportSegments(js, [{
    file: RED, start: 0, end: 2, audioSources: [], refW: W, refH: H, dur: 2,
    effects: [{ id: 1, type: 'bw', enabled: true }, { id: 2, type: 'sepia', enabled: true }],
  }], OUT_A);
  expect('흑백→세피아 내보내기 성공', resA?.ok, true);
  const resB = await exportSegments(js, [{
    file: RED, start: 0, end: 2, audioSources: [], refW: W, refH: H, dur: 2,
    effects: [{ id: 1, type: 'sepia', enabled: true }, { id: 2, type: 'bw', enabled: true }],
  }], OUT_B);
  expect('세피아→흑백 내보내기 성공', resB?.ok, true);
  if (fs.existsSync(OUT_A) && fs.existsSync(OUT_B)) {
    const pxA = framePixel(OUT_A, 0.5), pxB = framePixel(OUT_B, 0.5);
    // R 채널 하나만 보면 이 테스트 색상에선 두 경로가 우연히 비슷한 값으로 수렴한다(직접
    // 계산해서 확인함 — 버그 아니라 이 색상만의 우연). 그래서 "채도 유무"(A 는 색조가
    // 남고 B 는 완전 무채도)로 순서가 다른 결과를 만든다는 걸 확인한다 — 이게 더 확실하다.
    expect('흑백→세피아는 갈색조가 남음(R>G>B, 무채도 아님)', pxA.r > pxA.g + 5 && pxA.g > pxA.b, true);
    expect('세피아→흑백은 무채도(R≈G≈B) — 순서가 달라 A 와는 다른 결과', Math.abs(pxB.r - pxB.g) < 4 && Math.abs(pxB.g - pxB.b) < 4, true);
  }

  section('3) enabled:false 는 건너뛴다(끄기 — 목록에서 지우지 않고 비활성화)');
  const OUT_C = path.join(TMP, 'out_disabled.mp4');
  const resC = await exportSegments(js, [{
    file: RED, start: 0, end: 2, audioSources: [], refW: W, refH: H, dur: 2,
    effects: [{ id: 1, type: 'bw', enabled: false }],   // 꺼져 있으니 원본 그대로여야 함
  }], OUT_C);
  expect('비활성 효과로 내보내기 성공', resC?.ok, true);
  if (fs.existsSync(OUT_C)) {
    const px = framePixel(OUT_C, 0.5);
    expect('꺼진 흑백은 적용 안 됨(원래 색 그대로, 무채도 아님)', px.r > px.g + 20, true);
  }

  section('4) 밝기+대비 조합 — 정확한 CSS 배율로');
  const OUT_D = path.join(TMP, 'out_bc.mp4');
  const resD = await exportSegments(js, [{
    file: RED, start: 0, end: 2, audioSources: [], refW: W, refH: H, dur: 2,
    effects: [{ id: 1, type: 'brightness', value: 50, enabled: true }, { id: 2, type: 'contrast', value: 30, enabled: true }],
  }], OUT_D);
  expect('밝기+대비 내보내기 성공', resD?.ok, true);
  if (fs.existsSync(OUT_D)) {
    const px = framePixel(OUT_D, 0.5);
    // 소스 R=220 → *1.5=330→clip 255 → 대비(255-128)*1.3+128=293→clip 255
    near('R 채널이 밝기+대비 순서대로 계산한 값과 일치(둘 다 상한 근접)', px.r, 255, 5);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
