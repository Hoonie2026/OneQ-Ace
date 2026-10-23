"""큐넷 출제기준 PDF 읽기(ADR 021 1절, PREP-PLAN-v0.5 A1).

입력: 큐넷 출제기준 자료실 보고서 보기 창(Crownix)에서 [저장]한 글자 PDF.
  1쪽 머리 표: 직무분야·중직무분야·자격종목·적용기간 / 검정방법·문제수·시험시간
  본문 표:    필기과목명 | 문제수 | 주요항목 | 세부항목 | 세세항목 (쪽이 바뀌면 첫 줄에 과목·주요·세부를 되풀이)
  뒤쪽:       출제기준(실기) — 필기 프로필에는 쓰지 않음(과목명만 참고로 남김)

출력: 출제기준 프로필(standards/*.json과 같은 모양) + 과목마다 majors(주요항목 → 세부항목 → 세세항목).
단원 = 세부항목(ADR 021 4.1), 주요항목은 머리글.

명령줄:  python -m oneq_prep.qnet_standard <pdf> [--code CIVIL] [--out 파일.json]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber

from . import standards as S

NUM_RE = re.compile(r"^\s*(\d{1,2})\s*\.\s*")       # "1. 힘과 모멘트" / "1.오일러방정식…"
PERIOD_RE = re.compile(r"(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*~\s*(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})")
MINUTES_RE = re.compile(r"(?:(\d+)\s*시간)?\s*(?:(\d+)\s*분)?")


class StandardPdfError(ValueError):
    """출제기준 PDF로 읽을 수 없음(사용자에게 그대로 보여 줄 문장)."""


@dataclass
class Detail:
    no: int
    name: str
    items: list[str] = field(default_factory=list)
    item_nos: list[int | None] = field(default_factory=list, repr=False)   # 검사용(출력 안 함)


@dataclass
class Major:
    no: int
    name: str
    details: list[Detail] = field(default_factory=list)
    raw_no: int | None = field(default=None, repr=False)   # 문서에 적힌 번호(없을 수 있음)


@dataclass
class Subject:
    name: str
    count: int
    majors: list[Major] = field(default_factory=list)


@dataclass
class StandardDoc:
    cert_name: str
    field: str                       # 직무분야/중직무분야
    period_from: str                 # YYYY-MM-DD
    period_to: str
    method: str                      # 검정방법(객관식 …)
    total_count: int | None
    minutes: int | None
    subjects: list[Subject]
    practical_subjects: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def is_current(self, today: dt.date | None = None) -> bool:
        d = (today or dt.date.today()).isoformat()
        return self.period_from <= d <= self.period_to

    def unit_count(self) -> int:
        return sum(len(m.details) for s in self.subjects for m in s.majors)


# ───────────────────────── 칸 글자 ─────────────────────────

class _Joiner:
    """칸 안 줄 잇기. 보기 창은 칸 폭에서 글자 단위로 줄을 바꾸며 그 자리 띄어쓰기를 지운다.
    줄 끝 남은 폭만으로는 못 가른다(실측: 낱말 중간 "안전과|의" 11.6pt, 낱말 사이 "체제 및|운용" 11.5pt) →
    1) 다음 첫 글자가 확실히 들어갈 자리가 남았으면 띄움(그 자리에서 바꿀 까닭은 띄어쓰기뿐)
    2) "및·등·또는" 앞뒤, 쉼표 뒤는 띄움
    3) 같은 문서의 한 줄 안(띄어쓰기 믿을 수 있음)에 "앞말 뒷말"/"앞말뒷말" 중 한쪽만 나오면 그쪽
    4) 앞 낱말이 두 글자 이상이고 "~한·~는·~된·~할·~될"로 끝나면 띄움(관한 사항, 요구되는 사항)
    5) 나머지는 붙임(글자 단위 줄바꿈이 훨씬 흔함)"""

    SPACE_WORDS = {"및", "등", "또는", "와", "과"}
    ADNOMINAL = ("한", "는", "된", "할", "될")

    def __init__(self):
        self.corpus: list[str] = []

    def learn(self, lines: list[dict]) -> None:
        self.corpus.extend(re.sub(r"\s+", " ", ln["text"]).strip() for ln in lines)

    def _seen(self, s: str) -> int:
        return sum(s in c for c in self.corpus)

    def spaced(self, prev: dict, cur: dict, cell_x1: float, pad: float) -> bool:
        a, b = prev["text"].rstrip(), cur["text"].lstrip()
        if not a or not b:
            return False
        if b[0] in "·)]" or a[-1] in "·([" or (b[0] == "(" and a[-1].isalnum()):
            return False                                  # "추정|·결정", "시스템|(GIS)"
        first = next((ch for ch in cur["chars"] if ch["text"].strip()), None)
        need = (first["x1"] - first["x0"]) if first else 10.0
        if cell_x1 - prev["x1"] >= need + pad + 0.5:
            return True
        tail, head = a.split()[-1], b.split()[0]
        if tail in self.SPACE_WORDS or head in self.SPACE_WORDS or a.endswith(","):
            return True
        if not (a[-1].isalnum() and b[0].isalnum()):
            return False
        sp, jn = self._seen(f"{tail} {head}"), self._seen(f"{tail}{head}")
        if sp and not jn:
            return True
        if jn and not sp:
            return False
        return len(tail) >= 2 and tail.endswith(self.ADNOMINAL)

    def join(self, lines: list[dict], bbox) -> str:
        if not lines:
            return ""
        pad = max(0.5, min(4.0, lines[0]["x0"] - bbox[0]))
        out = lines[0]["text"].strip()
        for prev, cur in zip(lines, lines[1:]):
            out += (" " if self.spaced(prev, cur, bbox[2], pad) else "") + cur["text"].strip()
        return re.sub(r"\s+", " ", out).strip()


def _cell_lines(page, bbox) -> list[dict]:
    crop = page.crop(bbox, strict=False)
    return [ln for ln in crop.extract_text_lines(return_chars=True) if ln["text"].strip()]


def _split_no(text: str) -> tuple[int | None, str]:
    m = NUM_RE.match(text)
    if not m:
        return None, text.strip()
    return int(m.group(1)), text[m.end():].strip()


def _rows(page, table, joiner: _Joiner) -> list[list[str | None]]:
    return [[(joiner.join(_cell_lines(page, c), c) if c else None) for c in r.cells] for r in table.rows]


def _flat(text: str | None) -> str:
    return re.sub(r"\s+", "", text or "")


# ───────────────────────── 머리 표 ─────────────────────────

def _header(rows: list[list[str | None]], doc_kw: dict) -> None:
    cells = [c for r in rows for c in r if c]
    flat = [_flat(c) for c in cells]
    def after(label: str) -> str | None:
        for i, f in enumerate(flat):
            if f == label and i + 1 < len(cells):
                return cells[i + 1]
        return None
    if (v := after("자격종목")) and not doc_kw.get("cert_name"):
        doc_kw["cert_name"] = _flat(v)
    fields = [x for x in (after("직무분야"), after("중직무분야")) if x]
    if fields and not doc_kw.get("field"):
        doc_kw["field"] = "/".join(_flat(x) for x in fields)
    if (v := after("적용기간")) and not doc_kw.get("period_from"):
        m = PERIOD_RE.search(_flat(v).replace("~", " ~ "))
        if m:
            y1, m1, d1, y2, m2, d2 = map(int, m.groups())
            doc_kw["period_from"] = f"{y1:04d}-{m1:02d}-{d1:02d}"
            doc_kw["period_to"] = f"{y2:04d}-{m2:02d}-{d2:02d}"
    if (v := after("검정방법")) and not doc_kw.get("method"):
        doc_kw["method"] = _flat(v)
    if (v := after("문제수")) and doc_kw.get("total_count") is None and _flat(v).isdigit():
        doc_kw["total_count"] = int(_flat(v))
    if (v := after("시험시간")) and doc_kw.get("minutes") is None:
        m = MINUTES_RE.fullmatch(_flat(v))
        if m and (m.group(1) or m.group(2)):
            doc_kw["minutes"] = int(m.group(1) or 0) * 60 + int(m.group(2) or 0)


# ───────────────────────── 본문 표 ─────────────────────────

class _Builder:
    def __init__(self):
        self.subjects: list[Subject] = []
        self.warnings: list[str] = []

    def _same(self, a: str, b: str) -> bool:
        return S.norm(a) == S.norm(b)

    def row(self, subj: str | None, count: str | None, major: str | None, detail: str | None, item: str | None,
            page_first: bool) -> None:
        # 과목
        if subj:
            cur = self.subjects[-1] if self.subjects else None
            if cur is None or not self._same(cur.name, subj):
                n = int(_flat(count)) if count and _flat(count).isdigit() else 0
                if not n:
                    self.warnings.append(f"과목 '{subj}' 문제수를 읽지 못함")
                self.subjects.append(Subject(_flat_name(subj), n))
        if not self.subjects:
            return
        s = self.subjects[-1]
        # 주요항목(번호가 없을 수도 있음 — 토목기사 측량학 "측량학일반") → 순서로 번호를 매긴다
        if major:
            no, name = _split_no(major)
            cur = s.majors[-1] if s.majors else None
            a, b = (S.norm(cur.name), S.norm(name)) if cur else ("", "")
            if cur is not None and (a == b or (no is not None and no == cur.raw_no and (a.startswith(b) or b.startswith(a)))):
                if len(name) > len(cur.name):
                    cur.name = name                       # 쪽 끝에서 잘린 칸 → 긴 쪽
            elif cur is not None and no is None and page_first and a.endswith(b):
                pass                                      # 쪽을 넘어 잘린 칸의 나머지("…관한" | "사항")
            else:
                s.majors.append(Major(len(s.majors) + 1, name, raw_no=no))
                if no is not None and no != len(s.majors):
                    self.warnings.append(f"{s.name}: 주요항목 번호 {no} ≠ 순서 {len(s.majors)} ('{name}')")
        if not s.majors:
            if detail or item:
                s.majors.append(Major(1, ""))
                self.warnings.append(f"{s.name}: 주요항목 없이 세부항목이 나옴")
            else:
                return
        m = s.majors[-1]
        if detail:
            no, name = _split_no(detail)
            cur = m.details[-1] if m.details else None
            if cur is None or not self._same(cur.name, name):
                m.details.append(Detail(no if no is not None else len(m.details) + 1, name))
        if item:
            if not m.details:
                m.details.append(Detail(1, ""))
                self.warnings.append(f"{s.name}: 세부항목 없이 세세항목이 나옴")
            d = m.details[-1]
            no, name = _split_no(item)
            if page_first and d.items and no is not None and d.item_nos[-1] == no:
                return                                    # 쪽 첫 줄 되풀이
            if no is None and d.items and page_first and d.item_nos[-1] is not None:
                d.items[-1] = d.items[-1] + " " + name     # 쪽을 넘어 이어진 세세항목
            else:
                d.items.append(name)
                d.item_nos.append(no)


def _flat_name(s: str) -> str:
    """과목명: 줄바꿈에서 생긴 공백만 정리(표기 그대로 — 공백 차이는 norm으로 비교)."""
    return re.sub(r"\s+", " ", s).strip()


def parse(pdf_path: Path) -> StandardDoc:
    pdf_path = Path(pdf_path)
    head: dict = {}
    b = _Builder()
    practical: list[str] = []
    section = None                                  # "written" / "practical"
    try:
        pdf = pdfplumber.open(str(pdf_path))
    except Exception as e:                          # 깨진 파일·PDF 아님
        raise StandardPdfError(f"PDF를 열 수 없습니다: {pdf_path.name} ({e})") from e
    joiner = _Joiner()
    with pdf:
        found = [(page, page.find_tables()) for page in pdf.pages]
        for page, tables in found:                  # 1차: 한 줄 안 글자(띄어쓰기 믿을 수 있음) 모으기
            for t in tables:
                for r in t.rows:
                    for c in r.cells:
                        if c:
                            joiner.learn(_cell_lines(page, c))
        for page, tables in found:
            text = _flat(page.extract_text() or "")
            if "출제기준(실기)" in text:
                section = "practical"
            elif "출제기준(필기)" in text:
                section = "written"
            page_first = True
            for t in tables:
                rows = _rows(page, t, joiner)
                if not rows:
                    continue
                hdr = [_flat(c) for c in rows[0]]
                if "필기과목명" in hdr:
                    col = {h: i for i, h in enumerate(hdr) if h}
                    need = ["필기과목명", "문제수", "주요항목", "세부항목", "세세항목"]
                    if not all(k in col for k in need):
                        b.warnings.append(f"{page.page_number}쪽: 표 머리글이 예상과 다름 {hdr}")
                        continue
                    for r in rows[1:]:
                        g = lambda k: (r[col[k]] if col[k] < len(r) else None) or None  # noqa: E731
                        b.row(g("필기과목명"), g("문제수"), g("주요항목"), g("세부항목"), g("세세항목"), page_first)
                        page_first = False
                elif "실기과목명" in hdr:
                    for r in rows[1:]:
                        if r and r[0] and not any(S.norm(r[0]) == S.norm(x) for x in practical):
                            practical.append(_flat_name(r[0]))
                elif section != "practical" and any(_flat(c) in ("자격종목", "검정방법") for r in rows for c in r if c):
                    _header(rows, head)
    if not b.subjects:
        raise StandardPdfError(f"{pdf_path.name}: 필기 출제기준 표(필기과목명·문제수·주요항목…)를 찾지 못했습니다. "
                               "큐넷 출제기준 보기 창에서 [저장]한 PDF인지 확인하세요.")
    missing = [k for k in ("cert_name", "period_from") if not head.get(k)]
    if missing:
        b.warnings.append("머리 표에서 못 읽음: " + ", ".join({"cert_name": "자격종목", "period_from": "적용기간"}[k] for k in missing))
    doc = StandardDoc(
        cert_name=head.get("cert_name", ""), field=head.get("field", ""),
        period_from=head.get("period_from", ""), period_to=head.get("period_to", ""),
        method=head.get("method", ""), total_count=head.get("total_count"), minutes=head.get("minutes"),
        subjects=b.subjects, practical_subjects=practical, warnings=b.warnings)
    _check(doc)
    return doc


def _check(doc: StandardDoc) -> None:
    w = doc.warnings
    s_sum = sum(s.count for s in doc.subjects)
    if doc.total_count is not None and s_sum != doc.total_count:
        w.append(f"과목 문제수 합 {s_sum} ≠ 전체 문제수 {doc.total_count}")
    for s in doc.subjects:
        if not s.majors:
            w.append(f"{s.name}: 주요항목이 없음")
        for m in s.majors:
            if not m.details:
                w.append(f"{s.name} · {m.name}: 세부항목이 없음")
            nos = [d.no for d in m.details]
            if nos != list(range(1, len(nos) + 1)):
                w.append(f"{s.name} · {m.name}: 세부항목 번호가 1부터 이어지지 않음 {nos}")
            for d in m.details:
                if not d.items:
                    w.append(f"{s.name} · {d.name}: 세세항목이 없음")
                elif any(n is not None for n in d.item_nos) and d.item_nos != list(range(1, len(d.item_nos) + 1)):
                    w.append(f"{s.name} · {d.name}: 세세항목 번호가 1부터 이어지지 않음 {d.item_nos}")


# ───────────────────────── 프로필로 ─────────────────────────

def grade_of(cert_name: str) -> str:
    n = re.sub(r"\(.*\)$", "", cert_name)
    for g in ("산업기사", "기능장", "기술사", "기능사", "기사"):
        if n.endswith(g):
            return g
    return ""


def to_profile(doc: StandardDoc, code: str, base: S.Profile | None = None, source_name: str = "") -> dict:
    """출제기준 프로필(dict). base(같은 종목의 기존 프로필)가 있으면:
    - 과목 이름이 공백·가운뎃점만 다르면 기존 표기를 쓴다(이미 만든 팩의 과목명과 맞춤)
    - aliases·excluded·legacy·isLaw는 이어받는다
    - 과목 이름이 바뀐 것은 note에 남긴다(별칭은 자동으로 만들지 않음 — 순서만 같다고 같은 과목이라 할 수 없음)"""
    if not S.CODE_RE.match(code):
        raise ValueError("종목 코드는 영문 대문자로 시작하는 2~16자(예: CIVIL)")
    def loose(n: str) -> str:                       # 괄호 속 덧붙임까지 무시("…위성측위시스템(GNSS)" = "…위성측위시스템")
        return S.norm(re.sub(r"[(（][^)）]*[)）]", "", n))
    base_by_norm = {S.norm(s["name"]): s for s in (base.subjects if base else [])}
    base_by_norm.update({loose(s["name"]): s for s in (base.subjects if base else []) if loose(s["name"]) not in base_by_norm})
    subjects = []
    renamed = []
    for s in doc.subjects:
        old = base_by_norm.get(S.norm(s.name)) or base_by_norm.get(loose(s.name))
        name = old["name"] if old else s.name
        d: dict = {"name": name, "count": s.count}
        if old and old.get("isLaw"):
            d["isLaw"] = True
        d["majors"] = [{"no": m.no, "name": m.name,
                        "details": [{"no": x.no, "name": x.name, "items": x.items} for x in m.details]}
                       for m in s.majors]
        subjects.append(d)
    if base:
        new_norms = {S.norm(s["name"]) for s in subjects}
        renamed = [s["name"] for s in base.subjects if S.norm(s["name"]) not in new_norms]
    year = doc.period_from[:4] or "0000"
    note = f"큐넷 출제기준 {doc.period_from}~{doc.period_to}({len(subjects)}과목 {sum(s['count'] for s in subjects)}문항"
    if doc.minutes:
        note += f", {doc.minutes // 60}시간" + (f" {doc.minutes % 60}분" if doc.minutes % 60 else "")
    note += ")"
    if base and base.note and not base.note.startswith("큐넷 출제기준"):
        note += ". " + base.note                    # 손으로 적은 메모(옛 기준 합치기 등)는 이어 둠
    if renamed:
        note += f". 이전 프로필에만 있는 과목: {', '.join(renamed)} — 별칭·제외는 직접 확인"
    prof = {
        "code": code,
        "name": doc.cert_name or (base.name if base else ""),
        "grade": grade_of(doc.cert_name) or (base.grade if base else ""),
        "version": year,
        "note": note,
        "period": {"from": doc.period_from, "to": doc.period_to},
        "passRule": base.pass_rule if base else {"subjectMin": 40, "avgMin": 60},
        "subjects": subjects,
        "aliases": dict(base.aliases) if base else {},
        "excluded": list(base.excluded) if base else [],
        "source": {"type": "qnet-standard-pdf", "file": source_name,
                   "readAt": dt.date.today().isoformat()},
    }
    if base and base.legacy:
        prof["legacy"] = base.legacy
    return prof


# ───────────────────────── 명령줄 ─────────────────────────

def summary(doc: StandardDoc) -> str:
    out = [f"{doc.cert_name}  {doc.period_from} ~ {doc.period_to}"
           + ("  (현행)" if doc.period_from and doc.is_current() else ""),
           f"{doc.method} {doc.total_count}문항 · {doc.minutes}분 · {len(doc.subjects)}과목 · 단원(세부항목) {doc.unit_count()}개"]
    for s in doc.subjects:
        out.append(f"  {s.name} ({s.count}문항) — 주요 {len(s.majors)} · 세부 {sum(len(m.details) for m in s.majors)}")
        for m in s.majors:
            out.append(f"    {m.no}. {m.name}: " + " / ".join(d.name for d in m.details))
    if doc.practical_subjects:
        out.append("실기(참고): " + ", ".join(doc.practical_subjects))
    for w in doc.warnings:
        out.append(f"! {w}")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="oneq_prep.qnet_standard", description="큐넷 출제기준 PDF → 출제기준 프로필(JSON)")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--code", help="종목 코드(예: CIVIL). 주면 프로필 JSON을 만든다(같은 코드의 기존 프로필을 이어받음)")
    ap.add_argument("--out", type=Path, help="프로필 저장 경로(기본: 화면에 출력)")
    a = ap.parse_args(argv)
    try:
        doc = parse(a.pdf)
    except StandardPdfError as e:
        sys.exit(str(e))
    print(summary(doc))
    if a.code:
        try:
            base = S.load(a.code)
        except FileNotFoundError:
            base = None
        prof = to_profile(doc, a.code, base, a.pdf.name)
        text = json.dumps(prof, ensure_ascii=False, indent=2)
        if a.out:
            a.out.write_text(text + "\n", encoding="utf-8")
            print(f"\n프로필 저장: {a.out}")
        else:
            print(text)


if __name__ == "__main__":
    main()
