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
    assert b.name == "oneq-CIVIL-bundle-2012-2022.zip"          # 시행일 모름(0000)은 연도 범위에서 뺌
    with zipfile.ZipFile(b) as z:
        assert sorted(z.namelist()) == sorted(p.name for p in packs)
        assert all(i.compress_type == zipfile.ZIP_STORED for i in z.infolist())
        assert z.read("oneq-CIVIL-2012-1.zip") == (tmp_path / "oneq-CIVIL-2012-1.zip").read_bytes()


def test_bundle_names():
    assert bundle_name("SAFETY", ["SAFETY-0000-1"]) == "oneq-SAFETY-bundle-0000.zip"
    assert write_bundle([], Path("."), "X") is None
