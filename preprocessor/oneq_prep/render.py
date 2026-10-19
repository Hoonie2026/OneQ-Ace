"""페이지 렌더링, 정답 표시 제거, 문항 이미지 크롭.

정답 표시 제거 방식(마스킹):
  A. 채운 원문자(❶~❹)  — 텍스트층에서 위치를 알 수 있으므로, 그 자리를 흰색으로 지우고
     같은 페이지(없으면 다른 페이지)의 같은 번호 일반 원문자(①~④) 픽셀을 그대로 옮겨 붙인다.
     원본과 같은 글꼴·크기의 글자가 들어가므로 흔적이 남지 않는다.
  B. 형광펜 표시(벡터) — PDF 객체 단계에서 노란 채움 사각형만 지우고 렌더링한다(`render_pages(..., strip_yellow=True)`).
     스캔본의 래스터 형광은 보기 번호 상자 주변의 채도 높은 픽셀만 흰색으로 `remove_highlight()`
  C. 보기에 표시가 없는 PDF — 마스킹 없이 정답표에서 정답만 읽는다.
마스킹 뒤에는 `mark_leaks()`로 보기 번호 자리에 채운 원문자 흔적이 남았는지 픽셀로 다시 검사한다.
"""
from __future__ import annotations

from dataclasses import dataclass

import ctypes

import numpy as np
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_c
from PIL import Image

from .extract import Label, Layout, Question

SCALE = 4.0            # 72dpi × 4 = 288dpi. 단 폭 약 275pt → 약 1100px
OUT_WIDTH = 1080       # 개발기준서 D6
GAP_PX = 16            # 단·페이지를 넘는 문항을 이어 붙일 때 간격
NEXT_MARGIN = 7.0      # 다음 경계 위로 띄우는 여백(pt). 다음 문항의 윗줄표(AB̅)·과목 머리말 상자 테두리가 끼지 않게.
                       # 34회차 실측: 문항 사이 글자 간격 최소 14.5pt
INK = 160              # 이 값보다 어두우면 잉크로 본다(0~255)
FILLED_RATIO = 0.42    # 보기 번호 상자 안 잉크 비율이 이보다 크면 채운 원문자로 판정


@dataclass
class Region:
    page: int
    col: int
    top: float
    bottom: float


def _strip_yellow(page) -> int:
    """노란 채움(255,255,0) 작은 사각형 경로 객체를 지운다. 지운 개수를 돌려준다."""
    gone = []
    for o in page.get_objects(max_depth=1):
        if o.type != pdfium_c.FPDF_PAGEOBJ_PATH:
            continue
        r, g, b, a = (ctypes.c_uint() for _ in range(4))
        if not pdfium_c.FPDFPageObj_GetFillColor(o.raw, r, g, b, a):
            continue
        if r.value >= 225 and g.value >= 225 and b.value <= 30:
            x0, y0, x1, y1 = o.get_bounds()
            if (x1 - x0) < 40 and (y1 - y0) < 60:      # 보기 번호 크기의 표시만(그림 속 노란 면 보호)
                gone.append(o)
    for o in gone:
        page.remove_obj(o)
    if gone:
        page.gen_content()
    for o in gone:
        o.close()          # 페이지에서 떼어 낸 객체는 호출자가 닫는다(pypdfium2)
    return len(gone)


def render_pages(path, scale: float = SCALE, strip_yellow: bool = False) -> list[Image.Image] | tuple[list[Image.Image], int]:
    """페이지를 렌더링한다. strip_yellow=True이면 (이미지들, 지운 형광 표시 수)를 돌려준다."""
    pdf = pdfium.PdfDocument(str(path))
    try:
        out, removed = [], 0
        for i in range(len(pdf)):
            page = pdf[i]
            # pdfplumber 좌표는 mediabox 기준 → cropbox가 다른 PDF(한솔 경향문제)도 같은 좌표로 그리도록 맞춘다
            page.set_cropbox(*page.get_mediabox())
            if strip_yellow:
                removed += _strip_yellow(page)
            out.append(page.render(scale=scale, grayscale=False).to_pil().convert("RGB"))
        return (out, removed) if strip_yellow else out
    finally:
        pdf.close()


def _px(b, scale=SCALE):
    return tuple(int(round(v * scale)) for v in b)


def ink_ratio(img: Image.Image, bbox_pt, scale=SCALE) -> float:
    x0, t, x1, b = _px(bbox_pt, scale)
    a = np.asarray(img.crop((x0, t, x1, b)).convert("L"))
    return float((a < INK).mean()) if a.size else 0.0


def mask_filled_labels(pages: list[Image.Image], layout: Layout, scale: float = SCALE) -> int:
    """보기 번호 위치의 채운 원문자를 같은 번호 일반 원문자로 바꿔 그린다. 바꾼 개수를 돌려준다."""
    # 번호별 일반 원문자 견본(페이지 우선)
    plain: dict[tuple[int, int], Label] = {}
    any_plain: dict[int, Label] = {}
    for q in layout.questions:
        for lab in q.labels:
            if not lab.filled:
                plain.setdefault((lab.page, lab.digit), lab)
                any_plain.setdefault(lab.digit, lab)
    n = 0
    for q in layout.questions:
        for lab in q.labels:
            if not lab.filled:
                continue
            src = plain.get((lab.page, lab.digit)) or any_plain.get(lab.digit)
            if src is None:
                raise RuntimeError(f"{q.no}번: 견본으로 쓸 일반 원문자 {lab.digit}가 문서에 없음")
            sx0, st, sx1, sb = _px(src.bbox, scale)
            patch = pages[src.page].crop((sx0, st, sx1, sb))
            img = pages[lab.page]
            x0, t, x1, b = lab.bbox
            pad = 0.8
            wx0, wt, wx1, wb = _px((x0 - pad, t - pad, x1 + pad, b + pad), scale)
            img.paste((255, 255, 255), (wx0, wt, wx1, wb))
            cx, cy = (x0 + x1) / 2 * scale, (t + b) / 2 * scale
            img.paste(patch, (int(round(cx - patch.width / 2)), int(round(cy - patch.height / 2))))
            n += 1
    return n


def remove_highlight(img: Image.Image, sat_min: float = 0.25, val_min: float = 0.55) -> tuple[Image.Image, int]:
    """형광펜처럼 채도 높고 밝은 픽셀을 흰색으로 바꾼다. 바뀐 픽셀 수를 함께 돌려준다."""
    hsv = np.asarray(img.convert("HSV")).astype(np.float32) / 255.0
    m = (hsv[..., 1] >= sat_min) & (hsv[..., 2] >= val_min)
    a = np.asarray(img).copy()
    a[m] = 255
    return Image.fromarray(a), int(m.sum())


def _label_font(px: int):
    from PIL import ImageFont
    for name in ("malgun.ttf", "C:/Windows/Fonts/malgun.ttf", "NotoSansCJK-Regular.ttc",
                 "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, px)
        except OSError:
            continue
    return ImageFont.load_default()


def mask_ocr_filled(pages: list[Image.Image], layout: Layout, scale: float = SCALE) -> int:
    """스캔본: 진하게 칠한 보기 번호(잉크 비율 > FILLED_RATIO)를 찾아 정답으로 기록하고,
    그 자리를 지운 뒤 글꼴로 일반 원문자를 다시 그린다. 지운 개수."""
    from PIL import ImageDraw
    n = 0
    for q in layout.questions:
        filled = [lab for lab in q.labels if ink_ratio(pages[lab.page], lab.bbox, scale) > FILLED_RATIO]
        for lab in filled:
            lab.filled = True
        if len(filled) == 1 and q.inline_answer is None:
            q.inline_answer = filled[0].digit
        for lab in filled:
            img = pages[lab.page]
            x0, t, x1, b = _px(lab.bbox, scale)
            img.paste((255, 255, 255), (x0 - 2, t - 2, x1 + 2, b + 2))
            h = b - t
            ImageDraw.Draw(img).text(((x0 + x1) / 2, (t + b) / 2), "①②③④⑤"[lab.digit - 1],
                                     fill=(0, 0, 0), font=_label_font(int(h * 0.95)), anchor="mm")
            n += 1
    return n


def remove_highlight_near_labels(pages: list[Image.Image], layout: Layout, scale: float = SCALE) -> int:
    """스캔본: 보기 번호 주변(번호 상자 ± 여백)에서만 채도 높은 픽셀을 지운다. 지운 상자 수."""
    n = 0
    for q in layout.questions:
        for lab in q.labels:
            x0, t, x1, b = lab.bbox
            box = _px((x0 - 3, t - 3, x1 + 3, b + 3), scale)
            img = pages[lab.page]
            patch, k = remove_highlight(img.crop(box))
            if k:
                img.paste(patch, box[:2])
                n += 1
    return n


def yellow_ratio(img: Image.Image, bbox_pt, scale=SCALE) -> float:
    x0, t, x1, b = _px((bbox_pt[0] - 2, bbox_pt[1] - 2, bbox_pt[2] + 2, bbox_pt[3] + 2), scale)
    hsv = np.asarray(img.crop((x0, t, x1, b)).convert("HSV")).astype(np.float32) / 255.0
    if not hsv.size:
        return 0.0
    return float(((hsv[..., 1] >= 0.25) & (hsv[..., 2] >= 0.55)).mean())


def regions_for(layout: Layout) -> dict[int, list[Region]]:
    """문항별 크롭 구간. 문항 시작 줄부터 다음 문항(또는 과목 머리말·단 끝) 직전까지."""
    # 단마다 '경계' 목록: 문항 시작 위치와 과목 머리말 위치
    starts: dict[tuple[int, int], list[float]] = {}
    for q in layout.questions:
        s = q.segments[0]
        starts.setdefault((s.page, s.col), []).append(s.top)
    for (p, c, t) in layout.barriers:
        starts.setdefault((p, c), []).append(t)
    for v in starts.values():
        v.sort()

    def next_start(page, col, after):
        for t in starts.get((page, col), []):
            if t > after + 1:
                return t
        return None

    out: dict[int, list[Region]] = {}
    last_no = layout.questions[-1].no if layout.questions else 0
    for q in layout.questions:
        regs = []
        for i, s in enumerate(q.segments):
            top_body, bot_body = layout.body_of(s.page)
            top = s.top - 3 if i == 0 else top_body
            if i < len(q.segments) - 1:
                nb = next_start(s.page, s.col, s.top)
                bottom = (nb - NEXT_MARGIN) if nb else bot_body
            elif q.no == last_no:
                bottom = s.bottom + 4          # 마지막 문항 뒤 정답표·안내문 제외
            else:
                nb = next_start(s.page, s.col, s.top)
                bottom = (nb - NEXT_MARGIN) if nb else bot_body
            if i > 0:
                # 이어지는 단 위쪽에 다른 경계(과목 머리말 등)가 있으면 그 아래부터
                prev = [t for t in starts.get((s.page, s.col), []) if t < s.top - 1]
                if prev:
                    top = max(top, prev[-1])
            regs.append(Region(s.page, s.col, top, bottom))
        out[q.no] = regs
    return out


def _trim_rows(a: np.ndarray, pad: int = 10) -> tuple[int, int]:
    rows = np.where((a < INK).any(axis=1))[0]
    if rows.size == 0:
        return 0, 0
    return max(0, rows[0] - pad), min(a.shape[0], rows[-1] + 1 + pad)


def crop_question(pages: list[Image.Image], layout: Layout, regs: list[Region], scale: float = SCALE) -> Image.Image:
    parts = []
    for r in regs:
        x0, x1 = layout.col_x[r.col]
        box = _px((x0, r.top, x1, r.bottom), scale)
        im = pages[r.page].crop(box)
        a = np.asarray(im.convert("L"))
        t, b = _trim_rows(a)
        if b > t:
            parts.append(im.crop((0, t, im.width, b)))
    w = max(p.width for p in parts)
    h = sum(p.height for p in parts) + GAP_PX * (len(parts) - 1)
    canvas = Image.new("RGB", (w, h), (255, 255, 255))
    y = 0
    for p in parts:
        canvas.paste(p, (0, y))
        y += p.height + GAP_PX
    if canvas.width != OUT_WIDTH:
        canvas = canvas.resize((OUT_WIDTH, round(canvas.height * OUT_WIDTH / canvas.width)), Image.LANCZOS)
    return canvas


def mark_leaks(pages: list[Image.Image], q: Question, scale: float = SCALE) -> list[int]:
    """마스킹 후 보기 번호 자리에 아직 정답 표시(채운 원문자·형광 색)가 보이는지 픽셀로 검사."""
    return [lab.digit for lab in q.labels
            if ink_ratio(pages[lab.page], lab.bbox, scale) > FILLED_RATIO
            or yellow_ratio(pages[lab.page], lab.bbox, scale) > 0.05]
