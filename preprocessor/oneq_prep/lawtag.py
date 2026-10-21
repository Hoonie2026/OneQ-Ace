"""법령·기준 문항 자동 표시(ADR 019 — 전처리기 v0.4).

법령·기준(시방서 등)이 개정되면 옛 기출의 원본 정답이 현행과 달라질 수 있다. 그런 문항을 팩의 flags에 "law"로,
걸린 법령 이름을 lawRefs에 적는다(팩 포맷 oqp/1에 칸이 이미 있음 — 앱 v0.10.9가 답한 뒤 안내에 씀).

판정(넓게 잡으면 경고를 안 보게 되므로 좁게):
1. 법령 이름이 문항 글에 있음: "산업안전보건법령상", "…에 관한 규칙에 따라", "…시방서" 등 → refs
2. 종목별 법정 제도 낱말(standards/law-terms.json): 안전관리자·안전보건관리비·도급·측량업 …
3. 지정 과목에서 "수치+단위 + 이상·이하·이내·초과·미만" 기준을 묻는 문항(비계 간격·난간 높이 등)
"""
from __future__ import annotations

import json
import re
import sys
from functools import lru_cache
from pathlib import Path

# 법령 이름 찾기 — 세 가지 모양만(넓게 잡으면 "교육방법"·"뿜칠공법" 같은 낱말이 걸림)
# ① "…에 관한 특별법/법률/규칙/기준"  ② "…법·법령·시행령·시행규칙" + 법령 문맥(상, 에 따른/따라/의한, 에서 정한, 의 규정, 시행)
# ③ "…시방서", "…지침"(4글자 이상)  ④ 띄어쓰기가 든 이름·고시는 law-terms.json knownLaws
REL = re.compile(r"((?:[가-힣·ㆍ]+\s){0,5}?[가-힣·ㆍ]+)에\s?관한\s?(특별법|법률|규칙|기준)")
ACT = re.compile(r"((?:[가-힣·ㆍ]+\s)?[가-힣·ㆍ]+?(?:법령|시행령|시행규칙|법))"
                 r"(?=\s?(?:상|에\s?(?:따른|따라|의한|의하여|의하면|규정|정한)|에서\s?(?:정한|규정)|의\s?규정|\s시행))")
DOC = re.compile(r"([가-힣·ㆍ]*시방서|[가-힣·ㆍ]{4,}지침)")   # "…고시"는 knownLaws로만("냉장창고시" 같은 낱말 때문)
PARTICLE = ("는", "은", "를", "을", "가", "로", "서", "와", "과", "도", "에", "중")
STOP = {"다음", "다음은", "다음의", "아래", "및", "또는", "그", "이", "각", "중"}
LEAD = re.compile(r"^(?:다음\s?중|다음은|다음의|다음|아래)\s*")
NUM_STD = re.compile(r"\d+(?:\.\d+)?\s?(?:m|㎝|cm|㎜|mm|㎏|kg|kN|N|t|톤|미터|센티미터|밀리미터|킬로그램|도|°|%|퍼센트|시간|일|개월|년|명|인)"
                     r"[^\n]{0,12}?(?:이상|이하|이내|초과|미만)")


def _root() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return base / "standards"


@lru_cache(maxsize=4)
def _terms(root: str | None = None) -> dict:
    p = Path(root) / "law-terms.json" if root else _root() / "law-terms.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except OSError:
        return {}


def _clean_prefix(words: list[str], allow_and: bool = False) -> list[str]:
    """이름 앞쪽 낱말 중 조사로 끝나거나 일반 낱말이면 그 앞은 버린다("벽돌쌓기는 도면 또는 공사시방서" → "공사시방서")."""
    keep: list[str] = []
    for w in reversed(words):
        if (w in STOP and not (allow_and and w in ("및", "등"))) or (keep and w.endswith(PARTICLE) and not w.endswith("의")):
            break
        keep.insert(0, w)
    return keep


def law_refs(text: str, not_law: list[str] | None = None) -> list[str]:
    """문항 글에 나온 법령·기준 이름(정규화, 중복 없음)."""
    bad = tuple(not_law if not_law is not None else _terms().get("notLaw", []))
    t = re.sub(r"\s+", " ", text.replace("\n", " "))
    found: list[str] = []
    for m in REL.finditer(t):
        words = _clean_prefix(m.group(1).split(" "), allow_and=True)
        if words:
            found.append(" ".join(words) + "에 관한 " + m.group(2))
    squeezed = t.replace(" ", "")
    for law in _terms().get("knownLaws", []):
        if law.replace(" ", "") in squeezed:
            found.append(law)
    for m in ACT.finditer(t):
        name = m.group(1).split(" ")[-1]          # 띄어쓰기가 든 이름은 knownLaws로 — 앞 낱말("경우", "작업시")이 붙지 않게
        if len(name) >= 4 and not name.endswith(bad) and "에 관한" not in name:
            found.append(name[:-1] if name.endswith("법령") else name)   # 산업안전보건법령 → 산업안전보건법
    for m in DOC.finditer(t):
        name = m.group(1)
        if len(name) >= 4 and name not in ("반적지침",):
            found.append(name)
    out: list[str] = []
    for n in found:
        n = LEAD.sub("", n).strip().removeprefix("의 ")
        if n and n not in out and not any(n != o and n.replace(" ", "") in o.replace(" ", "") for o in found):
            out.append(n)
    return out


def tag(text: str, cert: str, subject: str | None, root: str | None = None) -> tuple[bool, list[str]]:
    """(법령·기준 문항인가, 법령 이름들)."""
    t = _terms(root)
    head = text[:400]
    refs = law_refs(head, t.get("notLaw", []))
    if refs:
        return True, refs
    terms = t.get("common", {}).get("terms", []) + t.get(cert, {}).get("terms", [])
    if any(k in head for k in terms):
        return True, []
    if subject and subject in t.get(cert, {}).get("numericSubjects", []) and NUM_STD.search(head):
        return True, []
    return False, []
