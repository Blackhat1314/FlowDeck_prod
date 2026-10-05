"""Heatmap columns: dense liquidity snapshot around mid + the trades printed during the column.

Binary record layout v2 (little endian, 4-byte aligned), decoded in frontend/src/lib/store.ts:
  f64 t | f64 bestBid | f64 bestAsk | i32 baseBucket | u32 n | u32 m | f32 last
  f32[n]          resting liquidity (BTC) on the primary venue, buckets base .. base+n-1
  m x (i32 bucket, f32 buyBTC, f32 sellBTC)   aggressive volume printed on the primary venue
  u32 m2, m2 x (i32 bucket, f32 buy, f32 sell)  other perps' prints (basis-adjusted to primary prices)
  u32 k3, k3 x (i32 bucket, f32 btc)            other perps' resting liquidity (combined book)
  u32 nx, nx x (i32 venue, f32 buy, f32 sell)   volume per venue in this column
  f32[6]  perp taker-order size classes: <1 buy, sell | 1-10 buy, sell | >=10 buy, sell
  f32 coinbase premium (USD, NaN if n/a) | f32 open interest all venues (BTC, NaN) | f32 long liq | f32 short liq
A message = u8 type(1) | u8 version(2) | u16 count | records...
"""
from __future__ import annotations

import struct
from array import array
from collections import deque

HDR = struct.Struct("<dddiIIf")      # 40 bytes
TRD = struct.Struct("<iff")
U32 = struct.Struct("<I")
BQ = struct.Struct("<if")
SZ = struct.Struct("<6f")
TAIL = struct.Struct("<4f")
MSG_HDR = struct.Struct("<BBH")
MSG_COLUMNS = 1
VERSION = 2
NAN = float("nan")


def _f(x):
    return NAN if x is None else float(x)


class Heatmap:
    def __init__(self, book, venue, settings):
        self.book = book
        self.v = venue
        self.s = settings
        self.bucket_usd = settings.bucket_usd
        self.R = settings.half_range
        self.history: deque = deque(maxlen=int(settings.history_min * 60_000 / settings.column_ms))
        self.frame_trades: dict = {}     # bucket -> [buy, sell]
        self.columns = 0

    def add_trade(self, bucket: int, side: int, btc: float):
        e = self.frame_trades.get(bucket)
        if e is None:
            e = self.frame_trades[bucket] = [0.0, 0.0]
        if side > 0:
            e[0] += btc
        else:
            e[1] += btc

    def sample(self, t_ms: float, last_px: float, ext=None):
        bk = self.book
        if not bk.synced or bk.best_bid is None or bk.best_ask is None:
            self.frame_trades = {}
            return None
        mid_b = int(bk.mid_ticks() // bk.bt)
        base = mid_b - self.R
        n = 2 * self.R + 1
        arr = array("f", bytes(4 * n))
        qs = float(bk.qs)
        bid_b, ask_b = bk.bid_b, bk.ask_b
        if self.v.inverse:
            cu = self.v.contract_usd
            bu = self.bucket_usd
            for i in range(n):
                b = base + i
                q = bid_b.get(b, 0) + ask_b.get(b, 0)
                if q:
                    arr[i] = q / qs * cu / ((b + 0.5) * bu)
        else:
            for i in range(n):
                b = base + i
                q = bid_b.get(b, 0) + ask_b.get(b, 0)
                if q:
                    arr[i] = q / qs
        trades = self.frame_trades
        self.frame_trades = {}
        bb, ba = bk.best_prices()
        parts = [HDR.pack(t_ms, bb, ba, base, n, len(trades), last_px or 0.0), arr.tobytes()]
        for b, (buy, sell) in trades.items():
            parts.append(TRD.pack(b, buy, sell))
        ext = ext or {}
        xt = [e for e in ext.get("xt", ()) if base <= e[0] < base + n]
        parts.append(U32.pack(len(xt)))
        for b, buy, sell in xt:
            parts.append(TRD.pack(b, buy, sell))
        cb = ext.get("cb", ())
        parts.append(U32.pack(len(cb)))
        for b, q in cb:
            parts.append(BQ.pack(b, q))
        ex = ext.get("ex", ())
        parts.append(U32.pack(len(ex)))
        for vid, buy, sell in ex:
            parts.append(TRD.pack(vid, buy, sell))
        parts.append(SZ.pack(*(ext.get("sz") or (0.0,) * 6)))
        lq = ext.get("liq") or (0.0, 0.0)
        parts.append(TAIL.pack(_f(ext.get("prem")), _f(ext.get("oi")), lq[0], lq[1]))
        rec = b"".join(parts)
        self.history.append(rec)
        self.columns += 1
        return rec


def pack_columns(records) -> bytes:
    return MSG_HDR.pack(MSG_COLUMNS, VERSION, len(records)) + b"".join(records)


def history_messages(history, chunk: int = 400):
    recs = list(history)
    return [pack_columns(recs[i:i + chunk]) for i in range(0, len(recs), chunk)]


def decode_columns(msg: bytes):
    """Decoder used by tests (mirrors the frontend)."""
    typ, ver, cnt = MSG_HDR.unpack_from(msg, 0)
    off = MSG_HDR.size
    out = []
    for _ in range(cnt):
        t, bb, ba, base, n, m, last = HDR.unpack_from(msg, off)
        off += HDR.size
        qty = array("f")
        qty.frombytes(msg[off:off + 4 * n])
        off += 4 * n
        trades = []
        for _ in range(m):
            trades.append(TRD.unpack_from(msg, off))
            off += TRD.size
        rec = {"t": t, "bb": bb, "ba": ba, "base": base, "qty": qty, "trades": trades, "last": last}
        if ver >= 2:
            def rd(fmt):
                nonlocal off
                (k,) = U32.unpack_from(msg, off)
                off += 4
                rows = []
                for _ in range(k):
                    rows.append(fmt.unpack_from(msg, off))
                    off += fmt.size
                return rows
            rec["xt"] = rd(TRD)
            rec["cb"] = rd(BQ)
            rec["ex"] = rd(TRD)
            rec["sz"] = SZ.unpack_from(msg, off)
            off += SZ.size
            rec["tail"] = TAIL.unpack_from(msg, off)
            off += TAIL.size
        out.append(rec)
    return out
