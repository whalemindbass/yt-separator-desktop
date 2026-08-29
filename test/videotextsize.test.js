'use strict';
// 미리보기에서 보이는 글자 크기와 실제 내보내기 글자 크기가 어긋나던 문제 — clip.size 는
// "출력 해상도 기준 px" 인데, #ve-preview 는 그 해상도를 화면에 맞게 축소해서 보여주는
// 창이라(대부분 1280x720 이상을 수백 px 로 줄여서 보여줌), CSS font-size 에 raw px 를
// 그대로 넣으면 미리보기 글자가 실제 결과물보다 훨씬 크게 보였다. previewScale() 배율로
// 나눠 넣게 고쳤다 — 실제로 축소 비율만큼 줄어드는지 확인한다.

const path = require('path'); const fs = require('fs'); const os = require('os');
const { app } = require('electron');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'yss-vetsize-profile-')));

const { bootMain, expect, near, section, wait, finish } = require('./harness');

(async () => {
  const { app, js } = await bootMain({ settle: 1500 });

  section('1) 프리뷰 글자 크기 = clip.size × (미리보기 화면폭 / 출력 해상도 폭)');
  await js(`document.querySelector('.tab[data-view="video"]').click(); true`);
  await wait(300);
  await js(`document.getElementById('ve-add-track-btn').click(); document.querySelector('#ve-add-track-menu [data-kind="text"]').click(); true`);
  await wait(150);

  const info = await js(`(() => {
    const host = document.getElementById('ve-preview');
    const el = document.querySelector('.ve-text-item.sel');
    return JSON.stringify({
      previewW: host.clientWidth,
      cssFontSize: parseFloat(getComputedStyle(el).fontSize),
    });
  })()`);
  const { previewW, cssFontSize } = JSON.parse(info);
  // 클립 생성 직후 기본값: size=42, 자동 해상도(첫 영상 클립 없으니 기본 1280x720).
  const expected = 42 * (previewW / 1280);
  near(`기본 크기(42)가 미리보기 배율만큼 줄어들어 렌더됨(preview폭=${previewW})`, cssFontSize, expected, 0.5);

  section('2) 리사이즈 핸들로 크기를 키워도 같은 배율이 유지됨');
  await js(`(() => {
    document.getElementById('tx-size').value = 200;
    document.getElementById('tx-size').dispatchEvent(new Event('input', { bubbles: true }));
  })(); true`);
  await wait(100);
  const cssFontSize2 = await js(`parseFloat(getComputedStyle(document.querySelector('.ve-text-item.sel')).fontSize)`);
  const expected2 = 200 * (previewW / 1280);
  near('숫자칸으로 200 지정해도 같은 배율로 축소돼서 렌더됨', cssFontSize2, expected2, 0.5);

  finish(app);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
