'use strict';
// 텍스트 폰트 선택 — main.js 가 서로 다른 fontKey 를 가진 텍스트 여러 개를 한 export 안에서
// 충돌 없이(같은 파일명으로 두 번 복사 시도하는 캐시 로직 포함) 처리하는지, 그리고 알 수
// 없는/잘못된 fontKey 가 와도 맑은 고딕으로 조용히 대체되어 export 가 죽지 않는지 확인한다.
// (실제 글꼴 모양이 픽셀로 다르게 나오는지까지는 이미지 비교 없이 검증하기 어려우니, 여긴
// "여러 폰트를 섞어도 필터그래프가 안 깨진다"는 계약만 본다.)

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetextfont-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetextfont-'));
const SRC = path.join(TMP, 'blue.mp4');
const W = 320, H = 240;

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=blue:size=${W}x${H}:duration=2:rate=10`,
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  const baseSeg = { file: SRC, start: 0, end: 2, refW: W, refH: H, dur: 2, audioSources: [{ file: SRC, start: 0, end: 2 }] };

  section('1) 서로 다른 fontKey 텍스트 3개(맑은고딕/Impact/Georgia) 한 export 안에 섞기');
  const OUT_MIX = path.join(TMP, 'out_mix.mp4');
  const texts = [
    { content: '기본', x: 0.2, y: 0.2, size: 30, color: '#ffff00', fontKey: 'malgun' },
    { content: 'IMPACT', x: 0.5, y: 0.5, size: 30, color: '#ffff00', fontKey: 'impact' },
    { content: 'Georgia', x: 0.8, y: 0.8, size: 30, color: '#ffff00', fontKey: 'georgia' },
  ];
  let res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts }], outPath: OUT_MIX, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('폰트 3종 섞어도 export 성공(같은 파일명 중복 복사 충돌 없음)', res?.ok, true);
  if (!res?.ok) console.log('  export error:', res?.error);

  section('2) 알 수 없는 fontKey 는 조용히 맑은 고딕으로 대체 — export 가 안 죽음');
  const OUT_UNKNOWN = path.join(TMP, 'out_unknown.mp4');
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ content: '이상한 폰트키', x: 0.5, y: 0.5, size: 30, color: '#ffff00', fontKey: 'no-such-font-xyz' }] }], outPath: OUT_UNKNOWN, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('알 수 없는 fontKey 도 export 성공(맑은 고딕 대체)', res?.ok, true);

  section('3) fontKey 자체가 없는(undefined) 텍스트도 기본값으로 처리');
  const OUT_NOKEY = path.join(TMP, 'out_nokey.mp4');
  res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments: [{ ...baseSeg, texts: [{ content: '키 없음', x: 0.5, y: 0.5, size: 30, color: '#ffff00' }] }], outPath: OUT_NOKEY, format: 'mp4' })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('fontKey 없어도 export 성공', res?.ok, true);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
