"""원큐합격 문제팩 생성기(구 전처리기) — 창 프로그램 본체(ADR 018·019, v0.5 처리 화면 ADR 021 6절, 메인 화면 재설계 ADR 023).

머리 띠 | 왼쪽: ① 종목 선택(처음엔 빈칸) + 작업 순서 ①~④ | 오른쪽: ② 기출 PDF 업로드 — 사용자가 직접 올림
(끌어다 놓는 큰 상자 + [폴더에서 선택하기] + 조건 셋 상시 표시, comcbt 자동 받기는 2026-11-17 제거) → 목록(글자/스캔·파일별 진행 막대)
| 아래 실행 띠: ③ 문제팩 만들기 · ④ 문제팩 공유하기(사용자 2026-11-12 세션 #19).
입력 칸 없음(만든 사람·출처·문제 종류·처리 속도 자동, 저장 폴더는 기본 폴더 — 도움말 메뉴에서 바꿈).
처리가 끝난 뒤 파일을 누르면 결과 화면(과목별 문항·정답·뺀 문항·미리 보기, [직접 고치기(선택)]).
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
from ..batch import STATUS_TEXT, BatchSpec, RoundResult, mark_duplicates, plan_one
from ..summary import law_summary, peek_subjects, subject_change
from . import theme
from .cert_picker import CertPicker
from .profile_dialog import ProfileDialog
from .result_dialog import ResultDialog
from .samples import ConditionDialog, ConditionPicture
from .share_dialog import ShareDialog
from .widgets import BadgeDelegate, Card, DropZone, Note, ProgressDelegate, WrapLabel
from .worker import BatchWorker, PlanWorker, QnetWorker

APP_NAME = "원큐합격 문제팩 생성기"
EXE_NAME = "OneQ-PackMaker.exe"
COLS = ["PDF 파일", "종류", "회차", "진행", "상태", "결과"]
C_FILE, C_KIND, C_ROUND, C_PROG, C_STATUS, C_MSG = range(6)
C_DATE = C_ROUND          # v0.4 이름(시험 호환)
DATE_RE = re.compile(r"^(19|20)\d{2}-\d{2}-\d{2}$")
STAGES = ["읽기", "문항 나누기", "정답", "정답 확인", "팩"]     # ADR 021 6절 — 파일별 진행 막대의 단계(batch.py가 보내는 값)
STAGE_LABEL = {"팩": "마무리", "팩 대기": "마무리 대기"}      # 화면 표시(0.5.0 — 개발 용어 "팩" 대신)
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
    """처리 중 진행 막대: 단계 다섯(STAGES) 중 어디인지. 준비가 끝나 다른 회차를 기다리는 중(팩 대기)이면 '정답 확인' 앞."""
    if r.status in ("packed", "review", "error", "skipped"):
        return 1.0 if r.status != "skipped" or r.pack_id else 0.0
    if r.status != "running":
        return 0.0
    if r.stage in STAGES:
        return (STAGES.index(r.stage) + 0.5) / len(STAGES)
    if r.prepared is not None or r.stage == "팩 대기":
        return STAGES.index("정답 확인") / len(STAGES)
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
        # 화면 크기에 맞춤(실기기 2026-11-16: 노트북·배율 125%에서 창이 화면보다 커 아래 [문제팩 만들기] 띠가 안 보임)
        self.setMinimumSize(980, 600)
        scr = QApplication.primaryScreen()
        if scr is not None:
            g = scr.availableGeometry()
            w, h = min(1320, int(g.width() * 0.94)), min(880, int(g.height() * 0.92))
            self.resize(max(w, 980), max(h, 600))
            self.move(g.x() + (g.width() - self.width()) // 2, g.y() + max(0, (g.height() - self.frameGeometry().height()) // 2))
        else:
            self.resize(1320, 880)
        self.setAcceptDrops(True)
        self.settings = QSettings("OneQ-Ace", "oneq-prep")
        self.pdfs: list[Path] = []
        self.file_dates: dict[Path, str] = {}
        self.rows: list[RoundResult] = []
        self.thread: QThread | None = None
        self.qnet_thread: QThread | None = None
        # 목록 미리 읽기(시행일·회차·종류)는 다른 스레드에서, 읽은 것은 기억(실기기 2026-11-16 — 20회차 넣을 때 '응답 없음')
        self.plan_async = True
        self.plan_cache: dict[tuple, RoundResult] = {}
        self.plan_thread: QThread | None = None
        self._std_check: set[Path] = set()      # 출제기준 PDF인지 아직 안 본 파일
        self.worker: BatchWorker | None = None
        self.peek_thread: QThread | None = None
        self.peek_cache: dict[Path, list[str]] = {}
        self.started = 0.0
        self.done = 0
        self.report: Path | None = None
        self.bundle: Path | None = None
        self.shared = False                       # ④ 문제팩 공유하기에서 메시지까지 복사했는지
        self.made = False                         # 지금 목록으로 문제팩을 다 만들었는지(다시 조회하면 목록을 비움)
        self.cert_locked = False                  # 기출을 올린 뒤 문제팩 만들기가 끝날 때까지 종목 조회 잠금
        self.list_code: str | None = None         # 지금 목록을 올릴 때의 종목
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
        lw.setFixedWidth(400)                    # 출제기준 요약의 과목명이 한 줄에 들어가게(2026-11-17, 364 → 400)
        scroll = QScrollArea()
        scroll.setObjectName("side")
        scroll.setWidget(lw)
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(412)
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
        s = QLabel("기출 PDF를 원큐합격 문제팩으로 — 현행 출제기준의 과목으로 정리합니다")
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
            "① 종목 선택 — 종목 이름을 넣고 [조회](예: 측량, 건안기). Q-Net에서 현행 출제기준을 받아 옵니다.\n"
            "② 기출 PDF 업로드 — 기출 PDF를 끌어다 놓거나 [폴더에서 선택하기](조건 셋 확인).\n"
            "③ 문제팩 만들기 — 끝난 파일을 누르면 결과 화면이 열립니다. 정답을 못 찾은 문항은 학습앱에서 지정합니다.\n"
            "④ 문제팩 보내기 — [문제팩 공유하기]로 내 휴대폰이나 동료에게 카카오톡·메일로.\n\n"
            "끝나면 문제팩 폴더에 종목 문제팩 파일 하나(예: 원큐합격 문제팩_건설안전기사_2016-2022(20회차).zip)가 생깁니다.\n"
            "그 파일을 원큐합격 학습앱의 [문제팩 가져오기]로 넣으세요(기기마다 따로).")))
        m.addSeparator()
        m.addAction("저장 폴더 바꾸기…", self.pick_out)
        speed = m.addMenu("처리 속도")
        for v, t in ((0, "자동(권장)"), (1, "천천히 — 한 회차씩(오래된 PC·메모리가 부족할 때)")):
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
        self.update_buttons()
        for i, ((n, t), st) in enumerate(zip(self.flow, self.flow_state()), 1):
            n.setText("✓" if st == "done" else str(i))
            for w in (n, t):
                if w.property("state") != st:
                    w.setProperty("state", st)
                    w.style().unpolish(w)
                    w.style().polish(w)

    def busy(self) -> bool:
        return self.worker is not None or getattr(self, "running", False) or self.qnet_thread is not None \
            or self.plan_thread is not None

    def update_buttons(self) -> None:
        """작업 순서 버튼(① 조회 → ② 기출 PDF 웹검색 → ③ 문제팩 만들기 → ④ 문제팩 공유하기)을 차례로 파랗게(사용자 2026-11-17).
        지금 할 단계 버튼만 파랑, 나머지는 회색. 조회·PDF 읽기·문제팩 만들기 중에는 네 버튼 모두 누를 수 없음."""
        if not hasattr(self, "share_btn"):
            return
        st = self.flow_state()
        now = st.index("now") if "now" in st else -1
        busy = self.busy()
        code = bool(self.picker.code)
        have_rows = any(r.pack_id and r.status != "error" for r in self.rows)
        from ..pack import ROUNDS_DIR
        rd = self.out_dir / ROUNDS_DIR
        have_packs = bool(self.bundle) or (rd.exists() and any(rd.glob("oneq-*.zip")))
        btns = [self.picker.b_query, self.web_btn, self.run_btn, self.share_btn]
        # 기출을 한 번 올리면 문제팩 만들기가 끝날 때까지 다른 종목을 조회하지 못함(사용자 2026-11-17 — [모두 비우기]로도 안 풀림).
        # 올리기 전(종목만 조회한 상태)에는 열어 둠
        can_query = not self.cert_locked
        enabled = [can_query, code, code and have_rows, have_packs]
        for i, (b, en) in enumerate(zip(btns, enabled)):
            b.setEnabled(en and not busy)
            flow = "now" if i == now and not busy else "idle"
            if b.property("flow") != flow:
                b.setProperty("flow", flow)
                b.style().unpolish(b)
                b.style().polish(b)
        self.picker.edit.setEnabled(not busy and can_query)
        tip = "" if can_query else "기출을 올린 종목의 문제팩 만들기가 끝나면 다른 종목을 조회할 수 있어요"
        self.picker.b_query.setToolTip(tip)
        self.picker.edit.setToolTip(tip)

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

    def show_conditions(self, on: bool) -> None:
        """업로드 조건 셋을 보이거나 접는다. 접으면 목록을 행 수만큼 크게(최대 15행) — 아래 안내 상자에 밀려 작아지지 않게."""
        self.cond_panel.setVisible(on)
        self.fit_list()

    def fit_list(self) -> None:
        if self.cond_panel.isVisible():
            self.table.setMinimumHeight(150)
            return
        rows = min(max(self.table.rowCount(), 3), 15)
        head = self.table.horizontalHeader().height() or 36
        self.table.setMinimumHeight(head + rows * self.table.verticalHeader().defaultSectionSize() + 6)

    def show_condition(self, index: int) -> None:
        ConditionDialog(index, CONDITIONS[index][1], self).exec()

    def latest_bundle(self) -> Path | None:
        """보낼 종목 묶음 — 이번에 만든 것, 없으면 저장 폴더에서 지금 종목(없으면 아무 종목)의 가장 새 묶음."""
        if self.bundle and self.bundle.exists():
            return self.bundle
        code = self.picker.code or ""
        from ..bundle import PREFIX, bundles_of
        try:
            found = bundles_of(self.out_dir, code) if code else sorted(self.out_dir.glob(f"{PREFIX}*.zip"))
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

    def _card_pdfs(self) -> Card:
        """② 기출 PDF 업로드 = 끌어다 놓는 상자(+ [폴더에서 선택하기]) → 조건 셋(상시) → 목록. 직접 올리기 하나(2026-11-17)."""
        c = Card("기출 PDF 업로드", "2")
        self.summary = QLabel()
        self.summary.setObjectName("muted")
        c.head.addWidget(self.summary)
        self.pdf_buttons = []
        # 제목 줄 오른쪽 끝(= 아래 끌어다 놓는 상자의 오른쪽 끝선) — 조회한 종목으로 구글 검색(사용자 2026-11-17)
        self.web_btn = QPushButton("기출 PDF 웹검색")
        self.web_btn.setObjectName("flowBtn")
        self.web_btn.setToolTip("기본 브라우저에서 구글 검색: 「종목명 필기 기출 PDF」")
        self.web_btn.clicked.connect(self.web_search)
        c.head.addWidget(self.web_btn, 0, Qt.AlignVCenter)
        self.pdf_buttons.append(self.web_btn)
        # 기출 PDF는 사용자가 직접 올린다(2026-11-17 — comcbt 자동 받기 완전 제거: 사이트가 자동 요청을 막았고,
        # 저작권 안내상 받은 자료의 수정·편집은 허용 범위 밖이라 받는 일은 사용자 몫으로 둠). 끌어다 놓는 큰 상자가 중심
        self.drop = DropZone()
        self.drop.clicked.connect(lambda: self.drop.isEnabled() and self.add_files())
        self.drop_hint = self.drop.title
        c.body.addWidget(self.drop)
        row = QHBoxLayout()
        row.setSpacing(8)
        # 버튼 하나 — 파일 고르기 창에서 한 개든 여러 개든(Ctrl·Shift·Ctrl+A) 고름(사용자 2026-11-17)
        b = QPushButton("폴더에서 선택하기")
        b.setToolTip("기출 PDF가 저장된 폴더를 열어 파일을 고릅니다 — 여러 개는 Ctrl·Shift를 누른 채로, 모두는 Ctrl+A")
        b.clicked.connect(self.add_files)
        row.addWidget(b)
        self.pdf_buttons.append(b)
        row.addStretch(1)
        c.body.addLayout(row)
        self.cond_panel = self._conditions_panel()
        c.body.addWidget(self.cond_panel)
        # 목록
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
        for col, w in ((C_KIND, 64), (C_ROUND, 164), (C_PROG, 130), (C_STATUS, 92), (C_MSG, 150)):
            hh.setSectionResizeMode(col, QHeaderView.Interactive)
            self.table.setColumnWidth(col, w)
        self.table.itemChanged.connect(self.on_item_changed)
        self._edit_triggers = self.table.editTriggers()
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
        self.noans_note = Note("warn")           # 정답 표시가 없어 만들지 못한 PDF(사용자 2026-11-17)
        self.noans_note.setVisible(False)
        self.ocr_note = Note("warn")             # 스캔본인데 OCR 기능이 없을 때(ADR 022 1절)
        self.ocr_note.setVisible(False)
        c.body.addWidget(self.ocr_note)
        c.body.addWidget(self.noans_note)
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
        self.run_btn.setObjectName("flowBtn")
        self.run_btn.setProperty("big", True)
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
        lay.addWidget(self.run_btn)
        lay.addWidget(self.stop_btn)
        lay.addLayout(mid, 1)
        lay.addWidget(self.open_out_btn)
        sep = QFrame()
        sep.setObjectName("vsep")
        sep.setFixedWidth(1)
        lay.addWidget(sep)
        step4 = QLabel("4")
        step4.setObjectName("cardStep")
        lay.addWidget(step4, 0, Qt.AlignVCenter)
        self.share_btn = QPushButton("문제팩 공유하기")
        self.share_btn.setObjectName("flowBtn")
        self.share_btn.setProperty("big", True)
        self.share_btn.setToolTip("종목별 문제팩 파일 하나로 내 휴대폰·동료에게 카카오톡·메일로 보냅니다")
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
        if self.qnet_thread is not None or self.worker is not None:     # 문제팩을 만드는 중에는 종목을 바꾸지 않음
            return
        # 다른 종목을 조회하거나, 문제팩을 다 만든 뒤 다시 조회하면 올린 기출 목록을 비움(사용자 2026-11-17 — 콘크리트기사 목록이
        # 남은 채 건설안전산업기사 출제기준으로 오류 표시)
        if self.pdfs and (cert.profile != self.list_code or self.made):
            self.clear_files()
        self.reset_progress()                            # 이전 작업의 진행 막대·안내 글을 비움(실기기 2026-11-17)
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
        self.update_ready()                              # 조회 중에는 작업 순서 버튼을 모두 잠금

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
        up = r.get("upcoming")
        notes = [f"다음 출제기준도 게시돼 있어요({up.title}) — 그날부터 과목·문항 수가 바뀔 수 있어요"] if up else []
        self._use_profile(r["code"])
        # 핵심만(사용자 2026-11-17). 파서 경고(r["warnings"])는 화면에 내지 않음 — 처리에는 영향 없는 표 읽기 참고
        self.picker.show_summary("출제기준 받기 완료!" if not r.get("same") else "출제기준 확인 완료! (최신과 같아요)",
                                 r["code"], notes)

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
                self.picker.show_summary("전에 받은 출제기준을 씁니다", code,
                                         [f"Q-Net에 연결하지 못했어요{f'({why})' if why else ''}"], kind="info")
                return
        self.picker.show_failed(msg)
        self.update_ready()

    def search_query(self) -> str:
        return f"{self.picker.current.name} 필기 기출 PDF" if self.picker.current else ""

    def web_search(self) -> None:
        """조회한 종목으로 기본 브라우저의 구글 검색을 연다 — 검색어 「종목명 필기 기출 PDF」."""
        from urllib.parse import quote
        q = self.search_query()
        if q:
            QDesktopServices.openUrl(QUrl("https://www.google.com/search?q=" + quote(q)))

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
        self.picker.show_summary("출제기준 PDF 읽기 완료!", path.stem)
        _ = warns

    def update_ready(self) -> None:
        """② 기출 PDF는 출제기준이 정해진 뒤에(ADR 021 — 과목이 출제기준에서 오므로)."""
        ready = bool(self.picker.code) and self.qnet_thread is None and self.worker is None \
            and not getattr(self, "running", False)
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
            from ..bundle import PREFIX
            from ..pack import ROUNDS_DIR
            out += sorted(self.out_dir.glob("oneq-*.zip")) + sorted(self.out_dir.glob(f"{PREFIX}*.zip"))
            for sub in ("review", "보낼 문제팩", ROUNDS_DIR):
                if (self.out_dir / sub).exists():
                    out.append(self.out_dir / sub)
        return out

    def reset_all(self) -> None:
        """도움말 › 처음 상태로 되돌리기 — 받아 둔 출제기준·만든 문제팩·처리 보고서·오류 기록을 지움(기출 PDF는 그대로)."""
        if self.worker is not None:
            return
        targets = self.reset_targets()
        root = S.user_root().parent
        msg = ("다음을 지웁니다(기출 PDF는 그대로 둡니다):\n"
               f"· 받아 둔 출제기준 — {root / 'standards'}, {root / 'qnet'}\n"
               f"· 만든 문제팩·처리 기록 — {self.out_dir}\n"
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
        self.cert_locked = False
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
        d = QFileDialog.getExistingDirectory(self, "문제팩 저장 폴더", str(self.out_dir))
        if d:
            self.out_dir = Path(d)
            self.save_settings()

    def add_paths(self, paths: list[Path]) -> None:
        if self.busy_making():
            return
        self.show_conditions(True)                # 파일을 더 넣을 때는 조건 셋을 다시 보여 줌(3단계에서 접음)
        from ..qnet_standard import looks_like_standard
        added = 0
        for p in paths:
            cand = sorted(p.rglob("*.pdf")) if p.is_dir() else ([p] if p.suffix.lower() == ".pdf" else [])
            for c in cand:
                c = c.resolve()
                if not self.picker.code or not self.plan_async:
                    if looks_like_standard(c):      # 출제기준 PDF는 기출 목록이 아니라 종목 출제기준으로
                        self.import_standard_pdf(c)
                        continue
                    if not self.picker.code:        # 출제기준이 정해지기 전엔 기출을 받지 않음
                        continue
                elif c not in self.pdfs:
                    self._std_check.add(c)          # 출제기준 PDF인지는 미리 읽기 스레드에서 함께 봄
                if c not in self.pdfs:
                    self.pdfs.append(c)
                    added += 1
        if added:
            if self.made:                           # 문제팩을 다 만든 목록에 더 넣으면 새 작업으로
                self.made = False
                self.shared = False
            self.cert_locked = True
            self.list_code = self.picker.code
            self.refresh_plan()

    def busy_making(self) -> bool:
        return self.worker is not None or getattr(self, "running", False)

    def add_files(self) -> None:
        if self.busy_making():
            return
        files, _ = QFileDialog.getOpenFileNames(self, "기출 PDF 선택(여러 개는 Ctrl·Shift, 모두는 Ctrl+A)",
                                                self.settings.value("last_dir", ""), "PDF (*.pdf)")
        if files:
            self.settings.setValue("last_dir", str(Path(files[0]).parent))
            self.add_paths([Path(f) for f in files])

    def remove_selected(self) -> None:
        if self.busy_making():
            return
        names = {self.table.item(i.row(), C_FILE).data(Qt.UserRole) for i in self.table.selectionModel().selectedRows()}
        self.pdfs = [p for p in self.pdfs if str(p) not in names]
        self.refresh_plan()

    def reset_progress(self) -> None:
        if self.worker is not None or not hasattr(self, "progress"):
            return
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.status.setText("종목을 고르고 기출 PDF를 넣은 뒤 [문제팩 만들기]를 누르세요.")

    def clear_files(self) -> None:
        self._start_after_plan = None
        self.show_conditions(True)
        self.reset_progress()
        self.bundle = None
        self.made = False
        self.shared = False
        if hasattr(self, "bundle_note"):
            self.bundle_note.setVisible(False)
            self.law_note.setVisible(False)
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
            self.rows = self.plan_rows(code)
            other = [r for r in self.rows if r.other_cert]
            if other:                                   # ①에서 조회한 종목이 아닌 기출은 목록에 넣지 않음(사용자 2026-11-17)
                drop = {r.pdf for r in other}
                self.pdfs = [p for p in self.pdfs if p not in drop]
                self.rows = [r for r in self.rows if r.pdf not in drop]
                QTimer.singleShot(0, lambda o=other: self.warn_other_cert(o))
        elif self.pdfs:
            self.rows = [RoundResult(pdf=p, message="종목을 먼저 고르세요") for p in sorted(self.pdfs, key=lambda x: x.name)]
        else:
            self.rows = []
        self.render_rows()
        self.law_note.setVisible(False)
        self.bundle_note.setVisible(False)
        self.noans_note.setVisible(False)
        self.update_ocr_note()
        self.peek_timer.start()
        self.update_flow()

    def warn_other_cert(self, rows: list[RoundResult]) -> None:
        name = self.picker.current.name if self.picker.current else "조회한 종목"
        lines = "\n".join(f"· {r.pdf.name} — {r.other_cert}" for r in rows[:12]) + \
            (f"\n· … 외 {len(rows) - 12}개" if len(rows) > 12 else "")
        QMessageBox.warning(self, APP_NAME,
                            f"「{name}」이(가) 아닌 종목의 기출 PDF {len(rows)}개는 올리지 않았어요.\n\n{lines}\n\n"
                            f"다른 종목은 ① 종목 선택에서 그 종목을 조회한 뒤 올려 주세요.")

    def _plan_key(self, p: Path, code: str, spec: BatchSpec) -> tuple:
        try:
            mt = p.stat().st_mtime_ns
        except OSError:
            mt = 0
        return (str(p), mt, code, spec.date_of(p), spec.round_no)

    def plan_rows(self, code: str) -> list[RoundResult]:
        """읽어 둔 회차는 기억한 것으로, 새 파일은 다른 스레드에서 읽고 그동안 '읽는 중'으로 보인다."""
        import dataclasses
        spec, prof = self.spec(), S.load(code)
        keys = {p: self._plan_key(p, code, spec) for p in self.pdfs}
        missing = [p for p in self.pdfs if keys[p] not in self.plan_cache]
        if missing and not self.plan_async:              # 시험용: 바로 읽음
            from .. import examinfo
            names = examinfo.known_cert_names()
            for p in missing:
                self.plan_cache[keys[p]] = plan_one(p, prof, spec, names)
            missing = []
        # PDF를 읽는 일은 한 번에 한 스레드만(pdfium은 여러 스레드에서 동시에 쓰면 안 됨) — 미리 보기·처리 중이면 끝난 뒤 이어서
        if missing and self.plan_thread is None and self.peek_thread is None and self.worker is None \
                and not getattr(self, "_closing", False):
            self.plan_thread = QThread(self)
            w = PlanWorker({p: keys[p] for p in missing}, missing, prof, spec, set(self._std_check))
            w.moveToThread(self.plan_thread)
            self.plan_thread.started.connect(w.run)
            w.done.connect(self.on_plan)
            w.done.connect(self.plan_thread.quit)
            self.plan_thread.finished.connect(self._plan_finished)
            self._plan_worker = w
            self.plan_thread.start()
        rows = []
        for p in sorted(self.pdfs, key=lambda x: x.name):
            r = self.plan_cache.get(keys[p])
            rows.append(dataclasses.replace(r, issues=list(r.issues)) if r is not None
                        else RoundResult(pdf=p, message="PDF 읽는 중…"))
        return mark_duplicates(rows)

    def planning(self) -> bool:
        return self.plan_thread is not None or any(r.message == "PDF 읽는 중…" for r in self.rows)

    def on_plan(self, keys: dict, out: dict) -> None:
        std = []
        for p, (kind, r) in out.items():
            self._std_check.discard(p)
            if kind == "standard":
                std.append(p)
            else:
                self.plan_cache[keys[p]] = r
        for p in std:                                     # 출제기준 PDF는 기출 목록이 아니라 종목 출제기준으로
            if p in self.pdfs:
                self.pdfs.remove(p)
            self.import_standard_pdf(p)

    def _plan_finished(self) -> None:
        self.plan_thread.deleteLater()
        self.plan_thread = None
        if self.worker is None:
            self.refresh_plan()                           # 읽은 결과를 보이고, 그사이 더 들어온 파일이 있으면 이어서 읽음
        self.update_ready()
        want = getattr(self, "_start_after_plan", None)
        if want is not None and self.worker is None and not self.planning():
            self._start_after_plan = None
            self.start(want or None)

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
        self.fit_list()
        # 보충 문서(ADR 032)는 같은 회차 원본에 더하므로 같은 팩 이름이어도 겹침이 아님
        dup = {r.pack_id for r in self.rows if r.pack_id and not r.supplement
               and sum(x.pack_id == r.pack_id and not x.supplement for x in self.rows) > 1}
        for i, r in enumerate(self.rows):
            # 시행일은 문서 내용에서 읽고, 못 찾으면 "0000년 nn회"로 자동(ADR 021 2절) — 칸을 두 번 눌러 고칠 수는 있음
            needs_date = r.date.startswith("0000") or r.date.endswith("-00")
            st_text = STATUS_TEXT.get(r.status, r.status)
            msg = r.message
            if r.pack_id in dup and r.status == "waiting":
                msg = "같은 회차 PDF가 두 번 들어갔는지 확인하세요"
            done = r.status in ("packed", "review")
            early = r.status == "running" and r.prepared is not None     # 처리 중에 끝난 파일(B3 ②) — 정답 확인·팩만 남음
            if early:
                msg = f"{len(r.prepared.items)}문항"   # '결과 보기'는 없앰(사용자 2026-11-16)
            elif r.status == "packed":
                msg = r.message if r.supplement else f"{r.questions}문항"
            elif r.status == "review":
                msg = f"{r.questions}문항"
            prog = 1.0 if done else 0.0 if r.status in ("error", "skipped") else stage_progress(r)
            stage = {"waiting": "대기", "running": STAGE_LABEL.get(r.stage, r.stage) or "시작", "error": "중단", "skipped": "건너뜀"}.get(r.status, "끝")
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
        self._building = False
        n = len(self.rows)
        packed = sum(r.status == "packed" and not r.supplement for r in self.rows)
        kinds = {k: sum(r.kind == k for r in self.rows) for k in ("글자", "스캔", "섞임")}
        ktxt = " · ".join(f"{k} {v}" for k, v in kinds.items() if v)
        self.summary.setText((f"PDF {n}개" + (f" ({ktxt})" if ktxt else "") + (f" · 문제팩 {packed}개 완료" if packed else "")) if n else "")
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
        if self.plan_thread is not None or self.worker is not None or getattr(self, "_closing", False):   # 목록 읽기·처리가 끝나면 다시 불림
            return
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
        if self.worker is None and any(r.message == "PDF 읽는 중…" for r in self.rows):
            self.refresh_plan()                           # 미리 보기 때문에 미뤄 둔 목록 읽기

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
        title = "과목 개편 — 현행 출제기준으로 정리해 문제팩을 만듭니다" if cs.changed else "과목 구성 확인"
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
        ids = [r.pack_id for r in self.rows if r.pdf in pdfs and r.pack_id and not r.supplement]
        if len(ids) != len(set(ids)):
            return "같은 팩 이름이 둘 이상입니다. 같은 회차 PDF가 두 번 들어갔는지 확인하세요."
        years = {i.rsplit("-", 2)[-2] for i in ids}
        sup = {r.pack_id for r in self.rows if r.pdf in pdfs and r.supplement and r.pack_id}
        orphan = {i for i in sup if i not in ids and i.rsplit("-", 2)[-2] not in years}
        if orphan:
            return ("보충 문서는 원본 회차 PDF와 함께 올려 주세요 — 원본이 없는 회차: "
                    + ", ".join(sorted(orphan)))
        return None

    def start(self, pdfs: list[Path] | None = None) -> None:
        if self.planning():                     # 목록을 다 읽으면 바로 이어서 시작(사용자 2026-11-16 — 다시 누르게 하지 않음)
            self._start_after_plan = list(pdfs) if pdfs else []
            self.status.setText("목록의 PDF를 읽고 있어요 — 다 읽으면 바로 문제팩 만들기를 시작합니다")
            return
        pdfs = list(pdfs) if pdfs else list(self.pdfs)
        msg = self.check_inputs(pdfs)
        if msg:
            QMessageBox.warning(self, APP_NAME, msg)
            return
        # 열 수 없거나 다른 종목 문서인 파일은 건너뛰고 나머지만(목록에 이유가 보임)
        skip = {r.pdf for r in self.rows if r.status == "error" and not r.pack_id}
        pdfs = [p for p in pdfs if p not in skip]
        # 목록의 회차가 모두 이미 문제팩으로 있으면 먼저 묻는다(사용자 2026-11-16 — 있는데 말없이 다시 만들었음)
        ids = [r.pack_id for r in self.rows if r.pdf in pdfs and r.pack_id and not r.supplement]
        from ..pack import rounds_dir
        rd = rounds_dir(self.out_dir)
        if ids and len(ids) == len([r for r in self.rows if r.pdf in pdfs and not r.supplement]) and all((rd / f"oneq-{i}.zip").exists() for i in ids):
            box = QMessageBox(self)
            box.setWindowTitle(APP_NAME)
            box.setIcon(QMessageBox.Information)
            box.setText(f"이 {len(ids)}회차는 이미 문제팩으로 만들어 두었어요.")
            box.setInformativeText("바로 보내려면 [문제팩 공유하기], 프로그램이 새로 바뀌었거나 다시 확인하려면 [다시 만들기].")
            share = box.addButton("문제팩 공유하기", QMessageBox.AcceptRole)
            again = box.addButton("다시 만들기", QMessageBox.DestructiveRole)
            box.addButton("취소", QMessageBox.RejectRole)
            box.setDefaultButton(share)
            box.exec()
            if box.clickedButton() is share:
                self.show_share()
                return
            if box.clickedButton() is not again:
                return
        self.save_settings()
        self.bundle = None
        spec = self.spec(pdfs)
        for r in self.rows:
            if r.pdf in pdfs:
                r.status, r.message = "waiting", ""
        self.render_rows()
        self.set_running(True)
        self.done = 0
        self.total_rounds = len(pdfs)
        self.run_pdfs = set(pdfs)
        self.progress.setRange(0, 1000)          # 회차별 단계 진행을 합쳐 꾸준히 차오르게(사용자 2026-11-17)
        self.progress.setValue(0)
        self.started = time.monotonic()
        # 문제팩을 만드는 동안에는 업로드 조건 셋을 접어 PDF 목록을 크게(사용자 2026-11-18) — 파일을 더 넣거나 목록을 비우면 다시 보임
        self.show_conditions(False)
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
        """문제팩을 만드는 동안에는 [멈추기]만 — 끌어다 놓기 상자·[폴더에서 선택하기]·목록 버튼·표 고치기·끌어다 놓기도 잠금
        (실기기 2026-11-17: 만드는 중에 상자를 누르거나 [폴더에서 선택하기]가 눌렸음 — set_running이 작업을 만들기 전에 불려
        worker가 아직 없어 '준비됨'으로 판단했다)."""
        self.running = on
        self.stop_btn.setEnabled(on)
        self.picker.setEnabled(not on)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers if on else self._edit_triggers)
        self.update_ready()
        self.setAcceptDrops(not on)

    def update_progress(self) -> None:
        """전체 진행 = 처리하는 회차들의 단계 진행 평균. 마지막(묶음 쓰기)까지 1000의 98%로, 끝나면 100%."""
        rows = [r for r in self.rows if r.pdf in getattr(self, "run_pdfs", set())]
        if not rows:
            return
        frac = sum(stage_progress(r) for r in rows) / len(rows)
        self.progress.setValue(max(self.progress.value(), int(980 * frac)))

    def tick(self) -> None:
        sec = int(time.monotonic() - self.started)
        total = getattr(self, "total_rounds", 0)
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
            self.update_progress()
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
        self.made = any(r.status == "packed" for r in rows)
        if self.made:
            self.cert_locked = False                     # 문제팩을 다 만들면 다른 종목 조회 가능
        self.progress.setValue(self.progress.maximum())
        self.set_running(False)
        sec = int(time.monotonic() - self.started)
        ok = sum(r.status == "packed" and not r.supplement for r in rows)
        rev = sum(r.status == "review" for r in rows)
        err = sum(r.status == "error" for r in rows)
        skip = sum(r.status == "skipped" for r in rows)
        text = f"끝 — 문제팩 {ok}개" + (f" · 만들지 못함 {rev}개" if rev else "") + (f" · 오류 {err}개" if err else "") + \
               (f" · 건너뜀 {skip}개" if skip else "") + \
               f" · {sec // 60}분 {sec % 60}초"
        self.status.setText(text)
        if self.bundle:
            self.bundle_note.set("ok", f"종목 묶음 저장: {self.bundle.name}",
                                 [f"이 종목의 모든 회차를 파일 하나에 담았어요 — "
                                  "학습앱 [문제팩 가져오기]로 넣거나 ④ [문제팩 공유하기]로 보내세요."])
        else:
            self.bundle_note.setVisible(False)
        from ..pack import FEW_QUESTIONS_ISSUE, NO_ANSWER_NOTE
        # 정답 표시가 없어도 문항은 만듦(정답은 학습앱에서 지정) — 교사용 PDF 조건은 안내로 남김(사용자 2026-11-17)
        noans = [r for r in rows if r.status == "packed" and r.prepared is not None and NO_ANSWER_NOTE in r.prepared.notes]
        few = [r for r in rows if r.status == "review" and r.message == FEW_QUESTIONS_ISSUE]

        def names(rs):
            return [f"{r.pdf.name}" for r in rs[:8]] + ([f"… 외 {len(rs) - 8}개"] if len(rs) > 8 else [])
        if noans or few:
            body = []
            if noans:
                body += [f"정답 표시를 대부분 찾지 못한 PDF {len(noans)}개 — 문항은 만들었어요:"] + names(noans) \
                    + ["정답은 학습앱에서 처음 풀 때 지정할 수 있어요. 정답이 표시된 PDF(교사용 — 칠한 번호·형광펜·끝 정답표)를 "
                       "올리면 정답까지 들어갑니다(조건 2)"]
            if few:
                body += [f"문항을 절반도 만들지 못한 스캔본 {len(few)}개:"] + names(few) + ["더 선명한 PDF가 있으면 다시 올려 주세요"]
            title = (f"PDF {len(few)}개는 문제팩을 만들지 못했어요" if few and not noans else
                     f"정답 표시가 없는 PDF {len(noans)}개 — 정답은 학습앱에서 지정" if noans and not few else
                     f"정답 표시가 없는 PDF {len(noans)}개 · 만들지 못한 PDF {len(few)}개")
            self.noans_note.set("warn", title, body)
        else:
            self.noans_note.setVisible(False)
        lines = law_summary(self.rows)
        if lines:
            self.law_note.set("warn", "법령·기준 개정 주의", lines)
        else:
            self.law_note.setVisible(False)

    def open_result(self, row: int, col: int) -> None:
        """끝난 파일을 누르면 결과 화면 — 처리 중에도 먼저 끝난 파일은 바로 열림(B3 ②)."""
        if row >= len(self.rows) or (col == C_ROUND and self.worker is None):
            return
        if self.worker is not None:          # 처리 중에는 열지 않음(사용자 2026-11-16 — 처리 중 '결과 보기' 불필요)
            return
        r = self.rows[row]
        if r.prepared is None:
            if r.status == "error" and r.message:
                QMessageBox.information(self, APP_NAME, r.message)
            return
        ResultDialog(r, self, pending=self.worker is not None and r.status == "running").exec()

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
        # 닫은 뒤 새 스레드가 생기지 않게 하고, 돌고 있는 것은 끝날 때까지 기다림(Windows: 실행 중인 QThread가 지워지면 프로그램이 죽음)
        self._closing = True
        self.peek_timer.stop()
        self._start_after_plan = None
        if self.plan_thread:
            self.plan_thread.quit()
            self.plan_thread.wait(30_000)
        if self.peek_thread:
            self.peek_thread.quit()
            self.peek_thread.wait(10_000)
        if self.qnet_thread:
            self.qnet_thread.quit()
            self.qnet_thread.wait(10_000)
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
        if issubclass(kind, KeyboardInterrupt):   # 실행한 PowerShell 창에서 Ctrl+C·창 닫기 — 오류가 아니라 조용히 끝냄
            QApplication.quit()
            return
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
