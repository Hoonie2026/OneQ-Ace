"""올리는 기출 PDF 조건 셋의 예시 그림(ADR 021 3절, B3) — 그림 파일 없이 코드로 그린다(실행파일에 넣을 것 없음, 크게 봐도 선명).

조건마다 그림 하나: ① 한 파일 = 한 회차(✓ 회차별 파일 / ✗ 합본) ② 정답이 파일 안에(칠한 번호·형광펜·끝 정답표 — 셋 중 하나)
③ 알아볼 수 있는 품질(✓ 반듯한 스캔·글자 PDF / ✗ 기울고 흐린 사진). 누르면 크게 보는 창.
화면 문구·디자인 손질은 E에서(사용자 2026-10-24).
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QDialog, QHBoxLayout, QLabel, QPushButton, QSizePolicy, QVBoxLayout, QWidget

from . import theme

W, H = 320.0, 120.0          # 그림의 논리 크기(위젯 크기에 맞춰 비율 그대로 늘림)
INK = QColor("#334155")
FAINT = QColor("#94a3b8")
PAPER = QColor("#ffffff")
LINE = QColor("#cbd5e1")
HIGHLIGHT = QColor(255, 225, 60, 190)
GOOD = QColor(theme.OK)
BAD = QColor(theme.BAD)

TITLES = ["한 파일 = 한 회차", "정답이 파일 안에", "알아볼 수 있는 품질"]


def _font(px: float, bold: bool = False) -> QFont:
    f = QFont(theme.FAMILY)
    f.setPixelSize(max(1, round(px)))
    f.setBold(bold)
    return f


def _page(p: QPainter, r: QRectF, stack: int = 0, shadow: bool = False) -> None:
    """종이 한 장(stack>0이면 뒤에 겹친 장)."""
    for k in range(stack, 0, -1):
        p.setPen(QPen(LINE, 1))
        p.setBrush(PAPER)
        p.drawRect(r.translated(3 * k, -3 * k))
    if shadow:
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(15, 23, 42, 45))
        p.drawRect(r.translated(4, 4))
    p.setPen(QPen(LINE, 1))
    p.setBrush(PAPER)
    p.drawRect(r)


def _lines(p: QPainter, r: QRectF, n: int, color: QColor = INK, width: float = 1.6, top: float = 0.0) -> None:
    p.setPen(QPen(color, width, Qt.SolidLine, Qt.RoundCap))
    gap = (r.height() - 12 - top) / max(1, n)
    for i in range(n):
        y = r.top() + 8 + top + i * gap
        x2 = r.right() - 8 - (i % 3) * (r.width() * 0.12)
        p.drawLine(QPointF(r.left() + 8, y), QPointF(x2, y))


def _mark(p: QPainter, c: QPointF, ok: bool, size: float = 9.0) -> None:
    """✓(초록) / ✗(빨강) 동그라미."""
    p.setPen(Qt.NoPen)
    p.setBrush(GOOD if ok else BAD)
    p.drawEllipse(c, size, size)
    p.setPen(QPen(QColor("white"), 2.2, Qt.SolidLine, Qt.RoundCap, Qt.RoundJoin))
    s = size * 0.45
    if ok:
        path = QPainterPath(QPointF(c.x() - s, c.y()))
        path.lineTo(c.x() - s * 0.2, c.y() + s * 0.8)
        path.lineTo(c.x() + s, c.y() - s * 0.7)
        p.setBrush(Qt.NoBrush)
        p.drawPath(path)
    else:
        p.drawLine(QPointF(c.x() - s, c.y() - s), QPointF(c.x() + s, c.y() + s))
        p.drawLine(QPointF(c.x() + s, c.y() - s), QPointF(c.x() - s, c.y() + s))


def _caption(p: QPainter, r: QRectF, text: str, color: QColor = INK, px: float = 11, bold: bool = False) -> None:
    p.setPen(color)
    p.setFont(_font(px, bold))
    p.drawText(r, Qt.AlignHCenter | Qt.AlignTop, text)


def _label_on(p: QPainter, r: QRectF, text: str, px: float = 10) -> None:
    p.setPen(INK)
    p.setFont(_font(px, True))
    p.drawText(QRectF(r.left(), r.top() + 4, r.width(), 14), Qt.AlignHCenter, text)


def _divider(p: QPainter, x: float) -> None:
    p.setPen(QPen(LINE, 1, Qt.DashLine))
    p.drawLine(QPointF(x, 8), QPointF(x, H - 8))


# ── 그림 셋(논리 좌표 320×120) ──
def draw_round(p: QPainter) -> None:
    """① ✓ 회차마다 파일 하나 / ✗ 여러 회차를 합친 파일."""
    for k, t in enumerate(("2022년 1회", "2022년 2회")):
        r = QRectF(18 + k * 72, 14, 60, 76)
        _page(p, r)
        _label_on(p, r, t, 9)
        _lines(p, r, 4, FAINT, 1.4, top=14)
    _mark(p, QPointF(14, 14), True)
    _caption(p, QRectF(0, 96, 160, 20), "회차마다 파일 하나")
    _divider(p, 166)
    r = QRectF(208, 20, 66, 70)
    _page(p, r, stack=3)
    _label_on(p, r, "1·2·3회 합본", 9)
    _lines(p, r, 4, FAINT, 1.4, top=14)
    _mark(p, QPointF(196, 14), False)
    _caption(p, QRectF(166, 96, 154, 20), "합본은 회차별로 나눠서")


def draw_answer(p: QPainter) -> None:
    """② 셋 중 하나면 됨: 보기 번호를 칠함 / 형광펜 / 끝에 정답표."""
    cols = [QRectF(10 + k * 104, 10, 92, 80) for k in range(3)]
    caps = ["칠한 번호", "형광펜", "끝에 정답표"]
    for k, r in enumerate(cols):
        _page(p, r)
        if k < 2:
            p.setPen(QPen(INK, 1.6, Qt.SolidLine, Qt.RoundCap))
            p.drawLine(QPointF(r.left() + 8, r.top() + 12), QPointF(r.right() - 10, r.top() + 12))
            for i in range(4):
                y = r.top() + 26 + i * 13
                if k == 1 and i == 2:
                    p.setPen(Qt.NoPen)
                    p.setBrush(HIGHLIGHT)
                    p.drawRect(QRectF(r.left() + 6, y - 5, r.width() - 14, 10))
                p.setPen(QPen(INK, 1.1))
                p.setBrush(INK if (k == 0 and i == 2) else Qt.NoBrush)
                p.drawEllipse(QPointF(r.left() + 13, y), 4, 4)
                p.setPen(QPen(FAINT if not (k == 0 and i == 2) else INK, 1.4))
                p.drawLine(QPointF(r.left() + 22, y), QPointF(r.right() - 14 - i * 6, y))
        else:
            _label_on(p, r, "정답", 9)
            p.setFont(_font(7))
            ans = "②④①③②④①③④②③①"
            for i in range(12):
                cx = r.left() + 8 + (i % 4) * 20
                cy = r.top() + 22 + (i // 4) * 18
                cell = QRectF(cx, cy, 18, 16)
                p.setPen(QPen(LINE, 1))
                p.setBrush(Qt.NoBrush)
                p.drawRect(cell)
                p.setPen(INK)
                p.drawText(cell, Qt.AlignCenter, f"{i + 1}{ans[i]}")
        _mark(p, QPointF(r.left(), r.top()), True, 7.5)
        _caption(p, QRectF(r.left() - 6, 96, r.width() + 12, 20), caps[k])


def draw_quality(p: QPainter) -> None:
    """③ ✓ 반듯한 스캔·글자 PDF / ✗ 기울고 흐린 사진."""
    r = QRectF(48, 12, 64, 80)
    _page(p, r)
    _lines(p, r, 6, INK, 1.5)
    _mark(p, QPointF(44, 12), True)
    _caption(p, QRectF(0, 96, 160, 20), "반듯한 스캔 · 글자 PDF")
    _divider(p, 166)
    p.save()
    p.setPen(Qt.NoPen)
    p.setBrush(QColor("#e2e8f0"))             # 책상 바탕(사진)
    p.drawRoundedRect(QRectF(186, 10, 116, 84), 6, 6)
    p.translate(244, 52)
    p.rotate(-14)
    rr = QRectF(-30, -36, 60, 72)
    _page(p, rr, shadow=True)
    p.setBrush(QColor(15, 23, 42, 30))        # 그림자 진 귀퉁이
    p.setPen(Qt.NoPen)
    p.drawRect(QRectF(rr.left(), rr.center().y(), rr.width(), rr.height() / 2))
    _lines(p, rr, 6, QColor(148, 163, 184, 150), 2.6)
    p.restore()
    _mark(p, QPointF(194, 14), False)
    _caption(p, QRectF(166, 96, 154, 20), "기울고 흐린 사진")


DRAW = [draw_round, draw_answer, draw_quality]


def paint(p: QPainter, rect: QRectF, index: int) -> None:
    """rect 안에 index번 그림을 비율 그대로 가운데 맞춰 그린다."""
    s = min(rect.width() / W, rect.height() / H)
    p.save()
    p.setRenderHint(QPainter.Antialiasing)
    p.setRenderHint(QPainter.TextAntialiasing)
    p.translate(rect.left() + (rect.width() - W * s) / 2, rect.top() + (rect.height() - H * s) / 2)
    p.scale(s, s)
    DRAW[index](p)
    p.restore()


class ConditionPicture(QWidget):
    """조건 카드 안의 작은 예시 그림 — 누르면 크게 보기."""
    clicked = Signal(int)

    def __init__(self, index: int, parent: QWidget | None = None):
        super().__init__(parent)
        self.index = index
        self.setMinimumHeight(84)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setCursor(Qt.PointingHandCursor)
        self.setToolTip("눌러서 크게 보기")
        self.setObjectName("conditionPicture")

    def sizeHint(self):  # noqa: N802
        return QSize(int(W), 88)

    def paintEvent(self, _e):  # noqa: N802
        p = QPainter(self)
        r = QRectF(self.rect()).adjusted(0.5, 0.5, -0.5, -0.5)
        p.setRenderHint(QPainter.Antialiasing)
        p.setPen(QPen(QColor(theme.LINE), 1))
        p.setBrush(QColor("#f8fafc"))
        p.drawRoundedRect(r, 8, 8)
        paint(p, r.adjusted(4, 4, -4, -2), self.index)
        p.end()

    def mouseReleaseEvent(self, e):  # noqa: N802
        if e.button() == Qt.LeftButton and self.rect().contains(e.position().toPoint()):
            self.clicked.emit(self.index)
        super().mouseReleaseEvent(e)


class _Big(QWidget):
    def __init__(self, index: int):
        super().__init__()
        self.index = index
        self.setMinimumSize(int(W * 2.4), int(H * 2.4))

    def paintEvent(self, _e):  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#f8fafc"))
        paint(p, QRectF(self.rect()).adjusted(12, 12, -12, -12), self.index)
        p.end()


class ConditionDialog(QDialog):
    """예시 그림 크게 보기(조건 제목 + 설명 + 그림)."""

    def __init__(self, index: int, hint: str, parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle(f"예시 — {TITLES[index]}")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(20, 18, 20, 16)
        lay.setSpacing(10)
        t = QLabel(f"{index + 1}. {TITLES[index]}")
        t.setObjectName("cardTitle")
        lay.addWidget(t)
        h = QLabel(hint)
        h.setObjectName("muted")
        h.setWordWrap(True)
        lay.addWidget(h)
        self.big = _Big(index)
        lay.addWidget(self.big, 1)
        row = QHBoxLayout()
        row.addStretch(1)
        b = QPushButton("닫기")
        b.clicked.connect(self.accept)
        row.addWidget(b)
        lay.addLayout(row)
