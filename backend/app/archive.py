"""History on disk: heatmap tiers (5-second and 1-minute columns) and footprint bars.

Layout under the data folder (next to the accounts database):
  history/<venue>/heat5s/YYYY-MM-DD.bin   5-second heatmap columns (kept 2 days: reloads the last 12 h after a restart)
  history/<venue>/heat1m/YYYY-MM-DD.bin   1-minute heatmap columns (the archive, kept forever by default)
  history/<venue>/footprint/YYYY-MM-DD.bin   1-minute footprint bars with per-price buy/sell (kept forever by default)
  history/<venue>/footprint/YYYY-MM-DD.full  marker: that day's footprint is complete (from Binance's daily file)

Each file is a sequence of frames: u32 length | zlib(payload). Heatmap payloads are u32-length-prefixed records,
footprint payloads a JSON list of bars. Frames are appended once a minute, so a crash loses at most the last one,
and a half-written frame at the end is ignored. Days are UTC.
"""
from __future__ import annotations

import os
import struct
import threading
import time
import zlib
from collections import OrderedDict
from pathlib import Path

import orjson

DAY = 86_400_000
U32 = struct.Struct("<I")
TIME = struct.Struct("<d")


def day_of(t_ms: float) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(t_ms / 1000))


def day_start(day: str) -> int:
    import calendar
    return calendar.timegm(time.strptime(day, "%Y-%m-%d")) * 1000


def _frames(path: Path):
    try:
        data = path.read_bytes()
    except OSError:
        return
    off = 0
    while off + 4 <= len(data):
        (n,) = U32.unpack_from(data, off)
        if off + 4 + n > len(data):
            break                      # half-written last frame
        try:
            yield zlib.decompress(data[off + 4:off + 4 + n])
        except zlib.error:
            break
        off += 4 + n


def _records(payload: bytes):
    off = 0
    while off + 4 <= len(payload):
        (n,) = U32.unpack_from(payload, off)
        yield payload[off + 4:off + 4 + n]
        off += 4 + n


class Archive:
    def __init__(self, root: Path, archive_days: int = 0):
        self.root = Path(root)
        self.archive_days = archive_days        # 0 = keep the 1-minute heatmap and footprint forever
        self.lock = threading.Lock()
        self._cache: OrderedDict = OrderedDict()   # (path, size) -> decoded day

    def _dir(self, kind: str) -> Path:
        d = self.root / kind
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _append(self, path: Path, payload: bytes):
        frame = zlib.compress(payload, 6)
        with self.lock, open(path, "ab") as f:
            f.write(U32.pack(len(frame)) + frame)
            f.flush()
            os.fsync(f.fileno())

    def _cached(self, path: Path, decode):
        try:
            key = (str(path), path.stat().st_size)
        except OSError:
            return []
        hit = self._cache.get(key)
        if hit is not None:
            self._cache.move_to_end(key)
            return hit
        val = decode(path)
        self._cache[key] = val
        while len(self._cache) > 4:
            self._cache.popitem(last=False)
        return val

    # ------------------------------------------------------------------ heatmap
    def append_heat(self, tier: str, items):
        """items: [(t_ms, record bytes)] in time order."""
        by_day: dict = {}
        for t, rec in items:
            by_day.setdefault(day_of(t), []).append(rec)
        d = self._dir(f"heat{tier}")
        for day, recs in by_day.items():
            self._append(d / f"{day}.bin", b"".join(U32.pack(len(r)) + r for r in recs))

    def _heat_day(self, path: Path):
        out = []
        for payload in _frames(path):
            out.extend(_records(payload))
        out.sort(key=lambda r: TIME.unpack_from(r, 0)[0])
        return out

    def read_heat(self, tier: str, t0: float, t1: float, limit: int = 100_000):
        """Records with t0 <= t < t1, newest `limit` of them, oldest first."""
        d = self.root / f"heat{tier}"
        if not d.exists():
            return []
        out: list = []
        day = day_of(t1 - 1)
        first = day_of(t0)
        while True:
            recs = self._cached(d / f"{day}.bin", self._heat_day)
            part = [r for r in recs if t0 <= TIME.unpack_from(r, 0)[0] < t1]
            out = part + out
            if len(out) >= limit or day <= first:
                break
            day = day_of(day_start(day) - 1)
            if day < "2000":
                break
        return out[-limit:]

    def first_heat_time(self, tier: str):
        d = self.root / f"heat{tier}"
        files = sorted(d.glob("*.bin")) if d.exists() else []
        for f in files:
            recs = self._heat_day(f)
            if recs:
                return TIME.unpack_from(recs[0], 0)[0]
        return None

    # ------------------------------------------------------------------ footprint
    def append_bars(self, bars: list):
        by_day: dict = {}
        for b in bars:
            by_day.setdefault(day_of(b["t"]), []).append(b)
        d = self._dir("footprint")
        for day, bs in by_day.items():
            self._append(d / f"{day}.bin", orjson.dumps(bs))

    def _bars_day(self, path: Path):
        seen: dict = {}
        for payload in _frames(path):
            for b in orjson.loads(payload):
                seen[b["t"]] = b          # later frames win (a day file rewritten by the back-fill)
        return [seen[t] for t in sorted(seen)]

    def read_bars(self, t0: float, t1: float):
        d = self.root / "footprint"
        if not d.exists():
            return []
        out = []
        day, last = day_of(t0), day_of(t1 - 1)
        while day <= last:
            out.extend(b for b in self._cached(d / f"{day}.bin", self._bars_day) if t0 <= b["t"] < t1)
            day = day_of(day_start(day) + DAY)
        return out

    def day_full(self, day: str) -> bool:
        return (self.root / "footprint" / f"{day}.full").exists()

    def write_full_day(self, day: str, bars: list):
        """Replace a day's footprint with a complete set (from Binance's daily trade file), keeping bars we recorded
        live: those also carry other exchanges' volume, liquidations and open interest."""
        d = self._dir("footprint")
        path = d / f"{day}.bin"
        live = {b["t"]: b for b in self._bars_day(path)} if path.exists() else {}
        merged = {b["t"]: b for b in bars}
        merged.update(live)
        tmp = d / f"{day}.tmp"
        frame = zlib.compress(orjson.dumps([merged[t] for t in sorted(merged)]), 6)
        with self.lock:
            with open(tmp, "wb") as f:
                f.write(U32.pack(len(frame)) + frame)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
            (d / f"{day}.full").write_text("binance daily aggTrades\n")
        self._cache.clear()

    # ------------------------------------------------------------------ housekeeping
    def prune(self, now_ms: float, keep_5s_days: int = 2):
        """Delete 5-second heatmap files older than keep_5s_days, and archive files past archive_days (if set)."""
        rules = [("heat5s", keep_5s_days)]
        if self.archive_days:
            rules += [("heat1m", self.archive_days), ("footprint", self.archive_days)]
        for kind, days in rules:
            d = self.root / kind
            if not d.exists():
                continue
            cut = day_of(now_ms - days * DAY)
            for f in d.iterdir():
                if f.suffix in (".bin", ".full", ".tmp") and f.stem < cut:
                    try:
                        f.unlink()
                    except OSError:
                        pass

    def usage(self) -> dict:
        """Bytes on disk per kind (for the admin panel)."""
        out = {}
        for kind in ("heat5s", "heat1m", "footprint"):
            d = self.root / kind
            out[kind] = sum(f.stat().st_size for f in d.glob("*.bin")) if d.exists() else 0
        return out
