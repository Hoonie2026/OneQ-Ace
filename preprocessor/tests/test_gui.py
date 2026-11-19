"""창 프로그램 시험(화면 없이 — QT_QPA_PLATFORM=offscreen). PySide6·pytest-qt가 없으면 건너뛴다."""
import json
import os
import sys
from pathlib import Path

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
pytest.importorskip("PySide6")
pytest.importorskip("pytestqt")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oneq_prep.gui.app import MainWindow  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SAFETY = ROOT / "source_pdf" / "safety_기출_2003_2022"
PDFS = [SAFETY / "건설안전기사20220305(교사용).pdf", SAFETY / "건설안전기사20220424(교사용).pdf"]


@pytest.fixture
def win(qtbot, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))          # QSettings를 시험 폴더에
    monkeypatch.setenv("ONEQ_NO_NETWORK", "1")          # 큐넷에 묻지 않음(A3 — 시험은 네트워크 없이)
    monkeypatch.setenv("ONEQ_PREP_HOME", str(tmp_path / "home"))
    from PySide6.QtCore import QSettings
    QSettings.setPath(QSettings.IniFormat, QSettings.UserScope, str(tmp_path / "settings"))
    w = MainWindow()
    w.plan_async = False                    # 목록 미리 읽기를 바로(시험 — 스레드 비동기는 test_plan_async에서)
    w.settings = QSettings(str(tmp_path / "s.ini"), QSettings.IniFormat)
    qtbot.addWidget(w)
    w.out_dir = tmp_path / "packs"          # 저장 폴더는 기본 폴더(입력 칸 없음, ADR 021 6절)
    assert w.set_cert("SAFETY")
    w.settings.setValue("workers", 2)
    return w


def test_plan_reads_content_not_filename(win, tmp_path):
    """v0.5(ADR 021 2절): 시행일·회차는 파일 이름이 아니라 내용에서 — 열 수 없는 파일은 오류로 표시."""
    a = tmp_path / "토목기사_2024_3회_경향문제.pdf"
    b = tmp_path / "건설안전기사20220305(교사용).pdf"
    a.write_bytes(b"%PDF-1.4")
    b.write_bytes(b"%PDF-1.4 x")
    win.add_paths([tmp_path])
    assert [r.pdf.name for r in win.rows] == sorted([a.name, b.name])
    from oneq_prep.gui.app import C_MSG
    for i in range(2):
        assert win.rows[i].status == "error" and "열 수 없" in win.table.item(i, C_MSG).text()
    assert "처리할 수 있는 PDF가 없" in (win.check_inputs(win.pdfs) or "")


def test_inputs_required(win):
    """입력 칸은 종목·PDF뿐(만든 사람·출처·폴더·속도는 자동, ADR 021 6절)."""
    win.picker.current = None
    assert "종목" in win.check_inputs([Path("x.pdf")])
    win.set_cert("SAFETY")
    assert "PDF" in win.check_inputs([])
    assert win.check_inputs([Path("x.pdf")]) is None
    assert win.spec([Path("x.pdf")]).prepared_by.startswith("원큐합격 문제팩 생성기")


@pytest.mark.skipif(not all(p.exists() for p in PDFS), reason="건설안전 기출 PDF 없음")
def test_run_makes_one_zip(win, qtbot, tmp_path):
    win.add_paths(PDFS)
    assert [r.pack_id for r in win.rows] == ["SAFETY-2022-1", "SAFETY-2022-2"]
    win.start()
    qtbot.waitUntil(lambda: win.worker is None and win.done == 2, timeout=180_000)
    assert [r.status for r in win.rows] == ["packed", "packed"]
    assert (tmp_path / "packs" / ".회차별" / "oneq-SAFETY-2022-2.zip").exists()
    assert "팩 2개" in win.status.text()
    assert all(r.law > 0 for r in win.rows)                       # 법령·기준 문항 표시(ADR 019)
    assert win.law_note.isVisible() is False or "법령" in win.law_note.title.text()
    assert "법령·기준" in win.law_note.title.text()

    # 문제팩 폴더에는 종목 파일 하나만(회차별 팩은 안쪽 .회차별 — 사용자 2026-11-17)
    assert [f.name for f in (tmp_path / "packs").glob("*.zip")] == ["원큐합격 문제팩_건설안전기사_2022(2회차).zip"]
    assert not (tmp_path / "packs" / "review").exists()


def test_cert_search_and_profile_dialog(win, qtbot, tmp_path, monkeypatch):
    """프로필이 없는 종목(전기기사) → [과목 직접 입력] → 저장하면 검색에 ✓, 처리 가능."""
    monkeypatch.setenv("ONEQ_PREP_HOME", str(tmp_path / "home"))
    from oneq_prep.certs import search
    from oneq_prep.gui.profile_dialog import ProfileDialog
    win.picker.reload()
    elec = search("전기", win.picker.certs)[0]
    win.picker.select(elec, query=True)          # 오프라인 시험 → 못 받음 안내 + 올리기 상자
    assert win.picker.code is None and win.picker.missing.isVisibleTo(win.picker)
    dlg = ProfileDialog(elec, win)
    qtbot.addWidget(dlg)
    dlg.code_edit.setText("ELEC")
    from PySide6.QtWidgets import QTableWidgetItem
    for r, name in enumerate(["전기자기학", "전력공학", "전기기기", "회로이론 및 제어공학", "전기설비기술기준"]):
        dlg.table.setItem(r, 0, QTableWidgetItem(name))
    dlg._save()
    assert dlg.code == "ELEC" and (tmp_path / "home" / "standards" / "ELEC.json").exists()
    win.picker.reload()
    assert win.set_cert("ELEC") and win.picker.code == "ELEC"
    assert "5과목 100문항" in win.picker.info.text()


def test_drop_standard_pdf_makes_profile(win, tmp_path):
    """큐넷 보기 창에서 [저장]한 출제기준 PDF를 끌어다 놓으면 기출 목록이 아니라 종목 출제기준으로(A3)."""
    pdf = Path(__file__).parent / "fixtures" / "standards" / "SURVEY-qnet-2025-2027.pdf"
    win.add_paths([pdf])
    assert win.pdfs == []                                          # 기출 목록에 들어가지 않음
    assert (tmp_path / "home" / "standards" / "SURVEY.json").exists()
    assert win.picker.code == "SURVEY" and "읽기 완료" in win.picker.qnet.title.text()
    t = win.picker.qnet.text.text()                       # 핵심만: 종목명·버전·과목 수·과목별 문항(사용자 2026-11-17)
    assert "종목명" in t and "적용기간" in t and "과목명" in t and "1과목" not in t and "읽다가" not in t
    assert "과목, " in t and "&nbsp;" * 4 + "측량학" in t    # '4과목, 80문항' + 왼쪽 끝에서 네 칸 들여 쓴 과목명
    assert "세부항목 63개" in win.picker.info.text()


def test_query_flow_offline_shows_upload_box(win, qtbot, tmp_path):
    """[조회] → Q-Net에 못 닿으면 안내 + 출제기준 PDF 올리기 상자, ② 기출 PDF는 출제기준이 정해질 때까지 막힘(사용자 흐름 2026-10-24)."""
    win.picker.edit.setText("전기기사")
    win.picker.query()
    assert win.picker.fail.isVisibleTo(win.picker) and win.picker.upload.isVisibleTo(win.picker)
    assert "직접 내려받아" in win.picker.fail.text.text() and "끈 상태" in win.picker.fail.title.text()
    assert not win.pdf_buttons[0].isEnabled() and "조회" in win.drop_hint.text()
    win.import_standard_pdf(Path(__file__).parent / "fixtures" / "standards" / "CIVIL-qnet-2026-2027.pdf")
    assert win.picker.code == "CIVIL" and not win.picker.fail.isVisibleTo(win.picker) and win.pdf_buttons[0].isEnabled()


def test_qnet_result_messages(win):
    from oneq_prep.qnet import Post
    post = Post("토목기사", "토목기사(2026.1.1~2027.12.31)", "1250", "1004", "2026-01-01", "2027-12-31")
    win.on_qnet({"code": "CIVIL", "post": post, "upcoming": None, "warnings": [], "same": True})
    assert "최신과 같아요" in win.picker.qnet.title.text() and not win.picker.busy.isVisibleTo(win.picker)
    t = win.picker.qnet.text.text()
    assert "토목기사" in t and "적용기간" in t and "과목명" in t and "문항" in t and "과목 수" not in t
    assert not win.picker.info.isVisibleTo(win.picker)                 # 같은 내용을 두 번 보이지 않음
    win.on_qnet({"code": "CIVIL", "post": post, "upcoming": None, "warnings": ["세부항목 번호"], "same": False})
    assert win.picker.qnet.title.text() == "출제기준 받기 완료!" and "세부항목 번호" not in win.picker.qnet.text.text()
    from oneq_prep import qnet
    from oneq_prep.gui.cert_picker import Cert
    # 전에 받은 출제기준(기간 안)이 있으면 조회가 실패해도 그것으로 계속(실기기 2026-11-12)
    win.on_qnet_failed(str(qnet.QnetOffline("TimeoutError")))
    assert "전에 받은 출제기준" in win.picker.qnet.title.text() and "TimeoutError" in win.picker.qnet.text.text()
    assert not win.picker.fail.isVisibleTo(win.picker) and win.picker.code == "CIVIL"
    win.picker.current = Cert("없는종목기사")                      # 받아 둔 것이 없으면 올리기 상자
    win.on_qnet_failed(str(qnet.QnetChanged()))
    assert "화면이 바뀌어" in win.picker.fail.title.text() and "직접 내려받아" in win.picker.fail.text.text()


def test_share_dialog(win, tmp_path, monkeypatch):
    """④ [문제팩 공유하기](재설계 2026-11-16): 종목 카드 체크 → 보내는 방법 한 번 —
    카카오톡 = 한글 이름 묶음 파일을 클립보드에(메시지 따로 없음), 메일 = 제목·본문·첨부를 한 창에(MAPI)."""
    import json
    import time
    import zipfile

    from PySide6.QtWidgets import QApplication, QLabel

    from oneq_prep.appinfo import APP_URL
    from oneq_prep.batch import RoundResult
    from oneq_prep.gui import share_dialog as sd

    win.out_dir = tmp_path

    def wait_for(cond):
        end = time.time() + 2
        while not cond():
            QApplication.processEvents()
            assert time.time() < end

    def pack(pid):
        f = tmp_path / ".회차별" / f"oneq-{pid}.zip"
        f.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(f, "w") as z:
            z.writestr("manifest.json", json.dumps({"packId": pid}))
        return f
    r1, r2, r3, _c1 = pack("SAFETY-2020-1"), pack("SAFETY-2021-2"), pack("SAFETY-2022-2"), pack("CIVIL-2022-1")
    old = tmp_path / "oneq-SAFETY-bundle-2022-2022.zip"                          # 지난번에 새로 만든 회차만 든 묶음
    old.write_bytes(b"z")
    shown = []
    monkeypatch.setattr(sd.ShareDialog, "exec", lambda self: shown.append(self) or 0)
    win.show_share()
    d = shown[0]
    labels = " ".join(q.text() for q in d.findChildren(QLabel))
    assert "보낼 종목" in labels and "보내는 방법" in labels
    assert "학습앱 설치" not in labels and "생성기" not in labels and APP_URL not in labels
    rows = {r.name.text(): r for r, _, _ in d.rows}
    assert set(rows) == {"건설안전기사", "토목기사"} and "3회차  ·  2020~2022년" in rows["건설안전기사"].meta.text()
    assert rows["건설안전기사"].check.isChecked() and not rows["토목기사"].check.isChecked()   # 마지막 묶음 종목이 먼저 체크
    rows["건설안전기사"].check.setChecked(False)
    assert not d.kakao_btn.isEnabled() and not d.mail_btn.isEnabled()
    rows["건설안전기사"].check.setChecked(True)
    revealed = []
    monkeypatch.setattr(sd.ShareDialog, "reveal_files", lambda self, fs: revealed.append(fs))
    d.kakao_btn.click()                                                          # 카카오톡: 파일만 한 번에
    sent = tmp_path / "원큐합격 문제팩_건설안전기사_2020-2022(3회차).zip"            # 문제팩 폴더의 종목 파일 하나 그대로
    assert sent.exists() and not old.exists() and not (tmp_path / "보낼 문제팩").exists()
    assert sorted(f.name for f in tmp_path.glob("*.zip")) == [sent.name]
    assert sorted(zipfile.ZipFile(sent).namelist()) == sorted(f.name for f in (r1, r2, r3))
    # 카카오톡 PC: 붙여넣기 안 됨·우리 창에서 끌면 주소 글로 감 → 파일이 선택된 탐색기 창(그 하나로, 사용자 2026-11-16)
    assert d.shared and d.done_box.isVisibleTo(d) and revealed == [[sent]] and "끌어다 놓기" in d.done_text.text()
    assert "Ctrl+V" not in d.done_text.text()
    d.send_email()                                                               # 메일: 어떤 메일이든 — 글 복사 + 파일 선택
    body = QApplication.clipboard().text()
    assert body.startswith("[원큐합격] 건설안전기사 2020~2022년 3회차 문제팩") and revealed[-1] == [sent]
    assert "oneq-" not in body and "http" not in body and ".zip" not in body          # 주소처럼 보이는 글 없음
    assert "Ctrl+V" in d.done_text.text() and "mail.google.com" in d.done_text.text()
    win.shared = True                                                            # ④까지 하면 작업 순서 끝(앞 단계가 끝났을 때)
    win.bundle = sent
    win.rows = [RoundResult(pdf=r1, pack_id="SAFETY-2022-1", status="packed")]
    assert win.flow_state() == ["done", "done", "done", "done"]


def test_qnet_success_unlocks_pdf_area(win, qtbot, monkeypatch):
    """🖥P19(2026-11-11): [조회] 성공 뒤 ② 기출 PDF 단추·끌어다 놓기가 열려야 한다(전에는 잠긴 채 남음)."""
    from PySide6.QtCore import QObject, Signal, Slot

    from oneq_prep.gui import app as gui_app

    class Post:
        title = "건설안전기사(2026.1.1~2030.12.31)"

    class FakeWorker(QObject):
        done = Signal(object)
        failed = Signal(str)

        def __init__(self, *a):
            super().__init__()

        @Slot()
        def run(self):
            self.done.emit({"kind": "fetched", "code": "SAFETY", "post": Post(), "upcoming": None, "warnings": [], "same": True})

    monkeypatch.delenv("ONEQ_NO_NETWORK")
    monkeypatch.setattr(gui_app, "QnetWorker", FakeWorker)
    win.qnet_check(win.picker.current)
    qtbot.waitUntil(lambda: win.qnet_thread is None, timeout=5000)
    assert win.drop.isEnabled() and all(b.isEnabled() for b in win.pdf_buttons)
    assert "끌어다 놓으세요" in win.drop_hint.text()


# ── B3 마무리(세션 #17): ① 조건 예시 그림 ② 처리 중에 끝난 파일 결과 보기 ──
def test_condition_pictures(win, qtbot, monkeypatch):
    """조건 셋마다 예시 그림 — 그려지고(빈 그림 아님), 누르면 크게 보는 창."""
    from PySide6.QtCore import Qt
    from PySide6.QtGui import QColor, QImage, QPainter
    from oneq_prep.gui import app as appmod
    from oneq_prep.gui.samples import ConditionDialog
    pics = win.condition_pictures
    assert len(pics) == 3
    for pic in pics:
        img = QImage(320, 120, QImage.Format_ARGB32)
        img.fill(QColor("white"))
        p = QPainter(img)
        from PySide6.QtCore import QRectF
        from oneq_prep.gui.samples import paint
        paint(p, QRectF(0, 0, 320, 120), pic.index)
        p.end()
        dark = sum(1 for x in range(0, 320, 4) for y in range(0, 120, 4) if QColor(img.pixel(x, y)).lightness() < 200)
        assert dark > 30, pic.index
    opened = []
    monkeypatch.setattr(ConditionDialog, "exec", lambda self: opened.append((self.windowTitle(), self.big.index)) or 0)
    qtbot.mouseClick(pics[1], Qt.LeftButton)
    assert opened == [("예시 — 정답이 파일 안에", 1)]
    assert appmod.CONDITIONS[1][0] == "정답이 파일 안에"


def _fake_prepared(tmp_path, n_warn=0):
    import io
    from types import SimpleNamespace as NS
    from PIL import Image
    from oneq_prep import standards as S
    buf = io.BytesIO()
    Image.new("RGB", (200, 60), "white").save(buf, "PNG")
    prof = S.load("SAFETY")
    subj = prof.subjects[0]["name"]
    items = [NS(no=k + 1, subject=subj, answer=1, answer_source="inline-mark",
                excluded=False, suggestion=None, image=buf.getvalue(),
                warnings=["정답 표시가 둘"] if k < n_warn else [])
             for k in range(5)]
    return NS(items=items, profile=prof, exam={"year": 2022, "round": 1, "date": "2022-03-05"}, info=None,
              pdf=tmp_path / "a.pdf", issues=[])


def test_result_while_running(win, qtbot, tmp_path, monkeypatch):
    """처리 중 표시: 결과 보기 없음, 팩 대기는 '정답 확인' 앞, 처리 중에는 결과 화면을 열지 않음."""
    from oneq_prep.batch import RoundResult
    from oneq_prep.gui import app as appmod
    from oneq_prep.gui.result_dialog import ResultDialog
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    win.pdfs = [a, b]
    win.rows = [RoundResult(pdf=a, pack_id="SAFETY-2022-1", date="2022-03-05", status="running", stage="팩 대기"),
                RoundResult(pdf=b, pack_id="SAFETY-2022-2", date="2022-04-24", status="running", stage="정답")]
    win.rows[0].prepared = _fake_prepared(tmp_path, n_warn=2)
    win.worker = object()                       # 처리 중
    win.render_rows()
    assert win.table.item(0, appmod.C_MSG).text() == "5문항"   # 결과 보기 없음(2026-11-16)
    assert "결과 보기" not in win.table.item(1, appmod.C_MSG).text()
    assert 0.55 <= win.table.item(0, appmod.C_PROG).data(appmod.Qt.UserRole) < 0.8     # 팩 대기 = 정답 확인 앞

    seen = []
    monkeypatch.setattr(ResultDialog, "exec", lambda self: seen.append(self.pending) or 0)
    win.open_result(1, appmod.C_MSG)            # 처리 중에는 열지 않음(2026-11-16)
    win.open_result(0, appmod.C_MSG)
    assert seen == []

    # 실제 결과 화면(처리 중 표시)
    dlg = ResultDialog(win.rows[0], win, pending=True)
    qtbot.addWidget(dlg)
    texts = " ".join(lbl.text() for lbl in dlg.findChildren(appmod.QLabel))
    assert "모든 회차가 끝난 뒤" in texts and "다른 회차를 처리하는 중" in texts
    win.worker = None                           # 시험 끝 — 닫을 때 '처리 중' 질문이 뜨지 않게


def test_main_screen_work_order(win, qtbot, tmp_path, monkeypatch):
    """메인 화면 재설계(사용자 2026-11-12): 작업 순서 ① 종목 선택 → ② 기출 PDF 업로드 → ③ 문제팩 만들기 → ④ 문제팩 보내기.
    ② = 끌어다 놓는 큰 상자 + [폴더에서 선택하기] 하나 + 조건 셋(늘 보임) — comcbt 자동 받기 없음(2026-11-17).
    ① 종목은 처음에 빈칸(미리 골라 둔 종목 없음). 머리말의 [동료에게 보내기]·[학습앱 설치]는 없음."""
    from PySide6.QtCore import QSettings
    from PySide6.QtWidgets import QFrame, QPushButton

    from oneq_prep.batch import RoundResult
    from oneq_prep.gui.app import MainWindow, QLabel
    texts = [lbl.text() for lbl in win.findChildren(QLabel)]
    assert "종목 선택" in texts and "기출 PDF 업로드" in texts and "종목 선택(출제기준 다운로드)" not in texts
    assert [lbl.text() for lbl in win.findChildren(QLabel) if lbl.objectName() == "flowText"] == \
        ["종목 선택", "기출 PDF 업로드", "문제팩 만들기", "문제팩 보내기"]
    assert not [f for f in win.findChildren(QFrame) if f.objectName() == "srcArea"]
    assert not any("comcbt" in t for t in texts)
    assert not [lbl for lbl in win.findChildren(QLabel) if lbl.objectName() == "subStep"]
    chips = [lbl.text() for lbl in win.findChildren(QLabel) if lbl.objectName() == "condChip"]
    assert chips == ["조건 1", "조건 2", "조건 3"]
    steps = [lbl.text() for lbl in win.findChildren(QLabel) if lbl.objectName() == "cardStep"]
    assert sorted(steps) == ["1", "2", "3", "4"]
    buttons = [b.text() for b in win.findChildren(QPushButton)]
    assert "문제팩 만들기" in buttons and "문제팩 공유하기" in buttons
    assert "폴더에서 선택하기" in buttons and "최근 기출 받기" not in buttons
    assert "PDF 고르기" not in buttons and "폴더 고르기" not in buttons and not any("받아 둔" in t for t in buttons)
    assert "동료에게 보내기" not in buttons and "팩 만들기" not in buttons
    assert win.flow_state() == ["done", "now", "todo", "todo"]          # 종목은 골라져 있음 → 지금은 ② 업로드
    assert not win.cond_panel.isHidden()
    p = win.out_dir / "a.pdf"
    win.pdfs = [p]
    win.rows = [RoundResult(pdf=p, pack_id="SAFETY-2022-1", date="2022-03-05", status="waiting")]
    win.render_rows()
    assert not win.cond_panel.isHidden() and not win.drop.isHidden()    # 파일이 들어와도 상자·조건은 그대로(상자만 낮게)
    assert win.drop.maximumHeight() < 100
    assert win.flow_state() == ["done", "done", "now", "todo"]
    # 처음 켜면 종목은 빈칸(예전엔 측량이 미리 골라져 ① 체크)
    monkeypatch.setenv("HOME", str(tmp_path / "fresh"))
    QSettings.setPath(QSettings.IniFormat, QSettings.UserScope, str(tmp_path / "fresh-settings"))
    w2 = MainWindow()
    w2.plan_async = False
    qtbot.addWidget(w2)
    assert w2.picker.current is None and w2.picker.edit.text() == ""
    assert w2.flow_state() == ["now", "todo", "todo", "todo"]
    assert "① 종목 선택" in w2.drop_hint.text() and not w2.drop.isEnabled()


def test_reset_all_keeps_source_pdfs(win, tmp_path, monkeypatch):
    """도움말 › 처음 상태로 되돌리기(사용자 2026-11-12): 출제기준·문제팩·처리 보고서·오류 기록만 지우고 기출 PDF는 남김."""
    from oneq_prep.gui import app as appmod
    home = tmp_path / "home"
    monkeypatch.setenv("ONEQ_PREP_HOME", str(home))
    for f in ("standards/Q1.json", "qnet/Q1-1-1.pdf", "logs/error.log"):
        (home / f).parent.mkdir(parents=True, exist_ok=True)
        (home / f).write_text("x")
    win.out_dir = tmp_path / "packs"
    (win.out_dir / "review" / "Q1-2020-1").mkdir(parents=True)
    (win.out_dir / "oneq-Q1-2020-1.zip").write_text("x")                # 예전처럼 바깥에 있던 회차 팩
    (win.out_dir / ".회차별").mkdir()
    (win.out_dir / "원큐합격 문제팩_종목_2020(1회차).zip").write_text("x")
    src = win.out_dir / "기출 PDF" / "종목" / "a.pdf"
    src.parent.mkdir(parents=True)
    src.write_text("x")
    assert len(win.reset_targets()) == 7
    monkeypatch.setattr(appmod.QMessageBox, "question", lambda *a, **k: appmod.QMessageBox.Yes)
    win.reset_all()
    assert src.exists() and not (win.out_dir / "review").exists() and not list(win.out_dir.glob("*.zip"))
    assert not (win.out_dir / ".회차별").exists()
    assert not list((home / "standards").iterdir()) and not list((home / "qnet").iterdir())
    assert win.picker.current is None and "처음 상태" in win.status.text()


def test_pc_fixes_2026_11_16(win, tmp_path, monkeypatch):
    """실기기(2026-11-16): ① 추천 목록 글('…  ✓ 출제기준 있음')로 Q-Net에 묻던 것 ② 공유 창 닫기가 오류(속성 이름이 QDialog.done을 가림)."""

    from oneq_prep.gui import share_dialog as sd
    from oneq_prep.gui.cert_picker import MARK
    asked = []
    win.picker.want_qnet.connect(lambda c: asked.append(c))
    win.picker.edit.setText("건설안전기사" + MARK)
    win.picker.query()
    assert asked[-1].name == "건설안전기사" and asked[-1].profile == "SAFETY"
    win.out_dir = tmp_path
    dlg = sd.ShareDialog(win, tmp_path)
    dlg.show()
    dlg.done(0)                                                    # 닫기(accept) — 예전엔 TypeError
    assert not dlg.isVisible()


def test_already_made_asks_first(win, tmp_path, monkeypatch):
    """목록의 회차가 모두 이미 문제팩으로 있으면 [문제팩 만들기]가 먼저 묻는다(사용자 2026-11-16)."""
    from oneq_prep.batch import RoundResult
    from oneq_prep.gui import app as appmod
    win.out_dir = tmp_path
    p = tmp_path / "a.pdf"
    p.write_bytes(b"%PDF")
    (tmp_path / ".회차별").mkdir()
    (tmp_path / ".회차별" / "oneq-SAFETY-2022-1.zip").write_bytes(b"z")
    win.pdfs = [p]
    win.rows = [RoundResult(pdf=p, pack_id="SAFETY-2022-1", date="2022-03-05", status="waiting")]
    asked, shared = [], []
    monkeypatch.setattr(appmod.MainWindow, "check_inputs", lambda self, pdfs: "")
    monkeypatch.setattr(appmod.QMessageBox, "exec", lambda self: asked.append(self.text()) or 0)
    monkeypatch.setattr(appmod.QMessageBox, "clickedButton", lambda self: self.buttons()[0])   # [문제팩 공유하기]
    monkeypatch.setattr(appmod.MainWindow, "show_share", lambda self: shared.append(1))
    win.start()
    assert "이미 문제팩으로" in asked[0] and shared and win.thread is None


def test_picker_marks_only_saved_standards(win):
    """사용자 2026-11-16: 처음 상태(받아 둔 출제기준 없음)에서는 함께 배포된 프로필에 '출제기준 있음'을 붙이지 않음."""
    import json
    from oneq_prep import standards as S
    from oneq_prep.gui.cert_picker import MARK
    win.picker._suggest("건설안전")
    assert not any(MARK in t for t in win.picker._by_text)
    p = S.user_root() / "SAFETY.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(json.loads((S._root() / "SAFETY.json").read_text(encoding="utf-8")), ensure_ascii=False), encoding="utf-8")
    win.picker._suggest("건설안전")
    assert "건설안전기사" + MARK in win.picker._by_text


def test_plan_async(win, qtbot, tmp_path, monkeypatch):
    """실기기 2026-11-16: 목록에 넣은 PDF 미리 읽기는 다른 스레드에서 — 그동안 '읽는 중', 끝나면 회차가 보이고 [문제팩 만들기]는 기다림."""
    from oneq_prep.gui import app as appmod
    win.plan_async = True
    a = tmp_path / "a.pdf"
    a.write_bytes(b"%PDF-1.4 broken")
    win.add_paths([a])
    assert win.rows[0].message == "PDF 읽는 중…"
    warned = []
    monkeypatch.setattr(appmod.QMessageBox, "warning", lambda *a, **k: warned.append(a[2]))
    win.start()                                     # 읽는 중이면 기다렸다가 다 읽으면 바로 시작(다시 누르지 않음)
    assert "다 읽으면 바로" in win.status.text()
    qtbot.waitUntil(lambda: win.plan_thread is None and win.rows and win.rows[0].message != "PDF 읽는 중…", timeout=10000)
    qtbot.waitUntil(lambda: bool(warned), timeout=5000)   # 이어서 시작됨(이 시험에선 열 수 없는 파일뿐이라 입력 확인에서 멈춤)
    assert win.rows[0].status == "error"           # 열 수 없는 파일은 오류로(내용으로 판정)
    assert not win.planning()
    n = len(win.plan_cache)
    win.refresh_plan()                              # 읽은 것은 다시 읽지 않음
    assert len(win.plan_cache) == n and win.plan_thread is None
    win.close()                                     # 닫으면 미리 보기 타이머·스레드가 남지 않음(Windows 빌드에서 죽던 원인)
    qtbot.waitUntil(lambda: win.peek_thread is None and win.plan_thread is None, timeout=10000)
    assert not win.peek_timer.isActive()
    _ = appmod


def test_web_search_button(win, monkeypatch):
    """② 제목 줄 오른쪽 [기출 PDF 웹검색] — 조회한 종목으로 구글 검색 「종목명 필기 기출 PDF」(사용자 2026-11-17)."""
    from oneq_prep.gui import app as appmod
    opened = []
    monkeypatch.setattr(appmod.QDesktopServices, "openUrl", lambda u: opened.append(u.toString()))
    assert win.web_btn.isEnabled() and win.picker.current is not None
    win.web_btn.click()
    from urllib.parse import unquote
    assert opened and opened[0].startswith("https://www.google.com/search?q=")
    assert unquote(opened[0].split("q=", 1)[1]) == f"{win.picker.current.name} 필기 기출 PDF"


def test_flow_buttons_lock_and_reset(win, qtbot, tmp_path, monkeypatch):
    """사용자 2026-11-17: ① 조회 → ② 웹검색 → ③ 문제팩 만들기 → ④ 공유하기 순서로 지금 할 버튼만 파랑, 처리 중엔 모두 잠금,
    다 만든 뒤(또는 다른 종목) 조회하면 올린 목록을 비움, 진행 막대는 단계 진행을 합쳐 차오름."""
    from oneq_prep.batch import RoundResult
    from oneq_prep.gui import app as appmod
    flow = lambda: [b.property("flow") for b in (win.picker.b_query, win.web_btn, win.run_btn, win.share_btn)]  # noqa: E731
    win.update_ready()
    assert flow() == ["idle", "now", "idle", "idle"]                      # 종목 조회 끝 → ② 웹검색
    assert not win.run_btn.isEnabled() and not win.share_btn.isEnabled()
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    win.pdfs, win.list_code, win.cert_locked = [a, b], "SAFETY", True
    win.rows = [RoundResult(pdf=a, pack_id="SAFETY-2022-1", status="waiting"), RoundResult(pdf=b, pack_id="SAFETY-2022-2", status="waiting")]
    win.update_ready()
    assert flow()[2] == "now" and win.run_btn.isEnabled()                 # ③ 문제팩 만들기
    assert not win.picker.b_query.isEnabled() and not win.picker.edit.isEnabled()   # 올려 둔 채로는 종목 못 바꿈(실기기 2026-11-17)
    assert "만들기가 끝나면" in win.picker.b_query.toolTip()
    win.clear_files()
    win.update_ready()
    assert not win.picker.b_query.isEnabled()                              # [모두 비우기]로도 안 풀림(사용자 2026-11-17)
    win.pdfs = [a, b]
    win.rows = [RoundResult(pdf=a, pack_id="SAFETY-2022-1", status="waiting"), RoundResult(pdf=b, pack_id="SAFETY-2022-2", status="waiting")]
    win.worker = object()                                                 # 처리 중: 모두 잠금(멈추기만)
    win.run_pdfs, win.total_rounds = {a, b}, 2
    win.progress.setRange(0, 1000)
    win.progress.setValue(0)
    win.update_ready()
    win.set_running(True)                                                 # 만드는 중: [멈추기]만(실기기 2026-11-17)
    assert not any(x.isEnabled() for x in (win.picker.b_query, win.web_btn, win.run_btn, win.share_btn, win.picker.edit))
    assert not win.drop.isEnabled() and not any(b.isEnabled() for b in win.pdf_buttons) and win.stop_btn.isEnabled()
    assert not win.acceptDrops() and win.table.editTriggers() == appmod.QAbstractItemView.NoEditTriggers
    n = len(win.pdfs)
    win.add_paths([tmp_path])
    assert len(win.pdfs) == n
    win.rows[0].status, win.rows[0].stage = "running", "정답"
    win.update_progress()
    v1 = win.progress.value()
    win.rows[0].status = "packed"
    win.update_progress()
    assert 0 < v1 < win.progress.value() < 1000                           # 회차 하나 끝 → 절반쯤
    win.worker = None
    win.set_running(False)
    win.bundle = tmp_path / "x.zip"
    for r in win.rows:
        r.status = "packed"
    win.on_finished(win.rows)                                             # 다 만들면 잠금 풀림
    win.bundle = tmp_path / "x.zip"
    win.update_ready()
    assert flow()[3] == "now" and win.share_btn.isEnabled() and win.picker.b_query.isEnabled()   # ④ 공유하기
    asked = []
    monkeypatch.setattr(appmod.MainWindow, "refresh_plan", lambda self: None)
    win.progress.setRange(0, 1000)
    win.progress.setValue(1000)
    win.status.setText("끝 — 문제팩 2개")
    win.qnet_check(win.picker.current)                                    # 다 만든 뒤 다시 조회 → 목록 비움
    assert win.pdfs == [] and not win.made
    assert win.progress.value() == 0 and "끝" not in win.status.text()     # 진행 막대도 처음으로(실기기 2026-11-17)
    _ = asked


def test_other_cert_pdf_is_rejected(win, monkeypatch, tmp_path):
    """사용자 2026-11-17: ①에서 조회한 종목이 아닌 기출 PDF는 경고창을 띄우고 목록에 넣지 않음."""
    from oneq_prep.batch import RoundResult
    from oneq_prep.gui import app as appmod
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    rows = [RoundResult(pdf=a, pack_id="SAFETY-2022-1"),
            RoundResult(pdf=b, status="error", message="'콘크리트기사' 문서로 보여요", other_cert="콘크리트기사")]
    monkeypatch.setattr(appmod.MainWindow, "plan_rows", lambda self, code: [r for r in rows if r.pdf in self.pdfs])
    warned = []
    monkeypatch.setattr(appmod.QMessageBox, "warning", lambda *x, **k: warned.append(x[2]))
    win.pdfs = [a, b]
    win.refresh_plan()
    assert win.pdfs == [a] and [r.pdf for r in win.rows] == [a]
    win.warn_other_cert([rows[1]])
    assert "콘크리트기사" in warned[0] and "b.pdf" in warned[0] and "올리지 않았어요" in warned[0]


def test_no_answer_note(win, tmp_path):
    """정답 표시가 없는 PDF도 문제팩은 만들고 끝난 뒤 '정답은 학습앱에서 지정' 안내(조건 2는 안내로), 문항을 절반도 못 만든 스캔본만
    만들지 못함 — 사용자 2026-11-17."""
    import time as _t
    from types import SimpleNamespace as N

    from oneq_prep.batch import RoundResult
    from oneq_prep.pack import FEW_QUESTIONS_ISSUE, NO_ANSWER_NOTE
    a, b, c = tmp_path / "학생용.pdf", tmp_path / "교사용.pdf", tmp_path / "흐린스캔.pdf"
    rows = [RoundResult(pdf=a, pack_id="SAFETY-2022-1", status="packed", message="80문항 · 정답 미지정 80",
                        prepared=N(notes=[NO_ANSWER_NOTE])),
            RoundResult(pdf=b, pack_id="SAFETY-2022-2", status="packed", message="120문항", prepared=N(notes=[])),
            RoundResult(pdf=c, pack_id="SAFETY-2021-1", status="review", message=FEW_QUESTIONS_ISSUE)]
    win.rows, win.started = rows, _t.monotonic()
    win.on_finished(rows)
    assert win.noans_note.isVisibleTo(win) and "정답 표시가 없는 PDF 1개" in win.noans_note.title.text()
    body = win.noans_note.text.text()
    assert "학생용.pdf" in body and "교사용.pdf" not in body and "학습앱" in body
    assert "절반도 만들지 못한 스캔본 1개" in body and "흐린스캔.pdf" in body
