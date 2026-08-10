#!/usr/bin/env node
'use strict';
/**
 * 자동 릴리즈 스크립트.
 *
 * 사용법:
 *   $env:GH_TOKEN="ghp_..."         # PowerShell
 *   npm run release                 # patch bump (0.1.1 → 0.1.2)
 *   npm run release -- minor        # 0.1.x → 0.2.0
 *   npm run release -- major        # 0.x.x → 1.0.0
 *   npm run release -- --no-bump    # 현재 버전 그대로 재빌드/재업로드
 *   npm run release -- --no-git     # 커밋/푸시 스킵 (dist 재발행만)
 *
 * 하는 일:
 *   1) 로컬 clean 확인 (변경사항 있으면 중단)
 *   2) package.json 버전 bump
 *   3) 버전 커밋 + main push
 *   4) dist/ 잔재 정리 (latest.yml, *.blockmap)
 *   5) electron-builder 로 빌드 + GitHub Releases 업로드
 *   6) 릴리즈 assets 검증 → latest.yml 누락 시 수동 업로드
 *   7) 결과 URL 출력
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ── 설정 ────────────────────────────────────────
const REPO_OWNER = 'whalemindbass';
const REPO_NAME  = 'yt-separator-releases';   // 배포용 public 레포 (소스 없음)
const REPO       = `${REPO_OWNER}/${REPO_NAME}`;

// ── 인자 파싱 ───────────────────────────────────
const args      = process.argv.slice(2);
const bumpKind  = args.find(a => ['patch', 'minor', 'major'].includes(a)) || 'patch';
const skipBump  = args.includes('--no-bump');
const skipGit   = args.includes('--no-git');
const skipBuild = args.includes('--no-build');

// ── 유틸 ────────────────────────────────────────
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', dim: '\x1b[2m', x: '\x1b[0m' };
const log  = (m) => console.log(`${C.c}→${C.x} ${m}`);
const done = (m) => console.log(`${C.g}✓${C.x} ${m}`);
const warn = (m) => console.log(`${C.y}!${C.x} ${m}`);
const die  = (m) => { console.error(`${C.r}✗${C.x} ${m}`); process.exit(1); };

const sh    = (cmd, opts = {}) => execSync(cmd, { stdio: 'inherit', ...opts });
const shOut = (cmd)            => execSync(cmd, { encoding: 'utf-8' }).trim();

function ghApi(pathname, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: pathname,
      method,
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'yt-separator-release-script',
        Accept: 'application/vnd.github+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 300) return reject(new Error(`GH ${method} ${pathname} → ${res.statusCode}\n${buf}`));
        try { resolve(buf ? JSON.parse(buf) : null); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function uploadAsset(releaseId, name, filePath) {
  const stat = fs.statSync(filePath);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'uploads.github.com',
      path: `/repos/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'yt-separator-release-script',
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Upload ${name} failed: ${res.statusCode}\n${buf}`));
        resolve(JSON.parse(buf));
      });
    });
    req.on('error', reject);
    req.setTimeout(15 * 60 * 1000, () => req.destroy(new Error('upload timeout')));
    fs.createReadStream(filePath).pipe(req);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 180MB 업로드는 중간에 끊긴다 ('socket hang up'). 끊기면 릴리즈에 옛 파일이 남거나
 * 아무것도 없는 채로 latest.yml 만 올라가 자동 업데이트가 죽는다. 그래서 매 시도마다
 * 같은 이름의 에셋을 지우고 새로 올린 뒤, 크기가 로컬과 같은지 확인될 때까지 반복한다.
 */
async function putAsset(releaseId, name, filePath) {
  if (!fs.existsSync(filePath)) { warn(`${name} — 로컬 파일 없음, 건너뜀`); return false; }
  const want = fs.statSync(filePath).size;
  const delays = [3000, 8000, 20000, 45000];

  for (let attempt = 1; attempt <= delays.length + 1; attempt++) {
    try {
      // 이전 시도의 잔재를 먼저 치운다 (같은 이름이 남아 있으면 업로드가 422 로 거절된다)
      const rel = await ghApi(`/repos/${REPO}/releases/${releaseId}`);
      for (const a of rel.assets || []) {
        if (a.name === name) await ghApi(`/repos/${REPO}/releases/assets/${a.id}`, 'DELETE');
      }
      await uploadAsset(releaseId, name, filePath);

      // 업로드가 성공을 반환해도 크기를 다시 확인한다 — 잘린 채 올라가는 경우가 있다
      const after = await ghApi(`/repos/${REPO}/releases/${releaseId}`);
      const got = (after.assets || []).find(a => a.name === name);
      if (got && got.size === want) { done(`${name} 업로드 완료 (${(want / 1048576).toFixed(1)}MB)`); return true; }
      throw new Error(`크기 불일치 (GitHub ${got ? got.size : '없음'} vs 로컬 ${want})`);
    } catch (e) {
      const last = attempt > delays.length;
      if (last) throw new Error(`${name} 업로드 ${attempt}회 모두 실패: ${e.message}`);
      warn(`${name} 업로드 실패 (${attempt}/${delays.length + 1}): ${e.message} — ${delays[attempt - 1] / 1000}초 후 재시도`);
      await sleep(delays[attempt - 1]);
    }
  }
  return false;
}

// ── 환경 확인 ───────────────────────────────────
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) die('GH_TOKEN 환경변수가 필요합니다.\n  PowerShell: $env:GH_TOKEN="ghp_..."\n  bash:       export GH_TOKEN="ghp_..."');

// ── 메인 ────────────────────────────────────────
(async () => {
  // 1) git clean 검사
  if (!skipGit) {
    const st = shOut('git status --porcelain');
    if (st) die(`로컬에 커밋되지 않은 변경사항이 있어요:\n${st}\n먼저 커밋하거나 --no-git 옵션을 사용하세요.`);
    done('git working tree clean');
  }

  // 2) 버전 bump
  if (!skipBump) {
    log(`버전 bump (${bumpKind})...`);
    sh(`npm version ${bumpKind} --no-git-tag-version`);
  }
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
  const version = pkg.version;
  const tag = `v${version}`;
  done(`대상 버전: ${tag}`);

  // 3) 버전 커밋 + push
  if (!skipGit && !skipBump) {
    log('버전 커밋 & push...');
    sh('git add package.json package-lock.json');
    sh(`git commit -m "Release ${tag}"`);
    sh('git push origin main');
    done('git push 완료');
  }

  // 4) dist/ 잔재 정리 (latest.yml, blockmap)
  if (!skipBuild) {
    log('dist 정리...');
    if (fs.existsSync('dist')) {
      for (const f of ['latest.yml', ...fs.readdirSync('dist').filter(x => x.endsWith('.blockmap'))]) {
        try { fs.unlinkSync(path.join('dist', f)); } catch {}
      }
    }
  }

  // 5) 빌드 + electron-builder publish
  if (!skipBuild) {
    log('electron-builder 빌드 + 업로드 (몇 분 소요)...');
    try {
      sh('npx electron-builder --win --publish always', {
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      });
    } catch (e) {
      warn(`electron-builder 종료 코드 비정상 (일부 asset 업로드는 성공했을 수 있음). 검증 계속...`);
    }
  }

  // 6) 릴리즈 존재 확인
  log(`릴리즈 ${tag} 검증...`);
  let release;
  try {
    release = await ghApi(`/repos/${REPO}/releases/tags/${tag}`);
  } catch (e) {
    die(`릴리즈 ${tag} 를 찾을 수 없어요: ${e.message}`);
  }
  if (!release?.id) die(`릴리즈 ${tag} id 획득 실패`);

  // 7) latest.yml 준비 (없으면 NSIS만 재빌드해서 재생성)
  const localLatest = path.join('dist', 'latest.yml');
  if (!fs.existsSync(localLatest)) {
    warn('dist/latest.yml 누락 — NSIS만 재빌드하여 재생성...');
    try {
      sh('npx electron-builder --win nsis --publish never', {
        env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
      });
    } catch { /* proceed */ }
  }
  if (!fs.existsSync(localLatest)) die('latest.yml 재생성 실패');

  // 8) Assets 정합성 검사 — Setup.exe의 sha가 latest.yml과 다르면 교체
  //    (electron-builder 크래시로 latest.yml 재생성 후에도 GitHub의 exe는 옛 sha일 수 있음)
  const latestYml = fs.readFileSync(localLatest, 'utf-8');
  const latestSize = parseInt((latestYml.match(/^\s*size:\s*(\d+)/m) || [])[1] || '0', 10);
  // 이름은 package.json 의 build.nsis/portable artifactName 을 따른다.
  // (여기가 실제 산출물과 어긋나면 정합성 검사가 통째로 스킵된다)
  const product          = pkg.build?.productName || pkg.name;
  const expectedSetup    = `${product}-Setup.exe`;
  const expectedBlockmap = `${expectedSetup}.blockmap`;
  const expectedPortable = `${product}.exe`;
  const localSetup    = path.join('dist', expectedSetup);
  const localBlockmap = path.join('dist', expectedBlockmap);
  const localPortable = path.join('dist', expectedPortable);

  const assets = release.assets || [];
  const findAsset = (name) => assets.find(a => a.name === name);

  // Setup.exe — 없거나 latest.yml 과 크기가 다르면 올린다
  const setupAsset = findAsset(expectedSetup);
  if (!setupAsset) {
    log(`${expectedSetup} 업로드...`);
    await putAsset(release.id, expectedSetup, localSetup);
  } else if (latestSize && setupAsset.size !== latestSize) {
    warn(`Setup.exe 크기 불일치 (GitHub ${setupAsset.size} vs latest.yml ${latestSize}) — 교체`);
    await putAsset(release.id, expectedSetup, localSetup);
  }

  // Blockmap (차등 다운로드용)
  if (!findAsset(expectedBlockmap)) await putAsset(release.id, expectedBlockmap, localBlockmap);

  // Portable
  if (!findAsset(expectedPortable)) await putAsset(release.id, expectedPortable, localPortable);

  // latest.yml — 항상 최신으로 덮어쓴다. 이게 자동 업데이트의 기준점이라 마지막에 올린다.
  await putAsset(release.id, 'latest.yml', localLatest);

  // 최종 점검 — 여기서 통과해야 사용자 자동 업데이트가 실제로 동작한다
  log('최종 점검...');
  const final = await ghApi(`/repos/${REPO}/releases/${release.id}`);
  const finalAssets = final.assets || [];
  const problems = [];
  for (const [name, local] of [[expectedSetup, localSetup], [expectedBlockmap, localBlockmap], ['latest.yml', localLatest]]) {
    const a = finalAssets.find(x => x.name === name);
    if (!a) { problems.push(`${name} 없음`); continue; }
    if (fs.existsSync(local) && a.size !== fs.statSync(local).size) problems.push(`${name} 크기 불일치 (GitHub ${a.size} vs 로컬 ${fs.statSync(local).size})`);
  }
  const setupFinal = finalAssets.find(x => x.name === expectedSetup);
  if (setupFinal && latestSize && setupFinal.size !== latestSize) problems.push(`${expectedSetup} 가 latest.yml 의 size 와 다름 — 자동 업데이트가 해시 검증에서 실패한다`);
  if (problems.length) {
    for (const p of problems) warn(p);
    die(`릴리즈 ${tag} 가 온전하지 않다. 위 항목을 고치기 전에는 배포된 것으로 보지 말 것.`);
  }
  done('에셋 정합성 확인');

  // 릴리즈 노트가 비어 있으면 앱의 업데이트 창이 엉뚱한 것을 보여준다.
  //   본문이 비면 electron-updater 가 GitHub atom 피드로 떨어지고, 거기서는 태그가 가리키는
  //   커밋 메시지가 나온다 — releases 레포의 아무 커밋 메시지가 사용자에게 패치 노트로 뜬다.
  //   실제로 v1.4.10 에서 "docs: point download links..." 가 그렇게 노출됐다.
  if (!String(final.body || '').trim()) {
    warn(`릴리즈 노트가 비어 있다 — 앱 업데이트 창에 엉뚱한 커밋 메시지가 뜬다. 지금 채워라:`);
    console.log(`   ${C.dim}gh release edit ${tag} --repo ${REPO} --title "Dr.studio ${tag}" --notes-file <파일>${C.x}`);
  }

  console.log();
  done(`릴리즈 ${tag} 완료`);
  console.log(`   ${C.dim}https://github.com/${REPO}/releases/tag/${tag}${C.x}`);
  console.log(`\n다음 단계:`);
  console.log(`   1) 설치된 이전 버전 실행 → 3초 후 우측 상단 배지 확인`);
  console.log(`   2) 배지 클릭 → 다이얼로그 → 다운로드 → 재시작 & 설치`);
})().catch(e => die(e.stack || e.message));
