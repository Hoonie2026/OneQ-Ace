"""OCR 엔진 비교(🖥P5, PREP-PLAN-v0.5 B1) — Tesseract / Windows 내장(winocr) / PaddleOCR(PP-OCRv5 한국어).

정답 파일(tests/fixtures/ocr/*-gt.json)의 쪽마다 문항 줄기·보기 글자를 얼마나 맞게 읽는지, 정답표 쪽에서
정답(가나다라 100개)을 몇 개 맞게 읽는지, 쪽당 시간을 잰다. 엔진이 없으면 그 줄만 "설치 안 됨"으로 건너뛴다.

    py -3 -m oneq_prep.ocrbench "..\\source_pdf\\철도보선기사_스캔본.pdf"
    py -3 -m oneq_prep.ocrbench <pdf> --engines tesseract,winocr --scales 1,2
    py -3 -m oneq_prep.ocrbench <pdf> --pack      (B1 실측 🖥P25: 본 경로로 문항·정답표·보기 번호)

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
        if os.environ.get("ONEQ_PADDLE_THREADS"):        # 예: 1 — 계산 스레드 수(충돌 우회 시험)
            kw["cpu_threads"] = int(os.environ["ONEQ_PADDLE_THREADS"])
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


def _tesseract_mode(img, psm: str) -> str:
    from .ocr import OcrUnavailable, tesseract_path
    try:
        exe = tesseract_path()
    except OcrUnavailable as e:
        raise Missing(str(e).splitlines()[0]) from e
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "c.png"
        img.save(p)
        r = subprocess.run([exe, str(p), "stdout", "-l", "kor", "--psm", psm], capture_output=True)
        return r.stdout.decode("utf-8", "replace")


def _tesseract_line(img) -> str:
    """한 줄(정답표 줄을 이어 붙인 그림) — psm 7. psm 3이면 덩어리로 나눠 글자를 놓침."""
    return _tesseract_mode(img, "7")


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
RUN_LINE = {"tesseract": _tesseract_line, "winocr": _winocr, "paddle": _paddle}

# ── 정답표: 칸 나눠 읽기 — 본 경로(ocr.py)로 옮김(ADR 022 4절). 여기서는 같은 함수를 쓴다 ──
from .ocr import CONFUSE, _runs, letters as _letters, strip_image as _strip, table_cells, table_rows  # noqa: E402,F401


def read_answer_cells(eng: str, img) -> str:
    """정답표: 줄마다 칸들을 한 줄 그림으로 이어 붙여 읽고(줄당 엔진 1~3번, 크기 1·0.5·0.3배 중 글자를 가장 많이 찾은 것),
    가·나·다·라가 칸 수의 절반도 안 나오면 번호 줄로 보고 건너뜀, 절반 이상인데 모자라면 그 줄만 칸마다 다시.
    비슷한 글자는 보정. 칸을 못 찾으면 ''."""
    got = []
    for row in table_rows(img):
        best: list[str] = []
        for k in (1.0, 0.5, 0.3):
            ls = _letters(RUN_LINE[eng](_strip(row, k)))
            if len(ls) > len(best):
                best = ls
            if len(best) >= len(row):
                break
        if len(best) * 2 < len(row):
            continue                                   # 번호 줄(숫자)·빈 줄
        if len(best) != len(row):
            best = []
            for c in row:
                one = _letters(RUN_CHAR[eng](c))
                best.append(one[0] if one else "?")
        got += best
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


RAILTRACK_2010 = {   # B1 실측용 임시 프로필(표본 2010년 2회의 5과목 — 큐넷 현행 기준과 다를 수 있어 저장하지 않음)
    "code": "RAILTRACK", "name": "철도보선기사", "grade": "기사", "version": "B1 실측용",
    "passRule": {"subjectMin": 40, "avgMin": 60},
    "subjects": [{"name": n, "count": 20} for n in ("철도공학", "측량학", "응용역학", "건설재료 및 시공", "철도보선관계법규")],
    "aliases": {}, "excluded": []}


def pack_measure(pdf_path: Path, gt: dict, out_dir: Path, log=print) -> dict:
    """B1 실측(🖥P25): 본 경로(pack.prepare)로 스캔본을 처리해 문항 찾기·정답표·보기 번호를 정답과 맞춘다.
    out_dir에 문항 그림(q###.webp)·막히는 문제 목록·요약 JSON — Claude가 PC 연결로 읽는다."""
    import shutil
    from . import ocr
    from . import standards as S
    from .pack import prepare
    home = out_dir / "_home"
    (home / "standards").mkdir(parents=True, exist_ok=True)
    (home / "standards" / "RAILTRACK.json").write_text(json.dumps(RAILTRACK_2010, ensure_ascii=False), encoding="utf-8")
    old = os.environ.get("ONEQ_PREP_HOME")
    os.environ["ONEQ_PREP_HOME"] = str(home)
    try:
        engine = ocr.pick_engine()
        t0 = time.perf_counter()
        pr = prepare(pdf_path, S.load("RAILTRACK"), out_dir / "_work", log=lambda *a: None)
        sec = time.perf_counter() - t0
    finally:
        if old is None:
            os.environ.pop("ONEQ_PREP_HOME", None)
        else:
            os.environ["ONEQ_PREP_HOME"] = old
        shutil.rmtree(home, ignore_errors=True)
    key = gt["answers"]
    wrong = [it.no for it in pr.items if it.answer != LABELS.index(key[it.no - 1]) + 1]
    short = [it.no for it in pr.items if any(w.startswith("OCR: 보기") for w in it.warnings)]
    for it in pr.items:
        (out_dir / f"q{it.no:03d}.webp").write_bytes(it.image)
    res = {"engine": engine, "sec": round(sec, 1), "packId": pr.pack_id, "exam": pr.exam,
           "found": len(pr.items), "missing": [n for n, _ in pr.missing], "answer_wrong": wrong,
           "choices_short": short, "issues": pr.issues, "notes": pr.notes,
           "texts": {it.no: it.text for it in pr.items}}
    (out_dir / "pack-결과.json").write_text(json.dumps(res, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"엔진 {ocr.ENGINE_NAMES.get(engine, engine)} · {sec:.0f}초 · 팩 이름 {pr.pack_id}")
    log(f"문항 {len(pr.items)}/100 찾음 · 못 찾음 {res['missing'] or '없음'}")
    log(f"정답(정답표) 맞음 {len(pr.items) - len(wrong)}/{len(pr.items)}" + (f" · 틀림 {wrong}" if wrong else ""))
    log(f"보기 가나다라 4개 다 찾음 {len(pr.items) - len(short)}/{len(pr.items)}")
    log(f"막히는 문제 {len(pr.issues)}건 — 자세한 것: {out_dir / 'pack-결과.json'}")
    return res


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
    ap.add_argument("--pack", action="store_true", help="B1 실측: 본 경로로 팩 준비까지(🖥P25) — 엔진 비교 대신")
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
    if a.pack:
        pack_measure(a.pdf, gt, out / "pack")
        return 0
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
