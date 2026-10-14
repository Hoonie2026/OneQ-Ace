"""shared/fixtures/cases.json의 변경(ops)을 적용하는 도우미. TS 쪽 fixtureOps.ts와 같은 규칙."""
import copy
import hashlib
import json
from pathlib import Path

FIX = Path(__file__).resolve().parents[2] / "shared" / "fixtures"


def load_valid() -> dict[str, bytes]:
    root = FIX / "valid-pack"
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


def _walk(doc, pointer):
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.split("/")[1:]]
    cur = doc
    for p in parts[:-1]:
        cur = cur[int(p)] if isinstance(cur, list) else cur[p]
    last = parts[-1]
    return cur, (int(last) if isinstance(cur, list) else last)


def apply_case(files: dict[str, bytes], case: dict) -> dict[str, bytes]:
    files = dict(files)
    edited_json = set()
    for op in case["ops"]:
        f = op["file"]
        kind = op["op"]
        if kind in ("set", "delete"):
            doc = json.loads(files[f])
            parent, key = _walk(doc, op["pointer"])
            if kind == "set":
                if isinstance(parent, list) and key == len(parent):
                    parent.append(copy.deepcopy(op["value"]))
                else:
                    parent[key] = copy.deepcopy(op["value"])
            else:
                del parent[key]
            files[f] = json.dumps(doc, ensure_ascii=False, indent=1).encode("utf-8")
            edited_json.add(f)
        elif kind == "removeFile":
            files.pop(f, None)
        elif kind == "addFile":
            files[f] = op["text"].encode("utf-8")
        elif kind == "corrupt":
            files[f] = files[f] + b"\x00"
        elif kind == "replaceText":
            files[f] = op["text"].encode("utf-8")
        else:
            raise ValueError(kind)
    if case.get("rehash", True) and edited_json - {"manifest.json"} and "manifest.json" in files:
        m = json.loads(files["manifest.json"])
        for entry in m.get("files", []):
            if entry["path"] in edited_json:
                b = files[entry["path"]]
                entry["sha256"] = hashlib.sha256(b).hexdigest()
                entry["bytes"] = len(b)
        files["manifest.json"] = json.dumps(m, ensure_ascii=False, indent=1).encode("utf-8")
    return files
