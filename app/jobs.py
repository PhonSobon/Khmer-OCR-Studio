"""Single background worker that runs detection / recognition batches."""
from __future__ import annotations

import queue
import threading
import time
import traceback
import uuid
from typing import Any

from . import engine, storage

_jobs: dict[str, dict[str, Any]] = {}
_q: "queue.Queue[str]" = queue.Queue()
_lock = threading.Lock()


def submit(kind: str, pid: str, image_ids: list[str], overwrite: bool = False) -> dict[str, Any]:
    jid = uuid.uuid4().hex[:10]
    job = {
        "id": jid, "kind": kind, "pid": pid, "image_ids": image_ids, "overwrite": overwrite,
        "total": len(image_ids), "done": 0, "status": "queued", "errors": [],
        "current": None, "created_at": time.time(), "message": "",
    }
    with _lock:
        _jobs[jid] = job
    _q.put(jid)
    return public(job)


def public(job: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in job.items() if k != "image_ids"}


def get(jid: str) -> dict[str, Any]:
    return public(_jobs[jid])


def list_for(pid: str) -> list[dict[str, Any]]:
    return [public(j) for j in _jobs.values() if j["pid"] == pid and j["status"] in ("queued", "running")]


def cancel(jid: str) -> None:
    job = _jobs.get(jid)
    if job and job["status"] in ("queued", "running"):
        job["status"] = "cancelling" if job["status"] == "running" else "cancelled"


def _run(job: dict[str, Any]) -> None:
    job["status"] = "running"
    if not engine.is_loaded(job["kind"]):
        job["message"] = "Loading model…"
    for iid in job["image_ids"]:
        if job["status"] == "cancelling":
            job["status"] = "cancelled"
            return
        job["current"] = iid
        try:
            img = storage.get_image(job["pid"], iid)
            path = storage.image_path(job["pid"], iid)
            if job["kind"] == "detect":
                if job["overwrite"] or img.get("lines") is None:
                    lines = engine.detect(path)
                    storage.update_image(job["pid"], iid, lines=lines, det_verified=False, text_verified=False)
            elif job["kind"] == "recognize":
                lines = img.get("lines") or []
                todo = [l for l in lines if job["overwrite"] or l.get("text") is None]
                if todo:
                    results = engine.recognize_boxes(path, [l["box"] for l in todo])
                    for l, r in zip(todo, results):
                        l.update(r)
                    storage.update_image(job["pid"], iid, lines=lines, text_verified=False)
        except Exception as e:  # keep going with the rest of the batch
            traceback.print_exc()
            job["errors"].append({"image_id": iid, "error": str(e)})
        job["message"] = ""
        job["done"] += 1
    job["current"] = None
    job["status"] = "done"


def _worker() -> None:
    while True:
        jid = _q.get()
        job = _jobs.get(jid)
        if not job or job["status"] == "cancelled":
            continue
        try:
            _run(job)
        except Exception as e:
            traceback.print_exc()
            job["status"] = "error"
            job["message"] = str(e)


threading.Thread(target=_worker, daemon=True, name="ocr-worker").start()
