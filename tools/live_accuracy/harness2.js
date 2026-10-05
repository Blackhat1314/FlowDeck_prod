// Phase 2 live harness: every venue the server uses, graded against each exchange's own REST data.
// 1) python tools/live_accuracy/make_bundle.py --phase2   2) on https://example.com paste bundle2.js, then this file.
// Then after 15+ minutes: T2.summary()
(async () => {
  const T = (window.T2 = { started: Date.now(), log: [], errors: [], candles: {}, trades: {}, books: [], oi: [], micro: [],
    premium: [], okxLiq: [], xstart: {} })
  const log = (m) => { T.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (T.log.length > 300) T.log.shift() }
  const err = (m) => { if (T.errors.length < 200) T.errors.push(`${new Date().toISOString().slice(11, 19)} ${m}`) }
  try {
    const { loadPyodide } = await import('https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs')
    const py = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/' })
    for (const [path, src] of Object.entries(window.__ENGINE_SRC)) {
      py.FS.mkdirTree('/home/pyodide/' + path.split('/').slice(0, -1).join('/'))
      py.FS.writeFile('/home/pyodide/' + path, src)
    }
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide')")
    py.runPython(window.__HARNESS2_PY)
    const P = (n) => py.globals.get(n)
    const feed = P('feed'), feedX = P('feed_x'), feedK = P('feed_kline'), tick = P('tick'), snap = P('snapshot')
    const check = P('check'), needSnap = P('needs_snapshot'), synced = P('synced'), setOff = P('set_offset')
    const report = P('report'), minute = P('minute'), bnK = P('binance_klines'), trCheck = P('trades_check')
    const trCheckG = P('trades_check_grouped'), bkCheck = P('book_check'), vstate = P('venue_state'), liqs = P('liqs'), mmark = P('micro_mark')
    T.report = () => JSON.parse(report())
    T.vstate = () => JSON.parse(vstate())
    T.binanceKlines = () => JSON.parse(bnK())

    // ---------------------------------------------------------------- Binance WS APIs (no CORS needed)
    const wsApi = (url) => {
      const o = { ws: null, rid: 0, pend: {} }
      o.open = () => new Promise((res) => {
        o.ws = new WebSocket(url)
        o.ws.onopen = () => res()
        o.ws.onmessage = (e) => { const d = JSON.parse(e.data); if (o.pend[d.id]) { o.pend[d.id](e.data); delete o.pend[d.id] } }
        o.ws.onclose = () => { log('api closed ' + url); setTimeout(o.open, 1000) }
      })
      o.req = (method, params) => new Promise((res) => { const id = String(++o.rid); o.pend[id] = res; o.ws.send(JSON.stringify({ id, method, params: params || {} })) })
      return o
    }
    const fapi = wsApi('wss://ws-fapi.binance.com/ws-fapi/v1')
    const sapi = wsApi('wss://ws-api.binance.com:443/ws-api/v3')
    await fapi.open()
    await sapi.open()
    const syncClock = async () => {
      let best = null
      for (let i = 0; i < 6; i++) {
        const t0 = Date.now(); const raw = await fapi.req('time'); const t1 = Date.now()
        const st = JSON.parse(raw).result.serverTime
        if (!best || t1 - t0 < best[0]) best = [t1 - t0, st - (t0 + t1) / 2]
      }
      setOff(best[1])
    }
    await syncClock()
    setInterval(syncClock, 300000)

    // ---------------------------------------------------------------- engine clock + Binance book upkeep
    let lastTick = 0, lastCheck = Date.now(), pendingCheck = null, snapping = false, checking = false
    const maint = (now) => {
      if (now - lastTick >= 100) { lastTick = now; tick(now) }
      if (!snapping && needSnap()) {
        snapping = true
        fapi.req('depth', { symbol: 'BTCUSDT', limit: 1000 }).then((raw) => { snap(raw); snapping = false })
      }
      if (synced() && !checking && now - lastCheck > 30000) {
        checking = true; lastCheck = now
        fapi.req('depth', { symbol: 'BTCUSDT', limit: 1000 }).then((raw) => { pendingCheck = raw })
      }
      if (pendingCheck) {
        const r = check(pendingCheck)
        if (r !== '') { pendingCheck = null; checking = false; T.books.push({ venue: 'BIN', ...JSON.parse(r) }) }
      }
    }
    const stream = (url, name, fn, subs, ping) => {
      const ws = new WebSocket(url)
      let pinger = null
      ws.onopen = () => {
        for (const s of subs || []) ws.send(JSON.stringify(s))
        if (ping) pinger = setInterval(() => ws.send(typeof ping === 'string' ? ping : JSON.stringify(ping)), 20000)
        if (!T.xstart[name]) T.xstart[name] = Date.now()
        log(name + ' open')
      }
      ws.onmessage = (e) => {
        if (e.data === 'pong') return
        try {
          const now = Date.now()
          if (fn(e.data, now) === 1) { log(name + ' sequence gap -> resubscribe'); ws.close() }
          maint(now)
        } catch (x) { err(name + ' ' + String(x).slice(0, 300)) }
      }
      ws.onclose = () => { if (pinger) clearInterval(pinger); log(name + ' closed, reconnecting'); setTimeout(() => stream(url, name, fn, subs, ping), 1000) }
    }
    stream('wss://fstream.binance.com/public/stream?streams=btcusdt@depth@100ms', 'book', feed)
    stream('wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@markPrice@1s/btcusdt@forceOrder/btcusdt@kline_1m/btcusdt@ticker', 'market', feed)
    // other venues: exactly the URLs / subscriptions of backend/app/runtime.py xfeeds()
    const X = (k) => (raw, now) => feedX(k, raw, now)
    stream('wss://dstream.binance.com/stream?streams=btcusd_perp@aggTrade/btcusd_perp@forceOrder/btcusd_perp@markPrice@1s', 'bn_coinm', X('bn_coinm'))
    stream('wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade', 'bn_spot', X('bn_spot'))
    stream('wss://stream.bybit.com/v5/public/linear', 'bybit', X('bybit'),
      [{ op: 'subscribe', args: ['publicTrade.BTCUSDT', 'allLiquidation.BTCUSDT', 'tickers.BTCUSDT', 'orderbook.1000.BTCUSDT'] }], { op: 'ping' })
    stream('wss://stream.bybit.com/v5/public/inverse', 'bybit_inv', X('bybit_inv'),
      [{ op: 'subscribe', args: ['publicTrade.BTCUSD', 'allLiquidation.BTCUSD', 'tickers.BTCUSD'] }], { op: 'ping' })
    stream('wss://ws.okx.com:8443/ws/v5/public', 'okx', X('okx'),
      [{ op: 'subscribe', args: [{ channel: 'trades', instId: 'BTC-USDT-SWAP' }, { channel: 'liquidation-orders', instType: 'SWAP' },
        { channel: 'open-interest', instId: 'BTC-USDT-SWAP' }, { channel: 'funding-rate', instId: 'BTC-USDT-SWAP' },
        { channel: 'books', instId: 'BTC-USDT-SWAP' }] }], 'ping')
    stream('wss://ws-feed.exchange.coinbase.com', 'coinbase', X('coinbase'),
      [{ type: 'subscribe', product_ids: ['BTC-USD', 'USDT-USD'], channels: ['matches', 'ticker'] }])
    // the exchanges' own 1-minute candles for spot and COIN-M (graders only, not used by the engine)
    stream('wss://stream.binance.com:9443/stream?streams=btcusdt@kline_1m', 'k_spot', (raw) => feedK('bn_spot', raw))
    stream('wss://dstream.binance.com/stream?streams=btcusd_perp@kline_1m', 'k_coinm', (raw) => feedK('bn_coinm', raw))

    // ---------------------------------------------------------------- graders (REST of each venue, CORS-enabled)
    const J = async (u) => (await fetch(u)).json()
    const eng = (vkey, m) => JSON.parse(minute(vkey, m))
    const candleCheck = async () => {
      const now = Date.now()
      const m = now - (now % 60000) - 120000
      const rows = []
      try {
        const bl = await J(`https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&start=${m}&end=${m}`)
        const bi = await J(`https://api.bybit.com/v5/market/kline?category=inverse&symbol=BTCUSD&interval=1&start=${m}&end=${m}`)
        const ok = await J(`https://www.okx.com/api/v5/market/candles?instId=BTC-USDT-SWAP&bar=1m&after=${m + 60000}&limit=2`)
        const iso = (t) => new Date(t).toISOString()
        const cb = await J(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${iso(m)}&end=${iso(m + 60000)}`)
        const pick = (list, f) => (list || []).find(f)
        const r1 = pick(bl.result?.list, (r) => +r[0] === m)
        const r2 = pick(bi.result?.list, (r) => +r[0] === m)
        const r3 = pick(ok.data, (r) => +r[0] === m)
        const r4 = pick(cb, (r) => r[0] * 1000 === m)
        if (r1) rows.push(['bybit', +r1[5], eng('bybit', m)])
        if (r2) rows.push(['bybit_inv', +r2[6], eng('bybit_inv', m)])          // inverse: turnover is BTC
        if (r3) rows.push(['okx', +r3[6], eng('okx', m), r3[8]])               // volCcy (BTC), confirm flag
        if (r4) rows.push(['coinbase', +r4[5], eng('coinbase', m)])
        for (const [v, exch, e, conf] of rows) {
          if (!e || m < (T.xstart[v] || Infinity) + 60000) continue
          ;(T.candles[v] = T.candles[v] || []).push({ t: m, exch, eng: e[0], n: e[2], diff: e[0] - exch, rel: exch ? (e[0] - exch) / exch : null, conf })
        }
      } catch (x) { err('candles ' + String(x).slice(0, 200)) }
    }
    const tradesCheck = async () => {
      const now = Date.now()
      const jobs = [
        ['bybit', 'https://api.bybit.com/v5/market/recent-trade?category=linear&symbol=BTCUSDT&limit=1000',
          (d) => d.result.list.map((x) => [x.execId, +x.time, +x.price, +x.size, x.side === 'Buy' ? 1 : -1])],
        ['bybit_inv', 'https://api.bybit.com/v5/market/recent-trade?category=inverse&symbol=BTCUSD&limit=1000',
          (d) => d.result.list.map((x) => [x.execId, +x.time, +x.price, +x.size / +x.price, x.side === 'Buy' ? 1 : -1])],
        ['okx', 'https://www.okx.com/api/v5/market/trades?instId=BTC-USDT-SWAP&limit=500',
          (d) => d.data.map((x) => [x.tradeId, +x.ts, +x.px, +x.sz * 0.01, x.side === 'buy' ? 1 : -1])],
        // Coinbase reports the maker side; the aggressor is the other side
        ['coinbase', 'https://api.exchange.coinbase.com/products/BTC-USD/trades?limit=1000',
          (d) => d.map((x) => [x.trade_id, Date.parse(x.time), +x.price, +x.size, x.side === 'buy' ? -1 : 1])],
      ]
      for (const [v, url, parse] of jobs) {
        try {
          const rows = parse(await J(url))
          const tFrom = (T.xstart[v] || now) + 5000
          // OKX's trades channel merges the fills of one taker order at one price: compare grouped volumes
          const res = JSON.parse((v === 'okx' ? trCheckG : trCheck)(v, JSON.stringify(rows), tFrom, now - 4000))
          if (res.rest) (T.trades[v] = T.trades[v] || []).push({ t: now, ...res })
        } catch (x) { err('trades ' + v + ' ' + String(x).slice(0, 200)) }
      }
    }
    const bookCheck = async () => {
      try {
        const b = await J('https://api.bybit.com/v5/market/orderbook?category=linear&symbol=BTCUSDT&limit=200')
        const r1 = JSON.parse(bkCheck('bybit', JSON.stringify(b.result.b.map(([p, q]) => [+p, +q])), JSON.stringify(b.result.a.map(([p, q]) => [+p, +q])), 200))
        T.books.push({ t: Date.now(), rest_u: b.result.u, ...r1 })
        const o = await J('https://www.okx.com/api/v5/market/books?instId=BTC-USDT-SWAP&sz=400')
        const d = o.data[0]
        const r2 = JSON.parse(bkCheck('okx', JSON.stringify(d.bids.map((r) => [+r[0], +r[1] * 0.01])), JSON.stringify(d.asks.map((r) => [+r[0], +r[1] * 0.01])), 200))
        T.books.push({ t: Date.now(), rest_ts: +d.ts, ...r2 })
      } catch (x) { err('books ' + String(x).slice(0, 200)) }
    }
    const oiCheck = async () => {
      try {
        const st = T.vstate()
        const bl = (await J('https://api.bybit.com/v5/market/tickers?category=linear&symbol=BTCUSDT')).result.list[0]
        const bi = (await J('https://api.bybit.com/v5/market/tickers?category=inverse&symbol=BTCUSD')).result.list[0]
        const oo = (await J('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP')).data[0]
        const of = (await J('https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP')).data[0]
        T.oi.push({ t: Date.now(),
          // Bybit reports single-counted OI since 11 Jun 2026 (singleOpenInterest); openInterest is still two-sided
          bybit: { eng: st.bybit.oi, rest: +bl.singleOpenInterest, fund_eng: st.bybit.fund, fund_rest: +bl.fundingRate },
          bybit_inv: { eng: st.bybit_inv.oi, rest: +bi.singleOpenInterestValue, fund_eng: st.bybit_inv.fund, fund_rest: +bi.fundingRate },
          okx: { eng: st.okx.oi, rest: +oo.oiCcy, fund_eng: st.okx.fund, fund_rest: +of.fundingRate },
        })
        // Coinbase premium: independent prices at the same moment
        const cb = await J('https://api.exchange.coinbase.com/products/BTC-USD/ticker')
        const ut = await J('https://api.exchange.coinbase.com/products/USDT-USD/ticker')
        const sp = JSON.parse(await sapi.req('ticker.price', { symbol: 'BTCUSDT' })).result
        const rep = T.report()
        T.premium.push({ t: Date.now(), eng: rep.flow.premium, indep: +cb.price - +sp.price * +ut.price, usdt_eng: rep.flow.usdt, usdt_rest: +ut.price })
        T.micro.push(JSON.parse(mmark()))
      } catch (x) { err('oi ' + String(x).slice(0, 200)) }
    }
    const okxLiqCheck = async () => {
      try {
        const d = await J('https://www.okx.com/api/v5/public/liquidation-orders?instType=SWAP&instFamily=BTC-USDT&state=filled&limit=100')
        const rest = []
        for (const x of d.data || []) if (x.instId === 'BTC-USDT-SWAP') for (const r of x.details) rest.push([+r.ts, r.posSide, +r.bkPx, +r.sz * 0.01])
        const mine = JSON.parse(liqs()).filter((l) => l[0] === 4)
        const t0 = T.xstart.okx + 5000
        const inWin = rest.filter((r) => r[0] >= t0 && r[0] <= Date.now() - 5000)
        let found = 0
        const miss = []
        for (const r of inWin) {
          const m = mine.find((l) => Math.abs(l[1] - r[0]) < 1500 && Math.abs(l[3] - r[2]) < 0.05 && Math.abs(l[4] - r[3]) < 1e-9 && l[2] === r[1])
          if (m) found++; else if (miss.length < 5) miss.push(r)
        }
        T.okxLiq.push({ t: Date.now(), rest: inWin.length, found, miss, engine_okx: mine.length })
      } catch (x) { err('okxliq ' + String(x).slice(0, 200)) }
    }
    const every = (ms, f, first) => { setTimeout(() => { f(); setInterval(f, ms) }, first) }
    const toMinute = (off) => (60000 - (Date.now() % 60000) + off) % 60000
    every(60000, candleCheck, toMinute(25000))
    every(60000, tradesCheck, 90000)
    every(30000, bookCheck, 45000)
    every(60000, oiCheck, 40000)
    every(300000, okxLiqCheck, 240000)

    T.summary = () => {
      const s = {}
      for (const [v, rows] of Object.entries(T.candles)) {
        const exact = rows.filter((r) => Math.abs(r.diff) < 1e-6 * Math.max(1, r.exch)).length
        s['candle_' + v] = { minutes: rows.length, exact, max_abs_rel: Math.max(0, ...rows.map((r) => Math.abs(r.rel || 0))), last: rows.slice(-3) }
      }
      for (const [v, rows] of Object.entries(T.trades)) {
        const a = rows.reduce((o, r) => ({ rest: o.rest + r.rest, found: o.found + r.found, price: o.price + r.price_ok, size: o.size + r.size_ok, side: o.side + r.side_ok }), { rest: 0, found: 0, price: 0, size: 0, side: 0 })
        s['trades_' + v] = { checks: rows.length, ...a, bad: rows.flatMap((r) => r.bad).slice(0, 4) }
      }
      const bk = {}
      for (const b of T.books) {
        const k = b.venue
        const o = (bk[k] = bk[k] || { checks: 0, levels: 0, match: 0, missing: 0, qty_diff: 0, crossed: 0 })
        o.checks++
        o.levels += b.levels || 0
        o.match += b.match || 0
        o.missing += b.missing || 0
        o.qty_diff += b.qty_diff || 0
        if (b.best && b.best[0] >= b.best[1]) o.crossed++
      }
      s.books = bk
      s.binance_klines = Object.fromEntries(Object.entries(T.binanceKlines()).map(([k, rows]) => [k, {
        minutes: rows.length, vol_exact: rows.filter((r) => Math.abs(r.dv) < 1e-6).length,
        buy_exact: rows.filter((r) => Math.abs(r.db) < 1e-6).length, n_eq: rows.filter((r) => r.eng_n === r.exch_n).length, last: rows.slice(-2) }]))
      s.oi = T.oi.slice(-3)
      s.premium = T.premium.slice(-5)
      if (T.micro.length > 1) {
        const a = T.micro[0], b = T.micro[T.micro.length - 1]
        s.micro = { minutes: Math.round((b.t - a.t) / 60000), filled: b.filled - a.filled, hidden: b.hidden - a.hidden, tape: b.tape - a.tape,
          cancelled: b.cancelled - a.cancelled, added: b.added - a.added, ratio: ((b.filled - a.filled) + (b.hidden - a.hidden)) / (b.tape - a.tape) }
      }
      s.okxLiq = T.okxLiq.slice(-2)
      const r = T.report()
      s.engine = { uptime_s: r.uptime_s, msgs: r.msgs, xmsgs: r.xmsgs, avg_ms: r.avg_ms, max_ms: r.max_ms, errors: r.errors, resubs: r.resubs,
        xbooks: r.xbooks, liqs: r.liqs, micro_events: r.micro_events, regime: r.flow.regime.label, events: r.events.length, kline: r.kline }
      s.harness_errors = T.errors.slice(-5)
      return s
    }
    log('harness2 running')
  } catch (x) {
    err('fatal ' + String(x).slice(0, 800))
  }
})()
