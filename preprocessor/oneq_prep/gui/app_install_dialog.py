"""[학습앱 설치] 창 — 전처리기 경로(B)의 서브(사용자 2026-11-12, ADR 021 7절).

설치 경로는 두 갈래: A 학습앱 링크(+ 문제팩)를 받은 사람은 링크에서 바로 학습앱 설치, B 전처리기를 설치한 사람은
팩을 만든 뒤 이 창에서 공부할 기기에 학습앱을 설치. 어느 쪽이든 학습앱 설치 방법은 같다(기기의 브라우저 정식 설치).
- PC: 기본 브라우저로 학습앱을 열고 그 화면의 [PC에 설치](Chrome·Edge 정식 설치 — 바탕화면·시작 메뉴, Windows 설정 › 앱에서 제거).
  전처리기가 바로가기를 만들던 방식(11-11~12 개발판)은 없앰 — 남아 있으면 정리 안내만
- Android·iPhone: 주소를 휴대폰으로 여는 두 방법(QR / 주소 복사해 보내기). 어느 브라우저로 열릴지는 휴대폰 설정마다
  달라서 브라우저별 순서는 적지 않고, 열린 학습앱 첫 화면이 그 브라우저를 알아보고 설치 방법을 안내한다(InstallGuide)
- 문제팩 가져오기 안내는 두지 않는다 — 설치 전이라 앱이 없음. 학습앱을 처음 열면 안내(사용자 2026-11-12)
"""
from __future__ import annotations

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QDesktopServices, QPixmap
from PySide6.QtWidgets import QApplication, QDialog, QHBoxLayout, QLabel, QPushButton, QTabWidget, QVBoxLayout, QWidget

from ..appinfo import APP_URL, qr_png
from . import shortcut

INTRO = ("원큐합격 학습앱은 문제를 푸는 앱입니다. 공부할 기기를 골라 설치하세요(여러 기기에 설치해도 됩니다). "
         "학습 기록은 설치된 기기에 저장되고, 다른 기기와의 학습 기록 공유는 학습 기록 백업 파일로만 가능합니다.")


def _steps(items: list[str]) -> QLabel:
    lab = QLabel("<ol style='margin:0 0 0 -18px'>" + "".join(f"<li style='margin-bottom:6px'>{x}</li>" for x in items) + "</ol>")
    lab.setTextFormat(Qt.RichText)
    lab.setWordWrap(True)
    return lab


def _hint(text: str) -> QLabel:
    lab = QLabel(text)
    lab.setObjectName("hint")
    lab.setTextFormat(Qt.RichText)
    lab.setWordWrap(True)
    return lab


def _head(text: str) -> QLabel:
    lab = QLabel(text)
    lab.setStyleSheet("font-weight:600")
    lab.setWordWrap(True)
    return lab


class AppInstallDialog(QDialog):
    def __init__(self, parent=None, tab: str = "pc", status=None):
        super().__init__(parent)
        self.setWindowTitle("원큐합격 학습앱 설치")
        self.setMinimumWidth(640)
        self.status = status            # 메인 창 상태 줄(있으면)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(22, 20, 22, 18)
        lay.setSpacing(12)
        title = QLabel("원큐합격 학습앱 설치")
        title.setObjectName("cardTitle")
        lay.addWidget(title)
        lay.addWidget(_hint(INTRO))
        self.tabs = QTabWidget()
        self.tabs.addTab(self._tab_pc(), "PC(이 컴퓨터)")
        self.tabs.addTab(self._tab_phone("android"), "Android 휴대폰·태블릿")
        self.tabs.addTab(self._tab_phone("ios"), "iPhone·iPad")
        self.tabs.setCurrentIndex({"pc": 0, "android": 1, "ios": 2}.get(tab, 0))
        lay.addWidget(self.tabs, 1)
        foot = QHBoxLayout()
        foot.addStretch(1)
        close = QPushButton("닫기")
        close.clicked.connect(self.accept)
        foot.addWidget(close)
        lay.addLayout(foot)

    # ── PC: 브라우저 정식 설치(사용자 2026-11-12) ──
    def _tab_pc(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        v.setContentsMargins(16, 16, 16, 16)
        v.setSpacing(10)
        v.addWidget(_hint("바탕화면과 시작 메뉴에 <b>원큐합격</b> 학습앱을 설치합니다. 실행은 인터넷이 필요 없고 학습 기록은 "
                          "설치된 기기에 저장됩니다(다른 기기와의 학습 기록 공유는 학습 기록 백업 파일로만 가능). "
                          "지울 때는 Windows 설정 › 앱의 <b>원큐합격</b>."))
        self.pc_btn = QPushButton("학습앱 열어 설치하기")
        self.pc_btn.setObjectName("primarySmall")
        self.pc_btn.clicked.connect(self.install_pc)
        row = QHBoxLayout()
        row.addWidget(self.pc_btn)
        row.addStretch(1)
        v.addLayout(row)
        v.addWidget(_steps([
            "[학습앱 열어 설치하기]를 누르면 이 PC의 기본 브라우저에 학습앱이 열립니다",
            "열린 화면 위쪽의 <b>[PC에 설치]</b>(또는 주소창 오른쪽의 설치 아이콘) → 「설치」 — "
            "Chrome·Edge가 아닌 브라우저면 화면 안내대로 Chrome·Edge로 엽니다",
            "바탕화면·시작 메뉴의 <b>원큐합격</b>으로 엽니다",
        ]))
        self.pc_note = _hint("")
        self.pc_note.setVisible(False)
        if shortcut.legacy_app_installed():
            self.pc_note.setText("예전 방식으로 만든 <b>원큐합격 학습앱</b> 바로가기가 이 PC에 있어요. 기록은 같은 브라우저라 그대로 이어지니, "
                                 "새로 설치한 뒤 Windows 설정 › 앱에서 <b>원큐합격 학습앱</b>을 제거해 아이콘을 하나로 정리하세요.")
            self.pc_note.setVisible(True)
        v.addWidget(self.pc_note)
        v.addStretch(1)
        return w

    def install_pc(self) -> None:
        QDesktopServices.openUrl(QUrl(APP_URL))
        if self.status is not None:
            self.status.setText("브라우저에 학습앱을 열었어요 — 그 화면의 [PC에 설치]를 누르세요")

    # ── 휴대폰 ──
    def _tab_phone(self, os_: str) -> QWidget:
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(16, 16, 16, 16)
        h.setSpacing(18)
        qr = QLabel()
        qr.setObjectName("appQr")
        pm = QPixmap()
        png = qr_png()
        if png and pm.loadFromData(png, "PNG"):
            qr.setPixmap(pm.scaled(168, 168, Qt.KeepAspectRatio, Qt.FastTransformation))
        h.addWidget(qr, 0, Qt.AlignTop)
        v = QVBoxLayout()
        v.setSpacing(8)
        dev = "휴대폰·태블릿" if os_ == "android" else "아이폰·아이패드"
        v.addWidget(_head(f"1. {dev}에서 학습앱 주소 열기 — 편한 방법 하나"))
        v.addWidget(_steps([
            "<b>QR</b>: 카메라(또는 QR 스캔 앱)로 왼쪽 QR을 찍고, 뜨는 주소를 누릅니다",
            "<b>주소 보내기</b>: 아래 [주소 복사] → 카카오톡 ‘나와의 채팅’·메일 등으로 내 휴대폰에 보낸 뒤, 휴대폰에서 그 주소를 누릅니다",
        ]))
        row = QHBoxLayout()
        url = QLabel(APP_URL)
        url.setObjectName("muted")
        url.setTextInteractionFlags(Qt.TextSelectableByMouse)
        row.addWidget(url, 1)
        copy = QPushButton("주소 복사")
        copy.setObjectName(f"copy_{os_}")
        copy.clicked.connect(self.copy_url)
        row.addWidget(copy)
        v.addLayout(row)
        v.addWidget(_head("2. 열린 화면의 안내대로 설치"))
        how = ("어느 브라우저로 열리든(휴대폰 설정마다 다름) 학습앱 첫 화면이 그 브라우저를 알아보고 설치 방법을 알려 줍니다"
               " — 안내대로 [원큐합격 앱 설치] 또는 「앱 설치」·「홈 화면에 추가」.")
        how += (" 카카오톡·네이버 앱 안에서 열리면 안내대로 바깥 브라우저로 다시 엽니다." if os_ == "android" else
                " 브라우저 화면과 홈 화면 앱은 기록이 따로이니, 홈 화면에 생긴 <b>원큐합격</b>으로 공부하세요.")
        v.addWidget(_hint(how))
        v.addStretch(1)
        h.addLayout(v, 1)
        return w

    def copy_url(self) -> None:
        QApplication.clipboard().setText(APP_URL)
        if self.status is not None:
            self.status.setText(f"학습앱 주소를 복사했습니다: {APP_URL}")
