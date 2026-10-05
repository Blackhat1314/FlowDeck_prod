"""Self-audit: continuously grades the engine against the exchange's own numbers.

* Every closed 1m kline from the exchange is compared with the bar the engine built from
  aggTrades: volume, taker-buy volume (=> delta), OHLC, raw trade count, first/last trade id.
* Periodic independent order-book snapshots are compared level-by-level with the local book.
* Feed latency (local receive time - exchange event time) is tracked, corrected by the local
  clock's offset to the exchange clock when the IO layer measures it ('clock_offset').
"""
from __future__ import annotations

from collections import deque


class Integrity:
    def __init__(self, flow, book, venue):
        self.flow = flow
        self.book = book
        self.v = venue
        self.klines: deque = deque(maxlen=240)
        self.books: deque = deque(maxlen=120)
        self.lat: deque = deque(maxlen=2000)
        self.pending_kl: dict = {}
        self.clock_offset = 0.0         # exchange clock - local clock (ms)

    # ------------------------------------------------------------- latency
    def on_latency(self, recv_ms, event_ms):
        if event_ms:
            self.lat.append(recv_ms + self.clock_offset - event_ms)

    # ------------------------------------------------------------- klines
    def on_kline(self, k: dict):
        if not k.get("x"):
            return None
        t = int(k["t"])
        self.pending_kl[t] = k
        return None

    def evaluate_klines(self, now_ms):
        """Kline close events can arrive slightly before the last trades of the minute; wait 1.5s."""
        out = []
        for t in list(self.pending_kl):
            if now_ms - (t + 60_000) < 1500:
                continue
            k = self.pending_kl.pop(t)
            r = self._compare(k)
            if r is not None:
                self.klines.append(r)
                out.append(r)
        return out

    def _compare(self, k):
        fl = self.flow
        t = int(k["t"])
        cov = fl.coverage_from
        if cov is None or t < cov:
            return None
        b = fl.bars.get(t)
        qs = self.v.qty_scale
        kv = int(round(float(k["v"]) * qs))
        kbv = int(round(float(k["V"]) * qs))
        if b is None or b.approx:
            return {"t": t, "status": "no_bar", "kv": kv / qs}
        r = {
            "t": t,
            "status": "ok",
            "vol_k": kv / qs, "vol_e": b.rv / qs,
            "buy_k": kbv / qs, "buy_e": b.rbv / qs,
            "vol_ok": kv == b.rv,
            "buy_ok": kbv == b.rbv,
            "vol_err": abs(kv - b.rv) / kv if kv else 0.0,
            "vol_diff": (b.rv - kv) / qs,
            "buy_err": abs(kbv - b.rbv) / kbv if kbv else 0.0,
            "delta_k": (2 * kbv - kv) / qs, "delta_e": (2 * b.rbv - b.rv) / qs,
            "n_k": int(k["n"]), "n_e": b.nraw,
            "f_k": int(k["f"]), "L_k": int(k["L"]), "f_e": b.f, "L_e": b.L,
            "ids_ok": (int(k["f"]) == b.f and int(k["L"]) == b.L),
            "ohlc_ok": all(abs(float(k[x]) - (getattr(b, y) or 0)) < 1e-9
                           for x, y in (("o", "o"), ("h", "h"), ("l", "l"), ("c", "c"))),
            "gaps": b.gaps,
        }
        return r

    # ------------------------------------------------------------- book
    def add_book_result(self, res):
        if res and res.get("status") == "ok":
            self.books.append(res)

    # ------------------------------------------------------------- summary
    def summary(self):
        ks = [r for r in self.klines if r.get("status") == "ok"]
        n = len(ks)
        lat = sorted(self.lat)
        out = {
            "kline_checked": n,
            "vol_exact": sum(1 for r in ks if r["vol_ok"]),
            "vol_close": sum(1 for r in ks if r["vol_err"] <= 1e-4),
            "buy_close": sum(1 for r in ks if r["buy_err"] <= 1e-4),
            "buy_exact": sum(1 for r in ks if r["buy_ok"]),
            "ids_exact": sum(1 for r in ks if r["ids_ok"]),
            "ohlc_exact": sum(1 for r in ks if r["ohlc_ok"]),
            "vol_err_avg": (sum(r["vol_err"] for r in ks) / n) if n else None,
            "buy_err_avg": (sum(r["buy_err"] for r in ks) / n) if n else None,
            "last_kline": ks[-1] if ks else None,
            "book_checks": len(self.books),
            "book_pct_avg": (sum(r["pct"] for r in self.books if r["pct"] is not None) / len(self.books))
            if self.books else None,
            "book_last": self.books[-1] if self.books else None,
            "lat_p50": lat[len(lat) // 2] if lat else None,
            "lat_p95": lat[int(len(lat) * 0.95)] if lat else None,
            "clock_offset": round(self.clock_offset, 1),
            "resyncs": self.book.resyncs,
            "agg_gaps": self.flow.agg_gaps,
            "crossed": self.book.crossed,
            "book_updates": self.book.updates,
            "live_trades": self.flow.live_trades,
        }
        if n:
            out["vol_match_pct"] = round(100 * out["vol_exact"] / n, 2)
            out["buy_match_pct"] = round(100 * out["buy_exact"] / n, 2)
        return out
