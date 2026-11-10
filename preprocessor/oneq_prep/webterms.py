"""실시간 웹 용어 보강(ADR 021 4.8 방법 ②, PREP-PLAN-v0.5 C4).

전처리기가 작동할 때마다 출제기준 세부항목·세세항목 이름으로 한국어 위키백과를 검색해, 단원마다 관련 용어를 모은다.
- 출처: 한국어 위키백과 검색 API(ko.wikipedia.org/w/api.php) — API 키·계정 없음, 공개 문서(CC BY-SA)의 요약만 읽음
- 이번 기출에 실제로 나오는 낱말만 남기고(말뭉치 거름), 여러 단원에 두루 나오는 낱말은 버림 → 단원 판정(classify)의 씨앗 낱말에 더함
- **저장하지 않는다**(사용자 결정 2026-11-10): 캐시·파일 없음. 이번 처리가 끝나면 버린다
- 인터넷이 안 되거나 위키백과가 바뀌면 None → 기출 자기 학습(①)만으로 동작하고 화면에 알림만

위키미디어 API 이용 원칙: 알아볼 수 있는 User-Agent, 동시 요청 적게(최대 3).
"""
from __future__ import annotations

import json
import os
import re
import ssl
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

from . import classify as C

API = "https://ko.wikipedia.org/w/api.php"
UA = "OneQ-Ace-prep/0.5 (https://github.com/Hoonie2026/OneQ-Ace; exam study pack preprocessor)"
PAGES_PER_QUERY = 3
MAX_WORKERS = 3
TIMEOUT = 15
MAX_FRAC = 0.05          # 이번 기출 문항 5% 넘게 나오는 낱말은 버림(너무 흔함)
MAX_UNITS = 2            # 단원 3곳 이상의 검색 결과에 나오는 낱말은 버림(구별력 없음)
W_ONE, W_TWO = 1.2, 0.5  # 한 단원에만 / 두 단원에 나온 낱말의 무게(출제기준 낱말 1.0~1.5와 비슷하게)

Fetch = Callable[[str], dict]


@dataclass
class WebTerms:
    terms: dict[str, dict[str, float]]          # 단원 id → {낱말: 무게}
    queries: int = 0
    failed: int = 0
    pages: int = 0
    notes: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return sum(len(t) for t in self.terms.values())


def _http(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=TIMEOUT, context=ssl.create_default_context()) as r:
        return json.loads(r.read().decode("utf-8"))


def search_url(query: str) -> str:
    return API + "?" + urllib.parse.urlencode({
        "action": "query", "format": "json", "formatversion": 2, "generator": "search", "gsrsearch": query,
        "gsrlimit": PAGES_PER_QUERY, "gsrnamespace": 0, "prop": "extracts", "exintro": 1, "explaintext": 1,
        "exlimit": PAGES_PER_QUERY, "redirects": 1})


def _texts(data: dict) -> list[tuple[str, str]]:
    pages = (data.get("query") or {}).get("pages") or []
    if isinstance(pages, dict):                     # formatversion 1
        pages = list(pages.values())
    return [(p.get("title", ""), p.get("extract", "")) for p in pages if p.get("extract")]


def queries_for(unit: dict) -> list[str]:
    """단원 이름 + 세세항목(짧은 일반어 "개요"·"종류"만인 것은 뺌). 겹치면 한 번만."""
    out = [unit["name"]]
    for it in unit["items"]:
        w = [x for x in C._words(it)]
        if w and C._flat(it) not in {C._flat(q) for q in out}:
            out.append(re.sub(r"\s+", " ", it).strip())
    return out


WORD = re.compile(r"[가-힣]{2,}|[A-Za-z][A-Za-z.\-]{1,}")


def _words(text: str) -> set[str]:
    out = set()
    for w in WORD.findall(text):
        if re.match(r"[A-Za-z]", w):
            w = w.strip(".-")
            if len(w) >= 2 and (w.isupper() or len(w) >= 4):
                out.add(w.lower())
            continue
        for suf in C.SUFFIX + ("이다", "한다", "하는", "하여", "되는", "된다", "에는", "으로써", "이며", "에서의"):
            if len(w) > len(suf) + 1 and w.endswith(suf):
                w = w[: -len(suf)]
                break
        if len(w) >= 2 and w not in C.STOP:
            out.add(w)
    return out


def gather(units: list[dict], corpus: list[str], fetch: Fetch | None = None,
           log: Callable[[str], None] = lambda *_: None) -> WebTerms | None:
    """단원(profile.units) → 위키백과 검색 → 이번 기출 말뭉치로 거른 단원별 낱말. 하나도 못 받으면 None."""
    if fetch is None and os.environ.get("ONEQ_NO_WEB"):
        log("웹 용어: 꺼 둠(ONEQ_NO_WEB)")
        return None
    fetch = fetch or (lambda q: _http(search_url(q)))
    jobs = [(u["id"], q) for u in units for q in queries_for(u)]

    def one(job):
        uid, q = job
        try:
            return uid, _texts(fetch(q)), None
        except Exception as e:  # noqa: BLE001 — 네트워크·시간 초과·형식 바뀜
            return uid, [], type(e).__name__

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        results = list(ex.map(one, jobs))
    failed = sum(1 for _, _, err in results if err)
    if failed == len(jobs):
        log(f"웹 용어: 위키백과에 연결하지 못함({results[0][2] if results else '-'})")
        return None
    per_unit: dict[str, Counter] = defaultdict(Counter)
    seen_pages: dict[str, set[str]] = defaultdict(set)
    for uid, pages, _ in results:
        for title, text in pages:
            if title in seen_pages[uid]:
                continue
            seen_pages[uid].add(title)
            for w in _words(title + " " + text):
                per_unit[uid][w] += 1
    flat = [C._flat(t) for t in corpus]
    n = max(1, len(flat))
    owners: dict[str, set[str]] = defaultdict(set)
    for uid, cnt in per_unit.items():
        for w in cnt:
            owners[C._flat(w)].add(uid)
    terms: dict[str, dict[str, float]] = defaultdict(dict)
    for k, us in owners.items():
        if len(k) < 2 or len(us) > MAX_UNITS:
            continue
        frac = sum(k in f for f in flat) / n
        if frac == 0 or frac > MAX_FRAC:
            continue
        for uid in us:
            terms[uid][k] = W_ONE if len(us) == 1 else W_TWO
    wt = WebTerms(dict(terms), len(jobs), failed, sum(len(s) for s in seen_pages.values()))
    if failed:
        wt.notes.append(f"웹 용어: 검색 {len(jobs)}건 중 {failed}건 실패")
    log(f"웹 용어: 검색 {len(jobs)}건 · 문서 {wt.pages}개 · 낱말 {wt.total}개")
    return wt
