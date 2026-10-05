"""Absorption detector.

An absorption is flagged at a price bucket when, inside a rolling window,
  * aggressive volume hitting that bucket >= threshold
        threshold = max(abs_min_btc, abs_rel * EMA(10-second market volume))
  * traded volume >= abs_ratio x the most liquidity that was visible there during the window
        (more was executed than was ever shown -> passive orders were refilled / iceberg)
  * price has not traded through the level by more than 'abs_tol_buckets' and the
    level keeps holding for 'abs_confirm_ms' after the threshold is reached.

Bid absorption = passive buyers soaking up market sells (bullish read);
ask absorption = passive sellers soaking up market buys (bearish read).
Each event is scored after 'abs_horizon_ms': the move from the level in the absorbing side's favour.
"""
from __future__ import annotations

from collections import deque


class _Tracker:
    __slots__ = ("start", "last", "hits", "vol", "visible0", "vis_max", "th_time", "emitted", "lo", "hi")

    def __init__(self, lt, visible0):
        self.start = lt
        self.last = lt
        self.hits = deque()
        self.vol = 0.0
        self.visible0 = visible0
        self.vis_max = visible0
        self.th_time = None
        self.emitted = 0
        self.lo = None
        self.hi = None


class AbsorptionDetector:
    def __init__(self, settings, bucket_usd: float):
        self.s = settings
        self.bu = bucket_usd
        self.tr: dict = {}
        self.ema10 = 0.0
        self._win_start = None
        self._win_vol = 0.0
        self.events: deque = deque(maxlen=400)
        self.pending: list = []        # events awaiting outcome
        self.new_events: list = []
        self.updates: list = []
        self.seq = 0
        self.scored = deque(maxlen=400)

    def threshold(self):
        return max(self.s.abs_min_btc, self.s.abs_rel * self.ema10)

    def on_trade(self, lt, side, price, bucket, btc, visible_btc_fn):
        # 10-second market volume EMA
        if self._win_start is None:
            self._win_start = lt
        self._win_vol += btc
        if lt - self._win_start >= 10_000:
            self.ema10 = self._win_vol if self.ema10 == 0 else 0.8 * self.ema10 + 0.2 * self._win_vol
            self._win_start, self._win_vol = lt, 0.0
        key = ("bid", bucket) if side < 0 else ("ask", bucket)
        t = self.tr.get(key)
        if t is None:
            t = self.tr[key] = _Tracker(lt, visible_btc_fn(key[0], bucket))
        t.hits.append((lt, btc))
        t.vol += btc
        t.last = lt
        if t.lo is None or price < t.lo:
            t.lo = price
        if t.hi is None or price > t.hi:
            t.hi = price

    def on_tick(self, lt, best_bid, best_ask, last_px, visible_btc_fn):
        s = self.s
        W = s.abs_window_ms
        thr = self.threshold()
        tol = s.abs_tol_buckets * self.bu
        for key in list(self.tr.keys()):
            t = self.tr[key]
            side, b = key
            lo_px = b * self.bu
            hi_px = lo_px + self.bu
            while t.hits and lt - t.hits[0][0] > W:
                t.vol -= t.hits.popleft()[1]
            vis = visible_btc_fn(side, b)
            if vis > t.vis_max:
                t.vis_max = vis
            if side == "bid":
                broken = best_bid is not None and best_bid < lo_px - tol
            else:
                broken = best_ask is not None and best_ask > hi_px + tol
            if broken or (not t.hits and lt - t.last > W):
                del self.tr[key]
                continue
            if self.ema10 > 0 and t.vol >= thr and t.vol >= s.abs_ratio * max(t.vis_max, 0.01):
                if t.th_time is None:
                    t.th_time = lt
                elif lt - t.th_time >= s.abs_confirm_ms:
                    self._emit(lt, side, lo_px, t, thr, vis)
                    t.hits.clear()
                    t.vol = 0.0
                    t.th_time = None
                    t.visible0 = t.vis_max = vis
            else:
                t.th_time = None
        self._score(lt, best_bid, best_ask, last_px)

    def _emit(self, lt, side, lo_px, t, thr, visible_now):
        self.seq += 1
        vol = sum(h[1] for h in t.hits)
        ev = {"id": self.seq, "t": int(lt), "side": side, "p": round(lo_px + self.bu / 2, 2),
              "vol": round(vol, 3), "vis0": round(t.vis_max, 3), "vis": round(visible_now, 3),
              "ratio": round(vol / max(t.vis_max, 0.01), 2), "thr": round(thr, 2),
              "dur": int(t.hits[-1][0] - t.hits[0][0]) if t.hits else 0,
              "strength": round(vol / thr, 2), "n": len(t.hits), "res": None}
        self.events.append(ev)
        self.new_events.append(ev)
        self.pending.append({"ev": ev, "mfe": 0.0, "mae": 0.0})

    def _score(self, lt, bb, ba, last_px):
        if not self.pending or last_px is None:
            return
        keep = []
        H = self.s.abs_horizon_ms
        for p in self.pending:
            ev = p["ev"]
            sign = 1 if ev["side"] == "bid" else -1
            move = (last_px - ev["p"]) * sign
            p["mfe"] = max(p["mfe"], move)
            p["mae"] = min(p["mae"], move)
            if lt - ev["t"] >= H:
                ev["res"] = {"move": round(move, 2), "mfe": round(p["mfe"], 2), "mae": round(p["mae"], 2),
                             "win": move > 0}
                self.scored.append(ev["res"])
                self.updates.append({"id": ev["id"], "res": ev["res"]})
            else:
                keep.append(p)
        self.pending = keep

    def stats(self):
        n = len(self.scored)
        if not n:
            return {"scored": 0}
        wins = sum(1 for r in self.scored if r["win"])
        return {"scored": n, "hit_rate": round(100 * wins / n, 1),
                "avg_move": round(sum(r["move"] for r in self.scored) / n, 2),
                "avg_mfe": round(sum(r["mfe"] for r in self.scored) / n, 2),
                "avg_mae": round(sum(r["mae"] for r in self.scored) / n, 2)}
