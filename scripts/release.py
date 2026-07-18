#!/usr/bin/env python3
"""
YT Separator Desktop — 자동 릴리즈 스크립트.

기능:
  1) GitHub Personal Access Token 입력 (getpass 마스킹 or GH_TOKEN 환경변수)
  2) 릴리즈 레벨 선택 (patch / minor / major)
  3) 릴리즈 노트 입력 (기존 릴리즈 노트가 있으면 참고로 보여주고 새로 입력)
  4) 버전 bump → git commit/push → electron-builder 빌드 → GitHub Release 생성 → 자산 업로드까지 자동
  5) 빌드 후반부 크래시로 latest.yml 누락 시 NSIS 재빌드로 자동 복구
  6) Setup.exe / blockmap / Portable.exe / latest.yml 자산 정합성 검증 후 업로드

사용:
  python scripts/release.py
"""
from __future__ import annotations

import getpass
import http.client
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# ── 설정 ────────────────────────────────────────────
REPO_OWNER = "whalemindbass"
REPO_NAME  = "yt-separator-desktop"
REPO       = f"{REPO_OWNER}/{REPO_NAME}"
PROJECT_DIR = Path(__file__).resolve().parent.parent

# ── 컬러 (Windows 지원 포함) ─────────────────────────
if sys.platform == "win32":
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        kernel32.SetConsoleMode(kernel32.GetStdHandle(-11), 7)
    except Exception:
        pass

class C:
    R    = "\x1b[31m"
    G    = "\x1b[32m"
    Y    = "\x1b[33m"
    Cyan = "\x1b[36m"
    B    = "\x1b[1m"
    Dim  = "\x1b[2m"
    X    = "\x1b[0m"

def log(msg):  print(f"{C.Cyan}→{C.X} {msg}")
def ok(msg):   print(f"{C.G}✓{C.X} {msg}")
def warn(msg): print(f"{C.Y}!{C.X} {msg}")
def die(msg):
    print(f"{C.R}✗{C.X} {msg}", file=sys.stderr)
    sys.exit(1)

# ── 셸 실행 헬퍼 ────────────────────────────────────
def sh(cmd, capture=False, cwd=None, env=None, check=True):
    print(f"{C.Dim}$ {cmd}{C.X}")
    if capture:
        return subprocess.check_output(cmd, shell=True, text=True, cwd=cwd or PROJECT_DIR, env=env).strip()
    result = subprocess.run(cmd, shell=True, cwd=cwd or PROJECT_DIR, env=env)
    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, cmd)
    return result.returncode

# ── GitHub API ─────────────────────────────────────
def _gh_headers(token, content_type=None, content_length=None):
    h = {
        "Authorization": f"token {token}",
        "User-Agent":    "yt-separator-release-py",
        "Accept":        "application/vnd.github+json",
    }
    if content_type:   h["Content-Type"] = content_type
    if content_length: h["Content-Length"] = str(content_length)
    return h

def gh_api(token, method, path, body=None, expect_status=None):
    conn = http.client.HTTPSConnection("api.github.com", timeout=60)
    body_bytes = json.dumps(body).encode() if body else None
    headers = _gh_headers(token, content_type=("application/json" if body else None))
    conn.request(method, path, body=body_bytes, headers=headers)
    res = conn.getresponse()
    data = res.read().decode()
    conn.close()
    if expect_status and res.status not in expect_status:
        raise RuntimeError(f"GH {method} {path} → {res.status}\n{data}")
    if res.status >= 400:
        raise RuntimeError(f"GH {method} {path} → {res.status}\n{data}")
    return json.loads(data) if data else None

def upload_asset(token, release_id, remote_name, filepath: Path):
    size = filepath.stat().st_size
    conn = http.client.HTTPSConnection("uploads.github.com", timeout=600)
    with open(filepath, "rb") as f:
        conn.request(
            "POST",
            f"/repos/{REPO}/releases/{release_id}/assets?name={remote_name}",
            body=f,
            headers=_gh_headers(token, content_type="application/octet-stream", content_length=size),
        )
        res = conn.getresponse()
        data = res.read().decode()
    conn.close()
    if res.status >= 400:
        raise RuntimeError(f"Upload {remote_name} → {res.status}\n{data}")
    return json.loads(data)

# ── 프롬프트 ────────────────────────────────────────
def prompt_token():
    token = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if token:
        print(f"{C.Dim}환경변수 GH_TOKEN 사용{C.X}")
        return token
    print()
    tok = getpass.getpass("GitHub Personal Access Token (repo scope): ").strip()
    if not tok:
        die("토큰이 비어있어요.")
    return tok

def prompt_bump():
    print()
    print(f"{C.B}릴리즈 레벨 선택{C.X}")
    print("  1) patch  (0.1.2 → 0.1.3)   버그 수정 · UI 개선 등")
    print("  2) minor  (0.1.x → 0.2.0)   새 기능 추가")
    print("  3) major  (0.x.x → 1.0.0)   호환 깨는 변경")
    while True:
        c = input("선택 [1]: ").strip() or "1"
        if c == "1": return "patch"
        if c == "2": return "minor"
        if c == "3": return "major"
        print("1 / 2 / 3 중 선택")

def prompt_multiline(header):
    print()
    print(f"{C.B}{header}{C.X}")
    print(f"{C.Dim}여러 줄 입력. 빈 줄 두 번 연속 입력하면 종료. (Ctrl+C로 중단){C.X}")
    lines = []
    blank_streak = 0
    while True:
        try:
            line = input()
        except EOFError:
            break
        if line == "":
            blank_streak += 1
            if blank_streak >= 2:
                if lines and lines[-1] == "":
                    lines.pop()  # 마지막 blank 제거
                break
        else:
            blank_streak = 0
        lines.append(line)
    return "\n".join(lines).strip()

# ── 메인 ────────────────────────────────────────────
def main():
    print(f"\n{C.Cyan}{C.B}▶ YT Separator 자동 릴리즈{C.X}")

    # 1. Token
    token = prompt_token()

    # 2. 현재 버전 / git 상태
    pkg_path = PROJECT_DIR / "package.json"
    current_version = json.loads(pkg_path.read_text(encoding="utf-8"))["version"]
    print(f"\n현재 버전: {C.B}v{current_version}{C.X}")

    try:
        st = sh("git status --porcelain", capture=True)
    except subprocess.CalledProcessError:
        die("git status 실패 — repo인지 확인")
    if st:
        print(f"\n{C.Y}커밋되지 않은 변경사항:{C.X}\n{st}")
        if input("\n그대로 진행? (y/N): ").strip().lower() != "y":
            print("중단.")
            return

    # 3. 릴리즈 레벨
    kind = prompt_bump()

    # 4. 이전 릴리즈 노트 조회 (참고용)
    prev_notes = None
    try:
        prev = gh_api(token, "GET", f"/repos/{REPO}/releases/tags/v{current_version}")
        prev_notes = (prev or {}).get("body", "").strip() or None
    except RuntimeError:
        prev_notes = None

    if prev_notes:
        print(f"\n{C.Dim}── 이전 릴리즈 v{current_version} 노트 (참고) ──{C.X}")
        print(prev_notes)
        print(f"{C.Dim}────────────────────────────{C.X}")

    # 5. 새 노트 입력
    notes = prompt_multiline(f"새 릴리즈 노트 입력")
    if not notes:
        notes = f"Release"
        warn(f"빈 노트로 진행 — 기본값 '{notes}' 사용")

    # 6. 확인
    print()
    print(f"{C.B}요약{C.X}")
    print(f"  · 버전:  v{current_version} → {kind} bump")
    print(f"  · 노트:  {notes[:80]}{'...' if len(notes) > 80 else ''}")
    print(f"  · 리포:  {REPO}")
    if input("\n진행할까요? (Y/n): ").strip().lower() == "n":
        print("중단.")
        return

    # 7. 버전 bump
    log(f"버전 bump ({kind})...")
    sh(f"npm version {kind} --no-git-tag-version")
    new_version = json.loads(pkg_path.read_text(encoding="utf-8"))["version"]
    tag = f"v{new_version}"
    ok(f"새 버전: {tag}")

    # 8. git commit + push
    log("git commit + push...")
    sh("git add package.json package-lock.json")
    sh(f'git commit -m "Release {tag}"')
    sh("git push origin main")
    ok("git push 완료")

    # 9. dist 정리
    log("dist 정리...")
    dist = PROJECT_DIR / "dist"
    if dist.exists():
        for f in dist.glob("latest.yml"):
            f.unlink(missing_ok=True)
        for f in dist.glob("*.blockmap"):
            f.unlink(missing_ok=True)

    # 10. 빌드 (--publish never — 업로드는 스크립트가 직접 처리)
    log("electron-builder 빌드 (몇 분)...")
    env = os.environ.copy()
    env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
    try:
        sh("npx electron-builder --win --publish never", env=env)
    except subprocess.CalledProcessError:
        warn("빌드 종료 코드 비정상 — 결과물 확인 후 계속")

    # 11. latest.yml 검증 (없으면 NSIS만 재빌드)
    latest_yml = dist / "latest.yml"
    if not latest_yml.exists():
        warn("latest.yml 없음 → NSIS만 재빌드해서 재생성")
        sh("npx electron-builder --win nsis --publish never", env=env, check=False)
    if not latest_yml.exists():
        die("latest.yml 재생성 실패")

    setup    = dist / f"YT Separator-{new_version}-Setup.exe"
    blockmap = dist / f"YT Separator-{new_version}-Setup.exe.blockmap"
    portable = dist / f"YT Separator-{new_version}-Portable.exe"

    if not setup.exists():
        die(f"{setup.name} 파일 없음")

    # 12. 릴리즈 생성 (이미 있으면 재사용)
    log(f"GitHub Release {tag} 생성...")
    try:
        release = gh_api(token, "POST", f"/repos/{REPO}/releases", body={
            "tag_name": tag,
            "name": new_version,
            "body": notes,
            "draft": False,
            "prerelease": False,
        })
    except RuntimeError as e:
        if "already_exists" in str(e):
            warn(f"{tag} 이미 존재 — 기존 릴리즈 사용")
            release = gh_api(token, "GET", f"/repos/{REPO}/releases/tags/{tag}")
            # 기존 노트 갱신
            release = gh_api(token, "PATCH", f"/repos/{REPO}/releases/{release['id']}", body={"body": notes})
        else:
            die(str(e))
    release_id = release["id"]
    ok(f"Release id={release_id}")

    # 13. 기존 asset 전부 삭제 → 새 asset 업로드 (sha 정합성 보장)
    log("기존 assets 정리...")
    for a in release.get("assets", []):
        try:
            gh_api(token, "DELETE", f"/repos/{REPO}/releases/assets/{a['id']}")
            print(f"  {C.Dim}deleted{C.X} {a['name']}")
        except Exception as e:
            warn(f"삭제 실패 {a['name']}: {e}")

    remote_setup    = f"YT-Separator-{new_version}-Setup.exe"
    remote_blockmap = f"YT-Separator-{new_version}-Setup.exe.blockmap"
    remote_portable = f"YT-Separator-{new_version}-Portable.exe"

    uploads = [
        (remote_setup,    setup),
        (remote_blockmap, blockmap),
        ("latest.yml",    latest_yml),
    ]
    if portable.exists():
        uploads.append((remote_portable, portable))

    for name, path_local in uploads:
        if not path_local.exists():
            warn(f"{name} 로컬 파일 없음 — 스킵")
            continue
        size_mb = path_local.stat().st_size / 1024 / 1024
        log(f"업로드 {name} ({size_mb:.1f} MB)...")
        t0 = time.time()
        try:
            upload_asset(token, release_id, name, path_local)
            ok(f"{name}  ({time.time()-t0:.1f}s)")
        except Exception as e:
            die(f"업로드 실패 {name}: {e}")

    print()
    ok(f"릴리즈 {tag} 완료")
    print(f"   {C.Dim}https://github.com/{REPO}/releases/tag/{tag}{C.X}")
    print(f"\n다음 단계 — 이전 버전 실행 → 3초 후 우측 상단 배지 확인")
    print()

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n중단됨.")
        sys.exit(1)
    except Exception as e:
        die(f"예외: {e}")
