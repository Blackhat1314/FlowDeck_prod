import { useState } from 'react'
import { act, adminApi, confirmAction, Empty, fmtDate, num, span, usePoll } from './ui'

export const VENUE_NAMES: Record<string, string> = {
  usdm: 'Binance BTCUSDT perpetual',
  coinm: 'Binance BTCUSD perpetual (COIN-M)',
}

const FEED_NAMES: Record<string, string> = {
  book_ws: 'Binance order book',
  market_ws: 'Binance trades',
  deribit: 'Deribit options (gamma)',
  backfill: 'History backfill',
  bn_coinm: 'Binance COIN-M',
  bybit: 'Bybit USDT perp',
  bybit_inv: 'Bybit inverse perp',
  okx: 'OKX perp',
  bn_spot: 'Binance spot',
  coinbase: 'Coinbase spot',
}

const FEED_STATE: Record<string, string> = {
  live: 'Live', demo: 'Simulated', done: 'Complete', idle: 'Idle', connecting: 'Connecting', reconnecting: 'Reconnecting',
  loading: 'Loading', error: 'Error', waiting: 'Waiting', ticks: 'Loading trades', klines: 'Loading candles',
}

interface Kline {
  t: number; status: 'ok' | 'no_bar'
  vol_k?: number; vol_e?: number; buy_k?: number; buy_e?: number; vol_ok?: boolean; buy_ok?: boolean
  delta_k?: number; delta_e?: number; n_k?: number; n_e?: number; ids_ok?: boolean; ohlc_ok?: boolean; tape_ok?: boolean; gaps?: number; kv?: number
}
interface Venue {
  key: string; label: string; name: string; kind: string; primary: boolean; msgs: number; trades: number
  last_msg_age_ms: number | null; live: boolean; px: number | null; basis: number | null; oi: number | null; fund: number | null
  book: { ok: boolean; updates: number; gaps: number } | null
}
interface Acc {
  health: Record<string, any>
  feeds: Record<string, string>
  venues: Venue[]
  venue: string
  demo: boolean
  klines: Kline[]
  server_time: number
}

const kState = (k: Kline) => k.status !== 'ok' ? 'none' : (k.vol_ok && k.buy_ok) ? 'exact' : k.tape_ok ? 'tape' : k.tape_ok === false ? 'off' : 'pending'

export function Accuracy() {
  const [d, error, reload] = usePoll<Acc>('/api/admin/accuracy', 3000)
  const [busy, setBusy] = useState(false)
  if (error && !d) return <section className="view"><p className="err-line">{error}</p></section>
  if (!d) return <section className="view"><p className="dim">Loading…</p></section>
  const h = d.health
  const book = h.book_last

  const switchTo = async (v: string) => {
    if (v === d.venue) return
    const ok = await confirmAction({
      title: `Switch everyone to ${VENUE_NAMES[v]}?`,
      body: <p>The data feed restarts on the new instrument. Every open dashboard reloads its history, which takes a few seconds, and the accuracy counters start again from zero.</p>,
      confirm: 'Switch instrument', danger: true,
    })
    if (!ok) return
    setBusy(true)
    await act(() => adminApi('/api/admin/feed', { body: { venue: v } }), `Switched to ${VENUE_NAMES[v]}`)
    setBusy(false)
    reload()
  }

  const checked = h.kline_checked ?? 0
  const tapeExact = h.tape_exact ?? 0
  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Data accuracy</h1>
          <p className="lede">The server grades its own data against each exchange's official numbers. Updates every 3 seconds.</p>
        </div>
        <label className="venue-pick">Instrument
          <select value={d.venue} disabled={busy} onChange={(e) => switchTo(e.target.value)}>
            {Object.entries(VENUE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
      </header>

      {d.demo && <p className="demo-note">Demo mode: the market is simulated, so every check below passes by construction. Run without <code>FLOW_DEMO=1</code> for real numbers.</p>}

      <div className="acc-grid">
        <div className="panel acc-hero">
          <h2 className="panel-title">Trades vs Binance's 1-minute candles</h2>
          {checked === 0 ? <Empty>The first check runs about a minute after start-up, once a full minute has closed.</Empty> : (
            <>
              <p className="verdict">
                <span className="big">{tapeExact} of {checked}</span>
                <span>closed minutes match Binance exactly: same volume, same buy volume, so the same delta.</span>
              </p>
              <MinuteStrip ks={d.klines} />
              <dl className="kv">
                <dt>Volume identical</dt><dd>{h.vol_exact}/{checked}</dd>
                <dt>Buy volume identical</dt><dd>{h.buy_exact}/{checked}</dd>
                <dt>First and last trade ID identical</dt><dd>{h.ids_exact}/{checked}</dd>
                <dt>Open, high, low, close identical</dt><dd>{h.ohlc_exact}/{checked}</dd>
                <dt>Settled against the raw trade list</dt><dd>{h.tape_arbitrated ?? 0}</dd>
                <dt>Missing trade IDs</dt><dd className={h.agg_gaps ? 'bad' : ''}>{h.agg_gaps ?? 0}</dd>
              </dl>
              <p className="panel-note">
                "Settled against the raw trade list": Binance's candle and its own trade stream sometimes disagree by a few trades. When that happens
                the server downloads every trade of that minute and compares again.
              </p>
            </>
          )}
        </div>

        <div className="panel">
          <h2 className="panel-title">Order book</h2>
          <p className="verdict sm">
            <span className="big">{h.book_pct_avg != null ? `${num(h.book_pct_avg, 1)}%` : '—'}</span>
            <span>of price levels matched a fresh snapshot from Binance, averaged over {h.book_checks ?? 0} checks.</span>
          </p>
          <dl className="kv">
            <dt>State</dt><dd className={h.book_state === 'synced' ? 'good' : 'bad'}>{h.book_state === 'synced' ? 'In sync' : h.book_state}</dd>
            {book && <><dt>Last check</dt><dd>{num(book.match)} of {num(book.levels)} levels</dd></>}
            {book && <><dt>Wrong size / missing / stale</dt><dd>{book.qty_diff} / {book.missing} / {book.stale}</dd></>}
            <dt>Resyncs</dt><dd>{h.resyncs ?? 0}</dd>
            <dt>Crossed book events</dt><dd className={h.crossed ? 'bad' : ''}>{h.crossed ?? 0}</dd>
            <dt>Book updates applied</dt><dd>{num(h.book_updates)}</dd>
          </dl>
          <p className="panel-note">Levels that changed while the snapshot was in flight are counted separately as stale, not wrong.</p>
        </div>

        <div className="panel">
          <h2 className="panel-title">Speed</h2>
          <p className="verdict sm">
            <span className="big">{h.lat_p50 != null ? `${Math.round(h.lat_p50)} ms` : '—'}</span>
            <span>typical delay from Binance's matching engine to this server.</span>
          </p>
          <dl className="kv">
            <dt>Slowest 5% of messages</dt><dd>{h.lat_p95 != null ? `${Math.round(h.lat_p95)} ms or more` : '—'}</dd>
            <dt>Server clock vs Binance</dt><dd>{h.clock_offset != null ? `${h.clock_offset > 0 ? '+' : ''}${h.clock_offset} ms (corrected)` : '—'}</dd>
            <dt>Messages received</dt><dd>{num((h.msgs ?? 0) + (h.xmsgs ?? 0))}</dd>
            <dt>Heatmap columns built</dt><dd>{num(h.columns)}</dd>
          </dl>
          <p className="panel-note">Viewers add their own internet delay on top, usually 20 to 150 ms.</p>
        </div>
      </div>

      <div className="panel">
        <h2 className="panel-title">Exchanges</h2>
        <div className="table-wrap">
          <table className="tbl venues">
            <thead>
              <tr>
                <th>Exchange</th><th>Status</th><th className="r">Last price</th><th className="r">Gap to main</th>
                <th className="r">Open interest</th><th className="r">Funding / 8h</th><th className="r">Trades</th><th>Book depth</th>
              </tr>
            </thead>
            <tbody>
              {d.venues.map((v) => (
                <tr key={v.key}>
                  <td data-label="Exchange"><b>{v.name}</b>{v.primary && <span className="tag">main</span>}</td>
                  <td data-label="Status">
                    <span className={v.live ? 'live-tag' : 'frozen-tag'}>{v.live ? 'Live' : 'Silent'}</span>
                    <small className="dim">{v.last_msg_age_ms != null ? ` ${v.last_msg_age_ms < 1000 ? 'now' : `${span(v.last_msg_age_ms)} ago`}` : ' no data yet'}</small>
                  </td>
                  <td data-label="Last price" className="r num">{v.px != null ? num(v.px, 1) : '—'}</td>
                  <td data-label="Gap to main" className="r num">{v.primary ? '' : v.basis != null ? `${v.basis > 0 ? '+' : ''}${num(v.basis, 1)}` : '—'}</td>
                  <td data-label="Open interest" className="r num">{v.oi != null ? `${num(v.oi)} BTC` : v.kind === 'spot' ? 'spot' : '—'}</td>
                  <td data-label="Funding / 8h" className="r num">{v.fund != null ? `${(v.fund * 100).toFixed(4)}%` : v.kind === 'spot' ? 'spot' : '—'}</td>
                  <td data-label="Trades" className="r num">{num(v.trades)}</td>
                  <td data-label="Book depth">
                    {v.primary ? <span className="dim">checked above</span> : v.book
                      ? <span className={v.book.ok ? '' : 'bad'}>{v.book.ok ? 'In sync' : 'Resyncing'}<small className="dim">{` ${num(v.book.updates)} updates, ${v.book.gaps} gaps`}</small></span>
                      : <span className="dim">trades only</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h2 className="panel-title">Connections</h2>
        <ul className="feeds">
          {Object.entries(d.feeds).map(([k, s]) => (
            <li key={k} className={`f-${['live', 'demo', 'done'].includes(s) ? 'ok' : ['error', 'reconnecting'].includes(s) ? 'bad' : 'wait'}`}>
              <span>{FEED_NAMES[k] ?? k}</span><b>{FEED_STATE[s] ?? s}</b>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}

function MinuteStrip({ ks }: { ks: Kline[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const list = ks.slice(-30)
  const k = hover != null ? list[hover] : null
  const label: Record<string, string> = {
    exact: 'Exact match', tape: 'Matched the raw trade list (candle was off)', off: 'Did not match', pending: 'Checking against the trade list', none: 'Not checked (no live data for that minute)',
  }
  const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return (
    <figure className="mstrip">
      <div className="cells" onMouseLeave={() => setHover(null)}>
        {list.map((x, i) => (
          <button key={x.t} className={`cell c-${kState(x)} ${hover === i ? 'hot' : ''}`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}
            aria-label={`${time(x.t)}: ${label[kState(x)]}`} />
        ))}
      </div>
      <figcaption>
        {k ? (
          <>
            <b>{time(k.t)}</b> {label[kState(k)]}.
            {k.status === 'ok' && <> Volume {num(k.vol_k, 3)} BTC (ours {num(k.vol_e, 3)}), delta {num(k.delta_k, 3)} (ours {num(k.delta_e, 3)}), {num(k.n_k)} trades.</>}
          </>
        ) : (
          <span className="legend">
            <span><i className="c-exact" /> exact</span>
            <span><i className="c-tape" /> matched raw trades</span>
            <span><i className="c-off" /> mismatch</span>
            <span><i className="c-none" /> not checked</span>
            <span className="dim">Last {list.length} minutes, newest on the right. Ends {list.length ? fmtDate(list[list.length - 1].t + 60_000) : ''}.</span>
          </span>
        )}
      </figcaption>
    </figure>
  )
}
