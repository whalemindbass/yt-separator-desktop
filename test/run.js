#!/usr/bin/env node
'use strict';
// 테스트 실행기.
//
//   npm test                 전부
//   npm test -- home studio  이름에 그 말이 든 것만
//   npm test -- --serial     디버깅용 — 병렬 안 쓰고 하나씩(예전 방식)
//
// 파일마다 프로세스를 따로 띄운다. 하나가 죽어도 나머지는 돌고,
// 창을 닫아 앱이 끝나는 검사(저장 확인 등)도 그대로 쓸 수 있다.
//
// 대부분은(84개 중 다수) 스튜디오 탭을 안 열어서 real 오디오 엔진/장치를 안 건드린다
// (Studio 화면을 열어야 main.js 가 engine:start 로 엔진 프로세스를 그때서야 띄운다 —
// 앱 부팅 자체는 엔진을 안 켠다). 그런 것들은 여러 개를 동시에 띄워도 서로 부딪힐 게
// 없어서(각자 mkdtempSync 로 독립된 userData 프로필을 쓴다) 병렬로 돌린다. 실제 ASIO
// 장치를 여는 것들(스튜디오 탭 클릭·engine.start 직접 호출·엔진 강제종료)은 장치가
// 하나뿐이라 동시에 돌리면 서로의 재생/녹음을 방해한다(실제로 겪은 flaky 원인) —
// 이것들만 예전처럼 하나씩 순서대로 돈다.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..');

// Electron 이 필요한 것과 Node 로 충분한 것을 나눈다.
// samplerate 는 엔진만 쓰므로 창을 띄울 이유가 없다.
const NODE_ONLY = new Set(['samplerate.test.js', 'i18n.test.js', 'studioutil.test.js', 'enginebuild.test.js', 'devremember.test.js', 'devreconnectstatus.test.js']);

// 실제 오디오 장치/엔진 프로세스를 만지는 스위트 — 위 NODE_ONLY(엔진을 직접 spawn)
// 더하기, 스튜디오 탭을 열거나(engine:start 트리거) 엔진을 직접 start/kill 하는 것들.
// (`.tab[data-view="studio"]` 클릭 또는 `engine.start(` 직접 호출로 찾았다 — 새 테스트가
// 스튜디오를 열게 되면 여기 추가해야 병렬 배치에서 장치 경합이 안 생긴다.)
const DEVICE_SENSITIVE = new Set([
  ...NODE_ONLY,
  'fileassoc.test.js', 'studio.test.js', 'shortcuts.test.js', 'metronome.test.js',
  'dirtyboot.test.js', 'devtypeswitch.test.js', 'deverror.test.js', 'beatgrid.test.js',
  'crash.test.js',
]);

const args = process.argv.slice(2);
const forceSerial = args.includes('--serial');
const filters = args.filter(a => !a.startsWith('-'));
const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filters.length || filters.some(k => f.includes(k)))
  .sort();

if (!files.length) { console.error('돌릴 테스트가 없다'); process.exit(1); }

const electron = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
const results = [];

// 앞선 스위트가 엔진을 남기면 그 프로세스가 오디오 장치를 물고 있어
// 다음 스위트의 재생이 조용히 어긋난다. 실패가 코드 탓처럼 보이므로 미리 치운다.
function killStrayEngine() {
  if (process.platform !== 'win32') return;
  try { spawnSync('taskkill', ['/IM', 'yss-engine.exe', '/F'], { stdio: 'ignore' }); } catch {}
}

// 각 테스트 파일이 mkdtempSync 로 만드는 yss-* userData/작업 폴더를 아무도 안 지운다 —
// 실패·강제종료뿐 아니라 정상 통과 때도 그대로 남는다. 스위트 하나당 여러 개씩, 84개
// 전체를 몇 번 돌리면 수십 GB 로 불어난다(실제로 이 프로젝트에서 겪은 디스크 꽉 참 사고
// 두 번 다 이게 원인). 스위트 끝날 때마다 쓸어서 쌓이지 않게 한다 — 어차피 테스트
// 전용이라 실행 중 남 다른 프로세스가 이 접두사를 쓸 일이 없다.
function cleanupYssTemp() {
  const tmp = os.tmpdir();
  let entries;
  try { entries = fs.readdirSync(tmp); } catch { return; }
  for (const name of entries) {
    if (!/^yss-/i.test(name)) continue;
    try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }
}

function bar() { return '─'.repeat(58); }

/** 하나 돌리고 끝날 때까지 기다린다(병렬용 — stdio 는 섞이면 못 읽으니 버퍼에 모았다 한 번에 찍는다). */
function runOne(f) {
  return new Promise((resolve) => {
    const label = f.replace(/\.test\.js$/, '');
    const target = path.join(DIR, f);
    const useNode = NODE_ONLY.has(f);
    const child = spawn(useNode ? process.execPath : process.execPath,
      useNode ? [target] : [electron, target],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => {
      cleanupYssTemp();
      resolve({ label, code: code == null ? 1 : code, out });
    });
  });
}

/** 동시 실행 개수를 concurrency 로 제한하며 tasks 를 전부 돈다.
 *  끝나는 대로(파일 순서 아니라 완료 순서로) 그 자리에서 바로 onDone 을 부른다 —
 *  전부 모았다 한꺼번에 찍으면 배치 하나(수십 개) 끝날 때까지 화면이 몇 분씩 깜깜해서
 *  실제로 도는 중인지 죽었는지 알 수가 없다(진행 상황 확인해달란 요청으로 드러난 문제). */
async function runPool(fileList, concurrency, onDone) {
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= fileList.length) return;
      const r = await runOne(fileList[i]);
      onDone(r, i, fileList.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, fileList.length) }, worker));
}

(async () => {
  cleanupYssTemp();   // 이전 실행(강제종료 등)이 남긴 것부터 먼저 치운다

  const parallelFiles = forceSerial ? [] : files.filter(f => !DEVICE_SENSITIVE.has(f));
  const serialFiles = forceSerial ? files : files.filter(f => DEVICE_SENSITIVE.has(f));

  if (parallelFiles.length) {
    const cpu = os.cpus()?.length || 4;
    const concurrency = Math.max(2, Math.min(6, cpu));
    console.log(`\n[병렬 ${concurrency}개씩 · ${parallelFiles.length}개 스위트 — 완료 순서대로(파일 순서 아님) 바로 찍는다]`);
    await runPool(parallelFiles, concurrency, (r, i, total) => {
      console.log(`\n${bar()}\n${r.label}  (${i + 1}/${total})\n${bar()}`);
      process.stdout.write(r.out);
      results.push({ label: r.label, code: r.code });
    });
  }

  if (serialFiles.length) {
    console.log(`\n[순차 · ${serialFiles.length}개 스위트 — 실제 오디오 장치/엔진을 만져서 한 번에 하나씩]`);
    for (const f of serialFiles) {
      const label = f.replace(/\.test\.js$/, '');
      console.log(`\n${bar()}\n${label}\n${bar()}`);
      killStrayEngine();
      const target = path.join(DIR, f);
      const r = NODE_ONLY.has(f)
        ? spawnSync(process.execPath, [target], { stdio: 'inherit', cwd: ROOT })
        : spawnSync(process.execPath, [electron, target], { stdio: 'inherit', cwd: ROOT });
      results.push({ label, code: r.status == null ? 1 : r.status });
      cleanupYssTemp();
    }
  }

  console.log(`\n${'═'.repeat(58)}`);
  let bad = 0;
  for (const r of results) {
    if (r.code !== 0) bad++;
    console.log(`  ${r.code === 0 ? '통과' : '실패'}  ${r.label}`);
  }
  console.log(`${'═'.repeat(58)}`);
  console.log(bad ? `${bad}개 실패` : `${results.length}개 전부 통과`);
  process.exit(bad ? 1 : 0);
})();
