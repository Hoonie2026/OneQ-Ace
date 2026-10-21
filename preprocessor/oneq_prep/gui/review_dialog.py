"""회차 하나의 검수 창 — 문항 카드(이미지·정답·과목·제외)를 고치고 검수 파일로 저장한다.

HTML 보고서의 "검수 파일 저장 → review/ 폴더에 넣기 → 다시 실행"을 [저장하고 다시 만들기] 단추 하나로 줄인다.
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (QCheckBox, QComboBox, QDialog, QFrame, QHBoxLayout, QLabel, QLineEdit, QPushButton,
                               QScrollArea, QVBoxLayout, QWidget)

from ..review import Edit, build_review, save_review

CIRCLED = "①②③④⑤⑥⑦⑧"
EXCLUDE = "제외"


def _circ(k: int | None) -> str:
    return CIRCLED[k - 1] if k and 1 <= k <= len(CIRCLED) else "?"


SRC = {"inline-mark": "보기 표시", "answer-table": "정답표", "manual": "검수 입력"}


class QuestionCard(QFrame):
    def __init__(self, it, subjects: list[str], shown_subject: str | None, edit: Edit, legacy: bool):
        super().__init__()
        self.it = it
        self.edit = edit
        self.setObjectName("qcard")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(16, 14, 16, 14)
        lay.setSpacing(8)
        head = f"<b>{it.no}번</b> · {it.pdf_subject}"
        if it.local_no != it.no:
            head += f" {it.local_no}번"
        head += f" &nbsp; 정답 <b>{it.answer or '?'}번</b> <span style='color:gray'>{SRC.get(it.answer_source or '', '')}</span>"
        top = QLabel(head)
        top.setTextFormat(Qt.RichText)
        lay.addWidget(top)
        warn = [w for w in it.warnings if not w.startswith("info:")]
        notes = [w[5:] for w in it.warnings if w.startswith("info:")]
        if warn:
            w = QLabel("⚠ " + " / ".join(warn))
            w.setWordWrap(True)
            w.setObjectName("warn")
            lay.addWidget(w)
        if it.suggestion and it.suggestion.suggested != it.suggestion.current:
            s = it.suggestion
            sl = QLabel(f"재배정 제안: {s.current} → <b>{s.suggested}</b> (확신 {s.confidence:.0%})")
            sl.setTextFormat(Qt.RichText)
            lay.addWidget(sl)
        if "law" in it.flags:
            refs = getattr(it, "law_refs", []) or []
            lw = QLabel("법령·기준 문항" + (f" — {', '.join(refs[:2])}" if refs else "") + " · 앱에서 답한 뒤 현행 기준 확인 안내")
            lw.setObjectName("law")
            lay.addWidget(lw, 0, Qt.AlignLeft)
        if notes:
            n = QLabel(" · ".join(notes))
            n.setObjectName("muted")
            lay.addWidget(n)
        img = QLabel()
        pm = QPixmap()
        pm.loadFromData(it.image)
        img.setPixmap(pm.scaledToWidth(min(760, pm.width()), Qt.SmoothTransformation))
        img.setStyleSheet("background:white")
        lay.addWidget(img)

        row = QHBoxLayout()
        row.addWidget(QLabel("정답"))
        self.answer = QComboBox()
        for k in range(1, max(4, it.choice_count) + 1):
            self.answer.addItem(f"{k}번", k)      # 원문자(③)는 글꼴에 따라 아주 작게 그려져 숫자로
        self.answer.setCurrentIndex(max(0, (edit.answer or it.answer or 1) - 1))
        row.addWidget(self.answer)
        row.addSpacing(12)
        row.addWidget(QLabel("과목"))
        self.subject = QComboBox()
        self.subject.addItems(subjects)
        cur = edit.subject or shown_subject or it.subject
        if cur in subjects:
            self.subject.setCurrentText(cur)
        self.subject.setEnabled(legacy or bool(it.suggestion))
        row.addWidget(self.subject, 1)
        row.addSpacing(12)
        self.excl = QCheckBox("제외")
        self.excl.setChecked(edit.excluded)
        row.addWidget(self.excl)
        self.reason = QLineEdit(edit.reason)
        self.reason.setPlaceholderText("제외 사유")
        self.reason.setMaximumWidth(160)
        row.addWidget(self.reason)
        lay.addLayout(row)
        for w in (self.answer, self.subject):
            w.currentIndexChanged.connect(self._sync)
        self.excl.toggled.connect(self._sync)
        self.reason.textChanged.connect(self._sync)
        self._sync()

    def _sync(self) -> None:
        self.edit.answer = self.answer.currentData()
        self.edit.subject = self.subject.currentText() if self.subject.isEnabled() else None
        self.edit.excluded = self.excl.isChecked()
        self.edit.reason = self.reason.text()
        changed = (self.edit.answer != self.it.answer or (self.edit.subject and self.edit.subject != self.it.subject)
                   or self.edit.excluded != bool(self.it.excluded))
        self.setProperty("changed", bool(changed))
        self.setProperty("excluded", self.edit.excluded)
        self.style().unpolish(self)
        self.style().polish(self)


class ReviewDialog(QDialog):
    """결과: accepted + rerun=True면 저장한 뒤 이 회차를 다시 만든다."""

    def __init__(self, prepared, out_dir: Path, parent=None):
        super().__init__(parent)
        self.p = prepared
        self.out_dir = out_dir
        self.rerun = False
        self.saved_path: Path | None = None
        self.setWindowTitle(f"검수 — {prepared.pack_id}")
        self.resize(900, 820)
        self.subjects = [s["name"] for s in prepared.profile.subjects]
        rv = prepared.review or {}
        self.edits: dict[int, Edit] = {}
        self.shown: dict[int, str | None] = {}
        for it in prepared.items:
            shown = it.subject
            if it.suggestion and prepared.legacy and not rv.get("reviewed"):
                shown = rv.get("reassign", {}).get(str(it.no), it.suggestion.suggested)
            self.shown[it.no] = shown
            self.edits[it.no] = Edit(answer=it.answer, subject=shown, excluded=bool(it.excluded),
                                     reason=it.excluded or "")

        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 20, 24, 16)
        lay.setSpacing(12)
        title = QLabel(f"<h2 style='margin:0'>{prepared.pack_id}</h2><span style='color:gray'>{prepared.pdf.name} · "
                       f"{len(prepared.items)}문항</span>")
        title.setTextFormat(Qt.RichText)
        lay.addWidget(title)
        if prepared.issues:
            iss = QLabel("<b>막히는 문제</b><br>" + "<br>".join(f"• {x}" for x in prepared.issues[:12]))
            iss.setTextFormat(Qt.RichText)
            iss.setWordWrap(True)
            iss.setObjectName("issues")
            lay.addWidget(iss)

        # 출제기준 프로필에 없는 과목명 → 표준 과목 또는 제외로 연결
        self.map_boxes: dict[str, QComboBox] = {}
        raw_unknown = sorted({it.pdf_subject for it in prepared.items if it.subject not in self.subjects and not it.excluded})
        if raw_unknown:
            box = QVBoxLayout()
            box.addWidget(QLabel("<b>출제기준에 없는 과목명</b> — 어느 과목으로 볼지 고르세요"))
            for raw in raw_unknown:
                r = QHBoxLayout()
                r.addWidget(QLabel(raw))
                cb = QComboBox()
                cb.addItems(["(고르세요)", *self.subjects, EXCLUDE])
                cur = rv.get("subjectMap", {}).get(raw)
                if cur:
                    cb.setCurrentText(cur)
                self.map_boxes[raw] = cb
                r.addWidget(cb, 1)
                box.addLayout(r)
            lay.addLayout(box)

        bar = QHBoxLayout()
        bar.addWidget(QLabel("보기:"))
        self.filter = QComboBox()
        self.filter.addItems(["확인할 문항(경고·재배정 제안·제외)", "전체 문항", "법령·기준 문항"])
        bar.addWidget(self.filter)
        self.count = QLabel()
        bar.addWidget(self.count, 1)
        lay.addLayout(bar)

        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        lay.addWidget(self.scroll, 1)

        bottom = QHBoxLayout()
        self.reviewed = QCheckBox("검수 완료(구기준 회차는 체크해야 과목 재배정이 반영됨)")
        self.reviewed.setChecked(bool(rv.get("reviewed")))
        bottom.addWidget(self.reviewed, 1)
        b_save = QPushButton("저장")
        b_save.clicked.connect(lambda: self._save(False))
        b_rerun = QPushButton("저장하고 이 회차 다시 만들기")
        b_rerun.setDefault(True)
        b_rerun.setObjectName("primary")
        b_save.setMinimumHeight(40)
        b_rerun.clicked.connect(lambda: self._save(True))
        b_close = QPushButton("닫기")
        b_close.clicked.connect(self.reject)
        for b in (b_save, b_rerun, b_close):
            bottom.addWidget(b)
        lay.addLayout(bottom)

        self.filter.currentIndexChanged.connect(self._fill)
        self._fill()

    def _wanted(self, it) -> bool:
        if self.filter.currentIndex() == 1:
            return True
        if self.filter.currentIndex() == 2:
            return "law" in it.flags
        return bool([w for w in it.warnings if not w.startswith("info:")] or it.excluded
                    or (it.suggestion and it.suggestion.suggested != it.suggestion.current)
                    or self.edits[it.no].excluded)

    def _fill(self) -> None:
        host = QWidget()
        v = QVBoxLayout(host)
        shown = [it for it in self.p.items if self._wanted(it)]
        for it in shown:
            v.addWidget(QuestionCard(it, self.subjects, self.shown[it.no], self.edits[it.no], self.p.legacy))
        if not shown:
            v.addWidget(QLabel("확인할 문항이 없습니다. '전체 문항'으로 바꾸면 모든 문항을 볼 수 있습니다."))
        v.addStretch(1)
        self.scroll.setWidget(host)
        self.count.setText(f"{len(shown)} / {len(self.p.items)}문항")

    def _save(self, rerun: bool) -> None:
        smap = {raw: cb.currentText() for raw, cb in self.map_boxes.items() if cb.currentIndex() > 0}
        review = build_review(self.p, self.edits, self.reviewed.isChecked(), smap)
        self.saved_path = save_review(self.out_dir, review)
        self.rerun = rerun
        self.accept()
