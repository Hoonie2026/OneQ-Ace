"""원큐합격 문제팩 생성기(구 전처리기) — 창 프로그램 본체(ADR 018·019, v0.5 처리 화면 ADR 021 6절, 메인 화면 재설계 ADR 023).

머리 띠 | 왼쪽: ① 종목 선택(처음엔 빈칸) + 작업 순서 ①~④ | 오른쪽: ② 기출 PDF 업로드 — 두 영역
「comcbt.com 최근 기출 받기」·「사용자 직접 올리기」(끌어다 놓는 상자 + 바로 아래 조건 셋 상시 표시) → 한 목록(글자/스캔·파일별 진행 막대)
| 아래 실행 띠: ③ 문제팩 만들기 · ④ 문제팩 공유하기(사용자 2026-11-12 세션 #19).
입력 칸 없음(만든 사람·출처·문제 종류·처리 속도 자동, 저장 폴더는 기본 폴더 — 도움말 메뉴에서 바꿈).
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
                               QProgressBar, QPushButton, QScrollArea, QStackedWidget, QTableWidget,
                               QTableWidgetItem, QToolButton, QVBoxLayout, QWidget)

from .. import __version__
from .. import standards as S
from . import shortcut
from ..batch import STATUS_TEXT, BatchSpec, RoundResult, plan_rounds
from ..summary import law_summary, peek_subjects, subject_change
from . import theme
from .cert_picker import CertPicker
from .profile_dialog import ProfileDialog
from .result_dialog import ResultDialog, suspects
from .review_dialog import ReviewDialog
from .samples import ConditionDialog, ConditionPicture
from .share_dialog import ShareDialog
from .widgets import BadgeDelegate, Card, DropZone, Note, ProgressDelegate, WrapLabel
from .worker import BatchWorker, ComcbtWorker, QnetWorker

APP_NAME = "원큐합격 문제팩 생성기"
EXE_NAME = "OneQ-PackMaker.exe"
COLS = ["PDF 파일", "종류", "회차", "진행", "상태", "결과"]
C_FILE, C_KIND, C_ROUND, C_PROG, C_STATUS, C_MSG = range(6)
C_DATE = C_ROUND          # v0.4 이름(시험 호환)
DATE_RE = re.compile(r"^(19|20)\d{2}-\d{2}-\d{2}$")
STAGES = ["읽기", "문항 나누기", "정답", "분류", "팩"]     # ADR 021 6절 — 파일별 진행 막대의 단계
CONDITIONS = [("한 파일 = 한 회차", "여러 회차가 합쳐진 PDF는 나눠서"),
              ("정답이 파일 안에", "칠한 번호·형광펜, 또는 끝에 정답표"),
              ("알아볼 수 있는 품질", "스캔본도 됨 — 심하게 기울지 않게")]


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


def stage_progress(r: RoundResult) -> float:
    """처리 중 진행 막대: 단계 다섯(STAGES) 중 어디인지. 준비가 끝나 단원 대기·단원 학습 중이면 '분류'와 '팩' 사이."""
    if r.status != "running":
        return 0.0
    if r.stage in STAGES:
        return (STAGES.index(r.stage) + 0.5) / len(STAGES)
    if r.prepared is not None or r.stage in ("단원 대기", "단원 학습"):
        return (STAGES.index("팩") + (0.25 if r.stage == "단원 학습" else 0.0)) / len(STAGES)
    return 0.0


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
        self.pending_rerun: list[Path] = []      # 처리 중에 검수하고 [다시 만들기]를 누른 회차 — 처리가 끝나면 이어서
        self.shared = False                       # ④ 문제팩 공유하기에서 메시지까지 복사했는지
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
        left.addWidget(self._card_flow())
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
        right = QScrollArea()                    # 작은 화면에서도 목록이 눌리지 않게(조건 셋이 늘 보이므로)
        right.setObjectName("main")
        right.setWidget(self._card_pdfs())
        right.setWidgetResizable(True)
        right.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        right.viewport().setObjectName("sideViewport")
        body.addWidget(right, 1)
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
            "① 종목 선택 — 종목 이름을 넣고 [조회](예: 측량, 건안기).\n"
            "② 기출 PDF 업로드 — comcbt.com 최근 기출 받기, 또는 직접 올리기(조건 셋 확인).\n"
            "③ 문제팩 만들기 — 끝난 파일을 누르면 결과 화면, 의심 문항이 있으면 [확인하기].\n"
            "④ 문제팩 보내기 — [문제팩 공유하기]로 내 휴대폰이나 동료에게.\n\n"
            "끝나면 종목 묶음(oneq-종목-bundle-….zip) 하나가 문제팩 폴더에 생깁니다.\n"
            "그 파일을 원큐합격 학습앱의 [문제팩 가져오기]로 넣으세요(기기마다 따로).")))
        m.addSeparator()
        m.addAction("저장 폴더 바꾸기…", self.pick_out)
        speed = m.addMenu("처리 속도")
        for v, t in ((0, "자동(코어 수 − 1, 최대 4)"), (1, "천천히 — 1회차씩(오래된 PC)")):
            speed.addAction(t, lambda v=v: self.settings.setValue("workers", v))
        m.addAction("바로가기 만들기(바탕화면·시작 메뉴)", lambda: self.offer_shortcuts(ask=False))
        m.addAction("프로그램 폴더 열기", self.open_program_folder)
        m.addAction("문제팩 공유하기…", self.show_share)
        m.addSeparator()
        m.addAction("처음 상태로 되돌리기…", self.reset_all)
        m.addAction("라이선스·사용한 오픈소스", self.show_licenses)
        m.addAction(f"{APP_NAME} 정보", lambda: QMessageBox.about(
            self, APP_NAME, f"{APP_NAME} v{__version__}\n기출 PDF → 원큐합격 문제팩(.zip)"))
        help_btn.setMenu(m)
        lay.addWidget(help_btn)
        return h

    def _card_cert(self) -> Card:
        c = Card("종목 선택", "1")
        self.picker = CertPicker()
        c.body.addWidget(self.picker)
        return c

    def _card_flow(self) -> Card:
        """작업 순서 한눈에(사용자 2026-11-11, 네 단계로 2026-11-12) — 끝난 단계 ✓(초록), 지금 할 단계(파랑), 남은 단계(회색)."""
        c = Card("작업 순서", "", "")
        self.flow: list[tuple[QLabel, QLabel]] = []
        steps = [("종목 선택", ""), ("기출 PDF 업로드", ""), ("문제팩 만들기", ""), ("문제팩 보내기", "")]   # 설명은 뺌(2026-11-12)
        for i, (t, h) in enumerate(steps, 1):
            row = QHBoxLayout()
            row.setSpacing(10)
            n = QLabel(str(i))
            n.setObjectName("flowStep")
            row.addWidget(n, 0, Qt.AlignTop)
            v = QVBoxLayout()
            v.setSpacing(0)
            tl = QLabel(t)
            tl.setObjectName("flowText")
            v.addWidget(tl)
            if h:
                hl = QLabel(h)
                hl.setObjectName("muted")
                hl.setWordWrap(True)
                v.addWidget(hl)
            row.addLayout(v, 1)
            c.body.addLayout(row)
            self.flow.append((n, tl))
        return c

    def flow_state(self) -> list[str]:
        """작업 순서 네 단계의 상태 — done / now / todo."""
        s1 = bool(self.picker.code)
        s2 = any(r.pack_id and r.status != "error" for r in self.rows)
        s3 = self.bundle is not None and self.worker is None and any(r.status in ("packed", "review") for r in self.rows)
        s4 = self.shared
        out, now = [], False
        for d in (s1, s2, s3, s4):
            if d and not now:
                out.append("done")
            elif not now:
                out.append("now")
                now = True
            else:
                out.append("todo")
        return out

    def update_flow(self) -> None:
        if not hasattr(self, "flow"):
            return
        for i, ((n, t), st) in enumerate(zip(self.flow, self.flow_state()), 1):
            n.setText("✓" if st == "done" else str(i))
            for w in (n, t):
                if w.property("state") != st:
                    w.setProperty("state", st)
                    w.style().unpolish(w)
                    w.style().polish(w)

    def _conditions_panel(self) -> QFrame:
        """끌어다 놓는 상자 바로 아래에 늘 보이는 '올리는 기출 PDF 조건' 셋(ADR 021 3절, 상시 표시 2026-11-12) — 조건 1·2·3 + 예시 그림."""
        f = QFrame()
        f.setObjectName("condPanel")
        v = QVBoxLayout(f)
        v.setContentsMargins(14, 10, 14, 10)
        v.setSpacing(6)
        head = WrapLabel("문제팩 생성이 가능한 PDF 업로드 조건")
        head.setObjectName("condHead")
        head.setToolTip("어디서 구했든 셋만 맞으면 됩니다. 그림을 누르면 크게 · 한글·워드 파일은 그 프로그램에서 PDF로 저장")
        v.addWidget(head)
        cols = QHBoxLayout()
        cols.setSpacing(12)
        self.condition_pictures: list[ConditionPicture] = []
        for i, (t, h) in enumerate(CONDITIONS, 1):
            col = QVBoxLayout()
            col.setSpacing(4)
            top = QHBoxLayout()
            top.setSpacing(8)
            chip = QLabel(f"조건 {i}")
            chip.setObjectName("condChip")
            top.addWidget(chip, 0, Qt.AlignVCenter)
            tl = QLabel(t)
            tl.setStyleSheet("font-weight:600")
            top.addWidget(tl, 1)
            col.addLayout(top)
            hl = WrapLabel(h)
            hl.setObjectName("muted")
            col.addWidget(hl)
            pic = ConditionPicture(i - 1)            # 예시 그림(B3 ①) — 누르면 크게
            pic.clicked.connect(self.show_condition)
            col.addWidget(pic)
            self.condition_pictures.append(pic)
            cols.addLayout(col, 1)
        v.addLayout(cols)
        return f

    def show_condition(self, index: int) -> None:
        ConditionDialog(index, CONDITIONS[index][1], self).exec()

    def latest_bundle(self) -> Path | None:
        """보낼 종목 묶음 — 이번에 만든 것, 없으면 저장 폴더에서 지금 종목(없으면 아무 종목)의 가장 새 묶음."""
        if self.bundle and self.bundle.exists():
            return self.bundle
        code = self.picker.code or ""
        try:
            found = [p for p in self.out_dir.glob("**/oneq-*-bundle-*.zip") if not code or p.name.startswith(f"oneq-{code}-")]
        except OSError:
            return None
        return max(found, key=lambda p: p.stat().st_mtime) if found else None

    def show_share(self) -> None:
        """④ [문제팩 공유하기] — 문제팩 폴더에서 파일을 골라 메시지와 함께 보냄(학습앱·생성기 안내 없음, 사용자 2026-11-12)."""
        d = ShareDialog(self, self.out_dir, self.status, self.latest_bundle())
        d.exec()
        if d.shared and not self.shared:
            self.shared = True
            self.update_flow()

    # ── 설치 없는 zip 배포: 바로가기·임시 폴더 경고(🖥P14, 2026-11-11) ──
    def first_run_checks(self) -> None:
        """실행파일로 처음 열 때: zip 안에서 바로 열었으면 경고, 아니면 바로가기 만들지 한 번 묻기."""
        exe = shortcut.exe_path()
        if exe is None or os.name != "nt":
            return
        if shortcut.inside_zip_temp(exe):
            QMessageBox.warning(self, APP_NAME, (
                "zip 파일을 풀지 않고 그 안에서 바로 실행했어요.\n"
                "이대로면 창을 닫을 때 프로그램이 임시 폴더에서 지워지고 바로가기도 만들 수 없어요.\n\n"
                f"창을 닫고 → 받은 zip을 오른쪽 클릭 → [모두 압축 풀기] → 풀린 폴더의 {EXE_NAME}를 여세요."))
            return
        if shortcut.installed(exe) or self.settings.value("shortcut_asked", False, type=bool):
            return
        self.settings.setValue("shortcut_asked", True)
        self.offer_shortcuts(ask=True)

    def offer_shortcuts(self, ask: bool) -> None:
        exe = shortcut.exe_path()
        if exe is None:
            QMessageBox.information(self, APP_NAME, f"바로가기는 실행파일({EXE_NAME})로 열었을 때 만들 수 있어요.")
            return
        if shortcut.inside_zip_temp(exe):
            self.first_run_checks()
            return
        if ask and QMessageBox.question(self, APP_NAME, (
                f"{APP_NAME}는 설치 없이 이 폴더에서 바로 실행됩니다:\n"
                f"{exe.parent}\n\n이 폴더를 지우거나 옮기지 말고 두세요.\n"
                "바탕화면과 시작 메뉴에 바로가기를 만들까요?")) != QMessageBox.Yes:
            return
        try:
            made = shortcut.make_shortcuts(exe)
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, APP_NAME, f"바로가기를 만들지 못했어요 — {e}\n\n프로그램 위치: {exe}")
            return
        self.status.setText(f"바로가기를 만들었어요: 바탕화면·시작 메뉴의 '{APP_NAME}'")
        if not ask:
            QMessageBox.information(self, APP_NAME, "바로가기를 만들었어요.\n" + "\n".join(made))

    def open_program_folder(self) -> None:
        exe = shortcut.exe_path()
        folder = exe.parent if exe else Path(__file__).resolve().parents[2]
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))

    def _source_area(self, name: str, title: str, hint: str = "") -> tuple[QFrame, QVBoxLayout, QHBoxLayout, QLabel]:
        """기출 PDF를 넣는 두 영역(comcbt.com 최근 기출 받기 / 사용자 직접 올리기) — 제목 줄(오른쪽에 단추) + 설명 + 내용."""
        f = QFrame()
        f.setObjectName("srcArea")
        f.setAccessibleName(name)
        v = QVBoxLayout(f)
        v.setContentsMargins(16, 12, 16, 14)
        v.setSpacing(8)
        top = QHBoxLayout()
        top.setSpacing(8)
        tl = QLabel(title)
        tl.setObjectName("srcTitle")
        top.addWidget(tl, 1)
        v.addLayout(top)
        hl = WrapLabel(hint)
        hl.setObjectName("muted")
        hl.setVisible(bool(hint))
        v.addWidget(hl)
        return f, v, top, hl

    def _card_pdfs(self) -> Card:
        """② 기출 PDF 업로드 = 「comcbt.com 최근 기출 받기」 → 「사용자 직접 올리기」(끌어다 놓는 상자 + 조건 셋 상시) → 목록
        (영역 구분 2026-11-12 — 2-1·2-2 번호 상자 대신)."""
        c = Card("기출 PDF 업로드", "2")
        self.summary = QLabel()
        self.summary.setObjectName("muted")
        c.head.addWidget(self.summary)
        self.pdf_buttons = []
        # comcbt.com 게시판 첫 쪽의 최근 기출 받기(사용자 결정 2026-10-24 — 이전·최신 회차는 직접 올림)
        from ..comcbt import FIRST_PAGE_HINT
        a1, v1, top1, self.comcbt_hint = self._source_area(
            "comcbt", "comcbt.com 최근 기출 받기", f"종목 게시판 첫 쪽의 최근 회차({FIRST_PAGE_HINT})")
        self.comcbt_btn = QPushButton("최근 기출 받기")
        self.comcbt_btn.setObjectName("primarySmall")
        self.comcbt_btn.setToolTip("comcbt.com 종목 게시판 첫 쪽의 최근 기출(정답 표시된 교사용 PDF)을 받아 목록에 넣습니다")
        self.comcbt_btn.clicked.connect(self.comcbt_fetch)
        top1.addWidget(self.comcbt_btn)
        self.pdf_buttons.append(self.comcbt_btn)
        self.comcbt_note = Note("info")
        self.comcbt_note.setVisible(False)
        v1.addWidget(self.comcbt_note)
        c.body.addWidget(a1)
        # 사용자 직접 올리기 — 끌어다 놓는 상자 + 바로 아래 조건 셋(늘 보임)
        a2, v2, top2, _ = self._source_area("upload", "사용자 직접 올리기")
        for text, fn in (("PDF 추가", self.add_files), ("폴더 추가", self.add_folder)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            top2.addWidget(b)
            self.pdf_buttons.append(b)
        self.drop = DropZone()
        self.drop.clicked.connect(lambda: self.drop.isEnabled() and self.add_files())
        self.drop_hint = self.drop.title
        v2.addWidget(self.drop)
        self.cond_panel = self._conditions_panel()
        v2.addWidget(self.cond_panel)
        c.body.addWidget(a2)
        # 목록(자동 받은 것·직접 올린 것 한 목록)
        bar = QHBoxLayout()
        bar.setSpacing(8)
        lt = QLabel("올린 기출 PDF 목록")
        lt.setObjectName("fieldLabel")
        bar.addWidget(lt)
        bar.addStretch(1)
        for text, fn in (("선택 빼기", self.remove_selected), ("모두 비우기", self.clear_files)):
            b = QPushButton(text)
            b.clicked.connect(fn)
            bar.addWidget(b)
            self.pdf_buttons.append(b)
        c.body.addLayout(bar)

        self.stack = QStackedWidget()
        empty = QLabel("올린 기출 PDF가 여기에 회차별로 나옵니다")
        empty.setObjectName("listEmpty")
        empty.setAlignment(Qt.AlignCenter)
        empty.setWordWrap(True)
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
        self.table.setMinimumHeight(150)
        self.stack.addWidget(empty)
        self.stack.addWidget(self.table)
        c.body.addWidget(self.stack, 1)

        self.change_note = Note("info")
        self.change_note.setVisible(False)
        self.law_note = Note("warn")
        self.law_note.setVisible(False)
        self.bundle_note = Note("ok")
        self.bundle_note.setVisible(False)
        self.ocr_note = Note("warn")             # 스캔본인데 OCR 기능이 없을 때(ADR 022 1절)
        self.ocr_note.setVisible(False)
        c.body.addWidget(self.ocr_note)
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
        step3 = QLabel("3")                      # ③ 문제팩 만들기 · ④ 문제팩 공유하기(작업 순서, 사용자 2026-11-12)
        step3.setObjectName("cardStep")
        lay.addWidget(step3, 0, Qt.AlignVCenter)
        self.run_btn = QPushButton("문제팩 만들기")
        self.run_btn.setObjectName("primary")
        self.run_btn.setMinimumWidth(160)
        self.run_btn.clicked.connect(lambda: self.start())
        self.stop_btn = QPushButton("멈추기")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self.stop)
        mid = QVBoxLayout()
        mid.setSpacing(6)
        self.status = QLabel("종목을 고르고 기출 PDF를 넣은 뒤 [문제팩 만들기]를 누르세요.")
        self.status.setObjectName("status")
        self.progress = QProgressBar()
        self.progress.setValue(0)
        mid.addWidget(self.status)
        mid.addWidget(self.progress)
        self.open_out_btn = QPushButton("문제팩 폴더 열기")
        self.open_out_btn.clicked.connect(self.open_out)
        self.open_report_btn = QPushButton("처리 보고서")
        self.open_report_btn.setEnabled(False)
        self.open_report_btn.clicked.connect(lambda: self.report and QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.report))))
        lay.addWidget(self.run_btn)
        lay.addWidget(self.stop_btn)
        lay.addLayout(mid, 1)
        lay.addWidget(self.open_out_btn)
        lay.addWidget(self.open_report_btn)
        sep = QFrame()
        sep.setObjectName("vsep")
        sep.setFixedWidth(1)
        lay.addWidget(sep)
        step4 = QLabel("4")
        step4.setObjectName("cardStep")
        lay.addWidget(step4, 0, Qt.AlignVCenter)
        self.share_btn = QPushButton("문제팩 공유하기")
        self.share_btn.setObjectName("shareBtn")
        self.share_btn.setToolTip("문제팩 폴더에서 보낼 문제팩 파일을 골라 메시지와 함께 내 휴대폰·동료에게 보냅니다")
        self.share_btn.clicked.connect(self.show_share)
        lay.addWidget(self.share_btn)
        return f

    # ───────────────── 설정 ─────────────────
    def load_settings(self) -> None:
        st = self.settings
        docs = QStandardPaths.writableLocation(QStandardPaths.DocumentsLocation)
        self.out_dir = Path(st.value("out", str(Path(docs) / "원큐합격 문제팩")))
        # ① 종목은 처음에 빈칸 — 사용자가 원하는 종목을 고르게(사용자 2026-11-12, 예전엔 측량을 미리 골라 둠)

    def save_settings(self) -> None:
        st = self.settings
        st.setValue("out", str(self.out_dir))

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
        self.update_ready()      # 🖥P19(2026-11-11): 조회 성공 때 on_qnet은 스레드가 끝나기 전이라 ②가 잠긴 채 남았음

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
        """조회 실패. 전에 받아 둔 이 종목 출제기준(기간 안)이 있으면 그것으로 계속(실기기 2026-11-12: 한 번 받았는데
        다시 조회가 실패하자 올리기 상자로 막힘) — 없을 때만 올리기 상자."""
        cert = self.picker.current
        code = cert.profile if cert else None
        if code:
            from .. import qnet
            try:
                prof = S.load(code)
            except Exception:  # noqa: BLE001
                prof = None
            if prof and prof.period and not qnet.needs_fetch(code):
                self._use_profile(code)
                why = msg.rsplit("(", 1)[-1].rstrip(")") if msg.endswith(")") else ""
                self.picker.set_qnet("info", f"Q-Net에 연결하지 못해 전에 받은 출제기준을 씁니다 "
                                     f"({prof.period['from'].replace('-', '.')}~{prof.period['to'].replace('-', '.')})",
                                     [f"원인: {why}"] if why else [])
                return
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
        self.comcbt_hint.setText(f"comcbt.com '{self.picker.current.name if self.picker.current else ''}' 게시판 첫 쪽: "
                                 f"{comcbt.first_page_text(res)}")
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
        self.drop_hint.setText("기출 PDF를 여기로 끌어다 놓으세요" if ready else "먼저 ① 종목 선택에서 자격종목을 조회하세요")
        self.update_flow()

    def make_profile(self, cert) -> None:
        dlg = ProfileDialog(cert, self)
        if dlg.exec() and dlg.code:
            self.picker.reload()
            self.picker.select_code(dlg.code)

    # ───────────────── PDF 목록 ─────────────────
    def reset_targets(self) -> list[Path]:
        """처음 상태로 되돌릴 때 지울 것 — 기출 PDF(문제팩 폴더의 '기출 PDF')는 남긴다(사용자 2026-11-12)."""
        root = S.user_root().parent                      # %APPDATA%\OneQ-Ace
        out = []
        for sub in ("standards", "qnet", "logs"):
            d = root / sub
            if d.exists():
                out += [f for f in d.iterdir() if f.is_file()]
        if self.out_dir.exists():
            out += sorted(self.out_dir.glob("oneq-*.zip"))
            if (self.out_dir / "review").exists():
                out.append(self.out_dir / "review")
        return out

    def reset_all(self) -> None:
        """도움말 › 처음 상태로 되돌리기 — 받아 둔 출제기준·만든 문제팩·처리 보고서·오류 기록을 지움(기출 PDF는 그대로)."""
        if self.worker is not None:
            return
        targets = self.reset_targets()
        root = S.user_root().parent
        msg = ("다음을 지웁니다(기출 PDF는 그대로 둡니다):\n"
               f"· 받아 둔 출제기준 — {root / 'standards'}, {root / 'qnet'}\n"
               f"· 만든 문제팩(oneq-….zip)·처리 보고서(review 폴더) — {self.out_dir}\n"
               f"· 오류 기록 — {root / 'logs'}\n\n"
               f"모두 {len(targets)}개. 되돌릴 수 없습니다. 학습앱에 넣어 둔 문제팩·학습 기록은 그대로입니다.")
        if QMessageBox.question(self, "처음 상태로 되돌리기", msg) != QMessageBox.Yes:
            return
        import shutil
        failed = 0
        for t in targets:
            try:
                shutil.rmtree(t) if t.is_dir() else t.unlink()
            except OSError:
                failed += 1                               # 열려 있는 오류 기록 등
        self.clear_files()
        self.bundle, self.report, self.shared = None, None, False
        self.picker.reload()
        self.picker.current = None
        self.picker.edit.clear()
        self.picker.info.setVisible(False)
        self.picker.qnet.setVisible(False)
        self.picker.fail.setVisible(False)
        self.refresh_plan()
        self.update_ready()
        self.status.setText("처음 상태로 되돌렸어요" + (f"(지우지 못한 파일 {failed}개 — 열려 있는 기록 파일)" if failed else ""))

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
        self.bundle = None
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
                         out=self.out_dir, prepared_by=f"{APP_NAME} v{__version__}",
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
        self.update_ocr_note()
        self.peek_timer.start()

    def update_ocr_note(self) -> None:
        """스캔본이 있는데 OCR 엔진(Windows 한국어 OCR 기능)이 없으면 처리 전에 미리 알린다(ADR 022 1절)."""
        from ..ocr import OcrUnavailable, pick_engine
        if not any(r.kind in ("스캔", "섞임") for r in self.rows):
            self.ocr_note.setVisible(False)
            return
        if getattr(self, "_ocr_err", None) is None:
            try:
                pick_engine()
                self._ocr_err = ""
            except OcrUnavailable as e:
                self._ocr_err = str(e)
        if not self._ocr_err:
            self.ocr_note.setVisible(False)
            return
        lines = [x.strip() for x in self._ocr_err.splitlines()[1:] if x.strip()]
        self.ocr_note.set("warn", "스캔본을 읽으려면 Windows 한국어 OCR 기능이 필요해요", lines)

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
            early = r.status == "running" and r.prepared is not None     # 처리 중에 끝난 파일(B3 ②) — 단원·팩만 남음
            if early:
                n_sus = len(suspects(r.prepared))
                msg = (f"확인할 문항 {n_sus}건" if n_sus else f"{len(r.prepared.items)}문항") + " · 결과 보기 ›"
            elif r.status == "packed":
                msg = f"{r.questions}문항 · 결과 보기 ›"
            elif r.status == "review":
                msg = f"확인할 문항 {len(r.issues)}건 · 결과 보기 ›"
            prog = 1.0 if done else 0.0 if r.status in ("error", "skipped") else stage_progress(r)
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
            if done or early:
                self.table.item(i, C_MSG).setForeground(QColor(theme.PRIMARY))
        self._building = False
        n = len(self.rows)
        packed = sum(r.status == "packed" for r in self.rows)
        kinds = {k: sum(r.kind == k for r in self.rows) for k in ("글자", "스캔", "섞임")}
        ktxt = " · ".join(f"{k} {v}" for k, v in kinds.items() if v)
        self.summary.setText((f"PDF {n}개" + (f" ({ktxt})" if ktxt else "") + (f" · 팩 {packed}개" if packed else "")) if n else "")
        self.drop.set_compact(bool(self.rows))   # 목록이 생기면 상자는 낮게(조건 셋은 그대로 보임)
        self.update_flow()

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
        self.bundle = None
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
            self.unit_summary = getattr(ev, "units", "")

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
        text = f"끝 — 문제팩 {ok}개" + (f" · 만들지 못함 {rev}개" if rev else "") + (f" · 오류 {err}개" if err else "") + \
               (f" · 건너뜀 {skip}개" if skip else "") + \
               f" · {sec // 60}분 {sec % 60}초"
        units = getattr(self, "unit_summary", "")
        self.status.setText(text + (f" · {units}" if units else ""))
        if self.bundle:
            self.bundle_note.set("ok", f"종목 묶음 저장: {self.bundle.name}",
                                 [f"새로 만든 {ok - sum(1 for r in rows if r.prepared and r.prepared.unchanged)}회차를 파일 하나에 담았어요 — "
                                  "학습앱 [문제팩 가져오기]로 넣거나 ④ [문제팩 공유하기]로 보내세요."])
        else:
            self.bundle_note.setVisible(False)
        lines = law_summary(self.rows)
        if lines:
            self.law_note.set("warn", "법령·기준 개정 주의", lines)
        else:
            self.law_note.setVisible(False)
        if self.pending_rerun:                         # 처리 중에 검수한 회차 다시 만들기(B3 ②)
            again = [p for p in self.pending_rerun if p in self.pdfs]
            self.pending_rerun = []
            if again:
                QTimer.singleShot(0, lambda: self.start(again))

    def open_result(self, row: int, col: int) -> None:
        """끝난 파일을 누르면 결과 화면 — 처리 중에도 먼저 끝난 파일은 바로 열림(B3 ②)."""
        if row >= len(self.rows) or (col == C_ROUND and self.worker is None):
            return
        r = self.rows[row]
        if r.prepared is None:
            if r.status == "error" and r.message:
                QMessageBox.information(self, APP_NAME, r.message)
            return
        dlg = ResultDialog(r, self, pending=self.worker is not None and r.status == "running")
        dlg.want_review.connect(lambda: self.open_review(r))
        dlg.exec()

    def open_review(self, r: RoundResult) -> None:
        dlg = ReviewDialog(r.prepared, self.out_dir, self, only_suspect=True)
        if dlg.exec() and dlg.rerun:
            if self.worker is not None:                # 처리 중이면 끝난 뒤 이어서 다시 만듦
                if r.pdf not in self.pending_rerun:
                    self.pending_rerun.append(r.pdf)
                self.status.setText(f"고친 내용을 저장했어요 — 지금 처리가 끝나면 {r.pdf.name}을(를) 다시 만듭니다")
            else:
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


def log_dir() -> Path:
    """오류 기록 폴더(%APPDATA%\\OneQ-Ace\\logs) — 갑자기 꺼진 원인을 다음에 알 수 있게(실기기 2026-11-12)."""
    from .. import standards as S
    d = S.user_root().parent / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def install_error_log() -> None:
    """처리되지 않은 오류는 기록하고 창으로 알림(꺼지지 않게), 파이썬이 통째로 죽는 경우(faulthandler)도 기록."""
    import datetime
    import faulthandler
    import traceback
    try:
        d = log_dir()
        crash = open(d / "crash.log", "a", encoding="utf-8")  # noqa: SIM115 — 프로그램이 끝날 때까지 열어 둠
        crash.write(f"\n=== {datetime.datetime.now():%Y-%m-%d %H:%M:%S} 시작 v{__version__} ===\n")
        crash.flush()
        faulthandler.enable(crash)
    except OSError:
        return

    def hook(kind, value, tb):
        text = "".join(traceback.format_exception(kind, value, tb))
        try:
            with open(d / "error.log", "a", encoding="utf-8") as f:
                f.write(f"\n=== {datetime.datetime.now():%Y-%m-%d %H:%M:%S} v{__version__} ===\n{text}")
        except OSError:
            pass
        sys.__stderr__ and sys.__stderr__.write(text)
        try:
            QMessageBox.warning(None, APP_NAME, f"예상하지 못한 오류가 났어요(프로그램은 계속 씁니다).\n\n"
                                f"{kind.__name__}: {value}\n\n기록: {d / 'error.log'}")
        except Exception:  # noqa: BLE001
            pass
    sys.excepthook = hook


def main() -> None:
    app = QApplication(sys.argv)
    install_error_log()
    app.setApplicationName(APP_NAME)
    theme.apply(app)
    icon = resource_path("oneq_prep/gui/icon.png")
    if icon.exists():
        app.setWindowIcon(QIcon(str(icon)))
    w = MainWindow()
    w.show()
    QTimer.singleShot(400, w.first_run_checks)
    sys.exit(app.exec())
