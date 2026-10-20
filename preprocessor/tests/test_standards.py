import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep import standards as S  # noqa: E402


def test_profiles_load():
    assert {"SURVEY", "CIVIL", "RAILCIVIL"} <= set(S.available())
    for code in S.available():
        p = S.load(code)
        assert p.code == code
        if not p.draft:
            assert p.subjects and all(s["count"] > 0 for s in p.subjects)


def test_resolve_spacing_alias_excluded(tmp_path):
    (tmp_path / "X.json").write_text(json.dumps({
        "code": "X", "name": "가상", "grade": "기사", "version": "2022", "passRule": {"subjectMin": 40, "avgMin": 60},
        "subjects": [{"name": "수리학 및 수문학", "count": 20}, {"name": "토질 및 기초", "count": 20}],
        "aliases": {"토질역학": "토질 및 기초"}, "excluded": ["건설재료"],
        "legacy": {"before": "2012-01-01", "action": "reassign"}}, ensure_ascii=False), encoding="utf-8")
    p = S.load("X", tmp_path)
    assert p.resolve("수리학및수문학") == ("std", 1, "수리학 및 수문학")
    assert p.resolve("토질역학") == ("std", 2, "토질 및 기초")
    assert p.resolve("건설 재료")[0] == "excluded"
    assert p.resolve("콘크리트공학")[0] == "unknown"
    assert p.is_legacy("2011-10-02") and not p.is_legacy("2012-03-04")


def test_survey_profile_legacy():
    p = S.load("SURVEY")
    assert [s["name"] for s in p.subjects][-1] == "측량학"
    assert p.is_legacy("2011-03-20")


def test_safety_profile_merges_old_subjects():
    """건설안전기사 2026 기준(ADR 016): 2025년까지의 6과목을 과목명으로 5과목에 맞춘다 — 두 과목이 한 과목으로 합쳐짐."""
    p = S.load("SAFETY")
    assert not p.draft and len(p.subjects) == 5 and sum(s["count"] for s in p.subjects) == 100
    assert p.resolve("산업안전관리론") == ("std", 1, "산업재해 예방 및 안전보건교육")
    assert p.resolve("산업심리 및 교육") == ("std", 1, "산업재해 예방 및 안전보건교육")
    assert p.resolve("인간공학 및 시스템안전공학")[1] == 2
    assert p.resolve("건설재료학") == ("std", 3, "건설재료")
    assert p.resolve("건설시공학") == ("std", 4, "건설시공")
    assert p.resolve("건설안전기술") == ("std", 5, "건설공사 안전관리")
