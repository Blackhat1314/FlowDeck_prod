"""Synthetic BTC perpetual market that emits Binance-format messages (depthUpdate with U/u/pu,
aggTrade, markPriceUpdate, forceOrder, kline, 24hrTicker) plus a Deribit-style option chain.

Used for `python run.py --demo` (offline UI demo) and for the automated tests. It is not used
when the app runs against the real exchange.
"""
from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone


def _fmt(x, d):
    return f"{x:.{d}f}"


class MarketSim:
    def __init__(self, start_px=84_800.0, seed=7, tick=0.1, now_ms=0):
        self.r = random.Random(seed)
        self.tick = tick
        self.mid = start_px
        self.bids = {}
        self.asks = {}
        self.u = 10_000_000
        self.agg = 3_000_000_000
        self.raw = 8_000_000_000
        self.trend = 0.0
        self.walls = []
        self.t = now_ms
        self.kl = None
        self.kl_closed = []
        self.oi = 82_000.0
        self.day_open = start_px
        self.fair = start_px
        self._seed_book()

    # -------------------------------------------------------------- book helpers
    def _pi(self, p):
        return int(round(p / self.tick))

    def _qty(self, dist):
        r = self.r
        base = r.lognormvariate(-1.0, 1.1)
        if dist < 30:
            base *= 1.8
        if self.r.random() < 0.015:
            base *= r.uniform(8, 30)
        return round(min(base, 400.0), 3)

    def _seed_book(self):
        bb = self._pi(self.mid) - 1
        for i in range(0, 9000):
            if i < 1500 or self.r.random() < 0.35:
                self.bids[bb - i] = self._qty(i)
                self.asks[bb + 1 + i] = self._qty(i)
        self.bbk, self.bak = bb, bb + 1
        for _ in range(10):
            self._new_wall()

    def _new_wall(self):
        side = self.r.choice(("b", "a"))
        off = self.r.uniform(40, 1100) / self.tick
        k = self._pi(self.fair) + int(-off if side == "b" else off)
        k -= k % 10                          # round-ish numbers
        if self.r.random() < 0.4:
            k -= k % 500
        size = round(self.r.uniform(40, 260), 3)
        self.walls.append({"side": side, "k": k, "q": size, "life": self.r.randint(600, 6000), "ice": self.r.random() < 0.35})

    def best(self):
        return self.bbk, self.bak

    def _fix_best(self):
        k = self.bbk
        n = 0
        while k not in self.bids and n < 20000:
            k -= 1
            n += 1
        self.bbk = k if n < 20000 else max(self.bids)
        k = self.bak
        n = 0
        while k not in self.asks and n < 20000:
            k += 1
            n += 1
        self.bak = k if n < 20000 else min(self.asks)

    def _setb(self, k, q, ch):
        if q <= 0:
            if k in self.bids:
                del self.bids[k]
                ch[k] = 0.0
        else:
            self.bids[k] = q
            ch[k] = q
            if k > self.bbk:
                self.bbk = k

    def _seta(self, k, q, ch):
        if q <= 0:
            if k in self.asks:
                del self.asks[k]
                ch[k] = 0.0
        else:
            self.asks[k] = q
            ch[k] = q
            if k < self.bak:
                self.bak = k

    # -------------------------------------------------------------- step
    def step(self, dt_ms=100):
        """Advance 100 ms; returns list of (stream_kind, payload)."""
        r = self.r
        self.t += dt_ms
        out = []
        ch_b, ch_a = {}, {}
        trades = []

        # regime: occasional trend bursts
        if r.random() < 0.004:
            self.trend = r.choice((-1, 1)) * r.uniform(0.5, 2.0)
        self.trend *= 0.993
        n_tr = sum(1 for _ in range(12) if r.random() < 0.26)
        bias = 0.5 + max(-0.3, min(0.3, self.trend * 0.12))
        for _ in range(n_tr):
            side = 1 if r.random() < bias else -1
            q = round(r.lognormvariate(-3.6, 1.6), 3) or 0.001
            if r.random() < 0.012:
                q = round(r.uniform(4, 40), 3)
            trades.append((side, q))

        # execute against the book
        net = 0.0
        for ti, (side, q) in enumerate(trades):
            T = self.t - 60 + ti
            ch = ch_a if side > 0 else ch_b
            rem = q
            k = None
            while rem > 1e-9:
                self._fix_best()
                k = self.bak if side > 0 else self.bbk
                book = self.asks if side > 0 else self.bids
                avail = book[k]
                w = next((w for w in self.walls if w["k"] == k and w["ice"] and (w["side"] == "a") == (side > 0)), None)
                fill = min(rem, avail)
                self.agg += 1
                nraw = max(1, int(fill / 0.05) % 6 + 1)
                f0 = self.raw + 1
                self.raw += nraw
                out.append(("market", {"e": "aggTrade", "E": T + 5, "a": self.agg, "s": "BTCUSDT",
                                       "p": _fmt(k * self.tick, 1), "q": _fmt(fill, 3), "f": f0,
                                       "l": self.raw, "T": T, "m": side < 0}))
                self._kline_add(T, k * self.tick, fill, side, nraw, f0, self.raw)
                rem -= fill
                left = round(avail - fill, 3)
                if w is not None and left < 1:
                    left = round(r.uniform(3, 12), 3)       # iceberg refill
                    w["q"] -= fill
                    if w["q"] <= 0:
                        w["ice"] = False
                if side > 0:
                    self._seta(k, left, ch)
                else:
                    self._setb(k, left, ch)
            net += side * q
            if r.random() < 0.004 and q > 2 and k is not None:
                lq = round(q * r.uniform(0.2, 1.0), 3)
                out.append(("market", {"e": "forceOrder", "E": T + 3, "o": {
                    "s": "BTCUSDT", "S": "SELL" if side < 0 else "BUY", "o": "LIMIT", "f": "IOC", "q": _fmt(lq, 3),
                    "p": _fmt(k * self.tick, 1), "ap": _fmt(k * self.tick, 1), "X": "FILLED",
                    "l": _fmt(lq, 3), "z": _fmt(lq, 3), "T": T}}))
        self._fix_best()

        # fair value drifts with trend, noise and order-flow impact; makers re-quote around it
        self.fair += self.trend * 0.35 + r.gauss(0, 0.7) + 0.45 * net
        fk = int(self.fair / self.tick)
        tb, ta = fk, fk + 1
        for k in range(tb + 1, self.bbk + 1):          # bids above fair get pulled / hit
            self._setb(k, 0, ch_b)
        for k in range(self.bak, ta):                    # asks below fair get pulled / lifted
            self._seta(k, 0, ch_a)
        self.bbk = min(self.bbk, tb)
        self.bak = max(self.bak, ta)
        for i in range(0, 3):
            if tb - i not in self.bids:
                self._setb(tb - i, self._qty(i), ch_b)
            if ta + i not in self.asks:
                self._seta(ta + i, self._qty(i), ch_a)
        self._fix_best()
        bb, ba = self.bbk, self.bak
        for i in range(3, 80):
            if bb - i not in self.bids and r.random() < 0.15:
                self._setb(bb - i, self._qty(i), ch_b)
            if ba + i not in self.asks and r.random() < 0.15:
                self._seta(ba + i, self._qty(i), ch_a)
        # random adds / cancels across depth
        for _ in range(40):
            d = 1 + int(abs(r.gauss(0, 900)))
            if r.random() < 0.5:
                k = bb - d
                self._setb(k, 0 if (k in self.bids and r.random() < 0.5) else self._qty(d), ch_b)
            else:
                k = ba + d
                self._seta(k, 0 if (k in self.asks and r.random() < 0.5) else self._qty(d), ch_a)
        self._fix_best()
        bb, ba = self.bbk, self.bak
        # walls
        for w in list(self.walls):
            w["life"] -= 1
            crossed = (w["side"] == "b" and w["k"] >= ba) or (w["side"] == "a" and w["k"] <= bb)
            if w["life"] <= 0 or crossed:
                self.walls.remove(w)
                if not crossed:
                    (self._setb if w["side"] == "b" else self._seta)(w["k"], self._qty(5), ch_b if w["side"] == "b" else ch_a)
                continue
            book = self.bids if w["side"] == "b" else self.asks
            if book.get(w["k"], 0) < w["q"] * 0.7 and not w["ice"]:
                (self._setb if w["side"] == "b" else self._seta)(w["k"], round(w["q"], 3), ch_b if w["side"] == "b" else ch_a)
        if len(self.walls) < 12 and r.random() < 0.02:
            self._new_wall()
        self._fix_best()

        if ch_b or ch_a:
            U = self.u + 1
            self.u += r.randint(len(ch_b) + len(ch_a), len(ch_b) + len(ch_a) + 400)
            out.append(("book", {"e": "depthUpdate", "E": self.t, "T": self.t - 2, "s": "BTCUSDT",
                                 "U": U, "u": self.u, "pu": U - 1,
                                 "b": [[_fmt(k * self.tick, 1), _fmt(q, 3)] for k, q in ch_b.items()],
                                 "a": [[_fmt(k * self.tick, 1), _fmt(q, 3)] for k, q in ch_a.items()]}))
        bb, ba = self.bbk, self.bak
        self.mid = (bb + ba) / 2 * self.tick

        if self.t % 1000 < dt_ms:
            self.oi += r.gauss(0, 3)
            out.append(("market", {"e": "markPriceUpdate", "E": self.t, "s": "BTCUSDT",
                                   "p": _fmt(self.mid + r.gauss(0, 1.5), 2), "i": _fmt(self.mid - 18 + r.gauss(0, 1), 2),
                                   "P": _fmt(self.mid, 2), "r": "0.00008100",
                                   "T": (self.t // 28_800_000 + 1) * 28_800_000}))
            chg = (self.mid / self.day_open - 1) * 100
            out.append(("market", {"e": "24hrTicker", "E": self.t, "s": "BTCUSDT", "P": _fmt(chg, 3),
                                   "c": _fmt(self.mid, 1), "h": _fmt(max(self.mid, self.day_open) + 650, 1),
                                   "l": _fmt(min(self.mid, self.day_open) - 720, 1), "v": "128734.211",
                                   "q": _fmt(128734.211 * self.mid, 2)}))
        for k in self.kl_closed:
            out.append(("market", {"e": "kline", "E": k["T"] + 1, "s": "BTCUSDT", "k": k}))
        self.kl_closed = []
        return out

    u_prev = None
    liq_pending = None

    def _kline_add(self, T, p, q, side, nraw, f, l):
        t = T - T % 60_000
        k = self.kl
        if k is None or k["t"] != t:
            if k is not None:
                if t < k["t"]:
                    t = k["t"]
                else:
                    k["x"] = True
                    self.kl_closed.append(self._kl_fmt(k))
            if k is None or t != k["t"]:
                k = self.kl = {"t": t, "T": t + 59_999, "o": p, "h": p, "l": p, "c": p, "v": 0.0, "V": 0.0,
                               "n": 0, "f": f, "L": l, "x": False}
        k["h"], k["l"], k["c"] = max(k["h"], p), min(k["l"], p), p
        k["v"] += q
        if side > 0:
            k["V"] += q
        k["n"] += nraw
        k["L"] = l

    def _kl_fmt(self, k):
        return {"t": k["t"], "T": k["T"], "s": "BTCUSDT", "i": "1m", "f": k["f"], "L": k["L"],
                "o": _fmt(k["o"], 1), "c": _fmt(k["c"], 1), "h": _fmt(k["h"], 1), "l": _fmt(k["l"], 1),
                "v": _fmt(k["v"], 3), "n": k["n"], "x": True, "q": "0", "V": _fmt(k["V"], 3), "Q": "0", "B": "0"}

    def snapshot(self, limit=1000):
        bids = sorted(self.bids.items(), reverse=True)[:limit]
        asks = sorted(self.asks.items())[:limit]
        return {"lastUpdateId": self.u,
                "bids": [[_fmt(k * self.tick, 1), _fmt(q, 3)] for k, q in bids],
                "asks": [[_fmt(k * self.tick, 1), _fmt(q, 3)] for k, q in asks]}

    def history_klines(self, minutes, end_t):
        """Fake 1m kline rows (REST format) leading up to end_t, ending near the current price."""
        rows = []
        px = self.mid
        seq = []
        for i in range(minutes):
            seq.append(px)
            px += self.r.gauss(0, 38)
        seq.reverse()
        for i, o in enumerate(seq):
            t = end_t - (minutes - i) * 60_000
            c = seq[i + 1] if i + 1 < len(seq) else self.mid
            h = max(o, c) + abs(self.r.gauss(0, 14))
            l = min(o, c) - abs(self.r.gauss(0, 14))
            v = abs(self.r.gauss(140, 60)) + 20
            bv = v * min(0.9, max(0.1, 0.5 + (c - o) / 200))
            rows.append([t, _fmt(o, 1), _fmt(h, 1), _fmt(l, 1), _fmt(c, 1), _fmt(v, 3), t + 59_999,
                         _fmt(v * o, 2), int(v * 18), _fmt(bv, 3), _fmt(bv * o, 2), "0"])
        return rows

    def option_chain(self, now_ms):
        """Deribit get_book_summary_by_currency-like rows."""
        r = random.Random(int(now_ms // 600_000))
        spot = self.mid - 18
        now = datetime.fromtimestamp(now_ms / 1000, tz=timezone.utc)
        exps = []
        d = now.replace(hour=8, minute=0, second=0, microsecond=0)
        if d <= now:
            d += timedelta(days=1)
        for i in range(3):
            exps.append(d + timedelta(days=i))
        fri = d + timedelta(days=(4 - d.weekday()) % 7)
        for i in range(4):
            exps.append(fri + timedelta(days=7 * i))
        for m in (1, 2, 3, 6):
            y, mo = now.year + (now.month - 1 + m) // 12, (now.month - 1 + m) % 12 + 1
            last = datetime(y, mo, 28, 8, tzinfo=timezone.utc)
            while last.weekday() != 4:
                last -= timedelta(days=1)
            exps.append(last)
        rows = []
        mons = "JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split()
        for e in sorted(set(exps)):
            T = (e - now).total_seconds() / 31_536_000
            name = f"{e.day}{mons[e.month - 1]}{e.strftime('%y')}"
            F = spot * (1 + 0.06 * T)
            for K in range(50_000, 150_001, 1000):
                m = math.log(K / F)
                if abs(m) > 0.6:
                    continue
                iv = 38 + 55 * m * m - 6 * m + 6 / (1 + 40 * T)
                w = math.exp(-abs(m) * 7) * (1 + 3 * (K % 5000 == 0)) * (0.4 + T ** 0.5)
                for cp in ("C", "P"):
                    tilt = 1.25 if (cp == "C" and K > spot) or (cp == "P" and K < spot) else 0.5
                    oi = round(max(0.0, r.gauss(1, 0.3)) * w * tilt * 900, 1)
                    rows.append({"instrument_name": f"BTC-{name}-{K}-{cp}", "open_interest": oi,
                                 "mark_iv": round(iv, 2), "underlying_price": round(F, 2),
                                 "estimated_delivery_price": round(spot, 2)})
        return rows
