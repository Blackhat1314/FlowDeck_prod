# Phase 2 live test. Runs inside Pyodide in a browser tab and drives the *unmodified* backend engine with every
# live feed the server uses (Binance USDⓈ-M book + tape, Binance COIN-M, Binance spot, Bybit linear + inverse,
# OKX, Coinbase). Records what the engine saw so the JS side can grade it against each exchange's own REST data.
import json
import time

from app.engine import VENUES, Engine, Settings
from app.engine.xchg import BY_ID, XVENUES

E = Engine(VENUES["usdm"], Settings())
S = {"msgs": 0, "xmsgs": {}, "proc_ms": 0.0, "max_ms": 0.0, "errors": [], "snap_ok": 0, "snap_fail": 0,
     "t0": None, "resubs": {}}
TR = {}       # vid -> {trade id: (t, price, btc, side)}
VOL = {}      # vid -> {minute: [btc, buy btc, n]}
LIQ = []      # (vid, t, side, price, btc)
KL = {}       # vkey -> {minute: kline row from the exchange's own stream}
BOOK = []

_on_trade = E.xflow.on_trade
_on_liq = E.xflow.on_liq


def _rec_trade(vid, t, p, btc, side, gkey, tid, lt, primary_px):
    d = TR.setdefault(vid, {})
    d[str(tid)] = (t, p, btc, side)
    if len(d) > 80000:
        for k in list(d)[:20000]:
            del d[k]
    m = int(t) - int(t) % 60000
    v = VOL.setdefault(vid, {}).setdefault(m, [0.0, 0.0, 0])
    v[0] += btc
    if side > 0:
        v[1] += btc
    v[2] += 1
    if vid == E.pvid:
        S["tape_cum"] = S.get("tape_cum", 0.0) + btc
    return _on_trade(vid, t, p, btc, side, gkey, tid, lt, primary_px)


def _rec_liq(vid, t, side, p, btc, lt):
    LIQ.append((vid, int(t), side, p, btc))
    return _on_liq(vid, t, side, p, btc, lt)


E.xflow.on_trade = _rec_trade
E.xflow.on_liq = _rec_liq


def feed(raw, recv):
    t = time.perf_counter()
    d = json.loads(raw)
    E.on_message(d.get("data", d), recv)
    _cost(t)
    S["msgs"] += 1
    if S["t0"] is None:
        S["t0"] = recv


def feed_x(vkey, raw, recv):
    """returns 1 when the engine asks for a resubscribe (book sequence gap)"""
    t = time.perf_counter()
    try:
        d = json.loads(raw)
    except ValueError:
        return 0
    try:
        E.on_xmsg(vkey, d, recv)
    except Exception as e:  # noqa: BLE001
        if len(S["errors"]) < 50:
            S["errors"].append(f"{vkey}: {type(e).__name__} {e} :: {raw[:200]}")
    _cost(t)
    S["xmsgs"][vkey] = S["xmsgs"].get(vkey, 0) + 1
    if vkey in E.resubscribe:
        E.resubscribe.discard(vkey)
        S["resubs"][vkey] = S["resubs"].get(vkey, 0) + 1
        return 1
    return 0


def _cost(t):
    dt = (time.perf_counter() - t) * 1000
    S["proc_ms"] += dt
    if dt > S["max_ms"]:
        S["max_ms"] = dt


def feed_kline(vkey, raw):
    """final 1m candles from Binance spot / COIN-M kline streams (the exchange's own per-minute totals)"""
    d = json.loads(raw)
    k = (d.get("data", d)).get("k")
    if k and k.get("x"):
        KL.setdefault(vkey, {})[int(k["t"])] = {"v": float(k["v"]), "V": float(k["V"]), "q": float(k["q"]),
                                                 "Q": float(k["Q"]), "n": int(k["n"])}


def needs_snapshot():
    return E.book.needs_snapshot and len(E.book.buffer) > 0


def synced():
    return E.book.synced


def snapshot(raw):
    ok = E.on_snapshot(json.loads(raw)["result"])
    S["snap_ok" if ok else "snap_fail"] += 1
    return ok


def check(raw):
    res = E.on_check_snapshot(json.loads(raw)["result"])
    if res is None:
        return ""
    res["t"] = int(time.time() * 1000)
    BOOK.append(res)
    return json.dumps(res)


def set_offset(ms):
    E.integ.clock_offset = float(ms)


def tick(now):
    E.tick(now)


# ------------------------------------------------------------------------------ grading helpers
def minute(vkey, t0):
    vid = XVENUES[vkey].id
    v = VOL.get(vid, {}).get(int(t0))
    return json.dumps(v)


def binance_klines():
    """engine per-minute BTC volume vs Binance spot / COIN-M candles (base-asset volume)"""
    out = {}
    for vkey, rows in KL.items():
        vid = XVENUES[vkey].id
        res = []
        for m, k in sorted(rows.items()):
            e = VOL.get(vid, {}).get(m)
            if not e or m < (S["t0"] or 0) + 60000:
                continue
            exch_v = k["v"] if vkey == "bn_spot" else k["q"]       # COIN-M: v is contracts, q is BTC
            exch_b = k["V"] if vkey == "bn_spot" else k["Q"]
            res.append({"t": m, "eng_v": round(e[0], 8), "exch_v": exch_v, "eng_buy": round(e[1], 8), "exch_buy": exch_b,
                        "eng_n": e[2], "exch_n": k["n"], "dv": round(e[0] - exch_v, 8), "db": round(e[1] - exch_b, 8)})
        out[vkey] = res
    return json.dumps(out)


def trades_check(vkey, rows_json, t_from, t_to):
    """rows: [[id, t, price, btc, side]] parsed by JS from the venue's REST trades (independently of the adapter)."""
    vid = XVENUES[vkey].id
    rec = TR.get(vid, {})
    rows = [r for r in json.loads(rows_json) if t_from <= r[1] <= t_to]
    found = px_ok = q_ok = side_ok = 0
    bad = []
    for rid, t, p, q, sd in rows:
        e = rec.get(str(rid))
        if e is None:
            if len(bad) < 5:
                bad.append(["missing", rid, t, p, q, sd])
            continue
        found += 1
        a = abs(e[1] - p) < 1e-6
        b = abs(e[2] - q) <= 1e-9 * max(1.0, q) + 1e-12
        c = e[3] == sd
        px_ok += a
        q_ok += b
        side_ok += c
        if not (a and b and c) and len(bad) < 5:
            bad.append(["diff", rid, [t, p, q, sd], list(e)])
    return json.dumps({"venue": vkey, "rest": len(rows), "found": found, "price_ok": px_ok, "size_ok": q_ok,
                       "side_ok": side_ok, "bad": bad})


def trades_check_grouped(vkey, rows_json, t_from, t_to):
    """Same as trades_check, for venues whose stream merges fills of one taker order at one price into a single
    record (OKX `trades`): both sides are grouped by (time, price, side) before comparing sizes."""
    vid = XVENUES[vkey].id
    rows = [r for r in json.loads(rows_json) if t_from <= r[1] <= t_to]
    rest, mine = {}, {}
    for rid, t, p, q, sd in rows:
        k = (int(t), round(p, 6), sd)
        rest[k] = rest.get(k, 0.0) + q
    for t, p, q, sd in TR.get(vid, {}).values():
        if t_from <= t <= t_to:
            k = (int(t), round(p, 6), sd)
            mine[k] = mine.get(k, 0.0) + q
    found = size_ok = 0
    bad = []
    for k, q in rest.items():
        e = mine.get(k)
        if e is None:
            if len(bad) < 5:
                bad.append(["missing", list(k), q])
            continue
        found += 1
        if abs(e - q) <= 1e-9 * max(1.0, q):
            size_ok += 1
        elif len(bad) < 5:
            bad.append(["diff", list(k), q, e])
    return json.dumps({"venue": vkey, "rest": len(rest), "found": found, "price_ok": found, "size_ok": size_ok,
                       "side_ok": found, "bad": bad, "grouped": True, "rest_trades": len(rows)})


def book_check(vkey, bids_json, asks_json, depth):
    """XBook vs a REST snapshot of the same venue: levels within `depth` of the top on each side."""
    vid = XVENUES[vkey].id
    xb = E.xbooks.get(vid)
    if xb is None or not xb.ok:
        return json.dumps({"venue": vkey, "ok": False})
    inv = xb.inv
    res = {"venue": vkey, "ok": True, "levels": 0, "match": 0, "missing": 0, "qty_diff": 0, "best": None}
    for side, rows in (("b", json.loads(bids_json)), ("a", json.loads(asks_json))):
        book = xb.bids if side == "b" else xb.asks
        for p, q in rows[:depth]:
            k = int(round(p * inv))
            mine = book.get(k)
            res["levels"] += 1
            if mine is None:
                res["missing"] += 1
            elif abs(mine - q) <= 1e-9 * max(1.0, q):
                res["match"] += 1
            else:
                res["qty_diff"] += 1
    if xb.bids and xb.asks:
        res["best"] = [max(xb.bids) / inv, min(xb.asks) / inv]
    res["seq"] = xb.seq
    return json.dumps(res)


def venue_state():
    out = {}
    for vid, st in E.xflow.v.items():
        out[BY_ID[vid].key] = {"px": st.px, "basis": st.basis, "oi": st.oi, "fund": st.fund, "next": st.next_fund,
                               "trades": st.trades, "msgs": st.msgs}
    return json.dumps(out)


def liqs():
    return json.dumps(LIQ[-500:])


def report():
    now = time.time() * 1000
    h = E.health()
    ms = E.micro.stats
    qs = E.v.qty_scale
    return json.dumps({
        "uptime_s": round((now - (S["t0"] or now)) / 1000),
        "msgs": S["msgs"], "xmsgs": S["xmsgs"], "avg_ms": round(S["proc_ms"] / max(1, S["msgs"] + sum(S["xmsgs"].values())), 3),
        "max_ms": round(S["max_ms"], 1), "errors": S["errors"][:10], "resubs": S["resubs"],
        "xbooks": h.get("xbooks"), "liqmap": h.get("liqmap"),
        "micro": {k: round(v / qs, 3) if k != "dec" else v for k, v in ms.items()},
        "flow": E.xflow.panel(now),
        "events": list(E.xflow.events)[-20:],
        "micro_events": {t: sum(1 for e in E.micro.events if e["type"] == t) for t in ("pulled", "eaten", "iceberg")},
        "walls": E.micro.walls_now(now),
        "liqs": len(LIQ),
        "book": {"checks": len(BOOK), "last": BOOK[-1] if BOOK else None},
        "kline": {k: h[k] for k in ("kline_checked", "vol_exact", "buy_exact", "ids_exact", "ohlc_exact", "agg_gaps")},
    })


def micro_mark():
    """cumulative fills reconciled from the book (+ hidden volume) and the primary tape volume, for deltas in JS"""
    ms = E.micro.stats
    qs = E.v.qty_scale
    return json.dumps({"t": int(time.time() * 1000), "filled": ms["filled"] / qs, "hidden": ms["hidden"] / qs,
                       "cancelled": ms["cancelled"] / qs, "added": ms["added"] / qs, "tape": S.get("tape_cum", 0.0),
                       "synced": E.book.synced, "resyncs": E.integ.summary().get("resyncs", 0) if hasattr(E.integ, "summary") else 0})
