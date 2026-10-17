"""Start Khmer OCR Studio.

- If the app is already running on the port, just open the browser.
- If the port is used by something else, use the next free port.
"""
from __future__ import annotations

import json
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

HOST = "127.0.0.1"
START_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


def _is_ours(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/settings", timeout=1.5) as r:
            return "model_path" in json.load(r)
    except Exception:
        return False


def _is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((HOST, port))
            return True
        except OSError:
            return False


def _open_when_ready(url: str) -> None:
    for _ in range(120):
        try:
            urllib.request.urlopen(url + "api/settings", timeout=1)
            webbrowser.open(url)
            return
        except Exception:
            time.sleep(0.5)


def main() -> None:
    for port in range(START_PORT, START_PORT + 20):
        if _is_free(port):
            break
        if _is_ours(port):
            url = f"http://{HOST}:{port}/"
            print(f"Khmer OCR Studio is already running at {url} - opening the browser.")
            webbrowser.open(url)
            return
        print(f"Port {port} is used by another program, trying {port + 1}...")
    else:
        sys.exit("No free port found.")

    url = f"http://{HOST}:{port}/"
    print(f"Starting Khmer OCR Studio at {url}  (press Ctrl+C to stop)")
    threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()

    import uvicorn
    uvicorn.run("app.main:app", host=HOST, port=port, log_level="warning")


if __name__ == "__main__":
    main()
