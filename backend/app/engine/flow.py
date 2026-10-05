"""Trade-flow engine: 1m footprint bars, sweeps (taker-order reconstruction), big trades, liquidations.

Volumes are kept in BTC for display (inverse contracts are converted at the trade price) and in
exact native integer lots ('rv', 'rbv') for integrity checks against exchange klines.
"""
from __future__ import annotations

from collections import deque

MIN = 60_000


class Bar:
    __slots__ = ("t", "o", "h", "l", "c", "oid", "cid", "v", "bv", "sv", "n", "nraw", "rv", "rbv",
                 "f", "L", "lv", "dirty", "approx", "gaps", "dcur", "dmax", "dmin", "oi_d", "oi",
                 "lq", "ll", "sl", "xl", "dsl", "dxl", "dll", "dmeta")

    def __init__(self, t: int):
        self.t = t
        self.o = self.h = self.l = self.c = None
        self.oid = None
        self.cid = None
        self.v = self.bv = self.sv = 0.0
        self.n = 0          # aggTrades
        self.nraw = 0       # raw exchange trades (sum of l-f+1)
        self.rv = 0         # native lots
        self.rbv = 0
        self.f = None       # first raw trade id
        self.L = None       # last raw trade id
        self.lv = {}        # bucket -> [buyBTC, sellBTC, buy trades, sell trades]
        self.dirty = set()
        self.approx = 0     # 1 = candle from exchange klines, 2 = tick detail trimmed (old)
        self.gaps = 0
        self.dcur = self.dmax = self.dmin = 0.0     # running delta inside the bar
        self.oi_d = 0.0     # open-interest change during the bar (sum over venues)
        self.oi = None      # open interest at the last update
        self.lq = [0.0, 0.0]                         # liquidated BTC: longs, shorts
        self.ll = {}        # bucket -> [long liq, short liq]
        self.sl = {}        # spot volume per bucket (basis-adjusted) -> [buy, sell]
        self.xl = {}        # other perps volume per bucket (basis-adjusted) -> [buy, sell]
        self.dsl = set()
        self.dxl = set()
        self.dll = set()
        self.dmeta = False

    def to_json(self, levels: str = "all"):
        d = {"t": self.t, "o": self.o, "h": self.h, "l": self.l, "c": self.c,
             "v": round(self.v, 4), "bv": round(self.bv, 4), "sv": round(self.sv, 4), "n": self.n,
             "dx": [round(self.dmax, 3), round(self.dmin, 3)], "oi": [round(self.oi_d, 3), self.oi],
             "lq": [round(self.lq[0], 3), round(self.lq[1], 3)]}
        if self.approx:
            d["ax"] = self.approx
        full = levels == "all"
        if full:
            keys, ks, kx, kl = self.lv.keys(), self.sl.keys(), self.xl.keys(), self.ll.keys()
        elif levels == "dirty":
            keys, ks, kx, kl = self.dirty, self.dsl, self.dxl, self.dll
        else:
            keys = ks = kx = kl = ()
        flat = []
        for b in keys:
            e = self.lv.get(b)
            if e is not None:
                flat.extend((b, round(e[0], 4), round(e[1], 4), e[2], e[3]))
        if flat or full:
            d["lv"] = flat
        for name, src, kk in (("sl", self.sl, ks), ("xl", self.xl, kx), ("ll", self.ll, kl)):
            f2 = []
            for b in kk:
                e = src.get(b)
                if e is not None:
                    f2.extend((b, round(e[0], 4), round(e[1], 4)))
            if f2 or (full and src):
                d[name] = f2
        return d

    def touch(self):
        return bool(self.dirty or self.dsl or self.dxl or self.dll or self.dmeta)

    def clean(self):
        self.dirty = set()
        self.dsl = set()
        self.dxl = set()
        self.dll = set()
        self.dmeta = False


class Sweep:
    __slots__ = ("id", "T", "lt", "s", "q", "usd", "lo", "hi", "n")

    def __init__(self, a, T, lt, s, p, q):
        self.id, self.T, self.lt, self.s = a, T, lt, s
        self.q = q
        self.usd = p * q
        self.lo = self.hi = p
        self.n = 1

    def add(self, p, q):
        self.q += q
        self.usd += p * q
        if p < self.lo:
            self.lo = p
        if p > self.hi:
            self.hi = p
        self.n += 1

    def to_json(self):
        return {"id": self.id, "t": self.T, "lt": int(self.lt), "s": self.s, "q": round(self.q, 4),
                "p": round(self.usd / self.q, 2) if self.q else self.lo, "lo": self.lo, "hi": self.hi,
                "n": self.n, "usd": round(self.usd)}


class SweepGrouper:
    """aggTrades from one taker order share the same trade time T and side -> group them."""

    def __init__(self):
        self.cur: Sweep | None = None

    def add(self, a, T, lt, s, p, q):
        c = self.cur
        if c is not None and c.T == T and c.s == s:
            c.add(p, q)
            return None
        self.cur = Sweep(a, T, lt, s, p, q)
        return c

    def flush(self, lt, idle_ms=120):
        c = self.cur
        if c is not None and lt - c.lt >= idle_ms:
            self.cur = None
            return c
        return None

    def flush_all(self):
        c, self.cur = self.cur, None
        return c


class Flow:
    def __init__(self, venue, settings, bucket_ticks: int, vid: int = 0):
        self.vid = vid
        self.v = venue
        self.s = settings
        self.bt = bucket_ticks
        self.inv_tick = 1.0 / venue.tick
        self.bars: dict = {}
        self.order: deque = deque()
        self.live_g = SweepGrouper()
        self.back_g = SweepGrouper()
        self.sweeps: deque = deque(maxlen=3000)
        self.new_sweeps: list = []
        self.liqs: deque = deque(maxlen=500)
        self.new_liqs: list = []
        self.last_px = None
        self.prev_px = None
        self.last_a = None
        self.agg_gaps = 0
        self.live_trades = 0
        self.live_since_T = None       # T of first live trade
        self.first_live_a = None
        self.coverage_from = None      # bars with t >= this are fully covered by tick data
        self.vol_10s = 0.0             # rolling helpers for absorption
        self.cvd_live = 0.0

    # ------------------------------------------------------------------ bars
    def _bar(self, t: int) -> Bar:
        b = self.bars.get(t)
        if b is None:
            b = self.bars[t] = Bar(t)
            # keep insertion ordered by time (backfill may insert older bars)
            if not self.order or t > self.order[-1]:
                self.order.append(t)
            else:
                lst = sorted(list(self.order) + [t])
                self.order = deque(lst)
            while len(self.order) > self.s.bars_keep:
                old = self.order.popleft()
                self.bars.pop(old, None)
        return b

    def to_btc(self, p: float, q: float) -> float:
        return q * self.v.contract_usd / p if self.v.inverse else q

    def on_trade(self, ev: dict, lt: float, live: bool = True):
        """Process one aggTrade. Returns (bucket, side, btc, price) for live trades."""
        p = float(ev["p"])
        qn = float(ev["q"])
        T = int(ev["T"])
        a = int(ev["a"])
        side = -1 if ev["m"] else 1
        btc = self.to_btc(p, qn)
        bkt = int(round(p * self.inv_tick)) // self.bt
        t = T - T % MIN
        bar = self.bars.get(t) or self._bar(t)
        if bar.approx == 1:       # kline placeholder gets replaced by real ticks
            bar.__init__(t)
        if bar.oid is None or a < bar.oid:
            bar.oid, bar.o = a, p
        if bar.cid is None or a > bar.cid:
            bar.cid, bar.c = a, p
        if bar.h is None or p > bar.h:
            bar.h = p
        if bar.l is None or p < bar.l:
            bar.l = p
        bar.v += btc
        qi = int(round(qn * self.v.qty_scale))
        bar.rv += qi
        if side > 0:
            bar.bv += btc
            bar.rbv += qi
        else:
            bar.sv += btc
        bar.n += 1
        f, l = int(ev.get("f", 0)), int(ev.get("l", 0))
        bar.nraw += l - f + 1
        if bar.f is None or f < bar.f:
            bar.f = f
        if bar.L is None or l > bar.L:
            bar.L = l
        e = bar.lv.get(bkt)
        if e is None:
            e = bar.lv[bkt] = [0.0, 0.0, 0, 0]
        if side > 0:
            e[0] += btc
            e[2] += 1
        else:
            e[1] += btc
            e[3] += 1
        bar.dirty.add(bkt)
        bar.dcur += btc * side
        if bar.dcur > bar.dmax:
            bar.dmax = bar.dcur
        if bar.dcur < bar.dmin:
            bar.dmin = bar.dcur

        g = self.live_g if live else self.back_g
        done = g.add(a, T, lt, side, p, btc)
        if done is not None:
            self._emit_sweep(done, live)

        if live:
            if self.last_a is not None and a != self.last_a + 1 and a > self.last_a:
                gap = a - self.last_a - 1
                self.agg_gaps += gap
                bar.gaps += gap
            if self.last_a is None or a > self.last_a:
                self.last_a = a
            if self.live_since_T is None:
                self.live_since_T = T
                self.first_live_a = a
            self.live_trades += 1
            self.prev_px = self.last_px
            self.last_px = p
            self.cvd_live += btc * side
            return bkt, side, btc, p
        return None

    def _emit_sweep(self, sw: Sweep, live: bool):
        if sw.q >= self.s.tape_min_btc:
            j = sw.to_json()
            j["x"] = self.vid
            if not live:
                j["bf"] = 1
            self.sweeps.append(j)
            if live:
                self.new_sweeps.append(j)

    def flush(self, lt):
        done = self.live_g.flush(lt)
        if done is not None:
            self._emit_sweep(done, True)

    def finish_backfill(self):
        done = self.back_g.flush_all()
        if done is not None:
            self._emit_sweep(done, False)
        # re-sort tape by time after merging historic sweeps
        self.sweeps = deque(sorted(self.sweeps, key=lambda j: (j["t"], j["id"])), maxlen=self.sweeps.maxlen)

    # ------------------------------------------------------------------ klines (approx history)
    def apply_kline_rows(self, rows, before_t: int):
        """REST kline rows -> bars without levels (approx), only for minutes < before_t."""
        inv = self.v.inverse
        added = False
        for r in rows:
            t = int(r[0])
            if t >= before_t or t in self.bars:
                continue
            b = self.bars[t] = Bar(t)
            added = True
            b.o, b.h, b.l, b.c = float(r[1]), float(r[2]), float(r[3]), float(r[4])
            if inv:
                v, bv = float(r[7]), float(r[10])     # base asset (BTC) volume fields
            else:
                v, bv = float(r[5]), float(r[9])
            b.v, b.bv, b.sv = v, bv, v - bv
            b.n = int(r[8])
            b.approx = 1
        if added:
            self.order = deque(sorted(self.bars))
            while len(self.order) > self.s.bars_keep:
                self.bars.pop(self.order.popleft(), None)

    # ------------------------------------------------------------------ liquidations
    def on_force_order(self, ev: dict, lt: float):
        o = ev.get("o", ev)
        p = float(o.get("ap") or o.get("p"))
        q = float(o.get("z") or o.get("q"))
        btc = self.to_btc(p, q)
        j = {"t": int(o.get("T", ev.get("E", 0))), "lt": int(lt),
             "side": "long" if o.get("S") == "SELL" else "short",
             "p": p, "q": round(btc, 4), "usd": round(p * btc)}
        self.liqs.append(j)
        self.new_liqs.append(j)

    # ------------------------------------------------------------------ output helpers
    # ------------------------------------------------------------------ cross-venue additions
    def _cur(self, t_ms):
        t = int(t_ms) - int(t_ms) % MIN
        b = self.bars.get(t)
        if b is None:
            if self.order and t < self.order[-1] - 2 * MIN:
                return None
            b = self._bar(t)
        if b.approx == 1:
            return None
        return b

    def add_side_volume(self, which: str, t_ms, bucket: int, side: int, btc: float):
        """which = 'sl' (spot) or 'xl' (other perps); prices already basis-adjusted to the primary."""
        b = self._cur(t_ms)
        if b is None:
            return
        d = b.sl if which == "sl" else b.xl
        e = d.get(bucket)
        if e is None:
            e = d[bucket] = [0.0, 0.0]
        e[0 if side > 0 else 1] += btc
        (b.dsl if which == "sl" else b.dxl).add(bucket)

    def add_liq(self, t_ms, bucket: int, side: str, btc: float):
        b = self._cur(t_ms)
        if b is None:
            return
        i = 0 if side == "long" else 1
        b.lq[i] += btc
        e = b.ll.get(bucket)
        if e is None:
            e = b.ll[bucket] = [0.0, 0.0]
        e[i] += btc
        b.dll.add(bucket)
        b.dmeta = True

    def add_oi(self, t_ms, delta: float, oi_now):
        b = self._cur(t_ms)
        if b is None:
            return
        if delta:
            b.oi_d += delta
            b.dmeta = True
        if oi_now is not None and oi_now != b.oi:
            b.oi = round(oi_now, 2)
            b.dmeta = True

    def trim(self, now_ms):
        """Free memory: drop per-price detail of old bars (kept: OHLCV, delta, OI, liquidations)."""
        keep_lv = now_ms - self.s.extra.get("levels_keep_min", 1440) * MIN
        keep_x = now_ms - self.s.extra.get("xlevels_keep_min", 360) * MIN
        for t in self.order:
            if t >= keep_x:
                break
            b = self.bars[t]
            if b.sl or b.xl:
                b.sl, b.xl = {}, {}
            if t < keep_lv and b.lv and b.approx == 0:
                b.lv = {}
                b.approx = 2

    def dirty_bars(self):
        out = []
        for t in list(self.order)[-3:]:
            b = self.bars.get(t)
            if b is not None and b.touch():
                out.append(b.to_json("dirty"))
                b.clean()
        return out

    def bars_json(self, n: int | None = None):
        ts = list(self.order)
        if n:
            ts = ts[-n:]
        out = []
        for t in ts:
            b = self.bars[t]
            b.clean()
            out.append(b.to_json("all"))
        return out
