#!/usr/bin/env sh
# Start Khmer OCR Studio on Linux / macOS
cd "$(dirname "$0")" || exit 1
if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python -m app.launch "$@"
