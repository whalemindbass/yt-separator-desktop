# Dr.studio — 구조와 배포

이 문서는 코드를 읽기 전에 먼저 읽는 지도다. 파일 목록이 아니라 **무엇이 무엇을 부르고, 어디로 배포되는지**를 적는다.
구조가 바뀌면 이 문서도 같은 커밋에서 고친다.

---

## 1. 한 줄 요약

Windows 전용 데스크톱 앱. 유튜브·로컬 음원을 스템으로 **분리**하고, 원곡 영상을 보며 **녹음**하고, 믹스해 **내보낸다.**
모든 처리는 사용자 PC 안에서 끝난다. 오디오를 서버로 올리지 않는다.

- 셸: Electron 43 (`main.js` · `preload.js` · `renderer/`)
- 실시간 오디오: JUCE 8 로 만든 **별도 프로세스** `yss-engine.exe` (JSON-over-stdio)
- 분리 추론: **렌더러 워커**에서 onnxruntime-web (WebGPU, 실패 시 WASM)
- 백엔드: Cloudflare Worker (커뮤니티 API · 오류 제보) + D1

---

## 2. 레포와 배포 대상 — **여기부터 읽어라**

이 프로젝트는 레포가 여러 개고, **이름이 헷갈리게 겹친다.** 과거에 여기서 사고가 났다.

| 레포 | 용도 | 배포되는 곳 |
|---|---|---|
| `whalemindbass/yt-separator-desktop` (private) | 앱 소스 **+ 랜딩 페이지 `docs/`** | `docs/` → **ytseparator.com (Cloudflare)** |
| `whalemindbass/yt-separator-releases` (public) | 릴리즈 바이너리 호스팅 | GitHub Releases (설치판·포터블·`latest.yml`·모델 onnx) |
| `dev/yt-separator-community` | Cloudflare Worker (커뮤니티·제보 API) | `ytseparator.com/community/api/*` |
| `rowonss/yt-separator-landing` | Astro 랜딩 시제품 | **어디에도 배포 안 됨.** 커밋 1개짜리 미사용 |

### 🚨 랜딩 페이지 규칙

- **라이브 랜딩의 유일한 소스는 `yt-separator-desktop/docs/`** 다.
  `main` 에 푸시하면 Cloudflare 가 약 1분 안에 자동 배포한다.
- `yt-separator-releases` 레포에도 `docs/` 사본이 있지만 **라이브가 아니다.** 여기를 고쳐도 아무 일도 일어나지 않는다.
- `whalemindbass.github.io/yt-separator-releases/` 는 `ytseparator.com` 으로 **301 한다.** 이것을 보고
  "GitHub Pages 가 도메인 주인" 이라고 판단하면 틀린다. GitHub Pages 설정은 남아만 있고, DNS 는 Cloudflare 로 간다.
- 따라서 **`docs/` 를 지우면 사이트가 죽는다.** 실제로 지웠다가 약 2분간 사이트가 앱 렌더러 HTML(`renderer/index.html`)을
  노출한 사고가 있었다. 복구는 `git revert` 후 푸시 — 약 1분.

**라이브 소스를 확인하는 방법** (추측하지 말고 매번 이걸로 확인):

```bash
curl -s https://ytseparator.com/ -o /tmp/live.html
diff <(tr -d '\r' < /tmp/live.html) <(tr -d '\r' < docs/index.html)   # 차이 없으면 이 파일이 소스
```

내용이 안 맞으면 캐시부터 의심하지 말고 **어느 파일과 일치하는지** 먼저 찾는다.
바이트 단위로 일치하는 파일이 진짜 소스다.

### 배포 경로 3개

1. **랜딩** — `docs/` 변경 → `git push origin main` → Cloudflare 자동 배포 (~1분).
   엣지 노드별로 반영 시차가 있어 몇 분간 옛 페이지가 섞여 나올 수 있다. 정상이다.
2. **앱 릴리즈** — `npm run release` (아래 3절).
3. **커뮤니티 API** — `dev/yt-separator-community/` 에서 `npx wrangler deploy`.
   시크릿은 코드에 넣지 않고 `wrangler secret put <NAME>` 로 주입한다 (`DISCORD_WEBHOOK` 등).

---

## 3. 릴리즈 절차

```powershell
# GH_TOKEN 이 없으면 gh 키링 토큰을 쓴다
GH_TOKEN="$(gh auth token)" npm run release          # patch bump
```

`scripts/release.js` 가 하는 일: clean 검사 → `npm version` bump → `Release vX.Y.Z` 커밋·푸시 →
electron-builder 빌드 → GitHub Releases 업로드 → **에셋 정합성 검증** → `latest.yml` 업로드.

### 지켜야 할 것

- **버전은 릴리즈할 때만 하나씩** 올린다. 기능 커밋에서 미리 올리지 않는다.
- 릴리즈 노트는 `gh release edit vX.Y.Z --notes-file -` 로 따로 쓴다.
  **사용자가 체감하는 것만** 적는다. 내부 리팩터·파일명은 적지 않는다.
- 산출물 이름은 버전이 안 붙는다: `Dr.studio-Setup.exe` · `Dr.studio.exe` · `Dr.studio-Setup.exe.blockmap`.
  `package.json` 의 `build.nsis.artifactName` 이 정본이다.

### 자동 업데이트가 깨지는 지점

`latest.yml` 의 `size`·`sha512` 는 **업로드된 `Dr.studio-Setup.exe` 와 정확히 일치해야 한다.**
electron-builder 가 업로드 도중 실패한 뒤 `latest.yml` 만 재생성되면 둘이 어긋나고, 사용자 쪽 업데이트가
검증 실패로 죽는다. 릴리즈 후 반드시 확인:

```bash
gh release view vX.Y.Z --repo whalemindbass/yt-separator-releases --json assets \
  -q '.assets[] | "\(.name)  \(.size)"'
grep -E '^\s*size:' dist/latest.yml      # 두 값이 같아야 한다
```

어긋나면 `gh release upload vX.Y.Z dist/Dr.studio-Setup.exe --clobber` 로 교체한다.

---

## 4. 프로세스 구조

세 개의 프로세스가 돈다. 어느 쪽에 코드를 두느냐가 성능과 안정성을 가른다.

```
Electron main (main.js)
├─ 파일·설정·라이브러리·다이얼로그·자동업데이트
├─ 외부 프로세스 spawn: ffmpeg · yt-dlp
└─ engine-client.js ──stdin/stdout JSON──> yss-engine.exe (JUCE, 별도 프로세스)
        ▲                                     실시간 오디오 · ASIO · VST3 호스팅
        │ IPC (preload 로 화이트리스트)
Renderer (renderer/)
├─ UI 전부 + 스템 분리 추론(워커에서 onnxruntime-web)
└─ 오디오 재생/편집 명령은 main 을 거쳐 엔진으로
```

- **렌더러는 파일 시스템에 직접 닿지 않는다.** `preload.js` 가 노출한 `window.yssApi` 만 쓴다.
- **오디오 스레드에서 블로킹 금지.** 엔진 쪽 락은 `ScopedTryLock` 만 쓴다.
- 분리 추론이 렌더러에 있는 이유는 WebGPU 를 쓰기 위해서다. 무거운 계산은 `renderer/workers/` 로 뺀다.

---

## 5. 파일 지도

### Electron main

| 파일 | 역할 |
|---|---|
| `main.js` (1.3k줄) | 창 생성, 모든 `ipcMain` 핸들러(약 50개), 설정·라이브러리 저장, ffmpeg/yt-dlp spawn, autoUpdater |
| `preload.js` | `window.yssApi` 화이트리스트. **새 IPC 를 쓰려면 여기에도 추가해야 한다** |
| `engine-client.js` | `yss-engine.exe` spawn + 줄 단위 JSON 파싱 → EventEmitter. 실행 파일 경로 탐색 순서 포함 |

### Renderer (`renderer/scripts/`)

| 파일 | 역할 |
|---|---|
| `app.js` | 탭 전환, 테마, 업데이트 배지, 전역 배선 |
| `separator.js` | 분리 오케스트레이션: 모델 바이트 → 워커 LOAD_MODEL → 오디오 추출 → PROCESS → 저장 |
| `library.js` (1.7k줄) | 라이브러리 목록·그룹·즐겨찾기·고아 파일 정리 |
| `studio.js` (2.7k줄) | **DAW 화면 전체.** 트랙 헤드, 믹서, 센드 버스, FX 슬롯, 자동화, 녹음, 내보내기 |
| `player.js` | 영상·오디오 재생 동기화 |
| `fader.js` | dB 테이퍼 변환(`faderToGain`/`gainToFader`). 유니티는 travel 의 72%, 상한 +10 dB |
| `i18n.js` (1.1k줄) | ko/en 사전 + `applyI18n`. `data-i18n` / `-html` / `-title` / `-placeholder` / `-aria` |
| `community.js` · `report.js` | Cloudflare Worker API 호출 (커뮤니티 · 오류 제보) |
| `tabview.js` | 베이스 TAB — 워커 실행(`transcribeBass`) + 흐르는 악보 표시(`TabView`). 라이브러리·스튜디오가 공유 |

`renderer/workers/` — `stem-worker.js`(onnx 추론) · `encoder-worker.js`(WAV 인코딩) · `beat-worker.js`(BPM)
· `tab-worker.js`(베이스 채보) · `tab-core.js`(YIN·온셋·운지 DP) · `bp-run.js`+`bp-notes.js`(basic-pitch, 기본 꺼짐).
`renderer/lib/` — onnxruntime-web 번들, music-tempo, signalsmith-stretch. 전부 로컬. CDN 을 쓰지 않는다(CSP 가 막는다).

### 오디오 엔진 (`engine/`)

`src/Main.cpp` 한 파일. 빌드는 `engine/build.ps1` (`C:\yss` 로 미러 후 CMake) → 산출물을 `engine/bin/yss-engine.exe` 로 복사(gitignore 됨).
패키징 시 `resources/engine/` 로 들어간다.

핵심 개념: 스템/녹음 트랙별 게인·팬·뮤트·솔로, 고정 2개 센드 버스(`kBusIdBase = 95001`),
트랙별 링버퍼 지연선으로 PDC, `pickInputs()` 로 모노/스테레오 입력 선택.

### 베이스 TAB 채보

분리된 **베이스 스템**만 입력으로 받는다. 표시와 재생 동기화까지가 범위다 — 편집·MIDI 내보내기는 없다.

1. `tab-core.js` — 2단계 YIN(2배 데시메이션 후 전체 레이트로 ±4 랙 정밀화), 로그 에너지 플럭스 온셋,
   잔음·유령음 제거, 손 위치를 상태로 갖는 DP 운지 배정.
2. `detectTechniques` 가 슬라이드(`/` `\`)·해머온(`h`)·풀오프(`p`)를 찾는다. 아래 주의점을 보라.
3. 드럼 스템에서 얻은 박(`detectBeats`)이 있으면 `quantizeToGrid` 로 16분 격자에 붙인다.
   격자에서 간격의 45%보다 먼 음은 건드리지 않는다 — 당김음을 억지로 끌어오면 틀린 자리에 고정된다.
4. `tab-worker.js` 가 워커에서 돌리고 `tabview.js` 가 흐르는 악보로 그린다.

**온셋은 전체 음의 24% 에서만 잡힌다.** 분리 스템은 어택이 뭉개져 있기 때문이다. 그래서
"온셋이 없다"는 것만으로는 왼손 주법의 근거가 되지 못한다. 실제로 쓰는 근거는 이렇다.
- 슬라이드 — 두 음 사이에 중간 음정 프레임이 실제로 찍혔는가 (튼튼하다)
- 해머·풀 — 그 위에 세기까지 본다. 왼손으로 낸 소리는 방금 뜯은 앞 음보다 작다
- 배치가 끝난 뒤 연주 가능성으로 한 번 더 거른다 — 다른 현으로 갈렸거나,
  개방현으로 슬라이드하거나, 개방현에 해머온하는 것은 지운다

기호는 같은 현 제약을 DP 에 넣으므로 운지 전체를 흔든다(실측 23% 의 음이 다른 현으로 옮겨졌다).
`opts.techniques: false` 로 통째로 끌 수 있다.

**basic-pitch 교차 확인은 기본으로 끈다**(`opts.crossCheck === true` 일 때만). 사용자 수정 정답지 617음 대비
자체 YIN 87% · basic-pitch 18%(옥타브 무시 90% vs 29%)로, 불일치는 신뢰도 신호가 아니라 basic-pitch 의 오답이었다.
채점 도구는 `scratchpad/tablab/_cmp.html` (renderer/ 에 복사해서 연다).

---

## 6. 데이터가 사는 곳

| 대상 | 위치 |
|---|---|
| 설정 | `%APPDATA%/<app>/settings.json` |
| 라이브러리 색인 | `%APPDATA%/<app>/library.json` |
| 분리 모델 | `%APPDATA%/<app>/models/*.onnx` — 첫 사용 시 releases 레포에서 내려받음 |
| 프로젝트 | 사용자가 고른 경로의 `.yssproj` (JSON) |
| 스템·다운로드 | 설정에서 지정한 폴더 |

**로그 파일은 남기지 않는다.** 디버그 로그를 코드에 추가하지 않는다.

---

## 7. 작업할 때 지키는 것

- **검증은 실제로 앱을 띄워서** 한다. `node --check` 는 템플릿 리터럴 안의 문법 오류를 잡지 못한다.
  오프스크린 Electron(`BrowserWindow({ offscreen: true })` + IPC 스텁 + `capturePage`)으로 콘솔 에러까지 확인한다.
  치환 횟수를 세는 것은 검증이 아니다.
- **i18n**: `studio.js` 는 `t` 를 반복문 변수로 쓰므로 번역 함수를 `tr` 로 import 한다.
  엔진 상태처럼 값이 계속 바뀌는 요소에는 `data-i18n` 을 달지 않는다(로케일 변경 시 값이 되돌아간다). 상태로 렌더한다.
- **커밋 트레일러**: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
- 되돌리기 어렵거나 외부로 나가는 작업(배포·삭제·푸시)은 **먼저 무엇이 그 대상을 쓰고 있는지 확인**하고 한다.
  랜딩 사고의 원인은 GitHub Pages 만 확인하고 Cloudflare 연결을 확인하지 않은 것이었다.
