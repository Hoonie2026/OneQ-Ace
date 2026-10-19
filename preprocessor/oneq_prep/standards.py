"""종목별 출제기준 프로필(ADR 005·012).

preprocessor/standards/<종목코드>.json
  subjects  현행 과목(표준 이름·순서·문항 수, isLaw 선택)
  aliases   연도마다 다르게 적힌 과목명 → 표준 이름
  excluded  현행에 없는 과목명(팩에 넣지 않음)
  legacy    {"before": "YYYY-MM-DD", "action": "reassign"} — 그 전 회차는 문항별 과목 재배정 대상
  draft     true이면 아직 확정 안 된 프로필(팩을 만들지 않음)
"""
from __future__ import annotations

import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


def _root() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))   # PyInstaller 대비
    return base / "standards"


def norm(name: str) -> str:
    """과목명 비교용: 공백·가운뎃점·괄호·쉼표를 무시한다("수리학및수문학" = "수리학 및 수문학")."""
    return re.sub(r"[\s·ㆍ,()（）\[\]]+", "", name)


@dataclass
class Profile:
    code: str
    name: str
    grade: str
    version: str
    pass_rule: dict
    subjects: list[dict]
    aliases: dict[str, str] = field(default_factory=dict)
    excluded: list[str] = field(default_factory=list)
    legacy: dict | None = None
    draft: bool = False
    note: str = ""

    def resolve(self, raw: str) -> tuple[str, int | None, str]:
        """PDF 과목명 → ("std", 과목번호(1부터), 표준이름) / ("excluded", None, raw) / ("unknown", None, raw)."""
        n = norm(raw)
        al = {norm(k): v for k, v in self.aliases.items()}
        if n in al:
            n = norm(al[n])
        for i, s in enumerate(self.subjects):
            if norm(s["name"]) == n:
                return "std", i + 1, s["name"]
        if n in {norm(x) for x in self.excluded}:
            return "excluded", None, raw
        return "unknown", None, raw

    def std_index(self, name: str) -> int | None:
        for i, s in enumerate(self.subjects):
            if norm(s["name"]) == norm(name):
                return i + 1
        return None

    def is_legacy(self, date: str) -> bool:
        return bool(self.legacy and date < self.legacy["before"])


def load(code: str, root: Path | None = None) -> Profile:
    p = (root or _root()) / f"{code}.json"
    if not p.exists():
        raise FileNotFoundError(f"출제기준 프로필 없음: {p}")
    d = json.loads(p.read_text(encoding="utf-8"))
    return Profile(d["code"], d["name"], d["grade"], str(d["version"]), d["passRule"], d["subjects"],
                   d.get("aliases", {}), d.get("excluded", []), d.get("legacy"), d.get("draft", False), d.get("note", ""))


def available(root: Path | None = None) -> list[str]:
    return sorted(p.stem for p in (root or _root()).glob("*.json"))
