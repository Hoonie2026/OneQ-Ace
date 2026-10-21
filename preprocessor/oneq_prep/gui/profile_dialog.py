"""출제기준(과목 구성) 직접 입력 — 프로필이 없는 종목을 고르면(ADR 019).

큐넷 종목 페이지·출제기준에서 필기 과목명과 문항 수를 보고 적는다. 사용자 폴더(standards.user_root)에 저장.
출제기준 PDF를 읽어 자동으로 채우는 것은 3단계(PREP-PLAN-v0.4).
"""
from __future__ import annotations

import datetime as dt
import re

from PySide6.QtCore import Qt, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QDialog, QFormLayout, QHBoxLayout, QHeaderView, QLabel, QLineEdit, QMessageBox,
                               QPushButton, QSpinBox, QTableWidget, QTableWidgetItem, QVBoxLayout)

from .. import standards as S
from ..certs import Cert

# 자주 쓰는 종목의 코드 제안(영문 대문자) — 없으면 사용자가 적음
CODE_HINT = {"산업안전기사": "INDSAFETY", "건설안전산업기사": "SAFETY2", "토목산업기사": "CIVIL2", "전기기사": "ELEC",
             "전기산업기사": "ELEC2", "전기철도기사": "ELECRAIL", "건축기사": "ARCH", "지적기사": "CADAS",
             "측량및지형공간정보산업기사": "SURVEY2", "콘크리트기사": "CONC", "건설재료시험기사": "MATTEST"}


class ProfileDialog(QDialog):
    def __init__(self, cert: Cert, parent=None):
        super().__init__(parent)
        self.cert = cert
        self.code: str | None = None
        self.setWindowTitle(f"출제기준 입력 — {cert.name}")
        self.resize(640, 640)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 20, 24, 20)
        lay.setSpacing(14)
        t = QLabel(f"<b style='font-size:18px'>{cert.name}</b><br><span style='color:#5b6b80'>"
                   "이 종목은 아직 출제기준(과목 구성)이 등록되지 않았습니다. 큐넷에서 <b>현행 필기 과목</b>과 문항 수를 확인해 적어 주세요. "
                   "한 번 저장하면 이 PC에서 계속 씁니다.</span>")
        t.setTextFormat(Qt.RichText)
        t.setWordWrap(True)
        lay.addWidget(t)
        b_qnet = QPushButton("큐넷에서 출제기준 확인하기 ↗")
        b_qnet.setObjectName("link")
        b_qnet.clicked.connect(lambda: QDesktopServices.openUrl(QUrl(cert.qnet_url())))
        lay.addWidget(b_qnet, 0, Qt.AlignLeft)

        form = QFormLayout()
        form.setSpacing(10)
        self.code_edit = QLineEdit(CODE_HINT.get(cert.name, ""))
        self.code_edit.setPlaceholderText("영문 대문자 2~16자 (예: ELEC)")
        self.version = QLineEdit(str(dt.date.today().year))
        self.version.setPlaceholderText("적용 시작 연도")
        self.subj_min = QSpinBox()
        self.subj_min.setRange(0, 100)
        self.subj_min.setValue(40)
        self.subj_min.setSuffix(" 점(과목별 과락)")
        self.avg_min = QSpinBox()
        self.avg_min.setRange(0, 100)
        self.avg_min.setValue(60)
        self.avg_min.setSuffix(" 점(평균 합격)")
        form.addRow("종목 코드", self.code_edit)
        form.addRow("출제기준 버전", self.version)
        form.addRow("합격 기준", self.subj_min)
        form.addRow("", self.avg_min)
        lay.addLayout(form)

        lay.addWidget(QLabel("<b>현행 필기 과목</b> (시험지 순서대로)"))
        self.table = QTableWidget(5, 2)
        self.table.setHorizontalHeaderLabels(["과목명", "문항 수"])
        self.table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        self.table.verticalHeader().setVisible(False)
        for r in range(5):
            self.table.setItem(r, 1, QTableWidgetItem("20"))
        lay.addWidget(self.table, 1)
        rowbar = QHBoxLayout()
        b_add = QPushButton("과목 추가")
        b_add.clicked.connect(self._add_row)
        b_del = QPushButton("선택 과목 빼기")
        b_del.clicked.connect(self._del_row)
        rowbar.addWidget(b_add)
        rowbar.addWidget(b_del)
        rowbar.addStretch(1)
        lay.addLayout(rowbar)

        lay.addWidget(QLabel("<b>옛 과목명</b>(선택) — 기출에 다른 이름으로 적힌 과목: <span style='color:#5b6b80'>옛 이름=현행 이름, 쉼표로 구분</span>"))
        self.aliases = QLineEdit()
        self.aliases.setPlaceholderText("예: 건설재료학=건설재료, 건설시공학=건설시공")
        lay.addWidget(self.aliases)

        bottom = QHBoxLayout()
        bottom.addStretch(1)
        cancel = QPushButton("취소")
        cancel.clicked.connect(self.reject)
        save = QPushButton("저장")
        save.setObjectName("primary")
        save.clicked.connect(self._save)
        bottom.addWidget(cancel)
        bottom.addWidget(save)
        lay.addLayout(bottom)

    def _add_row(self) -> None:
        r = self.table.rowCount()
        self.table.insertRow(r)
        self.table.setItem(r, 1, QTableWidgetItem("20"))

    def _del_row(self) -> None:
        for i in sorted({x.row() for x in self.table.selectedIndexes()}, reverse=True):
            self.table.removeRow(i)

    def profile_dict(self) -> dict:
        subjects = []
        for r in range(self.table.rowCount()):
            name = (self.table.item(r, 0).text() if self.table.item(r, 0) else "").strip()
            cnt = (self.table.item(r, 1).text() if self.table.item(r, 1) else "").strip()
            if not name:
                continue
            if not cnt.isdigit() or int(cnt) <= 0:
                raise ValueError(f"'{name}'의 문항 수를 숫자로 적으세요")
            subjects.append({"name": name, "count": int(cnt)})
        aliases = {}
        for part in re.split(r"[,，\n]", self.aliases.text()):
            if "=" in part:
                a, b = (x.strip() for x in part.split("=", 1))
                if a and b:
                    aliases[a] = b
        names = {S.norm(s["name"]) for s in subjects}
        bad = [b for b in aliases.values() if S.norm(b) not in names]
        if bad:
            raise ValueError("옛 과목명은 현행 과목 이름으로 연결해야 합니다: " + ", ".join(bad))
        return {"code": self.code_edit.text().strip().upper(), "name": self.cert.name, "grade": self.cert.grade or "기사",
                "version": self.version.text().strip() or str(dt.date.today().year),
                "note": "전처리기 창에서 직접 입력(큐넷 출제기준 확인)",
                "passRule": {"subjectMin": self.subj_min.value(), "avgMin": self.avg_min.value()},
                "subjects": subjects, "aliases": aliases, "excluded": []}

    def _save(self) -> None:
        try:
            d = self.profile_dict()
            if d["code"] in S.available() and not S.is_user_profile(d["code"]):
                raise ValueError(f"'{d['code']}'는 이미 함께 배포된 종목 코드입니다. 다른 코드를 쓰세요")
            S.save_user_profile(d)
        except ValueError as e:
            QMessageBox.warning(self, "출제기준 입력", str(e))
            return
        self.code = d["code"]
        self.accept()
