"""Order books of the other perp venues (Bybit, OKX) for the combined-liquidity heatmap.

Quantities are already converted to BTC by the adapters. Bucket sums are maintained incrementally.
OKX sends seqId/prevSeqId: a gap marks the book stale until the next snapshot (the IO layer resubscribes).
Bybit sends absolute sizes; u == 1 or type=snapshot resets the book.
"""
from __future__ import annotations


class XBook:
    def __init__(self, vid: int, tick: float, bucket_usd: float):
        self.vid = vid
        self.inv = 1.0 / tick
        self.bt = int(round(bucket_usd / tick))
        self.ok = False
        self.seq = None
        self.gaps = 0
        self.updates = 0
        self._reset()

    def _reset(self):
        self.bids: dict = {}
        self.asks: dict = {}
        self.bb: dict = {}     # bucket -> btc (bids)
        self.ab: dict = {}

    def _set(self, side, buckets, k, q):
        old = side.get(k, 0.0)
        if q > 0:
            side[k] = q
        else:
            side.pop(k, None)
            q = 0.0
        if q != old:
            b = k // self.bt
            v = buckets.get(b, 0.0) + q - old
            if v > 1e-9:
                buckets[b] = v
            else:
                buckets.pop(b, None)

    def apply(self, kind, bids, asks, seq=None, prev=None):
        if kind == "snapshot":
            self._reset()
            self.ok = True
        elif not self.ok:
            return False
        elif prev is not None and self.seq is not None and prev != self.seq and prev != -1:
            self.ok = False
            self.gaps += 1
            return False
        inv = self.inv
        for p, q in bids:
            self._set(self.bids, self.bb, int(round(p * inv)), q)
        for p, q in asks:
            self._set(self.asks, self.ab, int(round(p * inv)), q)
        if seq is not None:
            self.seq = seq
        self.updates += 1
        return True

    def mid(self):
        if not self.bids or not self.asks:
            return None
        return (max(self.bids) + min(self.asks)) / 2.0 / self.inv

    def bucket_total(self, b: int) -> float:
        return self.bb.get(b, 0.0) + self.ab.get(b, 0.0)
