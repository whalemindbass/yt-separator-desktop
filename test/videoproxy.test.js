'use strict';
// 미리보기 해상도(프록시, 저해상도 대체본) — 4K 등 고해상도 소스는 내장그래픽에서 실시간
// 디코드가 버겁다는 피드백으로 추가한 기능. "미리보기 해상도를 선택해서 조절할 수 있게해,
// 원본 보기도 포함하고" 요청으로 켜짐/꺼짐 버튼 하나였던 걸 셀렉트(#ve-preview-res:
// 원본/360p/540p/720p)로 바꿨다. 검증할 것:
//   1) 기본은 "원본 보기" — 4K 클립도 미리보기가 원본 그대로 물린다.
//   2) 540p 를 고르면 실제로 ffmpeg 가 돌아 userData/proxies 밑에 540p 사본이 생기고,
//      준비되면 미리보기 <video> 의 src 가 원본이 아니라 그 프록시로 바뀐다.
//   3) 720p 로 바꾸면 캐시가 비워지고 720p 사본을 새로 만들어 그걸로 바뀐다(해상도별로
//      따로 캐시된다는 뜻).
//   4) "원본 보기"로 되돌리면 미리보기가 원본으로 돌아간다.
//   5) 실제 내보내기는 미리보기 해상도와 무관하게 항상 원본 해상도 그대로 나온다.
//   6) 고른 해상도보다 이미 작은(SD) 클립은 애초에 프록시 대상이 아니다.
// UHD(4K) 클립 하나만으로 1~5 를 다 끝낸 뒤, 맨 마지막에 별개의 SD 클립으로 6 을 확인한다
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
const UHD = path.join(TMP, 'uhd.mp4');     // 3840x2160 — 어떤 미리보기 해상도를 골라도 대상
const SD  = path.join(TMP, 'sd.mp4');      // 640x480 — 540p 를 골라도 그보다 작으니 대상 아님

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
function setPreviewRes(js, value) {
  return js(`(() => {
    const sel = document.getElementById('ve-preview-res');
    sel.value = ${JSON.stringify(String(value))};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
}

const { bootMain, expect, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);

  section('1) 기본은 "원본 보기" — 4K 클립 하나 임포트, 미리보기가 원본 그대로 물린다');
  expect('기본값은 원본 보기(0)', await js(`document.getElementById('ve-preview-res')?.value`), '0');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [UHD] });
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  await wait(300);
  const srcOff = await js(`document.querySelector('.ve-video-layers video:not([hidden])')?.getAttribute('src') || ''`);
  expect('원본 보기 — 미리보기가 원본 파일을 그대로 물음', srcOff.includes(fileNameEncoded(UHD)), true);

  section('2) 540p 선택 — 실제로 ffmpeg 가 돌아 540p 사본이 생기고, 준비되면 미리보기가 그걸로 바뀐다');
  await setPreviewRes(js, 540);
  await wait(100);

  let proxyPath540 = null;
  for (let i = 0; i < 60; i++) {
    const entry = Object.values(readManifest(app)).find(e => e.srcPath === UHD);
    if (entry && fs.existsSync(entry.outPath)) { proxyPath540 = entry.outPath; break; }
    await wait(500);
  }
  expect('프록시 파일이 실제로 생김', !!proxyPath540, true);
  const proxySize540 = proxyPath540 ? probeSize(proxyPath540) : null;
  expect('프록시 높이가 540p', proxySize540?.h, 540);

  let srcOn540 = '';
  for (let i = 0; i < 30; i++) {
    srcOn540 = await js(`document.querySelector('.ve-video-layers video:not([hidden])')?.getAttribute('src') || ''`);
    if (proxyPath540 && srcOn540.includes(fileNameEncoded(proxyPath540))) break;
    await wait(300);
  }
  expect('540p 선택 — 미리보기가 그 프록시 파일로 바뀜', proxyPath540 ? srcOn540.includes(fileNameEncoded(proxyPath540)) : false, true);

  section('3) 720p 로 바꾸면 해상도별로 따로 캐시되어 720p 사본을 새로 만든다');
  await setPreviewRes(js, 720);
  await wait(100);
  let proxyPath720 = null;
  for (let i = 0; i < 60; i++) {
    const entry = Object.values(readManifest(app)).find(e => e.srcPath === UHD && e.outPath !== proxyPath540);
    if (entry && fs.existsSync(entry.outPath)) { proxyPath720 = entry.outPath; break; }
    await wait(500);
  }
  expect('720p 용 프록시가 540p 와 별개로 새로 생김', !!proxyPath720 && proxyPath720 !== proxyPath540, true);
  const proxySize720 = proxyPath720 ? probeSize(proxyPath720) : null;
  expect('그 프록시 높이가 720p', proxySize720?.h, 720);
  let srcOn720 = '';
  for (let i = 0; i < 30; i++) {
    srcOn720 = await js(`document.querySelector('.ve-video-layers video:not([hidden])')?.getAttribute('src') || ''`);
    if (proxyPath720 && srcOn720.includes(fileNameEncoded(proxyPath720))) break;
    await wait(300);
  }
  expect('720p 선택 — 미리보기가 720p 프록시로 바뀜', proxyPath720 ? srcOn720.includes(fileNameEncoded(proxyPath720)) : false, true);

  section('4) "원본 보기"로 되돌리면 미리보기가 원본으로 돌아간다');
  await setPreviewRes(js, 0);
  await wait(200);
  expect('선택값이 원본(0)으로 돌아감', await js(`document.getElementById('ve-preview-res')?.value`), '0');
  const srcAfterOff = await js(`document.querySelector('.ve-video-layers video:not([hidden])')?.getAttribute('src') || ''`);
  expect('원본 보기로 돌아오면 미리보기도 원본으로 돌아옴', srcAfterOff.includes(fileNameEncoded(UHD)), true);

  section('5) 실제 내보내기는 미리보기 해상도와 무관하게 항상 원본 해상도(3840x2160)로 나온다');
  await setPreviewRes(js, 540);   // 다시 540p 로 켠 상태에서 내보내기
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

  section('6) 고른 해상도(540p)보다 이미 작은 클립은 애초에 프록시 대상이 아니다');
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SD] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  await wait(500);
  const sdProxied = Object.values(readManifest(app)).some(e => e.srcPath === SD);
  expect('SD 클립은 프록시 매니페스트에 없음', sdProxied, false);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
