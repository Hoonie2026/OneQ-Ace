"""원큐합격 전처리기 — 창 프로그램 본체(ADR 018·019, v0.5 처리 화면 ADR 021 6절).

머리 띠 | 왼쪽: ① 종목(검색·출제기준) + 올리는 PDF 조건 셋 | 오른쪽: ② 기출 PDF(한 목록 · 글자/스캔 · 파일별 진행 막대)
| 아래: 실행 띠. 입력 칸 없음(만든 사람·출처·문제 종류·처리 속도 자동, 저장 폴더는 기본 폴더 — 도움말 메뉴에서 바꿈).
끝난 파일을 누르면 결과 화면(과목별 문항·정답·유형·단원·미리 보기, 의심 문항 [확인하기]).
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

from PySide6.QtCore import QObject, QSettings, QStandardPaths, Qt, QThread, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QColor, QDesktopServices, QIcon, QPixmap
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QFileDialog, QFrame,
                               QHBoxLayout, QHeaderView, QLabel, QMainWindow, QMenu, QMessageBox,
                               QProgressBar, QPushButton, QScrollArea, QStackedWidget, QTableWidget, QTableWidgetItem,
                               QToolButton, QVBoxLayout, QWidget)

from .. import __version__
from .. import standards as S
from ..batch import STATUS_TEXT, BatchSpec, RoundResult, plan_rounds
from ..summary import law_summary, peek_subjects, subject_change
from . import theme
from .cert_picker import CertPicker
from .profile_dialog import ProfileDialog
from .result_dialog import ResultDialog
from .review_dialog import ReviewDialog
from .widgets import BadgeDelegate, Card, DropZone, Note, ProgressDelegate
from .worker import BatchWorker, ComcbtWorker, QnetWorker

APP_NAME = "원큐합격 전처리기"
COLS = ["PDF 파일", "종류", "회차", "진행", "상태", "결과"]
C_FILE, C_KIND, C_ROUND, C_PROG, C_STATUS, C_MSG = range(6)
C_DATE = C_ROUND          # v0.4 이름(시험 호환)
DATE_RE = re.compile(r"^(19|20)\d{2}-\d{2}-\d{2}$")
STAGES = ["읽기", "문항 나누기", "정답", "분류", "팩"]     # ADR 021 6절 — 파일별 진행 막대의 단계
CONDITIONS = [("한 파일 = 한 회차", "여러 회차를 한 파일에 합친 PDF는 회차별로 나눠 주세요"),
              ("정답이 파일 안에", "보기에 정답 표시(칠한 번호·형광펜) 또는 끝에 정답표"),
              ("알아볼 수 있는 품질", "사진보다 스캔, 심하게 기울지 않게 — 글자 PDF면 가장 좋아요")]


def round_text(r: RoundResult) -> str:
    """'2022년 2회 · 04-24' / '2024년 3회 · 시행일 모름' / '0000년 1회'."""
    m = re.match(r"^[A-Z0-9]+-(\d{4})-(\d+)$", r.pack_id or "")
    if not m:
        return ""
    y, n = m.groups()
    if y == "0000":
        return f"0000년 {n}회 · 날짜 모름"
    tail = "날짜 모름" if r.date.endswith("-00") else r.date[5:]
    return f"{y}년 {n}회 · {tail}"


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
        self.qnet_thread: QThread | None = None
        self.comcbt_thread: QThread | None = None
        self.worker: BatchWorker | None = None
        self.peek_thread: QThread | None = None
        self.peek_cache: dict[Path, list[str]] = {}
        self.started = 0.0
        self.done = 0
        self.report: Path | None = None
        self.bundle: Path | None = None
        self.out_dir = Path(".")
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
        left.addWidget(self._card_conditions())
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
        self.update_ready()
        self.picker.changed.connect(lambda _c: self.refresh_plan())
        self.picker.want_profile.connect(self.make_profile)
        self.picker.want_qnet.connect(self.qnet_check)
        self.picker.want_upload.connect(self.pick_standard_pdf)
        self.picker.changed.connect(lambda _c: self.update_ready())
        self.qnet_thread: QThread | None = None

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
        s = QLabel("기출 PDF를 원큐합격 문제팩으로 — 현행 출제기준으로 과목·단원·유형을 정리합니다")
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
            "① 종목을 찾아 고릅니다(예: 측량, 건안기).\n② 기출 PDF를 끌어다 놓고 [팩 만들기].\n"
            "③ 끝난 파일을 누르면 결과 화면 — 의심 문항이 있으면 [확인하기].\n\n"
            "끝나면 종목 묶음(oneq-종목-bundle-….zip) 하나가 저장 폴더에 생깁니다.\n"
            "그 파일을 휴대폰·PC의 원큐합격 앱에서 [문제팩 가져오기]로 넣으세요(기기마다 따로).")))
        m.addSeparator()
        m.addAction("저장 폴더 바꾸기…", self.pick_out)
        speed = m.addMenu("처리 속도")
        for v, t in ((0, "자동(코어 수 − 1, 최대 4)"), (1, "천천히 — 1회차씩(오래된 PC)")):
            speed.addAction(t, lambda v=v: self.settings.setValue("workers", v))
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

    def _card_conditions(self) -> Card:
        """올리는 기출 PDF 조건 셋(ADR 021 3절) — 넣으면 바로 [글자]/[스캔]과 회차를 보여 줌."""
        c = Card("올리는 기출 PDF", "", "어디서 구했든 괜찮아요. 아래 셋만 맞으면 됩니다.")
        for i, (t, h) in enumerate(CONDITIONS, 1):
            row = QHBoxLayout()
            row.setSpacing(10)
            n = QLabel(str(i))
            n.setObjectName("cardStep")
            row.addWidget(n, 0, Qt.AlignTop)
            v = QVBoxLayout()
            v.setSpacing(0)
            tl = QLabel(t)
            tl.setStyleSheet("font-weight:600")
            hl = QLabel(h)
            hl.setObjectName("muted")
            hl.setWordWrap(True)
            v.addWidget(tl)
            v.addWidget(hl)
            row.addLayout(v, 1)
            c.body.addLayout(row)
        tip = QLabel("한글(HWP)·워드 파일은 그 프로그램에서 PDF로 저장해 넣으세요.")
        tip.setObjectName("hint")
        tip.setWordWrap(True)
        c.body.addWidget(tip)
        return c

    def _card_pdfs(self) -> Card:
        c = Card("기출 PDF", "2")
        self.summary = QLabel()
        self.summary.setObjectName("muted")
        c.head.addWidget(self.summary)
        bar = QHBoxLayout()
        bar.setSpacing(8)
        self.pdf_buttons = []
        for text, fn in (("PDF 추가", self.add_files), ("폴더 추가", self.add_folder), ("선택 빼기", self.remove_selected),
                         ("모두 비우기", self.clear_files)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            bar.addWidget(b)
            self.pdf_buttons.append(b)
        bar.addStretch(1)
        # comcbt 게시판 첫 쪽의 최근 기출 받기(사용자 결정 2026-10-24 — 이전·최신 회차는 직접 올림)
        self.comcbt_btn = QPushButton("comcbt 최근 기출 받기")
        self.comcbt_btn.setObjectName("primarySmall")
        self.comcbt_btn.setToolTip("comcbt.com 종목 게시판 첫 쪽의 최근 기출(정답 표시된 교사용 PDF)을 받아 목록에 넣습니다")
        self.comcbt_btn.clicked.connect(self.comcbt_fetch)
        bar.addWidget(self.comcbt_btn)
        self.pdf_buttons.append(self.comcbt_btn)
        c.body.addLayout(bar)

        self.stack = QStackedWidget()
        self.drop = DropZone()
        self.drop.clicked.connect(lambda: self.drop.isEnabled() and self.add_files())
        self.drop_hint = self.drop.title
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
        self.table.setItemDelegateForColumn(C_KIND, BadgeDelegate(self.table))
        self.table.setItemDelegateForColumn(C_PROG, ProgressDelegate(self.table))
        hh = self.table.horizontalHeader()
        hh.setHighlightSections(False)
        hh.setMinimumSectionSize(56)
        hh.setSectionResizeMode(C_FILE, QHeaderView.Stretch)
        for col, w in ((C_KIND, 64), (C_ROUND, 176), (C_PROG, 130), (C_STATUS, 92), (C_MSG, 200)):
            hh.setSectionResizeMode(col, QHeaderView.Interactive)
            self.table.setColumnWidth(col, w)
        self.table.itemChanged.connect(self.on_item_changed)
        self.table.cellClicked.connect(self.open_result)
        self.stack.addWidget(self.drop)
        self.stack.addWidget(self.table)
        c.body.addWidget(self.stack, 1)

        self.change_note = Note("info")
        self.change_note.setVisible(False)
        self.law_note = Note("warn")
        self.law_note.setVisible(False)
        self.bundle_note = Note("ok")
        self.bundle_note.setVisible(False)
        self.comcbt_note = Note("info")
        self.comcbt_note.setVisible(False)
        c.body.addWidget(self.comcbt_note)
        c.body.addWidget(self.bundle_note)
        c.body.addWidget(self.change_note)
        c.body.addWidget(self.law_note)
        hint = QLabel("종목·시행일·회차·출처는 문서 내용에서 읽습니다. 끝난 파일을 누르면 결과 화면이 열립니다.")
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
        self.open_out_btn.clicked.connect(self.open_out)
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
        self.out_dir = Path(st.value("out", str(Path(docs) / "원큐합격 문제팩")))
        self.picker.select_code(st.value("cert", "SURVEY"))

    def save_settings(self) -> None:
        st = self.settings
        st.setValue("out", str(self.out_dir))
        if self.picker.code:
            st.setValue("cert", self.picker.code)

    def open_out(self) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.out_dir)))

    def set_cert(self, code: str) -> bool:
        return self.picker.select_code(code)

    # ── Q-Net 출제기준(A2·A3) — 종목명 입력 → [조회] → 받기, 못 받으면 올리기 상자(사용자 흐름 2026-10-24) ──
    def qnet_check(self, cert) -> None:
        """[조회]: 매번 Q-Net 목록에서 현행 출제기준을 확인하고, 가진 것과 다른 게시물이면 PDF를 받아 프로필로."""
        if self.qnet_thread is not None:
            return
        if os.environ.get("ONEQ_NO_NETWORK"):            # 시험·오프라인 모드: 묻지 않고 실패 안내와 올리기 상자
            self.picker.show_failed("Q-Net 조회를 끈 상태입니다. Q-Net에서 출제기준을 직접 내려받아 아래 상자에 올려 주세요.")
            return
        self.picker.set_busy(True)
        self.update_ready()
        self.qnet_thread = QThread(self)
        w = QnetWorker(cert.name, cert.profile, True)
        w.moveToThread(self.qnet_thread)
        self.qnet_thread.started.connect(w.run)
        w.done.connect(self.on_qnet)
        w.failed.connect(self.on_qnet_failed)
        w.done.connect(self.qnet_thread.quit)
        w.failed.connect(self.qnet_thread.quit)
        self.qnet_thread.finished.connect(self._qnet_finished)
        self._qnet_worker = w
        self.qnet_thread.start()

    def _qnet_finished(self) -> None:
        self.qnet_thread.deleteLater()
        self.qnet_thread = None

    def _use_profile(self, code: str) -> None:
        self.picker.reload()
        self.picker.blockSignals(True)
        self.picker.select_code(code)
        self.picker.blockSignals(False)
        self.refresh_plan()
        self.update_ready()

    def on_qnet(self, r: dict) -> None:
        post, up = r.get("post"), r.get("upcoming")
        lines = [f"다음 기준도 게시돼 있어요: {up.title} — 그날부터 과목·단원이 바뀔 수 있어요"] if up else []
        lines += [f"읽다가 확인할 것: {w}" for w in r.get("warnings", [])[:3]]
        self._use_profile(r["code"])
        title = (f"Q-Net 최신 출제기준과 같아요 — {post.title}" if r.get("same")
                 else f"Q-Net에서 최신 출제기준을 받았어요 — {post.title}")
        self.picker.set_qnet("ok" if not up else "info", title, lines)

    def on_qnet_failed(self, msg: str) -> None:
        self.picker.show_failed(msg)
        self.update_ready()

    # ── comcbt 첫 쪽 기출 받기 ──
    def comcbt_dir(self) -> Path:
        name = self.picker.current.name if self.picker.current else "기출"
        return self.out_dir / "기출 PDF" / re.sub(r'[\\/:*?"<>|]+', "_", name)

    def comcbt_fetch(self) -> None:
        if self.comcbt_thread is not None or not self.picker.current:
            return
        from .. import comcbt
        dest = self.comcbt_dir()
        have = {r.date for r in self.rows if r.date}
        if dest.exists():          # 전에 받아 둔 파일(이름의 시행일 8자리)은 다시 받지 않음
            have |= {f"{m[0:4]}-{m[4:6]}-{m[6:8]}" for f in dest.glob("*.pdf") if (m := (re.findall(r"(\d{8})", f.name) or [""])[0])}
        self.comcbt_note.set("info", "comcbt.com에서 최근 기출을 받는 중…", comcbt.guide(None, self.picker.current.name))
        self.comcbt_thread = QThread(self)
        w = ComcbtWorker(self.picker.current.name, dest, have)
        w.moveToThread(self.comcbt_thread)
        self.comcbt_thread.started.connect(w.run)
        w.progress.connect(self.on_comcbt_progress)
        w.done.connect(self.on_comcbt_done)
        w.failed.connect(self.on_comcbt_failed)
        w.done.connect(self.comcbt_thread.quit)
        w.failed.connect(self.comcbt_thread.quit)
        self.comcbt_thread.finished.connect(self._comcbt_finished)
        self._comcbt_worker = w
        self.comcbt_thread.start()
        self.update_ready()

    def _comcbt_finished(self) -> None:
        self.comcbt_thread.deleteLater()
        self.comcbt_thread = None
        self.update_ready()

    def on_comcbt_progress(self, i: int, n: int, title: str) -> None:
        self.comcbt_note.title.setText(f"comcbt.com에서 최근 기출을 받는 중… ({i}/{n}) {title}")

    def on_comcbt_done(self, res) -> None:
        from .. import comcbt
        if res.saved:
            self.add_paths(res.saved)
        head = f"comcbt.com에서 {len(res.saved)}회차를 받아 목록에 넣었어요" if res.saved else "새로 받을 회차가 없어요"
        lines = comcbt.guide(res, self.picker.current.name if self.picker.current else "")
        if res.skipped:
            lines.insert(0, f"이미 목록·폴더에 있는 {len(res.skipped)}회차는 건너뜀")
        lines += [f"받지 못함: {x}" for x in res.failed[:3]]
        self.comcbt_note.set("ok" if res.saved and not res.failed else "info", head, lines)

    def on_comcbt_failed(self, msg: str) -> None:
        from .. import comcbt
        self.comcbt_note.set("warn", "comcbt.com에서 기출을 받지 못했어요", [msg] + comcbt.guide(None, ""))

    def pick_standard_pdf(self) -> None:
        f, _ = QFileDialog.getOpenFileName(self, "출제기준 PDF 고르기", self.settings.value("last_dir", ""), "PDF (*.pdf)")
        if f:
            self.import_standard_pdf(Path(f))

    def import_standard_pdf(self, pdf: Path) -> None:
        """올리기 상자·끌어다 놓기로 들어온 출제기준 PDF(Q-Net 보기 창 [저장]) → 종목 출제기준(ADR 021 1절)."""
        from .. import qnet
        from ..certs import Cert
        from ..qnet_standard import StandardPdfError, parse
        try:
            doc = parse(pdf)
        except StandardPdfError as e:
            self.picker.show_failed(f"이 PDF에서 출제기준 표를 읽지 못했습니다 — {e}")
            return
        key = re.sub(r"\s+", "", doc.cert_name)
        cert = self.picker.current if self.picker.current and re.sub(r"\s+", "", self.picker.current.name) == key else \
            next((c for c in self.picker.certs if re.sub(r"\s+", "", c.name) == key), None) or Cert(doc.cert_name)
        code = cert.profile or qnet.code_for(cert.name, cert.jm_code or None)
        path, warns = qnet.save_profile_from_pdf(pdf, code, pdf.name, {"uploaded": True})
        self._use_profile(path.stem)
        self.picker.fail.setVisible(False)
        self.picker.set_qnet("ok", f"출제기준 PDF를 읽었어요 — {doc.cert_name} {doc.period_from} ~ {doc.period_to}",
                             [f"읽다가 확인할 것: {w}" for w in warns[:3]])

    def update_ready(self) -> None:
        """② 기출 PDF는 출제기준이 정해진 뒤에(ADR 021 — 과목·단원이 출제기준에서 오므로)."""
        ready = bool(self.picker.code) and self.qnet_thread is None and self.worker is None and \
            getattr(self, "comcbt_thread", None) is None
        for b in self.pdf_buttons:
            b.setEnabled(ready)
        self.drop.setEnabled(ready)
        self.drop_hint.setText("기출 PDF를 여기로 끌어다 놓으세요" if ready else "먼저 ①에서 자격종목을 조회하세요")

    def make_profile(self, cert) -> None:
        dlg = ProfileDialog(cert, self)
        if dlg.exec() and dlg.code:
            self.picker.reload()
            self.picker.select_code(dlg.code)

    # ───────────────── PDF 목록 ─────────────────
    def pick_out(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "팩 저장 폴더", str(self.out_dir))
        if d:
            self.out_dir = Path(d)
            self.save_settings()

    def add_paths(self, paths: list[Path]) -> None:
        from ..qnet_standard import looks_like_standard
        added = 0
        for p in paths:
            cand = sorted(p.rglob("*.pdf")) if p.is_dir() else ([p] if p.suffix.lower() == ".pdf" else [])
            for c in cand:
                c = c.resolve()
                if looks_like_standard(c):          # 출제기준 PDF는 기출 목록이 아니라 종목 출제기준으로
                    self.import_standard_pdf(c)
                    continue
                if not self.picker.code:            # 출제기준이 정해지기 전엔 기출을 받지 않음
                    continue
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
        w = int(self.settings.value("workers", 0) or 0)
        return BatchSpec(pdfs=list(pdfs if pdfs is not None else self.pdfs), cert=self.picker.code or "",
                         out=self.out_dir, prepared_by=f"원큐합격 전처리기 v{__version__}",
                         workers=w or None, file_dates=dict(self.file_dates))

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
        self.bundle_note.setVisible(False)
        self.peek_timer.start()

    def render_rows(self) -> None:
        self._building = True
        self.stack.setCurrentIndex(1 if self.rows else 0)
        self.table.setRowCount(len(self.rows))
        dup = {r.pack_id for r in self.rows if r.pack_id and sum(x.pack_id == r.pack_id for x in self.rows) > 1}
        for i, r in enumerate(self.rows):
            # 시행일은 문서 내용에서 읽고, 못 찾으면 "0000년 nn회"로 자동(ADR 021 2절) — 칸을 두 번 눌러 고칠 수는 있음
            needs_date = r.date.startswith("0000") or r.date.endswith("-00")
            st_text = STATUS_TEXT.get(r.status, r.status)
            msg = r.message
            if r.pack_id in dup and r.status == "waiting":
                msg = "같은 회차 PDF가 두 번 들어갔는지 확인하세요"
            done = r.status in ("packed", "review")
            if r.status == "packed":
                msg = f"{r.questions}문항 · 결과 보기 ›"
            elif r.status == "review":
                msg = f"확인할 문항 {len(r.issues)}건 · 결과 보기 ›"
            prog = 1.0 if done else 0.0 if r.status in ("error", "skipped") else \
                ((STAGES.index(r.stage) + 0.5) / len(STAGES) if r.status == "running" and r.stage in STAGES else 0.0)
            stage = {"waiting": "대기", "running": r.stage or "시작", "error": "처리 안 함", "skipped": "건너뜀"}.get(r.status, "끝")
            cells = [r.pdf.name, r.kind, round_text(r) or ("" if r.status == "error" else "…"), stage, st_text, msg]
            for c, text in enumerate(cells):
                it = QTableWidgetItem(text)
                if not (c == C_ROUND and r.status in ("waiting", "packed", "review")):
                    it.setFlags(it.flags() & ~Qt.ItemIsEditable)
                self.table.setItem(i, c, it)
            self.table.item(i, C_FILE).setData(Qt.UserRole, str(r.pdf))
            self.table.item(i, C_FILE).setToolTip(str(r.pdf))
            self.table.item(i, C_STATUS).setData(Qt.UserRole, r.status)
            self.table.item(i, C_KIND).setData(Qt.UserRole, {"글자": "packed", "스캔": "review", "섞임": "review"}.get(r.kind, "waiting"))
            self.table.item(i, C_PROG).setData(Qt.UserRole, prog)
            self.table.item(i, C_PROG).setData(Qt.UserRole + 1, r.status)
            tip = "\n".join(r.issues[:20]) if r.issues else (r.message if r.status == "packed" else msg)
            if tip:
                self.table.item(i, C_MSG).setToolTip(tip)
            if needs_date:
                self.table.item(i, C_ROUND).setForeground(QColor(theme.WARN))
                self.table.item(i, C_ROUND).setToolTip("시행일을 문서에서 못 찾았어요. 알면 두 번 눌러 YYYY-MM-DD로 적으세요(안 적어도 됩니다)")
            if done:
                self.table.item(i, C_MSG).setForeground(QColor(theme.PRIMARY))
        self._building = False
        n = len(self.rows)
        packed = sum(r.status == "packed" for r in self.rows)
        kinds = {k: sum(r.kind == k for r in self.rows) for k in ("글자", "스캔", "섞임")}
        ktxt = " · ".join(f"{k} {v}" for k, v in kinds.items() if v)
        self.summary.setText((f"PDF {n}개" + (f" ({ktxt})" if ktxt else "") + (f" · 팩 {packed}개" if packed else "")) if n else "")

    def on_item_changed(self, item: QTableWidgetItem) -> None:
        if self._building or item.column() != C_ROUND:
            return
        p = Path(self.table.item(item.row(), C_FILE).data(Qt.UserRole))
        v = item.text().strip()
        v = v.split("·")[-1].strip() if "·" in v else v
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
        bad = {r.pdf for r in self.rows if r.pdf in pdfs and r.status == "error" and not r.pack_id}
        if bad and len(bad) == len(set(pdfs)):
            return "처리할 수 있는 PDF가 없습니다(열 수 없거나 다른 종목 문서) — 목록의 '결과' 칸을 확인하세요."
        ids = [r.pack_id for r in self.rows if r.pdf in pdfs and r.pack_id]
        if len(ids) != len(set(ids)):
            return "같은 팩 이름이 둘 이상입니다. 같은 회차 PDF가 두 번 들어갔는지 확인하세요."
        return None

    def start(self, pdfs: list[Path] | None = None) -> None:
        pdfs = list(pdfs) if pdfs else list(self.pdfs)
        msg = self.check_inputs(pdfs)
        if msg:
            QMessageBox.warning(self, APP_NAME, msg)
            return
        # 열 수 없거나 다른 종목 문서인 파일은 건너뛰고 나머지만(목록에 이유가 보임)
        skip = {r.pdf for r in self.rows if r.status == "error" and not r.pack_id}
        pdfs = [p for p in pdfs if p not in skip]
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
        self.picker.setEnabled(not on)
        self.update_ready()
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
            self.bundle = ev.bundle

    def on_failed(self, msg: str) -> None:
        QMessageBox.critical(self, APP_NAME, f"처리를 시작하지 못했습니다.\n\n{msg}")

    def on_finished(self, rows) -> None:
        self.timer.stop()
        self.worker = None
        self.thread = None
        self.set_running(False)
        self.open_report_btn.setEnabled(bool(self.report))
        sec = int(time.monotonic() - self.started)
        ok = sum(r.status == "packed" for r in rows)
        rev = sum(r.status == "review" for r in rows)
        err = sum(r.status == "error" for r in rows)
        skip = sum(r.status == "skipped" for r in rows)
        text = f"끝 — 팩 {ok}개 · 검수 필요 {rev}개 · 오류 {err}개" + (f" · 건너뜀 {skip}개" if skip else "") + \
               f" · {sec // 60}분 {sec % 60}초"
        self.status.setText(text + ("  — '검수 필요' 파일을 눌러 확인하세요" if rev else ""))
        if self.bundle:
            self.bundle_note.set("ok", f"종목 묶음 저장: {self.bundle.name}",
                                 [f"이번에 새로 만든 회차 {ok - sum(1 for r in rows if r.prepared and r.prepared.unchanged)}개를 파일 하나에 담았어요.",
                                  "원큐합격 앱(폰·PC 각각)에서 [문제팩 가져오기]로 이 파일을 넣으세요. [팩 폴더 열기]로 위치를 볼 수 있어요."])
        else:
            self.bundle_note.setVisible(False)
        lines = law_summary(self.rows)
        if lines:
            self.law_note.set("warn", "법령·기준 개정 주의", lines)
        else:
            self.law_note.setVisible(False)

    def open_result(self, row: int, col: int) -> None:
        if col == C_ROUND or self.worker is not None or row >= len(self.rows):
            return
        r = self.rows[row]
        if r.prepared is None:
            if r.status == "error" and r.message:
                QMessageBox.information(self, APP_NAME, r.message)
            return
        dlg = ResultDialog(r, self)
        dlg.want_review.connect(lambda: self.open_review(r))
        dlg.exec()

    def open_review(self, r: RoundResult) -> None:
        dlg = ReviewDialog(r.prepared, self.out_dir, self, only_suspect=True)
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
        if self.qnet_thread:
            self.qnet_thread.quit()
            self.qnet_thread.wait(10_000)
        if self.comcbt_thread:
            self._comcbt_worker.stop()
            self.comcbt_thread.quit()
            self.comcbt_thread.wait(10_000)
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
