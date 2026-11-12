"""교차 확인(C) — 정답을 믿을 수 없는 문항을 다른 회차의 같은 문항으로 살린다(ADR 024, 사용자 2026-11-12).

기출은 같은 문항이 여러 회차에 다시 나온다. 정답을 못 찾았거나(정답 표시·정답표 어긋남 등) 확신이 없는 문항과
같은 문항이 이번에 함께 처리한 회차나 문제팩 폴더의 기존 팩에 '믿을 수 있는 정답'으로 있으면 그 정답을 쓴다.
- 같은 문항 = 발문이 같고 보기 글이 같은 것(번호·공백·부호 무시). 보기 순서가 바뀌었으면 정답 보기의 글로 위치를 찾는다
- 찾은 정답이 서로 다르면 쓰지 않음(그대로 '정답 확인 필요' 또는 제외 — pack.settle_doubts)
"""
from __future__ import annotations

import json
import re
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path

CHOICE_RE = re.compile(r"[①②③④⑤]")


def _clean(s: str) -> str:
    return re.sub(r"[^0-9A-Za-z가-힣ㄱ-ㆎ]", "", unicodedata.normalize("NFKC", s)).lower()


def split(text: str) -> tuple[str, list[str]]:
    """(발문, 보기 글 목록) — 앱 engine/items.ts sameKey와 같은 정리(번호 머리 떼고, 원문자로 나눔)."""
    t = re.sub(r"^\s*\d{1,3}\s*\.\s*", "", text)
    parts = CHOICE_RE.split(t)
    if len(parts) < 3:
        return _clean(t), []
    # NFKC가 ①을 1로 바꾸므로 나눈 뒤에 정리한다
    return _clean(parts[0]), [_clean(x) for x in parts[1:]]


@dataclass
class Known:
    stem: str
    choices: list[str]
    answer: int
    ref: str            # 어디서(qid)


def _key(stem: str, choices: list[str]) -> str:
    return stem + "|" + "|".join(sorted(choices))


def pool(prepared: list, out_dir: Path, code: str) -> dict[str, list[Known]]:
    """믿을 수 있는 정답: 이번 회차들의 정답 확정 문항 + 문제팩 폴더의 같은 종목 기존 팩(이번에 다시 만드는 회차는 뺌)."""
    out: dict[str, list[Known]] = {}

    def add(text: str, answer: int, ref: str) -> None:
        stem, ch = split(text)
        if len(stem) < 8 or len(ch) < 2 or not 1 <= answer <= len(ch):
            return
        out.setdefault(_key(stem, ch), []).append(Known(stem, ch, answer, ref))

    ids = {p.pack_id for p in prepared}
    for p in prepared:
        for it in p.items:
            if it.excluded or it.doubt or it.answer is None:
                continue
            add(it.text, it.answer, f"{p.pack_id}-{it.no:03d}")
    for z in sorted(Path(out_dir).glob(f"oneq-{code}-*.zip")):
        if "-bundle-" in z.name:
            continue
        try:
            with zipfile.ZipFile(z) as f:
                if json.loads(f.read("manifest.json"))["packId"] in ids:
                    continue
                for q in json.loads(f.read("questions.json")):
                    if "answer-unsure" not in q.get("flags", []):
                        add(q.get("text", ""), int(q["answer"]), q["qid"])
        except (OSError, KeyError, ValueError, zipfile.BadZipFile):
            continue
    return out


def answer_for(text: str, known: dict[str, list[Known]]) -> tuple[int, str] | None:
    """같은 문항의 정답(이 문항의 보기 순서로) — 후보끼리 다르면 None."""
    stem, ch = split(text)
    if len(stem) < 8 or len(ch) < 2:
        return None
    got: dict[int, str] = {}
    for k in known.get(_key(stem, ch), []):
        right = k.choices[k.answer - 1]
        pos = [i + 1 for i, c in enumerate(ch) if c == right]
        if len(pos) != 1:
            return None                       # 같은 글의 보기가 둘 — 위치를 정할 수 없음
        got.setdefault(pos[0], k.ref)
    if len(got) != 1:
        return None
    (a, ref), = got.items()
    return a, ref


def apply(prepared: list, out_dir: Path, code: str) -> int:
    """정답을 믿을 수 없는 문항(doubt)을 교차 확인으로 살림. 살린 문항 수."""
    from .pack import LEAK_DOUBT
    targets = [(p, it) for p in prepared for it in p.items if it.doubt and not it.excluded and it.doubt != LEAK_DOUBT]
    if not targets:
        return 0
    known = pool(prepared, out_dir, code)
    n = 0
    for p, it in targets:
        hit = answer_for(it.text, known)
        if not hit:
            continue
        a, ref = hit
        it.answer, it.answer_source, it.answer_check = a, "cross-check", "agree"
        it.alts = []
        p.notes.append(f"{it.no}번: {it.doubt} → 같은 문항({ref})의 정답 {a}번으로 교차 확인")
        it.doubt = None
        n += 1
    return n
