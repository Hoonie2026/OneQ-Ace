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
