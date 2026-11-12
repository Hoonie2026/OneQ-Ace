"""일괄 처리(batch): 회차 하나가 실패해도 나머지는 계속, 동시 처리 결과 = 순서 처리 결과, 멈추기."""
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep.batch import BatchSpec, run_batch  # noqa: E402

SAFETY = Path(__file__).resolve().parents[2] / "source_pdf" / "safety_기출_2003_2022"
GOOD = [SAFETY / "건설안전기사20220305(교사용).pdf", SAFETY / "건설안전기사20220424(교사용).pdf"]
need = pytest.mark.skipif(not all(p.exists() for p in GOOD), reason="건설안전 기출 PDF 없음")


@need
def test_broken_pdf_does_not_stop_others(tmp_path):
    bad = tmp_path / "건설안전기사20210307(교사용).pdf"
    bad.write_bytes(b"%PDF-1.4 broken")
    events = []
    rows = run_batch(BatchSpec([*GOOD, bad], "SAFETY", tmp_path / "out", "시험", workers=2), events.append)
    st = {r.pdf.name: r.status for r in rows}
    assert st[bad.name] == "error" and [st[p.name] for p in GOOD] == ["packed", "packed"]
    assert [e.kind for e in events][0] == "plan" and events[-1].kind == "finish"
    assert (tmp_path / "out" / "review" / "report.html").exists()


@need
def test_parallel_equals_sequential(tmp_path):
    a = run_batch(BatchSpec(GOOD, "SAFETY", tmp_path / "a", "시험", workers=1))
    b = run_batch(BatchSpec(GOOD, "SAFETY", tmp_path / "b", "시험", workers=2))
    for ra, rb in zip(a, b):
        za, zb = zipfile.ZipFile(ra.zip_path), zipfile.ZipFile(rb.zip_path)
        assert ra.pack_id == rb.pack_id
        assert all(za.read(n) == zb.read(n) for n in za.namelist() if n != "manifest.json")


@need
def test_stop_skips_rest(tmp_path):
    rows = run_batch(BatchSpec(GOOD, "SAFETY", tmp_path / "o", "시험", workers=1), should_stop=lambda: True)
    assert [r.status for r in rows] == ["skipped", "skipped"]


def test_unsure_answer_auto_exclude():
    """정답을 믿을 수 없는 문항은 검수 대신 자동으로 뺀다(사용자 2026-11-12)."""
    from oneq_prep.pack import AUTO_EXCLUDE, Item, unsure_answer

    def item(ans, warns):
        return Item(1, 1, "과목", "과목", ans, "inline-mark", "single", [], 4, b"", (1, 1), "", [], warns)
    assert unsure_answer(item(None, ["정답을 찾지 못함"]), None) == AUTO_EXCLUDE + "정답 못 찾음"
    assert unsure_answer(item(2, ["보기 표시 2 ≠ 정답표 3"]), None).endswith("정답표가 다름")
    assert unsure_answer(item(2, ["정답 표시 2개: [1, 2]"]), None).endswith("여러 개")
    assert unsure_answer(item(2, []), [(0, 0, 1, 1)]).endswith("남아 보임")
    assert unsure_answer(item(2, ["OCR: 보기 번호 3개만 찾음"]), None) is None      # 정답이 있으면 모양 경고로는 빼지 않음
