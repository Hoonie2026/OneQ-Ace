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


def _it(no, text, ans, doubt=None, alts=(), choices=4):
    from oneq_prep.pack import Item
    it = Item(no, no, "과목", "과목", ans, "inline-mark", "single", [], choices, b"", (1, 1), text, [], [])
    it.doubt, it.alts = doubt, list(alts)
    return it


class _P:
    def __init__(self, pid, items):
        self.pack_id, self.items, self.notes = pid, items, []


def test_crosscheck_then_flag_or_drop(tmp_path):
    """C 교차 확인 → 안 되면 B '정답 확인 필요'(다른 후보도 인정), 정답 후보가 없으면 뺌(사용자 2026-11-12)."""
    from oneq_prep import crosscheck
    from oneq_prep.pack import AUTO_EXCLUDE, settle_doubts
    q = "12. 콘크리트의 압축강도 시험에서 공시체의 표준 양생 온도는? ① 10±2℃ ② 15±2℃ ③ 20±2℃ ④ 25±2℃"
    moved = "37. 콘크리트의 압축강도 시험에서 공시체의 표준 양생 온도는? ① 25±2℃ ② 20±2℃ ③ 15±2℃ ④ 10±2℃"
    good = _P("X-2020-1", [_it(12, q, 3)])
    bad = _P("X-2021-1", [_it(37, moved, None, "정답 못 찾음"),                       # 보기 순서가 달라도 정답 글로 위치(2번)
                          _it(5, "5. 어디에도 없는 다른 문항의 발문입니다 ① 가 ② 나 ③ 다 ④ 라", 2, "보기 표시와 정답표가 다름", [4]),
                          _it(6, "6. 정답을 전혀 찾지 못한 문항의 발문입니다 ① 가 ② 나 ③ 다 ④ 라", None, "정답 못 찾음")])
    assert crosscheck.apply([good, bad], tmp_path, "X") == 1
    a, b, c = bad.items
    assert a.answer == 2 and a.answer_source == "cross-check" and a.doubt is None
    settle_doubts(bad)
    assert not a.excluded and "answer-unsure" not in a.flags
    assert "answer-unsure" in b.flags and b.accept_also == [4] and not b.excluded           # B: 넣고 표시
    assert c.excluded == AUTO_EXCLUDE + "정답 못 찾음"                                         # 정답 후보 없음 → 뺌
    settle_doubts(bad)                                                                       # 두 번 불러도 같음
    assert b.flags.count("answer-unsure") == 1


def test_crosscheck_conflicting_answers_not_used(tmp_path):
    from oneq_prep import crosscheck
    q = "1. 같은 발문인데 회차마다 정답이 다르게 표시된 문항 ① 가 ② 나 ③ 다 ④ 라"
    ps = [_P("X-2019-1", [_it(1, q, 1)]), _P("X-2019-2", [_it(1, q, 2)]), _P("X-2020-1", [_it(1, q, None, "정답 못 찾음")])]
    assert crosscheck.apply(ps, tmp_path, "X") == 0
