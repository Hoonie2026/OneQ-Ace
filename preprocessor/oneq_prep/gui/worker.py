"""처리를 화면과 다른 스레드에서 돌린다(창이 멈추지 않게). 회차 처리 자체는 batch가 여러 프로세스로 나눈다."""
from __future__ import annotations

from PySide6.QtCore import QObject, Signal, Slot

from ..batch import BatchSpec, RoundResult, run_batch


class BatchWorker(QObject):
    event = Signal(object)        # batch.Event
    failed = Signal(str)
    finished = Signal(object)     # list[RoundResult]

    def __init__(self, spec: BatchSpec):
        super().__init__()
        self.spec = spec
        self._stop = False

    def stop(self) -> None:
        self._stop = True

    @Slot()
    def run(self) -> None:
        try:
            rows = run_batch(self.spec, self.event.emit, lambda: self._stop)
        except Exception as e:  # noqa: BLE001 — 화면에 알리고 끝냄
            self.failed.emit(f"{type(e).__name__}: {e}")
            rows = []
        self.finished.emit(rows)


class QnetWorker(QObject):
    """큐넷 출제기준 확인·받기(A2·A3) — 화면이 멈추지 않게 다른 스레드에서. fetch=True면 PDF를 받아 프로필 저장, 아니면 목록만."""
    done = Signal(object)         # dict(kind="fetched"|"checked", ...)
    failed = Signal(str)

    def __init__(self, cert_name: str, code: str | None, fetch: bool):
        super().__init__()
        self.cert_name, self.code, self.fetch = cert_name, code, fetch

    @Slot()
    def run(self) -> None:
        from .. import qnet
        try:
            if self.fetch:
                try:
                    got = qnet.fetch_standard(self.cert_name, self.code)
                except qnet.QnetOffline:          # 잠깐 끊김·시간 초과는 한 번 더(실기기 2026-11-12)
                    import time
                    time.sleep(2)
                    got = qnet.fetch_standard(self.cert_name, self.code)
                self.done.emit({"kind": "fetched", "code": got.profile_path.stem, "post": got.post,
                                "upcoming": got.upcoming, "warnings": got.warnings})
            else:
                ch = qnet.check_today(self.cert_name)
                self.done.emit({"kind": "checked", "code": self.code, "post": ch.current, "upcoming": ch.upcoming,
                                "warnings": []})
        except qnet.QnetError as e:
            self.failed.emit(str(e))
        except Exception as e:  # noqa: BLE001 — 출제기준 PDF 모양이 달라 읽지 못한 경우 등
            self.failed.emit(f"큐넷 출제기준을 읽지 못했습니다({type(e).__name__}: {e}). "
                             "보기 창에서 [저장]한 PDF를 끌어다 놓거나 [과목 직접 입력]을 쓰세요.")


class PlanWorker(QObject):
    """목록에 넣은 PDF의 시행일·회차·종류 미리 읽기(회차당 0.3~1초) — 화면이 멈추지 않게 다른 스레드에서
    (실기기 2026-11-16: 20회차를 목록에 넣는 동안 창이 '응답 없음')."""
    done = Signal(object, object)      # (key, {경로: ("standard", None) | ("round", RoundResult)})

    def __init__(self, key, pdfs, prof, spec, check_standard: set):
        super().__init__()
        self.key, self.pdfs, self.prof, self.spec, self.check = key, pdfs, prof, spec, check_standard

    @Slot()
    def run(self) -> None:
        from .. import examinfo
        from ..batch import plan_one
        from ..qnet_standard import looks_like_standard
        out = {}
        try:
            names = examinfo.known_cert_names()
            for p in self.pdfs:
                if p in self.check and looks_like_standard(p):
                    out[p] = ("standard", None)
                else:
                    try:
                        out[p] = ("round", plan_one(p, self.prof, self.spec, names))
                    except Exception as e:  # noqa: BLE001 — 한 파일이 목록 전체를 막지 않게
                        out[p] = ("round", RoundResult(pdf=p, status="error", message=f"{type(e).__name__}: {e}"))
        finally:
            self.done.emit(self.key, out)
