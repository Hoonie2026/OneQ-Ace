"""큐넷 출제기준 받기(A2) — 네트워크 없이: 목록 HTML(2026-10-24 실제 응답 모양)과 PDF 응답을 흉내 낸다."""
import datetime as dt
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep import qnet  # noqa: E402

LIST_HTML = """
<table><tbody>
<tr> <td class="tbodyView">1</td> <td class="txtL" title="토목기사"> <a href="#" onclick="cst006Report('1250', '1004');">
 토목기사(2026.1.1~2027.12.31) </a> </td> <td class="tbodyWriter">자격품질관리국 자격기준관리부</td> </tr>
<tr> <td class="tbodyView">2</td> <td class="txtL" title="철도토목기사"> <a href="#" onclick="cst006Report('1760', '135');">
 철도토목기사(2025.1.1~2027.12.31) </a> </td> </tr>
<tr> <td class="tbodyView">3</td> <td class="txtL" title="토목기사"> <a href="#" onclick="cst006Report('1250', '880');">
 토목기사(2022.1.1~2025.12.31) </a> </td> </tr>
<tr> <td class="tbodyView">4</td> <td class="txtL" title="토목기사"> <a href="#" onclick="cst006Report('1250', '1100');">
 토목기사(2028.1.1~2031.12.31) </a> </td> </tr>
</tbody></table>"""
CIVIL_PDF = Path(__file__).parent / "fixtures" / "standards" / "CIVIL-qnet-2026-2027.pdf"


def fake(calls):
    def fetch(url, data=None, timeout=30):
        calls.append((url, data))
        if "ReportingServer" in url:
            assert b"jmCd%5B1250%5D+mcrtrNo%5B1004%5D" in data and b"opcode=500" in data
            return CIVIL_PDF.read_bytes(), "application/pdf"
        assert "schText=%ED%86%A0%EB%AA%A9%EA%B8%B0%EC%82%AC" in url and "code=1202" in url
        return LIST_HTML.encode("utf-8"), "text/html"
    return fetch


def test_parse_and_choose():
    posts = qnet.parse_list(LIST_HTML)
    assert [(p.name, p.jm_cd, p.no, p.period_from) for p in posts][:2] == [
        ("토목기사", "1250", "1004", "2026-01-01"), ("철도토목기사", "1760", "135", "2025-01-01")]
    ch = qnet.choose(posts, "토목기사", dt.date(2026, 10, 24))
    assert ch.current.no == "1004" and ch.upcoming.no == "1100" and [p.no for p in ch.others] == ["880"]
    assert qnet.choose(posts, "토목기사", dt.date(2028, 3, 1)).current.no == "1100"


def test_fetch_standard_saves_user_profile(tmp_path, monkeypatch):
    monkeypatch.setenv("ONEQ_PREP_HOME", str(tmp_path))
    calls = []
    got = qnet.fetch_standard("토목기사", "CIVIL", fake(calls), dt.date(2026, 10, 24))
    assert got.post.no == "1004" and got.upcoming.no == "1100" and got.warnings == []
    assert got.profile_path == tmp_path / "standards" / "CIVIL.json"
    from oneq_prep import standards as S
    p = S.load("CIVIL")                                   # 사용자 폴더 것이 우선
    assert p.period == {"from": "2026-01-01", "to": "2027-12-31"} and len(p.units("응용역학")) == 10
    assert p.subjects[2]["name"] == "수리학 및 수문학"     # 함께 배포한 프로필의 과목 표기 이어받음
    # 같은 날 다시: 목록은 저장해 둔 것(큐넷에 목록을 다시 묻지 않음)
    n = len(calls)
    qnet.check_today("토목기사", fake(calls), dt.date(2026, 10, 24))
    assert len(calls) == n


def test_not_pdf_is_friendly_error(tmp_path):
    post = qnet.Post("토목기사", "t", "1250", "1004", "2026-01-01", "2027-12-31")
    with pytest.raises(qnet.QnetError, match="끌어다 놓"):
        qnet.download_pdf(post, tmp_path / "x.pdf", lambda *a, **k: (b"<html>", "text/html"))


def test_no_current_standard(tmp_path, monkeypatch):
    monkeypatch.setenv("ONEQ_PREP_HOME", str(tmp_path))
    with pytest.raises(qnet.QnetError, match="현행 출제기준을 찾지 못"):
        qnet.fetch_standard("전기기사", "ELEC", lambda *a, **k: (b"<table></table>", "text/html"))
