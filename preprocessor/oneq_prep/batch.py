"""여러 기출 PDF를 한 번에 처리한다 — 명령줄과 창 프로그램이 함께 쓰는 핵심(ADR 018).

- 회차마다 따로 처리한다. 한 회차가 실패해도 나머지는 계속한다.
- 여러 회차를 CPU 코어에 나눠 동시에 처리한다(workers). 구기준 회차(재배정)는 현행 회차가 끝난 뒤.
- 진행은 on_event로 알리고, should_stop()이 참이면 아직 시작하지 않은 회차는 건너뛴다.
- 화면(Qt)에 의존하지 않는다.
"""
from __future__ import annotations

import multiprocessing
import os
import re
from concurrent.futures import FIRST_COMPLETED, Future, ProcessPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import standards as S
from .pack import REVIEW_DIR, Prepared, exam_from_filename, prepare, reference_from, write_pack, write_review_skeleton


@dataclass
class BatchSpec:
    pdfs: list[Path]
    cert: str
    out: Path
    prepared_by: str
    origin: str = ""
    source_type: str = "public-pbt"
    date: str | None = None          # 파일명에 시행일이 없을 때(PDF 1개)
    round_no: int | None = None      # 회차 강제(PDF 1개)
    pack_version: int = 2            # v0.4: 법령·기준 표시(ADR 019)가 든 판 — 앱이 1판을 자동 교체
    report_only: bool = False
    workers: int | None = None       # None이면 코어 수에 맞춰(최대 4)
    file_dates: dict[Path, str] = field(default_factory=dict)   # 파일별 시행일(파일명에 없을 때, 창 프로그램)
    context: list[Path] = field(default_factory=list)           # 회차 번호를 정할 때 함께 볼 PDF(한 회차만 다시 만들 때)

    def date_of(self, p: Path) -> str | None:
        return self.file_dates.get(p) or self.date

    def all_dates(self) -> list[str]:
        return _dates(list(dict.fromkeys([*self.pdfs, *self.context])))


@dataclass
class RoundResult:
    pdf: Path
    pack_id: str = ""
    date: str = ""
    status: str = "waiting"          # waiting · running · packed · review · error · skipped
    questions: int = 0
    law: int = 0                     # 법령·기준 문항 수(ADR 019)
    size: int = 0
    message: str = ""
    issues: list[str] = field(default_factory=list)
    zip_path: Path | None = None
    review_file: Path | None = None
    prepared: Prepared | None = None  # 검수 화면용(창 프로그램이 문항 카드를 그림)


@dataclass
class Event:
    kind: str                         # plan · start · done · finish
    index: int = -1
    total: int = 0
    result: RoundResult | None = None
    report: Path | None = None


STATUS_TEXT = {"waiting": "대기", "running": "처리 중", "packed": "팩 생성", "review": "검수 필요",
               "error": "오류", "skipped": "건너뜀"}


def default_workers() -> int:
    """동시에 처리할 회차 수. 회차 하나가 쪽 그림을 288dpi로 그려 메모리를 꽤 쓰므로 최대 4."""
    return max(1, min(4, (os.cpu_count() or 2) - 1))


def plan_rounds(spec: BatchSpec, prof: S.Profile) -> list[RoundResult]:
    """파일 이름으로 시행일·회차를 미리 정한다(처리 전에 목록에 보여 줄 수 있게)."""
    dates = spec.all_dates()
    rows = []
    for p in sorted(spec.pdfs, key=lambda x: x.name):
        r = RoundResult(pdf=p)
        try:
            ex = exam_from_filename(p, dates, spec.date_of(p), spec.round_no)
            r.date = ex["date"]
            r.pack_id = f"{prof.code}-{ex['year']}-{ex['round']}"
        except ValueError as e:
            r.status, r.message = "error", str(e)
        rows.append(r)
    return rows


def _dates(pdfs: list[Path]) -> list[str]:
    return ["-".join(m.groups()) for p in pdfs if (m := re.search(r"(20\d{2})(\d{2})(\d{2})", p.name))]


def _prepare_job(pdf: Path, cert: str, out: Path, dates: list[str], date: str | None, round_no: int | None,
                 reference=None, standards_root: str | None = None) -> Prepared:
    """작업 프로세스에서 도는 함수(모듈 맨 위에 있어야 Windows spawn에서 불러올 수 있다)."""
    prof = S.load(cert, Path(standards_root) if standards_root else None)
    return prepare(pdf, prof, out, dates, date, round_no, reference=reference)


def run_batch(spec: BatchSpec, on_event: Callable[[Event], None] | None = None,
              should_stop: Callable[[], bool] = lambda: False, standards_root: Path | None = None) -> list[RoundResult]:
    emit = on_event or (lambda e: None)
    prof = S.load(spec.cert, standards_root)
    if prof.draft:
        raise ValueError(f"출제기준 프로필 {spec.cert}은 초안(draft)입니다. 과목을 확정한 뒤 쓰세요.")
    spec.out.mkdir(parents=True, exist_ok=True)
    rows = plan_rounds(spec, prof)
    total = len(rows)
    emit(Event("plan", total=total))
    dates = spec.all_dates()
    std_root = str(standards_root) if standards_root else None
    current = [i for i, r in enumerate(rows) if r.status == "waiting" and not prof.is_legacy(r.date)]
    legacy = [i for i, r in enumerate(rows) if r.status == "waiting" and prof.is_legacy(r.date)]
    for i, r in enumerate(rows):
        if r.status == "error":
            emit(Event("done", i, total, r))

    def finish(i: int, prepared: Prepared | None, err: BaseException | None):
        r = rows[i]
        if err is not None:
            r.status, r.message = "error", f"{type(err).__name__}: {err}"
        else:
            _finish_round(spec, r, prepared)
        emit(Event("done", i, total, r))

    workers = max(1, spec.workers or default_workers())
    for group, ref in ((current, None), (legacy, "later")):
        if not group:
            continue
        reference = None
        if ref == "later":
            reference = reference_from([r.prepared for r in rows if r.prepared is not None], spec.out, prof.code)
        if workers == 1 or len(group) == 1:
            for i in group:
                if should_stop():
                    rows[i].status, rows[i].message = "skipped", "멈춤"
                    emit(Event("done", i, total, rows[i]))
                    continue
                rows[i].status = "running"
                emit(Event("start", i, total, rows[i]))
                try:
                    finish(i, _prepare_job(rows[i].pdf, spec.cert, spec.out, dates, spec.date_of(rows[i].pdf), spec.round_no,
                                           reference, std_root), None)
                except Exception as e:  # noqa: BLE001 — 회차 하나의 실패가 전체를 멈추지 않게
                    finish(i, None, e)
            continue
        # spawn: Windows와 같은 방식(창 프로그램은 스레드 안에서 부르므로 fork는 멈출 위험이 있음)
        ctx = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(max_workers=min(workers, len(group)), mp_context=ctx) as ex:
            queue = list(group)
            running: dict[Future, int] = {}
            while queue or running:
                while queue and len(running) < workers and not should_stop():
                    i = queue.pop(0)
                    rows[i].status = "running"
                    emit(Event("start", i, total, rows[i]))
                    running[ex.submit(_prepare_job, rows[i].pdf, spec.cert, spec.out, dates, spec.date_of(rows[i].pdf),
                                      spec.round_no, reference, std_root)] = i
                if should_stop():
                    for i in queue:
                        rows[i].status, rows[i].message = "skipped", "멈춤"
                        emit(Event("done", i, total, rows[i]))
                    queue.clear()
                if not running:
                    break
                done, _ = wait(list(running), timeout=0.5, return_when=FIRST_COMPLETED)
                for fut in done:
                    i = running.pop(fut)
                    try:
                        finish(i, fut.result(), None)
                    except Exception as e:  # noqa: BLE001
                        finish(i, None, e)

    from .report import write_report
    prepared = [r.prepared for r in rows if r.prepared is not None]
    report = write_report(prepared, spec.out / REVIEW_DIR / "report.html") if prepared else None
    emit(Event("finish", total=total, report=report))
    return rows


def _finish_round(spec: BatchSpec, r: RoundResult, p: Prepared) -> None:
    r.prepared = p
    r.pack_id = p.pack_id
    r.questions = len(p.items)
    r.law = sum("law" in it.flags for it in p.items if not it.excluded)
    r.issues = list(p.issues)
    if p.issues or spec.report_only:
        if p.issues:
            p.review_file = write_review_skeleton(spec.out, p.pack_id, p.pdf.name, p.review,
                                                  [it.suggestion for it in p.items if it.suggestion])
            r.review_file = p.review_file
            r.status = "review"
            r.message = f"검수 필요 {len(p.issues)}건"
        else:
            r.status, r.message = "skipped", "보고서만"
        return
    p.zip_path, m = write_pack(p, spec.out, spec.prepared_by, spec.source_type, spec.origin, spec.pack_version)
    r.zip_path = p.zip_path
    r.size = p.zip_path.stat().st_size
    r.questions = m["questionCount"]
    r.status = "packed"
    r.message = f"{m['questionCount']}문항 · 정답 표시 {p.masked}개 제거 · {r.size / 1e6:.2f}MB"
