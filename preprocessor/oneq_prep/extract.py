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
    hangul: bool = False                       # 가나다라 보기(스캔본) — 번호를 글자에서 읽음


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
    guessed: bool = False                  # 스캔본: 문항번호를 못 읽어 순서로 매김(뒤에 진짜 번호가 나오면 앞 문항에 합침)
    pen_guess: bool = False                # 빨간 펜 정답을 OCR이 못 읽은 번호 자리로 짐작해 읽음 → '정답 확인 필요'(2026-11-17)
    pen_labels: list = field(default_factory=list)  # 펜 정답을 읽은 보기 번호 자리 — 펜을 지운 뒤 번호를 다시 그림(2026-11-17)

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
    missing: list[tuple[int, int]] = field(default_factory=list)   # 스캔본: 찾지 못한 문항(번호, 과목번호)
    page_cols: dict[int, list[tuple[float, float]]] = field(default_factory=dict)   # 스캔본: 쪽마다 단 범위(종이 위치가 쪽마다 다름)

    def body_of(self, page: int) -> tuple[float, float]:
        return self.bodies[page] if page < len(self.bodies) else self.body

    def col_of(self, page: int, col: int) -> tuple[float, float]:
        """그 쪽의 단 x 범위(쪽마다 따로 잡았으면 그것, 아니면 전체)."""
        cols = self.page_cols.get(page, self.col_x)
        return cols[col] if col < len(cols) else (0.0, self.page_size[0])


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
        if ch.get("ocr_digit"):           # 스캔본 가나다라 보기 번호(ocr.py) — 칠한 표시 없음(손글씨 ✓는 정답 아님)
            labels.append(Label(ch["ocr_digit"], False, line.page, (ch["x0"], ch["top"], ch["x1"], ch["bottom"]), ch["size"],
                                hangul=True))
        elif t in FILLED or t in PLAIN:
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


def _circled_in_line(line: Line, hl: list | None = None) -> list[tuple[Label, bool]]:
    """줄 안의 모든 원문자 (Label, 줄 첫 글자인지). 간격과 상관없이 — 배치로 보기를 고를 때 쓴다."""
    out = []
    first = True
    for ch in line.chars:
        t = ch["text"]
        if t in SPACES:
            continue
        if t in FILLED or t in PLAIN:
            bbox = (ch["x0"], ch["top"], ch["x1"], ch["bottom"])
            out.append((Label(FILLED.get(t) or PLAIN[t], t in FILLED, line.page, bbox, ch["size"],
                              highlight=any(_overlaps(bbox, h) for h in (hl or []))), first))
        first = False
    return out


def _labels_by_layout(q: "Question", hl: dict, n: int = 4) -> list[Label] | None:
    """보기 번호 순서가 어긋난 문항에서, 보기 배치 모양으로 1..n을 다시 고른다(건설안전 기출 ADR 016).

    보기 안 원문자 참조("① ① 1 ② 1❷ ① 1 ② 6")나 앞 글에 붙은 번호("공구② 낙하") 때문에 간격 규칙이 틀리는 경우.
    허용하는 배치: 한 줄에 하나씩(4줄, 같은 x) · 2×2(①②/③④, ①③·②④ 같은 x) · 한 줄에 넷.
    ①·③(또는 모든 줄)은 줄 첫 글자여야 한다. 맞는 조합이 정확히 하나일 때만 쓰고, 정답 표시가 든 조합을 우선한다.
    """
    rows = []
    for ln in q.lines:
        c = _circled_in_line(ln, hl.get(ln.page))
        if c:
            rows.append(c)
    if not rows:
        return None
    TOL = 4.0   # 같은 열로 보는 x 차이(pt). 원문자 폭 ≈ 9pt, 보기 안 참조와는 13pt 이상 떨어짐
    same_x = lambda a, b: abs(a.bbox[0] - b.bbox[0]) <= TOL   # noqa: E731
    found: list[list[Label]] = []
    # 한 줄에 하나씩: 연속한 n줄의 첫 글자 원문자가 1..n
    for i in range(len(rows) - n + 1):
        firsts = [rows[i + k][0] for k in range(n)]
        if all(f[1] and f[0].digit == k + 1 for k, f in enumerate(firsts)) and all(same_x(firsts[0][0], f[0]) for f in firsts):
            found.append([f[0] for f in firsts])
    # 2×2
    if n == 4:
        for i in range(len(rows) - 1):
            a, b = rows[i], rows[i + 1]
            if not (a[0][1] and b[0][1] and a[0][0].digit == 1 and b[0][0].digit == 3 and same_x(a[0][0], b[0][0])):
                continue
            for two in (l for l, _ in a[1:] if l.digit == 2):
                for four in (l for l, _ in b[1:] if l.digit == 4):
                    if same_x(two, four):
                        found.append([a[0][0], two, b[0][0], four])
    # 한 줄에 넷: 첫 글자 ① 뒤로 ②③④가 차례로(가장 멀리 떨어진 것 하나씩은 판단 불가 → 후보가 하나일 때만)
    for r in rows:
        if r[0][1] and r[0][0].digit == 1:
            seqs = [[r[0][0]]]
            for d in range(2, n + 1):
                seqs = [s + [l] for s in seqs for l, _ in r if l.digit == d and l.bbox[0] > s[-1].bbox[0]]
            found += seqs
    if not found:
        return None
    marked = [f for f in found if sum(l.marked for l in f) == 1]
    pick = marked if marked else found
    uniq = {tuple(id(l) for l in f): f for f in pick}
    return next(iter(uniq.values())) if len(uniq) == 1 else None


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


def numbered_mode(header_mode: bool) -> bool:
    """스캔본 번호를 시험지 번호로 쓰는 형식(과목 머리말 + 이어지는 번호)."""
    return header_mode


def _confirmed_ahead(lines: list[Line], i: int, n: int) -> bool:
    """i번 줄의 번호 n이 진짜인지 — 뒤 60줄 안에 n+1 또는 n+2로 시작하는 줄이 n+3·더 큰 번호보다 먼저 나옴."""
    for ln in lines[i + 1:i + 61]:
        m = _qnum(ln)
        if m is None:
            continue
        if m in (n + 1, n + 2):
            return True
        if m > n + 2 or m < n:
            return False
    return False


def _lines_after_stem(q: Question) -> int:
    """문항의 발문 끝('…은?') 줄 뒤에 온 줄 수 — 보기 번호를 OCR이 못 읽어도 보기가 나왔는지 가늠."""
    idx = [i for i, ln in enumerate(q.lines) if re.search(r"[가-힣]\s*\?", ln.text)]
    return len(q.lines) - 1 - idx[0] if idx else 0


def _stem_like(lines: list[Line], i: int) -> bool:
    """i번 줄이 발문 첫 줄처럼 보임 — 한글 8자 이상, 가나다라 보기('가.')가 아니고, 그 줄이나 바로 다음 줄(다른 문항 머리가 아님)에 '?'."""
    ln = lines[i]
    t = ln.text.strip()
    if re.match(r"^[가나다라]\s*[.,]", t) or len(re.findall(r"[가-힣]", t)) < 8:
        return False
    if "?" in t:
        return True
    nx = lines[i + 1] if i + 1 < len(lines) else None
    # 다음 줄이 다른 문항 머리면 그 '?'는 다음 문항 것(2011 법규: 보기 이어지는 줄 '되지 아니한 자'를 머리로 잘못 봄)
    return nx is not None and (nx.page, nx.col) == (ln.page, ln.col) and "?" in nx.text and _qnum(nx) is None


def _prev_is_choice(lines: list[Line], i: int, left: float, hl: dict) -> bool:
    """i번 줄 바로 앞의 글줄(같은 쪽·단, 단 오른쪽 멀리 떨어진 워터마크·쪽 번호는 건너뜀)이 보기 줄인지."""
    ln = lines[i]
    for j in range(i - 1, max(-1, i - 4), -1):
        p = lines[j]
        if (p.page, p.col) != (ln.page, ln.col):
            return False
        if p.x0 > left + 60:
            continue
        return bool(_labels_in_line(p, hl.get(p.page))[0])
    return False


def _qnum(ln: Line) -> int | None:
    """줄 맨 앞의 문항번호 "12." — 바로 붙은 숫자(소수 "2.5")는 제외하되, 같은 줄에 멀리 떨어진 숫자(수식 첨자)는 허용."""
    ink = [c for c in ln.chars if c["text"] not in SPACES]
    # 스캔본: 번호 앞 잡티 한 글자('•12.')는 건너뜀
    if len(ink) > 2 and ink[0].get("ocr") and ink[0]["text"] in "•·'`‘’\"" and ink[1]["text"] in DIGITS:
        ink = ink[1:]
    k = 0
    while k < len(ink) and k < 3 and ink[k]["text"] in DIGITS:
        k += 1
    # 스캔본은 "9,"·"26•"·"59·"도 문항번호(winocr가 마침표를 쉼표·가운뎃점으로 읽음 — 철도토목기사, 2026-11-17)
    if k == 0 or k >= len(ink) or not (ink[k]["text"] == "." or (ink[k]["text"] in ",•·" and ink[k].get("ocr"))):
        return None
    if k + 1 < len(ink) and ink[k + 1]["text"] in DIGITS and ink[k + 1]["x0"] - ink[k]["x1"] < 3:
        return None
    return int("".join(c["text"] for c in ink[:k]))


OCR_QHEAD = re.compile(r"^[0-9OoIl|SB%\-,·]{0,4}[.:,]")   # "23.", ".", "-.", "2:", "9,"(winocr), "%."와 글자가 붙은 "20.수준"
OCR_SUBJ = re.compile(r"^\s*제?\s*(\d?)\s*과\s*목\s*[:：;•·.,]+\s*(.*)$")   # 쌍점을 "•."로 읽기도(winocr). 이름을 못 읽으면 pack이 출제기준 순서로
# "과목"을 엉뚱하게 읽은 머리말("제 3 고수복 : 응용역학" — 철도토목기사 2010, 세션 #22): '제 + 숫자 + 한글 1~3자 + 쌍점 + 한글 이름'만
OCR_SUBJ_LOOSE = re.compile(r"^\s*제\s*(\d)\s*[가-힣]{1,3}\s*[:：;]\s*([가-힣][가-힣\s]{1,20})$")
# 번호 뒤 마침표를 다른 글자로 읽은 머리("41:℃}음", "44+ 길이", "19”다음") 또는 번호 뒤에 숫자가 붙은 머리("21.120m의") —
# 기대 번호와 같을 때만 문항 머리로 본다(세션 #22)
OCR_ODD_HEAD = re.compile(r"^[^\w가-힣]{0,2}(\d{1,3})\s*(?:[:;+”“\"'`]|[.,](?=\d))")


def _head_token(ln: Line) -> str:
    out = []
    for c in ln.chars:
        if c["text"] in SPACES:
            if out:
                break
            continue
        out.append(c["text"])
    return "".join(out)


def _scan(all_lines, col_left, titles, hl, expected: int | None, ocr: bool = False, left_of=None, free: bool = False):
    """줄 목록에서 문항·과목을 찾는다. expected가 주어지면 마지막 문항 뒤의 정답표·안내문을 잘라 낸다.
    left_of(줄) → 그 줄 높이에서 단 왼쪽 끝 x(스캔본: 쪽마다 다른 여백·기울기). 없으면 col_left[단]."""
    subjects: dict[int, str] = {}
    questions: list[Question] = []
    cur_subject = 1
    expect_local = 1
    header_mode = False          # "N과목:" 머리말이 있는 형식
    barriers: list[tuple[int, int, float]] = []
    q: Question | None = None
    stop = False
    warnings: list[str] = []
    missing: list[tuple[int, int]] = []     # 스캔본: 번호가 건너뛴 문항(번호, 과목) — 판독 불가로 뺀다
    # 스캔본: 쪽·단마다 '번호로 시작하는 줄'의 가장 왼쪽 x — 문항번호 줄 위치 모형(left_of)이 들여 쓴 줄에 끌려 어긋나도
    # (철도토목기사 2015 6쪽 오른쪽 단: 모형 337, 실제 번호 310) 번호가 맞는 줄은 문항 머리로 받음
    num_left: dict[tuple[int, int], float] = {}
    if ocr:
        for l in all_lines:
            if _qnum(l) is not None and l.x0 >= col_left[l.col] - 40:
                key = (l.page, l.col)
                num_left[key] = min(num_left.get(key, l.x0), l.x0)
    for li, ln in enumerate(all_lines):
        text = ln.text.strip()
        m = SUBJ_RE.search(text.replace("\xa0", " "))
        mo = OCR_SUBJ.match(text) if ocr and "과" in text[:8] else None
        if ocr and mo is None and not (m and "과목" in text[:6]):
            mo = OCR_SUBJ_LOOSE.match(text)
            # 보기 속 "제4법 : 다지기를 할 부분의 도상은…"(철도토목기사 2021 97번)을 과목 머리말로 잡지 않게 —
            # 숫자가 다음 과목 번호이고 과목명이 짧을 때만(세션 #22 PC 실측에서 찾음)
            if mo and (int(mo.group(1)) != (max(subjects) + 1 if subjects else 1)
                       or len(re.sub(r"\s", "", mo.group(2))) > 10):
                mo = None
        if (m and "과목" in text[:6]) or mo:
            header_mode = True
            if m:
                cur_subject = int(m.group(1))
            else:   # OCR: 과목 번호 숫자를 못 믿으므로 순서로 정한다
                cur_subject = (max(subjects) + 1) if subjects else 1
                m = mo
                name = re.sub(r"\s+", "", mo.group(2)).strip(" .:;|")
                subjects[cur_subject] = name if len(re.findall(r"[가-힣]", name)) >= 2 else f"{cur_subject}과목"
                barriers.append((ln.page, ln.col, ln.top))
                q = None
                continue
            subjects[cur_subject] = re.sub(r"\s+", " ", m.group(2)).strip()
            if ocr and len(re.findall(r"[가-힣]", subjects[cur_subject])) < 2:
                subjects[cur_subject] = f"{cur_subject}과목"      # 과목명을 못 읽음 → pack이 출제기준 순서로
            barriers.append((ln.page, ln.col, ln.top))
            q = None
            continue
        first = next((c for c in ln.chars if c["text"] not in SPACES), None)
        n = _qnum(ln)
        if ocr and n is None and not stop:
            mh = OCR_ODD_HEAD.match(text)
            if mh and int(mh.group(1)) in (expect_local, expect_local + 1) and (expect_local >= 10 or int(mh.group(1)) == expect_local) \
                    and len(re.findall(r"[가-힣]", text[:16])) >= 2:
                n = int(mh.group(1))
            mh = re.match(r"^[^\w가-힣]{0,2}(\d{2,3})[가-힣]\s", text)      # 마침표를 한글로 읽음("50들 단순보의")
            if n is None and mh and expect_local >= 10 and int(mh.group(1)) in (expect_local, expect_local + 1):
                n = int(mh.group(1))
        if ocr and n is not None and expect_local < n <= expect_local + 3 and not stop:
            # 번호를 뒤 번호로 잘못 읽음("41."→"44.") — 뒤따르는 머리가 기대 번호의 다음 번호로 이어지면 이 줄이 기대 번호(철도토목기사 2010, 세션 #22)
            nxt = next((m2 for m2 in (_qnum(l2) for l2 in all_lines[li + 1:li + 61]) if m2 is not None), None)
            if nxt in (expect_local + 1, expect_local + 2) and nxt != n + 1:
                n = expect_local
        at_left = first is not None and abs(first["x0"] - (left_of(ln) if left_of else col_left[ln.col])) < (12 if ocr else 3)
        if ocr and not at_left and first is not None and n is not None and expect_local <= n <= expect_local + 3 \
                and (ln.page, ln.col) in num_left and abs(first["x0"] - num_left[(ln.page, ln.col)]) < 8:
            at_left = True
        # 번호를 한글 아닌 엉뚱한 글자로 읽은 머리('圈.그림과') — '있다. 선로의…'처럼 앞 발문이 이어지는 줄과 구별
        odd_mark = bool(re.match(r"^[^\s가-힣]{1,2}\.\s*[가-힣]", text))
        if ocr and n is None and first is not None and not stop and _stem_like(all_lines, li) \
                and (ln.page, ln.col) in num_left \
                and (q is not None and (len(q.labels) >= 3 or _lines_after_stem(q) >= 2 or odd_mark)
                     and abs(first["x0"] - num_left[(ln.page, ln.col)]) < (5 if not odd_mark else 8)
                     or q is not None and (len(q.labels) >= 4 or _lines_after_stem(q) >= 4)
                     and -5 < first["x0"] - num_left[(ln.page, ln.col)] < 25
                     and not re.match(r"^\S{0,4}\d", text)      # 앞 문항 발문이 이어지는 줄('3%m이었다.')은 숫자로 시작하곤 함
                     and _prev_is_choice(all_lines, li, num_left[(ln.page, ln.col)], hl)):   # 바로 앞 글줄이 보기 줄일 때만
            # 문항번호를 엉뚱한 글자로 읽은 머리줄('67.'→'①', '58.'→'圈.') — 번호 자리(단의 가장 왼쪽 번호 줄 x)에서 시작하고
            # 앞 문항의 보기가 나온 뒤이며 발문처럼 '?'로 끝나면 다음 번호의 머리(철도토목기사 2017, 사용자 2026-11-17)
            n, at_left = expect_local, True
        # 2017년 58번 "圈.그림과…"은 여러 줄 발문에서 물음표까지 유실됐다.
        # 한자와 점, 직전 명시 번호의 위치와 보기, 바로 뒤의 명시 번호를 함께 요구한다.
        if (ocr and not stop and n is None and q and q.no == expect_local - 1 and q.lines
                and _qnum(q.lines[0]) == q.no and _lines_after_stem(q) >= 2
                and (ln.page, ln.col) == (q.lines[0].page, q.lines[0].col)
                and abs(ln.x0 - q.lines[0].x0) < 5 and re.match(r"^[一-鿿]\.\s*[가-힣]", text)
                and len(re.findall(r"[가-힣]", text)) >= 8
                and next((v for row in all_lines[li + 1:li + 61]
                          if (v := _qnum(row)) is not None), None) == expect_local + 1):
            n, at_left = expect_local, True
        if ocr and any(c.get("ocr_digit") for c in [c for c in ln.chars if c["text"] not in SPACES][:3]):
            n, at_left = None, False                # "가." 보기 줄(앞에 잡티 ". 라." 포함)은 문항 머리가 아님
        if ocr and at_left and n != expect_local and expect_local >= 10 and not stop:
            # OCR이 문항번호 앞자리를 빠뜨리거나 잡티로 읽음("13."→"3.", "21."→":1.", "22."→"!2.") — 끝자리가 기대 번호와 같으면
            # 그 번호로(철도토목기사 2018, 사용자 2026-11-17). 끝 한 자리만 맞으면 앞자리가 깨진 것으로 본다
            # 앞 문항 머리를 놓쳤으면 기대 번호가 하나 밀려 있으므로 기대 번호 ~ +3 중 끝자리가 맞는 첫 번호(건너뛴 번호는 아래에서 판독 불가로)
            # 번호 뒤에는 한글 발문이 와야 함 — 지문 속 값('1.258m'·'2.2에')과 구별
            mt = re.match(r"^[^\w가-힣]{0,2}\s*(\d{1,2})\s*[.,]\s*[가-힣(]", text)
            if mt:
                d = mt.group(1)
                k = next((k for k in range(expect_local, expect_local + 4) if len(d) < len(str(k)) and str(k).endswith(d)), None)
                if k is not None:
                    # 2015년 17번의 마지막 보기 "(1,스위치…" 뒤에 실제 18번이 있다.
                    # 끝자리로 번호를 건너뛰기 전에 다음 명시 번호가 기대 번호인지 확인한다.
                    if k == expect_local:
                        n = k
                    else:
                        ahead = [v for row in all_lines[li + 1:li + 61]
                                 if (v := _qnum(row)) is not None]
                        if ahead[:1] != [expect_local]:
                            n = k
                        # 2020년 21번 "2.지 … 것은?" 뒤에 22·23번이 모두 또렷하다.
                        if (q is None and k == expect_local + 1 and ahead[:2] == [k, k + 1]
                                and _stem_like(all_lines, li)):
                            n = expect_local
        if ocr and at_left and n is not None and _qnum(ln) == n and expect_local + 3 < n <= expect_local + 40 and numbered_mode(header_mode) \
                and not stop and _confirmed_ahead(all_lines, li, n):
            # 번호를 순서로 매기다(머리를 놓쳐) 시험지 번호보다 뒤처졌는데, 또렷한 번호 n이 나오고 바로 뒤 문항(n+1·n+2)도 그 흐름이면
            # 시험지 번호로 다시 맞춘다 — 바로 앞의 순서로 매긴 문항들은 n-1, n-2…로 고쳐 매기고 건너뛴 번호만 판독 불가로
            # (철도토목기사 2014: 12번에서 어긋난 뒤 끝까지 한 칸씩 밀림, 사용자 2026-11-17)
            run = []
            for qq in reversed(questions):
                if not qq.guessed:
                    break
                run.append(qq)
            for i2, qq in enumerate(run):
                qq.no = qq.local_no = n - 1 - i2
            first_free = (n - len(run)) if run else n
            missing += [(k, cur_subject) for k in range(expect_local - len(run), first_free) if k >= 1]
            expect_local = n
        guessed = False
        if ocr and at_left and n is not None and expect_local - 3 <= n < expect_local and questions and not stop \
                and len(questions) > expect_local - n and all(x.guessed for x in questions[n - expect_local:]):
            # 진짜 번호가 나왔는데 앞서 순서로 매긴 문항이 그 번호를 차지함 → 그 문항들은 앞 문항의 이어지는 줄이었음
            fake = questions[n - expect_local:]
            del questions[n - expect_local:]
            prev = questions[-1]
            for f in fake:
                for fl in f.lines:
                    prev.lines.append(fl)
                    if (prev.segments[-1].page, prev.segments[-1].col) != (fl.page, fl.col):
                        prev.segments.append(Segment(fl.page, fl.col, fl.top, fl.bottom))
                    prev.segments[-1].bottom = max(prev.segments[-1].bottom, fl.bottom)
                prev.labels += f.labels
                prev.stem_filled += f.stem_filled
            expect_local = n
        # 1과목 머리말을 못 읽어도(header_mode 전) 1과목 번호는 시험지 번호 그대로 — 번호 하나를 놓치면 그 뒤 전부를
        # 순서로 매겨 한 칸씩 밀리던 문제(철도토목기사 2018, 사용자 2026-11-17)
        numbered = header_mode or cur_subject == 1
        if ocr and at_left and n is not None and expect_local < n <= expect_local + 3 and numbered and not stop:
            # 앞 문항 머리를 OCR이 못 읽음 → 읽은 번호를 믿고 빠진 번호는 판독 불가로(정답표 번호와 어긋나지 않게)
            missing += [(k, cur_subject) for k in range(expect_local, n)]
            expect_local = n
        elif ocr and at_left and n != expect_local and OCR_QHEAD.match(_head_token(ln)) \
                and re.match(r"^\S{1,4}\s*[가-힣(]", text) and len(re.findall(r"[가-힣]", text)) >= 6:
            # 순서로 매기는 머리는 발문처럼 보일 때만 — 번호 다음에 한글 발문(지문 속 값 '0.6h,'·'300.310m'·'.songjs.com'은 아님)
            # OCR은 문항번호를 잘못 읽기도 한다("23."→"28.", "1."→"-.") — 매달린 들여쓰기의 첫 줄이면 순서로 번호를 매긴다
            n = expect_local
            guessed = True
        mq = n is not None
        restart = (n == 1 and not header_mode and expect_local > MIN_RESTART and questions)
        # 보충 문서(supplement.py): 시험지 번호 그대로 — 앞 문항 번호보다 크면 이어지지 않아도(17, 18, 39…) 문항 머리
        if free and mq and at_left and not stop and n > (questions[-1].local_no if questions else 0):
            expect_local = n
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
            # 스캔본(과목 머리말 + 이어지는 번호): 팩 번호 = 시험지 번호(빠진 문항이 있어도 정답표와 맞게)
            q = Question(no=n if (ocr and numbered) or free else len(questions) + 1, subject_no=cur_subject, local_no=n,
                         guessed=guessed)
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
            # 보기가 다 나온 뒤 단 왼쪽 끝에서 시작하는 글줄(보기 줄은 들여 씀) = 광고문·정답표 — 간격이 좁아도 끊는다
            if expected and q.no == expected and len(q.labels) >= 4 and at_left and not ocr \
                    and not _labels_in_line(ln, hl.get(ln.page))[0]:
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
    if ocr and missing:
        missing = _recover_missing(questions, missing, hl, left_of)
    if ocr and missing:
        missing = _split_missing(questions, missing, hl)
    if missing:
        warnings.append("스캔본: 문항 머리를 못 읽어 빠진 번호 " + ", ".join(str(k) for k, _ in missing))
    return subjects, questions, barriers, warnings, numbering, missing


def analyze(path: str | Path, expected: int | None = None, ocr_pages=None, free_numbers: bool = False) -> Layout:
    """expected: 기대 문항 수(없으면 번호 흐름으로 정함). ocr_pages: 스캔본일 때 페이지별 글자 목록(ocr.py).
    free_numbers: 보충 문서 — 문항 번호를 적힌 그대로(이어지지 않아도)."""
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
        if free_numbers:
            col_split = W - 1          # 보충 문서는 1단으로 쓰도록 안내(supplement.py) — 2단으로 보면 가운데가 잘림
        page_split: dict[int, float] = {}
        if ocr_pages is not None:
            col_split = _ocr_col_split(ocr_pages, W, H)
            # 스캔본은 쪽마다 종이 위치가 달라 단 구분도 쪽마다(철도토목기사 2009: 2쪽 오른쪽 단이 x 294부터인데 전체로 찾은 구분은
            # 309 → 오른쪽 단 문항번호 '22.'·보기 '가.'가 왼쪽 단으로 가 22~26번이 21번에 붙음, 사용자 2026-11-17)
            for pi, chars in enumerate(ocr_pages):
                if sum(1 for c in chars if c["text"] not in SPACES) >= 300:
                    page_split[pi] = _ocr_col_split([chars], W, H)
        body0 = _body_of_page(p0, None)
        bodies = [body0] + [_body_of_page(pg, body0) for pg in pages[1:]]
        if ocr_pages is not None:
            # 스캔본은 머리말 가로선이 없어 본문을 40pt~H-30으로 잘랐는데, 머리말 없는 쪽은 단 맨 위 문항 머리줄(y 34)·
            # 쪽 맨 아래 마지막 보기 줄이 잘려 문항을 잃었다(철도토목기사 2021 6번·2018 94번, 사용자 2026-11-17 '모든 문항').
            # 머리말·꼬리말은 되풀이 안내문·꼬리말·쪽 머리글 걸러내기(아래, pack.trim_page_junk)로 처리하므로 거의 끝까지 본다
            bodies = [(H * 0.022, H - 10) for _ in pages]
            body0 = bodies[0]
        hl = {pi: yellow_boxes(pg) for pi, pg in enumerate(pages)}
        hl = {k: v for k, v in hl.items() if v}
        titles = [(pi, name) for pi, pg in enumerate(pages) for (_, name) in _titles(pg, pi)]

        all_lines: list[Line] = []
        for pi, page in enumerate(pages):
            split = page_split.get(pi, col_split)
            if ocr_pages is None:
                all_lines += _page_lines(page, pi, split, bodies[pi])
                continue
            # 2018년 36·39번 등은 위쪽 여백에 번호와 발문이 통째로 있다.
            # 여백에서는 번호·한글이 있고 다음 번호 줄과 위치와 끝자리 순서가 맞는 줄만 살린다.
            rows = _page_lines(page, pi, split, (0, bodies[pi][1]))
            for i, row in enumerate(rows):
                if row.top < bodies[pi][0]:
                    num = _qnum(row)
                    if num is None or len(re.findall(r"[가-힣]", row.text)) < 6:
                        continue
                    following = next((r for r in rows[i + 1:] if r.col == row.col
                                      and abs(r.x0 - row.x0) < 12 and _qnum(r) is not None), None)
                    next_num = _qnum(following) if following is not None else None
                    if next_num is None or not (next_num == num + 1 or min(next_num, num) < 10
                                                and (next_num - num) % 10 == 1):
                        continue
                all_lines.append(row)

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
        if ocr_pages is not None:
            # 스캔본 꼬리말("A-9-1-1760" — 쪽마다 달라 되풀이 안내문으로 안 잡힘): 쪽 아래 8% 안의 한글 없는 줄
            foot = [l for l in all_lines if l.top > H * 0.92 and not re.search(r"[가-힣]", l.text)]
            all_lines = [l for l in all_lines if l not in foot]
            boiler_barriers += [(l.page, l.col, l.top) for l in foot]

        page_cols: dict[int, list[tuple[float, float]]] = {}
        col_left = [min((l.x0 for l in all_lines if l.col == c), default=0) for c in (0, 1)]
        if ocr_pages is not None:
            col_left = [_ocr_col_left(all_lines, c, col_left[c]) for c in (0, 1)]
        # 크롭 폭: 왼쪽 단은 여백 5pt, 오른쪽 단은 구분선 바로 오른쪽부터(두 단 폭을 같게)
        col_x = [(col_left[0] - 5, col_split - 1.5), (col_split + 1.5, W - col_left[0] + 5)]
        if free_numbers:
            # 보충 문서(1단): 글상자 폭만큼 — 왼쪽 여백과 같은 오른쪽 여백을 가정(원본 시험지 단 폭과 같게 쓰면 글자 크기도 같게 보임)
            x_hi = max((max(c["x1"] for c in l.chars) for l in all_lines if l.chars), default=W - col_left[0])
            col_x = [(max(0.0, col_left[0] - 5), min(W, max(x_hi, W - col_left[0]) + 5)), (W, W)]
        if ocr_pages is not None:
            # 스캔본은 쪽마다 여백이 달라(종이 위치) 글줄 실제 범위로 — 왼쪽 단 가장 왼쪽 ~ 오른쪽 단 가장 오른쪽
            full = [l for l in all_lines if len(l.text.strip()) >= 5]
            x_lo = min((l.x0 for l in full if l.col == 0), default=col_left[0])
            x_hi = max((max(c["x1"] for c in l.chars) for l in full if l.col == 1), default=W - col_left[0])
            col_x = [(max(0.0, x_lo - 6), col_split - 1.5), (col_split + 1.5, min(W, x_hi + 6))]
            # 쪽마다 단 범위(크롭 폭) — 그 쪽의 구분·글줄 범위로
            for pi, sp in page_split.items():
                fp = [l for l in full if l.page == pi]
                lo_p = min((l.x0 for l in fp if l.col == 0), default=col_x[0][0] + 6)
                hi_p = max((max(c["x1"] for c in l.chars) for l in fp if l.col == 1), default=col_x[1][1] - 6)
                page_cols[pi] = [(max(0.0, lo_p - 6), sp - 1.5), (sp + 1.5, min(W, hi_p + 6))]

        left_of = _ocr_left_model(all_lines, col_left) if ocr_pages is not None else None
        if expected is None:
            _, first, _, _, _, miss0 = _scan(all_lines, col_left, titles, hl, None, ocr_pages is not None, left_of,
                                             free_numbers)
            expected = (first[-1].no if free_numbers and first else len(first) + len(miss0))
        subjects, questions, barriers, w2, numbering, missing = _scan(all_lines, col_left, titles, hl, expected,
                                                                      ocr_pages is not None, left_of, free_numbers)
        warnings += w2
        barriers += boiler_barriers
        answer_table = parse_answer_table(pdf) if ocr_pages is None else parse_answer_table_lines(all_lines)

    if len(questions) + len(missing) != expected:
        warnings.append(f"문항 수 {len(questions)}개(기대 {expected})")
    for q in questions:
        if ocr_pages is not None and any(l.hangul for l in q.labels):
            # 가나다라: 글자가 곧 번호 — 마지막 라에서 거꾸로 다·나·가를 고른다(보기 줄이 "다."로 시작하는 줄바꿈 등은 빠짐)
            q.labels = _hangul_chain([l for l in q.labels if l.hangul])
            if q.labels and len(q.labels) < 4 and (alt := _hangul_chain_layout(q)) is not None:
                q.labels = alt
            if len(q.labels) < 4:
                q.warnings.append(f"OCR: 보기 번호 {len(q.labels)}개만 찾음")
        elif ocr_pages is not None:
            # OCR은 원문자 숫자를 못 믿으므로 문항 안 순서로 1..n을 다시 매긴다(마지막 4개)
            q.labels = q.labels[-4:]
            for k, lab in enumerate(q.labels):
                lab.digit = k + 1
            if len(q.labels) < 4:
                q.warnings.append(f"OCR: 보기 번호 {len(q.labels)}개만 찾음")
        digits = [l.digit for l in q.labels]
        # 지문 속 원문자가 보기 번호로 잡히는 경우: 마지막 1..n 연속열만 보기로 인정
        n = max(digits) if digits else 0
        # 순서가 어긋났거나 4지선다인데 보기가 모자라면(앞 글에 붙은 "…)❹" 등) 배치 모양으로 다시 고른다
        if ((digits[-n:] != list(range(1, n + 1)) if n else True) or n < 4) and ocr_pages is None \
                and (alt := _labels_by_layout(q, hl)) is not None:
            # 간격 규칙으로 고른 보기 번호가 어긋남 → 배치 모양으로 다시 고름. 고르지 않은 채운 원문자는 지문 속 표시
            q.stem_filled = [l for row in q.lines for l, _ in _circled_in_line(row, hl.get(row.page))
                             if l.filled and not any(l.bbox == c.bbox and l.page == c.page for c in alt)]
            q.labels = alt
            digits = [l.digit for l in alt]
            n = len(alt)
            q.warnings.append("info:보기 번호를 배치로 고름")
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
    lay.missing = missing
    lay.page_cols = page_cols
    return lay


def _ocr_col_split(ocr_pages, W: float, H: float) -> float:
    """스캔본 단 구분 x = 가운데(35~65%) 중 글자가 가장 덜 덮는 곳(모든 쪽 합산). 구분선 그림은 OCR 글자가 아니므로
    글자 분포로 찾는다 — 철도보선기사 2010-2 표본은 단 구분이 52~56%라 W/2로 자르면 왼쪽 단 줄 끝이 오른쪽으로 넘어감."""
    step = 2.0
    lo, hi = W * 0.35, W * 0.65
    bins = [0] * int((hi - lo) / step + 1)
    for chars in ocr_pages:
        for c in chars:
            if c["text"] in SPACES or c["top"] < H * 0.05:
                continue
            a, b = max(lo, c["x0"]), min(hi, c["x1"])
            for k in range(int((a - lo) / step), int((b - lo) / step) + 1) if b > a else ():
                bins[k] += 1
    if not any(bins):
        return W / 2
    m = min(bins)
    # 가장 덜 덮는 구간이 여럿이면 가장 긴 연속 구간의 가운데
    runs, s = [], None
    for k, v in enumerate(bins + [m + 1]):
        if v == m and s is None:
            s = k
        elif v != m and s is not None:
            runs.append((k - s, s, k))
            s = None
    _, a, b = max(runs)
    return lo + (a + b) / 2 * step


def _segments_of(lines: list[Line]) -> list[Segment]:
    segs: list[Segment] = []
    for l in lines:
        if segs and (segs[-1].page, segs[-1].col) == (l.page, l.col):
            segs[-1].bottom = max(segs[-1].bottom, l.bottom)
        else:
            segs.append(Segment(l.page, l.col, l.top, l.bottom))
    return segs


def _recover_missing(questions: list[Question], missing: list[tuple[int, int]], hl: dict, left_of=None) -> list[tuple[int, int]]:
    """스캔본: 번호를 못 읽어 빠진 문항(k)을 앞 문항(k-1) 안에서 되찾는다 — 앞 문항의 마지막 보기 "라" 줄 뒤에서
    보기보다 왼쪽으로 내어 쓴 첫 줄이 k번 머리(번호 글자가 깨져도 위치는 남음). 못 찾은 번호만 돌려준다."""
    left = []
    for k, sno in missing:
        prev = next((q for q in questions if q.no == k - 1 and q.subject_no == sno), None)
        cut = None
        if prev is not None:
            lab = [(i, l) for i, ln in enumerate(prev.lines) for l in _labels_in_line(ln, hl.get(ln.page))[0] if l.hangul]
            last4 = next(((i, l) for i, l in lab if l.digit == 4), None)     # 앞 문항 자신의 첫 "라"
            if last4 is not None:
                i4, l4 = last4
                for j in range(i4 + 1, len(prev.lines)):
                    ln = prev.lines[j]
                    head_x = abs(ln.x0 - left_of(ln)) < 14 if left_of else ln.x0 < l4.bbox[0] - 4
                    rest = [l for r in prev.lines[j:] for l in _labels_in_line(r, hl.get(r.page))[0] if l.hangul]
                    # 문항 머리 자리(번호 x)에서 시작하고, 그 뒤에 보기가 둘 이상 있어야 새 문항
                    if head_x and ln.x0 < l4.bbox[0] - 4 and ln.text.strip() and len({l.digit for l in rest}) >= 2:
                        cut = j
                        break
        if cut is None:
            left.append((k, sno))
            continue
        new = Question(no=k, subject_no=sno, local_no=k, guessed=True)
        new.lines, prev.lines = prev.lines[cut:], prev.lines[:cut]
        for q in (prev, new):
            q.segments = _segments_of(q.lines)
            q.labels, q.stem_filled = [], []
            for ln in q.lines:
                a, b = _labels_in_line(ln, hl.get(ln.page))
                q.labels += a
                q.stem_filled += b
        new.warnings.append("스캔본: 문항번호를 못 읽어 위치로 찾음 — 문항 경계 확인")
        questions.insert(questions.index(prev) + 1, new)
    return left


def _split_missing(questions: list[Question], missing: list[tuple[int, int]], hl: dict) -> list[tuple[int, int]]:
    """스캔본: OCR이 문항 머리줄을 통째로 놓친 문항(k)을 앞 문항 안에서 위치로 되찾는다(사용자 2026-11-17 '모든 문항').
    앞 문항(번호가 k보다 작은 가장 가까운 문항)의 줄 가운데 새 문항이 시작하는 곳:
      ① 'k.'(잡티·가운뎃점 포함)으로 시작하는 줄 ② 앞 문항 보기가 다 나온 뒤(①~④ 중 셋 이상) 줄 높이 1.3배 넘는 빈칸 다음 줄
      ③ 앞 문항 보기가 다 나온 뒤 단·쪽이 바뀐 첫 줄 — 그 뒤에 보기가 둘 이상 있어야 함.
    그림은 빈칸(또는 단 맨 위)부터 자르므로 OCR이 놓친 머리줄도 그림에는 들어간다. 못 찾은 번호만 돌려준다."""
    left = []
    for k, sno in sorted(missing):
        prev = max((q for q in questions if q.no < k and q.lines), key=lambda q: q.no, default=None)
        if prev is None or len(prev.lines) < 3:
            left.append((k, sno))
            continue
        lines = prev.lines
        labs = [[l for l in _labels_in_line(ln, hl.get(ln.page))[0]] for ln in lines]
        hs = sorted(ln.bottom - ln.top for ln in lines)
        h = max(6.0, hs[len(hs) // 2])
        cut, kind = None, ""
        for j in range(1, len(lines)):
            if re.match(rf"^[^\w가-힣]{{0,3}}{k}\s*[.,·•+:]", lines[j].text.strip()):
                cut, kind = j, "num"
                break
        if cut is None:
            for j in range(1, len(lines)):
                before = {l.digit for ls in labs[:j] for l in ls}
                after = {l.digit for ls in labs[j:] for l in ls}
                if len(before) < 3 or len(after) < 2 or 4 not in before and len(before) < 4:
                    continue
                a, b = lines[j - 1], lines[j]
                if (a.page, a.col) != (b.page, b.col):
                    cut, kind = j, "col"
                    break
                if b.top - a.bottom > 1.3 * h:
                    cut, kind = j, "gap"
                    break
        if cut is None:
            # ④ Windows OCR은 보기 번호(①)를 거의 못 읽음 → 발문 끝 '?'가 둘이면(앞 문항 것 + 붙은 문항 것) 그 사이에서
            # 가장 큰 빈칸(또는 단·쪽 바뀜) 다음 줄이 붙은 문항의 첫 줄(발문이 여러 줄이어도 빈칸은 보기 뒤에 있음)
            qs = [i for i, ln in enumerate(lines) if "?" in ln.text]
            if len(qs) >= 2 and qs[0] <= 6 and qs[1] >= qs[0] + 2:
                best, gbest = None, 0.0
                for j in range(qs[0] + 2, qs[1] + 1):
                    a, b = lines[j - 1], lines[j]
                    g = 99.0 if (a.page, a.col) != (b.page, b.col) else b.top - a.bottom
                    if g > gbest:
                        best, gbest = j, g
                if best is not None and gbest > 1.0 * h:
                    cut, kind = best, ("col" if gbest == 99.0 else "gap")
        if cut is None:
            left.append((k, sno))
            continue
        new = Question(no=k, subject_no=prev.subject_no, local_no=k, guessed=True)
        new.lines, prev.lines = prev.lines[cut:], prev.lines[:cut]
        for q in (prev, new):
            q.segments = _segments_of(q.lines)
            q.labels, q.stem_filled = [], []
            for ln in q.lines:
                a2, b2 = _labels_in_line(ln, hl.get(ln.page))
                q.labels += a2
                q.stem_filled += b2
        if kind == "gap":                                    # 놓친 머리줄이 빈칸에 있음 — 그림이 거기서 시작하게
            new.segments[0].top = prev.lines[-1].bottom + 2
        elif kind == "col":
            new.segments[0].top = max(0.0, new.segments[0].top - 2.2 * h)
        new.warnings.append("info: 스캔본: 문항번호를 못 읽어 위치로 찾음")
        questions.insert(questions.index(prev) + 1, new)
    return left


def _ocr_left_model(lines: list[Line], col_left: list[float]):
    """스캔본: 쪽·단마다 문항번호 줄의 x를 줄 높이에 대한 직선으로 맞춘다(종이 기울기·쪽마다 다른 여백 — 표본 2쪽은
    위 59pt → 아래 42pt). 머리 후보가 둘 미만인 단은 전체 가운데값(col_left)."""
    pts: dict[tuple[int, int], list[tuple[float, float]]] = {}
    for l in lines:
        first = next((c for c in l.chars if c["text"] not in SPACES), None)
        if first is None or first.get("ocr_digit"):
            continue
        if _qnum(l) is not None or OCR_QHEAD.match(_head_token(l)):
            pts.setdefault((l.page, l.col), []).append((l.top, l.x0))
    fits: dict[tuple[int, int], tuple[float, float]] = {}
    for key, ps in pts.items():
        ps = [p for p in ps if abs(p[1] - col_left[key[1]]) < 120]   # 단 한가운데에서 시작한 쓰레기 줄 빼기
        while len(ps) >= 2:
            n = len(ps)
            my, mx = sum(p[0] for p in ps) / n, sum(p[1] for p in ps) / n
            vy = sum((p[0] - my) ** 2 for p in ps)
            b = sum((p[0] - my) * (p[1] - mx) for p in ps) / vy if vy > 0 else 0.0
            b = max(-0.05, min(0.05, b))           # 기울기 상한(≈3°)
            a = mx - b * my
            res = [abs(p[1] - (a + b * p[0])) for p in ps]
            worst = max(range(n), key=lambda i: res[i])
            if res[worst] <= 8 or n <= 3:
                fits[key] = (a, b)
                break
            ps.pop(worst)                            # 들여 쓴 보기 줄 "1. …"·잘못 읽은 줄
        else:
            if ps:
                fits[key] = (ps[0][1], 0.0)

    def left_of(ln: Line) -> float:
        a, b = fits.get((ln.page, ln.col), (col_left[ln.col], 0.0))
        return a + b * ln.top
    return left_of


def _hangul_chain_layout(q: Question) -> list[Label] | None:
    """가나다라 중 하나를 못 읽었을 때(예: "나." 대신 "Lt."), 보기 배치(2×2 또는 한 줄 하나씩)로 빈 자리를 채울 수 있으면
    채운다 — 자리만 표시(번호 상자). 못 하면 None."""
    have = {l.digit: l for l in q.labels}
    if len(have) != 3:
        return None
    miss = next(d for d in (1, 2, 3, 4) if d not in have)
    # 2×2: 가·다 같은 x, 나·라 같은 x / 가·나 같은 줄, 다·라 같은 줄
    pair_col = {1: 3, 3: 1, 2: 4, 4: 2}
    pair_row = {1: 2, 2: 1, 3: 4, 4: 3}
    c, r = have.get(pair_col[miss]), have.get(pair_row[miss])
    if c is None or r is None:
        return None
    x0, x1 = c.bbox[0], c.bbox[2]
    t, b = r.bbox[1], r.bbox[3]
    fake = Label(miss, False, r.page, (x0, t, x1, b), r.size, hangul=True)
    return sorted(list(have.values()) + [fake], key=lambda l: l.digit)


def _ocr_col_left(lines: list[Line], col: int, fallback: float) -> float:
    """스캔본 단의 왼쪽 끝 = 문항번호 줄("12.")의 x 가운데값. 첫 쪽 머리 표·안내문이 단을 넘나들어
    가장 왼쪽 글자를 기준으로 하면 오른쪽 단 문항을 못 찾는다(철도보선기사 2010-2 표본)."""
    xs = sorted(l.x0 for l in lines if l.col == col and _qnum(l) is not None)
    if len(xs) < 3:
        return fallback
    return xs[len(xs) // 2] - 4


def _hangul_chain(labels: list[Label]) -> list[Label]:
    """가나다라 보기 번호 후보 → 1..4 순서열 하나. 끝에서부터: 마지막 라, 그 앞 마지막 다, …(없는 번호는 건너뜀)."""
    out: list[Label] = []
    i = len(labels) - 1
    for want in (4, 3, 2, 1):
        j = i
        while j >= 0 and labels[j].digit != want:
            j -= 1
        if j >= 0:
            out.insert(0, labels[j])
            i = j - 1
    return out


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
