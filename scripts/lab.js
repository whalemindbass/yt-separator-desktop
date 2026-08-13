#!/usr/bin/env node
'use strict';
// 베이스 채보 실험 도구 실행기.
//
//   npm run lab              도구 목록과 기준선
//   npm run lab -- score     정답지 대비 채점
//   npm run lab -- dump      마디 악보 덤프
//
// 도구는 renderer/ 의 모듈(tab-core.js 등)을 import 하고 file:// 을 fetch 한다.
// 브라우저에서는 둘 다 막히므로 오프스크린 Electron 안에서 연다. 결과는 터미널에 그대로 나온다 —
// 전에는 손으로 복사하고 URL 을 만들어 붙였고, 그 마찰 때문에 측정을 건너뛰게 됐다.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const LAB = path.join(ROOT, 'lab', 'tab');
const TOOLS = path.join(LAB, 'tools');

const manifest = JSON.parse(fs.readFileSync(path.join(LAB, 'manifest.json'), 'utf8'));
const sample = manifest.samples[0];
const tools = fs.readdirSync(TOOLS).filter(f => f.endsWith('.html')).map(f => f.replace(/\.html$/, ''));
const want = process.argv[2];

if (!want || !tools.includes(want)) {
  console.log('도구:', tools.join(' · '));
  console.log('예)  npm run lab -- score\n');
  const b = manifest.baseline.yin;
  console.log('기준선 — 넘지 못하면 개선이 아니다:');
  console.log(`  YIN  정답률 ${b.pct}% · 검출 ${b.detected} · 음정오류 ${b.pitchWrong} · 놓침 ${b.miss} · 잉여 ${b.extra}`);
  console.log(`  ${manifest.baseline.comment}`);
  process.exit(want ? 1 : 0);
}

// ── 입력 확인 ────────────────────────────────────────────
const bass = path.join(ROOT, sample.audio.bass);
const gt = path.join(LAB, sample.groundTruth);
const lacking = [[bass, '베이스 오디오'], [gt, '정답지']].filter(([p]) => !fs.existsSync(p));
if (lacking.length) {
  for (const [p, what] of lacking) console.error(`없음 — ${what}: ${p}`);
  console.error('\nlab/tab/manifest.json 의 samples[0] 를 보고 파일을 제자리에 두세요.');
  process.exit(1);
}

const stemDir = path.join(process.env.APPDATA || '', 'yt-separator-desktop', 'downloads', 'stems');
const stem = (kind) => {
  const f = path.join(stemDir, `${sample.stems.prefix}_${kind}.wav`);
  return fs.existsSync(f) ? f : null;
};

// score 는 <bass>|<정답지>|<drums>|<other>|<vocals> — 뒤 셋은 격자 정렬까지 재기 위한 것이라 없어도 된다.
// 나머지 도구는 <bass>|<drums>|<other>|<vocals>.
const parts = want === 'score'
  ? [bass, gt, stem('drums'), stem('other'), stem('vocals')].filter(Boolean)
  : [bass, stem('drums'), stem('other'), stem('vocals')].filter(Boolean);

console.log(`도구 ${want} · 입력 ${parts.length}개`);
if (want !== 'score' && !stem('drums')) console.log('  드럼 스템 없음 — 박자 검출이 폴백으로 간다');
console.log('');

// ── 오프스크린 Electron 에서 실행 ─────────────────────────
const copied = path.join(ROOT, 'renderer', `_lab-${want}.html`);
fs.copyFileSync(path.join(TOOLS, `${want}.html`), copied);

const driver = path.join(require('os').tmpdir(), `yss-lab-${process.pid}.js`);
fs.writeFileSync(driver, `
const { app, BrowserWindow } = require('electron');
const path = require('path');
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
  // 결과 표시만 하고 끝나는 도구도 있다 — 그때는 화면 글자를 그대로 가져온다
  setTimeout(async () => {
    if (done) return;
    try { console.log(await win.webContents.executeJavaScript("document.getElementById('out')?.textContent || ''")); } catch {}
    app.exit(0);
  }, 180000);
});
`, 'utf8');

const asUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace('%3A', ':');
const query = encodeURIComponent(parts.map(asUrl).join('|'));

const electron = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
const r = spawnSync(process.execPath, [electron, driver, copied, query], { stdio: 'inherit', cwd: ROOT });

try { fs.unlinkSync(driver); } catch {}
try { fs.unlinkSync(copied); } catch {}
process.exit(r.status == null ? 1 : r.status);
