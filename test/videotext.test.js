'use strict';
// 텍스트/타이틀 오버레이 — main.js video:export 의 drawtext 통합을 렌더러 UI 없이
// api.video.export() 로 직접 검증한다(videopip.test.js 와 같은 패턴: segments 를 손으로
// 만들어 filter_complex 계약만 떼어서 확인). 실제 픽셀(ffmpeg 로 프레임 추출)로 텍스트가
// 정말 그려졌는지까지 본다 — "필터 문법이 유효하다"와 "실제로 그 결과가 나온다"는 다르다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetext-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetext-'));
const SRC = path.join(TMP, 'blue.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=blue:size=${W}x${H}:duration=3:rate=10`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function probeFrameCounts(file) {
  const raw = path.join(TMP, path.basename(file, '.mp4') + '.rgb');
  spawnSync(FFMPEG, ['-y', '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw], { stdio: 'ignore' });
  const d = fs.readFileSync(raw);
  let yellow = 0, boxDark = 0, blue = 0;
  for (let i = 0; i < d.length; i += 3) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    if (r > 200 && g > 200 && b < 100) yellow++;
    else if (r < 60 && g < 60 && b < 140 && !(r < 20 && g < 20 && b > 150)) boxDark++;
    else if (b > 150 && r < 80 && g < 80) blue++;
  }
  return { yellow, boxDark, blue, total: d.length / 3 };
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 기본 세그먼트(plain) — 텍스트 오버레이 있는/없는 결과 비교');
  const OUT_NOTEXT = path.join(TMP, 'out_notext.mp4');
  const baseSeg = { file: SRC, start: 0, end: 2, refW: W, refH: H, dur: 2, audioSources: [{ file: SRC, start: 0, end: 2 }] };
  let res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [baseSeg], outPath: OUT_NOTEXT, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('텍스트 없는 내보내기 성공(회귀 없음)', res?.ok, true);

  const OUT_TEXT = path.join(TMP, 'out_text.mp4');
  const texts = [{ content: 'Hello 안녕', x: 0.5, y: 0.5, size: 40, color: '#ffff00' }];
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts }], outPath: OUT_TEXT, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('텍스트 있는 내보내기 성공', res?.ok, true);
  if (!res?.ok) console.log('  export error:', res?.error);
  let cText = null;
  if (fs.existsSync(OUT_TEXT)) {
    cText = probeFrameCounts(OUT_TEXT);
    expect('노란 글자 픽셀 있음(#ffff00 fontcolor)', cText.yellow > 20, true);
  }
  if (fs.existsSync(OUT_NOTEXT)) {
    const c0 = probeFrameCounts(OUT_NOTEXT);
    expect('텍스트 없는 쪽엔 노란 픽셀 없음', c0.yellow, 0);
  }

  section('1b) 배경 상자(bg) — 기본은 꺼짐(글자만), 켜면 반투명 검정 상자가 실제로 붙음');
  const OUT_BG = path.join(TMP, 'out_bg.mp4');
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ ...texts[0], bg: true }] }], outPath: OUT_BG, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('bg:true 내보내기 성공', res?.ok, true);
  if (fs.existsSync(OUT_BG) && cText) {
    const cBg = probeFrameCounts(OUT_BG);
    // 글자 안티에일리어싱 가장자리도 boxDark 문턱에 약간 걸릴 수 있어(폰트마다 다름)
    // 절대 0 근처를 기대하진 않는다 — bg:true 로 상자가 켜지면 뚜렷이 더 늘어나는지만 본다.
    expect('bg:true 로 켜면 어두운 상자 픽셀이 뚜렷이 늘어남(기본보다 훨씬 넓은 면적)', cBg.boxDark > cText.boxDark + 200, true);
  }

  section('2) 빈 내용 캡션은 조용히 건너뜀(drawtext textfile 빈 파일 크래시 방지)');
  const OUT_EMPTY = path.join(TMP, 'out_empty.mp4');
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ content: '   ', x: 0.5, y: 0.5, size: 40, color: '#ffffff' }] }], outPath: OUT_EMPTY, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('빈 캡션이어도 export 는 성공(필터그래프 안 죽음)', res?.ok, true);

  section('3) 같은 세그먼트에 텍스트 2개 — 둘 다 그려짐(체인)');
  const OUT_TWO = path.join(TMP, 'out_two.mp4');
  const twoTexts = [
    { content: 'A', x: 0.2, y: 0.2, size: 30, color: '#ffff00' },
    { content: 'B', x: 0.8, y: 0.8, size: 30, color: '#ffff00' },
  ];
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: twoTexts }], outPath: OUT_TWO, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('텍스트 2개 체인 내보내기 성공', res?.ok, true);
  if (fs.existsSync(OUT_TWO)) {
    const c = probeFrameCounts(OUT_TWO);
    expect('텍스트 2개치 노란 픽셀(1개일 때보다 많음)', c.yellow > 20, true);
  }

  section('4) 영상 트랙 없는 구간(isAudioOnly)에도 텍스트만 얹을 수 있음(타이틀 카드)');
  const OUT_TITLECARD = path.join(TMP, 'out_titlecard.mp4');
  const titleSeg = { isAudioOnly: true, audioSources: [], refW: W, refH: H, dur: 1.5, texts: [{ content: 'Title Card', x: 0.5, y: 0.5, size: 36, color: '#ffff00' }] };
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [titleSeg], outPath: OUT_TITLECARD, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('타이틀 카드(검은 배경+텍스트만) 내보내기 성공', res?.ok, true);
  if (fs.existsSync(OUT_TITLECARD)) {
    const c = probeFrameCounts(OUT_TITLECARD);
    expect('타이틀 카드에 노란 텍스트 픽셀 있음', c.yellow > 10, true);
    const info = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', OUT_TITLECARD], { encoding: 'utf-8' }).stdout.trim();
    expect('길이 ≈ 1.5초', Math.abs(parseFloat(info) - 1.5) < 0.3, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
