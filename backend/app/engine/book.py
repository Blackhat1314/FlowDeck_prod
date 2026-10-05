"""Local order book built from Binance diff-depth events + REST/WS-API snapshots.

Follows Binance's documented futures sync procedure:
  1. buffer diff events, 2. fetch snapshot (lastUpdateId = L),
  3. drop events with u < L, 4. first applied event must satisfy U <= L <= u,
  5. afterwards every event's 'pu' must equal the previous event's 'u', otherwise resync.

Prices are stored as integer ticks, quantities as integer lots (exact, no float drift).
Per-bucket sums are maintained incrementally so a heatmap column is O(buckets).
"""
from __future__ import annotations

from collections import deque


class OrderBook:
    BUFFERING = "buffering"
    AWAIT_FIRST = "await_first"
    SYNCED = "synced"

    def __init__(self, tick: float, bucket_ticks: int, qty_scale: int):
        self.tick = tick
        self.inv_tick = 1.0 / tick
        self.bt = bucket_ticks
        self.qs = qty_scale
        self.state = self.BUFFERING
        self.buffer: deque = deque(maxlen=3000)
        self.events: deque = deque(maxlen=1200)   # (U, u, changed_bids, changed_asks) for integrity checks
        self.resyncs = 0
        self.crossed = 0
        self.updates = 0
        self.last_event_ms = 0
        self.chg = None            # set to a list to receive (side, price_int, old, new) per applied change
        self._reset()

    # ------------------------------------------------------------------ helpers
    def _reset(self):
        self.bids: dict = {}
        self.asks: dict = {}
        self.bid_b: dict = {}
        self.ask_b: dict = {}
        self.best_bid = None
        self.best_ask = None
        self.last_u = None
        self.snap_id = None

    def pi(self, p) -> int:
        return int(round(float(p) * self.inv_tick))

    def qi(self, q) -> int:
        return int(round(float(q) * self.qs))

    @property
    def synced(self) -> bool:
        return self.state == self.SYNCED

    @property
    def needs_snapshot(self) -> bool:
        return self.state == self.BUFFERING

    def _set(self, side: dict, buckets: dict, pi: int, qi: int):
        old = side.get(pi, 0)
        if qi == old:
            return old
        if qi:
            side[pi] = qi
        else:
            side.pop(pi, None)
        b = pi // self.bt
        v = buckets.get(b, 0) + qi - old
        if v:
            buckets[b] = v
        else:
            buckets.pop(b, None)
        return old

    # ------------------------------------------------------------------ input
    def on_diff(self, ev: dict) -> bool:
        """Feed one depthUpdate event. Returns True if applied to the live book."""
        if self.state == self.BUFFERING:
            self.buffer.append(ev)
            return False
        if self.state == self.AWAIT_FIRST:
            L = self.snap_id
            if ev["u"] < L:
                return False
            if ev["U"] <= L <= ev["u"]:
                self._apply(ev)
                self.state = self.SYNCED
                return True
            # first event already beyond the snapshot -> snapshot is stale
            self._desync(ev)
            return False
        # synced
        pu = ev.get("pu")
        if pu is not None and pu != self.last_u:
            self._desync(ev)
            return False
        self._apply(ev)
        return True

    def _desync(self, ev=None):
        self.resyncs += 1
        self.state = self.BUFFERING
        self.buffer.clear()
        if ev is not None:
            self.buffer.append(ev)

    def force_resync(self):
        """Called by the IO layer when the socket drops."""
        if self.state != self.BUFFERING:
            self.resyncs += 1
        self.state = self.BUFFERING
        self.buffer.clear()

    def on_snapshot(self, snap: dict) -> bool:
        """Load a snapshot {lastUpdateId, bids, asks}. Returns True when the book is (or will be) in sync."""
        L = int(snap["lastUpdateId"])
        self._reset()
        pi, qi = self.pi, self.qi
        for p, q in snap["bids"]:
            self._set(self.bids, self.bid_b, pi(p), qi(q))
        for p, q in snap["asks"]:
            self._set(self.asks, self.ask_b, pi(p), qi(q))
        self.best_bid = max(self.bids) if self.bids else None
        self.best_ask = min(self.asks) if self.asks else None
        self.last_u = L
        self.snap_id = L
        self.events.clear()
        buffered = list(self.buffer)
        self.buffer.clear()
        self.state = self.AWAIT_FIRST
        for ev in buffered:
            if self.state == self.BUFFERING:     # failed during replay
                self.buffer.append(ev)
                continue
            self.on_diff(ev)
        return self.state != self.BUFFERING

    def _apply(self, ev: dict):
        pi, qi = self.pi, self.qi
        bids, asks = self.bids, self.asks
        cb, ca = [], []
        bb, ba = self.best_bid, self.best_ask
        chg = self.chg
        for p, q in ev["b"]:
            k = pi(p)
            v = qi(q)
            old = self._set(bids, self.bid_b, k, v)
            if chg is not None and old != v:
                chg.append(("b", k, old, v))
            cb.append(k)
            if v and (bb is None or k > bb):
                bb = k
        for p, q in ev["a"]:
            k = pi(p)
            v = qi(q)
            old = self._set(asks, self.ask_b, k, v)
            if chg is not None and old != v:
                chg.append(("a", k, old, v))
            ca.append(k)
            if v and (ba is None or k < ba):
                ba = k
        if bb is not None and bb not in bids:
            bb = max(bids) if bids else None
        if ba is not None and ba not in asks:
            ba = min(asks) if asks else None
        self.best_bid, self.best_ask = bb, ba
        if bb is not None and ba is not None and bb >= ba:
            self.crossed += 1
        self.last_u = ev["u"]
        self.last_event_ms = ev.get("E", 0)
        self.updates += 1
        self.events.append((ev["U"], ev["u"], cb, ca))

    # ------------------------------------------------------------------ queries
    def best_prices(self):
        t = self.tick
        return (
            self.best_bid * t if self.best_bid is not None else None,
            self.best_ask * t if self.best_ask is not None else None,
        )

    def mid_ticks(self):
        if self.best_bid is None or self.best_ask is None:
            return None
        return (self.best_bid + self.best_ask) / 2.0

    def bucket_qty(self, side: str, b: int) -> int:
        return (self.bid_b if side == "bid" else self.ask_b).get(b, 0)

    def prune(self, pct: float):
        mid = self.mid_ticks()
        if mid is None:
            return 0
        lo, hi = mid * (1 - pct), mid * (1 + pct)
        n = 0
        for k in [k for k in self.bids if k < lo or k > hi]:
            self._set(self.bids, self.bid_b, k, 0)
            n += 1
        for k in [k for k in self.asks if k < lo or k > hi]:
            self._set(self.asks, self.ask_b, k, 0)
            n += 1
        return n

    def depth_ladder(self, levels_each: int, group_ticks: int):
        """Top-of-book ladder grouped by 'group_ticks' -> ([[price, qty_native], ...] bids, asks)."""
        if self.best_bid is None or self.best_ask is None:
            return [], []
        g = group_ticks
        out_b, out_a = [], []
        top = self.best_bid // g
        for i in range(levels_each):
            gb = top - i
            s = 0
            for k in range(gb * g, gb * g + g):
                s += self.bids.get(k, 0)
            out_b.append([gb * g * self.tick, s / self.qs])
        bot = self.best_ask // g
        for i in range(levels_each):
            ga = bot + i
            s = 0
            for k in range(ga * g, ga * g + g):
                s += self.asks.get(k, 0)
            out_a.append([ga * g * self.tick, s / self.qs])
        return out_b, out_a

    # ------------------------------------------------------------------ integrity
    def compare_snapshot(self, snap: dict, repair: bool = True):
        """Exact comparison vs an independent snapshot.

        Levels touched by events after the snapshot's lastUpdateId (or by the straddling event)
        are excluded; every other level must match exactly. Returns None if the local book has
        not caught up to the snapshot yet (caller retries), or a result dict.

        Categories:  qty_diff = known level with a wrong size (an engine bug if > 0)
                     stale    = level the engine shows that the exchange no longer has
                     missing  = level the engine never saw (outside the 1000-level window of the
                                original snapshot and untouched since - a data-feed limitation)
        With repair=True the untouched levels are then corrected from the snapshot, which is exact
        because nothing changed them after lastUpdateId.
        """
        if not self.synced:
            return {"status": "not_synced"}
        L = int(snap["lastUpdateId"])
        if self.last_u < L:
            return None
        ex_b, ex_a = set(), set()
        covered = False
        for U, u, cb, ca in reversed(self.events):
            if u <= L:
                covered = True
                break
            ex_b.update(cb)
            ex_a.update(ca)
        if not covered and self.events and self.events[0][0] > L:
            return {"status": "too_old"}
        res = {"status": "ok", "levels": 0, "match": 0, "qty_diff": 0, "missing": 0, "stale": 0, "excluded": 0}
        fixes = []
        for side, local, ex, rows in (("b", self.bids, ex_b, snap["bids"]), ("a", self.asks, ex_a, snap["asks"])):
            bk = self.bid_b if side == "b" else self.ask_b
            seen = set()
            lo = hi = None
            for p, q in rows:
                k = self.pi(p)
                v = self.qi(q)
                seen.add(k)
                lo = k if lo is None or k < lo else lo
                hi = k if hi is None or k > hi else hi
                if k in ex:
                    res["excluded"] += 1
                    continue
                res["levels"] += 1
                lv = local.get(k, 0)
                if lv == v:
                    res["match"] += 1
                elif lv == 0:
                    res["missing"] += 1
                    fixes.append((local, bk, k, v))
                else:
                    res["qty_diff"] += 1
                    fixes.append((local, bk, k, v))
            if lo is None:
                continue
            for k in local:
                if lo <= k <= hi and k not in seen and k not in ex:
                    res["stale"] += 1
                    res["levels"] += 1
                    fixes.append((local, bk, k, 0))
        known = res["levels"] - res["missing"]
        res["pct"] = 100.0 * res["match"] / res["levels"] if res["levels"] else None
        res["known_pct"] = 100.0 * res["match"] / known if known else None
        res["coverage_pct"] = 100.0 * known / res["levels"] if res["levels"] else None
        if repair and fixes:
            for local, bk, k, v in fixes:
                self._set(local, bk, k, v)
            if self.bids:
                self.best_bid = max(self.bids)
            if self.asks:
                self.best_ask = min(self.asks)
        res["repaired"] = len(fixes) if repair else 0
        res["lag_events"] = sum(1 for e in self.events if e[1] > L)
        return res
