"""Async runtime: exchange connections (aiohttp), periodic REST jobs, the engine clock and the
client broadcast hub. All engine calls happen on the single asyncio thread, so no locks are needed.
"""
from __future__ import annotations

import asyncio
import dataclasses
import logging
import os
import ssl
import time

import aiohttp
import orjson

from .engine import VENUES, Engine, Settings
from .engine.gamma import compute_gex
from .engine.xchg import XVENUES
from .sim import MarketSim
from .xsim import XSim

log = logging.getLogger("flow")


def xfeeds(primary: str):
    """WebSocket feeds of the other venues: (venue key, url, subscribe messages, ping payload)."""
    mock = os.environ.get("FLOW_MOCK_BASE", "").rstrip("/")
    other = "bn_coinm" if primary == "usdm" else "bn_usdm"
    if other == "bn_coinm":
        sec = "wss://dstream.binance.com/stream?streams=btcusd_perp@aggTrade/btcusd_perp@forceOrder/btcusd_perp@markPrice@1s"
    else:
        sec = ("wss://fstream.binance.com/market/stream?streams="
               "btcusdt@aggTrade/btcusdt@forceOrder/btcusdt@markPrice@1s")
    feeds = [
        (other, sec, [], None),
        ("bn_spot", "wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade", [], None),
        ("bybit", "wss://stream.bybit.com/v5/public/linear",
         [{"op": "subscribe", "args": ["publicTrade.BTCUSDT", "allLiquidation.BTCUSDT", "tickers.BTCUSDT",
                                       "orderbook.1000.BTCUSDT"]}], {"op": "ping"}),
        ("bybit_inv", "wss://stream.bybit.com/v5/public/inverse",
         [{"op": "subscribe", "args": ["publicTrade.BTCUSD", "allLiquidation.BTCUSD", "tickers.BTCUSD"]}],
         {"op": "ping"}),
        ("okx", "wss://ws.okx.com:8443/ws/v5/public",
         [{"op": "subscribe", "args": [{"channel": "trades", "instId": "BTC-USDT-SWAP"},
                                       {"channel": "liquidation-orders", "instType": "SWAP"},
                                       {"channel": "open-interest", "instId": "BTC-USDT-SWAP"},
                                       {"channel": "funding-rate", "instId": "BTC-USDT-SWAP"},
                                       {"channel": "books", "instId": "BTC-USDT-SWAP"}]}], "ping"),
        ("coinbase", "wss://ws-feed.exchange.coinbase.com",
         [{"type": "subscribe", "product_ids": ["BTC-USD", "USDT-USD"], "channels": ["matches", "ticker"]}], None),
    ]
    if mock:
        feeds = [(k, f"{mock}/x/{k}", subs, ping) for k, _, subs, ping in feeds]
    return feeds

DERIBIT = os.environ.get("FLOW_DERIBIT_URL",
                         "https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option")


def venue_with_overrides(v):
    """Optional endpoint overrides (testing against a mock exchange, or a regional mirror)."""
    rest = os.environ.get("FLOW_BINANCE_REST")
    ws = os.environ.get("FLOW_BINANCE_WS")
    if not rest and not ws:
        return v
    kw = {}
    if rest:
        kw["rest"] = rest.rstrip("/")
    if ws:
        base = ws.rstrip("/")
        kw["ws_book"] = base + v.ws_book[v.ws_book.index("/", 6):]
        kw["ws_market"] = base + v.ws_market[v.ws_market.index("/", 6):]
    return dataclasses.replace(v, **kw)


def now_ms() -> float:
    return time.time() * 1000.0


def _ssl_ctx():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:  # pragma: no cover
        return ssl.create_default_context()


# ============================================================================ hub
class Client:
    def __init__(self, ws, maxq=1500):
        self.ws = ws
        self.q: asyncio.Queue = asyncio.Queue(maxsize=maxq)
        self.dead = False

    def put(self, item):
        if self.dead:
            return
        try:
            self.q.put_nowait(item)
        except asyncio.QueueFull:
            self.dead = True          # slow consumer: drop; browser reconnects and re-syncs

    async def sender(self):
        try:
            while not self.dead:
                kind, data = await self.q.get()
                if kind == "t":
                    await self.ws.send_text(data)
                elif kind == "b":
                    await self.ws.send_bytes(data)
                else:   # close: code or (code, reason)
                    code, reason = data if isinstance(data, tuple) else (data, None)
                    await self.ws.close(code=code, reason=reason)
                    return
        except Exception:
            pass
        finally:
            self.dead = True
            try:
                await self.ws.close()
            except Exception:
                pass


class Hub:
    def __init__(self):
        self.clients: set = set()

    def add(self, c: Client):
        self.clients.add(c)

    def remove(self, c: Client):
        self.clients.discard(c)

    def json(self, obj):
        if not self.clients:
            return
        data = orjson.dumps(obj).decode()
        for c in list(self.clients):
            c.put(("t", data))

    def binary(self, data: bytes):
        for c in list(self.clients):
            c.put(("b", data))

    def close_all(self, code=4000):
        for c in list(self.clients):
            c.put(("c", code))


# ============================================================================ runtime
class Runtime:
    def __init__(self, venue: str = "usdm", demo: bool = False, settings: Settings | None = None):
        self.venue_key = venue
        self.demo = demo
        self.settings = settings or Settings()
        self.hub = Hub()
        self.engine = Engine(venue_with_overrides(VENUES[venue]), self.settings)
        self.tasks: list = []
        self.session: aiohttp.ClientSession | None = None
        self.status = {"book_ws": "idle", "market_ws": "idle", "deribit": "idle", "backfill": "idle"}
        self.sim = None

    # ------------------------------------------------------------------ lifecycle
    async def start(self):
        self.session = aiohttp.ClientSession(
            trust_env=True,
            connector=aiohttp.TCPConnector(ssl=_ssl_ctx(), limit=16),
            timeout=aiohttp.ClientTimeout(total=None, sock_connect=15),
            json_serialize=lambda o: orjson.dumps(o).decode(),
        )
        self.ready = asyncio.Event()
        if self.demo:
            self.tasks = [asyncio.create_task(self._demo())]
        else:
            v = self.engine.v
            self.tasks = [
                asyncio.create_task(self._ws_loop("book_ws", v.ws_book, self._on_book_msg, self.engine.book.force_resync)),
                asyncio.create_task(self._ws_loop("market_ws", v.ws_market, self._on_market_msg, None)),
                asyncio.create_task(self._snapshot_loop()),
                asyncio.create_task(self._integrity_loop()),
                asyncio.create_task(self._oi_loop()),
                asyncio.create_task(self._deribit_loop()),
                asyncio.create_task(self._clock_sync_loop()),
                asyncio.create_task(self._backfill()),
                asyncio.create_task(self._secondary_oi_loop()),
                asyncio.create_task(self._seed_liqmap()),
            ]
            for vkey, url, subs, ping in xfeeds(self.venue_key):
                self.status[vkey] = "idle"
                self.tasks.append(asyncio.create_task(self._xws_loop(vkey, url, subs, ping)))
            self.ready.set()
        self.tasks.append(asyncio.create_task(self._clock()))
        log.info("runtime started: %s%s", self.engine.v.label, " (demo)" if self.demo else "")

    async def stop(self):
        for t in self.tasks:
            t.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []
        if self.session:
            await self.session.close()
            self.session = None

    async def switch(self, venue: str):
        if venue not in VENUES or (venue == self.venue_key and not self.demo):
            return False
        await self.stop()
        self.venue_key = venue
        self.engine = Engine(venue_with_overrides(VENUES[venue]), self.settings)
        self.status = {k: "idle" for k in self.status}
        await self.start()
        self.hub.close_all(4000)
        return True

    # ------------------------------------------------------------------ clock
    async def _clock(self):
        eng = self.engine
        await self.ready.wait()
        while True:
            try:
                col, upd = eng.tick(now_ms())
                if col is not None:
                    self.hub.binary(Engine.pack(col))
                if upd is not None:
                    upd["type"] = "u"
                    if "health" in upd:
                        upd["health"]["feeds"] = self.status
                        upd["health"].update(self.tape_summary())
                    for r in upd.get("kchk", ()):
                        if r.get("status") == "ok" and not (r["vol_ok"] and r["buy_ok"]) and not self.demo:
                            asyncio.create_task(self._verify_tape(r))
                    self.hub.json(upd)
            except Exception:
                log.exception("tick failed")
            await asyncio.sleep(0.05)

    # ------------------------------------------------------------------ tape arbitration
    def tape_summary(self):
        ks = [k for k in self.engine.integ.klines if k.get("status") == "ok"]
        exact = sum(1 for k in ks if (k["vol_ok"] and k["buy_ok"]) or k.get("tape_ok"))
        return {"tape_checked": len(ks), "tape_exact": exact,
                "tape_arbitrated": sum(1 for k in ks if "tape_ok" in k)}

    async def _verify_tape(self, r):
        """Binance's 1m candle occasionally disagrees with its own public trade tape (a few trades are
        left out of one or the other). When engine != candle, fetch that minute's aggTrades and
        compare the engine bar with the tape itself."""
        v = self.engine.v
        t0 = int(r["t"])
        try:
            await asyncio.sleep(2)
            trades = []
            page = await self._get(v.rest + v.p_agg, symbol=v.symbol, startTime=t0, endTime=t0 + 59_999, limit=1000)
            for _ in range(60):
                trades.extend(page)
                if len(page) < 1000:
                    break
                await asyncio.sleep(0.5)
                page = await self._get(v.rest + v.p_agg, symbol=v.symbol, fromId=page[-1]["a"] + 1, limit=1000)
                page = [x for x in page if int(x["T"]) <= t0 + 59_999]
            qs = v.qty_scale
            tv = sum(int(round(float(x["q"]) * qs)) for x in trades)
            tb = sum(int(round(float(x["q"]) * qs)) for x in trades if not x["m"])
            b = self.engine.flow.bars.get(t0)
            r["tape_v"] = tv / qs
            r["tape_bv"] = tb / qs
            r["tape_ok"] = bool(b is not None and b.rv == tv and b.rbv == tb)
            self.hub.json({"type": "u", "kchk_fix": [r]})
            log.info("minute %s: engine %s tape %s candle %s -> %s", t0, r["vol_e"], tv / qs, r["vol_k"],
                     "engine = tape" if r["tape_ok"] else "MISMATCH")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("tape check failed: %s", e)

    # ------------------------------------------------------------------ websockets
    async def _ws_loop(self, name, url, handler, on_drop):
        backoff = 1.0
        while True:
            try:
                self.status[name] = "connecting"
                async with self.session.ws_connect(url, heartbeat=30, max_msg_size=0) as ws:
                    self.status[name] = "live"
                    backoff = 1.0
                    log.info("%s connected", name)
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            recv = now_ms()
                            d = orjson.loads(msg.data)
                            handler(d.get("data", d), recv)
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("%s error: %s", name, e)
            self.status[name] = "reconnecting"
            if on_drop:
                on_drop()
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def _xws_loop(self, vkey, url, subs, ping):
        """Other venues: subscribe, keep alive with the venue's ping, feed the engine."""
        backoff = 1.0
        eng_key = vkey
        while True:
            pinger = None
            try:
                self.status[eng_key] = "connecting"
                async with self.session.ws_connect(url, heartbeat=None if ping else 30, max_msg_size=0) as ws:
                    for s in subs:
                        await ws.send_str(orjson.dumps(s).decode())
                    self.status[eng_key] = "live"
                    backoff = 1.0
                    log.info("%s connected", vkey)

                    async def keepalive():
                        while True:
                            await asyncio.sleep(20)
                            await ws.send_str(ping if isinstance(ping, str) else orjson.dumps(ping).decode())

                    if ping:
                        pinger = asyncio.create_task(keepalive())
                    async for msg in ws:
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            if msg.data == "pong":
                                continue
                            recv = now_ms()
                            try:
                                d = orjson.loads(msg.data)
                            except Exception:
                                continue
                            self.engine.on_xmsg(vkey, d, recv)
                            if vkey in self.engine.resubscribe:
                                self.engine.resubscribe.discard(vkey)
                                log.info("%s book sequence gap: resubscribing", vkey)
                                break
                        elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                            break
            except asyncio.CancelledError:
                if pinger:
                    pinger.cancel()
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("%s error: %s", vkey, e)
            if pinger:
                pinger.cancel()
            self.status[eng_key] = "reconnecting"
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    def _on_book_msg(self, d, recv):
        self.engine.on_message(d, recv)

    def _on_market_msg(self, d, recv):
        self.engine.on_message(d, recv)

    async def _get(self, url, **params):
        async with self.session.get(url, params=params or None, timeout=aiohttp.ClientTimeout(total=15)) as r:
            r.raise_for_status()
            return await r.json(loads=orjson.loads, content_type=None)

    # ------------------------------------------------------------------ REST jobs
    async def _snapshot_loop(self):
        v = self.engine.v
        fails = 0
        while True:
            book = self.engine.book
            if book.needs_snapshot and len(book.buffer) > 0:
                try:
                    snap = await self._get(v.rest + v.p_depth, symbol=v.symbol, limit=1000)
                    ok = self.engine.on_snapshot(snap)
                    if ok:
                        fails = 0
                        log.info("order book synced at update id %s", snap["lastUpdateId"])
                    else:
                        fails += 1
                except asyncio.CancelledError:
                    raise
                except Exception as e:  # noqa: BLE001
                    fails += 1
                    log.warning("snapshot failed: %s", e)
                await asyncio.sleep(min(0.5 * (2 ** min(fails, 4)), 8) if fails else 0.3)
            else:
                await asyncio.sleep(0.1)

    async def _integrity_loop(self):
        """Independent snapshot every 30 s: grade the local book and repair unseen far levels."""
        v = self.engine.v
        await asyncio.sleep(8)
        while True:
            try:
                if self.engine.book.synced:
                    snap = await self._get(v.rest + v.p_depth, symbol=v.symbol, limit=1000)
                    for _ in range(100):
                        res = self.engine.on_check_snapshot(snap)
                        if res is not None:
                            break
                        await asyncio.sleep(0.05)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("integrity snapshot failed: %s", e)
            await asyncio.sleep(30)

    async def _clock_sync_loop(self):
        """Estimate exchange-clock minus local-clock so feed latency is measured correctly."""
        v = self.engine.v
        path = v.p_depth.replace("depth", "time")
        while True:
            try:
                best = None
                for _ in range(5):
                    t0 = now_ms()
                    r = await self._get(v.rest + path)
                    t1 = now_ms()
                    if best is None or t1 - t0 < best[0]:
                        best = (t1 - t0, r["serverTime"] - (t0 + t1) / 2)
                    await asyncio.sleep(0.2)
                self.engine.integ.clock_offset = best[1]
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("clock sync failed: %s", e)
            await asyncio.sleep(300)

    async def _oi_loop(self):
        """Primary open interest every 3 s (weight 1): feeds OI change per bar and the liquidation map."""
        v = self.engine.v
        while True:
            try:
                r = await self._get(v.rest + v.p_oi, symbol=v.symbol)
                self.engine.on_open_interest(float(r["openInterest"]), now_ms())
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.warning("open interest failed: %s", e)
            await asyncio.sleep(3)

    async def _secondary_oi_loop(self):
        """Open interest of the other Binance BTC perp (USDⓈ-M <-> COIN-M) every 5 s."""
        other = VENUES["coinm" if self.venue_key == "usdm" else "usdm"]
        other = venue_with_overrides(other)
        vkey = "bn_coinm" if other.key == "coinm" else "bn_usdm"
        while True:
            try:
                r = await self._get(other.rest + other.p_oi, symbol=other.symbol)
                self.engine.on_secondary_oi(vkey, float(r["openInterest"]), now_ms())
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                log.debug("secondary open interest failed: %s", e)
            await asyncio.sleep(5)

    async def _seed_liqmap(self):
        """Seed the liquidation-level model with ~41 h of 5-minute OI history + candles."""
        v = self.engine.v
        try:
            if v.inverse:
                oi = await self._get(v.rest + "/futures/data/openInterestHist", pair="BTCUSD",
                                     contractType="PERPETUAL", period="5m", limit=500)
                kl = await self._get(v.rest + v.p_klines, symbol=v.symbol, interval="5m", limit=500)
                kmap = {int(r[0]): (float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[7]), float(r[10]))
                        for r in kl}
                pts = [(int(x["timestamp"]), float(x["sumOpenInterestValue"])) for x in oi]
            else:
                oi = await self._get(v.rest + "/futures/data/openInterestHist", symbol=v.symbol, period="5m", limit=500)
                kl = await self._get(v.rest + v.p_klines, symbol=v.symbol, interval="5m", limit=500)
                kmap = {int(r[0]): (float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5]), float(r[9]))
                        for r in kl}
                pts = [(int(x["timestamp"]), float(x["sumOpenInterest"])) for x in oi]
            rows = []
            for ts, val in sorted(pts):
                k = kmap.get(ts - 300_000) or kmap.get(ts)
                if k:
                    o, h, l, c, vol, tb = k
                    rows.append((ts, val, o, h, l, c, vol, tb))
            self.engine.seed_liqmap(rows)
            log.info("liquidation map seeded with %d five-minute steps", len(rows))
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.warning("liquidation map seed failed: %s", e)

    async def _deribit_loop(self):
        while True:
            try:
                self.status["deribit"] = "loading"
                r = await self._get(DERIBIT)
                rows = r["result"]
                g = await asyncio.to_thread(compute_gex, rows, now_ms())
                self.engine.set_gex(g)
                self.status["deribit"] = "live"
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                self.status["deribit"] = "error"
                log.warning("deribit failed: %s", e)
            await asyncio.sleep(60)

    async def _backfill(self, max_pages=60):
        """24h of 1m klines (candles + exact delta) plus up to max_pages*1000 aggTrades of tick history
        ending exactly where the live stream starts. Paced at ~1 request/s (20 weight each) so it stays
        well under Binance's 2400 weight/minute limit even in busy markets."""
        v = self.engine.v
        eng = self.engine
        self.status["backfill"] = "waiting"
        for _ in range(300):
            if eng.flow.first_live_a is not None:
                break
            await asyncio.sleep(0.1)
        a0 = eng.flow.first_live_a
        try:
            trades = []
            start_min = None
            if a0 is not None:
                self.status["backfill"] = "ticks"
                frm = max(0, a0 - max_pages * 1000)
                for i in range(max_pages + 1):
                    page = await self._get(v.rest + v.p_agg, symbol=v.symbol, fromId=frm, limit=1000)
                    if not page:
                        break
                    if start_min is None:
                        T = int(page[0]["T"])
                        start_min = T - T % 60_000 + 60_000        # first complete minute
                    done = False
                    for t in page:
                        if t["a"] >= a0:
                            done = True
                            break
                        if int(t["T"]) >= start_min:
                            trades.append(t)
                    if done or len(page) < 1000:
                        break
                    frm = page[-1]["a"] + 1
                    await asyncio.sleep(1.0)
            if start_min is None:
                now = now_ms()
                start_min = int(now - now % 60_000)
            self.status["backfill"] = "klines"
            rows = []
            end = None
            for _ in range(7):                       # 7 days of 1m candles for multi-day profiles / levels
                kw = {"symbol": v.symbol, "interval": "1m", "limit": 1500}
                if end is not None:
                    kw["endTime"] = end
                page = await self._get(v.rest + v.p_klines, **kw)
                if not page:
                    break
                rows = page + rows
                end = int(page[0][0]) - 1
                if len(rows) >= self.settings.bars_keep:
                    break
                await asyncio.sleep(0.5)
            eng.backfill_klines(rows, start_min)
            if a0 is not None:
                eng.backfill_trades(trades, start_min)
            self.status["backfill"] = "done"
            log.info("backfill: %d kline bars, %d aggTrades from %s", len(rows), len(trades),
                     time.strftime("%H:%M", time.gmtime(start_min / 1000)))
            tape = sorted(list(eng.flow.sweeps)[-800:] + list(eng.xflow.tape)[-1200:], key=lambda j: j["lt"])
            self.hub.json({"type": "bars", "bars": eng.flow.bars_json(), "sweeps": tape})
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            self.status["backfill"] = "error"
            log.warning("backfill failed: %s", e)

    # ------------------------------------------------------------------ demo
    async def _demo(self):
        eng = self.engine
        t_now = now_ms()
        pre = int(float(os.environ.get("FLOW_DEMO_WARMUP_MIN", "20")) * 60_000)
        sim = self.sim = MarketSim(now_ms=t_now - pre)
        xs = XSim(sim)
        m0 = sim.t - sim.t % 60_000
        eng.backfill_klines(sim.history_klines(7 * 24 * 60, m0), m0)
        eng.seed_liqmap(xs.liqmap_seed_rows(sim.t))
        first = True
        for k in ("book_ws", "market_ws", "deribit", "backfill", "bybit", "bybit_inv", "okx", "bn_spot", "coinbase",
                  "bn_coinm"):
            self.status[k] = "demo"
        eng.backfill_state = "done"
        eng.flow.coverage_from = int(m0 + 60_000)
        state = {"check": 0, "gex": 0, "oi": 0}

        def step_once(gex_sync=True):
            msgs = sim.step()
            t = sim.t + 25
            for kind, msg in msgs:
                eng.on_message(msg, t)
            for vkey, xm in xs.step(msgs, sim.t):
                eng.on_xmsg(vkey, xm, t)
            if sim.t >= state["oi"]:
                eng.on_open_interest(sim.oi, t)
                eng.on_secondary_oi("bn_coinm", xs.oi_secondary(), t)
                state["oi"] = sim.t + 3000
            if sim.t >= state["check"] and eng.book.synced:
                eng.on_check_snapshot(sim.snapshot())
                state["check"] = sim.t + 30_000

        # fast-forward 20 minutes of synthetic history so the screen is populated
        while sim.t < t_now:
            step_once()
            if first:
                eng.on_snapshot(sim.snapshot())
                first = False
            if sim.t >= state["gex"]:
                eng.set_gex(compute_gex(sim.option_chain(sim.t), sim.t))
                state["gex"] = sim.t + 60_000
            eng.tick(sim.t + 25)
            if sim.t % 5000 < 100:
                await asyncio.sleep(0)
        eng.flow.coverage_from = eng.flow.coverage_from or (t_now - pre)
        sim.t = max(sim.t, now_ms() - 100)      # skip the time spent fast-forwarding (no catch-up burst)
        self.ready.set()
        while True:
            t = now_ms()
            while sim.t + 100 <= t:
                step_once()
            if sim.t >= state["gex"]:
                g = await asyncio.to_thread(compute_gex, sim.option_chain(sim.t), sim.t)
                eng.set_gex(g)
                state["gex"] = sim.t + 60_000
            await asyncio.sleep(0.05)
