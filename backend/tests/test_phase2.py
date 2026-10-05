"""Tests for the cross-exchange / microstructure modules (run: python -m pytest -q backend/tests)."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.engine import VENUES, Engine, Settings  # noqa: E402
from app.engine.heatmap import decode_columns  # noqa: E402
from app.engine.liqmap import LiqMap  # noqa: E402
from app.engine.xbook import XBook  # noqa: E402
from app.engine.xchg import XVENUES, BybitState, adapt, iso_ms  # noqa: E402

T0 = 1_790_977_120_000
BYB, BYBI, OKX, BNS, CB = (XVENUES[k].id for k in ("bybit", "bybit_inv", "okx", "bn_spot", "coinbase"))


# ---------------------------------------------------------------- adapters (formats captured live)
def test_bybit_trades_and_liquidations():
    m = json.loads('{"topic":"publicTrade.BTCUSDT","type":"snapshot","ts":1790977123571,"data":['
                   '{"T":1790977123570,"s":"BTCUSDT","S":"Buy","v":"0.080","p":"84457.30","L":"ZeroPlusTick",'
                   '"i":"a","BT":false,"RPI":false,"seq":819828135729},'
                   '{"T":1790977123570,"s":"BTCUSDT","S":"Buy","v":"0.109","p":"84457.30","i":"b","seq":819828135729}]}')
    ev = adapt("bybit", m, BybitState())
    assert [e[0] for e in ev] == ["trade", "trade"]
    assert ev[0][3] == 84457.3 and abs(ev[0][4] - 0.08) < 1e-12 and ev[0][5] == 1 and ev[0][6] == 819828135729
    liq = adapt("bybit", {"topic": "allLiquidation.BTCUSDT", "data": [{"T": 1, "s": "BTCUSDT", "S": "Buy", "v": "2.5", "p": "84000"}]}, BybitState())
    assert liq[0][0] == "liq" and liq[0][3] == "long" and liq[0][5] == 2.5      # S=Buy -> long liquidated
    inv = adapt("bybit_inv", {"topic": "publicTrade.BTCUSD", "data": [{"T": 1, "S": "Sell", "v": "8400", "p": "84000", "seq": 5}]}, BybitState())
    assert abs(inv[0][4] - 0.1) < 1e-12 and inv[0][5] == -1                   # 8400 USD contracts = 0.1 BTC


def test_bybit_ticker_single_counted_oi():
    st = BybitState()
    snap = {"topic": "tickers.BTCUSDT", "type": "snapshot", "ts": 10, "data": {
        "markPrice": "84457.30", "openInterest": "56562.078", "singleOpenInterest": "28281.039",
        "fundingRate": "-0.00004104", "nextFundingTime": "1790985600000"}}
    ev = {e[0]: e for e in adapt("bybit", snap, st)}
    assert ev["oi"][3] == 28281.039
    assert ev["fund"][2] == -0.00004104
    delta = {"topic": "tickers.BTCUSDT", "type": "delta", "ts": 11, "data": {"bid1Price": "1"}}
    assert not [e for e in adapt("bybit", delta, st) if e[0] == "oi"]          # no OI field -> no OI event
    st2 = BybitState()
    inv = {"topic": "tickers.BTCUSD", "type": "snapshot", "ts": 1, "data": {
        "markPrice": "84439.49", "openInterest": "468908504", "openInterestValue": "5553.19",
        "singleOpenInterest": "234454252", "singleOpenInterestValue": "2776.59"}}
    assert [e for e in adapt("bybit_inv", inv, st2) if e[0] == "oi"][0][3] == 2776.59


def test_okx_messages():
    t = adapt("okx", {"arg": {"channel": "trades", "instId": "BTC-USDT-SWAP"}, "data": [
        {"instId": "BTC-USDT-SWAP", "tradeId": "1", "px": "84462.9", "sz": "30", "side": "sell", "ts": "1790977123281"}]})
    assert t[0][0] == "trade" and abs(t[0][4] - 0.3) < 1e-12 and t[0][5] == -1
    oi = adapt("okx", {"arg": {"channel": "open-interest"}, "data": [{"oiCcy": "28558.97", "ts": "5"}]})
    assert oi[0][3] == 28558.97
    liq = adapt("okx", {"arg": {"channel": "liquidation-orders", "instType": "SWAP"}, "data": [
        {"instId": "ETH-USDT-SWAP", "details": [{"posSide": "long", "side": "sell", "sz": "5", "bkPx": "2000", "ts": "1"}]},
        {"instId": "BTC-USDT-SWAP", "details": [{"posSide": "short", "side": "buy", "sz": "120", "bkPx": "85000", "ts": "2"}]}]})
    assert len(liq) == 1 and liq[0][3] == "short" and abs(liq[0][5] - 1.2) < 1e-12
    bk = adapt("okx", {"arg": {"channel": "books"}, "action": "snapshot", "data": [
        {"asks": [["84462.9", "798.89", "0", "24"]], "bids": [["84462.8", "10", "0", "1"]], "seqId": 7, "prevSeqId": -1}]})
    assert bk[0][2] == "snapshot" and abs(bk[0][4][0][1] - 7.9889) < 1e-9


def test_coinbase_taker_side_and_time():
    m = {"type": "match", "trade_id": 1, "taker_order_id": "x", "side": "sell", "size": "0.5", "price": "84495.35",
         "product_id": "BTC-USD", "time": "2026-10-02T21:38:44.085466Z"}
    ev = adapt("coinbase", m)
    assert ev[0][5] == 1                       # maker sold -> taker BUY
    assert ev[0][2] == iso_ms("2026-10-02T21:38:44.085Z")
    assert adapt("coinbase", {"type": "ticker", "product_id": "USDT-USD", "price": "0.99983"})[0] == ("usdt", 0.99983)


# ---------------------------------------------------------------- cross-exchange flow
def _eng():
    e = Engine(VENUES["usdm"], Settings())
    e.on_snapshot({"lastUpdateId": 10, "bids": [["84000.0", "5"]], "asks": [["84000.1", "5"]]})
    e.on_message({"e": "depthUpdate", "E": T0, "U": 10, "u": 11, "pu": 9, "b": [], "a": []}, T0)
    e.on_message({"e": "aggTrade", "E": T0, "a": 1, "p": "84000.1", "q": "0.1", "f": 1, "l": 1, "T": T0, "m": False}, T0)
    return e


def test_xflow_columns_sizes_tape_premium():
    e = _eng()
    t = T0 + 10
    # one Bybit taker order of 12 BTC split into two fills (same seq) -> one large sweep
    e.on_xmsg("bybit", {"topic": "publicTrade.BTCUSDT", "data": [
        {"T": t, "S": "Buy", "v": "7", "p": "84001", "seq": 99, "i": "a"},
        {"T": t, "S": "Buy", "v": "5", "p": "84002", "seq": 99, "i": "b"}]}, t)
    e.on_xmsg("coinbase", {"type": "ticker", "product_id": "USDT-USD", "price": "0.9998"}, t)
    e.on_xmsg("coinbase", {"type": "match", "side": "buy", "size": "2", "price": "84010", "product_id": "BTC-USD",
                           "taker_order_id": "z", "trade_id": 3, "time": "2026-10-02T21:38:44.100Z"}, t)
    e.on_xmsg("bn_spot", {"e": "aggTrade", "p": "84020", "q": "1", "T": t, "m": False, "a": 5}, t)
    col, upd = e.tick(t + 400)
    d = decode_columns(Engine.pack(col))[0]
    ex = {int(r[0]): (r[1], r[2]) for r in d["ex"]}
    assert abs(ex[BYB][0] - 12) < 1e-4 and abs(ex[CB][1] - 2) < 1e-4 and abs(ex[BNS][0] - 1) < 1e-4
    assert abs(d["sz"][4] - 12) < 1e-4                    # >= 10 BTC buy class
    assert any(s.get("x") == BYB and abs(s["q"] - 12) < 1e-9 and s["n"] == 2 for s in upd["sweeps"])
    prem = d["tail"][0]
    assert abs(prem - (84010 - 84020 * 0.9998)) < 0.01


def test_oi_delta_ignores_venues_joining():
    e = _eng()
    e.on_xmsg("okx", {"arg": {"channel": "open-interest"}, "data": [{"oiCcy": "28000", "ts": "1"}]}, T0)
    assert e.xflow.take_oi_delta() == 0                    # first value: no delta
    e.on_xmsg("okx", {"arg": {"channel": "open-interest"}, "data": [{"oiCcy": "28010", "ts": "2"}]}, T0)
    e.on_xmsg("bybit", {"topic": "tickers.BTCUSDT", "type": "snapshot", "ts": 3, "data": {"singleOpenInterest": "30000"}}, T0)
    assert abs(e.xflow.take_oi_delta() - 10) < 1e-9        # Bybit joining adds level, not delta
    assert abs(e.xflow.oi_total(T0 + 1) - 58010) < 1e-6


def test_regime_perp_led_rally():
    e = _eng()
    xf = e.xflow
    # 5 minutes: price +0.3 %, perps net buying, spot net selling
    for i in range(301):
        xf.sec.append((1000 + i, 84000 + i * 0.84, 10.0, 6.0, 2.0, 3.0, (0.0,) * 6, 0.0, 0.0, 0.0, None))
    xf._eval_regime(T0)
    assert xf.regime["state"] == "perp_led_up"
    assert xf.new_events and xf.new_events[-1]["bias"] == -1


def test_cascade_detection_and_unified_liqs():
    e = _eng()
    for i in range(10):
        e.on_xmsg("bybit", {"topic": "allLiquidation.BTCUSDT", "data": [{"T": T0 + i, "S": "Buy", "v": "3", "p": "83900"}]}, T0 + i)
    e.on_message({"e": "forceOrder", "E": T0, "o": {"S": "SELL", "q": "1", "ap": "83950", "z": "1", "T": T0}}, T0 + 20)
    assert len(e.xflow.liqs) == 11 and all(j["side"] == "long" for j in e.xflow.liqs)
    e.xflow._eval_cascade(T0 + 100)
    assert any(ev["type"] == "cascade" and ev["side"] == "long" and ev["btc"] >= 30 for ev in e.xflow.new_events)
    bar = e.flow.bars[T0 - T0 % 60000]
    assert abs(bar.lq[0] - 31) < 1e-9


# ---------------------------------------------------------------- microstructure
def _wall_engine():
    e = Engine(VENUES["usdm"], Settings())
    bids = [[f"{84000 - i * 0.1:.1f}", "1.0"] for i in range(300)]
    asks = [[f"{84000.1 + i * 0.1:.1f}", "1.0"] for i in range(300)]
    bids[30] = ["83997.0", "60.0"]          # wall 3 USD below
    e.on_snapshot({"lastUpdateId": 100, "bids": bids, "asks": asks})
    e.on_message({"e": "depthUpdate", "E": T0, "U": 100, "u": 101, "pu": 99, "b": [], "a": []}, T0)
    e.micro.thr_lots = 30_000               # 30 BTC
    e.on_message({"e": "depthUpdate", "E": T0, "U": 102, "u": 102, "pu": 101, "b": [["83997.0", "61.0"]], "a": []}, T0)
    return e


def test_wall_pulled_vs_filled():
    e = _wall_engine()
    assert ("b", 839970) in e.micro.walls
    # pulled: size drops to 0 with no trades while price is 3 USD away (< 8 bps)
    e.on_message({"e": "depthUpdate", "E": T0 + 100, "U": 103, "u": 103, "pu": 102, "b": [["83997.0", "0"]], "a": []}, T0 + 100)
    for k in range(20):
        e.tick(T0 + 200 + k * 100)
    ev = [x for x in e.micro.events if x["type"] == "pulled"]
    assert ev and ev[0]["p"] == 83997.0 and ev[0]["cancelled"] > 50

    e = _wall_engine()
    # filled: trades at the wall explain the decrease
    for i in range(6):
        t = T0 + 100 + i * 50
        e.on_message({"e": "aggTrade", "E": t, "a": 10 + i, "p": "83997.0", "q": "10", "f": 10 + i, "l": 10 + i, "T": t, "m": True}, t)
    e.on_message({"e": "depthUpdate", "E": T0 + 420, "U": 103, "u": 103, "pu": 102, "b": [["83997.0", "1.0"]], "a": []}, T0 + 420)
    for k in range(20):
        e.tick(T0 + 500 + k * 100)
    assert any(x["type"] == "eaten" for x in e.micro.events)
    dom = e.micro.dom(T0 + 2500)
    row = [r for r in dom["rows"] if r[0] == 83997][0]
    assert row[1 + 2 + 4 * 2 + 1] >= 59           # 60 s window: bid fills ~60 BTC


def test_iceberg_detection():
    e = _wall_engine()
    t = T0 + 100
    u = 103
    for i in range(12):                    # level keeps showing 1 BTC while 3 BTC trades each time
        e.on_message({"e": "aggTrade", "E": t, "a": 100 + i, "p": "83999.0", "q": "3", "f": 100 + i, "l": 100 + i, "T": t, "m": True}, t)
        e.on_message({"e": "depthUpdate", "E": t + 30, "U": u, "u": u, "pu": u - 1, "b": [["83999.0", "0.2"]], "a": []}, t + 30)
        u += 1
        e.on_message({"e": "depthUpdate", "E": t + 130, "U": u, "u": u, "pu": u - 1, "b": [["83999.0", "1.0"]], "a": []}, t + 130)
        u += 1
        for k in range(4):
            e.tick(t + 150 + k * 100)
        t += 500
    for k in range(30):
        e.tick(t + k * 100)
    ice = [x for x in e.micro.events if x["type"] == "iceberg"]
    assert ice and ice[0]["p"] == 83999.0 and ice[0]["exec"] >= 4


# ---------------------------------------------------------------- liquidation map
def test_liqmap_levels_consume_and_close():
    lm = LiqMap(bucket_usd=25.0, leverage=((10, 1.0),), mm=0.0)
    lm.on_oi(1000.0, 0)
    lm.on_trade(80000.0, 10.0, 1)
    lm.on_oi(1100.0, 1000)                  # +100 BTC opened at 80k, taker buys
    snap = lm.snapshot(80000.0)
    assert snap["top_long"][0]["p"] == 72000.0 and snap["top_short"][0]["p"] == 88000.0
    assert snap["total_long"] > snap["total_short"]          # aggressive side weighted more
    lm.on_trade(71990.0, 1.0, -1)
    lm.on_oi(1100.0, 2000)                  # price traded through 72k -> those longs are gone
    assert not lm.snapshot(80000.0)["long"]
    lm.on_oi(550.0, 3000)                   # half the OI closed -> shorts halved
    assert abs(lm.snapshot(80000.0)["total_short"] - snap["total_short"] / 2) < 0.2


def test_xbook_okx_gap_and_combined_book():
    xb = XBook(4, 0.1, 1.0)
    assert xb.apply("snapshot", [[84000.0, 2.0]], [[84001.0, 3.0]], 7, -1)
    assert xb.apply("delta", [[84000.0, 4.0]], [], 8, 7)
    assert xb.bucket_total(84000) == 4.0
    assert not xb.apply("delta", [[84000.0, 1.0]], [], 10, 9) and not xb.ok


def test_column_v2_combined_book_roundtrip():
    e = _eng()
    e.on_xmsg("okx", {"arg": {"channel": "books"}, "action": "snapshot", "data": [
        {"asks": [["84010.0", "500", "0", "1"]], "bids": [["83990.0", "1000", "0", "1"]], "seqId": 1, "prevSeqId": -1}]}, T0)
    col, _ = e.tick(T0 + 300)
    d = decode_columns(Engine.pack(col))[0]
    cb = {int(b): q for b, q in d["cb"]}
    assert abs(cb[83990] - 10.0) < 1e-4 and abs(cb[84010] - 5.0) < 1e-4
