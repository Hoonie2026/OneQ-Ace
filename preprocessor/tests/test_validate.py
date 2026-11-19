import io
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fixture_ops import FIX, apply_case, load_valid  # noqa: E402
from oneq_prep.validate import validate_files  # noqa: E402

CASES = json.loads((FIX / "cases.json").read_text(encoding="utf-8"))["cases"]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_shared_cases(case):
    files = apply_case(load_valid(), case)
    codes = sorted({i.code for i in validate_files(files)})
    assert codes == sorted(case["expect"]), [str(i) for i in validate_files(files)]


def test_deep_image_size():
    files = load_valid()
    q = json.loads(files["questions.json"])
    case = {"ops": [{"op": "set", "file": "questions.json", "pointer": "/0/imgSize", "value": [10, 10]}]}
    files = apply_case(files, case)
    assert validate_files(files) == []                       # 기본 검사는 이미지를 열지 않음
    assert {i.code for i in validate_files(files, deep=True)} == {"IMAGE"}
    assert q[0]["imgSize"] != [10, 10]
