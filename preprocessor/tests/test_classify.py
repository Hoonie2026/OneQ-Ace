"""단원·유형 판정(ADR 021 4절, PREP-PLAN-v0.5 C1·C2).

- 앞쪽: 문항 글을 직접 적은 작은 시험(어디서나 돎)
- 뒤쪽: 실측(C2) — 사람 정답표 fixtures/classify/*.json + source_pdf/ 기출(저장소에 없음 → 없으면 건너뜀).
  기준선은 2026-10-24 실측값보다 조금 낮게 잡아 판정 규칙이 나빠지는 것만 막는다.
"""
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "preprocessor"))
from oneq_prep import classify as C  # noqa: E402
from oneq_prep import standards as S  # noqa: E402

FIX = Path(__file__).parent / "fixtures" / "classify"


def test_type_numeric_choices_with_data_is_calc():
    t = C.judge_type("4. 탄성계수(E)가 2.1×105MPa, 푸아송 비(ν)가 0.25일 때 전단 탄성계수(G)의 값은?\n"
                     "① 8.4×104MPa② 9.8×104MPa\n③ 1.7×106MPa④ 2.1×106MPa")
    assert (t.qtype, t.sure) == ("calc", True)


def test_type_formula_image_choices_is_calc():
    t = C.judge_type("9. 등분포 하중을 받는 단순보에서 중앙점의 처짐을 구하는 공식은?\n① ②\n③ ④")
    assert t.qtype == "calc"


def test_type_word_choices_is_concept():
    t = C.judge_type("2. 전단중심에 대한 설명으로 틀린 것은?\n① 1축이 대칭인 단면의 전단중심은 도심과 일치한다.\n"
                     "② 대칭축 선상에 있다.\n③ 보는 비틀린다.\n④ 합력점의 위치를 말한다.")
    assert (t.qtype, t.sure) == ("concept", True)


def test_type_recall_number_is_not_calc():
    """주어진 값 없이 숫자를 고르는 문항(외워 고름)은 계산 탭에 넣지 않는다."""
    t = C.judge_type("16. 현재 운용되고 있는 GPS 위성의 궤도 경사각은?\n① 50°② 55°\n③ 63°④ 72°")
    assert t.qtype == "concept" and not t.sure


def test_type_acronym_choices_not_numeric():
    t = C.judge_type("2. GNSS 측량 방법 중 보기가 설명하고 있는 방법은?\n① VRS② SLR\n③ DGPS④ Pseudo Kinematic")
    assert t.qtype == "concept"


def test_type_law_and_sequence():
    assert C.judge_type("다음 중 산업안전보건법령상 안전관리자의 업무가 아닌 것은?\n① 가② 나\n③ 다④ 라", is_law=True).qtype == "law"
    t = C.judge_type("콘크리트 타설 작업 순서로 옳은 것은?\n① ㄱ→ㄴ→ㄷ② ㄴ→ㄱ→ㄷ\n③ ㄷ→ㄴ→ㄱ④ ㄱ→ㄷ→ㄴ")
    assert t.sequence


def test_unit_index_uses_standard_and_keywords():
    idx = C.build_index(S.load("CIVIL"), "응용역학")
    assert C.judge_unit("그림과 같은 부정정보에서 B점의 반력은?", idx).unit == "1-10"   # "정정보"보다 "부정정보"
    assert C.judge_unit("양단 힌지 기둥의 세장비는?", idx).unit == "1-7"                 # 보충 낱말
    assert C.judge_unit("단면 상승 모멘트의 값은?", idx).unit == "1-2"                    # 출제기준 세세항목
    r = C.judge_unit("다음 중 옳은 것은?", idx)
    assert r.unit is None and not r.sure


def test_profile_without_units_skips_unit():
    p = S.Profile("X", "가상", "기사", "2026", {"subjectMin": 40, "avgMin": 60}, [{"name": "가", "count": 20}])
    c = C.classify("보기 값은?\n① 1m② 2m\n③ 3m④ 4m", C.build_index(p, "가"))
    assert c.unit is None and c.unit_sure       # 단원이 없는 프로필은 묻지 않음


def _measure(gt_file: str, pdf_dir: str, pattern: str):
    gt = json.loads((FIX / gt_file).read_text(encoding="utf-8"))
    d = ROOT / "source_pdf" / pdf_dir
    dates = sorted({g["date"] for g in gt["items"]})
    pdfs = {dt: next(iter(d.glob(pattern.format(dt))), None) for dt in dates}
    if not d.exists() or not all(pdfs.values()):
        pytest.skip(f"{pdf_dir} 기출 PDF 없음")
    from oneq_prep.extract import analyze
    prof = S.load(gt["cert"])
    texts = {}
    for dt, f in pdfs.items():
        lay = analyze(f)
        for q in lay.questions:
            if prof.resolve(lay.subjects.get(q.subject_no, ""))[2] == gt["subject"]:
                texts[(dt, q.no)] = q.text()
    idx = C.build_index(prof, gt["subject"])
    n = len(gt["items"])
    t_ok = u_ok = sure = sure_ok = 0
    for g in gt["items"]:
        text = texts[(g["date"], g["no"])]
        t_ok += C.judge_type(text).qtype == g["type"]
        u = C.judge_unit(text, idx)
        u_ok += u.unit == g["unit"]
        if u.sure:
            sure += 1
            sure_ok += u.unit == g["unit"]
    return t_ok / n, u_ok / n, sure / n, sure_ok / max(sure, 1)


def test_c2_civil_mechanics():
    """토목 응용역학 160문항(2026-10-24: 유형 98.8% · 단원 92.5% · 확신 84% 중 97.8%) — 보충 낱말을 문항을 보며 적음(낙관적)."""
    typ, unit, cover, prec = _measure("CIVIL-응용역학-2020-2022.json", "civil_기출_2012_2022", "토목기사{}(교사용).pdf")
    assert typ >= 0.95 and unit >= 0.88 and cover >= 0.75 and prec >= 0.95


def test_c2_survey_geodesy_blind():
    """측량 1과목 160문항, 맹검(2026-10-24: 유형 95.0% · 단원 71.9% · 확신 61% 중 88.8%)."""
    typ, unit, cover, prec = _measure("SURVEY-측지학-2019-2022.json", "survey_기출_2011_2022", "측량및지형공간정보기사{}(교사용).pdf")
    assert typ >= 0.90 and unit >= 0.68 and cover >= 0.55 and prec >= 0.85
