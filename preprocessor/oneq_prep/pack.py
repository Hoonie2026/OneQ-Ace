"""기출 PDF → 원큐합격 문제팩(.zip, oqp/1) + 검수 보고서(HTML).

사용 예:
    python -m oneq_prep <기출.pdf ...> <출력폴더> --cert SURVEY --prepared-by Hoonie
    (python -m oneq_prep.pack 도 같다)

흐름: 추출(extract, 스캔본이면 ocr) → 렌더링·정답 표시 제거(render) → 출제기준 프로필로 과목 정리(standards)
      → [구기준 회차] 과목 재배정 제안(reassign) → 검수 파일 반영 → 팩 쓰기 + 보고서(report)
막히는 문제(정답 불일치·모르는 과목·재배정 미확인 등)가 있는 회차는 팩을 만들지 않고 검수 파일을 남긴다.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import re
import sys
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from . import __version__
from . import lawtag
from . import examinfo
from . import standards as S
from .extract import analyze
from .reassign import Reference, Suggestion
from .render import (crop_question, mark_leaks, mask_filled_labels, mask_ocr_filled, pen_mark_answers, red_ink_answers, redraw_pen_labels, regions_for,
                     remove_highlight_near_labels, remove_red_ink, render_pages)

REVIEW_DIR = "review"
# 회차별 팩은 안쪽 폴더에(사용자 2026-11-17 — 문제팩 폴더에는 종목마다 압축 파일 하나만 보이게). 같은 회차를 다시 만들 때
# 판 비교·정답 교차 확인·종목 묶음을 만드는 재료로만 쓴다. Windows에서는 숨김 폴더
ROUNDS_DIR = ".회차별"


def rounds_dir(out_dir: Path) -> Path:
    """문제팩 폴더 안의 회차별 팩 폴더(없으면 만들고, 예전처럼 바깥에 있던 회차 팩은 옮겨 옴)."""
    d = Path(out_dir) / ROUNDS_DIR
    new = not d.exists()
    d.mkdir(parents=True, exist_ok=True)
    if new:
        import sys
        if sys.platform == "win32":
            try:
                import ctypes
                ctypes.windll.kernel32.SetFileAttributesW(str(d), 0x2)      # FILE_ATTRIBUTE_HIDDEN
            except Exception:  # noqa: BLE001
                pass
    for f in Path(out_dir).glob("oneq-*.zip"):
        if re.fullmatch(r"oneq-[A-Za-z0-9]+-\d{4}-\d+\.zip", f.name):
            try:
                f.replace(d / f.name)
            except OSError:
                pass
    return d
REASSIGN_MIN_CONF = 0.6     # 이 이상인 재배정 제안만 자동 적용(낮으면 시험지 과목 그대로), 보고서에서 낮은 것은 강조
LEAK_DOUBT = "정답 표시가 남아 보임"
PEN_DOUBT = "손글씨 정답 표시(번호 자리를 짐작)"
# 정답 표시가 없는 PDF(학생용 등) — 이만큼 넘는 문항에서 정답을 못 찾으면 회차 전체를 만들지 않음(사용자 2026-11-17)
NO_ANSWER_RATIO = 0.5


def _unit_score(texts: list[str], profile: S.Profile, std: str) -> float:
    """문항 글 묶음이 출제기준 과목 std 내용인 정도 = 그 과목 이름·주요항목·세부항목의 한글 2글자 묶음이 문항 글에 나오는 비율."""
    names = [std] + [f"{u.get('major', '')} {u.get('name', '')}" for u in (profile.units(std) or [])]
    keys = {w[i:i + 2] for n in names for w in re.findall(r"[가-힣]{2,}", n) for i in range(len(w) - 1)}
    keys -= {"설계", "일반", "기타", "관련", "규정", "기준"}           # 어느 과목에나 나오는 낱말
    grams = [w[i:i + 2] for t in texts for w in re.findall(r"[가-힣]{2,}", t) for i in range(len(w) - 1)]
    return sum(g in keys for g in grams) / len(grams) if grams else 0.0


def _garbled(raw: str) -> bool:
    """OCR이 과목명을 엉뚱한 글자로 읽음(예: '진-1=(二。고그呑卜') — 한글 음절이 절반이 안 되면 못 읽은 것으로."""
    n = S.norm(raw)
    if not n:
        return True
    return sum(1 for ch in n if "가" <= ch <= "힣") < 0.5 * len(n)


def _subjects_by_number(layout, profile: S.Profile, notes: list[str]) -> None:
    """스캔본에서 과목 머리말을 놓치면 다음 과목 문항이 앞 과목에 붙는다(철도토목기사 2010: '측량학' 35문항).
    읽은 머리말의 과목 번호가 건너뛰면(2 → 4) 그 사이 문항을 나눈다 — 출제기준 과목의 문항 수가 모두 c로 같을 때만.
    번호를 읽은 문항은 (번호 - 1) // c + 1로, 번호를 짐작한 문항은 앞 문항을 따르되 한 과목이 c문항을 넘으면 다음 과목으로.
    못 읽은 머리말 자리는 'n과목'(이름을 못 읽음)으로 두어 아래 순서 맞추기가 출제기준 과목을 고르게 한다."""
    counts = {s["count"] for s in profile.subjects}
    if len(counts) != 1 or layout.numbering != "continuous" or not layout.questions:
        return
    c = counts.pop()
    heads = sorted({q.subject_no for q in layout.questions})
    if len(heads) < 1 or heads[-1] > 8:
        return
    moved = 0
    for i, lo in enumerate(heads):
        hi = (heads[i + 1] - 1) if i + 1 < len(heads) else lo
        span = [q for q in layout.questions if q.subject_no == lo]
        if hi == lo or len(span) <= c:
            continue
        cur, n = lo, 0
        for q in span:
            by_no = (q.no - 1) // c + 1
            if not q.guessed and cur <= by_no <= hi:
                if by_no != cur:
                    cur, n = by_no, 0
            elif n >= c and cur < hi:
                cur, n = cur + 1, 0
            if q.subject_no != cur:
                q.subject_no = cur
                moved += 1
            n += 1
    if not moved:
        return
    for k in range(1, max(q.subject_no for q in layout.questions) + 1):
        if k not in layout.subjects and any(q.subject_no == k for q in layout.questions):
            layout.subjects[k] = f"{k}과목"
    layout.subjects = dict(sorted(layout.subjects.items()))
    notes.append(f"과목 머리말을 못 읽은 곳이 있어 문항 번호·문항 수(과목당 {c}문항)로 과목을 나눔 — {moved}문항")


def no_answer_issue(items: list, scan: bool = False) -> bool:
    """정답을 찾은 문항이 절반이 안 되는 PDF(학생용 등)인지 — 문제팩은 만들고 안내만(정답은 학습앱에서 지정, 사용자 2026-11-17)."""
    live = [it for it in items if not it.excluded]
    if len(live) < 10:
        return False
    missing = sum(1 for it in live if it.answer is None)
    return missing > len(live) * NO_ANSWER_RATIO


AUTO_EXCLUDE = "자동 제외: "  # 정답을 믿을 수 없어 뺀 문항의 사유 머리(manifest.excluded reason "other")
NO_ANSWER_NOTE = "정답 표시를 절반 넘게 찾지 못함 — 문항은 만들고 정답은 학습앱에서 지정(교사용 PDF를 올리면 정답까지 들어감)"
FEW_QUESTIONS_ISSUE = "스캔 상태가 좋지 않아 문항을 절반도 만들지 못했어요 — 더 선명한 PDF를 올려 주세요"


def few_questions_issue(items: list, profile) -> str | None:
    """문항 그림을 만들 수 있는 문항이 출제기준 문항 수의 절반도 안 되면 회차를 포기(정답 유무와 관계없이, 사용자 2026-11-17).
    현행 출제기준에 없는 과목·찾지 못한 문항·두 문항이 붙은 문항은 '만든 문항'에 넣지 않는다."""
    want = sum(s["count"] for s in profile.subjects)
    made = sum(1 for it in items if not it.excluded and MERGED_DOUBT not in (it.doubt or ""))
    return FEW_QUESTIONS_ISSUE if want and made < 0.5 * want else None


MERGED_NEXT = "다음 문항이 붙음"
MERGED_DOUBT = "다음 문항이 붙어 읽힘"
TALL_RATIO = 1.15


def merged_next(q) -> bool:
    """스캔본: 문항 번호를 못 읽은 다음 문항이 이 문항에 붙음 — 둘째 줄부터 'n+1.'(또는 n+2.)로 시작하는 줄이 있음
    (철도토목기사 2022 8·9번: 9번의 보기·정답이 8번 것으로 읽힘, 사용자 PC 2026-11-17). 정답을 믿을 수 없어 뺀다."""
    x0 = q.lines[0].x0 if q.lines else 0
    for ln in q.lines[1:]:
        # OCR은 '44.'를 '44+'·'27•'로도 읽음. 번호 뒤에 한글 발문이 와야 함 — 보기 값('76.8m'·'0.7m/s')과 구별
        m = re.match(r"\s*(\d{1,3})\s*[.,+•·:]\s*[가-힣(]", ln.text)
        # 다음 번호뿐 아니라 다른 아무 문항 번호든(2009: 41번 그림에 89번이 붙음 — 쪽 배치가 뒤섞인 스캔본)
        if m and int(m.group(1)) != q.no and 1 <= int(m.group(1)) <= 120 and abs(ln.x0 - x0) < 25:
            return True
    # 번호 줄까지 못 읽은 경우: 줄 간격이 줄 높이의 2.4배 넘는 큰 빈칸의 앞뒤에 각각 보기 줄(원문자로 시작하고 글이 이어짐)이 있음
    # = 보기 묶음이 둘. 그림은 지문과 보기 사이에 오므로 빈칸 앞에 보기 줄이 없음, 그림 속 번호만 있는 줄('① ① ①')은 보기 줄이 아님
    lines = sorted((ln for ln in q.lines if ln.chars), key=lambda ln: (ln.page, ln.col, ln.top))
    if len(lines) < 3:
        return False
    hs = sorted(ln.bottom - ln.top for ln in lines)
    h = hs[len(hs) // 2]

    def choice_line(ln) -> bool:
        t = ln.text.strip()
        if not re.match(r"[①-⑤㉠-㉿]", t):
            return False
        rest = t[1:].lstrip()
        return len(rest) >= 2 and not re.match(r"[①-⑳㉠-㉿]", rest)

    # 발문 끝 '?' 둘이 보기 묶음(두 줄 이상)과 빈칸(줄 높이 1.3배 넘음)을 사이에 두고 떨어져 있음 = 다른 문항 발문(2014 18번)
    qi = [i for i, ln in enumerate(lines) if re.search(r"[가-힣]\s*\?", ln.text)]   # '(?)'(보기 번호를 잘못 읽음)는 빼고
    for i1, i2 in zip(qi, qi[1:]):
        if i2 - i1 < 3:
            continue
        for j in range(i1 + 2, i2 + 1):
            a, b = lines[j - 1], lines[j]
            if (a.page, a.col) != (b.page, b.col) or b.top - a.bottom > 1.0 * h:
                return True
    for i, (a, b) in enumerate(zip(lines, lines[1:])):
        if a.page == b.page and a.col == b.col and b.top - a.top > 2.4 * h:
            # 발문 끝 '?'도 빈칸 앞뒤에 각각 있어야(그림이 보기 사이에 있는 문항을 붙은 문항으로 잘못 보지 않게, 2026-11-17)
            if any(choice_line(ln) for ln in lines[:i + 1]) and any(choice_line(ln) for ln in lines[i + 1:]) \
                    and any("?" in ln.text for ln in lines[:i + 1]) and any("?" in ln.text for ln in lines[i + 1:]):
                return True
    return False


# 스캔본 쪽 머리글·바닥글(다른 쪽·다른 시험지 표지가 문항 구간에 끼어 듦 — 철도토목기사 2008·2010·2013·2022)
PAGE_JUNK = re.compile(r"국가기술자격|필기시험|수험번호|시험시간|자격종목|답안\s*카드|문제지\s*형별|"
                       r"^[A-Z]?\s*-?\s*\d{1,2}\s*-\s*\d{1,2}\s*-\s*\d{1,3}|HRDK|RDK|RDI|송정석|songjs|www\.|http|^[A-Z]\s*-\s*\d|기사\s*A\s*형?\s*$|^\s*\d{1,2}\s*-\s*\d{1,2}\s*$")


def trim_page_junk(layout, regions: dict) -> int:
    """스캔본: 문항 구간 안에 쪽 머리글·바닥글 줄이 있으면 그 줄 위에서 자른다(문항 그림에 시험지 표지·쪽 번호가 붙지 않게). 자른 수."""
    n = 0
    for q in layout.questions:
        regs = regions.get(q.no)
        if not regs:
            continue
        for ln in q.lines[1:]:
            if not PAGE_JUNK.search(ln.text):
                continue
            for i, r in enumerate(regs):
                if r.page == ln.page and r.col == ln.col and r.top < ln.top < r.bottom:
                    regs[i] = type(r)(r.page, r.col, r.top, ln.top - 2)
                    n += 1
    return n


def unsure_answer(it: "Item", leak) -> str | None:
    """정답을 믿을 수 없는 이유 — 있으면 그 문항은 팩에서 뺀다(사용자 2026-11-12, 검수 대신)."""
    w = " ".join(it.warnings)
    if MERGED_NEXT in w:                      # 그림이 망가진 문항이 먼저 — 정답이 없어도 '정답 미지정'으로 넣지 않게
        return AUTO_EXCLUDE + MERGED_DOUBT
    if leak:
        it.flags.append("answer-visible")     # 정답 표시가 그림에 남음 — 넣되 학습앱이 안내(사용자 2026-11-17)
    if it.answer is None:
        return AUTO_EXCLUDE + "정답 못 찾음"
    if "≠ 정답표" in w:
        return AUTO_EXCLUDE + "보기 표시와 정답표가 다름"
    if "보기 수" in w and "벗어남" in w:
        return AUTO_EXCLUDE + "정답 번호가 보기 수를 벗어남"
    if re.search(r"정답 표시 \d+개", w):
        return AUTO_EXCLUDE + "정답 표시가 여러 개"
    if leak:
        return AUTO_EXCLUDE + LEAK_DOUBT
    return None


# ───────────────────────── 회차 정보 ─────────────────────────

def content_hash(text: str) -> str:
    norm = re.sub(r"\s+", "", text)
    return "t:" + hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]


def _figure_boxes(pdf_path: Path) -> dict[int, list[tuple[float, float, float, float]]]:
    """페이지별 그림 영역(래스터 이미지, 표·도형 선). 'has-figure' 표시에 쓴다."""
    import pdfplumber
    out: dict[int, list] = {}
    with pdfplumber.open(pdf_path) as pdf:
        for pi, page in enumerate(pdf.pages):
            boxes = [(im["x0"], im["top"], im["x1"], im["bottom"]) for im in page.images]
            short = [o for o in page.lines + page.curves + page.rects
                     if (o["x1"] - o["x0"]) < page.width * 0.6 and (o["bottom"] - o["top"]) < page.height * 0.6]
            boxes += [(o["x0"], o["top"], o["x1"], o["bottom"]) for o in short]
            out[pi] = boxes
    return out


# ───────────────────────── 검수 파일 ─────────────────────────

def review_path(out_dir: Path, pack_id: str) -> Path:
    return out_dir / REVIEW_DIR / f"{pack_id}.review.json"


def load_review(out_dir: Path, pack_id: str) -> dict:
    p = review_path(out_dir, pack_id)
    if not p.exists():
        return {}
    d = json.loads(p.read_text(encoding="utf-8"))
    for k in ("answers", "acceptAlso", "exclude", "reassign", "subjectMap"):
        d.setdefault(k, {})
    return d


REVIEW_HELP = {
    "_설명": "이 파일을 고친 뒤 같은 명령을 다시 실행하면 반영된다. 키는 시험지 문항번호(팩의 no).",
    "subjectMap": "PDF 과목명 → 표준 과목명 또는 \"제외\"",
    "answers": "문항번호 → 정답 번호(정답을 못 찾았거나 표시·정답표가 다를 때)",
    "acceptAlso": "문항번호 → [추가 인정 번호] (복수정답·전항정답)",
    "exclude": "문항번호 → 사유 (판독 불가 등으로 팩에서 뺄 문항)",
    "reassign": "문항번호 → 표준 과목명 (구기준 회차 과목 재배정). 제안을 확인·수정한 뒤 reviewed를 true로",
    "reviewed": "사람이 검수를 마쳤으면 true → manifest.reviewedAt 기록, 재배정 반영",
}


# ───────────────────────── 준비(검사까지) ─────────────────────────

@dataclass
class Item:
    """보고서·팩에 쓰는 문항 하나."""
    no: int
    local_no: int
    pdf_subject: str
    subject: str | None          # 표준 과목명(제외면 None)
    answer: int | None
    answer_source: str | None
    answer_check: str | None
    accept_also: list[int]
    choice_count: int
    image: bytes
    img_size: tuple[int, int]
    text: str
    flags: list[str]
    warnings: list[str] = field(default_factory=list)
    excluded: str | None = None   # 제외 사유
    suggestion: Suggestion | None = None
    law_refs: list[str] = field(default_factory=list)   # 법령·기준 이름(ADR 019) — 팩 lawRefs
    doubt: str | None = None      # 정답을 믿을 수 없는 이유(ADR 024) — 교차 확인(C) → 안 되면 표시(B) 또는 제외
    alts: list[int] = field(default_factory=list)       # 다른 정답 후보(정답표 값·여러 표시) — 표시(B)일 때 함께 인정


@dataclass
class Prepared:
    pdf: Path
    pack_id: str
    exam: dict
    profile: S.Profile
    method: list[str]
    masked: int
    items: list[Item]
    issues: list[str]             # 막히는 문제(팩을 만들지 않음)
    notes: list[str]              # 참고
    numbering: str
    ocr: bool
    legacy: bool
    review: dict
    renamed: list[str] = field(default_factory=list)
    info: "examinfo.ExamInfo | None" = None   # 문서에서 읽은 종목·출처·근거(B2)
    unchanged: bool = False       # 출력 폴더에 내용이 같은 팩이 이미 있었음(묶음은 종목 전체 회차, 2026-11-16)
    missing: list = field(default_factory=list)   # 스캔본에서 찾지 못한 문항(번호, PDF 과목명) → manifest.excluded "unreadable"
    zip_path: Path | None = None
    review_file: Path | None = None
    supplement: bool = False      # 보충 문서(supplement.py) — 따로 팩을 만들지 않고 원본 회차에 더함


def prepare(pdf_path: Path, profile: S.Profile, out_dir: Path,
            date: str | None = None, round_no: int | None = None, image_quality: int = 80,
            reference: Reference | None = None, log=print, progress=None) -> Prepared:
    """progress(단계) — 처리 화면의 파일별 진행 막대용(ADR 021 6절): 읽기 → 문항 나누기 → 정답 → 분류(→ 팩은 쓰는 쪽)."""
    from .ocr import ENGINE_NAMES, load_ocr, needs_ocr, ocr_document, save_ocr

    step = progress or (lambda _s: None)
    step("읽기")

    issues: list[str] = []
    notes: list[str] = []
    doc = None
    if needs_ocr(pdf_path):
        # 스캔본: 먼저 OCR(ADR 022) — 종목·시행일도 OCR 글에서 읽는다
        log(f"  {pdf_path.name}: 텍스트층 없음 → OCR")
        doc = load_ocr(pdf_path)                   # 같은 파일을 전에 OCR했으면 그 결과(%APPDATA%\\OneQ-Ace\\logs\\ocr) — 원인 짚기·다시 만들기 빠르게
        if doc is None:
            doc = ocr_document(pdf_path)
            save_ocr(doc, pdf_path)
        notes.append(f"스캔본: {ENGINE_NAMES.get(doc.engine, doc.engine)}로 글자를 읽음 — 문항 경계·보기를 검수")
    # 종목·시행일·회차·출처는 문서 내용에서(ADR 021 2절) — 파일 이름은 쓰지 않음
    from . import supplement
    sup = None if doc else supplement.header(pdf_path)          # 보충 문서(직접 타이핑한 빠진 문항)
    info0 = examinfo.read(pdf_path, ocr_text=doc.text) if doc else None
    if sup:
        info0 = info0 or examinfo.read(pdf_path)
        info0.year = sup[0]
        info0.round = sup[1] or supplement.UNKNOWN_ROUND
    exam, info = examinfo.exam_of(pdf_path, profile, out_dir, date, round_no, info0)
    pack_id = examinfo.pack_id(profile.code, exam)
    if info.cert_name and S.norm(info.cert_name) != S.norm(profile.name):
        issues.append(f"이 파일은 '{info.cert_name}' 문서로 보입니다(고른 종목: {profile.name}) — 종목을 확인하세요")
    if exam.get("dateUnknown"):
        notes.append("시행일을 문서에서 찾지 못함 → " + (f"{exam['year']}년 {exam['round']}회(시행일 모름)" if exam["year"]
                                                    else f"0000년 {exam['round']}회로 지정"))
    review = load_review(out_dir, pack_id)

    step("문항 나누기")
    # 검수 없이 항상 팩을 만든다(사용자 2026-11-12 — 시험 준비생에게 검수를 맡기는 것은 비현실적, ADR 024):
    # 파일 단위 경고는 참고(notes)로, 문항 단위로 정답을 믿을 수 없으면 그 문항만 자동으로 뺀다(manifest.excluded)
    layout = analyze(pdf_path, ocr_pages=doc.pages if doc else None, free_numbers=bool(sup))
    notes += list(layout.warnings)                                     # 빠진 번호는 아래에서 번호마다
    table_ok = True
    if doc and doc.answer_pages:
        layout.answer_table = doc.answers      # 끝 쪽 정답표(칸 나눠 읽기, ADR 022 4절)
        msg = f"정답표({', '.join(str(p + 1) for p in doc.answer_pages)}쪽)에서 정답 {len(doc.answers)}개를 읽음"
        if doc.shape_answers:
            msg += f"(그중 {doc.shape_answers}개는 OCR이 못 읽어 같은 표의 글자 모양으로 맞춤)"
        notes.append(msg + (f" — {doc.unread_answers}칸은 못 읽어 그 문항은 뺌" if doc.unread_answers else ""))
        if len(doc.answers) + doc.unread_answers != len(layout.questions) + len(layout.missing):
            table_ok = False                       # 칸 수가 어긋나면 정답이 밀렸을 수 있음 → 정답표는 믿지 않음
            notes.append(f"정답표 칸 {len(doc.answers) + doc.unread_answers}개 ≠ 문항 {len(layout.questions)}개 — "
                         "정답표는 쓰지 않음(보기 표시가 없는 문항은 뺌)")

    step("정답")
    # 렌더링 + 정답 표시 제거
    if layout.highlights:
        pages, masked = render_pages(pdf_path, strip_yellow=True)
        method = ["highlight-remove"]
        n_hl = sum(len(v) for v in layout.highlights.values())
        if masked != n_hl:
            notes.append(f"형광 표시 {n_hl}개 중 {masked}개만 지움(남은 문항은 아래 '정답 표시가 남음'으로 뺌)")
    else:
        pages = render_pages(pdf_path)
        if layout.ocr:
            n_red = red_ink_answers(pages, layout)          # 빨간 펜 ✓·○(철도토목기사 스캔본, 사용자 2026-11-17)
            remove_red_ink(pages)
            redraw_pen_labels(pages, layout)                # 펜이 덮었던 정답 번호만 흐려 보이지 않게 넷 다 다시 그림
            if n_red:
                notes.append(f"빨간 펜 정답 표시 {n_red}문항을 읽고 그림에서 지움")
            masked = mask_ocr_filled(pages, layout) + n_red
            n_pen = pen_mark_answers(pages, layout)         # 검은 펜 ✓·／(철도토목기사 2018~2022 스캔본)
            if n_pen:
                notes.append(f"검은 펜 정답 표시 {n_pen}문항을 읽고 그림에서 지움(정답 확인 필요로 표시)")
            masked += n_pen
            masked += remove_highlight_near_labels(pages, layout)
        else:
            masked = mask_filled_labels(pages, layout)
        method = ["filled-glyph-replace"] if masked else ["none-needed"]
    leaks = {q.no: mark_leaks(pages, q) for q in layout.questions}
    leaks = {k: v for k, v in leaks.items() if v}

    regions = regions_for(layout)
    if layout.ocr:
        trim_page_junk(layout, regions)
    figs = _figure_boxes(pdf_path) if not layout.ocr else {}

    # 과목 정리(출제기준 프로필) — 이름이 정확히 맞지 않으면 비슷한 이름·과목 순서로 자동 대응(검수 없음, 2026-11-12)
    if layout.ocr:
        _subjects_by_number(layout, profile, notes)
    smap: dict[int, tuple[str, str | None]] = {}     # PDF 과목번호 → (PDF 이름, 표준 이름 또는 None=제외)
    renamed: list[str] = []
    pending: list[tuple[int, str]] = []
    unread: list[tuple[int, str]] = []
    n_pdf, n_std = len(layout.subjects), len(profile.subjects)
    for sno, raw in sorted(layout.subjects.items()):
        override = review.get("subjectMap", {}).get(raw)
        if override == "제외":
            smap[sno] = (raw, None)
            continue
        if not override and (re.fullmatch(r"\d과목", S.norm(raw) or "") or _garbled(raw)):
            unread.append((sno, raw))          # 스캔본에서 과목명을 못 읽음 → 이름이 있는 과목을 다 맞춘 뒤 순서로
            continue
        kind, _, std = profile.resolve(override or raw)
        if kind == "std":
            smap[sno] = (raw, std)
            if S.norm(raw) != S.norm(std):
                renamed.append(f"{raw} → {std}")
        elif kind == "excluded":
            smap[sno] = (raw, None)
        else:
            pending.append((sno, raw))
    taken = {S.norm(std) for _, std in smap.values() if std}
    # 이름은 읽었는데 출제기준과 정확히 같지 않은 과목: 비슷한 이름이면 현행 과목으로, 아니면 뺀다(사용자 2026-11-17 — 철도토목기사
    # 옛 5과목 '건설재료 및 시공'은 현행 4과목에 없음). 과목 순서로 맞추는 것은 PDF 과목 수가 출제기준과 같을 때만
    for sno, raw in pending:
        g = profile.guess(raw, sno, n_pdf, taken)
        if g:
            std, why = g
            smap[sno] = (raw, std)
            taken.add(S.norm(std))
            renamed.append(f"{raw} → {std}")
            notes.append(f"과목명 '{raw}' → 출제기준 '{std}'(자동 — {why})")
        else:
            smap[sno] = (raw, None)
            notes.append(f"과목 '{raw}'은 현행 출제기준에 없어 이 회차에서 뺌")
    # 이름을 못 읽은 과목: 과목 수가 같으면 같은 순번. 다르면 이름을 읽은 앞뒤 과목 사이에 들어갈 현행 과목을 순서대로 —
    # 못 읽은 과목이 연달아 k개이고 그 사이 현행 과목도 k개일 때만(철도보선기사 2010: 1~3과목 이름을 못 읽음, 4과목 '건설재료 및 시공'은 빠짐)
    runs: list[list[tuple[int, str]]] = []
    for sno, raw in unread:
        if runs and runs[-1][-1][0] == sno - 1:
            runs[-1].append((sno, raw))
        else:
            runs.append([(sno, raw)])
    for run in runs:
        snos = [sno for sno, _ in run]
        if n_pdf == n_std:
            pick = [profile.subjects[sno - 1]["name"] if 1 <= sno <= n_std else None for sno in snos]
        else:
            before = [profile.std_index(v[1]) for k, v in smap.items() if k < snos[0] and v[1]]
            after = [profile.std_index(v[1]) for k, v in smap.items() if k > snos[-1] and v[1]]
            lo, hi = max(before, default=0), min(after, default=n_std + 1)
            cands = [x["name"] for i, x in enumerate(profile.subjects, 1) if lo < i < hi and S.norm(x["name"]) not in taken]
            if len(cands) == len(run):
                pick = cands
            else:
                # 못 읽은 과목이 더 많으면(옛 과목이 끼어 있음) 이름이 가장 비슷한 것끼리만 — 자모 단위 비슷함 0.5 이상
                pick = [None] * len(run)
                for c in cands:
                    best = max(range(len(run)), key=lambda k: S.similarity(run[k][1], c))
                    if pick[best] is None and S.similarity(run[best][1], c) >= 0.5:
                        pick[best] = c
                # 그래도 못 정한 현행 과목은 문항 내용으로 — 출제기준 세부항목 낱말(2글자 묶음)이 가장 많이 나오는 과목 묶음
                # (철도토목기사 2018: 3·4과목 머리말을 다 못 읽음 → 보·모멘트·응력이 많은 쪽이 응용역학, 콘크리트·시멘트 쪽은 옛 과목)
                for c in cands:
                    if c in pick:
                        continue
                    free = [k for k in range(len(run)) if pick[k] is None]
                    sc = {k: _unit_score([q.text() for q in layout.questions if q.subject_no == run[k][0]], profile, c) for k in free}
                    if not sc:
                        continue
                    rank = sorted(sc, key=lambda k: -sc[k])
                    top = sc[rank[0]]
                    if top >= 0.02 and (len(rank) == 1 or top >= 1.6 * sc[rank[1]]):
                        pick[rank[0]] = c
        for (sno, raw), std in zip(run, pick):
            if std and S.norm(std) not in taken:
                smap[sno] = (raw, std)
                taken.add(S.norm(std))
                notes.append(f"{sno}과목 이름을 못 읽어 과목 순서로 출제기준 '{std}'로 둠")
            else:
                smap[sno] = (raw, None)
                notes.append(f"{sno}과목 이름을 못 읽고 순서로도 정할 수 없어 이 회차에서 뺌")

    # 과목별 문항 수를 프로필과 대조 — 스캔본에서 문항 경계를 놓치거나 잘못 나눈 경우를 잡는다
    if not profile.is_legacy(exam["date"]):
        per = {}
        for q in layout.questions:
            per[q.subject_no] = per.get(q.subject_no, 0) + 1
        for _, sno in layout.missing:               # 찾지 못한 문항은 따로 알림(아래) — 경계 경고와 겹치지 않게
            per[sno] = per.get(sno, 0) + 1
        want = {s["name"]: s["count"] for s in profile.subjects}
        for sno, (raw, std) in smap.items():
            if std in want and per.get(sno, 0) != want[std]:
                notes.append(f"{raw}: 문항 {per.get(sno, 0)}개(출제기준 {want[std]}개)")

    legacy = profile.is_legacy(exam["date"])
    answers = {int(k): int(v) for k, v in review.get("answers", {}).items()}
    accept = {int(k): [int(x) for x in v] for k, v in review.get("acceptAlso", {}).items()}
    excl = {int(k): str(v) for k, v in review.get("exclude", {}).items()}
    reassign = {int(k): v for k, v in review.get("reassign", {}).items()}

    items: list[Item] = []
    for q in layout.questions:
        raw, std = smap.get(q.subject_no, (f"{q.subject_no}과목", None))
        inline, table = q.inline_answer, (layout.answer_table.get(q.no) if table_ok else None)
        warn = [w for w in q.warnings if not w.startswith("info:")]
        if layout.ocr and merged_next(q):
            warn.append(MERGED_NEXT)
        manual = answers.get(q.no)
        ans, src, check = None, None, None
        if inline and table:
            ans, src, check = inline, "inline-mark", "agree"
            if manual and manual != inline:
                ans, check = manual, "corrected"      # 검수자 판단이 우선(표시·정답표 불일치, 출제 오류 정정)
            elif inline != table and not manual:
                warn.append(f"보기 표시 {inline} ≠ 정답표 {table}")
        elif inline or table:
            ans, src, check = inline or table, "inline-mark" if inline else "answer-table", "single"
            if manual and manual != ans:
                ans, check = manual, "corrected"
        elif manual:
            ans, src, check = manual, "manual", "single"
        else:
            warn.append("정답을 찾지 못함")

        n_choice = 4 if layout.ocr else (len(q.labels) or 4)
        if ans is not None and not 1 <= ans <= n_choice:
            warn.append(f"정답 {ans}번이 보기 수({n_choice}개)를 벗어남 — 보기 번호를 못 찾았을 수 있음")
        img = crop_question(pages, layout, regions[q.no])
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=image_quality, method=6)
        flags = []
        regs = regions[q.no]
        if any(bx[0] < layout.col_of(r.page, r.col)[1] and bx[2] > layout.col_of(r.page, r.col)[0] and bx[1] < r.bottom and bx[3] > r.top
               for r in regs for bx in figs.get(r.page, [])):
            flags.append("has-figure")
        if len(q.segments) > 1:
            flags.append("spans-column")
        if q.stem_filled:
            flags.append("stem-has-circled-glyph")
        if layout.ocr:
            flags += ["ocr", "needs-review"]
            # 문항 그림이 폭보다 1.15배 넘게 길면 다음 문항·쪽 머리글이 붙은 것(철도토목기사 스캔본에서 모두 그랬음) — 뺌
            # 그림이 긴 문항(그림 문제)은 그대로 — 발문 끝 '?'가 둘 이상(다른 문항 발문이 붙음)일 때만 뺌
            if img.height > TALL_RATIO * img.width and MERGED_NEXT not in warn \
                    and sum("?" in ln.text for ln in q.lines) >= 2:
                warn.append(MERGED_NEXT)
        it = Item(q.no, q.local_no, raw, std, ans, src, check, accept.get(q.no, []),
                  n_choice,
                  buf.getvalue(), (img.width, img.height), q.text(), flags, warn)
        # 법령·기준 문항 표시(ADR 019): 개정으로 원본 정답이 현행과 다를 수 있는 문항 → 앱이 답한 뒤 안내
        is_law, refs = lawtag.tag(it.text, profile.code, std or raw)
        if is_law:
            it.flags.append("law")
            it.law_refs = refs
        if std is None:
            it.excluded = f"현행 출제기준에 없는 과목({raw})"
        if q.no in excl:
            it.excluded = excl[q.no]
        if legacy and std is not None and reference is not None:
            it.suggestion = reference.suggest(q.no, std, it.text)
        if legacy and q.no in reassign and review.get("reviewed"):
            target = reassign[q.no]
            if profile.std_index(target) is None:
                warn.append(f"재배정 과목 '{target}'이 프로필에 없음")
            elif target != std:
                it.subject = target
                it.flags.append("subject-reassigned")
        elif legacy and it.suggestion and it.suggestion.suggested != std \
                and it.suggestion.confidence >= REASSIGN_MIN_CONF and profile.std_index(it.suggestion.suggested):
            it.subject = it.suggestion.suggested                    # 구기준 회차: 확신 있는 제안은 자동 재배정(검수 없음)
            it.flags.append("subject-reassigned")
        # 정답을 믿을 수 없는 문항(ADR 024, 사용자 2026-11-12): 우선 표시만 해 두고 —
        # 다른 회차의 같은 문항과 교차 확인(C, crosscheck.apply) → 안 되면 '정답 확인 필요'로 넣거나(B) 정답이 없으면 뺀다(settle_doubts)
        if it.excluded is None and q.no not in answers:
            why = unsure_answer(it, leaks.get(q.no))
            if not why and getattr(q, "pen_guess", False) and it.answer is not None:
                why = AUTO_EXCLUDE + PEN_DOUBT        # 손글씨 표시를 짐작한 번호 자리로 읽음 → 교차 확인, 안 되면 '정답 확인 필요'(B)
            if why:
                it.doubt = why[len(AUTO_EXCLUDE):]
                marks = re.search(r"정답 표시 \d+개: \[([\d, ]+)\]", " ".join(warn))
                if marks:
                    nums = [int(x) for x in re.findall(r"\d+", marks.group(1))]
                    if it.answer is None and nums:
                        it.answer = nums[0]
                    it.alts = [x for x in nums if x != it.answer]
                if table and inline and table != inline:
                    it.alts = sorted(set(it.alts) | {table})
        items.append(it)

    # 정답이 없어도 문항은 만든다(사용자 2026-11-17): 정답은 학습앱에서 학습자가 처음 풀 때 지정(answer-missing).
    # 교사용 PDF 조건은 안내로만 남기고, 회차를 포기하는 것은 문항 자체를 절반도 못 만들 때뿐
    na = no_answer_issue(items, scan=layout.ocr)
    if na:
        notes.append(NO_ANSWER_NOTE)
    fq = None if sup else few_questions_issue(items, profile)      # 보충 문서는 몇 문항뿐
    if fq:
        issues.append(fq)
    if legacy:
        n_re = sum(1 for it in items if "subject-reassigned" in it.flags)
        notes.append(f"구기준 회차({exam['date']} < {profile.legacy['before']}): {n_re}문항을 현행 과목으로 자동 재배정"
                     + ("" if reference is not None else " — 참조 문항이 없어 시험지 과목 그대로(현행 회차를 함께 넣으면 나아짐)"))
    n_ex = sum(1 for it in items if it.excluded)
    if n_ex:
        notes.append(f"제외 {n_ex}문항")
    for no, sno in layout.missing:
        notes.append(f"{no}번: 스캔본에서 문항을 찾지 못함 — 팩에서 빠짐(판독 불가)")
    if layout.numbering == "per-subject":
        notes.append("원본은 과목마다 번호가 1부터 다시 시작 — 팩 번호(no)는 시험지 전체 순번")
    missing = [(no, (lambda r, st: st if st and re.fullmatch(r"\d과목", r) else r)(*smap.get(sno, (f"{sno}과목", None))))
               for no, sno in layout.missing]                     # 과목명을 못 읽었으면 출제기준 이름으로
    return Prepared(pdf_path, pack_id, exam, profile, method, masked, items, issues, notes,
                    layout.numbering, layout.ocr, legacy, review, renamed, info=info, missing=missing,
                    supplement=bool(sup))


# ───────────────────────── 팩 쓰기 ─────────────────────────

def settle_doubts(p: "Prepared") -> None:
    """교차 확인(C) 뒤에도 남은 '정답을 믿을 수 없는' 문항(ADR 024, 사용자 2026-11-12):
    정답 후보가 있으면 넣고 flags "answer-unsure"(학습앱이 답한 뒤 '정답 확인 필요' 안내, 다른 후보도 정답 인정) — B,
    정답 후보가 없거나 보기 수를 벗어나면 뺀다. 여러 번 불러도 같다."""
    marked, dropped, missing = [], [], []
    for it in p.items:
        if not it.doubt or it.excluded:
            continue
        if it.doubt == MERGED_DOUBT:
            it.excluded = AUTO_EXCLUDE + it.doubt   # 두 문항이 붙어 읽힌 문항은 그림이 망가짐 → 뺌(문항을 만들 수 없는 경우)
            dropped.append(it)
            continue
        # 정답 표시가 그림에 남은 문항도 넣는다(사용자 2026-11-17: 기출을 볼 수 있는 것 자체가 의미) — 학습앱이 안내
        if it.doubt == LEAK_DOUBT:
            if "answer-visible" not in it.flags:
                it.flags.append("answer-visible")
            if it.answer is not None and 1 <= it.answer <= it.choice_count:
                continue
        # 정답이 없거나 보기 수를 벗어남 → 정답 칸을 비우고 넣음(학습앱에서 학습자가 처음 풀 때 정답을 지정)
        if it.answer is None or not 1 <= it.answer <= it.choice_count:
            it.answer, it.answer_source, it.answer_check = None, "none", "none"
            it.accept_also = []
            if "answer-missing" not in it.flags:
                it.flags.append("answer-missing")
                missing.append(it)
            continue
        if "answer-unsure" not in it.flags:
            it.flags.append("answer-unsure")
            it.accept_also = sorted({x for x in it.accept_also + it.alts if x != it.answer and 1 <= x <= it.choice_count})
            marked.append(it)
    if marked:
        p.notes.append(f"정답 확인 필요로 넣은 문항 {len(marked)}개(학습앱이 답한 뒤 안내): "
                       + ", ".join(f"{it.no}번({it.doubt})" for it in marked[:8]) + (" …" if len(marked) > 8 else ""))
    if missing:
        p.notes.append(f"정답 미지정으로 넣은 문항 {len(missing)}개(학습앱에서 처음 풀 때 정답 지정)")
    if dropped:
        p.notes.append(f"문항 그림이 망가져 뺀 문항 {len(dropped)}개: "
                       + ", ".join(f"{it.no}번({it.doubt})" for it in dropped[:8]) + (" …" if len(dropped) > 8 else ""))


def write_pack(p: Prepared, out_dir: Path, prepared_by: str, source_type: str | None = None,
               source_origin: str = "", pack_version: int = 1) -> tuple[Path, dict]:
    """source_type·source_origin을 비우면 문서에서 읽은 출처(ADR 021 6절)."""
    settle_doubts(p)
    prof = p.profile
    kept = [it for it in p.items if not it.excluded]
    std_order = {s["name"]: i + 1 for i, s in enumerate(prof.subjects)}
    used = sorted({it.subject for it in kept}, key=lambda n: std_order.get(n, 99))
    sno = {name: (std_order.get(name) or (len(prof.subjects) + 1 + used.index(name))) for name in used}
    counter: dict[int, int] = {}
    files: dict[str, bytes] = {}
    questions = []
    for it in kept:
        s = sno[it.subject]
        counter[s] = counter.get(s, 0) + 1
        path = f"images/{it.no:03d}.webp"
        files[path] = it.image
        q = {
            "qid": f"{p.pack_id}-{it.no:03d}",
            "no": it.no,
            "subjectNo": s,
            "noInSubject": counter[s],
            "answer": it.answer,
            "choiceCount": it.choice_count,
            "answerSource": it.answer_source,
            "answerCheck": it.answer_check,
            "img": path,
            "imgSize": list(it.img_size),
            "text": it.text,
            "contentHash": content_hash(it.text),
            "keywords": [],
            "lawRefs": it.law_refs,
            "clusterId": None,
            "flags": it.flags,
        }
        if it.accept_also:
            q["acceptAlso"] = it.accept_also
        questions.append(q)

    law = {s["name"] for s in prof.subjects if s.get("isLaw")}
    exam_count = {s["name"]: s["count"] for s in prof.subjects}
    subjects = []
    for n in used:
        s = {"no": sno[n], "name": n, "count": counter[sno[n]], "isLaw": n in law}
        # 실제 시험 문항 수와 다르면(옛 기준 과목 합침·제외 문항) 함께 적는다 — 같으면 쓰지 않아 이전 팩과 같은 모양(ADR 016)
        if n in exam_count and exam_count[n] != s["count"]:
            s["examCount"] = exam_count[n]
        units = prof.units(n)
        if units:                 # 출제기준 주요항목·세부항목 — 학습앱 '출제기준' 화면용(ADR 025). 문항별 단원 분류는 없앰
            s["units"] = [{"id": u["id"], "major": u["major"], "name": u["name"]} for u in units]
        subjects.append(s)
    excluded: dict[tuple[str, str], list[int]] = {}
    for it in p.items:
        if it.excluded:
            reason = "abolished-subject" if it.subject is None else ("unreadable" if "판독" in it.excluded else "other")
            excluded.setdefault((it.pdf_subject, reason, it.excluded if reason == "other" else ""), []).append(it.no)
    for no, raw in p.missing:
        excluded.setdefault((raw, "unreadable", ""), []).append(no)
    for v in excluded.values():
        v.sort()

    qjson = json.dumps(questions, ensure_ascii=False, indent=1).encode("utf-8")
    files = {"questions.json": qjson, **files}
    info = p.info or examinfo.ExamInfo(source_type="public-pbt", origin="")
    source = {"type": source_type or info.source_type}
    if source_origin or info.origin:
        source["origin"] = source_origin or info.origin
    if info.note and not source_type:
        source["note"] = info.note
    manifest = {
        "format": "oqp/1",
        "packId": p.pack_id,
        "packVersion": pack_version,
        "cert": {"code": prof.code, "name": prof.name, "grade": prof.grade},
        "exam": p.exam,
        "subjects": subjects,
        "passRule": prof.pass_rule,
        "questionCount": len(questions),
        "source": source,
        "preparedBy": prepared_by,
        "reviewedAt": dt.date.today().isoformat() if p.review.get("reviewed") else None,
        "createdAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "generator": f"oneq-prep {__version__}",
        "answerMasking": {"method": p.method, "masked": p.masked, "leakCheck": "passed"},
    }
    if excluded:
        manifest["excluded"] = [
            {"subject": subj, "nos": nos, "reason": reason, **({"note": note} if note else {})}
            for (subj, reason, note), nos in excluded.items()]
    # 출제기준은 항상 기록(ADR 025 — 학습앱 '출제기준' 화면에 적용 기간을 보이려고; 앱 v0.6.0 이하 호환은 더 고려하지 않음)
    if True:
        std = {"profile": prof.code, "version": prof.version}
        if prof.period and prof.period.get("from") and prof.period.get("to"):
            std["period"] = {"from": prof.period["from"], "to": prof.period["to"]}
        if p.renamed:
            std["renamed"] = p.renamed
        if p.legacy:
            std["reassigned"] = sum(1 for it in kept if "subject-reassigned" in it.flags)
        manifest["standard"] = std
    manifest["files"] = [{"path": k, "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for k, b in files.items()]

    zpath = rounds_dir(out_dir) / f"oneq-{p.pack_id}.zip"
    # 같은 회차를 다시 만들 때(ADR 021 8절): 내용이 같으면 판 그대로(앱이 조용히 건너뜀),
    # 다르면 이전 판보다 하나 올림(앱이 "바꿀까요?" 없이 교체하고 학습 기록은 이어짐)
    old = _existing_manifest(zpath)
    if old and old.get("packVersion", 0) >= pack_version:
        same = {f["path"]: f["sha256"] for f in old.get("files", [])} == {f["path"]: f["sha256"] for f in manifest["files"]}
        manifest["packVersion"] = old["packVersion"] if same else old["packVersion"] + 1
        if same:
            manifest["createdAt"] = old.get("createdAt", manifest["createdAt"])
        p.unchanged = same
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        for k, b in files.items():
            # webp는 이미 압축돼 있어 STORED로 둔다(해제 속도↑)
            z.writestr(k, b, zipfile.ZIP_STORED if k.endswith(".webp") else zipfile.ZIP_DEFLATED)
    return zpath, manifest


def _existing_manifest(zpath: Path) -> dict | None:
    try:
        with zipfile.ZipFile(zpath) as z:
            return json.loads(z.read("manifest.json"))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return None


def build_pack(pdf_path: Path, out_dir: Path, cert_code: str, prepared_by: str, source_origin: str = "",
               pack_version: int = 1, image_quality: int = 80) -> tuple[Path, dict]:
    """1단계 호환: 문제가 있으면 ValueError."""
    prof = S.load(cert_code)
    p = prepare(Path(pdf_path), prof, Path(out_dir), image_quality=image_quality)
    if p.issues:
        raise ValueError("팩을 만들 수 없음:\n  " + "\n  ".join(p.issues))
    return write_pack(p, Path(out_dir), prepared_by, source_origin=source_origin, pack_version=pack_version)


# ───────────────────────── 참조 문항(재배정용) ─────────────────────────

def reference_from(prepared: list[Prepared], out_dir: Path, cert: str) -> Reference | None:
    items = [(f"{p.pack_id}-{it.no:03d}", it.subject, it.text)
             for p in prepared if not p.legacy for it in p.items if it.subject and not it.excluded]
    if not items:
        for z in sorted(rounds_dir(out_dir).glob(f"oneq-{cert}-*.zip")):
            with zipfile.ZipFile(z) as zf:
                m = json.loads(zf.read("manifest.json"))
                if m.get("standard", {}).get("reassigned") is not None:
                    continue
                names = {s["no"]: s["name"] for s in m["subjects"]}
                for q in json.loads(zf.read("questions.json")):
                    items.append((q["qid"], names[q["subjectNo"]], q["text"]))
    return Reference(items) if items else None


# ───────────────────────── 명령줄 ─────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(prog="oneq_prep", description="기출 PDF → 원큐합격 문제팩(종목 묶음 .zip 하나)")
    ap.add_argument("pdf", nargs="+", type=Path, help="기출 PDF(여러 개 가능)")
    ap.add_argument("out", type=Path, help="출력 폴더(종목 묶음 zip — 회차별 팩은 안쪽 .회차별 폴더)")
    ap.add_argument("--cert", default="SURVEY", choices=S.available(), help="종목 코드(출제기준 프로필)")
    ap.add_argument("--prepared-by", default="원큐합격 문제팩 생성기 v0.5", help="만든 사람(기본: 자동 — ADR 021 6절)")
    ap.add_argument("--origin", default="", help="원본 출처(기본: 문서 머리말·꼬리말에서 읽음, 모르면 '직접 올림')")
    ap.add_argument("--source-type", default=None, choices=["public-pbt", "recalled", "other"], help="기본: 문서에서 읽음")
    ap.add_argument("--date", help="시행일 YYYY-MM-DD 직접 지정(PDF 1개) — 기본은 문서 내용에서 읽고, 못 찾으면 '0000년 nn회'")
    ap.add_argument("--round", type=int, dest="round_no", help="회차 강제 지정(PDF 1개)")
    ap.add_argument("--pack-version", type=int, default=3, help="팩 판(v0.5부터 기본 3, v0.4는 2 — 앱이 낮은 판을 자동 교체, 기록은 이어짐)")
    ap.add_argument("--no-bundle", action="store_true", help="종목 묶음을 만들지 않음(회차별 팩만 .회차별 폴더에)")
    ap.add_argument("--workers", type=int, default=None, help="동시에 처리할 회차 수(기본: CPU 코어 수 - 1, 최대 4)")
    a = ap.parse_args(argv)

    ap_workers = a.workers
    from .batch import STATUS_TEXT, BatchSpec, run_batch

    def show(ev):
        r = ev.result
        if ev.kind == "start":
            print(f"· {r.pdf.name}", flush=True)
        elif ev.kind == "done" and r is not None:
            mark = {"packed": "✓", "review": "✗", "error": "✗"}.get(r.status, "·")
            what = r.zip_path.name if r.zip_path else (r.pack_id or r.pdf.name)
            print(f"  {mark} {what}: {STATUS_TEXT[r.status]} — {r.message}", flush=True)
        elif ev.kind == "finish":
            if ev.bundle:
                print(f"\n종목 묶음: {ev.bundle}", flush=True)

    spec = BatchSpec(list(a.pdf), a.cert, a.out, a.prepared_by, a.origin, a.source_type, a.date, a.round_no,
                     a.pack_version, False, ap_workers, bundle=not a.no_bundle)
    try:
        rows = run_batch(spec, show)
    except ValueError as e:
        sys.exit(str(e))
    ok = sum(r.status == "packed" for r in rows)
    bad = sum(r.status in ("review", "error") for r in rows)
    print(f"\n팩 {ok}개 / 만들지 못함·오류 {bad}개")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
