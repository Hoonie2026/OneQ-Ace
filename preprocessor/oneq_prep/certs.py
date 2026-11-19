"""자격 종목 검색(ADR 019) — 드롭다운 대신 "측량", "건안기" 같은 말로 찾는다. 화면(Qt)에 의존하지 않음.

데이터(인터넷 없이 동작):
- standards/qualifications.csv — 공공데이터포털 "한국산업인력공단_국가자격 종목 목록 정보"(자격구분명·계열명·종목명).
  없으면 아래 SEED(건설·안전·측량·전기 등 자주 쓰는 기사·산업기사)만.
- standards/qual-codes.csv — 같은 포털 "…_국가기술자격시험_공통 편성기준 정보"(종목코드·종목명) — 큐넷 종목 페이지 주소용(선택)
- 별칭(ALIASES): 줄임말·옛 이름
- 출제기준 프로필(standards/*.json, 사용자 폴더)이 있는 종목은 앞에 ✓
"""
from __future__ import annotations

import csv
import io
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from . import standards as S

SEED = [
    "건설안전기사", "건설안전산업기사", "산업안전기사", "산업안전산업기사", "토목기사", "토목산업기사", "철도토목기사",
    "철도토목산업기사", "측량및지형공간정보기사", "측량및지형공간정보산업기사", "지적기사", "지적산업기사", "건축기사",
    "건축산업기사", "건설재료시험기사", "콘크리트기사", "전기기사", "전기산업기사", "전기공사기사", "전기공사산업기사",
    "전기철도기사", "전기철도산업기사", "철도신호기사", "철도신호산업기사", "소방설비기사(기계분야)", "소방설비기사(전기분야)",
    "위험물산업기사", "대기환경기사", "수질환경기사", "품질경영기사", "건설기계설비기사", "일반기계기사", "정보처리기사",
    "조경기사", "도시계획기사", "교통기사", "응용지질기사", "공조냉동기계기사", "화공기사", "에너지관리기사", "가스기사",
    "인간공학기사", "산업위생관리기사", "건축설비기사", "실내건축기사", "건설안전기술사", "토질및기초기술사",
]

# 줄임말·흔히 부르는 이름 → 정식 종목명
ALIASES = {
    "건안기": "건설안전기사", "건안산기": "건설안전산업기사", "산안기": "산업안전기사", "산안산기": "산업안전산업기사",
    "측량기사": "측량및지형공간정보기사", "측량산업기사": "측량및지형공간정보산업기사", "측지기사": "측량및지형공간정보기사",
    "철토기": "철도토목기사", "철도토목": "철도토목기사", "토목": "토목기사", "건축": "건축기사", "건재기": "건설재료시험기사",
    "전기": "전기기사", "전기철도": "전기철도기사", "소방기사": "소방설비기사(기계분야)", "정처기": "정보처리기사",
    "위험물": "위험물산업기사", "대기": "대기환경기사", "수질": "수질환경기사", "공조냉동": "공조냉동기계기사",
}


@dataclass
class Cert:
    name: str
    series: str = ""        # 계열(건설·안전관리 …)
    kind: str = ""          # 자격구분(국가기술자격 …)
    jm_code: str = ""       # 큐넷 종목코드(있으면)
    profile: str = ""       # 출제기준 프로필 코드(있으면)

    @property
    def grade(self) -> str:
        n = re.sub(r"\(.*\)$", "", self.name)
        for g in ("산업기사", "기능장", "기술사", "기능사", "기사"):
            if n.endswith(g):
                return g
        return ""

    def qnet_url(self) -> str:
        if self.jm_code:
            return f"https://www.q-net.or.kr/crf005.do?id=crf00503&jmCd={self.jm_code}"
        from urllib.parse import quote
        return "https://www.google.com/search?q=" + quote(f"큐넷 {self.name} 출제기준")


def _root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1])) / "standards"


def _read_csv(p: Path) -> list[dict]:
    """공공데이터 CSV는 대개 CP949(EUC-KR). UTF-8(BOM)도 받는다."""
    raw = p.read_bytes()
    for enc in ("utf-8-sig", "cp949"):
        try:
            return list(csv.DictReader(io.StringIO(raw.decode(enc))))
        except UnicodeDecodeError:
            continue
    return []


def _col(row: dict, *names: str) -> str:
    for n in names:
        for k, v in row.items():
            if k and k.strip() == n:
                return (v or "").strip()
    return ""


def norm(s: str) -> str:
    return re.sub(r"[\s·ㆍ()（）]+", "", s)


def catalog(root: Path | None = None) -> list[Cert]:
    root = root or _root()
    certs: dict[str, Cert] = {}
    q = root / "qualifications.csv"
    if q.exists():
        for row in _read_csv(q):
            name = _col(row, "종목명")
            if name:
                certs.setdefault(name, Cert(name, _col(row, "계열명"), _col(row, "자격구분명")))
    for name in SEED:
        certs.setdefault(name, Cert(name, kind="국가기술자격"))
    c = root / "qual-codes.csv"
    if c.exists():
        for row in _read_csv(c):
            name, code = _col(row, "종목명"), _col(row, "종목코드")
            if name in certs and code and not certs[name].jm_code:
                certs[name].jm_code = code
    for code in S.available():
        try:
            prof = S.load(code)
        except Exception:  # noqa: BLE001 — 깨진 사용자 프로필이 검색을 막지 않게
            continue
        cert = certs.setdefault(prof.name, Cert(prof.name, kind="국가기술자격"))
        if not prof.draft:
            cert.profile = code
    return sorted(certs.values(), key=lambda x: x.name)


def search(query: str, certs: list[Cert], limit: int = 30) -> list[Cert]:
    """띄어쓰기·가운뎃점 무시. 별칭 → 정식명, 앞부분 일치 > 포함. 프로필이 있는 종목을 위로."""
    q = norm(query)
    if not q:
        return sorted(certs, key=lambda c: (not c.profile, c.name))[:limit]
    target = ALIASES.get(q) or ALIASES.get(query.strip())
    scored = []
    for c in certs:
        n = norm(c.name)
        if target and c.name == target:
            s = 0
        elif n.startswith(q):
            s = 1
        elif q in n:
            s = 2
        elif any(norm(a) == q or q in norm(a) for a, t in ALIASES.items() if t == c.name):
            s = 2
        else:
            continue
        scored.append((s, not c.profile, len(c.name), c.name, c))
    return [x[-1] for x in sorted(scored)[:limit]]
