"""B1 스캔본 OCR(ADR 022) — 엔진 없이 도는 단위 시험 + 표본 PDF가 있을 때만 도는 실측."""
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oneq_prep import ocr  # noqa: E402
from oneq_prep.extract import Label, _hangul_chain  # noqa: E402

GT = Path(__file__).parent / "fixtures" / "ocr" / "railway-2010-2-gt.json"
SAMPLE = Path(__file__).resolve().parents[2] / "source_pdf" / "철도보선기사_스캔본.pdf"


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


@pytest.mark.skipif(not SAMPLE.exists(), reason="스캔본 표본 PDF 없음(source_pdf/, 커밋 안 함)")
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


@pytest.mark.skipif(not SAMPLE.exists(), reason="스캔본 표본 PDF 없음(source_pdf/, 커밋 안 함)")
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
