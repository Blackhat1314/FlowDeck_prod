"""Back-fill footprint history from Binance's free daily trade files (https://data.binance.vision).

Run by the server in a separate, low-priority process every few hours:
    python -m app.histfill --root <history folder> --days 7 --market um --symbol BTCUSDT --tick 0.1 --bucket 1

For each of the last N complete UTC days that isn't marked complete yet, it downloads that day's aggTrades zip,
checks it against Binance's published SHA-256, rebuilds every 1-minute footprint bar (per-price buy/sell volume and
trade counts, running delta, OHLC) exactly the way the live engine does, and merges it into the archive. Minutes the
server recorded live are kept as they are, because those also hold other exchanges' volume and liquidations.
Binance publishes a day's file the following day, so the current day always comes from live recording.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from .archive import Archive, day_of

BASE = "https://data.binance.vision/data/futures/{market}/daily/aggTrades/{symbol}/{symbol}-aggTrades-{day}.zip"
MIN = 60_000


def _ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


def download(url: str, dest: Path) -> bool:
    """False when Binance has no file for that day (404)."""
    req = urllib.request.Request(url, headers={"User-Agent": "flowdeck-histfill"})
    try:
        with urllib.request.urlopen(req, context=_ctx(), timeout=120) as r, open(dest, "wb") as f:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                f.write(chunk)
        return True
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_bars(rows, tick: float, bucket_usd: float, contract_usd: float = 0.0) -> list:
    """aggTrades rows (agg_id, price, qty, first_id, last_id, time_ms, is_buyer_maker) -> footprint bars (archive JSON),
    using the live engine's bucket maths so live and back-filled bars line up exactly."""
    bt = int(round(bucket_usd / tick))
    inv_tick = 1.0 / tick
    bars: dict = {}
    for r in rows:
        try:
            a, p, q, T, maker = int(r[0]), float(r[1]), float(r[2]), int(r[5]), r[6].strip().lower() == "true"
        except (ValueError, IndexError):
            continue                       # header row or a broken line
        btc = q * contract_usd / p if contract_usd else q
        side = -1 if maker else 1
        t = T - T % MIN
        b = bars.get(t)
        if b is None:
            b = bars[t] = {"t": t, "o": p, "h": p, "l": p, "c": p, "v": 0.0, "bv": 0.0, "sv": 0.0, "n": 0,
                           "d": 0.0, "dmax": 0.0, "dmin": 0.0, "lv": {}, "a0": a, "a1": a}
        if a < b["a0"]:
            b["a0"], b["o"] = a, p
        if a >= b["a1"]:
            b["a1"], b["c"] = a, p
        if p > b["h"]:
            b["h"] = p
        if p < b["l"]:
            b["l"] = p
        b["v"] += btc
        if side > 0:
            b["bv"] += btc
        else:
            b["sv"] += btc
        b["n"] += 1
        bkt = int(round(p * inv_tick)) // bt
        e = b["lv"].get(bkt)
        if e is None:
            e = b["lv"][bkt] = [0.0, 0.0, 0, 0]
        if side > 0:
            e[0] += btc
            e[2] += 1
        else:
            e[1] += btc
            e[3] += 1
        b["d"] += btc * side
        if b["d"] > b["dmax"]:
            b["dmax"] = b["d"]
        if b["d"] < b["dmin"]:
            b["dmin"] = b["d"]
    out = []
    for t in sorted(bars):
        b = bars[t]
        flat = []
        for k in sorted(b["lv"]):
            e = b["lv"][k]
            flat.extend((k, round(e[0], 4), round(e[1], 4), e[2], e[3]))
        out.append({"t": t, "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"], "v": round(b["v"], 4),
                    "bv": round(b["bv"], 4), "sv": round(b["sv"], 4), "n": b["n"],
                    "dx": [round(b["dmax"], 3), round(b["dmin"], 3)], "oi": [0.0, None], "lq": [0.0, 0.0], "lv": flat})
    return out


def fill_day(arc: Archive, day: str, a) -> str:
    url = BASE.format(market=a.market, symbol=a.symbol, day=day)
    with tempfile.TemporaryDirectory(dir=arc.root) as tmp:
        z = Path(tmp) / "day.zip"
        if not download(url, z):
            return "not published yet"
        ck = Path(tmp) / "day.CHECKSUM"
        if download(url + ".CHECKSUM", ck):
            want = ck.read_text().split()[0].strip().lower()
            if sha256(z) != want:
                return "checksum mismatch, skipped"
        with zipfile.ZipFile(z) as zf:
            name = zf.namelist()[0]
            with zf.open(name) as raw:
                rows = csv.reader(io.TextIOWrapper(raw, encoding="utf-8", newline=""))
                bars = build_bars(rows, a.tick, a.bucket, a.contract_usd)
    if not bars:
        return "empty file"
    arc.write_full_day(day, bars)
    return f"{len(bars)} bars"


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--market", default="um", choices=["um", "cm"])
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--tick", type=float, default=0.1)
    ap.add_argument("--bucket", type=float, default=1.0)
    ap.add_argument("--contract-usd", type=float, default=0.0)
    a = ap.parse_args(argv)
    if a.market == "um":
        a.contract_usd = 0.0
    arc = Archive(Path(a.root))
    arc.root.mkdir(parents=True, exist_ok=True)
    today = day_of(time.time() * 1000)
    for i in range(1, a.days + 1):
        day = day_of(time.time() * 1000 - i * 86_400_000)
        if day >= today or arc.day_full(day):
            continue
        t0 = time.time()
        try:
            res = fill_day(arc, day, a)
        except Exception as e:                      # network trouble: try again next round
            res = f"failed: {e}"
        print(f"{day}: {res} ({time.time() - t0:.0f} s)", flush=True)


if __name__ == "__main__":
    sys.exit(main())
