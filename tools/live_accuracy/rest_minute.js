// Paste in a tab on https://fapi.binance.com (REST is same-origin there). restMinute(t0) returns the
// footprint fingerprint of one minute from Binance's REST aggTrades, in the same format as T.engineMinute(t0).
window.restMinute = async (t0) => {
  const all = []
  let page = await (await fetch(`/fapi/v1/aggTrades?symbol=BTCUSDT&startTime=${t0}&endTime=${t0 + 59999}&limit=1000`)).json()
  while (page.length) {
    all.push(...page)
    if (page.length < 1000) break
    const last = page[page.length - 1].a
    page = (await (await fetch(`/fapi/v1/aggTrades?symbol=BTCUSDT&fromId=${last + 1}&limit=1000`)).json()).filter((x) => x.T <= t0 + 59999)
  }
  const m = new Map()
  let v = 0, bv = 0
  for (const x of all) {
    const b = Math.floor(Math.round(parseFloat(x.p) * 10) / 10)     // $1 bucket, same as the engine
    const q = Math.round(parseFloat(x.q) * 1000)
    const e = m.get(b) || [0, 0]
    if (x.m) e[1] += q; else { e[0] += q; bv += q }
    v += q
    m.set(b, e)
  }
  const keys = [...m.keys()].sort((a, b) => a - b)
  const canon = keys.map((k) => `${k}:${m.get(k)[0]}:${m.get(k)[1]}`).join('|')
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon)))).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
  const kl = (await (await fetch(`/fapi/v1/klines?symbol=BTCUSDT&interval=1m&startTime=${t0}&limit=1`)).json())[0]
  return { t0, n: all.length, first_a: all[0]?.a, last_a: all.at(-1)?.a, levels: keys.length, vol: v / 1000, buy: bv / 1000, hash, candle: { v: kl[5], V: kl[9] } }
}
