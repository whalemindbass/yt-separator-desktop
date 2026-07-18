# YT Separator — Desktop

<p align="center">
  <img src="build/icon.png" width="96" height="96" alt="YT Separator" />
</p>

<p align="center">
  <strong>YouTube 링크나 로컬 파일에서 보컬·베이스·드럼·기타를 분리해<br />원본 영상과 sync 재생하는 Windows 데스크톱 앱.</strong>
</p>

<p align="center">
  <a href="https://github.com/whalemindbass/yt-separator-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/whalemindbass/yt-separator-desktop?label=latest" alt="Latest release" /></a>
  <a href="https://github.com/whalemindbass/yt-separator-desktop/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL-3.0" /></a>
  <a href="https://whalemindbass.github.io/yt-separator-desktop/"><img src="https://img.shields.io/badge/download-page-35d1a6" alt="Download" /></a>
</p>

## 설치

**다운로드**: https://whalemindbass.github.io/yt-separator-desktop/

- `Setup.exe` — NSIS 인스톨러. 자동 업데이트 지원 (권장).
- `Portable.exe` — 단일 실행 파일. 업데이트 시 다운로드 페이지로 안내.

> Windows Defender SmartScreen 경고가 표시될 수 있습니다 (코드 서명 미적용). "추가 정보" → "실행" 으로 진행하세요.

## 주요 기능

- **입력**: YouTube URL · 로컬 파일 (mp4, mkv, webm, mp3, wav, m4a, flac 등)
- **모델 선택**: 4-stem (htdemucs) · 6-stem (htdemucs_6s)
  - 4-stem: 보컬 · 베이스 · 드럼 · 기타(그외)
  - 6-stem: + 기타 · 피아노
- **재생**: 영상 + 스템 sync, 원본↔스템 토글, 반음 단위 키 변경(±6)
- **믹서**: 마스터 볼륨 + 트랙별 개별 볼륨/뮤트, 캐릭터 아이콘
- **라이브러리**: 즐겨찾기, 그룹, 이름 편집, 4↔6-stem 재분리
- **처리 가속**: WebGPU 자동 감지 (GPU) · CPU (WASM) 자동 폴백
- **자동 업데이트**: GitHub Releases 기반
- **테마**: 다크 / 라이트

## 로컬 처리

영상·오디오는 서버로 전송되지 않고 사용자 컴퓨터에서 온전히 처리됩니다.
모델 다운로드 이후에는 오프라인으로 사용할 수 있습니다.

## 기술 스택

- **Electron 43** (Chromium 148)
- **ONNX Runtime Web** — WebGPU + WASM
- **htdemucs / htdemucs_6s** — 음원 분리 모델
- **yt-dlp · ffmpeg** — 다운로드 / 오디오 추출
- **Pretendard** — typeface

## 개발

```bash
npm install
npm start                # 개발 모드 실행
npm run dist             # Windows 인스톨러 빌드 (dist/)
```

### 릴리즈 자동화

```bash
# Node CLI
GH_TOKEN=<token> npm run release

# Python GUI (exe 빌드 가능)
python scripts/release_gui.py
```

## 프로젝트 구조

```
yt-separator-desktop/
├── main.js              # Electron main process
├── preload.js           # IPC bridge
├── package.json
├── build/
│   ├── icon.png         # App icon
│   └── installer.nsh    # NSIS custom installer
├── renderer/
│   ├── index.html
│   ├── styles/app.css
│   ├── scripts/         # app, library, player, separator
│   ├── workers/         # stem-worker, encoder-worker
│   ├── lib/             # ONNX Runtime Web bundle
│   ├── assets/          # icons, fonts
│   └── fonts/           # Pretendard Variable
├── docs/                # GitHub Pages landing
├── scripts/             # release.js, release.py, release_gui.py
├── vendor/              # yt-dlp, ffmpeg (gitignored)
└── models/              # htdemucs models (gitignored, downloaded on demand)
```

## 법적 고지

본 앱은 사용자가 **자신의 컴퓨터에서 개인 감상 목적**으로 이용하는 도구입니다.
저작권 보호 콘텐츠 취급에 대한 책임은 사용자에게 있으며, 개발자는 특정 사용 사례를 권장·조장하지 않습니다.

## 라이선스

[GPL-3.0](LICENSE) © 2026 Whale Mind

## 링크

- **다운로드**: https://whalemindbass.github.io/yt-separator-desktop/
- **모든 릴리즈**: https://github.com/whalemindbass/yt-separator-desktop/releases
- **이슈 신고**: https://github.com/whalemindbass/yt-separator-desktop/issues
