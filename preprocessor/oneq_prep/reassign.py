"""구기준 회차의 문항별 과목 재배정 제안(ADR 005 추가 절, ADR 012).

현행 기준 회차 문항(과목이 맞는 참조 집합)과의 글자 2-gram 코사인 유사도로 가까운 문항 k개를 찾아
과목을 투표한다. 외부 의존성 없이 numpy만 쓴다(6단계 TF-IDF·형태소 분석으로 바꿀 수 있음).
결과는 '제안'일 뿐이고, 검수 파일에서 사람이 확인해야 팩에 반영된다.
"""
from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass

import numpy as np

_CLEAN = re.compile(r"[\s①②③④⑤❶❷❸❹❺0-9.,()\[\]{}:;~\-+=*/×÷<>?!'\"“”‘’·]+")


def _grams(text: str) -> Counter:
    t = _CLEAN.sub(" ", text)
    out: Counter = Counter()
    for w in t.split():
        if len(w) == 1:
            out[w] += 1
        for i in range(len(w) - 1):
            out[w[i:i + 2]] += 1
    return out


@dataclass
class Suggestion:
    no: int
    current: str          # 시험지 머리말 과목(표준 이름)
    suggested: str
    confidence: float     # 투표 몫(0~1)
    neighbors: list[tuple[str, float]]   # (참조 문항 qid, 유사도)


class Reference:
    def __init__(self, items: list[tuple[str, str, str]]):
        """items: (qid, 표준 과목명, text)"""
        self.items = items
        grams = [_grams(t) for _, _, t in items]
        df: Counter = Counter()
        for g in grams:
            df.update(g.keys())
        n = len(items)
        self.vocab = {k: i for i, k in enumerate(df)}
        self.idf = np.array([math.log((1 + n) / (1 + df[k])) + 1 for k in self.vocab], dtype=np.float32)
        self.mat = np.vstack([self._vec(g) for g in grams]) if items else np.zeros((0, len(self.vocab)), np.float32)

    def _vec(self, g: Counter) -> np.ndarray:
        v = np.zeros(len(self.vocab), dtype=np.float32)
        for k, c in g.items():
            i = self.vocab.get(k)
            if i is not None:
                v[i] = 1 + math.log(c)
        v *= self.idf
        nrm = np.linalg.norm(v)
        return v / nrm if nrm else v

    def suggest(self, no: int, current: str, text: str, k: int = 7) -> Suggestion:
        sims = self.mat @ self._vec(_grams(text))
        top = np.argsort(-sims)[:k]
        votes: Counter = Counter()
        for i in top:
            votes[self.items[i][1]] += float(max(sims[i], 0.0))
        total = sum(votes.values()) or 1.0
        subj, w = votes.most_common(1)[0] if votes else (current, 0.0)
        return Suggestion(no, current, subj, w / total,
                          [(self.items[i][0], round(float(sims[i]), 3)) for i in top[:3]])
