"""문제팩(.zip, oqp/1) 만들기.

사용 예:
    python -m oneq_prep.pack <기출.pdf> <출력폴더> --cert SURVEY --prepared-by Hoonie
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

import pdfplumber

from . import __version__
from .extract import analyze
from .render import crop_question, mark_leaks, mask_filled_labels, regions_for, render_pages

CERTS = {
    "SURVEY": {"name": "측량및지형공간정보기사", "grade": "기사", "lawSubjects": []},
}
PASS_RULE = {"subjectMin": 40, "avgMin": 60}


def exam_from_filename(path: Path, all_dates: list[str] | None = None) -> dict:
    """파일명의 시행일(YYYYMMDD)로 연도·회차를 정한다. 회차는 같은 해 시행일 순서.
    2020년 기사는 1·2회를 통합 시행해 첫 시행일이 1·2회, 이후가 3·4회다."""
    m = re.search(r"(20\d{2})(\d{2})(\d{2})", path.name)
    if not m:
        raise ValueError(f"파일명에서 시행일을 찾지 못함: {path.name}")
    y, mo, d = m.groups()
    date = f"{y}-{mo}-{d}"
    same_year = sorted(x for x in (all_dates or [date]) if x.startswith(y))
    idx = same_year.index(date) if date in same_year else 0
    exam = {"year": int(y), "round": idx + 1, "date": date}
    if y == "2020":
        exam["round"] = [1, 3, 4][idx] if idx < 3 else idx + 1
        if idx == 0:
            exam["roundLabel"] = "1·2회 통합"
    return exam


def content_hash(text: str) -> str:
    norm = re.sub(r"\s+", "", text)
    return "t:" + hashlib.sha256(norm.encode("utf-8")).hexdigest()[:16]


def _figure_boxes(pdf_path: Path) -> dict[int, list[tuple[float, float, float, float]]]:
    """페이지별 그림 영역(래스터 이미지, 표·도형 선). 'has-figure' 표시에 쓴다."""
    out: dict[int, list] = {}
    with pdfplumber.open(pdf_path) as pdf:
        for pi, page in enumerate(pdf.pages):
            boxes = [(im["x0"], im["top"], im["x1"], im["bottom"]) for im in page.images]
            short = [o for o in page.lines + page.curves + page.rects
                     if (o["x1"] - o["x0"]) < page.width * 0.6 and (o["bottom"] - o["top"]) < page.height * 0.6]
            boxes += [(o["x0"], o["top"], o["x1"], o["bottom"]) for o in short]
            out[pi] = boxes
    return out


def build_pack(pdf_path: Path, out_dir: Path, cert_code: str, prepared_by: str,
               source_origin: str = "", pack_version: int = 1, all_dates: list[str] | None = None,
               image_quality: int = 80) -> tuple[Path, dict]:
    layout = analyze(pdf_path)
    errors = list(layout.warnings)
    for q in layout.questions:
        errors += [f"{q.no}번: {w}" for w in q.warnings if not w.startswith("info:")]

    exam = exam_from_filename(pdf_path, all_dates)
    cert = CERTS[cert_code]
    pack_id = f"{cert_code}-{exam['year']}-{exam['round']}"

    pages = render_pages(pdf_path)
    masked = mask_filled_labels(pages, layout)
    leaks = {q.no: mark_leaks(pages, q) for q in layout.questions}
    leaks = {k: v for k, v in leaks.items() if v}
    regions = regions_for(layout)
    figs = _figure_boxes(pdf_path)

    files: dict[str, bytes] = {}
    questions = []
    sub_counter: dict[int, int] = {}
    for q in layout.questions:
        inline, table = q.inline_answer, layout.answer_table.get(q.no)
        if inline and table:
            answer, src, check = inline, "inline-mark", "agree" if inline == table else None
            if check is None:
                errors.append(f"{q.no}번: 보기 표시 {inline} ≠ 정답표 {table}")
                check = "agree"   # 오류로 중단되므로 실제로 쓰이지 않음
        elif inline or table:
            answer, src, check = inline or table, "inline-mark" if inline else "answer-table", "single"
        else:
            errors.append(f"{q.no}번: 정답을 찾지 못함")
            continue
        sub_counter[q.subject_no] = sub_counter.get(q.subject_no, 0) + 1
        img = crop_question(pages, layout, regions[q.no])
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=image_quality, method=6)
        path = f"images/{q.no:03d}.webp"
        files[path] = buf.getvalue()

        flags = []
        regs = regions[q.no]
        if any(
            bx[0] < layout.col_x[r.col][1] and bx[2] > layout.col_x[r.col][0] and bx[1] < r.bottom and bx[3] > r.top
            for r in regs for bx in figs.get(r.page, [])
        ):
            flags.append("has-figure")
        if len(q.segments) > 1:
            flags.append("spans-column")
        if q.stem_filled:
            flags.append("stem-has-circled-glyph")
        text = q.text()
        questions.append({
            "qid": f"{pack_id}-{q.no:03d}",
            "no": q.no,
            "subjectNo": q.subject_no,
            "noInSubject": sub_counter[q.subject_no],
            "answer": answer,
            "choiceCount": len(q.labels) or 4,
            "answerSource": src,
            "answerCheck": check,
            "img": path,
            "imgSize": [img.width, img.height],
            "text": text,
            "contentHash": content_hash(text),
            "keywords": [],
            "lawRefs": [],
            "clusterId": None,
            "flags": flags,
        })

    if leaks:
        errors.append(f"정답 표시 잔존 의심: {leaks}")
    if errors:
        raise ValueError("팩을 만들 수 없음:\n  " + "\n  ".join(errors))

    qjson = json.dumps(questions, ensure_ascii=False, indent=1).encode("utf-8")
    files = {"questions.json": qjson, **files}
    subjects = []
    for no in sorted(sub_counter):
        name = layout.subjects.get(no, f"{no}과목")
        subjects.append({"no": no, "name": name, "count": sub_counter[no], "isLaw": name in cert["lawSubjects"]})
    manifest = {
        "format": "oqp/1",
        "packId": pack_id,
        "packVersion": pack_version,
        "cert": {"code": cert_code, "name": cert["name"], "grade": cert["grade"]},
        "exam": exam,
        "subjects": subjects,
        "passRule": PASS_RULE,
        "questionCount": len(questions),
        "source": {"type": "public-pbt", "origin": source_origin} if source_origin else {"type": "public-pbt"},
        "preparedBy": prepared_by,
        "reviewedAt": None,
        "createdAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "generator": f"oneq-prep {__version__}",
        "answerMasking": {
            "method": ["filled-glyph-replace"] if masked else ["none-needed"],
            "masked": masked,
            "leakCheck": "passed",
        },
        "files": [{"path": p, "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for p, b in files.items()],
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    zpath = out_dir / f"oneq-{pack_id}.zip"
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=1))
        for p, b in files.items():
            # webp는 이미 압축돼 있어 STORED로 둔다(해제 속도↑)
            z.writestr(p, b, zipfile.ZIP_STORED if p.endswith(".webp") else zipfile.ZIP_DEFLATED)
    return zpath, manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description="기출 PDF → 원큐합격 문제팩(.zip)")
    ap.add_argument("pdf", nargs="+", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--cert", default="SURVEY", choices=sorted(CERTS))
    ap.add_argument("--prepared-by", required=True)
    ap.add_argument("--origin", default="")
    a = ap.parse_args(argv)
    dates = []
    for p in a.pdf:
        m = re.search(r"(20\d{2})(\d{2})(\d{2})", p.name)
        if m:
            dates.append("-".join(m.groups()))
    for p in a.pdf:
        z, m = build_pack(p, a.out, a.cert, a.prepared_by, a.origin, all_dates=dates)
        size = z.stat().st_size
        print(f"{z.name}: {m['questionCount']}문항, 정답 표시 {m['answerMasking']['masked']}개 제거, {size/1e6:.2f}MB")


if __name__ == "__main__":
    main()
