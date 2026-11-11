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


def ps_script(exe: Path, desktop: bool = True, start_menu: bool = True) -> str:
    """바로가기 만드는 PowerShell — 바탕화면은 OneDrive로 옮겨진 경우도 GetFolderPath가 맞게 찾는다."""
    targets = [f for f, on in (("Desktop", desktop), ("Programs", start_menu)) if on]
    lines = ["$ErrorActionPreference = 'Stop'", "[Console]::OutputEncoding = [Text.Encoding]::UTF8", "$sh = New-Object -ComObject WScript.Shell", "$made = @()"]
    for t in targets:
        lines += [
            f"$p = Join-Path ([Environment]::GetFolderPath('{t}')) {_ps_quote(LINK_NAME)}",
            "$l = $sh.CreateShortcut($p)",
            f"$l.TargetPath = {_ps_quote(str(exe))}",
            f"$l.WorkingDirectory = {_ps_quote(str(exe.parent))}",
            f"$l.IconLocation = {_ps_quote(str(exe) + ',0')}",
            "$l.Description = '기출 PDF를 원큐합격 문제팩으로'",
            "$l.Save()",
            "$made += $p",
        ]
    lines.append("$made -join \"`n\"")
    return "\n".join(lines)


def make_shortcuts(exe: Path, desktop: bool = True, start_menu: bool = True) -> list[str]:
    """만든 바로가기 경로들. 실패하면 RuntimeError(메시지는 화면에 그대로)."""
    if os.name != "nt":
        raise RuntimeError("바로가기는 Windows에서만 만듭니다.")
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script(exe, desktop, start_menu)],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, creationflags=flags)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "알 수 없는 오류").strip().splitlines()[-1])
    return [x for x in r.stdout.strip().splitlines() if x]
