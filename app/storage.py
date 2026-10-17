"""File-based project storage.

Layout:
    data/projects/<pid>/project.json      project meta + image index + annotations
    data/projects/<pid>/images/<iid>.<ext>
    data/projects/<pid>/thumbs/<iid>.jpg
"""
from __future__ import annotations

import json
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data" / "projects"
DATA_DIR.mkdir(parents=True, exist_ok=True)

THUMB_SIZE = 320
_lock = threading.RLock()


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _project_dir(pid: str) -> Path:
    d = (DATA_DIR / pid).resolve()
    if d.parent != DATA_DIR.resolve():
        raise KeyError(pid)
    return d


def _read(pid: str) -> dict[str, Any]:
    p = _project_dir(pid) / "project.json"
    if not p.exists():
        raise KeyError(pid)
    return json.loads(p.read_text(encoding="utf-8"))


def _write(project: dict[str, Any]) -> None:
    d = _project_dir(project["id"])
    project["updated_at"] = time.time()
    tmp = d / "project.json.tmp"
    tmp.write_text(json.dumps(project, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(d / "project.json")


# ---------------------------------------------------------------- status

def image_status(img: dict[str, Any]) -> str:
    """new -> detected -> boxes_ok -> recognized -> done"""
    if img.get("lines") is None:
        return "new"
    if not img.get("det_verified"):
        return "detected"
    if img.get("text_verified"):
        return "done"
    lines = img["lines"]
    if lines and all(l.get("text") is not None for l in lines):
        return "recognized"
    return "boxes_ok"


def summarize(project: dict[str, Any]) -> dict[str, Any]:
    out = dict(project)
    imgs = []
    counts: dict[str, int] = {}
    for img in project["images"]:
        s = image_status(img)
        counts[s] = counts.get(s, 0) + 1
        imgs.append({**img, "status": s})
    out["images"] = imgs
    out["counts"] = counts
    return out


# ---------------------------------------------------------------- projects

def list_projects() -> list[dict[str, Any]]:
    out = []
    with _lock:
        for d in sorted(DATA_DIR.iterdir()):
            if not (d / "project.json").exists():
                continue
            p = _read(d.name)
            s = summarize(p)
            out.append({
                "id": p["id"], "name": p["name"], "created_at": p["created_at"],
                "updated_at": p.get("updated_at"), "n_images": len(p["images"]),
                "counts": s["counts"],
            })
    out.sort(key=lambda p: p.get("updated_at") or 0, reverse=True)
    return out


def create_project(name: str) -> dict[str, Any]:
    pid = _new_id()
    d = DATA_DIR / pid
    (d / "images").mkdir(parents=True)
    (d / "thumbs").mkdir()
    project = {"id": pid, "name": name.strip() or "Untitled", "created_at": time.time(), "images": []}
    with _lock:
        _write(project)
    return project


def rename_project(pid: str, name: str) -> None:
    with _lock:
        p = _read(pid)
        p["name"] = name.strip() or p["name"]
        _write(p)


def delete_project(pid: str) -> None:
    with _lock:
        shutil.rmtree(_project_dir(pid), ignore_errors=True)


def get_project(pid: str) -> dict[str, Any]:
    with _lock:
        return _read(pid)


# ---------------------------------------------------------------- images

def add_image(pid: str, filename: str, data: bytes) -> dict[str, Any]:
    import io

    d = _project_dir(pid)
    iid = _new_id()
    im = Image.open(io.BytesIO(data))
    im = ImageOps.exif_transpose(im)  # bake EXIF rotation so boxes match pixels
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    ext = ".png" if filename.lower().endswith(".png") else ".jpg"
    path = d / "images" / f"{iid}{ext}"
    if ext == ".png":
        im.save(path)
    else:
        im.convert("RGB").save(path, quality=95)
    th = im.convert("RGB").copy()
    th.thumbnail((THUMB_SIZE, THUMB_SIZE))
    th.save(d / "thumbs" / f"{iid}.jpg", quality=80)

    rec = {
        "id": iid, "filename": filename, "file": path.name,
        "width": im.width, "height": im.height,
        "lines": None, "det_verified": False, "text_verified": False,
        "added_at": time.time(),
    }
    with _lock:
        p = _read(pid)
        p["images"].append(rec)
        _write(p)
    return rec


def image_path(pid: str, iid: str) -> Path:
    img = get_image(pid, iid)
    return _project_dir(pid) / "images" / img["file"]


def thumb_path(pid: str, iid: str) -> Path:
    return _project_dir(pid) / "thumbs" / f"{iid}.jpg"


def get_image(pid: str, iid: str) -> dict[str, Any]:
    with _lock:
        p = _read(pid)
    for img in p["images"]:
        if img["id"] == iid:
            return img
    raise KeyError(iid)


def update_image(pid: str, iid: str, **fields: Any) -> dict[str, Any]:
    with _lock:
        p = _read(pid)
        for img in p["images"]:
            if img["id"] == iid:
                img.update(fields)
                _write(p)
                return img
    raise KeyError(iid)


def delete_image(pid: str, iid: str) -> None:
    with _lock:
        p = _read(pid)
        keep = [i for i in p["images"] if i["id"] != iid]
        gone = [i for i in p["images"] if i["id"] == iid]
        p["images"] = keep
        _write(p)
    d = _project_dir(pid)
    for img in gone:
        (d / "images" / img["file"]).unlink(missing_ok=True)
        (d / "thumbs" / f"{iid}.jpg").unlink(missing_ok=True)


def new_line_id() -> str:
    return _new_id()[:8]
