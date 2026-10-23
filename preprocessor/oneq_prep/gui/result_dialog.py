"""파일 하나의 결과 화면(ADR 021 6절) — 과목별 문항 수, 정답 상태, 유형 분포, 단원, 문항 미리 보기, 의심 n건 [확인하기]."""
from __future__ import annotations

from collections import Counter

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (QDialog, QFrame, QGridLayout, QHBoxLayout, QLabel, QPushButton, QScrollArea, QVBoxLayout,
                               QWidget)

from . import theme
from .widgets import Note

QTYPE = {"calc": "계산", "law": "기준·법령", "concept": "개념·실무"}


def suspects(p) -> list:
    """학습 엔진 필수 정보(문항 경계·정답·과목)의 의심 문항(ADR 021 6절)."""
    return [it for it in p.items if [w for w in it.warnings if not w.startswith("info:")] or it.answer is None
            or (it.suggestion and it.suggestion.suggested != it.suggestion.current)]


def summary(p) -> dict:
    kept = [it for it in p.items if not it.excluded]
    by_subj = Counter(it.subject for it in kept)
    want = {s["name"]: s["count"] for s in p.profile.subjects}
    has_units = any(p.profile.units(s["name"]) for s in p.profile.subjects)
    src = Counter(it.answer_source for it in kept)
    return {
        "subjects": [(name, by_subj.get(name, 0), want[name]) for name in want] +
                    [(n, c, None) for n, c in by_subj.items() if n not in want],
        "answers": (sum(it.answer is not None for it in kept), len(kept), src),
        "types": Counter(it.qtype for it in kept),
        "units": (sum(1 for it in kept if it.unit), sum(1 for it in kept if not it.unit and it.unit_candidates),
                  sum(1 for it in kept if not it.unit and not it.unit_candidates)) if has_units else None,
        "sequence": sum(it.sequence for it in kept),
        "excluded": len(p.items) - len(kept),
        "suspects": len(suspects(p)),
    }


class ResultDialog(QDialog):
    want_review = Signal()

    def __init__(self, row, parent=None):
        super().__init__(parent)
        p = row.prepared
        self.p = p
        s = summary(p)
        ex = p.exam
        label = f"{ex['year']:04d}년 {ex.get('roundLabel') or str(ex['round']) + '회'}"
        self.setWindowTitle(f"결과 — {p.profile.name} {label}")
        self.resize(860, 760)
        lay = QVBoxLayout(self)
        lay.setContentsMargins(24, 20, 24, 16)
        lay.setSpacing(12)
        date = "시행일 모름" if ex.get("dateUnknown") else ex["date"]
        info = p.info
        head = QLabel(f"<h2 style='margin:0'>{p.profile.name} {label}</h2>"
                      f"<span style='color:{theme.MUTED}'>{date} · {p.pdf.name}"
                      + (f" · 출처 {info.origin}" if info and info.origin else "") + "</span>")
        head.setTextFormat(Qt.RichText)
        head.setWordWrap(True)
        lay.addWidget(head)

        n_sus = s["suspects"]
        if n_sus or p.issues:
            note = Note("warn")
            lines = [x for x in p.issues[:6]]
            note.set("warn", f"확인할 문항 {n_sus}건" if n_sus else "확인할 것이 있어요", lines)
            b = QPushButton(f"확인하기 ({n_sus}건)" if n_sus else "확인하기")
            b.setObjectName("primary")
            b.clicked.connect(self._review)
            note.layout().addWidget(b, 0, Qt.AlignLeft)
            lay.addWidget(note)
        else:
            ok = Note("ok")
            ok.set("ok", "확인할 문항 없음 — 그대로 팩이 만들어졌어요", [])
            lay.addWidget(ok)

        grid = QGridLayout()
        grid.setHorizontalSpacing(24)
        grid.setVerticalSpacing(6)
        r = 0

        def row_(k: str, v: str) -> None:
            nonlocal r
            a = QLabel(k)
            a.setObjectName("fieldLabel")
            b = QLabel(v)
            b.setTextFormat(Qt.RichText)
            b.setWordWrap(True)
            grid.addWidget(a, r, 0, Qt.AlignTop)
            grid.addWidget(b, r, 1)
            r += 1

        subj = []
        for name, got, want in s["subjects"]:
            bad = want is not None and got != want
            subj.append(f"{name} <b{' style=color:' + theme.BAD if bad else ''}>{got}</b>"
                        + (f"/{want}" if want is not None and bad else ""))
        row_("과목별 문항", " · ".join(subj))
        got, tot, src = s["answers"]
        srcs = " · ".join(f"{ {'inline-mark': '보기 표시', 'answer-table': '정답표', 'manual': '직접 고름'}.get(k, k)} {v}"
                          for k, v in src.items() if k)
        row_("정답", f"{got}/{tot}문항 확인" + (f" ({srcs})" if srcs else ""))
        t = s["types"]
        row_("유형", " · ".join(f"{QTYPE[k]} {t.get(k, 0)}" for k in QTYPE) + (f" · 순서·절차 {s['sequence']}" if s["sequence"] else ""))
        if s["units"]:
            sure, cand, none = s["units"]
            row_("단원", f"확정 {sure} · 미정 {cand + none}"
                 + (f" <span style='color:{theme.MUTED}'>(미정 문항은 앱에서 답한 뒤 후보 3개 중 고름)</span>" if cand else ""))
        if s["excluded"]:
            row_("뺀 문항", f"{s['excluded']}문항(현행 출제기준에 없는 과목 등)")
        if info and info.evidence:
            row_("읽은 근거", "<br>".join(info.evidence[:4]))
        grid.setColumnStretch(1, 1)
        grid.setColumnMinimumWidth(0, 88)
        lay.addLayout(grid)

        lay.addWidget(QLabel("<b>문항 미리 보기</b>"))
        sc = QScrollArea()
        sc.setWidgetResizable(True)
        host = QWidget()
        hv = QVBoxLayout(host)
        for it in [x for x in p.items if not x.excluded][:4]:
            card = QFrame()
            card.setObjectName("qcard")
            cv = QVBoxLayout(card)
            cap = QLabel(f"{it.no}번 · {it.subject} · {QTYPE.get(it.qtype or '', '')}"
                         + (f" · 단원 {it.unit}" if it.unit else ""))
            cap.setObjectName("muted")
            cv.addWidget(cap)
            img = QLabel()
            pm = QPixmap()
            pm.loadFromData(it.image)
            img.setPixmap(pm.scaledToWidth(min(760, pm.width()), Qt.SmoothTransformation))
            cv.addWidget(img)
            hv.addWidget(card)
        hv.addStretch(1)
        sc.setWidget(host)
        lay.addWidget(sc, 1)

        bottom = QHBoxLayout()
        bottom.addStretch(1)
        close = QPushButton("닫기")
        close.clicked.connect(self.accept)
        bottom.addWidget(close)
        lay.addLayout(bottom)

    def _review(self) -> None:
        self.accept()
        self.want_review.emit()
