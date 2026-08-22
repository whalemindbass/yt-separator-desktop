# VexFlow

- 출처: https://www.npmjs.com/package/vexflow (github.com/vexflow/vexflow)
- 버전: 5.0.0
- 라이선스: MIT
- 파일: `vexflow.js` — `build/cjs/vexflow.js` UMD 번들 그대로(Bravura 폰트 포함). `npm pack vexflow` 로 받은 tarball에서 복사.
- 용도: 베이스 채보 오선보 표시(프로토타입).
- 로드: `renderer/index.html` 에 classic `<script>` 로 얹어 `window.VexFlow` 전역으로 씀(다른 워커 모듈들과 달리 렌더링은 메인 스레드 DOM 이 필요해 워커 밖에서 로드).
- 복원: `npm pack vexflow@5.0.0` 후 tarball 안 `package/build/cjs/vexflow.js` 를 그대로 복사.
