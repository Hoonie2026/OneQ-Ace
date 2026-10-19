"""스캔본(텍스트층 없는 PDF) 경로 — Tesseract OCR로 글자 좌표를 만들어 extract.analyze()에 넘긴다.

- Tesseract(kor)는 선택 설치다. 없으면 `OcrUnavailable`로 멈추고 설치 방법을 알려 준다.
  Windows: UB Mannheim 설치본 + kor.traineddata. 경로는 PATH 또는 환경변수 ONEQ_TESSERACT.
- OCR은 보기 원문자(①~④)를 잘 못 읽는다("@", "(3)", "00" 등). 그래서 **줄 첫머리나 넓은 간격 뒤의
  짧은 기호 토큰**을 보기 번호 자리로 보고 '①' 자리표로 바꾼다. 번호(1~4)는 문항 안 순서로 다시 매긴다.
- 정답은 ① 채운 원문자처럼 진하게 칠한 보기 번호(픽셀 잉크 비율) 또는 ② 검수 파일의 수동 입력에서 얻는다.
  OCR 팩의 문항은 모두 `ocr`·`needs-review` 표시를 단다.
"""
from __future__ import annotations

import csv
import io
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import pdfplumber
import pypdfium2 as pdfium

OCR_SCALE = 300 / 72          # 300dpi
LABELISH = re.compile(r"^(\(?[0-9OoQ]{1,2}\)?|[@®©◎⑩]|[①-⑤❶-❺]|\(\w\))$")
QNUM_TOKEN = re.compile(r"^\d{1,3}\.$")


class OcrUnavailable(RuntimeError):
    pass


def tesseract_path() -> str:
    p = os.environ.get("ONEQ_TESSERACT") or shutil.which("tesseract")
    if not p:
        for cand in (r"C:\Program Files\Tesseract-OCR\tesseract.exe", r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe"):
            if Path(cand).exists():
                return cand
        raise OcrUnavailable(
            "스캔본(텍스트층 없음)이라 OCR이 필요한데 Tesseract를 찾지 못했습니다.\n"
            "  설치: https://github.com/UB-Mannheim/tesseract/wiki (설치 중 Korean 언어 선택)\n"
            "  설치 후 PATH에 넣거나 환경변수 ONEQ_TESSERACT=...\\tesseract.exe 로 지정")
    return p


def needs_ocr(path: str | Path, min_chars: int = 50) -> bool:
    """텍스트층 글자가 거의 없으면 스캔본으로 본다."""
    with pdfplumber.open(path) as pdf:
        n = sum(len(p.chars) for p in pdf.pages[:3])
    return n < min_chars


def _tsv(img, exe: str, lang: str) -> list[dict]:
    with tempfile.TemporaryDirectory() as d:
        src = Path(d) / "p.png"
        img.save(src)
        out = subprocess.run([exe, str(src), "stdout", "-l", lang, "--psm", "3", "tsv"],
                             capture_output=True, check=False)
        if out.returncode != 0:
            msg = out.stderr.decode("utf-8", "replace")
            if "kor" in msg or "language" in msg.lower():
                raise OcrUnavailable("Tesseract 한국어 데이터(kor.traineddata)가 없습니다. 설치 때 Korean을 선택하세요.\n" + msg)
            raise OcrUnavailable(msg)
    rows = csv.DictReader(io.StringIO(out.stdout.decode("utf-8", "replace")), delimiter="\t", quoting=csv.QUOTE_NONE)
    return [r for r in rows if r.get("level") == "5" and (r.get("text") or "").strip()]


def _char(text, x0, x1, top, bottom):
    return {"text": text, "x0": x0, "x1": x1, "top": top, "bottom": bottom, "size": bottom - top,
            "upright": True, "object_type": "char"}


def words_to_chars(words: list[dict], scale: float = OCR_SCALE) -> list[dict]:
    """Tesseract 단어(px) → pdfplumber 글자 사전 목록(pt). 같은 OCR 줄의 글자는 top을 맞춘다."""
    lines: dict[tuple, list[dict]] = {}
    for w in words:
        lines.setdefault((w["block_num"], w["par_num"], w["line_num"]), []).append(w)
    chars: list[dict] = []
    for ws in lines.values():
        ws.sort(key=lambda w: int(w["left"]))
        top = min(int(w["top"]) for w in ws) / scale
        bottom = max(int(w["top"]) + int(w["height"]) for w in ws) / scale
        prev_x1 = None
        avg_h = sum(int(w["height"]) for w in ws) / len(ws)
        for j, w in enumerate(ws):
            t = w["text"].strip()
            nxt = ws[j + 1]["text"] if j + 1 < len(ws) else ""
            x0 = int(w["left"]) / scale
            x1 = (int(w["left"]) + int(w["width"])) / scale
            gap_ok = prev_x1 is None or (int(w["left"]) - prev_x1 * scale) > avg_h * 0.8
            if prev_x1 is not None:
                chars.append(_char(" ", prev_x1, x0, top, bottom))
            if QNUM_TOKEN.match(t):
                step = (x1 - x0) / len(t)
                chars += [_char(c, x0 + i * step, x0 + (i + 1) * step, top, bottom) for i, c in enumerate(t)]
            elif LABELISH.match(t) and gap_ok and (x1 - x0) * scale < avg_h * 2.2 and not nxt.startswith("과"):
                # 보기 번호 자리. 실제 번호는 문항 안 순서로 다시 매긴다(extract.analyze, ocr 모드)
                c = _char("①", x0, x1, top, bottom)
                c["ocr_label"] = True
                chars.append(c)
            else:
                step = (x1 - x0) / max(1, len(t))
                chars += [_char(c, x0 + i * step, x0 + (i + 1) * step, top, bottom) for i, c in enumerate(t)]
            prev_x1 = x1
    return chars


def ocr_pdf(path: str | Path, lang: str = "kor", progress=None) -> list[list[dict]]:
    exe = tesseract_path()
    pdf = pdfium.PdfDocument(str(path))
    try:
        out = []
        for i in range(len(pdf)):
            page = pdf[i]
            page.set_cropbox(*page.get_mediabox())     # pdfplumber와 같은 좌표계
            img = page.render(scale=OCR_SCALE).to_pil().convert("L")
            out.append(words_to_chars(_tsv(img, exe, lang)))
            if progress:
                progress(i + 1, len(pdf))
        return out
    finally:
        pdf.close()
