// 표기 도구 자동 확인 — 뜨는가 · 클릭이 표기가 되는가 · 저장이 파일로 떨어지는가
const { app, BrowserWindow } = require('electron');
const fs = require('fs');

const PAGE = process.argv[2], QUERY = process.argv[3], OUT = process.argv[4];
app.commandLine.appendSwitch('allow-file-access-from-files');

let pass = 0, fail = 0;
const expect = (label, got, want) => {
  const ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}: ${got}${ok ? '' : ` (기대 ${want})`}`);
};

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 720,
    webPreferences: { offscreen: true, webSecurity: false, contextIsolation: true },
  });

  let savedText = null;
  const errs = [];
  win.webContents.on('console-message', (_e, lvl, msg) => {
    const s = String(msg);
    if (s.startsWith('###SAVE###')) savedText = s.slice(10).replace(/^\n/, '');
    else if (lvl >= 2 && !/powerPreference|Security Warning|severe|adapters|Autofill/i.test(s)) errs.push(s.slice(0, 150));
  });

  try { fs.unlinkSync(OUT); } catch {}
  await win.loadURL('file:///' + PAGE.replace(/\\/g, '/') + '?q=' + QUERY);
  await new Promise(r => setTimeout(r, 8000));   // 디코딩까지 기다린다

  const js = (c) => win.webContents.executeJavaScript(c);

  console.log('1) 로드');
  const ready = await js(`({
    캔버스폭: document.getElementById('zoomc').width,
    표기: document.getElementById('count').textContent,
    길이표시: document.getElementById('pos').textContent,
  })`);
  expect('확대 캔버스  ', ready.캔버스폭 > 0, true);
  expect('표기 0 에서 시작', ready.표기, '0');

  console.log('2) 클릭이 표기가 되는가');
  await js(`(() => {
    const c = document.getElementById('zoomc'), r = c.getBoundingClientRect();
    for (const f of [0.25, 0.5, 0.75]) {
      c.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, clientX: r.left + r.width * f, clientY: r.top + r.height / 2,
        button: 0, pointerId: 1 }));
    }
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));
  expect('표기 3개     ', await js("document.getElementById('count').textContent"), '3');

  console.log('3) 우클릭으로 지워지는가');
  await js(`(() => {
    const c = document.getElementById('zoomc'), r = c.getBoundingClientRect();
    c.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: r.left + r.width * 0.5, clientY: r.top + r.height / 2,
      button: 2, pointerId: 2 }));
    return true;
  })()`);
  await new Promise(r => setTimeout(r, 300));
  expect('표기 2개     ', await js("document.getElementById('count').textContent"), '2');

  console.log('4) 내보내는 글이 채점기가 읽는 꼴인가');
  const text = await js("document.getElementById('out').value");
  const nums = (text.split('\n').filter(l => l && !l.startsWith('#')).join(' ').trim().split(/\s+/));
  expect('숫자 2개     ', nums.length, 2);
  expect('소수 3자리   ', /^\d+\.\d{3}$/.test(nums[0]), true);
  expect('오름차순     ', Number(nums[0]) < Number(nums[1]), true);

  console.log('5) S 로 저장');
  await js("(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true })); return true; })()");
  await new Promise(r => setTimeout(r, 400));
  expect('저장 신호    ', savedText != null, true);
  if (savedText != null) {
    fs.writeFileSync(OUT, savedText, 'utf8');
    expect('파일 생성    ', fs.existsSync(OUT), true);
  }

  // 버튼도 따로 재야 한다. 한 번은 S 만 이어져 있고 버튼이 죽어 있었는데, 키보드만 재고
  // 있어서 검사를 통과했다. 그 사이에 한 시간짜리 표기가 조용히 사라졌다.
  console.log('5-1) 저장 버튼도 같은 일을 하는가');
  savedText = null;
  await js("(() => { document.getElementById('save').click(); return true; })()");
  await new Promise(r => setTimeout(r, 400));
  expect('버튼 저장 신호', savedText != null, true);

  console.log('6) 검출기 결과를 보여주지 않는가');
  const src = fs.readFileSync(PAGE, 'utf8');
  expect('tab-core 안 씀', /tab-core|transcribe\(/.test(src), false);

  expect('콘솔 오류 없음', errs.length ? errs.slice(0, 2).join(' | ') : 0, 0);
  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  app.exit(fail ? 1 : 0);
});
