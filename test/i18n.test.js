'use strict';
// 번역 사전 대조. Electron 이 필요 없다.
//
// 한쪽에만 키가 생기면 그 언어 사용자는 다른 언어를 보게 된다. 폴백이 있어 화면이 깨지지는
// 않으므로 눈으로는 잘 안 잡힌다 — 그래서 테스트로 둔다.
// 사전 경계는 ko/en 블록의 줄 번호로 잡는다. 키 이름으로 자르면 그 앞의 항목이 통째로 빠진다.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'renderer', 'scripts', 'i18n.js');

let pass = 0, fail = 0;
const expect = (label, got, want) => {
  const ok = String(got) === String(want); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}: ${got}${ok ? '' : ` (기대 ${want})`}`);
};

const lines = fs.readFileSync(SRC, 'utf8').split('\n');
const at = (re) => { const i = lines.findIndex(l => re.test(l)); if (i < 0) throw new Error('경계 없음: ' + re); return i; };

const koStart = at(/^ {2}ko: \{/);
const enStart = at(/^ {2}en: \{/);
let end = 0;
lines.forEach((l, i) => { if (l.startsWith('  },')) end = i; });

const PAIR = /^'([A-Za-z0-9_.]+)'\s*:\s*'((?:[^'\\]|\\.)*)'/;
function parse(a, b) {
  const d = new Map();
  for (const raw of lines.slice(a, b)) {
    const m = PAIR.exec(raw.trim());
    if (m && !d.has(m[1])) d.set(m[1], m[2]);
  }
  return d;
}

const ko = parse(koStart, enStart);
const en = parse(enStart, end + 1);

console.log('1) 양쪽 사전이 같은 키를 갖는가');
console.log(`   ko ${ko.size} · en ${en.size}`);
const onlyKo = [...ko.keys()].filter(k => !en.has(k));
const onlyEn = [...en.keys()].filter(k => !ko.has(k));
if (onlyKo.length) console.log('   영어에 없음:', onlyKo.slice(0, 10).join(', '));
if (onlyEn.length) console.log('   한국어에 없음:', onlyEn.slice(0, 10).join(', '));
expect('영어에 빠진 키', onlyKo.length, 0);
expect('한국어에 빠진 키', onlyEn.length, 0);
expect('사전이 비지 않음', ko.size > 100, true);

console.log('2) 같은 키의 치환 자리가 서로 맞는가');
// '{n}일 전' ↔ '{n} days ago' — 한쪽만 자리를 빠뜨리면 화면에 {n} 이 그대로 남는다
const slotOf = (s) => (s.match(/\{(\w+)\}/g) || []).sort().join(',');
const badSlots = [...ko.keys()].filter(k => en.has(k) && slotOf(ko.get(k)) !== slotOf(en.get(k)));
if (badSlots.length) for (const k of badSlots.slice(0, 8)) console.log(`   ${k}: ko[${slotOf(ko.get(k))}] en[${slotOf(en.get(k))}]`);
expect('치환 자리 불일치', badSlots.length, 0);

console.log('3) 값이 빈 키가 없는가');
const empty = [...ko.keys()].filter(k => !ko.get(k).trim() || !(en.get(k) || '').trim());
if (empty.length) console.log('   ', empty.slice(0, 8).join(', '));
expect('빈 문구      ', empty.length, 0);

console.log('4) main 의 네이티브 대화상자에 한국어가 박혀 있지 않은가');
// 파일 선택창은 OS 가 그리므로 화면 번역이 닿지 않는다 — main 쪽 표에서 골라야 한다
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const table = main.slice(main.indexOf('const DIALOG_TEXT'), main.indexOf('const td ='));
const outside = main.replace(table, '');
const hard = (outside.match(/(?:title|message|detail|name)\s*:\s*'[^']*[가-힣][^']*'/g) || []);
if (hard.length) console.log('   ', hard.slice(0, 6).join(' | '));
expect('한국어 고정  ', hard.length, 0);
expect('두 언어 표 존재', /ko: \{[\s\S]*en: \{/.test(table), true);

console.log(`\n통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
