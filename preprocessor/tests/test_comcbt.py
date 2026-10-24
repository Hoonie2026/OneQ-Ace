"""comcbt 첫 쪽 기출 받기(사용자 결정 2026-10-24) — 네트워크 없이 사이트 모양(2026-10-24 확인)을 흉내 낸다."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep import comcbt  # noqa: E402

MENU = '<li><a href="//www.comcbt.com/xe/n1">토목기사</a></li><li><a href="//www.comcbt.com/xe/cdf">철도토목산업기사</a></li>'
BOARD = """
<a href="https://www.comcbt.com/xe/n1/100">전자문제집 CBT 최신 기출문제, 복원중, 해설, 자주 하는 질문 모음</a>
<a href="https://www.comcbt.com/xe/n1/5855371">토목기사 필기 기출문제 및 CBT 2022년 04월 24일(2회)</a>
<a href="https://www.comcbt.com/xe/n1/5756155">토목기사 필기 기출문제 및 CBT 2022년 03월 05일(1회)</a>
<a href="https://www.comcbt.com/xe/n1/4000000">토목기사 필기 기출문제 및 CBT 2020년 06월 06일(1, 2회 통합)</a>
<div class="pagination">Board Pagination Prev <strong>1</strong> <a href="#">2</a> <a href="#">3</a> Next</div>"""
POST = """<p><a data-file-srl="1" href="https://www.comcbt.com/xe/?module=file&amp;act=procFileDownload&amp;file_srl=1&amp;sid=a&amp;module_srl=9">토목기사20220424(교사용).hwp</a></p>
<p><a href="https://www.comcbt.com/xe/?module=file&amp;act=procFileDownload&amp;file_srl=3&amp;sid=c&amp;module_srl=9">토목기사20220424(학생용).pdf</a></p>
<p><a href="https://www.comcbt.com/xe/?module=file&amp;act=procFileDownload&amp;file_srl=2&amp;sid=b&amp;module_srl=9">토목기사20220424(교사용).pdf</a></p>"""


class Fake(comcbt.Client):
    def __init__(self):
        super().__init__(opener=object(), delay=0)
        self.urls = []

    def get(self, url, referer=None, timeout=60):
        self.urls.append((url, referer))
        if url == comcbt.BASE + "/":
            return MENU.encode()
        if url.endswith("/xe/n1"):
            return BOARD.encode()
        if "procFileDownload" in url:
            assert "file_srl=2" in url and "&amp;" not in url and referer.startswith(comcbt.BASE + "/xe/n1/")
            return b"%PDF-1.4 fake"
        return POST.encode()


def test_parse_board_and_files():
    posts, more = comcbt.parse_board(BOARD)
    assert [(p.date, p.round_label) for p in posts] == [("2022-04-24", "2회"), ("2022-03-05", "1회"), ("2020-06-06", "1, 2회 통합")]
    assert more
    files = comcbt.parse_files(POST)
    assert files[0][0] == "토목기사20220424(교사용).pdf" and len(files) == 2   # hwp는 빼고 교사용 먼저
    assert comcbt.parse_menu(MENU) == {"토목기사": "n1", "철도토목산업기사": "cdf"}


def test_fetch_recent_first_page_only(tmp_path):
    c = Fake()
    res = comcbt.fetch_recent("토목기사", tmp_path, have_dates={"2022-03-05"}, client=c)
    assert len(res.saved) == 2 and res.skipped and res.more_pages
    assert not any("page=" in u or "search" in u for u, _ in c.urls)        # robots.txt가 막는 매개변수 안 씀
    assert all(p.read_bytes().startswith(b"%PDF") for p in res.saved)
    g = comcbt.guide(res, "토목기사")
    assert "첫 쪽" in g[0] and "직접 내려받아" in g[1]


def test_unknown_board():
    with pytest.raises(comcbt.ComcbtError, match="게시판을 찾지 못"):
        comcbt.fetch_recent("없는기사", Path("."), client=Fake())
