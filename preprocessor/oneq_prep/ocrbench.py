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
        # enable_mkldnn=False: PaddlePaddle 3.3 + CPU 가속(oneDNN)이 "ConvertPirAttribute2RuntimeAttribute not support"로
        # 멈추는 알려진 문제 우회(2026-11-11 사용자 PC). 그래도 안 되면 pip install paddlepaddle==3.2.2
        kw = {}
        if os.environ.get("ONEQ_PADDLE_DET"):          # 예: PP-OCRv5_mobile_det(가벼운 글자 찾기 모델)
            kw["text_detection_model_name"] = os.environ["ONEQ_PADDLE_DET"]
        if os.environ.get("ONEQ_PADDLE_MKLDNN") != "1":
            kw["enable_mkldnn"] = False
        print("  paddle: 모델 불러오는 중", kw, flush=True)
        _PADDLE = PaddleOCR(lang="korean", use_doc_orientation_classify=False, use_doc_unwarping=False,
                            use_textline_orientation=False, **kw)
        print("  paddle: 모델 준비됨 — 글자 읽기 시작", flush=True)
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


def _tesseract_char(img) -> str:
    """칸 하나(글자 하나) — psm 10."""
    from .ocr import OcrUnavailable, tesseract_path
    try:
        exe = tesseract_path()
    except OcrUnavailable as e:
        raise Missing(str(e).splitlines()[0]) from e
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "c.png"
        img.save(p)
        r = subprocess.run([exe, str(p), "stdout", "-l", "kor", "--psm", "10"], capture_output=True)
        return r.stdout.decode("utf-8", "replace")


RUN = {"tesseract": _tesseract, "winocr": _winocr, "paddle": _paddle}
RUN_CHAR = {"tesseract": _tesseract_char, "winocr": _winocr, "paddle": _paddle}

# ── 정답표: 표를 칸으로 잘라 칸마다 읽기(2026-11-11 — 쪽 통째로는 세 엔진 모두 낱자를 거의 건너뜀, 9/100 이하) ──
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


def table_cells(img) -> list:
    """격자 표 → 칸 그림(왼→오, 위→아래, 한 줄로 펼침). 칸이 아니면 []."""
    return [c for row in table_rows(img) for c in row]


def table_rows(img) -> list[list]:
    """격자 표 → 줄마다 칸 그림 목록. 가로선·색칠한 줄(번호 줄)과 세로선으로 자른다. 칸이 아니면 []."""
    import numpy as np
    from PIL import Image
    a = np.asarray(img.convert("L")).astype(int)
    h, w = a.shape
    ink = a < 240
    line_rows = ink.mean(1) > 0.6           # 가로선 또는 색칠한 줄(번호 줄)
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
        out.append(line)
        for x0, x1 in cols:
            c = img.convert("L").crop((x0, y0 + 2, x1, y1 - 2)).point(lambda v: 0 if v < 200 else 255)
            if c.getbbox() is None or not any(px == 0 for px in c.getdata()):
                continue                      # 빈 칸
            k = 120 / max(1, c.height)
            c = c.resize((max(1, int(c.width * k)), 120), Image.LANCZOS)
            pad = Image.new("L", (c.width + 80, c.height + 80), 255)
            pad.paste(c, (40, 40))
            line.append(pad)
    return [ln for ln in out if ln]


def _strip(cells: list):
    """한 줄의 칸들을 띄어서 한 줄 그림으로 — Windows 내장 OCR은 낱자 하나짜리 그림을 읽지 않는다(2026-11-11 PC 5/100)."""
    from PIL import Image
    gap = 60
    w = sum(c.width for c in cells) + gap * (len(cells) + 1)
    h = max(c.height for c in cells)
    im = Image.new("L", (w, h), 255)
    x = gap
    for c in cells:
        im.paste(c, (x, (h - c.height) // 2))
        x += c.width + gap
    return im


def _letters(t: str) -> list[str]:
    out = []
    for x in re.sub(r"[\s.,·:;|]+", "", t):
        if x in LABELS:
            out.append(x)
        elif x in CONFUSE:
            out.append(CONFUSE[x])
    return out


def read_answer_cells(eng: str, img) -> str:
    """정답표: 줄마다 칸들을 한 줄 그림으로 이어 붙여 읽고(줄당 엔진 1번), 글자 수가 칸 수와 다르면 그 줄만 칸마다 다시.
    가·나·다·라만(비슷한 글자는 보정), 번호 줄(숫자)은 건너뜀. 칸을 못 찾으면 ''."""
    got = []
    for row in table_rows(img):
        t = re.sub(r"\s+", " ", RUN[eng](_strip(row)))
        if re.fullmatch(r"[0-9 ]+", t.strip()):
            continue
        ls = _letters(t)
        if len(ls) != len(row):
            ls = []
            for c in row:
                one = _letters(RUN_CHAR[eng](c))
                ls.append(one[0] if one else "?")
        got += ls
    return " ".join(got)


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
                        t0 = time.perf_counter()
                        cells = read_answer_cells(eng, render(pdf, ans_page, max(sc, 2.0)))
                        row["answers_cells"] = answer_score(gt["answers"], cells)
                        row["answers_cells"]["sec"] = round(time.perf_counter() - t0, 1)
                        (out_dir / f"{eng}_x{sc:g}_p{ans_page}_cells.txt").write_text(cells, encoding="utf-8")
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
    head = f"{'엔진':<10}{'배율':>5}{'글자 맞춤':>10}{'95%↑ 단위':>11}{'정답표':>10}{'칸별 정답':>10}{'쪽당 초':>9}  비고"
    lines = [head, "-" * len(head)]
    for r in rows:
        if "missing" in r or "error" in r:
            lines.append(f"{r['engine']:<10}{r['scale']:>5g}{'':>10}{'':>11}{'':>10}{'':>10}{'':>9}  "
                         + ("설치 안 됨 — " + r["missing"] if "missing" in r else "오류 — " + r["error"][:120]))
            continue
        a = r.get("answers") or {}
        ans = f"{a.get('matched', 0)}/{a.get('total', 0)}" if a else "-"
        c = r.get("answers_cells") or {}
        cel = f"{c.get('exact_position') if c.get('exact_position') is not None else c.get('matched', 0)}/{c.get('total', 0)}" if c else "-"
        lines.append(f"{r['engine']:<10}{r['scale']:>5g}{r['text_mean']*100:>9.1f}%{r['text_exact95']*100:>10.1f}%"
                     f"{ans:>10}{cel:>10}{r['sec_per_page']:>9.1f}  처음 실행 포함 {r['sec_total_incl_load']:.0f}초"
                     + (f", 칸 읽기 {c.get('sec')}초" if c else ""))
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="OCR 엔진 비교(🖥P5)")
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--gt", type=Path, help="정답 파일(기본: tests/fixtures/ocr/ 에서 PDF 이름으로 찾음)")
    ap.add_argument("--engines", default=",".join(ENGINES))
    ap.add_argument("--scales", default="1,2", help="렌더 배율(이 표본은 1배 ≈ 120dpi, 2.5배 ≈ 300dpi)")
    ap.add_argument("--out", type=Path, help="결과 폴더(기본: PDF 폴더\\_ocrbench)")
    ap.add_argument("--one", help=argparse.SUPPRESS)
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
    out.mkdir(parents=True, exist_ok=True)
    engines = [e.strip() for e in a.engines.split(",") if e.strip()]
    scales = [float(x) for x in a.scales.split(",")]
    if a.one:
        # 자식 프로세스: 엔진 하나만 재고 결과를 파일로(엔진이 프로세스째 죽어도 부모는 다른 엔진 결과를 지킴)
        rows = bench(a.pdf, gt, engines, scales, out)
        Path(a.one).write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")
        return 0
    rows = []
    for eng in engines:
        part = out / f"_{eng}.json"
        part.unlink(missing_ok=True)
        cmd = [sys.executable, "-X", "faulthandler", "-m", "oneq_prep.ocrbench", str(a.pdf), "--engines", eng, "--scales", a.scales,
               "--out", str(out), "--one", str(part)] + (["--gt", str(gt_path)] if a.gt else [])
        r = subprocess.run(cmd, cwd=str(Path(__file__).resolve().parents[1]), stderr=subprocess.PIPE)
        err = r.stderr.decode("utf-8", "replace")
        if r.returncode != 0 and err:
            (out / f"_{eng}_오류기록.txt").write_text(err, encoding="utf-8")   # 프로세스째 죽은 위치(faulthandler)
        if part.exists():
            rows += json.loads(part.read_text(encoding="utf-8"))
            part.unlink()
        else:
            hint = f" — 기록: _{eng}_오류기록.txt" if err else ""
            rows.append({"engine": eng, "scale": scales[0], "error": f"프로그램이 비정상 종료(코드 {r.returncode}){hint}"})
        (out / "결과.json").write_text(json.dumps({"pdf": a.pdf.name, "rows": rows}, ensure_ascii=False, indent=1),
                                     encoding="utf-8")
    print()
    print(table(rows))
    print(f"\n자세한 결과: {out / '결과.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
