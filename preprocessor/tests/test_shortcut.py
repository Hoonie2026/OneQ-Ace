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


def test_exe_path_none_when_not_frozen():
    assert shortcut.exe_path() is None
