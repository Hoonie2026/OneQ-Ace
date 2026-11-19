"""여러 기출 PDF를 한 번에 처리한다 — 명령줄과 창 프로그램이 함께 쓰는 핵심(ADR 018).

- 회차마다 따로 처리한다. 한 회차가 실패해도 나머지는 계속한다.
- 모든 회차를 준비한 뒤 정답을 믿을 수 없는 문항을 다른 회차와 맞춰 보고(crosscheck, ADR 024) 팩을 쓴다.
- 여러 회차를 CPU 코어에 나눠 동시에 처리한다(workers). 구기준 회차(재배정)는 현행 회차가 끝난 뒤.
- 진행은 on_event로 알리고, should_stop()이 참이면 아직 시작하지 않은 회차는 건너뛴다.
- 화면(Qt)에 의존하지 않는다.
"""
from __future__ import annotations

import multiprocessing
import os
from concurrent.futures import FIRST_COMPLETED, Future, ProcessPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from . import standards as S
from . import examinfo
from .pack import Prepared, prepare, reference_from, rounds_dir, write_pack


@dataclass
class BatchSpec:
    pdfs: list[Path]
    cert: str
    out: Path
    prepared_by: str
    origin: str = ""
    source_type: str | None = None   # None·"" = 문서에서 읽은 출처(ADR 021 6절)
    date: str | None = None          # 시행일 직접 지정(PDF 1개) — 보통은 문서 내용에서 읽음
    round_no: int | None = None      # 회차 강제(PDF 1개)
    pack_version: int = 3            # v0.5 판(v0.4 = 2) — 같은 회차를 내용이 바뀌게 다시 만들면 판이 하나 올라 앱이 자동 교체(기록은 이어짐)
    report_only: bool = False
    workers: int | None = None       # None이면 코어 수에 맞춰(최대 4)
    bundle: bool = True              # 끝나면 종목 묶음 1개(이번에 새로 만들거나 바뀐 회차만, ADR 021 8절)
    file_dates: dict[Path, str] = field(default_factory=dict)   # 파일별 시행일 직접 지정(창 프로그램)
    context: list[Path] = field(default_factory=list)           # (v0.4 호환, 쓰지 않음 — 회차는 시행월로 정함)

    def date_of(self, p: Path) -> str | None:
        return self.file_dates.get(p) or self.date


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
    stage: str = ""                  # 처리 단계(읽기 · 문항 나누기 · 정답 · 분류 · 팩) — ADR 021 6절
    kind: str = ""                   # 글자 / 스캔 / 섞임(쪽마다 글자층 유무)
    zip_path: Path | None = None
    review_file: Path | None = None
    prepared: Prepared | None = None  # 검수 화면용(창 프로그램이 문항 카드를 그림)
    retry: bool = False               # 동시 처리 중 MemoryError → 한 회차씩 한 번 더
    no_answer: int = 0                # 정답 미지정으로 넣은 문항 수(학습앱에서 지정, 2026-11-17)
    other_cert: str = ""              # 문서 머리말이 다른 종목(창 프로그램은 목록에 넣지 않고 경고 — 2026-11-17)
    supplement: bool = False          # 보충 문서(직접 타이핑한 빠진 문항) — 같은 회차 원본에 더함(supplement.py)


@dataclass
class Event:
    kind: str                         # plan · start · stage · done · finish
    index: int = -1
    total: int = 0
    result: RoundResult | None = None
    report: Path | None = None
    bundle: Path | None = None


STATUS_TEXT = {"waiting": "대기", "running": "처리 중", "packed": "문제팩 생성", "review": "만들지 못함",
               "error": "오류", "skipped": "건너뜀"}


GB_PER_WORKER = 1.5   # 스캔본 회차 하나가 쪽 그림(288dpi 컬러)·회색본·OCR 좌표로 쓰는 메모리(철도토목기사 12쪽 실측 여유 포함)


def available_gb() -> float | None:
    """지금 남은 실제 메모리(GB). 모르면 None."""
    try:
        if os.name == "nt":
            import ctypes

            class _MS(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
            m = _MS()
            m.dwLength = ctypes.sizeof(_MS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                return m.ullAvailPhys / 2**30
            return None
        return os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE") / 2**30
    except (AttributeError, ValueError, OSError):
        return None


def default_workers() -> int:
    """동시에 처리할 회차 수 — CPU 코어 수(최대 4)와 남은 메모리(회차당 약 1.5GB) 중 작은 쪽.
    (실기기 2026-11-18: 철도토목기사 스캔본 15회차를 4개씩 동시에 처리하다 메모리가 모자라 3회차 실패)"""
    n = max(1, min(4, (os.cpu_count() or 2) - 1))
    gb = available_gb()
    if gb is not None:
        n = max(1, min(n, int(gb / GB_PER_WORKER)))
    return n


def is_memory_error(e: BaseException | None) -> bool:
    """메모리 부족인지 — PDF 읽기 라이브러리가 다른 오류(PdfminerException 등)로 감싸 올려도 원인을 따라가 본다."""
    seen = 0
    while e is not None and seen < 10:
        if isinstance(e, MemoryError):
            return True
        e = e.__cause__ or e.__context__
        seen += 1
    return False


def plan_one(p: Path, prof: S.Profile, spec: BatchSpec, names=None) -> RoundResult:
    """PDF 하나의 시행일·회차·종류를 첫 쪽 머리말에서 미리 읽는다(같은 회차 겹침 확인은 mark_duplicates)."""
    r = RoundResult(pdf=p)
    try:
        info = examinfo.read(p, names=names if names is not None else examinfo.known_cert_names())
        if info.cert_name and S.norm(info.cert_name) != S.norm(prof.name):
            # 다른 종목 문서는 처리하지 않음(ADR 021 2절 — 내용으로 판정). 번호(0000년 nn회)도 잡지 않게 여기서 멈춤
            r.status, r.message = "error", f"'{info.cert_name}' 문서로 보여요 — 종목을 확인하세요"
            r.other_cert = info.cert_name
            return r
        from . import supplement
        sup = supplement.header(p)
        if sup:
            info.year = sup[0]
            info.round = sup[1] or supplement.UNKNOWN_ROUND
            r.supplement = True
        ex, _ = examinfo.exam_of(p, prof, spec.out, spec.date_of(p), spec.round_no, info)
        r.date = ex["date"]
        r.pack_id = examinfo.pack_id(prof.code, ex)
        r.kind = examinfo.page_kind(p)
    except (ValueError, OSError) as e:
        r.status, r.message = "error", str(e)
    return r


def mark_duplicates(rows: list[RoundResult]) -> list[RoundResult]:
    """같은 팩 이름이 둘 나오면(같은 회차 파일 두 개) 뒤의 것은 오류로 둔다.
    회차를 적지 않은 보충 문서는 그해 원본 회차가 하나뿐이면 그 회차로 잇는다(supplement.UNKNOWN_ROUND)."""
    from .supplement import UNKNOWN_ROUND
    for r in rows:
        if r.supplement and r.pack_id and r.pack_id.endswith(f"-{UNKNOWN_ROUND}") and r.status != "error":
            year = r.pack_id.rsplit("-", 2)[-2]
            mains = [x for x in rows if not x.supplement and x.pack_id and x.status != "error"
                     and x.pack_id.rsplit("-", 2)[-2] == year]
            if len(mains) == 1:
                r.pack_id = mains[0].pack_id
            elif mains:
                r.status, r.message = "error", f"{year}년 원본이 {len(mains)}개 회차 — 보충 문서 첫 줄에 회차를 적어 주세요(예: {year}년 … 2회 보충)"
            else:
                r.status, r.message = "error", f"{year}년 원본 회차 PDF를 함께 올려 주세요 — 보충 문서는 원본 회차 문제팩에 더합니다"
    seen: dict[str, Path] = {}
    for r in rows:
        if r.status == "error" or not r.pack_id or r.supplement:
            continue
        if r.pack_id in seen:
            r.status, r.message = "error", f"{seen[r.pack_id].name}와 같은 회차({r.pack_id})"
        seen.setdefault(r.pack_id, r.pdf)
    return rows


def plan_rounds(spec: BatchSpec, prof: S.Profile) -> list[RoundResult]:
    """문서 첫 쪽 머리말에서 시행일·회차를 미리 읽는다(처리 전에 목록에 보여 줄 수 있게, ADR 021 2절)."""
    names = examinfo.known_cert_names()
    return mark_duplicates([plan_one(p, prof, spec, names) for p in sorted(spec.pdfs, key=lambda x: x.name)])


def _prepare_job(pdf: Path, cert: str, out: Path, date: str | None, round_no: int | None,
                 reference=None, standards_root: str | None = None, queue=None) -> Prepared:
    """작업 프로세스에서 도는 함수(모듈 맨 위에 있어야 Windows spawn에서 불러올 수 있다).
    queue: 단계 알림(파일, 단계)을 화면 쪽으로 보내는 통로(multiprocessing Manager Queue 또는 None)."""
    prof = S.load(cert, Path(standards_root) if standards_root else None)
    step = (lambda s: queue.put((str(pdf), s))) if queue is not None else None
    try:
        return prepare(pdf, prof, out, date, round_no, reference=reference, log=lambda *_: None, progress=step)
    except Exception as e:  # noqa: BLE001 — 메모리 부족만 따로(감싼 오류 포함), 나머지는 그대로
        if not is_memory_error(e):
            raise
        # 작업 프로세스의 원인 위치를 화면 쪽 기록(logs/error.log)에 남기려고 traceback을 붙여 다시 던짐(실기기 2026-11-16)
        import traceback
        raise JobMemoryError(traceback.format_exc()) from e


class JobMemoryError(MemoryError):
    """작업 프로세스에서 난 MemoryError(+ 그 프로세스의 traceback). 화면 쪽에서 한 번 더(한 회차씩) 처리한다."""


def _log_error(pdf: Path, text: str) -> None:
    """처리 오류의 자세한 원인을 %APPDATA%\\OneQ-Ace\\logs\\error.log에(오류 칸에는 짧게만 보임)."""
    import datetime
    try:
        d = S.user_root().parent / "logs"
        d.mkdir(parents=True, exist_ok=True)
        with open(d / "error.log", "a", encoding="utf-8") as f:
            f.write(f"\n=== {datetime.datetime.now():%Y-%m-%d %H:%M:%S} 처리 오류 {pdf.name} ===\n{text}\n")
    except OSError:
        pass


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
    std_root = str(standards_root) if standards_root else None
    current = [i for i, r in enumerate(rows) if r.status == "waiting" and not prof.is_legacy(r.date)]
    legacy = [i for i, r in enumerate(rows) if r.status == "waiting" and prof.is_legacy(r.date)]
    for i, r in enumerate(rows):
        if r.status == "error":
            emit(Event("done", i, total, r))

    by_pdf = {str(r.pdf): i for i, r in enumerate(rows)}

    def on_stage(pdf: str, stage: str) -> None:
        i = by_pdf.get(pdf)
        if i is not None and rows[i].status == "running":
            rows[i].stage = stage
            emit(Event("stage", i, total, rows[i]))

    def finish(i: int, prepared: Prepared | None, err: BaseException | None):
        """준비가 끝난 회차는 다른 회차를 기다린다(정답 교차 확인 뒤 모든 회차의 팩을 씀)."""
        r = rows[i]
        if err is not None:
            import traceback
            _log_error(r.pdf, str(err) if isinstance(err, JobMemoryError)
                       else "".join(traceback.format_exception(type(err), err, err.__traceback__)))
            if is_memory_error(err):
                r.status, r.message = "error", "메모리가 모자랐어요 — 다른 프로그램을 닫고 이 회차만 다시 처리해 주세요"
                r.retry = True                       # 동시 처리가 끝난 뒤 한 회차씩 한 번 더
            else:
                r.status, r.message = "error", f"{type(err).__name__}: {err}"
            emit(Event("done", i, total, r))
            return
        r.prepared = prepared
        on_stage(str(r.pdf), "팩 대기")

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
                    p = prepare(rows[i].pdf, prof, spec.out, spec.date_of(rows[i].pdf), spec.round_no,
                                reference=reference, log=lambda *_: None,
                                progress=lambda s, _p=str(rows[i].pdf): on_stage(_p, s))
                    finish(i, p, None)
                except Exception as e:  # noqa: BLE001 — 회차 하나의 실패가 전체를 멈추지 않게
                    finish(i, None, e)
            continue
        # spawn: Windows와 같은 방식(창 프로그램은 스레드 안에서 부르므로 fork는 멈출 위험이 있음)
        ctx = multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(max_workers=min(workers, len(group)), mp_context=ctx) as ex, ctx.Manager() as mgr:
            stages = mgr.Queue()

            def drain() -> None:
                while True:
                    try:
                        on_stage(*stages.get_nowait())
                    except Exception:  # noqa: BLE001 — 비었음(queue.Empty)
                        return
            queue = list(group)
            running: dict[Future, int] = {}
            while queue or running:
                while queue and len(running) < workers and not should_stop():
                    i = queue.pop(0)
                    rows[i].status = "running"
                    emit(Event("start", i, total, rows[i]))
                    running[ex.submit(_prepare_job, rows[i].pdf, spec.cert, spec.out, spec.date_of(rows[i].pdf),
                                      spec.round_no, reference, std_root, stages)] = i
                if should_stop():
                    for i in queue:
                        rows[i].status, rows[i].message = "skipped", "멈춤"
                        emit(Event("done", i, total, rows[i]))
                    queue.clear()
                if not running:
                    break
                done, _ = wait(list(running), timeout=0.3, return_when=FIRST_COMPLETED)
                drain()
                for fut in done:
                    i = running.pop(fut)
                    try:
                        finish(i, fut.result(), None)
                    except Exception as e:  # noqa: BLE001
                        finish(i, None, e)
                        if getattr(rows[i], "retry", False):
                            workers = 1              # 메모리가 모자랐으면 남은 회차는 하나씩
        # 동시 처리 중 메모리가 모자랐던 회차는 다른 회차가 끝난 뒤 한 회차씩 다시(실기기 2026-11-16: 콘크리트기사 2회차 MemoryError)
        for i in group:
            r = rows[i]
            if not getattr(r, "retry", False) or should_stop():
                continue
            r.retry = False
            r.status, r.message, r.stage = "running", "", "다시 처리"
            emit(Event("start", i, total, r))
            try:
                # 새 작업 프로세스 하나에서(끝나면 메모리를 모두 돌려받음) — 창 프로그램 안에서 직접 돌리면
                # 그 프로세스가 쥔 메모리 위에 또 쌓여 다시 모자랐음(실기기 2026-11-18)
                with ProcessPoolExecutor(max_workers=1, mp_context=multiprocessing.get_context("spawn")) as one:
                    p = one.submit(_prepare_job, r.pdf, spec.cert, spec.out, spec.date_of(r.pdf), spec.round_no,
                                   reference, std_root, None).result()
                finish(i, p, None)
            except Exception as e:  # noqa: BLE001
                finish(i, None, e)
                r.retry = False                      # 다시 해도 안 되면 오류로 둠

    # 보충 문서: 같은 묶음의 원본 회차에 빠진 번호만 더하고, 따로 팩은 만들지 않는다(supplement.py)
    from . import supplement
    counts = {s_["count"] for s_ in prof.subjects}
    block = counts.pop() if len(counts) == 1 else None
    for i, r in enumerate(rows):
        if not r.supplement or r.status != "running" or r.prepared is None:
            continue
        mains = [x for x in rows if not x.supplement and x.prepared is not None and x.status == "running"]
        main = next((x for x in mains if x.prepared.pack_id == r.prepared.pack_id), None)
        if main is None:
            # 머리말에 회차가 없으면(HEAD_NOROUND_RE) 그해 원본 회차가 하나뿐일 때 거기에
            year = r.prepared.pack_id.rsplit("-", 2)[-2]
            same_year = [x for x in mains if x.prepared.pack_id.rsplit("-", 2)[-2] == year]
            if len(same_year) == 1:
                main = same_year[0]
        if main is None:
            r.status = "error"
            r.message = f"원본 회차({r.prepared.pack_id}) PDF를 함께 올려 주세요 — 보충 문서는 원본 회차 문제팩에 더합니다"
        else:
            added, skipped = supplement.merge(main.prepared, r.prepared, block)
            r.status = "packed"
            r.questions = len(added)
            r.message = (f"{len(added)}문항을 {main.pdf.name} 문제팩에 더함" + (f" ({', '.join(map(str, added))}번)" if added else "")
                         + ("" if not skipped else " · " + " · ".join(skipped)))
        r.prepared = None
        emit(Event("done", i, total, r))

    ready = [i for i, r in enumerate(rows) if r.status == "running" and r.prepared is not None]
    if ready:                                   # 정답을 믿을 수 없는 문항 → 다른 회차의 같은 문항으로 교차 확인(ADR 024 C)
        for i in ready:
            on_stage(str(rows[i].pdf), "정답 확인")
        from . import crosscheck
        crosscheck.apply([rows[i].prepared for i in ready], spec.out, prof.code)
    for i in ready:
        on_stage(str(rows[i].pdf), "팩")
        try:
            _finish_round(spec, rows[i], rows[i].prepared)
        except Exception as e:  # noqa: BLE001
            rows[i].status, rows[i].message = "error", f"{type(e).__name__}: {e}"
        emit(Event("done", i, total, rows[i]))

    # 처리 보고서(report.html)·검수 파일은 없앰(사용자 2026-11-17 — 경고·의심 문항은 학습앱에서 바로잡는 쪽으로)
    report = None
    bundle = None
    if spec.bundle:
        from .bundle import write_bundle
        # 묶음 = 이 종목의 모든 회차(문제팩 폴더 전체, 사용자 2026-11-16 — 전과 같은 회차를 빼고 묶으니 '2015-2021'처럼
        # 일부만 든 묶음이 생겨 공유 창의 '20회차 2014~2021'과 어긋났다). 같은 종목의 예전 묶음은 지움. 학습앱은 이미 있는 회차를 건너뜀
        made = [r for r in rows if r.status == "packed" and r.zip_path]
        if made:
            import re as _re
            allr = sorted(f for f in rounds_dir(spec.out).glob(f"oneq-{prof.code}-*.zip")
                          if _re.fullmatch(rf"oneq-{prof.code}-\d{{4}}-\d+\.zip", f.name))
            bundle = write_bundle(allr, spec.out, prof.code)      # 같은 종목의 예전 묶음은 write_bundle이 지움
    emit(Event("finish", total=total, report=report, bundle=bundle))
    return rows


def _finish_round(spec: BatchSpec, r: RoundResult, p: Prepared) -> None:
    r.prepared = p
    r.pack_id = p.pack_id
    r.questions = len(p.items)
    r.law = sum("law" in it.flags for it in p.items if not it.excluded)
    r.issues = list(p.issues)
    if p.issues or spec.report_only:
        if p.issues:
            r.status = "review"
            r.message = p.issues[0] if p.issues else "만들지 못함"
        else:
            r.status, r.message = "skipped", "보고서만"
        return
    p.zip_path, m = write_pack(p, spec.out, spec.prepared_by, spec.source_type, spec.origin, spec.pack_version)
    r.zip_path = p.zip_path
    r.size = p.zip_path.stat().st_size
    r.questions = m["questionCount"]
    r.status = "packed"
    from .pack import AUTO_EXCLUDE
    n_auto = sum(1 for it in p.items if it.excluded and it.excluded.startswith(AUTO_EXCLUDE))
    n_flag = sum(1 for it in p.items if not it.excluded and "answer-unsure" in it.flags)
    n_none = sum(1 for it in p.items if not it.excluded and "answer-missing" in it.flags)
    r.no_answer = n_none
    n_cross = sum(1 for it in p.items if not it.excluded and it.answer_source == "cross-check")
    r.message = f"{m['questionCount']}문항" + (f" · 교차 확인 {n_cross}" if n_cross else "") + \
        (f" · 정답 확인 필요 {n_flag}" if n_flag else "") + (f" · 정답 미지정 {n_none}" if n_none else "") + (f" · 뺌 {n_auto}" if n_auto else "") + \
        f" · 정답 표시 {p.masked}개 제거 · {r.size / 1e6:.2f}MB" + \
        (" · 전에 만든 것과 같음" if p.unchanged else (f" · 판 {m['packVersion']}" if m["packVersion"] > spec.pack_version else ""))
