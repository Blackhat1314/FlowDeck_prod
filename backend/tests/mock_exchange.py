"""Local mock of the Binance USDⓈ-M + Deribit public endpoints, driven by the market simulator.

Used to exercise the server's real network code (aiohttp WebSockets, REST snapshot/backfill
paging, integrity loop) without internet access:

    python tests/mock_exchange.py --port 9001
    FLOW_BINANCE_REST=http://127.0.0.1:9001 FLOW_BINANCE_WS=ws://127.0.0.1:9001 \
    FLOW_DERIBIT_URL=http://127.0.0.1:9001/deribit FLOW_MOCK_BASE=ws://127.0.0.1:9001 python run.py

The other venues (Bybit, OKX, Binance spot / COIN-M, Coinbase) are served at /x/{venue key} in their real
wire formats (from app.xsim), so the multi-exchange code paths run end to end as well.
"""
import argparse
import asyncio
import json
import os
import sys
import time

from aiohttp import WSMsgType, web

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from app.sim import MarketSim  # noqa: E402
from app.xsim import XSim  # noqa: E402

X_KEYS = ("bybit", "bybit_inv", "okx", "bn_spot", "coinbase", "bn_coinm", "bn_usdm")


class Mock:
    def __init__(self):
        now = time.time() * 1000
        self.sim = MarketSim(now_ms=now)
        self.trades = []           # every aggTrade emitted (for REST /aggTrades)
        self.book_ws = set()
        self.mkt_ws = set()
        self.drop_next_book = 0    # test hook: drop N depth updates to force a resync
        self.kline_bias = 0.0      # test hook: make the next closed candle disagree with the tape
        self.xs = XSim(self.sim)
        self.x_ws = {k: set() for k in X_KEYS}
        self.x_drop = {}           # test hook: drop N book deltas for a venue (forces a sequence gap)
        self.x_sent = {k: 0 for k in X_KEYS}

    async def run(self):
        while True:
            now = time.time() * 1000
            while self.sim.t + 100 <= now:
                msgs = self.sim.step()
                for vkey, xm in self.xs.step(msgs, self.sim.t):
                    await self.x_send(vkey, xm)
                for kind, msg in msgs:
                    if msg.get("e") == "kline" and self.kline_bias:
                        msg["k"]["v"] = f"{float(msg['k']['v']) + self.kline_bias:.3f}"
                        self.kline_bias = 0.0
                    if msg.get("e") == "aggTrade":
                        self.trades.append({k: msg[k] for k in ("a", "p", "q", "f", "l", "T", "m")})
                    if kind == "book":
                        if self.drop_next_book:
                            self.drop_next_book -= 1
                            continue
                        payload = json.dumps({"stream": "btcusdt@depth@100ms", "data": msg})
                        targets = self.book_ws
                    else:
                        payload = json.dumps({"stream": "btcusdt@" + msg["e"], "data": msg})
                        targets = self.mkt_ws
                    for ws in list(targets):
                        try:
                            await ws.send_str(payload)
                        except Exception:
                            targets.discard(ws)
            await asyncio.sleep(0.02)

    async def x_send(self, vkey, xm):
        if vkey in ("okx", "bybit") and self._is_book(vkey, xm) and self.x_drop.get(vkey):
            if xm.get("action", xm.get("type")) in ("update", "delta"):
                self.x_drop[vkey] -= 1
                return
        targets = self.x_ws.get(vkey)
        if not targets:
            return
        payload = json.dumps(xm)
        for ws in list(targets):
            try:
                await ws.send_str(payload)
                self.x_sent[vkey] += 1
            except Exception:
                targets.discard(ws)

    @staticmethod
    def _is_book(vkey, xm):
        if vkey == "okx":
            return xm.get("arg", {}).get("channel") == "books"
        return str(xm.get("topic", "")).startswith("orderbook")

    def _book_snapshot(self, vkey):
        """Full book for a client that just subscribed, consistent with the running sequence numbers."""
        pb = self.xs.prev_books.get(vkey)
        if not pb:
            return None
        bids, asks = pb
        t = int(self.sim.t)
        if vkey == "okx":
            return {"arg": {"channel": "books", "instId": "BTC-USDT-SWAP"}, "action": "snapshot",
                    "data": [{"asks": [[str(p), f"{q * 100:.2f}", "0", "1"] for p, q in asks.items()],
                              "bids": [[str(p), f"{q * 100:.2f}", "0", "1"] for p, q in bids.items()],
                              "ts": str(t), "seqId": self.xs.okx_seq, "prevSeqId": -1}]}
        return {"topic": "orderbook.1000.BTCUSDT", "type": "snapshot", "ts": t,
                "data": {"s": "BTCUSDT", "b": [[f"{p:.1f}", f"{q:.3f}"] for p, q in bids.items()],
                         "a": [[f"{p:.1f}", f"{q:.3f}"] for p, q in asks.items()], "u": self.xs.byb_u,
                         "seq": self.xs.byb_u}}

    async def x_handler(self, req):
        vkey = req.match_info["key"]
        if vkey not in self.x_ws:
            raise web.HTTPNotFound()
        ws = web.WebSocketResponse(heartbeat=None)
        await ws.prepare(req)
        if vkey in ("bn_spot", "bn_coinm", "bn_usdm"):      # Binance streams are chosen in the URL
            self.x_ws[vkey].add(ws)
        async for m in ws:
            if m.type == WSMsgType.TEXT:
                if m.data == "ping":
                    await ws.send_str("pong")
                    continue
                try:
                    d = json.loads(m.data)
                except ValueError:
                    continue
                if d.get("op") == "ping":
                    await ws.send_str(json.dumps({"op": "pong", "success": True}))
                elif d.get("op") == "subscribe" or d.get("type") == "subscribe":
                    snap = self._book_snapshot(vkey) if vkey in ("okx", "bybit") else None
                    if snap:
                        await ws.send_str(json.dumps(snap))
                    self.x_ws[vkey].add(ws)          # stream starts after the subscription (and snapshot)
            elif m.type == WSMsgType.ERROR:
                break
        self.x_ws[vkey].discard(ws)
        return ws

    async def oi_hist(self, req):
        limit = int(req.query.get("limit", 500))
        rows = self.xs.liqmap_seed_rows(self.sim.t - self.sim.t % 300_000, steps=limit)
        return web.json_response([{"symbol": "BTCUSDT", "timestamp": int(r[0]), "sumOpenInterest": f"{r[1]:.3f}",
                                   "sumOpenInterestValue": f"{r[1] * r[5]:.2f}"} for r in rows])

    async def hook_xdrop(self, req):
        self.x_drop[req.query.get("venue", "okx")] = int(req.query.get("n", 1))
        return web.json_response({"ok": True})

    async def x_stats(self, req):
        return web.json_response({k: {"clients": len(v), "sent": self.x_sent[k]} for k, v in self.x_ws.items()})

    async def ws_handler(self, req, bucket):
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(req)
        bucket.add(ws)
        async for m in ws:
            if m.type == WSMsgType.ERROR:
                break
        bucket.discard(ws)
        return ws

    async def depth(self, req):
        await asyncio.sleep(0.05)
        return web.json_response(self.sim.snapshot(int(req.query.get("limit", 1000))))

    async def klines(self, req):
        limit = int(req.query.get("limit", 500))
        t = int(self.sim.t - self.sim.t % 60000)
        if req.query.get("interval") == "5m":
            rows = self.sim.history_klines(limit * 5, t - t % 300_000)
            out = []
            for i in range(0, len(rows) - 4, 5):
                g = rows[i:i + 5]
                out.append([g[0][0], g[0][1], max(g, key=lambda r: float(r[2]))[2], min(g, key=lambda r: float(r[3]))[3], g[-1][4],
                            f"{sum(float(r[5]) for r in g):.3f}", g[-1][6], f"{sum(float(r[7]) for r in g):.2f}",
                            sum(r[8] for r in g), f"{sum(float(r[9]) for r in g):.3f}",
                            f"{sum(float(r[10]) for r in g):.2f}", "0"])
            return web.json_response(out)
        return web.json_response(self.sim.history_klines(limit, t))

    async def agg(self, req):
        limit = int(req.query.get("limit", 500))
        if "fromId" in req.query:
            fid = int(req.query["fromId"])
            rows = [x for x in self.trades if x["a"] >= fid][:limit]
        else:
            st = int(req.query.get("startTime", 0))
            rows = [x for x in self.trades if x["T"] >= st]
            if "endTime" in req.query:
                rows = [x for x in rows if x["T"] <= int(req.query["endTime"])]
            rows = rows[:limit]
        return web.json_response(rows)

    async def oi(self, req):
        return web.json_response({"symbol": "BTCUSDT", "openInterest": f"{self.sim.oi:.3f}", "time": int(self.sim.t)})

    async def time_(self, req):
        return web.json_response({"serverTime": int(time.time() * 1000) + 120})

    async def deribit(self, req):
        return web.json_response({"result": self.sim.option_chain(self.sim.t)})

    async def hook_kline(self, req):
        self.kline_bias = float(req.query.get("v", 0.5))
        return web.json_response({"ok": True})

    async def hook_drop(self, req):
        self.drop_next_book = int(req.query.get("n", 1))
        return web.json_response({"ok": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9001)
    a = ap.parse_args()
    m = Mock()
    app = web.Application()
    app.router.add_get("/public/stream", lambda r: m.ws_handler(r, m.book_ws))
    app.router.add_get("/market/stream", lambda r: m.ws_handler(r, m.mkt_ws))
    app.router.add_get("/fapi/v1/depth", m.depth)
    app.router.add_get("/fapi/v1/klines", m.klines)
    app.router.add_get("/fapi/v1/aggTrades", m.agg)
    app.router.add_get("/fapi/v1/openInterest", m.oi)
    app.router.add_get("/fapi/v1/time", m.time_)
    app.router.add_get("/deribit", m.deribit)
    app.router.add_get("/hook/drop", m.hook_drop)
    app.router.add_get("/hook/kline", m.hook_kline)
    app.router.add_get("/hook/xdrop", m.hook_xdrop)
    app.router.add_get("/x-stats", m.x_stats)
    app.router.add_get("/x/{key}", m.x_handler)
    app.router.add_get("/futures/data/openInterestHist", m.oi_hist)

    async def start(app):
        app["sim"] = asyncio.create_task(m.run())

    app.on_startup.append(start)
    web.run_app(app, host="127.0.0.1", port=a.port, print=None)


if __name__ == "__main__":
    main()
