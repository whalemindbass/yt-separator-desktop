#!/usr/bin/env python3
"""
YT Separator 자동 릴리즈 GUI.

기능:
  - GitHub Token / 프로젝트 폴더를 %APPDATA%\\YT-Release 에 저장 → 다음 실행 시 자동 로드
  - 릴리즈 레벨 (patch/minor/major) 라디오 선택
  - 릴리즈 노트 입력 (여러 줄)
  - "빌드 & 릴리즈" 클릭 시:
      npm version → git commit/push → electron-builder → GitHub Release 생성 → assets 업로드
  - 진행 로그를 창 안 실시간 표시
  - 빌드 후반부 크래시로 latest.yml 누락 시 NSIS 재빌드로 자동 복구

exe 빌드:
  pip install pyinstaller
  pyinstaller --onefile --noconsole --name YT-Release scripts/release_gui.py
"""
from __future__ import annotations

import http.client
import json
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, scrolledtext, ttk

REPO_OWNER = "whalemindbass"
REPO_NAME  = "yt-separator-desktop"
REPO       = f"{REPO_OWNER}/{REPO_NAME}"

# 설정 저장 폴더 — exe로 빌드해도 사용자 %APPDATA%에 유지
if sys.platform == "win32":
    STATE_DIR = Path(os.environ.get("APPDATA", str(Path.home()))) / "YT-Release"
else:
    STATE_DIR = Path.home() / ".yt-release"
STATE_DIR.mkdir(parents=True, exist_ok=True)

TOKEN_FILE  = STATE_DIR / "token.txt"
CONFIG_FILE = STATE_DIR / "config.json"


def load_config() -> dict:
    try:
        if CONFIG_FILE.exists():
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def save_config(cfg: dict):
    try:
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception as e:
        print(f"config save failed: {e}", file=sys.stderr)


# ── GitHub API ──────────────────────────────────────
def gh_api(token, method, path, body=None):
    conn = http.client.HTTPSConnection("api.github.com", timeout=60)
    body_bytes = json.dumps(body).encode() if body else None
    headers = {
        "Authorization": f"token {token}",
        "User-Agent":    "yt-separator-release-gui",
        "Accept":        "application/vnd.github+json",
    }
    if body:
        headers["Content-Type"] = "application/json"
    conn.request(method, path, body=body_bytes, headers=headers)
    res = conn.getresponse()
    data = res.read().decode()
    conn.close()
    if res.status >= 400:
        raise RuntimeError(f"GH {method} {path} → {res.status}\n{data}")
    return json.loads(data) if data else None


def upload_asset(token, release_id, remote_name, filepath: Path):
    size = filepath.stat().st_size
    conn = http.client.HTTPSConnection("uploads.github.com", timeout=1200)
    headers = {
        "Authorization":  f"token {token}",
        "User-Agent":     "yt-separator-release-gui",
        "Content-Type":   "application/octet-stream",
        "Content-Length": str(size),
    }
    with open(filepath, "rb") as f:
        conn.request("POST",
                     f"/repos/{REPO}/releases/{release_id}/assets?name={remote_name}",
                     body=f, headers=headers)
        res = conn.getresponse()
        data = res.read().decode()
    conn.close()
    if res.status >= 400:
        raise RuntimeError(f"Upload {remote_name} → {res.status}\n{data}")
    return json.loads(data)


# ── GUI ──────────────────────────────────────────────
class ReleaseApp:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.cfg  = load_config()

        root.title("YT Separator 자동 릴리즈")
        root.geometry("820x760")
        root.minsize(640, 560)

        self._build_ui()
        self._load_state()
        self._refresh_version()

    # ── UI 구성 ─────────────────────────────────────
    def _build_ui(self):
        style = ttk.Style()
        try: style.theme_use("vista")
        except Exception: pass

        top = ttk.Frame(self.root, padding=12)
        top.pack(fill="both", expand=True)

        # 프로젝트 폴더
        row = ttk.Frame(top); row.pack(fill="x", pady=(0, 8))
        ttk.Label(row, text="프로젝트 폴더", width=14).pack(side="left")
        self.project_var = tk.StringVar()
        ttk.Entry(row, textvariable=self.project_var).pack(side="left", fill="x", expand=True, padx=(0, 6))
        ttk.Button(row, text="찾아보기…", command=self._pick_project).pack(side="left")

        # GitHub Token
        row = ttk.Frame(top); row.pack(fill="x", pady=(0, 8))
        ttk.Label(row, text="GitHub Token", width=14).pack(side="left")
        self.token_var = tk.StringVar()
        self.token_entry = ttk.Entry(row, textvariable=self.token_var, show="•")
        self.token_entry.pack(side="left", fill="x", expand=True, padx=(0, 6))
        self.show_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(row, text="표시", variable=self.show_var,
                        command=self._toggle_show).pack(side="left", padx=(0, 6))
        ttk.Button(row, text="저장", command=self._save_state).pack(side="left")

        # 현재 버전
        row = ttk.Frame(top); row.pack(fill="x", pady=(0, 8))
        ttk.Label(row, text="현재 버전", width=14).pack(side="left")
        self.version_label = ttk.Label(row, text="—")
        self.version_label.pack(side="left")
        ttk.Button(row, text="↻", width=3, command=self._refresh_version).pack(side="left", padx=(6, 0))

        # 릴리즈 레벨
        row = ttk.Frame(top); row.pack(fill="x", pady=(0, 12))
        ttk.Label(row, text="릴리즈 레벨", width=14).pack(side="left")
        self.bump_var = tk.StringVar(value=self.cfg.get("bump", "patch"))
        for k, lbl in [("patch", "patch  (0.1.2 → 0.1.3)"),
                       ("minor", "minor  (0.1.x → 0.2.0)"),
                       ("major", "major  (0.x.x → 1.0.0)")]:
            ttk.Radiobutton(row, text=lbl, variable=self.bump_var, value=k).pack(side="left", padx=(0, 12))

        # 릴리즈 노트
        ttk.Label(top, text="릴리즈 노트").pack(anchor="w")
        self.notes_txt = scrolledtext.ScrolledText(top, height=9, wrap="word")
        self.notes_txt.pack(fill="both", expand=False, pady=(4, 12))

        # 버튼
        row = ttk.Frame(top); row.pack(fill="x", pady=(0, 12))
        self.release_btn = ttk.Button(row, text="  ▶  빌드 & 릴리즈 실행  ",
                                      command=self._start_release)
        self.release_btn.pack(side="left")
        ttk.Button(row, text="로그 지우기", command=self._clear_log).pack(side="left", padx=(8, 0))
        ttk.Button(row, text="이전 노트 불러오기", command=self._load_prev_notes).pack(side="left", padx=(8, 0))

        # 로그
        ttk.Label(top, text="진행 상황").pack(anchor="w")
        self.log_txt = scrolledtext.ScrolledText(top, height=18, wrap="word",
                                                 state="disabled",
                                                 font=("Consolas", 9))
        self.log_txt.pack(fill="both", expand=True, pady=(4, 0))

    # ── 상태 저장/로드 ──────────────────────────────
    def _load_state(self):
        # 토큰 로드
        if TOKEN_FILE.exists():
            try:
                self.token_var.set(TOKEN_FILE.read_text(encoding="utf-8").strip())
                self._log(f"[state] 토큰 로드됨 ({TOKEN_FILE})")
            except Exception as e:
                self._log(f"[state] 토큰 로드 실패: {e}")
        # 프로젝트 폴더
        saved_proj = self.cfg.get("project_dir")
        if saved_proj and Path(saved_proj).exists():
            self.project_var.set(saved_proj)
        else:
            # exe 옆에 package.json이 있으면 자동 감지
            here = self._app_dir()
            if (here / "package.json").exists():
                self.project_var.set(str(here))
            elif (here.parent / "package.json").exists():
                self.project_var.set(str(here.parent))

    def _save_state(self):
        # 토큰 파일
        try:
            TOKEN_FILE.write_text(self.token_var.get().strip(), encoding="utf-8")
        except Exception as e:
            messagebox.showerror("저장 실패", f"토큰 저장 실패: {e}")
            return
        # 나머지 설정
        self.cfg["project_dir"] = self.project_var.get().strip()
        self.cfg["bump"]        = self.bump_var.get()
        save_config(self.cfg)
        self._log(f"[state] 저장됨 → {TOKEN_FILE.parent}")
        messagebox.showinfo("저장 완료", f"설정이 저장되었어요.\n{TOKEN_FILE.parent}")

    def _app_dir(self) -> Path:
        if getattr(sys, "frozen", False):
            return Path(sys.executable).resolve().parent
        return Path(__file__).resolve().parent

    # ── 유틸 ────────────────────────────────────────
    def _toggle_show(self):
        self.token_entry.config(show="" if self.show_var.get() else "•")

    def _pick_project(self):
        d = filedialog.askdirectory(title="프로젝트 폴더 선택 (package.json 있는 곳)")
        if d:
            self.project_var.set(d)
            self._refresh_version()

    def _project(self) -> Path:
        return Path(self.project_var.get().strip())

    def _refresh_version(self):
        try:
            pkg = self._project() / "package.json"
            if pkg.exists():
                v = json.loads(pkg.read_text(encoding="utf-8"))["version"]
                self.version_label.config(text=f"v{v}")
            else:
                self.version_label.config(text="(package.json 없음)")
        except Exception as e:
            self.version_label.config(text=f"오류: {e}")

    def _clear_log(self):
        self.log_txt.config(state="normal")
        self.log_txt.delete("1.0", "end")
        self.log_txt.config(state="disabled")

    def _log(self, msg=""):
        def _append():
            self.log_txt.config(state="normal")
            self.log_txt.insert("end", msg + "\n")
            self.log_txt.see("end")
            self.log_txt.config(state="disabled")
        self.root.after(0, _append)

    def _ask_ui(self, fn):
        """스레드에서 GUI 다이얼로그 열기."""
        result = [None]
        ev = threading.Event()
        def wrap():
            result[0] = fn()
            ev.set()
        self.root.after(0, wrap)
        ev.wait()
        return result[0]

    def _load_prev_notes(self):
        """직전 태그의 릴리즈 노트를 불러와 편집란에 채움."""
        token = self.token_var.get().strip()
        if not token:
            messagebox.showwarning("토큰 필요", "토큰이 필요해요.")
            return
        try:
            pkg = self._project() / "package.json"
            cur = json.loads(pkg.read_text(encoding="utf-8"))["version"]
            rel = gh_api(token, "GET", f"/repos/{REPO}/releases/tags/v{cur}")
            body = (rel or {}).get("body", "").strip()
            if body:
                self.notes_txt.delete("1.0", "end")
                self.notes_txt.insert("1.0", body)
                self._log(f"[prev] v{cur} 노트 로드됨")
            else:
                messagebox.showinfo("빈 노트", f"v{cur} 릴리즈에 노트가 없어요.")
        except Exception as e:
            messagebox.showerror("불러오기 실패", str(e))

    # ── 릴리즈 스레드 ───────────────────────────────
    def _start_release(self):
        token = self.token_var.get().strip()
        if not token:
            messagebox.showerror("토큰 필요", "GitHub Token을 먼저 입력하고 저장하세요.")
            return
        project = self._project()
        if not (project / "package.json").exists():
            messagebox.showerror("프로젝트 오류", f"{project}에 package.json이 없어요.")
            return
        notes = self.notes_txt.get("1.0", "end").strip()
        if not notes:
            if not messagebox.askyesno("빈 노트", "릴리즈 노트가 비어있어요.\n기본 문구로 진행할까요?"):
                return
            notes = "Release"
        kind = self.bump_var.get()
        cur_v = json.loads((project / "package.json").read_text(encoding="utf-8"))["version"]
        if not messagebox.askyesno("확인",
            f"현재 v{cur_v} → {kind} bump 후 GitHub Release까지 자동 진행합니다.\n\n계속할까요?"):
            return

        # 저장 (다음 실행에도 유지)
        self._save_state()

        self.release_btn.config(state="disabled")
        self._log("─" * 60)
        threading.Thread(
            target=self._safe_run,
            args=(token, kind, notes, project),
            daemon=True,
        ).start()

    def _safe_run(self, token, kind, notes, project):
        try:
            self._release_flow(token, kind, notes, project)
        except Exception as e:
            self._log(f"✗ 예외: {e}")
            import traceback
            for line in traceback.format_exc().splitlines():
                self._log("  " + line)
        finally:
            self.root.after(0, lambda: self.release_btn.config(state="normal"))
            self.root.after(0, self._refresh_version)

    def _sh(self, cmd, cwd, env=None):
        self._log(f"$ {cmd}")
        proc = subprocess.Popen(
            cmd, shell=True, cwd=cwd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace",
            bufsize=1,
        )
        for line in proc.stdout:
            self._log(line.rstrip())
        code = proc.wait()
        if code != 0:
            raise RuntimeError(f"exit {code}: {cmd}")

    def _release_flow(self, token, kind, notes, project: Path):
        pkg_path = project / "package.json"

        # 1) git 상태
        st = subprocess.run("git status --porcelain", shell=True, cwd=project,
                            capture_output=True, text=True).stdout.strip()
        if st:
            def _ask():
                return messagebox.askyesno(
                    "변경사항 있음",
                    f"커밋되지 않은 변경사항이 있어요:\n\n{st[:400]}\n\n그대로 진행할까요?"
                )
            if not self._ask_ui(_ask):
                self._log("중단됨.")
                return

        # 2) 버전 bump
        self._log(f"→ 버전 bump ({kind})...")
        self._sh(f"npm version {kind} --no-git-tag-version", cwd=project)
        new_v = json.loads(pkg_path.read_text(encoding="utf-8"))["version"]
        tag = f"v{new_v}"
        self._log(f"✓ {tag}")

        # 3) commit + push
        self._log("→ git commit + push...")
        self._sh("git add package.json package-lock.json", cwd=project)
        self._sh(f'git commit -m "Release {tag}"', cwd=project)
        self._sh("git push origin main", cwd=project)

        # 4) dist 정리
        self._log("→ dist 정리...")
        dist = project / "dist"
        if dist.exists():
            for f in dist.glob("latest.yml"):
                f.unlink(missing_ok=True)
            for f in dist.glob("*.blockmap"):
                f.unlink(missing_ok=True)

        # 5) 빌드
        self._log("→ electron-builder 빌드 (몇 분 소요)...")
        env = os.environ.copy()
        env["CSC_IDENTITY_AUTO_DISCOVERY"] = "false"
        try:
            self._sh("npx electron-builder --win --publish never", cwd=project, env=env)
        except RuntimeError as e:
            self._log(f"! 빌드 종료 비정상 ({e}) — 결과물 확인 후 계속")

        # 6) latest.yml 검증 (없으면 NSIS만 재빌드)
        latest_yml = dist / "latest.yml"
        if not latest_yml.exists():
            self._log("! latest.yml 없음 → NSIS 재빌드")
            try:
                self._sh("npx electron-builder --win nsis --publish never", cwd=project, env=env)
            except RuntimeError:
                pass
        if not latest_yml.exists():
            raise RuntimeError("latest.yml 재생성 실패")

        setup    = dist / f"YT Separator-{new_v}-Setup.exe"
        blockmap = dist / f"YT Separator-{new_v}-Setup.exe.blockmap"
        portable = dist / f"YT Separator-{new_v}-Portable.exe"
        if not setup.exists():
            raise RuntimeError(f"{setup.name} 없음")

        # 7) Release 생성/갱신
        self._log(f"→ GitHub Release {tag} 생성...")
        try:
            release = gh_api(token, "POST", f"/repos/{REPO}/releases", body={
                "tag_name": tag,
                "name":     new_v,
                "body":     notes,
                "draft":    False,
                "prerelease": False,
            })
        except RuntimeError as e:
            if "already_exists" in str(e):
                self._log(f"! {tag} 이미 존재 — 노트 갱신")
                release = gh_api(token, "GET",   f"/repos/{REPO}/releases/tags/{tag}")
                release = gh_api(token, "PATCH", f"/repos/{REPO}/releases/{release['id']}",
                                 body={"body": notes})
            else:
                raise
        rel_id = release["id"]
        self._log(f"✓ release id={rel_id}")

        # 8) 기존 asset 삭제 → 재업로드 (sha 정합성)
        self._log("→ 기존 assets 정리...")
        for a in release.get("assets", []) or []:
            try:
                gh_api(token, "DELETE", f"/repos/{REPO}/releases/assets/{a['id']}")
                self._log(f"  del {a['name']}")
            except Exception as e:
                self._log(f"  ! del 실패 {a['name']}: {e}")

        r_setup    = f"YT-Separator-{new_v}-Setup.exe"
        r_blockmap = f"YT-Separator-{new_v}-Setup.exe.blockmap"
        r_portable = f"YT-Separator-{new_v}-Portable.exe"

        uploads = [(r_setup, setup), (r_blockmap, blockmap), ("latest.yml", latest_yml)]
        if portable.exists():
            uploads.append((r_portable, portable))

        for name, lp in uploads:
            if not lp.exists():
                self._log(f"  ! {name} 없음 — 스킵")
                continue
            mb = lp.stat().st_size / 1024 / 1024
            self._log(f"→ 업로드 {name} ({mb:.1f} MB)...")
            t0 = time.time()
            upload_asset(token, rel_id, name, lp)
            self._log(f"  ✓ {name}  ({time.time() - t0:.1f}s)")

        self._log("")
        self._log(f"✓ 릴리즈 {tag} 완료")
        self._log(f"  https://github.com/{REPO}/releases/tag/{tag}")
        # 다음 릴리즈용으로 노트 필드 비움
        self.root.after(0, lambda: self.notes_txt.delete("1.0", "end"))


def main():
    root = tk.Tk()
    # 아이콘 설정 (있으면)
    try:
        for p in [Path(__file__).resolve().parent.parent / "build" / "icon.png",
                  Path(sys.executable).resolve().parent / "icon.png"]:
            if p.exists():
                img = tk.PhotoImage(file=str(p))
                root.iconphoto(True, img)
                break
    except Exception:
        pass
    ReleaseApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
