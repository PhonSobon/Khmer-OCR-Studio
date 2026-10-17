from __future__ import annotations

import io
from typing import Any, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel

from . import engine, exporter, jobs, storage

app = FastAPI(title="Khmer OCR Studio", description="Khmer text detection & recognition dataset tool")
STATIC = storage.ROOT / "static"


def _nf(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except KeyError:
        raise HTTPException(404, "Not found")


# ---------------------------------------------------------------- projects

class ProjectIn(BaseModel):
    name: str


@app.get("/api/projects")
def list_projects():
    return storage.list_projects()


@app.post("/api/projects")
def create_project(body: ProjectIn):
    return storage.create_project(body.name)


@app.patch("/api/projects/{pid}")
def rename_project(pid: str, body: ProjectIn):
    _nf(storage.rename_project, pid, body.name)
    return {"ok": True}


@app.delete("/api/projects/{pid}")
def delete_project(pid: str):
    storage.delete_project(pid)
    return {"ok": True}


@app.get("/api/projects/{pid}")
def get_project(pid: str):
    p = _nf(storage.get_project, pid)
    out = storage.summarize(p)
    out["jobs"] = jobs.list_for(pid)
    return out


# ---------------------------------------------------------------- images

@app.post("/api/projects/{pid}/images")
async def upload_images(pid: str, files: list[UploadFile] = File(...)):
    _nf(storage.get_project, pid)
    added, failed = [], []
    for f in files:
        data = await f.read()
        try:
            added.append(storage.add_image(pid, f.filename or "image", data))
        except Exception as e:
            failed.append({"filename": f.filename, "error": str(e)})
    return {"added": added, "failed": failed}


@app.get("/api/projects/{pid}/images/{iid}/file")
def image_file(pid: str, iid: str):
    return FileResponse(_nf(storage.image_path, pid, iid), headers={"Cache-Control": "max-age=86400"})


@app.get("/api/projects/{pid}/images/{iid}/thumb")
def image_thumb(pid: str, iid: str):
    p = storage.thumb_path(pid, iid)
    if not p.exists():
        raise HTTPException(404)
    return FileResponse(p, headers={"Cache-Control": "max-age=86400"})


@app.get("/api/projects/{pid}/images/{iid}/crop")
def line_crop(pid: str, iid: str, x1: float, y1: float, x2: float, y2: float, h: int = 0):
    with Image.open(_nf(storage.image_path, pid, iid)) as im:
        crop = engine.crop_line(im.convert("RGB"), [x1, y1, x2, y2])
    if crop is None:
        raise HTTPException(400, "Empty box")
    if h and crop.height > h:
        crop = crop.resize((max(1, round(crop.width * h / crop.height)), h), Image.LANCZOS)
    buf = io.BytesIO()
    crop.save(buf, "PNG")
    return Response(buf.getvalue(), media_type="image/png", headers={"Cache-Control": "max-age=3600"})


class ImageUpdate(BaseModel):
    lines: Optional[list[dict[str, Any]]] = None
    det_verified: Optional[bool] = None
    text_verified: Optional[bool] = None


@app.put("/api/projects/{pid}/images/{iid}")
def update_image(pid: str, iid: str, body: ImageUpdate):
    fields = body.model_dump(exclude_none=True)
    if "lines" in fields:
        clean = []
        for ln in fields["lines"]:
            x1, y1, x2, y2 = (float(v) for v in ln["box"])
            clean.append({
                "id": ln.get("id") or storage.new_line_id(),
                "box": [round(min(x1, x2), 1), round(min(y1, y2), 1), round(max(x1, x2), 1), round(max(y1, y2), 1)],
                "det_conf": ln.get("det_conf"),
                "text": ln.get("text"),
                "conf": ln.get("conf"),
                "alt": ln.get("alt"),
                "ignore": bool(ln.get("ignore", False)),
            })
        fields["lines"] = clean
    img = _nf(storage.update_image, pid, iid, **fields)
    return {**img, "status": storage.image_status(img)}


@app.delete("/api/projects/{pid}/images/{iid}")
def delete_image(pid: str, iid: str):
    storage.delete_image(pid, iid)
    return {"ok": True}


class LineRecIn(BaseModel):
    box: list[float]


@app.post("/api/projects/{pid}/images/{iid}/recognize-line")
def recognize_line(pid: str, iid: str, body: LineRecIn):
    return engine.recognize_boxes(_nf(storage.image_path, pid, iid), [body.box])[0]


# ---------------------------------------------------------------- jobs

class JobIn(BaseModel):
    kind: str  # detect | recognize
    image_ids: Optional[list[str]] = None
    overwrite: bool = False
    # detect:    "new" (no boxes yet) | "unapproved" (new + not-yet-approved, re-detected) | "all"
    # recognize: "approved" (boxes approved) | "with_boxes" (any image that has boxes)
    scope: Optional[str] = None


def _select_images(p: dict[str, Any], kind: str, scope: Optional[str], overwrite: bool) -> list[str]:
    imgs = p["images"]
    if kind == "detect":
        scope = scope or "new"
        if scope == "all":
            return [i["id"] for i in imgs]
        if scope == "unapproved":
            return [i["id"] for i in imgs if not i.get("det_verified")]
        return [i["id"] for i in imgs if i.get("lines") is None]
    scope = scope or "approved"
    out = []
    for i in imgs:
        lines = i.get("lines") or []
        if not lines or (scope == "approved" and not i.get("det_verified")):
            continue
        if i.get("text_verified") and not overwrite:
            continue  # never touch human-approved text unless asked
        if overwrite or any(l.get("text") is None for l in lines):
            out.append(i["id"])
    return out


@app.post("/api/projects/{pid}/jobs")
def create_job(pid: str, body: JobIn):
    if body.kind not in ("detect", "recognize"):
        raise HTTPException(400, "kind must be detect or recognize")
    p = _nf(storage.get_project, pid)
    ids = body.image_ids
    overwrite = body.overwrite
    if ids is None:
        ids = _select_images(p, body.kind, body.scope, body.overwrite)
        if body.kind == "detect" and body.scope in ("unapproved", "all"):
            overwrite = True
    return jobs.submit(body.kind, pid, ids, overwrite)


@app.get("/api/jobs/{jid}")
def get_job(jid: str):
    return _nf(jobs.get, jid)


@app.post("/api/jobs/{jid}/cancel")
def cancel_job(jid: str):
    jobs.cancel(jid)
    return {"ok": True}


# ---------------------------------------------------------------- settings / export

@app.get("/api/settings")
def get_settings():
    return engine.get_settings()


@app.put("/api/settings")
def put_settings(body: dict[str, Any]):
    return engine.update_settings(body)


class ExportIn(BaseModel):
    val_ratio: float = 0.1
    seed: int = 42
    include_unverified_text: bool = False


@app.post("/api/projects/{pid}/export")
def export(pid: str, body: ExportIn):
    _nf(storage.get_project, pid)
    return exporter.export_project(pid, val_ratio=body.val_ratio, seed=body.seed,
                                   include_unverified_text=body.include_unverified_text)


@app.get("/api/exports/{name}")
def download_export(name: str):
    p = (exporter.EXPORT_DIR / name).resolve()
    if p.parent != exporter.EXPORT_DIR.resolve() or not p.is_file():
        raise HTTPException(404)
    return FileResponse(p, filename=name)


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
