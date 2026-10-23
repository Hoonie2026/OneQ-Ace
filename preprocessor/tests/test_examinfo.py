"""문서 내용에서 종목·시행일·회차·출처 읽기(ADR 021 2절, PREP-PLAN-v0.5 B2)."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "preprocessor"))
from oneq_prep import examinfo as E  # noqa: E402
from oneq_prep import standards as S  # noqa: E402

SRC = ROOT / "source_pdf"


@pytest.mark.parametrize("date,expect", [
    ("2003-03-16", (1, None)), ("2011-06-12", (2, None)), ("2018-04-28", (2, None)), ("2011-10-02", (3, None)),
    ("2018-08-19", (3, None)), ("2020-06-06", (1, "1·2회 통합")), ("2020-08-22", (3, None)), ("2020-09-26", (4, None)),
])
def test_round_from_month(date, expect):
    """기사 정기시험 3회(3월·4~6월·7월 이후), 2020년 1·2회 통합·3회·4회 — 지금까지 만든 팩 회차와 같다."""
    assert E.round_from_date(date) == expect


def test_unknown_date_gets_stable_number(tmp_path, monkeypatch):
    """시행일·연도를 못 찾으면 "0000년 nn회" — 같은 파일은 다시 처리해도 같은 번호, 새 파일은 다음 번호."""
    a, b = tmp_path / "a.pdf", tmp_path / "b.pdf"
    a.write_bytes(b"A")
    b.write_bytes(b"B")
    prof = S.load("SURVEY")
    monkeypatch.setattr(E, "read", lambda p, ocr_text=None, names=None: E.ExamInfo())
    ex_a, _ = E.exam_of(a, prof, tmp_path / "out")
    ex_b, _ = E.exam_of(b, prof, tmp_path / "out")
    again, _ = E.exam_of(a, prof, tmp_path / "out")
    assert ex_a == {"year": 0, "round": 1, "date": "0000-00-00", "dateUnknown": True} and ex_b["round"] == 2 and again == ex_a
    assert E.pack_id("SURVEY", ex_b) == "SURVEY-0000-2"
    assert not prof.is_legacy(ex_a["date"])           # 옛 기준 재배정 대상으로 보지 않음


def test_year_round_without_date():
    info = E.ExamInfo(year=2024, round=3)
    ex, _ = E.exam_of(Path("x.pdf"), S.load("CIVIL"), Path("."), info=info)
    assert ex == {"year": 2024, "round": 3, "date": "2024-00-00", "dateUnknown": True}


def test_manual_date_wins():
    ex, _ = E.exam_of(Path("x.pdf"), S.load("CIVIL"), Path("."), date="2024-07-05", info=E.ExamInfo(year=2024, round=3))
    assert ex == {"year": 2024, "round": 3, "date": "2024-07-05"}


COMCBT = SRC / "survey_기출_2011_2022" / "측량및지형공간정보기사20200822(교사용).pdf"
HANSOL = SRC / "civil_경향문제" / "토목기사_2024_3회_경향문제(한솔).pdf"


@pytest.mark.skipif(not COMCBT.exists(), reason="측량 기출 PDF 없음")
def test_comcbt_header():
    i = E.read(COMCBT)
    assert (i.cert_name, i.date, i.year, i.round) == ("측량및지형공간정보기사", "2020-08-22", 2020, 3)
    assert (i.source_type, i.origin) == ("public-pbt", "comcbt (www.comcbt.com)")


@pytest.mark.skipif(not HANSOL.exists(), reason="토목 경향문제 PDF 없음")
def test_hansol_trend_questions():
    i = E.read(HANSOL)
    assert (i.cert_name, i.year, i.round, i.date) == ("토목기사", 2024, 3, None)
    assert i.source_type == "other" and i.origin == "한솔아카데미" and "유형문제" in i.note
