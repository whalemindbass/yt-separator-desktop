# Dr.studio

구조·배포 전반은 **`ARCHITECTURE.md`** 에 있다. 코드를 건드리기 전에 읽어라.

## 절대 틀리면 안 되는 것

- **랜딩 페이지 소스는 이 레포의 `docs/` 다.** `main` 푸시 → Cloudflare 자동 배포(~1분).
  `yt-separator-releases` 레포의 `docs/` 사본은 라이브가 아니다. `docs/` 를 지우면 사이트가 죽는다.
- 라이브가 이상하면 캐시부터 의심하지 말고, 라이브 HTML 과 **바이트 단위로 일치하는 파일**을 먼저 찾아라.
- 릴리즈 후 `latest.yml` 의 `size`·`sha512` 가 업로드된 `Dr.studio-Setup.exe` 와 일치하는지 확인해라.
  어긋나면 사용자 자동 업데이트가 죽는다.
- 렌더러는 파일 시스템에 직접 닿지 않는다. `preload.js` 의 `window.yssApi` 만 쓴다.
- 오디오 스레드에서 블로킹 금지. 엔진 락은 `ScopedTryLock` 만.

## 작업 규칙

- 버전은 **릴리즈할 때만 하나씩** 올린다. 기능 커밋에서 미리 올리지 않는다.
- 릴리즈 노트는 **사용자가 체감하는 것만** 짧게. 내부 리팩터는 쓰지 않는다.
- 디버그 로그를 넣지 않는다. 로그 파일을 디스크에 남기지 않는다.
- 검증은 실제로 앱을 띄워서 한다. `node --check` 통과나 치환 횟수는 검증이 아니다.
- `studio.js` 에서 번역 함수는 `tr` 로 import 한다 (`t` 는 반복문 변수로 쓰인다).
- 커밋 트레일러: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`
