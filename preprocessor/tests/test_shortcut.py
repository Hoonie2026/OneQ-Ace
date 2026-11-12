"""zip 배포 바로가기·임시 폴더 경고(🖥P14, 2026-11-11) — Windows 없이 되는 부분만."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oneq_prep.gui import shortcut  # noqa: E402


def test_inside_zip_temp(tmp_path):
    t = tmp_path / "Temp"
    exe = t / "Temp1_OneQ-Prep-win64.zip" / "OneQ-Prep" / "OneQ-Prep.exe"
    exe.parent.mkdir(parents=True)
    exe.touch()
    assert shortcut.inside_zip_temp(exe, str(t))
    ok = tmp_path / "Documents" / "OneQ-Prep" / "OneQ-Prep.exe"
    ok.parent.mkdir(parents=True)
    ok.touch()
    assert not shortcut.inside_zip_temp(ok, str(t))


def test_ps_script_quotes_and_targets():
    exe = Path("C:/Users/o'brien/문서/OneQ-Prep/OneQ-Prep.exe")
    s = shortcut.ps_script(exe)
    assert "GetFolderPath('Desktop')" in s and "GetFolderPath('Programs')" in s
    assert "o''brien" in s                      # 작은따옴표 이스케이프
    assert s.count("$l.Save()") == 2
    assert "GetFolderPath('Desktop')" not in shortcut.ps_script(exe, desktop=False)


def test_installed(tmp_path):
    exe = tmp_path / "OneQ-Prep.exe"
    exe.touch()
    assert not shortcut.installed(exe)
    (tmp_path / "unins000.exe").touch()
    assert shortcut.installed(exe)


def test_exe_path_none_when_not_frozen():
    assert shortcut.exe_path() is None


def test_app_shortcut_script_and_edge(tmp_path):
    env = {"ProgramFiles(x86)": str(tmp_path / "x86"), "ProgramFiles": str(tmp_path / "pf")}
    assert shortcut.edge_path(env) is None
    e = tmp_path / "pf" / "Microsoft" / "Edge" / "Application" / "msedge.exe"
    e.parent.mkdir(parents=True)
    e.touch()
    assert shortcut.edge_path(env) == e
    s = shortcut.app_ps_script(e, "https://hoonie2026.github.io/OneQ-Ace/", Path("C:/p/app-icon.ico"))
    assert "원큐합격 학습앱.lnk" in s and "--app=https://hoonie2026.github.io/OneQ-Ace/" in s
    assert "app-icon.ico,0" in s and s.count("$l.Save()") == 2


def test_app_browser_follows_default(tmp_path):
    """PC 접근 일원화: 기본 브라우저가 Chrome이면 Chrome 앱 창, 아니면 Edge."""
    env = {"ProgramFiles": str(tmp_path / "pf"), "LOCALAPPDATA": str(tmp_path / "la")}
    edge = tmp_path / "pf" / "Microsoft" / "Edge" / "Application" / "msedge.exe"
    chrome = tmp_path / "la" / "Google" / "Chrome" / "Application" / "chrome.exe"
    for f in (edge, chrome):
        f.parent.mkdir(parents=True)
        f.touch()
    assert shortcut.app_browser("ChromeHTML", env) == (chrome, "Chrome")
    assert shortcut.app_browser("MSEdgeHTM", env) == (edge, "Edge")
    assert shortcut.app_browser("FirefoxURL-308046B0AF4A39CB", env) == (edge, "Edge")
    edge.unlink()
    assert shortcut.app_browser("MSEdgeHTM", env) == (chrome, "Chrome")
    chrome.unlink()
    assert shortcut.app_browser("ChromeHTML", env) is None


def test_app_registered_in_windows_programs(tmp_path, monkeypatch):
    """사용자 2026-11-12: 학습앱이 '설정 › 앱'·'제어판 › 프로그램 제거'에 보이도록 HKCU Uninstall 키 등록,
    제거는 바로가기·아이콘 폴더·키만 지우고 학습 기록(브라우저 저장소)은 남김."""
    import base64
    home = tmp_path / "la" / "OneQ-Ace" / "StudyApp"
    assert shortcut.app_home({"LOCALAPPDATA": str(tmp_path / "la")}) == home
    s = shortcut.app_ps_script(Path("C:/e/msedge.exe"), "https://x/", home / "app-icon.ico", home)
    key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\OneQAce.StudyApp"
    assert f"$k = '{key}'" in s and "DisplayName -Value '원큐합격 학습앱'" in s
    assert "-Name NoModify -Value 1 -PropertyType DWord" in s and "UninstallString" in s
    assert s.splitlines()[-1] == '$made -join "`n"'          # 만든 경로 출력은 맨 끝
    enc = shortcut.uninstall_command(home).rsplit(" ", 1)[1]
    un = base64.b64decode(enc).decode("utf-16-le")
    assert "원큐합격 학습앱.lnk" in un and f"Remove-Item -Recurse -Force '{key}'" in un and str(home) in un
    assert "학습 기록은 브라우저에 남아" in un

    # 아이콘은 %LOCALAPPDATA%로 복사해 씀(전처리기를 지워도 깨지지 않게)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "la"))
    ran = []
    monkeypatch.setattr(shortcut, "_run_ps", lambda script: ran.append(script) or ["ok"])
    icon = tmp_path / "app-icon.ico"
    icon.write_bytes(b"ico")
    assert shortcut.make_app_shortcuts(Path("C:/e/msedge.exe"), "https://x/", icon) == ["ok"]
    assert (home / "app-icon.ico").read_bytes() == b"ico" and str(home / "app-icon.ico") + ",0" in ran[0]
    assert shortcut.app_installed() is False                 # 윈도가 아니면 False
