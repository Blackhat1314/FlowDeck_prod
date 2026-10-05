"""Longer history: heatmap tiers (5 s, 1 min), the archive on disk, footprint save/restore and Binance daily back-fill."""
import asyncio
import math
import os
import struct
import tempfile
import time
import zlib
from array import array
from pathlib import Path

import pytest

TMP = tempfile.mkdtemp(prefix="fd-hist-")
os.environ.setdefault("FLOWDECK_DB", os.path.join(TMP, "h.db"))
os.environ.setdefault("FLOW_DEMO", "1")
os.environ.setdefault("FLOW_DEMO_WARMUP_MIN", "1")

from app.archive import Archive, day_of  # noqa: E402
from app.engine import VENUES, Settings  # noqa: E402
from app.engine.flow import MIN, Flow  # noqa: E402
from app.engine.heatmap import BQ, HDR, SZ, TAIL, TRD, U32  # noqa: E402
from app.engine.heattiers import TIER_1M, TIER_5S, HeatTiers, merge, parse, rec_time  # noqa: E402
from app.histfill import build_bars  # noqa: E402


def rec(t, base, liq, trades=(), last=100.0, n=11, oi=math.nan):
    q = array("f", [liq] * n)
    parts = [HDR.pack(t, 99.0, 101.0, base, n, len(trades), last), q.tobytes()]
    parts += [TRD.pack(b, buy, sell) for b, buy, sell in trades]
    parts += [U32.pack(0), U32.pack(1), BQ.pack(base, 2.0), U32.pack(1), TRD.pack(3, 1.0, 0.5)]
    parts += [SZ.pack(1, 0, 0, 0, 0, 0), TAIL.pack(math.nan, oi, 0.0, 0.25)]
    return b"".join(parts)


# ------------------------------------------------------------------------------------------ merging
def test_merge_averages_liquidity_and_sums_trades():
    cols = [parse(rec(1000, 50, 4.0, [(55, 1.0, 0.0)])), parse(rec(1250, 52, 0.0, [(55, 0.5, 2.0)], last=101.0, oi=7.0))]
    m = parse(merge(cols, 1000))
    assert m.t == 1000 and m.base == 50 and len(m.qty) == 13
    assert m.qty[0] == pytest.approx(2.0)          # 4 in one column, absent in the other
    assert m.tr[55] == pytest.approx((1.5, 2.0))   # trades add up
    assert m.ex[3] == pytest.approx((2.0, 1.0)) and m.sz[0] == 2 and m.liq[1] == pytest.approx(0.5)
    assert m.last == 101.0 and m.oi == 7.0          # latest values


def test_tiers_make_5s_then_1m_columns():
    t = HeatTiers(keep_hours=1)
    t0 = 1_700_000_000_000 - 1_700_000_000_000 % 60_000
    for i in range(int(61_000 / 250) + 30):     # a bit more than a minute of 250 ms columns
        t.add(rec(t0 + i * 250, 100, 1.0))
    times = [rec_time(r) for r in t.s5]
    assert times[:3] == [t0, t0 + 5000, t0 + 10000] and len(times) == 13     # 68.5 s of columns: 13 closed windows
    s5, m1 = t.take_new()
    assert len(s5) == 13 and len(m1) == 1 and m1[0][0] == t0
    assert parse(m1[0][1]).qty[0] == pytest.approx(1.0)
    assert t.take_new() == ([], [])


# ------------------------------------------------------------------------------------------ archive
def test_archive_heat_roundtrip_across_days(tmp_path):
    a = Archive(tmp_path)
    day0 = 1_700_006_400_000 - 1_700_006_400_000 % 86_400_000
    items = [(day0 - 120_000 + i * 60_000, rec(day0 - 120_000 + i * 60_000, 1, 1.0)) for i in range(5)]   # 2 days
    a.append_heat("1m", items)
    got = a.read_heat("1m", day0 - 200_000, day0 + 200_000)
    assert [rec_time(r) for r in got] == [t for t, _ in items]
    assert len(a.read_heat("1m", 0, day0 + 200_000, limit=2)) == 2          # newest two only
    # a crash in the middle of a write leaves a half frame: earlier frames still read
    f = tmp_path / "heat1m" / f"{day_of(day0)}.bin"
    with open(f, "ab") as fh:
        fh.write(struct.pack("<I", 999) + b"partial")
    assert len(a.read_heat("1m", day0, day0 + 200_000)) == 3


def test_full_day_keeps_live_bars(tmp_path):
    a = Archive(tmp_path)
    t = 1_700_006_400_000 - 1_700_006_400_000 % 86_400_000
    a.append_bars([{"t": t, "v": 9.0, "sl": [1, 2, 3], "lv": []}])
    a.write_full_day(day_of(t), [{"t": t, "v": 1.0, "lv": []}, {"t": t + MIN, "v": 2.0, "lv": []}])
    bars = a.read_bars(t, t + 2 * MIN)
    assert [b["v"] for b in bars] == [9.0, 2.0] and a.day_full(day_of(t))


# ------------------------------------------------------------------------------------------ footprint
def trade(a, p, q, T, maker):
    return {"a": a, "p": str(p), "q": str(q), "f": a, "l": a, "T": T, "m": maker}


def test_footprint_restore_and_no_double_count():
    v, s = VENUES["usdm"], Settings()
    bt = int(round(s.bucket_usd / v.tick))
    f = Flow(v, s, bt)
    m0 = 1_700_000_040_000 - 1_700_000_040_000 % MIN
    for i in range(30):
        f.on_trade(trade(i, 100.0 + (i % 3), 0.5, m0 + i * 3000, i % 2 == 0), m0 + i * 3000, live=False)
    f.coverage_from = m0
    saved = f.completed_bars(m0 + 5 * MIN)
    assert [b["t"] for b in saved] == [m0, m0 + MIN] and f.completed_bars(m0 + 5 * MIN) == []

    g = Flow(v, s, bt)
    g.restore(saved)
    assert g.bars[m0].rs and g.bars[m0].v == pytest.approx(f.bars[m0].v) and g.bars[m0].lv == f.bars[m0].lv
    # after the restart the tick back-fill replays the second minute again: it must not count twice
    from app.engine import Engine
    e = Engine(v, s)
    e.flow.restore(saved)
    e.backfill_trades([trade(i, 100.0 + (i % 3), 0.5, m0 + i * 3000, i % 2 == 0) for i in range(20, 30)], m0 + MIN)
    assert e.flow.bars[m0 + MIN].v == pytest.approx(f.bars[m0 + MIN].v)
    assert e.flow.bars[m0].v == pytest.approx(f.bars[m0].v)       # older restored minute untouched


def test_backfill_bars_match_live_engine():
    v, s = VENUES["usdm"], Settings()
    f = Flow(v, s, int(round(s.bucket_usd / v.tick)))
    m0 = 1_700_000_040_000 - 1_700_000_040_000 % MIN
    rows, n = [], 0
    for i in range(400):
        p, q, T, maker = round(64000 + (i * 37 % 90) * 0.1, 1), round(0.001 * (1 + i % 7), 3), m0 + i * 450, i % 3 == 0
        f.on_trade(trade(i, p, q, T, maker), T, live=False)
        rows.append([str(i), str(p), str(q), str(i), str(i), str(T), "true" if maker else "false"])
    rows.insert(0, ["agg_trade_id", "price", "quantity", "first_trade_id", "last_trade_id", "transact_time", "is_buyer_maker"])
    built = {b["t"]: b for b in build_bars(rows, v.tick, s.bucket_usd)}
    for t, bar in f.bars.items():
        live = bar.to_json("all")
        got = built[t]
        for k in ("o", "h", "l", "c", "v", "bv", "sv", "n", "dx"):
            assert got[k] == live[k], (t, k)
        levels = lambda f: {f[i]: tuple(f[i + 1:i + 5]) for i in range(0, len(f), 5)}   # order doesn't matter
        assert levels(got["lv"]) == levels(live["lv"]), t


# ------------------------------------------------------------------------------------------ server
def test_restart_restores_heatmap_and_footprint(tmp_path, monkeypatch):
    monkeypatch.setenv("FLOW_DEMO_WARMUP_MIN", "4")
    from app.runtime import Runtime

    async def run():
        r = Runtime(demo=True, archive_root=tmp_path, fill_days=0)
        await r.start()
        await asyncio.wait_for(r.ready.wait(), 120)     # the demo fast-forwards 4 minutes of market first
        await asyncio.sleep(0.5)
        n5 = len(r.engine.tiers.s5)
        await r.stop()                                  # saves what it has
        r2 = Runtime(demo=True, archive_root=tmp_path, fill_days=0)
        r2._open_archive()
        return n5, len(r2.engine.tiers.s5), sum(1 for b in r2.engine.flow.bars.values() if b.rs)
    n5, restored, bars = asyncio.run(run())
    assert n5 >= 40 and restored == n5 and bars >= 1     # bars are final 2 min after they close
    assert (tmp_path / "demo-usdm" / "heat1m").exists()


def test_history_endpoints():
    from fastapi.testclient import TestClient
    from app import main
    J = {"origin": "http://testserver"}
    with TestClient(main.app, base_url="http://testserver") as c:
        main.signup_ip.hits.clear()
        c.post("/api/auth/signup", json={"name": "H", "email": "hist@example.com", "password": "password123"}, headers=J)
        deadline = time.time() + 30
        while not main.runtime.engine.tiers.s5 and time.time() < deadline:
            time.sleep(0.5)
        now = time.time() * 1000
        r = c.get("/api/history/heatmap", params={"before": now, "span": 3600_000})
        assert r.status_code == 200 and r.headers["X-History-Dt"] == str(TIER_5S)
        body = r.content
        (n,) = struct.unpack_from("<I", body, 0)
        typ, ver, cnt = struct.unpack_from("<BBH", body, 4)
        assert typ == 2 and cnt >= 1 and n + 4 <= len(body)
        assert c.get("/api/history/footprint", params={"start": now - 3600_000, "end": now}).status_code == 200
        # no live plan, no history
        u = main.accounts.user_by_email("hist@example.com")
        main.accounts.update_user(u["id"], {"expires_at": now - 1000})
        assert c.get("/api/history/heatmap", params={"before": now}).status_code == 403
