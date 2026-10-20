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
SAFETY_DIR = ROOT / "source_pdf" / "safety_기출_2003_2022"
SAFETY_GLUED = SAFETY_DIR / "건설안전기사20070513(교사용).pdf"      # 20번 "공구② 낙하" — 보기 번호가 앞 글에 붙음
SAFETY_REF = SAFETY_DIR / "건설안전기사20040905(교사용).pdf"        # 102번 "① ① 1 ② 1❷ ① 1 ② 6" — 보기 안 원문자 참조
SAFETY_TAIL = SAFETY_DIR / "건설안전기사20120915(교사용).pdf"       # 120번 바로 아래(15pt) comcbt 안내문


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


@pytest.mark.skipif(not SAFETY_GLUED.exists(), reason="건설안전 기출 PDF 없음")
def test_safety_glued_choice_label():
    """간격 규칙으로는 ②④를 놓침 → 2×2 배치(②④ 같은 x)로 다시 고른다."""
    lay = analyze(SAFETY_GLUED)
    q = lay.questions[19]
    assert [l.digit for l in q.labels] == [1, 2, 3, 4] and q.inline_answer == 3 == lay.answer_table[20]
    assert "info:보기 번호를 배치로 고름" in q.warnings


@pytest.mark.skipif(not SAFETY_REF.exists(), reason="건설안전 기출 PDF 없음")
def test_safety_circled_refs_inside_choices_stay_stem():
    lay = analyze(SAFETY_REF)
    q = lay.questions[101]
    assert [l.digit for l in q.labels] == [1, 2, 3, 4] and q.inline_answer == 2 == lay.answer_table[102]
    assert [round(l.bbox[0]) for l in q.labels][1] == round(q.labels[3].bbox[0])   # ❷ = ④ 열


@pytest.mark.skipif(not SAFETY_TAIL.exists(), reason="건설안전 기출 PDF 없음")
def test_safety_merged_pack(tmp_path):
    """마지막 문항 뒤 안내문을 잘라 내고, 옛 6과목 → 2026 기준 5과목(1과목 40문항, examCount 20)으로 팩을 만든다."""
    lay = analyze(SAFETY_TAIL)
    assert len(lay.questions) == 120 and [l.digit for l in lay.questions[-1].labels] == [1, 2, 3, 4]
    assert len(lay.answer_table) == 120
    p = prepare(SAFETY_TAIL, S.load("SAFETY"), tmp_path)
    assert not p.issues
    z, m = write_pack(p, tmp_path, "test")
    subj = {s["name"]: s for s in m["subjects"]}
    assert list(subj) == ["산업재해 예방 및 안전보건교육", "인간공학 및 위험성 평가·관리", "건설재료", "건설시공", "건설공사 안전관리"]
    assert subj["산업재해 예방 및 안전보건교육"]["count"] == 40 and subj["산업재해 예방 및 안전보건교육"]["examCount"] == 20
    assert all("examCount" not in s for n, s in subj.items() if n != "산업재해 예방 및 안전보건교육")
    assert "산업안전관리론 → 산업재해 예방 및 안전보건교육" in m["standard"]["renamed"]
    assert m["questionCount"] == 120 and validate_zip(z, deep=True) == []


@pytest.mark.parametrize("date,no", [("20161001", 66), ("20160306", 104), ("20100509", 62)])
def test_safety_short_or_shifted_choice_labels(date, no):
    """보기 ④가 앞 글자 ")"에 붙어 3개만 찾던 문항, ②·④ 열이 2pt 넘게 어긋난 문항도 4개를 찾고 정답표와 맞는다."""
    pdf = SAFETY_DIR / f"건설안전기사{date}(교사용).pdf"
    if not pdf.exists():
        pytest.skip("건설안전 기출 PDF 없음")
    lay = analyze(pdf)
    q = lay.questions[no - 1]
    assert [l.digit for l in q.labels] == [1, 2, 3, 4] and q.inline_answer == lay.answer_table[no]
