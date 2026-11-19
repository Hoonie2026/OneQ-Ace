"""큐넷 출제기준 PDF 읽기(ADR 021 1절, PREP-PLAN-v0.5 A1) — 표본: 토목기사 2026.1.1~2027.12.31(보기 창 [저장] PDF)."""
import datetime as dt
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep import qnet_standard as Q  # noqa: E402
from oneq_prep import standards as S  # noqa: E402

CIVIL_PDF = Path(__file__).parent / "fixtures" / "standards" / "CIVIL-qnet-2026-2027.pdf"


@pytest.fixture(scope="module")
def civil():
    return Q.parse(CIVIL_PDF)


def test_header(civil):
    assert civil.cert_name == "토목기사"
    assert (civil.period_from, civil.period_to) == ("2026-01-01", "2027-12-31")
    assert civil.method == "객관식" and civil.total_count == 120 and civil.minutes == 180
    assert civil.is_current(dt.date(2026, 10, 24)) and not civil.is_current(dt.date(2028, 1, 1))
    assert civil.warnings == []


def test_subjects_and_unit_counts(civil):
    """쪽이 바뀌면 첫 줄에 과목·주요·세부가 되풀이된다 — 한 번만 센다(세부·세세항목 번호가 1부터 끊김 없이 이어짐)."""
    got = [(s.name, s.count, len(s.majors), sum(len(m.details) for m in s.majors)) for s in civil.subjects]
    assert got == [
        ("응용역학", 20, 1, 10),
        ("측량학", 20, 4, 10),
        ("수리학및수문학", 20, 2, 10),
        ("철근콘크리트및강구조", 20, 1, 3),
        ("토질및기초", 20, 2, 13),
        ("상하수도공학", 20, 2, 6),
    ]
    assert civil.unit_count() == 52
    assert sum(len(d.items) for s in civil.subjects for m in s.majors for d in m.details) == 183
    assert civil.practical_subjects == ["토목설계 및 시공실무"]


def test_wrapped_cell_spacing(civil):
    """보기 창이 칸 폭에서 줄을 바꾸며 지운 띄어쓰기: 낱말 사이면 띄우고 낱말 중간이면 붙인다."""
    names = {d.name for s in civil.subjects for m in s.majors for d in m.details}
    majors = {m.name for s in civil.subjects for m in s.majors}
    assert "역학적인 개념 및 건설 구조물의 해석" in majors
    assert "흙의 물리적 성질과 분류" in names
    assert "정정트러스(Truss), 라멘(Rahmen), 아치(Arch), 케이블(Cable)" in names


def test_unnumbered_major_and_continued_detail(civil):
    survey = civil.subjects[1]
    assert [m.name for m in survey.majors] == ["측량학일반", "평면기준점측량", "수준점측량", "응용측량"]
    assert [m.no for m in survey.majors] == [1, 2, 3, 4]
    area = survey.majors[3].details[1]
    assert area.name == "면적 및 체적 측량" and area.items == ["면적계산", "체적계산"]   # 3·4쪽에 걸침


def test_profile_keeps_existing_names_and_units(civil, tmp_path):
    base = S.Profile("CIVIL", "토목기사", "기사", "2022", {"subjectMin": 40, "avgMin": 60},
                     [{"name": "응용역학", "count": 20}, {"name": "측량학", "count": 20},
                      {"name": "수리학 및 수문학", "count": 20}, {"name": "철근콘크리트 및 강구조", "count": 20},
                      {"name": "토질 및 기초", "count": 20}, {"name": "상하수도공학", "count": 20, "isLaw": False},
                      {"name": "옛과목", "count": 20}],
                     aliases={"토질역학": "토질 및 기초"})
    d = Q.to_profile(civil, "CIVIL", base, CIVIL_PDF.name)
    assert [s["name"] for s in d["subjects"]][:3] == ["응용역학", "측량학", "수리학 및 수문학"]
    assert d["version"] == "2026" and d["period"] == {"from": "2026-01-01", "to": "2027-12-31"}
    assert d["aliases"] == {"토질역학": "토질 및 기초"} and "옛과목" in d["note"]
    (tmp_path / "CIVIL.json").write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    p = S.load("CIVIL", tmp_path)
    assert p.resolve("수리학및수문학") == ("std", 3, "수리학 및 수문학")
    units = p.units("응용역학")
    assert len(units) == 10 and units[0] == {"id": "1-1", "major": "역학적인 개념 및 건설 구조물의 해석",
                                             "name": "힘과 모멘트", "items": ["힘", "모멘트"]}
    assert p.units("없는과목") == []


def test_bundled_civil_profile_has_units():
    p = S.load("CIVIL")
    assert p.period and sum(len(p.units(s["name"])) for s in p.subjects) == 52
    assert [s["name"] for s in p.subjects][2] == "수리학 및 수문학"   # 이미 만든 팩의 과목 표기 유지


def test_not_a_standard_pdf(tmp_path):
    bad = tmp_path / "x.pdf"
    bad.write_bytes(b"not a pdf")
    with pytest.raises(Q.StandardPdfError):
        Q.parse(bad)


# ── 다른 종목(2026-10-24 받은 표본): 표 모양이 토목기사와 다른 곳 ──

SAFETY_PDF = Path(__file__).parent / "fixtures" / "standards" / "SAFETY-qnet-2026-2030.pdf"
SURVEY_PDF = Path(__file__).parent / "fixtures" / "standards" / "SURVEY-qnet-2025-2027.pdf"


@pytest.fixture(scope="module")
def safety():
    return Q.parse(SAFETY_PDF)


@pytest.fixture(scope="module")
def survey():
    return Q.parse(SURVEY_PDF)


def _units(doc):
    return [(s.name, len(s.majors), sum(len(m.details) for m in s.majors)) for s in doc.subjects]


def test_safety(safety):
    assert (safety.cert_name, safety.period_from, safety.period_to) == ("건설안전기사", "2026-01-01", "2030-12-31")
    assert safety.total_count == 100 and safety.minutes == 150 and safety.warnings == []
    assert [x[1:] for x in _units(safety)] == [(6, 16), (6, 19), (2, 15), (7, 19), (6, 11)]
    assert safety.unit_count() == 80


def test_safety_major_split_across_pages(safety):
    """긴 주요항목 칸이 쪽 끝에서 잘려 다음 쪽 첫 줄에 "사항"만 남는다 → 같은 주요항목으로 합침."""
    mat = safety.subjects[2]
    assert [m.name for m in mat.majors] == ["건설재료 일반", "각종 건설재료의 특성, 용도, 규격에 관한 사항"]
    d = mat.majors[1].details
    assert [x.no for x in d] == list(range(1, 12)) and d[0].name == "목재" and len(d[0].items) >= 2


def test_wrap_spacing_other_certs(safety, survey):
    names = {d.name for doc in (safety, survey) for s in doc.subjects for m in s.majors for d in m.details}
    majors = {m.name for doc in (safety, survey) for s in doc.subjects for m in s.majors}
    subjects = {s.name for doc in (safety, survey) for s in doc.subjects}
    assert "산업재해 예방 및 안전보건교육" in subjects                  # "안|전보건교육" 붙임
    assert {"인간의 특성과 안전과의 관계", "근골격계 유해요인 관리", "안전관리 고려사항 확인",
            "안전보건교육계획 수립 및 실시", "시스템 위험성 추정 및 결정", "건설공사 위험성 추정·결정",
            "단곡선 설치와 계산 및 이용방법"} <= names
    assert {"측량학에 대한 전문적인 지식이 요구되는 사항", "위성 측위시스템(GNSS)", "지리정보 시스템(GIS)"} <= majors


def test_survey(survey):
    assert (survey.cert_name, survey.period_from, survey.period_to) == ("측량및지형공간정보기사", "2025-01-01", "2027-12-31")
    assert survey.warnings == []
    assert [x[1:] for x in _units(survey)] == [(2, 12), (8, 21), (2, 10), (2, 7), (2, 13)]
    net = survey.subjects[0].majors[0].details[3]
    assert net.name == "수평 및 수직 측지망" and net.items == ["평면기준측량", "수준점측량"]   # 번호 없는 세세항목


def test_bundled_profiles_keep_old_subject_names():
    """이미 만든 팩과 과목명이 맞아야 함 — "측지학 및 위성측위시스템(GNSS)"도 옛 표기 그대로, 옛 기준 합치기 별칭·재배정 유지."""
    sv, sf = S.load("SURVEY"), S.load("SAFETY")
    assert sv.subjects[0]["name"] == "측지학 및 위성측위시스템" and sv.legacy and sv.period["from"] == "2025-01-01"
    assert sf.resolve("산업안전관리론") == ("std", 1, "산업재해 예방 및 안전보건교육")
    assert sf.subjects[4]["name"] == "건설공사 안전관리" and "ADR 016" in sf.note
    assert sum(len(sv.units(s["name"])) for s in sv.subjects) == 63
