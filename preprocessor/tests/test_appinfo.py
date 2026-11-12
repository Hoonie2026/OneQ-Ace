"""D1 배포(ADR 021 7절): 앱 주소·문제팩 생성기 받기 이름이 학습앱·생성기·빌드 워크플로에서 같은지, 실행파일 버전 정보가 맞는지."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oneq_prep import __version__  # noqa: E402
from oneq_prep.appinfo import APP_URL  # noqa: E402

PRE = Path(__file__).resolve().parents[1]
ROOT = PRE.parent


def test_app_url_matches_app_build():
    vite = (ROOT / "app" / "vite.config.ts").read_text(encoding="utf-8")
    base = re.search(r"const BASE = '([^']+)'", vite).group(1)
    assert APP_URL == f"https://hoonie2026.github.io{base}"


def test_download_asset_name_matches_release_workflow():
    maker = (ROOT / "app" / "src" / "maker.ts").read_text(encoding="utf-8")
    wf = (ROOT / ".github" / "workflows" / "release-prep.yml").read_text(encoding="utf-8")
    for const in ("MAKER_ASSET", "MAKER_SETUP_ASSET"):
        asset = re.search(const + r" = '([^']+)'", maker).group(1)
        assert asset in wf, const
    setup = re.search(r"MAKER_SETUP_ASSET = '([^']+)'", maker).group(1)
    iss = (PRE / "packaging" / "oneq-prep.iss").read_text(encoding="utf-8-sig")
    assert f"OutputBaseFilename={Path(setup).stem}" in iss


def test_installer_shortcut_name_matches_gui():
    """설치 프로그램 바로가기와 [바로가기 만들기]가 같은 이름 → 두 개가 생기지 않고 덮어씀."""
    from oneq_prep.gui.shortcut import LINK_NAME
    iss = (PRE / "packaging" / "oneq-prep.iss").read_text(encoding="utf-8-sig")
    assert f'#define MyAppName "{Path(LINK_NAME).stem}"' in iss


def test_version_info_matches_package():
    nums = tuple(int(x) for x in re.match(r"(\d+)\.(\d+)\.(\d+)", __version__).groups())
    vi = (PRE / "packaging" / "version_info.txt").read_text(encoding="utf-8")
    assert f"filevers=({nums[0]}, {nums[1]}, {nums[2]}, 0)" in vi
    assert f"'ProductVersion', '{'.'.join(map(str, nums))}'" in vi


def test_names_match_everywhere():
    """이름 변경(사용자 2026-11-12): 화면·설치 프로그램·실행파일·학습앱이 모두 '원큐합격 문제팩 생성기' / OneQ-PackMaker."""
    from oneq_prep.gui.app import APP_NAME, EXE_NAME
    maker = (ROOT / "app" / "src" / "maker.ts").read_text(encoding="utf-8")
    assert APP_NAME == "원큐합격 문제팩 생성기" and f"MAKER_NAME = '{APP_NAME}'" in maker
    spec = (PRE / "packaging" / "oneq-prep.spec").read_text(encoding="utf-8")
    iss = (PRE / "packaging" / "oneq-prep.iss").read_text(encoding="utf-8-sig")
    vi = (PRE / "packaging" / "version_info.txt").read_text(encoding="utf-8")
    assert f'name="{Path(EXE_NAME).stem}"' in spec and f'#define MyExe "{EXE_NAME}"' in iss and f"'{EXE_NAME}'" in vi
    assert f"'ProductName', '{APP_NAME}'" in vi
