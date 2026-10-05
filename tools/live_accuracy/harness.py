# Runs inside Pyodide in a browser tab. Drives the *unmodified* backend engine (backend/app/engine)
# with the live Binance + Deribit feeds and records accuracy metrics.
import json
import time

from app.engine import VENUES, Engine, Settings
from app.engine.gamma import bs_gamma, bs_delta, compute_gex, parse_instrument

E = Engine(VENUES["usdm"], Settings())
E2 = Engine(VENUES["coinm"], Settings())      # COIN-M BTCUSD_PERP: trades/candles cross-check only
S = {"msgs": 0, "proc_ms": 0.0, "max_ms": 0.0, "by": {}, "t0": None, "snap_ok": 0, "snap_fail": 0, "cols": 0}
BOOK = []
GEX = {"last": None, "n": 0}


def feed(raw, recv):
    t = time.perf_counter()
    d = json.loads(raw)
    d = d.get("data", d)
    E.on_message(d, recv)
    dt = (time.perf_counter() - t) * 1000
    S["msgs"] += 1
    S["proc_ms"] += dt
    if dt > S["max_ms"]:
        S["max_ms"] = dt
    e = d.get("e", "?")
    S["by"][e] = S["by"].get(e, 0) + 1
    if S["t0"] is None:
        S["t0"] = recv


def feed2(raw, recv):
    d = json.loads(raw)
    E2.on_message(d.get("data", d), recv)


def tick2(now):
    E2.tick(now)


def report2():
    h = E2.integ.summary()
    ks = [r for r in E2.integ.klines if r.get("status") == "ok"]
    return json.dumps({"kline": {k: h[k] for k in ("kline_checked", "vol_exact", "vol_close", "buy_exact", "ids_exact",
                                                  "ohlc_exact", "agg_gaps")},
                       "rows": [{k: r[k] for k in ("t", "vol_k", "vol_e", "buy_k", "buy_e", "ids_ok", "ohlc_ok")}
                                for r in ks[-30:]],
                       "trades": E2.flow.live_trades, "last_px": E2.flow.last_px, "mark": E2.stats["mark"]})


def needs_snapshot():
    return E.book.needs_snapshot and len(E.book.buffer) > 0


def synced():
    return E.book.synced


def snapshot(raw):
    r = json.loads(raw)["result"]
    ok = E.on_snapshot(r)
    S["snap_ok" if ok else "snap_fail"] += 1
    return ok


def check(raw):
    r = json.loads(raw)["result"]
    res = E.on_check_snapshot(r)
    if res is None:
        return ""
    res["t"] = int(time.time() * 1000)
    BOOK.append(res)
    return json.dumps(res)


def set_offset(ms):
    E.integ.clock_offset = float(ms)


def tick(now):
    col, upd = E.tick(now)
    if col:
        S["cols"] += 1


def gex(raw, now):
    rows = json.loads(raw)["result"]
    t = time.perf_counter()
    g = compute_gex(rows, now)
    ms = (time.perf_counter() - t) * 1000
    E.set_gex(g)
    GEX["last"] = g
    GEX["n"] += 1
    GEX["ms"] = ms
    a = g["groups"]["all"]
    return json.dumps({"spot": g["spot"], "net": a["net"], "flip": a["flip"], "call_wall": a["call_wall"],
                       "put_wall": a["put_wall"], "max_pain": g["max_pain"], "n": g["n_options"], "ms": round(ms),
                       "basis": g.get("basis")})


def greeks_check(raw_list, now):
    """Compare our Black-Scholes gamma/delta with Deribit's published greeks for the same instruments."""
    out = []
    for raw in json.loads(raw_list):
        r = json.loads(raw).get("result")
        if not r or not r.get("greeks"):
            continue
        exp, K, cp = parse_instrument(r["instrument_name"])
        T = (exp - r["timestamp"]) / (365.0 * 86400000)
        F = r["underlying_price"]
        sig = r["mark_iv"] / 100.0
        g_ours = bs_gamma(F, K, T, sig)
        d_ours = bs_delta(F, K, T, sig, cp)
        g_der = r["greeks"]["gamma"]
        d_der = r["greeks"]["delta"]
        out.append({"i": r["instrument_name"], "g_ours": g_ours, "g_der": g_der,
                    "g_err": abs(g_ours - g_der) / g_der if g_der else None,
                    "d_ours": d_ours, "d_der": d_der, "oi": r.get("open_interest")})
    errs = sorted(x["g_err"] for x in out if x["g_err"] is not None)
    summ = {"n": len(out), "median_err": errs[len(errs) // 2] if errs else None,
            "p90_err": errs[int(len(errs) * 0.9)] if errs else None, "max_err": errs[-1] if errs else None}
    return json.dumps({"summary": summ, "rows": out})


def bar_levels(t):
    b = E.flow.bars.get(int(t))
    if b is None:
        return "null"
    return json.dumps({"t": b.t, "v": b.rv / E.v.qty_scale, "bv": b.rbv / E.v.qty_scale, "n": b.n,
                       "first_a": b.oid, "last_a": b.cid,
                       "lv": sorted([[k, round(v[0], 6), round(v[1], 6)] for k, v in b.lv.items()])})


def report():
    h = E.integ.summary()
    ks = [r for r in E.integ.klines if r.get("status") == "ok"]
    bad = [r for r in ks if not (r["vol_ok"] and r["buy_ok"])]
    return json.dumps({
        "elapsed_s": round((time.time() * 1000 - S["t0"]) / 1000) if S["t0"] else 0,
        "msgs": S["msgs"], "by_type": S["by"],
        "proc_avg_ms": round(S["proc_ms"] / max(1, S["msgs"]), 4), "proc_max_ms": round(S["max_ms"], 2),
        "snap_ok": S["snap_ok"], "snap_fail": S["snap_fail"], "columns": S["cols"],
        "book_state": E.book.state, "resyncs": E.book.resyncs, "crossed": E.book.crossed,
        "levels": [len(E.book.bids), len(E.book.asks)],
        "kline": {k: h[k] for k in ("kline_checked", "vol_exact", "vol_close", "buy_exact", "buy_close", "ids_exact",
                                    "ohlc_exact", "vol_err_avg", "buy_err_avg", "agg_gaps", "clock_offset")},
        "kline_bad": bad[:5],
        "kline_rows": [{k: r[k] for k in ("t", "vol_k", "vol_e", "vol_diff", "buy_k", "buy_e", "n_k", "n_e", "f_k", "f_e",
                                          "L_k", "L_e", "ids_ok", "ohlc_ok")}
                       for r in ks[-30:]],
        "book_checks": [{k: r.get(k) for k in ("t", "levels", "match", "qty_diff", "missing", "stale", "excluded",
                                               "pct", "known_pct", "coverage_pct", "lag_events")} for r in BOOK],
        "latency": {"p50": h["lat_p50"], "p95": h["lat_p95"]},
        "sweeps": len(E.flow.sweeps), "big_5btc": sum(1 for s in E.flow.sweeps if s["q"] >= 5),
        "liqs": len(E.flow.liqs),
        "absorption": {"events": list(E.absd.events)[-20:], "stats": E.absd.stats()},
        "gex": {k: GEX["last"].get(k) for k in ("spot", "max_pain", "pcr", "n_options", "basis")} if GEX["last"] else None,
        "gex_levels": {k: GEX["last"]["groups"]["all"][k] for k in ("net", "flip", "call_wall", "put_wall", "pos", "neg")}
        if GEX["last"] else None,
        "last_px": E.flow.last_px, "best": E.book.best_prices(),
    })
