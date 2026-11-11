"""OCR 엔진 비교(🖥P5, PREP-PLAN-v0.5 B1) — Tesseract / Windows 내장(winocr) / PaddleOCR(PP-OCRv5 한국어).

정답 파일(tests/fixtures/ocr/*-gt.json)의 쪽마다 문항 줄기·보기 글자를 얼마나 맞게 읽는지, 정답표 쪽에서
정답(가나다라 100개)을 몇 개 맞게 읽는지, 쪽당 시간을 잰다. 엔진이 없으면 그 줄만 "설치 안 됨"으로 건너뛴다.

    py -3 -m oneq_prep.ocrbench "..\\source_pdf\\철도보선기사_스캔본.pdf"
    py -3 -m oneq_prep.ocrbench <pdf> --engines tesseract,winocr --scales 1,2

결과: 표(화면) + <PDF 폴더>\\_ocrbench\\결과.json, 엔진·배율별 읽은 글자(.txt) — Claude가 PC 연결로 읽는다.
글자 맞춤 점수는 순서·띄어쓰기를 무시한 부분 정렬(두 단 배치를 엔진마다 다른 순서로 읽어도 공정하게).
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pypdfium2 as pdfium

GT_DIR = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "ocr"
ENGINES = ("tesseract", "winocr", "paddle")
LABELS = "가나다라"


# ── 점수 ──
def _squash(s: str) -> str:
    return re.sub(r"\s+", "", s)


def partial_score(unit: str, text: str) -> float:
    """정답 한 단위가 OCR 글자 안 어딘가에 얼마나 맞게 들어 있는지(0~1). 순서·띄어쓰기 무시."""
    u, t = _squash(unit), _squash(text)
    if not u:
        return 1.0
    if not t:
        return 0.0
    try:
        from rapidfuzz import fuzz
        return fuzz.partial_ratio(u, t) / 100
    except ImportError:
        n, best = len(u), 0.0
        step = max(1, n // 4)
        for i in range(0, max(1, len(t) - n + 1), step):
            r = difflib.SequenceMatcher(None, u, t[i:i + n + n // 5], autojunk=False).ratio()
            if r > best:
                best = r
                if best == 1.0:
                    break
        return best


def text_scores(units: list[str], text: str) -> dict:
    s = [partial_score(u, text) for u in units]
    return {"mean": sum(s) / len(s), "exact95": sum(x >= 0.95 for x in s) / len(s), "worst": sorted(zip(s, units))[:5]}


def answer_score(key: str, text: str) -> dict:
    """정답표 쪽: 낱자 가·나·다·라만 읽는 순서대로 뽑아 정답 100개와 맞춘다."""
    got = [t for t in re.findall(r"(?<![가-힣])[가나다라](?![가-힣])", text)]
    sm = difflib.SequenceMatcher(None, list(key), got, autojunk=False)
    matched = sum(b.size for b in sm.get_matching_blocks())
    exact = sum(a == b for a, b in zip(key, got)) if len(got) == len(key) else None
    return {"found": len(got), "matched": matched, "total": len(key), "exact_position": exact}


# ── 엔진 ──
class Missing(RuntimeError):
    pass


def _tesseract(img) -> str:
    from .ocr import OcrUnavailable, tesseract_path
    try:
        exe = tesseract_path()
    except OcrUnavailable as e:
        raise Missing(str(e).splitlines()[0]) from e
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "p.png"
        img.save(p)
        r = subprocess.run([exe, str(p), "stdout", "-l", "kor", "--psm", "3"], capture_output=True)
        if r.returncode != 0:
            raise Missing(r.stderr.decode("utf-8", "replace").strip().splitlines()[-1])
        return r.stdout.decode("utf-8", "replace")


def _winocr(img) -> str:
    if os.name != "nt":
        raise Missing("Windows 내장 OCR은 Windows에서만")
    try:
        import winocr
    except ImportError as e:
        raise Missing("py -3 -m pip install winocr") from e
    r = winocr.recognize_pil_sync(img.convert("RGBA"), "ko")
    lines = r.get("lines") if isinstance(r, dict) else None
    if lines:
        return "\n".join(ln.get("text", "") for ln in lines)
    return r.get("text", "") if isinstance(r, dict) else str(r)


_PADDLE = None


def _paddle(img) -> str:
    global _PADDLE
    try:
        import numpy as np
        from paddleocr import PaddleOCR
    except ImportError as e:
        raise Missing("py -3 -m pip install paddlepaddle paddleocr") from e
    if _PADDLE is None:
        _PADDLE = PaddleOCR(lang="korean", use_doc_orientation_classify=False, use_doc_unwarping=False,
                            use_textline_orientation=False)
    res = _PADDLE.predict(np.array(img.convert("RGB")))
    out = []
    for r in res:
        texts = None
        try:
            texts = r["rec_texts"]
        except (KeyError, TypeError):
            texts = (getattr(r, "json", {}) or {}).get("res", {}).get("rec_texts")
        out.extend(texts or [])
    return "\n".join(out)


RUN = {"tesseract": _tesseract, "winocr": _winocr, "paddle": _paddle}


def render(pdf, page_no: int, scale: float):
    page = pdf[page_no - 1]
    return page.render(scale=scale).to_pil().convert("L")


def bench(pdf_path: Path, gt: dict, engines: list[str], scales: list[float], out_dir: Path, log=print) -> list[dict]:
    pdf = pdfium.PdfDocument(str(pdf_path))
    pages = sorted(int(p) for p in gt["pages"])
    ans_page = gt.get("answer_page")
    rows = []
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        for eng in engines:
            for sc in scales:
                row = {"engine": eng, "scale": sc}
                try:
                    t_first = time.perf_counter()
                    times, units_all, scores = [], [], []
                    texts = {}
                    for p in pages + ([ans_page] if ans_page else []):
                        img = render(pdf, p, sc if p != ans_page else max(sc, 2.0))
                        t0 = time.perf_counter()
                        texts[p] = RUN[eng](img)
                        times.append(time.perf_counter() - t0)
                        log(f"  {eng} ×{sc:g} {p}쪽 {times[-1]:.1f}초")
                    for p in pages:
                        ts = text_scores(gt["pages"][str(p)], texts[p])
                        scores.append(ts)
                        units_all += gt["pages"][str(p)]
                    n = sum(len(gt["pages"][str(p)]) for p in pages)
                    row["text_mean"] = sum(s["mean"] * len(gt["pages"][str(p)]) for s, p in zip(scores, pages)) / n
                    row["text_exact95"] = sum(s["exact95"] * len(gt["pages"][str(p)]) for s, p in zip(scores, pages)) / n
                    row["worst"] = [w for s in scores for w in s["worst"]][:6]
                    if ans_page:
                        row["answers"] = answer_score(gt["answers"], texts[ans_page])
                    row["sec_per_page"] = sum(times[:len(pages)]) / len(pages)
                    row["sec_total_incl_load"] = time.perf_counter() - t_first
                    for p, t in texts.items():
                        (out_dir / f"{eng}_x{sc:g}_p{p}.txt").write_text(t, encoding="utf-8")
                except Missing as e:
                    row["missing"] = str(e)
                except Exception as e:  # noqa: BLE001 — 한 엔진이 실패해도 나머지는 잰다
                    msg = f"{type(e).__name__}: {e}"
                    if "model hosting" in msg or "download" in msg.lower():
                        msg = ("모델을 받지 못함(회사망 차단?) — PowerShell에서 $env:PADDLE_PDX_MODEL_SOURCE=\"bos\" "
                               "(안 되면 \"modelscope\", \"aistudio\") 넣고 다시 실행. 원문: " + msg[:160])
                    row["error"] = msg
                rows.append(row)
                if "missing" in row or "error" in row:
                    break           # 설치 안 됐거나 실패한 엔진은 다른 배율도 건너뜀(같은 이유로 실패)
    finally:
        pdf.close()
    return rows


def table(rows: list[dict]) -> str:
    head = f"{'엔진':<10}{'배율':>5}{'글자 맞춤':>10}{'95%↑ 단위':>11}{'정답표':>10}{'쪽당 초':>9}  비고"
    lines = [head, "-" * len(head)]
    for r in rows:
        if "missing" in r or "error" in r:
            lines.append(f"{r['engine']:<10}{r['scale']:>5g}{'':>10}{'':>11}{'':>10}{'':>9}  "
                         + ("설치 안 됨 — " + r["missing"] if "missing" in r else "오류 — " + r["error"][:120]))
            continue
        a = r.get("answers") or {}
        ans = f"{a.get('matched', 0)}/{a.get('total', 0)}" if a else "-"
        lines.append(f"{r['engine']:<10}{r['scale']:>5g}{r['text_mean']*100:>9.1f}%{r['text_exact95']*100:>10.1f}%"
                     f"{ans:>10}{r['sec_per_page']:>9.1f}  처음 실행 포함 {r['sec_total_incl_load']:.0f}초")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="OCR 엔진 비교(🖥P5)")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--gt", type=Path, help="정답 파일(기본: tests/fixtures/ocr/ 에서 PDF 이름으로 찾음)")
    ap.add_argument("--engines", default=",".join(ENGINES))
    ap.add_argument("--scales", default="1,2", help="렌더 배율(이 표본은 1배 ≈ 120dpi, 2.5배 ≈ 300dpi)")
    ap.add_argument("--out", type=Path, help="결과 폴더(기본: PDF 폴더\\_ocrbench)")
    a = ap.parse_args(argv)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    gt_path = a.gt or next((p for p in GT_DIR.glob("*-gt.json")
                            if json.loads(p.read_text(encoding="utf-8")).get("pdf") == a.pdf.name), None)
    if not gt_path:
        print(f"정답 파일을 찾지 못했습니다(--gt). 찾은 곳: {GT_DIR}")
        return 2
    gt = json.loads(gt_path.read_text(encoding="utf-8"))
    out = a.out or a.pdf.parent / "_ocrbench"
    rows = bench(a.pdf, gt, [e.strip() for e in a.engines.split(",") if e.strip()],
                 [float(x) for x in a.scales.split(",")], out)
    print()
    print(table(rows))
    (out / "결과.json").write_text(json.dumps({"pdf": a.pdf.name, "rows": rows}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n자세한 결과: {out / '결과.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
