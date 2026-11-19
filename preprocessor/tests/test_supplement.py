"""보충 문서(세션 #22): 스캔본에서 만들지 못한 문항을 직접 타이핑한 PDF로 회차 문제팩에 더한다."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep.pack import Item, Prepared  # noqa: E402
from oneq_prep.supplement import HEAD_NOROUND_RE, HEAD_RE, merge  # noqa: E402


def test_header_line():
    for t, yr in (("2014년 철도토목기사 2회 보충", (2014, 2)), ("2009년 철도토목기사 제2회 보충", (2009, 2)),
                  ("2021년 2회 철도토목기사 필기 보충", (2021, 2))):
        m = HEAD_RE.search(t)
        assert m and (int(m.group(1)), int(m.group(2))) == yr
    assert HEAD_RE.search("2014년 철도토목기사 2회") is None          # '보충'이 없으면 원본 회차
    # 회차 없이 쓴 머리말(실기기 2026-11-18: "2014년 철도토목기사 필기 보충") — 그해 원본 회차에 더함
    assert HEAD_RE.search("2014년 철도토목기사 필기 보충") is None
    assert HEAD_NOROUND_RE.search("2014년 철도토목기사 필기 보충").group(1) == "2014"
    assert HEAD_NOROUND_RE.search("2014년 철도토목기사 필기") is None


def _it(no, subject, excluded=None, warnings=()):
    return Item(no, no, subject or "x", subject, None, None, None, [], 4, b"", (1, 1), f"{no}. 문항", [],
                list(warnings), excluded)


def _prep(items, missing=()):
    return Prepared(Path("a.pdf"), "T-2014-2", {}, None, [], 0, items, [], [], "continuous", False, False, {},
                    missing=list(missing))


def test_merge_fills_only_missing_numbers():
    main = _prep([_it(1, "철도공학"), _it(2, "철도공학", warnings=["다음 문항이 붙음"]), _it(21, "측량학"),
                  _it(41, None, excluded="현행 출제기준에 없는 과목(건설재료 및 시공)"), _it(61, "법규")],
                 missing=[(3, "철도공학"), (22, "측량학")])
    sup = _prep([_it(n, None, excluded="현행 출제기준에 없는 과목(1과목)") for n in (1, 2, 3, 22, 41, 62)])
    added, skipped = merge(main, sup, block=20)
    assert added == [2, 3, 22, 62]                                  # 망가진 2번·판독 불가 3·22번·기록 없이 빠진 62번
    assert any(s.startswith("1번") for s in skipped) and any(s.startswith("41번") for s in skipped)
    by = {it.no: it for it in main.items}
    assert (by[3].subject, by[22].subject, by[62].subject) == ("철도공학", "측량학", "법규")
    assert by[3].excluded is None and main.missing == []
    assert [it.no for it in main.items] == sorted(it.no for it in main.items)
