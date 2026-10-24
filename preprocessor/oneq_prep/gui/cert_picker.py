"""① 종목 — 이름을 입력하고 [조회] → Q-Net에서 최신 출제기준을 받아 온다(ADR 019 검색 + ADR 021 1절, 사용자 흐름 2026-10-24).

상태 셋:
- 조회 중: "Q-Net에서 최신 출제기준을 조회합니다." + 움직이는 막대
- 됨: ✓ Q-Net 출제기준 기간 · 과목·문항·단원
- 못 받음: 이유(연결 안 됨 / Q-Net 화면이 바뀜 / 종목 없음) + 출제기준 PDF 올리기 상자 + 받는 방법
"""
from __future__ import annotations

from PySide6.QtCore import QStringListModel, Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QCompleter, QFrame, QHBoxLayout, QLabel, QLineEdit, QProgressBar, QPushButton,
                               QVBoxLayout, QWidget)

from .. import standards as S
from ..certs import Cert, catalog, search
from .widgets import Note

MARK = "  ✓ 출제기준 있음"
QNET_BOARD = "https://www.q-net.or.kr/cst006.do?id=cst00601&gSite=Q&gId="
HOW_TO = ("내려받는 방법: Q-Net 출제기준 자료실 → 분류 '출제기준'에서 종목명 검색 → 제목 누르기 → "
          "보기 창 위쪽 [저장] → PDF")


class UploadBox(QFrame):
    """출제기준 PDF 올리기 상자 — 누르면 파일 고르기, 창 어디에 끌어다 놓아도 됨(MainWindow가 출제기준 PDF를 알아봄)."""
    clicked = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("dropZone")
        self.setCursor(Qt.PointingHandCursor)
        self.setMinimumHeight(84)
        v = QVBoxLayout(self)
        v.setContentsMargins(12, 14, 12, 14)
        v.setSpacing(4)
        t = QLabel("출제기준 PDF를 여기로 끌어다 놓기")
        t.setObjectName("dropTitle")
        t.setAlignment(Qt.AlignCenter)
        t.setWordWrap(True)
        s = QLabel("누르면 파일을 고를 수 있어요")
        s.setObjectName("muted")
        s.setAlignment(Qt.AlignCenter)
        v.addWidget(t)
        v.addWidget(s)

    def mouseReleaseEvent(self, e):  # noqa: N802
        if e.button() == Qt.LeftButton:
            self.clicked.emit()


class CertPicker(QWidget):
    changed = Signal(object)          # Cert | None — 쓸 수 있는 출제기준이 정해짐(또는 바뀜)
    want_profile = Signal(object)     # Cert — [과목 직접 입력]
    want_qnet = Signal(object)        # Cert — [조회]: Q-Net에서 최신 출제기준 받기
    want_upload = Signal()            # 출제기준 PDF 고르기

    def __init__(self, parent=None):
        super().__init__(parent)
        self.certs: list[Cert] = catalog()
        self.current: Cert | None = None
        self._by_text: dict[str, Cert] = {}
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)

        row = QHBoxLayout()
        row.setSpacing(8)
        self.edit = QLineEdit()
        self.edit.setPlaceholderText("자격종목명 — 예: 토목기사, 측량, 건안기")
        self.edit.setClearButtonEnabled(True)
        self.model = QStringListModel(self)
        self.comp = QCompleter(self.model, self)
        self.comp.setCompletionMode(QCompleter.UnfilteredPopupCompletion)
        self.comp.setCaseSensitivity(Qt.CaseInsensitive)
        self.comp.setMaxVisibleItems(12)
        self.edit.setCompleter(self.comp)
        self.edit.textEdited.connect(self._suggest)
        self.comp.activated[str].connect(self._chosen)
        self.edit.returnPressed.connect(self.query)
        self.b_query = QPushButton("조회")
        self.b_query.setObjectName("primarySmall")
        self.b_query.clicked.connect(self.query)
        row.addWidget(self.edit, 1)
        row.addWidget(self.b_query)
        lay.addLayout(row)

        # 조회 중
        self.busy = QWidget()
        bv = QVBoxLayout(self.busy)
        bv.setContentsMargins(0, 2, 0, 2)
        bv.setSpacing(6)
        self.busy_text = QLabel("Q-Net에서 최신 출제기준을 조회합니다.")
        self.busy_bar = QProgressBar()
        self.busy_bar.setRange(0, 0)                 # 움직이는 막대(끝을 모름)
        bv.addWidget(self.busy_text)
        bv.addWidget(self.busy_bar)
        self.busy.setVisible(False)
        lay.addWidget(self.busy)

        # 됨
        self.info = QLabel()
        self.info.setObjectName("muted")
        self.info.setWordWrap(True)
        self.info.setTextFormat(Qt.RichText)
        self.info.setVisible(False)
        lay.addWidget(self.info)
        self.qnet = Note("info")                     # 참고(다음 기준 게시 등) — 못 받음 상자와 따로
        self.qnet.setVisible(False)
        lay.addWidget(self.qnet)

        # 못 받음: 이유 + 올리기 상자 + 받는 방법
        self.fail = Note("warn")
        self.upload = UploadBox()
        self.upload.clicked.connect(self.want_upload.emit)
        self.fail.layout().addWidget(self.upload)
        how = QLabel(HOW_TO)
        how.setObjectName("muted")
        how.setWordWrap(True)
        self.fail.layout().addWidget(how)
        frow = QHBoxLayout()
        b_open = QPushButton("Q-Net 자료실 열기")
        b_open.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(QNET_BOARD)))
        b_retry = QPushButton("다시 조회")
        b_retry.clicked.connect(self.query)
        frow.addWidget(b_open)
        frow.addWidget(b_retry)
        frow.addStretch(1)
        self.fail.layout().addLayout(frow)
        self.b_profile = QPushButton("PDF가 없으면 과목 직접 입력")
        self.b_profile.setObjectName("link")
        self.b_profile.clicked.connect(lambda: self.current and self.want_profile.emit(self.current))
        self.fail.layout().addWidget(self.b_profile, 0, Qt.AlignLeft)
        self.fail.setVisible(False)
        lay.addWidget(self.fail)
        self.missing = self.fail                     # v0.4 이름(시험 호환)

    # ── 검색·조회 ──
    def reload(self) -> None:
        self.certs = catalog()

    def _suggest(self, text: str) -> None:
        found = search(text, self.certs)
        self._by_text = {c.name + (MARK if c.profile else ""): c for c in found}
        self.model.setStringList(list(self._by_text))
        if found:
            self.comp.complete()

    def _chosen(self, text: str) -> None:
        cert = self._by_text.get(text) or next((c for c in self.certs if c.name == text.replace(MARK, "")), None)
        if cert:
            self.select(cert, query=True)

    def query(self) -> None:
        """[조회]/Enter: 입력한 이름(줄임말 허용)으로 종목을 정하고 Q-Net에 최신 출제기준을 묻는다."""
        text = self.edit.text().strip()
        if not text:
            return
        found = search(text, self.certs, limit=1)
        cert = found[0] if found else Cert(text)    # 목록에 없는 이름도 Q-Net에 그대로 물어봄
        self.select(cert, query=True)

    def select_code(self, code: str, query: bool = False) -> bool:
        for c in self.certs:
            if c.profile == code:
                self.select(c, query=query)
                return True
        return False

    def select(self, cert: Cert, query: bool = False) -> None:
        self.current = cert
        self.edit.setText(cert.name)
        self.fail.setVisible(False)
        self.qnet.setVisible(False)
        self.show_profile()
        self.changed.emit(cert)
        if query:
            self.want_qnet.emit(cert)

    def show_profile(self) -> None:
        cert = self.current
        if not (cert and cert.profile):
            self.info.setVisible(False)
            return
        p = S.load(cert.profile)
        q = sum(s["count"] for s in p.subjects)
        subj = " · ".join(s["name"] for s in p.subjects)
        units = sum(len(p.units(x["name"])) for x in p.subjects)
        if p.period:   # Q-Net 출제기준 PDF에서 읽은 프로필(ADR 021 1절)
            head = (f"<span style='color:#1f7a4d;font-weight:600'>✓ Q-Net 출제기준</span> "
                    f"{p.period['from'].replace('-', '.')} ~ {p.period['to'].replace('-', '.')}")
        else:
            head = f"<span style='color:#1f7a4d;font-weight:600'>✓ 출제기준 등록</span> · {p.version} 기준"
        self.info.setText(f"{head} · {len(p.subjects)}과목 {q}문항" + (f" · 단원 {units}개" if units else "")
                          + f"<br>{subj}")
        self.info.setVisible(True)

    # ── 조회 상태 ──
    def set_busy(self, on: bool) -> None:
        self.busy.setVisible(on)
        self.b_query.setEnabled(not on)
        self.edit.setEnabled(not on)
        if on:
            self.fail.setVisible(False)
            self.qnet.setVisible(False)

    def show_failed(self, message: str) -> None:
        """제목 = 이유(첫 문장), 본문 = 할 일. 예: "Q-Net 웹페이지 화면이 바뀌어 …" / "Q-Net에서 출제기준을 직접 내려받아 …" """
        self.set_busy(False)
        head, _, rest = message.partition(". ")
        self.fail.set("warn", head.rstrip(".") + ".", [rest] if rest else [])
        self.fail.text.setText(rest)               # 글머리표 없이
        self.fail.setVisible(True)

    def set_qnet(self, kind: str, title: str, lines: list[str], busy: bool = False) -> None:
        """참고 안내(받았음·다음 기준 게시 등)."""
        self.set_busy(busy)
        self.qnet.set(kind, title, lines)

    @property
    def code(self) -> str | None:
        return self.current.profile if self.current and self.current.profile else None
