"""처리를 화면과 다른 스레드에서 돌린다(창이 멈추지 않게). 회차 처리 자체는 batch가 여러 프로세스로 나눈다."""
from __future__ import annotations

from PySide6.QtCore import QObject, Signal, Slot

from ..batch import BatchSpec, run_batch


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
