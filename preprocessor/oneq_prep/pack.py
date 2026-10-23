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
from .render import (crop_question, mark_leaks, mask_filled_labels, mask_ocr_filled, regions_for,
                     remove_highlight_near_labels, render_pages)

REVIEW_DIR = "review"
REASSIGN_MIN_CONF = 0.6     # 이보다 낮은 재배정 제안은 보고서에서 '확인 필요'로 강조


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
    for k in ("answers", "acceptAlso", "exclude", "reassign", "subjectMap", "units", "types"):
        d.setdefault(k, {})
    return d


REVIEW_HELP = {
    "_설명": "이 파일을 고친 뒤 같은 명령을 다시 실행하면 반영된다. 키는 시험지 문항번호(팩의 no).",
    "subjectMap": "PDF 과목명 → 표준 과목명 또는 \"제외\"",
    "answers": "문항번호 → 정답 번호(정답을 못 찾았거나 표시·정답표가 다를 때)",
    "acceptAlso": "문항번호 → [추가 인정 번호] (복수정답·전항정답)",
    "exclude": "문항번호 → 사유 (판독 불가 등으로 팩에서 뺄 문항)",
    "reassign": "문항번호 → 표준 과목명 (구기준 회차 과목 재배정). 제안을 확인·수정한 뒤 reviewed를 true로",
    "units": "문항번호 → 단원 id(\"주요-세부\", 예 \"1-3\") 또는 \"미분류\" — 자동 판정이 확신 없던 문항(ADR 021 4.5)",
    "types": "문항번호 → calc(계산) / law(기준·법령) / concept(개념·실무)",
    "reviewed": "사람이 검수를 마쳤으면 true → manifest.reviewedAt 기록, 재배정 반영",
}


def write_review_skeleton(out_dir: Path, pack_id: str, source: str, review: dict,
                          suggestions: list[Suggestion]) -> Path:
    p = review_path(out_dir, pack_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    d = {"_도움말": REVIEW_HELP, "packId": pack_id, "source": source,
         "subjectMap": review.get("subjectMap", {}), "answers": review.get("answers", {}),
         "acceptAlso": review.get("acceptAlso", {}), "exclude": review.get("exclude", {}),
         "reassign": review.get("reassign") or {str(s.no): s.suggested for s in suggestions if s.suggested != s.current},
         "units": review.get("units", {}), "types": review.get("types", {}),
         "reviewed": review.get("reviewed", False)}
    p.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
    return p


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
    unit: str | None = None       # 단원(세부항목) id(ADR 021 4.1) — 확신 있거나 사람이 고른 것만
    qtype: str | None = None      # calc / law / concept (4.2)
    sequence: bool = False
    unsure: list[str] = field(default_factory=list)     # 자동 판정 확신 낮음("unit"/"qtype")
    unit_candidates: list[str] = field(default_factory=list)   # 단원 미정 → 앱에서 학습자가 고르는 후보(최대 3)


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
    unchanged: bool = False       # 출력 폴더에 내용이 같은 팩이 이미 있었음(묶음에서 뺌, ADR 021 8절)
    zip_path: Path | None = None
    review_file: Path | None = None


def prepare(pdf_path: Path, profile: S.Profile, out_dir: Path,
            date: str | None = None, round_no: int | None = None, image_quality: int = 80,
            reference: Reference | None = None, log=print, progress=None) -> Prepared:
    """progress(단계) — 처리 화면의 파일별 진행 막대용(ADR 021 6절): 읽기 → 문항 나누기 → 정답 → 분류(→ 팩은 쓰는 쪽)."""
    from .ocr import needs_ocr, ocr_pdf

    step = progress or (lambda _s: None)
    step("읽기")

    issues: list[str] = []
    notes: list[str] = []
    # 종목·시행일·회차·출처는 문서 내용에서(ADR 021 2절) — 파일 이름은 쓰지 않음
    exam, info = examinfo.exam_of(pdf_path, profile, out_dir, date, round_no)
    pack_id = examinfo.pack_id(profile.code, exam)
    if info.cert_name and S.norm(info.cert_name) != S.norm(profile.name):
        issues.append(f"이 파일은 '{info.cert_name}' 문서로 보입니다(고른 종목: {profile.name}) — 종목을 확인하세요")
    if exam.get("dateUnknown"):
        notes.append("시행일을 문서에서 찾지 못함 → " + (f"{exam['year']}년 {exam['round']}회(시행일 모름)" if exam["year"]
                                                    else f"0000년 {exam['round']}회로 지정"))
    review = load_review(out_dir, pack_id)

    ocr_pages = None
    if needs_ocr(pdf_path):
        log(f"  {pdf_path.name}: 텍스트층 없음 → OCR")
        ocr_pages = ocr_pdf(pdf_path)
        notes.append("스캔본: OCR로 문항 경계를 찾음 — 보기·정답을 반드시 검수")
    step("문항 나누기")
    layout = analyze(pdf_path, ocr_pages=ocr_pages)
    issues += layout.warnings

    step("정답")
    # 렌더링 + 정답 표시 제거
    if layout.highlights:
        pages, masked = render_pages(pdf_path, strip_yellow=True)
        method = ["highlight-remove"]
        n_hl = sum(len(v) for v in layout.highlights.values())
        if masked != n_hl:
            issues.append(f"형광 표시 {n_hl}개 중 {masked}개만 지움")
    else:
        pages = render_pages(pdf_path)
        if layout.ocr:
            masked = mask_ocr_filled(pages, layout)
            masked += remove_highlight_near_labels(pages, layout)
        else:
            masked = mask_filled_labels(pages, layout)
        method = ["filled-glyph-replace"] if masked else ["none-needed"]
    leaks = {q.no: mark_leaks(pages, q) for q in layout.questions}
    leaks = {k: v for k, v in leaks.items() if v}
    if leaks:
        issues.append(f"정답 표시 잔존 의심: {leaks}")
    regions = regions_for(layout)
    figs = _figure_boxes(pdf_path) if not layout.ocr else {}

    # 과목 정리(출제기준 프로필)
    smap: dict[int, tuple[str, str | None]] = {}     # PDF 과목번호 → (PDF 이름, 표준 이름 또는 None=제외)
    renamed: list[str] = []
    for sno, raw in sorted(layout.subjects.items()):
        override = review.get("subjectMap", {}).get(raw)
        if override == "제외":
            smap[sno] = (raw, None)
            continue
        kind, _, std = profile.resolve(override or raw)
        if kind == "std":
            smap[sno] = (raw, std)
            if S.norm(raw) != S.norm(std):
                renamed.append(f"{raw} → {std}")
        elif kind == "excluded":
            smap[sno] = (raw, None)
        else:
            smap[sno] = (raw, raw)
            issues.append(f"출제기준 프로필({profile.code})에 없는 과목명: '{raw}' — 검수 파일 subjectMap에 표준 과목명 또는 \"제외\"를 적으세요")

    # 과목별 문항 수를 프로필과 대조 — 스캔본에서 문항 경계를 놓치거나 잘못 나눈 경우를 잡는다
    if not profile.is_legacy(exam["date"]):
        per = {}
        for q in layout.questions:
            per[q.subject_no] = per.get(q.subject_no, 0) + 1
        want = {s["name"]: s["count"] for s in profile.subjects}
        for sno, (raw, std) in smap.items():
            if std in want and per.get(sno, 0) != want[std]:
                msg = f"{raw}: 문항 {per.get(sno, 0)}개(출제기준 {want[std]}개)"
                (issues if layout.ocr else notes).append(msg + (" — 문항 경계 확인 필요(스캔 품질)" if layout.ocr else ""))

    legacy = profile.is_legacy(exam["date"])
    answers = {int(k): int(v) for k, v in review.get("answers", {}).items()}
    accept = {int(k): [int(x) for x in v] for k, v in review.get("acceptAlso", {}).items()}
    excl = {int(k): str(v) for k, v in review.get("exclude", {}).items()}
    reassign = {int(k): v for k, v in review.get("reassign", {}).items()}

    items: list[Item] = []
    for q in layout.questions:
        raw, std = smap.get(q.subject_no, (f"{q.subject_no}과목", None))
        inline, table = q.inline_answer, layout.answer_table.get(q.no)
        warn = [w for w in q.warnings if not w.startswith("info:")]
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
        if any(bx[0] < layout.col_x[r.col][1] and bx[2] > layout.col_x[r.col][0] and bx[1] < r.bottom and bx[3] > r.top
               for r in regs for bx in figs.get(r.page, [])):
            flags.append("has-figure")
        if len(q.segments) > 1:
            flags.append("spans-column")
        if q.stem_filled:
            flags.append("stem-has-circled-glyph")
        if layout.ocr:
            flags += ["ocr", "needs-review"]
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
        items.append(it)

    step("분류")
    _classify_items(items, profile, review)
    if legacy:
        if not review.get("reviewed"):
            issues.append(f"구기준 회차({exam['date']} < {profile.legacy['before']}): 문항별 과목 재배정 검수 필요 — "
                          "검수 파일의 reassign(자동 제안)을 확인하고 reviewed를 true로")
        if reference is None:
            notes.append("재배정 제안용 참조 문항이 없음(같은 종목의 현행 회차를 함께 넣거나 출력 폴더에 팩이 있어야 함)")
    for it in items:
        if it.excluded is None:
            # OCR의 보기 번호 개수·순서 경고는 정답만 확보되면 막지 않는다(카드에는 표시)
            soft = layout.ocr and it.answer is not None
            issues += [f"{it.no}번: {w}" for w in it.warnings
                       if not (soft and (w.startswith("OCR:") or w.startswith("보기 번호 순서")))]
    kept_items = [it for it in items if not it.excluded]
    if kept_items:
        from collections import Counter
        tc = Counter(it.qtype for it in kept_items)
        nu = sum(1 for it in kept_items if "unit" in it.unsure)
        notes.append(f"유형: 계산 {tc.get('calc', 0)} · 기준·법령 {tc.get('law', 0)} · 개념·실무 {tc.get('concept', 0)}"
                     + (f" / 단원 미정 {nu}문항(학습 중 후보 3개에서 고름)" if any(profile.units(s['name']) for s in profile.subjects) else ""))
    n_ex = sum(1 for it in items if it.excluded)
    if n_ex:
        notes.append(f"제외 {n_ex}문항")
    if layout.numbering == "per-subject":
        notes.append("원본은 과목마다 번호가 1부터 다시 시작 — 팩 번호(no)는 시험지 전체 순번")
    return Prepared(pdf_path, pack_id, exam, profile, method, masked, items, issues, notes,
                    layout.numbering, layout.ocr, legacy, review, renamed, info=info)


def _classify_items(items: list[Item], profile: S.Profile, review: dict) -> None:
    """단원·유형·순서형(ADR 021 4절). 사람이 검수 파일 units/types로 고른 것이 자동보다 우선."""
    from . import classify as C
    picked_u = {int(k): v for k, v in review.get("units", {}).items()}
    picked_t = {int(k): v for k, v in review.get("types", {}).items()}
    idx: dict[str, C.UnitIndex] = {}
    law_subjects = {s["name"] for s in profile.subjects if s.get("isLaw")}
    for it in items:
        if it.excluded or not it.subject:
            continue
        if it.subject not in idx:
            idx[it.subject] = C.build_index(profile, it.subject)
        c = C.classify(it.text, idx[it.subject], is_law="law" in it.flags or it.subject in law_subjects)
        it.qtype, it.sequence = c.qtype, c.sequence
        it.unit = c.unit if c.unit_sure else None
        it.unsure = [k for k, sure in (("unit", c.unit_sure or not idx[it.subject].units), ("qtype", c.type_sure)) if not sure]
        it.unit_candidates = c.candidates
        if it.no in picked_u:
            v = picked_u[it.no]
            it.unit = None if v in ("미분류", "", None) else v
            it.unsure = [k for k in it.unsure if k != "unit"]
            it.unit_candidates = []
        if it.no in picked_t and picked_t[it.no] in ("calc", "law", "concept"):
            it.qtype = picked_t[it.no]
            it.unsure = [k for k in it.unsure if k != "qtype"]


# ───────────────────────── 팩 쓰기 ─────────────────────────

def write_pack(p: Prepared, out_dir: Path, prepared_by: str, source_type: str | None = None,
               source_origin: str = "", pack_version: int = 1) -> tuple[Path, dict]:
    """source_type·source_origin을 비우면 문서에서 읽은 출처(ADR 021 6절)."""
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
        if it.unit:
            q["unit"] = it.unit
        if it.qtype:
            q["qtype"] = it.qtype
        if it.sequence:
            q["sequence"] = True
        if it.unsure:
            q["classifyUnsure"] = it.unsure
        if not it.unit and it.unit_candidates:
            q["unitCandidates"] = it.unit_candidates
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
        if units:
            s["units"] = [{"id": u["id"], "major": u["major"], "name": u["name"]} for u in units]
        subjects.append(s)
    excluded: dict[tuple[str, str], list[int]] = {}
    for it in p.items:
        if it.excluded:
            reason = "abolished-subject" if it.subject is None else ("unreadable" if "판독" in it.excluded else "other")
            excluded.setdefault((it.pdf_subject, reason, it.excluded if reason == "other" else ""), []).append(it.no)

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
    # 과목을 손댄 경우에만 기록한다(손대지 않은 팩은 앱 v0.6.0 이하에서도 그대로 열리도록)
    if p.renamed or p.legacy or excluded:
        std = {"profile": prof.code, "version": prof.version}
        if p.renamed:
            std["renamed"] = p.renamed
        if p.legacy:
            std["reassigned"] = sum(1 for it in kept if "subject-reassigned" in it.flags)
        manifest["standard"] = std
    manifest["files"] = [{"path": k, "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for k, b in files.items()]

    out_dir.mkdir(parents=True, exist_ok=True)
    zpath = out_dir / f"oneq-{p.pack_id}.zip"
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
        for z in sorted(out_dir.glob(f"oneq-{cert}-*.zip")):
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
    ap = argparse.ArgumentParser(prog="oneq_prep", description="기출 PDF → 원큐합격 문제팩(.zip) + 검수 보고서")
    ap.add_argument("pdf", nargs="+", type=Path, help="기출 PDF(여러 개 가능)")
    ap.add_argument("out", type=Path, help="출력 폴더(팩 zip, review/ 보고서·검수 파일)")
    ap.add_argument("--cert", default="SURVEY", choices=S.available(), help="종목 코드(출제기준 프로필)")
    ap.add_argument("--prepared-by", default="원큐합격 전처리기 v0.5", help="만든 사람(기본: 자동 — ADR 021 6절)")
    ap.add_argument("--origin", default="", help="원본 출처(기본: 문서 머리말·꼬리말에서 읽음, 모르면 '직접 올림')")
    ap.add_argument("--source-type", default=None, choices=["public-pbt", "recalled", "other"], help="기본: 문서에서 읽음")
    ap.add_argument("--date", help="시행일 YYYY-MM-DD 직접 지정(PDF 1개) — 기본은 문서 내용에서 읽고, 못 찾으면 '0000년 nn회'")
    ap.add_argument("--round", type=int, dest="round_no", help="회차 강제 지정(PDF 1개)")
    ap.add_argument("--pack-version", type=int, default=3, help="팩 판(v0.5부터 기본 3: 단원·유형이 든 판, v0.4는 2 — 앱이 낮은 판을 자동 교체, 기록은 이어짐)")
    ap.add_argument("--report-only", action="store_true", help="팩은 쓰지 않고 보고서만")
    ap.add_argument("--no-bundle", action="store_true", help="종목 묶음(oneq-종목-bundle-….zip)을 만들지 않음")
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
            extra = f" → {r.review_file}" if r.review_file else ""
            print(f"  {mark} {what}: {STATUS_TEXT[r.status]} — {r.message}{extra}", flush=True)
        elif ev.kind == "finish" and ev.bundle:
            print(f"\n종목 묶음: {ev.bundle}", flush=True)

    spec = BatchSpec(list(a.pdf), a.cert, a.out, a.prepared_by, a.origin, a.source_type, a.date, a.round_no,
                     a.pack_version, a.report_only, ap_workers, bundle=not a.no_bundle)
    try:
        rows = run_batch(spec, show)
    except ValueError as e:
        sys.exit(str(e))
    ok = sum(r.status == "packed" for r in rows)
    bad = sum(r.status in ("review", "error") for r in rows)
    print(f"\n팩 {ok}개 / 검수 필요·오류 {bad}개. 보고서: {a.out / REVIEW_DIR / 'report.html'}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
