"""shared/fixtures/valid-pack 를 다시 만든다(직접 그린 더미 문항 3개, 실제 기출 없음).

    python preprocessor/tests/make_fixture.py
"""
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2] / "shared" / "fixtures" / "valid-pack"


def dummy_image(no: int) -> bytes:
    im = Image.new("RGB", (1080, 240 + 40 * no), "white")
    d = ImageDraw.Draw(im)
    d.rectangle((20, 20, 300, 60), outline="black", width=3)
    for k in range(4):
        y = 100 + k * 30
        d.ellipse((60, y, 80, y + 20), outline="black", width=2)
        d.line((100, y + 10, 600 - 40 * k, y + 10), fill="black", width=3)
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=60)
    return buf.getvalue()


def main():
    (ROOT / "images").mkdir(parents=True, exist_ok=True)
    files = {}
    questions = []
    spec = [(1, 1, 1, 2), (2, 1, 2, 4), (3, 2, 1, 1)]
    for no, subj, nis, ans in spec:
        img = dummy_image(no)
        path = f"images/{no:03d}.webp"
        files[path] = img
        with Image.open(io.BytesIO(img)) as im:
            size = [im.width, im.height]
        text = f"더미 문항 {no}. 다음 중 옳은 것은?\n① 가 ② 나 ③ 다 ④ 라"
        questions.append({
            "qid": f"TEST-2022-1-{no:03d}", "no": no, "subjectNo": subj, "noInSubject": nis,
            "answer": ans, "choiceCount": 4, "answerSource": "inline-mark", "answerCheck": "agree",
            "img": path, "imgSize": size, "text": text,
            "contentHash": "t:" + hashlib.sha256(text.replace(" ", "").replace("\n", "").encode()).hexdigest()[:16],
            "keywords": [], "lawRefs": [], "clusterId": None,
            "flags": ["law"] if subj == 2 else [],
        })
    qjson = json.dumps(questions, ensure_ascii=False, indent=1).encode("utf-8")
    files = {"questions.json": qjson, **files}
    manifest = {
        "format": "oqp/1", "packId": "TEST-2022-1", "packVersion": 1,
        "cert": {"code": "TEST", "name": "시험용 더미 종목", "grade": "기사"},
        "exam": {"year": 2022, "round": 1, "date": "2022-03-05"},
        "subjects": [
            {"no": 1, "name": "더미과목A", "count": 2, "isLaw": False},
            {"no": 2, "name": "더미법규", "count": 1, "isLaw": True},
        ],
        "passRule": {"subjectMin": 40, "avgMin": 60},
        "questionCount": 3,
        "source": {"type": "other", "note": "검증기 시험용 더미"},
        "preparedBy": "fixture", "reviewedAt": "2026-10-14",
        "createdAt": "2026-10-14T00:00:00+00:00", "generator": "oneq-prep 0.1.0",
        "answerMasking": {"method": ["none-needed"], "masked": 0, "leakCheck": "passed"},
        "files": [{"path": p, "sha256": hashlib.sha256(b).hexdigest(), "bytes": len(b)} for p, b in files.items()],
    }
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    for p, b in files.items():
        (ROOT / p).write_bytes(b)
    print("written", ROOT)


if __name__ == "__main__":
    main()
