"""[학습앱 설치] 창 — 설치 경로 일원화(사용자 2026-11-11).

설치 프로그램은 전처리기만 깐다. 학습앱은 사용자가 이 창에서 기기를 골라 **직접** 설치한다
(자동으로 둘 다 깔면 무엇이 설치됐는지 몰라 혼란 — 사용자). 순서: 전처리기 설치 → 문제팩 만들기 → 여기서 학습앱 설치 → 팩 넣기.
- PC: [이 PC에 학습앱 설치] → 바탕화면·시작 메뉴 '원큐합격 학습앱'(기본 브라우저 Chrome/Edge의 앱 창, shortcut.py)
  + Windows 프로그램 목록 등록(설정 › 앱·제어판 › 프로그램 제거에서 지움, 사용자 2026-11-12).
  PC 접근은 이 아이콘 하나 — [학습앱 열기]·아래쪽 [주소 복사]는 없앰(사용자 2026-11-12)
- Android·iPhone: 주소를 휴대폰으로 여는 두 방법(QR / 주소 복사해 보내기). 어느 브라우저로 열릴지는 휴대폰 설정마다
  달라서 여기서는 브라우저별 순서를 적지 않고, 열린 학습앱 첫 화면이 그 브라우저를 알아보고 설치 방법을 안내한다(InstallGuide)
"""
from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (QApplication, QDialog, QHBoxLayout, QLabel, QMessageBox, QPushButton, QTabWidget,
                               QVBoxLayout, QWidget)

from ..appinfo import APP_URL, qr_png
from . import shortcut

INTRO = ("원큐합격 학습앱은 문제를 푸는 앱이고, 이 전처리기는 Q-Net 출제기준과 기출 PDF로 학습앱에 넣을 "
         "문제팩을 만드는 프로그램입니다. 공부할 기기를 골라 학습앱을 직접 설치하세요(여러 기기에 설치해도 됩니다).")

PACK_TO_PHONE = ("문제팩 넣기: 전처리기가 만든 <b>oneq-종목-bundle-….zip</b>을 휴대폰으로 옮긴 뒤(카카오톡 ‘나와의 채팅’, "
                 "구글 드라이브·iCloud Drive, 메일 등) 학습앱의 <b>[문제팩 가져오기]</b>로 고릅니다. 기록은 기기마다 따로 저장됩니다.")


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


def _resource(rel: str) -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[2])) / rel


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

    # ── PC ──
    def _tab_pc(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        v.setContentsMargins(16, 16, 16, 16)
        v.setSpacing(10)
        found = shortcut.app_browser()
        self.edge, self.browser_name = found if found else (None, "")
        v.addWidget(_hint("바탕화면과 시작 메뉴에 <b>원큐합격 학습앱</b>을 설치합니다. 실행은 인터넷이 필요 없고 "
                          "학습 기록은 설치된 기기에 저장됩니다(다른 기기와의 학습 기록 공유는 학습 기록 백업 파일로만 가능)."
                          "<br>지울 때는 Windows 설정 › 앱(또는 제어판 › 프로그램 제거)의 <b>원큐합격 학습앱</b>."))
        self.pc_btn = QPushButton("다시 설치(바로가기 새로 만들기)" if shortcut.app_installed() else "이 PC에 학습앱 설치")
        self.pc_btn.setObjectName("primarySmall")
        self.pc_btn.clicked.connect(self.install_pc)
        row = QHBoxLayout()
        row.addWidget(self.pc_btn)
        row.addStretch(1)
        v.addLayout(row)
        self.pc_note = _hint("")
        self.pc_note.setVisible(False)
        v.addWidget(self.pc_note)
        v.addWidget(_steps([
            "설치한 뒤 학습앱을 엽니다",
            "학습앱의 <b>[문제팩 가져오기]</b> → 전처리기의 <b>[팩 폴더 열기]</b> 위치에 있는 oneq-종목-bundle-….zip을 고릅니다",
        ]))
        if self.edge is None:
            self.pc_btn.setEnabled(False)
            self.pc_note.setText("Chrome·Edge를 찾지 못해 설치할 수 없어요 — 둘 중 하나를 설치한 뒤 다시 여세요.")
            self.pc_note.setVisible(True)
        v.addStretch(1)
        return w

    def install_pc(self) -> None:
        if self.edge is None:
            return
        icon = _resource("oneq_prep/gui/app-icon.ico")
        try:
            made = shortcut.make_app_shortcuts(self.edge, APP_URL, icon)
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "원큐합격 학습앱 설치", f"설치하지 못했어요 — {e}")
            return
        self.pc_note.setText("설치했어요 — 바탕화면·시작 메뉴의 <b>원큐합격 학습앱</b>으로 여세요"
                             "(Windows 설정 › 앱 목록에도 올렸어요)." +
                             ("<br>" + "<br>".join(made) if made else ""))
        self.pc_note.setVisible(True)
        self.pc_btn.setText("다시 설치(바로가기 새로 만들기)")
        if self.status is not None:
            self.status.setText("PC에 원큐합격 학습앱을 설치했어요(바탕화면·시작 메뉴)")

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
        head = QLabel(f"1. {dev}에서 학습앱 주소 열기 — 편한 방법 하나")
        head.setStyleSheet("font-weight:600")
        v.addWidget(head)
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
        head2 = QLabel("2. 열린 화면의 안내대로 설치")
        head2.setStyleSheet("font-weight:600")
        v.addWidget(head2)
        how = ("어느 브라우저로 열리든(휴대폰 설정마다 다름) 학습앱 첫 화면이 그 브라우저를 알아보고 설치 방법을 알려 줍니다"
               " — 안내대로 [원큐합격 앱 설치] 또는 「앱 설치」·「홈 화면에 추가」.")
        how += (" 카카오톡·네이버 앱 안에서 열리면 안내대로 바깥 브라우저로 다시 엽니다." if os_ == "android" else
                " 브라우저 화면과 홈 화면 앱은 기록이 따로이니, 홈 화면에 생긴 <b>원큐합격</b>으로 공부하세요.")
        v.addWidget(_hint(how))
        v.addWidget(_hint(PACK_TO_PHONE))
        v.addStretch(1)
        h.addLayout(v, 1)
        return w

    def copy_url(self) -> None:
        QApplication.clipboard().setText(APP_URL)
        if self.status is not None:
            self.status.setText(f"학습앱 주소를 복사했습니다: {APP_URL}")
