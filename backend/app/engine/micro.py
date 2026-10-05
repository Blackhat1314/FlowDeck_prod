"""Order-book microstructure on the primary venue (closest free substitute for Market-by-Order data).

Every visible size change from the 100 ms depth stream is reconciled with the trade tape:
  * size up                      -> liquidity ADDED (stacked)
  * size down explained by trades -> FILLED
  * size down not explained       -> CANCELLED (pulled)
  * trades with no visible size down at that price -> HIDDEN execution (iceberg / refill)
Depth and trades arrive on different sockets, so decreases are matched with trades within a time
window after a short delay. Changes that happen and reverse inside one 100 ms batch stay invisible.

Built on top: pulling/stacking DOM columns (5/30/60 s), wall tracker (big resting orders, their age,
pulled-vs-filled outcome) and iceberg detection.
"""
from __future__ import annotations

from collections import deque

WINDOWS = (5, 30, 60)
MATCH_DELAY = 350        # ms before a decrease is classified
MATCH_SLACK = 700        # trades up to this long after a decrease may explain it
CREDIT_TTL = 1500        # unexplained trades older than this become hidden executions


class _Roll:
    """Per bucket & side: 60 one-second slots of (added, cancelled, filled, hidden)."""
    __slots__ = ("sec", "v")

    def __init__(self):
        self.sec = [-1] * 60
        self.v = [[0.0, 0.0, 0.0, 0.0] for _ in range(60)]

    def add(self, s, i, x):
        j = s % 60
        if self.sec[j] != s:
            self.sec[j] = s
            self.v[j] = [0.0, 0.0, 0.0, 0.0]
        self.v[j][i] += x

    def window(self, now_s, w):
        out = [0.0, 0.0, 0.0, 0.0]
        lo = now_s - w
        for j in range(60):
            if self.sec[j] > lo:
                vv = self.v[j]
                out[0] += vv[0]
                out[1] += vv[1]
                out[2] += vv[2]
                out[3] += vv[3]
        return out


class _Wall:
    __slots__ = ("side", "k", "born", "max_q", "cur_q", "filled", "cancelled", "hidden", "refills",
                 "min_dist", "ending", "last_dec_filled", "dist_end")

    def __init__(self, side, k, t, q, dist):
        self.side, self.k, self.born = side, k, t
        self.max_q = self.cur_q = q
        self.filled = self.cancelled = self.hidden = 0.0
        self.refills = 0
        self.min_dist = dist
        self.ending = None
        self.last_dec_filled = False
        self.dist_end = dist


class Micro:
    def __init__(self, book, venue, settings):
        self.book = book
        self.v = venue
        self.s = settings
        ex = settings.extra
        self.wall_min = ex.get("wall_min_btc", 15.0)
        self.wall_mult = ex.get("wall_mult", 10.0)
        self.near_bps = ex.get("wall_near_bps", 8.0)
        self.ice_min = ex.get("iceberg_min_btc", 4.0)
        self.qs = book.qs
        self.bt = book.bt
        self.tick = book.tick
        self.pend: dict = {}      # (side, k) -> deque[[t, lots]]   visible decreases waiting for trades
        self.cred: dict = {}      # (side, k) -> deque[[t, lots]]   trades waiting for a visible decrease
        self.active: set = set()
        self.roll: dict = {}      # (side, bucket) -> _Roll
        self.walls: dict = {}     # (side, k) -> _Wall
        self.ice: dict = {}       # (side, k) -> [first_t, exec_lots, hidden_lots, max_shown_lots, refills, last_emit]
        self.events: deque = deque(maxlen=400)
        self.new_events: list = []
        self.thr_lots = int(self.wall_min * self.qs)
        self._next_thr = 0
        self.seq = 0
        self.stats = {"dec": 0, "filled": 0.0, "cancelled": 0.0, "hidden": 0.0, "added": 0.0}

    # ------------------------------------------------------------------ helpers
    def _btc(self, k, lots):
        q = lots / self.qs
        if self.v.inverse:
            return q * self.v.contract_usd / (k * self.tick) if k else 0.0
        return q

    def _roll(self, side, k):
        key = (side, k // self.bt)
        r = self.roll.get(key)
        if r is None:
            r = self.roll[key] = _Roll()
        return r

    def _mid(self):
        m = self.book.mid_ticks()
        return m

    def reset(self):
        self.pend.clear()
        self.cred.clear()
        self.active.clear()
        self.walls.clear()

    # ------------------------------------------------------------------ inputs
    def on_changes(self, changes, t):
        """changes: [(side 'b'|'a', price_int, old_lots, new_lots)] from one depth event."""
        mid = self._mid()
        if mid is None:
            return
        thr = self.thr_lots
        s = int(t // 1000)
        lo, hi = mid * 0.985, mid * 1.015
        for side, k, old, new in changes:
            if k < lo or k > hi:
                continue
            key = (side, k)
            if new > old:
                d = new - old
                self._roll(side, k).add(s, 0, self._btc(k, d))
                self.stats["added"] += d
                w = self.walls.get(key)
                if w is not None and w.last_dec_filled:
                    w.refills += 1
                    w.last_dec_filled = False
                ic = self.ice.get(key)
                if ic is not None and t - ic[0] < 60_000:
                    ic[4] += 1
            elif new < old:
                q = self.pend.get(key)
                if q is None:
                    q = self.pend[key] = deque()
                q.append([t, old - new])
                self.active.add(key)
            # wall tracking
            w = self.walls.get(key)
            if w is None:
                if new >= thr and mid is not None:
                    dist = abs(k - mid) / mid * 1e4
                    if dist < 150:
                        self.walls[key] = _Wall(side, k, t, new, dist)
            else:
                w.cur_q = new
                if new > w.max_q:
                    w.max_q = new
                if mid is not None:
                    dist = abs(k - mid) / mid * 1e4
                    w.dist_end = dist
                    if dist < w.min_dist:
                        w.min_dist = dist
                if w.ending is None and new < 0.2 * w.max_q:
                    w.ending = t
                elif w.ending is not None and new >= 0.5 * w.max_q:
                    w.ending = None
            ic = self.ice.get(key)
            if ic is not None and new > ic[3]:
                ic[3] = new

    def on_trade(self, price, lots, taker_side, t):
        """A primary-venue aggTrade. The passive side is bids for taker sells, asks for taker buys."""
        side = "b" if taker_side < 0 else "a"
        k = int(round(price / self.tick))
        key = (side, k)
        q = self.cred.get(key)
        if q is None:
            q = self.cred[key] = deque()
        q.append([t, lots])
        self.active.add(key)
        ic = self.ice.get(key)
        if ic is None or t - ic[0] > 60_000:
            shown = (self.book.bids if side == "b" else self.book.asks).get(k, 0)
            self.ice[key] = [t, lots, 0, shown, 0, ic[5] if ic else 0]
        else:
            ic[1] += lots

    # ------------------------------------------------------------------ reconciliation
    def process(self, now):
        s_now = int(now // 1000)
        done = []
        for key in self.active:
            pq = self.pend.get(key)
            cq = self.cred.get(key)
            side, k = key
            w = self.walls.get(key)
            while pq and now - pq[0][0] >= MATCH_DELAY:
                t_dec, amt = pq.popleft()
                filled = 0
                while cq and amt > 0 and cq[0][0] <= t_dec + MATCH_SLACK:
                    c = cq[0]
                    use = min(c[1], amt)
                    c[1] -= use
                    amt -= use
                    filled += use
                    if c[1] <= 0:
                        cq.popleft()
                cancelled = amt
                s = int(t_dec // 1000)
                r = self._roll(side, k)
                if filled:
                    r.add(s, 2, self._btc(k, filled))
                    self.stats["filled"] += filled
                if cancelled:
                    r.add(s, 1, self._btc(k, cancelled))
                    self.stats["cancelled"] += cancelled
                self.stats["dec"] += 1
                if w is not None:
                    w.filled += filled
                    w.cancelled += cancelled
                    w.last_dec_filled = filled > 0
            while cq and now - cq[0][0] >= CREDIT_TTL:
                t_c, amt = cq.popleft()
                if amt > 0:
                    self._roll(side, k).add(int(t_c // 1000), 3, self._btc(k, amt))
                    self.stats["hidden"] += amt
                    if w is not None:
                        w.hidden += amt
                    ic = self.ice.get(key)
                    if ic is not None:
                        ic[2] += amt
            if not pq and not cq:
                done.append(key)
        for key in done:
            self.active.discard(key)
            self.pend.pop(key, None)
            self.cred.pop(key, None)
        self._walls(now)
        self._icebergs(now)
        if now >= self._next_thr:
            self._next_thr = now + 5000
            self._update_threshold()
            stale = s_now - 70
            for key in [key for key, r in self.roll.items() if max(r.sec) < stale]:
                del self.roll[key]

    def _update_threshold(self):
        mid = self._mid()
        if mid is None:
            return
        lo, hi = mid * (1 - 0.0025), mid * (1 + 0.0025)
        sizes = [q for k, q in self.book.bids.items() if k >= lo]
        sizes += [q for k, q in self.book.asks.items() if k <= hi]
        if len(sizes) < 20:
            return
        sizes.sort()
        med = sizes[len(sizes) // 2]
        self.thr_lots = max(int(self.wall_min * self.qs), int(self.wall_mult * med))

    def _emit(self, ev):
        self.seq += 1
        ev["id"] = self.seq
        self.events.append(ev)
        self.new_events.append(ev)

    def _walls(self, now):
        mid = self._mid()
        for key in list(self.walls):
            w = self.walls[key]
            if w.ending is None or now - w.ending < MATCH_DELAY + MATCH_SLACK:
                continue
            del self.walls[key]
            removed = w.filled + w.cancelled
            if removed <= 0:
                continue
            price = w.k * self.tick
            base = {"t": int(w.ending), "side": "bid" if w.side == "b" else "ask", "p": round(price, 2),
                    "max": round(self._btc(w.k, w.max_q), 3), "filled": round(self._btc(w.k, w.filled), 3),
                    "cancelled": round(self._btc(w.k, w.cancelled), 3), "age": round((w.ending - w.born) / 1000, 1),
                    "dist_bps": round(w.dist_end, 1), "refills": w.refills}
            if w.cancelled >= 0.6 * removed and w.dist_end <= self.near_bps:
                self._emit(dict(base, type="pulled", label="Wall pulled as price approached"))
            elif w.filled >= 0.5 * removed:
                self._emit(dict(base, type="eaten", label="Wall filled"))

    def _icebergs(self, now):
        for key in list(self.ice):
            ic = self.ice[key]
            first_t, ex_lots, hid_lots, shown, refills, last_emit = ic
            if now - first_t > 90_000:
                del self.ice[key]
                continue
            side, k = key
            ex_btc = self._btc(k, ex_lots)
            if ex_btc < self.ice_min or now - last_emit < 30_000:
                continue
            if (hid_lots >= 0.5 * ex_lots or ex_lots >= 2 * max(shown, 1)) and (refills >= 2 or hid_lots >= ex_lots * 0.6):
                ic[5] = now
                self._emit({"type": "iceberg", "t": int(now), "side": "bid" if side == "b" else "ask",
                            "p": round(k * self.tick, 2), "exec": round(ex_btc, 3),
                            "hidden": round(self._btc(k, hid_lots), 3), "shown": round(self._btc(k, shown), 3),
                            "refills": refills, "label": "Iceberg: more traded than shown"})

    # ------------------------------------------------------------------ outputs
    def dom(self, now, rows=40):
        """Ladder around mid at bucket granularity with pulling/stacking per window."""
        bk = self.book
        mid = bk.mid_ticks()
        if mid is None:
            return None
        mb = int(mid // self.bt)
        s_now = int(now // 1000)
        out = []
        for b in range(mb + rows, mb - rows - 1, -1):
            bq = bk.bid_b.get(b, 0)
            aq = bk.ask_b.get(b, 0)
            row = [b, round(self._btc(b * self.bt, bq), 3), round(self._btc(b * self.bt, aq), 3)]
            rb = self.roll.get(("b", b))
            ra = self.roll.get(("a", b))
            for w in WINDOWS:
                vb = rb.window(s_now, w) if rb else (0.0, 0.0, 0.0, 0.0)
                va = ra.window(s_now, w) if ra else (0.0, 0.0, 0.0, 0.0)
                # net stack (added - cancelled), fills, hidden for bids then asks
                row += [round(vb[0] - vb[1], 3), round(vb[2] + vb[3], 3), round(va[0] - va[1], 3), round(va[2] + va[3], 3)]
            out.append(row)
        return {"rows": out, "bucket": self.s.bucket_usd, "windows": list(WINDOWS)}

    def walls_now(self, now, n=24):
        mid = self._mid()
        res = []
        for w in self.walls.values():
            if w.ending is not None:
                continue
            res.append({"side": "bid" if w.side == "b" else "ask", "p": round(w.k * self.tick, 2),
                        "q": round(self._btc(w.k, w.cur_q), 3), "max": round(self._btc(w.k, w.max_q), 3),
                        "age": round((now - w.born) / 1000, 1), "filled": round(self._btc(w.k, w.filled), 3),
                        "cancelled": round(self._btc(w.k, w.cancelled), 3), "refills": w.refills,
                        "dist_bps": round(abs(w.k - mid) / mid * 1e4, 1) if mid else None})
        res.sort(key=lambda r: -r["q"])
        return {"walls": res[:n], "thr": round(self.thr_lots / self.qs, 2)}
