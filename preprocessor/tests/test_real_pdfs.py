"""실제 PDF로 하는 통합 시험. source_pdf/는 저장소에 없으므로(.gitignore) 파일이 없으면 건너뛴다."""
import dataclasses
import json
import sys
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "preprocessor"))
from oneq_prep import standards as S  # noqa: E402
from oneq_prep.extract import analyze  # noqa: E402
from oneq_prep.pack import prepare, write_pack  # noqa: E402
from oneq_prep.validate import validate_zip  # noqa: E402

CIVIL = ROOT / "source_pdf" / "civil_경향문제" / "토목기사_2024_3회_경향문제(한솔).pdf"
SURVEY = ROOT / "source_pdf" / "survey_기출_2011_2022" / "측량및지형공간정보기사20190303(교사용).pdf"


@pytest.mark.skipif(not CIVIL.exists(), reason="토목 경향문제 PDF 없음")
def test_civil_highlight_layout():
    lay = analyze(CIVIL)
    assert lay.numbering == "per-subject"
    assert len(lay.questions) == 120 and len(lay.subjects) == 6
    assert sum(len(v) for v in lay.highlights.values()) == 120
    assert all(q.inline_answer for q in lay.questions)
    assert [q.local_no for q in lay.questions[:21]] == list(range(1, 21)) + [1]
    prof = S.load("CIVIL")
    assert all(prof.resolve(n)[0] == "std" for n in lay.subjects.values())


@pytest.mark.skipif(not SURVEY.exists(), reason="측량 기출 PDF 없음")
def test_excluded_subject_pack(tmp_path):
    """폐지 과목이 있는 종목을 흉내: 응용측량을 제외 과목으로 둔 프로필 → 21~40번이 빠진 80문항 팩."""
    d = json.loads((ROOT / "preprocessor" / "standards" / "SURVEY.json").read_text(encoding="utf-8"))
    d["subjects"] = [s for s in d["subjects"] if s["name"] != "응용측량"]
    d["excluded"] = ["응용측량"]
    (tmp_path / "SURVEY.json").write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    prof = S.load("SURVEY", tmp_path)
    p = prepare(SURVEY, prof, tmp_path / "out")
    assert not p.issues
    z, m = write_pack(p, tmp_path / "out", "test")
    assert m["questionCount"] == 80
    assert m["excluded"] == [{"subject": "응용측량", "nos": list(range(21, 41)), "reason": "abolished-subject"}]
    assert [s["name"] for s in m["subjects"]][1] == "사진측량 및 원격탐사"
    assert validate_zip(z, deep=True) == []


@pytest.mark.skipif(not SURVEY.exists(), reason="측량 기출 PDF 없음")
def test_review_file_answers_and_exclude(tmp_path):
    out = tmp_path / "out"
    base = {it.no: it.answer for it in prepare(SURVEY, S.load("SURVEY"), out).items}
    other = lambda a: a % 4 + 1  # noqa: E731
    (out / "review").mkdir(parents=True, exist_ok=True)
    (out / "review" / "SURVEY-2019-1.review.json").write_text(json.dumps(
        {"answers": {"5": other(base[5])}, "exclude": {"7": "판독 불가"}, "acceptAlso": {"9": [other(base[9])]},
         "reviewed": True}), encoding="utf-8")
    p = prepare(SURVEY, S.load("SURVEY"), out)
    assert not p.issues
    z, m = write_pack(p, out, "test")
    qs = {q["no"]: q for q in json.loads(zipfile.ZipFile(z).read("questions.json"))}
    assert 7 not in qs and m["excluded"][0]["reason"] == "unreadable"
    assert qs[5]["answer"] == other(base[5]) and qs[5]["answerCheck"] == "corrected"
    assert qs[9]["acceptAlso"] == [other(base[9])]
    assert m["reviewedAt"] is not None
    assert validate_zip(z) == []
