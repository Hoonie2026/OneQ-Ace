"""전처리기 v0.4(ADR 019): 법령·기준 문항 표시, 종목 검색, 과목 개편 요약, 사용자 프로필."""
import sys
from dataclasses import dataclass
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep import standards as S  # noqa: E402
from oneq_prep.certs import ALIASES, catalog, search  # noqa: E402
from oneq_prep.lawtag import law_refs, tag  # noqa: E402
from oneq_prep.summary import law_summary, subject_change  # noqa: E402


@pytest.mark.parametrize("text,refs", [
    ("산업안전보건법령상 안전관리자를 2인 이상 선임하여야 하는", ["산업안전보건법"]),
    ("다음 중 시설물의 안전 및 유지관리에 관한 특별법령상 정밀안전진단", ["시설물의 안전 및 유지관리에 관한 특별법"]),
    ("산업안전보건기준에 관한 규칙에 따라 비계의", ["산업안전보건기준에 관한 규칙"]),
    ("건설기술 진흥법에 따른 안전관리계획", ["건설기술 진흥법"]),
    ("벽돌쌓기는 도면 또는 공사시방서에 정한 바가 없을 때", ["공사시방서"]),
    ("보호구 안전인증 고시에 따른 안전모의", ["보호구 안전인증 고시"]),
    ("교육방법에 따라 작업방법을 정한다", []),           # 방법·공법은 법령이 아님
    ("냉장창고시설의 단열재", []),                       # "…고시"가 아님
    ("삼각측량법에 의한 기준점", []),
])
def test_law_refs(text, refs):
    assert law_refs(text) == refs


def test_tag_terms_and_numeric_subjects():
    assert tag("안전보건관리비의 사용 내역", "SAFETY", "산업재해 예방 및 안전보건교육") == (True, [])
    # 지정 과목에서 수치 기준을 묻는 문항만
    q = "이동식 사다리의 폭은 30cm 이상으로 할 것"
    assert tag(q, "SAFETY", "건설공사 안전관리")[0] is True
    assert tag(q, "SAFETY", "건설재료")[0] is False
    assert tag("콘크리트의 물-시멘트비", "SAFETY", "건설재료") == (False, [])
    assert tag("공공측량의 실시에 대한 설명", "SURVEY", "측량학")[0] is True


def test_cert_search_aliases():
    certs = catalog()
    assert search("건안기", certs)[0].name == "건설안전기사"
    assert search("측량", certs)[0].profile == "SURVEY"
    assert search("건설 안전", certs)[0].name == "건설안전기사"
    assert search("없는종목xyz", certs) == []
    assert all(t in {c.name for c in certs} for t in ALIASES.values())


def test_catalog_reads_public_data_csv(tmp_path):
    """공공데이터포털 CSV(CP949)를 읽고 종목코드를 붙인다."""
    (tmp_path / "qualifications.csv").write_bytes("자격구분명,계열명,종목명\n국가기술자격,건설,궤도기사\n".encode("cp949"))
    (tmp_path / "qual-codes.csv").write_bytes("순번,종목코드,종목명\n1,9999,궤도기사\n".encode("cp949"))
    certs = {c.name: c for c in catalog(tmp_path)}
    assert certs["궤도기사"].series == "건설" and certs["궤도기사"].jm_code == "9999"
    assert "jmCd=9999" in certs["궤도기사"].qnet_url()


def test_subject_change_summary():
    old = ["산업안전관리론", "산업심리 및 교육", "인간공학 및 시스템안전공학", "건설시공학", "건설재료학", "건설안전기술"]
    cs = subject_change(S.load("SAFETY"), [old], ["2012-03-04"])
    assert cs.merged == {"산업재해 예방 및 안전보건교육": ["산업안전관리론", "산업심리 및 교육"]}
    assert ("건설재료학", "건설재료") in cs.renamed and not cs.unknown
    assert cs.lines()[0] == "PDF 과목 6개 → 현행 출제기준 5과목 100문항"
    same = subject_change(S.load("SURVEY"), [[s["name"] for s in S.load("SURVEY").subjects]])
    assert not same.changed and "같습니다" in same.lines()[-1]
    assert subject_change(S.load("SURVEY"), [["측지학", "엉뚱한 과목"]]).unknown == ["측지학", "엉뚱한 과목"]


def test_law_summary():
    @dataclass
    class R:
        status: str
        questions: int
        law: int
        date: str
    lines = law_summary([R("packed", 120, 20, "2012-03-04"), R("packed", 120, 10, "2025-03-01")], now_year=2026)
    assert "30문항(12%)" in lines[0] and "5년 넘은 회차 1개" in lines[1]
    assert law_summary([R("packed", 120, 0, "2012-03-04")]) == []


def test_user_profile_overrides_and_filters(tmp_path, monkeypatch):
    monkeypatch.setenv("ONEQ_PREP_HOME", str(tmp_path))
    assert "law-terms" not in S.available()             # 설정 파일은 프로필이 아님
    with pytest.raises(ValueError):
        S.save_user_profile({"code": "bad", "subjects": [{"name": "a", "count": 20}]})
    S.save_user_profile({"code": "ELEC", "name": "전기기사", "grade": "기사", "version": "2026",
                         "passRule": {"subjectMin": 40, "avgMin": 60}, "subjects": [{"name": "전력공학", "count": 20}]})
    assert "ELEC" in S.available() and S.is_user_profile("ELEC") and S.load("ELEC").name == "전기기사"
