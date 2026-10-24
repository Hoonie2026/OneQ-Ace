"""공용 화면 부품 — 카드, 안내 상자, 상태 배지, 끌어다 놓기 상자."""
from __future__ import annotations

from PySide6.QtCore import QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPixmap
from PySide6.QtWidgets import (QFrame, QGraphicsDropShadowEffect, QHBoxLayout, QLabel, QStyle, QStyledItemDelegate,
                               QStyleOptionViewItem, QVBoxLayout, QWidget)

from . import theme


class Card(QFrame):
    """둥근 흰 카드: [번호] 제목 · 보조 설명 + 내용. 기본 묶음 상자(QGroupBox)처럼 제목이 테두리에 걸려 잘리지 않음."""

    def __init__(self, title: str, step: str = "", hint: str = "", parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("card")
        sh = QGraphicsDropShadowEffect(self)
        sh.setBlurRadius(18)
        sh.setOffset(0, 2)
        sh.setColor(QColor(15, 23, 42, 18))
        self.setGraphicsEffect(sh)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(20, 18, 20, 20)
        lay.setSpacing(12)
        head = QHBoxLayout()
        head.setSpacing(10)
        if step:
            s = QLabel(step)
            s.setObjectName("cardStep")
            head.addWidget(s, 0, Qt.AlignVCenter)
        t = QLabel(title)
        t.setObjectName("cardTitle")
        head.addWidget(t, 0, Qt.AlignVCenter)
        head.addStretch(1)
        self.head = head
        lay.addLayout(head)
        if hint:
            h = QLabel(hint)
            h.setObjectName("cardHint")
            h.setWordWrap(True)
            lay.addWidget(h)
        self.body = lay


class Note(QFrame):
    """안내 상자(파랑·노랑·초록·빨강). 제목 + 줄들."""

    def __init__(self, kind: str = "info", parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("note")
        self.setProperty("kind", kind)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(14, 12, 14, 12)
        lay.setSpacing(4)
        self.title = QLabel()
        self.title.setObjectName("noteTitle")
        self.title.setWordWrap(True)
        self.text = QLabel()
        self.text.setWordWrap(True)
        self.text.setTextFormat(Qt.RichText)
        lay.addWidget(self.title)
        lay.addWidget(self.text)

    def set(self, kind: str, title: str, lines: list[str]) -> None:
        self.setProperty("kind", kind)
        self.style().unpolish(self)
        self.style().polish(self)
        self.title.setText(title)
        self.text.setText("<br>".join(f"• {x}" for x in lines))
        self.setVisible(bool(title or lines))


class BadgeDelegate(QStyledItemDelegate):
    """상태 칸을 둥근 색 배지로 그린다. 칸의 UserRole에 상태 키(waiting·packed …)."""

    def paint(self, painter: QPainter, option: QStyleOptionViewItem, index) -> None:
        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        text = opt.text
        opt.text = ""
        opt.widget.style().drawControl(QStyle.CE_ItemViewItem, opt, painter, opt.widget)
        if not text:
            return                                   # 빈 칸엔 배지를 그리지 않음
        key = index.data(Qt.UserRole) or "waiting"
        fg, bg = theme.STATUS.get(key, theme.STATUS["waiting"])
        painter.save()
        painter.setRenderHint(QPainter.Antialiasing)
        f = QFont(opt.font)
        f.setPixelSize(12)
        f.setWeight(QFont.DemiBold)
        painter.setFont(f)
        fm = painter.fontMetrics()
        w = fm.horizontalAdvance(text) + 20
        h = 24
        r = QRectF(opt.rect.x() + 6, opt.rect.center().y() - h / 2 + 1, w, h)
        path = QPainterPath()
        path.addRoundedRect(r, 12, 12)
        painter.fillPath(path, QColor(bg))
        painter.setPen(QColor(fg))
        painter.drawText(r, Qt.AlignCenter, text)
        painter.restore()

    def sizeHint(self, option, index) -> QSize:
        s = super().sizeHint(option, index)
        return QSize(s.width() + 28, max(s.height(), 36))


class ProgressDelegate(QStyledItemDelegate):
    """파일별 진행 막대(ADR 021 6절): UserRole = 0~1, UserRole+1 = 상태 키, 글자 = 지금 단계."""

    def paint(self, painter: QPainter, option: QStyleOptionViewItem, index) -> None:
        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        text = opt.text
        opt.text = ""
        opt.widget.style().drawControl(QStyle.CE_ItemViewItem, opt, painter, opt.widget)
        v = float(index.data(Qt.UserRole) or 0.0)
        key = index.data(Qt.UserRole + 1) or "waiting"
        fg = {"packed": theme.OK, "review": theme.WARN, "error": theme.BAD}.get(key, theme.PRIMARY)
        painter.save()
        painter.setRenderHint(QPainter.Antialiasing)
        r = opt.rect.adjusted(8, 0, -8, 0)
        bar = QRectF(r.x(), r.center().y() + 4, r.width(), 6)
        path = QPainterPath()
        path.addRoundedRect(bar, 3, 3)
        painter.fillPath(path, QColor(theme.GRAY_SOFT))
        if v > 0:
            done = QRectF(bar.x(), bar.y(), max(6.0, bar.width() * min(v, 1.0)), bar.height())
            p2 = QPainterPath()
            p2.addRoundedRect(done, 3, 3)
            painter.fillPath(p2, QColor(fg))
        f = QFont(opt.font)
        f.setPixelSize(12)
        painter.setFont(f)
        painter.setPen(QColor(theme.MUTED))
        painter.drawText(QRectF(r.x(), r.y() + 2, r.width(), r.height() / 2 + 2), Qt.AlignLeft | Qt.AlignVCenter, text)
        painter.restore()


class DropZone(QFrame):
    """PDF가 없을 때 보이는 점선 상자. 누르면 파일 고르기."""
    clicked = Signal()

    def __init__(self, logo: QPixmap | None = None, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("dropZone")
        self.setCursor(Qt.PointingHandCursor)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 32, 24, 32)
        lay.setSpacing(8)
        lay.addStretch(1)
        icon = QLabel("📄")
        icon.setAlignment(Qt.AlignCenter)
        icon.setStyleSheet("font-size: 40px;")
        t = QLabel("기출 PDF를 여기로 끌어다 놓으세요")
        t.setObjectName("dropTitle")
        self.title = t
        t.setAlignment(Qt.AlignCenter)
        s = QLabel("폴더째 놓아도 됩니다 · 누르면 파일을 고를 수 있어요\n종목·시행일·회차는 문서 내용에서 읽습니다(파일 이름은 상관없어요)")
        s.setObjectName("muted")
        s.setAlignment(Qt.AlignCenter)
        for w in (icon, t, s):
            lay.addWidget(w)
        lay.addStretch(1)

    def set_active(self, on: bool) -> None:
        self.setProperty("active", on)
        self.style().unpolish(self)
        self.style().polish(self)

    def mouseReleaseEvent(self, e):  # noqa: N802
        if e.button() == Qt.LeftButton:
            self.clicked.emit()


def field_label(text: str) -> QLabel:
    lab = QLabel(text)
    lab.setObjectName("fieldLabel")
    return lab
