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
from . import standards as S
from .extract import Layout, analyze
from .reassign import Reference, Suggestion
from .render import (crop_question, mark_leaks, mask_filled_labels, mask_ocr_filled, regions_for,
                     remove_highlight_near_labels, render_pages)

REVIEW_DIR = "review"
REASSIGN_MIN_CONF = 0.6     # 이보다 낮은 재배정 제안은 보고서에서 '확인 필요'로 강조


# ───────────────────────── 회차 정보 ─────────────────────────

def exam_from_filename(path: Path, all_dates: list[str] | None = None, date: str | None = None,
                       round_no: int | None = None) -> dict:
    """파일명의 시행일(YYYYMMDD)로 연도·회차를 정한다. 회차는 같은 해 시행일 순서.
    2020년 기사는 1·2회를 통합 시행해 첫 시행일이 1·2회, 이후가 3·4회다.
    시행일이 없는 파일명("..._2024_3회_...")은 연도·회차를 읽고 시행일은 --date로 받는다."""
    m = re.search(r"(20\d{2})(\d{2})(\d{2})", path.name)
    if m:
        y, mo, d = m.groups()
        dte = f"{y}-{mo}-{d}"
        same_year = sorted(x for x in (all_dates or [dte]) if x.startswith(y))
        idx = same_year.index(dte) if dte in same_year else 0
        exam = {"year": int(y), "round": idx + 1, "date": date or dte}
        if y == "2020":
            exam["round"] = [1, 3, 4][idx] if idx < 3 else idx + 1
            if idx == 0:
                exam["roundLabel"] = "1·2회 통합"
        if round_no:
            exam["round"] = round_no
        return exam
    m = re.search(r"(20\d{2})\D{0,3}?(\d)\s*회", path.name)
    if not m:
        raise ValueError(f"파일명에서 시행일(YYYYMMDD) 또는 '연도_N회'를 찾지 못함: {path.name}")
    if not date:
        raise ValueError(f"{path.name}: 파일명에 시행일이 없어 --date YYYY-MM-DD 가 필요함")
    return {"year": int(m.group(1)), "round": round_no or int(m.group(2)), "date": date}


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


def write_review_skeleton(out_dir: Path, pack_id: str, source: str, review: dict,
                          suggestions: list[Suggestion]) -> Path:
    p = review_path(out_dir, pack_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    d = {"_도움말": REVIEW_HELP, "packId": pack_id, "source": source,
         "subjectMap": review.get("subjectMap", {}), "answers": review.get("answers", {}),
         "acceptAlso": review.get("acceptAlso", {}), "exclude": review.get("exclude", {}),
         "reassign": review.get("reassign") or {str(s.no): s.suggested for s in suggestions if s.suggested != s.current},
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
    zip_path: Path | None = None
    review_file: Path | None = None


def prepare(pdf_path: Path, profile: S.Profile, out_dir: Path, all_dates: list[str] | None = None,
            date: str | None = None, round_no: int | None = None, image_quality: int = 80,
            reference: Reference | None = None, log=print) -> Prepared:
    from .ocr import needs_ocr, ocr_pdf

    issues: list[str] = []
    notes: list[str] = []
    exam = exam_from_filename(pdf_path, all_dates, date, round_no)
    pack_id = f"{profile.code}-{exam['year']}-{exam['round']}"
    review = load_review(out_dir, pack_id)

    ocr_pages = None
    if needs_ocr(pdf_path):
        log(f"  {pdf_path.name}: 텍스트층 없음 → OCR")
        ocr_pages = ocr_pdf(pdf_path)
        notes.append("스캔본: OCR로 문항 경계를 찾음 — 보기·정답을 반드시 검수")
    layout = analyze(pdf_path, ocr_pages=ocr_pages)
    issues += layout.warnings

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
    n_ex = sum(1 for it in items if it.excluded)
    if n_ex:
        notes.append(f"제외 {n_ex}문항")
    if layout.numbering == "per-subject":
        notes.append("원본은 과목마다 번호가 1부터 다시 시작 — 팩 번호(no)는 시험지 전체 순번")
    return Prepared(pdf_path, pack_id, exam, profile, method, masked, items, issues, notes,
                    layout.numbering, layout.ocr, legacy, review, renamed)


# ───────────────────────── 팩 쓰기 ─────────────────────────

def write_pack(p: Prepared, out_dir: Path, prepared_by: str, source_type: str = "public-pbt",
               source_origin: str = "", pack_version: int = 1) -> tuple[Path, dict]:
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
            "lawRefs": [],
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
        subjects.append(s)
    excluded: dict[tuple[str, str], list[int]] = {}
    for it in p.items:
        if it.excluded:
            reason = "abolished-subject" if it.subject is None else ("unreadable" if "판독" in it.excluded else "other")
            excluded.setdefault((it.pdf_subject, reason, it.excluded if reason == "other" else ""), []).append(it.no)

    qjson = json.dumps(questions, ensure_ascii=False, indent=1).encode("utf-8")
    files = {"questions.json": qjson, **files}
    source = {"type": source_type}
    if source_origin:
        source["origin"] = source_origin
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
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        for k, b in files.items():
            # webp는 이미 압축돼 있어 STORED로 둔다(해제 속도↑)
            z.writestr(k, b, zipfile.ZIP_STORED if k.endswith(".webp") else zipfile.ZIP_DEFLATED)
    return zpath, manifest


def build_pack(pdf_path: Path, out_dir: Path, cert_code: str, prepared_by: str, source_origin: str = "",
               pack_version: int = 1, all_dates: list[str] | None = None, image_quality: int = 80) -> tuple[Path, dict]:
    """1단계 호환: 문제가 있으면 ValueError."""
    prof = S.load(cert_code)
    p = prepare(Path(pdf_path), prof, Path(out_dir), all_dates, image_quality=image_quality)
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
    ap.add_argument("--prepared-by", required=True)
    ap.add_argument("--origin", default="", help="원본 출처(사이트·자료명)")
    ap.add_argument("--source-type", default="public-pbt", choices=["public-pbt", "recalled", "other"])
    ap.add_argument("--date", help="시행일 YYYY-MM-DD(파일명에 없을 때, PDF 1개)")
    ap.add_argument("--round", type=int, dest="round_no", help="회차 강제 지정(PDF 1개)")
    ap.add_argument("--pack-version", type=int, default=1)
    ap.add_argument("--report-only", action="store_true", help="팩은 쓰지 않고 보고서만")
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

    spec = BatchSpec(list(a.pdf), a.cert, a.out, a.prepared_by, a.origin, a.source_type, a.date, a.round_no,
                     a.pack_version, a.report_only, ap_workers)
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
