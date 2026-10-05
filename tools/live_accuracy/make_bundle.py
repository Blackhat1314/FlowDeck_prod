"""Writes bundle.js: the backend engine sources + harness.py as JS globals, for the browser live test.

Usage:  python tools/live_accuracy/make_bundle.py            (Binance accuracy test: bundle.js + harness.js)
        python tools/live_accuracy/make_bundle.py --phase2   (all venues: bundle2.js + harness2.js, then T2.summary())
Then open https://example.com in Chrome, open DevTools > Console, paste bundle.js, then harness.js.
Wait 15+ minutes and run  T.report()  /  T.report2()  in the console.
(example.com is used only because it has no Content-Security-Policy that would block the
exchange WebSockets; nothing is sent to it.)
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(ROOT, "..", "..", "backend", "app", "engine")
files = {"app/__init__.py": ""}
for f in sorted(os.listdir(ENGINE)):
    if f.endswith(".py"):
        with open(os.path.join(ENGINE, f), encoding="utf-8") as fh:
            files["app/engine/" + f] = fh.read()
phase2 = "--phase2" in sys.argv
with open(os.path.join(ROOT, "harness2.py" if phase2 else "harness.py"), encoding="utf-8") as fh:
    harness = fh.read()
out = os.path.join(ROOT, "bundle2.js" if phase2 else "bundle.js")
with open(out, "w", encoding="utf-8") as fh:
    fh.write("window.__ENGINE_SRC = " + json.dumps(files) + ";\n")
    fh.write(("window.__HARNESS2_PY = " if phase2 else "window.__HARNESS_PY = ") + json.dumps(harness) + ";\n")
print("wrote", out)
