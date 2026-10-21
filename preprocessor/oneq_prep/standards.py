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
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path


def _root() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))   # PyInstaller 대비
    return base / "standards"


def user_root() -> Path:
    """사용자가 만든 출제기준 프로필(창 프로그램 [과목 직접 입력]) — 실행파일 폴더가 아니라 사용자 폴더에 저장(ADR 019).
    같은 종목 코드면 사용자 것이 함께 배포된 것보다 우선."""
    env = os.environ.get("ONEQ_PREP_HOME")
    if env:
        base = Path(env)
    elif os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home())) / "OneQ-Ace"
    else:
        base = Path.home() / ".local" / "share" / "OneQ-Ace"
    return base / "standards"


CODE_RE = re.compile(r"^[A-Z][A-Z0-9]{1,15}$")


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
    if root is not None:
        p = root / f"{code}.json"
    else:
        p = user_root() / f"{code}.json"
        if not p.exists():
            p = _root() / f"{code}.json"
    if not p.exists():
        raise FileNotFoundError(f"출제기준 프로필 없음: {p}")
    d = json.loads(p.read_text(encoding="utf-8"))
    return Profile(d["code"], d["name"], d["grade"], str(d["version"]), d["passRule"], d["subjects"],
                   d.get("aliases", {}), d.get("excluded", []), d.get("legacy"), d.get("draft", False), d.get("note", ""))


def available(root: Path | None = None) -> list[str]:
    """프로필 종목 코드(대문자 파일 이름만 — law-terms.json 같은 설정 파일은 제외)."""
    roots = [root] if root is not None else [_root(), user_root()]
    codes = {p.stem for r in roots if r.exists() for p in r.glob("*.json") if CODE_RE.match(p.stem)}
    return sorted(codes)


def is_user_profile(code: str) -> bool:
    return (user_root() / f"{code}.json").exists()


def save_user_profile(d: dict) -> Path:
    """창 프로그램에서 만든 프로필 저장. d는 SURVEY.json과 같은 모양(code·name·grade·version·passRule·subjects)."""
    if not CODE_RE.match(d.get("code", "")):
        raise ValueError("종목 코드는 영문 대문자로 시작하는 2~16자(예: ELEC, RAILCIVIL)")
    if not d.get("subjects"):
        raise ValueError("과목을 하나 이상 적으세요")
    p = user_root() / f"{d['code']}.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(d, ensure_ascii=False, indent=2), encoding="utf-8")
    return p
