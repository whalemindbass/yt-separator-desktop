// yss-engine 사이드카 클라이언트 (Electron main 프로세스)
//   JSON stdio 로 실시간 오디오 엔진(JUCE)을 제어.
//   stdout 한 줄당 JSON 이벤트 → 'event' 및 이벤트명(ev)으로 emit.
//   파싱 안 되는 줄(플러그인 자체 로그 등)은 무시.

const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

/** 엔진 실행 파일 경로 — 패키지: resources/engine, 개발: 환경변수 또는 C:\yss 빌드 산출물 */
function resolveEnginePath() {
  if (process.env.YSS_ENGINE && fs.existsSync(process.env.YSS_ENGINE)) return process.env.YSS_ENGINE;
  const packaged = path.join(process.resourcesPath || '', 'engine', 'yss-engine.exe');
  if (fs.existsSync(packaged)) return packaged;
  const dev = 'C:\\yss\\build\\yss-engine_artefacts\\Release\\yss-engine.exe';
  if (fs.existsSync(dev)) return dev;
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
    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }   // 비-JSON 줄 무시
      if (msg && msg.ev) { this.emit('event', msg); this.emit(msg.ev, msg); }
    });
    this.proc.stderr.on('data', (d) => this.emit('log', String(d)));
    this.proc.on('exit', (code) => { this.proc = null; this.emit('exit', code); });
    return true;
  }

  send(cmd) {
    if (!this.proc) return false;
    try { this.proc.stdin.write(JSON.stringify(cmd) + '\n'); return true; }
    catch { return false; }
  }

  loadStems(paths)   { return this.send({ cmd: 'loadStems', paths }); }
  play()             { return this.send({ cmd: 'play' }); }
  stop()             { return this.send({ cmd: 'stop' }); }
  seek(pos)          { return this.send({ cmd: 'seek', pos }); }
  scanPlugins()      { return this.send({ cmd: 'scanPlugins' }); }
  track(index, opts) { return this.send({ cmd: 'track', index, ...(opts || {}) }); }
  master(gain)       { return this.send({ cmd: 'master', gain }); }
  monitor(gain)      { return this.send({ cmd: 'monitor', gain }); }
  metro(on, bpm)     { return this.send({ cmd: 'metro', on, bpm }); }
  // FX 체인 (슬롯 id 기반)
  fxAdd(index)          { return this.send({ cmd: 'fxAdd', index }); }
  fxRemove(slot)        { return this.send({ cmd: 'fxRemove', slot }); }
  fxReorder(order)      { return this.send({ cmd: 'fxReorder', order }); }
  fxSetChain(plugins)   { return this.send({ cmd: 'fxSetChain', plugins }); }
  fxBypass(slot, on)    { return this.send({ cmd: 'fxBypass', slot, on }); }
  fxEditor(slot)        { return this.send({ cmd: 'fxEditor', slot }); }
  fxSaveState(slot)     { return this.send({ cmd: 'fxSaveState', slot }); }
  fxSetState(slot, data){ return this.send({ cmd: 'fxSetState', slot, data }); }
  recordArm(file)    { return this.send({ cmd: 'recordArm', file }); }
  recordStop()       { return this.send({ cmd: 'recordStop' }); }

  quit() {
    if (!this.proc) return;
    this.send({ cmd: 'quit' });
    setTimeout(() => { if (this.proc) this.proc.kill(); }, 800);
  }
}

module.exports = { AudioEngine, resolveEnginePath };
