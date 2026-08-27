'use strict';
// ytsep:// 프로토콜의 Range 처리 — main.js:319 근처. "bytes=시작-끝" 만 받고
// "bytes=-N"(끝에서부터 N바이트, moov 가 파일 끝에 있는 mp4 를 크롬이 seek 가능하게
// 만들 때 꼭 이 형식으로 먼저 옴)를 못 받으면, 그 요청이 "전체 요청"으로 새어
// 큰 파일 전체를 잘못 돌려준다 — 크롬이 그 응답을 못 알아듣고 포기해서 seekable 이
// 통째로 비어버리고(seekable=[[0,0]]), currentTime 을 옮겨도 실제로는 안 움직인다.
//
// 짧은 테스트 파일(몇 초)로는 재현이 안 된다(moov 도 작아서 초기 요청 범위 안에 다
// 들어옴) — 영상 편집 탭에 실제 몇 분짜리 영상을 넣었을 때만 나타나서, 합성 영상으로
// 재현하려고 충분히 긴(30초) 파일을 직접 만든다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-verange-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-verange-'));
const LONG = path.join(TMP, 'long.mp4');
{
  // -movflags +faststart 를 일부러 안 준다 — moov 가 파일 끝에 남아야(ffmpeg 기본값)
  // 이 버그가 재현된다. 실사용 영상(유튜브 다운로드 등)도 이 배치가 흔하다.
  const r = spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=320x240:rate=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', LONG], { stdio: 'ignore' });
  if (r.status !== 0 || !fs.existsSync(LONG)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');
}

const { bootMain, expect, section, finish } = require('./harness');

(async () => {
  const { app: eApp, js } = await bootMain({ settle: 2000 });
  const url = 'ytsep://f/' + encodeURI(LONG.replace(/\\/g, '/'));

  section('1) 메타데이터 + seekable 범위');
  const info = await js(`(async () => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
    v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;';
    document.body.appendChild(v);
    await new Promise((resolve) => { v.onloadedmetadata = resolve; v.src = ${JSON.stringify(url)}; });
    window.__probeVideo = v;   // 다음 섹션에서 재사용
    const ranges = [];
    for (let i = 0; i < v.seekable.length; i++) ranges.push([v.seekable.start(i), v.seekable.end(i)]);
    return { duration: Math.round(v.duration), seekableRanges: ranges };
  })()`);
  expect('duration ≈ 30초', info.duration, 30);
  expect('seekable 이 전체 구간을 덮음', info.seekableRanges.length > 0 && info.seekableRanges[0][1] >= 29, true);

  section('2) 파일 끝 쪽으로 seek 하면 실제로 그 위치로 이동함');
  const seekRes = await js(`(async () => {
    const v = window.__probeVideo;
    await new Promise((resolve) => { v.onseeked = resolve; v.currentTime = 25; });
    return { got: v.currentTime };
  })()`);
  expect('t=25 로 seek 하면 실제 currentTime 도 25(±0.5)', Math.abs(seekRes.got - 25) < 0.5, true);

  finish(eApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
