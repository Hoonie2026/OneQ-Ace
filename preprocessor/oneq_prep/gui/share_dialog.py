"""④ [문제팩 공유하기] 창 — 문제팩만 공유(사용자 2026-11-12 세션 #19, 화면·흐름 재설계 2026-11-16).

사용자 업무 흐름 그대로 한 화면·한 번에:
  ① 보낼 종목 고르기(종목 카드 — 회차 수·연도·크기)  ② 보내는 방법 하나 누르기
     · [카카오톡·메신저로] — 보낼 파일이 선택된 탐색기 창을 엶 → 대화창으로 끌어다 놓기(카카오톡 PC는 붙여넣기 안 됨)
     · [메일로] — 제목·본문 글을 복사하고 파일이 선택된 탐색기 창을 엶 → 쓰던 메일(사내·네이버·Gmail)에 붙여넣기·끌어다 놓기
       (Outlook 전용 방식(MAPI)은 없앰 — 대부분 Outlook을 쓰지 않음, 2026-11-16)
메시지와 파일을 따로 보내지 않는다(2026-11-16): 보낼 파일 이름 자체가 설명이 되게 한글 이름으로 만들고
(「원큐합격 문제팩_종목_첫해-끝해(n회차).zip」, 문제팩 폴더의 '보낼 문제팩'), 메일은 본문·첨부를 한 창에.
메시지 글에 'oneq-….zip' 같은 파일 이름을 넣으면 카카오톡이 인터넷 주소로 바꿔 누르면 '사이트에 연결할 수 없음'이 됐다 → 넣지 않음.
학습앱은 파일 이름이 아니라 내용으로 문제팩·묶음을 알아본다(app/src/pack/bundle.ts) — 이름을 바꿔도 가져오기 된다.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from PySide6.QtCore import QMimeData, Qt, QUrl, Signal
from PySide6.QtGui import QDesktopServices
from PySide6.QtWidgets import (QApplication, QCheckBox, QDialog, QFileDialog, QFrame, QHBoxLayout, QLabel,
                               QPushButton, QSizePolicy, QVBoxLayout)

from .theme import BG, INK, LINE, MUTED, OK, OK_SOFT, PRIMARY, PRIMARY_SOFT, SURFACE, WARN, WARN_SOFT

PACK_FILTER = "원큐합격 문제팩 (*.zip)"
ROUND_RE = re.compile(r"^oneq-([A-Za-z0-9]+)-(\d{4})-(\d+)\.zip$")


def cert_name(code: str) -> str:
    """종목 코드 → 이름(출제기준 프로필). 모르면 코드 그대로."""
    try:
        from .. import standards as S
        return S.load(code).name
    except Exception:  # noqa: BLE001 — 프로필이 없는 종목
        return code


def describe(path: Path) -> str:
    """'건설안전기사 2016~2025년 묶음' / '건설안전기사 2022년 2회' — 파일 이름에서(묶음·회차 팩)."""
    m = re.match(r"^원큐합격 문제팩_(.+?)(?:_(\d{4})(?:-(\d{4}))?)?\((\d+)회차\)\.zip$", path.name)
    if m:
        name, y1, y2, n = m.groups()
        span = (f" {y1}~{y2}년" if y2 else f" {y1}년") if y1 else ""
        return f"{name}{span} {n}회차"
    m = re.match(r"^oneq-([A-Za-z0-9]+)-bundle-(\d{4})(?:-(\d{4}))?\.zip$", path.name)
    if m:
        code, y1, y2 = m.groups()
        span = "" if y1 == "0000" else (f" {y1}~{y2}년" if y2 and y2 != y1 else f" {y1}년")
        return f"{cert_name(code)}{span} 묶음"
    m = ROUND_RE.match(path.name)
    if m:
        code, y, n = m.groups()
        return f"{cert_name(code)} {y}년 {int(n)}회"
    return path.stem


def size_text(path_or_bytes) -> str:
    if isinstance(path_or_bytes, int):
        n = path_or_bytes
    else:
        n = path_or_bytes.stat().st_size if path_or_bytes.exists() else 0
    return f"{n / 1_048_576:.1f}MB" if n >= 1_048_576 else f"{max(1, round(n / 1024))}KB"


def rounds_by_cert(out_dir: Path | None) -> dict[str, list[Path]]:
    """문제팩 폴더 안쪽 회차별 팩(.회차별\\oneq-종목-연도-회.zip)을 종목 코드별로."""
    out: dict[str, list[Path]] = {}
    if out_dir and Path(out_dir).exists():
        from ..pack import rounds_dir
        for f in sorted(rounds_dir(Path(out_dir)).glob("oneq-*.zip")):
            m = ROUND_RE.match(f.name)
            if m:
                out.setdefault(m.group(1), []).append(f)
    return out


def years_of(files: list[Path]) -> list[int]:
    ys = set()
    for f in files:
        m = ROUND_RE.match(f.name)
        if m and int(m.group(2)) > 0:
            ys.add(int(m.group(2)))
    return sorted(ys)


def full_bundle(code: str, rounds: list[Path], out_dir: Path) -> Path | None:
    """종목의 모든 회차를 묶음 하나로 — 이 파일이 곧 보낼 파일(「원큐합격 문제팩_종목_연도(n회차).zip」, 예전 묶음은 지움)."""
    from ..bundle import write_bundle
    return write_bundle(rounds, out_dir, code)


def pack_message(items: list[tuple[str, Path]]) -> str:
    """메일 본문 — 문제팩만(학습앱·생성기 안내 없음). 주소처럼 보이는 파일 이름은 넣지 않는다."""
    lines = ["원큐합격 문제팩을 보냅니다.", ""]
    for title, f in items:
        lines.append(f"· {title} ({size_text(f)})")
    lines += ["", "첨부한 파일을 원큐합격 학습앱의 [문제팩 가져오기]로 넣으세요."]
    return "\n".join(lines)


def files_mime(files: list[Path]) -> QMimeData:
    """파일 자체(탐색기에서 복사한 것과 같음) — 카카오톡 PC·메일 쓰기 창에 Ctrl+V 하면 첨부된다."""
    md = QMimeData()
    md.setUrls([QUrl.fromLocalFile(str(f)) for f in files])
    return md


def copy_files_to_clipboard(files: list[Path], hwnd: int = 0) -> bool:
    """파일을 클립보드에 — 탐색기에서 [복사]한 것과 같은 형식(CF_HDROP + Preferred DropEffect=복사).
    실기기(2026-11-16): Qt 기본 방식(파일 주소 목록)으로 넣으면 카카오톡 PC에 Ctrl+V 해도 아무것도 붙지 않았다 →
    Windows에서는 직접 넣는다. 다른 운영체제·실패 시 Qt 방식."""
    if sys.platform == "win32":
        try:
            return _win_copy_files(files, hwnd)
        except Exception as e:  # noqa: BLE001 — 기록하고 아래 Qt 방식으로
            _log(f"클립보드(Windows) 실패: {type(e).__name__}: {e}")
    md = files_mime(files)
    md.setData('application/x-qt-windows-mime;value="Preferred DropEffect"', b"\x01\x00\x00\x00")
    QApplication.clipboard().setMimeData(md)
    return False


def _log(msg: str) -> None:
    try:
        from .app import log_dir
        import datetime
        with open(log_dir() / "error.log", "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n")
    except Exception:  # noqa: BLE001
        pass


def _win_copy_files(files: list[Path], hwnd: int = 0) -> bool:
    """실기기(2026-11-16 저녁): 창 없이(NULL) 클립보드를 열면 EmptyClipboard 뒤 SetClipboardData가 실패한다(Windows 문서) →
    공유 창의 창 번호(hwnd)로 연다. 넣은 뒤 CF_HDROP이 실제로 있는지 확인."""
    import ctypes
    from ctypes import wintypes
    k32, u32 = ctypes.windll.kernel32, ctypes.windll.user32
    k32.GlobalAlloc.restype = wintypes.HGLOBAL
    k32.GlobalAlloc.argtypes = (wintypes.UINT, ctypes.c_size_t)
    k32.GlobalLock.restype = ctypes.c_void_p
    k32.GlobalLock.argtypes = (wintypes.HGLOBAL,)
    k32.GlobalUnlock.argtypes = (wintypes.HGLOBAL,)
    u32.SetClipboardData.argtypes = (wintypes.UINT, wintypes.HANDLE)
    u32.SetClipboardData.restype = wintypes.HANDLE
    u32.RegisterClipboardFormatW.argtypes = (wintypes.LPCWSTR,)
    u32.OpenClipboard.argtypes = (wintypes.HWND,)
    u32.IsClipboardFormatAvailable.argtypes = (wintypes.UINT,)
    GMEM_MOVEABLE, CF_HDROP = 0x0002, 15

    def put(fmt: int, data: bytes) -> None:
        h = k32.GlobalAlloc(GMEM_MOVEABLE, len(data))
        ptr = k32.GlobalLock(h)
        ctypes.memmove(ptr, data, len(data))
        k32.GlobalUnlock(h)
        if not u32.SetClipboardData(fmt, h):
            raise OSError("SetClipboardData")

    names = "".join(str(Path(f).resolve()) + "\0" for f in files) + "\0"
    # DROPFILES { DWORD pFiles=20; POINT pt; BOOL fNC; BOOL fWide=1 } + 와이드 문자 경로 목록
    import struct
    drop = struct.pack("<IiiII", 20, 0, 0, 0, 1) + names.encode("utf-16-le")
    effect = u32.RegisterClipboardFormatW("Preferred DropEffect")
    for _ in range(10):                       # 다른 프로그램이 잠깐 잡고 있으면 다시
        if u32.OpenClipboard(wintypes.HWND(hwnd) if hwnd else None):
            break
        import time
        time.sleep(0.05)
    else:
        raise OSError("OpenClipboard")
    try:
        if not u32.EmptyClipboard():
            raise OSError("EmptyClipboard")
        put(CF_HDROP, drop)
        put(effect, struct.pack("<I", 1))     # DROPEFFECT_COPY
    finally:
        u32.CloseClipboard()
    if not u32.IsClipboardFormatAvailable(CF_HDROP):
        raise OSError("넣은 뒤 클립보드에 파일(CF_HDROP)이 없음")
    return True


STYLE = f"""
QDialog#shareDialog {{ background: {BG}; }}
QLabel#shTitle {{ font-size: 21px; font-weight: 800; color: {INK}; }}
QLabel#shSub {{ font-size: 14px; color: {MUTED}; }}
QLabel#shSection {{ font-size: 13px; font-weight: 800; color: {MUTED}; }}
QFrame#certRow {{ background: {SURFACE}; border: 1px solid {LINE}; border-radius: 12px; }}
QFrame#certRow[on="true"] {{ border: 2px solid {PRIMARY}; background: #f7faff; }}
QLabel#certName {{ font-size: 17px; font-weight: 700; color: {INK}; background: transparent; border: 0; }}
QLabel#certMeta {{ font-size: 14px; color: {MUTED}; background: transparent; border: 0; }}
QLabel#certMark {{ border-radius: 13px; font-size: 15px; font-weight: 900; qproperty-alignment: AlignCenter; }}
QLabel#certMark[on="true"] {{ background: {PRIMARY}; color: white; border: 2px solid {PRIMARY}; }}
QLabel#certMark[on="false"] {{ background: {SURFACE}; color: transparent; border: 2px solid #b8c2d0; }}
QFrame#sendTile {{ background: {SURFACE}; border: 1px solid {LINE}; border-radius: 14px; }}
QFrame#sendTile:hover {{ border: 2px solid {PRIMARY}; background: {PRIMARY_SOFT}; }}
QFrame#sendTile:focus {{ border: 2px solid {PRIMARY}; }}
QFrame#sendTile:disabled {{ background: #f1f3f7; border: 1px solid {LINE}; }}
QLabel#tileIcon {{ font-size: 24px; background: transparent; }}
QLabel#tileTitle {{ font-size: 16px; font-weight: 800; color: {INK}; background: transparent; }}
QLabel#tileHint {{ font-size: 13px; color: {MUTED}; background: transparent; }}
QLabel#tileTitle:disabled, QLabel#tileHint:disabled, QLabel#tileIcon:disabled {{ color: #a9b2bf; }}
QPushButton#shLink {{ border: 0; background: transparent; color: {PRIMARY}; font-size: 14px; padding: 6px 4px; }}
QPushButton#shLink:hover {{ text-decoration: underline; }}
QFrame#shDone {{ border-radius: 12px; }}
QFrame#shDone[kind="ok"] {{ background: {OK_SOFT}; border: 1px solid #b7dfc6; }}
QFrame#shDone[kind="warn"] {{ background: {WARN_SOFT}; border: 1px solid #f0d58c; }}
QLabel#shDoneTitle {{ font-size: 16px; font-weight: 800; background: transparent; }}
QLabel#shDoneTitle[kind="ok"] {{ color: {OK}; }}
QLabel#shDoneTitle[kind="warn"] {{ color: {WARN}; }}
QLabel#shDoneText {{ color: {INK}; font-size: 14px; background: transparent; }}
QFrame#dragFile {{ background: {SURFACE}; border: 2px dashed {PRIMARY}; border-radius: 12px; }}
QFrame#dragFile:hover {{ background: {PRIMARY_SOFT}; }}
QLabel#dragGrip {{ color: {PRIMARY}; font-size: 13px; font-weight: 700; background: transparent; }}
QLabel#shEmpty {{ background: {SURFACE}; border: 1px dashed {LINE}; border-radius: 12px; padding: 22px; color: {MUTED};
                  font-size: 14px; }}
"""


class CertRow(QFrame):
    """보낼 종목 카드 한 줄 — 카드 어디를 눌러도 체크가 바뀜."""

    def __init__(self, title: str, meta: str, checked: bool, on_change):
        super().__init__()
        self.setObjectName("certRow")
        self.setCursor(Qt.PointingHandCursor)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(16, 12, 16, 12)
        lay.setSpacing(14)
        self.check = QCheckBox(self)              # 상태만 들고(보이지 않음) — 보이는 표시는 둥근 체크(certMark)
        self.check.setVisible(False)
        self.check.setChecked(checked)
        self.check.toggled.connect(lambda _on: (self._paint(), on_change()))
        self.mark = QLabel("✓")
        self.mark.setObjectName("certMark")
        self.mark.setFixedSize(26, 26)
        lay.addWidget(self.mark, 0, Qt.AlignVCenter)
        v = QVBoxLayout()
        v.setSpacing(2)
        self.name = QLabel(title)
        self.name.setObjectName("certName")
        self.meta = QLabel(meta)
        self.meta.setObjectName("certMeta")
        v.addWidget(self.name)
        v.addWidget(self.meta)
        lay.addLayout(v, 1)
        self._paint()

    def _paint(self) -> None:
        on = "true" if self.check.isChecked() else "false"
        for w in (self, self.mark):
            w.setProperty("on", on)
            w.style().unpolish(w)
            w.style().polish(w)

    def mouseReleaseEvent(self, e):  # noqa: N802 — Qt 이름
        if e.button() == Qt.LeftButton:
            self.check.toggle()
        super().mouseReleaseEvent(e)


class Tile(QFrame):
    """보내는 방법 단추 — 아이콘 + 제목(굵게) + 한 줄 설명. 누르면 clicked."""
    clicked = Signal()

    def __init__(self, icon: str, title: str, hint: str):
        super().__init__()
        self.setObjectName("sendTile")
        self.setCursor(Qt.PointingHandCursor)
        self.setFixedHeight(84)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        self.setFocusPolicy(Qt.StrongFocus)
        h = QHBoxLayout(self)
        h.setContentsMargins(18, 12, 18, 12)
        h.setSpacing(14)
        ic = QLabel(icon)
        ic.setObjectName("tileIcon")
        h.addWidget(ic, 0, Qt.AlignVCenter)
        v = QVBoxLayout()
        v.setSpacing(3)
        v.addStretch(1)
        for text, name in ((title, "tileTitle"), (hint, "tileHint")):
            lab = QLabel(text)
            lab.setObjectName(name)
            v.addWidget(lab)
        v.addStretch(1)
        h.addLayout(v, 1)

    def click(self) -> None:
        if self.isEnabled():
            self.clicked.emit()

    def mouseReleaseEvent(self, e):  # noqa: N802 — Qt 이름
        if e.button() == Qt.LeftButton and self.rect().contains(e.position().toPoint()):
            self.click()
        super().mouseReleaseEvent(e)

    def keyPressEvent(self, e):  # noqa: N802
        if e.key() in (Qt.Key_Return, Qt.Key_Enter, Qt.Key_Space):
            self.click()
        else:
            super().keyPressEvent(e)


class ShareDialog(QDialog):

    def __init__(self, parent=None, out_dir: Path | None = None, status=None, example: Path | None = None):
        super().__init__(parent)
        self.setObjectName("shareDialog")
        self.setWindowTitle("문제팩 공유하기")
        self.setStyleSheet(STYLE)
        self.setMinimumWidth(640)
        self.status = status
        self.out_dir = Path(out_dir) if out_dir else None
        self.shared = False                       # 보내기까지 했는지 — 작업 순서 ④ 완료 표시
        self.extra: list[Path] = []               # 직접 고른 파일(받은 문제팩을 다시 보낼 때)
        self.prepared: list[tuple[str, Path]] = []    # (설명, 보낼 파일) — 마지막으로 만든 것

        lay = QVBoxLayout(self)
        lay.setContentsMargins(28, 24, 28, 22)
        lay.setSpacing(0)
        t = QLabel("문제팩 공유하기")
        t.setObjectName("shTitle")
        sub = QLabel("보낼 종목을 고르고 보내는 방법을 누르세요. 종목마다 모든 회차가 파일 하나로 갑니다.")
        sub.setObjectName("shSub")
        sub.setWordWrap(True)
        lay.addWidget(t)
        lay.addSpacing(4)
        lay.addWidget(sub)
        lay.addSpacing(22)

        # ① 보낼 종목
        s1 = QLabel("①  보낼 종목")
        s1.setObjectName("shSection")
        lay.addWidget(s1)
        lay.addSpacing(8)
        self.rows: list[tuple[CertRow, str, list[Path]]] = []
        groups = rounds_by_cert(self.out_dir)
        prefer = None
        if example is not None and (m := re.match(r"^oneq-([A-Za-z0-9]+)-", example.name)):
            prefer = m.group(1)
        for code, files in groups.items():
            ys = years_of(files)
            size = sum(f.stat().st_size for f in files if f.exists())
            meta = f"{len(files)}회차" + (f"  ·  {ys[0]}~{ys[-1]}년" if ys else "") + f"  ·  {size_text(size)}"
            row = CertRow(cert_name(code), meta, code == prefer or len(groups) == 1, self.update_state)
            lay.addWidget(row)
            lay.addSpacing(8)
            self.rows.append((row, code, files))
        if not groups:
            e = QLabel("문제팩 폴더에 만든 문제팩이 없어요.\n③ [문제팩 만들기]를 먼저 하거나, 아래 [다른 파일 고르기]로 고르세요.")
            e.setObjectName("shEmpty")
            e.setAlignment(Qt.AlignCenter)
            e.setWordWrap(True)
            lay.addWidget(e)
            lay.addSpacing(8)
        self.extra_label = QLabel()
        self.extra_label.setObjectName("certMeta")
        self.extra_label.setWordWrap(True)
        self.extra_label.setVisible(False)
        lay.addWidget(self.extra_label)
        lay.addSpacing(16)

        # ② 보내는 방법
        s2 = QLabel("②  보내는 방법")
        s2.setObjectName("shSection")
        lay.addWidget(s2)
        lay.addSpacing(8)
        trow = QHBoxLayout()
        trow.setSpacing(12)
        self.kakao_btn = Tile("💬", "카카오톡·메신저로", "선택된 파일을 대화창으로 끌어다 놓기")
        self.mail_btn = Tile("✉", "메일로", "사내 메일·네이버·Gmail 등 어떤 메일이든")
        self.kakao_btn.clicked.connect(self.send_messenger)
        self.mail_btn.clicked.connect(self.send_email)
        trow.addWidget(self.kakao_btn)
        trow.addWidget(self.mail_btn)
        lay.addLayout(trow)
        lay.addSpacing(14)

        # 결과 안내(보낸 뒤에만)
        self.done_box = QFrame()
        self.done_box.setObjectName("shDone")
        dv = QVBoxLayout(self.done_box)
        dv.setContentsMargins(16, 12, 16, 12)
        dv.setSpacing(4)
        self.done_title = QLabel()
        self.done_title.setObjectName("shDoneTitle")
        self.done_text = QLabel()
        self.done_text.setObjectName("shDoneText")
        self.done_text.setWordWrap(True)
        self.done_text.setTextFormat(Qt.RichText)
        self.done_text.setOpenExternalLinks(True)
        dv.addWidget(self.done_title)
        dv.addWidget(self.done_text)
        self.drag_box = QVBoxLayout()            # 보낼 파일 카드(끌어다 놓기)
        self.drag_box.setSpacing(6)
        dv.addLayout(self.drag_box)
        self.done_box.setVisible(False)
        lay.addWidget(self.done_box)

        lay.addStretch(1)                         # 창을 키워도 위에서부터 차곡차곡(틈이 벌어지지 않게)
        lay.addSpacing(14)
        foot = QHBoxLayout()
        self.pick_btn = QPushButton("다른 파일 고르기…")
        self.pick_btn.setObjectName("shLink")
        self.pick_btn.setToolTip("받은 문제팩을 다시 보내는 경우 등")
        self.pick_btn.clicked.connect(self.pick)
        self.reveal_btn = QPushButton("보낼 파일 폴더 열기")
        self.reveal_btn.setObjectName("shLink")
        self.reveal_btn.clicked.connect(self.reveal)
        foot.addWidget(self.pick_btn)
        foot.addWidget(self.reveal_btn)
        foot.addStretch(1)
        close = QPushButton("닫기")
        close.setMinimumWidth(96)
        close.clicked.connect(self.accept)
        foot.addWidget(close)
        self._close = close
        lay.addLayout(foot)
        self.update_state()
        self._fit()                                    # 처음 크기는 내용만큼(빈 공간 없이)
        self._close.setFocus()                         # 보내는 방법 단추가 처음부터 눌린 것처럼 보이지 않게

    # ── 상태 ──
    def checked(self) -> list[tuple[str, list[Path]]]:
        return [(code, files) for row, code, files in self.rows if row.check.isChecked()]

    def update_state(self) -> None:
        on = bool(self.checked() or self.extra)
        self.kakao_btn.setEnabled(on)
        self.mail_btn.setEnabled(on)
        self.extra_label.setVisible(bool(self.extra))
        self.extra_label.setText("직접 고른 파일: " + ", ".join(f.name for f in self.extra))

    def pick(self) -> None:
        start = str(self.out_dir) if self.out_dir and self.out_dir.exists() else ""
        files, _ = QFileDialog.getOpenFileNames(self, "보낼 문제팩 고르기(여러 개 가능)", start, PACK_FILTER)
        for f in map(Path, files):
            if f not in self.extra and f.suffix.lower() == ".zip":
                self.extra.append(f)
        self.update_state()

    # ── 보낼 파일 만들기 ──
    def send_dir(self) -> Path:
        return self.out_dir or (self.extra[0].parent if self.extra else Path.home())

    def prepare(self) -> list[tuple[str, Path]]:
        """체크한 종목마다 모든 회차 묶음(문제팩 폴더의 종목 파일 하나)을 새로 만들어 그대로 보냄(+직접 고른 파일).
        예전의 '보낼 문제팩' 복사본은 없앰(사용자 2026-11-17 — 종목마다 파일 하나)."""
        out: list[tuple[str, Path]] = []
        for code, rounds in self.checked():
            target = full_bundle(code, rounds, self.out_dir or rounds[0].parent.parent)
            if not target:
                continue
            ys = years_of(rounds)
            out.append((f"{cert_name(code)} " + (f"{ys[0]}~{ys[-1]}년 " if ys else "") + f"{len(rounds)}회차", target))
        for f in self.extra:
            if f.exists():
                out.append((describe(f), f))
        self.prepared = out
        return out

    # ── 보내기 ──
    def send_messenger(self) -> None:
        """카카오톡 PC로 보내기(실기기 2026-11-16): 카카오톡 PC는 파일 붙여넣기를 받지 않고, 이 프로그램에서 끌어다 놓으면
        파일이 아니라 주소 글(file:///…)로 들어갔다. 탐색기에서 끌어다 놓는 것만 확실히 되므로(사용자 확인 — 이 방법 하나로)
        보낼 파일이 선택된 탐색기 창을 열어 준다."""
        items = self.prepare()
        if not items:
            return
        self.reveal_files([f for _, f in items])
        self.shared = True
        self.show_done("ok", "보낼 파일을 탐색기에 선택해 두었어요",
                       "방금 열린 탐색기 창에서 <b>선택된 파일을 카카오톡 대화창으로 끌어다 놓기</b> → [전송].<br>"
                       f"<span style='color:{MUTED}'>파일 이름에 종목·연도·회차가 들어 있어 메시지를 따로 쓰지 않아도 됩니다.</span>")
        if self.status is not None:
            self.status.setText("보낼 문제팩을 탐색기에 선택해 두었어요 — 카카오톡 대화창으로 끌어다 놓으세요")

    def reveal_files(self, files: list[Path]) -> None:
        """탐색기에서 파일을 선택한 채로 열기(하나면 그 파일 선택, 여럿이면 폴더)."""
        if sys.platform == "win32" and len(files) == 1:
            import subprocess
            subprocess.Popen(f'explorer /select,"{files[0]}"')  # noqa: S602 — 경로는 우리가 만든 파일
        else:
            QDesktopServices.openUrl(QUrl.fromLocalFile(str(files[0].parent)))

    def send_email(self) -> None:
        """메일로 보내기(사용자 2026-11-16 — 대부분 Outlook을 쓰지 않음, Outlook이 없으면 'Outlook.pst를 찾을 수 없음' 오류):
        어떤 메일(사내 그룹웨어·네이버·Gmail 등)이든 되게 — 본문 글을 클립보드에 넣고, 보낼 파일이 선택된 탐색기 창을 연다.
        사용자는 쓰던 메일의 새 메일 쓰기에서 본문 Ctrl+V, 파일은 첨부 칸으로 끌어다 놓기. 자주 쓰는 웹메일은 바로 열기 링크."""
        items = self.prepare()
        if not items:
            return
        files = [f for _, f in items]
        subject = "[원큐합격] " + ", ".join(t for t, _ in items) + " 문제팩"
        body = pack_message(items)
        QApplication.clipboard().setText(f"{subject}\n\n{body}")
        self.reveal_files(files)
        self.shared = True
        big = sum(f.stat().st_size for f in files if f.exists()) > 20 * 1_048_576
        from urllib.parse import quote
        gmail = f"https://mail.google.com/mail/?view=cm&fs=1&su={quote(subject)}&body={quote(body)}"
        links = (f"<a href='{gmail}'>Gmail 새 메일</a> · <a href='https://mail.naver.com/'>네이버 메일</a> · "
                 "<a href='https://mail.daum.net/'>다음 메일</a>")
        self.show_done("ok", "메일에 붙일 글을 복사하고 파일을 선택해 두었어요",
                       "① 쓰시는 메일(사내 메일·네이버·Gmail 등)에서 <b>새 메일 쓰기</b><br>"
                       "② 본문에 <b>Ctrl+V</b> — 제목·안내 글이 붙습니다<br>"
                       "③ 열린 탐색기 창의 <b>선택된 파일을 첨부 칸으로 끌어다 놓기</b> → 받는 사람 넣고 [보내기]<br>"
                       + (f"<span style='color:{MUTED}'>파일이 커서 '대용량 첨부'로 올라갈 수 있어요(받는 쪽에서 내려받기 기간이 있음).</span><br>" if big else "")
                       + f"<span style='color:{MUTED}'>바로 열기: </span>{links}")
        if self.status is not None:
            self.status.setText("메일에 붙일 글을 복사했어요 — 새 메일 본문에 Ctrl+V, 파일은 첨부 칸으로 끌어다 놓기")

    def show_done(self, kind: str, title: str, text: str) -> None:
        while self.drag_box.count():              # 지난번 파일 카드 지움
            w = self.drag_box.takeAt(0).widget()
            if w is not None:
                w.deleteLater()
        for w in (self.done_box, self.done_title):
            w.setProperty("kind", kind)
            w.style().unpolish(w)
            w.style().polish(w)
        self.done_title.setText(("✓  " if kind == "ok" else "!  ") + title)
        self.done_text.setText(text)
        self.done_box.setVisible(True)
        self._fit()

    def _fit(self) -> None:
        """내용 높이에 맞춤 — 최소 크기보다 작게 요청하면 Windows가 setGeometry 경고를 내므로 최소 크기 이상으로."""
        lay = self.layout()
        lay.activate()
        h = max(self.sizeHint().height(), self.minimumSizeHint().height(), self.minimumHeight())
        if self.height() < h or not self.isVisible():
            self.resize(max(660, self.width() if self.isVisible() else 0), h)

    def reveal(self) -> None:
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.send_dir())))
