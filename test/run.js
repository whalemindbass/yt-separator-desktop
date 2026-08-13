#!/usr/bin/env node
'use strict';
// 테스트 실행기.
//
//   npm test                 전부
//   npm test -- home studio  이름에 그 말이 든 것만
//
// 파일마다 프로세스를 따로 띄운다. 하나가 죽어도 나머지는 돌고,
// 창을 닫아 앱이 끝나는 검사(저장 확인 등)도 그대로 쓸 수 있다.

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const ROOT = path.resolve(DIR, '..');

// Electron 이 필요한 것과 Node 로 충분한 것을 나눈다.
// samplerate 는 엔진만 쓰므로 창을 띄울 이유가 없다.
const NODE_ONLY = new Set(['samplerate.test.js', 'i18n.test.js']);

const filters = process.argv.slice(2).filter(a => !a.startsWith('-'));
const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.test.js'))
  .filter(f => !filters.length || filters.some(k => f.includes(k)))
  .sort();

if (!files.length) { console.error('돌릴 테스트가 없다'); process.exit(1); }

const electron = path.join(ROOT, 'node_modules', 'electron', 'cli.js');
const results = [];

for (const f of files) {
  const label = f.replace(/\.test\.js$/, '');
  console.log(`\n${'─'.repeat(58)}\n${label}\n${'─'.repeat(58)}`);
  const target = path.join(DIR, f);
  const r = NODE_ONLY.has(f)
    ? spawnSync(process.execPath, [target], { stdio: 'inherit', cwd: ROOT })
    : spawnSync(process.execPath, [electron, target], { stdio: 'inherit', cwd: ROOT });
  results.push({ label, code: r.status == null ? 1 : r.status });
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
