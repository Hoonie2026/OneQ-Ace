"""OCR 비교 도구(🖥P5) — 점수 계산만(엔진 없이)."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oneq_prep import ocrbench  # noqa: E402

GT = Path(__file__).parent / "fixtures" / "ocr" / "railway-2010-2-gt.json"


def test_gt_file():
    d = json.loads(GT.read_text(encoding="utf-8"))
    assert len(d["answers"]) == 100 and set(d["answers"]) <= set("가나다라")
    assert d["answers"][:10] == "나가나가가나라라가라"      # 1번 정답 나(손글씨 ✓는 가) — 손글씨 표시를 정답으로 쓰면 안 됨
    assert d["answers"][8] == "가"                          # 9번 정답 가(손글씨 ✓는 나)


def test_scores_ignore_order_and_spaces():
    units = ["1. 캔트(cant)에 대한 설명으로 옳지 않은 것은?", "가. 열차속도에 정비례한다."]
    ocr = "가 . 열 차 속 도 에 정비례한다.\n오른쪽 단 글자\n1.캔트(cant)에 대한 설명으로 옳지 않은 것은?"
    s = ocrbench.text_scores(units, ocr)
    assert s["mean"] > 0.97 and s["exact95"] == 1.0
    assert ocrbench.text_scores(units, "전혀 다른 글자")["mean"] < 0.5


def test_answer_score():
    key = "나가다라" * 25
    text = "1 2 3 4\n" + " ".join(key[:50]) + "\n철도보선기사\n" + " ".join(key[50:])
    a = ocrbench.answer_score(key, text)
    assert a["found"] == 100 and a["matched"] == 100 and a["exact_position"] == 100
    assert ocrbench.answer_score(key, " ".join(key[:90]))["matched"] == 90


def test_table_cells_grid():
    """정답표 칸 자르기: 번호 줄(색칠)·답 줄이 번갈아 있는 10열 격자 → 답 줄 칸만 글자가 있으면 그 칸들."""
    from PIL import Image, ImageDraw
    w, h = 640, 200
    im = Image.new("L", (w, h), 255)
    d = ImageDraw.Draw(im)
    for y0, y1 in ((10, 40), (100, 130)):
        d.rectangle((3, y0, w - 4, y1), fill=225)          # 번호 줄(색칠)
    for x in range(3, w, 63):
        d.line((x, 10, x, 190), fill=200, width=2)        # 세로선
    for y in (10, 70, 100, 160, 190):
        d.line((3, y, w - 4, y), fill=200, width=1)
    for i in range(10):
        d.rectangle((3 + i * 63 + 25, 48, 3 + i * 63 + 35, 62), fill=0)    # 답 칸 글자 자리
    cells = ocrbench.table_cells(im)
    assert len(cells) == 10
    assert ocrbench.table_cells(Image.new("L", (300, 300), 255)) == []
