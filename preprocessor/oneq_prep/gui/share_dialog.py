"""④ [문제팩 공유하기] 창 — 문제팩 파일만 공유(사용자 2026-11-12 세션 #19).

설치 루트를 학습앱 하나로 모았으므로(학습앱 설치 → 학습앱 안에서 생성기 받기) 여기에는 학습앱·생성기 링크를 두지 않는다.
흐름: [문제팩 폴더에서 고르기] → 문제팩 폴더에서 문제팩 파일(oneq-….zip)을 고름(한 번에 여러 개, 또는 여러 번 나눠서)
→ [선택 완료 · 메시지 복사] → 메시지가 클립보드에 들어가고, 보내는 방법과 [문제팩 파일 복사]가 나온다.
생성기가 직접 보내지는 않는다(ADR 021 7절) — 메신저·메일 창에 사용자가 붙여 넣는다(파일 복사 → Ctrl+V, 또는 목록에서 끌어다 놓기).
"""
from __future__ import annotations

import re
from pathlib import Path

from PySide6.QtCore import QMimeData, Qt, QUrl
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QDialog, QFileDialog, QFrame, QHBoxLayout, QLabel,
                               QListWidget, QListWidgetItem, QPlainTextEdit, QPushButton, QVBoxLayout, QWidget)

from .widgets import Note, WrapLabel

PACK_FILTER = "원큐합격 문제팩 (oneq-*.zip);;zip 파일 (*.zip)"
EXAMPLE = "oneq-종목-bundle-2016-2025.zip"


def cert_name(code: str) -> str:
    """종목 코드 → 이름(출제기준 프로필). 모르면 코드 그대로."""
    try:
        from .. import standards as S
        return S.load(code).name
    except Exception:  # noqa: BLE001 — 프로필이 없는 종목
        return code


def describe(path: Path) -> str:
    """'건설안전기사 2016~2025년 묶음' / '건설안전기사 2022년 2회' — 파일 이름에서(묶음·회차 팩)."""
    m = re.match(r"^oneq-([A-Za-z0-9]+)-bundle-(\d{4})(?:-(\d{4}))?\.zip$", path.name)
    if m:
        code, y1, y2 = m.groups()
        span = "" if y1 == "0000" else (f" {y1}~{y2}년" if y2 and y2 != y1 else f" {y1}년")
        return f"{cert_name(code)}{span} 묶음"
    m = re.match(r"^oneq-([A-Za-z0-9]+)-(\d{4})-(\d+)\.zip$", path.name)
    if m:
        code, y, n = m.groups()
        return f"{cert_name(code)} {y}년 {int(n)}회"
    return "문제팩"


def size_text(path: Path) -> str:
    try:
        n = path.stat().st_size
    except OSError:
        return ""
    return f"{n / 1_048_576:.1f}MB" if n >= 1_048_576 else f"{max(1, round(n / 1024))}KB"


def pack_message(files: list[Path]) -> str:
    """문제팩만 담은 메시지 — 학습앱·생성기 안내 없음(사용자 2026-11-12)."""
    certs = list(dict.fromkeys(describe(f).split(" ")[0] for f in files if describe(f) != "문제팩"))
    what = f"{', '.join(certs)} 문제팩" if certs else "문제팩"
    lines = [f"[원큐합격] {what} {len(files)}개를 보냅니다."]
    for f in files:
        size = size_text(f)
        lines.append(f"· {f.name} ({describe(f)}{', ' + size if size else ''})")
    return "\n".join(lines)


def files_mime(files: list[Path]) -> QMimeData:
    """파일 자체(탐색기에서 복사한 것과 같음) — 카카오톡 PC·메일 창에 Ctrl+V 하면 첨부된다."""
    md = QMimeData()
    md.setUrls([QUrl.fromLocalFile(str(f)) for f in files])
    return md


class PackList(QListWidget):
    """고른 문제팩 목록 — 항목을 메신저·메일 창으로 끌어다 놓으면 파일이 첨부된다."""

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setObjectName("shareList")
        self.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.setDragEnabled(True)
        self.setDragDropMode(QAbstractItemView.DragOnly)
        self.setMinimumHeight(120)

    def paths(self, selected_only: bool = False) -> list[Path]:
        items = self.selectedItems() if selected_only else [self.item(i) for i in range(self.count())]
        return [Path(it.data(Qt.UserRole)) for it in items]

    def mimeData(self, items):  # noqa: N802 — Qt 이름
        return files_mime([Path(it.data(Qt.UserRole)) for it in items])


class ShareDialog(QDialog):
    def __init__(self, parent=None, out_dir: Path | None = None, status=None, example: Path | None = None):
        super().__init__(parent)
        self.setWindowTitle("문제팩 공유하기")
        self.setMinimumWidth(680)
        self.resize(680, 760)
        self.status = status
        self.out_dir = out_dir
        self.shared = False                  # [선택 완료 · 메시지 복사]까지 했는지 — 작업 순서 ④ 완료 표시
        lay = QVBoxLayout(self)
        lay.setContentsMargins(22, 20, 22, 18)
        lay.setSpacing(12)
        t = QLabel("문제팩 공유하기")
        t.setObjectName("cardTitle")
        lay.addWidget(t)

        guide = Note("info")
        guide.set("info", "문제팩 폴더를 열어 보낼 문제팩 파일을 찾아 선택하세요", [
            f"[문제팩 폴더에서 고르기]를 누르면 문제팩 폴더가 열립니다 — 문제팩 파일(예: <b>{(example.name if example else EXAMPLE)}</b>)을 고릅니다",
            "한 번에 여러 개를 골라도 되고, 한 개씩 여러 번 골라도 됩니다",
            "다 골랐으면 [선택 완료 · 메시지 복사]"])
        lay.addWidget(guide)

        row = QHBoxLayout()
        self.pick_btn = QPushButton("문제팩 폴더에서 고르기…")
        self.pick_btn.setObjectName("primarySmall")
        self.pick_btn.clicked.connect(self.pick)
        row.addWidget(self.pick_btn)
        self.remove_btn = QPushButton("선택 빼기")
        self.remove_btn.clicked.connect(self.remove_selected)
        row.addWidget(self.remove_btn)
        row.addStretch(1)
        self.count = QLabel("고른 문제팩 없음")
        self.count.setObjectName("muted")
        row.addWidget(self.count)
        lay.addLayout(row)

        self.list = PackList()
        lay.addWidget(self.list, 1)

        self.done_btn = QPushButton("선택 완료 · 메시지 복사")
        self.done_btn.setObjectName("primary")
        self.done_btn.clicked.connect(self.finish)
        lay.addWidget(self.done_btn)

        # 선택 완료 뒤: 메시지(고쳐 써도 됨) + 보내는 방법 + 파일 복사
        self.result = QFrame()
        self.result.setObjectName("condPanel")
        rv = QVBoxLayout(self.result)
        rv.setContentsMargins(14, 12, 14, 12)
        rv.setSpacing(8)
        self.result_title = QLabel("메시지를 복사했어요 — 이제 메신저·메일에 붙여 넣으세요")
        self.result_title.setObjectName("noteTitle")
        rv.addWidget(self.result_title)
        self.msg = QPlainTextEdit()
        self.msg.setObjectName("msg_pack")
        self.msg.setMinimumHeight(96)
        rv.addWidget(self.msg)
        steps = WrapLabel("<ol style='margin:0 0 0 -18px'>"
                       "<li style='margin-bottom:4px'>카카오톡·메일 등 보낼 창에서 <b>Ctrl+V</b> — 메시지가 붙습니다</li>"
                       "<li style='margin-bottom:4px'>[문제팩 파일 복사]를 누르고 그 창에서 다시 <b>Ctrl+V</b> — 문제팩 파일이 첨부됩니다"
                       "(위 목록에서 파일을 그 창으로 끌어다 놓아도 됩니다)</li>"
                       "<li>보내기</li></ol>")
        steps.setTextFormat(Qt.RichText)
        rv.addWidget(steps)
        rrow = QHBoxLayout()
        self.copy_msg_btn = QPushButton("메시지 다시 복사")
        self.copy_msg_btn.clicked.connect(self.copy_message)
        self.copy_files_btn = QPushButton("문제팩 파일 복사")
        self.copy_files_btn.setObjectName("primarySmall")
        self.copy_files_btn.clicked.connect(self.copy_files)
        self.reveal_btn = QPushButton("폴더에서 보기")
        self.reveal_btn.clicked.connect(self.reveal)
        rrow.addWidget(self.copy_msg_btn)
        rrow.addWidget(self.copy_files_btn)
        rrow.addWidget(self.reveal_btn)
        rrow.addStretch(1)
        rv.addLayout(rrow)
        self.result.setVisible(False)
        lay.addWidget(self.result)

        foot = QHBoxLayout()
        foot.addStretch(1)
        close = QPushButton("닫기")
        close.clicked.connect(self.accept)
        foot.addWidget(close)
        lay.addLayout(foot)
        self.update_state()

    # ── 고르기 ──
    def start_dir(self) -> str:
        if self.out_dir is None:
            return ""
        return str(self.out_dir) if self.out_dir.exists() else str(self.out_dir.parent)

    def pick(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(self, "보낼 문제팩 고르기(여러 개 가능)", self.start_dir(), PACK_FILTER)
        self.add([Path(f) for f in files])

    def add(self, files: list[Path]) -> None:
        have = set(self.list.paths())
        for f in files:
            f = Path(f)
            if f in have or f.suffix.lower() != ".zip":
                continue
            have.add(f)
            size = size_text(f)
            it = QListWidgetItem(f"{f.name}    {describe(f)}{' · ' + size if size else ''}")
            it.setData(Qt.UserRole, str(f))
            it.setToolTip(str(f))
            self.list.addItem(it)
        self.update_state()

    def remove_selected(self) -> None:
        for it in self.list.selectedItems():
            self.list.takeItem(self.list.row(it))
        self.update_state()

    def update_state(self) -> None:
        n = self.list.count()
        self.count.setText(f"고른 문제팩 {n}개" if n else "고른 문제팩 없음")
        self.done_btn.setEnabled(n > 0)
        self.remove_btn.setEnabled(n > 0)
        if self.result.isVisible() and n:          # 다 고른 뒤 더 고르거나 빼면 메시지를 새로
            self.msg.setPlainText(pack_message(self.list.paths()))
        elif not n:
            self.result.setVisible(False)

    # ── 선택 완료 ──
    def finish(self) -> None:
        files = self.list.paths()
        if not files:
            return
        self.msg.setPlainText(pack_message(files))
        self.result.setVisible(True)
        self.copy_message()
        self.shared = True

    def copy_message(self) -> None:
        QApplication.clipboard().setText(self.msg.toPlainText())
        self.result_title.setText("메시지를 복사했어요 — 이제 메신저·메일에 붙여 넣으세요")
        if self.status is not None:
            self.status.setText("보낼 메시지를 복사했어요 — 카카오톡·메일에 붙여 넣고, 이어서 [문제팩 파일 복사]")

    def copy_files(self) -> None:
        files = [f for f in self.list.paths() if f.exists()]
        if not files:
            return
        QApplication.clipboard().setMimeData(files_mime(files))
        self.result_title.setText(f"문제팩 파일 {len(files)}개를 복사했어요 — 보낼 창에서 Ctrl+V")
        if self.status is not None:
            self.status.setText(f"문제팩 파일 {len(files)}개를 복사했어요 — 카카오톡·메일 창에서 Ctrl+V로 첨부하세요")

    def reveal(self) -> None:
        files = self.list.paths()
        folder = files[0].parent if files else (self.out_dir or Path("."))
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(folder)))
