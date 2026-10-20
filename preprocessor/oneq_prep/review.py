"""검수 파일(review/<packId>.review.json)을 화면의 수정 사항으로 만든다 — HTML 보고서와 창 프로그램 공용 규칙.

HTML 보고서(report.py)의 [검수 파일 저장]과 같은 결과가 나와야 한다:
- 바꾼 것만 적는다(원래 정답·과목과 같으면 지움). 기존 검수 파일의 내용은 유지하고 그 위에 덮는다.
- 화면에서 '제외'를 해제한 문항은 기존 검수 파일의 exclude에서도 뺀다.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .pack import REVIEW_HELP, review_path


@dataclass
class Edit:
    """문항 하나에 대한 화면의 현재 값."""
    answer: int | None = None       # 고른 정답
    subject: str | None = None      # 고른 과목(표준 이름)
    excluded: bool = False
    reason: str = ""


def build_review(prepared, edits: dict[int, Edit], reviewed: bool, subject_map: dict[str, str] | None = None) -> dict:
    """prepared: pack.Prepared. edits: 문항번호 → 화면 값(바꾼 문항만 넣어도 됨)."""
    base = prepared.review or {}
    out = {
        "_도움말": REVIEW_HELP,
        "packId": prepared.pack_id,
        "source": prepared.pdf.name,
        "subjectMap": {**base.get("subjectMap", {}), **(subject_map or {})},
        "answers": dict(base.get("answers", {})),
        "acceptAlso": dict(base.get("acceptAlso", {})),
        "exclude": dict(base.get("exclude", {})),
        "reassign": dict(base.get("reassign", {})),
        "reviewed": bool(reviewed),
    }
    items = {it.no: it for it in prepared.items}
    for no, e in edits.items():
        it = items.get(no)
        if it is None:
            continue
        k = str(no)
        # it.answer·it.subject는 이미 기존 검수 파일을 반영한 값 → 같으면 바꾸지 않은 것
        if e.answer is not None and e.answer != it.answer:
            out["answers"][k] = e.answer
        if e.subject:
            if e.subject != it.subject:
                out["reassign"][k] = e.subject
            elif k in out["reassign"] and "subject-reassigned" not in it.flags:
                out["reassign"].pop(k)
        if it.subject is None:
            continue          # 폐지 과목으로 빠진 문항은 프로필이 정함(검수 파일에 적지 않음)
        if e.excluded:
            out["exclude"][k] = e.reason.strip() or it.excluded or "판독 불가"
        else:
            out["exclude"].pop(k, None)
    return out


def save_review(out_dir: Path, review: dict) -> Path:
    p = review_path(out_dir, review["packId"])
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(review, ensure_ascii=False, indent=1), encoding="utf-8")
    return p
