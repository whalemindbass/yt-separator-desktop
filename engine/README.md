# yss-engine

실시간 오디오 사이드카 (JUCE, Windows). Electron UI 와 IPC 로 분리. 커버 연주자용 저지연 녹음·모니터링·믹싱·VST 호스팅 담당.

## 상태

- **M1 (현재)**: 디바이스 목록 + 스템 재생 + 입력 모니터 + 왕복 지연 표시
- M2: 멀티 스템 + 트랜스포트 + 1트랙 녹음 + PDC(지연 보정)
- M3: VST3 스캔·호스팅·에디터, 트랙 FX 체인
- M4: 테이크/컴핑, 자동화, export, Electron IPC 연동

## 빌드 (Windows / MSVC + CMake + Ninja)

```
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
build\yss-engine.exe [stem.wav]
```

VS 제너레이터도 가능:
```
cmake -S . -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

첫 configure 시 JUCE 8.0.15 를 FetchContent 로 clone (수 분).

> ⚠️ **경로에 한글(non-ASCII) 있으면 juceaide 가 .rc 생성 중 크래시.**
> 리포 경로가 `...\개발\...` 이므로 **ASCII 경로에 소스 복사 후 빌드**:
> ```
> robocopy engine C:\yss /E /XD build _deps
> cmake -S C:/yss -B C:/yss/build && cmake --build C:/yss/build --config Release
> ```
> (추후 빌드 스크립트로 자동화 예정)

## ASIO (저지연)

Steinberg ASIO SDK 는 재배포 불가 → 리포에 없음. 직접 받아서:

1. https://www.steinberg.net/developers/ 에서 ASIO SDK 다운로드
2. 압축 해제 후 `common` 폴더(= `asio.h` 위치) 경로 확보
3. 빌드:
```
cmake -S . -B build -G Ninja -DYSS_ENABLE_ASIO=ON -DYSS_ASIO_SDK_DIR=C:/path/asiosdk/common
cmake --build build
```

ASIO off 상태(기본)에선 WASAPI(shared) 로 동작 — 지연 큼. 저지연 검증은 ASIO on 필요.

## 라이선스 노트

- JUCE 8.0.15 — 현재 무매출 무료. 상용 판매 시 라이선스 필요(코드 변경 없음).
- ASIO SDK — 소스 미동봉, 빌드 시 링크만. `_deps/`, ASIO SDK 는 git 제외.
- VST3(M3) — 배포 시 Steinberg 라이선스 동의 필요.
