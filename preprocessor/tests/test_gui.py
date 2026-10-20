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
    from PySide6.QtCore import QSettings
    QSettings.setPath(QSettings.IniFormat, QSettings.UserScope, str(tmp_path / "settings"))
    w = MainWindow()
    w.settings = QSettings(str(tmp_path / "s.ini"), QSettings.IniFormat)
    qtbot.addWidget(w)
    w.out.setText(str(tmp_path / "packs"))
    w.name.setText("시험")
    w.cert.setCurrentIndex(w.cert.findData("SAFETY"))
    w.workers.setValue(2)
    return w


def test_plan_and_date_entry(win, tmp_path):
    a = tmp_path / "토목기사_2024_3회_경향문제.pdf"
    b = tmp_path / "건설안전기사20220305(교사용).pdf"
    a.write_bytes(b"%PDF-1.4")
    b.write_bytes(b"%PDF-1.4")
    win.add_paths([tmp_path])
    assert [r.pdf.name for r in win.rows] == sorted([a.name, b.name])
    i = [r.pdf.name for r in win.rows].index(a.name)
    assert win.rows[i].status == "error" and "시행일" in win.table.item(i, 4).text()
    win.table.item(i, 1).setText("2024-07-05")
    win.refresh_plan()
    assert win.rows[i].pack_id == "SAFETY-2024-3" and win.rows[i].status == "waiting"
    assert "만든 사람" not in (win.check_inputs(win.pdfs) or "")


def test_inputs_required(win):
    win.name.setText("")
    assert "PDF" in win.check_inputs([])
    assert "만든 사람" in win.check_inputs([Path("x.pdf")])


@pytest.mark.skipif(not all(p.exists() for p in PDFS), reason="건설안전 기출 PDF 없음")
def test_run_review_rerun(win, qtbot, tmp_path):
    win.add_paths(PDFS)
    assert [r.pack_id for r in win.rows] == ["SAFETY-2022-1", "SAFETY-2022-2"]
    win.start()
    qtbot.waitUntil(lambda: win.worker is None and win.done == 2, timeout=180_000)
    assert [r.status for r in win.rows] == ["packed", "packed"]
    assert (tmp_path / "packs" / "oneq-SAFETY-2022-2.zip").exists()
    assert "팩 2개" in win.status.text()

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
