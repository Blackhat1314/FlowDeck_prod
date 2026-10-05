"""Estimated liquidation-level map (the kind of chart Coinglass / Hyblock sell). It is a MODEL.

No exchange publishes where open positions get liquidated. The estimate:
  * when open interest rises by dOI while price trades around P, new positions worth dOI were opened
    on both sides near P (every contract has a long and a short);
  * the aggressive side (taker buys -> longs, taker sells -> shorts) is weighted 1.0, the passive side 0.5;
  * positions are spread over a leverage mix; a long at leverage L liquidates near P*(1 - 1/L + mm),
    a short near P*(1 + 1/L - mm), with mm = maintenance margin;
  * when OI falls, all estimated positions shrink proportionally (closed);
  * when price trades through a level, positions there are treated as liquidated and removed;
  * everything decays slowly (half-life 48 h).
"""
from __future__ import annotations

import math

DEFAULT_LEVERAGE = ((5, 0.10), (10, 0.25), (25, 0.30), (50, 0.22), (100, 0.13))


class LiqMap:
    def __init__(self, bucket_usd=25.0, leverage=DEFAULT_LEVERAGE, mm=0.004, aggr_w=1.0, pass_w=0.5,
                 half_life_h=48.0):
        self.bu = bucket_usd
        self.lev = leverage
        self.mm = mm
        self.aw = aggr_w
        self.pw = pass_w
        self.k = math.log(2) / (half_life_h * 3600_000)
        self.long: dict = {}
        self.short: dict = {}
        self.prev_oi = None
        self.last_t = None
        self._b = self._s = self._pv = self._v = 0.0
        self._lo = self._hi = None
        self.updates = 0
        self.seeded = 0

    # ------------------------------------------------------------------ inputs
    def on_trade(self, p, btc, side):
        if side > 0:
            self._b += btc
        else:
            self._s += btc
        self._pv += p * btc
        self._v += btc
        if self._lo is None or p < self._lo:
            self._lo = p
        if self._hi is None or p > self._hi:
            self._hi = p

    def on_oi(self, oi, t, px_hint=None):
        if self.prev_oi is None:
            self.prev_oi, self.last_t = oi, t
            self._reset_acc()
            return
        if t - self.last_t > 0:
            f = math.exp(-self.k * (t - self.last_t))
            if f < 0.99999:
                self._scale(f)
        self.last_t = t
        price = (self._pv / self._v) if self._v else px_hint
        if self._lo is not None:
            self.consume(self._lo, self._hi)
        d = oi - self.prev_oi
        if d > 0 and price:
            tot = self._b + self._s
            wl = self._b / tot if tot else 0.5
            lw = self.aw * wl + self.pw * (1 - wl)
            sw = self.aw * (1 - wl) + self.pw * wl
            norm = (lw + sw) / 2 or 1.0
            self._open(price, d * lw / norm, d * sw / norm)
        elif d < 0 and self.prev_oi > 0:
            self._scale(max(0.0, oi / self.prev_oi))
        self.prev_oi = oi
        self.updates += 1
        self._reset_acc()

    def _reset_acc(self):
        self._b = self._s = self._pv = self._v = 0.0
        self._lo = self._hi = None

    def _open(self, p, longs, shorts):
        mm = self.mm
        bu = self.bu
        for L, w in self.lev:
            lp = p * (1 - 1.0 / L + mm)
            sp = p * (1 + 1.0 / L - mm)
            kb = int(lp // bu)
            ks = int(sp // bu)
            self.long[kb] = self.long.get(kb, 0.0) + longs * w
            self.short[ks] = self.short.get(ks, 0.0) + shorts * w

    def _scale(self, f):
        for d in (self.long, self.short):
            for k in list(d):
                v = d[k] * f
                if v < 1e-4:
                    del d[k]
                else:
                    d[k] = v

    def consume(self, lo, hi):
        """Price traded in [lo, hi]: long levels at/above lo and short levels at/below hi are liquidated."""
        if lo is not None:
            kl = int(lo // self.bu)
            for k in [k for k in self.long if k >= kl]:
                del self.long[k]
        if hi is not None:
            kh = int(hi // self.bu)
            for k in [k for k in self.short if k <= kh]:
                del self.short[k]

    def seed(self, rows):
        """rows: [(t_ms, oi_btc, open, high, low, close, volume, taker_buy_volume)] oldest first."""
        for t, oi, o, h, l, c, v, tb in rows:
            if v > 0:
                self._b += tb
                self._s += max(0.0, v - tb)
                tp = (h + l + c) / 3.0
                self._pv += tp * v
                self._v += v
                self._lo = l if self._lo is None else min(self._lo, l)
                self._hi = h if self._hi is None else max(self._hi, h)
            self.on_oi(oi, t, c)
            self.seeded += 1

    # ------------------------------------------------------------------ outputs
    def snapshot(self, price, span=0.15, top=4):
        if not price:
            return None
        lo, hi = price * (1 - span), price * (1 + span)
        bu = self.bu
        longs = sorted([[k * bu, round(v, 2)] for k, v in self.long.items() if lo <= k * bu <= price and v >= 0.01])
        shorts = sorted([[k * bu, round(v, 2)] for k, v in self.short.items() if price <= k * bu <= hi and v >= 0.01])

        def clusters(rows):
            # merge neighbouring buckets into clusters, rank by size
            cl = []
            for p, v in rows:
                if cl and p - cl[-1][1] <= 2 * bu:
                    c = cl[-1]
                    c[1] = p
                    c[2] += v
                    c[3] += p * v
                else:
                    cl.append([p, p, v, p * v])
            cl.sort(key=lambda c: -c[2])
            return [{"lo": c[0], "hi": c[1] + bu, "p": round(c[3] / c[2], 1), "btc": round(c[2], 1)} for c in cl[:top]]

        return {"bucket": bu, "long": longs, "short": shorts, "top_long": clusters(longs),
                "top_short": clusters(shorts), "seeded": self.seeded, "updates": self.updates,
                "total_long": round(sum(v for _, v in longs), 1), "total_short": round(sum(v for _, v in shorts), 1)}
