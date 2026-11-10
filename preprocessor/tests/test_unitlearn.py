"""C4 단원 자동 확정(ADR 021 4.8): 기출 자기 학습(unitlearn), 정답률 우선."""
import json
from pathlib import Path

import pytest

from oneq_prep import classify as C
from oneq_prep import standards as S
from oneq_prep import unitlearn as UL

ROOT = Path(__file__).resolve().parents[2]


def test_build_index_ignores_keyword_file_by_default():
    """종목 정보 저장 안 함(사용자 2026-11-10): 수작업 보충 낱말은 기본으로 쓰지 않는다."""
    idx = C.build_index(S.load("CIVIL"), "응용역학")
    assert not any("세장비" in t for t in idx.terms.values())
    idx2 = C.build_index(S.load("CIVIL"), "응용역학", use_keywords=True)
    assert any("세장비" in t for t in idx2.terms.values())


def test_learn_small_corpus_falls_back_to_rule():
    prof = S.load("CIVIL")
    dec = UL.learn(["양단 힌지 기둥의 세장비는?", "다음 중 옳은 것은?"], prof, "응용역학")
    assert len(dec) == 2 and dec[1].unit is None and not dec[1].sure


def _corpus(cert: str, folder: str, subject: str):
    d = ROOT / "source_pdf" / folder
    pdfs = sorted(d.glob("*.pdf")) if d.exists() else []
    if not pdfs:
        pytest.skip(f"{folder} 기출 PDF 없음")
    import re
    from oneq_prep.extract import analyze
    prof = S.load(cert)
    texts, raws, keys = [], [], []
    for f in pdfs:
        lay = analyze(f)
        dt = re.search(r"(\d{8})", f.name).group(1)
        for q in lay.questions:
            raw = lay.subjects.get(q.subject_no, "")
            if raw and prof.resolve(raw)[2] == subject:
                texts.append(q.text()); raws.append(raw); keys.append((dt, q.no))
    return prof, texts, raws, {k: i for i, k in enumerate(keys)}


def test_c4_civil_precision_first():
    """토목 응용역학 전 32회차, 보충 낱말·웹 없이, 정답률 우선(사용자 2026-11-10): 확정 63%·정답 90% 실측."""
    gt = json.loads((ROOT / "preprocessor/tests/fixtures/classify/CIVIL-응용역학-2020-2022.json").read_text(encoding="utf-8"))
    prof, texts, raws, pos = _corpus("CIVIL", "civil_기출_2012_2022", gt["subject"])
    dec = UL.learn(texts, prof, gt["subject"], raws)
    d = [dec[pos[(g["date"], g["no"])]] for g in gt["items"]]
    sure = [(x, g) for x, g in zip(d, gt["items"]) if x.sure]
    assert len(sure) / len(d) >= 0.55
    assert sum(x.unit == g["unit"] for x, g in sure) / len(sure) >= 0.88
    assert all(len(x.candidates) <= 3 for x in d if not x.sure)


# ───────────────────────── C2 법령 판정(lawtag) ─────────────────────────

def test_lawtag_rule_names_and_spaced_terms():
    from oneq_prep import lawtag
    subj = "산업재해 예방 및 안전보건교육"
    assert lawtag.tag("산업재해통계업무처리규정상 재해 통계 관련 용어로 옳은 것은?", "SAFETY", subj)[0]
    assert lawtag.tag("유해 · 위험방지계획서 제출 시 첨부서류가 아닌 것은?", "SAFETY", "건설공사 안전관리")[0]
    assert lawtag.tag("건설업 산업안전 보건관리비의 사용내역에 대하여 옳은 것은?", "SAFETY", "건설공사 안전관리")[0]
    # 이론 문항(조직 규모·교육기법)은 아님 — C2 실측 오판정
    assert not lawtag.tag("1000명 이상의 대규모 사업장에서 가장 적합한 안전관리조직의 형태는?", "SAFETY", subj)[0]
    assert not lawtag.tag("안전보건교육에 있어 역할 연기법의 장점이 아닌 것은?", "SAFETY", subj)[0]
    # 짧은 낱말은 띄어쓰기를 넘어 걸리지 않음("…하고 시공" ≠ 고시)
    assert not lawtag.tag("콘크리트를 부어 넣은 후 다지고 시공하는 방법은?", "SAFETY", "건설시공")[0]


def test_c2_safety_law_measure():
    """건설안전 1과목 160문항(2026-11-10): 정밀도 92%·재현율 96% → 고친 뒤 98%·100%."""
    gt = json.loads((ROOT / "preprocessor/tests/fixtures/classify/SAFETY-안전보건교육-2021-2022.json").read_text(encoding="utf-8"))
    d = ROOT / "source_pdf" / "safety_기출_2003_2022"
    pdfs = {g["date"]: d / f"건설안전기사{g['date']}(교사용).pdf" for g in gt["items"]}
    if not all(p.exists() for p in pdfs.values()):
        pytest.skip("건설안전 기출 PDF 없음")
    from oneq_prep import lawtag
    from oneq_prep.extract import analyze
    prof = S.load("SAFETY")
    txt = {}
    for dt, f in pdfs.items():
        lay = analyze(f)
        for q in lay.questions:
            if prof.resolve(lay.subjects.get(q.subject_no, ""))[2] == gt["subject"]:
                txt[(dt, q.no)] = q.text()
    tp = fp = fn = 0
    for g in gt["items"]:
        law = lawtag.tag(txt[(g["date"], g["no"])], "SAFETY", gt["subject"])[0]
        tp += law and g["law"]
        fp += law and not g["law"]
        fn += (not law) and g["law"]
    assert tp / (tp + fp) >= 0.95 and tp / (tp + fn) >= 0.95
