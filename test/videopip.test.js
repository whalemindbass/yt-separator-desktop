'use strict';
// video:export v2 — PIP(트랙 겹침 overlay) + 여러 오디오 트랙 동시 믹스(amix) 검증.
// buildEDL() 이 만드는 새 구간 모양(layers/audioSources 배열)을 렌더러 드래그 시뮬레이션 없이
// 직접 구성해서 api.video.export 로 보낸다 — main.js filter_complex 계약만 딱 떼어서 검증.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vepip-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vepip-'));
const RED = path.join(TMP, 'red.mp4');
const BLUE = path.join(TMP, 'blue.mp4');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240;

function makeClip(file, color, freq, seconds) {
  const r = spawnSync(FFMPEG, ['-y',
    '-f', 'lavfi', '-i', `color=${color}:size=${W}x${H}:duration=${seconds}:rate=15`,
    '-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}`,
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(file)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패: ' + file);
}
makeClip(RED, 'red', 440, 3);
makeClip(BLUE, 'blue', 880, 3);

const { bootMain, expect, near, section, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) PIP + 2트랙 오디오 믹스 세그먼트로 내보내기');
  // layers: 위(화면 앞)→아래 순서. blue 를 우측하단 30% 로, red 를 풀프레임 배경으로.
  // audioSources 2개 → main.js 가 amix 로 동시에 섞어야 한다.
  const segments = [
    {
      layers: [
        { file: BLUE, start: 0, end: 3, transform: { x: 0.65, y: 0.65, scale: 0.3 } },
        { file: RED, start: 0, end: 3, transform: null },
      ],
      audioSources: [{ file: RED, start: 0, end: 3 }, { file: BLUE, start: 0, end: 3 }],
      refW: W, refH: H, dur: 3,
    },
    {
      // 영상 없는 구간(검은 화면)에서도 2트랙 오디오 믹스가 되는지 같이 확인.
      isAudioOnly: true,
      audioSources: [{ file: RED, start: 0, end: 2 }, { file: BLUE, start: 0, end: 2 }],
      refW: W, refH: H, dur: 2,
    },
  ];
  const res = await js(`(async () => {
    try { return await yssApi.video.export(${JSON.stringify({ segments, outPath: OUT })}); }
    catch (e) { return { ok: false, error: String(e && (e.stack || e.message || e)) }; }
  })()`);
  expect('내보내기 성공', res?.ok, true);
  if (!res?.ok) console.log('  export error:', res?.error);
  expect('출력 파일 생김', fs.existsSync(OUT), true);

  if (fs.existsSync(OUT)) {
    section('2) 결과물 검증(ffprobe) — 길이/스트림');
    const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-show_entries', 'stream=codec_type',
      '-of', 'default=noprint_wrappers=1', OUT], { encoding: 'utf-8' });
    const out = r.stdout || '';
    near('총 길이 ≈ 5초(3+2)', parseFloat((/duration=([\d.]+)/.exec(out) || [])[1] || 0), 5, 0.3);
    expect('비디오 스트림 있음', out.includes('codec_type=video'), true);
    expect('오디오 스트림 있음', out.includes('codec_type=audio'), true);

    section('3) PIP 합성 검증 — 실제 픽셀 색상(raw rgb24 프레임 추출)');
    const RAW = path.join(TMP, 'frame.raw');
    spawnSync(FFMPEG, ['-y', '-ss', '1.5', '-i', OUT, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, RAW], { stdio: 'ignore' });
    if (fs.existsSync(RAW)) {
      const buf = fs.readFileSync(RAW);
      const px = (x, y) => { const o = (y * W + x) * 3; return { r: buf[o], g: buf[o + 1], b: buf[o + 2] }; };
      const center = px(160, 120);     // PIP 박스(x208-304,y156-228) 밖 — 배경 red 여야 함
      const corner = px(250, 190);     // PIP 박스 안 — blue 여야 함
      expect('중앙(배경)은 빨강 우세', center.r > center.g + 40 && center.r > center.b + 40, true);
      expect('우측하단(PIP)은 파랑 우세', corner.b > corner.r + 40 && corner.b > corner.g + 40, true);
    } else {
      expect('raw 프레임 추출 실패(환경 문제로 스킵되면 안 됨)', false, true);
    }

    section('4) 오디오 믹스 검증 — 무음 아님(volumedetect)');
    const vd = spawnSync(FFMPEG, ['-i', OUT, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf-8' });
    const stderr = vd.stderr || '';
    const mean = parseFloat((/mean_volume:\s*(-?[\d.]+)/.exec(stderr) || [])[1] ?? '-999');
    expect('평균 음량이 무음(-90dB 이하)이 아님', mean > -80, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
