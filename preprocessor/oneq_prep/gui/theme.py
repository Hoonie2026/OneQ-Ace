"""원큐합격 디자인(앱과 같은 색·글꼴) — 전처리기 창 프로그램 v0.4(ADR 019).

- 글꼴: Pretendard(SIL OFL, fonts/ 폴더에 함께 배포) → 없으면 맑은 고딕
- 크기 단계(px): 제목 20 · 카드 제목 16 · 본문·입력 14 · 배지·보조 12. 8px 격자 여백
- Windows 버전마다 모양이 달라지지 않게 Qt Fusion 스타일 + 이 스타일시트
"""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtGui import QColor, QFont, QFontDatabase, QPalette
from PySide6.QtWidgets import QApplication

INK = "#1d2433"
MUTED = "#5b6b80"
LINE = "#e2e8f0"
BG = "#f4f6fa"
SURFACE = "#ffffff"
PRIMARY = "#1f5fd1"
PRIMARY_DARK = "#174bb0"
PRIMARY_SOFT = "#e8effc"
ACCENT = "#f2b830"
OK = "#1f7a4d"
OK_SOFT = "#e3f4ea"
WARN = "#9a6700"
WARN_SOFT = "#fdf3d7"
BAD = "#b3261e"
BAD_SOFT = "#fde7e5"
GRAY_SOFT = "#eef1f5"

STATUS = {   # 상태 → (글자색, 배경색)
    "waiting": (MUTED, GRAY_SOFT),
    "running": (PRIMARY, PRIMARY_SOFT),
    "packed": (OK, OK_SOFT),
    "review": (WARN, WARN_SOFT),
    "error": (BAD, BAD_SOFT),
    "skipped": (MUTED, GRAY_SOFT),
    "needdate": (BAD, BAD_SOFT),
}

FAMILY = "Pretendard"


def _font_dir() -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2]))
    return base / "oneq_prep" / "gui" / "fonts"


def load_fonts() -> str:
    """Pretendard를 등록하고 쓸 글꼴 이름을 돌려준다."""
    global FAMILY
    ok = False
    d = _font_dir()
    for f in ("Pretendard-Regular.otf", "Pretendard-SemiBold.otf", "Pretendard-Bold.otf"):
        p = d / f
        if p.exists() and QFontDatabase.addApplicationFont(str(p)) >= 0:
            ok = True
    if not ok:
        FAMILY = "Malgun Gothic"
    return FAMILY


QSS = f"""
* {{ font-family: "{{family}}", "Malgun Gothic", sans-serif; }}
QMainWindow, QDialog, QWidget#page {{ background: {BG}; }}
QWidget {{ color: {INK}; font-size: 14px; }}
QToolTip {{ background: {INK}; color: white; border: 0; padding: 6px 8px; border-radius: 6px; }}

/* 머리 띠 */
QFrame#header {{ background: {SURFACE}; border-bottom: 1px solid {LINE}; }}
QLabel#appTitle {{ font-size: 20px; font-weight: 700; }}
QLabel#appSub {{ color: {MUTED}; font-size: 13px; }}
QLabel#versionChip {{ color: {MUTED}; background: {GRAY_SOFT}; border-radius: 10px; padding: 3px 10px; font-size: 12px; }}

/* 카드 */
QFrame#card {{ background: {SURFACE}; border: 1px solid {LINE}; border-radius: 12px; }}
QLabel#cardTitle {{ font-size: 16px; font-weight: 600; }}
QLabel#cardStep {{ color: white; background: {PRIMARY}; border-radius: 11px; font-size: 12px; font-weight: 700;
                   min-width: 22px; max-width: 22px; min-height: 22px; max-height: 22px; qproperty-alignment: AlignCenter; }}
QLabel#cardHint, QLabel#muted, QLabel#hint {{ color: {MUTED}; font-size: 13px; }}
QLabel#fieldLabel {{ color: {MUTED}; font-size: 13px; font-weight: 600; }}

/* 입력 */
QLineEdit, QComboBox, QSpinBox {{ background: {SURFACE}; border: 1px solid #cfd8e3; border-radius: 8px;
                                  padding: 7px 12px; min-height: 22px; selection-background-color: {PRIMARY}; }}
QLineEdit:focus, QComboBox:focus {{ border: 2px solid {PRIMARY}; padding: 6px 11px; }}
QLineEdit:disabled, QComboBox:disabled {{ background: {GRAY_SOFT}; color: {MUTED}; }}
QComboBox::drop-down {{ border: 0; width: 28px; }}
QComboBox QAbstractItemView {{ border: 1px solid {LINE}; border-radius: 8px; padding: 4px; background: {SURFACE};
                               selection-background-color: {PRIMARY_SOFT}; selection-color: {INK}; outline: 0; }}

/* 단추 */
QPushButton {{ background: {SURFACE}; border: 1px solid #cfd8e3; border-radius: 8px; padding: 8px 16px;
               min-height: 22px; font-weight: 600; }}
QPushButton:hover {{ background: {GRAY_SOFT}; }}
QPushButton:pressed {{ background: #e2e8f0; }}
QPushButton:disabled {{ color: #a0aab8; background: {GRAY_SOFT}; border-color: {LINE}; }}
QPushButton#primary {{ background: {PRIMARY}; color: white; border: 0; font-size: 16px; font-weight: 700;
                       padding: 12px 28px; border-radius: 10px; }}
QPushButton#primary:hover {{ background: {PRIMARY_DARK}; }}
QPushButton#primary:disabled {{ background: #9db3e0; color: white; }}
QPushButton#link {{ background: transparent; border: 0; color: {PRIMARY}; padding: 4px 6px; font-weight: 600; }}
QPushButton#link:hover {{ text-decoration: underline; }}
QPushButton#danger {{ color: {BAD}; }}

/* 표 */
QTableWidget {{ background: {SURFACE}; border: 1px solid {LINE}; border-radius: 10px; gridline-color: transparent;
                selection-background-color: {PRIMARY_SOFT}; selection-color: {INK}; alternate-background-color: #fafbfd; }}
QTableWidget::item {{ padding: 4px 8px; border-bottom: 1px solid #edf1f6; }}
QHeaderView::section {{ background: #f8fafc; color: {MUTED}; font-size: 12px; font-weight: 600; border: 0;
                        border-bottom: 1px solid {LINE}; padding: 8px 8px; }}
QTableCornerButton::section {{ background: #f8fafc; border: 0; }}

/* 끌어다 놓기 빈 상자 */
QFrame#dropZone {{ background: #f8fafc; border: 2px dashed #c3cede; border-radius: 12px; }}
QFrame#dropZone[active="true"] {{ background: {PRIMARY_SOFT}; border-color: {PRIMARY}; }}
QLabel#dropTitle {{ font-size: 16px; font-weight: 600; }}

/* 안내 상자 */
QFrame#note {{ background: {PRIMARY_SOFT}; border-radius: 10px; }}
QFrame#note[kind="warn"] {{ background: {WARN_SOFT}; }}
QFrame#note[kind="ok"] {{ background: {OK_SOFT}; }}
QFrame#note[kind="bad"] {{ background: {BAD_SOFT}; }}
QLabel#noteTitle {{ font-weight: 700; }}

/* 실행 띠 */
QFrame#actionBar {{ background: {SURFACE}; border-top: 1px solid {LINE}; }}
QProgressBar {{ background: {GRAY_SOFT}; border: 0; border-radius: 6px; min-height: 12px; max-height: 12px;
                text-align: center; color: transparent; }}
QProgressBar::chunk {{ background: {PRIMARY}; border-radius: 6px; }}
QLabel#status {{ font-size: 14px; }}

/* 검수 창 카드 */
QFrame#qcard {{ background: {SURFACE}; border: 1px solid {LINE}; border-radius: 12px; }}
QFrame#qcard[changed="true"] {{ border: 2px solid {PRIMARY}; }}
QFrame#qcard[excluded="true"] {{ background: {GRAY_SOFT}; }}
QLabel#warn {{ color: {WARN}; }}
QLabel#law {{ color: {WARN}; background: {WARN_SOFT}; border-radius: 6px; padding: 4px 8px; font-size: 12px; font-weight: 600; }}
QLabel#issues {{ color: {BAD}; }}
QScrollArea {{ border: 0; background: transparent; }}
QWidget#sideBody, QWidget#sideViewport {{ background: transparent; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar::handle:vertical {{ background: #cbd5e1; border-radius: 4px; min-height: 32px; }}
QScrollBar::handle:vertical:hover {{ background: #94a3b8; }}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; width: 0; }}
QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px; }}
QScrollBar::handle:horizontal {{ background: #cbd5e1; border-radius: 4px; min-width: 32px; }}
QFrame#qcard QComboBox {{ font-size: 16px; min-width: 64px; }}
QCheckBox {{ spacing: 6px; }}
"""


def apply(app: QApplication) -> None:
    app.setStyle("Fusion")
    family = load_fonts()
    f = QFont(family, 10)
    f.setPixelSize(14)
    f.setHintingPreference(QFont.PreferNoHinting)
    app.setFont(f)
    pal = app.palette()
    pal.setColor(QPalette.Window, QColor(BG))
    pal.setColor(QPalette.Base, QColor(SURFACE))
    pal.setColor(QPalette.Text, QColor(INK))
    pal.setColor(QPalette.WindowText, QColor(INK))
    pal.setColor(QPalette.Highlight, QColor(PRIMARY))
    app.setPalette(pal)
    app.setStyleSheet(QSS.replace("{family}", family))
