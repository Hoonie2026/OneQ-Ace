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
    # 다시 조회: 목록은 매번 묻고(최신 확인), 같은 게시물이면 PDF는 다시 받지 않음
    n = len(calls)
    again = qnet.fetch_standard("토목기사", "CIVIL", fake(calls), dt.date(2026, 10, 24))
    assert again.same and len(calls) == n + 1 and "ReportingServer" not in calls[-1][0]


def test_not_pdf_is_friendly_error(tmp_path):
    post = qnet.Post("토목기사", "t", "1250", "1004", "2026-01-01", "2027-12-31")
    with pytest.raises(qnet.QnetChanged, match="화면이 바뀌어.*직접 내려받아"):
        qnet.download_pdf(post, tmp_path / "x.pdf", lambda *a, **k: (b"<html>", "text/html"))


def test_no_current_standard(tmp_path, monkeypatch):
    monkeypatch.setenv("ONEQ_PREP_HOME", str(tmp_path))
    with pytest.raises(qnet.QnetNotFound, match="현행 출제기준을 찾지 못"):
        qnet.fetch_standard("전기기사", "ELEC", lambda *a, **k: ("<p>등록된 게시물이 없습니다.</p>".encode(), "text/html"))


def test_list_page_changed(tmp_path, monkeypatch):
    """게시물도 '없음' 안내도 없는 목록 → 화면이 바뀐 것으로 보고 직접 올리기 안내."""
    monkeypatch.setenv("ONEQ_PREP_HOME", str(tmp_path))
    with pytest.raises(qnet.QnetChanged):
        qnet.fetch_standard("토목기사", "CIVIL", lambda *a, **k: (b"<html><body>new design</body></html>", "text/html"))


def test_offline_message():
    def boom(*a, **k):
        raise qnet.QnetOffline("URLError")
    with pytest.raises(qnet.QnetOffline, match="연결하지 못했습니다"):
        qnet.search("토목기사", boom)
