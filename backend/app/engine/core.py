"""Engine orchestrator. Pure, synchronous and IO-free: the FastAPI server, the demo simulator and
the in-browser (Pyodide) live accuracy test all drive this same class.

Primary venue (Binance USDⓈ-M or COIN-M): full order book -> heatmap, footprint, absorption,
microstructure (pulling/stacking, walls, icebergs), liquidation map.
Other venues (Bybit, OKX, Binance spot, Coinbase, the other Binance perp): trades, liquidations,
open interest, funding and (Bybit/OKX) books for the cross-exchange views.
"""
from __future__ import annotations

from .absorption import AbsorptionDetector
from .book import OrderBook
from .flow import MIN, Flow
from .heatmap import Heatmap, history_messages, pack_columns
from .heattiers import HeatTiers
from .integrity import Integrity
from .liqmap import LiqMap
from .micro import Micro
from .venues import Settings, Venue
from .xbook import XBook
from .xchg import BY_ID, PRIMARY_KEY, XVENUES, BybitState, adapt
from .xflow import XFlow


class Engine:
    def __init__(self, venue: Venue, settings: Settings | None = None):
        self.v = venue
        self.s = settings or Settings()
        bt = int(round(self.s.bucket_usd / venue.tick))
        self.bt = bt
        self.pkey = PRIMARY_KEY[venue.key]
        self.pvid = XVENUES[self.pkey].id
        self.book = OrderBook(venue.tick, bt, venue.qty_scale)
        self.book.chg = []
        self.flow = Flow(venue, self.s, bt, vid=self.pvid)
        self.heat = Heatmap(self.book, venue, self.s)
        self.tiers = HeatTiers(self.s.hist_hours)          # 5 s heatmap history (and 1 min for the archive)
        self.absd = AbsorptionDetector(self.s, self.s.bucket_usd)
        self.integ = Integrity(self.flow, self.book, venue)
        self.micro = Micro(self.book, venue, self.s)
        self.xflow = XFlow(self.pvid, self.s, self.s.bucket_usd)
        self.liqmap = LiqMap(bucket_usd=self.s.extra.get("liqmap_bucket", 25.0))
        self.xbooks = {XVENUES["bybit"].id: XBook(XVENUES["bybit"].id, 0.1, self.s.bucket_usd),
                       XVENUES["okx"].id: XBook(XVENUES["okx"].id, 0.1, self.s.bucket_usd)}
        self.xstate = {"bybit": BybitState(), "bybit_inv": BybitState()}
        self.resubscribe: set = set()      # venue keys whose book feed needs a fresh snapshot
        self.gex = None
        self.gex_new = False
        self.stats = {"mark": None, "index": None, "funding": None, "next_funding": None,
                      "oi": None, "oi_usd": None, "chg24": None, "high24": None, "low24": None,
                      "vol24": None, "volusd24": None, "last": None}
        self.next_col = None
        self.next_stats = 0
        self.next_health = 0
        self.next_prune = 0
        self.next_dom = 0
        self.next_walls = 0
        self.next_panel = 0
        self.next_liqmap = 0
        self.next_trim = 0
        self.msgs = 0
        self.xmsgs = 0
        self.backfill_state = "pending"
        self._book_state = self.book.state

    # ================================================================= primary venue
    def on_message(self, msg: dict, recv_ms: float):
        """Dispatch a raw Binance stream payload (already JSON-decoded, combined-stream wrapper removed)."""
        self.msgs += 1
        e = msg.get("e")
        if e == "depthUpdate":
            self.integ.on_latency(recv_ms, msg.get("E"))
            bk = self.book
            bk.on_diff(msg)
            if bk.chg:
                self.micro.on_changes(bk.chg, recv_ms)
                bk.chg = []
            if bk.state != self._book_state:
                if bk.state != bk.SYNCED:
                    self.micro.reset()
                self._book_state = bk.state
        elif e == "aggTrade":
            self.integ.on_latency(recv_ms, msg.get("E"))
            self.on_agg_trade(msg, recv_ms)
        elif e == "markPriceUpdate":
            self.stats["mark"] = float(msg["p"])
            if msg.get("i"):
                self.stats["index"] = float(msg["i"])
            if msg.get("r") not in (None, ""):
                self.stats["funding"] = float(msg["r"])
                self.xflow.on_fund(self.pvid, float(msg["r"]), msg.get("T"))
            self.stats["next_funding"] = msg.get("T")
        elif e == "forceOrder":
            for ev in adapt(self.pkey, msg):
                if ev[0] == "liq":
                    self._liq(ev[1], ev[2], ev[3], ev[4], ev[5], recv_ms)
        elif e == "kline":
            self.integ.on_kline(msg["k"])
        elif e == "24hrTicker":
            self.stats["chg24"] = float(msg["P"])
            self.stats["high24"] = float(msg["h"])
            self.stats["low24"] = float(msg["l"])
            if self.v.inverse:
                self.stats["vol24"] = float(msg.get("q", 0))       # base volume (BTC)
            else:
                self.stats["vol24"] = float(msg["v"])
                self.stats["volusd24"] = float(msg["q"])

    def on_agg_trade(self, ev: dict, recv_ms: float):
        r = self.flow.on_trade(ev, recv_ms, live=True)
        if r is None:
            return
        bkt, side, btc, p = r
        self.heat.add_trade(bkt, side, btc)
        self.absd.on_trade(recv_ms, side, p, bkt, btc, self._visible_btc)
        self.micro.on_trade(p, int(round(float(ev["q"]) * self.v.qty_scale)), side, recv_ms)
        T = int(ev["T"])
        self.xflow.on_trade(self.pvid, T, p, btc, side, T, int(ev["a"]), recv_ms, p)
        self.liqmap.on_trade(p, btc, side)
        if self.flow.coverage_from is None and self.backfill_state != "done":
            self.flow.coverage_from = T - T % MIN + MIN

    def on_snapshot(self, snap: dict) -> bool:
        self.micro.reset()
        ok = self.book.on_snapshot(snap)
        self.book.chg = []
        self._book_state = self.book.state
        return ok

    def on_check_snapshot(self, snap: dict):
        """Independent snapshot for the integrity monitor. Returns result or None (retry later)."""
        chg, self.book.chg = self.book.chg, None       # repairs are not market activity
        res = self.book.compare_snapshot(snap)
        self.book.chg = chg if chg is not None else []
        if res is not None:
            self.integ.add_book_result(res)
        return res

    def on_open_interest(self, oi_native: float, t_ms: float | None = None):
        px = self.stats.get("mark") or self.flow.last_px
        if self.v.inverse and px:
            oi = oi_native * self.v.contract_usd / px
            self.stats["oi_usd"] = oi_native * self.v.contract_usd
        else:
            oi = oi_native
            self.stats["oi_usd"] = oi_native * px if px else None
        self.stats["oi"] = oi
        if t_ms is not None:
            self.xflow.on_oi(self.pvid, t_ms, oi)
            self.xflow.seen(self.pvid, t_ms)
            self.liqmap.on_oi(oi, t_ms, px)

    def seed_liqmap(self, rows):
        self.liqmap.seed(rows)

    def set_gex(self, g):
        if g:
            perp = self.stats.get("mark") or self.flow.last_px
            if perp and g.get("spot"):
                g["perp_mark"] = round(perp, 2)
                g["basis"] = round(perp - g["spot"], 2)    # perp premium over the Deribit index
            self.gex = g
            self.gex_new = True

    # ================================================================= other venues
    def on_xmsg(self, vkey: str, msg: dict, recv_ms: float):
        self.xmsgs += 1
        v = XVENUES[vkey]
        self.xflow.seen(v.id, recv_ms)
        for ev in adapt(vkey, msg, self.xstate.get(vkey)):
            k = ev[0]
            if k == "trade":
                _, vid, t, p, btc, side, gk, tid = ev
                self.xflow.on_trade(vid, t, p, btc, side, gk, tid, recv_ms, self.flow.last_px)
                basis = self.xflow.v[vid].basis or 0.0
                b = int((p - basis) // self.s.bucket_usd)
                self.flow.add_side_volume("sl" if BY_ID[vid].kind == "spot" else "xl", t, b, side, btc)
            elif k == "liq":
                self._liq(ev[1], ev[2], ev[3], ev[4], ev[5], recv_ms)
            elif k == "oi":
                self.xflow.on_oi(ev[1], ev[2], ev[3])
            elif k == "fund":
                self.xflow.on_fund(ev[1], ev[2], ev[3])
            elif k == "px":
                self.xflow.on_px(ev[1], ev[2], ev[3], self.flow.last_px)
            elif k == "usdt":
                self.xflow.on_usdt(ev[1])
            elif k == "book":
                _, vid, kind, bids, asks, seq, prev = ev
                xb = self.xbooks.get(vid)
                if xb is not None and not xb.apply(kind, bids, asks, seq, prev) and kind == "delta":
                    self.resubscribe.add(vkey)

    def on_secondary_oi(self, vkey: str, oi_native: float, t_ms: float):
        """REST-polled open interest of the other Binance perp (native units)."""
        v = XVENUES[vkey]
        st = self.xflow.v[v.id]
        px = st.px or self.flow.last_px
        oi = oi_native * v.contract / px if (v.inverse and px) else oi_native
        if oi:
            self.xflow.on_oi(v.id, t_ms, oi)
            self.xflow.seen(v.id, t_ms)

    def _liq(self, vid, t, side, p, btc, recv_ms):
        self.xflow.on_liq(vid, t, side, p, btc, recv_ms)
        basis = 0.0 if vid == self.pvid else (self.xflow.v[vid].basis or 0.0)
        self.flow.add_liq(t or recv_ms, int((p - basis) // self.s.bucket_usd), side, btc)

    # ---------------------------------------------------------------- backfill
    def backfill_klines(self, rows, before_t: int):
        self.flow.apply_kline_rows(rows, before_t)

    def backfill_trades(self, trades, start_minute: int):
        # drop kline placeholders, and bars restored from the archive, that tick data is about to rebuild
        # (restored bars would otherwise count these trades twice)
        for t in [t for t, b in self.flow.bars.items() if (b.approx == 1 or b.rs) and t >= start_minute]:
            self.flow.bars[t].__init__(t)
        for ev in trades:
            self.flow.on_trade(ev, float(ev["T"]), live=False)
        self.flow.finish_backfill()
        self.flow.coverage_from = start_minute
        self.backfill_state = "done"

    # ================================================================= clock
    def _visible_btc(self, side, bucket):
        q = self.book.bucket_qty(side, bucket)
        if not q:
            return 0.0
        q = q / self.v.qty_scale
        if self.v.inverse:
            return q * self.v.contract_usd / ((bucket + 0.5) * self.s.bucket_usd)
        return q

    def _combined_book(self):
        bk = self.book
        mid = bk.mid_ticks()
        if mid is None:
            return []
        base = int(mid // bk.bt) - self.s.half_range
        top = base + 2 * self.s.half_range + 1
        acc = {}
        for vid, xb in self.xbooks.items():
            if not xb.ok:
                continue
            shift = int(round((self.xflow.v[vid].basis or 0.0) / self.s.bucket_usd))
            for d in (xb.bb, xb.ab):
                for b, q in d.items():
                    b2 = b - shift
                    if base <= b2 < top:
                        acc[b2] = acc.get(b2, 0.0) + q
        return list(acc.items())

    def tick(self, now_ms: float):
        """Advance engine time. Returns (column_record_bytes | None, update_dict | None)."""
        col = None
        self.flow.flush(now_ms)
        bb, ba = self.book.best_prices()
        last = self.flow.last_px
        self.absd.on_tick(now_ms, bb, ba, last, self._visible_btc)
        self.micro.process(now_ms)
        self.xflow.tick(now_ms, last)
        d_oi = self.xflow.take_oi_delta()
        if d_oi:
            self.flow.add_oi(now_ms, d_oi, self.xflow.oi_total(now_ms))
        if self.next_col is None:
            self.next_col = now_ms
        if now_ms >= self.next_col:
            ext = self.xflow.column_ext(now_ms)
            ext["cb"] = self._combined_book()
            col = self.heat.sample(now_ms, last or 0.0, ext)
            if col is not None:
                self.tiers.add(col)
            self.next_col += self.s.column_ms
            if self.next_col < now_ms:
                self.next_col = now_ms + self.s.column_ms
        if now_ms >= self.next_prune:
            self.book.prune(self.s.prune_pct)
            self.next_prune = now_ms + 15_000
        if now_ms >= self.next_trim:
            self.flow.trim(now_ms)
            self.next_trim = now_ms + 60_000

        upd = {}
        if col is not None:
            bars = self.flow.dirty_bars()
            if bars:
                upd["bars"] = bars
        sw = self.flow.new_sweeps + self.xflow.new_sweeps
        if sw:
            upd["sweeps"] = sw
            self.flow.new_sweeps = []
            self.xflow.new_sweeps = []
        if self.xflow.new_liqs:
            upd["liqs"] = self.xflow.new_liqs
            self.xflow.new_liqs = []
        if self.absd.new_events:
            upd["abs"] = self.absd.new_events
            self.absd.new_events = []
        if self.absd.updates:
            upd["absu"] = self.absd.updates
            self.absd.updates = []
        if self.micro.new_events:
            upd["micro"] = self.micro.new_events
            self.micro.new_events = []
        if self.xflow.new_events:
            upd["xev"] = self.xflow.new_events
            self.xflow.new_events = []
        if self.xflow.event_updates:
            upd["xevu"] = self.xflow.event_updates
            self.xflow.event_updates = []
        if self.gex_new:
            upd["gex"] = self.gex
            self.gex_new = False
        kc = self.integ.evaluate_klines(now_ms)
        if kc:
            upd["kchk"] = kc
        if now_ms >= self.next_stats:
            self.stats["last"] = last
            upd["stats"] = dict(self.stats)
            self.next_stats = now_ms + 500
        if now_ms >= self.next_dom:
            dom = self.micro.dom(now_ms)
            if dom:
                upd["dom"] = dom
            self.next_dom = now_ms + 500
        if now_ms >= self.next_walls:
            upd["walls"] = self.micro.walls_now(now_ms)
            self.next_walls = now_ms + 1000
        if now_ms >= self.next_panel:
            upd["flow"] = self.xflow.panel(now_ms)
            self.next_panel = now_ms + 1000
        if now_ms >= self.next_liqmap and last:
            upd["liqmap"] = self.liqmap.snapshot(last)
            self.next_liqmap = now_ms + 5000
        if now_ms >= self.next_health:
            upd["health"] = self.health()
            self.next_health = now_ms + 2000
        if upd or col:
            upd["t"] = int(now_ms)
            upd["bb"] = bb
            upd["ba"] = ba
            upd["last"] = last
        return col, (upd if upd else None)

    def health(self):
        h = self.integ.summary()
        h["abs"] = self.absd.stats()
        h["book_state"] = self.book.state
        h["backfill"] = self.backfill_state
        h["msgs"] = self.msgs
        h["xmsgs"] = self.xmsgs
        h["columns"] = self.heat.columns
        ms = self.micro.stats
        qs = self.v.qty_scale
        h["micro"] = {"filled": round(ms["filled"] / qs, 2), "cancelled": round(ms["cancelled"] / qs, 2),
                      "hidden": round(ms["hidden"] / qs, 2), "added": round(ms["added"] / qs, 2),
                      "decreases": ms["dec"]}
        h["xbooks"] = {BY_ID[vid].label: {"ok": xb.ok, "updates": xb.updates, "gaps": xb.gaps}
                       for vid, xb in self.xbooks.items()}
        h["liqmap"] = {"seeded": self.liqmap.seeded, "updates": self.liqmap.updates}
        return h

    # ================================================================= clients
    def config(self):
        v = self.v
        return {"venue": v.key, "exchange": v.exchange, "symbol": v.symbol, "label": v.label,
                "tick": v.tick, "inverse": v.inverse, "contract_usd": v.contract_usd,
                "bucket": self.s.bucket_usd, "column_ms": self.s.column_ms, "half_range": self.s.half_range,
                "history_min": self.s.history_min, "hist_hours": self.s.hist_hours, "big_trade_btc": self.s.big_trade_btc,
                "tape_min_btc": self.s.tape_min_btc, "primary_x": self.pvid,
                "xvenues": [{"x": x.id, "key": x.key, "label": x.label, "name": x.name, "kind": x.kind}
                            for x in XVENUES.values()]}

    def init_payload(self, now_ms: float | None = None):
        now_ms = now_ms or (self.flow.live_since_T or 0)
        last = self.flow.last_px
        js = {
            "type": "init",
            "config": self.config(),
            "stats": dict(self.stats, last=last),
            "bars": self.flow.bars_json(),
            "sweeps": sorted(list(self.flow.sweeps)[-800:] + list(self.xflow.tape)[-1200:], key=lambda j: j["lt"]),
            "liqs": list(self.xflow.liqs),
            "abs": list(self.absd.events),
            "micro": list(self.micro.events),
            "xev": list(self.xflow.events),
            "gex": self.gex,
            "health": self.health(),
            "kchk": list(self.integ.klines)[-60:],
            "flow": self.xflow.panel(now_ms) if now_ms else None,
            "liqmap": self.liqmap.snapshot(last) if last else None,
            "walls": self.micro.walls_now(now_ms) if now_ms else None,
        }
        return js, history_messages(self.heat.history)

    @staticmethod
    def pack(col_record: bytes) -> bytes:
        return pack_columns([col_record])
