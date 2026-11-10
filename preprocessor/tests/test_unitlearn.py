"""C4 단원 자동 확정(ADR 021 4.8): 기출 자기 학습(unitlearn) + 실시간 웹 용어(webterms)."""
import json
from pathlib import Path

import pytest

from oneq_prep import classify as C
from oneq_prep import standards as S
from oneq_prep import unitlearn as UL
from oneq_prep import webterms as W

ROOT = Path(__file__).resolve().parents[2]


def test_build_index_ignores_keyword_file_by_default():
    """종목 정보 저장 안 함(사용자 2026-11-10): 수작업 보충 낱말은 기본으로 쓰지 않는다."""
    idx = C.build_index(S.load("CIVIL"), "응용역학")
    assert not any("세장비" in t for t in idx.terms.values())
    idx2 = C.build_index(S.load("CIVIL"), "응용역학", use_keywords=True)
    assert any("세장비" in t for t in idx2.terms.values())


def test_build_index_takes_web_terms():
    prof = S.load("CIVIL")
    uid = prof.units("응용역학")[6]["id"]
    idx = C.build_index(prof, "응용역학", extra={uid: {"세장비": 1.2}})
    assert "세장비" in idx.terms[uid]
    assert C.judge_unit("양단 힌지 기둥의 세장비는?", idx).unit == uid


def _fake_wiki(pages: dict[str, list[tuple[str, str]]]):
    def fetch(q):
        hit = pages.get(q)
        if hit is None:
            return {"batchcomplete": True}
        return {"query": {"pages": [{"title": t, "extract": x} for t, x in hit]}}
    return fetch


def test_webterms_filters_by_corpus_and_specificity():
    units = [{"id": "1-1", "name": "안전관리", "items": ["안전보건관리 제이론"]},
             {"id": "4-3", "name": "집단관리와 리더십", "items": ["리더십의 유형"]},
             {"id": "5-2", "name": "교육방법", "items": ["교육훈련기법"]}]
    fetch = _fake_wiki({
        "안전관리": [("하인리히 법칙", "하인리히 법칙은 1:29:300 법칙으로 재해와 도미노 이론을 설명한다. 관리")],
        "집단관리와 리더십": [("리더십", "헤드십과 리더십, 민주적 리더십과 권위적 리더십. 관리")],
        "리더십의 유형": [("리더십 유형", "자유방임형 리더십. 관리")],
        "교육방법": [("현장 훈련", "OJT는 직장 내 교육훈련이다. 관리")],
    })
    corpus = ["하인리히의 1:29:300 법칙에서 29는?", "도미노 이론에서 직접원인은?", "헤드십에 해당하는 것은?",
              "자유방임형 리더십의 특징은?", "OJT의 장점은?", "옳은 것은?"] + [f"관리 문항 {i}" for i in range(30)]
    wt = W.gather(units, corpus, fetch=fetch)
    assert wt is not None and wt.failed == 0
    assert "하인리히" in wt.terms["1-1"] and "도미노" in wt.terms["1-1"]
    assert "헤드십" in wt.terms["4-3"] and "자유방임형" in wt.terms["4-3"]
    assert "ojt" in wt.terms["5-2"]
    assert not any("관리" in t for t in wt.terms.values())          # 문항 5% 넘게 나옴 → 버림
    assert not any("직장" in t for t in wt.terms.values())          # 기출에 안 나옴 → 버림


def test_webterms_offline_returns_none():
    def boom(q):
        raise OSError("offline")
    units = [{"id": "1-1", "name": "안전관리", "items": []}]
    assert W.gather(units, ["문항"], fetch=boom) is None


def test_webterms_disabled_by_env(monkeypatch):
    monkeypatch.setenv("ONEQ_NO_WEB", "1")
    assert W.gather([{"id": "1-1", "name": "가", "items": []}], ["x"]) is None


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


def test_c4_civil_self_learning_raises_coverage():
    """토목 응용역학 전 32회차, 보충 낱말·웹 없이(2026-11-10: 규칙 확정 68%·89% → 자기 학습 86%·84%)."""
    gt = json.loads((ROOT / "preprocessor/tests/fixtures/classify/CIVIL-응용역학-2020-2022.json").read_text(encoding="utf-8"))
    prof, texts, raws, pos = _corpus("CIVIL", "civil_기출_2012_2022", gt["subject"])
    dec = UL.learn(texts, prof, gt["subject"], raws)
    d = [dec[pos[(g["date"], g["no"])]] for g in gt["items"]]
    sure = [(x, g) for x, g in zip(d, gt["items"]) if x.sure]
    assert len(sure) / len(d) >= 0.80
    assert sum(x.unit == g["unit"] for x, g in sure) / len(sure) >= 0.80
    assert all(len(x.candidates) <= 3 for x in d if not x.sure)
