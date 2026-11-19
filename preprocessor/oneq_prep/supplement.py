"""보충 문서 — 스캔본에서 만들지 못한 문항을 사용자가 직접 타이핑해 회차 문제팩에 더한다(세션 #22, 사용자 2026-11-18).

- 알아보기: 첫 쪽 첫머리(위쪽 몇 줄)에 "2014년 철도토목기사 2회 보충"처럼 연도·회차와 '보충'이 있으면 보충 문서.
  종목·연도·회차는 이 줄에서 읽는다(파일 이름은 쓰지 않음 — ADR 021 2절).
- 문항 번호는 시험지 번호 그대로(17, 18, 39…) — 1번부터 이어지지 않아도 된다(extract.analyze free_numbers).
- 합치기(batch): 같은 묶음에서 처리한 원본 회차의 문제팩에서 **빠진 번호 자리에만** 넣는다 — 판독 불가·자동 제외된 번호,
  아예 기록 없이 빠진 끝 번호. 원본에 이미 있는 문항은 덮어쓰지 않고, 폐지 과목 번호에도 넣지 않는다.
  과목은 원본에서 같은 번호 구간(과목마다 같은 문항 수일 때 그 크기, 예: 20문항)에 든 문항의 과목으로.
"""
from __future__ import annotations

import re
from pathlib import Path

HEAD_RE = re.compile(r"((?:19|20)\d{2})\s*년.{0,30}?(?:제\s*)?(\d{1,2})\s*회.{0,25}?보\s*충")
# 회차를 적지 않은 머리말("2014년 철도토목기사 필기 보충") — 같은 묶음에서 그해 원본 회차가 하나뿐일 때 거기에 더함
HEAD_NOROUND_RE = re.compile(r"((?:19|20)\d{2})\s*년.{0,40}?보\s*충")


def header(pdf: str | Path) -> tuple[int, int | None] | None:
    """보충 문서면 (연도, 회차 또는 None), 아니면 None — 첫 쪽 위쪽 다섯 줄 안에서."""
    try:
        import pdfplumber
        with pdfplumber.open(str(pdf)) as doc:
            if not doc.pages:
                return None
            text = doc.pages[0].extract_text() or ""
    except Exception:  # noqa: BLE001 — 읽을 수 없는 PDF는 보충 문서가 아님(다른 단계에서 오류로)
        return None
    for line in text.splitlines()[:5]:
        m = HEAD_RE.search(line)
        if m:
            return int(m.group(1)), int(m.group(2))
        m = HEAD_NOROUND_RE.search(line)
        if m:
            return int(m.group(1)), None
    return None


ABOLISHED_PREFIX = "현행 출제기준에 없는 과목"
# 머리말에 회차가 없을 때 쓰는 임시 회차 — 파일 목록을 다 읽은 뒤 그해 원본 회차로 바꾼다(batch.mark_duplicates)
UNKNOWN_ROUND = 99


def merge(main, sup, block: int | None) -> tuple[list[int], list[str]]:
    """보충(sup, Prepared)의 문항을 원본 회차(main, Prepared)에 더한다. (넣은 번호, 넣지 못한 이유) 를 돌려준다.
    block: 과목마다 문항 수가 같으면 그 수(번호 구간으로 과목을 정함), 아니면 None(바로 앞 번호 문항의 과목)."""
    have = {it.no: it for it in main.items}
    added: list[int] = []
    skipped: list[str] = []
    missing_nos = {m[0] if isinstance(m, (list, tuple)) else m for m in main.missing}

    def subject_of(n: int) -> str | None:
        kept = [it for it in main.items if it.subject and not (it.excluded or "").startswith(ABOLISHED_PREFIX)]
        if block:
            same = [it.subject for it in kept if (it.no - 1) // block == (n - 1) // block]
            if same:
                return max(set(same), key=same.count)
            abolished = [it for it in main.items if (it.excluded or "").startswith(ABOLISHED_PREFIX)
                         and (it.no - 1) // block == (n - 1) // block]
            if abolished:
                return None
        lower = [it for it in kept if it.no < n]
        return max(lower, key=lambda it: it.no).subject if lower else None

    for it in sorted(sup.items, key=lambda x: x.no):
        n = it.no
        cur = have.get(n)
        # 원본 문항에 다음 문항이 붙어 망가진 것(pack.MERGED_NEXT — 팩을 쓸 때 자동으로 빠짐)은 빠진 번호로 본다
        broken = cur is not None and any("다음 문항이 붙음" in w for w in cur.warnings)
        if cur is not None and not cur.excluded and not broken:
            skipped.append(f"{n}번: 원본에 이미 있어 넣지 않음")
            continue
        if cur is not None and (cur.excluded or "").startswith(ABOLISHED_PREFIX):
            skipped.append(f"{n}번: 현행 출제기준에 없는 과목 번호라 넣지 않음")
            continue
        std = subject_of(n)
        if std is None:
            skipped.append(f"{n}번: 과목을 정할 수 없어 넣지 않음(폐지 과목 구간일 수 있음)")
            continue
        it.subject = std
        it.pdf_subject = std
        it.local_no = n
        it.excluded = None
        if cur is not None:
            main.items[main.items.index(cur)] = it
        else:
            main.items.append(it)
        added.append(n)
        missing_nos.discard(n)
    main.items.sort(key=lambda x: x.no)
    main.missing = [m for m in main.missing if (m[0] if isinstance(m, (list, tuple)) else m) in missing_nos]
    if added:
        main.notes.append(f"보충 문서({sup.pdf.name})에서 {len(added)}문항을 더함: {', '.join(map(str, added))}번")
    return added, skipped
