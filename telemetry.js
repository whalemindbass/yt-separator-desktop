'use strict';
// 익명 사용 통계 — 메인 프로세스 전용.
//
// 보내는 것: 설치별 임의 ID(처음 켤 때 기기에서 만든 UUID) · 앱 버전 · 배포 채널(설치판/포터블/
// 스토어) · OS 이름 · 처음 도달한 사용 단계(첫 분리 / 스튜디오 첫 진입 / 첫 녹음 / 첫 내보내기).
// 곡 제목·파일 경로·장치 이름 같은 건 보내지 않는다. 서버도 IP 를 저장하지 않는다.
//
// 하루 한 번 핑(오늘 아직 안 보냈으면) + 단계에 처음 도달한 순간. 실패하면 다음 기회에 다시
// 보낸다(서버는 같은 요청이 여러 번 와도 결과가 같다). 설정에서 끌 수 있고, 끄면 ID 도 안
// 만들고 아무것도 기록·전송하지 않는다. 개발 실행(테스트 포함)에서는 절대 보내지 않는다.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENDPOINT = 'https://ytseparator.com/community/api/telemetry/ping';
const STEPS = new Set(['separation', 'studio_open', 'recording', 'export']);
const RECHECK_MS = 6 * 60 * 60 * 1000;   // 앱을 며칠씩 켜 두는 사람도 하루 한 번은 잡히게

function createTelemetry({ app, net, readSettings, isDev, channel, osName }) {
  const file = () => path.join(app.getPath('userData'), 'telemetry.json');   // 늦게 — userData 가 바뀔 수 있다
  let st = null;
  let busy = false;

  const today = () => new Date().toISOString().slice(0, 10);
  // YSS_TELEMETRY_URL — 검증용으로만: 로컬 서버를 가리키면 개발 실행에서도 그쪽으로만 보낸다.
  // 평소(환경변수 없음)엔 개발 실행에서 절대 안 보내고, 실제 앱은 운영 서버로 보낸다.
  const endpoint = () => process.env.YSS_TELEMETRY_URL || ENDPOINT;
  const enabled = () => (!isDev || !!process.env.YSS_TELEMETRY_URL) && !process.env.YSS_NO_TELEMETRY
    && readSettings().telemetryEnabled !== false;

  function state() {
    if (st) return st;
    try { st = JSON.parse(fs.readFileSync(file(), 'utf-8')); } catch { st = {}; }
    if (!st || typeof st !== 'object') st = {};
    if (!Array.isArray(st.sent)) st.sent = [];
    if (!Array.isArray(st.pending)) st.pending = [];
    return st;
  }
  function save() {
    try { fs.writeFileSync(file(), JSON.stringify(st), 'utf-8'); } catch { /* 다음 저장 때 다시 */ }
  }

  async function flush() {
    if (!enabled() || busy) return;
    const s = state();
    if (!s.id) { s.id = crypto.randomUUID(); save(); }
    const steps = s.pending.slice();
    if (!steps.length && s.lastPingDay === today()) return;   // 오늘 이미 보냈고 새 단계도 없음
    busy = true;
    try {
      const res = await net.fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s.id, v: app.getVersion(), ch: channel(), os: osName, steps }),
      });
      if (res.ok) {
        s.sent = [...new Set([...s.sent, ...steps])];
        s.pending = s.pending.filter((x) => !steps.includes(x));
        s.lastPingDay = today();
        save();
      }
    } catch { /* 오프라인 등 — 다음 기회에 */ }
    finally { busy = false; }
  }

  /** 사용 단계에 처음 도달했을 때 — 이미 보낸 단계면 아무것도 안 한다 */
  function step(name) {
    if (!STEPS.has(name) || !enabled()) return;
    const s = state();
    if (s.sent.includes(name) || s.pending.includes(name)) return;
    s.pending.push(name);
    save();
    flush();
  }

  /** 앱 시작 후 한 번, 그 뒤로 몇 시간마다 — 오늘 아직 안 보냈으면 보낸다 */
  function start() {
    setTimeout(() => { flush(); }, 15000);
    setInterval(() => { flush(); }, RECHECK_MS).unref?.();
  }

  return { step, start, flush };
}

module.exports = { createTelemetry, TELEMETRY_STEPS: STEPS };
