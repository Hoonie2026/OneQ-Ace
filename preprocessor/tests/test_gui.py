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
from oneq_prep.gui.review_dialog import QuestionCard, ReviewDialog  # noqa: E402

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
def test_run_review_rerun(win, qtbot, tmp_path):
    win.add_paths(PDFS)
    assert [r.pack_id for r in win.rows] == ["SAFETY-2022-1", "SAFETY-2022-2"]
    win.start()
    qtbot.waitUntil(lambda: win.worker is None and win.done == 2, timeout=180_000)
    assert [r.status for r in win.rows] == ["packed", "packed"]
    assert (tmp_path / "packs" / "oneq-SAFETY-2022-2.zip").exists()
    assert "팩 2개" in win.status.text()
    assert all(r.law > 0 for r in win.rows)                       # 법령·기준 문항 표시(ADR 019)
    assert win.law_note.isVisible() is False or "법령" in win.law_note.title.text()
    assert "법령·기준" in win.law_note.title.text()

    # 검수 창: 5번 정답을 바꾸고 저장 → 검수 파일
    r = win.rows[1]
    dlg = ReviewDialog(r.prepared, tmp_path / "packs", win)
    qtbot.addWidget(dlg)
    dlg.filter.setCurrentIndex(1)                       # 전체 문항
    cards = dlg.scroll.widget().findChildren(QuestionCard)
    assert len(cards) == 120
    c5 = cards[4]
    new = c5.it.answer % 4 + 1
    c5.answer.setCurrentIndex(new - 1)
    dlg._save(rerun=True)
    rv = json.loads((tmp_path / "packs" / "review" / "SAFETY-2022-2.review.json").read_text(encoding="utf-8"))
    assert rv["answers"] == {"5": new} and rv["exclude"] == {} and dlg.rerun

    # 한 회차만 다시 만들어도 회차 번호(2022-2)가 그대로
    win.start([r.pdf])
    qtbot.waitUntil(lambda: win.worker is None and win.rows[1].status == "packed", timeout=120_000)
    import zipfile
    z = zipfile.ZipFile(tmp_path / "packs" / "oneq-SAFETY-2022-2.zip")
    q5 = [q for q in json.loads(z.read("questions.json")) if q["no"] == 5][0]
    assert q5["answer"] == new and q5["answerCheck"] == "corrected"


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
    assert win.picker.code == "SURVEY" and "2025" in win.picker.qnet.title.text()
    assert "단원 63개" in win.picker.info.text()


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
    assert "최신 출제기준과 같아요" in win.picker.qnet.title.text() and not win.picker.busy.isVisibleTo(win.picker)
    from oneq_prep import qnet
    from oneq_prep.gui.cert_picker import Cert
    # 전에 받은 출제기준(기간 안)이 있으면 조회가 실패해도 그것으로 계속(실기기 2026-11-12)
    win.on_qnet_failed(str(qnet.QnetOffline("TimeoutError")))
    assert "전에 받은 출제기준" in win.picker.qnet.title.text() and "TimeoutError" in win.picker.qnet.text.text()
    assert not win.picker.fail.isVisibleTo(win.picker) and win.picker.code == "CIVIL"
    win.picker.current = Cert("없는종목기사")                      # 받아 둔 것이 없으면 올리기 상자
    win.on_qnet_failed(str(qnet.QnetChanged()))
    assert "화면이 바뀌어" in win.picker.fail.title.text() and "직접 내려받아" in win.picker.fail.text.text()


def test_comcbt_button_adds_files_and_guides(win, qtbot, tmp_path, monkeypatch):
    """[comcbt 최근 기출 받기] → 받은 PDF가 목록에 들어가고, 이전·최신 회차는 직접 올리라는 안내(사용자 결정 2026-10-24)."""
    from oneq_prep import comcbt
    src = ROOT / "source_pdf" / "safety_기출_2003_2022" / "건설안전기사20220424(교사용).pdf"
    if not src.exists():
        pytest.skip("건설안전 기출 PDF 없음")

    def fake(name, dest, have, progress=None, should_stop=None):
        dest.mkdir(parents=True, exist_ok=True)
        out = dest / src.name
        out.write_bytes(src.read_bytes())
        post = comcbt.Post("건설안전기사 필기 기출문제 및 CBT 2022년 04월 24일(2회)", "u", "2022-04-24", "2회")
        progress and progress(1, 1, post)
        return comcbt.Result("nj", [post], [out], more_pages=True)
    monkeypatch.setattr(comcbt, "fetch_recent", fake)
    win.comcbt_fetch()
    qtbot.waitUntil(lambda: win.comcbt_thread is None, timeout=30_000)
    assert [r.pack_id for r in win.rows] == ["SAFETY-2022-2"]
    assert "1회차" in win.comcbt_note.title.text() and "직접 내려받아" in win.comcbt_note.text.text()
    assert (tmp_path / "packs" / "기출 PDF" / "건설안전기사" / src.name).exists()


def test_share_dialog(win, tmp_path, monkeypatch):
    """④ [문제팩 공유하기](사용자 2026-11-12): 학습앱·생성기 안내 없이 문제팩만 — 종목에 체크하면 그 종목의 **모든 회차**를
    묶음 하나로 새로 만들어(예전 일부 묶음은 지움) [선택 완료 · 메시지 복사] → 메시지가 클립보드에, [문제팩 파일 복사]로 파일 자체."""
    import json
    import zipfile

    from PySide6.QtWidgets import QApplication, QCheckBox, QLabel, QPlainTextEdit

    from oneq_prep.appinfo import APP_URL
    from oneq_prep.batch import RoundResult
    from oneq_prep.gui import share_dialog as sd

    win.out_dir = tmp_path

    def pack(pid):
        f = tmp_path / f"oneq-{pid}.zip"
        with zipfile.ZipFile(f, "w") as z:
            z.writestr("manifest.json", json.dumps({"packId": pid}))
        return f
    r1, r2, r3, c1 = pack("SAFETY-2020-1"), pack("SAFETY-2021-2"), pack("SAFETY-2022-2"), pack("CIVIL-2022-1")
    old = tmp_path / "oneq-SAFETY-bundle-2022-2022.zip"                          # 지난번에 새로 만든 회차만 든 묶음
    old.write_bytes(b"z")
    shown = []
    monkeypatch.setattr(sd.ShareDialog, "exec", lambda self: shown.append(self) or 0)
    win.show_share()
    d = shown[0]
    assert d.windowTitle() == "문제팩 공유하기"
    labels = " ".join(q.text() for q in d.findChildren(QLabel))
    assert "종목에 체크" in labels
    assert "학습앱 설치" not in labels and "생성기" not in labels and APP_URL not in labels
    checks = {cb.text().split(" — ")[0]: cb for cb in d.findChildren(QCheckBox)}
    assert set(checks) == {"건설안전기사", "토목기사"} and "3회차 · 2020~2022년" in checks["건설안전기사"].text()
    checks["건설안전기사"].setChecked(True)
    checks["토목기사"].setChecked(False)
    assert d.done_btn.isEnabled() and not d.result.isVisibleTo(d)
    d.done_btn.click()
    full = tmp_path / "oneq-SAFETY-bundle-2020-2022.zip"
    assert d.list.paths() == [full] and not old.exists()
    assert sorted(zipfile.ZipFile(full).namelist()) == sorted(f.name for f in (r1, r2, r3))
    msg = d.findChild(QPlainTextEdit, "msg_pack").toPlainText()
    assert QApplication.clipboard().text() == msg and d.result.isVisibleTo(d) and d.shared
    assert full.name in msg and "건설안전기사 2020~2022년 묶음" in msg
    assert "http" not in msg and "학습앱" not in msg and "생성기" not in msg       # 순수하게 문제팩만
    d.copy_files_btn.click()
    urls = [u.toLocalFile() for u in QApplication.clipboard().mimeData().urls()]
    assert [Path(u) for u in urls] == [full]
    md = d.list.mimeData([d.list.item(0)])                                       # 목록에서 끌어다 놓기 = 파일
    assert [Path(u.toLocalFile()) for u in md.urls()] == [full]
    monkeypatch.setattr(sd.QFileDialog, "getOpenFileNames", lambda *x, **k: ([str(c1)], ""))
    d.pick()                                                                     # 보조: 파일 직접 고르기
    assert c1 in d.list.paths()
    win.shared = True                                                            # ④까지 하면 작업 순서 끝(앞 단계가 끝났을 때)
    win.bundle = full
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
    items = [NS(no=k + 1, subject=subj, answer=1, answer_source="inline-mark", qtype="concept", unit=None,
                unit_candidates=[], sequence=False, excluded=False, suggestion=None, image=buf.getvalue(),
                warnings=["정답 표시가 둘"] if k < n_warn else [])
             for k in range(5)]
    return NS(items=items, profile=prof, exam={"year": 2022, "round": 1, "date": "2022-03-05"}, info=None,
              pdf=tmp_path / "a.pdf", issues=[])


def test_result_while_running(win, qtbot, tmp_path, monkeypatch):
    """처리 중에도 먼저 끝난 파일(준비 끝, 단원·팩 대기)은 '결과 보기'로 열리고, 검수 뒤 다시 만들기는 처리가 끝나면 이어서."""
    from oneq_prep.batch import RoundResult
    from oneq_prep.gui import app as appmod
    from oneq_prep.gui.result_dialog import ResultDialog
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    win.pdfs = [a, b]
    win.rows = [RoundResult(pdf=a, pack_id="SAFETY-2022-1", date="2022-03-05", status="running", stage="단원 대기"),
                RoundResult(pdf=b, pack_id="SAFETY-2022-2", date="2022-04-24", status="running", stage="정답")]
    win.rows[0].prepared = _fake_prepared(tmp_path, n_warn=2)
    win.worker = object()                       # 처리 중
    win.render_rows()
    assert "확인할 문항 2건 · 결과 보기" in win.table.item(0, appmod.C_MSG).text()
    assert "결과 보기" not in win.table.item(1, appmod.C_MSG).text()
    assert 0.8 <= win.table.item(0, appmod.C_PROG).data(appmod.Qt.UserRole) < 1.0     # 단원 대기 = 분류와 팩 사이

    seen = []
    monkeypatch.setattr(ResultDialog, "exec", lambda self: seen.append(self.pending) or 0)
    win.open_result(1, appmod.C_MSG)            # 아직 처리 중인 파일 → 안 열림
    win.open_result(0, appmod.C_MSG)
    assert seen == [True]

    # 실제 결과 화면(처리 중 표시)
    dlg = ResultDialog(win.rows[0], win, pending=True)
    qtbot.addWidget(dlg)
    texts = " ".join(lbl.text() for lbl in dlg.findChildren(appmod.QLabel))
    assert "처리가 끝난 뒤 확정" in texts and "다른 회차를 처리하는 중" in texts

    # 검수 → 다시 만들기: 처리 중이면 미뤘다가 끝나면 시작
    class FakeReview:
        def __init__(self, *a, **k):
            self.rerun = True

        def exec(self):
            return 1
    monkeypatch.setattr(appmod, "ReviewDialog", FakeReview)
    started = []
    monkeypatch.setattr(win, "start", lambda pdfs=None: started.append(pdfs))
    win.open_review(win.rows[0])
    assert win.pending_rerun == [a] and started == []
    win.on_finished(win.rows)
    qtbot.waitUntil(lambda: started == [[a]], timeout=2000)
    assert win.pending_rerun == []


def test_main_screen_work_order(win, qtbot, tmp_path, monkeypatch):
    """메인 화면 재설계(사용자 2026-11-12): 작업 순서 ① 종목 선택 → ② 기출 PDF 업로드 → ③ 문제팩 만들기 → ④ 문제팩 보내기.
    ② 안은 번호 상자(2-1·2-2) 대신 두 영역(comcbt.com 최근 기출 받기 / 사용자 직접 올리기), 조건 셋은 끌어다 놓는 상자 아래 늘 보임.
    ① 종목은 처음에 빈칸(미리 골라 둔 종목 없음). 머리말의 [동료에게 보내기]·[학습앱 설치]는 없음."""
    from PySide6.QtCore import QSettings
    from PySide6.QtWidgets import QFrame, QPushButton

    from oneq_prep.batch import RoundResult
    from oneq_prep.gui.app import MainWindow, QLabel
    texts = [lbl.text() for lbl in win.findChildren(QLabel)]
    assert "종목 선택" in texts and "기출 PDF 업로드" in texts and "종목 선택(출제기준 다운로드)" not in texts
    assert [lbl.text() for lbl in win.findChildren(QLabel) if lbl.objectName() == "flowText"] == \
        ["종목 선택", "기출 PDF 업로드", "문제팩 만들기", "문제팩 보내기"]
    assert [f.accessibleName() for f in win.findChildren(QFrame) if f.objectName() == "srcArea"] == ["comcbt", "upload"]
    assert [lbl.text() for lbl in win.findChildren(QLabel) if lbl.objectName() == "srcTitle"] == \
        ["comcbt.com 최근 기출 받기", "사용자 직접 올리기"]
    assert not [lbl for lbl in win.findChildren(QLabel) if lbl.objectName() == "subStep"]
    chips = [lbl.text() for lbl in win.findChildren(QLabel) if lbl.objectName() == "condChip"]
    assert chips == ["조건 1", "조건 2", "조건 3"]
    steps = [lbl.text() for lbl in win.findChildren(QLabel) if lbl.objectName() == "cardStep"]
    assert sorted(steps) == ["1", "2", "3", "4"]
    buttons = [b.text() for b in win.findChildren(QPushButton)]
    assert "문제팩 만들기" in buttons and "문제팩 공유하기" in buttons
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
    qtbot.addWidget(w2)
    assert w2.picker.current is None and w2.picker.edit.text() == ""
    assert w2.flow_state() == ["now", "todo", "todo", "todo"]
    assert "① 종목 선택" in w2.drop_hint.text() and not w2.drop.isEnabled()


def test_comcbt_hint_round_count(win):
    """2-1 안내에 첫 쪽이 대략 몇 회차인지(받기 전 어림), 받은 뒤엔 이 종목의 실제 회차 수·기간(사용자 2026-11-11)."""
    from oneq_prep import comcbt
    assert "약 20회차" in win.comcbt_hint.text() and "5~6년치" in win.comcbt_hint.text()
    posts = [comcbt.Post("t", "u", "2016-05-08", "2회"), comcbt.Post("t", "u", "2022-04-24", "2회")]
    win.on_comcbt_done(comcbt.Result("nj", posts, [], skipped=["a", "b"]))
    assert "2회차 · 2016년 5월 ~ 2022년 4월" in win.comcbt_hint.text()
    assert comcbt.first_page_text(comcbt.Result("nj", [])) == "첫 쪽에 필기 기출 글이 없어요"


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
    (win.out_dir / "oneq-Q1-2020-1.zip").write_text("x")
    src = win.out_dir / "기출 PDF" / "종목" / "a.pdf"
    src.parent.mkdir(parents=True)
    src.write_text("x")
    assert len(win.reset_targets()) == 5
    monkeypatch.setattr(appmod.QMessageBox, "question", lambda *a, **k: appmod.QMessageBox.Yes)
    win.reset_all()
    assert src.exists() and not (win.out_dir / "review").exists() and not list(win.out_dir.glob("oneq-*.zip"))
    assert not list((home / "standards").iterdir()) and not list((home / "qnet").iterdir())
    assert win.picker.current is None and "처음 상태" in win.status.text()
