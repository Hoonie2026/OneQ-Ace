"""[동료에게 보내기] 창 — 설치 경로 두 갈래(사용자 2026-11-12, ADR 021 7절).

A 공부할 동료: 학습앱 링크 + 문제팩 파일(종목 묶음 zip). 받은 사람은 링크에서 학습앱을 설치하고, 설치한 앱을 열면
  받은 파일을 넣는 안내가 나온다(문제팩 안내는 앱 안에서만 — 설치 전 단계에 두지 않음).
B 문제팩을 만들 동료(Windows PC): 전처리기 링크(앱 주소?prep) — 열면 전처리기 설치가 메인, 학습앱은 서브.
전처리기가 직접 보내지는 않는다(ADR 021 7절) — 메시지를 복사해 카카오톡·메일에 붙이고, 팩 파일은 사용자가 첨부.
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QApplication, QDialog, QHBoxLayout, QLabel, QPlainTextEdit, QPushButton, QTabWidget,
                               QVBoxLayout, QWidget)

from ..appinfo import APP_URL, PREP_URL


def study_message(cert: str, bundle: str | None) -> str:
    what = f"{cert} 기출 문제팩" if cert else "기출 문제팩"
    file = f"({bundle})" if bundle else ""
    return (f"[원큐합격] {what}을 보냅니다.\n"
            f"① 아래 링크를 열어 원큐합격 학습앱을 설치하세요(PC·휴대폰 모두).\n{APP_URL}\n"
            f"② 설치한 앱을 열면, 함께 보낸 파일{file}을 넣는 방법이 나옵니다.")


def prep_message() -> str:
    return ("[원큐합격] 기출 PDF로 학습 문제팩을 만드는 '원큐합격 전처리기'입니다(Windows PC).\n"
            f"아래 링크를 PC에서 열어 설치하세요.\n{PREP_URL}")


class ShareDialog(QDialog):
    def __init__(self, parent=None, cert: str = "", bundle: Path | None = None, out_dir: Path | None = None, status=None):
        super().__init__(parent)
        self.setWindowTitle("동료에게 보내기")
        self.setMinimumWidth(620)
        self.status = status
        self.bundle = bundle
        self.out_dir = out_dir
        lay = QVBoxLayout(self)
        lay.setContentsMargins(22, 20, 22, 18)
        lay.setSpacing(12)
        t = QLabel("동료에게 보내기")
        t.setObjectName("cardTitle")
        lay.addWidget(t)
        self.tabs = QTabWidget()
        self.tabs.addTab(self._tab(
            "공부할 동료에게 — 학습앱 링크와 문제팩 파일을 함께 보냅니다. 받은 사람은 전처리기 없이 바로 공부합니다.",
            study_message(cert, bundle.name if bundle else None), "study",
            ["[메시지 복사] → 카카오톡·메일 등에 붙여넣기",
             "[팩 폴더 열기]로 문제팩 파일(<b>" + (bundle.name if bundle else "oneq-종목-bundle-….zip") + "</b>)을 찾아 함께 첨부"],
            with_folder=True), "문제팩 + 학습앱")
        self.tabs.addTab(self._tab(
            "문제팩을 직접 만들 동료에게(Windows PC) — 전처리기 링크를 보냅니다. 받은 사람이 PC에서 열면 전처리기 설치 안내가 나옵니다.",
            prep_message(), "prep", ["[메시지 복사] → 카카오톡·메일 등에 붙여넣기"]), "전처리기")
        lay.addWidget(self.tabs, 1)
        foot = QHBoxLayout()
        foot.addStretch(1)
        close = QPushButton("닫기")
        close.clicked.connect(self.accept)
        foot.addWidget(close)
        lay.addLayout(foot)

    def _tab(self, lead: str, message: str, key: str, steps: list[str], with_folder: bool = False) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        v.setContentsMargins(16, 16, 16, 16)
        v.setSpacing(10)
        h = QLabel(lead)
        h.setObjectName("hint")
        h.setWordWrap(True)
        v.addWidget(h)
        box = QPlainTextEdit(message)            # 보내기 전에 고쳐 써도 됨
        box.setObjectName(f"msg_{key}")
        box.setMinimumHeight(110)
        v.addWidget(box)
        row = QHBoxLayout()
        cp = QPushButton("메시지 복사")
        cp.setObjectName("primarySmall")
        cp.setAccessibleName(f"copy_{key}")
        cp.clicked.connect(lambda: self.copy(box.toPlainText()))
        row.addWidget(cp)
        if with_folder:
            fb = QPushButton("팩 폴더 열기")
            fb.clicked.connect(self.open_folder)
            fb.setEnabled(self.out_dir is not None)
            row.addWidget(fb)
        row.addStretch(1)
        v.addLayout(row)
        st = QLabel("<ol style='margin:0 0 0 -18px'>" + "".join(f"<li>{x}</li>" for x in steps) + "</ol>")
        st.setTextFormat(Qt.RichText)
        st.setWordWrap(True)
        v.addWidget(st)
        v.addStretch(1)
        return w

    def copy(self, text: str) -> None:
        QApplication.clipboard().setText(text)
        if self.status is not None:
            self.status.setText("보낼 메시지를 복사했어요 — 카카오톡·메일에 붙여넣으세요")

    def open_folder(self) -> None:
        if self.out_dir is not None:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.bundle.parent if self.bundle else self.out_dir)))
