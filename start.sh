#!/usr/bin/env bash
# macOS / Linux launcher:  ./start.sh   (add --demo for the synthetic market)
set -e
cd "$(dirname "$0")/backend"
[ -x .venv/bin/python ] || python3 -m venv .venv
. .venv/bin/activate
pip install --disable-pip-version-check -q -r requirements.txt
exec python run.py --open "$@"
