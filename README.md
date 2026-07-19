# YT Separator — Desktop

<p align="center">
  <img src="build/icon.png" width="96" height="96" alt="YT Separator" />
</p>

<p align="center">
  <strong>YouTube 링크나 로컬 파일에서 보컬·베이스·드럼·기타를 분리해<br />원본 영상과 sync 재생하는 Windows 데스크톱 앱.</strong>
</p>

<p align="center">
  <a href="https://ytseparator.com"><img src="https://img.shields.io/badge/download-ytseparator.com-35d1a6" alt="Download" /></a>
</p>

## 설치

**다운로드**: https://ytseparator.com

- `Setup.exe` — NSIS 인스톨러. 자동 업데이트 지원 (권장).
- `Portable.exe` — 단일 실행 파일.

> Windows Defender SmartScreen 경고가 표시될 수 있습니다 (코드 서명 진행 중). "추가 정보" → "실행" 으로 진행하세요.

## 주요 기능

- **입력**: YouTube URL · 로컬 파일 (mp4, mkv, webm, mp3, wav, m4a, flac 등)
- **모델**: 4-stem (htdemucs) · 6-stem (htdemucs_6s)
  - 4-stem: 보컬 · 베이스 · 드럼 · 기타(그외)
  - 6-stem: + 기타 · 피아노
- **재생**: 영상 + 스템 sync, 원본↔스템 토글, 반음 단위 키 변경(±6), A-B 구간 반복, 배속(피치 보존)
- **믹서**: 마스터 볼륨 + 트랙별 개별 볼륨/뮤트
- **라이브러리**: 즐겨찾기, 그룹, 이름 편집, 4↔6-stem 재분리, 스템/믹스 저장
- **처리 가속**: WebGPU 자동 감지 (GPU) · CPU (WASM) 자동 폴백
- **자동 업데이트**: GitHub Releases 기반
- **다국어**: 한국어 · English
- **테마**: 다크 / 라이트

## 로컬 처리

영상·오디오는 서버로 전송되지 않고 사용자 컴퓨터에서 온전히 처리됩니다.
모델 다운로드 이후에는 오프라인으로 사용할 수 있습니다.

## 라이선스

Copyright © 2026 Whale Mind. All rights reserved.

본 소프트웨어는 [상용 EULA](LICENSE) 하에 배포됩니다.
개인·비상업적 목적으로 자유롭게 사용하실 수 있으며, 재배포·수정·리버스 엔지니어링은 금지됩니다.
자세한 조건은 [LICENSE](LICENSE) 파일을 참조하세요.

> 버전 1.1.11 이하는 GPL-3.0 라이선스로 배포된 바 있으며, 해당 조건은 그대로 유지됩니다.

## 링크

- **다운로드**: https://ytseparator.com
- **이슈 신고 · 문의**: whalemindbass@gmail.com
