import { useMemo, useState } from 'react'
import type { Prefs } from '../lib/prefs'
import { store, useTopic } from '../lib/store'
import type { GexGroup } from '../lib/types'
import { C, fmtAge, fmtPx, fmtQty, fmtTime, fmtUsd, venueColor } from '../lib/util'
import { tip } from '../lib/hints'

type Tab = 'tape' | 'flow' | 'book' | 'gamma' | 'signals' | 'health'
type SetPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => void

export default function SidePanel({ p, set }: { p: Prefs; set: SetPref }) {
  const [tab, setTab] = useState<Tab>('tape')
  return (
    <aside className="side" {...tip('side.panel')}>
      <nav className="tabs" role="tablist">
        {(
          [
            ['tape', 'Tape'],
            ['flow', 'Flow'],
            ['book', 'Book'],
            ['gamma', 'Gamma'],
            ['signals', 'Signals'],
            ['health', 'Accuracy'],
          ] as [Tab, string][]
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)} {...tip(`side.${k}`)}>
            {l}
          </button>
        ))}
      </nav>
      <div className="side-body">
        {tab === 'tape' && <Tape p={p} set={set} />}
        {tab === 'flow' && <Flow p={p} set={set} />}
        {tab === 'book' && <Book p={p} set={set} />}
        {tab === 'gamma' && <Gamma group={p.gammaGroup} setGroup={(g) => set('gammaGroup', g)} />}
        {tab === 'signals' && <Signals p={p} />}
        {tab === 'health' && <HealthTab />}
      </div>
    </aside>
  )
}

function signed(v: number | null | undefined, d = 1) {
  if (v == null || !Number.isFinite(v)) return '–'
  return `${v > 0 ? '+' : ''}${fmtQty(v, d)}`
}
const sc = (v: number | null | undefined) => (v == null ? undefined : v >= 0 ? C.buy : C.sell)

function VenueChips({ p, set, kinds }: { p: Prefs; set: SetPref; kinds: ('perp' | 'spot')[] }) {
  useTopic('config')
  const vs = (store.config?.xvenues ?? []).filter((v) => kinds.includes(v.kind))
  if (!vs.length) return null
  const toggle = (x: number) => set('venOff', p.venOff.includes(x) ? p.venOff.filter((v) => v !== x) : [...p.venOff, x])
  return (
    <div className="chips" role="group" aria-label="Venues">
      {vs.map((v) => {
        const on = !p.venOff.includes(v.x)
        return (
          <button key={v.x} className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(v.x)} title={v.name}>
            <i style={{ background: venueColor(v.x) }} />
            {v.label}
          </button>
        )
      })}
    </div>
  )
}

// ================================================================== tape
function Tape({ p, set }: { p: Prefs; set: SetPref }) {
  useTopic('tape')
  const [minQ, setMinQ] = useState(1)
  const px = store.config?.primary_x ?? 0
  const off = p.venOff
  const vis = (x: number | undefined) => !off.includes(x ?? px)
  const rows = useMemo(() => {
    const out = []
    for (let i = store.sweeps.length - 1; i >= 0 && out.length < 300; i--) {
      const s = store.sweeps[i]
      if (s.q >= minQ && vis(s.x)) out.push(s)
    }
    return out
  }, [store.version('tape'), minQ, off.join(',')])
  const now = store.now()
  let b5 = 0
  let s5 = 0
  let nBig = 0
  for (let i = store.sweeps.length - 1; i >= 0; i--) {
    const s = store.sweeps[i]
    if (s.t < now - 300000) break
    if (!vis(s.x)) continue
    if (s.s > 0) b5 += s.q
    else s5 += s.q
    if (s.q >= p.bigTrade) nBig++
  }
  const maxQ = Math.max(1, ...rows.slice(0, 80).map((r) => r.q))
  return (
    <div className="tape">
      <VenueChips p={p} set={set} kinds={['perp', 'spot']} />
      <div className="kpis">
        <div><span>Buy sweeps 5m</span><b style={{ color: C.buy }}>{fmtQty(b5, 1)}</b></div>
        <div><span>Sell sweeps 5m</span><b style={{ color: C.sell }}>{fmtQty(s5, 1)}</b></div>
        <div><span>Big trades 5m</span><b>{nBig}</b></div>
      </div>
      <div className="ctrls">
        <label>
          Show ≥
          <select value={minQ} onChange={(e) => setMinQ(+e.target.value)}>
            {[0.5, 1, 2, 5, 10, 25, 50].map((v) => <option key={v} value={v}>{v} BTC</option>)}
          </select>
        </label>
        <label>
          Highlight ≥
          <select value={p.bigTrade} onChange={(e) => set('bigTrade', +e.target.value)}>
            {[2, 5, 10, 20, 50, 100].map((v) => <option key={v} value={v}>{v} BTC</option>)}
          </select>
        </label>
      </div>
      <div className="thead tv"><span>Time</span><span>Venue</span><span>Price</span><span>Size</span><span>Value</span></div>
      <div className="list">
        {rows.map((r) => {
          const v = store.venue(r.x ?? px)
          return (
            <div key={r.id} className={`trow tv ${r.s > 0 ? 'b' : 's'} ${r.q >= p.bigTrade ? 'big' : ''}`}
              title={`${v?.name ?? ''}${r.n > 1 ? ` · ${r.n} fills from ${fmtPx(r.lo, 1)} to ${fmtPx(r.hi, 1)}` : ''}`}>
              <i style={{ width: `${(Math.min(1, r.q / maxQ) * 100).toFixed(1)}%` }} />
              <span className="t">{fmtTime(r.t, true).slice(0, 12)}</span>
              <span className="vn" style={{ color: venueColor(r.x ?? px) }}>{v?.label ?? '–'}</span>
              <span>{fmtPx(r.p, 1)}</span>
              <span className="q">{fmtQty(r.q)}{r.n > 1 && <sup>×{r.n}</sup>}</span>
              <span className="u">{fmtUsd(r.usd)}</span>
            </div>
          )
        })}
        {!rows.length && <p className="empty">No sweeps at this size yet. Lower the filter to see smaller prints.</p>}
      </div>
    </div>
  )
}

// ================================================================== flow (cross-exchange)
function Flow({ p, set }: { p: Prefs; set: SetPref }) {
  useTopic('flow', 'liqmap')
  const f = store.flow
  if (!f) return <p className="empty">Connecting to Bybit, OKX, Binance spot and Coinbase…</p>
  const rg = f.regime
  const since = rg.since ? fmtAge((store.now() - rg.since) / 1000) : null
  const bias = rg.state.includes('up') || rg.state === 'spot_bid_perp_sold' ? 1
    : rg.state.includes('down') || rg.state === 'spot_sold_perp_bid' ? -1 : 0
  const lm = store.liqmap
  const bar = (v: number, m: number) => (
    <span className="hbar"><i className={v >= 0 ? 'pos' : 'neg'} style={{ width: `${Math.min(50, (Math.abs(v) / (m || 1)) * 50)}%` }} /></span>
  )
  const mc = Math.max(1, Math.abs(f.cvd5.perp), Math.abs(f.cvd5.spot))
  const mc60 = Math.max(1, Math.abs(f.cvd60.perp), Math.abs(f.cvd60.spot))
  const ms = Math.max(1, ...f.size60.map(Math.abs))
  return (
    <div className="flow">
      <div className={`regime ${bias > 0 ? 'pos' : bias < 0 ? 'neg' : ''}`}>
        <b>{rg.label}</b>
        <span>
          {rg.dp_bps != null ? `${rg.dp_bps > 0 ? '+' : ''}${rg.dp_bps} bps in 5m` : ''}
          {since ? ` · for ${since}` : ''}
        </span>
        <p>
          Who is driving price over the last 5 minutes: spot buyers/sellers (Binance spot + Coinbase) or perpetual
          traders. Spot-led moves tend to stick; perp-led moves without spot often fade.
          {f.regime_stats.scored > 0 && ` Scored ${f.regime_stats.scored} calls, ${f.regime_stats.hit_rate}% followed through after 5 min.`}
        </p>
      </div>
      <dl className="levels">
        <div><dt>Coinbase premium</dt><dd style={{ color: sc(f.premium) }}>{f.premium != null ? `${f.premium >= 0 ? '+' : ''}$${f.premium.toFixed(1)}` : '–'}<em>{f.premium_bps != null ? ` ${f.premium_bps} bps` : ''}</em></dd></div>
        <div><dt>USDT / USD</dt><dd>{f.usdt != null ? f.usdt.toFixed(4) : '–'}</dd></div>
        <div><dt>OI all venues</dt><dd>{f.oi != null ? `${fmtQty(f.oi, 0)} BTC` : '–'}</dd></div>
        <div><dt>OI Δ 5m / 1h</dt><dd><span style={{ color: sc(f.oi_d5) }}>{signed(f.oi_d5, 0)}</span> / <span style={{ color: sc(f.oi_d60) }}>{signed(f.oi_d60, 0)}</span></dd></div>
        <div><dt>Funding (OI-weighted)</dt><dd style={{ color: sc(f.fund_w) }}>{f.fund_w != null ? `${(f.fund_w * 100).toFixed(4)}%` : '–'}</dd></div>
        <div><dt>Liquidations 1h L / S</dt><dd><span style={{ color: C.orange }}>{fmtQty(f.liq60[0], 1)}</span> / <span style={{ color: C.cyan }}>{fmtQty(f.liq60[1], 1)}</span></dd></div>
      </dl>
      <h3>Venues</h3>
      <p className="explain">Untick a venue to remove it from the aggregated tape, sweeps and CVD.</p>
      <table className="vtab">
        <thead><tr><th /><th>Venue</th><th>Price</th><th>Basis</th><th>OI</th><th>Funding</th></tr></thead>
        <tbody>
          {f.venues.map((v) => {
            const on = !p.venOff.includes(v.x)
            return (
              <tr key={v.x} className={on ? '' : 'off'}>
                <td>
                  <input type="checkbox" checked={on} aria-label={`Include ${v.name}`}
                    onChange={() => set('venOff', on ? [...p.venOff, v.x] : p.venOff.filter((q) => q !== v.x))} />
                </td>
                <td title={v.name}>
                  <span className={`dot ${v.live ? 'ok' : 'bad'}`} style={{ width: 6, height: 6, marginRight: 5 }} />
                  <span style={{ color: venueColor(v.x) }}>{v.label}</span>
                  {v.kind === 'spot' && <em> spot</em>}
                </td>
                <td>{fmtPx(v.px, 1)}</td>
                <td style={{ color: sc(v.basis) }}>{v.basis != null && v.x !== store.config?.primary_x ? signed(v.basis, 1) : '–'}</td>
                <td>{v.oi != null ? fmtQty(v.oi, 0) : '–'}</td>
                <td style={{ color: sc(v.fund) }}>{v.fund != null ? `${(v.fund * 100).toFixed(4)}%` : '–'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <h3>Spot vs perps delta</h3>
      <table className="btab">
        <thead><tr><th /><th>5 min</th><th /><th>1 hour</th><th /></tr></thead>
        <tbody>
          <tr><td>Perps</td><td style={{ color: sc(f.cvd5.perp) }}>{signed(f.cvd5.perp)}</td><td>{bar(f.cvd5.perp, mc)}</td>
            <td style={{ color: sc(f.cvd60.perp) }}>{signed(f.cvd60.perp, 0)}</td><td>{bar(f.cvd60.perp, mc60)}</td></tr>
          <tr><td>Spot</td><td style={{ color: sc(f.cvd5.spot) }}>{signed(f.cvd5.spot)}</td><td>{bar(f.cvd5.spot, mc)}</td>
            <td style={{ color: sc(f.cvd60.spot) }}>{signed(f.cvd60.spot, 0)}</td><td>{bar(f.cvd60.spot, mc60)}</td></tr>
        </tbody>
      </table>
      <h3>Delta by order size (perps)</h3>
      <table className="btab">
        <thead><tr><th /><th>5 min</th><th>1 hour</th><th /></tr></thead>
        <tbody>
          {(['< 1 BTC', '1–10 BTC', '≥ 10 BTC'] as const).map((l, i) => (
            <tr key={l}><td>{l}</td><td style={{ color: sc(f.size5[i]) }}>{signed(f.size5[i])}</td>
              <td style={{ color: sc(f.size60[i]) }}>{signed(f.size60[i], 0)}</td><td>{bar(f.size60[i], ms)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="explain">Sizes are whole taker orders rebuilt from their fills, so a 30 BTC market order split into 200 prints counts once as ≥ 10 BTC.</p>
      {lm && (
        <>
          <h3>Liquidation levels <em className="tagm">model</em></h3>
          <p className="explain">
            Estimated from open-interest increases at each price and a typical leverage mix (5×–100×). It shows where
            positions opened recently would be force-closed, not actual exchange data.
          </p>
          <table className="vtab">
            <thead><tr><th>Shorts liquidate</th><th>BTC</th><th>Longs liquidate</th><th>BTC</th></tr></thead>
            <tbody>
              {Array.from({ length: Math.max(lm.top_short.length, lm.top_long.length) }).map((_, i) => (
                <tr key={i}>
                  <td style={{ color: C.cyan }}>{lm.top_short[i] ? fmtPx(lm.top_short[i].p, 0) : ''}</td>
                  <td>{lm.top_short[i] ? fmtQty(lm.top_short[i].btc, 0) : ''}</td>
                  <td style={{ color: C.orange }}>{lm.top_long[i] ? fmtPx(lm.top_long[i].p, 0) : ''}</td>
                  <td>{lm.top_long[i] ? fmtQty(lm.top_long[i].btc, 0) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="foot">Model built from {lm.seeded ? `${lm.seeded} history rows + ` : ''}{lm.updates} live OI updates.</p>
        </>
      )}
    </div>
  )
}

// ================================================================== book: pull/stack DOM + walls
function Book({ p, set }: { p: Prefs; set: SetPref }) {
  useTopic('dom', 'walls', 'micro', 'health')
  const dom = store.dom
  const win = p.domWin || 30
  const wi = dom ? dom.windows.indexOf(win) : -1
  const walls = store.walls
  const thr = walls?.thr ?? Infinity
  const ev = [...store.micro].reverse().slice(0, 60)
  const ms = store.health?.micro
  let mx = 0
  let mq = 0
  if (dom && wi >= 0) for (const r of dom.rows) {
    const o = 3 + wi * 4
    mx = Math.max(mx, Math.abs(r[o]), Math.abs(r[o + 2]))
    mq = Math.max(mq, r[1], r[2])
  }
  const midIdx = dom ? dom.rows.findIndex((r) => r[1] > 0) : -1
  return (
    <div className="book">
      <div className="seg">
        {[5, 30, 60].map((w) => (
          <button key={w} className={win === w ? 'on' : ''} onClick={() => set('domWin', w)}>{w} s window</button>
        ))}
      </div>
      <p className="explain">
        Liquidity added (stacking, green) or cancelled (pulling, red) at each price over the window. Fills are not counted as pulls:
        every size change is matched against the trade tape first.
      </p>
      {!dom && <p className="empty">Waiting for the order book…</p>}
      {dom && wi >= 0 && (
        <div className="dom">
          <div className="dhead"><span>Pull / stack</span><span>Bid</span><span>Price</span><span>Ask</span><span>Pull / stack</span></div>
          <div className="dlist">
            {dom.rows.slice(Math.max(0, midIdx - 14), midIdx + 14).map((r) => {
              const o = 3 + wi * 4
              const sb = r[o]
              const sa = r[o + 2]
              const price = r[0] * dom.bucket
              return (
                <div key={r[0]} className={`drow ${r[1] >= thr || r[2] >= thr ? 'wall' : ''}`}>
                  <span className="ps">{sb ? <i className={sb >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(sb) / (mx || 1)) * 100}%` }} /> : null}<b>{sb ? signed(sb) : ''}</b></span>
                  <span className="bq">{r[1] ? <i style={{ width: `${Math.sqrt(r[1] / (mq || 1)) * 100}%` }} /> : null}<b>{r[1] ? fmtQty(r[1]) : ''}</b></span>
                  <span className="pr">{fmtPx(price, 0)}</span>
                  <span className="aq">{r[2] ? <i style={{ width: `${Math.sqrt(r[2] / (mq || 1)) * 100}%` }} /> : null}<b>{r[2] ? fmtQty(r[2]) : ''}</b></span>
                  <span className="ps">{sa ? <i className={sa >= 0 ? 'pos' : 'neg'} style={{ width: `${(Math.abs(sa) / (mx || 1)) * 100}%` }} /> : null}<b>{sa ? signed(sa) : ''}</b></span>
                </div>
              )
            })}
          </div>
        </div>
      )}
      <h3>Walls now {walls && <em className="tagm">≥ {fmtQty(walls.thr, 0)} BTC</em>}</h3>
      <div className="list short">
        {(walls?.walls ?? []).map((w) => (
          <div key={`${w.side}${w.p}`} className="wrow">
            <span className={`tag ${w.side}`}>{w.side === 'bid' ? 'Bid' : 'Ask'}</span>
            <span>{fmtPx(w.p, 0)}</span>
            <span><b>{fmtQty(w.q, 0)}</b> BTC</span>
            <span className="dimx">{fmtAge(w.age)}</span>
            <span className="dimx">{w.dist_bps != null ? `${w.dist_bps} bps` : ''}</span>
          </div>
        ))}
        {!walls?.walls.length && <p className="empty">No resting order above the wall threshold near the price.</p>}
      </div>
      <h3>Wall events &amp; icebergs</h3>
      <div className="list short">
        {ev.map((e) => (
          <div key={e.id} className="mrow" title={e.label}>
            <span className={`tag m-${e.type}`}>{e.type === 'pulled' ? 'Pulled' : e.type === 'eaten' ? 'Filled' : 'Iceberg'}</span>
            <span>{fmtTime(e.t)}</span>
            <span>{e.side === 'bid' ? 'bid' : 'ask'} {fmtPx(e.p, 0)}</span>
            <span>
              {e.type === 'iceberg'
                ? `${fmtQty(e.exec ?? 0, 1)} traded, ${fmtQty(e.shown ?? 0, 1)} shown`
                : e.type === 'pulled' ? `${fmtQty(e.cancelled ?? 0, 0)} of ${fmtQty(e.max ?? 0, 0)} cancelled`
                  : `${fmtQty(e.filled ?? 0, 0)} of ${fmtQty(e.max ?? 0, 0)} filled`}
            </span>
          </div>
        ))}
        {!ev.length && <p className="empty">Nothing yet. Large orders that get pulled as price approaches, walls that get filled and icebergs appear here.</p>}
      </div>
      {ms && (
        <dl className="levels">
          <div><dt>Added since start</dt><dd>{fmtQty(ms.added, 0)} BTC</dd></div>
          <div><dt>Cancelled</dt><dd>{fmtQty(ms.cancelled, 0)} BTC</dd></div>
          <div><dt>Filled (matched to trades)</dt><dd>{fmtQty(ms.filled, 0)} BTC</dd></div>
          <div><dt>Hidden (traded &gt; shown)</dt><dd>{fmtQty(ms.hidden, 1)} BTC</dd></div>
        </dl>
      )}
    </div>
  )
}

// ================================================================== gamma
function Gamma({ group, setGroup }: { group: Prefs['gammaGroup']; setGroup: (g: Prefs['gammaGroup']) => void }) {
  useTopic('gex', 'stats')
  const gx = store.gex
  if (!gx) return <p className="empty">Loading the Deribit options chain… levels appear within a minute.</p>
  const g = gx.groups[group] ?? gx.groups.all
  if (!g) return <p className="empty">No open interest in this expiry window.</p>
  const regime = g.net >= 0 ? 'Positive gamma' : 'Negative gamma'
  const regimeNote = g.net >= 0
    ? 'Dealers hedge against moves: expect mean reversion and pinning near big strikes.'
    : 'Dealers hedge with moves: expect trending, faster moves and bigger ranges.'
  const spot = gx.spot
  const frontLabel = gx.expiries[0]?.label
  return (
    <div className="gamma">
      <div className="seg">
        {(
          [
            ['all', 'All expiries'],
            ['front', `Next (${frontLabel ?? ''})`],
            ['week', '≤ 7 days'],
            ['month', '≤ 35 days'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={group === k ? 'on' : ''} onClick={() => setGroup(k)}>{l}</button>
        ))}
      </div>
      <div className={`regime ${g.net >= 0 ? 'pos' : 'neg'}`}>
        <b>{regime}</b>
        <span>{fmtUsd(g.net)} per 1% move</span>
        <p>{regimeNote}</p>
      </div>
      <dl className="levels">
        <div><dt>Deribit index</dt><dd>{fmtPx(spot, 1)}</dd></div>
        <div><dt>Gamma flip</dt><dd style={{ color: C.amber }}>{fmtPx(g.flip, 0)}</dd></div>
        <div><dt>Call wall</dt><dd style={{ color: C.buy }}>{fmtPx(g.call_wall, 0)}</dd></div>
        <div><dt>Put wall</dt><dd style={{ color: C.sell }}>{fmtPx(g.put_wall, 0)}</dd></div>
        <div><dt>Max pain ({frontLabel})</dt><dd>{fmtPx(gx.max_pain, 0)}</dd></div>
        <div><dt>Put/call OI</dt><dd>{gx.pcr?.toFixed(2) ?? '–'}</dd></div>
        <div><dt>Perp basis</dt><dd>{gx.basis != null ? `${gx.basis > 0 ? '+' : ''}${gx.basis.toFixed(1)}` : '–'}</dd></div>
        <div><dt>Options used</dt><dd>{gx.n_options}</dd></div>
      </dl>
      <GexBars g={g} spot={spot} />
      <GexCurve g={g} spot={spot} />
      <p className="foot">
        Net GEX = Σ γ × OI × F² × 1%, calls positive and puts negative (dealers assumed long calls, short puts).
        Source: Deribit public API, refreshed every 60 s · {fmtTime(gx.ts)}
      </p>
    </div>
  )
}

function GexBars({ g, spot }: { g: GexGroup; spot: number }) {
  const rows = g.strikes.filter((r) => Math.abs(r[0] / spot - 1) <= 0.12 && (r[1] !== 0 || r[2] !== 0))
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => Math.max(r[1], -r[2])))
  const H = 15
  const W = 300
  const mid = W / 2
  const sorted = [...rows].sort((a, b) => b[0] - a[0])
  return (
    <figure className="gexbars">
      <figcaption>Gamma by strike <span><i style={{ background: C.buy }} />calls <i style={{ background: C.sell }} />puts <i style={{ background: '#d3dceb' }} />net</span></figcaption>
      <svg viewBox={`0 0 ${W} ${sorted.length * H + 4}`} width="100%" role="img" aria-label="Gamma exposure by strike">
        {sorted.map((r, i) => {
          const y = i * H + 2
          const cw = (r[1] / max) * (mid - 52)
          const pw = (-r[2] / max) * (mid - 52)
          const nw = (Math.abs(r[3]) / max) * (mid - 52)
          const isSpot = Math.abs(r[0] - spot) < (sorted[0][0] - (sorted[1]?.[0] ?? sorted[0][0] - 1000)) / 2
          return (
            <g key={r[0]}>
              <text x={46} y={y + H / 2 + 3.5} textAnchor="end" className={isSpot ? 'spotk' : ''}>
                {(r[0] / 1000).toFixed(r[0] % 1000 ? 1 : 0)}k
              </text>
              <rect x={mid} y={y + 2} width={cw} height={H - 5} fill={C.buy} opacity={0.75} />
              <rect x={mid - pw} y={y + 2} width={pw} height={H - 5} fill={C.sell} opacity={0.75} />
              <rect x={r[3] >= 0 ? mid : mid - nw} y={y + H / 2 - 1} width={nw} height={2} fill="#d3dceb" />
              {(r[0] === g.call_wall || r[0] === g.put_wall) && (
                <text x={W - 2} y={y + H / 2 + 3.5} textAnchor="end"
                  fill={r[0] === g.call_wall && r[0] === g.put_wall ? C.amber : r[0] === g.call_wall ? C.buy : C.sell}>
                  {r[0] === g.call_wall && r[0] === g.put_wall ? 'call + put wall' : r[0] === g.call_wall ? 'call wall' : 'put wall'}
                </text>
              )}
            </g>
          )
        })}
        <line x1={mid} x2={mid} y1={0} y2={sorted.length * H + 4} stroke="#2a3d57" />
      </svg>
    </figure>
  )
}

function GexCurve({ g, spot }: { g: GexGroup; spot: number }) {
  const pts = g.curve.filter((p) => Math.abs(p[0] / spot - 1) <= 0.12)
  if (pts.length < 3) return null
  const W = 300
  const H = 110
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x0 = Math.min(...xs)
  const x1 = Math.max(...xs)
  const yAbs = Math.max(...ys.map(Math.abs)) || 1
  const X = (x: number) => 6 + ((x - x0) / (x1 - x0)) * (W - 12)
  const Y = (y: number) => H / 2 - (y / yAbs) * (H / 2 - 8)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join('')
  return (
    <figure className="gexcurve">
      <figcaption>Total gamma if price moves to…</figcaption>
      <svg viewBox={`0 0 ${W} ${H + 14}`} width="100%" role="img" aria-label="Net gamma versus spot price">
        <rect x={0} y={0} width={W} height={H / 2} fill="rgba(43,217,159,0.05)" />
        <rect x={0} y={H / 2} width={W} height={H / 2} fill="rgba(255,92,122,0.05)" />
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} stroke="#2a3d57" />
        <path d={d} fill="none" stroke="#d3dceb" strokeWidth={1.5} />
        <line x1={X(spot)} x2={X(spot)} y1={0} y2={H} stroke={C.cyan} strokeDasharray="3 3" />
        {g.flip && g.flip > x0 && g.flip < x1 && <line x1={X(g.flip)} x2={X(g.flip)} y1={0} y2={H} stroke={C.amber} />}
        <text x={6} y={H + 11}>{fmtPx(x0, 0)}</text>
        <text x={W - 6} y={H + 11} textAnchor="end">{fmtPx(x1, 0)}</text>
        <text x={X(spot) + 4} y={10} fill={C.cyan}>spot</text>
        {g.flip && g.flip > x0 && g.flip < x1 && <text x={X(g.flip) + 4} y={H - 4} fill={C.amber}>flip</text>}
      </svg>
    </figure>
  )
}

// ================================================================== signals
function Signals({ p }: { p: Prefs }) {
  useTopic('abs', 'liqs', 'health', 'xev')
  const abs = [...store.abs].reverse().slice(0, 120)
  const liqs = [...store.liqs].reverse().filter((l) => !p.venOff.includes(l.x ?? -1)).slice(0, 150)
  const xev = [...store.xev].reverse().slice(0, 80)
  const st = store.health?.abs
  return (
    <div className="signals">
      <h3>Cascades &amp; flow regime</h3>
      <p className="explain">
        A cascade fires when 30 s of liquidations across Binance, Bybit and OKX exceed 4× the recent rate.
        Regime changes compare spot and perp aggression; each call is scored 5 minutes later.
      </p>
      <div className="list short">
        {xev.map((e) => (
          <div key={e.id} className="xrow">
            <span className={`tag ${e.type === 'cascade' ? e.side : (e.bias ?? 0) > 0 ? 'up' : 'down'}`}>
              {e.type === 'cascade' ? 'Cascade' : 'Regime'}
            </span>
            <span>{fmtTime(e.t)}</span>
            <span className="lbl">{e.type === 'cascade' ? `${e.side === 'long' ? 'Longs' : 'Shorts'} ${fmtQty(e.btc ?? 0, 0)} BTC · ${fmtUsd(e.usd)}` : e.label}</span>
            <span className={e.res ? (e.res.win ? 'win' : 'loss') : e.type === 'regime' ? 'pend' : 'pend'}>
              {e.res ? `${e.res.move > 0 ? '+' : ''}${e.res.move.toFixed(0)}` : e.type === 'regime' ? '…' : ''}
            </span>
          </div>
        ))}
        {!xev.length && <p className="empty">No cascades or regime changes yet.</p>}
      </div>
      <h3>Absorption</h3>
      <p className="explain">
        Heavy market orders hit one price, more traded than was visibly resting, and the level held.
        Each signal is scored 60 s later.
      </p>
      <div className="kpis">
        <div><span>Scored</span><b>{st?.scored ?? 0}</b></div>
        <div><span>Held direction</span><b>{st?.hit_rate != null ? `${st.hit_rate}%` : '–'}</b></div>
        <div><span>Avg move 60s</span><b>{st?.avg_move != null ? `${st.avg_move > 0 ? '+' : ''}${st.avg_move}` : '–'}</b></div>
      </div>
      <div className="list short">
        {abs.map((a) => (
          <div key={a.id} className="arow">
            <span className={`tag ${a.side}`}>{a.side === 'bid' ? 'Bid held' : 'Offer held'}</span>
            <span>{fmtTime(a.t)}</span>
            <span>{fmtPx(a.p, 0)}</span>
            <span title={`visible ${fmtQty(a.vis0)} BTC at start`}>{fmtQty(a.vol, 1)} BTC · {a.ratio}×</span>
            <span className={a.res ? (a.res.win ? 'win' : 'loss') : 'pend'}>
              {a.res ? `${a.res.move > 0 ? '+' : ''}${a.res.move.toFixed(0)}` : '…'}
            </span>
          </div>
        ))}
        {!abs.length && <p className="empty">No absorption yet. Signals appear when a level soaks up heavy aggression.</p>}
      </div>
      <h3>Liquidations (all venues)</h3>
      <div className="list short">
        {liqs.map((l, i) => (
          <div key={`${l.t}-${i}`} className="lrow">
            <span className={`tag ${l.side}`}>{l.side === 'long' ? 'Long liq' : 'Short liq'}</span>
            <span style={{ color: venueColor(l.x) }}>{store.venue(l.x)?.label ?? ''}</span>
            <span>{fmtTime(l.t)}</span>
            <span>{fmtPx(l.p, 1)}</span>
            <span>{fmtQty(l.q)} BTC</span>
            <span>{fmtUsd(l.usd)}</span>
          </div>
        ))}
        {!liqs.length && <p className="empty">No forced orders since the server started.</p>}
      </div>
    </div>
  )
}

// ================================================================== health / accuracy
function HealthTab() {
  useTopic('health', 'flow')
  const h = store.health
  if (!h) return <p className="empty">Collecting…</p>
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(2)}%` : '–')
  const k = store.kchk.filter((r) => r.status === 'ok').slice(-12).reverse()
  const bl = h.book_last
  return (
    <div className="health">
      <h3>Trades vs exchange</h3>
      <p className="explain">
        Every closed minute, the bar built from the live trade stream is compared with Binance's 1-minute candle.
        If they differ, the server downloads that minute's trades from Binance and compares against those too,
        because the candle sometimes leaves out a few trades that the public trade tape does show.
      </p>
      <dl className="levels">
        <div><dt>Minutes checked</dt><dd>{h.tape_checked ?? h.kline_checked}</dd></div>
        <div><dt>Exact vs exchange trades</dt><dd style={{ color: C.buy }}>{pct(h.tape_exact ?? h.vol_exact, h.tape_checked ?? h.kline_checked)}</dd></div>
        <div><dt>Volume = candle exactly</dt><dd>{pct(h.vol_exact, h.kline_checked)}</dd></div>
        <div><dt>Volume within 0.01% of candle</dt><dd>{pct(h.vol_close, h.kline_checked)}</dd></div>
        <div><dt>Taker-buy (delta) = candle</dt><dd>{pct(h.buy_exact, h.kline_checked)}</dd></div>
        <div><dt>OHLC = candle</dt><dd>{pct(h.ohlc_exact, h.kline_checked)}</dd></div>
        <div><dt>Missing trades in stream</dt><dd>{h.agg_gaps}</dd></div>
        <div><dt>Re-checked against trade tape</dt><dd>{h.tape_arbitrated ?? 0}</dd></div>
      </dl>
      {k.length > 0 && (
        <table className="ktab">
          <thead><tr><th>Minute</th><th>Vol engine</th><th>Vol candle</th><th>Δ engine</th><th>Δ candle</th><th>Tape</th></tr></thead>
          <tbody>
            {k.map((r) => (
              <tr key={r.t} className={(r.vol_ok && r.buy_ok) || r.tape_ok ? '' : 'bad'}>
                <td>{fmtTime(r.t).slice(0, 5)}</td>
                <td>{r.vol_e.toFixed(3)}</td>
                <td>{r.vol_k.toFixed(3)}</td>
                <td>{r.delta_e.toFixed(3)}</td>
                <td>{r.delta_k.toFixed(3)}</td>
                <td>{r.vol_ok && r.buy_ok ? '=' : r.tape_ok === undefined ? '…' : r.tape_ok ? '= tape' : '≠'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Order book vs snapshot</h3>
      <p className="explain">Every 30 s an independent 1000-level snapshot is compared level by level with the local book.</p>
      <dl className="levels">
        <div><dt>Known levels exact</dt><dd>{bl?.known_pct != null ? `${bl.known_pct.toFixed(2)}%` : '–'}</dd></div>
        <div><dt>Coverage of snapshot</dt><dd>{bl?.coverage_pct != null ? `${bl.coverage_pct.toFixed(2)}%` : '–'}</dd></div>
        <div><dt>Wrong sizes</dt><dd>{bl?.qty_diff ?? '–'}</dd></div>
        <div><dt>Stale levels</dt><dd>{bl?.stale ?? '–'}</dd></div>
        <div><dt>Checks run</dt><dd>{h.book_checks}</dd></div>
        <div><dt>Resyncs</dt><dd>{h.resyncs}</dd></div>
      </dl>
      <h3>Other venues</h3>
      <dl className="levels">
        {(store.flow?.venues ?? []).map((v) => (
          <div key={v.x}><dt>{v.name}</dt><dd style={{ color: v.live ? C.buy : C.sell }}>{v.live ? 'live' : 'stale'} · {v.trades.toLocaleString()} trades</dd></div>
        ))}
        {h.xbooks && Object.entries(h.xbooks).map(([name, b]) => (
          <div key={name}><dt>{name} order book</dt><dd style={{ color: b.ok ? C.buy : C.sell }}>{b.ok ? 'in sync' : 'resyncing'} · {b.gaps} gaps</dd></div>
        ))}
        <div><dt>Messages (other venues)</dt><dd>{(h.xmsgs ?? 0).toLocaleString()}</dd></div>
        <div><dt>Liq model inputs</dt><dd>{h.liqmap ? `${h.liqmap.seeded} hist + ${h.liqmap.updates} live` : '–'}</dd></div>
      </dl>
      <h3>Feed</h3>
      <dl className="levels">
        <div><dt>Latency p50 / p95</dt><dd>{h.lat_p50 != null ? `${Math.round(h.lat_p50)} / ${Math.round(h.lat_p95 ?? 0)} ms` : '–'}</dd></div>
        <div><dt>Book state</dt><dd>{h.book_state}</dd></div>
        <div><dt>Backfill</dt><dd>{h.backfill}</dd></div>
        <div><dt>Messages</dt><dd>{h.msgs.toLocaleString()}</dd></div>
        <div><dt>Trades</dt><dd>{h.live_trades.toLocaleString()}</dd></div>
        <div><dt>Heatmap columns</dt><dd>{h.columns.toLocaleString()}</dd></div>
        {h.feeds && Object.entries(h.feeds).map(([key, v]) => (
          <div key={key}><dt>{key.replace('_', ' ')}</dt><dd>{v}</dd></div>
        ))}
      </dl>
    </div>
  )
}
