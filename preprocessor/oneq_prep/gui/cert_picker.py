"""종목 검색 입력(드롭다운 대신) — "측량", "건안기", "건설 안전" … 자동완성(ADR 019)."""
from __future__ import annotations

from PySide6.QtCore import QStringListModel, Qt, Signal
from PySide6.QtWidgets import QCompleter, QHBoxLayout, QLabel, QLineEdit, QPushButton, QVBoxLayout, QWidget

from .. import standards as S
from ..certs import Cert, catalog, search
from .widgets import Note

MARK = "  ✓ 출제기준 있음"


class CertPicker(QWidget):
    changed = Signal(object)          # Cert | None
    want_profile = Signal(object)     # Cert — [과목 직접 입력]

    def __init__(self, parent=None):
        super().__init__(parent)
        self.certs: list[Cert] = catalog()
        self.current: Cert | None = None
        self._by_text: dict[str, Cert] = {}
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(10)
        self.edit = QLineEdit()
        self.edit.setPlaceholderText("종목 이름으로 찾기 — 예: 측량, 건안기, 토목, 전기")
        self.edit.setClearButtonEnabled(True)
        self.model = QStringListModel(self)
        self.comp = QCompleter(self.model, self)
        self.comp.setCompletionMode(QCompleter.UnfilteredPopupCompletion)
        self.comp.setCaseSensitivity(Qt.CaseInsensitive)
        self.comp.setMaxVisibleItems(12)
        self.edit.setCompleter(self.comp)
        self.edit.textEdited.connect(self._suggest)
        self.comp.activated[str].connect(self._chosen)
        self.edit.returnPressed.connect(self._enter)
        lay.addWidget(self.edit)

        self.info = QLabel()
        self.info.setObjectName("muted")
        self.info.setWordWrap(True)
        self.info.setTextFormat(Qt.RichText)
        lay.addWidget(self.info)
        self.missing = Note("warn")
        row = QHBoxLayout()
        self.b_profile = QPushButton("과목 직접 입력")
        self.b_profile.clicked.connect(lambda: self.current and self.want_profile.emit(self.current))
        row.addWidget(self.b_profile)
        row.addStretch(1)
        self.missing.layout().addLayout(row)
        self.missing.setVisible(False)
        lay.addWidget(self.missing)

    # ── 검색 ──
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
            self.select(cert)

    def _enter(self) -> None:
        found = search(self.edit.text(), self.certs, limit=1)
        if found:
            self.select(found[0])

    def select_code(self, code: str) -> bool:
        for c in self.certs:
            if c.profile == code:
                self.select(c)
                return True
        return False

    def select(self, cert: Cert) -> None:
        self.current = cert
        self.edit.setText(cert.name)
        if cert.profile:
            p = S.load(cert.profile)
            q = sum(s["count"] for s in p.subjects)
            subj = " · ".join(s["name"] for s in p.subjects)
            mine = " · 이 PC에서 입력" if S.is_user_profile(cert.profile) else ""
            self.info.setText(f"<span style='color:#1f7a4d;font-weight:600'>✓ 출제기준 등록</span> "
                              f"· {len(p.subjects)}과목 {q}문항 · {p.version} 기준{mine}<br>{subj}")
            self.info.setVisible(True)
            self.missing.setVisible(False)
        else:
            self.info.setVisible(False)
            self.missing.set("warn", "출제기준(과목 구성)이 아직 없습니다",
                             ["팩은 현행 과목 기준으로 만들어지므로 먼저 과목명과 문항 수를 등록해야 합니다.",
                              "큐넷의 종목 정보에서 필기 과목을 확인해 [과목 직접 입력]으로 한 번만 적으면 됩니다."])
        self.changed.emit(cert)

    @property
    def code(self) -> str | None:
        return self.current.profile if self.current and self.current.profile else None
