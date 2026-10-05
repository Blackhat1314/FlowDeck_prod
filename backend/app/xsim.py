"""Synthetic messages for the other venues (Bybit, OKX, Binance spot/COIN-M, Coinbase), in each venue's
real wire format, mirrored from the primary MarketSim. Used by demo mode, the mock exchange and tests.
"""
from __future__ import annotations

import random
from datetime import datetime, timezone

VENUE_CFG = {
    # key: (basis USD vs primary, size share, ok to emit book)
    "bybit": (2.0, 0.55),
    "bybit_inv": (-14.0, 0.08),
    "okx": (1.0, 0.35),
    "bn_coinm": (-12.0, 0.10),
    "bn_spot": (-9.0, 0.22),
    "coinbase": (-4.0, 0.12),
}


def _iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f") + "Z"


class XSim:
    def __init__(self, sim, seed=11):
        self.sim = sim
        self.r = random.Random(seed)
        self.seq = 10_000_000
        self.tid = 1
        self.okx_seq = 1
        self.byb_u = 1
        self.prev_books = {"okx": None, "bybit": None}
        self.oi = {"bybit": 28_000.0, "bybit_inv": 2_700.0, "okx": 28_500.0}
        self.spot_bias = 0.0
        self.premium = 0.0
        self.t_next = {"tick": 0, "oi_okx": 0, "fund": 0, "usdt": 0}
        self.started = False

    # ------------------------------------------------------------------ helpers
    def _book_levels(self, basis, n=200):
        sim = self.sim
        bids = sorted(sim.bids.items(), reverse=True)[:n]
        asks = sorted(sim.asks.items())[:n]
        tk = sim.tick
        return ({round(k * tk + basis, 1): q for k, q in bids}, {round(k * tk + basis, 1): q for k, q in asks})

    def _book_msgs(self, t):
        out = []
        for key, basis, scale in (("okx", VENUE_CFG["okx"][0], 0.7), ("bybit", VENUE_CFG["bybit"][0], 0.9)):
            bids, asks = self._book_levels(basis)
            bids = {p: round(q * scale, 3) for p, q in bids.items()}
            asks = {p: round(q * scale, 3) for p, q in asks.items()}
            prev = self.prev_books[key]
            if prev is None:
                cb, ca = bids, asks
                kind = "snapshot"
            else:
                pb, pa = prev
                cb = {p: q for p, q in bids.items() if pb.get(p) != q}
                cb.update({p: 0.0 for p in pb if p not in bids})
                ca = {p: q for p, q in asks.items() if pa.get(p) != q}
                ca.update({p: 0.0 for p in pa if p not in asks})
                kind = "update"
                if not cb and not ca:
                    continue
            self.prev_books[key] = (bids, asks)
            if key == "okx":
                seq = self.okx_seq + 1
                out.append(("okx", {"arg": {"channel": "books", "instId": "BTC-USDT-SWAP"}, "action": kind,
                                    "data": [{"asks": [[str(p), f"{q * 100:.2f}", "0", "1"] for p, q in ca.items()],
                                              "bids": [[str(p), f"{q * 100:.2f}", "0", "1"] for p, q in cb.items()],
                                              "ts": str(int(t)), "seqId": seq,
                                              "prevSeqId": -1 if kind == "snapshot" else self.okx_seq}]}))
                self.okx_seq = seq
            else:
                self.byb_u += 1
                out.append(("bybit", {"topic": "orderbook.1000.BTCUSDT", "type": "snapshot" if kind == "snapshot" else "delta",
                                      "ts": int(t), "data": {"s": "BTCUSDT",
                                                             "b": [[f"{p:.1f}", f"{q:.3f}"] for p, q in cb.items()],
                                                             "a": [[f"{p:.1f}", f"{q:.3f}"] for p, q in ca.items()],
                                                             "u": self.byb_u, "seq": self.byb_u}}))
        return out

    # ------------------------------------------------------------------ main
    def step(self, primary_msgs, t):
        """primary_msgs: list of (kind, msg) produced by MarketSim.step(); returns [(venue_key, msg)]."""
        r = self.r
        out = []
        # slow regime: spot sometimes leads, sometimes lags
        self.spot_bias += r.gauss(0, 0.02) - self.spot_bias * 0.002
        self.spot_bias = max(-0.4, min(0.4, self.spot_bias))
        self.premium += r.gauss(0, 0.6) - self.premium * 0.01
        for kind, m in primary_msgs:
            if m.get("e") != "aggTrade":
                continue
            p = float(m["p"])
            q = float(m["q"])
            buy = not m["m"]
            T = int(m["T"])
            for key, (basis, share) in VENUE_CFG.items():
                if r.random() > min(0.95, share * 1.6):
                    continue
                qq = round(q * share * r.uniform(0.5, 1.5), 3) or 0.001
                b = buy
                if key in ("bn_spot", "coinbase") and r.random() < abs(self.spot_bias):
                    b = self.spot_bias > 0
                px = p + basis + (self.premium if key == "coinbase" else 0.0) + r.gauss(0, 0.3)
                self.seq += 1
                self.tid += 1
                if key == "bybit":
                    out.append(("bybit", {"topic": "publicTrade.BTCUSDT", "type": "snapshot", "ts": T, "data": [
                        {"T": T, "s": "BTCUSDT", "S": "Buy" if b else "Sell", "v": f"{qq:.3f}", "p": f"{px:.1f}",
                         "i": str(self.tid), "BT": False, "RPI": False, "seq": self.seq}]}))
                elif key == "bybit_inv":
                    out.append(("bybit_inv", {"topic": "publicTrade.BTCUSD", "type": "snapshot", "ts": T, "data": [
                        {"T": T, "s": "BTCUSD", "S": "Buy" if b else "Sell", "v": str(max(1, int(qq * px))),
                         "p": f"{px:.1f}", "i": str(self.tid), "seq": self.seq}]}))
                elif key == "okx":
                    out.append(("okx", {"arg": {"channel": "trades", "instId": "BTC-USDT-SWAP"}, "data": [
                        {"instId": "BTC-USDT-SWAP", "tradeId": str(self.tid), "px": f"{px:.1f}",
                         "sz": f"{qq * 100:.2f}", "side": "buy" if b else "sell", "ts": str(T), "count": "1"}]}))
                elif key == "bn_coinm":
                    out.append(("bn_coinm", {"stream": "btcusd_perp@aggTrade", "data": {
                        "e": "aggTrade", "E": T, "a": self.tid, "s": "BTCUSD_PERP", "p": f"{px:.1f}",
                        "q": str(max(1, int(qq * px / 100))), "f": self.tid, "l": self.tid, "T": T, "m": not b}}))
                elif key == "bn_spot":
                    out.append(("bn_spot", {"stream": "btcusdt@aggTrade", "data": {
                        "e": "aggTrade", "E": T, "a": self.tid, "s": "BTCUSDT", "p": f"{px:.2f}", "q": f"{qq:.5f}",
                        "f": self.tid, "l": self.tid, "T": T, "m": not b}}))
                else:
                    out.append(("coinbase", {"type": "match", "trade_id": self.tid, "taker_order_id": f"o{self.seq}",
                                             "side": "sell" if b else "buy", "size": f"{qq:.8f}", "price": f"{px:.2f}",
                                             "product_id": "BTC-USD", "time": _iso(T)}))
            if q >= 3 and r.random() < 0.08:
                lq = round(q * r.uniform(0.2, 1.2), 3)
                out.append(("bybit", {"topic": "allLiquidation.BTCUSDT", "type": "snapshot", "ts": T, "data": [
                    {"T": T, "s": "BTCUSDT", "S": "Sell" if buy else "Buy", "v": f"{lq:.3f}", "p": f"{p:.1f}"}]}))
        # periodic tickers / OI / funding
        if t >= self.t_next["tick"]:
            self.t_next["tick"] = t + 1000
            for key, sym, st in (("bybit", "BTCUSDT", "snapshot"), ("bybit_inv", "BTCUSD", "snapshot")):
                self.oi[key] *= 1 + r.gauss(0, 0.0004)
                px = self.sim.mid + VENUE_CFG[key][0]
                data = {"symbol": sym, "markPrice": f"{px:.2f}", "lastPrice": f"{px:.1f}",
                        "fundingRate": "0.0000810", "nextFundingTime": str(int((t // 28_800_000 + 1) * 28_800_000))}
                if key == "bybit":
                    data["singleOpenInterest"] = f"{self.oi[key]:.3f}"
                else:
                    data["singleOpenInterestValue"] = f"{self.oi[key]:.2f}"
                out.append((key, {"topic": f"tickers.{sym}", "type": st if not self.started else "delta",
                                  "ts": int(t), "data": data}))
            out.append(("bn_coinm", {"stream": "btcusd_perp@markPrice@1s", "data": {
                "e": "markPriceUpdate", "E": int(t), "p": f"{self.sim.mid - 12:.2f}", "r": "0.00006", "T": int((t // 28_800_000 + 1) * 28_800_000)}}))
            self.started = True
        if t >= self.t_next["oi_okx"]:
            self.t_next["oi_okx"] = t + 3000
            self.oi["okx"] *= 1 + r.gauss(0, 0.0005)
            out.append(("okx", {"arg": {"channel": "open-interest", "instId": "BTC-USDT-SWAP"},
                                "data": [{"oiCcy": f"{self.oi['okx']:.4f}", "ts": str(int(t))}]}))
        if t >= self.t_next["fund"]:
            self.t_next["fund"] = t + 30_000
            out.append(("okx", {"arg": {"channel": "funding-rate", "instId": "BTC-USDT-SWAP"}, "data": [
                {"fundingRate": "0.0000169", "fundingTime": str(int((t // 28_800_000 + 1) * 28_800_000))}]}))
        if t >= self.t_next["usdt"]:
            self.t_next["usdt"] = t + 5000
            out.append(("coinbase", {"type": "ticker", "product_id": "USDT-USD", "price": f"{0.9998 + r.gauss(0, 0.00005):.5f}",
                                     "time": _iso(t)}))
        if int(t) % 200 < 100:
            out += self._book_msgs(t)
        return out

    def oi_secondary(self):
        """Native COIN-M open interest (USD 100 contracts)."""
        return 4_200_000.0 * (1 + self.r.gauss(0, 0.0003))

    def liqmap_seed_rows(self, end_t, steps=480):
        rows = []
        oi = 82_000.0
        px = self.sim.mid
        r = random.Random(3)
        seq = []
        for i in range(steps):
            seq.append(px)
            px += r.gauss(0, 60)
        seq.reverse()
        for i, o in enumerate(seq):
            t = end_t - (steps - i) * 300_000
            c = seq[i + 1] if i + 1 < len(seq) else self.sim.mid
            h = max(o, c) + abs(r.gauss(0, 30))
            l = min(o, c) - abs(r.gauss(0, 30))
            v = abs(r.gauss(700, 250)) + 100
            tb = v * min(0.9, max(0.1, 0.5 + (c - o) / 400))
            oi += r.gauss(15, 120)
            rows.append((t + 300_000, oi, o, h, l, c, v, tb))
        return rows
