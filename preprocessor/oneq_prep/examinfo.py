"""문서 내용에서 종목·시행일·회차·출처 읽기(ADR 021 2절·6절, PREP-PLAN-v0.5 B2). 파일 이름은 쓰지 않는다.

읽는 곳: 첫 쪽 위쪽 글(머리말)과 마지막 쪽 끝(꼬리말). 글자가 없는 스캔본은 OCR 글(ocr_text)을 받는다.
- comcbt: "건설안전기사 ◐ 2020년 06월 06일 필기 기출문제 ◑ 전자문제집 CBT : www.comcbt.com" → 시행일, 출처 comcbt
- 한솔 경향문제: "24토목기사 … 3회 필기 경향문제 … 2024년3회CBT 대비" → 연도·회차(시행일 없음), 출처 한솔아카데미(자체 개발 유형문제)
- 그 밖: "YYYY년 MM월 DD일", "YYYY.MM.DD", "YYYY년(도) (제)N회"

회차: 문서에 "N회"가 있으면 그것, 없으면 시행월로 — 기사 정기시험은 해마다 3번(3월 1회 · 4~6월 2회 · 7월 이후 3회),
2020년은 코로나로 1·2회 통합(6월) · 3회(8월) · 4회(9월). 2003~2022 기출 시행일 모두와 맞음(지금까지 만든 팩 회차와 같음).
시행일·연도를 못 찾으면 "0000년 nn회"(nn = 같은 종목에서 올린 순서, 출력 폴더에 기록해 다시 처리해도 같은 번호).
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import standards as S

DATE_KO = re.compile(r"(19\d{2}|20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일")
DATE_DOT = re.compile(r"(?<!\d)(19\d{2}|20\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?!\d)")
YEAR_ROUND = re.compile(r"(19\d{2}|20\d{2})\s*년\s*(?:도\s*)?(?:제\s*)?(\d)\s*회")
YY_CERT_ROUND = re.compile(r"(?<!\d)(\d{2})\s*([가-힣()·]+?(?:기사|산업기사|기능사|기술사|기능장))\D{0,40}?(\d)\s*회")
ROUND_ONLY = re.compile(r"(?:제\s*)?(\d)\s*회\s*(?:필기|기출|시험|CBT)")


@dataclass
class ExamInfo:
    cert_name: str = ""            # 문서에 적힌 종목명(못 찾으면 "")
    year: int | None = None
    round: int | None = None
    date: str | None = None        # YYYY-MM-DD(못 찾으면 None)
    round_label: str | None = None
    source_type: str = "other"     # public-pbt / recalled / other (팩 manifest.source.type)
    origin: str = "직접 올림"
    note: str = ""
    evidence: list[str] = field(default_factory=list)   # 무엇을 보고 정했는지(결과 화면·보고서용)


def _text(pdf_path: Path) -> tuple[str, str]:
    import pdfplumber
    try:
        with pdfplumber.open(str(pdf_path)) as pdf:
            if not pdf.pages:
                return "", ""
            p0 = pdf.pages[0]
            head = p0.crop((0, 0, p0.width, p0.height * 0.35)).extract_text() or ""
            tail = pdf.pages[-1].extract_text() or ""
            return head, tail[-400:]
    except Exception as e:
        raise ValueError(f"PDF를 열 수 없습니다: {Path(pdf_path).name}") from e


def known_cert_names() -> list[str]:
    from .certs import SEED
    names = set(SEED)
    for code in S.available():
        try:
            names.add(S.load(code).name)
        except Exception:
            pass
    return sorted(names, key=len, reverse=True)


def _find_cert(text: str, names: list[str]) -> str:
    flat = re.sub(r"\s+", "", text)
    for n in names:                                   # 긴 이름 먼저("철도토목기사"가 "토목기사"보다 먼저)
        if re.sub(r"\s+", "", n) in flat:
            return n
    return ""


def round_from_date(date: str) -> tuple[int, str | None]:
    y, m = int(date[:4]), int(date[5:7])
    if y == 2020:
        if m <= 6:
            return 1, "1·2회 통합"
        return (3, None) if m <= 8 else (4, None)
    if m <= 3:
        return 1, None
    if m <= 6:
        return 2, None
    return 3, None


def read(pdf_path: Path, ocr_text: str | None = None, names: list[str] | None = None) -> ExamInfo:
    head, tail = _text(pdf_path)
    if not head.strip() and ocr_text:
        head, tail = ocr_text[:1500], ocr_text[-400:]
    info = ExamInfo()
    alltxt = head + "\n" + tail
    info.cert_name = _find_cert(head, names or known_cert_names())

    low = alltxt.lower()
    if "comcbt" in low:
        info.source_type, info.origin = "public-pbt", "comcbt (www.comcbt.com)"
        info.evidence.append("출처: 머리말·꼬리말의 comcbt")
    elif "한솔" in alltxt:
        info.origin = "한솔아카데미"
        info.evidence.append("출처: 꼬리말의 한솔아카데미")
    if re.search(r"경향문제|자체\s*개발|예상문제|유형문제", alltxt):
        info.source_type = "other"
        info.note = "기출이 아니라 출제 경향을 반영해 만든 유형문제"
    elif re.search(r"복원", alltxt) and info.source_type != "public-pbt":
        info.source_type = "recalled"

    if m := (DATE_KO.search(head) or DATE_DOT.search(head)):
        y, mo, d = (int(x) for x in m.groups())
        if 1 <= mo <= 12 and 1 <= d <= 31:
            info.date = f"{y:04d}-{mo:02d}-{d:02d}"
            info.year = y
            info.evidence.append(f"시행일: '{m.group(0)}'")
    if m := YEAR_ROUND.search(re.sub(r"\s+", "", head)):
        info.year = info.year or int(m.group(1))
        info.round = int(m.group(2))
        info.evidence.append(f"회차: '{m.group(0)}'")
    elif m := YY_CERT_ROUND.search(head):
        info.year = info.year or 2000 + int(m.group(1))
        info.round = int(m.group(3))
        info.evidence.append(f"연도·회차: '{m.group(1)}…{m.group(3)}회'")
    elif info.year and (m := ROUND_ONLY.search(head)):
        info.round = int(m.group(1))
        info.evidence.append(f"회차: '{m.group(0)}'")
    if info.round is None and info.date:
        info.round, info.round_label = round_from_date(info.date)
        info.evidence.append("회차: 시행월로 정함")
    elif info.date and info.date.startswith("2020") and info.round in (1, 2):
        info.round, info.round_label = 1, "1·2회 통합"
    return info


# ───────────────────────── 시행일 모름: 0000년 nn회 ─────────────────────────

UNKNOWN_FILE = "unknown-dates.json"


def file_key(pdf_path: Path) -> str:
    return hashlib.sha256(Path(pdf_path).read_bytes()).hexdigest()[:16]


def unknown_round(out_dir: Path, cert_code: str, pdf_path: Path, reserve: bool = True) -> int:
    """시행일·연도를 못 찾은 파일의 nn — 같은 파일(내용 해시)은 늘 같은 번호, 새 파일은 다음 번호."""
    p = Path(out_dir) / "review" / UNKNOWN_FILE
    try:
        reg = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        reg = {}
    mine = reg.setdefault(cert_code, {})
    key = file_key(pdf_path)
    if key in mine:
        return int(mine[key]["round"])
    nn = max([int(v["round"]) for v in mine.values()] + [0]) + 1
    if nn > 99:
        raise ValueError("시행일 모름 회차가 99개를 넘음")
    if reserve:
        mine[key] = {"round": nn, "file": Path(pdf_path).name}
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(reg, ensure_ascii=False, indent=1), encoding="utf-8")
    return nn


def exam_of(pdf_path: Path, profile: S.Profile, out_dir: Path, date: str | None = None, round_no: int | None = None,
            info: ExamInfo | None = None) -> tuple[dict, ExamInfo]:
    """팩 manifest.exam. date·round_no는 명령줄에서 사람이 준 값(내용보다 우선)."""
    info = info or read(pdf_path)
    if date:
        info.date, info.year = date, int(date[:4])
        info.evidence.append("시행일: 직접 입력")
        if info.round is None:
            info.round, info.round_label = round_from_date(date)
    if round_no:
        info.round, info.round_label = round_no, None
    if info.year and info.round:
        exam = {"year": info.year, "round": info.round, "date": info.date or f"{info.year:04d}-00-00"}
        if info.round_label:
            exam["roundLabel"] = info.round_label
        if not info.date:
            exam["dateUnknown"] = True
        return exam, info
    nn = unknown_round(out_dir, profile.code, pdf_path)
    info.evidence.append(f"시행일을 못 찾아 0000년 {nn}회로 지정")
    return {"year": 0, "round": nn, "date": "0000-00-00", "dateUnknown": True}, info


def pack_id(code: str, exam: dict) -> str:
    return f"{code}-{exam['year']:04d}-{exam['round']}"
