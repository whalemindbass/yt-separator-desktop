// 간단한 i18n 시스템.
//   HTML: <element data-i18n="key">, data-i18n-title, data-i18n-placeholder
//   JS  : import { t, setLocale, getLocale, onLocaleChange } from './i18n.js'
// 브라우저(웹뷰) 환경. localStorage 로 사용자 선택 저장. 기본값: 'ko'.

const LOCALES = {
  ko: {
    // 공통
    'common.confirm':   '확인',
    'common.cancel':    '취소',
    'common.close':     '닫기',
    'common.save':      '저장',
    'common.open':      '열기',
    'common.change':    '변경…',
    'common.refresh':   '새로고침',
    'common.reset':     '초기화',
    'common.delete':    '삭제',
    'common.retry':     '다시 시도',
    'common.loading':   '로드 중…',
    'common.checking':  '확인 중…',
    'common.error':     '오류',
    'common.done':      '완료',
    // 상단바 · 창 컨트롤
    'title.brand':      'YT Separator',
    'title.brand.sub':  'Desktop',
    'title.tab.separate': '새 분리',
    'title.tab.library':  '라이브러리',
    'title.tab.settings': '설정',
    'title.theme':      '테마 전환',
    'title.min':        '최소화',
    'title.max':        '최대화',
    'title.closebtn':   '닫기',
    // 새 분리 뷰
    'sep.heading':      'YouTube 링크를 붙여넣으세요',
    'sep.subtext':      '영상과 오디오를 로컬로 받아와 스템으로 분리합니다.',
    'sep.probe':        '확인',
    'sep.probing':      '확인 중…',
    'sep.download':     '다운로드',
    'sep.redownload':   '다시 다운로드',
    'sep.reset':        '초기화',
    'sep.reset.title':  '입력·진행·완료 상태 초기화',
    'sep.local.btn':    '로컬 파일 열기',
    'sep.local.title':  '로컬 영상/오디오 파일 선택',
    'sep.local.hint':   '인터넷 없이 로컬 파일도 분리 가능',
    'sep.label.model':  '모델',
    'sep.label.provider': '처리 장치',
    'sep.label.quality':  '영상 화질',
    'sep.provider.auto':  '자동',
    'sep.provider.gpu':   'GPU (WebGPU)',
    'sep.provider.cpu':   'CPU (WASM)',
    'sep.quality.hint':   '낮을수록 용량↓',
    'sep.existing.title': '이미 처리한 영상입니다',
    'sep.existing.open':  '라이브러리에서 열기',
    'sep.progress.ready': '준비',
    'sep.done.title':     '다운로드 완료',
    'sep.done.openFolder':'폴더 열기',
    'sep.done.startSep':  '스템 분리 시작',
    'sep.stems.done':     '스템 분리 완료',
    'sep.stems.openFolder':'스템 폴더 열기',
    'sep.stems.goLibrary': '라이브러리에서 재생',
    'sep.stems.newSong':   '새 곡 처리',
    // 라이브러리
    'lib.head':          '라이브러리',
    'lib.cleanup':       '정리',
    'lib.cleanup.title': '중복/orphan 파일 정리',
    'lib.refresh.title': '새로고침',
    'lib.empty':         '처리한 영상이 없습니다.',
    'lib.playerEmpty':   '좌측에서 항목을 선택하세요.',
    'lib.search.placeholder': '검색…',
    'lib.sort.group':    '그룹',
    'lib.sort.date':     '최근',
    'lib.sort.name':     '이름',
    // Player
    'player.stems.load':  '스템 로드 중…',
    'player.name.hint':   'Enter로 저장',
    'player.save':        '저장',
    'player.save.title':  '스템 저장',
    'player.reseparate':  '다른 모델로 분리',
    'player.reseparate.title': '다른 모델로 다시 분리',
    'player.group.title': '그룹 지정',
    'player.group.none':  '그룹 없음',
    'player.group.set':   '그룹',
    'player.delete':      '삭제',
    'player.dl.mix':      '현재 믹스 저장 (WAV)',
    'player.dl.stems':    '개별 스템 저장 (모두)',
    'player.dl.divider':  '폴더',
    'player.dl.folder':   '스템 폴더 열기',
    // Mixer
    'mixer.master':      'MASTER',
    'mixer.audio':       '오디오',
    'mixer.src.stem':    '스템믹스',
    'mixer.src.orig':    '원본',
    'mixer.speed':       '속도',
    'mixer.speed.down':  '-5%',
    'mixer.speed.up':    '+5%',
    'mixer.speed.reset': '1x로 초기화',
    'mixer.loop':        '구간반복',
    'mixer.loop.a':      '현재 위치를 A로 설정',
    'mixer.loop.b':      '현재 위치를 B로 설정',
    'mixer.loop.toggle': '반복',
    'mixer.loop.toggle.title': 'A~B 반복 재생 켜기/끄기',
    'mixer.loop.reset':  '초기화',
    'mixer.loop.reset.title': 'A/B 초기화',
    'mixer.metro':       '메트로놈',
    'mixer.metro.toggle':'클릭',
    'mixer.metro.toggle.title':'곡 sync 메트로놈 켜기/끄기',
    'mixer.metro.vol':   '메트로놈 볼륨',
    'mixer.exp':         'BETA',
    'mixer.metro.exp.desc':'실험적 기능 — 곡에 따라 정확도 차이가 있을 수 있음',
    'mixer.key':         '키',
    'mixer.key.down':    '반음 내림',
    'mixer.key.up':      '반음 올림',
    'mixer.key.apply':   '적용',
    // 설정
    'set.heading':       '설정',
    'set.subtext':       '앱 동작 방식을 조정할 수 있습니다.',
    'set.sec.sep':       '스템 분리',
    'set.sec.storage':   '파일 · 저장소',
    'set.sec.update':    '업데이트',
    'set.sec.about':     '정보',
    'set.sec.lang':      '언어',
    'set.model.title':   '기본 모델',
    'set.model.desc':    '"새 분리" 뷰의 초기 모델',
    'set.provider.title':'기본 처리 장치',
    'set.provider.desc': '자동 = WebGPU 지원 시 GPU, 아니면 CPU',
    'set.quality.title': '기본 영상 화질',
    'set.quality.desc':  '낮을수록 다운로드 · 처리 시간 단축',
    'set.clipboard.title':'클립보드 자동 감지',
    'set.clipboard.desc':'앱 창 활성화 시 클립보드의 YouTube 링크 자동 입력',
    'set.dldir.title':   '다운로드 폴더',
    'set.disk.title':    '사용 용량',
    'set.cleanup.title': '라이브러리 정리',
    'set.cleanup.desc':  '중복 통합 · 라이브러리에 없는 파일 확인',
    'set.cleanup.run':   '정리 실행',
    'set.models.title':  '모델',
    'set.models.desc':   '필요할 때 자동 다운로드됩니다. 사용 안 하면 삭제로 용량 확보',
    'set.autoUpd.title': '자동 확인',
    'set.autoUpd.desc':  '앱 시작 시 새 버전이 있는지 확인',
    'set.check.title':   '지금 확인',
    'set.version.title': '버전',
    'set.notes.title':   '릴리즈 노트',
    'set.notes.desc':    '모든 버전의 변경 내역',
    'set.notes.open':    'GitHub 열기',
    'set.lang.title':    '언어',
    'set.lang.desc':     '앱 인터페이스 언어',
    // Update dialog
    'upd.title':         '업데이트',
    'upd.download':      '다운로드',
    'upd.install':       '지금 재시작 & 설치',
    // Model download dialog
    'model.dl.title':    '모델 다운로드',
    // Errors (부분)
    'err.download.fail': '다운로드 실패',
    'err.probe.fail':    '확인 실패',
    'err.delete.confirm':'이 모델을 삭제할까요? 다음 사용 시 다시 다운로드됩니다.',
    // 진행 상태
    'progress.calculating':'계산 중…',
    // 모델 상태
    'model.state.ready': '준비됨',
    'model.state.willDl':'첫 사용 시 {size}MB 다운로드',
    // Provider status
    'prov.webgpu.unsupported': 'WebGPU 미지원 시스템 — CPU만 사용 가능',
    'prov.webgpu.nan':        '이전 세션에서 WebGPU NaN 발생 → CPU 권장 (WebGPU 다시 시도 가능)',
    'prov.auto':              'WebGPU 자동 사용',
    'prov.webgpu':            'WebGPU 강제 사용',
    'prov.cpu':               'CPU 강제 사용',
    'prov.fallback':          'WebGPU 미지원 — CPU로 fallback',
    // Phases (yt-dlp download)
    'phase.dl.video':    '영상 다운로드',
    'phase.dl.audio':    '오디오 다운로드',
    'phase.dl.merge':    'MP4 병합',
    'phase.dl.done':     '완료',
    'phase.dl.error':    '오류',
    // Phases (stem separation)
    'phase.sep.init':    '워커 초기화',
    'phase.sep.model':   '모델 로드',
    'phase.sep.extract': '오디오 추출',
    'phase.sep.separate':'스템 분리',
    'phase.sep.save':    'WAV 저장',
    'phase.sep.done':    '완료',
    'phase.sep.canceling':'취소 중…',
    'phase.sep.canceled':'취소됨',
    // Errors
    'err.dlpFailed':     '다운로드 실패',
    'err.sepFailed':     '스템 분리 실패',
    'err.probeFail':     '영상 정보를 가져오지 못했습니다',
    // Update dialog
    'upd.badge':         'v{version} 사용 가능',
    'upd.newVersion':    '새 버전 v{version} 있음',
    'upd.notes.none':    '릴리즈 노트 없음.',
    'upd.downloading':   '업데이트 다운로드 중…',
    'upd.dlFail':        '다운로드 실패',
    'upd.openPage':      '다운로드 페이지 열기',
    'upd.readyToInstall':'설치 준비 완료 (v{version}). 지금 재시작하시겠어요?',
    'upd.timeSince':     '방금 전',
    // Sep completion detail
    'sep.done.detail':   '{time}s 소요 · {provider} 사용',
    // Misc
    'lang.ko': '한국어',
    'lang.en': 'English',
  },
  en: {
    'common.confirm':   'OK',
    'common.cancel':    'Cancel',
    'common.close':     'Close',
    'common.save':      'Save',
    'common.open':      'Open',
    'common.change':    'Change…',
    'common.refresh':   'Refresh',
    'common.reset':     'Reset',
    'common.delete':    'Delete',
    'common.retry':     'Retry',
    'common.loading':   'Loading…',
    'common.checking':  'Checking…',
    'common.error':     'Error',
    'common.done':      'Done',
    'title.brand':      'YT Separator',
    'title.brand.sub':  'Desktop',
    'title.tab.separate': 'New',
    'title.tab.library':  'Library',
    'title.tab.settings': 'Settings',
    'title.theme':      'Toggle theme',
    'title.min':        'Minimize',
    'title.max':        'Maximize',
    'title.closebtn':   'Close',
    'sep.heading':      'Paste a YouTube link',
    'sep.subtext':      'Downloads video/audio locally and separates stems on your machine.',
    'sep.probe':        'Check',
    'sep.probing':      'Checking…',
    'sep.download':     'Download',
    'sep.redownload':   'Download again',
    'sep.reset':        'Reset',
    'sep.reset.title':  'Reset input, progress, and completion state',
    'sep.local.btn':    'Open local file',
    'sep.local.title':  'Select a local video/audio file',
    'sep.local.hint':   'Local files work without internet',
    'sep.label.model':  'Model',
    'sep.label.provider': 'Runtime',
    'sep.label.quality':  'Video quality',
    'sep.provider.auto':  'Auto',
    'sep.provider.gpu':   'GPU (WebGPU)',
    'sep.provider.cpu':   'CPU (WASM)',
    'sep.quality.hint':   'Lower = smaller file',
    'sep.existing.title': 'Already processed',
    'sep.existing.open':  'Open in library',
    'sep.progress.ready': 'Ready',
    'sep.done.title':     'Download complete',
    'sep.done.openFolder':'Open folder',
    'sep.done.startSep':  'Start stem separation',
    'sep.stems.done':     'Stem separation complete',
    'sep.stems.openFolder':'Open stems folder',
    'sep.stems.goLibrary': 'Play in library',
    'sep.stems.newSong':   'Process another',
    'lib.head':          'Library',
    'lib.cleanup':       'Clean up',
    'lib.cleanup.title': 'Remove duplicates / orphan files',
    'lib.refresh.title': 'Refresh',
    'lib.empty':         'No processed videos yet.',
    'lib.playerEmpty':   'Select an item from the left.',
    'lib.search.placeholder': 'Search…',
    'lib.sort.group':    'Group',
    'lib.sort.date':     'Recent',
    'lib.sort.name':     'Name',
    'player.stems.load':  'Loading stems…',
    'player.name.hint':   'Press Enter to save',
    'player.save':        'Save',
    'player.save.title':  'Save stems',
    'player.reseparate':  'Reseparate with other model',
    'player.reseparate.title': 'Run separation again with a different model',
    'player.group.title': 'Assign group',
    'player.group.none':  'No group',
    'player.group.set':   'Group',
    'player.delete':      'Delete',
    'player.dl.mix':      'Save current mix (WAV)',
    'player.dl.stems':    'Save individual stems (all)',
    'player.dl.divider':  'Folder',
    'player.dl.folder':   'Open stems folder',
    'mixer.master':      'MASTER',
    'mixer.audio':       'Audio',
    'mixer.src.stem':    'Stem mix',
    'mixer.src.orig':    'Original',
    'mixer.speed':       'Speed',
    'mixer.speed.down':  '-5%',
    'mixer.speed.up':    '+5%',
    'mixer.speed.reset': 'Reset to 1x',
    'mixer.loop':        'Loop',
    'mixer.loop.a':      'Set A to current position',
    'mixer.loop.b':      'Set B to current position',
    'mixer.loop.toggle': 'Loop',
    'mixer.loop.toggle.title': 'Toggle A→B repeat',
    'mixer.loop.reset':  'Reset',
    'mixer.loop.reset.title': 'Clear A/B points',
    'mixer.metro':       'Metronome',
    'mixer.metro.toggle':'Click',
    'mixer.metro.toggle.title':'Toggle song-synced metronome',
    'mixer.metro.vol':   'Metronome volume',
    'mixer.exp':         'BETA',
    'mixer.metro.exp.desc':'Experimental — accuracy varies by song',
    'mixer.key':         'Key',
    'mixer.key.down':    'Down a semitone',
    'mixer.key.up':      'Up a semitone',
    'mixer.key.apply':   'Apply',
    'set.heading':       'Settings',
    'set.subtext':       'Adjust how the app behaves.',
    'set.sec.sep':       'Stem separation',
    'set.sec.storage':   'Files & storage',
    'set.sec.update':    'Updates',
    'set.sec.about':     'About',
    'set.sec.lang':      'Language',
    'set.model.title':   'Default model',
    'set.model.desc':    'Initial model in the "New" view',
    'set.provider.title':'Default runtime',
    'set.provider.desc': 'Auto = GPU when WebGPU is available, otherwise CPU',
    'set.quality.title': 'Default video quality',
    'set.quality.desc':  'Lower = faster download & processing',
    'set.clipboard.title':'Auto-detect clipboard',
    'set.clipboard.desc':'Auto-fill YouTube links from clipboard when the app is focused',
    'set.dldir.title':   'Download folder',
    'set.disk.title':    'Storage usage',
    'set.cleanup.title': 'Library cleanup',
    'set.cleanup.desc':  'Merge duplicates · check for orphan files',
    'set.cleanup.run':   'Run cleanup',
    'set.models.title':  'Models',
    'set.models.desc':   'Downloaded automatically on demand. Delete if unused to free space.',
    'set.autoUpd.title': 'Check automatically',
    'set.autoUpd.desc':  'Check for a new version on app start',
    'set.check.title':   'Check now',
    'set.version.title': 'Version',
    'set.notes.title':   'Release notes',
    'set.notes.desc':    'Full change history across all versions',
    'set.notes.open':    'Open on GitHub',
    'set.lang.title':    'Language',
    'set.lang.desc':     'App interface language',
    'upd.title':         'Update',
    'upd.download':      'Download',
    'upd.install':       'Restart & install now',
    'model.dl.title':    'Model download',
    'err.download.fail': 'Download failed',
    'err.probe.fail':    'Check failed',
    'err.delete.confirm':'Delete this model? It will be re-downloaded next time.',
    'progress.calculating':'Calculating…',
    'model.state.ready': 'Ready',
    'model.state.willDl':'Downloads {size}MB on first use',
    'prov.webgpu.unsupported': 'WebGPU not supported — CPU only',
    'prov.webgpu.nan':        'Previous session hit WebGPU NaN → CPU recommended (WebGPU still available)',
    'prov.auto':              'WebGPU used automatically',
    'prov.webgpu':            'WebGPU forced',
    'prov.cpu':               'CPU forced',
    'prov.fallback':          'WebGPU unavailable — falling back to CPU',
    'phase.dl.video':    'Downloading video',
    'phase.dl.audio':    'Downloading audio',
    'phase.dl.merge':    'Merging MP4',
    'phase.dl.done':     'Done',
    'phase.dl.error':    'Error',
    'phase.sep.init':    'Initializing worker',
    'phase.sep.model':   'Loading model',
    'phase.sep.extract': 'Extracting audio',
    'phase.sep.separate':'Separating stems',
    'phase.sep.save':    'Saving WAV',
    'phase.sep.done':    'Done',
    'phase.sep.canceling':'Canceling…',
    'phase.sep.canceled':'Canceled',
    'err.dlpFailed':     'Download failed',
    'err.sepFailed':     'Stem separation failed',
    'err.probeFail':     'Could not fetch video info',
    'upd.badge':         'v{version} available',
    'upd.newVersion':    'New version v{version} available',
    'upd.notes.none':    'No release notes.',
    'upd.downloading':   'Downloading update…',
    'upd.dlFail':        'Download failed',
    'upd.openPage':      'Open download page',
    'upd.readyToInstall':'Ready to install v{version}. Restart now?',
    'upd.timeSince':     'just now',
    'sep.done.detail':   '{time}s · {provider}',
    'lang.ko': '한국어',
    'lang.en': 'English',
  },
};

const LS_KEY = 'yss:locale';
const DEFAULT_LOCALE = 'ko';
const SUPPORTED = Object.keys(LOCALES);

let _current = (() => {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved && SUPPORTED.includes(saved)) return saved;
  } catch {}
  return DEFAULT_LOCALE;
})();

const _listeners = new Set();

export function getLocale() { return _current; }
export function supportedLocales() { return SUPPORTED.slice(); }

export function t(key, params) {
  const dict = LOCALES[_current] || LOCALES[DEFAULT_LOCALE];
  let s = (dict && dict[key]) ?? LOCALES[DEFAULT_LOCALE][key] ?? key;
  if (params && typeof s === 'string') {
    s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
  }
  return s;
}

export function setLocale(loc) {
  if (!SUPPORTED.includes(loc)) return;
  _current = loc;
  try { localStorage.setItem(LS_KEY, loc); } catch {}
  document.documentElement.setAttribute('lang', loc);
  applyI18n(document);
  for (const fn of _listeners) { try { fn(loc); } catch {} }
  try { window.dispatchEvent(new CustomEvent('yss:locale-change', { detail: { locale: loc } })); } catch {}
}

export function onLocaleChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// data-i18n / data-i18n-title / data-i18n-placeholder 처리
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n');
    if (k) el.textContent = t(k);
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    const k = el.getAttribute('data-i18n-title');
    if (k) el.title = t(k);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const k = el.getAttribute('data-i18n-placeholder');
    if (k) el.placeholder = t(k);
  });
}

// 초기 <html lang="..."> 반영
document.documentElement.setAttribute('lang', _current);
