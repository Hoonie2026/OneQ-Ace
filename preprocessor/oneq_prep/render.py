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

import math

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
                # 문서에 같은 번호 일반 원문자가 하나도 없음(보충 문서에 문항이 하나뿐이고 그 번호가 정답 — 실기기 2026-11-18,
                # 2011년 보충 50번 ❷) → 글꼴로 그린다. 크기는 다른 일반 원문자가 있으면 그 높이, 없으면 채운 원문자 높이
                from PIL import ImageDraw
                img = pages[lab.page]
                x0, t, x1, b = lab.bbox
                ref = next(iter(any_plain.values()), None)
                h = ((ref.bbox[3] - ref.bbox[1]) if ref else (b - t)) * scale
                wx0, wt, wx1, wb = _px((x0 - 0.8, t - 0.8, x1 + 0.8, b + 0.8), scale)
                img.paste((255, 255, 255), (wx0, wt, wx1, wb))
                ImageDraw.Draw(img).text(((x0 + x1) / 2 * scale, (t + b) / 2 * scale), "①②③④⑤"[lab.digit - 1],
                                         fill=(0, 0, 0), font=_fit_font("①②③④⑤"[lab.digit - 1], h), anchor="mm")
                n += 1
                continue
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


def _fit_font(ch: str, px: float):
    """원문자의 원 지름이 px가 되는 글꼴 — 글꼴마다 원이 글자 칸에서 차지하는 비율이 다름."""
    f = _label_font(100)
    try:
        x0, y0, x1, y1 = f.getbbox(ch)
        k = max(1, y1 - y0) / 100
    except Exception:
        k = 0.8
    return _label_font(max(8, int(px / k)))


def mask_ocr_filled(pages: list[Image.Image], layout: Layout, scale: float = SCALE) -> int:
    """스캔본: 진하게 칠한 보기 번호(잉크 비율 > FILLED_RATIO)를 찾아 정답으로 기록하고,
    그 자리를 지운 뒤 글꼴로 일반 원문자를 다시 그린다. 지운 개수."""
    from PIL import ImageDraw
    n = 0
    for q in layout.questions:
        if q.pen_labels:
            continue                                        # 펜 정답 문항은 redraw_pen_labels가 번호를 이미 다시 그림
        # 가나다라 보기(hangul)는 칠해 표시하는 형식이 아님 — 손글씨 ✓가 번호에 겹쳐도 정답으로 쓰지 않는다(ADR 022 4절)
        filled = [lab for lab in q.labels if not lab.hangul and ink_ratio(pages[lab.page], lab.bbox, scale) > FILLED_RATIO]
        for lab in filled:
            lab.filled = True
        if filled and layout.ocr:
            # 스캔본: 칠한 번호 하나만 글꼴로 바꾸면 크기·모양이 달라 정답이 보임 → 넷 다 같은 크기로 다시 그림.
            # 보기 번호 자리를 동그라미로 확인하지 못하면 '칠한 번호'도 믿지 않음 — Windows OCR은 m²의 ²·그림 속 숫자를
            # 원문자로 읽기도 함(철도토목기사 2016 35번). 정답으로 쓰지 않고 그리지도 않음(→ 정답 못 찾음으로 빠짐)
            if _redraw_question(pages, complete_labels(q), {}, scale):
                if len(filled) == 1 and q.inline_answer is None:
                    q.inline_answer = filled[0].digit
                n += len(filled)
            continue
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
            # 스캔본은 이어지는 단·쪽도 그 단의 첫 글줄부터(본문 영역을 거의 끝까지 보므로 쪽 머리글·앞 쪽 꼬리말이 끼지 않게)
            top = s.top - 3 if i == 0 or layout.ocr else top_body
            if i < len(q.segments) - 1:
                nb = next_start(s.page, s.col, s.top)
                bottom = (nb - NEXT_MARGIN) if nb else bot_body
            elif q.no == last_no:
                bottom = s.bottom + 4          # 마지막 문항 뒤 정답표·안내문 제외
            else:
                nb = next_start(s.page, s.col, s.top)
                bottom = (nb - NEXT_MARGIN) if nb else bot_body
                if layout.ocr and s.bottom > s.top:
                    # 스캔본: 다음 문항 머리를 못 읽으면 단 끝까지 잘려 다음 문항·쪽 머리글이 붙음(철도토목기사) →
                    # 이 문항의 마지막 글줄(보기)에서 끊음. 보기는 그림 아래에 오므로 그림은 잘리지 않음
                    bottom = min(bottom, s.bottom + 16)            # OCR이 마지막 보기 줄을 놓쳐도 한 줄쯤은 담기게
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
        x0, x1 = layout.col_of(r.page, r.col)
        box = _px((x0, r.top, x1, r.bottom), scale)
        if box[3] <= box[1] + 2:                 # 스캔본에서 다음 문항 머리를 잘못 읽어 구간이 뒤집힌 경우 — 건너뜀(2008 철도토목기사)
            continue
        im = pages[r.page].crop(box)
        a = np.asarray(im.convert("L"))
        t, b = _trim_rows(a)
        if b > t:
            parts.append(im.crop((0, t, im.width, b)))
    if not parts:
        return Image.new("RGB", (OUT_WIDTH, 40), (255, 255, 255))
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


# ───────── 색깔 펜 정답 표시(스캔본) — 사용자 2026-11-17: 철도토목기사 스캔본은 정답에 빨간·파란 펜으로 ✓·○를 그림 ─────────
RED_DIFF = 40            # 색깔 펜 = 가장 센 색과 가장 약한 색의 차(채도)가 이만큼 넘고(검정·회색 인쇄·워터마크는 채도가 낮음)
RED_MIN_R = 90           # 가장 센 색이 이 이상(너무 어두운 얼룩 제외)
RED_ERASE_DIFF = 24      # 지울 때는 더 넓게(번진 가장자리까지)


def red_mask(arr: np.ndarray, diff: int = RED_DIFF) -> np.ndarray:
    """색깔 펜 자국(빨강·파랑·초록 등 채도 높은 픽셀). 이름은 처음 빨간 펜에서 왔음."""
    a = arr.astype(np.int16)
    hi, lo = a.max(axis=2), a.min(axis=2)
    return (hi - lo > diff) & (hi > RED_MIN_R)


def _rows_of(labs: list[Label]) -> list[list[Label]]:
    h = max(1.0, sorted(l.bbox[3] - l.bbox[1] for l in labs)[len(labs) // 2])
    rows: list[list[Label]] = []
    for l in sorted(labs, key=lambda l: (l.page, l.bbox[1])):
        if rows and rows[-1][0].page == l.page and abs(rows[-1][0].bbox[1] - l.bbox[1]) < 0.6 * h:
            rows[-1].append(l)
        else:
            rows.append([l])
    return [sorted(r, key=lambda l: l.bbox[0]) for r in rows]


def complete_labels(q: Question) -> list[Label]:
    """스캔본 OCR이 보기 번호(①~④)를 일부 못 읽거나 잘못 읽었을 때(예: 넷 다 '①'), 번호 자리로 1~4를 다시 정한다(빨간 펜 판독용).
    번호 자리가 넷이면 읽는 순서(행 → 왼쪽부터)로 1~4. 셋 이하이면 읽은 번호의 배치로 빠진 자리를 짐작:
    한 줄에 하나씩(같은 x — 그 x에서 시작하는 줄 순서), 2×2(같은 행·같은 열), 한 줄에 넷(같은 y, 간격)."""
    cand = [l for l in q.labels if 1 <= l.digit <= 5]          # 가나다라 보기도(파란 펜 ○ — 2008 철도토목기사)
    uniq: list[Label] = []
    for l in cand:                                                  # 같은 자리 중복 제거
        if all(o.page != l.page or abs(o.bbox[0] - l.bbox[0]) > 3 or abs(o.bbox[1] - l.bbox[1]) > 3 for o in uniq):
            uniq.append(l)
    if len(uniq) == 4:
        order = [l for r in _rows_of(uniq) for l in r]
        return [Label(i, l.filled, l.page, l.bbox, l.size, l.highlight) for i, l in enumerate(order, 1)]
    labs = {}
    for lab in uniq:
        if 1 <= lab.digit <= 4:
            labs.setdefault(lab.digit, lab)
    if len(labs) < 2 or len(labs) == 4:
        return list(labs.values())
    any_lab = next(iter(labs.values()))
    h = any_lab.bbox[3] - any_lab.bbox[1]
    w = any_lab.bbox[2] - any_lab.bbox[0]
    mk = lambda d, x, t, page: Label(d, False, page, (x, t, x + w, t + h), any_lab.size)  # noqa: E731
    xs = [l.bbox[0] for l in labs.values()]
    ys = [l.bbox[1] for l in labs.values()]
    out = dict(labs)
    if max(ys) - min(ys) < 0.6 * h:                                   # 한 줄에 넷
        ks = sorted(labs)
        step = (labs[ks[-1]].bbox[0] - labs[ks[0]].bbox[0]) / max(ks[-1] - ks[0], 1)
        if step > 2 * w:
            for d in range(1, 5):
                if d not in out:
                    out[d] = mk(d, labs[ks[0]].bbox[0] + (d - ks[0]) * step, labs[ks[0]].bbox[1], labs[ks[0]].page)
    elif max(xs) - min(xs) < 4:                                       # 한 줄에 하나씩
        x = min(xs)
        starts = sorted((ln for ln in q.lines if ln.chars and abs(ln.chars[0]["x0"] - x) < 4 and ln.top >= min(ys) - 3 * h),
                        key=lambda ln: (ln.page, ln.col, ln.top))
        if len(starts) == 4 and all(labs[d].page == starts[d - 1].page and abs(labs[d].bbox[1] - starts[d - 1].top) < h
                                    for d in labs):
            for d in range(1, 5):
                if d not in out:
                    out[d] = mk(d, x, starts[d - 1].top, starts[d - 1].page)
    else:                                                             # 2×2: ①② / ③④
        pairs = {1: 2, 2: 1, 3: 4, 4: 3}
        cols = {1: 3, 3: 1, 2: 4, 4: 2}
        for d in range(1, 5):
            if d not in out and pairs[d] in labs and cols[d] in labs:
                out[d] = mk(d, labs[cols[d]].bbox[0], labs[pairs[d]].bbox[1], labs[pairs[d]].page)
    return list(out.values())


def _ink_cols(gray: np.ndarray) -> np.ndarray:
    return (gray < INK).any(axis=0)


_ANG = [(math.cos(2 * math.pi * k / 36), math.sin(2 * math.pi * k / 36)) for k in range(36)]
RING_STRONG, RING_WEAK = 0.80, 0.45
RING_PICK_MIN, RING_MEAN = 0.5, 0.7
RING_REDRAW = 0.7                      # 번호를 다시 그릴 자리로 믿는 동그라미


def _ring_score(g: np.ndarray, x0: float, top: float, h: float, scale: float, wide: bool = False) -> tuple[float, tuple]:
    """번호 자리(x0, top, 높이 h — pt)에 동그라미(①~④의 원)가 있는지: 원 둘레 36점 중 잉크가 닿는 비율의 최댓값과 그 원(pt 상자).
    본문 첫 글자는 0.2~0.35, 깨끗한 ①~④는 0.85 이상, 펜이 덧칠된 번호는 0.55~0.7(철도토목기사 2019 스캔본)."""
    hp = h * scale
    pad = int(0.7 * hp) + 2
    X0, Y0 = int(x0 * scale - 0.5 * hp) - pad, int(top * scale - (0.4 * hp if wide else 0)) - pad
    X1, Y1 = int(x0 * scale + 0.9 * hp) + pad, int(top * scale + (1.4 if wide else 1.0) * hp) + pad
    sub = g[max(0, Y0):max(0, Y1), max(0, X0):max(0, X1)] < INK
    if sub.size == 0:
        return 0.0, (x0, top, x0 + 0.8 * h, top + h)
    d = sub.copy()                                     # 3×3로 불림 — 원 둘레가 1~2픽셀 어긋나도 닿게
    d[1:] |= sub[:-1]
    d[:-1] |= sub[1:]
    e = d.copy()
    e[:, 1:] |= d[:, :-1]
    e[:, :-1] |= d[:, 1:]
    ox, oy = max(0, X0), max(0, Y0)
    cxs = x0 * scale + np.linspace(-0.5 * hp, 0.9 * hp, 11) - ox    # OCR이 ①을 빠뜨리면 줄 시작 x가 번호 오른쪽
    cys = top * scale + (np.linspace(-0.2 * hp, 1.2 * hp, 11) if wide else np.linspace(0.2 * hp, 0.8 * hp, 6)) - oy
    rs = np.array([0.36, 0.42, 0.48, 0.54]) * hp
    cs, sn = np.array([c for c, _ in _ANG]), np.array([v for _, v in _ANG])
    CX, CY, R = np.meshgrid(cxs, cys, rs, indexing="ij")
    xs = (CX[..., None] + R[..., None] * cs).astype(int)
    ys = (CY[..., None] + R[..., None] * sn).astype(int)
    ok = (xs >= 0) & (xs < e.shape[1]) & (ys >= 0) & (ys < e.shape[0])
    hit = np.zeros(xs.shape, bool)
    hit[ok] = e[ys[ok], xs[ok]]
    score = hit.mean(axis=-1)
    best = float(score.max())
    # 원 안의 숫자 획에 맞는 작은 원보다 바깥 원 — 거의 같은 점수(0.06 안)면 가장 큰 반지름
    near = np.argwhere(score >= best - 0.06)
    k = max(range(len(near)), key=lambda j: (near[j][2], score[tuple(near[j])]))
    i = tuple(near[k])
    cx, cy, r = (CX[i] + ox) / scale, (CY[i] + oy) / scale, R[i] / scale
    box = (cx - r, cy - r, cx + r, cy + r)
    return best, box


def choice_positions(q: Question, page_gray: dict, scale: float = SCALE, strict: bool = True) -> list[Label]:
    """스캔본: 보기 번호 자리를 그림으로 찾는다(OCR이 ①을 '㉦'·'(十'·'수)'로 읽거나 아예 빠뜨림 — Windows OCR, 철도토목기사 2026-11-17).
    ① 번호 열 x = 첫 줄(문항 번호)을 뺀 줄들의 시작 x 중 가장 왼쪽. ② 그 x 자리에 잉크가 있는 줄의 시작과, 줄 안에서 번호 높이의
    2.5배 넘는 빈칸 뒤(2×2·한 줄에 넷)가 후보. ③ 후보마다 동그라미인지 본다 — 이어지는 지문 줄이 보기와 같은 x에서 시작하는 시험지가 있음.
    뚜렷한 동그라미가 넷이면 그것, 셋이면 펜이 덧칠해 흐려진 동그라미 하나를 그 셋과 같은 줄·바로 옆 줄에서. 읽는 순서로 1~4, 아니면 [].
    strict=False: 동그라미를 보지 않고 후보가 딱 넷이면 그 자리(빨간 펜 — 색으로 표시를 가려내므로 자리만 맞으면 됨)."""
    lines = [ln for ln in q.lines if ln.chars]
    if len(lines) < 2:
        return []
    hs = sorted(ln.bottom - ln.top for ln in lines)
    h = max(6.0, hs[len(hs) // 2])
    x_lab = min(ln.chars[0]["x0"] for ln in lines[1:])
    cands: list[tuple[float, Label]] = []
    loose: list[Label] = []

    def add(g, page, x, top):
        loose.append(Label(0, False, page, (x, top, x + 0.8 * h, top + h), h))
        if strict:
            sc, box = _ring_score(g, x - 1, top, h, scale)
            if sc >= RING_WEAK:
                cands.append((sc, Label(0, False, page, box, h)))

    for ln in lines[1:]:
        g = page_gray.get(ln.page)
        if g is None:
            continue
        X0, T, X1, B = _px((x_lab - 1, ln.top, x_lab + 0.8 * h, ln.bottom), scale)
        box = g[max(0, T):B, max(0, X0):X1]
        if box.size and (box < INK).mean() >= 0.06:
            add(g, ln.page, x_lab, ln.top)
        # 같은 줄의 다음 보기: 빈칸(번호 높이 2.5배 넘음) 뒤 첫 잉크
        right = max(c["x1"] for c in ln.chars)
        X0b, _, X1b, _ = _px((x_lab + 0.8 * h, 0, right + 2, 0), scale)
        band = g[max(0, T):B, max(0, X0b):X1b]
        if not band.size:
            continue
        cols = _ink_cols(band)
        gap, start = 0, None
        for i, on in enumerate(cols):
            if not on:
                gap += 1
                continue
            if start is not None and gap >= 2.5 * h * scale:
                add(g, ln.page, (max(0, X0b) + i) / scale, ln.top)
            start = i if start is None else start
            gap = 0
    if not strict:
        if len(loose) != 4 or not _choice_shape(loose, h):     # 지문 줄이 끼면 배치가 깨짐(2015 85번: 1·2·1 줄)
            return []
        order = [l for r in _rows_of(loose) for l in r]
        return [Label(i, False, l.page, l.bbox, l.size) for i, l in enumerate(order, 1)]
    # 보기는 문항의 맨 끝에 오고, 보기 글이 길어 줄을 넘기면 들여 쓴다 → 후보 중 읽는 순서로 마지막 넷이 보기 번호.
    # 그보다 앞(지문 줄)에 뚜렷한 동그라미가 있으면 두 문항이 붙었거나 그림 속 원문자 → 버림
    cands = [(sc, l) for sc, l in cands if sc >= RING_PICK_MIN]
    if len(cands) < 4:
        return []
    last = cands[-4:]
    if any(sc >= RING_STRONG for sc, _ in cands[:-4]):
        return []
    if sum(sc for sc, _ in last) / 4 < RING_MEAN or sum(sc >= RING_STRONG for sc, _ in last) < 2:
        return []
    strong = [l for _, l in last]
    if not _choice_shape(strong, h):
        return []
    order = [l for r in _rows_of(strong) for l in r]
    return [Label(i, False, l.page, l.bbox, l.size) for i, l in enumerate(order, 1)]


def _choice_shape(labs: list[Label], h: float) -> bool:
    """보기 번호 넷의 배치가 시험지 보기 꼴인지 — 한 줄에 하나씩(같은 x), 2×2(두 열·두 행), 한 줄에 넷(같은 y).
    그림 속 원문자(⑥·⑦…)가 섞이면 이 꼴이 깨진다(철도토목기사 2019 37번)."""
    rows = _rows_of(labs)
    xs = lambda r: [l.bbox[0] for l in r]
    same_x = lambda a: max(a) - min(a) <= 0.8 * h
    if [len(r) for r in rows] == [1, 1, 1, 1]:
        if len({l.page for l in labs}) > 1:
            return False
        tops = [r[0].bbox[1] for r in rows]
        return same_x(xs(labs)) and all(b - a <= 8 * h for a, b in zip(tops, tops[1:]))
    if [len(r) for r in rows] == [2, 2]:
        (a, b), (c, d) = rows
        return same_x([a.bbox[0], c.bbox[0]]) and same_x([b.bbox[0], d.bbox[0]]) and b.bbox[0] - a.bbox[0] >= 3 * h \
            and 0 < c.bbox[1] - a.bbox[1] <= 4 * h
    if [len(r) for r in rows] == [4]:
        gaps = [q - p for p, q in zip(xs(rows[0]), xs(rows[0])[1:])]
        return min(gaps) >= 2.5 * h
    return False


def _blobs(mask: np.ndarray, cell: int = 4) -> list[tuple[float, float, int]]:
    """빨간 픽셀 덩어리(작은 칸으로 줄여 이웃끼리 묶음) → (중심 x, 중심 y, 픽셀 수) — 원본 픽셀 좌표."""
    H, W = mask.shape
    hh, ww = H // cell, W // cell
    if not hh or not ww:
        return []
    small = mask[:hh * cell, :ww * cell].reshape(hh, cell, ww, cell).sum(axis=(1, 3))
    on = small > 0
    seen = np.zeros_like(on)
    out = []
    for y0, x0 in zip(*np.nonzero(on)):
        if seen[y0, x0]:
            continue
        stack, cells = [(y0, x0)], []
        seen[y0, x0] = True
        while stack:
            y, x = stack.pop()
            cells.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < hh and 0 <= nx < ww and on[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
        wsum = sum(int(small[y, x]) for y, x in cells)
        # 아래쪽 절반의 중심 — ✓는 꼭짓점(번호 자리)에서 위로 삐치므로 전체 중심은 윗줄 보기 쪽으로 쏠림. ○는 아래 절반도 번호 가까이
        ys = sorted(y for y, x in cells)
        mid = ys[len(ys) // 2]
        low = [(y, x) for y, x in cells if y >= mid] or cells
        lw = sum(int(small[y, x]) for y, x in low)
        cy = sum((y + 0.5) * small[y, x] for y, x in low) / lw * cell
        cx = sum((x + 0.5) * small[y, x] for y, x in low) / lw * cell
        out.append((cx, cy, wsum))
    return out


def red_ink_answers(pages: list[Image.Image], layout: Layout, scale: float = SCALE) -> int:
    """빨간 펜 ✓·○가 가리키는 보기를 정답으로(사용자 2026-11-17 — 철도토목기사 스캔본).
    문항 구간의 빨간 덩어리마다 아래쪽 중심에서 가장 가까운 보기 번호(번호 높이 안)에 픽셀 수만큼 표를 주고, 1등이 2등의 2.5배 이상일 때만.
    지문에 그린 동그라미·밑줄은 보기 번호에서 멀어 표가 가지 않는다. 이미 정답 표시가 있는 문항은 건드리지 않는다. 찾은 문항 수."""
    found = 0
    arrays: dict[int, np.ndarray] = {}
    grays: dict[int, np.ndarray] = {}
    for q in layout.questions:
        if q.inline_answer is not None:
            continue
        labs = complete_labels(q)
        read = {l.digit for l in q.labels}
        sure = read == {1, 2, 3, 4} and len(q.labels) == 4      # OCR이 ①~④(가~라)를 제자리에서 다 읽음
        if not sure:
            for seg in q.segments:
                if seg.page not in grays:
                    grays[seg.page] = np.asarray(pages[seg.page].convert("L"))
            # 그림에서 찾은 번호 자리 넷이 있으면 그것을 씀 — 동그라미까지 확인한 자리, 없으면 줄 시작·빈칸 뒤 자리
            pos = choice_positions(q, grays, scale) or choice_positions(q, grays, scale, strict=False)
            if pos:
                labs = pos
            else:
                # OCR이 읽은 번호로 짐작한 자리 — 배치·읽는 순서가 맞을 때만(번호를 잘못 읽으면 정답이 한 칸씩 밀림, 2015 85번)
                hh = sorted(l.bbox[3] - l.bbox[1] for l in labs)[len(labs) // 2] if labs else 0
                if len(labs) != 4 or [l.digit for r in _rows_of(labs) for l in r] != [1, 2, 3, 4] or not _choice_shape(labs, hh):
                    continue
        if len(labs) < 2:
            continue
        h = sorted(l.bbox[3] - l.bbox[1] for l in labs)[len(labs) // 2]
        votes: dict[int, int] = {}
        for seg in q.segments:
            if seg.page not in arrays:
                arrays[seg.page] = np.asarray(pages[seg.page].convert("RGB"))
            x0, x1 = layout.col_of(seg.page, seg.col)
            X0, T, X1, B = _px((x0, seg.top - h, x1, seg.bottom), scale)
            a = arrays[seg.page][max(0, T):B, max(0, X0):X1]
            if not a.size:
                continue
            for cx, cy, n in _blobs(red_mask(a)):
                if n < 30:
                    continue
                px, py = (max(0, X0) + cx) / scale, (max(0, T) + cy) / scale
                ds = sorted((math.hypot((l.bbox[0] + l.bbox[2]) / 2 - px, (l.bbox[1] + l.bbox[3]) / 2 - py), l.digit)
                            for l in labs if l.page == seg.page)
                # 가장 가까운 번호가 한 줄(번호 높이) 안이고, 둘째로 가까운 번호보다 확실히 가까울 때만(애매하면 표를 주지 않음 — 틀린 정답보다 빼는 게 나음)
                if ds and ds[0][0] <= 1.0 * h and (len(ds) == 1 or ds[0][0] <= 0.7 * ds[1][0]):
                    votes[ds[0][1]] = votes.get(ds[0][1], 0) + n
        if not votes:
            continue
        ranked = sorted(votes.items(), key=lambda kv: -kv[1])
        if len(ranked) == 1 or ranked[0][1] >= 2.5 * ranked[1][1]:
            q.inline_answer = ranked[0][0]
            q.pen_labels = labs
            q.pen_guess = not sure
            found += 1
    return found


PEN_DEV, PEN_GAP, PEN_SHARE, PEN_MIN_Q = 0.25, 0.2, 0.5, 12


def pen_mark_answers(pages: list[Image.Image], layout: Layout, scale: float = SCALE) -> int:
    """검은 펜 ✓·／가 보기 번호 위에 그어진 스캔본(철도토목기사 2018~2022, 사용자 2026-11-17) — 색으로는 못 찾음.
    보기 번호 자리 넷을 찾은 문항마다 번호 둘레(위로 0.6h, 왼쪽 0.6h)의 잉크를 세어, 같은 번호(①·②·③·④)의 시험지 전체
    가운뎃값보다 25% 넘게 많고 2등보다 20%p 앞서면 그 보기를 정답으로. 표시가 없는 시험지에서 잡음으로 고르는 것을 막으려고
    번호 자리를 찾은 문항이 12개 이상이고 그중 절반 넘게 골라질 때만 쓴다(아니면 아무것도 쓰지 않음). 빨간 펜을 지운 뒤에 부른다.
    찾은 문항 수 — 모두 '정답 확인 필요'(pen_guess)."""
    grays: dict[int, np.ndarray] = {}
    rows: list[tuple[Question, list[int], list[Label]]] = []
    for q in layout.questions:
        if q.inline_answer is not None:
            continue
        for seg in q.segments:
            if seg.page not in grays:
                grays[seg.page] = np.asarray(pages[seg.page].convert("L"))
        labs = choice_positions(q, grays, scale)
        if len(labs) != 4:
            continue
        h = sorted(l.bbox[3] - l.bbox[1] for l in labs)[2]
        v = []
        for l in labs:
            x0, t, x1, b = l.bbox
            X0, T, X1, B = _px((x0 - 0.6 * h, t - 0.6 * h, x1 + 0.2 * h, b + 0.3 * h), scale)
            v.append(int((grays[l.page][max(0, T):B, max(0, X0):X1] < 110).sum()))
        rows.append((q, v, labs))
    if len(rows) < PEN_MIN_Q:
        return 0
    med = [max(1.0, float(np.median([v[d] for _, v, _ in rows]))) for d in range(4)]
    picks: list[tuple[Question, int, list[Label]]] = []
    for q, v, labs in rows:
        dev = [v[d] / med[d] - 1 for d in range(4)]
        o = sorted(range(4), key=lambda i: -dev[i])
        if dev[o[0]] >= PEN_DEV and dev[o[0]] - dev[o[1]] >= PEN_GAP:
            picks.append((q, o[0] + 1, labs))
    if len(picks) <= PEN_SHARE * len(rows):
        return 0
    for q, d, labs in picks:
        q.inline_answer = d
        q.pen_guess = True
        # 펜 자국이 문항 그림에 남으면 정답이 보임 → 보기 번호 넷 모두 둘레를 지우고 글꼴로 다시 그림(하나만 고치면 그것만 달라 보임)
        h = sorted(l.bbox[3] - l.bbox[1] for l in labs)[2]
        for l in labs:
            x0, t, x1, b = l.bbox
            _erase_mark(pages, l.page, (x0 - 0.6 * h, t - 0.45 * h, x1 + 0.15 * h, b + 0.3 * h),
                        (x0 - 1.0 * h, t - 1.6 * h, x1 + 0.3 * h, b + 0.6 * h), scale)
            _draw_label(pages[l.page], l, l.bbox, scale)
    return len(picks)


def _erase_mark(pages: list[Image.Image], page: int, box, win, scale: float) -> None:
    """box(pt)를 희게 지우고, 그 안의 잉크와 이어진 획(✓의 꼬리)을 win(pt) 안에서 따라가 함께 지운다 — 이웃 줄 글자는 이어지지 않아 남음."""
    img = pages[page]
    W0, T0, W1, B0 = (max(0, v) for v in _px(win, scale))
    X0, T, X1, B = _px(box, scale)
    a = np.array(img.convert("RGB").crop((W0, T0, W1, B0)))
    if not a.size:
        return
    dark = a.min(axis=2) < 200                            # 펜 획은 인쇄보다 옅은 곳이 있음(가는 볼펜)
    seed = np.zeros_like(dark)
    bx0, bt, bx1, bb = max(0, X0 - W0), max(0, T - T0), max(0, X1 - W0), max(0, B - T0)
    seed[bt:bb, bx0:bx1] = dark[bt:bb, bx0:bx1]
    for _ in range(400):                                  # 잉크 안에서만 넓혀 가는 이어짐(geodesic) — 더 늘지 않으면 끝
        g = seed.copy()
        g[1:] |= seed[:-1]
        g[:-1] |= seed[1:]
        g[:, 1:] |= seed[:, :-1]
        g[:, :-1] |= seed[:, 1:]
        g &= dark
        g[bt:bb, bx0:bx1] = dark[bt:bb, bx0:bx1]
        if (g == seed).all():
            break
        seed = g
    a[seed] = 255
    a[bt:bb, bx0:bx1] = 255
    img.paste(Image.fromarray(a), (W0, T0))


def _draw_label(img: Image.Image, lab: Label, box, scale: float) -> None:
    """보기 번호를 글꼴로 그림 — 원 지름을 box(pt)에 맞춤. 가나다라 보기는 글자만."""
    from PIL import ImageDraw
    x0, t, x1, b = box
    cx, cy = (x0 + x1) / 2 * scale, (t + b) / 2 * scale
    if lab.hangul:
        ch = "가나다라마"[lab.digit - 1]
        ImageDraw.Draw(img).text((cx, cy), ch, fill=(0, 0, 0), font=_label_font(int((b - t) * scale * 0.9)), anchor="mm")
    else:
        ch = "①②③④⑤"[lab.digit - 1]
        ImageDraw.Draw(img).text((cx, cy), ch, fill=(0, 0, 0), font=_fit_font(ch, (b - t) * scale * 1.08), anchor="mm")


def _redraw_question(pages: list[Image.Image], labs: list[Label], grays: dict, scale: float) -> bool:
    """문항의 보기 번호 넷(가나다라 포함)을 모두 지우고 글꼴로 같은 크기로 다시 그림 — 하나만 흐리거나 달라 보이면 정답이 보임.
    번호 자리는 근처 동그라미에 맞추고, 그 읽는 순서가 번호와 맞을 때만(아니면 그리지 않고 False)."""
    labs = [l for l in labs if 1 <= l.digit <= 5]
    if len(labs) < 2:
        return False
    # 가나다라 보기에 OCR이 '④'를 섞어 읽기도 함(2013 9번) — 한 문항 안에서 섞이면 다수 쪽으로, 반반이면 그리지 않음
    n_h = sum(l.hangul for l in labs)
    if 0 < n_h < len(labs):
        if 2 * n_h == len(labs):
            return False
        hang = 2 * n_h > len(labs)
        labs = [Label(l.digit, False, l.page, l.bbox, l.size, hangul=hang) for l in labs]
    h = sorted(l.bbox[3] - l.bbox[1] for l in labs)[len(labs) // 2]
    for l in labs:
        if l.page not in grays:
            grays[l.page] = np.asarray(pages[l.page].convert("L"))
    boxes: list = []
    for l in labs:
        x0, t, x1, b = l.bbox
        box = (x0, t, x0 + h, t + h)
        if not l.hangul:
            sc, rb = _ring_score(grays[l.page], x0 - 0.2 * h, t, h, scale, wide=True)   # 짐작한 자리는 위아래로 어긋나기도
            box = rb if sc >= RING_REDRAW else None
        boxes.append(box)
    miss = [i for i, b in enumerate(boxes) if b is None]
    if len(miss) > 1:
        return False                                        # 번호 자리가 불확실하면 엉뚱한 곳에 그리지 않음
    if miss:
        # 펜에 덮여 망가진 번호 하나(동그라미가 안 잡힘) — 같은 열의 x, 같은 행의 y를 다른 번호에서 빌림
        i = miss[0]
        l = labs[i]
        lx, ly = (l.bbox[0] + l.bbox[2]) / 2, (l.bbox[1] + l.bbox[3]) / 2
        others = [(labs[j], boxes[j]) for j in range(len(labs)) if j != i and labs[j].page == l.page]
        col = [(b[0] + b[2]) / 2 for o, b in others if abs(o.bbox[0] - l.bbox[0]) < 1.0 * h]
        row = [(b[1] + b[3]) / 2 for o, b in others if abs(o.bbox[1] - l.bbox[1]) < 0.6 * h]
        if not col and not row:
            return False
        d = float(np.median([b[3] - b[1] for _, b in others]))
        cx = float(np.median(col)) if col else lx
        cy = float(np.median(row)) if row else ly
        boxes[i] = (cx - d / 2, cy - d / 2, cx + d / 2, cy + d / 2)
    # 다시 잡은 자리의 읽는 순서가 번호와 맞을 때만(아니면 엉뚱한 번호를 그리게 됨 — 가나다라도 OCR이 '다'를 '나'로 읽기도 함)
    if sorted(l.digit for l in labs) != [1, 2, 3, 4]:
        return False
    ring = [Label(l.digit, False, l.page, b, l.size) for l, b in zip(labs, boxes)]
    if [l.digit for r in _rows_of(ring) for l in r] != [1, 2, 3, 4] or not _choice_shape(ring, h):
        return False
    if not labs[0].hangul:
        d = float(np.median([b[3] - b[1] for b in boxes]))          # 넷 다 같은 크기로
        boxes = [((b[0] + b[2]) / 2 - d / 2, (b[1] + b[3]) / 2 - d / 2, (b[0] + b[2]) / 2 + d / 2, (b[1] + b[3]) / 2 + d / 2)
                 for b in boxes]
    for l, (x0, t, x1, b) in zip(labs, boxes):
        pad = 0.25 * (b - t)                                # 펜 자국 둘레 잔여물까지 — 번호 왼쪽은 여백이라 더 넓게(○의 왼쪽 호)
        X0, T, X1, B = _px((x0 - 2.2 * pad, t - pad, x1 + pad, b + pad), scale)
        # 더 넓은 둘레(위아래 0.6, 왼쪽 1.0, 오른쪽 0.2 지름)의 옅은 잔여물(펜을 지운 뒤 남은 회색 점)만 지움 — 진한 인쇄 글자는 남김
        d0 = b - t
        W0, T0, W1, B0 = (max(0, v) for v in _px((x0 - 1.0 * d0, t - 0.6 * d0, x1 + 0.2 * d0, b + 0.6 * d0), scale))
        a = np.array(pages[l.page].convert("RGB").crop((W0, T0, W1, B0)))
        if a.size:
            a[a.min(axis=2) > 110] = 255
            pages[l.page].paste(Image.fromarray(a), (W0, T0))
        pages[l.page].paste((255, 255, 255), (max(0, X0), max(0, T), X1, B))
        _draw_label(pages[l.page], l, (x0, t, x1, b), scale)
    return True


def redraw_pen_labels(pages: list[Image.Image], layout: Layout, scale: float = SCALE) -> int:
    """색깔 펜(✓·○)을 지우면 펜이 덮었던 정답 번호의 인쇄 획까지 지워져 그 번호만 흐리게 남는다 → 정답이 보임
    (철도토목기사 2022 PC 결과, 사용자 2026-11-17). 펜 정답을 읽은 문항은 보기 번호 넷 모두 다시 그림. 다시 그린 문항 수."""
    grays: dict[int, np.ndarray] = {}
    return sum(_redraw_question(pages, q.pen_labels, grays, scale) for q in layout.questions if q.pen_labels)


def remove_red_ink(pages: list[Image.Image]) -> int:
    """스캔본 쪽에서 빨간 펜 자국(정답 ✓·○, 밑줄)을 흰색으로 — 문항 그림에 정답이 새지 않게. 지운 쪽 수."""
    n = 0
    for i, img in enumerate(pages):
        a = np.array(img.convert("RGB"))
        m = red_mask(a, RED_ERASE_DIFF)
        if m.any():
            # 펜 자국 둘레 3픽셀의 옅은 번짐(채도가 낮아진 가장자리)도 지움 — 인쇄 글자(진한 픽셀)는 남김
            grow = m.copy()
            for _ in range(3):
                g2 = grow.copy()
                g2[1:] |= grow[:-1]
                g2[:-1] |= grow[1:]
                g2[:, 1:] |= grow[:, :-1]
                g2[:, :-1] |= grow[:, 1:]
                grow = g2
            m = m | (grow & (a.min(axis=2) > 150))
            a[m] = 255
            pages[i] = Image.fromarray(a)
            n += 1
    return n
