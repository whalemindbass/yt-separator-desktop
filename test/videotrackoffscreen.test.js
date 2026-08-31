'use strict';
// 오토 트래킹 — 대상이 화면 밖으로 나가면 억지로 비슷한 걸 붙잡지 않고 오버레이 자체가
// 사라져야 하고, 다시 화면 안으로 들어오면 다시 따라가야 한다("화면 밖으로 나가면 비슷한
// 것으로 옮겨가는데 사라지는 게 맞고, 다시 들어오면 다시 따라가야" 요청). video-tracker.js
// 의 lost/reacquire 알고리즘은 videotracker.test.js 에서 이미 단위 검증했으니, 여긴 그
// 결과가 실제 내보내기 결과물(픽셀)에 정확히 반영되는지 — 화면 밖에 있는 구간엔 오버레이가
// 어디에도 안 보이고, 화면 안으로 돌아온 뒤엔 그 새 자리에 다시 보이는지 — 실측한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrackoff-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetrackoff-'));
const BG = path.join(TMP, 'bg.mp4');
const OVERLAY_IMG = path.join(TMP, 'overlay.png');
const OUT = path.join(TMP, 'out.mp4');
const W = 320, H = 240, BOX = 40;

// t=0~1: 왼쪽(20,20)에서 오른쪽으로 이동해 t=1 근처 화면 밖(x=330, 캔버스 폭 320)으로 완전히
// 나간다. t=1~2.2: 화면 밖(x=450)에 머문다. t=2.2 이후: 왼쪽 아래(100,150)에 다시 나타나
// 그대로 — 이미지 오버레이 클립 기본 길이(5초)와 맞춰서 배경도 5초로 잡는다(안 그러면
// 배경이 먼저 끝나 트래커가 마지막 프레임만 붙들고 남은 시간을 낭비하며 분석한다).
// 30fps(예전엔 10fps) — 내보내기가 추적 구간을 EXPORT_INTERP_HZ(30) 만큼 촘촘히 쪼개는데,
// 그 조각 하나가 소스 프레임 주기보다 짧으면 ffmpeg trim 이 0프레임을 내놓아 결과물이
// 어긋난다(실측 확인된 버그, videotracking.test.js 쪽 주석 참고) — 30fps 면 그 문턱과
// 정확히 맞아떨어져 여유가 없으니(30Hz 요청에 30fps 소스) 여유를 두려면 이 이상이어야
// 하지만, 이 값이면 재현되지 않는다(실측 확인).
const RED_BOX = path.join(TMP, 'red_box.png');
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=red:size=${BOX}x${BOX}`, '-frames:v', '1', RED_BOX], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=black:size=${W}x${H}:duration=5:rate=30`, '-i', RED_BOX,
  '-filter_complex', `[0][1]overlay=x='if(lt(t,1),20+t*310,if(lt(t,2.2),450,100))':y='if(lt(t,2.2),20,150)'`,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', BG], { stdio: 'ignore' });
spawnSync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'color=yellow:size=30x30', '-frames:v', '1', OVERLAY_IMG], { stdio: 'ignore' });
if (!fs.existsSync(BG) || !fs.existsSync(OVERLAY_IMG)) throw new Error('ffmpeg 로 테스트 파일 생성 실패');

const { bootMain, expect, section, wait, finish } = require('./harness');

// 프레임 전체를 스캔해서 노란(오버레이) 픽셀이 몇 개나 있는지 센다 — "화면 어딘가에
// 보이는지/전혀 안 보이는지"를 한 좌표만 찍어서는 확신할 수 없어서(엉뚱한 곳으로 옮겨
// 붙었을 수도 있다) 프레임 전체를 본다.
function countYellowPixels(file, t) {
  const raw = file + `.${t}.raw`;
  spawnSync(FFMPEG, ['-y', '-ss', String(t), '-i', file, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, raw], { stdio: 'ignore' });
  const buf = fs.readFileSync(raw);
  let n = 0;
  for (let i = 0; i + 2 < buf.length; i += 3) {
    if (buf[i] > 150 && buf[i + 1] > 150 && buf[i + 2] < 120) n++;
  }
  return n;
}

(async () => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [BG] });
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 배경(화면 밖으로 나갔다 돌아오는 빨간 사각형) 임포트 + 이미지 오버레이 추가');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="video"]').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 1) break; await wait(300); }

  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [OVERLAY_IMG] });
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="image"]').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip.image').length`) >= 1) break; await wait(300); }

  section('2) "+" 메뉴에서 오토 트래킹 선택 → 시작 위치(20,20 근처)에 영역 지정');
  // fx-add 버튼은 클립이 선택돼 있어야 활성화된다 — 방금 만든 이미지 클립을 먼저 선택.
  await js(`(() => {
    const el = document.querySelector('.ve-clip.image');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 }));
  })(); true`);
  await wait(150);
  await js(`document.getElementById('ve-fx-add-btn').click(); true`);
  await wait(80);
  await js(`(() => { [...document.querySelectorAll('#ve-fx-add-menu .ve-fx-add-item')][0].click(); })(); true`);
  await wait(150);
  await js(`(() => {
    const host = document.getElementById('ve-preview');
    const r = host.getBoundingClientRect();
    const sx = r.left + r.width * (20 / ${W});
    const sy = r.top + r.height * (20 / ${H});
    const ex = r.left + r.width * (65 / ${W});
    const ey = r.top + r.height * (65 / ${H});
    host.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, bubbles: true, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointermove', { clientX: ex, clientY: ey, pointerId: 5 }));
    document.dispatchEvent(new PointerEvent('pointerup', { clientX: ex, clientY: ey, pointerId: 5 }));
  })(); true`);

  section('3) 자동 분석 완료 대기(화면 밖으로 나갔다 돌아오는 구간이라 재탐색까지 겹쳐 오래 걸릴 수 있다)');
  for (let i = 0; i < 300; i++) {
    if (/추적 중/.test(await js(`document.querySelector('.ve-track-status')?.textContent || ''`))) break;
    await wait(400);
  }
  const finalStatus = await js(`document.querySelector('.ve-track-status')?.textContent || ''`);
  expect('분석 끝나면 "추적 중 (N개 지점)" 으로 바뀜', /추적 중/.test(finalStatus), true);

  section('4) 내보내기 — 화면 밖 구간엔 오버레이가 아예 안 보이고, 돌아온 뒤엔 새 자리에 다시 보임');
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: OUT });
  await js(`document.getElementById('ve-export').click(); document.getElementById('ve-exp-go').click(); true`);
  for (let i = 0; i < 90; i++) {
    if (fs.existsSync(OUT)) { const lbl = await js(`document.getElementById('ve-export').textContent`); if (!/%$/.test(lbl)) break; }
    await wait(500);
  }
  expect('출력 파일 생김', fs.existsSync(OUT), true);
  if (fs.existsSync(OUT)) {
    const before = countYellowPixels(OUT, 0.3);   // 아직 화면 안(왼쪽 위 근처)
    const during = countYellowPixels(OUT, 1.6);   // 화면 밖에 있어야 할 구간(가장 안전한 중간 지점)
    const after = countYellowPixels(OUT, 2.8);    // 다시 나타난 뒤(왼쪽 아래 근처, 정적)
    console.log(`  노란 픽셀 수 — before(0.3s): ${before}, during(1.6s, 화면 밖): ${during}, after(2.8s, 재진입): ${after}`);
    expect('화면 안에 있을 때는 오버레이가 보임(노란 픽셀 있음)', before > 20, true);
    expect('화면 밖으로 나간 구간엔 오버레이가 어디에도 안 보임(억지로 옮겨붙지 않음)', during < 5, true);
    expect('다시 화면 안으로 들어온 뒤엔 오버레이가 다시 보임', after > 20, true);
  }

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
