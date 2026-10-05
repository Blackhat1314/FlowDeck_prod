"""Extra BTC venues (other perps + spot) and pure message adapters.

Every adapter turns one raw exchange message into normalized events:
  ("trade", vid, t_ms, price, btc, side(+1 taker buy / -1 taker sell), group_key, trade_id)
  ("liq",   vid, t_ms, "long"|"short", price, btc)          side = which positions were liquidated
  ("oi",    vid, t_ms, oi_btc)
  ("fund",  vid, rate, next_funding_ms)
  ("px",    vid, t_ms, price)                                last / mark price
  ("book",  vid, "snapshot"|"delta", bids, asks, seq, prev_seq)   [[price, btc], ...]
  ("usdt",  price)                                           USDT priced in USD (Coinbase)
Formats were taken from live captures of each feed (Oct 2026).
"""
from __future__ import annotations

import calendar
from dataclasses import dataclass


@dataclass(frozen=True)
class XVenue:
    id: int
    key: str
    label: str        # short chip label
    name: str
    kind: str         # "perp" | "spot"
    inverse: bool     # quantities are USD contracts
    contract: float   # BTC per contract (linear) or USD per contract (inverse)


XVENUES = {
    "bn_usdm": XVenue(0, "bn_usdm", "BIN", "Binance BTCUSDT perp", "perp", False, 1.0),
    "bn_coinm": XVenue(1, "bn_coinm", "BIN-C", "Binance BTCUSD perp (COIN-M)", "perp", True, 100.0),
    "bybit": XVenue(2, "bybit", "BYB", "Bybit BTCUSDT perp", "perp", False, 1.0),
    "bybit_inv": XVenue(3, "bybit_inv", "BYB-I", "Bybit BTCUSD inverse perp", "perp", True, 1.0),
    "okx": XVenue(4, "okx", "OKX", "OKX BTC-USDT-SWAP", "perp", False, 0.01),
    "bn_spot": XVenue(5, "bn_spot", "BIN-S", "Binance BTCUSDT spot", "spot", False, 1.0),
    "coinbase": XVenue(6, "coinbase", "CB", "Coinbase BTC-USD spot", "spot", False, 1.0),
}
BY_ID = {v.id: v for v in XVENUES.values()}
PRIMARY_KEY = {"usdm": "bn_usdm", "coinm": "bn_coinm"}


def to_btc(v: XVenue, price: float, qty: float) -> float:
    if v.inverse:
        return qty * v.contract / price if price else 0.0
    return qty * v.contract


def iso_ms(s: str) -> int:
    """'2026-10-02T21:38:44.085466Z' -> epoch ms (no dependency on fromisoformat quirks)."""
    date, _, rest = s.partition("T")
    y, mo, d = (int(x) for x in date.split("-"))
    rest = rest.rstrip("Z")
    for sep in ("+", "-"):
        if sep in rest:
            rest = rest.split(sep)[0]
    hms, _, frac = rest.partition(".")
    h, mi, se = (int(x) for x in hms.split(":"))
    ms = int((frac + "000")[:3]) if frac else 0
    return calendar.timegm((y, mo, d, h, mi, se, 0, 0, 0)) * 1000 + ms


# ------------------------------------------------------------------ Binance (secondary perp / spot)
def binance(v: XVenue, d: dict):
    e = d.get("e")
    out = []
    if e == "aggTrade":
        p = float(d["p"])
        out.append(("trade", v.id, int(d["T"]), p, to_btc(v, p, float(d["q"])), -1 if d["m"] else 1,
                    int(d["T"]), int(d["a"])))
    elif e == "forceOrder":
        o = d.get("o", {})
        p = float(o.get("ap") or o.get("p") or 0)
        q = float(o.get("z") or o.get("q") or 0)
        if p and q:
            out.append(("liq", v.id, int(o.get("T", d.get("E", 0))), "long" if o.get("S") == "SELL" else "short",
                        p, to_btc(v, p, q)))
    elif e == "markPriceUpdate":
        out.append(("px", v.id, int(d.get("E", 0)), float(d["p"])))
        if d.get("r") not in (None, ""):
            out.append(("fund", v.id, float(d["r"]), int(d.get("T") or 0)))
    return out


# ------------------------------------------------------------------ Bybit v5 (linear + inverse)
class BybitState:
    """tickers deltas only carry changed fields -> keep the last full picture."""

    def __init__(self):
        self.t = {}


def bybit(v: XVenue, m: dict, st: BybitState):
    topic = m.get("topic") or ""
    data = m.get("data")
    out = []
    if topic.startswith("publicTrade."):
        for x in data or ():
            p = float(x["p"])
            out.append(("trade", v.id, int(x["T"]), p, to_btc(v, p, float(x["v"])), 1 if x["S"] == "Buy" else -1,
                        int(x.get("seq") or x["T"]), x.get("i")))
    elif topic.startswith("allLiquidation."):
        for x in data or ():
            p = float(x["p"])
            # Bybit: S == "Buy" means a LONG position was liquidated
            out.append(("liq", v.id, int(x["T"]), "long" if x["S"] == "Buy" else "short", p,
                        to_btc(v, p, float(x["v"]))))
    elif topic.startswith("tickers."):
        if not isinstance(data, dict):
            return out
        t = st.t
        if m.get("type") == "snapshot":
            t.clear()
        t.update(data)
        ts = int(m.get("ts") or 0)
        px = t.get("markPrice") or t.get("lastPrice")
        if px:
            out.append(("px", v.id, ts, float(px)))
        if any(k in data for k in ("singleOpenInterest", "singleOpenInterestValue", "openInterest", "openInterestValue")):
            if v.inverse:
                val = t.get("singleOpenInterestValue") or t.get("openInterestValue")
            else:
                val = t.get("singleOpenInterest") or t.get("openInterest")
            if val:
                out.append(("oi", v.id, ts, float(val)))
        if "fundingRate" in data and t.get("fundingRate") not in (None, ""):
            out.append(("fund", v.id, float(t["fundingRate"]), int(t.get("nextFundingTime") or 0)))
    elif topic.startswith("orderbook."):
        d = data or {}
        kind = "snapshot" if (m.get("type") == "snapshot" or d.get("u") == 1) else "delta"
        conv = (lambda p, q: to_btc(v, p, q))
        bids = [[float(p), conv(float(p), float(q))] for p, q in d.get("b", ())]
        asks = [[float(p), conv(float(p), float(q))] for p, q in d.get("a", ())]
        out.append(("book", v.id, kind, bids, asks, d.get("u"), None))
    return out


# ------------------------------------------------------------------ OKX v5
OKX_INST = {"BTC-USDT-SWAP": ("okx", 0.01, False)}


def okx(v: XVenue, m: dict):
    arg = m.get("arg") or {}
    ch = arg.get("channel")
    data = m.get("data") or ()
    out = []
    if ch == "trades":
        for x in data:
            p = float(x["px"])
            out.append(("trade", v.id, int(x["ts"]), p, float(x["sz"]) * v.contract, 1 if x["side"] == "buy" else -1,
                        int(x["ts"]), x.get("tradeId")))
    elif ch == "liquidation-orders":
        for x in data:
            if x.get("instId") not in OKX_INST:
                continue
            for d in x.get("details", ()):
                p = float(d.get("bkPx") or 0)
                if not p:
                    continue
                pos = d.get("posSide")
                side = "long" if (pos == "long" or (pos not in ("long", "short") and d.get("side") == "sell")) else "short"
                out.append(("liq", v.id, int(d.get("ts") or 0), side, p, float(d["sz"]) * v.contract))
    elif ch == "open-interest":
        for x in data:
            out.append(("oi", v.id, int(x.get("ts") or 0), float(x["oiCcy"])))
    elif ch == "funding-rate":
        for x in data:
            out.append(("fund", v.id, float(x["fundingRate"]), int(x.get("fundingTime") or 0)))
    elif ch == "books":
        for x in data:
            kind = "snapshot" if m.get("action") == "snapshot" else "delta"
            bids = [[float(r[0]), float(r[1]) * v.contract] for r in x.get("bids", ())]
            asks = [[float(r[0]), float(r[1]) * v.contract] for r in x.get("asks", ())]
            out.append(("book", v.id, kind, bids, asks, x.get("seqId"), x.get("prevSeqId")))
    return out


# ------------------------------------------------------------------ Coinbase Exchange feed
def coinbase(v: XVenue, m: dict):
    typ = m.get("type")
    out = []
    if typ in ("match", "last_match") and m.get("product_id") == "BTC-USD":
        p = float(m["price"])
        # Coinbase reports the MAKER side; the taker is the opposite side
        side = 1 if m["side"] == "sell" else -1
        out.append(("trade", v.id, iso_ms(m["time"]), p, float(m["size"]), side, m.get("taker_order_id"),
                    m.get("trade_id")))
    elif typ == "ticker":
        if m.get("product_id") == "USDT-USD" and m.get("price"):
            out.append(("usdt", float(m["price"])))
        elif m.get("product_id") == "BTC-USD" and m.get("price"):
            out.append(("px", v.id, iso_ms(m["time"]) if m.get("time") else 0, float(m["price"])))
    return out


def adapt(vkey: str, msg: dict, state=None):
    v = XVENUES[vkey]
    if vkey in ("bn_usdm", "bn_coinm", "bn_spot"):
        return binance(v, msg.get("data", msg))
    if vkey in ("bybit", "bybit_inv"):
        return bybit(v, msg, state)
    if vkey == "okx":
        return okx(v, msg)
    if vkey == "coinbase":
        return coinbase(v, msg)
    return []
