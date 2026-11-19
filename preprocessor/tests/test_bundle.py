"""종목 묶음(ADR 021 8절, B4) — 포장만 하나로: 안의 팩은 다시 압축하지 않고, 이름은 앱이 알아보는 모양."""
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep.bundle import bundle_name, write_bundle  # noqa: E402


def _pack(d: Path, pid: str) -> Path:
    p = d / f"oneq-{pid}.zip"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps({"packId": pid}))
        z.writestr("questions.json", "[]" * 100)
    return p


def test_bundle_stored_and_named(tmp_path):
    packs = [_pack(tmp_path, "CIVIL-2022-2"), _pack(tmp_path, "CIVIL-2012-1"), _pack(tmp_path, "CIVIL-0000-1")]
    b = write_bundle(packs, tmp_path, "CIVIL")
    assert b.name == "원큐합격 문제팩_토목기사_2012-2022(3회차).zip"   # 받는 사람이 알아볼 이름, 시행일 모름(0000)은 연도에서 뺌
    with zipfile.ZipFile(b) as z:
        assert sorted(z.namelist()) == sorted(p.name for p in packs)
        assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist())
        assert z.read("oneq-CIVIL-2012-1.zip") == (tmp_path / "oneq-CIVIL-2012-1.zip").read_bytes()


def test_bundle_names():
    assert bundle_name("SAFETY", ["SAFETY-0000-1"]) == "원큐합격 문제팩_건설안전기사(1회차).zip"
    assert bundle_name("SAFETY", ["SAFETY-2022-1"]) == "원큐합격 문제팩_건설안전기사_2022(1회차).zip"
    assert write_bundle([], Path("."), "X") is None


def test_bundle_replaces_old_of_same_cert(tmp_path):
    """종목마다 파일 하나(사용자 2026-11-17) — 같은 종목의 예전 묶음(옛 이름 포함)은 지우고 다른 종목은 둠."""
    (tmp_path / "oneq-CIVIL-bundle-2012-2012.zip").write_bytes(b"z")
    (tmp_path / "원큐합격 문제팩_토목기사_2012(1회차).zip").write_bytes(b"z")
    other = tmp_path / "원큐합격 문제팩_건설안전기사_2022(1회차).zip"
    other.write_bytes(b"z")
    b = write_bundle([_pack(tmp_path, "CIVIL-2012-1"), _pack(tmp_path, "CIVIL-2013-1")], tmp_path, "CIVIL")
    assert sorted(f.name for f in tmp_path.glob("원큐합격*.zip")) == sorted([b.name, other.name])
    assert not list(tmp_path.glob("oneq-CIVIL-bundle-*.zip"))
