// 익명 사용 통계 요약 보기 — 운영자용.
//
//   node scripts/telemetry-stats.js [사용자이름] [--days 30]
//
// post-updates.js 와 같은 관리자 로그인(비밀번호는 화면에 안 찍는다 — 터미널에서 직접 실행).
// 서버: ytseparator.com/community/api/yts/telemetry (Worker src/telemetry.js)

const BASE = 'https://ytseparator.com/community/api';
const args = process.argv.slice(2);
const di = args.indexOf('--days');
const DAYS = di >= 0 ? Number(args[di + 1]) || 30 : 30;
const USERNAME = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--days') || 'admin';

const ENTER = ['\r', '\n', ''];
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('터미널에서 직접 실행해야 합니다.'));
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ENTER.includes(ch)) {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); resolve(buf);
      } else if (ch === '') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      else if (ch === '' || ch === '\b') buf = buf.slice(0, -1);
      else buf += ch;
    };
    stdin.on('data', onData);
  });
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '-');

(async () => {
  const password = await askHidden(`${USERNAME} 비밀번호: `);
  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password }),
  });
  const ld = await login.json().catch(() => null);
  if (!login.ok || !ld?.token) { console.error('로그인 실패:', ld?.error || ('HTTP ' + login.status)); process.exit(1); }

  const res = await fetch(`${BASE}/yts/telemetry?days=${DAYS}`, { headers: { Authorization: 'Bearer ' + ld.token } });
  const s = await res.json().catch(() => null);
  if (!res.ok || !s?.ok) { console.error('통계 조회 실패:', s?.error || ('HTTP ' + res.status)); process.exit(1); }

  const i = s.installs, a = s.active, f = s.funnel.recent, r = s.retention;
  console.log(`\n설치  전체 ${i.total} · 최근 7일 +${i.new7d} · 30일 +${i.new30d}`);
  console.log(`      채널 ${i.byChannel.map(c => `${c.channel} ${c.n}`).join(' · ') || '-'}`);
  console.log(`사용자  오늘 ${a.dau} · 7일 ${a.wau} · 30일 ${a.mau}`);
  console.log(`\n깔때기 (최근 ${f.days}일 설치 ${f.installs}명 기준)`);
  for (const [k, label] of [['separation', '첫 분리'], ['studio_open', '스튜디오 진입'], ['recording', '첫 녹음'], ['export', '첫 내보내기']]) {
    const n = f.steps[k] || 0;
    console.log(`  ${label.padEnd(8)} ${String(n).padStart(5)}  ${pct(n, f.installs)}`);
  }
  console.log(`\n재방문  다음 날 ${r.d1.returned}/${r.d1.base} (${pct(r.d1.returned, r.d1.base)}) · 7일+ ${r.d7.returned}/${r.d7.base} (${pct(r.d7.returned, r.d7.base)})`);
  console.log(`버전(최근 7일 접속) ${s.versions7d.map(v => `${v.v} ${v.n}`).join(' · ') || '-'}\n`);
})();
