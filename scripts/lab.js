#!/usr/bin/env node
'use strict';
// 베이스 채보 실험 도구 실행기.
//
//   npm run lab                    도구 목록과 기준선
//   npm run lab -- synth           정답이 알려진 합성 베이스를 만든다
//   npm run lab -- synth-score     그 합성 음원으로 채점  ← 시각까지 믿을 수 있는 유일한 기준
//   npm run lab -- score           실제 곡 정답지로 채점  (시각은 검출기에서 파생 — README 를 보라)
//   npm run lab -- dump            마디 악보 덤프
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
const htmlTools = fs.readdirSync(TOOLS).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''));
const want = process.argv[2];

// ── 합성 음원 만들기 ─────────────────────────────────────
if (want === 'synth') {
  const r = spawnSync(process.execPath, [path.join(TOOLS, 'synth.js')], { stdio: 'inherit', cwd: ROOT });
  process.exit(r.status == null ? 1 : r.status);
}

if (!want || (!htmlTools.includes(want) && want !== 'synth-score')) {
  console.log('도구:', ['synth', 'synth-score', ...htmlTools].join(' · '));
  console.log('예)  npm run lab -- synth-score\n');
  const b = manifest.baseline.yin;
  console.log('실제 곡 기준선 (정답지의 시각은 검출기에서 파생 — 음정만 유효):');
  console.log(`  YIN  일치 ${b.hit} (${b.pct}%) · 음정오류 ${b.pitchWrong} · 놓침 ${b.miss} · 잉여 ${b.extra}`);
  process.exit(want ? 1 : 0);
}

// ── 입력 고르기 ─────────────────────────────────────────
const useSynth = want === 'synth-score';
const tool = useSynth ? 'score' : want;
const bass = useSynth ? path.join(SYNTH, 'bass.wav') : path.join(ROOT, sample.audio.bass);
const gt = useSynth ? path.join(SYNTH, 'bass.gt.txt') : path.join(LAB, sample.groundTruth);

const lacking = [[bass, '베이스 오디오'], [gt, '정답지']].filter(([p]) => !fs.existsSync(p));
if (lacking.length) {
  for (const [p, what] of lacking) console.error(`없음 — ${what}: ${p}`);
  console.error(useSynth ? '\n먼저 만드세요: npm run lab -- synth'
                         : '\nlab/tab/manifest.json 의 samples[0] 를 보고 파일을 제자리에 두세요.');
  process.exit(1);
}

const stemDir = path.join(process.env.APPDATA || '', 'yt-separator-desktop', 'downloads', 'stems');
const stem = (kind) => {
  if (useSynth) return null;   // 합성 음원은 박자를 우리가 알고 있어 스템이 필요 없다
  const f = path.join(stemDir, `${sample.stems.prefix}_${kind}.wav`);
  return fs.existsSync(f) ? f : null;
};

const parts = tool === 'score'
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
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('allow-file-access-from-files');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    offscreen: true, webSecurity: false, nodeIntegration: false, contextIsolation: true } });
  let done = false;
  win.webContents.on('console-message', (_e, _l, msg) => {
    const s = String(msg);
    if (s.startsWith('###RESULT###')) { done = true; console.log(s.slice(12).trim()); app.exit(0); }
  });
  await win.loadURL('file:///' + PAGE.replace(/\\\\/g, '/') + '?q=' + QUERY);
  setTimeout(async () => {   // 결과를 화면에만 쓰는 도구도 있다
    if (done) return;
    try { console.log(await win.webContents.executeJavaScript("document.getElementById('out')?.textContent || ''")); } catch {}
    app.exit(0);
  }, 180000);
});
`, 'utf8');

const asUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
const electron = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
const r = spawnSync(process.execPath,
  [electron, driver, copied, encodeURIComponent(parts.map(asUrl).join('|'))],
  { stdio: 'inherit', cwd: ROOT });

try { fs.unlinkSync(driver); } catch {}
try { fs.unlinkSync(copied); } catch {}
process.exit(r.status == null ? 1 : r.status);
