"""PDF 텍스트층에서 문항 경계·과목·보기 번호·정답 표시를 찾는다.

1단계 프로토타입: 텍스트층이 있는 2단 레이아웃 기출 PDF(comcbt 교사용 형식)를 대상으로 한다.
2단계에서 레이아웃 판정·OCR 경로를 추가하고 검수 화면과 연결한다.
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

LINE_TOL = 2.0          # 같은 줄로 볼 top 차이(pt)
LABEL_GAP = 6.0         # 보기 번호 앞 공백(pt). 이보다 좁으면 지문 속 원문자로 본다
QNUM_RE = re.compile(r"^(\d{1,3})\.$")
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
    """보기 번호 하나. filled=True이면 정답 표시(채운 원문자)."""
    digit: int
    filled: bool
    page: int
    bbox: tuple[float, float, float, float]   # x0, top, x1, bottom (pt)
    size: float


@dataclass
class Question:
    no: int
    subject_no: int
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


def _labels_in_line(line: Line) -> tuple[list[Label], list[Label]]:
    """줄 안의 원문자를 보기 번호(labels)와 지문 속 채운 원문자(stem)로 나눈다."""
    labels, stem = [], []
    prev_ink_x1 = None
    for ch in line.chars:
        t = ch["text"]
        if t in SPACES:
            continue
        if t in FILLED or t in PLAIN:
            is_label = prev_ink_x1 is None or ch["x0"] - prev_ink_x1 >= LABEL_GAP
            lab = Label(FILLED.get(t) or PLAIN[t], t in FILLED, line.page,
                        (ch["x0"], ch["top"], ch["x1"], ch["bottom"]), ch["size"])
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


def analyze(path: str | Path, expected: int = 100) -> Layout:
    path = Path(path)
    warnings: list[str] = []
    with pdfplumber.open(path) as pdf:
        p0 = pdf.pages[0]
        W, H = p0.width, p0.height
        # 단 구분선: 페이지 중앙 근처의 긴 세로선. 없으면 중앙값
        col_split = W / 2
        for ln in p0.lines:
            if abs(ln["x0"] - ln["x1"]) < 1 and (ln["bottom"] - ln["top"]) > H * 0.5:
                col_split = ln["x0"]
        # 본문 영역: 머리말·꼬리말 가로선 사이
        hlines = sorted(r["top"] for r in p0.rects if r["width"] > W * 0.8)
        body = (hlines[0] + 2, hlines[-1] - 2) if len(hlines) >= 2 else (40.0, H - 30)

        all_lines: list[Line] = []
        for pi, page in enumerate(pdf.pages):
            all_lines += _page_lines(page, pi, col_split, body)

        col_left = [min((l.x0 for l in all_lines if l.col == c), default=0) for c in (0, 1)]
        # 크롭 폭: 왼쪽 단은 여백 5pt, 오른쪽 단은 구분선 바로 오른쪽부터(두 단 폭을 같게)
        col_x = [(col_left[0] - 5, col_split - 1.5), (col_split + 1.5, W - col_left[0] + 5)]

        subjects: dict[int, str] = {}
        questions: list[Question] = []
        cur_subject = 1
        expect_no = 1
        barriers: list[tuple[int, int, float]] = []   # 과목 머리말 위치(page, col, top)
        q: Question | None = None
        stop = False
        for ln in all_lines:
            text = ln.text.strip()
            m = SUBJ_RE.search(text.replace("\xa0", " "))
            if m and "과목" in text[:6]:
                cur_subject = int(m.group(1))
                subjects[cur_subject] = re.sub(r"\s+", " ", m.group(2)).strip()
                barriers.append((ln.page, ln.col, ln.top))
                q = None
                continue
            first = next((c for c in ln.chars if c["text"] not in SPACES), None)
            head = text.split("\xa0")[0].split(" ")[0]
            mq = QNUM_RE.match(head)
            at_left = first is not None and abs(first["x0"] - col_left[ln.col]) < 3
            if mq and at_left and int(mq.group(1)) == expect_no:
                q = Question(no=expect_no, subject_no=cur_subject)
                q.segments.append(Segment(ln.page, ln.col, ln.top, ln.bottom))
                questions.append(q)
                expect_no += 1
            elif q is None or stop:
                continue
            else:
                seg = q.segments[-1]
                same = (seg.page, seg.col) == (ln.page, ln.col)
                # 마지막 문항의 보기가 다 나온 뒤 떨어진 줄(정답표·안내문)은 잘라 낸다
                if q.no == expected and len(q.labels) >= 4 and (not same or ln.top - seg.bottom > 20):
                    stop = True
                    continue
                if not same:
                    q.segments.append(Segment(ln.page, ln.col, ln.top, ln.bottom))
            q.lines.append(ln)
            q.segments[-1].bottom = max(q.segments[-1].bottom, ln.bottom)
            labels, stem = _labels_in_line(ln)
            q.labels += labels
            q.stem_filled += stem

        answer_table = parse_answer_table(pdf)

    if len(questions) != expected:
        warnings.append(f"문항 수 {len(questions)}개(기대 {expected})")
    for q in questions:
        digits = [l.digit for l in q.labels]
        # 지문 속 원문자가 보기 번호로 잡히는 경우: 마지막 1..n 연속열만 보기로 인정
        n = max(digits) if digits else 0
        if digits[-n:] != list(range(1, n + 1)) if n else True:
            q.warnings.append(f"보기 번호 순서 이상: {digits}")
        else:
            extra = q.labels[:-n]
            q.stem_filled += [l for l in extra if l.filled]
            q.labels = q.labels[-n:]
        filled = [l.digit for l in q.labels if l.filled]
        if len(filled) == 1:
            q.inline_answer = filled[0]
        elif len(filled) > 1:
            q.warnings.append(f"정답 표시 {len(filled)}개: {filled}")
        if len(q.segments) > 1:
            q.warnings.append("info:여러 단/페이지에 걸침")
    return Layout(path, (W, H), col_split, col_x, body, subjects, questions, answer_table, warnings, barriers)
