"""문제팩 검증기 (Python). app/src/pack/validate.ts와 같은 규칙·같은 오류 코드를 쓴다.

규칙 원본: shared/pack-schema.json(형식) + 아래 integrity 검사(내용 정합성).
공용 시험: shared/fixtures/cases.json — 두 검증기가 같은 결과를 내야 한다.

사용 예:  python -m oneq_prep.validate oneq-SURVEY-2022-1.zip [--deep]
"""
from __future__ import annotations

import hashlib
import io
import json
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "shared" / "pack-schema.json"


@dataclass
class Issue:
    code: str
    message: str

    def __str__(self):
        return f"[{self.code}] {self.message}"


def load_schema(path: Path = SCHEMA_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _sub(schema: dict, name: str) -> dict:
    return {"$schema": schema["$schema"], "$defs": schema["$defs"], "$ref": f"#/$defs/{name}"}


def validate_files(files: dict[str, bytes], schema: dict | None = None, deep: bool = False) -> list[Issue]:
    """zip을 푼 {경로: 바이트} 사전을 검사한다. 빈 목록이면 통과."""
    schema = schema or load_schema()
    issues: list[Issue] = []

    for name in ("manifest.json", "questions.json"):
        if name not in files:
            issues.append(Issue("MISSING_FILE", f"{name} 없음"))
    if issues:
        return issues
    try:
        manifest = json.loads(files["manifest.json"].decode("utf-8"))
        questions = json.loads(files["questions.json"].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        return [Issue("JSON", f"JSON 해석 실패: {e}")]

    for label, data, defn in (("manifest", manifest, "manifest"), ("questions", questions, "questions")):
        v = Draft202012Validator(_sub(schema, defn))
        for err in sorted(v.iter_errors(data), key=lambda e: list(e.absolute_path)):
            loc = "/".join(str(p) for p in err.absolute_path)
            issues.append(Issue("SCHEMA", f"{label}/{loc}: {err.message}"))
    if issues:
        return issues   # 형식이 틀리면 정합성 검사는 의미가 없다

    # ── 정합성 ──
    if manifest["answerMasking"]["leakCheck"] != "passed":
        issues.append(Issue("LEAK_CHECK", "정답 표시 제거 검사를 통과하지 못한 팩"))

    listed = {f["path"]: f for f in manifest["files"]}
    for path, f in listed.items():
        b = files.get(path)
        if b is None:
            issues.append(Issue("MISSING_FILE", f"{path} 없음"))
        elif len(b) != f["bytes"] or hashlib.sha256(b).hexdigest() != f["sha256"]:
            issues.append(Issue("HASH_MISMATCH", f"{path} 해시·크기 불일치"))
    if "questions.json" not in listed:
        issues.append(Issue("MISSING_FILE", "manifest.files에 questions.json 없음"))
    for path in files:
        if path != "manifest.json" and path not in listed and not path.endswith("/"):
            issues.append(Issue("EXTRA_FILE", f"목록에 없는 파일: {path}"))

    pid = manifest["packId"]
    exp = f"{manifest['cert']['code']}-{manifest['exam']['year']}-{manifest['exam']['round']}"
    if pid != exp:
        issues.append(Issue("PACK_ID", f"packId {pid} ≠ 종목-연도-회차 {exp}"))

    if len(questions) != manifest["questionCount"]:
        issues.append(Issue("COUNT_MISMATCH", f"문항 {len(questions)}개 ≠ questionCount {manifest['questionCount']}"))

    seen: set[str] = set()
    for q in questions:
        if q["qid"] in seen:
            issues.append(Issue("DUP_QID", f"qid 중복: {q['qid']}"))
        seen.add(q["qid"])
        if q["qid"] != f"{pid}-{q['no']:03d}":
            issues.append(Issue("QID_FORMAT", f"{q['qid']} ≠ {pid}-{q['no']:03d}"))
        if q["answer"] > q["choiceCount"] or any(a > q["choiceCount"] or a == q["answer"] for a in q.get("acceptAlso", [])):
            issues.append(Issue("ANSWER_RANGE", f"{q['qid']}: 정답 번호가 보기 수를 벗어나거나 중복"))
        if q["img"] not in listed:
            issues.append(Issue("MISSING_FILE", f"{q['qid']}: 이미지 {q['img']}가 manifest.files에 없음"))

    nos = [q["no"] for q in questions]
    if nos != list(range(1, len(questions) + 1)):
        issues.append(Issue("NUMBERING", "문항번호가 1부터 연속하지 않음"))

    subj = {s["no"]: s for s in manifest["subjects"]}
    counts: dict[int, list[int]] = {}
    for q in questions:
        if q["subjectNo"] not in subj:
            issues.append(Issue("SUBJECT", f"{q['qid']}: 없는 과목 {q['subjectNo']}"))
        counts.setdefault(q["subjectNo"], []).append(q["noInSubject"])
    for no, s in subj.items():
        got = counts.get(no, [])
        if len(got) != s["count"]:
            issues.append(Issue("SUBJECT", f"{no}과목 문항 수 {len(got)} ≠ {s['count']}"))
        elif got != list(range(1, len(got) + 1)):
            issues.append(Issue("NUMBERING", f"{no}과목 과목 내 번호가 연속하지 않음"))

    if deep:
        from PIL import Image
        for q in questions:
            b = files.get(q["img"])
            if b is None:
                continue
            try:
                with Image.open(io.BytesIO(b)) as im:
                    if im.format != "WEBP":
                        issues.append(Issue("IMAGE", f"{q['img']}: WebP 아님({im.format})"))
                    if [im.width, im.height] != q["imgSize"]:
                        issues.append(Issue("IMAGE", f"{q['img']}: 크기 {im.size} ≠ imgSize {q['imgSize']}"))
            except Exception as e:  # noqa: BLE001
                issues.append(Issue("IMAGE", f"{q['img']}: 읽기 실패 {e}"))
    return issues


def read_zip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {n: z.read(n) for n in z.namelist() if not n.endswith("/")}


def validate_zip(path: str | Path, deep: bool = False) -> list[Issue]:
    try:
        files = read_zip(Path(path).read_bytes())
    except zipfile.BadZipFile:
        return [Issue("ZIP", "zip 파일이 아님")]
    return validate_files(files, deep=deep)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    deep = "--deep" in argv
    paths = [a for a in argv if a != "--deep"]
    bad = 0
    for p in paths:
        issues = validate_zip(p, deep=deep)
        if issues:
            bad += 1
            print(f"✗ {p}")
            for i in issues:
                print("   ", i)
        else:
            print(f"✓ {p}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
