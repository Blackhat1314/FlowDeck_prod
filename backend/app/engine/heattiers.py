"""Longer heatmap history at lower time detail.

The live heatmap keeps 30 minutes of 250 ms columns. Older history is kept by merging columns:
  - 5-second columns: 20 live columns each, kept for 12 hours (memory, and saved to disk for restarts)
  - 1-minute columns: 12 five-second columns each, the permanent archive (disk only)

A merged column has the same binary layout as a live one (see heatmap.py), so the dashboard draws it the same way:
  - resting liquidity per price: average over the merged columns (orders that sat in the book for only part of the
    window count for that part, so brief flashes fade and steady walls stay bright)
  - trades, other venues' prints, per-venue volume, taker size classes, liquidations: summed
  - best bid/ask, last price, premium, open interest: the latest value
Pure and IO-free, like the rest of the engine; disk access lives in app/archive.py.
"""
from __future__ import annotations

import math
import struct
from array import array
from collections import deque

from .heatmap import BQ, HDR, MSG_HDR, SZ, TAIL, TRD, U32

TIER_5S = 5_000
TIER_1M = 60_000
MSG_HISTORY = 2              # message type for merged columns: u8 2 | u8 version | u16 count | u32 dt_ms | records
DT = struct.Struct("<I")
MAX_ROWS = 2400              # cap on the merged price range (a fast market can drift during a minute)


class Col:
    """One heatmap column, unpacked."""
    __slots__ = ("t", "bb", "ba", "base", "qty", "last", "tr", "xt", "cb", "ex", "sz", "prem", "oi", "liq")



def parse(rec: bytes) -> Col:
    c = Col()
    c.t, c.bb, c.ba, c.base, n, m, c.last = HDR.unpack_from(rec, 0)
    off = HDR.size
    c.qty = array("f")
    c.qty.frombytes(rec[off:off + 4 * n])
    off += 4 * n
    c.tr = {b: (buy, sell) for b, buy, sell in TRD.iter_unpack(rec[off:off + TRD.size * m])}
    off += TRD.size * m
    (m2,) = U32.unpack_from(rec, off)
    off += 4
    c.xt = {b: (buy, sell) for b, buy, sell in TRD.iter_unpack(rec[off:off + TRD.size * m2])}
    off += TRD.size * m2
    (k3,) = U32.unpack_from(rec, off)
    off += 4
    c.cb = dict(BQ.iter_unpack(rec[off:off + BQ.size * k3]))
    off += BQ.size * k3
    (nx,) = U32.unpack_from(rec, off)
    off += 4
    c.ex = {v: (buy, sell) for v, buy, sell in TRD.iter_unpack(rec[off:off + TRD.size * nx])}
    off += TRD.size * nx
    c.sz = SZ.unpack_from(rec, off)
    off += SZ.size
    prem, oi, ll, ls = TAIL.unpack_from(rec, off)
    c.prem, c.oi, c.liq = prem, oi, (ll, ls)
    return c


def _add2(acc: dict, src: dict):
    for k, (a, b) in src.items():
        e = acc.get(k)
        acc[k] = (a, b) if e is None else (e[0] + a, e[1] + b)


def merge(cols: list, t0: float) -> bytes:
    """Merge parsed columns (oldest first) into one record stamped t0."""
    k = len(cols)
    last = cols[-1]
    lo = min(c.base for c in cols)
    hi = max(c.base + len(c.qty) for c in cols)
    if hi - lo > MAX_ROWS:                       # keep the range centred on the latest price
        mid = last.base + len(last.qty) // 2
        lo, hi = mid - MAX_ROWS // 2, mid + MAX_ROWS // 2 + 1
    n = hi - lo
    acc = array("f", bytes(4 * n))
    for c in cols:
        q = c.qty
        s = c.base - lo
        i0 = max(0, -s)
        i1 = min(len(q), n - s)
        for i in range(i0, i1):
            v = q[i]
            if v:
                acc[s + i] += v
    inv = 1.0 / k
    for i in range(n):
        if acc[i]:
            acc[i] *= inv
    tr, xt, ex, cb = {}, {}, {}, {}
    sz = [0.0] * 6
    liq = [0.0, 0.0]
    prem = oi = math.nan
    for c in cols:
        _add2(tr, c.tr)
        _add2(xt, c.xt)
        _add2(ex, c.ex)
        for b, q in c.cb.items():
            cb[b] = cb.get(b, 0.0) + q
        for i in range(6):
            sz[i] += c.sz[i]
        liq[0] += c.liq[0]
        liq[1] += c.liq[1]
        if not math.isnan(c.prem):
            prem = c.prem
        if not math.isnan(c.oi):
            oi = c.oi
    parts = [HDR.pack(t0, last.bb, last.ba, lo, n, len(tr), last.last), acc.tobytes()]
    for b, (buy, sell) in tr.items():
        parts.append(TRD.pack(b, buy, sell))
    parts.append(U32.pack(len(xt)))
    for b, (buy, sell) in xt.items():
        parts.append(TRD.pack(b, buy, sell))
    parts.append(U32.pack(len(cb)))
    for b, q in cb.items():
        parts.append(BQ.pack(b, q * inv))
    parts.append(U32.pack(len(ex)))
    for vid, (buy, sell) in ex.items():
        parts.append(TRD.pack(vid, buy, sell))
    parts.append(SZ.pack(*sz))
    parts.append(TAIL.pack(prem, oi, liq[0], liq[1]))
    return b"".join(parts)


def rec_time(rec: bytes) -> float:
    return struct.unpack_from("<d", rec, 0)[0]


def pack_history(dt: int, records) -> bytes:
    """Network message for merged columns."""
    return MSG_HDR.pack(MSG_HISTORY, 2, len(records)) + DT.pack(dt) + b"".join(records)


class Window:
    """Collects columns that fall in the same dt-aligned window and emits the merge when the window closes."""

    def __init__(self, dt: int):
        self.dt = dt
        self.t0 = None
        self.cols: list = []

    def add(self, t: float, col: Col):
        """Returns (t0, merged record) when this column starts a new window, else None."""
        w = t - t % self.dt
        out = None
        if self.t0 is not None and w != self.t0 and self.cols:
            out = (self.t0, merge(self.cols, self.t0))
            self.cols = []
        self.t0 = w
        self.cols.append(col)
        return out


class HeatTiers:
    """5-second history in memory (12 h by default), plus queues of new 5 s / 1 min records to save."""

    def __init__(self, keep_hours: float = 12.0):
        self.s5: deque = deque(maxlen=int(keep_hours * 3600_000 / TIER_5S))
        self.w5 = Window(TIER_5S)
        self.w1 = Window(TIER_1M)
        self.new_s5: list = []      # (t, rec) not yet saved
        self.new_m1: list = []

    def add(self, rec: bytes):
        """Feed every live 250 ms column."""
        col = parse(rec)
        done = self.w5.add(col.t, col)
        if done is None:
            return
        t5, r5 = done
        self.s5.append(r5)
        self.new_s5.append((t5, r5))
        done1 = self.w1.add(t5, parse(r5))
        if done1 is not None:
            self.new_m1.append(done1)

    def restore(self, recs):
        """Records from disk (oldest first) after a restart."""
        for r in recs:
            if not self.s5 or rec_time(r) > rec_time(self.s5[-1]):
                self.s5.append(r)

    def take_new(self):
        a, b = self.new_s5, self.new_m1
        self.new_s5, self.new_m1 = [], []
        return a, b

    def first_time(self):
        return rec_time(self.s5[0]) if self.s5 else None

    def range(self, t0: float, t1: float, limit: int) -> list:
        """5 s records with t0 <= t < t1, the newest `limit` of them."""
        out = [r for r in self.s5 if t0 <= rec_time(r) < t1]
        return out[-limit:]
