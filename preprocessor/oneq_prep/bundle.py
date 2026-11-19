"""종목 묶음(ADR 021 8절, PREP-PLAN-v0.5 B4) — 회차별 팩 여러 개를 zip 하나로 "포장만" 한다.

- 안의 팩은 다시 압축하지 않음(STORED — 이미 압축돼 있고, 앱이 하나씩 꺼낼 때 빠름)
- 종목의 모든 회차(2026-11-16 — 일부만 든 묶음이 공유 창과 어긋났음). 앱은 이미 있는 같은 팩을 조용히 건너뜀
- **문제팩 폴더에 보이는 파일은 종목마다 이 묶음 하나**(사용자 2026-11-17). 회차별 팩은 안쪽 `.회차별` 폴더(pack.rounds_dir)
- 이름: 「원큐합격 문제팩_콘크리트기사_2014-2021(20회차).zip」 — 받는 사람이 이름만 보고 알 수 있게.
  학습앱은 이름이 아니라 내용(안에 manifest.json 없이 zip들이 있음)으로 묶음을 알아본다(app pack/bundle.ts)
"""
from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path


PREFIX = "원큐합격 문제팩_"


def cert_name(code: str) -> str:
    try:
        from . import standards as S
        return S.load(code).name
    except Exception:  # noqa: BLE001 — 프로필이 없는 종목
        return code


def safe_name(name: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "", name)


def bundle_name(code: str, pack_ids: list[str]) -> str:
    years = sorted({int(m.group(1)) for p in pack_ids if (m := re.search(r"-(\d{4})-\d+$", p)) and int(m.group(1)) > 0})
    span = (f"_{years[0]}-{years[-1]}" if years[0] != years[-1] else f"_{years[0]}") if years else ""
    return f"{PREFIX}{safe_name(cert_name(code))}{span}({len(pack_ids)}회차).zip"


def bundles_of(out_dir: Path, code: str) -> list[Path]:
    """이 종목의 묶음 파일들(새 이름 + 예전 이름 oneq-종목-bundle-…)."""
    d = Path(out_dir)
    if not d.exists():
        return []
    return sorted(set(d.glob(f"{PREFIX}{safe_name(cert_name(code))}_*.zip"))
                  | set(d.glob(f"{PREFIX}{safe_name(cert_name(code))}(*.zip")) | set(d.glob(f"oneq-{code}-bundle-*.zip")))


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
    for old in bundles_of(out_dir, code):        # 같은 종목의 예전 묶음은 지움 — 종목마다 파일 하나
        if old != path:
            try:
                old.unlink()
            except OSError:
                pass
    return path
