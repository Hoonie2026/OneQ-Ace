"""처리 전 '과목 개편 요약'과 처리 후 '법령·기준 문항 요약' 글(ADR 019). 화면(Qt)에 의존하지 않음."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field
from pathlib import Path

from . import standards as S

def peek_subjects(pdf: Path) -> list[str]:
    """PDF의 과목 머리말을 실제 추출기로 읽는다(두 단이 섞이지 않게). 1~3초 — 화면은 백그라운드에서 부른다."""
    from .extract import analyze
    try:
        lay = analyze(pdf)
    except Exception:  # noqa: BLE001 — 미리 보기는 실패해도 처리에는 영향 없음
        return []
    return [lay.subjects[k] for k in sorted(lay.subjects)]


@dataclass
class ChangeSummary:
    pdf_subjects: list[str] = field(default_factory=list)
    merged: dict[str, list[str]] = field(default_factory=dict)    # 표준 과목 ← 여러 PDF 과목
    renamed: list[tuple[str, str]] = field(default_factory=list)
    excluded: list[str] = field(default_factory=list)
    unknown: list[str] = field(default_factory=list)
    legacy_rounds: int = 0
    std_count: int = 0
    std_questions: int = 0

    @property
    def changed(self) -> bool:
        return bool(self.merged or self.renamed or self.excluded or self.unknown or self.legacy_rounds)

    def lines(self) -> list[str]:
        out = [f"PDF 과목 {len(self.pdf_subjects)}개 → 현행 출제기준 {self.std_count}과목 {self.std_questions}문항"]
        for std, raws in self.merged.items():
            out.append(f"합쳐짐: {' + '.join(raws)} → {std}")
        if self.renamed:
            out.append("이름 바뀜: " + " · ".join(f"{a} → {b}" for a, b in self.renamed))
        if self.excluded:
            out.append("빠짐(폐지 과목): " + " · ".join(self.excluded))
        if self.unknown:
            out.append("출제기준에 없는 과목명: " + " · ".join(self.unknown) + " — 처리 후 검수 창에서 연결")
        if self.legacy_rounds:
            out.append(f"구기준 회차 {self.legacy_rounds}개: 문항마다 과목을 다시 배정해야 함(검수 창에서 제안 확인)")
        if not self.changed:
            out.append("과목 구성이 현행 출제기준과 같습니다")
        return out


def subject_change(profile: S.Profile, subject_lists: list[list[str]], dates: list[str] | None = None) -> ChangeSummary:
    cs = ChangeSummary(std_count=len(profile.subjects), std_questions=sum(s["count"] for s in profile.subjects))
    seen: list[str] = []
    for lst in subject_lists:
        for n in lst:
            if n not in seen:
                seen.append(n)
    cs.pdf_subjects = seen
    to_std: dict[str, list[str]] = {}
    for raw in seen:
        kind, _, std = profile.resolve(raw)
        if kind == "std":
            to_std.setdefault(std, []).append(raw)
            if S.norm(raw) != S.norm(std):
                cs.renamed.append((raw, std))
        elif kind == "excluded":
            cs.excluded.append(raw)
        else:
            cs.unknown.append(raw)
    for std, raws in to_std.items():
        if len(raws) > 1:
            cs.merged[std] = raws
            cs.renamed = [(a, b) for a, b in cs.renamed if b != std]
    cs.legacy_rounds = sum(1 for d in (dates or []) if d and profile.is_legacy(d))
    return cs


def law_summary(rows, now_year: int | None = None, old_years: int = 5) -> list[str]:
    """처리 결과(batch.RoundResult 목록) → 법령·기준 문항 요약 글. 없으면 빈 목록."""
    done = [r for r in rows if r.status in ("packed", "review") and r.questions]
    if not done:
        return []
    law = sum(r.law for r in done)
    q = sum(r.questions for r in done)
    if not law:
        return []
    year = now_year or dt.date.today().year
    old = sum(1 for r in done if r.date and int(r.date[:4]) <= year - old_years)
    out = [f"법령·기준 관련 {law:,}문항({law / q:.0%}) — 법령·고시·시방서가 개정되면 기출의 원본 정답이 현행과 다를 수 있습니다."]
    if old:
        out.append(f"{old_years}년 넘은 회차 {old}개가 들어 있습니다. 이 문항들은 앱에서 답한 뒤 '현행 기준 확인' 안내가 나옵니다.")
    else:
        out.append("이 문항들은 앱에서 답한 뒤 '현행 기준 확인' 안내가 나옵니다.")
    return out
