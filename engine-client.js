// yss-engine 사이드카 클라이언트 (Electron main 프로세스)
//   JSON stdio 로 실시간 오디오 엔진(JUCE)을 제어.
//   stdout 한 줄당 JSON 이벤트 → 'event' 및 이벤트명(ev)으로 emit.
//   파싱 안 되는 줄(플러그인 자체 로그 등)은 무시.

const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

/** 엔진 실행 파일 경로 — 환경변수 → 패키지(resources/engine) → 프로젝트 산출물 순 */
function resolveEnginePath() {
  if (process.env.YSS_ENGINE && fs.existsSync(process.env.YSS_ENGINE)) return process.env.YSS_ENGINE;
  const packaged = path.join(process.resourcesPath || '', 'engine', 'yss-engine.exe');
  if (fs.existsSync(packaged)) return packaged;
  // 개발: 리포에 복사된 산출물 우선, 그다음 특정 빌드 경로(레거시)
  const candidates = [
    path.join(__dirname, 'engine', 'bin', 'yss-engine.exe'),
    path.join(__dirname, 'engine', 'build', 'yss-engine_artefacts', 'Release', 'yss-engine.exe'),
    'C:\\yss\\build\\yss-engine_artefacts\\Release\\yss-engine.exe',
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

class AudioEngine extends EventEmitter {
  constructor(exePath = resolveEnginePath()) {
    super();
    this.exePath = exePath;
    this.proc = null;
  }

  start(stemPaths = []) {
    if (this.proc) return true;
    if (!this.exePath) { this.emit('event', { ev: 'error', msg: 'engine exe not found' }); return false; }
    this.expectExit = false;   // 우리가 끝낸 것과 죽은 것을 구별한다
    try {
      this.proc = spawn(this.exePath, stemPaths, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.proc = null;
      this.emit('event', { ev: 'error', msg: 'spawn failed: ' + e.message });
      return false;
    }
    // 'error'/stdin EPIPE 등 미처리 시 프로세스 크래시 → 반드시 핸들
    this.proc.on('error', (e) => { this.proc = null; this.emit('event', { ev: 'error', msg: String(e && e.message || e) }); });
    this.proc.stdin.on('error', () => {});
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }   // 비-JSON 줄 무시
      if (msg && msg.ev) { this.emit('event', msg); this.emit(msg.ev, msg); }
    });
    this.proc.stderr.on('data', (d) => this.emit('log', String(d)));
    // 부모가 사라져도 엔진은 살아남는다. 그러면 ASIO 장치를 계속 물고 있어
    // 다시 켠 앱도, 사용자의 다른 DAW 도 소리를 못 낸다. 나갈 때 같이 데려간다.
    this._killOnExit = () => { try { this.proc?.kill(); } catch {} };
    process.once('exit', this._killOnExit);

    this.proc.on('exit', (code) => {
      try { this.rl?.close(); } catch {}
      try { process.removeListener('exit', this._killOnExit); } catch {}
      this.rl = null; this.proc = null;
      const crashed = !this.expectExit;
      this.expectExit = false;
      this.emit('exit', code, crashed);
    });
    return true;
  }

  // 모든 엔진 명령은 preload 의 인라인 {cmd:...} 객체 → engine:cmd → 이 send() 단일 경로.
  send(cmd) {
    if (!this.proc) return false;
    try { this.proc.stdin.write(JSON.stringify(cmd) + '\n'); return true; }
    catch { return false; }
  }

  quit() {
    if (!this.proc) return;
    this.expectExit = true;
    this.send({ cmd: 'quit' });
    setTimeout(() => { if (this.proc) this.proc.kill(); }, 800);
  }
}

module.exports = { AudioEngine, resolveEnginePath };
