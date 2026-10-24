"""comcbt.com 게시판 첫 쪽의 최근 기출 PDF 받기(ADR 021 1절 개정, 사용자 결정 2026-10-24 15:19).

범위: 종목 게시판 **첫 쪽만**(robots.txt가 막는 검색·정렬·쪽 넘김 매개변수는 쓰지 않음 — 2026-10-24 확인).
그 이전 회차(2쪽~)와 게시판에 아직 없는 최신 회차는 사용자가 comcbt.com 등에서 직접 내려받아 올린다(화면 안내).

사이트 모양(2026-10-24 PC Chrome 확인):
- 첫 화면 메뉴: <a href="//www.comcbt.com/xe/n1">토목기사</a> — 종목명 → 게시판 주소
- 게시판: 제목 "토목기사 필기 기출문제 및 CBT 2022년 04월 24일(2회)" → 글 주소 /xe/n1/5855371, 쪽 표시 "Prev 1 2 3 Next"
- 글: 첨부 <a href="…/xe/?module=file&act=procFileDownload&file_srl=…&sid=…&module_srl=…">토목기사20220424(교사용).pdf</a>
  (교사용 = 정답 표시 있음 — 직접 올리는 기출 조건 2와 같음). 받을 때 다른 주소로 넘겨줌 → 쿠키·Referer를 지킨다
- 정중하게: 요청 사이 1초 쉼, 이미 있는 시행일은 받지 않음
"""
from __future__ import annotations

import html
import http.cookiejar
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

BASE = "https://www.comcbt.com"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OneQ-Prep"
MENU_RE = re.compile(r"<a[^>]+href=\"(?:https?:)?//www\.comcbt\.com/xe/([A-Za-z0-9]+)\"[^>]*>\s*([^<]+?)\s*</a>")
POST_RE = re.compile(r"<a[^>]+href=\"(?:https?://www\.comcbt\.com)?/xe/([A-Za-z0-9]+)/(\d+)\"[^>]*>\s*([^<]*?필기\s*기출문제[^<]*?)\s*</a>")
TITLE_RE = re.compile(r"(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\s*\(([^)]*)\)")
FILE_RE = re.compile(r"<a[^>]+href=\"([^\"]*procFileDownload[^\"]*)\"[^>]*>\s*([^<]+?\.pdf)\s*</a>", re.I)
PAGES_RE = re.compile(r"Board Pagination|pagination", re.I)
DELAY = 1.0


class ComcbtError(RuntimeError):
    """comcbt에서 받지 못함(사용자에게 그대로 보여 줄 문장)."""


@dataclass
class Post:
    title: str
    url: str
    date: str          # YYYY-MM-DD
    round_label: str   # "2회", "1, 2회 통합" (comcbt 표기 그대로)


@dataclass
class Result:
    board: str
    posts: list[Post]                       # 첫 쪽의 필기 기출 글
    saved: list[Path] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)    # 이미 있음
    failed: list[str] = field(default_factory=list)     # (글 제목: 이유)
    more_pages: bool = False                # 게시판에 2쪽 이상 있음 → 이전 회차는 직접


class Client:
    def __init__(self, opener=None, delay: float = DELAY):
        self.jar = http.cookiejar.CookieJar()
        self.opener = opener or urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.delay = delay
        self._last = 0.0

    def get(self, url: str, referer: str | None = None, timeout: float = 60) -> bytes:
        wait = self.delay - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": UA, **({"Referer": referer} if referer else {})})
        try:
            with self.opener.open(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise ComcbtError(f"comcbt.com이 요청을 거절했습니다(HTTP {e.code}).") from e
        except Exception as e:  # noqa: BLE001
            raise ComcbtError(f"comcbt.com에 연결하지 못했습니다({type(e).__name__}). 인터넷 연결을 확인하세요.") from e
        finally:
            self._last = time.monotonic()


def _norm(s: str) -> str:
    return re.sub(r"[\s·ㆍ]+", "", s)


def parse_menu(page: str) -> dict[str, str]:
    """첫 화면 메뉴 → {종목명: 게시판 코드}."""
    out: dict[str, str] = {}
    for slug, name in MENU_RE.findall(page):
        out.setdefault(_norm(html.unescape(name)), slug)
    return out


def parse_board(page: str) -> tuple[list[Post], bool]:
    posts, seen = [], set()
    for slug, no, title in POST_RE.findall(page):
        title = re.sub(r"\s+", " ", html.unescape(title)).strip()
        m = TITLE_RE.search(title)
        if not m or no in seen:
            continue
        seen.add(no)
        y, mo, d, lab = m.groups()
        posts.append(Post(title, f"{BASE}/xe/{slug}/{no}", f"{int(y):04d}-{int(mo):02d}-{int(d):02d}", lab.strip()))
    more = bool(re.search(r">\s*2\s*</a>", page)) and bool(PAGES_RE.search(page))
    return posts, more


def parse_files(page: str) -> list[tuple[str, str]]:
    """글의 첨부 PDF [(이름, 받기 주소)] — 교사용(정답 표시)이 먼저."""
    seen, out = set(), []
    for href, name in FILE_RE.findall(page):
        href = html.unescape(href)
        if href in seen:
            continue
        seen.add(href)
        out.append((html.unescape(name).strip(), urllib.parse.urljoin(BASE + "/xe/", href)))
    return sorted(out, key=lambda x: "교사용" not in x[0])


def board_of(cert_name: str, client: Client) -> str:
    menu = parse_menu(client.get(BASE + "/").decode("utf-8", "replace"))
    if not menu:
        raise ComcbtError("comcbt.com 첫 화면 모양이 바뀌어 종목 게시판을 찾지 못했습니다.")
    slug = menu.get(_norm(cert_name))
    if not slug:
        raise ComcbtError(f"comcbt.com에서 '{cert_name}' 게시판을 찾지 못했습니다.")
    return slug


def fetch_recent(cert_name: str, dest: Path, have_dates: set[str] | None = None, client: Client | None = None,
                 progress=None, should_stop=lambda: False) -> Result:
    """게시판 첫 쪽의 필기 기출 글마다 교사용 PDF 하나를 dest에 받는다(이미 있는 시행일은 건너뜀)."""
    client = client or Client()
    step = progress or (lambda *_: None)
    have = set(have_dates or ())
    slug = board_of(cert_name, client)
    board_url = f"{BASE}/xe/{slug}"
    posts, more = parse_board(client.get(board_url).decode("utf-8", "replace"))
    if not posts:
        raise ComcbtError("comcbt.com 게시판 모양이 바뀌어 기출 글을 찾지 못했습니다.")
    res = Result(slug, posts, more_pages=more)
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)
    for i, p in enumerate(posts, 1):
        if should_stop():
            break
        step(i, len(posts), p)
        if p.date in have:
            res.skipped.append(p.title)
            continue
        try:
            files = parse_files(client.get(p.url, referer=board_url).decode("utf-8", "replace"))
            pdf = next(((n, u) for n, u in files if "교사용" in n), None)
            if pdf is None:
                res.failed.append(f"{p.title}: 정답 표시(교사용) PDF가 없음")
                continue
            body = client.get(pdf[1], referer=p.url, timeout=120)
            if not body.startswith(b"%PDF"):
                res.failed.append(f"{p.title}: 받은 파일이 PDF가 아님(로그인이 필요하거나 사이트가 바뀜)")
                continue
            name = re.sub(r'[\\/:*?"<>|]+', "_", pdf[0])
            out = dest / name
            out.write_bytes(body)
            res.saved.append(out)
            have.add(p.date)
        except ComcbtError as e:
            res.failed.append(f"{p.title}: {e}")
    return res


def guide(res: Result | None, cert_name: str) -> list[str]:
    """받은 뒤 안내 — 첫 쪽만 받았으니 나머지는 직접(사용자 결정 2026-10-24)."""
    lines = []
    if res is not None and res.posts:
        oldest = min(p.date for p in res.posts)
        lines.append(f"comcbt.com '{cert_name}' 게시판 첫 쪽의 최근 {len(res.posts)}회차"
                     f"({oldest[:4]}년~)만 자동으로 받습니다.")
    lines.append("그보다 이전 회차와, 게시판에 아직 올라오지 않은 최신 회차는 comcbt.com 등에서 직접 내려받아 "
                 "이 목록에 끌어다 놓아 주세요(정답이 표시된 '교사용' PDF).")
    return lines


def main(argv=None):
    import argparse
    import sys
    ap = argparse.ArgumentParser(prog="oneq_prep.comcbt", description="comcbt.com 게시판 첫 쪽의 최근 기출(교사용 PDF) 받기")
    ap.add_argument("name", help="정확한 종목명(예: 토목기사)")
    ap.add_argument("dest", type=Path, help="저장 폴더")
    ap.add_argument("--list", action="store_true", help="목록만 보기(받지 않음)")
    a = ap.parse_args(argv)
    try:
        if a.list:
            c = Client()
            slug = board_of(a.name, c)
            posts, more = parse_board(c.get(f"{BASE}/xe/{slug}").decode("utf-8", "replace"))
            for p in posts:
                print(f"{p.date}\t{p.round_label}\t{p.url}")
            print(f"(게시판 {slug}, 2쪽 이상: {more})")
            return
        res = fetch_recent(a.name, a.dest, progress=lambda i, n, p: print(f"[{i}/{n}] {p.title}", flush=True))
    except ComcbtError as e:
        sys.exit(str(e))
    print(f"받음 {len(res.saved)} · 이미 있음 {len(res.skipped)} · 실패 {len(res.failed)}")
    for f in res.failed:
        print(f"! {f}")
    print("\n".join(guide(res, a.name)))


if __name__ == "__main__":
    main()
