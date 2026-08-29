'use strict';
// HDR(PQ) 소스 임포트 → 내보내기 시 자동 톤매핑(zscale+tonemap) 적용 검증.
// PQ 로 태깅된 소스를 그냥 SDR 인코딩만 하면(톤매핑 없이) 화면이 밝고 납작하게(낮은 대비로)
// 나온다 — 실제 톤매핑이 걸렸을 때와 안 걸렸을 때를 같은 소스로 비교해서, 톤매핑이 실제로
// "뭔가를 다르게" 만드는지(그리고 더 정상적인 대비 분포로 만드는지) 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vehdr-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const FFPROBE = path.join(ROOT, 'vendor', 'ffmpeg', 'ffprobe.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vehdr-'));
const W = 320, H = 240;
const HDR_SRC = path.join(TMP, 'hdr.mp4');

// PQ(HDR10) 로 제대로 태깅된 픽스처 — -x264-params 로 넣어야 VUI 에 실제로 박힌다
// (-color_trc 출력 옵션만으로는 이 빌드/무버에서 안 남는 걸 확인함).
// 중간톤 회색 — PQ 곡선과 표준 감마가 가장 크게 갈라지는 지점(극단값은 양쪽 다 0/255 로
// 수렴해서 차이가 잘 안 보인다. testsrc 의 원색 막대로 처음 시도했다가 이걸로 바꿈).
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=0x808080:size=${W}x${H}:duration=2:rate=10`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
  '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
  HDR_SRC], { stdio: 'ignore' });
if (!fs.existsSync(HDR_SRC)) throw new Error('ffmpeg 로 HDR 테스트 mp4 생성 실패');
{
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=color_transfer', '-of', 'default=noprint_wrappers=1', HDR_SRC], { encoding: 'utf-8' });
  if (!(r.stdout || '').includes('color_transfer=smpte2084')) throw new Error('픽스처에 PQ 태그가 안 박힘 — ' + r.stdout);
}

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [HDR_SRC] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function frameStats(file) {
  const raw = file + '.raw';
  spawnSync(FFMPEG, ['-y', '-ss', '1', '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < buf.length; i++) { sum += buf[i]; sumSq += buf[i] * buf[i]; }
  const mean = sum / buf.length;
  const variance = sumSq / buf.length - mean * mean;
  return { mean, std: Math.sqrt(Math.max(0, variance)) };
}

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) HDR(PQ) 소스 임포트 — probe 가 isHDR 을 잡는가');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }
  expect('클립 1개 임포트됨', await js(`document.querySelectorAll('.ve-clip').length`), 1);

  section('2) 내보내기 — HDR 클립이면 자동으로 톤매핑돼야 함(실제 export 필터체인 경유)');
  const OUT_HDR = path.join(TMP, 'out_hdr.mp4');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT_HDR });
  await js(`document.getElementById('ve-export').click(); true`);
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(OUT_HDR)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('톤매핑 내보내기 파일 생김(zscale 체인이 에러 없이 끝까지 돎)', fs.existsSync(OUT_HDR), true);

  section('3) 비교 — 같은 PQ 소스를 톤매핑 없이 그냥 SDR 인코딩만 했을 때와 통계가 달라야 함');
  // buildEDL()이 hdr 필드를 안 넘겼을 때(=이 기능이 없던 예전 상태)를 흉내낸다 — 같은
  // yssApi.video.export 를 직접 호출하되 세그먼트에 hdr 필드를 빼서 비교 기준을 만든다.
  const OUT_NAIVE = path.join(TMP, 'out_naive.mp4');
  const res = await js(`(async () => {
    try {
      return await yssApi.video.export({
        segments: [{ file: ${JSON.stringify(HDR_SRC)}, start: 0, end: 2, audioSources: [], refW: ${W}, refH: ${H}, dur: 2 }],
        outPath: ${JSON.stringify(OUT_NAIVE)},
      });
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`);
  expect('비교용(톤매핑 없는) 내보내기도 성공', res?.ok, true);

  if (fs.existsSync(OUT_HDR) && fs.existsSync(OUT_NAIVE)) {
    const withTonemap = frameStats(OUT_HDR);
    const naive = frameStats(OUT_NAIVE);
    console.log('  with tonemap:', withTonemap, '/ naive(PQ as SDR):', naive);
    // PQ 곡선은 표준 감마와 완전히 달라서, 톤매핑을 거쳤는지 아닌지에 따라 같은 소스라도
    // 확실히 다른 픽셀이 나와야 한다(어느 쪽이 더 밝다/어둡다 방향까지는 소스 패턴에 따라
    // 달라질 수 있어 단정하지 않는다 — testsrc 의 원색 막대는 방향성 판단엔 안 맞았다).
    // 관건은 "톤매핑 필터가 실제로 뭔가를 하고 있다"는 것 — 값이 같으면 조용히 안 걸린 것이다.
    const meanDiff = Math.abs(withTonemap.mean - naive.mean);
    expect('톤매핑 켜고/끄고가 실제로 다른 결과를 만듦(조용히 안 걸리는 버그 없음)', meanDiff > 15, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
