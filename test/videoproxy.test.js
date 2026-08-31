'use strict';
// 프록시(저해상도 미리보기 대체본) — 4K 등 고해상도 소스는 내장그래픽에서 실시간 디코드가
// 버겁다는 피드백으로 추가한 기능. 검증할 것:
//   1) 기본은 꺼짐 — 4K 클립도 미리보기가 원본 그대로 물린다.
//   2) 프록시 켜면 실제로 ffmpeg 가 돌아 userData/proxies 밑에 540p 사본이 생기고,
//      준비되면 미리보기 <video> 의 src 가 원본이 아니라 그 프록시로 바뀐다.
//   3) 다시 끄면 미리보기가 원본으로 돌아간다.
//   4) 실제 내보내기는 프록시와 무관하게 항상 원본 해상도 그대로 나온다(화질 손실 없음).
//   5) 해상도가 임계값(1080p) 이하인 클립은 애초에 프록시 대상이 아니다.
// UHD(4K) 클립 하나만으로 1~4 를 다 끝낸 뒤, 맨 마지막에 별개의 SD 클립으로 5 를 확인한다
// — 트랙이 여러 개 섞이면(맨 위 트랙이 화면을 덮는 관례) "내보낸 해상도"의 의미가
// 흐려지니, 해상도 검증은 UHD 클립 하나만 있는 단순한 상태에서 끝낸다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veproxy-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-veproxy-'));
const UHD = path.join(TMP, 'uhd.mp4');     // 3840x2160 — 프록시 대상(1080 초과)
const SD  = path.join(TMP, 'sd.mp4');      // 640x480 — 프록시 대상 아님(1080 이하)

spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=red:size=3840x2160:duration=1:rate=5',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', UHD], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=blue:size=640x480:duration=1:rate=5',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', SD], { stdio: 'ignore' });
if (!fs.existsSync(UHD) || !fs.existsSync(SD)) throw new Error('ffmpeg 로 테스트 픽스처 생성 실패');

function probeSize(file) {
  const out = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).stdout.toString().trim();
  const [w, h] = out.split('x').map(Number);
  return { w, h };
}
function fileNameEncoded(p) { return encodeURI(p.replace(/\\/g, '/')).split('/').pop(); }
function readManifest(app) {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'proxies', 'manifest.json'), 'utf-8')); }
  catch { return {}; }
}

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) 기본은 꺼짐 — 4K 클립 하나 임포트, 미리보기가 원본 그대로 물린다');
  expect('프록시 버튼 기본 꺼짐', await js(`document.getElementById('ve-proxy-toggle')?.classList.contains('on')`), false);
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [UHD] });
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await wait(300);
  const srcOff = await js(`document.querySelector('.ve-video-layers video:not([hidden])')?.getAttribute('src') || ''`);
  expect('꺼진 상태 — 미리보기가 원본 파일을 그대로 물음', srcOff.includes(fileNameEncoded(UHD)), true);

  section('2) 프록시 켜기 — 실제로 ffmpeg 가 돌아 540p 사본이 생기고, 준비되면 미리보기가 그걸로 바뀐다');
  await js(`document.getElementById('ve-proxy-toggle').click(); true`);
  await wait(100);
  expect('버튼이 켜짐 표시로 바뀜', await js(`document.getElementById('ve-proxy-toggle')?.classList.contains('on')`), true);

  let proxyPath = null;
  for (let i = 0; i < 60; i++) {
    const entry = Object.values(readManifest(app)).find(e => e.srcPath === UHD);
    if (entry && fs.existsSync(entry.outPath)) { proxyPath = entry.outPath; break; }
    await wait(500);
  }
  expect('프록시 파일이 실제로 생김', !!proxyPath, true);
  const proxySize = proxyPath ? probeSize(proxyPath) : null;
  expect('프록시 높이가 540p', proxySize?.h, 540);

  let srcOn = '';
  for (let i = 0; i < 30; i++) {
    srcOn = await js(`document.querySelector('.ve-video-layers video:not([hidden])')?.getAttribute('src') || ''`);
    if (proxyPath && srcOn.includes(fileNameEncoded(proxyPath))) break;
    await wait(300);
  }
  expect('켠 상태 — 미리보기가 프록시 파일로 바뀜', proxyPath ? srcOn.includes(fileNameEncoded(proxyPath)) : false, true);

  section('3) 다시 끄면 미리보기가 원본으로 돌아간다');
  await js(`document.getElementById('ve-proxy-toggle').click(); true`);
  await wait(200);
  expect('버튼 꺼짐', await js(`document.getElementById('ve-proxy-toggle')?.classList.contains('on')`), false);
  const srcAfterOff = await js(`document.querySelector('.ve-video-layers video:not([hidden])')?.getAttribute('src') || ''`);
  expect('꺼면 미리보기가 다시 원본으로 돌아옴', srcAfterOff.includes(fileNameEncoded(UHD)), true);

  section('4) 실제 내보내기는 프록시와 무관하게 항상 원본 해상도(3840x2160)로 나온다');
  await js(`document.getElementById('ve-proxy-toggle').click(); true`);   // 다시 켠 상태에서 내보내기
  await wait(200);
  const OUT = path.join(TMP, 'out.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('내보내기 성공', fs.existsSync(OUT), true);
  const outSize = probeSize(OUT);
  expect('내보낸 해상도가 원본(4K) 그대로 — 프록시(540p) 화질로 안 나옴', outSize.h, 2160);

  section('5) 해상도가 낮은(1080 이하) 클립은 애초에 프록시 대상이 아니다');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SD] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  await wait(500);
  const sdProxied = Object.values(readManifest(app)).some(e => e.srcPath === SD);
  expect('SD 클립은 프록시 매니페스트에 없음', sdProxied, false);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
