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
    assert win.spec([Path("x.pdf")]).prepared_by.startswith("원큐합격 전처리기")


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
    win.picker.select(elec)
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
