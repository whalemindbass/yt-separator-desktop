'use strict';
// STT(자동 자막, Whisper-small ONNX) 파이프라인 — 실제 Windows TTS 로 만든 알려진 문장
// (영어/한국어)을 넣어서, 워커(mel 추출 → 인코더/디코더 → 토크나이저 디코드)가 그
// 문장을 실제로 정확히 뽑아내는지 확인한다. 합성 톤이 아니라 진짜 음성이라야 텐서
// 계약(입출력 이름/모양)과 디코드 루프가 진짜 맞는지 검증된다 — 크래시 안 남만으론
// 부족하다. 세그먼트 타임스탬프(<|X.XX|> 토큰 파싱)도 문장 길이와 대략 맞는지 같이 본다.
//
// 모델(약 249MB)은 이미 GitHub Release(stt-v1)에 올려 뒀지만, 테스트마다 매번 받으면
// 너무 느리다 — 이 로컬 다운로드 사본을 테스트용 userData 에 미리 복사해 둔다(있으면).
// 없으면 이 테스트는 건너뛴다(실패로 치지 않음 — CI 등 이 캐시가 없는 환경 대비).

const path = require('path'); const fs = require('fs'); const os = require('os');
const { app } = require('electron');

const STT_CACHE_DIR = 'C:\\Users\\wkq32\\AppData\\Local\\Temp\\claude\\C--Users-wkq32-Desktop----dev\\713b49d5-7436-4b9d-9acc-e9109a348eab\\scratchpad\\whisper-small';
const TTS_DIR = 'C:\\Users\\wkq32\\AppData\\Local\\Temp\\claude\\C--Users-wkq32-Desktop----dev\\713b49d5-7436-4b9d-9acc-e9109a348eab\\scratchpad\\stt-test';

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yss-stt-profile-'));
app.setPath('userData', profileDir);

const { bootMain, expect, near, section, finish } = require('./harness');

function transcribeInPage(js, wavPath) {
  return js(`(async () => {
    const modelBytes = await yssApi.stt.modelBytes();
    if (!modelBytes.ok) return { error: 'modelBytes: ' + modelBytes.error };
    const audio = await yssApi.stt.extractAudio16k(${JSON.stringify(wavPath)}, 0, 10);
    if (!audio.ok) return { error: 'extractAudio: ' + audio.error };

    const worker = new Worker(new URL('./workers/stt-worker.js', document.baseURI), { type: 'module' });
    const progressLog = [];
    worker.addEventListener('message', (e) => {
      if (e.data.type === 'CHUNK_START' || e.data.type === 'DECODE_PROGRESS') progressLog.push(e.data);
    });
    const wait = (matchType) => new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('timeout waiting ' + matchType)), 60000);
      worker.addEventListener('message', function h(e) {
        if (e.data.type === matchType) { clearTimeout(to); worker.removeEventListener('message', h); resolve(e.data); }
        else if (e.data.type === 'ERROR') { clearTimeout(to); worker.removeEventListener('message', h); reject(new Error(e.data.error)); }
      });
    });
    const runtimeUrl = new URL('./', document.baseURI).href;
    worker.postMessage({ type: 'INIT', runtimeUrl });
    await wait('INIT_OK');
    worker.postMessage({ type: 'LOAD_MODEL', encoder: modelBytes.encoder, decoder: modelBytes.decoder, vocab: modelBytes.vocab, generationConfig: modelBytes.generationConfig });
    await wait('MODEL_OK');
    worker.postMessage({ type: 'TRANSCRIBE', pcm: audio.pcm, jobId: 1 });
    const result = await wait('RESULT');
    worker.terminate();
    return { segments: result.segments, progressLog };
  })()`);
}

(async () => {
  if (!fs.existsSync(STT_CACHE_DIR) || !fs.existsSync(path.join(STT_CACHE_DIR, 'encoder_model_quantized.onnx'))) {
    console.log('  건너뜀 — 로컬 whisper-small 캐시 없음(' + STT_CACHE_DIR + ')');
    process.exit(0);
  }
  if (!fs.existsSync(TTS_DIR)) {
    console.log('  건너뜀 — TTS 픽스처 없음(' + TTS_DIR + ')');
    process.exit(0);
  }

  section('0) 모델 파일을 테스트 userData 로 미리 복사(다운로드 생략)');
  const sttDir = path.join(profileDir, 'stt-model');
  fs.mkdirSync(sttDir, { recursive: true });
  for (const f of fs.readdirSync(STT_CACHE_DIR)) fs.copyFileSync(path.join(STT_CACHE_DIR, f), path.join(sttDir, f));

  const { app: electronApp, js } = await bootMain({ settle: 1500 });

  section('1) stt:status — installed:true (미리 복사해 둔 걸 인식)');
  const status = await js(`yssApi.stt.status()`);
  expect('설치됨 확인', status.installed, true);

  section('2) 영어 TTS 문장("The quick brown fox jumps over the lazy dog.") — 정확히 인식');
  const en = await transcribeInPage(js, path.join(TTS_DIR, 'en.wav'));
  expect('에러 없음', !en.error, true);
  if (en.error) console.log('  ERROR:', en.error);
  const enText = (en.segments || []).map((s) => s.text).join(' ').toLowerCase();
  console.log('  영어 인식 결과:', JSON.stringify(enText));
  expect('"quick"과 "fox"가 인식 텍스트에 포함됨', enText.includes('quick') && enText.includes('fox'), true);
  expect('세그먼트 1개(짧은 한 문장)', (en.segments || []).length, 1);
  if (en.segments?.length) {
    const s = en.segments[0];
    expect('시작 시각 0초', s.start, 0);
    expect('끝 시각이 있음(타임스탬프 토큰이 실제로 파싱됨)', s.end != null, true);
    near('끝 시각이 문장 길이(2~4초권)에 맞음', s.end, 3, 1.5);
  }
  expect('CHUNK_START 진행 메시지가 옴(진행 UI 가 걸 수 있는 신호)', en.progressLog.some((p) => p.type === 'CHUNK_START'), true);
  const decodeSteps = en.progressLog.filter((p) => p.type === 'DECODE_PROGRESS');
  expect('DECODE_PROGRESS 가 토큰마다 여러 번 옴(1개 이상)', decodeSteps.length > 0, true);
  expect('토큰 카운트가 1부터 단조 증가함', decodeSteps.every((p, i) => p.tokenCount === i + 1), true);

  section('3) 한국어 TTS 문장("오늘 날씨가 정말 좋네요.") — 정확히 인식');
  const ko = await transcribeInPage(js, path.join(TTS_DIR, 'ko.wav'));
  expect('에러 없음', !ko.error, true);
  if (ko.error) console.log('  ERROR:', ko.error);
  const koText = (ko.segments || []).map((s) => s.text).join(' ');
  console.log('  한국어 인식 결과:', JSON.stringify(koText));
  expect('"오늘"이 포함됨', koText.includes('오늘'), true);
  expect('"날씨"가 포함됨', koText.includes('날씨'), true);

  finish(electronApp);
})().catch((e) => { console.error('테스트 실패:', e); process.exit(1); });
