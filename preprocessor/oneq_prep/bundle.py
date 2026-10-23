"""종목 묶음(ADR 021 8절, PREP-PLAN-v0.5 B4) — 회차별 팩 여러 개를 zip 하나로 "포장만" 한다.

- 안의 팩은 다시 압축하지 않음(STORED — 이미 압축돼 있고, 앱이 하나씩 꺼낼 때 빠름)
- 기본은 이번에 새로 만든(또는 바뀐) 회차만 — 파일이 작아지고, 앱은 이미 있는 같은 팩을 조용히 건너뜀
- 이름: oneq-<종목>-bundle-<첫해>-<끝해>.zip (앱 pack/bundle.ts가 이름의 "bundle"로 알아봄)
"""
from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path


def bundle_name(code: str, pack_ids: list[str]) -> str:
    years = sorted({int(m.group(1)) for p in pack_ids if (m := re.search(r"-(\d{4})-\d+$", p)) and int(m.group(1)) > 0})
    span = f"{years[0]}-{years[-1]}" if years else "0000"
    return f"oneq-{code}-bundle-{span}.zip"


def write_bundle(packs: list[Path], out_dir: Path, code: str) -> Path | None:
    """packs(oneq-…zip)를 묶음 하나로. 팩이 없으면 None."""
    packs = sorted({Path(p) for p in packs if Path(p).exists()}, key=lambda p: p.name)
    if not packs:
        return None
    ids = []
    for p in packs:
        with zipfile.ZipFile(p) as z:
            ids.append(json.loads(z.read("manifest.json"))["packId"])
    path = Path(out_dir) / bundle_name(code, ids)
    tmp = path.with_suffix(".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for p in packs:
            z.write(p, p.name)
    tmp.replace(path)
    return path
