"""원큐합격 전처리기 — 창 프로그램 본체(ADR 018·019).

머리 띠 | 왼쪽: ① 종목(검색) ② 팩 정보 | 오른쪽: ③ 기출 PDF(끌어다 놓기·표) + 과목 개편·법령 안내 | 아래: 실행 띠
"""
from __future__ import annotations

import re
import sys
import time
from pathlib import Path

from PySide6.QtCore import QObject, QSettings, QStandardPaths, Qt, QThread, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QColor, QDesktopServices, QIcon, QPixmap
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QComboBox, QFileDialog, QFrame, QGridLayout,
                               QHBoxLayout, QHeaderView, QLabel, QLineEdit, QMainWindow, QMenu, QMessageBox,
                               QProgressBar, QPushButton, QScrollArea, QStackedWidget, QTableWidget, QTableWidgetItem,
                               QToolButton, QVBoxLayout, QWidget)

from .. import __version__
from .. import standards as S
from ..batch import STATUS_TEXT, BatchSpec, RoundResult, default_workers, plan_rounds
from ..summary import law_summary, peek_subjects, subject_change
from . import theme
from .cert_picker import CertPicker
from .profile_dialog import ProfileDialog
from .review_dialog import ReviewDialog
from .widgets import BadgeDelegate, Card, DropZone, Note, field_label
from .worker import BatchWorker

APP_NAME = "원큐합격 전처리기"
SOURCE_TYPES = [("public-pbt", "공개 기출(시행 회차)"), ("recalled", "복원 기출"), ("other", "기타(경향·예상 문제)")]
SPEEDS = [(2, "보통 — 2회차씩 동시에"), (4, "빠르게 — 4회차씩(메모리 8GB 이상)"), (1, "천천히 — 1회차씩(오래된 PC)")]
COLS = ["PDF 파일", "시행일", "팩 이름", "법령 문항", "상태", "내용"]
C_FILE, C_DATE, C_PACK, C_LAW, C_STATUS, C_MSG = range(6)
DATE_RE = re.compile(r"^20\d{2}-\d{2}-\d{2}$")


def resource_path(rel: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    return base / rel


class PeekWorker(QObject):
    """처리 전 과목 미리 읽기(PDF 1~2개, 회차당 1~4초) — 화면이 멈추지 않게 다른 스레드에서."""
    done = Signal(object, object)    # (key, list[list[str]])

    def __init__(self, key, pdfs: list[Path]):
        super().__init__()
        self.key, self.pdfs = key, pdfs

    @Slot()
    def run(self) -> None:
        self.done.emit(self.key, [peek_subjects(p) for p in self.pdfs])


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"{APP_NAME} v{__version__}")
        self.setMinimumSize(1080, 720)
        self.resize(1320, 880)
        self.setAcceptDrops(True)
        self.settings = QSettings("OneQ-Ace", "oneq-prep")
        self.pdfs: list[Path] = []
        self.file_dates: dict[Path, str] = {}
        self.rows: list[RoundResult] = []
        self.thread: QThread | None = None
        self.worker: BatchWorker | None = None
        self.peek_thread: QThread | None = None
        self.peek_cache: dict[Path, list[str]] = {}
        self.started = 0.0
        self.done = 0
        self.report: Path | None = None
        self._building = False

        page = QWidget()
        page.setObjectName("page")
        root = QVBoxLayout(page)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        root.addWidget(self._header())

        body = QHBoxLayout()
        body.setContentsMargins(24, 20, 24, 16)
        body.setSpacing(16)
        left = QVBoxLayout()
        left.setSpacing(16)
        left.addWidget(self._card_cert())
        left.addWidget(self._card_pack())
        left.addStretch(1)
        lw = QWidget()
        lw.setLayout(left)
        lw.setFixedWidth(364)
        scroll = QScrollArea()
        scroll.setObjectName("side")
        scroll.setWidget(lw)
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(376)
        lw.setObjectName("sideBody")             # 배경만 투명(스타일시트는 이름으로 — 안쪽 카드에 번지지 않게)
        scroll.viewport().setObjectName("sideViewport")
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        body.addWidget(scroll)
        body.addWidget(self._card_pdfs(), 1)
        root.addLayout(body, 1)
        root.addWidget(self._action_bar())
        self.setCentralWidget(page)

        self.timer = QTimer(self)
        self.timer.setInterval(1000)
        self.timer.timeout.connect(self.tick)
        self.peek_timer = QTimer(self)
        self.peek_timer.setSingleShot(True)
        self.peek_timer.setInterval(400)
        self.peek_timer.timeout.connect(self.start_peek)
        self.load_settings()
        self.picker.changed.connect(lambda _c: self.refresh_plan())
        self.picker.want_profile.connect(self.make_profile)

    # ───────────────── 화면 만들기 ─────────────────
    def _header(self) -> QFrame:
        h = QFrame()
        h.setObjectName("header")
        lay = QHBoxLayout(h)
        lay.setContentsMargins(24, 14, 24, 14)
        lay.setSpacing(14)
        logo = QLabel()
        pm = QPixmap(str(resource_path("oneq_prep/gui/icon.png")))
        if not pm.isNull():
            logo.setPixmap(pm.scaled(44, 44, Qt.KeepAspectRatio, Qt.SmoothTransformation))
        lay.addWidget(logo)
        tv = QVBoxLayout()
        tv.setSpacing(2)
        t = QLabel(APP_NAME)
        t.setObjectName("appTitle")
        s = QLabel("기출 PDF를 원큐합격 문제팩으로 — 현행 출제기준에 맞춰 과목을 정리합니다")
        s.setObjectName("appSub")
        tv.addWidget(t)
        tv.addWidget(s)
        lay.addLayout(tv)
        lay.addStretch(1)
        v = QLabel(f"v{__version__}")
        v.setObjectName("versionChip")
        lay.addWidget(v)
        help_btn = QToolButton()
        help_btn.setText("도움말 ▾")
        help_btn.setPopupMode(QToolButton.InstantPopup)
        help_btn.setStyleSheet("QToolButton{border:0;padding:6px 10px;font-weight:600;}"
                               "QToolButton::menu-indicator{image:none;}")
        m = QMenu(help_btn)
        m.addAction("사용 안내", lambda: QMessageBox.information(self, APP_NAME, (
            "① 종목을 찾아 고릅니다(예: 측량, 건안기).\n② 만든 사람·저장 폴더를 확인합니다.\n"
            "③ 기출 PDF를 끌어다 놓고 [팩 만들기].\n\n'검수 필요' 회차는 두 번 눌러 고치고 [저장하고 다시 만들기].\n"
            "만든 팩(oneq-…zip)을 휴대폰으로 옮겨 원큐합격 앱에서 가져옵니다.")))
        m.addAction("라이선스·사용한 오픈소스", self.show_licenses)
        m.addAction(f"{APP_NAME} 정보", lambda: QMessageBox.about(
            self, APP_NAME, f"{APP_NAME} v{__version__}\n기출 PDF → 원큐합격 문제팩(.zip)"))
        help_btn.setMenu(m)
        lay.addWidget(help_btn)
        return h

    def _card_cert(self) -> Card:
        c = Card("종목", "1")
        self.picker = CertPicker()
        c.body.addWidget(self.picker)
        return c

    def _card_pack(self) -> Card:
        c = Card("팩 정보", "2")
        g = QGridLayout()
        g.setHorizontalSpacing(10)
        g.setVerticalSpacing(4)
        self.name = QLineEdit()
        self.name.setPlaceholderText("예: 홍길동(철도3부)")
        self.out = QLineEdit()
        b_out = QPushButton("바꾸기")
        b_out.clicked.connect(self.pick_out)
        self.origin = QLineEdit()
        self.origin.setPlaceholderText("예: comcbt.com 교사용")
        self.source_type = QComboBox()
        for v, t in SOURCE_TYPES:
            self.source_type.addItem(t, v)
        self.speed = QComboBox()
        for v, t in SPEEDS:
            self.speed.addItem(t, v)
        r = 0
        for label, w, extra in (("만든 사람 — 앱의 문제팩 정보에 보입니다", self.name, None),
                                ("팩 저장 폴더", self.out, b_out), ("원본 출처", self.origin, None),
                                ("문제 종류", self.source_type, None), ("처리 속도", self.speed, None)):
            g.addWidget(field_label(label), r, 0, 1, 2)
            if extra:
                g.addWidget(w, r + 1, 0)
                g.addWidget(extra, r + 1, 1)
            else:
                g.addWidget(w, r + 1, 0, 1, 2)
            g.setRowMinimumHeight(r + 2, 2)
            r += 3
        g.setColumnStretch(0, 1)
        c.body.addLayout(g)
        return c

    def _card_pdfs(self) -> Card:
        c = Card("기출 PDF", "3")
        self.summary = QLabel()
        self.summary.setObjectName("muted")
        c.head.addWidget(self.summary)
        bar = QHBoxLayout()
        bar.setSpacing(8)
        for text, fn in (("PDF 추가", self.add_files), ("폴더 추가", self.add_folder), ("선택 빼기", self.remove_selected),
                         ("모두 비우기", self.clear_files)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            bar.addWidget(b)
        bar.addStretch(1)
        c.body.addLayout(bar)

        self.stack = QStackedWidget()
        self.drop = DropZone()
        self.drop.clicked.connect(self.add_files)
        self.table = QTableWidget(0, len(COLS))
        self.table.setHorizontalHeaderLabels(COLS)
        self.table.setAlternatingRowColors(True)
        self.table.setShowGrid(False)
        self.table.setWordWrap(False)
        self.table.setTextElideMode(Qt.ElideMiddle)
        self.table.verticalHeader().setVisible(False)
        self.table.verticalHeader().setDefaultSectionSize(40)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setItemDelegateForColumn(C_STATUS, BadgeDelegate(self.table))
        hh = self.table.horizontalHeader()
        hh.setHighlightSections(False)
        hh.setMinimumSectionSize(56)
        hh.setSectionResizeMode(C_FILE, QHeaderView.Stretch)
        for col, w in ((C_DATE, 104), (C_PACK, 140), (C_LAW, 76), (C_STATUS, 104), (C_MSG, 170)):
            hh.setSectionResizeMode(col, QHeaderView.Interactive)
            self.table.setColumnWidth(col, w)
        self.table.itemChanged.connect(self.on_item_changed)
        self.table.cellDoubleClicked.connect(self.open_review)
        self.stack.addWidget(self.drop)
        self.stack.addWidget(self.table)
        c.body.addWidget(self.stack, 1)

        self.change_note = Note("info")
        self.change_note.setVisible(False)
        self.law_note = Note("warn")
        self.law_note.setVisible(False)
        c.body.addWidget(self.change_note)
        c.body.addWidget(self.law_note)
        hint = QLabel("처리한 뒤 회차를 두 번 누르면 문항을 검수할 수 있습니다. 파일 이름에 시행일이 없으면 시행일 칸을 두 번 눌러 YYYY-MM-DD로 적으세요.")
        hint.setObjectName("hint")
        hint.setWordWrap(True)
        c.body.addWidget(hint)
        return c

    def _action_bar(self) -> QFrame:
        f = QFrame()
        f.setObjectName("actionBar")
        lay = QHBoxLayout(f)
        lay.setContentsMargins(24, 14, 24, 14)
        lay.setSpacing(14)
        self.run_btn = QPushButton("팩 만들기")
        self.run_btn.setObjectName("primary")
        self.run_btn.setMinimumWidth(160)
        self.run_btn.clicked.connect(lambda: self.start())
        self.stop_btn = QPushButton("멈추기")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self.stop)
        mid = QVBoxLayout()
        mid.setSpacing(6)
        self.status = QLabel("종목을 고르고 기출 PDF를 넣은 뒤 [팩 만들기]를 누르세요.")
        self.status.setObjectName("status")
        self.progress = QProgressBar()
        self.progress.setValue(0)
        mid.addWidget(self.status)
        mid.addWidget(self.progress)
        self.open_out_btn = QPushButton("팩 폴더 열기")
        self.open_out_btn.clicked.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(self.out.text())))
        self.open_report_btn = QPushButton("검수 보고서(웹)")
        self.open_report_btn.setEnabled(False)
        self.open_report_btn.clicked.connect(lambda: self.report and QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.report))))
        lay.addWidget(self.run_btn)
        lay.addWidget(self.stop_btn)
        lay.addLayout(mid, 1)
        lay.addWidget(self.open_out_btn)
        lay.addWidget(self.open_report_btn)
        return f

    # ───────────────── 설정 ─────────────────
    def load_settings(self) -> None:
        st = self.settings
        docs = QStandardPaths.writableLocation(QStandardPaths.DocumentsLocation)
        self.out.setText(st.value("out", str(Path(docs) / "원큐합격 문제팩")))
        self.name.setText(st.value("name", ""))
        self.origin.setText(st.value("origin", ""))
        self.picker.select_code(st.value("cert", "SURVEY"))
        j = self.source_type.findData(st.value("source_type", "public-pbt"))
        self.source_type.setCurrentIndex(max(0, j))
        k = self.speed.findData(int(st.value("workers", min(2, default_workers()))))
        self.speed.setCurrentIndex(max(0, k))

    def save_settings(self) -> None:
        st = self.settings
        st.setValue("out", self.out.text())
        st.setValue("name", self.name.text())
        st.setValue("origin", self.origin.text())
        if self.picker.code:
            st.setValue("cert", self.picker.code)
        st.setValue("source_type", self.source_type.currentData())
        st.setValue("workers", self.speed.currentData())

    def set_cert(self, code: str) -> bool:
        return self.picker.select_code(code)

    def make_profile(self, cert) -> None:
        dlg = ProfileDialog(cert, self)
        if dlg.exec() and dlg.code:
            self.picker.reload()
            self.picker.select_code(dlg.code)

    # ───────────────── PDF 목록 ─────────────────
    def pick_out(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "팩 저장 폴더", self.out.text())
        if d:
            self.out.setText(d)

    def add_paths(self, paths: list[Path]) -> None:
        added = 0
        for p in paths:
            cand = sorted(p.rglob("*.pdf")) if p.is_dir() else ([p] if p.suffix.lower() == ".pdf" else [])
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
        names = {self.table.item(i.row(), C_FILE).data(Qt.UserRole) for i in self.table.selectionModel().selectedRows()}
        self.pdfs = [p for p in self.pdfs if str(p) not in names]
        self.refresh_plan()

    def clear_files(self) -> None:
        self.pdfs.clear()
        self.file_dates.clear()
        self.refresh_plan()

    def dragEnterEvent(self, e):  # noqa: N802 — Qt 이름
        if e.mimeData().hasUrls():
            e.acceptProposedAction()
            self.drop.set_active(True)

    def dragLeaveEvent(self, e):  # noqa: N802
        self.drop.set_active(False)

    def dropEvent(self, e):  # noqa: N802
        self.drop.set_active(False)
        self.add_paths([Path(u.toLocalFile()) for u in e.mimeData().urls() if u.isLocalFile()])

    def spec(self, pdfs: list[Path] | None = None) -> BatchSpec:
        return BatchSpec(pdfs=list(pdfs if pdfs is not None else self.pdfs), cert=self.picker.code or "",
                         out=Path(self.out.text()), prepared_by=self.name.text().strip(), origin=self.origin.text().strip(),
                         source_type=self.source_type.currentData(), workers=self.speed.currentData(),
                         file_dates=dict(self.file_dates), context=list(self.pdfs))

    def refresh_plan(self) -> None:
        code = self.picker.code
        if code and self.pdfs:
            self.rows = plan_rounds(self.spec(), S.load(code))
        elif self.pdfs:
            self.rows = [RoundResult(pdf=p, message="종목을 먼저 고르세요") for p in sorted(self.pdfs, key=lambda x: x.name)]
        else:
            self.rows = []
        self.render_rows()
        self.law_note.setVisible(False)
        self.peek_timer.start()

    def render_rows(self) -> None:
        self._building = True
        self.stack.setCurrentIndex(1 if self.rows else 0)
        self.table.setRowCount(len(self.rows))
        dup = {r.pack_id for r in self.rows if r.pack_id and sum(x.pack_id == r.pack_id for x in self.rows) > 1}
        for i, r in enumerate(self.rows):
            # 시행일은 문서 내용에서 읽고, 못 찾으면 "0000년 nn회"로 자동(ADR 021 2절) — 사람에게 묻지 않음
            needs_date = r.date.startswith("0000") or r.date.endswith("-00")   # 칸을 고칠 수는 있게
            key = r.status
            st_text = STATUS_TEXT.get(r.status, r.status)
            msg = r.message
            if r.date.startswith("0000") and r.status == "waiting":
                msg = "시행일을 문서에서 못 찾음 → 0000년 회차로 지정(시행일 칸을 두 번 눌러 바꿀 수 있음)"
            elif r.pack_id in dup and r.status == "waiting":
                msg = "같은 팩 이름이 둘 이상 — 같은 회차 PDF가 두 번 들어갔는지 확인하세요"
            if r.status == "packed":
                msg = f"{r.questions}문항 · {r.size / 1e6:.1f}MB"
            cells = [r.pdf.name, ("시행일 모름" if needs_date else r.date), r.pack_id,
                     f"{r.law}" if r.law else "", st_text, msg]
            for c, text in enumerate(cells):
                it = QTableWidgetItem(text)
                if not (c == C_DATE and needs_date):
                    it.setFlags(it.flags() & ~Qt.ItemIsEditable)
                if c == C_LAW:
                    it.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                self.table.setItem(i, c, it)
            self.table.item(i, C_FILE).setData(Qt.UserRole, str(r.pdf))
            self.table.item(i, C_FILE).setToolTip(str(r.pdf))
            self.table.item(i, C_STATUS).setData(Qt.UserRole, key)
            if r.issues:
                self.table.item(i, C_MSG).setToolTip("\n".join(r.issues[:20]))
            elif r.status == "packed":
                self.table.item(i, C_MSG).setToolTip(r.message)
            elif msg:
                self.table.item(i, C_MSG).setToolTip(msg)
            if needs_date:
                self.table.item(i, C_DATE).setForeground(QColor(theme.BAD))
        self._building = False
        n = len(self.rows)
        packed = sum(r.status == "packed" for r in self.rows)
        self.summary.setText(f"PDF {n}개" + (f" · 팩 {packed}개" if packed else "") if n else "")

    def on_item_changed(self, item: QTableWidgetItem) -> None:
        if self._building or item.column() != C_DATE:
            return
        p = Path(self.table.item(item.row(), C_FILE).data(Qt.UserRole))
        v = item.text().strip()
        if DATE_RE.match(v):
            self.file_dates[p] = v
        else:
            self.file_dates.pop(p, None)
        QTimer.singleShot(0, self.refresh_plan)

    # ── 과목 개편 미리 보기(처리 전) ──
    def start_peek(self) -> None:
        code = self.picker.code
        if not code or not self.pdfs or self.peek_thread is not None:
            if not self.pdfs or not code:
                self.change_note.setVisible(False)
            return
        dated = sorted((r for r in self.rows if r.date), key=lambda r: r.date)
        sample = [dated[0].pdf, dated[-1].pdf] if len(dated) > 1 else [r.pdf for r in self.rows[:1]]
        sample = list(dict.fromkeys(sample))
        todo = [p for p in sample if p not in self.peek_cache]
        if not todo:
            self.show_change(code, sample)
            return
        self.change_note.set("info", "과목 구성을 확인하는 중…", [])
        self.peek_thread = QThread(self)
        w = PeekWorker((code, tuple(sample)), todo)
        w.moveToThread(self.peek_thread)
        self.peek_thread.started.connect(w.run)
        w.done.connect(self.on_peek)
        w.done.connect(self.peek_thread.quit)
        self.peek_thread.finished.connect(self._peek_finished)
        self._peek_worker = w
        self.peek_thread.start()

    def _peek_finished(self) -> None:
        self.peek_thread.deleteLater()
        self.peek_thread = None

    def on_peek(self, key, lists) -> None:
        code, sample = key
        todo = [p for p in sample if p not in self.peek_cache]
        for p, lst in zip(todo, lists):
            self.peek_cache[p] = lst
        if code == self.picker.code:
            self.show_change(code, list(sample))

    def show_change(self, code: str, sample: list[Path]) -> None:
        lists = [self.peek_cache.get(p, []) for p in sample]
        if not any(lists):
            self.change_note.setVisible(False)
            return
        cs = subject_change(S.load(code), lists, [r.date for r in self.rows])
        kind = "warn" if (cs.unknown or cs.legacy_rounds) else ("info" if cs.changed else "ok")
        title = "과목 개편 — 현행 출제기준으로 정리해 팩을 만듭니다" if cs.changed else "과목 구성 확인"
        self.change_note.set(kind, title, cs.lines())

    # ───────────────── 실행 ─────────────────
    def check_inputs(self, pdfs: list[Path]) -> str | None:
        if not self.picker.code:
            return "종목을 먼저 고르세요(출제기준이 없으면 [과목 직접 입력])."
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
        for w in (self.picker, self.out, self.name, self.origin, self.source_type, self.speed):
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
        text = f"끝 — 팩 {ok}개 · 검수 필요 {rev}개 · 오류 {err}개" + (f" · 건너뜀 {skip}개" if skip else "") + \
               f" · {sec // 60}분 {sec % 60}초"
        self.status.setText(text + ("  — '검수 필요' 회차를 두 번 눌러 고치세요" if rev else ""))
        lines = law_summary(self.rows)
        if lines:
            self.law_note.set("warn", "법령·기준 개정 주의", lines)
        else:
            self.law_note.setVisible(False)

    def open_review(self, row: int, col: int) -> None:
        if col == C_DATE or self.worker is not None or row >= len(self.rows):
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
        if self.peek_thread:
            self.peek_thread.quit()
            self.peek_thread.wait(10_000)
        self.save_settings()
        e.accept()


def main() -> None:
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    theme.apply(app)
    icon = resource_path("oneq_prep/gui/icon.png")
    if icon.exists():
        app.setWindowIcon(QIcon(str(icon)))
    w = MainWindow()
    w.show()
    sys.exit(app.exec())
