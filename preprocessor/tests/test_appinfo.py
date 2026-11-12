"""D1 배포(ADR 021 7절): 앱 주소·전처리기 받기 이름이 앱·전처리기·빌드 워크플로에서 같은지, 실행파일 버전 정보가 맞는지."""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oneq_prep import __version__  # noqa: E402
from oneq_prep.appinfo import APP_URL, qr_png  # noqa: E402

PRE = Path(__file__).resolve().parents[1]
ROOT = PRE.parent


def test_app_url_matches_app_build():
    vite = (ROOT / "app" / "vite.config.ts").read_text(encoding="utf-8")
    base = re.search(r"const BASE = '([^']+)'", vite).group(1)
    assert APP_URL == f"https://hoonie2026.github.io{base}"


def test_download_asset_name_matches_release_workflow():
    prep = (ROOT / "app" / "src" / "prep.ts").read_text(encoding="utf-8")
    wf = (ROOT / ".github" / "workflows" / "release-prep.yml").read_text(encoding="utf-8")
    for const in ("PREP_ASSET", "PREP_SETUP_ASSET"):
        asset = re.search(const + r" = '([^']+)'", prep).group(1)
        assert asset in wf, const
    setup = re.search(r"PREP_SETUP_ASSET = '([^']+)'", prep).group(1)
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


def test_qr_png():
    png = qr_png()
    if png is None:      # segno 없는 명령줄 환경
        return
    assert png[:8] == b"\x89PNG\r\n\x1a\n"


def test_prep_link_matches_app():
    """전처리기 링크(앱 주소?prep)가 앱 prep.ts의 PREP_PARAM과 같아야 함(설치 경로 두 갈래, 2026-11-12)."""
    from oneq_prep.appinfo import PREP_URL
    prep = (ROOT / "app" / "src" / "prep.ts").read_text(encoding="utf-8")
    param = re.search(r"PREP_PARAM = '([^']+)'", prep).group(1)
    assert PREP_URL == APP_URL + "?" + param
