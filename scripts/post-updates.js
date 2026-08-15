// 릴리즈 내용을 앱 홈의 업데이트 게시판에 올린다.
//
//   node scripts/post-updates.js [사용자이름]
//
// 터미널에서 직접 실행해야 한다 — 비밀번호를 화면에 찍지 않고 받기 때문이다.
// 이미 있는 제목은 건너뛰고, 게시 시각이 다르면 맞춘다. 여러 번 돌려도 안전하다.
// 릴리즈할 때마다 아래 ENTRIES 맨 끝에 한 항목만 더하면 된다.

const BASE = 'https://ytseparator.com/community/api';
const USERNAME = process.argv[2] || 'admin';

const at = (iso) => new Date(iso).getTime();

const ENTRIES = [
  {
    title: 'v1.4.7',
    publishedAt: at('2026-08-09T02:09:36Z'),
    body: [
      '- **센드 버스 A · B** 를 추가했습니다. 리버브나 딜레이를 버스에 한 번만 걸고, 트랙마다 보내는 양을 조절해 씁니다',
      '- **오디오 입력 설정** 이 생겼습니다. 모노/스테레오와 사용할 입력 채널을 고르고, 채널별로 신호가 들어오는지 실시간으로 보입니다',
      '- 악기 소리가 한쪽에서만 들리던 문제를 고쳤습니다. 2번 단자에 꽂으면 튜너와 입력 레벨이 반응하지 않던 문제도 함께 고쳤습니다',
      '- 트랙을 좌우로 팬 해도 내보낸 파일은 가운데로 나오던 문제를 고쳤습니다',
    ].join('\n'),
  },
  {
    title: 'v1.4.8',
    publishedAt: at('2026-08-09T06:05:40Z'),
    body: [
      '- 스튜디오가 **영어를 지원**합니다. 설정에서 언어를 바꾸면 스튜디오 전체가 함께 바뀝니다',
      '- 스튜디오에 들어갈 때 오디오를 준비하는 동안 로딩 화면이 나오고, 켜지면 사용 중인 장비 이름이 보입니다',
      '- 업데이트 후 작업표시줄 고정이 풀리던 문제를 고쳤습니다',
      '- 트랙을 고르지 않아도 센드·이펙트가 조작되던 문제를 고쳤습니다',
    ].join('\n'),
  },
  {
    title: 'v1.4.9',
    publishedAt: at('2026-08-09T08:24:37Z'),
    body: [
      '- **5현 베이스 로우 B** 가 튜너에 잡히지 않던 문제를 고쳤습니다. 어쩌다 잡혀도 다른 음으로 표시되던 것도 함께 고쳤습니다',
      '- 튜너가 약하게 튕긴 소리도 잡습니다',
      '- 튜너 반응이 빨라지고, 표시가 끊기던 현상이 없어졌습니다',
    ].join('\n'),
  },
  {
    title: 'v1.4.10',
    publishedAt: at('2026-08-10T08:27:51Z'),
    body: [
      '- **밝은 테마가 덜 눈부십니다.** 타임라인과 영상 주변까지 흰색이던 넓은 면을 옅은 회색으로 낮췄습니다',
      '- **녹음 알림을 없앴습니다.** 녹음 버튼과 타임라인에 이미 보이던 내용이었습니다',
    ].join('\n'),
  },
  {
    title: 'v1.4.11',
    publishedAt: at('2026-08-10T09:06:01Z'),
    body: [
      '- **믹스를 원하는 폴더에 저장**할 수 있습니다. 설정의 영상·스템 폴더가 아닌 곳을 고르면 저장이 되지 않던 문제를 고쳤습니다',
      '- 개별 스템 저장도 같은 문제가 있었고 함께 고쳤습니다',
      '',
      '오류 제보 감사합니다 ^^',
    ].join('\n'),
  },
  {
    title: 'v1.4.12',
    // 게시 시각은 서버가 지금으로 찍는다 — 방금 나온 릴리즈라 그게 맞다
    body: [
      '- **홈 화면이 생겼습니다.** 왼쪽 위 로고를 누르면 열립니다. 공지사항·업데이트 내역·자주 묻는 질문을 여기서 봅니다',
      '- 홈에서 최근 작업한 곡을 눌러 바로 이어서 하거나, 새 분리·라이브러리·스튜디오로 곧장 갈 수 있습니다',
      '- **분리 화면을 정리했습니다.** 링크로 분리할지 내 파일을 분리할지 먼저 고르는 방식입니다',
      '- **오디오 장치를 48kHz 로 쓰면 반주가 빠르고 높게 재생되던 문제**를 고쳤습니다. 이제 장치 설정을 바꾸지 않아도 됩니다 — 44.1 / 48 / 96kHz 모두 그대로 쓰시면 됩니다',
      '- 저장한 프로젝트를 다른 샘플레이트에서 열면 녹음 트랙만 밀려 있던 문제를 고쳤습니다',
      '- 스튜디오를 쓰는 도중 샘플레이트를 바꾸면 녹음 트랙이 어긋나던 문제를 고쳤습니다',
      '',
      '오류 제보 감사합니다 ^^',
    ].join('\n'),
  },
  {
    title: 'v1.4.13',
    publishedAt: at('2026-08-12T08:41:26Z'),
    body: [
      '- **스튜디오에서 영상 크기를 조절할 수 있습니다.** 영상과 트랙 사이 경계를 위아래로 끌면 됩니다. 조절한 높이는 다음에 열 때도 그대로이고, 경계를 더블클릭하면 기본 크기로 돌아갑니다',
      '- **업데이트한 뒤 작업표시줄 고정이 풀리던 문제**를 고쳤습니다. 이번 업데이트 이후부터 유지됩니다 — 지금 풀려 있다면 한 번만 다시 고정해 주세요',
    ].join('\n'),
  },
  {
    title: 'v1.4.14',
    publishedAt: at('2026-08-13T06:10:13Z'),
    body: [
      '- **저장하지 않은 작업을 잃지 않습니다.** 변경한 채로 창을 닫으면 저장할지 묻고, 작업 중에는 1분마다 따로 백업을 남깁니다. 저장하지 못하고 종료됐다면 다음에 스튜디오에 들어올 때 되살릴지 물어봅니다',
      '- **프로젝트 파일(.yssproj)에 아이콘이 생겼고, 더블클릭하면 바로 열립니다**',
      '- **오디오 엔진이 멈춰도 작업이 남습니다.** 자동으로 다시 시작하고 트랙·클립·믹스를 되돌립니다. 녹음 중이었다면 그때까지 녹음된 소리도 되살립니다',
      '- **앱을 종료해도 오디오 엔진이 남아 오디오 인터페이스를 붙잡고 있던 문제**를 고쳤습니다. 다시 켰을 때 소리가 나지 않거나 다른 프로그램에서 인터페이스를 쓰지 못하던 원인입니다',
      '- 앱이 예기치 않게 종료되면 다음 실행 때 알려 드리고, 제보 창에 내용이 미리 채워집니다',
      '- 언어를 English 로 두면 파일 선택창과 경고창도 영어로 나옵니다',
    ].join('\n'),
  },
  {
    title: 'v1.4.15',
    publishedAt: at('2026-08-14T04:41:10Z'),
    body: [
      '- 스튜디오에서 영상을 접으면 영상만 사라지고 빈 공간이 그대로 남던 문제를 고쳤습니다. 이제 접은 만큼 타임라인이 넓어지고, 다시 펴면 조절해 둔 높이로 돌아옵니다',
    ].join('\n'),
  },
  {
    title: 'v1.4.16',
    publishedAt: at('2026-08-14T12:21:59Z'),
    body: [
      '- **오디오 엔진 안정성을 개선했습니다.** 오디오 인터페이스를 열지 못했을 때 재생·녹음이 조용히 멈추던 문제를 고쳤습니다 — 이제 기본 장치로 자동 전환하고 화면에 알립니다',
      '- .yssproj 파일을 더블클릭했을 때, 느린 컴퓨터에서 간혹 아무 반응이 없던 문제를 고쳤습니다',
    ].join('\n'),
  },
  {
    title: 'v1.4.17',
    publishedAt: at('2026-08-14T12:42:00Z'),
    body: [
      '- 라이브러리 재생 속도를 1% 단위로 세밀하게 조절할 수 있습니다 (기존 5% 단위)',
    ].join('\n'),
  },
  {
    title: 'v1.5.0',
    publishedAt: at('2026-08-15T02:48:36Z'),
    body: [
      '- **오디오 장치를 열지 못했을 때 재생·녹음이 멈추던 문제를 완전히 고쳤습니다.** 일부 ASIO 드라이버는 다른 프로그램이 이미 쓰고 있을 때 오류값 대신 예외를 던지는데, 그게 안 잡혀서 엔진이 통째로 죽는 경우가 있었습니다. 이제 기본 장치로 자동 전환하고 화면에 알립니다',
      '- **스튜디오에 들어가기만 해도 닫을 때 저장 안내가 뜨던 문제**를 고쳤습니다. 아무 편집도 하지 않았는데 저장하지 않은 변경사항이 있다고 뜨는 현상이었습니다',
      '- **ASIO 인터페이스 지원이 정상으로 돌아왔습니다.** 직전 세 버전(1.4.15~1.4.17)에서 빌드 설정 문제로 ASIO 목록이 빠진 채 배포됐습니다 — 그 사이 업데이트하며 ASIO가 사라졌던 분들은 이번 업데이트로 복구됩니다',
    ].join('\n'),
  },
  {
    title: 'v1.5.1',
    publishedAt: at('2026-08-15T13:17:17Z'),
    body: [
      '- **트랙을 확대하면 마디 안의 박(2·3·4번째)이 눈금으로 보입니다.** 칼박 편집에 도움이 되도록, 느린 곡은 더 확대하면 16분음표 단위까지 보입니다',
      '- **파형이 확대할수록 실제로 더 세밀하게 보입니다.** 예전엔 확대해도 같은 그림을 늘려 보여줄 뿐이었는데, 이제 화면 배율에 맞춰 다시 그립니다',
    ].join('\n'),
  },
];

const ENTER = ['\r', '\n', ''];
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) return reject(new Error('터미널에서 직접 실행해야 합니다.'));
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
      if (ENTER.includes(ch)) {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData);
        process.stdout.write('\n'); resolve(buf);
      } else if (ch === '') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
      else if (ch === '' || ch === '\b') buf = buf.slice(0, -1);
      else buf += ch;
    };
    stdin.on('data', onData);
  });
}

(async () => {
  const password = await askHidden(`${USERNAME} 비밀번호: `);

  const login = await fetch(`${BASE}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password }),
  });
  const ld = await login.json().catch(() => null);
  if (!login.ok || !ld?.token) {
    console.error('로그인 실패:', ld?.error || ('HTTP ' + login.status));
    process.exit(1);
  }
  const auth = { 'Authorization': 'Bearer ' + ld.token, 'Content-Type': 'application/json' };

  const listed = await fetch(`${BASE}/yts/notices`, { headers: auth });
  if (!listed.ok) { console.error('목록 실패: HTTP', listed.status); process.exit(1); }
  const have = new Map(((await listed.json()).notices || []).map(n => [n.title, n]));

  const day = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

  let made = 0, fixed = 0, skipped = 0;
  for (const e of ENTRIES) {
    const cur = have.get(e.title);

    if (!cur) {
      const res = await fetch(`${BASE}/yts/notices`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ kind: 'update', lang: 'ko', title: e.title, body: e.body,
                               publish: true, publishedAt: e.publishedAt }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { console.error(`  실패  ${e.title}:`, d?.error || ('HTTP ' + res.status)); process.exit(1); }
      console.log(`  올림  ${e.title}  (${day(d.notice.publishedAt)})`);
      made++;
      continue;
    }

    // 이미 있는 글의 게시 시각이 틀렸으면 맞춘다.
    // 워커 배포가 퍼지는 동안 올린 글은 옛 코드가 처리해 게시 시각이 '지금' 으로 박혔다.
    if (e.publishedAt && cur.publishedAt !== e.publishedAt) {
      const res = await fetch(`${BASE}/yts/notices/${cur.id}`, {
        method: 'PATCH', headers: auth,
        body: JSON.stringify({ publishedAt: e.publishedAt }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) { console.error(`  실패  ${e.title}:`, d?.error || ('HTTP ' + res.status)); process.exit(1); }
      console.log(`  고침  ${e.title}  ${day(cur.publishedAt)} -> ${day(d.notice.publishedAt)}`);
      fixed++;
      continue;
    }

    console.log(`  그대로 ${e.title}`);
    skipped++;
  }
  console.log(`\n새로 ${made}건 · 시각 고침 ${fixed}건 · 그대로 ${skipped}건`);
})();
