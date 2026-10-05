import { useEffect, useState } from 'react'
import { store, useTopic } from '../lib/store'
import { AccountMenu } from './Account'
import { C, fmtPx, fmtQty, fmtUsd } from '../lib/util'

function useClock(ms = 1000) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

export default function TopBar() {
  useTopic('stats', 'conn', 'config', 'health', 'cols', 'flow')
  useClock(1000)
  const st = store.stats
  const cfg = store.config
  const h = store.health
  const last = store.last
  const chg = st?.chg24 ?? null
  const fundLeft = st?.next_funding ? Math.max(0, st.next_funding - store.now()) : null
  const fl = fundLeft != null
    ? `${String(Math.floor(fundLeft / 3600000)).padStart(2, '0')}:${String(Math.floor((fundLeft % 3600000) / 60000)).padStart(2, '0')}:${String(Math.floor((fundLeft % 60000) / 1000)).padStart(2, '0')}`
    : '–'
  const spread = store.ba != null && store.bb != null ? store.ba - store.bb : null
  const tapeN = h?.tape_checked ?? h?.kline_checked ?? 0
  const tapeOk = h?.tape_exact ?? h?.vol_exact ?? 0
  const kOk = tapeN ? tapeOk === tapeN : null
  const bookPct = h?.book_last?.known_pct ?? null
  const f = store.flow
  const rg = f?.regime
  const rgBias = rg ? (rg.state.includes('up') || rg.state === 'spot_bid_perp_sold' ? 1
    : rg.state.includes('down') || rg.state === 'spot_sold_perp_bid' ? -1 : 0) : 0
  return (
    <header className="topbar">
      <div className="brand">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
          <rect x="4" y="18" width="5" height="10" fill="#1a96b0" />
          <rect x="11" y="10" width="5" height="18" fill="#f2d642" />
          <rect x="18" y="4" width="5" height="24" fill="#f58c34" />
          <rect x="25" y="14" width="4" height="14" fill="#0e4e80" />
        </svg>
        <span>Flowdeck</span>
      </div>
      <select
        className="venue"
        value={cfg?.venue ?? 'usdm'}
        onChange={(e) => store.switchVenue(e.target.value)}
        aria-label="Instrument"
        disabled={store.me?.user.role !== 'admin'}
        title={store.me?.user.role === 'admin' ? 'Switch the instrument for every user' : 'Instrument (set by the admin)'}
      >
        {(store.venues.length ? store.venues : [{ key: 'usdm', label: 'BTCUSDT perpetual', exchange: 'Binance USDⓈ-M' }]).map((v) => (
          <option key={v.key} value={v.key}>
            {v.label} · {v.exchange}
          </option>
        ))}
      </select>
      <div className="px" style={{ color: store.lastDir > 0 ? C.buy : C.sell }}>
        {fmtPx(last, 1)}
      </div>
      <div className="stats">
        <Stat label="24h" value={chg != null ? `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%` : '–'} color={chg != null ? (chg >= 0 ? C.buy : C.sell) : undefined} />
        <Stat label="Mark" value={fmtPx(st?.mark, 1)} sub={st?.index != null ? `idx ${fmtPx(st.index, 0)}` : undefined} opt2 />
        <Stat
          label={`Funding · ${fl}`}
          value={st?.funding != null ? `${(st.funding * 100).toFixed(4)}%` : '–'}
          color={st?.funding != null ? (st.funding >= 0 ? C.buy : C.sell) : undefined}
        />
        <Stat label="Open interest" value={st?.oi != null ? `${fmtQty(st.oi, 0)} BTC` : '–'} sub={fmtUsd(st?.oi_usd)} opt2 />
        {f?.oi != null && (
          <Stat label="OI all venues · 1h" value={`${fmtQty(f.oi / 1000, 1)}k`}
            sub={f.oi_d60 != null ? `${f.oi_d60 >= 0 ? '+' : ''}${fmtQty(f.oi_d60, 0)}` : undefined} />
        )}
        <Stat label="CB premium" value={f?.premium != null ? `${f.premium >= 0 ? '+' : ''}$${f.premium.toFixed(1)}` : '–'}
          color={f?.premium != null ? (f.premium >= 0 ? C.buy : C.sell) : undefined} />
        <Stat label="24h volume" value={st?.vol24 != null ? `${fmtQty(st.vol24, 0)} BTC` : '–'} opt />
        <Stat label="Spread" value={spread != null ? fmtPx(spread, 1) : '–'} opt />
      </div>
      {rg && rg.state !== 'neutral' && (
        <div className={`rchip ${rgBias > 0 ? 'pos' : rgBias < 0 ? 'neg' : ''}`} title="Spot vs perp flow leadership over the last 5 minutes">
          {rg.label}
        </div>
      )}
      <div className="integrity" title="Engine output graded against Binance's own 1-minute candles and independent order-book snapshots">
        <span className={`dot ${kOk === false ? 'bad' : kOk ? 'ok' : ''}`} />
        <span>
          Trades {tapeN ? `${tapeOk}/${tapeN} min exact` : 'checking…'}
        </span>
        <span className="sep" />
        <span>Book {bookPct != null ? `${bookPct.toFixed(2)}%` : '…'}</span>
        <span className="sep lat" />
        <span className="lat">{h?.lat_p50 != null ? `${Math.round(h.lat_p50)} ms` : '– ms'}</span>
      </div>
      <div className={`conn ${store.conn}`}>
        <span className="dot" />
        {store.conn === 'live' ? (store.demo ? 'Demo feed' : 'Live') : store.conn === 'frozen' ? 'Frozen'
          : store.conn === 'connecting' ? 'Connecting' : 'Offline'}
      </div>
      <AccountMenu />
    </header>
  )
}

function Stat({ label, value, sub, color, opt, opt2 }: {
  label: string; value: string; sub?: string; color?: string; opt?: boolean; opt2?: boolean
}) {
  return (
    <div className={`stat ${opt ? 'opt' : ''} ${opt2 ? 'opt2' : ''}`}>
      <span className="k">{label}</span>
      <span className="v" style={color ? { color } : undefined}>
        {value}
        {sub && <em>{sub}</em>}
      </span>
    </div>
  )
}
