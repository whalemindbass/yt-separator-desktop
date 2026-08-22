#!/usr/bin/env node
'use strict';
// 베이스 채보 실험 도구 실행기.
//
//   npm run lab                    도구 목록과 기준선
//   npm run lab -- synth           정답이 알려진 합성 베이스를 만든다
//   npm run lab -- synth-score     그 합성 음원으로 채점  ← 시각까지 믿을 수 있는 유일한 기준
//   npm run lab -- score           실제 곡 정답지로 채점  (시각은 검출기에서 파생 — README 를 보라)
//   npm run lab -- annotate        실제 곡의 온셋을 손으로 표기 (창이 뜬다)
//   npm run lab -- dump            마디 악보 덤프
//   npm run lab -- synth-mix       합성 베이스에 드럼·패드를 더해 진짜 곡처럼 섞는다 (synth 다음)
//   npm run lab -- sepattack       그 믹스를 실제 분리기에 태워 "분리가 어택을 얼마나 지우는가" 잰다
//
// HTML 도구는 renderer/ 의 모듈을 import 하고 file:// 을 fetch 한다. 브라우저에서는 둘 다
// 막히므로 오프스크린 Electron 안에서 연다. 결과는 터미널에 그대로 나온다 — 전에는 손으로
// 복사하고 URL 을 조립해야 했고, 그 마찰 때문에 측정을 건너뛰게 됐다.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LAB = path.join(ROOT, 'lab', 'tab');
const TOOLS = path.join(LAB, 'tools');
const SYNTH = path.join(LAB, 'synth');

const manifest = JSON.parse(fs.readFileSync(path.join(LAB, 'manifest.json'), 'utf8'));
const sample = manifest.samples[0];
const htmlTools = fs.readdirSync(TOOLS).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''))
  .filter(f => f !== 'annotate');   // 대화형이라 아래 오프스크린 흐름을 타지 않는다
const want = process.argv[2];

// ── 합성 음원 만들기 ─────────────────────────────────────
if (want === 'synth') {
  const r = spawnSync(process.execPath, [path.join(TOOLS, 'synth.js')], { stdio: 'inherit', cwd: ROOT });
  process.exit(r.status == null ? 1 : r.status);
}
if (want === 'synth-mix') {
  const r = spawnSync(process.execPath, [path.join(TOOLS, 'synth-mix.js')], { stdio: 'inherit', cwd: ROOT });
  process.exit(r.status == null ? 1 : r.status);
}
if (want === 'synth-mix-real') {
  const r = spawnSync(process.execPath, [path.join(TOOLS, 'synth-mix-real.js')], { stdio: 'inherit', cwd: ROOT });
  process.exit(r.status == null ? 1 : r.status);
}

// ── 손으로 온셋 표기 ─────────────────────────────────────
// 화면을 보고 찍는 작업이라 창이 실제로 떠야 한다. 저장은 페이지가 표식과 함께 찍고 여기서 받는다.
if (want === 'annotate') {
  const target = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(LAB, 'ground-truth', 'bass_sample.onsets.txt');
  const bassPath = path.join(ROOT, sample.audio.bass);
  if (!fs.existsSync(bassPath)) { console.error('없음:', bassPath); process.exit(1); }

  const page = path.join(ROOT, 'renderer', '_lab-annotate.html');
  fs.copyFileSync(path.join(TOOLS, 'annotate.html'), page);

  const drv = path.join(os.tmpdir(), `yss-annot-${process.pid}.js`);
  fs.writeFileSync(drv, `
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const PAGE = process.argv[2], QUERY = process.argv[3], OUT = process.argv[4];
app.commandLine.appendSwitch('allow-file-access-from-files');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 720, backgroundColor: '#0e1416',
    title: '온셋 표기', webPreferences: { webSecurity: false, contextIsolation: true } });
  win.setMenuBarVisibility(false);
  win.webContents.on('console-message', (_e, _l, msg) => {
    const s = String(msg);
    if (!s.startsWith('###SAVE###')) return;
    try { fs.writeFileSync(OUT, s.slice(10).replace(/^\\n/, ''), 'utf8');
          console.log('저장:', OUT, '(' + (s.split('\\n').length - 4) + '줄)'); }
    catch (e) { console.error('저장 실패:', e.message); }
  });
  await win.loadURL('file:///' + PAGE.replace(/\\\\/g, '/') + '?q=' + QUERY);
  win.on('closed', () => app.exit(0));
});
`, 'utf8');

  const asUrl2 = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
  console.log('창이 뜹니다. 확대해서 어택 자리를 클릭하세요.');
  console.log(`저장 위치: ${path.relative(ROOT, target)}\n`);
  const rr = spawnSync(process.execPath,
    [path.join(ROOT, 'node_modules', 'electron', 'cli.js'), drv, page, encodeURIComponent(asUrl2(bassPath)), target],
    { stdio: 'inherit', cwd: ROOT });
  try { fs.unlinkSync(drv); } catch {}
  try { fs.unlinkSync(page); } catch {}
  process.exit(rr.status == null ? 1 : rr.status);
}

const EXTRA = ['synth-score', 'onsets-synth', 'sepattack-real'];
if (!want || (!htmlTools.includes(want) && !EXTRA.includes(want))) {
  console.log('도구:', ['synth', 'annotate', 'synth-mix', 'synth-mix-real', ...EXTRA, ...htmlTools].join(' · '));
  console.log('예)  npm run lab -- synth-score\n');
  const b = manifest.baseline.yin;
  console.log('실제 곡 기준선 (정답지의 시각은 검출기에서 파생 — 음정만 유효):');
  console.log(`  YIN  일치 ${b.hit} (${b.pct}%) · 음정오류 ${b.pitchWrong} · 놓침 ${b.miss} · 잉여 ${b.extra}`);
  process.exit(want ? 1 : 0);
}

// ── 입력 고르기 ─────────────────────────────────────────
const isSepattack = want === 'sepattack' || want === 'sepattack-real';
const useSynth = want === 'synth-score' || want === 'onsets-synth' || isSepattack;
const tool = want === 'synth-score' ? 'score' : want === 'onsets-synth' ? 'onsets'
  : want === 'sepattack-real' ? 'sepattack' : want;
// 두 번째 인자로 다른 오디오를 줄 수 있다 —  npm run lab -- playable bass_sample_2.wav
// sepattack* 만은 두 번째 인자를 모델 키로 쓴다(합성 베이스/믹스는 항상 고정이므로 오디오
// 오버라이드가 의미 없다) — 파일 경로로 잘못 해석하지 않게 여기서 걸러낸다.
const override = (process.argv[3] && !isSepattack) ? path.resolve(process.argv[3]) : null;
const bass = override || (useSynth ? path.join(SYNTH, 'bass.wav') : path.join(ROOT, sample.audio.bass));
// onsets 도구만 다른 정답지를 본다 — 손으로 찍은 온셋이라 시각을 믿을 수 있는 유일한 것이다.
// 나머지 도구가 쓰는 탭 악보는 검출기에서 파생돼 음정만 유효하다 (README 를 보라).
const gt = useSynth ? path.join(SYNTH, 'bass.gt.txt')
  : tool === 'onsets' ? path.join(LAB, 'ground-truth', 'bass_sample.onsets.txt')
  : path.join(LAB, sample.groundTruth);

// sepattack* 은 실제 제품과 같은 분리 모델(.onnx)이 로컬에 받아져 있어야 한다 —
// 앱에서 한 번이라도 그 모델로 분리를 돌려 봤다면 userData/models 에 이미 있다.
const MODEL_FILES = { '4stem': 'htdemucs_core.onnx', '6stem': 'htdemucs_6s.onnx' };
const modelKey = (isSepattack && MODEL_FILES[process.argv[3]]) ? process.argv[3] : '4stem';
const modelPath = path.join(process.env.APPDATA || '', 'yt-separator-desktop', 'models', MODEL_FILES[modelKey]);
// -real 은 지어낸 드럼·패드 대신 진짜 스템 위에 얹은 믹스를 쓴다 — synth-mix-real.js 참고.
const mixPath = path.join(SYNTH, want === 'sepattack-real' ? 'mix-real.wav' : 'mix.wav');
const levelRefPath = path.join(SYNTH, want === 'sepattack-real' ? 'bass-as-mixed-real.wav' : 'bass-as-mixed.wav');

const lacking = [[bass, '베이스 오디오'], [gt, '정답지']]
  .concat(isSepattack ? [[mixPath, '합성 믹스'], [levelRefPath, '믹스 안 베이스 진폭 기준'],
                          [modelPath, `분리 모델(${modelKey}) — 앱에서 한 번 써서 받아 두세요`]] : [])
  .filter(([p]) => !fs.existsSync(p));
if (lacking.length) {
  for (const [p, what] of lacking) console.error(`없음 — ${what}: ${p}`);
  console.error(want === 'sepattack' ? '\n먼저: npm run lab -- synth  그다음: npm run lab -- synth-mix'
    : want === 'sepattack-real' ? '\n먼저: npm run lab -- synth  그다음: npm run lab -- synth-mix-real'
    : useSynth ? '\n먼저 만드세요: npm run lab -- synth'
    : '\nlab/tab/manifest.json 의 samples[0] 를 보고 파일을 제자리에 두세요.');
  process.exit(1);
}

const stemDir = path.join(process.env.APPDATA || '', 'yt-separator-desktop', 'downloads', 'stems');
const stem = (kind) => {
  if (useSynth) return null;   // 합성 음원은 박자를 우리가 알고 있어 스템이 필요 없다
  const f = path.join(stemDir, `${sample.stems.prefix}_${kind}.wav`);
  return fs.existsSync(f) ? f : null;
};

// -real 만 진짜 드럼·기타류·보컬 원본이 있다 — 잉여가 그 순간 다른 악기 활동과 겹치는지
// 보려면(9번 절 "다음으로 볼 만한 것") 분리를 한 번 더 하지 않고 이 원본과 바로 견준다.
const crossStemPaths = want === 'sepattack-real'
  ? ['drums', 'other', 'vocals'].map(k => path.join(stemDir, `${sample.stems.prefix}_${k}.wav`))
  : ['', '', ''];

const parts = tool === 'sepattack'
  ? [mixPath, bass, gt, modelPath, levelRefPath, ...crossStemPaths]   // 믹스 · 정답(분리 전) · 정답지 · 분리 모델 · 믹스 안 베이스 진폭 · 진짜 드럼·기타류·보컬
  : tool === 'octscore'
  ? [bass, path.join(LAB, 'ground-truth',
      path.basename(bass).replace(/\.wav$/i, '') + '.events.txt')]
  : tool === 'playable'
  ? [bass, gt]                       // 판정은 물리로 한다. 정답지는 마지막 절(옥타브 대조)에만 쓴다
  : tool === 'onsets'
  ? [bass, gt]                       // 시각만 본다 — 박자 격자도 스템도 쓰지 않는다
  : tool === 'score'
    ? [bass, gt, stem('drums'), stem('other'), stem('vocals')].filter(Boolean)
    : [bass, stem('drums'), stem('other'), stem('vocals')].filter(Boolean);

console.log(`도구 ${want} · 입력 ${parts.length}개`);
if (useSynth) console.log('  합성 음원 — 시각·음정이 검출기와 무관하다');
console.log('');

// ── 오프스크린 Electron 에서 실행 ────────────────────────
const copied = path.join(ROOT, 'renderer', `_lab-${tool}.html`);
fs.copyFileSync(path.join(TOOLS, `${tool}.html`), copied);

const driver = path.join(os.tmpdir(), `yss-lab-${process.pid}.js`);
fs.writeFileSync(driver, `
const { app, BrowserWindow } = require('electron');
const PAGE = process.argv[2], QUERY = process.argv[3];
// 하드웨어 가속을 끄지 않는다 — sepattack.html 의 htdemucs 분리는 항상 WASM 을 못박아 써서
// 원래도 GPU 와 무관했지만, CREPE(crepe-run.js)는 WebGPU 를 먼저 시도하고 실패하면 WASM 으로
// 자동 전환한다(11번 절) — 여기서 꺼 두면 WebGPU 시도 자체가 막혀 매번 WASM 으로만 돈다.
app.commandLine.appendSwitch('allow-file-access-from-files');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    offscreen: true, webSecurity: false, nodeIntegration: false, contextIsolation: true } });
  let done = false;
  win.webContents.on('console-message', (_e, _l, msg) => {
    const s = String(msg);
    if (s.startsWith('###RESULT###')) { done = true; console.log(s.slice(12).trim()); app.exit(0); }
    else if (s.startsWith('###PROGRESS###')) { console.log(s.slice(15).trim()); }   // 분리처럼 오래 걸리는 도구의 실시간 알림
  });
  await win.loadURL('file:///' + PAGE.replace(/\\\\/g, '/') + '?q=' + QUERY);
  setTimeout(async () => {   // 결과를 화면에만 쓰는 도구도 있다
    if (done) return;
    try { console.log(await win.webContents.executeJavaScript("document.getElementById('out')?.textContent || ''")); } catch {}
    app.exit(0);
  }, 900000);   // 훑기 도구는 transcribe 를 열 번 넘게 돌린다 — 3분으로는 중간에 잘린다
});
`, 'utf8');

const asUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
const electron = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
// 빈 문자열은 "안 줬다"는 뜻으로 그대로 둔다 — asUrl 을 태우면 'file:///' 이 되어 도구
// 쪽에서 값이 있는 것처럼 보인다(sepattack 의 진짜 스템 3개처럼 선택적인 인자가 있다).
const r = spawnSync(process.execPath,
  [electron, driver, copied, encodeURIComponent(parts.map(p => p ? asUrl(p) : '').join('|'))],
  { stdio: 'inherit', cwd: ROOT });

try { fs.unlinkSync(driver); } catch {}
try { fs.unlinkSync(copied); } catch {}
process.exit(r.status == null ? 1 : r.status);
