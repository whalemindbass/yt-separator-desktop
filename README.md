# YT Separator — Desktop (Electron)

크롬 웹 스토어 정책(Blue Zinc)으로 확장 배포가 막힌 후, **사용자 로컬 데스크톱 앱**으로 방향 전환한 버전.
YouTube URL을 붙여넣으면 로컬에서 영상·오디오를 받고 스템으로 분리해 함께 재생한다.

## 개발 로드맵

- **Phase 1 (진행 중)** — Electron 앱 골격, 창 뜨는 최소 상태
- Phase 2 — `yt-dlp` 통합 (URL → 로컬 다운로드)
- Phase 3 — 기존 확장의 `stem-worker` / `encoder-worker` 이식, ONNX 모델 로드
- Phase 4 — 영상 + 스템 sync 재생 UI (기존 panel 이식)
- Phase 5 — 라이브러리 (처리한 영상 저장 · 재사용)
- Phase 6 — 배포 (`electron-builder`, auto-updater, EULA)

## 실행

```bash
npm install
npm start
```

`npm start` 실행 시 창이 뜨고 상단에 앱 버전/플랫폼이 표시되면 Phase 1 성공.

## 스택

- **Electron 32** — Node integration off, contextIsolation on
- **ONNX Runtime Web** (Phase 3 도입) — 기존 확장과 동일
- **yt-dlp** binary bundled (Phase 2 도입) — Windows/Mac/Linux 각각

## 프로젝트 구조

```
yt-separator-desktop/
├── main.js              # Electron main process
├── preload.js           # IPC bridge
├── package.json
├── renderer/            # UI (기존 확장 UI 재활용 예정)
│   ├── index.html
│   ├── styles/app.css
│   └── scripts/app.js
├── vendor/              # yt-dlp, ffmpeg 바이너리 (gitignored)
├── models/              # htdemucs ONNX (gitignored)
└── icons/
```

## 법적 고지

본 앱은 사용자가 **자신의 컴퓨터에서 개인 감상 목적**으로 이용하는 도구입니다.
저작권 보호 콘텐츠 취급에 대한 책임은 사용자에게 있으며, 개발자는 특정 사용 사례를 권장·조장하지 않습니다.
