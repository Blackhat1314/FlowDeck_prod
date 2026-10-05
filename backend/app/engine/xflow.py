"""Cross-exchange flow: aggregated tape and CVD, spot vs perp, Coinbase premium, CVD by taker-order size,
open interest across venues, funding, unified liquidations with a cascade detector, and the
spot/perp leadership regime (scored after 5 minutes).

All venues feed normalized events from xchg.py. The primary venue (whose book drives the heatmap)
also feeds its trades here so the aggregates include it.
"""
from __future__ import annotations

from collections import deque

from .xchg import BY_ID, XVENUES

SIZE_EDGES = (1.0, 10.0)            # taker order size classes: <1, 1-10, >=10 BTC
REGIME_WIN = 300                     # seconds
REGIME_EVERY = 10_000                # ms
REGIME_HORIZON = 300_000             # score regime calls after 5 min

REGIMES = {
    "spot_led_up": ("Spot-led rally", 1),
    "perp_led_up": ("Perp-led rally, spot not buying", -1),
    "broad_up": ("Broad buying (spot + perps)", 1),
    "spot_led_down": ("Spot-led selloff", -1),
    "perp_led_down": ("Perp-led selloff, spot not selling", 1),
    "broad_down": ("Broad selling (spot + perps)", -1),
    "spot_bid_perp_sold": ("Spot buying while perps sell", 1),
    "spot_sold_perp_bid": ("Spot selling while perps buy", -1),
}


class _Group:
    __slots__ = ("key", "s", "t", "lt", "q", "usd", "lo", "hi", "n", "tid")

    def __init__(self, key, s, t, lt, p, q, tid):
        self.key, self.s, self.t, self.lt, self.tid = key, s, t, lt, tid
        self.q = q
        self.usd = p * q
        self.lo = self.hi = p
        self.n = 1


class VState:
    __slots__ = ("px", "px_t", "basis", "oi", "oi_t", "fund", "next_fund", "msgs", "last_msg", "trades")

    def __init__(self):
        self.px = None
        self.px_t = 0
        self.basis = None
        self.oi = None
        self.oi_t = 0
        self.fund = None
        self.next_fund = None
        self.msgs = 0
        self.last_msg = 0
        self.trades = 0


class XFlow:
    def __init__(self, primary_vid: int, settings, bucket_usd: float):
        self.pv = primary_vid
        self.s = settings
        self.bu = bucket_usd
        self.v = {vid: VState() for vid in BY_ID}
        self.groups = {vid: None for vid in BY_ID}
        # per heatmap column
        self.col_ex: dict = {}
        self.col_xt: dict = {}
        self.col_sz = [0.0] * 6
        self.col_liq = [0.0, 0.0]
        # per second history (1 h)
        self.sec: deque = deque(maxlen=3600)
        self._sec = None
        self._acc = self._new_acc()
        # outputs
        self.new_sweeps: list = []
        self.tape: deque = deque(maxlen=3000)       # other venues' sweeps (primary ones live in Flow)
        self.liqs: deque = deque(maxlen=1500)
        self.new_liqs: list = []
        self.events: deque = deque(maxlen=300)      # cascades + regime calls
        self.new_events: list = []
        self.event_updates: list = []
        self.pending_scores: list = []
        self.scored: deque = deque(maxlen=400)
        self.regime = {"state": "neutral", "label": "Not enough data yet", "since": None}
        self._next_regime = 0
        self._casc_last = {"long": 0, "short": 0}
        self._liq_ema = 0.0
        self._liq_ema_t = 0
        self.usdt = None
        self.oi_delta = 0.0
        self.oi_cum = 0.0
        self.seq = 0

    @staticmethod
    def _new_acc():
        return {"pb": 0.0, "ps": 0.0, "sb": 0.0, "ss": 0.0, "sz": [0.0] * 6, "ll": 0.0, "ls": 0.0}

    # ------------------------------------------------------------------ inputs
    def on_trade(self, vid, t, p, btc, side, gkey, tid, lt, primary_px):
        st = self.v[vid]
        st.px, st.px_t = p, t
        st.msgs += 1
        st.trades += 1
        st.last_msg = lt
        ven = BY_ID[vid]
        if vid != self.pv and primary_px:
            d = p - primary_px
            st.basis = d if st.basis is None else st.basis + 0.02 * (d - st.basis)
        e = self.col_ex.get(vid)
        if e is None:
            e = self.col_ex[vid] = [0.0, 0.0]
        a = self._acc
        if side > 0:
            e[0] += btc
            if ven.kind == "perp":
                a["pb"] += btc
            else:
                a["sb"] += btc
        else:
            e[1] += btc
            if ven.kind == "perp":
                a["ps"] += btc
            else:
                a["ss"] += btc
        if vid != self.pv and ven.kind == "perp":
            adj = p - (st.basis or 0.0)
            b = int(adj // self.bu)
            x = self.col_xt.get(b)
            if x is None:
                x = self.col_xt[b] = [0.0, 0.0]
            x[0 if side > 0 else 1] += btc
        g = self.groups[vid]
        if g is not None and g.key == gkey and g.s == side:
            g.q += btc
            g.usd += p * btc
            if p < g.lo:
                g.lo = p
            if p > g.hi:
                g.hi = p
            g.n += 1
        else:
            self.groups[vid] = _Group(gkey, side, t, lt, p, btc, tid)
            if g is not None:
                self._done(vid, g)

    def _done(self, vid, g):
        ven = BY_ID[vid]
        if ven.kind == "perp":
            k = 0 if g.q < SIZE_EDGES[0] else (2 if g.q < SIZE_EDGES[1] else 4)
            k += 0 if g.s > 0 else 1
            self.col_sz[k] += g.q
            self._acc["sz"][k] += g.q
        if vid != self.pv and g.q >= self.s.tape_min_btc:
            st = self.v[vid]
            vw = g.usd / g.q if g.q else g.lo
            j = {"id": f"{vid}:{g.tid}", "x": vid, "t": g.t, "lt": int(g.lt), "s": g.s,
                 "q": round(g.q, 4), "p": round(vw, 2), "pa": round(vw - (st.basis or 0.0), 2),
                 "lo": g.lo, "hi": g.hi, "n": g.n, "usd": round(g.usd)}
            self.tape.append(j)
            self.new_sweeps.append(j)

    def on_liq(self, vid, t, side, p, btc, lt):
        j = {"t": int(t), "lt": int(lt), "x": vid, "side": side, "p": p, "q": round(btc, 4), "usd": round(p * btc)}
        self.liqs.append(j)
        self.new_liqs.append(j)
        if side == "long":
            self.col_liq[0] += btc
            self._acc["ll"] += btc
        else:
            self.col_liq[1] += btc
            self._acc["ls"] += btc
        return j

    def on_oi(self, vid, t, oi):
        st = self.v[vid]
        if st.oi is not None:
            d = oi - st.oi
            self.oi_delta += d
            self.oi_cum += d
        st.oi, st.oi_t = oi, t
        st.msgs += 1

    def on_fund(self, vid, rate, nxt):
        st = self.v[vid]
        st.fund, st.next_fund = rate, nxt

    def on_px(self, vid, t, px, primary_px=None):
        st = self.v[vid]
        st.msgs += 1
        if st.px is None or t - st.px_t > 5000:
            st.px, st.px_t = px, t
            if vid != self.pv and primary_px:
                d = px - primary_px
                st.basis = d if st.basis is None else st.basis + 0.02 * (d - st.basis)

    def on_usdt(self, price):
        self.usdt = price

    def seen(self, vid, lt):
        self.v[vid].last_msg = lt

    # ------------------------------------------------------------------ derived values
    def oi_total(self, now):
        tot = 0.0
        n = 0
        for st in self.v.values():
            if st.oi is not None and now - st.last_msg < 120_000:
                tot += st.oi
                n += 1
        return tot if n else None

    def take_oi_delta(self):
        d, self.oi_delta = self.oi_delta, 0.0
        return d

    def premium(self, now):
        cb = self.v[XVENUES["coinbase"].id]
        bs = self.v[XVENUES["bn_spot"].id]
        if cb.px is None or bs.px is None or now - cb.last_msg > 60_000 or now - bs.last_msg > 60_000:
            return None
        return cb.px - bs.px * (self.usdt or 1.0)

    # ------------------------------------------------------------------ clock
    def tick(self, now, primary_px):
        for vid, g in self.groups.items():
            if g is not None and now - g.lt >= 150:
                self.groups[vid] = None
                self._done(vid, g)
        s = int(now // 1000)
        if self._sec is None:
            self._sec = s
        if s != self._sec:
            a = self._acc
            self.sec.append((self._sec, primary_px, a["pb"], a["ps"], a["sb"], a["ss"], tuple(a["sz"]),
                             a["ll"], a["ls"], self.oi_cum, self.premium(now)))
            self._acc = self._new_acc()
            self._sec = s
        if now >= self._next_regime:
            self._next_regime = now + REGIME_EVERY
            self._eval_regime(now)
            self._eval_cascade(now)
        self._score(now, primary_px)

    def _window(self, secs):
        if not self.sec:
            return []
        lo = self.sec[-1][0] - secs
        out = []
        for r in reversed(self.sec):
            if r[0] <= lo:
                break
            out.append(r)
        out.reverse()
        return out

    def _eval_regime(self, now):
        rows = self._window(REGIME_WIN)
        if len(rows) < 120 or rows[0][1] is None or rows[-1][1] is None:
            return
        p0, p1 = rows[0][1], rows[-1][1]
        dp = (p1 - p0) / p0 * 1e4
        pb = sum(r[2] for r in rows)
        ps = sum(r[3] for r in rows)
        sb = sum(r[4] for r in rows)
        ss = sum(r[5] for r in rows)
        if pb + ps <= 0 or sb + ss <= 0:
            return
        pz = (pb - ps) / (pb + ps)
        sz = (sb - ss) / (sb + ss)
        hi, lo = 0.08, 0.02
        st = "neutral"
        if dp >= 12:
            if pz > hi and sz > hi:
                st = "broad_up"
            elif pz > hi and sz < lo:
                st = "perp_led_up"
            elif sz > hi and pz < lo:
                st = "spot_led_up"
        elif dp <= -12:
            if pz < -hi and sz < -hi:
                st = "broad_down"
            elif pz < -hi and sz > -lo:
                st = "perp_led_down"
            elif sz < -hi and pz > -lo:
                st = "spot_led_down"
        elif abs(dp) < 6:
            if sz > hi and pz < -hi:
                st = "spot_bid_perp_sold"
            elif sz < -hi and pz > hi:
                st = "spot_sold_perp_bid"
        label = REGIMES[st][0] if st in REGIMES else "No clear leader"
        info = {"dp_bps": round(dp, 1), "perp_z": round(pz, 3), "spot_z": round(sz, 3),
                "perp_cvd": round(pb - ps, 2), "spot_cvd": round(sb - ss, 2), "price": p1}
        changed = st != self.regime["state"]
        self.regime = dict(self.regime, state=st, label=label, **info)
        if changed:
            self.regime["since"] = int(now)
            if st in REGIMES:
                self.seq += 1
                ev = {"id": self.seq, "type": "regime", "t": int(now), "state": st, "label": label,
                      "bias": REGIMES[st][1], "res": None, **info}
                self.events.append(ev)
                self.new_events.append(ev)
                self.pending_scores.append(ev)

    def _eval_cascade(self, now):
        # rolling 30 s liquidation volume per side vs an adaptive baseline
        cut = now - 30_000
        sums = {"long": 0.0, "short": 0.0}
        usd = {"long": 0.0, "short": 0.0}
        rng = {"long": [None, None], "short": [None, None]}
        n = {"long": 0, "short": 0}
        for j in reversed(self.liqs):
            if j["lt"] < cut:
                break
            sd = j["side"]
            sums[sd] += j["q"]
            usd[sd] += j["usd"]
            n[sd] += 1
            r = rng[sd]
            r[0] = j["p"] if r[0] is None or j["p"] < r[0] else r[0]
            r[1] = j["p"] if r[1] is None or j["p"] > r[1] else r[1]
        tot = sums["long"] + sums["short"]
        thr = max(self.s.extra.get("cascade_min_btc", 20.0), 4.0 * self._liq_ema)   # baseline before this window
        if now - self._liq_ema_t >= 30_000:
            self._liq_ema = 0.9 * self._liq_ema + 0.1 * tot
            self._liq_ema_t = now
        for sd in ("long", "short"):
            if sums[sd] >= thr and now - self._casc_last[sd] > 60_000:
                self._casc_last[sd] = now
                self.seq += 1
                ev = {"id": self.seq, "type": "cascade", "t": int(now), "side": sd, "btc": round(sums[sd], 2),
                      "usd": round(usd[sd]), "n": n[sd], "lo": rng[sd][0], "hi": rng[sd][1],
                      "label": ("Long" if sd == "long" else "Short") + " liquidation cascade"}
                self.events.append(ev)
                self.new_events.append(ev)

    def _score(self, now, px):
        if not self.pending_scores or px is None:
            return
        keep = []
        for ev in self.pending_scores:
            if now - ev["t"] >= REGIME_HORIZON:
                mv = (px - ev["price"]) * ev["bias"]
                ev["res"] = {"move": round(mv, 2), "win": mv > 0}
                self.scored.append(ev["res"])
                self.event_updates.append({"id": ev["id"], "res": ev["res"]})
            else:
                keep.append(ev)
        self.pending_scores = keep

    # ------------------------------------------------------------------ outputs
    def column_ext(self, now):
        ex = [(vid, e[0], e[1]) for vid, e in self.col_ex.items()]
        xt = [(b, e[0], e[1]) for b, e in self.col_xt.items()]
        sz = self.col_sz
        lq = self.col_liq
        self.col_ex, self.col_xt = {}, {}
        self.col_sz = [0.0] * 6
        self.col_liq = [0.0, 0.0]
        return {"ex": ex, "xt": xt, "sz": sz, "liq": lq, "prem": self.premium(now), "oi": self.oi_total(now)}

    def panel(self, now):
        w5 = self._window(300)
        w60 = self._window(3600)

        def sums(rows):
            out = {"pb": 0.0, "ps": 0.0, "sb": 0.0, "ss": 0.0, "sz": [0.0] * 6, "ll": 0.0, "ls": 0.0}
            for r in rows:
                out["pb"] += r[2]
                out["ps"] += r[3]
                out["sb"] += r[4]
                out["ss"] += r[5]
                for i in range(6):
                    out["sz"][i] += r[6][i]
                out["ll"] += r[7]
                out["ls"] += r[8]
            return out

        a5, a60 = sums(w5), sums(w60)

        def oi_d(rows):
            return round(rows[-1][9] - rows[0][9], 2) if len(rows) > 1 else None

        ven = []
        for key, xv in XVENUES.items():
            st = self.v[xv.id]
            if st.msgs == 0:
                continue
            ven.append({"x": xv.id, "key": key, "label": xv.label, "name": xv.name, "kind": xv.kind,
                        "px": st.px, "basis": round(st.basis, 2) if st.basis is not None else None,
                        "oi": round(st.oi, 1) if st.oi is not None else None, "fund": st.fund,
                        "next": st.next_fund, "live": now - st.last_msg < 30_000, "trades": st.trades})
        prem = self.premium(now)
        sc = list(self.scored)
        wins = sum(1 for r in sc if r["win"])
        return {
            "venues": ven,
            "oi": self.oi_total(now), "oi_d5": oi_d(w5), "oi_d60": oi_d(w60),
            "fund_w": self._oi_weighted_funding(now),
            "premium": prem, "premium_bps": round(prem / self.v[XVENUES["coinbase"].id].px * 1e4, 2) if prem is not None else None,
            "usdt": self.usdt,
            "regime": self.regime,
            "cvd5": {"perp": round(a5["pb"] - a5["ps"], 2), "spot": round(a5["sb"] - a5["ss"], 2),
                     "perp_vol": round(a5["pb"] + a5["ps"], 1), "spot_vol": round(a5["sb"] + a5["ss"], 1)},
            "cvd60": {"perp": round(a60["pb"] - a60["ps"], 2), "spot": round(a60["sb"] - a60["ss"], 2),
                      "perp_vol": round(a60["pb"] + a60["ps"], 1), "spot_vol": round(a60["sb"] + a60["ss"], 1)},
            "size5": [round(a5["sz"][i] - a5["sz"][i + 1], 2) for i in (0, 2, 4)],
            "size60": [round(a60["sz"][i] - a60["sz"][i + 1], 2) for i in (0, 2, 4)],
            "liq5": [round(a5["ll"], 2), round(a5["ls"], 2)],
            "liq60": [round(a60["ll"], 2), round(a60["ls"], 2)],
            "regime_stats": {"scored": len(sc), "hit_rate": round(100 * wins / len(sc), 1) if sc else None},
        }

    def _oi_weighted_funding(self, now):
        num = den = 0.0
        for st in self.v.values():
            if st.fund is not None and st.oi and now - st.last_msg < 120_000:
                num += st.fund * st.oi
                den += st.oi
        return num / den if den else None
