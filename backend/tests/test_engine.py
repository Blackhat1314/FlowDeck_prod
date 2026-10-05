"""Offline tests for the order-flow engine (run: python -m pytest -q backend/tests)."""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.engine import VENUES, Engine, Settings  # noqa: E402
from app.engine.flow import SweepGrouper  # noqa: E402
from app.engine.gamma import bs_gamma, compute_gex  # noqa: E402
from app.engine.heatmap import decode_columns  # noqa: E402
from app.sim import MarketSim  # noqa: E402

T0 = 1_790_000_000_000


def run_sim(seconds=120, seed=3, snapshot_after=3):
    sim = MarketSim(seed=seed, now_ms=T0)
    eng = Engine(VENUES["usdm"], Settings())
    cols = []
    for i in range(seconds * 10):
        for kind, msg in sim.step():
            eng.on_message(msg, sim.t + 20)
        if i == snapshot_after:
            eng.on_snapshot(sim.snapshot())
        col, upd = eng.tick(sim.t + 20)
        if col:
            cols.append(col)
    return sim, eng, cols


def test_book_matches_exchange_exactly():
    sim, eng, _ = run_sim(60)
    assert eng.book.synced
    # every level the engine knows that the simulated exchange also has must match exactly,
    # within the snapshot window (the engine only knows levels it has seen)
    snap = sim.snapshot(1000)
    res = eng.on_check_snapshot(snap)
    assert res["status"] == "ok"
    # levels the engine knows are exact; unseen far levels are reported as `missing`
    assert res["qty_diff"] == 0 and res["stale"] == 0, res
    assert res["known_pct"] == 100.0, res
    # after the repair pass the book equals the exchange snapshot completely
    res2 = eng.on_check_snapshot(sim.snapshot(1000))
    assert res2["pct"] == 100.0, res2
    bb, ba = sim.best()
    assert eng.book.best_bid == bb and eng.book.best_ask == ba


def test_sequence_gap_triggers_resync():
    sim, eng, _ = run_sim(5)
    assert eng.book.synced
    msgs = sim.step()
    book_msgs = [m for k, m in sim.step() if k == "book"]
    # drop one update -> pu chain breaks
    for m in book_msgs:
        eng.on_message(m, sim.t)
    assert eng.book.state == "buffering"
    assert eng.book.resyncs == 1
    eng.on_snapshot(sim.snapshot())
    for _ in range(5):
        for k, m in sim.step():
            eng.on_message(m, sim.t)
    assert eng.book.synced
    r = eng.on_check_snapshot(sim.snapshot())
    assert r["known_pct"] == 100.0, r


def test_bars_match_klines():
    sim, eng, _ = run_sim(200)
    s = eng.integ.summary()
    assert s["kline_checked"] >= 2, s
    assert s["vol_exact"] == s["kline_checked"]
    assert s["buy_exact"] == s["kline_checked"]
    assert s["ids_exact"] == s["kline_checked"]
    assert s["agg_gaps"] == 0


def test_heatmap_roundtrip():
    sim, eng, cols = run_sim(20)
    assert cols
    msg = Engine.pack(eng.heat.sample(sim.t + 50, 0.0))
    d = decode_columns(msg)[0]
    assert len(d["qty"]) == 2 * eng.s.half_range + 1
    total_engine = sum(d["qty"])
    assert total_engine > 0
    assert d["bb"] < d["ba"]
    # heatmap mass equals book mass inside the window
    base = d["base"]
    bt = eng.bt
    exp = 0
    bk = eng.book
    for k, q in list(bk.bids.items()) + list(bk.asks.items()):
        b = k // bt
        if base <= b < base + len(d["qty"]):
            exp += q / bk.qs
    assert abs(total_engine - exp) / exp < 1e-4


def test_sweep_grouping():
    g = SweepGrouper()
    assert g.add(1, 1000, 0, 1, 100.0, 1.0) is None
    assert g.add(2, 1000, 0, 1, 100.5, 2.0) is None
    done = g.add(3, 1001, 0, -1, 99.0, 1.0)
    assert done.q == 3.0 and done.n == 2 and done.lo == 100.0 and done.hi == 100.5


def _bs_call(F, K, T, s):
    d1 = (math.log(F / K) + 0.5 * s * s * T) / (s * math.sqrt(T))
    d2 = d1 - s * math.sqrt(T)
    N = lambda x: 0.5 * (1 + math.erf(x / math.sqrt(2)))
    return F * N(d1) - K * N(d2)


def test_bs_gamma_matches_finite_difference():
    F, K, T, s = 85_000.0, 90_000.0, 0.05, 0.45
    h = 5.0
    fd = (_bs_call(F + h, K, T, s) - 2 * _bs_call(F, K, T, s) + _bs_call(F - h, K, T, s)) / (h * h)
    assert abs(bs_gamma(F, K, T, s) - fd) / fd < 1e-3


def test_gex_levels():
    sim = MarketSim(seed=1, now_ms=T0)
    g = compute_gex(sim.option_chain(T0), T0)
    a = g["groups"]["all"]
    assert a["call_wall"] and a["put_wall"]
    assert a["flip"] is None or abs(a["flip"] / g["spot"] - 1) < 0.2
    assert g["max_pain"]


def test_absorption_fires_on_iceberg():
    # hammer a single level that keeps refilling
    eng = Engine(VENUES["usdm"], Settings())
    snap = {"lastUpdateId": 100, "bids": [["84000.0", "3.0"], ["83999.0", "5"]], "asks": [["84000.1", "2.0"]]}
    eng.on_snapshot(snap)
    eng.on_message({"e": "depthUpdate", "E": T0, "U": 100, "u": 101, "pu": 99, "b": [], "a": []}, T0)
    a = 1
    t = T0
    for i in range(200):           # > 10 s so the volume baseline is warmed up
        t += 100
        eng.on_message({"e": "aggTrade", "E": t, "a": a, "p": "84000.0", "q": "0.5", "f": a, "l": a, "T": t, "m": True}, t)
        a += 1
        eng.tick(t)
    assert len(eng.absd.events) >= 1
    ev = eng.absd.events[0]
    assert ev["side"] == "bid" and ev["vol"] >= 6
