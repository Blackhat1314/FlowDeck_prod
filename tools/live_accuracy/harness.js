// Live accuracy harness (the exact script used for ACCURACY.md).
// 1) python tools/live_accuracy/make_bundle.py   2) on https://example.com paste bundle.js, then this file.
// Runs the unmodified backend engine in Pyodide on the live Binance + Deribit feeds and grades it against
// Binance's candles, order-book snapshots and trade-id continuity, and Deribit's published greeks.
(async () => {
  const T = (window.T = { started: Date.now(), log: [], errors: [], gex: [], greeks: null, books: [], offsets: [], minutes: {} })
  const log = (m) => { T.log.push(`${new Date().toISOString().slice(11, 19)} ${m}`); if (T.log.length > 200) T.log.shift() }
  try {
    const { loadPyodide } = await import('https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs')
    const py = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/' })
    for (const [path, src] of Object.entries(window.__ENGINE_SRC)) {
      py.FS.mkdirTree('/home/pyodide/' + path.split('/').slice(0, -1).join('/'))
      py.FS.writeFile('/home/pyodide/' + path, src)
    }
    py.runPython("import sys; sys.path.insert(0, '/home/pyodide')")
    py.runPython(window.__HARNESS_PY)
    const P = (n) => py.globals.get(n)
    const feed = P('feed'), tick = P('tick'), snap = P('snapshot'), check = P('check'), needSnap = P('needs_snapshot')
    const synced = P('synced'), gex = P('gex'), report = P('report'), greeks = P('greeks_check'), setOff = P('set_offset')
    const feed2 = P('feed2'), tick2 = P('tick2'), report2 = P('report2'), barLevels = P('bar_levels')
    T.report = () => JSON.parse(report())
    T.report2 = () => JSON.parse(report2())
    T.barLevels = (t) => JSON.parse(barLevels(t))
    const hash = async (x) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(x)))).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
    // footprint fingerprint of a minute: sorted "bucket:buyLots:sellLots" -> compare with the same hash of REST aggTrades
    T.engineMinute = async (t0) => {
      const b = T.barLevels(t0); if (!b) return null
      const canon = b.lv.map(([k, bv, sv]) => `${k}:${Math.round(bv * 1000)}:${Math.round(sv * 1000)}`).join('|')
      return { t0, n: b.n, first_a: b.first_a, last_a: b.last_a, levels: b.lv.length, vol: b.v, buy: b.bv, hash: await hash(canon) }
    }
    let api, rid = 0
    const pend = {}
    const openApi = () => new Promise((res) => {
      api = new WebSocket('wss://ws-fapi.binance.com/ws-fapi/v1')     // WS API: depth snapshots + server time (no CORS needed)
      api.onopen = () => res()
      api.onmessage = (e) => { const d = JSON.parse(e.data); if (pend[d.id]) { pend[d.id](e.data); delete pend[d.id] } }
      api.onclose = () => { log('api closed'); setTimeout(openApi, 1000) }
    })
    await openApi()
    const apiReq = (method, params) => new Promise((res) => { const id = String(++rid); pend[id] = res; api.send(JSON.stringify({ id, method, params: params || {} })) })
    const syncClock = async () => {
      let best = null
      for (let i = 0; i < 6; i++) {
        const t0 = Date.now(); const raw = await apiReq('time'); const t1 = Date.now()
        const st = JSON.parse(raw).result.serverTime
        if (!best || t1 - t0 < best[0]) best = [t1 - t0, st - (t0 + t1) / 2]
      }
      setOff(best[1]); T.offsets.push({ rtt: best[0], offset: best[1] })
    }
    await syncClock()
    setInterval(syncClock, 300000)
    let lastTick = 0, lastCheck = Date.now(), pendingCheck = null, snapping = false, checking = false, lastMin = 0
    const maint = (now) => {     // driven by incoming messages, so background-tab timer throttling does not matter
      if (now - lastTick >= 100) { lastTick = now; tick(now); tick2(now) }
      if (!snapping && needSnap()) {
        snapping = true
        apiReq('depth', { symbol: 'BTCUSDT', limit: 1000 }).then((raw) => { snap(raw); snapping = false })
      }
      if (synced() && !checking && now - lastCheck > 30000) {
        checking = true; lastCheck = now
        apiReq('depth', { symbol: 'BTCUSDT', limit: 1000 }).then((raw) => { pendingCheck = raw })
      }
      if (pendingCheck) {
        const r = check(pendingCheck)
        if (r !== '') { pendingCheck = null; checking = false; T.books.push(JSON.parse(r)) }
      }
      const m = now - (now % 60000) - 60000
      if (now % 60000 > 4000 && m > lastMin) { lastMin = m; T.engineMinute(m).then((x) => { if (x) T.minutes[m] = x }) }
    }
    const stream = (url, name, fn) => {
      const ws = new WebSocket(url)
      ws.onmessage = (e) => { try { const now = Date.now(); fn(e.data, now); maint(now) } catch (err) { T.errors.push(name + ' ' + String(err).slice(0, 400)) } }
      ws.onclose = () => { log(name + ' closed, reconnecting'); setTimeout(() => stream(url, name, fn), 1000) }
    }
    stream('wss://fstream.binance.com/public/stream?streams=btcusdt@depth@100ms', 'book', feed)
    stream('wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdt@markPrice@1s/btcusdt@forceOrder/btcusdt@kline_1m/btcusdt@ticker', 'market', feed)
    stream('wss://dstream.binance.com/stream?streams=btcusd_perp@aggTrade/btcusd_perp@kline_1m/btcusd_perp@markPrice@1s', 'coinm', feed2)
    const DER = 'https://www.deribit.com/api/v2/public/'
    const doGex = async () => {
      try {
        const raw = await (await fetch(DER + 'get_book_summary_by_currency?currency=BTC&kind=option')).text()
        T.gex.push(JSON.parse(gex(raw, Date.now())))
        if (!T.greeks) {
          const rows = JSON.parse(raw).result.filter((r) => r.open_interest > 20)
          rows.sort((a, b) => b.open_interest - a.open_interest)
          const res = []
          for (const r of rows.slice(0, 60)) res.push(await (await fetch(DER + 'ticker?instrument_name=' + r.instrument_name)).text())
          T.greeks = JSON.parse(greeks(JSON.stringify(res), Date.now()))
        }
      } catch (err) { T.errors.push('gex ' + String(err).slice(0, 300)) }
    }
    setTimeout(doGex, 5000)
    setInterval(doGex, 60000)
    log('harness running')
  } catch (err) {
    T.errors.push('fatal ' + String(err).slice(0, 800))
  }
})()

// REST cross-check of one minute (run in a tab on https://fapi.binance.com, where REST is same-origin):
// window.restMinute = async (t0) => { ...see ACCURACY.md... }
