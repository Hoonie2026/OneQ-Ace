"""zip 배포 바로가기·임시 폴더 경고(🖥P14, 2026-11-11) — Windows 없이 되는 부분만."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oneq_prep.gui import shortcut  # noqa: E402


def test_inside_zip_temp(tmp_path):
    t = tmp_path / "Temp"
    exe = t / "Temp1_OneQ-PackMaker-win64.zip" / "OneQ-PackMaker" / "OneQ-PackMaker.exe"
    exe.parent.mkdir(parents=True)
    exe.touch()
    assert shortcut.inside_zip_temp(exe, str(t))
    ok = tmp_path / "Documents" / "OneQ-PackMaker" / "OneQ-PackMaker.exe"
    ok.parent.mkdir(parents=True)
    ok.touch()
    assert not shortcut.inside_zip_temp(ok, str(t))


def test_ps_script_quotes_and_targets():
    exe = Path("C:/Users/o'brien/문서/OneQ-PackMaker/OneQ-PackMaker.exe")
    s = shortcut.ps_script(exe)
    assert "GetFolderPath('Desktop')" in s and "GetFolderPath('Programs')" in s
    assert "o''brien" in s                      # 작은따옴표 이스케이프
    assert s.count("$l.Save()") == 2
    assert "GetFolderPath('Desktop')" not in shortcut.ps_script(exe, desktop=False)


def test_installed(tmp_path):
    exe = tmp_path / "OneQ-PackMaker.exe"
    exe.touch()
    assert not shortcut.installed(exe)
    (tmp_path / "unins000.exe").touch()
    assert shortcut.installed(exe)


def test_exe_path_none_when_not_frozen():
    assert shortcut.exe_path() is None


def test_old_name_links_removed():
    """이름 변경(전처리기 → 원큐합격 문제팩 생성기, 2026-11-12): 새 바로가기를 만들 때 옛 이름 바로가기는 지운다."""
    s = shortcut.ps_script(Path("C:/x/OneQ-PackMaker.exe"))
    assert "'원큐합격 문제팩 생성기.lnk'" in s and s.count("Remove-Item") == 2 and "'원큐합격 전처리기.lnk'" in s
    assert "Remove-Item" not in shortcut.ps_script(Path("C:/x/a.exe"), name="다른 이름.lnk")
