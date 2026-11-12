"""스캔본(텍스트층 없는 PDF) 경로 — OCR로 글자 좌표를 만들어 extract.analyze()에 넘긴다(ADR 022, PREP-PLAN-v0.5 B1).

엔진(ADR 022):
- **Windows 내장 OCR(winocr, 한국어)** — 기본. 동료 PC에 따로 설치할 것이 없다(한국어 Windows는 한국어 OCR 기능이
  보통 미리 깔려 있음). 없으면 `OcrUnavailable`로 멈추고 [설정]에서 추가하는 길을 알려 준다.
- Tesseract(kor) — 직접 설치된 PC에서만 예비로(PATH · ONEQ_TESSERACT · 표준 설치 위치). 클라우드 시험도 이것.
- 환경변수 ONEQ_OCR_ENGINE=winocr|tesseract 로 강제할 수 있다(실측·시험용).

글자 좌표: 엔진의 단어 상자(px)를 글자 수로 나눠 pdfplumber 글자 사전(pt)으로. 같은 OCR 줄은 top을 맞추고,
단어 사이가 글자 높이의 0.6배보다 넓을 때만 공백을 넣는다(엔진마다 단어를 나누는 방식이 달라도 같은 글이 되게).

보기 번호:
- 원문자(①~④)는 OCR이 잘 못 읽는다("@", "(3)", "00" 등) → 줄 첫머리나 넓은 간격 뒤의 짧은 기호 토큰을
  '①' 자리표로 바꾸고, 번호는 문항 안 순서로 다시 매긴다(extract.analyze).
- **가나다라**(옛 국가기술자격 시험지, 철도보선기사 2010-2 표본)는 OCR이 잘 읽으므로 글자 그대로 번호로 쓴다
  (`ocr_digit`). 줄 첫머리 또는 넓은 간격 뒤의 "가." 꼴만 — 문장 끝 "…한다."는 토큰이 "한다."라 안 걸린다.

정답(ADR 022 4절):
- 끝 쪽 **정답표**(격자 표)는 칸으로 잘라 답 줄마다 한 줄 그림으로 읽는다. 번호 줄은 바탕 칠로 가르고, 답 줄은
  건너뛰지 않으며, 못 읽은 칸은 같은 표의 글자 모양으로 맞춘다(read_answer_rows). 이 쪽은 문항 찾기에서 뺀다.
- 원문자형 스캔본의 진하게 칠한 번호는 render.mask_ocr_filled가 잡는다. **가나다라형의 손글씨 ✓ 표시는 정답으로
  쓰지 않는다**(시험 본 사람의 표시 — 표본 1번·9번 모두 오답).
- OCR 팩의 문항은 모두 `ocr`·`needs-review` 표시를 단다(pack.py).
"""
from __future__ import annotations

import csv
import functools
import io
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium

OCR_SCALE = 300 / 72          # 300dpi(A4 글자 PDF 기준)
MAX_SIDE = 3000               # 렌더 그림의 긴 변 상한(px) — 저해상도 스캔(표본 ≈120dpi)을 300dpi로 늘리면 느리기만 함
LABELISH = re.compile(r"^(\(?[0-9OoQ]{1,2}\)?|[@®©◎⑩]|[①-⑤❶-❺]|\(\w\))$")
QNUM_TOKEN = re.compile(r"^\d{1,3}\.$")
HANGUL_LABELS = "가나다라"
WORD_GAP = 0.6                # 단어 사이로 볼 간격(글자 높이 배수) — 표본 실측: 낱자 사이 0.2~0.5, 단어 사이 0.7~1.0
HANGUL_LABEL = re.compile(r"^([가나다라])([.,·]?)(.*)$")
ENGINE_NAMES = {"winocr": "Windows 내장 OCR", "tesseract": "Tesseract"}

WIN_OCR_HELP = (
    "이 PDF는 스캔본이라 글자 읽기(OCR)가 필요한데, 이 PC에서 Windows 한국어 OCR 기능을 찾지 못했습니다.\n"
    "추가하는 방법(Windows 11, 관리자 권한 없이):\n"
    "  [설정] → [시간 및 언어] → [언어 및 지역] → 한국어 옆 [⋯] → [언어 옵션]\n"
    "  → 언어 기능에서 '광학 문자 인식'(또는 '기본 입력'과 함께 설치되는 항목)을 설치한 뒤 문제팩 생성기를 다시 실행하세요.\n"
    "  한국어가 목록에 없으면 [언어 추가]로 한국어를 먼저 추가하세요.\n"
    "회사 정책으로 막혀 있으면 IT 담당자에게 'Windows 한국어 OCR 기능(Language.OCR~~~ko-KR~0.0.1.0) 설치'를 요청하세요.\n"
    "글자 PDF(comcbt 교사용 등)는 OCR 없이 처리됩니다.")


class OcrUnavailable(RuntimeError):
    pass


# ───────────────────────── 엔진 고르기 ─────────────────────────

def tesseract_path() -> str:
    p = os.environ.get("ONEQ_TESSERACT") or shutil.which("tesseract")
    if not p:
        local = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Tesseract-OCR", "tesseract.exe")   # "나만 설치"(관리자 권한 없음)
        for cand in (r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe", local):
            if Path(cand).exists():
                return cand
        raise OcrUnavailable(
            "스캔본(텍스트층 없음)이라 OCR이 필요한데 Tesseract를 찾지 못했습니다.\n"
            "  설치: https://github.com/UB-Mannheim/tesseract/wiki (설치 중 Korean 언어 선택)\n"
            "  설치 후 PATH에 넣거나 환경변수 ONEQ_TESSERACT=...\\tesseract.exe 로 지정")
    return p


def winocr_status(lang: str = "ko") -> str | None:
    """Windows 내장 OCR을 쓸 수 있으면 None, 아니면 이유(사람이 읽을 글)."""
    if os.name != "nt":
        return "Windows가 아님"
    try:
        from winrt.windows.globalization import Language
        from winrt.windows.media.ocr import OcrEngine
    except ImportError:
        return "winocr 패키지 없음(py -3 -m pip install winocr)"
    try:
        if not OcrEngine.is_language_supported(Language(lang)):
            return "한국어 OCR 기능 없음"
    except Exception as e:  # noqa: BLE001 — WinRT 오류(아주 오래된 Windows 등)
        return f"Windows OCR 오류: {e}"
    return None


def pick_engine() -> str:
    """쓸 엔진 이름. 둘 다 없으면 OcrUnavailable(Windows면 한국어 OCR 기능 추가 안내)."""
    forced = os.environ.get("ONEQ_OCR_ENGINE", "").strip().lower()
    if forced == "tesseract":
        tesseract_path()
        return "tesseract"
    why = winocr_status()
    if why is None:
        return "winocr"
    if forced == "winocr":
        raise OcrUnavailable(WIN_OCR_HELP + f"\n(이유: {why})")
    try:
        tesseract_path()
        return "tesseract"
    except OcrUnavailable as e:
        if os.name == "nt":
            raise OcrUnavailable(WIN_OCR_HELP + f"\n(이유: {why})") from e
        raise


def needs_ocr(path: str | Path, min_chars: int = 50) -> bool:
    """텍스트층 글자가 거의 없으면 스캔본으로 본다."""
    with pdfplumber.open(path) as pdf:
        n = sum(len(p.chars) for p in pdf.pages[:3])
    return n < min_chars


# ───────────────────────── 엔진별 단어 상자 ─────────────────────────
# 단어 = {"text", "left", "top", "width", "height", "line"}(px, line은 같은 OCR 줄이면 같은 값)

def _tsv(img, exe: str, lang: str, psm: str = "3") -> list[dict]:
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "p.png"
        img.save(src)
        out = subprocess.run([exe, str(src), "stdout", "-l", lang, "--psm", psm, "tsv"],
                             capture_output=True, check=False)
        if out.returncode != 0:
            msg = out.stderr.decode("utf-8", "replace")
            if "kor" in msg or "language" in msg.lower():
                raise OcrUnavailable("Tesseract 한국어 데이터(kor.traineddata)가 없습니다. 설치 때 Korean을 선택하세요.\n" + msg)
            raise OcrUnavailable(msg)
    rows = csv.DictReader(io.StringIO(out.stdout.decode("utf-8", "replace")), delimiter="\t", quoting=csv.QUOTE_NONE)
    return [r for r in rows if r.get("level") == "5" and (r.get("text") or "").strip()]


def _tesseract_words(img, lang: str = "kor") -> list[dict]:
    out = []
    for r in _tsv(img, tesseract_path(), lang):
        out.append({"text": r["text"].strip(), "left": int(r["left"]), "top": int(r["top"]),
                    "width": int(r["width"]), "height": int(r["height"]),
                    "line": (int(r["block_num"]), int(r["par_num"]), int(r["line_num"]))})
    return out


def _win_result(img, lang: str = "ko") -> dict:
    import winocr
    from winrt.windows.media.ocr import OcrEngine
    k = 1.0
    try:
        lim = int(OcrEngine.max_image_dimension)
        if max(img.size) > lim:
            k = lim / max(img.size)
    except Exception:  # noqa: BLE001
        pass
    if k < 1:
        from PIL import Image
        img = img.resize((int(img.width * k), int(img.height * k)), Image.LANCZOS)
    r = winocr.recognize_pil_sync(img.convert("RGBA"), lang)
    r = r if isinstance(r, dict) else {}
    r["_k"] = k
    return r


def words_from_winocr(result: dict) -> list[dict]:
    """winocr.recognize_pil_sync 결과(dict: lines → words → bounding_rect{x,y,width,height}) → 단어 상자."""
    k = result.get("_k", 1.0) or 1.0
    out = []
    for li, ln in enumerate(result.get("lines") or []):
        for w in ln.get("words") or []:
            t = (w.get("text") or "").strip()
            b = w.get("bounding_rect") or {}
            if not t or not b:
                continue
            out.append({"text": t, "left": round(b["x"] / k), "top": round(b["y"] / k),
                        "width": round(b["width"] / k), "height": round(b["height"] / k), "line": li})
    return out


def page_words(img, engine: str) -> list[dict]:
    if engine == "winocr":
        return words_from_winocr(_win_result(img))
    return _tesseract_words(img)


def line_text(img, engine: str) -> str:
    """한 줄 그림(정답표 줄을 이어 붙인 것)의 글. Tesseract는 psm 7(psm 3이면 덩어리로 나눠 글자를 놓침)."""
    if engine == "winocr":
        r = _win_result(img)
        return "\n".join(ln.get("text", "") for ln in r.get("lines") or []) or r.get("text", "")
    return " ".join(r["text"] for r in _tsv(img, tesseract_path(), "kor", psm="7"))


def char_text(img, engine: str) -> str:
    """칸 하나(글자 하나). Windows 내장은 낱자 그림을 잘 읽지 않는다 — 줄 읽기가 모자랄 때만 쓰는 마지막 수단."""
    if engine == "winocr":
        return line_text(img, engine)
    return " ".join(r["text"] for r in _tsv(img, tesseract_path(), "kor", psm="10"))


# ───────────────────────── 단어 → 글자 ─────────────────────────

def _char(text, x0, x1, top, bottom):
    return {"text": text, "x0": x0, "x1": x1, "top": top, "bottom": bottom, "size": bottom - top,
            "upright": True, "object_type": "char", "ocr": True}


def _spread(t: str, x0: float, x1: float, top: float, bottom: float) -> list[dict]:
    step = (x1 - x0) / max(1, len(t))
    return [_char(c, x0 + i * step, x0 + (i + 1) * step, top, bottom) for i, c in enumerate(t)]


def words_to_chars(words: list[dict], scale: float = OCR_SCALE) -> list[dict]:
    """단어 상자(px) → pdfplumber 글자 사전 목록(pt). 같은 OCR 줄의 글자는 top을 맞춘다.
    Tesseract TSV 행(block_num·par_num·line_num·left…)을 그대로 받아도 된다(예전 호출 호환)."""
    lines: dict[object, list[dict]] = {}
    for w in words:
        if "line" not in w:
            w = {"text": w["text"], "left": int(w["left"]), "top": int(w["top"]), "width": int(w["width"]),
                 "height": int(w["height"]), "line": (w["block_num"], w["par_num"], w["line_num"])}
        lines.setdefault(w["line"], []).append(w)
    chars: list[dict] = []
    for ws in lines.values():
        ws.sort(key=lambda w: w["left"])
        top = min(w["top"] for w in ws) / scale
        bottom = max(w["top"] + w["height"] for w in ws) / scale
        avg_h = sum(w["height"] for w in ws) / len(ws)
        prev_x1 = None                     # px
        for j, w in enumerate(ws):
            t = w["text"].strip()
            if not t:
                continue
            nxt = ws[j + 1]["text"] if j + 1 < len(ws) else ""
            x0 = w["left"] / scale
            x1 = (w["left"] + w["width"]) / scale
            gap = None if prev_x1 is None else w["left"] - prev_x1
            if gap is not None and gap > avg_h * WORD_GAP:
                chars.append(_char(" ", prev_x1 / scale, x0, top, bottom))
            line_start_or_wide = gap is None or gap > avg_h * 0.8
            hm = HANGUL_LABEL.match(t)
            if QNUM_TOKEN.match(t):
                chars += _spread(t, x0, x1, top, bottom)
            elif hm and line_start_or_wide and (hm.group(2) or nxt.startswith((".", ",")) or (not hm.group(3) and gap is None)
                                                or (not hm.group(3) and gap is not None and gap > avg_h * 2)):
                # 가나다라 보기 번호: "가." / "가.일정한…"(붙음) / "가" + 다음 단어 "." / 줄 첫 "가"
                lw = (x1 - x0) / len(t)
                c = _char(hm.group(1), x0, x0 + lw, top, bottom)
                c["ocr_label"] = True
                c["ocr_digit"] = HANGUL_LABELS.index(hm.group(1)) + 1
                chars.append(c)
                rest = t[1:]
                if rest:
                    chars += _spread(rest, x0 + lw, x1, top, bottom)
            elif LABELISH.match(t) and line_start_or_wide and (x1 - x0) * scale < avg_h * 2.2 and not nxt.startswith("과"):
                # 원문자 보기 번호 자리. 실제 번호는 문항 안 순서로 다시 매긴다(extract.analyze, ocr 모드)
                c = _char("①", x0, x1, top, bottom)
                c["ocr_label"] = True
                chars.append(c)
            else:
                chars += _spread(t, x0, x1, top, bottom)
            prev_x1 = w["left"] + w["width"]
    return chars


# ───────────────────────── 정답표: 칸 나눠 읽기(ADR 022 4절, ocrbench에서 옮김) ─────────────────────────
CONFUSE = {"마": "라", "타": "다", "카": "가", "따": "다", "까": "가", "랴": "라", "냐": "나", "댜": "다", "갸": "가"}


def _runs(mask) -> list[tuple[int, int]]:
    out, s = [], None
    for i, m in enumerate(mask):
        if m and s is None:
            s = i
        elif not m and s is not None:
            out.append((s, i))
            s = None
    if s is not None:
        out.append((s, len(mask)))
    return out


@dataclass
class TableRow:
    cells: list                 # 칸 그림(글자 칸만)
    shaded: bool                # 바탕을 칠한 줄(정답표의 번호 줄 — 표본은 밝기 240, 답 줄은 254)
    band: object                # 줄 전체 그림(칸으로 자르지 않은 것, 다시 읽기용)


def table_rows_info(img) -> list[TableRow]:
    """격자 표 → 줄마다 칸 그림·바탕 칠 여부. 가로선·짙게 칠한 줄과 세로선으로 자른다. 칸이 아니면 []."""
    import numpy as np
    from PIL import Image
    g = img.convert("L")
    a = np.asarray(g).astype(int)
    h, w = a.shape
    ink = a < 240
    line_rows = ink.mean(1) > 0.6           # 가로선 또는 짙게 칠한 줄
    rows = [(y0, y1) for y0, y1 in _runs(~line_rows) if y1 - y0 > h / 60]
    vl = np.where(ink.mean(0) > 0.6)[0]
    cuts, grp = [], []
    for x in vl:
        if grp and x > grp[-1] + 2:
            cuts.append(int(sum(grp) / len(grp)))
            grp = []
        grp.append(x)
    if grp:
        cuts.append(int(sum(grp) / len(grp)))
    cols = [(cuts[i] + 3, cuts[i + 1] - 2) for i in range(len(cuts) - 1) if cuts[i + 1] - cuts[i] > w / 40]
    if len(cols) < 3 or not rows:
        return []
    out = []
    for y0, y1 in rows:
        line = []
        for x0, x1 in cols:
            c = g.crop((x0, y0 + 2, x1, y1 - 2)).point(lambda v: 0 if v < 200 else 255)
            if c.getbbox() is None or c.getextrema()[0] != 0:
                continue                      # 빈 칸
            k = 120 / max(1, c.height)
            c = c.resize((max(1, int(c.width * k)), 120), Image.LANCZOS)
            pad = Image.new("L", (c.width + 80, c.height + 80), 255)
            pad.paste(c, (40, 40))
            line.append(pad)
        if not line:
            continue
        mid = a[y0 + 3:max(y0 + 4, y1 - 3), cols[0][0]:cols[-1][1]]
        shaded = bool(mid.size) and float(np.median(mid)) < 248
        band = g.crop((cols[0][0] - 3, y0, cols[-1][1] + 2, y1))
        out.append(TableRow(line, shaded, band))
    return out


def table_rows(img) -> list[list]:
    """격자 표 → 줄마다 칸 그림 목록(table_rows_info의 칸만)."""
    return [r.cells for r in table_rows_info(img)]


def table_cells(img) -> list:
    """격자 표 → 칸 그림(왼→오, 위→아래, 한 줄로 펼침). 칸이 아니면 []."""
    return [c for row in table_rows(img) for c in row]


def strip_image(cells: list, k: float = 1.0):
    """한 줄의 칸들을 띄어서 한 줄 그림으로 — Windows 내장 OCR은 낱자 하나짜리 그림을 읽지 않는다(2026-11-11 PC 5/100).
    k: 크기 배율(글자가 너무 크면 Windows 내장이 못 읽을 수 있어 0.5·0.3도 시도)."""
    from PIL import Image, ImageOps
    trimmed = []
    for c in cells:                                   # 칸 여백을 걷어 글자만(+여유 10px) — 빈칸이 넓으면 줄이 끊김
        bb = ImageOps.invert(c).getbbox()
        trimmed.append(c.crop((max(0, bb[0] - 10), max(0, bb[1] - 10), min(c.width, bb[2] + 10), min(c.height, bb[3] + 10))) if bb else c)
    cs = [c.resize((max(1, int(c.width * k)), max(1, int(c.height * k))), Image.LANCZOS) if k != 1 else c for c in trimmed]
    gap = max(10, int(45 * k))
    w = sum(c.width for c in cs) + gap * (len(cs) + 1)
    h = max(c.height for c in cs)
    im = Image.new("L", (w, h), 255)
    x = gap
    for c in cs:
        im.paste(c, (x, (h - c.height) // 2))
        x += c.width + gap
    return im


def letters(t: str) -> list[str]:
    """OCR 글에서 가·나·다·라만(비슷한 글자는 보정)."""
    out = []
    for x in re.sub(r"[\s.,·:;|]+", "", t):
        if x in HANGUL_LABELS:
            out.append(x)
        elif x in CONFUSE:
            out.append(CONFUSE[x])
    return out


ANSWER_DEBUG: list[dict] = []    # 마지막 정답표 읽기 기록(줄마다 칸 수·읽은 글·판정) — 실측 결과 파일용


def _read_strip(cells: list, engine: str) -> tuple[list[str], bool, str]:
    """칸 묶음을 한 줄 그림으로(크기 1·0.5·0.3배) 읽어 (가나다라 목록, 번호 줄인지, 읽은 글)."""
    best: list[str] = []
    seen = ""
    for k in (1.0, 0.5, 0.3):
        t = line_text(strip_image(cells, k), engine)
        if sum(ch.isdigit() for ch in t) >= max(3, len(cells) // 3):
            return [], True, t                     # 번호 줄("41 42 …"를 "다 라"로 일부 잘못 읽어도 숫자로 가름)
        ls = letters(t)
        if len(ls) > len(best):
            best, seen = ls, t
        if len(best) >= len(cells):
            break
    return best, False, seen


def _band_image(band, height: int = 90):
    """칸으로 자르지 않은 줄 그림을 키워 여백을 둠(다시 읽기용)."""
    from PIL import Image
    k = height / max(1, band.height)
    b = band.resize((max(1, int(band.width * k)), height), Image.LANCZOS).point(lambda v: 0 if v < 200 else 255)
    pad = Image.new("L", (b.width + 80, b.height + 80), 255)
    pad.paste(b, (40, 40))
    return pad


def _stack(top, bottom, gap: int = 60):
    from PIL import Image
    w = max(top.width, bottom.width)
    im = Image.new("L", (w, top.height + gap + bottom.height), 255)
    im.paste(top, (0, 0))
    im.paste(bottom, (0, top.height + gap))
    return im


def _reread(row: TableRow, engine: str, context) -> tuple[list[str], str]:
    """덜 읽은 답 줄 다시 읽기 — 맞는 칸 수가 나오는 첫 방법. (글자, 방법) / 끝내 못 읽으면 칸마다 "?"."""
    n = len(row.cells)
    h = n // 2
    a, _, _ = _read_strip(row.cells[:h], engine)
    b, _, _ = _read_strip(row.cells[h:], engine)
    if len(a) == h and len(b) == n - h:
        return a + b, "반씩"
    for ht in (90, 60):
        ls = letters(line_text(_band_image(row.band, ht), engine))
        if len(ls) == n:
            return ls, f"줄 통째({ht})"
    if context is not None and engine == "winocr":
        # Windows 내장 OCR은 글자 몇 개짜리 그림을 통째로 못 읽기도 함(2026-11-11 PC: 빈 글) → 잘 읽힌 답 줄 아래에 붙여 함께
        for k in (1.0, 0.5):
            t = line_text(_stack(strip_image(context, k), strip_image(row.cells, k)), engine)
            last = [ln for ln in t.splitlines() if ln.strip()]
            ls = letters(last[-1]) if len(last) >= 2 else []
            if len(ls) == n:
                return ls, f"앞 줄과 함께({k:g})"
    parts = [row.cells[i:i + 3] for i in range(0, n, 3)]
    got = []
    for part in parts:
        ls, _, _ = _read_strip(part, engine)
        if len(ls) != len(part):
            got = []
            break
        got += ls
    if len(got) == n:
        return got, "세 칸씩"
    out = []
    for c in row.cells:
        one = letters(char_text(c, engine))
        out.append(one[0] if one else "?")
    return out, "칸마다"


def read_answer_rows(img, engine: str) -> list[str]:
    """정답표 그림 → 답 글자 목록(읽은 순서, 못 읽은 칸은 "?"). 표가 아니면 [].
    - 표의 대표 칸 수(보통 10)와 다른 줄(제목 줄)은 뺌
    - 번호 줄 = 바탕을 칠한 줄(읽지 않음) 또는 숫자가 많은 줄 — **나머지 줄은 모두 답 줄**: 답 줄을 건너뛰면 뒤 정답이
      통째로 밀린다(2026-11-11 PC winocr 1차: 덜 읽은 줄을 건너뜀 / 2차: 번호 줄·답 줄을 빈 글로 돌려줘 구분 못 함)
    - 덜 읽은 답 줄은 반씩 · 줄 통째 · (winocr) 잘 읽힌 앞 답 줄과 함께 · 세 칸씩 · 칸마다 순서로 다시, 끝내 못 읽은 칸은 "?"."""
    from collections import Counter
    ANSWER_DEBUG.clear()
    rows = table_rows_info(img)
    if not rows:
        return []
    width = Counter(len(r.cells) for r in rows).most_common(1)[0][0]
    got: list[str] = []
    cells_of: list = []                 # got과 같은 순서의 칸 그림(모양 맞춤용)
    sure: list[tuple] = []              # 줄 통째로 다 읽힌 칸(그림, 글자) — 같은 표의 견본
    context = None
    for ri, row in enumerate(rows):
        rec = {"row": ri, "cells": len(row.cells), "shaded": row.shaded}
        ANSWER_DEBUG.append(rec)
        if len(row.cells) != width:
            rec["kind"] = "제목·기타(칸 수 다름)"
            continue
        if row.shaded:
            rec["kind"] = "번호 줄(바탕 칠)"
            continue
        best, numbers, seen = _read_strip(row.cells, engine)
        rec["text"] = seen
        if numbers:
            rec["kind"] = "번호 줄(숫자)"
            continue
        if len(best) != len(row.cells):
            best, rec["how"] = _reread(row, engine, context)
        else:
            context = row.cells
            sure += list(zip(row.cells, best))
        rec["kind"] = "답 줄"
        rec["letters"] = "".join(best)
        got += best
        cells_of += row.cells
    if "?" in got and sure:
        fixed = _match_shapes([c for c, x in zip(cells_of, got) if x == "?"], sure)
        it = iter(fixed)
        got = [next(it) if x == "?" else x for x in got]
        ANSWER_DEBUG.append({"kind": "모양 맞춤", "filled": sum(x != "?" for x in fixed), "of": len(fixed)})
    return got


def _shape(cell, n: int = 24):
    """칸 그림 → 글자만 잘라 n×n 흑백 배열(0~1, 잉크=1)."""
    import numpy as np
    from PIL import Image, ImageOps
    g = cell.convert("L")
    bb = ImageOps.invert(g).getbbox()
    if bb is None:
        return None
    g = g.crop(bb).resize((n, n), Image.LANCZOS)
    return 1.0 - np.asarray(g, dtype=float) / 255.0


def _match_shapes(unknown: list, sure: list[tuple], margin: float = 0.85) -> list[str]:
    """못 읽은 칸을 같은 표에서 확실히 읽은 칸(견본)과 글자 모양으로 맞춘다 — 정답표 글자는 한 글꼴의 가·나·다·라 넷뿐.
    가장 가까운 글자의 거리가 둘째 글자의 margin배 이하일 때만 정함(표본 줄 하나씩 빼고 맞춰 보기: 0.85에서 100/100·틀림 0, 0.6이면 69/100), 아니면 "?"(2026-11-11 PC winocr 3차:
    61~70번 답 줄 하나를 다섯 방법 모두 빈 글로 돌려줌)."""
    import numpy as np
    proto: dict[str, list] = {}
    for c, x in sure:
        a = _shape(c)
        if a is not None and x in HANGUL_LABELS:
            proto.setdefault(x, []).append(a)
    if len(proto) < 2:
        return ["?"] * len(unknown)
    out = []
    for c in unknown:
        a = _shape(c)
        if a is None:
            out.append("?")
            continue
        d = sorted((min(float(np.abs(a - p).mean()) for p in ps), x) for x, ps in proto.items())
        out.append(d[0][1] if len(d) == 1 or d[0][0] <= d[1][0] * margin else "?")
    return out


def answers_from_letters(seq: list[str]) -> dict[int, int]:
    return {i + 1: HANGUL_LABELS.index(x) + 1 for i, x in enumerate(seq) if x in HANGUL_LABELS}


# ───────────────────────── 문서 전체 ─────────────────────────

@dataclass
class OcrDoc:
    pages: list[list[dict]]                     # 쪽마다 글자 사전(정답표 쪽은 [])
    engine: str
    answers: dict[int, int] = field(default_factory=dict)   # 정답표에서 읽은 번호 → 보기 번호
    answer_pages: list[int] = field(default_factory=list)  # 정답표 쪽(0부터)
    unread_answers: int = 0                     # 정답표에서 못 읽은 칸 수
    shape_answers: int = 0                      # OCR로 못 읽어 글자 모양으로 맞춘 칸 수
    text: str = ""                              # 쪽 글(종목·시행일 읽기용, examinfo)


def page_scale(page) -> float:
    w, h = page.get_size()
    return min(OCR_SCALE, MAX_SIDE / max(w, h))


def _render(page, scale: float):
    page.set_cropbox(*page.get_mediabox())     # pdfplumber와 같은 좌표계
    return page.render(scale=scale).to_pil().convert("L")


def _answer_table(page, engine: str) -> list[str] | None:
    """끝 쪽이 격자 정답표면 답 글자 목록, 아니면 None."""
    w, _ = page.get_size()
    img = _render(page, max(2.0, 1000 / w))
    rows = table_rows(img)
    if len(rows) < 2 or max(len(r) for r in rows) < 5:
        return None
    got = read_answer_rows(img, engine)
    return got if sum(x != "?" for x in got) >= 5 else None


def ocr_document(path: str | Path, progress=None, engine: str | None = None) -> OcrDoc:
    engine = engine or pick_engine()
    pdf = pdfium.PdfDocument(str(path))
    try:
        n = len(pdf)
        ans_pages: list[int] = []
        shape = 0
        seq: list[str] = []
        for i in range(n - 1, max(0, n - 3) - 1, -1):          # 끝 쪽부터 최대 3쪽(정답표가 둘 이상 쪽일 수 있음)
            got = _answer_table(pdf[i], engine) if i > 0 else None
            if got is None:
                break
            shape += sum(r.get("filled", 0) for r in ANSWER_DEBUG if r.get("kind") == "모양 맞춤")
            ans_pages.insert(0, i)
            seq = got + seq
        out: list[list[dict]] = []
        texts: list[str] = []
        for i in range(n):
            if i in ans_pages:
                out.append([])
            else:
                page = pdf[i]
                sc = page_scale(page)
                words = page_words(_render(page, sc), engine)
                out.append(words_to_chars(words, sc))
                texts.append(_words_text(words))
            if progress:
                progress(i + 1, n)
        return OcrDoc(out, engine, answers_from_letters(seq), ans_pages, unread_answers=sum(x == "?" for x in seq),
                      shape_answers=shape, text="\n".join(texts))
    finally:
        pdf.close()


def _words_text(words: list[dict]) -> str:
    lines: dict[object, list[dict]] = {}
    for w in words:
        lines.setdefault(w["line"], []).append(w)
    rows = sorted(lines.values(), key=lambda ws: (min(w["top"] for w in ws), min(w["left"] for w in ws)))
    return "\n".join(" ".join(w["text"] for w in sorted(ws, key=lambda w: w["left"])) for ws in rows)


def ocr_pdf(path: str | Path, lang: str = "kor", progress=None) -> list[list[dict]]:
    """(예전 호출 호환) 쪽마다 글자 사전만."""
    return ocr_document(path, progress).pages


def head_text(path: str | Path, frac: float = 0.35) -> str:
    """스캔본 첫 쪽 위쪽 글(종목·시행일·회차 읽기용, examinfo). 엔진이 없거나 실패하면 "".
    창 프로그램은 목록을 고칠 때마다 다시 부르므로 파일(경로·크기·수정 시각)별로 기억한다."""
    try:
        st = Path(path).stat()
        return _head_text(str(path), st.st_size, st.st_mtime_ns, frac)
    except OSError:
        return ""


@functools.lru_cache(maxsize=256)
def _head_text(path: str, _size: int, _mtime: int, frac: float) -> str:
    try:
        engine = pick_engine()
        pdf = pdfium.PdfDocument(str(path))
        try:
            page = pdf[0]
            sc = page_scale(page)
            img = _render(page, sc)
            img = img.crop((0, 0, img.width, int(img.height * frac)))
            return _words_text(page_words(img, engine))
        finally:
            pdf.close()
    except Exception:  # noqa: BLE001 — 머리말을 못 읽으면 "0000년 nn회"로(ADR 021 2절)
        return ""


# ───────────────────────── 점검(명령줄·빌드 시험) ─────────────────────────

def check(lang: str = "ko") -> int:
    """이 PC에서 OCR을 쓸 수 있는지 — 0: Windows 내장 OCR로 실제 글자를 읽음, 1: Tesseract 예비만, 2: 불렀는데 못 읽음,
    3: 못 씀(기능 없음), 4: 실행파일에 winocr·winrt가 빠짐.
    빌드 시험(GitHub Windows)에서는 실행파일 안 winrt 모듈이 빠지지 않았는지 보려고 `--ocr-check en`으로 부른다."""
    why = winocr_status(lang)
    if why is None:
        from PIL import Image, ImageDraw, ImageFont
        text = "가. 열차속도 2010" if lang.startswith("ko") else "OneQ Ace 2010"
        font = None
        for name in ("malgun.ttf", "arial.ttf"):
            try:
                font = ImageFont.truetype(name, 44)
                break
            except OSError:
                continue
        im = Image.new("L", (900, 120), 255)
        ImageDraw.Draw(im).text((20, 30), text, fill=0, font=font or ImageFont.load_default())
        got = " ".join(w["text"] for w in words_from_winocr(_win_result(im, lang)))
        print(f"Windows 내장 OCR({lang}): 사용 가능 — 시험 글 '{text}' → '{got}'")
        return 0 if "2010" in got else 2
    print(f"Windows 내장 OCR({lang}): 못 씀 — {why}")
    if why.startswith("winocr 패키지 없음") and getattr(__import__("sys"), "frozen", False):
        return 4                                  # 실행파일에 winrt 모듈이 빠짐(빌드 문제)
    try:
        print(f"Tesseract(예비): {tesseract_path()}")
        return 1
    except OcrUnavailable:
        print("Tesseract(예비): 없음")
    if lang.startswith("ko"):
        print(WIN_OCR_HELP)
    return 3


if __name__ == "__main__":
    import sys
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = [a for a in sys.argv[1:] if a != "--check"]
    raise SystemExit(check(args[0] if args else "ko"))
