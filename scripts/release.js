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
    fs.createReadStream(filePath).pipe(req);
  });
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
  const expectedSetup    = `YT-Separator-${version}-Setup.exe`;
  const expectedBlockmap = `${expectedSetup}.blockmap`;
  const expectedPortable = `YT-Separator-${version}-Portable.exe`;
  const localSetup    = path.join('dist', `YT Separator-${version}-Setup.exe`);
  const localBlockmap = `${localSetup}.blockmap`;
  const localPortable = path.join('dist', `YT Separator-${version}-Portable.exe`);

  const assets = release.assets || [];
  const findAsset = (name) => assets.find(a => a.name === name);

  // Setup.exe 정합성
  const setupAsset = findAsset(expectedSetup);
  if (setupAsset && latestSize && setupAsset.size !== latestSize) {
    warn(`Setup.exe 크기 불일치 (GitHub ${setupAsset.size} vs latest.yml ${latestSize}) — 교체`);
    await ghApi(`/repos/${REPO}/releases/assets/${setupAsset.id}`, 'DELETE');
    await uploadAsset(release.id, expectedSetup, localSetup);
    done(`${expectedSetup} 교체 완료`);
  } else if (!setupAsset && fs.existsSync(localSetup)) {
    log(`${expectedSetup} 업로드...`);
    await uploadAsset(release.id, expectedSetup, localSetup);
    done(`${expectedSetup} 업로드 완료`);
  }

  // Blockmap
  if (!findAsset(expectedBlockmap) && fs.existsSync(localBlockmap)) {
    log(`${expectedBlockmap} 업로드...`);
    await uploadAsset(release.id, expectedBlockmap, localBlockmap);
    done(`${expectedBlockmap} 업로드 완료`);
  }

  // Portable.exe (있으면 참고용)
  if (!findAsset(expectedPortable) && fs.existsSync(localPortable)) {
    log(`${expectedPortable} 업로드...`);
    await uploadAsset(release.id, expectedPortable, localPortable);
    done(`${expectedPortable} 업로드 완료`);
  }

  // latest.yml
  const latestAsset = findAsset('latest.yml');
  if (latestAsset) {
    // 갱신 위해 삭제 후 재업로드
    await ghApi(`/repos/${REPO}/releases/assets/${latestAsset.id}`, 'DELETE');
  }
  await uploadAsset(release.id, 'latest.yml', localLatest);
  done('latest.yml 업로드 완료');

  console.log();
  done(`릴리즈 ${tag} 완료`);
  console.log(`   ${C.dim}https://github.com/${REPO}/releases/tag/${tag}${C.x}`);
  console.log(`\n다음 단계:`);
  console.log(`   1) 설치된 이전 버전 실행 → 3초 후 우측 상단 배지 확인`);
  console.log(`   2) 배지 클릭 → 다이얼로그 → 다운로드 → 재시작 & 설치`);
})().catch(e => die(e.stack || e.message));
