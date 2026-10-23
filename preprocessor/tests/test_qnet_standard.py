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
