"""Export reviewed annotations as training datasets.

detection/    YOLO format, single class `text` (Ultralytics):
                images/{train,val}/<name>.jpg
                labels/{train,val}/<name>.txt   ->  "0 cx cy w h" (normalised)
                data.yaml
              plus PaddleOCR DB-style labels for fine-tuning the DB (ONNX) detector:
                {train,val}_label.txt  ->  "images/train/x.jpg<TAB>[{"transcription":..,"points":[[x,y]x4]}]"
recognition/  line crops + tab-separated labels (works with
              `kiri-ocr train --train-labels ... --val-labels ...`):
                {train,val}/images/<name>_<NNN>.png
                {train,val}/labels.txt          ->  "<file name><TAB><text>"
                                                    (kiri-ocr resolves it in ./images/)
                {train,val}/metadata.jsonl      ->  HF `imagefolder` compatible
"""
from __future__ import annotations

import json
import random
import shutil
import time
import unicodedata
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image

from . import storage
from .engine import crop_line

EXPORT_DIR = storage.ROOT / "data" / "exports"
EXPORT_DIR.mkdir(parents=True, exist_ok=True)


def _clean_text(t: str) -> str:
    t = unicodedata.normalize("NFC", t)
    t = t.replace("\t", " ").replace("\r", " ").replace("\n", " ")
    return " ".join(t.split())


def _safe_stem(name: str, iid: str) -> str:
    stem = Path(name).stem
    stem = "".join(c if c.isalnum() or c in "-_" else "_" for c in stem)[:40]
    return f"{stem}_{iid}"


def export_project(pid: str, *, val_ratio: float = 0.1, seed: int = 42,
                   include_unverified_text: bool = False, pad: int | None = None,
                   make_zip: bool = True) -> dict[str, Any]:
    project = storage.get_project(pid)
    det_imgs = [i for i in project["images"] if i.get("det_verified") and i.get("lines") is not None]

    rng = random.Random(seed)
    ids = [i["id"] for i in det_imgs]
    rng.shuffle(ids)
    n_val = int(round(len(ids) * val_ratio)) if len(ids) > 1 else 0
    if val_ratio > 0 and len(ids) >= 2:
        n_val = max(1, n_val)
    val_ids = set(ids[:n_val])

    stamp = time.strftime("%Y%m%d-%H%M%S")
    pname = "".join(c if c.isalnum() or c in "-_" else "_" for c in project["name"])[:40]
    out = EXPORT_DIR / f"{pname}_{stamp}"
    det = out / "detection"
    rec = out / "recognition"
    for split in ("train", "val"):
        (det / "images" / split).mkdir(parents=True, exist_ok=True)
        (det / "labels" / split).mkdir(parents=True, exist_ok=True)
        (rec / split / "images").mkdir(parents=True, exist_ok=True)

    stats = {"det_images": {"train": 0, "val": 0}, "det_boxes": {"train": 0, "val": 0},
             "rec_lines": {"train": 0, "val": 0}, "skipped_lines": 0}
    rec_labels: dict[str, list[str]] = {"train": [], "val": []}
    db_labels: dict[str, list[str]] = {"train": [], "val": []}
    rec_meta: dict[str, list[str]] = {"train": [], "val": []}
    charset: set[str] = set()

    for img in det_imgs:
        split = "val" if img["id"] in val_ids else "train"
        stem = _safe_stem(img["filename"], img["id"])
        src = storage.image_path(pid, img["id"])
        W, H = img["width"], img["height"]

        # --- detection
        dst = det / "images" / split / f"{stem}{src.suffix}"
        shutil.copyfile(src, dst)
        rows, polys = [], []
        for ln in img["lines"]:
            x1, y1, x2, y2 = ln["box"]
            x1, x2 = max(0, min(x1, x2)), min(W, max(x1, x2))
            y1, y2 = max(0, min(y1, y2)), min(H, max(y1, y2))
            if x2 - x1 < 2 or y2 - y1 < 2:
                continue
            cx, cy = (x1 + x2) / 2 / W, (y1 + y2) / 2 / H
            bw, bh = (x2 - x1) / W, (y2 - y1) / H
            rows.append(f"0 {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}")
            pts = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
            polys.append({"transcription": _clean_text(ln.get("text") or "") or "###",
                          "points": [[int(round(x)), int(round(y))] for x, y in pts]})
        (det / "labels" / split / f"{stem}.txt").write_text("\n".join(rows) + ("\n" if rows else ""), encoding="utf-8")
        db_labels[split].append(f"images/{split}/{dst.name}\t" + json.dumps(polys, ensure_ascii=False))
        stats["det_images"][split] += 1
        stats["det_boxes"][split] += len(rows)

        # --- recognition
        if not (img.get("text_verified") or include_unverified_text):
            continue
        with Image.open(src) as im:
            im = im.convert("RGB")
            for n, ln in enumerate(img["lines"]):
                text = _clean_text(ln.get("text") or "")
                if not text or ln.get("ignore"):
                    stats["skipped_lines"] += 1
                    continue
                crop = crop_line(im, ln["box"], pad=pad)
                if crop is None:
                    stats["skipped_lines"] += 1
                    continue
                fname = f"{stem}_{n:03d}.png"
                crop.save(rec / split / "images" / fname)
                rec_labels[split].append(f"{fname}\t{text}")
                rec_meta[split].append(json.dumps({"file_name": f"images/{fname}", "text": text}, ensure_ascii=False))
                charset.update(text)
                stats["rec_lines"][split] += 1

    for split in ("train", "val"):
        (rec / split / "labels.txt").write_text("\n".join(rec_labels[split]) + "\n", encoding="utf-8")
        (rec / split / "metadata.jsonl").write_text("\n".join(rec_meta[split]) + "\n", encoding="utf-8")
        (det / f"{split}_label.txt").write_text("\n".join(db_labels[split]) + "\n", encoding="utf-8")
    (rec / "charset.txt").write_text("".join(sorted(charset)), encoding="utf-8")

    (det / "data.yaml").write_text(
        "# YOLO dataset - single class `text` (one box per text line)\n"
        f"path: {det.resolve().as_posix()}\n"
        "train: images/train\n"
        "val: images/val\n"
        "nc: 1\n"
        "names: ['text']\n",
        encoding="utf-8",
    )

    (out / "README.txt").write_text(_readme(project["name"], stats), encoding="utf-8")
    (out / "stats.json").write_text(json.dumps(stats, indent=2), encoding="utf-8")

    result = {"dir": str(out), "name": out.name, "stats": stats, "zip": None}
    if make_zip:
        zpath = out.with_suffix(".zip")
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for f in out.rglob("*"):
                if f.is_file():
                    z.write(f, f.relative_to(out.parent))
        result["zip"] = zpath.name
    return result


def _readme(name: str, s: dict[str, Any]) -> str:
    return f"""Dataset export for project: {name}

DETECTION (YOLO, 1 class: text)
  train images: {s['det_images']['train']}  boxes: {s['det_boxes']['train']}
  val   images: {s['det_images']['val']}  boxes: {s['det_boxes']['val']}

  YOLO (Ultralytics):
    pip install ultralytics
    yolo detect train data=detection/data.yaml model=yolov8n.pt imgsz=1024 epochs=100
  NOTE: data.yaml has an absolute `path:`; edit it if you move the folder.

  DB detector (PaddleOCR det format, same family as kiri-ocr detector/DB/detector.onnx):
    detection/train_label.txt, detection/val_label.txt  (data_dir = detection/)

RECOGNITION (line crops, label = "file<TAB>text", file names resolved in <split>/images/)
  train lines: {s['rec_lines']['train']}
  val   lines: {s['rec_lines']['val']}

  Train / fine-tune with kiri-ocr (input 48x640):
    cd recognition
    kiri-ocr train --train-labels train/labels.txt --val-labels val/labels.txt \\
        --height 48 --width 640 --output-dir output_model --device cuda
    (add --from-model <path to model.safetensors> to fine-tune instead of training from scratch)
  HF datasets:  load_dataset("imagefolder", data_dir="recognition")  (uses metadata.jsonl)
"""
