"""단원 자동 확정 높이기 — 기출 자기 학습(ADR 021 4.8 방법 ①, PREP-PLAN-v0.5 C4).

이번에 올린 기출의 같은 과목 문항을 한꺼번에 놓고:
1. 씨앗: 출제기준 세부·세세항목 낱말(+ 있으면 웹 용어, webterms.py)로 확신 있게 판정된 문항
2. 학습: 씨앗 문항의 글자 조각(2·3글자)과 원래 시험지 과목명으로 나이브 베이즈를 세우고, 나머지 문항을
   판정해 다시 세우기를 되풀이(EM — Nigam et al. 2000, 씨앗 낱말 약지도 분류)
3. 확정: 씨앗은 그대로 확정, 나머지는 1·2위 차이가 TAU 이상일 때만 확정. 못 하면 "미정" + 후보 3개(4.5)

종목 정보는 저장하지 않는다(사용자 결정 2026-11-10) — 학습 결과는 이번 처리 안에서만 쓰고 버린다.
수작업 보충 낱말(standards/unit-keywords.json)은 쓰지 않는다.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np

from . import classify as C
from . import standards as S

NGRAMS = (2, 3)
ALPHA = 1.0         # 라플라스 평활
ITERS = 8
UNLAB_W = 0.3       # 씨앗이 아닌 문항의 학습 무게
TAU = 0.5           # 씨앗이 아닌 문항 확정: 조각당 1·2위 로그 우도 차이 ≥ TAU(C4 실측 2026-11-10, NB 확률은 과신이라 안 씀)
MAX_DF = 0.5        # 문항 절반 넘게 나오는 조각은 버림
SEED_MIN = 1.5      # 씨앗: 규칙 점수 ≥ SEED_MIN 이고
SEED_RATIO = 2.0    # 2위 단원의 SEED_RATIO 배 이상


@dataclass
class Decision:
    unit: str | None
    sure: bool
    candidates: list[str] = field(default_factory=list)
    how: str = ""       # "seed"(출제기준·웹 낱말) / "learn"(자기 학습) / ""


def features(text: str, raw_subject: str | None = None) -> Counter:
    sp = C.split_text(text)
    s = re.sub(r"[^가-힣A-Za-z]+", "", (sp.stem + " " + " ".join(sp.choices)).lower())
    out: Counter = Counter()
    for n in NGRAMS:
        for i in range(len(s) - n + 1):
            out[s[i:i + n]] += 1
    if raw_subject:
        out["@과목:" + S.norm(raw_subject)] += 3
    return out


def _nb_em(docs: list[Counter], n_units: int, seeds: dict[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """→ (P 문항×단원 사후확률, M 조각당 1·2위 로그 우도 차이 — 확신도. NB 확률은 과신이라 확정에는 M을 쓴다)"""
    N = len(docs)
    df = Counter(k for d in docs for k in d)
    vocab = {k: j for j, k in enumerate(sorted(k for k, c in df.items() if c >= 2 and c <= MAX_DF * N
                                               or k.startswith("@과목:")))}
    X = np.zeros((N, len(vocab)), dtype=np.float32)
    for r, d in enumerate(docs):
        for k, c in d.items():
            j = vocab.get(k)
            if j is not None:
                X[r, j] = min(c, 3)
    P = np.zeros((N, n_units), dtype=np.float32)
    seed_ix = np.array(sorted(seeds), dtype=int)
    for i, u in seeds.items():
        P[i, u] = 1
    W = np.zeros(N, dtype=np.float32)
    W[seed_ix] = 1.0
    for _ in range(ITERS):
        cnt = (P * W[:, None]).T @ X + ALPHA
        logp = np.log(cnt / cnt.sum(1, keepdims=True))
        L = X @ logp.T
        L -= L.max(1, keepdims=True)
        Q = np.exp(L)
        Q /= Q.sum(1, keepdims=True)
        Q[seed_ix] = P[seed_ix]          # 씨앗은 고정
        P = Q
        W = np.full(N, UNLAB_W, dtype=np.float32)
        W[seed_ix] = 1.0
    cnt = (P * W[:, None]).T @ X + ALPHA
    logp = np.log(cnt / cnt.sum(1, keepdims=True))
    L = X @ logp.T
    Ls = np.sort(L, 1)
    M = (Ls[:, -1] - Ls[:, -2]) / np.maximum(X.sum(1), 1.0)
    return P, M


def learn(texts: list[str], profile: S.Profile, subject: str, raw_subjects: list[str] | None = None,
          extra: dict[str, dict[str, float]] | None = None) -> list[Decision]:
    """같은 과목 문항 전부(여러 회차) → 문항마다 단원 판정. extra = 웹 용어(단원 id → {낱말: 무게})."""
    idx = C.build_index(profile, subject, corpus=texts, extra=extra, use_keywords=False)
    if not idx.units:
        return [Decision(None, True) for _ in texts]
    units = [u["id"] for u in idx.units]
    uix = {u: i for i, u in enumerate(units)}
    rule = [C.judge_unit(t, idx) for t in texts]
    seeds = {i: uix[r.unit] for i, r in enumerate(rule)
             if r.unit in uix and r.score >= SEED_MIN and r.score >= SEED_RATIO * max(r.runner_score, 1e-9)}
    if len(texts) < 20 or len(seeds) < max(3, len(units) // 3):
        # 문항이 적거나 씨앗이 모자라면 학습하지 않음(규칙 판정 그대로)
        return [Decision(r.unit if r.sure else None, r.sure, [] if r.sure else r.candidates, "seed" if r.sure else "")
                for r in rule]
    raws = raw_subjects or [None] * len(texts)
    P, M = _nb_em([features(t, rw) for t, rw in zip(texts, raws)], len(units), seeds)
    out = []
    for i, r in enumerate(rule):
        if i in seeds:
            out.append(Decision(r.unit, True, [], "seed"))
            continue
        order = np.argsort(-P[i])
        cands = [units[j] for j in order[:C.N_CANDIDATES]]
        if M[i] >= TAU:
            out.append(Decision(units[order[0]], True, [], "learn"))
        else:
            out.append(Decision(None, False, cands or r.candidates, ""))
    return out


# ───────────────────────── 여러 회차에 적용(batch) ─────────────────────────

@dataclass
class ApplyStats:
    subjects: int = 0
    items: int = 0
    sure_before: int = 0
    sure_after: int = 0
    web_terms: int = 0
    web_ok: bool | None = None       # None = 웹 안 씀, False = 연결 실패
    notes: list[str] = field(default_factory=list)

    def summary(self) -> str:
        if not self.items:
            return ""
        web = {None: "", False: " · 웹 용어 연결 실패(기출만으로 학습)", True: f" · 웹 용어 {self.web_terms}개"}[self.web_ok]
        return (f"단원 확정 {self.sure_after / self.items:.0%}({self.sure_after}/{self.items}문항, "
                f"자기 학습 전 {self.sure_before / self.items:.0%}){web}")


def apply(prepared: list, profile: S.Profile, web: bool = True, log: Callable[[str], None] = lambda *_: None,
          fetch=None) -> ApplyStats:
    """이번에 준비한 회차(pack.Prepared) 전부를 과목별로 모아 단원을 다시 판정해 문항(it.unit 등)을 고친다.
    사람이 검수 파일 units로 고른 문항은 건드리지 않는다. 학습 결과·웹 용어는 저장하지 않는다."""
    from .pack import classify_note
    st = ApplyStats(web_ok=None if not web else True)
    groups: dict[str, list] = {}
    for p in prepared:
        picked = {int(k) for k in p.review.get("units", {})}
        for it in p.items:
            if it.excluded or not it.subject or it.no in picked:
                continue
            groups.setdefault(it.subject, []).append(it)
    for subject, items in groups.items():
        if not profile.units(subject):
            continue
        st.subjects += 1
        texts = [it.text for it in items]
        extra = None
        if web:
            from . import webterms
            wt = webterms.gather(profile.units(subject), texts, fetch=fetch, log=log)
            if wt is None:
                st.web_ok = False
            else:
                extra = wt.terms
                st.web_terms += wt.total
                st.notes += wt.notes
        dec = learn(texts, profile, subject, [it.pdf_subject for it in items], extra)
        for it, d in zip(items, dec):
            st.items += 1
            st.sure_before += "unit" not in it.unsure
            st.sure_after += d.sure
            it.unit = d.unit if d.sure else None
            it.unit_candidates = [] if d.sure else d.candidates
            it.unsure = [k for k in it.unsure if k != "unit"] + ([] if d.sure else ["unit"])
    for p in prepared:
        p.notes = [n for n in p.notes if not n.startswith("유형:")] + ([classify_note(p.items, profile)] if p.items else [])
    if st.web_ok is False:
        log("웹 용어를 받지 못해 기출 자기 학습만으로 단원을 정했습니다(인터넷 연결 확인)")
    return st


# ───────────────────────── 실측(PC에서 사용자가 실행) ─────────────────────────

def measure(root: Path, web: bool = True, fetch=None) -> list[dict]:
    """정답표(tests/fixtures/classify/*.json)와 source_pdf/의 기출로 ① 규칙 · ② 자기 학습 · ③ 자기 학습+웹 비교."""
    from .extract import analyze
    fix = root / "preprocessor" / "tests" / "fixtures" / "classify"
    folders = {"SAFETY": "safety_*", "SURVEY": "survey_*", "CIVIL": "civil_기출*"}
    rows = []
    for gt_file in sorted(fix.glob("*.json")):
        gt = json.loads(gt_file.read_text(encoding="utf-8"))
        prof = S.load(gt["cert"])
        d = next(iter(sorted((root / "source_pdf").glob(folders.get(gt["cert"], "-")))), None)
        if d is None:
            print(f"{gt_file.name}: source_pdf에 {gt['cert']} 기출 폴더 없음 — 건너뜀")
            continue
        texts, raws, keys = [], [], []
        pdfs = sorted(d.glob("*.pdf"))
        for k, f in enumerate(pdfs, 1):
            print(f"\r{gt['cert']} 기출 읽는 중 {k}/{len(pdfs)}", end="", flush=True)
            m = re.search(r"(\d{8})", f.name)
            lay = analyze(f)
            for q in lay.questions:
                raw = lay.subjects.get(q.subject_no, "")
                if raw and prof.resolve(raw)[2] == gt["subject"]:
                    texts.append(q.text())
                    raws.append(raw)
                    keys.append((m.group(1) if m else "", q.no))
        print()
        pos = {k: i for i, k in enumerate(keys)}
        gi = [pos.get((g["date"], g["no"])) for g in gt["items"]]
        if any(i is None for i in gi):
            print(f"{gt_file.name}: 정답표 문항 일부를 기출에서 못 찾음 — 건너뜀")
            continue

        def score(dec: list[Decision], how: str, extra_note: str = "") -> dict:
            d = [dec[i] for i in gi]
            sure = [(x, g) for x, g in zip(d, gt["items"]) if x.sure]
            ok = sum(x.unit == g["unit"] for x, g in sure)
            uns = [(x, g) for x, g in zip(d, gt["items"]) if not x.sure]
            cand = sum(g["unit"] in x.candidates for x, g in uns)
            return {"set": gt_file.stem, "how": how, "n": len(d), "sure": len(sure) / len(d),
                    "precision": ok / max(len(sure), 1), "cand3": cand / max(len(uns), 1),
                    "sure_all": sum(x.sure for x in dec) / len(dec), "corpus": len(texts), "note": extra_note}

        idx = C.build_index(prof, gt["subject"], corpus=texts)
        rule = [C.judge_unit(t, idx) for t in texts]
        rows.append(score([Decision(r.unit if r.sure else None, r.sure, [] if r.sure else r.candidates) for r in rule],
                          "출제기준 낱말만"))
        rows.append(score(learn(texts, prof, gt["subject"], raws), "① 기출 자기 학습"))
        if web:
            from . import webterms
            wt = webterms.gather(prof.units(gt["subject"]), texts, fetch=fetch, log=print)
            if wt is None:
                rows.append({"set": gt_file.stem, "how": "①+② 웹 용어", "note": "위키백과 연결 실패"})
            else:
                rows.append(score(learn(texts, prof, gt["subject"], raws, wt.terms), "①+② 웹 용어",
                                  f"검색 {wt.queries}건(실패 {wt.failed}) · 문서 {wt.pages} · 낱말 {wt.total}"))
    return rows


def _print(rows: list[dict]) -> None:
    print()
    print(f"{'정답표':34} {'방식':14} {'확정':>6} {'확정 정답률':>10} {'미정 후보3 적중':>14} {'전체 확정':>9}  비고")
    for r in rows:
        if "sure" not in r:
            print(f"{r['set']:34} {r['how']:14} {'-':>6} {'-':>10} {'-':>14} {'-':>9}  {r.get('note', '')}")
            continue
        print(f"{r['set']:34} {r['how']:14} {r['sure']:6.0%} {r['precision']:10.0%} {r['cand3']:14.0%} {r['sure_all']:9.0%}  {r['note']}")
    print("\n목표(ADR 021 4.8): 확정 80% 이상 · 확정 정답률 90% 이상")


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(prog="python -m oneq_prep.unitlearn", description="단원 자동 확정 실측(C4)")
    ap.add_argument("--measure", action="store_true", help="정답표와 source_pdf 기출로 실측")
    ap.add_argument("--no-web", action="store_true", help="웹 용어 검색 안 함")
    ap.add_argument("--root", default=str(Path(__file__).resolve().parents[2]), help="저장소 폴더")
    ap.add_argument("--json", help="결과를 JSON 파일로도 저장")
    a = ap.parse_args(argv)
    if not a.measure:
        ap.print_help()
        return 0
    rows = measure(Path(a.root), web=not a.no_web)
    _print(rows)
    if a.json:
        Path(a.json).write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
