"""PDF 텍스트층에서 문항 경계·과목·보기 번호·정답 표시를 찾는다.

지원 형식(2단계):
  - comcbt 교사용: 2단, "N과목 : 과목명" 머리말, 번호 1→100 연속, 채운 원문자(❶~❹) + 문서 끝 정답표
  - 형광펜 표시형(예: 한솔 경향문제): 2단, 과목마다 번호 1부터 다시, 과목명은 "(과목명)" 제목줄,
    정답은 보기 번호에 겹친 노란 채움 사각형(벡터)
  - 스캔본: 텍스트층이 없으면 `ocr.py`가 만든 글자 좌표를 같은 경로로 처리
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber

# 정답 표시용 채운 원문자(❶~❺)와 일반 원문자(①~⑤)
FILLED = {"❶": 1, "❷": 2, "❸": 3, "❹": 4, "❺": 5}
PLAIN = {"①": 1, "②": 2, "③": 3, "④": 4, "⑤": 5}
PLAIN_OF = {v: k for k, v in PLAIN.items()}
SPACES = {" ", "\xa0", "　"}
DIGITS = set("0123456789")      # str.isdigit()은 원문자(①)도 참이라 쓰지 않는다

LINE_TOL = 2.0          # 같은 줄로 볼 top 차이(pt)
LABEL_GAP = 6.0         # 보기 번호 앞 공백(pt). 이보다 좁으면 지문 속 원문자로 본다
QNUM_RE = re.compile(r"^(\d{1,3})\.(?!\d)")
TITLE_RE = re.compile(r"^\(([^()]{2,40})\)$")     # 형광펜형 과목 제목줄 "(응용역학)"
YELLOW_TOL = 0.12      # 노란 채움(1,1,0)으로 볼 색 허용 오차
MIN_RESTART = 5        # 번호가 1로 돌아가 새 과목으로 볼 최소 직전 번호
SUBJ_RE = re.compile(r"(\d)\s*과목\s*:\s*(.+)$")


@dataclass
class Line:
    page: int
    col: int
    top: float
    bottom: float
    x0: float
    chars: list[dict]

    @property
    def text(self) -> str:
        return "".join(c["text"] for c in self.chars)


@dataclass
class Segment:
    """문항 하나가 차지하는 페이지·단 안의 세로 구간(pt)."""
    page: int
    col: int
    top: float
    bottom: float


@dataclass
class Label:
    """보기 번호 하나. filled=True이면 채운 원문자(❶~❹), highlight=True이면 노란 형광 사각형이 겹친 번호."""
    digit: int
    filled: bool
    page: int
    bbox: tuple[float, float, float, float]   # x0, top, x1, bottom (pt)
    size: float
    highlight: bool = False

    @property
    def marked(self) -> bool:
        return self.filled or self.highlight


@dataclass
class Question:
    no: int
    subject_no: int
    local_no: int = 0                      # 원본 시험지에 찍힌 번호(과목마다 1부터 다시 시작하는 형식 대비)
    segments: list[Segment] = field(default_factory=list)
    lines: list[Line] = field(default_factory=list)
    labels: list[Label] = field(default_factory=list)
    stem_filled: list[Label] = field(default_factory=list)  # 지문 속 채운 원문자(정답 아님)
    inline_answer: int | None = None
    warnings: list[str] = field(default_factory=list)

    def text(self) -> str:
        """검색·유사도용 텍스트. 정답 표시 원문자는 일반 원문자로 바꿔 정답이 새지 않게 한다."""
        out = []
        for ln in self.lines:
            s = "".join(PLAIN_OF.get(FILLED.get(c["text"], 0), c["text"]) for c in ln.chars)
            out.append(re.sub(r"[\s\xa0]+", " ", s).strip())
        return "\n".join(x for x in out if x)


@dataclass
class Layout:
    path: Path
    page_size: tuple[float, float]
    col_split: float
    col_x: list[tuple[float, float]]       # 단별 [x0, x1]
    body: tuple[float, float]              # 본문 영역 top, bottom
    subjects: dict[int, str]
    questions: list[Question]
    answer_table: dict[int, int]
    warnings: list[str]
    barriers: list[tuple[int, int, float]] = field(default_factory=list)  # 과목 머리말(page, col, top)
    bodies: list[tuple[float, float]] = field(default_factory=list)       # 페이지별 본문 영역
    highlights: dict[int, list[tuple[float, float, float, float]]] = field(default_factory=dict)
    numbering: str = "continuous"          # continuous: 1→N 연속 / per-subject: 과목마다 1부터
    ocr: bool = False

    def body_of(self, page: int) -> tuple[float, float]:
        return self.bodies[page] if page < len(self.bodies) else self.body


def _page_lines(page, pi: int, col_split: float, body: tuple[float, float]) -> list[Line]:
    rows: dict[int, list[list[dict]]] = {0: [], 1: []}
    for ch in sorted(page.chars, key=lambda c: (c["top"], c["x0"])):
        if not (body[0] <= ch["top"] and ch["bottom"] <= body[1]):
            continue
        col = 0 if ch["x0"] < col_split else 1
        bucket = rows[col]
        for row in bucket:
            if abs(row[0]["top"] - ch["top"]) <= LINE_TOL:
                row.append(ch)
                break
        else:
            bucket.append([ch])
    lines = []
    for col, bucket in rows.items():
        for row in bucket:
            row.sort(key=lambda c: c["x0"])
            ink = [c for c in row if c["text"] not in SPACES]
            if not ink:
                continue
            lines.append(Line(pi, col, min(c["top"] for c in ink), max(c["bottom"] for c in ink),
                              ink[0]["x0"], row))
    lines.sort(key=lambda l: (l.page, l.col, l.top))
    return lines


def _is_yellow(color) -> bool:
    if not isinstance(color, (tuple, list)) or len(color) != 3:
        return False
    r, g, b = color
    return r >= 1 - YELLOW_TOL and g >= 1 - YELLOW_TOL and b <= YELLOW_TOL


def yellow_boxes(page) -> list[tuple[float, float, float, float]]:
    """형광펜 표시로 쓰인 노란 채움 사각형(x0, top, x1, bottom)."""
    return [(r["x0"], r["top"], r["x1"], r["bottom"]) for r in page.rects
            if r.get("fill") and _is_yellow(r.get("non_stroking_color"))]


def _overlaps(a, b, tol: float = 1.0) -> bool:
    return a[0] < b[2] + tol and a[2] > b[0] - tol and a[1] < b[3] + tol and a[3] > b[1] - tol


def _labels_in_line(line: Line, hl: list | None = None) -> tuple[list[Label], list[Label]]:
    """줄 안의 원문자를 보기 번호(labels)와 지문 속 채운 원문자(stem)로 나눈다."""
    labels, stem = [], []
    prev_ink_x1 = None
    for ch in line.chars:
        t = ch["text"]
        if t in SPACES:
            continue
        if t in FILLED or t in PLAIN:
            is_label = ch.get("ocr_label") or prev_ink_x1 is None or ch["x0"] - prev_ink_x1 >= LABEL_GAP
            bbox = (ch["x0"], ch["top"], ch["x1"], ch["bottom"])
            lab = Label(FILLED.get(t) or PLAIN[t], t in FILLED, line.page, bbox, ch["size"],
                        highlight=any(_overlaps(bbox, h) for h in (hl or [])))
            if is_label:
                labels.append(lab)
            elif lab.filled:
                stem.append(lab)
        prev_ink_x1 = ch["x1"]
    return labels, stem


def parse_answer_table(pdf) -> dict[int, int]:
    """문서 끝의 정답표(번호 10개 행 + 원문자 10개 행)를 읽는다."""
    res: dict[int, int] = {}
    for page in reversed(pdf.pages):
        words = page.extract_words()
        mid = page.width / 2
        rows: list[list[dict]] = []
        # 같은 높이의 왼쪽 단 글자와 섞이지 않도록 단별로 행을 만든다
        for w in sorted(words, key=lambda w: (w["x0"] >= mid, w["top"])):
            for r in rows:
                if abs(r[0]["top"] - w["top"]) <= LINE_TOL and (r[0]["x0"] >= mid) == (w["x0"] >= mid):
                    r.append(w)
                    break
            else:
                rows.append([w])
        for i, r in enumerate(rows):
            r.sort(key=lambda w: w["x0"])
            t = [w["text"] for w in r]
            if len(t) == 10 and all(re.fullmatch(r"[0-9]+", x) for x in t):
                nums = [int(x) for x in t]
                if nums != list(range(nums[0], nums[0] + 10)) or i + 1 >= len(rows):
                    continue
                cells = sorted(rows[i + 1], key=lambda w: w["x0"])
                # 행 아래 원문자를 x 위치로 각 번호 칸에 배정
                for n, head in zip(nums, r):
                    cx = (head["x0"] + head["x1"]) / 2
                    best = None
                    for w in cells:
                        for k, ch in enumerate(w["text"]):
                            if ch in PLAIN or ch in FILLED:
                                # 단어 안 글자 위치 근사
                                wx = w["x0"] + (w["x1"] - w["x0"]) * (k + 0.5) / len(w["text"])
                                d = abs(wx - cx)
                                if best is None or d < best[0]:
                                    best = (d, PLAIN.get(ch) or FILLED[ch])
                    if best and best[0] < 12:
                        res[n] = best[1]
        if res:
            return res
    return res


def _body_of_page(page, fallback: tuple[float, float] | None) -> tuple[float, float]:
    """머리말·꼬리말 가로선(폭 80% 이상 사각형) 사이를 본문으로 본다."""
    W, H = page.width, page.height
    hl = sorted(r["top"] for r in page.rects if r["width"] > W * 0.8 and r["height"] < 6)
    if len(hl) >= 2 and hl[-1] - hl[0] > H * 0.4:
        return (hl[0] + 2, hl[-1] - 2)
    return fallback or (40.0, H - 30)


def _titles(page, pi: int) -> list[tuple[float, str]]:
    """페이지 위쪽의 "(과목명)" 제목줄. 본문 영역 밖에 있을 수 있어 글자 전체에서 찾는다."""
    rows: list[list[dict]] = []
    for ch in sorted(page.chars, key=lambda c: (c["top"], c["x0"])):
        if ch["top"] > page.height * 0.3:
            continue
        for r in rows:
            if abs(r[0]["top"] - ch["top"]) <= LINE_TOL:
                r.append(ch)
                break
        else:
            rows.append([ch])
    out = []
    for r in rows:
        t = "".join(c["text"] for c in sorted(r, key=lambda c: c["x0"]) if c["text"] not in SPACES)
        m = TITLE_RE.match(t)
        if m:
            out.append((min(c["top"] for c in r), re.sub(r"\s+", " ", m.group(1)).strip()))
    return out


def _qnum(ln: Line) -> int | None:
    """줄 맨 앞의 문항번호 "12." — 바로 붙은 숫자(소수 "2.5")는 제외하되, 같은 줄에 멀리 떨어진 숫자(수식 첨자)는 허용."""
    ink = [c for c in ln.chars if c["text"] not in SPACES]
    k = 0
    while k < len(ink) and k < 3 and ink[k]["text"] in DIGITS:
        k += 1
    if k == 0 or k >= len(ink) or ink[k]["text"] != ".":
        return None
    if k + 1 < len(ink) and ink[k + 1]["text"] in DIGITS and ink[k + 1]["x0"] - ink[k]["x1"] < 3:
        return None
    return int("".join(c["text"] for c in ink[:k]))


OCR_QHEAD = re.compile(r"^[0-9OoIl|SB\-,·]{0,4}[.:]")   # "23.", ".", "-.", "2:" 그리고 글자가 붙은 "20.수준"
OCR_SUBJ = re.compile(r"과\s*목\s*[:：;]\s*(.+)$")


def _head_token(ln: Line) -> str:
    out = []
    for c in ln.chars:
        if c["text"] in SPACES:
            if out:
                break
            continue
        out.append(c["text"])
    return "".join(out)


def _scan(all_lines, col_left, titles, hl, expected: int | None, ocr: bool = False):
    """줄 목록에서 문항·과목을 찾는다. expected가 주어지면 마지막 문항 뒤의 정답표·안내문을 잘라 낸다."""
    subjects: dict[int, str] = {}
    questions: list[Question] = []
    cur_subject = 1
    expect_local = 1
    header_mode = False          # "N과목:" 머리말이 있는 형식
    barriers: list[tuple[int, int, float]] = []
    q: Question | None = None
    stop = False
    warnings: list[str] = []
    for ln in all_lines:
        text = ln.text.strip()
        m = SUBJ_RE.search(text.replace("\xa0", " "))
        mo = OCR_SUBJ.search(text) if ocr and "과" in text[:8] else None
        if (m and "과목" in text[:6]) or mo:
            header_mode = True
            if m:
                cur_subject = int(m.group(1))
            else:   # OCR: 과목 번호 숫자를 못 믿으므로 순서로 정한다
                cur_subject = (max(subjects) + 1) if subjects else 1
                m = mo
                subjects[cur_subject] = re.sub(r"\s+", "", mo.group(1)).strip()
                barriers.append((ln.page, ln.col, ln.top))
                q = None
                continue
            subjects[cur_subject] = re.sub(r"\s+", " ", m.group(2)).strip()
            barriers.append((ln.page, ln.col, ln.top))
            q = None
            continue
        first = next((c for c in ln.chars if c["text"] not in SPACES), None)
        n = _qnum(ln)
        at_left = first is not None and abs(first["x0"] - col_left[ln.col]) < (12 if ocr else 3)
        if ocr and at_left and n != expect_local and OCR_QHEAD.match(_head_token(ln)):
            # OCR은 문항번호를 잘못 읽기도 한다("23."→"28.", "1."→"-.") — 매달린 들여쓰기의 첫 줄이면 순서로 번호를 매긴다
            n = expect_local
        mq = n is not None
        restart = (n == 1 and not header_mode and expect_local > MIN_RESTART and questions)
        if mq and at_left and not stop and (n == expect_local or restart):
            if restart:
                cur_subject += 1
                expect_local = 1
            if not header_mode and cur_subject not in subjects:
                t = [name for (pg, name) in titles if pg == ln.page]
                subjects[cur_subject] = t[0] if t else f"{cur_subject}과목"
                if not t:
                    warnings.append(f"{cur_subject}과목: 제목줄 \"(과목명)\"을 찾지 못함")
                if restart:
                    barriers.append((ln.page, ln.col, ln.top - 0.5))
            q = Question(no=len(questions) + 1, subject_no=cur_subject, local_no=n)
            q.segments.append(Segment(ln.page, ln.col, ln.top, ln.bottom))
            questions.append(q)
            expect_local += 1
        elif q is None or stop:
            continue
        else:
            seg = q.segments[-1]
            same = (seg.page, seg.col) == (ln.page, ln.col)
            # 마지막 문항의 보기가 다 나온 뒤 떨어진 줄(정답표·안내문)은 잘라 낸다
            if expected and q.no == expected and len(q.labels) >= 4 and (not same or ln.top - seg.bottom > 20):
                stop = True
                continue
            if not same:
                q.segments.append(Segment(ln.page, ln.col, ln.top, ln.bottom))
        q.lines.append(ln)
        q.segments[-1].bottom = max(q.segments[-1].bottom, ln.bottom)
        labels, stem = _labels_in_line(ln, hl.get(ln.page))
        q.labels += labels
        q.stem_filled += stem
    numbering = "continuous" if header_mode or len(subjects) <= 1 else "per-subject"
    return subjects, questions, barriers, warnings, numbering


def analyze(path: str | Path, expected: int | None = None, ocr_pages=None) -> Layout:
    """expected: 기대 문항 수(없으면 번호 흐름으로 정함). ocr_pages: 스캔본일 때 페이지별 글자 목록(ocr.py)."""
    path = Path(path)
    warnings: list[str] = []
    with pdfplumber.open(path) as pdf:
        pages = list(pdf.pages)
        if ocr_pages is not None:
            for pg, chars in zip(pages, ocr_pages):
                pg._objects = {"char": chars, "rect": [], "line": [], "curve": [], "image": []}
        p0 = pages[0]
        W, H = p0.width, p0.height
        # 단 구분선: 페이지 중앙 근처의 긴 세로선. 없으면 글자 분포로, 그래도 없으면 중앙값
        col_split = W / 2
        for ln in p0.lines:
            if abs(ln["x0"] - ln["x1"]) < 1 and (ln["bottom"] - ln["top"]) > H * 0.5:
                col_split = ln["x0"]
        body0 = _body_of_page(p0, None)
        bodies = [body0] + [_body_of_page(pg, body0) for pg in pages[1:]]
        hl = {pi: yellow_boxes(pg) for pi, pg in enumerate(pages)}
        hl = {k: v for k, v in hl.items() if v}
        titles = [(pi, name) for pi, pg in enumerate(pages) for (_, name) in _titles(pg, pi)]

        all_lines: list[Line] = []
        for pi, page in enumerate(pages):
            all_lines += _page_lines(page, pi, col_split, bodies[pi])

        # 여러 페이지에 되풀이되는 안내문(예: "※ 본 콘텐츠는 …")은 문항이 아니다 → 빼고 크롭 경계로 쓴다
        key = lambda l: re.sub(r"\s+", "", l.text)
        pages_of: dict[str, set[int]] = {}
        for l in all_lines:
            pages_of.setdefault(key(l), set()).add(l.page)
        edge = {}            # 단의 첫 줄·끝 줄
        for l in all_lines:
            edge.setdefault((l.page, l.col), [l, l])[1] = l
        edges = {id(x) for pair in edge.values() for x in pair}
        boiler = [l for l in all_lines if len(pages_of[key(l)]) >= 3 and len(key(l)) >= 8 and _qnum(l) is None
                  and id(l) in edges]
        all_lines = [l for l in all_lines if l not in boiler]
        boiler_barriers = [(l.page, l.col, l.top) for l in boiler]

        col_left = [min((l.x0 for l in all_lines if l.col == c), default=0) for c in (0, 1)]
        # 크롭 폭: 왼쪽 단은 여백 5pt, 오른쪽 단은 구분선 바로 오른쪽부터(두 단 폭을 같게)
        col_x = [(col_left[0] - 5, col_split - 1.5), (col_split + 1.5, W - col_left[0] + 5)]

        if expected is None:
            _, first, _, _, _ = _scan(all_lines, col_left, titles, hl, None, ocr_pages is not None)
            expected = len(first)
        subjects, questions, barriers, w2, numbering = _scan(all_lines, col_left, titles, hl, expected, ocr_pages is not None)
        warnings += w2
        barriers += boiler_barriers
        answer_table = parse_answer_table(pdf) if ocr_pages is None else parse_answer_table_lines(all_lines)

    if len(questions) != expected:
        warnings.append(f"문항 수 {len(questions)}개(기대 {expected})")
    for q in questions:
        if ocr_pages is not None:
            # OCR은 원문자 숫자를 못 믿으므로 문항 안 순서로 1..n을 다시 매긴다(마지막 4개)
            q.labels = q.labels[-4:]
            for k, lab in enumerate(q.labels):
                lab.digit = k + 1
            if len(q.labels) < 4:
                q.warnings.append(f"OCR: 보기 번호 {len(q.labels)}개만 찾음")
        digits = [l.digit for l in q.labels]
        # 지문 속 원문자가 보기 번호로 잡히는 경우: 마지막 1..n 연속열만 보기로 인정
        n = max(digits) if digits else 0
        if digits[-n:] != list(range(1, n + 1)) if n else True:
            q.warnings.append(f"보기 번호 순서 이상: {digits}")
        else:
            extra = q.labels[:-n]
            q.stem_filled += [l for l in extra if l.filled]
            q.labels = q.labels[-n:]
        marked = [l.digit for l in q.labels if l.marked]
        if len(marked) == 1:
            q.inline_answer = marked[0]
        elif len(marked) > 1:
            q.warnings.append(f"정답 표시 {len(marked)}개: {marked}")
        if len(q.segments) > 1:
            q.warnings.append("info:여러 단/페이지에 걸침")
    lay = Layout(path, (W, H), col_split, col_x, body0, subjects, questions, answer_table, warnings, barriers,
                 bodies=bodies, highlights=hl, numbering=numbering, ocr=ocr_pages is not None)
    return lay


def parse_answer_table_lines(lines: list[Line]) -> dict[int, int]:
    """스캔본(OCR) 정답표: "번호 10개 줄" 바로 아래 "원문자 10개 줄"."""
    res: dict[int, int] = {}
    for i, ln in enumerate(lines[:-1]):
        toks = ln.text.split()
        if len(toks) == 10 and all(t.isdigit() for t in toks):
            nums = [int(t) for t in toks]
            if nums != list(range(nums[0], nums[0] + 10)):
                continue
            nxt = [c for c in lines[i + 1].text if c in PLAIN or c in FILLED]
            if len(nxt) == 10:
                for n, c in zip(nums, nxt):
                    res[n] = PLAIN.get(c) or FILLED[c]
    return res
