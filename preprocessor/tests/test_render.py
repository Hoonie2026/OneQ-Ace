import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from oneq_prep.render import remove_highlight  # noqa: E402


def test_remove_highlight_keeps_black_text():
    im = Image.new("RGB", (200, 60), "white")
    d = ImageDraw.Draw(im)
    d.rectangle((10, 10, 120, 50), fill=(255, 255, 80))      # 노란 형광펜
    d.rectangle((30, 25, 90, 35), fill=(0, 0, 0))            # 그 위의 검은 글자
    d.rectangle((140, 10, 190, 50), fill=(120, 255, 120))    # 연두 형광펜
    out, n = remove_highlight(im)
    a = np.asarray(out)
    assert n > 0
    assert (a[15, 15] == 255).all() and (a[30, 160] == 255).all()   # 형광 제거
    assert (a[30, 60] == 0).all()                                   # 글자 유지
