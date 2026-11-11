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
OCR_SUBJ = re.compile(r"제?\s*(\d?)\s*과\s*목\s*[:：;]\s*(.*)$")   # 과목명을 못 읽으면 빈칸(→ "N과목", pack이 출제기준 순서로)


def _head_token(ln: Line) -> str:
    out = []
    for c in ln.chars:
        if c["text"] in SPACES:
            if out:
                break
            continue
        out.append(c["text"])
    return "".join(out)


def _scan(all_lines, col_left, titles, hl, expected: int | None, ocr: bool = False, left_of=None):
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
        at_left = first is not None and abs(first["x0"] - (left_of(ln) if left_of else col_left[ln.col])) < (12 if ocr else 3)
        if ocr and any(c.get("ocr_digit") for c in [c for c in ln.chars if c["text"] not in SPACES][:3]):
            n, at_left = None, False                # "가." 보기 줄(앞에 잡티 ". 라." 포함)은 문항 머리가 아님
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
        if ocr and at_left and n is not None and expect_local < n <= expect_local + 3 and header_mode and not stop:
            # 앞 문항 머리를 OCR이 못 읽음 → 읽은 번호를 믿고 빠진 번호는 판독 불가로(정답표 번호와 어긋나지 않게)
            missing += [(k, cur_subject) for k in range(expect_local, n)]
            expect_local = n
        elif ocr and at_left and n != expect_local and OCR_QHEAD.match(_head_token(ln)):
            # OCR은 문항번호를 잘못 읽기도 한다("23."→"28.", "1."→"-.") — 매달린 들여쓰기의 첫 줄이면 순서로 번호를 매긴다
            n = expect_local
            guessed = True
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
            # 스캔본(과목 머리말 + 이어지는 번호): 팩 번호 = 시험지 번호(빠진 문항이 있어도 정답표와 맞게)
            q = Question(no=n if ocr and header_mode else len(questions) + 1, subject_no=cur_subject, local_no=n,
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
    if missing:
        warnings.append("스캔본: 문항 머리를 못 읽어 빠진 번호 " + ", ".join(str(k) for k, _ in missing))
    return subjects, questions, barriers, warnings, numbering, missing


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
        if ocr_pages is not None:
            col_split = _ocr_col_split(ocr_pages, W, H)
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
        if ocr_pages is not None:
            # 스캔본 꼬리말("A-9-1-1760" — 쪽마다 달라 되풀이 안내문으로 안 잡힘): 쪽 아래 8% 안의 한글 없는 줄
            foot = [l for l in all_lines if l.top > H * 0.92 and not re.search(r"[가-힣]", l.text)]
            all_lines = [l for l in all_lines if l not in foot]
            boiler_barriers += [(l.page, l.col, l.top) for l in foot]

        col_left = [min((l.x0 for l in all_lines if l.col == c), default=0) for c in (0, 1)]
        if ocr_pages is not None:
            col_left = [_ocr_col_left(all_lines, c, col_left[c]) for c in (0, 1)]
        # 크롭 폭: 왼쪽 단은 여백 5pt, 오른쪽 단은 구분선 바로 오른쪽부터(두 단 폭을 같게)
        col_x = [(col_left[0] - 5, col_split - 1.5), (col_split + 1.5, W - col_left[0] + 5)]
        if ocr_pages is not None:
            # 스캔본은 쪽마다 여백이 달라(종이 위치) 글줄 실제 범위로 — 왼쪽 단 가장 왼쪽 ~ 오른쪽 단 가장 오른쪽
            full = [l for l in all_lines if len(l.text.strip()) >= 5]
            x_lo = min((l.x0 for l in full if l.col == 0), default=col_left[0])
            x_hi = max((max(c["x1"] for c in l.chars) for l in full if l.col == 1), default=W - col_left[0])
            col_x = [(max(0.0, x_lo - 6), col_split - 1.5), (col_split + 1.5, min(W, x_hi + 6))]

        left_of = _ocr_left_model(all_lines, col_left) if ocr_pages is not None else None
        if expected is None:
            _, first, _, _, _, miss0 = _scan(all_lines, col_left, titles, hl, None, ocr_pages is not None, left_of)
            expected = len(first) + len(miss0)
        subjects, questions, barriers, w2, numbering, missing = _scan(all_lines, col_left, titles, hl, expected,
                                                                      ocr_pages is not None, left_of)
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
