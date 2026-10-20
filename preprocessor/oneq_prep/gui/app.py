"""원큐합격 전처리기 — 창 프로그램 본체(ADR 018).

① 종목·저장 위치·만든 사람 → ② 기출 PDF 넣기(끌어다 놓기) → ③ [팩 만들기](여러 회차 동시 처리, 진행률·멈추기)
→ 결과 표에서 '검수 필요' 회차를 두 번 눌러 검수 → [저장하고 다시 만들기].
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

from PySide6.QtCore import QSettings, QStandardPaths, Qt, QThread, QTimer, QUrl
from PySide6.QtGui import QAction, QColor, QDesktopServices, QIcon
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QComboBox, QFileDialog, QFormLayout, QGroupBox,
                               QHBoxLayout, QHeaderView, QLabel, QLineEdit, QMainWindow, QMessageBox, QProgressBar,
                               QPushButton, QSpinBox, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget)

from .. import __version__
from .. import standards as S
from ..batch import STATUS_TEXT, BatchSpec, RoundResult, default_workers, plan_rounds
from .review_dialog import ReviewDialog
from .worker import BatchWorker

APP_NAME = "원큐합격 전처리기"
SOURCE_TYPES = [("public-pbt", "공개 기출(시행 회차)"), ("recalled", "복원 기출"), ("other", "기타(경향·예상 문제)")]
COLS = ["PDF 파일", "시행일", "팩 이름", "상태", "내용"]
STATUS_COLOR = {"packed": "#1f7a4d", "review": "#9a6700", "error": "#b3261e", "running": "#1f5fd1", "skipped": "#6b6b66"}
DATE_RE = re.compile(r"^20\d{2}-\d{2}-\d{2}$")

STYLE = """
QWidget { font-size: 14px; }
QGroupBox { font-weight: 600; margin-top: 10px; }
QPushButton { padding: 6px 14px; }
QPushButton#primary { background: #1f5fd1; color: white; border: 0; border-radius: 6px; padding: 9px 22px; font-size: 16px; font-weight: 600; }
QPushButton#primary:disabled { background: #9db3e0; }
QLabel#warn { color: #9a6700; }
QLabel#muted, QLabel#hint { color: #6b6b66; }
QLabel#issues { color: #b3261e; }
QFrame#card { background: palette(base); border: 1px solid #d8d6cf; border-radius: 8px; }
QFrame#card[changed="true"] { border: 2px solid #1f5fd1; }
QFrame#card[excluded="true"] { background: #f1f0ec; }
"""


def resource_path(rel: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    return base / rel


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"{APP_NAME} v{__version__}")
        self.resize(1080, 760)
        self.setAcceptDrops(True)
        self.settings = QSettings("OneQ-Ace", "oneq-prep")
        self.pdfs: list[Path] = []
        self.file_dates: dict[Path, str] = {}
        self.rows: list[RoundResult] = []
        self.thread: QThread | None = None
        self.worker: BatchWorker | None = None
        self.started = 0.0
        self.done = 0
        self.report: Path | None = None
        self._building = False

        central = QWidget()
        root = QVBoxLayout(central)

        # ① 종목·저장 위치
        g1 = QGroupBox("① 종목과 저장 위치")
        form = QFormLayout(g1)
        self.cert = QComboBox()
        for code in S.available():
            prof = S.load(code)
            if not prof.draft:
                self.cert.addItem(f"{prof.name} ({code}) — {len(prof.subjects)}과목", code)
        self.out = QLineEdit()
        b_out = QPushButton("바꾸기…")
        b_out.clicked.connect(self.pick_out)
        h = QHBoxLayout()
        h.addWidget(self.out, 1)
        h.addWidget(b_out)
        self.name = QLineEdit()
        self.name.setPlaceholderText("예: 홍길동(철도3부)")
        self.origin = QLineEdit()
        self.origin.setPlaceholderText("예: comcbt.com 교사용")
        self.source_type = QComboBox()
        for v, t in SOURCE_TYPES:
            self.source_type.addItem(t, v)
        self.workers = QSpinBox()
        self.workers.setRange(1, max(1, (QThread.idealThreadCount() or 2)))
        self.workers.setSuffix(" 회차씩 동시에")
        form.addRow("종목(출제기준)", self.cert)
        form.addRow("팩 저장 폴더", h)
        form.addRow("만든 사람", self.name)
        form.addRow("원본 출처", self.origin)
        form.addRow("문제 종류", self.source_type)
        form.addRow("처리 속도", self.workers)
        root.addWidget(g1)

        # ② PDF 목록
        g2 = QGroupBox("② 기출 PDF — 이 창으로 끌어다 놓거나 [PDF 추가]")
        v2 = QVBoxLayout(g2)
        bar = QHBoxLayout()
        for text, fn in (("PDF 추가…", self.add_files), ("폴더 추가…", self.add_folder), ("선택 빼기", self.remove_selected),
                         ("모두 비우기", self.clear_files)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            bar.addWidget(b)
        bar.addStretch(1)
        self.summary = QLabel()
        self.summary.setObjectName("muted")
        bar.addWidget(self.summary)
        v2.addLayout(bar)
        self.table = QTableWidget(0, len(COLS))
        self.table.setHorizontalHeaderLabels(COLS)
        hh = self.table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.Stretch)
        for c in (1, 2, 3):
            hh.setSectionResizeMode(c, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(4, QHeaderView.Stretch)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.verticalHeader().setVisible(False)
        self.table.itemChanged.connect(self.on_item_changed)
        self.table.cellDoubleClicked.connect(self.open_review)
        v2.addWidget(self.table, 1)
        hint = QLabel("시행일은 파일 이름(예: …20220305…)에서 읽습니다. 없으면 시행일 칸을 두 번 눌러 YYYY-MM-DD로 적으세요. "
                      "처리한 뒤 회차를 두 번 누르면 문항을 검수할 수 있습니다.")
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        v2.addWidget(hint)
        root.addWidget(g2, 1)

        # ③ 실행
        g3 = QHBoxLayout()
        self.run_btn = QPushButton("팩 만들기")
        self.run_btn.setObjectName("primary")
        self.run_btn.clicked.connect(lambda: self.start())
        self.stop_btn = QPushButton("멈추기")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self.stop)
        self.progress = QProgressBar()
        self.progress.setTextVisible(True)
        self.status = QLabel("PDF를 넣고 [팩 만들기]를 누르세요.")
        g3.addWidget(self.run_btn)
        g3.addWidget(self.stop_btn)
        g3.addWidget(self.progress, 1)
        root.addLayout(g3)
        root.addWidget(self.status)
        g4 = QHBoxLayout()
        self.open_out_btn = QPushButton("팩 저장 폴더 열기")
        self.open_out_btn.clicked.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(self.out.text())))
        self.open_report_btn = QPushButton("검수 보고서(웹) 열기")
        self.open_report_btn.setEnabled(False)
        self.open_report_btn.clicked.connect(lambda: self.report and QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.report))))
        g4.addWidget(self.open_out_btn)
        g4.addWidget(self.open_report_btn)
        g4.addStretch(1)
        root.addLayout(g4)
        self.setCentralWidget(central)

        help_menu = self.menuBar().addMenu("도움말")
        act = QAction("라이선스·사용한 오픈소스", self)
        act.triggered.connect(self.show_licenses)
        help_menu.addAction(act)
        act2 = QAction(f"{APP_NAME} 정보", self)
        act2.triggered.connect(lambda: QMessageBox.about(self, APP_NAME, f"{APP_NAME} v{__version__}\n기출 PDF → 원큐합격 문제팩(.zip)"))
        help_menu.addAction(act2)

        self.timer = QTimer(self)
        self.timer.setInterval(1000)
        self.timer.timeout.connect(self.tick)
        self.load_settings()
        self.cert.currentIndexChanged.connect(self.refresh_plan)

    # ── 설정 ──
    def load_settings(self) -> None:
        st = self.settings
        docs = QStandardPaths.writableLocation(QStandardPaths.DocumentsLocation)
        self.out.setText(st.value("out", str(Path(docs) / "원큐합격 문제팩")))
        self.name.setText(st.value("name", ""))
        self.origin.setText(st.value("origin", ""))
        i = self.cert.findData(st.value("cert", "SURVEY"))
        self.cert.setCurrentIndex(max(0, i))
        j = self.source_type.findData(st.value("source_type", "public-pbt"))
        self.source_type.setCurrentIndex(max(0, j))
        self.workers.setValue(int(st.value("workers", default_workers())))

    def save_settings(self) -> None:
        st = self.settings
        st.setValue("out", self.out.text())
        st.setValue("name", self.name.text())
        st.setValue("origin", self.origin.text())
        st.setValue("cert", self.cert.currentData())
        st.setValue("source_type", self.source_type.currentData())
        st.setValue("workers", self.workers.value())

    # ── PDF 목록 ──
    def pick_out(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "팩 저장 폴더", self.out.text())
        if d:
            self.out.setText(d)

    def add_paths(self, paths: list[Path]) -> None:
        added = 0
        for p in paths:
            if p.is_dir():
                cand = sorted(p.rglob("*.pdf"))
            else:
                cand = [p] if p.suffix.lower() == ".pdf" else []
            for c in cand:
                c = c.resolve()
                if c not in self.pdfs:
                    self.pdfs.append(c)
                    added += 1
        if added:
            self.refresh_plan()

    def add_files(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(self, "기출 PDF 고르기", self.settings.value("last_dir", ""), "PDF (*.pdf)")
        if files:
            self.settings.setValue("last_dir", str(Path(files[0]).parent))
            self.add_paths([Path(f) for f in files])

    def add_folder(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "기출 PDF 폴더(하위 폴더 포함)", self.settings.value("last_dir", ""))
        if d:
            self.settings.setValue("last_dir", d)
            self.add_paths([Path(d)])

    def remove_selected(self) -> None:
        names = {self.table.item(i.row(), 0).data(Qt.UserRole) for i in self.table.selectionModel().selectedRows()}
        self.pdfs = [p for p in self.pdfs if str(p) not in names]
        self.refresh_plan()

    def clear_files(self) -> None:
        self.pdfs.clear()
        self.file_dates.clear()
        self.refresh_plan()

    def dragEnterEvent(self, e):  # noqa: N802 — Qt 이름
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e):  # noqa: N802
        self.add_paths([Path(u.toLocalFile()) for u in e.mimeData().urls() if u.isLocalFile()])

    def spec(self, pdfs: list[Path] | None = None) -> BatchSpec:
        return BatchSpec(pdfs=list(pdfs if pdfs is not None else self.pdfs), cert=self.cert.currentData(),
                         out=Path(self.out.text()), prepared_by=self.name.text().strip(), origin=self.origin.text().strip(),
                         source_type=self.source_type.currentData(), workers=self.workers.value(),
                         file_dates=dict(self.file_dates), context=list(self.pdfs))

    def refresh_plan(self) -> None:
        if not self.cert.currentData():
            return
        self.rows = plan_rounds(self.spec(), S.load(self.cert.currentData())) if self.pdfs else []
        self.render_rows()

    def render_rows(self) -> None:
        self._building = True
        self.table.setRowCount(len(self.rows))
        dup = {r.pack_id for r in self.rows if r.pack_id and sum(x.pack_id == r.pack_id for x in self.rows) > 1}
        for i, r in enumerate(self.rows):
            name = QTableWidgetItem(r.pdf.name)
            name.setData(Qt.UserRole, str(r.pdf))
            name.setFlags(name.flags() & ~Qt.ItemIsEditable)
            date = QTableWidgetItem(r.date or "")
            needs_date = not re.search(r"20\d{6}", r.pdf.name)
            if not needs_date:
                date.setFlags(date.flags() & ~Qt.ItemIsEditable)
            elif not r.date:
                date.setText("YYYY-MM-DD")
                date.setForeground(QColor("#b3261e"))
            pid = QTableWidgetItem(r.pack_id)
            pid.setFlags(pid.flags() & ~Qt.ItemIsEditable)
            st_text = STATUS_TEXT.get(r.status, r.status)
            if needs_date and not r.date and r.status == "error":
                st_text = "시행일 필요"
            st = QTableWidgetItem(st_text)
            st.setFlags(st.flags() & ~Qt.ItemIsEditable)
            st.setForeground(QColor(STATUS_COLOR.get(r.status, "#1d1d1b")))
            msg = r.message
            if r.pack_id in dup and r.status == "waiting":
                msg = "같은 팩 이름이 둘 이상 — 시행일·파일을 확인하세요"
            if needs_date and not r.date and r.status in ("waiting", "error"):
                msg = "파일 이름에 시행일이 없어요 — 시행일 칸을 두 번 눌러 적으세요"
            m = QTableWidgetItem(msg)
            m.setFlags(m.flags() & ~Qt.ItemIsEditable)
            if r.issues:
                m.setToolTip("\n".join(r.issues[:20]))
            for c, it in enumerate((name, date, pid, st, m)):
                self.table.setItem(i, c, it)
        self._building = False
        n = len(self.rows)
        packed = sum(r.status == "packed" for r in self.rows)
        self.summary.setText(f"PDF {n}개" + (f" · 팩 {packed}개" if packed else ""))

    def on_item_changed(self, item: QTableWidgetItem) -> None:
        if self._building or item.column() != 1:
            return
        p = Path(self.table.item(item.row(), 0).data(Qt.UserRole))
        v = item.text().strip()
        if DATE_RE.match(v):
            self.file_dates[p] = v
        else:
            self.file_dates.pop(p, None)
        QTimer.singleShot(0, self.refresh_plan)

    # ── 실행 ──
    def check_inputs(self, pdfs: list[Path]) -> str | None:
        if not pdfs:
            return "기출 PDF를 먼저 넣으세요."
        if not self.name.text().strip():
            return "만든 사람을 적으세요(팩에 기록되어 앱의 문제팩 정보에 보입니다)."
        if not self.out.text().strip():
            return "팩 저장 폴더를 고르세요."
        bad = [r.pdf.name for r in self.rows if r.pdf in pdfs and r.status == "error" and not r.pack_id]
        if bad:
            return "시행일을 알 수 없는 PDF가 있습니다:\n" + "\n".join(bad[:10])
        ids = [r.pack_id for r in self.rows if r.pdf in pdfs]
        if len(ids) != len(set(ids)):
            return "같은 팩 이름이 둘 이상입니다. 같은 회차 PDF가 두 번 들어갔는지 확인하세요."
        return None

    def start(self, pdfs: list[Path] | None = None) -> None:
        pdfs = list(pdfs) if pdfs else list(self.pdfs)
        msg = self.check_inputs(pdfs)
        if msg:
            QMessageBox.warning(self, APP_NAME, msg)
            return
        self.save_settings()
        spec = self.spec(pdfs)
        for r in self.rows:
            if r.pdf in pdfs:
                r.status, r.message = "waiting", ""
        self.render_rows()
        self.set_running(True)
        self.done = 0
        self.progress.setRange(0, len(pdfs))
        self.progress.setValue(0)
        self.started = time.monotonic()
        self.thread = QThread(self)
        self.worker = BatchWorker(spec)
        self.worker.moveToThread(self.thread)
        self.thread.started.connect(self.worker.run)
        self.worker.event.connect(self.on_event)
        # 람다로 연결하면 작업 스레드에서 실행되어 창을 띄우다 멈춘다 → 화면 객체의 메서드로(대기열 연결)
        self.worker.failed.connect(self.on_failed)
        self.worker.finished.connect(self.on_finished)
        self.worker.finished.connect(self.thread.quit)
        self.thread.finished.connect(self.thread.deleteLater)
        self.timer.start()
        self.tick()
        self.thread.start()

    def stop(self) -> None:
        if self.worker:
            self.worker.stop()
            self.stop_btn.setEnabled(False)
            self.status.setText("지금 처리 중인 회차까지 마치고 멈춥니다…")

    def set_running(self, on: bool) -> None:
        self.run_btn.setEnabled(not on)
        self.stop_btn.setEnabled(on)
        for w in (self.cert, self.out, self.name, self.origin, self.source_type, self.workers):
            w.setEnabled(not on)
        self.setAcceptDrops(not on)

    def tick(self) -> None:
        sec = int(time.monotonic() - self.started)
        total = self.progress.maximum()
        running = sum(r.status == "running" for r in self.rows)
        left = ""
        if self.done:
            est = sec / self.done * (total - self.done)
            left = f" · 남은 시간 약 {int(est // 60)}분 {int(est % 60)}초"
        self.status.setText(f"{self.done} / {total} 회차 끝 · 동시에 {running}개 처리 중 · {sec // 60}분 {sec % 60}초{left}")

    def row_of(self, r: RoundResult) -> int:
        for i, x in enumerate(self.rows):
            if x.pdf == r.pdf:
                return i
        return -1

    def on_event(self, ev) -> None:
        if ev.result is not None:
            i = self.row_of(ev.result)
            if i >= 0:
                self.rows[i] = ev.result
            if ev.kind == "done":
                self.done += 1
                self.progress.setValue(self.done)
            self.render_rows()
        if ev.kind == "finish":
            self.report = ev.report

    def on_failed(self, msg: str) -> None:
        QMessageBox.critical(self, APP_NAME, f"처리를 시작하지 못했습니다.\n\n{msg}")

    def on_finished(self, rows) -> None:
        self.timer.stop()
        self.set_running(False)
        self.worker = None
        self.thread = None
        self.open_report_btn.setEnabled(bool(self.report))
        sec = int(time.monotonic() - self.started)
        ok = sum(r.status == "packed" for r in rows)
        rev = sum(r.status == "review" for r in rows)
        err = sum(r.status == "error" for r in rows)
        skip = sum(r.status == "skipped" for r in rows)
        text = f"끝: 팩 {ok}개 · 검수 필요 {rev}개 · 오류 {err}개" + (f" · 건너뜀 {skip}개" if skip else "") + \
               f" · {sec // 60}분 {sec % 60}초"
        self.status.setText(text + ("  — '검수 필요' 회차를 두 번 눌러 고치세요." if rev else ""))

    def open_review(self, row: int, col: int) -> None:
        if col == 1 or self.worker is not None or row >= len(self.rows):
            return
        r = self.rows[row]
        if r.prepared is None:
            if r.status == "waiting":
                QMessageBox.information(self, APP_NAME, "먼저 [팩 만들기]를 눌러 처리하세요.")
            elif r.message:
                QMessageBox.information(self, APP_NAME, r.message)
            return
        dlg = ReviewDialog(r.prepared, Path(self.out.text()), self)
        if dlg.exec() and dlg.rerun:
            self.start([r.pdf])

    def show_licenses(self) -> None:
        p = resource_path("THIRD-PARTY-NOTICES.txt")
        text = p.read_text(encoding="utf-8") if p.exists() else "THIRD-PARTY-NOTICES.txt를 찾지 못했습니다."
        box = QMessageBox(self)
        box.setWindowTitle("라이선스")
        box.setText(text[:4000])
        box.exec()

    def closeEvent(self, e):  # noqa: N802
        if self.worker is not None:
            if QMessageBox.question(self, APP_NAME, "처리 중입니다. 멈추고 닫을까요?") != QMessageBox.Yes:
                e.ignore()
                return
            self.worker.stop()
            if self.thread:
                self.thread.quit()
                self.thread.wait(30_000)
        self.save_settings()
        e.accept()


def main() -> None:
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setStyleSheet(STYLE)
    icon = resource_path("oneq_prep/gui/icon.png")
    if icon.exists():
        app.setWindowIcon(QIcon(str(icon)))
    w = MainWindow()
    w.show()
    sys.exit(app.exec())
