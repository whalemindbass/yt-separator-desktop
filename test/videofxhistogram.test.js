'use strict';
// 효과 패널 미니 히스토그램 — 선택 상태(클립 없음/오디오전용/영상)에 따라 표시 여부가
// 맞는지, 그리고 실제로 미리보기 <video> 프레임을 캔버스에 그려서 명암 막대가 나오는지
// (placeholder 눈금이 아니라 진짜 데이터인지) 픽셀로 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { spawnSync } = require('child_process');
const { app, dialog } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vehist-profile-')));

const ROOT = path.resolve(__dirname, '..');
const FFMPEG = path.join(ROOT, 'vendor', 'ffmpeg', 'ffmpeg.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vehist-'));
const SRC = path.join(TMP, 'testsrc.mp4');
const W = 320, H = 240;

// 단색이 아니라 컬러바(testsrc) 소스 — 히스토그램이 여러 bin 에 걸쳐 퍼지는지도 자연스럽게 확인됨.
spawnSync(FFMPEG, ['-y',
  '-f', 'lavfi', '-i', `testsrc=size=${W}x${H}:duration=3:rate=10`,
  '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3',
  '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', SRC], { stdio: 'ignore' });
if (!fs.existsSync(SRC)) throw new Error('ffmpeg 로 테스트 mp4 생성 실패');

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SRC] });

const { bootMain, expect, section, wait, finish } = require('./harness');

function selectClip(selector, pid) {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: ${pid} }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: ${pid} }));
    return true;
  })()`;
}

// 히스토그램 막대는 accentColor() 그대로(#35d1a6 또는 라이트 테마 #0d7d5c) 를 fillStyle 로
// 쓰고 투명 캔버스 위에 그린다(getImageData 는 CSS background 를 안 읽으므로 순수 도형색만
// 나온다) — placeholder 눈금(회색 rgba(127,127,127,.18))이 아닌 픽셀이 하나라도 있으면
// 실제 프레임에서 뽑은 진짜 막대다.
const HAS_BAR_JS = `(() => {
  const c = document.getElementById('ve-fx-hist');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]; if (!a) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const isGrayDash = r > 118 && r < 136 && g > 118 && g < 136 && b > 118 && b < 136;
    if (!isGrayDash) return true;
  }
  return false;
})()`;

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 선택 전 — 히스토그램 영역 숨김');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  expect('선택 전 hist-wrap 숨김', await js(`document.getElementById('ve-fx-hist-wrap').hidden`), true);

  section('2) 임포트 + 영상 클립 선택(재생 위치=클립 시작=0초) — 히스토그램 보임 + 실제 막대');
  await js(`document.getElementById('ve-add-track').click(); true`);
  await js(`document.getElementById('ve-import').click(); true`);
  for (let i = 0; i < 40; i++) { if (await js(`document.querySelectorAll('.ve-clip').length`) >= 2) break; await wait(300); }
  expect('영상 클립 선택됨', await js(selectClip('.ve-clip:not(.audio)', 1)), true);
  await wait(700);   // 히스토그램 250ms 타이머 최소 2틱 + 비디오 첫 프레임 디코드 대기
  expect('클립 선택 후 hist-wrap 보임', await js(`document.getElementById('ve-fx-hist-wrap').hidden`), false);
  expect('실제 프레임에서 뽑은 막대가 있음(placeholder 아님)', await js(HAS_BAR_JS), true);

  section('3) 오디오 전용 클립 선택 — 히스토그램 다시 숨김');
  expect('오디오 클립 선택됨', await js(selectClip('.ve-clip.audio', 2)), true);
  await wait(150);
  expect('오디오 클립이면 hist-wrap 숨김', await js(`document.getElementById('ve-fx-hist-wrap').hidden`), true);

  section('4) 재생 위치가 클립 밖으로 나가면 — 패널은 보이되(클립은 여전히 선택) placeholder 로 돌아감');
  expect('영상 클립 다시 선택', await js(selectClip('.ve-clip:not(.audio)', 3)), true);
  await wait(300);
  expect('막대 다시 나타남', await js(HAS_BAR_JS), true);
  // 클립 길이(3초) 밖인 10초로 재생선 이동 — 눈금자 클릭으로 실제 UI 경로를 그대로 탄다.
  await js(`(() => {
    const ruler = document.getElementById('ve-ruler');
    const rect = ruler.getBoundingClientRect();
    ruler.dispatchEvent(new PointerEvent('pointerdown', { clientX: rect.left + 400, clientY: rect.top + 10, bubbles: true }));
  })(); true`);
  await wait(700);
  expect('클립은 여전히 선택된 채라 hist-wrap 은 계속 보임', await js(`document.getElementById('ve-fx-hist-wrap').hidden`), false);
  expect('재생 위치가 클립을 벗어나면 placeholder 로 돌아감(막대 없음)', await js(HAS_BAR_JS), false);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
