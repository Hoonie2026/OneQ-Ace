"""문항 단원·유형 판정(ADR 021 4절, PREP-PLAN-v0.5 C1).

- 단원(unit) = 출제기준 세부항목, id "주요-세부"(standards.Profile.units). 근거 낱말:
  ① 출제기준 세부항목 이름·세세항목에서 뽑은 낱말(모든 종목에 자동)
  ② standards/unit-keywords.json 의 종목·과목별 보충 낱말(교과 용어 — 출제기준에 안 나오는 좌굴·세장비·푸아송 …)
  낱말마다 과목 안 단원 몇 곳에 나오는지로 무게(드물수록 큼), "!"로 시작하면 강한 낱말(구조 형식 등, 무게 ×3)
- 유형(qtype) = calc(수치·수식 답) / law(기준·법령) / concept(나머지) — 겹치면 calc > law > concept (4.2)
- 순서형(sequence) = 발문 "순서" · ㄱㄴㄷ 나열 · 화살표 보기
- 확신도: 확신 있는 것은 그대로 팩에, 낮은 것만 "몰아 고르기" 목록으로(4.5)
"""
from __future__ import annotations

import json
import math
import re
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from . import standards as S

CIRCLED = "①②③④⑤"
CHOICE_SPLIT = re.compile(r"[①②③④⑤❶❷❸❹❺]")

# 보기 안 한글 중 "수치 보기"로 봐도 되는 낱말(단위·방향·부호 설명)
NUM_WORDS = re.compile(r"인장|압축|부정정|약|배|개|차|번|정|부|도|분|초|이상|이하|상향|하향|좌|우|↑|↓|←|→")
UNIT_RE = re.compile(r"\d\s*(?:%|㎝|㎜|㎡|㎥|㎏|°|′|″|[a-zA-Zμ]+|배|개|차|t|톤)")
FORMULA_RE = re.compile(r"[/×√π^]|\b[A-Za-z]{1,3}\s*[=+\-]|\([A-Za-z0-9+\-/ ]+\)")
CONCEPT_CUE = re.compile(r"설명|틀린|옳지\s?않|아닌\s?것|해당(?:하지|되지)|무엇|무슨|어느\s?것|가장\s?(?:적합|적당|중요|큰|거리가)|"
                         r"다음\s?중|특징|특성|원칙|원인|종류|용도|목적|정의|구분|분류|장점|단점")
FORMULA_ASK = re.compile(r"식|공식|관계|값|크기|얼마|몇|구하|계산|산정|산출|추정|비\b|비는|비\(|거리|위치|길이|높이|면적|체적|반력|"
                         r"응력|하중|모멘트|처짐|변위|변형|세장비|부재력|차수|분배율|강성|효율|유량|유속|속도|압력|시간|개수")
SHAPE_ASK = re.compile(r"모양|형태|선도|BMD|SFD|그래프|분포도")
SEQ_STEM = re.compile(r"순서|순으로|차례|절차|단계")
SEQ_KOR = re.compile(r"[ㄱ㉠]\s*[,·ㆍ\-→]?\s*[ㄴ㉡]\s*[,·ㆍ\-→]?\s*[ㄷ㉢]")
ARROW = re.compile(r"→|⇒|->")


@dataclass
class Split:
    stem: str
    choices: list[str]


def split_text(text: str) -> Split:
    """문항 글 → 발문 + 보기(보기 그림이면 빈 칸). 앞 번호("12.")는 뗀다."""
    t = re.sub(r"\s+", " ", text).strip()
    t = re.sub(r"^\d{1,3}\s*\.\s*", "", t)
    parts = CHOICE_SPLIT.split(t)
    if len(parts) < 3:
        return Split(t, [])
    return Split(parts[0].strip(), [p.strip() for p in parts[1:]])


def _numeric_choice(c: str) -> bool:
    if not c:
        return False
    han = re.sub(NUM_WORDS, "", c)
    han = re.findall(r"[가-힣]", han)
    has_num = bool(re.search(r"\d", c))
    if len(han) <= 2 and (has_num or FORMULA_RE.search(c)):
        return True
    return has_num and bool(UNIT_RE.search(c)) and len(han) <= 6 and len(c) <= 40


# ───────────────────────── 유형 ─────────────────────────

@dataclass
class TypeResult:
    qtype: str            # calc / law / concept
    sure: bool
    sequence: bool
    why: str = ""


def judge_type(text: str, is_law: bool = False) -> TypeResult:
    sp = split_text(text)
    stem, ch = sp.stem, sp.choices
    filled = [c for c in ch if c]
    seq = bool(SEQ_STEM.search(stem) and (SEQ_KOR.search(text) or any(ARROW.search(c) for c in filled) or "순서" in stem)) \
        or (len(filled) >= 3 and sum(bool(ARROW.search(c)) for c in filled) >= 3)
    n_num = sum(_numeric_choice(c) for c in filled)
    concept_cue = bool(CONCEPT_CUE.search(stem))
    ask = bool(FORMULA_ASK.search(stem))
    stem_nums = len(re.findall(UNIT_RE, stem))

    given = bool(re.search(r"\d", stem) or re.search(r"그림|다음|아래|보기|식|공식|관계", stem))
    if len(filled) >= 3 and n_num >= len(filled) - 1 and n_num >= 3:
        if given:
            return TypeResult("calc", True, seq, "보기가 수치·수식")
        # 주어진 수치·그림 없이 숫자를 고르는 문항(최소 위성 수·궤도 경사각 …)은 외워 고르는 것 — 계산 아님
        return TypeResult("concept", False, seq, "수치 보기지만 주어진 값이 없음")
    if is_law:
        return TypeResult("law", True, seq, "법령·기준")
    if len(filled) >= 3:                                 # 글 보기
        if n_num >= 2 and ask and not concept_cue:
            return TypeResult("calc", False, seq, "보기 일부가 수치")
        if any(re.search(r"\d", c) for c in filled) and re.search(r"위치|어디|비교", stem) and stem_nums:
            return TypeResult("calc", False, seq, "수치가 든 문장 보기")
        return TypeResult("concept", True, seq, "보기가 글")
    # 보기가 그림(수식·도형) — 글자가 없음
    if SHAPE_ASK.search(stem):
        return TypeResult("concept", False, seq, "그림 보기 · 모양을 물음")
    if concept_cue and not re.search(r"식|공식", stem):
        return TypeResult("concept", False, seq, "그림 보기 · 설명을 물음")
    if ask or stem_nums:
        return TypeResult("calc", True, seq, "그림 보기 · 값·식을 물음")
    return TypeResult("concept", False, seq, "판단 근거 부족")


# ───────────────────────── 단원 ─────────────────────────

STOP = {"개요", "일반", "기타", "종류", "해법", "방법", "이용", "활용", "사항", "관한", "대한", "관련", "기초", "이론", "구성",
        "현황", "정의", "분류", "특성", "특징", "원리", "계산", "측정", "설치", "적용", "관리", "운용", "실시", "수립", "결정",
        "응용", "성질", "주요", "기본", "개념", "등", "및", "의", "과", "와"}
SUFFIX = ("으로", "에서", "에의", "와의", "과의", "의", "을", "를", "은", "는", "이", "가", "에", "와", "과", "로")


def _words(s: str) -> list[str]:
    out = []
    for w in re.split(r"[\s,·ㆍ/()（）\[\]、]+|및|또는", s):
        w = re.sub(r"^\d+\.?", "", w).strip()
        for suf in SUFFIX:
            if len(w) > len(suf) and w.endswith(suf):
                w = w[: -len(suf)]
                break
        if len(w) >= 2 and w not in STOP:
            out.append(w)
    return out


def _flat(s: str) -> str:
    return re.sub(r"[\s·ㆍ]+", "", s).lower()


@lru_cache(maxsize=4)
def _keywords(root: str | None) -> dict:
    p = (Path(root) if root else Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1])) / "standards") / "unit-keywords.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except OSError:
        return {}


@dataclass
class UnitIndex:
    """과목 하나의 단원별 근거 낱말과 무게."""
    units: list[dict]
    terms: dict[str, dict[str, float]] = field(default_factory=dict)   # unit id → {낱말: 무게}


def build_index(profile: S.Profile, subject: str, kw_root: str | None = None,
                corpus: list[str] | None = None) -> UnitIndex:
    """corpus = 같은 과목 문항 글(여러 회차). 주면 문항 대부분에 나오는 낱말("지구"·"위치"·"GNSS")의 무게를 낮춘다(tf-idf)."""
    units = profile.units(subject)
    sub_kw = _keywords(kw_root).get(profile.code, {}).get(subject, {})
    raw: dict[str, dict[str, float]] = {}
    for u in units:
        t: dict[str, float] = {}
        for w in _words(u["name"]):
            t[_flat(w)] = max(t.get(_flat(w), 0), 1.5)
        for it in u["items"]:
            for w in _words(it):
                t.setdefault(_flat(w), 1.0)
            if len(_flat(it)) >= 4:
                t[_flat(it)] = max(t.get(_flat(it), 0), 1.5)        # 세세항목 통째("단면2차모멘트")
        for k in sub_kw.get(u["id"], []):
            strong = k.startswith("!")
            k = _flat(k.lstrip("!"))
            t[k] = max(t.get(k, 0), 3.0 if strong else 1.5)
        raw[u["id"]] = t
    n = max(1, len(units))
    df: dict[str, int] = {}
    for t in raw.values():
        for k in t:
            df[k] = df.get(k, 0) + 1
    common: dict[str, float] = {}
    if corpus and len(corpus) >= 20:
        flat = [_flat(c) for c in corpus]
        for k in df:
            frac = sum(k in f for f in flat) / len(flat)
            # 문항 5% 이하에 나오면 그대로, 많이 나올수록 낮춤(50% → 약 0.23)
            common[k] = 1.0 if frac <= 0.05 else max(0.05, math.log(1 / frac) / math.log(20))
    terms = {uid: {k: w * math.log(1 + n / df[k]) * common.get(k, 1.0) for k, w in t.items()} for uid, t in raw.items()}
    return UnitIndex(units, terms)


@dataclass
class UnitResult:
    unit: str | None       # "주요-세부" 또는 None(미분류)
    sure: bool
    score: float
    runner_up: str | None
    hits: list[str]
    runner_score: float = 0.0


SURE_MIN = 1.5      # 확신: 점수가 이 이상이고
SURE_RATIO = 2.0    # 둘째 단원 점수의 이 배 이상(C2 실측 2026-10-24: 토목 응용역학 확신 84%·정답 98%, 측량 1과목 맹검 61%·89% — ADR 021 4.5)


def judge_unit(text: str, idx: UnitIndex) -> UnitResult:
    sp = split_text(text)
    stem, body = _flat(sp.stem), _flat(" ".join(sp.choices))
    vocab = {k for t in idx.terms.values() for k in t}
    found_stem = {k for k in vocab if k in stem}
    found_body = {k for k in vocab if k in body} - found_stem
    # 더 긴 근거 낱말 안에 든 짧은 낱말은 버린다("부정정보" 안 "정정보", "휨모멘트" 안 "모멘트")
    def keep(found: set[str], hay: str) -> set[str]:
        return {k for k in found if not any(k != K and k in K for K in found)}
    found_stem, found_body = keep(found_stem, stem), keep(found_body, body)
    scores: list[tuple[float, str, list[str]]] = []
    for uid, t in idx.terms.items():
        sc, hits = 0.0, []
        for k, w in t.items():
            if k in found_stem:
                sc += w
                hits.append(k)
            elif k in found_body:
                sc += w * 0.5
                hits.append(k + "(보기)")
        scores.append((sc, uid, hits))
    scores.sort(key=lambda x: -x[0])
    if not scores or scores[0][0] <= 0:
        return UnitResult(None, False, 0.0, None, [])
    top, second = scores[0], (scores[1] if len(scores) > 1 else (0.0, None, []))
    sure = top[0] >= SURE_MIN and top[0] >= SURE_RATIO * max(second[0], 1e-9)
    return UnitResult(top[1], sure, round(top[0], 2), second[1], top[2], round(second[0], 2))


# ───────────────────────── 한 문항 ─────────────────────────

@dataclass
class Classified:
    unit: str | None
    unit_sure: bool
    qtype: str
    type_sure: bool
    sequence: bool

    @property
    def needs_pick(self) -> bool:
        """몰아 고르기 목록에 올릴지(4.5) — 단원이나 유형이 확신 없음."""
        return not (self.unit_sure and self.type_sure)


def classify(text: str, idx: UnitIndex | None, is_law: bool = False) -> Classified:
    t = judge_type(text, is_law)
    if idx is None or not idx.units:
        return Classified(None, True, t.qtype, t.sure, t.sequence)   # 출제기준 단원이 없는 프로필: 단원 판정 안 함
    u = judge_unit(text, idx)
    return Classified(u.unit if u.sure or u.unit else None, u.sure, t.qtype, t.sure, t.sequence)
