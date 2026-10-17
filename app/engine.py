"""Khmer OCR Studio - thin wrapper around kiri_ocr (https://huggingface.co/mrrtmob/kiri-ocr).

Detection : kiri_ocr.detector.TextDetector(method="db")  -> detector/DB/detector.onnx
Recognition: kiri_ocr.OCR  (Transformer + CTC, 48x640 line images)

Models are loaded lazily on first use and cached; changing settings that affect a
model drops it so it is reloaded with the new parameters.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SETTINGS_FILE = ROOT / "data" / "settings.json"

DEFAULTS: dict[str, Any] = {
    "model_path": "mrrtmob/kiri-ocr",
    "det_model_path": "",          # empty -> detector/DB/detector.onnx from model_path repo
    "device": "auto",              # auto | cpu | cuda
    "decode_method": "accurate",   # fast | accurate | beam
    "det_db_thresh": 0.3,
    "det_db_box_thresh": 0.5,
    "det_db_unclip_ratio": 1.5,
    "max_side_len": 960,
    "crop_pad": 5,                 # same extra padding kiri_ocr uses at inference
    "auto_recognize": False,       # recognize an image as soon as its boxes are approved
}
DET_KEYS = {"det_model_path", "model_path", "device", "det_db_thresh", "det_db_box_thresh",
            "det_db_unclip_ratio", "max_side_len"}
REC_KEYS = {"model_path", "device", "decode_method"}

_lock = threading.RLock()
_detector = None
_ocr = None
_settings: dict[str, Any] = dict(DEFAULTS)
if SETTINGS_FILE.exists():
    try:
        _settings.update(json.loads(SETTINGS_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass


# ---------------------------------------------------------------- settings

def _cuda_available() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


def _device() -> str:
    d = _settings["device"]
    if d == "auto":
        return "cuda" if _cuda_available() else "cpu"
    return d


def get_settings() -> dict[str, Any]:
    return {**_settings, "resolved_device": _device(), "cuda_available": _cuda_available(),
            "detector_loaded": _detector is not None, "recognizer_loaded": _ocr is not None}


def update_settings(new: dict[str, Any]) -> dict[str, Any]:
    global _detector, _ocr
    with _lock:
        changed = {k for k, v in new.items() if k in DEFAULTS and _settings.get(k) != v}
        for k in changed:
            _settings[k] = type(DEFAULTS[k])(new[k]) if DEFAULTS[k] is not None else new[k]
        if changed & DET_KEYS:
            _detector = None
        if changed & REC_KEYS:
            _ocr = None
        SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(_settings, indent=2), encoding="utf-8")
    return get_settings()


def is_loaded(kind: str) -> bool:
    return (_detector if kind == "detect" else _ocr) is not None


# ---------------------------------------------------------------- models

def _get_detector():
    global _detector
    with _lock:
        if _detector is None:
            from kiri_ocr.detector import TextDetector

            s = _settings
            use_gpu = False
            if _device() == "cuda":
                try:
                    import onnxruntime as ort
                    use_gpu = "CUDAExecutionProvider" in ort.get_available_providers()
                except Exception:
                    pass
            # TextDetector resolves/downloads detector/DB/detector.onnx; DB params can't be
            # passed through it (they also reach the legacy fallback), so rebuild the
            # DBDetector with our parameters.
            _detector = TextDetector(method="db", model_path=s["det_model_path"] or s["model_path"])
            if _detector.method == "db":
                from kiri_ocr.detector.db import DBDetector

                _detector.db_detector = DBDetector(
                    _detector.model_path,
                    use_gpu=use_gpu,
                    det_db_thresh=float(s["det_db_thresh"]),
                    det_db_box_thresh=float(s["det_db_box_thresh"]),
                    det_db_unclip_ratio=float(s["det_db_unclip_ratio"]),
                    max_side_len=int(s["max_side_len"]),
                )
            else:
                print("WARNING: DB detector could not be loaded; kiri_ocr fell back to", _detector.method)
        return _detector


def _get_ocr():
    global _ocr
    with _lock:
        if _ocr is None:
            from kiri_ocr import OCR

            _ocr = OCR(model_path=_settings["model_path"], device=_device(),
                       decode_method=_settings["decode_method"], verbose=False)
        return _ocr


def _load_bgr(path: Path) -> np.ndarray:
    import cv2

    # imdecode instead of imread: works with non-ASCII (e.g. Khmer) file paths on Windows
    data = np.fromfile(str(path), dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"Cannot read image {path}")
    return img


# ---------------------------------------------------------------- public API

def detect(path: Path) -> list[dict[str, Any]]:
    from . import storage

    img = _load_bgr(path)
    H, W = img.shape[:2]
    det = _get_detector()
    with _lock:
        boxes = det.detect_lines_objects(img)
    lines = []
    for b in boxes:
        x1, y1 = max(0, float(b.x)), max(0, float(b.y))
        x2, y2 = min(W, float(b.x + b.width)), min(H, float(b.y + b.height))
        if x2 - x1 < 2 or y2 - y1 < 2:
            continue
        lines.append({"id": storage.new_line_id(), "box": [x1, y1, x2, y2],
                      "det_conf": round(float(b.confidence), 4), "text": None, "conf": None})
    return lines


def crop_line(im: Image.Image, box: list[float], pad: int | None = None) -> Image.Image | None:
    """Crop one text line exactly the way it is fed to the recognizer (box + pad)."""
    if pad is None:
        pad = int(_settings["crop_pad"])
    x1, y1, x2, y2 = box
    x1, x2 = sorted((x1, x2))
    y1, y2 = sorted((y1, y2))
    x1 = max(0, int(round(x1)) - pad)
    y1 = max(0, int(round(y1)) - pad)
    x2 = min(im.width, int(round(x2)) + pad)
    y2 = min(im.height, int(round(y2)) + pad)
    if x2 - x1 < 2 or y2 - y1 < 2:
        return None
    return im.crop((x1, y1, x2, y2))


def recognize_boxes(path: Path, boxes: list[list[float]]) -> list[dict[str, Any]]:
    """Recognize each box. Returns [{text, conf, alt}].

    `conf` is the CTC confidence (well calibrated, unlike the decoder score).
    When the decoder is used, the CTC reading is also computed; if the two
    disagree it is returned as `alt` so the reviewer can see/pick it.
    """
    import torch
    from kiri_ocr.model import greedy_ctc_decode, preprocess_pil

    ocr = _get_ocr()
    use_ctc_check = ocr.cfg.USE_CTC and hasattr(ocr.model, "ctc_head")
    with Image.open(path) as im:
        gray = im.convert("L")
    out: list[dict[str, Any]] = []
    with _lock, torch.inference_mode():
        for box in boxes:
            crop = crop_line(gray, box)
            if crop is None:
                out.append({"text": "", "conf": 0.0, "alt": None})
                continue
            arr = np.asarray(crop)
            if arr.mean() < 127:  # light text on dark background (same as kiri_ocr)
                crop = Image.fromarray(255 - arr)
            try:
                t = preprocess_pil(ocr.cfg, crop)
                text, conf = ocr.recognize_region(t)
                alt = None
                if use_ctc_check and ocr.decode_method != "ctc":
                    ctc_text, conf = greedy_ctc_decode(ocr.model, t.to(ocr.device), ocr.tokenizer, ocr.cfg)
                    if ctc_text.strip() != text.strip():
                        alt = ctc_text
            except Exception as e:
                print("recognition failed:", e)
                text, conf, alt = "", 0.0, None
            out.append({"text": text, "conf": round(float(conf), 4), "alt": alt})
    return out
