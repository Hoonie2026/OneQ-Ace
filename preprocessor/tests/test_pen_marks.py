"""스캔본 색깔 펜 정답 표시·과목 개편·파일 이름 연도(사용자 2026-11-17 — 철도토목기사 스캔본)."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep.extract import Label, Layout, Line, Question, Segment  # noqa: E402
from oneq_prep.render import SCALE, complete_labels, red_ink_answers, red_mask, remove_red_ink  # noqa: E402


def _q(labels, no=1):
    q = Question(no, 1, segments=[Segment(0, 0, 90, 200)])
    q.labels = labels
    return q


def _lab(d, x, y, page=0):
    return Label(d, False, page, (x, y, x + 9, y + 10), 10)


def test_complete_labels_reorders_misread_digits():
    """OCR이 넷 다 '①'로 읽어도 자리(2×2)로 1~4."""
    q = _q([_lab(1, 45, 319), _lab(1, 163, 319), _lab(1, 45, 332), _lab(1, 163, 332)])
    got = {l.digit: (l.bbox[0], l.bbox[1]) for l in complete_labels(q)}
    assert got == {1: (45, 319), 2: (163, 319), 3: (45, 332), 4: (163, 332)}


def test_complete_labels_fills_missing_in_grid_and_row():
    q = _q([_lab(1, 45, 100), _lab(2, 160, 100), _lab(3, 45, 120)])
    got = {l.digit: (round(l.bbox[0]), round(l.bbox[1])) for l in complete_labels(q)}
    assert got[4] == (160, 120)                                    # 2×2: ④ = ③의 행, ②의 열
    q = _q([_lab(1, 40, 100), _lab(2, 100, 100), _lab(4, 220, 100)])
    got = {l.digit: round(l.bbox[0]) for l in complete_labels(q)}
    assert got[3] == 160                                           # 한 줄에 넷: 간격으로


def test_red_and_blue_pen_answer_then_erased():
    """빨간 ✓(번호에서 위로 삐침)·파란 ○(번호를 감쌈)가 가리키는 보기를 정답으로, 그림에서는 지움. 검정 인쇄는 그대로."""
    W, H = int(400 * SCALE), int(300 * SCALE)
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)
    labs = [_lab(k + 1, 50, 120 + 18 * k) for k in range(4)]
    for lab in labs:                                                # 인쇄된 번호(검정)
        x0, t, x1, b = (v * SCALE for v in lab.bbox)
        d.ellipse((x0, t, x1, b), outline=(0, 0, 0), width=4)
    s = SCALE                                                       # ③에 빨간 ✓
    d.line(((50 * s, 161 * s), (54 * s, 166 * s), (66 * s, 150 * s)), fill=(220, 60, 70), width=7)
    lay = Layout(Path("x.pdf"), (400, 300), 200, [(30, 200), (200, 380)], (60, 290), {1: "철도공학"}, [], {}, [])
    q = _q(labs)
    q.lines = [Line(0, 0, 120 + 18 * k, 130 + 18 * k, 50, [{"x0": 50, "text": "①"}]) for k in range(4)]
    lay.questions = [q]
    pages = [img]
    assert red_ink_answers(pages, lay) == 1 and q.inline_answer == 3 and not q.pen_guess
    q2 = _q(labs, 2)
    q2.lines = q.lines
    img2 = img.copy()
    ImageDraw.Draw(img2).rectangle((0, 0, W, H), fill="white")
    for lab in labs:
        x0, t, x1, b = (v * SCALE for v in lab.bbox)
        ImageDraw.Draw(img2).ellipse((x0, t, x1, b), outline=(0, 0, 0), width=4)
    x0, t, x1, b = (v * SCALE for v in labs[0].bbox)              # ①에 파란 ○
    ImageDraw.Draw(img2).ellipse((x0 - 14, t - 14, x1 + 14, b + 14), outline=(40, 70, 210), width=6)
    lay.questions = [q2]
    assert red_ink_answers([img2], lay) == 1 and q2.inline_answer == 1
    pages = [img2]
    remove_red_ink(pages)
    a = np.asarray(pages[0])
    assert not red_mask(a).any() and (a.min(axis=2) < 60).any()     # 펜 자국만 지워지고 검정 인쇄는 남음


def test_subject_dropped_and_unread_by_order(tmp_path, monkeypatch):
    """옛 5과목(건설재료 및 시공 포함) → 현행 4과목: 빠진 과목은 빼고, 이름을 못 읽은 과목은 앞뒤 과목 사이로."""
    from oneq_prep import standards as S
    prof = S.Profile.__new__(S.Profile)
    prof.subjects = [{"name": n, "count": 20} for n in ("철도공학", "측량학", "응용역학", "철도보선관계법규")]
    assert prof.guess("건설재료 및 시공", 4, 5, set()) is None              # 과목 수가 다르면 순서로 맞추지 않음
    assert prof.guess("철도보선관계 법 규", 5, 5, set())[0] == "철도보선관계법규"


def test_year_from_filename_when_content_has_none(tmp_path):
    from oneq_prep import examinfo
    info = examinfo.ExamInfo()
    prof = type("P", (), {"code": "Q1760"})()
    exam, info = examinfo.exam_of(tmp_path / "2016년 철도토목기사 필기.pdf", prof, tmp_path, info=info)
    assert (exam["year"], exam["round"], exam.get("dateUnknown")) == (2016, 1, True)
    assert any("파일 이름" in e for e in info.evidence)


def test_ocr_cache_roundtrip(tmp_path, monkeypatch):
    """스캔본 OCR 결과를 %APPDATA%\\OneQ-Ace\\logs\\ocr에 남기고 다시 씀(PC 결과로 원인 짚기, 2026-11-17)."""
    monkeypatch.setenv("ONEQ_PREP_HOME", str(tmp_path / "home"))
    from oneq_prep.ocr import OcrDoc, load_ocr, ocr_cache_path, save_ocr
    pdf = tmp_path / "2016년 철도토목기사 필기.pdf"
    pdf.write_bytes(b"%PDF-1.4 x")
    assert load_ocr(pdf) is None
    doc = OcrDoc([[{"text": "①", "x0": 1.0}], []], "winocr", {3: 2}, [1], 0, 0, "철도토목기사")
    save_ocr(doc, pdf)
    assert ocr_cache_path(pdf).exists() and "logs" in str(ocr_cache_path(pdf))
    got = load_ocr(pdf)
    assert got == doc


def test_subjects_by_number_when_header_missed():
    """과목 머리말(응용역학)을 놓쳐 측량학이 36문항이 된 스캔본(철도토목기사 2010) → 읽은 번호·문항 수로 나눔."""
    from oneq_prep import standards as S
    from oneq_prep.pack import _garbled, _subjects_by_number
    prof = S.Profile.__new__(S.Profile)
    prof.subjects = [{"name": n, "count": 20} for n in ("철도공학", "측량학", "응용역학", "철도보선관계법규")]
    subj = {1: "철도공학", 2: "측량학", 4: "건설재료 및 시공", 5: "철도보선관계법규"}
    # 21~43번은 번호를 읽고 41번은 놓침, 44~56번은 번호를 짐작(실제로는 응용역학)
    qs = [Question(no=n, subject_no=1 if n <= 20 else 2 if n <= 56 else 4 if n <= 73 else 5, guessed=n >= 44)
          for n in range(1, 93) if n != 41]
    lay = Layout(Path("x.pdf"), (595, 842), 297, [], (0, 842), dict(subj), qs, {}, [], ocr=True)
    notes: list[str] = []
    _subjects_by_number(lay, prof, notes)
    assert lay.subjects == {1: "철도공학", 2: "측량학", 3: "3과목", 4: "건설재료 및 시공", 5: "철도보선관계법규"}
    by = {q.no: q.subject_no for q in qs}
    assert (by[40], by[42], by[56], by[57]) == (2, 3, 3, 4) and notes
    # 번호를 하나도 못 읽어도 한 과목이 20문항을 넘으면 다음 과목으로
    qs = [Question(no=n, subject_no=1 if n <= 20 else 2 if n <= 50 else 4, guessed=n > 20) for n in range(1, 71)]
    lay = Layout(Path("x.pdf"), (595, 842), 297, [], (0, 842), {1: "a", 2: "b", 4: "d"}, qs, {}, [], ocr=True)
    _subjects_by_number(lay, prof, [])
    assert [q.subject_no for q in qs if q.no in (40, 41, 50, 51)] == [2, 3, 3, 4]
    assert _garbled("진-1=(二。고그呑卜") and not _garbled("응욕역확")


def _choice_page(n_q: int, marked: dict[int, int]):
    """보기 넷이 한 줄에 하나씩인 문항 n_q개 — marked{문항 번호: 검은 ✓를 그은 보기}."""
    s = SCALE
    img = Image.new("RGB", (int(300 * s), int((40 + 80 * n_q) * s)), "white")
    d = ImageDraw.Draw(img)
    qs = []
    for i in range(n_q):
        top = 30 + 80 * i
        q = Question(i + 1, 1, segments=[Segment(0, 0, top, top + 75)])
        q.lines = [Line(0, 0, top, top + 10, 30, [{"x0": 30, "x1": 200, "text": "1.문항"}])]
        d.rectangle((30 * s, (top + 2) * s, 200 * s, (top + 8) * s), fill=(0, 0, 0))     # 지문(검은 띠)
        for k in range(4):
            t = top + 15 + 14 * k
            q.lines.append(Line(0, 0, t, t + 10, 50, [{"x0": 50, "x1": 150, "text": "①보기"}]))
            d.ellipse((50.5 * s, (t + 0.5) * s, 59.5 * s, (t + 9.5) * s), outline=(0, 0, 0), width=4)
            d.rectangle((64 * s, (t + 3) * s, 140 * s, (t + 7) * s), fill=(0, 0, 0))     # 보기 글(검은 띠)
            if marked.get(i + 1) == k + 1:                                                # 검은 ✓(번호에서 위로)
                d.line(((49 * s, (t + 4) * s), (53 * s, (t + 9) * s), (60 * s, (t - 5) * s)), fill=(20, 20, 20), width=5)
        qs.append(q)
    lay = Layout(Path("x.pdf"), (300, 40 + 80 * n_q), 300, [(0, 300)], (0, 40 + 80 * n_q), {1: "a"}, qs, {}, [], ocr=True)
    return [img], lay


def test_black_pen_check_marks():
    """검은 펜 ✓(철도토목기사 2019): 번호 둘레 잉크가 같은 번호의 가운뎃값보다 많은 보기 → 정답(확인 필요), 그림에서는 번호를 새로 그림."""
    from oneq_prep.render import choice_positions, pen_mark_answers
    marked = {i: (i % 4) + 1 for i in range(1, 15)}
    pages, lay = _choice_page(14, marked)
    g = {0: np.asarray(pages[0].convert("L"))}
    assert [l.digit for l in choice_positions(lay.questions[0], g)] == [1, 2, 3, 4]
    assert pen_mark_answers(pages, lay) == 14
    assert {q.no: q.inline_answer for q in lay.questions} == marked and all(q.pen_guess for q in lay.questions)
    # 표시가 없는 시험지에서는 아무것도 고르지 않는다
    pages, lay = _choice_page(14, {})
    assert pen_mark_answers(pages, lay) == 0 and all(q.inline_answer is None for q in lay.questions)


def test_merged_next_question_is_excluded():
    """스캔본에서 다음 문항 번호를 못 읽어 두 문항이 붙으면(철도토목기사 2022 8·9번) 뒤 문항 정답이 앞 문항 것이 됨 → 뺌."""
    from oneq_prep.pack import merged_next

    def ln(top, text, x0=345):
        return Line(0, 1, top, top + 11, x0, [{"x0": x0, "text": text}])
    q = Question(8, 1)
    q.lines = [ln(383, "8.전향설비 중 병행되어"), ln(395, "타선으로 전환시키는 설비는?"), ln(426, "①전차대 델타선"), ln(437, "루프선 ④ 전차대"),
               ln(465, "해당하지 않는 것은?"), ln(495, "①선단포인트 승월 포인트"), ln(506, "③가동 포인트 스프링 포인트")]
    assert merged_next(q)
    q2 = Question(8, 1)                                                    # 붙지 않은 문항(그림이 지문과 보기 사이)
    q2.lines = [ln(383, "8.그림과 같은 구조물의"), ln(395, "힘의 크기는?"), ln(440, "① ① ① 100"), ln(470, "①100kN ②125kN"),
                ln(482, "③150kN ④200kN")]
    assert not merged_next(q2)
    q3 = Question(8, 1)
    q3.lines = [ln(383, "8.다음 중 옳은 것은?"), ln(395, "① 가나다"), ln(407, "9.다음 문항", 340)]
    assert merged_next(q3)


def test_page_junk_trimmed_and_odd_next_number():
    """스캔본: 문항 구간에 끼어 든 쪽 머리글('국가기술자격'·'A-9-4-17')은 그 위에서 자르고, '44+'·'27•'도 다음 문항 번호로 봄."""
    from oneq_prep.pack import merged_next, trim_page_junk
    from oneq_prep.render import Region

    def ln(top, text, x0=40):
        return Line(0, 0, top, top + 11, x0, [{"x0": x0, "text": text}])
    q = Question(82, 4)
    q.lines = [ln(100, "89. 고속철도의 분기기"), ln(115, "가. 기울기 구간은"), ln(160, "국가기술자격"), ln(175, "2013년도 기사2회")]
    lay = Layout(Path("x.pdf"), (595, 842), 297, [], (0, 842), {4: "a"}, [q], {}, [], ocr=True)
    regions = {82: [Region(0, 0, 97, 300)]}
    assert trim_page_junk(lay, regions) == 1 and regions[82][0].bottom == 158
    q2 = Question(43, 3)
    q2.lines = [ln(100, "43. 단면과 길이가"), ln(130, "가. 12t 나. 24t"), ln(150, "44+ 길이 20cm, 단면", 42)]
    assert merged_next(q2)
