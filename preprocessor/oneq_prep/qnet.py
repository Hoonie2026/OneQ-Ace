"""큐넷 출제기준 자료실에서 현행 출제기준 PDF 받기(ADR 021 1절, PREP-PLAN-v0.5 A2, PC-TODO P17 확인 2026-10-24).

계정·API 키 없음. 큐넷 화면이 쓰는 두 요청을 그대로 쓴다(로그인·쿠키 불필요 — PC Chrome에서 확인):
1. 목록: GET  /cst006.do?id=cst00601s01&...&schText=<종목명>&schType=T&brdId=Q006&code=1202
   → 줄마다 <td class="txtL" title="<종목명>"><a onclick="cst006Report('<종목코드>', '<게시번호>');"> 종목명(YYYY.M.D~YYYY.M.D) </a>
2. PDF:  POST /ReportingServer/service (보기 창 Crownix의 [PDF 저장] 요청: opcode 500, mrd HRD_QSC.mrd,
   매개변수 jmCd·mcrtrNo·rcgnMthdCd[A], protocol=file) → application/pdf
공개 API가 아니라 보기 창 내부 요청이므로 큐넷이 바꾸면 멈출 수 있다 → QnetError, 화면은 "보기 창에서 [저장]한 PDF를
끌어다 놓기"로 안내한다. 요청은 종목을 고를 때 몇 번뿐(하루 한 번 목록 확인).
"""
from __future__ import annotations

import datetime as dt
import html
import json
import re
import ssl
import urllib.parse
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

BASE = "https://www.q-net.or.kr"
LIST_URL = BASE + "/cst006.do"
REPORT_URL = BASE + "/ReportingServer/service"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) OneQ-Prep"
ROW_RE = re.compile(r"<td[^>]*title=\"([^\"]+)\"[^>]*>\s*<a[^>]*cst006Report\('(\d+)'\s*,\s*'(\d+)'\)[^>]*>([\s\S]*?)</a>")
PERIOD_RE = re.compile(r"\((\d{4})\.(\d{1,2})\.(\d{1,2})\s*~\s*(\d{4})\.(\d{1,2})\.(\d{1,2})\)")


class QnetError(RuntimeError):
    """큐넷에서 받지 못함(사용자에게 그대로 보여 줄 문장)."""


@dataclass
class Post:
    name: str           # 종목명(목록 칸의 title — 정확한 이름)
    title: str          # "토목기사(2026.1.1~2027.12.31)"
    jm_cd: str          # 큐넷 종목코드
    no: str             # 게시번호
    period_from: str    # YYYY-MM-DD ("" = 제목에 기간 없음)
    period_to: str

    def covers(self, day: str) -> bool:
        return bool(self.period_from) and self.period_from <= day <= self.period_to


def parse_list(page: str) -> list[Post]:
    out = []
    for name, jm, no, title in ROW_RE.findall(page):
        title = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", title))).strip()
        m = PERIOD_RE.search(title)
        f = t = ""
        if m:
            y1, m1, d1, y2, m2, d2 = map(int, m.groups())
            f, t = f"{y1:04d}-{m1:02d}-{d1:02d}", f"{y2:04d}-{m2:02d}-{d2:02d}"
        out.append(Post(html.unescape(name).strip(), title, jm, no, f, t))
    return out


@dataclass
class Choice:
    current: Post | None            # 오늘이 든 기간
    upcoming: Post | None           # 미래 기준이 이미 게시됨("곧 바뀜")
    others: list[Post]              # 같은 이름의 지난 기준


def choose(posts: list[Post], cert_name: str, today: dt.date | None = None) -> Choice:
    """정확한 이름만(부분 일치 검색이라 "토목기사"로 철도토목기사도 나옴), 오늘이 든 기간 = 현행."""
    day = (today or dt.date.today()).isoformat()
    key = re.sub(r"\s+", "", cert_name)
    mine = [p for p in posts if re.sub(r"\s+", "", p.name) == key]
    cur = next((p for p in mine if p.covers(day)), None)
    up = sorted((p for p in mine if p.period_from > day), key=lambda p: p.period_from)
    return Choice(cur, up[0] if up else None, [p for p in mine if p is not cur and (not up or p is not up[0])])


def _ctx() -> ssl.SSLContext:
    return ssl.create_default_context()


def _get(url: str, data: bytes | None = None, timeout: float = 30) -> tuple[bytes, str]:
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(
        {"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"} if data is not None else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ctx()) as r:
            return r.read(), r.headers.get("Content-Type", "")
    except Exception as e:  # noqa: BLE001 — 네트워크·인증서·시간 초과 모두 같은 안내
        raise QnetError(f"큐넷에 접속하지 못했습니다({type(e).__name__}). 인터넷 연결을 확인하거나, 큐넷 출제기준 "
                        "보기 창에서 [저장]한 PDF를 끌어다 놓으세요.") from e


def search(cert_name: str, fetch=_get) -> list[Post]:
    q = urllib.parse.urlencode({"id": "cst00601s01", "gSite": "Q", "gId": "", "page": 1, "schText": cert_name,
                                "schType": "T", "brdId": "Q006", "code": "1202"})
    body, _ = fetch(f"{LIST_URL}?{q}")
    return parse_list(body.decode("utf-8", "replace"))


def report_params(jm_cd: str, no: str) -> dict:
    mrd = ("/rsn [RDS] /rfn [https://www.q-net.or.kr/DataServer/rdagent.jsp] "
           "/rsetcertpdfprop [/ssw/jeus/webapps/report/ReportingServer/WEB-INF/conf/markany.properties] "
           f"/rspeech [2] /rv jmCd[{jm_cd}] mcrtrNo[{no}]  rcgnMthdCd[A] /rstaticrender "
           "/rformcurformat [₩ #,###] /rformnumformat [#,###.###] /rbrowserlocale [ko]")
    return {"opcode": "500", "mrd_path": "HRD_QSC.mrd", "mrd_param": mrd, "export_type": "pdf", "protocol": "file",
            "attachment": "true", "crownix-client": "html5viewer", "html5_uuid": str(uuid.uuid4())}


def download_pdf(post: Post, dest: Path, fetch=_get) -> Path:
    body, ctype = fetch(REPORT_URL, urllib.parse.urlencode(report_params(post.jm_cd, post.no)).encode("utf-8"), 120)
    if not body.startswith(b"%PDF"):
        raise QnetError("큐넷 보기 창이 PDF를 주지 않았습니다(큐넷 화면이 바뀌었을 수 있음). "
                        "보기 창에서 [저장]한 PDF를 끌어다 놓으세요.")
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    return dest


# ───────────────────────── 종목 하나: 받기 → 읽기 → 프로필 저장 ─────────────────────────

@dataclass
class Fetched:
    profile_path: Path
    pdf_path: Path
    post: Post
    upcoming: Post | None
    warnings: list[str]


def cache_dir() -> Path:
    from .standards import user_root
    return user_root().parent / "qnet"


def check_today(cert_name: str, fetch=_get, today: dt.date | None = None) -> Choice:
    """목록 확인(하루 한 번만 큐넷에 물음 — 같은 날 다시 고르면 저장해 둔 결과)."""
    day = (today or dt.date.today()).isoformat()
    p = cache_dir() / "list-cache.json"
    try:
        cache = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        cache = {}
    hit = cache.get(cert_name)
    if hit and hit.get("day") == day:
        posts = [Post(**x) for x in hit["posts"]]
    else:
        posts = search(cert_name, fetch)
        cache[cert_name] = {"day": day, "posts": [asdict(x) for x in posts]}
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    return choose(posts, cert_name, today)


def code_for(cert_name: str, jm_cd: str | None = None) -> str:
    """출제기준 프로필이 없던 종목의 코드: 큐넷 종목코드로 "Q1250"(없으면 이름에서 "U" + 6자리) — 팩 이름(Q1250-2022-1)에 쓰임."""
    if jm_cd:
        return f"Q{jm_cd}"
    import hashlib
    return "U" + hashlib.sha1(re.sub(r"\s+", "", cert_name).encode("utf-8")).hexdigest()[:6].upper()


def save_profile_from_pdf(pdf: Path, code: str, title: str = "", extra: dict | None = None) -> tuple[Path, list[str]]:
    """출제기준 PDF(받았거나 사용자가 끌어다 놓은 것) → 사용자 폴더 프로필. 같은 코드의 기존 프로필을 이어받는다."""
    from . import qnet_standard as Q
    from . import standards as S
    doc = Q.parse(pdf)
    try:
        base = S.load(code)
    except FileNotFoundError:
        base = None
    prof = Q.to_profile(doc, code, base, title or Path(pdf).name)
    if extra:
        prof["source"].update(extra)
    return S.save_user_profile(prof), list(doc.warnings)


def fetch_standard(cert_name: str, code: str | None, fetch=_get, today: dt.date | None = None) -> Fetched:
    """현행 출제기준 PDF를 받아 읽고 사용자 폴더에 프로필로 저장(같은 코드의 기존 프로필 — 과목 표기·별칭 — 이어받음).
    code가 없으면(출제기준 프로필이 없던 종목) 큐넷 종목코드로 만든다."""
    ch = check_today(cert_name, fetch, today)
    if ch.current is None:
        raise QnetError(f"큐넷 출제기준 자료실에서 '{cert_name}'의 현행 출제기준을 찾지 못했습니다"
                        + (f"(다음 기준 {ch.upcoming.title}만 있음)" if ch.upcoming else "") + ".")
    post = ch.current
    code = code or code_for(cert_name, post.jm_cd)
    pdf = download_pdf(post, cache_dir() / f"{code}-{post.jm_cd}-{post.no}.pdf", fetch)
    path, warns = save_profile_from_pdf(pdf, code, f"큐넷 {post.title}", {"qnet": {"jmCd": post.jm_cd, "no": post.no}})
    return Fetched(path, pdf, post, ch.upcoming, warns)


def needs_fetch(code: str | None, today: dt.date | None = None) -> bool:
    """받아야 하나: 프로필이 없거나, 큐넷에서 읽은 적이 없거나(기간 없음), 기간이 지났으면."""
    from . import standards as S
    if not code:
        return True
    try:
        p = S.load(code)
    except FileNotFoundError:
        return True
    day = (today or dt.date.today()).isoformat()
    return not (p.period and p.period["from"] <= day <= p.period["to"])


def main(argv=None):
    import argparse
    import sys
    ap = argparse.ArgumentParser(prog="oneq_prep.qnet", description="큐넷 출제기준 자료실에서 현행 출제기준 PDF를 받아 프로필로 저장")
    ap.add_argument("name", help="정확한 종목명(예: 토목기사, 측량및지형공간정보기사)")
    ap.add_argument("--code", help="프로필 코드(예: CIVIL). 없으면 Q+큐넷 종목코드")
    ap.add_argument("--list", action="store_true", help="목록만 보기(받지 않음)")
    a = ap.parse_args(argv)
    try:
        if a.list:
            for p in search(a.name):
                print(f"{p.name}\t{p.period_from}~{p.period_to}\tjmCd={p.jm_cd} no={p.no}")
            return
        got = fetch_standard(a.name, a.code)
    except QnetError as e:
        sys.exit(str(e))
    print(f"받음: {got.post.title} → {got.pdf_path}\n프로필: {got.profile_path}")
    if got.upcoming:
        print(f"참고: 다음 기준 게시됨 — {got.upcoming.title}")
    for w in got.warnings:
        print(f"! {w}")


if __name__ == "__main__":
    main()
