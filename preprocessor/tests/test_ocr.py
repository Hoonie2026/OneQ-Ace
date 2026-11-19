"""B1 스캔본 OCR(ADR 022) — 엔진 없이 도는 단위 시험 + 표본 PDF가 있을 때만 도는 실측."""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oneq_prep import ocr  # noqa: E402
from oneq_prep.extract import Label, _hangul_chain  # noqa: E402

# 실측 표본과 정답 파일은 실제 기출이라 저장소에 두지 않는다(source_pdf/, 커밋 안 함 — 2026-11-18 사용자)
SAMPLE = Path(__file__).resolve().parents[2] / "source_pdf" / "철도보선기사_스캔본.pdf"
GT = SAMPLE.parent / "railway-2010-2-gt.json"


def _w(text, left, top=100, width=None, height=20, line=0):
    return {"text": text, "left": left, "top": top, "width": width or 20 * len(text), "height": height, "line": line}


def test_words_from_winocr_shape_and_scale():
    """winocr.recognize_pil_sync 결과 모양(lines → words → bounding_rect) — 큰 그림을 줄였으면(_k) 원래 크기로."""
    r = {"text": "가. 열차", "_k": 0.5, "lines": [
        {"text": "가. 열차", "words": [{"text": "가.", "bounding_rect": {"x": 10, "y": 20, "width": 15, "height": 10}},
                                     {"text": "열차", "bounding_rect": {"x": 40, "y": 20, "width": 20, "height": 10}}]},
        {"text": "", "words": [{"text": " ", "bounding_rect": {"x": 0, "y": 0, "width": 1, "height": 1}}]}]}
    ws = ocr.words_from_winocr(r)
    assert [w["text"] for w in ws] == ["가.", "열차"]
    assert ws[0]["left"] == 20 and ws[0]["top"] == 40 and ws[0]["width"] == 30 and ws[1]["line"] == ws[0]["line"]


def test_hangul_labels_to_chars():
    """가나다라 보기: 줄 첫 "가." · 넓은 간격 뒤 "나." · 따로 읽힌 "다" + "." · 붙은 "라.일정" — 문장 끝 "한다."는 아님."""
    line = [_w("가.", 0, width=30), _w("일정한", 40), _w("한다.", 116), _w("나.", 300, width=30), _w("병위", 340)]
    cs = ocr.words_to_chars(line, scale=1)
    labs = [(c["text"], c["ocr_digit"]) for c in cs if c.get("ocr_digit")]
    assert labs == [("가", 1), ("나", 2)]
    assert "".join(c["text"] for c in cs) == "가.일정한 한다. 나.병위"
    cs = ocr.words_to_chars([_w("다", 0, width=18, line=1), _w(".", 19, width=4, line=1), _w("극선", 40, line=1)], scale=1)
    assert [c["ocr_digit"] for c in cs if c.get("ocr_digit")] == [3]
    cs = ocr.words_to_chars([_w("라.일정", 0, line=2)], scale=1)
    assert cs[0]["text"] == "라" and cs[0]["ocr_digit"] == 4 and "".join(c["text"] for c in cs) == "라.일정"
    # 같은 줄 낱자 사이(0.2~0.5×높이)는 붙이고, 단어 사이(0.7~1.0×높이)는 띄움
    cs = ocr.words_to_chars([_w("열", 0, width=20, line=3), _w("차", 26, width=20, line=3), _w("속도", 64, line=3)], scale=1)
    assert "".join(c["text"] for c in cs) == "열차 속도"


def test_old_tesseract_rows_still_accepted():
    rows = [{"text": "1.", "left": "0", "top": "0", "width": "20", "height": "20", "block_num": "1", "par_num": "1", "line_num": "1"}]
    assert "".join(c["text"] for c in ocr.words_to_chars(rows, scale=1)) == "1."


def test_hangul_chain_skips_wrapped_da():
    """보기 "라" 줄이 넘어가 다음 줄이 "다."로 시작해도(표본 13번) 가·나·다·라 하나씩."""
    L = lambda d: Label(d, False, 0, (0, 0, 1, 1), 1, hangul=True)  # noqa: E731
    got = _hangul_chain([L(1), L(2), L(3), L(4), L(3)])
    assert [l.digit for l in got] == [1, 2, 3, 4]
    got = _hangul_chain([L(3), L(1), L(2), L(3), L(4)])           # 줄기에 "다."로 시작하는 줄
    assert [l.digit for l in got] == [1, 2, 3, 4]
    assert [l.digit for l in _hangul_chain([L(1), L(3), L(4)])] == [1, 3, 4]


def _grid(rows: int = 2):
    from PIL import Image, ImageDraw
    w, h = 640, 60 * rows + 20
    im = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(im)
    for x in range(3, w, 63):
        d.line((x, 10, x, h - 10), fill=200, width=2)
    for r in range(rows + 1):
        d.line((3, 10 + r * 60, w - 4, 10 + r * 60), fill=200, width=1)
    for r in range(rows):
        for i in range(10):
            d.rectangle((3 + i * 63 + 25, 25 + r * 60, 3 + i * 63 + 35, 45 + r * 60), fill=0)
    return im


def test_answer_rows_skip_number_rows(monkeypatch):
    """번호 줄("41 42 …")을 OCR이 "다 라"로 일부 잘못 읽어도 답 줄로 세지 않음(표본 실측에서 10칸 밀림)."""
    said = iter(["41 42 다 44 45 라 47 48 49 50", "가 나 다 라 가 나 다 라 가 나"])
    monkeypatch.setattr(ocr, "line_text", lambda img, eng: next(said))
    got = ocr.read_answer_rows(_grid(2), "tesseract")
    assert "".join(got) == "가나다라가나다라가나"
    assert ocr.answers_from_letters(got)[4] == 4


def test_answer_rows_confusable_letters(monkeypatch):
    monkeypatch.setattr(ocr, "line_text", lambda img, eng: "카 냐 타 마 가 나 다 라 가 나")
    assert "".join(ocr.read_answer_rows(_grid(1), "tesseract")) == "가나다라가나다라가나"


def test_pick_engine_guidance(monkeypatch):
    """Windows 내장 OCR을 못 쓰면 [설정]에서 한국어 OCR 기능을 추가하는 길을 알려 준다(ADR 022 1절)."""
    monkeypatch.setattr(ocr, "winocr_status", lambda lang="ko": "한국어 OCR 기능 없음")
    monkeypatch.setenv("ONEQ_OCR_ENGINE", "winocr")
    with pytest.raises(ocr.OcrUnavailable) as e:
        ocr.pick_engine()
    assert "언어 옵션" in str(e.value) and "Language.OCR" in str(e.value)
    monkeypatch.setenv("ONEQ_OCR_ENGINE", "")
    monkeypatch.setattr(ocr, "tesseract_path", lambda: (_ for _ in ()).throw(ocr.OcrUnavailable("없음")))
    monkeypatch.setattr(ocr.os, "name", "nt")
    with pytest.raises(ocr.OcrUnavailable) as e:
        ocr.pick_engine()
    assert "언어 옵션" in str(e.value)


@pytest.mark.skipif(ocr.winocr_status("en") is not None, reason="Windows 내장 OCR(영어)이 없는 환경")
def test_winocr_real_call_english():
    """GitHub Windows 빌드 기계에서 winocr 결과 모양이 그대로인지(영어 OCR은 보통 기본 설치)."""
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("arial.ttf", 48)
    except OSError:
        pytest.skip("arial.ttf 없음")
    im = Image.new("L", (900, 120), 255)
    ImageDraw.Draw(im).text((20, 30), "OneQ Ace 2010 TEST", fill=0, font=font)
    ws = ocr.words_from_winocr(ocr._win_result(im, "en"))
    text = " ".join(w["text"] for w in ws)
    assert "TEST" in text and all(w["width"] > 0 and w["height"] > 0 for w in ws)


@pytest.mark.skipif(ocr.winocr_status("ko") is not None, reason="Windows 한국어 OCR 기능이 없는 환경")
def test_winocr_real_call_korean_label():
    from PIL import Image, ImageDraw, ImageFont
    try:
        font = ImageFont.truetype("malgun.ttf", 44)
    except OSError:
        pytest.skip("malgun.ttf 없음")
    im = Image.new("L", (1000, 120), 255)
    ImageDraw.Draw(im).text((20, 30), "가. 열차속도에 정비례한다.", fill=0, font=font)
    cs = ocr.words_to_chars(ocr.page_words(im, "winocr"), scale=1)
    assert cs and cs[0].get("ocr_digit") == 1


def _engine_or_skip():
    try:
        return ocr.pick_engine()
    except ocr.OcrUnavailable:
        pytest.skip("OCR 엔진 없음")


@pytest.mark.skipif(not (SAMPLE.exists() and GT.exists()), reason="스캔본 표본 PDF·정답 파일 없음(source_pdf/, 커밋 안 함)")
def test_scan_sample_pack(tmp_path, monkeypatch):
    """실측: 철도보선기사 2010-2 스캔본(가나다라 보기 · 끝 쪽 웹 캡처 정답표 · 손글씨 ✓).
    찾은 문항의 정답은 모두 정답표와 같아야 하고(번호 어긋남 없음), 손글씨 ✓(1번 가, 9번 나)는 정답이 아님."""
    eng = _engine_or_skip()
    home = tmp_path / "home"
    (home / "standards").mkdir(parents=True)
    (home / "standards" / "RAILTRACK.json").write_text(json.dumps({
        "code": "RAILTRACK", "name": "철도보선기사", "grade": "기사", "version": "시험용",
        "passRule": {"subjectMin": 40, "avgMin": 60},
        "subjects": [{"name": n, "count": 20} for n in ("철도공학", "측량학", "응용역학", "건설재료 및 시공", "철도보선관계법규")],
        "aliases": {}, "excluded": []}, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv("ONEQ_PREP_HOME", str(home))
    from oneq_prep import standards as S
    from oneq_prep.pack import prepare
    pr = prepare(SAMPLE, S.load("RAILTRACK"), tmp_path / "out", log=lambda *a: None)
    key = json.loads(GT.read_text(encoding="utf-8"))["answers"]
    assert pr.pack_id == "RAILTRACK-2010-2"
    assert all(it.answer == "가나다라".index(key[it.no - 1]) + 1 for it in pr.items)
    by_no = {it.no: it for it in pr.items}
    assert by_no.get(1) is None or by_no[1].answer == 2
    assert by_no.get(9) is None or by_no[9].answer == 1
    assert len(pr.items) + len(pr.missing) == 100
    assert len(pr.items) >= (98 if eng == "winocr" else 95)
    assert all("ocr" in it.flags and "needs-review" in it.flags for it in pr.items)


def test_answer_row_partly_read_is_not_skipped(monkeypatch):
    """덜 읽은 답 줄(10칸 중 6글자)을 건너뛰면 뒤 정답이 통째로 밀림(2026-11-11 PC winocr, 62번부터) → 반씩 다시 읽음."""
    calls = {"full": 0}

    def fake(img, eng):
        if img.width / img.height < 10:
            return "가 나 다 라 가"                     # 반쪽(5칸)
        calls["full"] += 1
        return "가 나 다 라 가 나" if calls["full"] <= 3 else "라 라 라 라 라 라 라 라 라 라"   # 1줄은 1·0.5·0.3배 모두 6글자
    monkeypatch.setattr(ocr, "line_text", fake)
    got = ocr.read_answer_rows(_grid(2), "winocr")
    assert len(got) == 20 and "".join(got[10:]) == "라" * 10


def test_ocr_subject_header_variants():
    from oneq_prep.extract import OCR_SUBJ
    assert OCR_SUBJ.match("제 3 과목 •. 으요 하").group(1) == "3"
    assert OCR_SUBJ.match("제 1 과목 : 철도공학").group(2) == "철도공학"
    assert OCR_SUBJ.match("가. 과목 : 이름") is None


def _grid_shaded():
    """번호 줄(바탕 칠) · 답 줄 · 번호 줄 · 답 줄."""
    from PIL import Image, ImageDraw
    w, h = 640, 260
    im = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(im)
    for r in (0, 2):
        d.rectangle((3, 10 + r * 60, w - 4, 70 + r * 60), fill=243)
    for x in range(3, w, 63):
        d.line((x, 10, x, h - 10), fill=200, width=2)
    for r in range(5):
        d.line((3, 10 + r * 60, w - 4, 10 + r * 60), fill=200, width=1)
    for r in range(4):
        for i in range(10):
            d.rectangle((3 + i * 63 + 25, 25 + r * 60, 3 + i * 63 + 35, 45 + r * 60), fill=0)
    return im


def test_answer_rows_shaded_and_empty_reads(monkeypatch):
    """2026-11-11 PC winocr 2차: 번호 줄·답 줄 몇 개를 빈 글로 돌려줌 → 번호 줄은 바탕 칠로 가르고(읽지 않음),
    빈 답 줄은 잘 읽힌 앞 답 줄과 함께 붙여 다시 읽는다. 순서가 밀리지 않아야 함."""
    rows = ocr.table_rows_info(_grid_shaded())
    assert [r.shaded for r in rows] == [True, False, True, False]

    def fake(img, eng):
        if img.info.get("stacked"):                      # 앞 줄과 함께 쌓은 그림(두 줄)
            return "가 나 다 라 가 나 다 라 가 나\n라 라 라 라 라 다 다 다 다 다"
        if img.width / img.height > 10:                  # 줄 하나 통째
            fake.n += 1
            return "가 나 다 라 가 나 다 라 가 나" if fake.n <= 1 else ""
        return ""
    fake.n = 0
    real_stack = ocr._stack

    def stack(top, bottom, gap=60):
        im = real_stack(top, bottom, gap)
        im.info["stacked"] = True
        return im
    monkeypatch.setattr(ocr, "_stack", stack)
    monkeypatch.setattr(ocr, "line_text", fake)
    got = ocr.read_answer_rows(_grid_shaded(), "winocr")
    assert "".join(got) == "가나다라가나다라가나" + "라라라라라다다다다다"
    assert ocr.ANSWER_DEBUG[3]["how"].startswith("앞 줄과 함께")


@pytest.mark.skipif(not (SAMPLE.exists() and GT.exists()), reason="스캔본 표본 PDF·정답 파일 없음(source_pdf/, 커밋 안 함)")
def test_answer_shape_match_leave_one_row_out():
    """정답표 답 줄 하나를 OCR이 통째로 못 읽어도(PC winocr 3차, 61~70번) 같은 표의 나머지 칸을 견본으로 모양 맞춤.
    줄 하나씩 빼고 맞춰 보면 틀린 글자가 없어야 함."""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument(str(SAMPLE))
    try:
        img = ocr._render(pdf[9], 2.0833)
    finally:
        pdf.close()
    key = json.loads(GT.read_text(encoding="utf-8"))["answers"]
    cells = [c for r in ocr.table_rows_info(img) if not r.shaded and len(r.cells) == 10 for c in r.cells]
    assert len(cells) == 100
    ok = bad = 0
    for hold in range(10):
        got = ocr._match_shapes(cells[hold * 10:hold * 10 + 10],
                                [(c, key[i]) for i, c in enumerate(cells) if i // 10 != hold])
        ok += sum(a == b for a, b in zip(got, key[hold * 10:hold * 10 + 10]))
        bad += sum(a not in (b, "?") for a, b in zip(got, key[hold * 10:hold * 10 + 10]))
    assert bad == 0 and ok >= 95


def _fake_scan(tmp_path, cols):
    """빈 A4 PDF 한 쪽 + 단마다 (x, 글줄들) — winocr 글자 사전 모양으로(세션 #22 머리 찾기 시험용)."""
    import pypdfium2 as pdfium
    pdf = pdfium.PdfDocument.new()
    pdf.new_page(595, 842)
    path = tmp_path / "fake.pdf"
    pdf.save(str(path))
    pdf.close()
    chars = []
    for x0, lines in cols:
        top = 60.0
        for t in lines:
            indent = 0 if not t.startswith("  ") else 18
            x = x0 + indent
            for ch in t.strip():
                chars.append({"text": ch, "x0": x, "x1": x + 7.5, "top": top, "bottom": top + 9, "size": 9,
                              "upright": True, "object_type": "char", "ocr": True})
                x += 7.5 if ch != " " else 3.5
            top += 13
    return path, [chars]


def test_ocr_heads_misread_numbers_and_subject_header(tmp_path):
    """철도토목기사 2010(세션 #22): '과목'이 깨진 머리말, 41번을 '•44.'로, 44번을 '44+'로 읽은 OCR — 번호가 밀리지 않아야 함."""
    from oneq_prep.extract import analyze
    def q(head, stem):
        return [f"{head} {stem} 옳은 것은?", "  가. 첫째 보기 나. 둘째 보기", "  다. 셋째 보기 라. 넷째 보기"]
    left = ["        제 1 과목 : 철도공학"] + q("1.", "철도 선로의 구성요소에 대한 설명으로") + q("2.", "궤간 측정 위치에 대한 설명으로") \
        + q("3.", "곡선 구간의 캔트 설정에 대한 설명으로") + q("4.", "도상의 역할에 대한 설명으로") + ["        제 2 고수복 : 측량학"] \
        + q("•8.", "삼각점의 위치 선정에 대한 설명으로") + q("6.", "지형도의 등고선 성질에 대한 설명으로")
    right = q("7.", "도면에서 곡선 부분의 면적을 구하는 방법으로") + q("8+", "수준측량의 오차 처리에 대한 설명으로") \
        + q("9.", "트래버스 측량의 각 오차 배분으로") + q("10.", "노선 측량의 단곡선 설치에 대한 설명으로")
    path, pages = _fake_scan(tmp_path, [(30, left), (310, right)])
    lay = analyze(path, ocr_pages=pages)
    heads = {x.no: x.lines[0].text[:3] for x in lay.questions}
    assert sorted(heads) == list(range(1, 11))
    assert heads[5].startswith("•8") and heads[8].startswith("8+")      # '•8.'은 5번, '8+'는 8번
    assert lay.subjects[2] == "측량학"
    assert not lay.missing


def test_ocr_odd_head_patterns():
    from oneq_prep.extract import OCR_ODD_HEAD, OCR_SUBJ_LOOSE
    assert OCR_SUBJ_LOOSE.match("제 3 고수복 : 응용역학").group(2) == "응용역학"
    assert OCR_SUBJ_LOOSE.match("제 3 장 : 1.5m") is None
    for t, n in (("41:℃}음연속보에서", "41"), ("44+ 길이 20", "44"), ("19”다음 열거하는", "19"), ("21.120m의 측선을", "21")):
        assert OCR_ODD_HEAD.match(t).group(1) == n
    assert OCR_ODD_HEAD.match("가. 첫째 보기") is None


def test_ocr_choice_suffix_before_exact_number(tmp_path):
    from oneq_prep.extract import analyze
    rows = [f"{n}. 시험 문제의 설명으로 옳은 것은?" for n in range(1, 18)]
    rows += ["(1,스위치 타이탬피", "18.다음 설명으로 옳은 것은?", "19.다음 조건은?"]
    path, pages = _fake_scan(tmp_path, [(30, rows)])
    qs = analyze(path, ocr_pages=pages).questions
    assert [q.no for q in qs] == list(range(1, 20))
    assert qs[16].lines[-1].text.startswith("(1,")


def test_ocr_suffix_after_subject_before_full_numbers(tmp_path):
    from oneq_prep.extract import analyze
    rows = ["제 1 과목 : 기본"] + [f"{n}. 시험 문항" for n in range(1, 21)]
    rows += ["제 2 과목 : 실무", "2.지 이용되지 않는 것은?", "22.다음 측량 방법은?", "23.다음 계측 방법은?"]
    path, pages = _fake_scan(tmp_path, [(30, rows)])
    qs = analyze(path, ocr_pages=pages).questions
    assert [(q.no, q.lines[0].text.split(".")[0], q.subject_no) for q in qs[-3:]] == [
        (21, "2", 2), (22, "22", 2), (23, "23", 2)]


def test_ocr_cjk_head_bracketed_by_numbers(tmp_path):
    from oneq_prep.extract import analyze
    rows = ["1.하중이 작용할 때 변위는?", "  10 mm", "  15 mm",
            "圈.그림과 같은 직육면체의 윗면에", "  전단력을 가한 경우", "  탄성계수는",
            "3.다음 설명은?"]
    path, pages = _fake_scan(tmp_path, [(30, rows)])
    qs = analyze(path, ocr_pages=pages).questions
    assert [(q.no, q.lines[0].text[:2]) for q in qs] == [(1, "1."), (2, "圈."), (3, "3.")]


def test_ocr_top_margin_numbered_stem(tmp_path):
    from oneq_prep.extract import analyze
    rows = ["1.시험 안내문에 적힌 유의사항", "1.하중의 방향을 바꾸는 방법은?", "2.다음 설명은?"]
    path, pages = _fake_scan(tmp_path, [(30, rows)])
    for ch in pages[0]:
        ch["top"] -= 59
        ch["bottom"] -= 59
    qs = analyze(path, ocr_pages=pages).questions
    assert [q.lines[0].text for q in qs] == rows[1:]


def test_ocr_choice_like_subject_header_is_not_subject(tmp_path):
    """철도토목기사 2021 97번 보기 '제4법 : 다지기를 할 부분의 도상은 지장이'는 과목 머리말이 아님(세션 #22)."""
    from oneq_prep.extract import analyze
    rows = ["        제 1 과목 : 철도공학", "1.다음 중 도상 다지기 방법으로 옳은 것은?", "  제1법 : 인접 침목 쪽에 긁어 올린다",
            "  제4법 : 다지기를 할 부분의 도상은 지장이", "  없는 한 긁어낸다", "2.다음 설명으로 옳은 것은?"]
    path, pages = _fake_scan(tmp_path, [(30, rows)])
    lay = analyze(path, ocr_pages=pages)
    assert lay.subjects == {1: "철도공학"}
    assert [q.subject_no for q in lay.questions] == [1, 1]
