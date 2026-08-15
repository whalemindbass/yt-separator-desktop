'use strict';
// 엔진 빌드 설정 — ASIO 가 실제로 들어갔는가.
//
// engine/build.ps1 은 ASIO SDK 를 찾으면 -DYSS_ENABLE_ASIO=ON 을 주고 별도 ASCII 경로
// (한글 경로에서 juceaide 가 죽는 것을 피하려고)에서 새로 구성해 빌드한다. 저장소 안의
// engine/build 폴더를 그 스크립트 없이 직접 cmake --build 하면, 그 폴더의 캐시가 예전에
// ASIO 없이 구성된 채로 있을 경우 조용히 ASIO 없는 바이너리가 나온다 — 컴파일도 되고
// 실행도 되고 다른 기능도 다 멀쩡해서, listDevices 로 직접 재보지 않으면 못 알아챈다.
//
// 실제로 이 일이 있었다: 세 번의 릴리즈(v1.4.15~17)가 이 상태로 나갔다. ASIO 인터페이스를
// 쓰는 사용자는 전부 Windows Audio 로 강등됐는데, 재빌드도 재부팅도 안 고쳐져서
// "드라이버가 고장났다"로만 보였다.
//
// ASIO SDK 는 재배포 금지라 저장소에 없다 — 이 검사는 SDK 가 있는 컴퓨터에서만 의미가
// 있다. SDK 를 못 찾으면 건너뛴다(그게 정상인 컴퓨터가 대부분이다). SDK 가 있는데
// engine/bin 의 바이너리에 ASIO 가 없으면, 그건 build.ps1 을 거치지 않고 만들어졌다는
// 뜻이라 실패로 잡는다.

const path = require('path'); const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXE = path.join(ROOT, 'engine', 'bin', 'yss-engine.exe');

// build.ps1 의 기본값과 같은 자리. 다른 컴퓨터는 -AsioSdk 로 다른 경로를 주므로,
// 그 경우를 위해 환경변수로도 받는다.
const SDK_CANDIDATES = [
  process.env.YSS_ASIO_SDK_DIR,
  'C:\\Users\\wkq32\\Downloads\\ASIOSDK\\common',
].filter(Boolean);

let pass = 0, fail = 0;
const expect = (l, g, w) => { const ok = String(g) === String(w); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${l}: ${g}${ok ? '' : ` (기대 ${w})`}`); };

(async () => {
  const sdk = SDK_CANDIDATES.find(d => fs.existsSync(path.join(d, 'asio.h')));
  if (!sdk) {
    console.log('  건너뜀 — 이 컴퓨터에 ASIO SDK 가 없다 (정상 — SDK 는 재배포 금지라 저장소에 없다)');
    process.exit(0);
  }
  if (!fs.existsSync(EXE)) {
    console.log('  건너뜀 — engine/bin/yss-engine.exe 없음, 먼저 빌드해야 한다');
    process.exit(0);
  }

  console.log(`  SDK 발견: ${sdk}`);
  const p = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const devices = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('listDevices 응답 없음(10초)')), 10000);
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.ev === 'ready') p.stdin.write('{"cmd":"listDevices"}\n');
        if (m.ev === 'devices') { clearTimeout(timer); resolve(m); }
      }
    });
    p.on('error', reject);
  });
  try { p.stdin.write('{"cmd":"quit"}\n'); } catch {}
  setTimeout(() => { try { p.kill(); } catch {} }, 1000);

  const types = (devices.types || []).map(t => t.name);
  console.log('  타입:', types.join(', ') || '(없음)');
  expect('ASIO 컴파일됨', types.includes('ASIO'), true);

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('테스트 실패:', e.message || e); process.exit(1); });
