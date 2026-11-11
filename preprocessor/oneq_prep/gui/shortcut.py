"""설치 없는 zip 배포의 빈자리 메우기(🖥P14, 2026-11-11 사용자: "아이콘도 없고 어디 설치됐는지 모르겠음").

- 풀린 폴더가 곧 프로그램 자리 → 처음 실행 때 바탕화면·시작 메뉴 바로가기를 만들지 묻는다(도움말 메뉴에도)
- zip을 풀지 않고 탐색기에서 바로 열면 Windows가 임시 폴더에 풀어 실행 → 창을 닫으면 사라짐 → 경고
바로가기는 Windows 기본 WScript.Shell(PowerShell)로 만든다 — 추가 패키지 없음.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path

LINK_NAME = "원큐합격 전처리기.lnk"


def exe_path() -> Path | None:
    """실행파일(PyInstaller)로 돌 때만 그 exe 경로. 파이썬으로 돌면 None."""
    return Path(sys.executable).resolve() if getattr(sys, "frozen", False) else None


def installed(exe: Path) -> bool:
    """설치 프로그램(Inno Setup)으로 깔렸는지 — 제거기 unins000.exe가 옆에 있음. 바로가기는 설치 프로그램이 만든다."""
    return (exe.parent / "unins000.exe").exists()


def inside_zip_temp(exe: Path, temp_dir: str | None = None) -> bool:
    """zip을 풀지 않고 열어 임시 폴더에서 도는지 — 탐색기(%TEMP%\\Temp1_….zip), 7-Zip(7zO…), 반디집 등 모두 %TEMP% 아래."""
    tmp = Path(temp_dir or tempfile.gettempdir()).resolve()
    try:
        exe.resolve().relative_to(tmp)
    except ValueError:
        return False
    return True


def _ps_quote(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"


def ps_script(exe: Path, desktop: bool = True, start_menu: bool = True, *, name: str = LINK_NAME, args: str = "",
              icon: str | None = None, workdir: str | None = None, description: str = "기출 PDF를 원큐합격 문제팩으로") -> str:
    """바로가기 만드는 PowerShell — 바탕화면은 OneDrive로 옮겨진 경우도 GetFolderPath가 맞게 찾는다."""
    targets = [f for f, on in (("Desktop", desktop), ("Programs", start_menu)) if on]
    lines = ["$ErrorActionPreference = 'Stop'", "[Console]::OutputEncoding = [Text.Encoding]::UTF8", "$sh = New-Object -ComObject WScript.Shell", "$made = @()"]
    for t in targets:
        lines += [
            f"$p = Join-Path ([Environment]::GetFolderPath('{t}')) {_ps_quote(name)}",
            "$l = $sh.CreateShortcut($p)",
            f"$l.TargetPath = {_ps_quote(str(exe))}",
            f"$l.Arguments = {_ps_quote(args)}",
            f"$l.WorkingDirectory = {_ps_quote(workdir or str(exe.parent))}",
            f"$l.IconLocation = {_ps_quote(icon or (str(exe) + ',0'))}",
            f"$l.Description = {_ps_quote(description)}",
            "$l.Save()",
            "$made += $p",
        ]
    lines.append("$made -join \"`n\"")
    return "\n".join(lines)


def _run_ps(script: str) -> list[str]:
    if os.name != "nt":
        raise RuntimeError("바로가기는 Windows에서만 만듭니다.")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, creationflags=flags)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "알 수 없는 오류").strip().splitlines()[-1])
    return [x for x in r.stdout.strip().splitlines() if x]


def make_shortcuts(exe: Path, desktop: bool = True, start_menu: bool = True) -> list[str]:
    """전처리기 바로가기 경로들. 실패하면 RuntimeError(메시지는 화면에 그대로)."""
    return _run_ps(ps_script(exe, desktop, start_menu))


# ── PC에 학습앱 설치(사용자 2026-11-11: 설치 프로그램은 전처리기만, 학습앱은 사용자가 [학습앱 설치]에서 직접) ──
APP_LINK_NAME = "원큐합격 학습앱.lnk"


def _find(rel: tuple[str, ...], env: dict) -> Path | None:
    for base in (env.get("ProgramFiles"), env.get("ProgramFiles(x86)"), env.get("LOCALAPPDATA")):
        if base:
            p = Path(base).joinpath(*rel)
            if p.exists():
                return p
    return None


def edge_path(env: dict | None = None) -> Path | None:
    """Microsoft Edge(Windows 10·11 기본)."""
    return _find(("Microsoft", "Edge", "Application", "msedge.exe"), env if env is not None else os.environ)


def chrome_path(env: dict | None = None) -> Path | None:
    return _find(("Google", "Chrome", "Application", "chrome.exe"), env if env is not None else os.environ)


def default_browser_progid() -> str:
    """이 PC의 기본 브라우저(https 연결) — ChromeHTML·MSEdgeHTM 등. 못 읽으면 ''."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice") as k:
            return str(winreg.QueryValueEx(k, "ProgId")[0])
    except Exception:  # noqa: BLE001 — 윈도가 아니거나 값이 없음
        return ""


def app_browser(progid: str | None = None, env: dict | None = None) -> tuple[Path, str] | None:
    """PC 학습앱을 열 브라우저(PC 접근 일원화, 2026-11-11): 기본 브라우저가 Chrome이면 Chrome, 아니면 Edge.
    링크·메일을 여는 브라우저와 같아야 기록이 한곳에 모인다. 둘 다 없으면 None."""
    progid = default_browser_progid() if progid is None else progid
    chrome, edge = chrome_path(env), edge_path(env)
    if progid.lower().startswith("chrome") and chrome:
        return chrome, "Chrome"
    if edge:
        return edge, "Edge"
    if chrome:
        return chrome, "Chrome"
    return None


def app_args(url: str) -> str:
    return f"--app={url}"


def app_ps_script(browser: Path, url: str, icon: Path) -> str:
    return ps_script(browser, name=APP_LINK_NAME, args=app_args(url), icon=f"{icon},0", workdir=str(browser.parent),
                     description="원큐합격 학습앱 — 기사·산업기사 필기 기출 학습")


def make_app_shortcuts(browser: Path, url: str, icon: Path) -> list[str]:
    """바탕화면·시작 메뉴에 '원큐합격 학습앱'(기본 브라우저의 앱 창). 기록은 그 브라우저에 저장."""
    return _run_ps(app_ps_script(browser, url, icon))


def open_app_window(browser: Path, url: str) -> None:
    flags = getattr(subprocess, "DETACHED_PROCESS", 0)
    subprocess.Popen([str(browser), app_args(url)], creationflags=flags, close_fds=True)
