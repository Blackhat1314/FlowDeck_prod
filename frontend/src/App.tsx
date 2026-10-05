import { FrozenBar, KickedOverlay } from './panels/Account'
import { api, ApiError, loginUrl, type Me } from './lib/session'
import { useEffect, useRef, useState } from 'react'
import FootprintView from './charts/FootprintView'
import HeatmapView from './charts/HeatmapView'
import TpoView from './charts/TpoView'
import { DAY, lastFunding, weekStart } from './lib/analytics'
import {
  loadPrefs, savePrefs, TPO_SESSIONS, type BottomMode, type FpMode, type Prefs, type ProfileRange, type ProfileView,
  type Tool, type TpoSession, type ViewMode,
} from './lib/prefs'
import { store, useTopic } from './lib/store'
import { CLASSIC_CSS, HEAT_CSS } from './lib/util'
import SidePanel from './panels/SidePanel'
import TopBar from './panels/TopBar'

const BOTTOM: [BottomMode, string][] = [
  ['delta', 'Delta + CVD'],
  ['perps', 'Perps CVD by venue'],
  ['spotperp', 'Spot vs perps CVD'],
  ['size', 'CVD by order size'],
  ['oi', 'OI Δ + liquidations'],
  ['premium', 'Coinbase premium'],
]
const FP_MODES: [FpMode, string][] = [
  ['bidask', 'Bid × Ask'],
  ['delta', 'Delta'],
  ['volume', 'Volume'],
  ['trades', 'Trades'],
  ['ratio', 'Dominant %'],
]
const SOURCES: [Prefs['fpSrc'], string][] = [
  ['primary', 'Binance'],
  ['perps', 'All perps'],
  ['spot', 'Spot'],
]

export default function App() {
  const [p, setP] = useState<Prefs>(loadPrefs)
  const set = <K extends keyof Prefs>(k: K, v: Prefs[K]) => setP((x) => ({ ...x, [k]: v }))
  const setTool = (t: Tool) => setP((x) => ({ ...x, tool: t }))
  useTopic('tools')
  useEffect(() => savePrefs(p), [p])
  useEffect(() => {
    // who is signed in (plan, role); a dead session goes back to the sign-in page
    api<Me>('/api/auth/me')
      .then((me) => {
        store.me = me
        store.bump('conn')
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) location.href = loginUrl('/app', e.code)
      })
    store.connect()
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTool('none')
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  const showHeat = p.view === 'heatmap' || p.view === 'split'
  const showFoot = p.view === 'footprint' || p.view === 'split'
  const nTools = store.ranges.length + store.anchors.length

  const anchorPreset = (k: string) => {
    const now = store.now()
    let t: number | null = null
    if (k === 'week') t = weekStart(now)
    else if (k === 'day') t = now - (now % DAY)
    else if (k === 'funding') t = lastFunding(now)
    else if (k === 'liq') {
      const casc = [...store.xev].reverse().find((e) => e.type === 'cascade')
      if (casc) t = casc.t - 30_000
      else {
        let best = null as null | { t: number; q: number }
        for (const l of store.liqs) if (!best || l.q > best.q) best = { t: l.t, q: l.q }
        t = best?.t ?? null
      }
    }
    if (t != null) store.addAnchor(t)
  }

  return (
    <div className="app">
      <TopBar />
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Chart">
          {(['heatmap', 'footprint', 'split', 'tpo'] as ViewMode[]).map((v) => (
            <button key={v} className={p.view === v ? 'on' : ''} onClick={() => set('view', v)}>
              {v === 'heatmap' ? 'Heatmap' : v === 'footprint' ? 'Footprint' : v === 'split' ? 'Both' : 'TPO'}
            </button>
          ))}
        </div>
        {showHeat && (
          <div className="group">
            <label className="slider" title="Heatmap contrast">
              <span className="ramp" style={{ background: `linear-gradient(90deg, ${p.heatPalette === 'classic' ? CLASSIC_CSS : HEAT_CSS})` }} />
              <input type="range" min={0.3} max={3} step={0.05} value={p.contrast} onChange={(e) => set('contrast', +e.target.value)} aria-label="Heatmap contrast" />
            </label>
            <label className="slider bub" title={`Bubble size ${p.bubbleScale.toFixed(1)}×`}>
              <span className="bub-ico" aria-hidden="true" />
              <input type="range" min={0.4} max={6} step={0.1} value={p.bubbleScale} onChange={(e) => set('bubbleScale', +e.target.value)} aria-label="Bubble size" />
            </label>
            <div className="seg sm" aria-label="Order book">
              <button className={p.book === 'primary' ? 'on' : ''} onClick={() => set('book', 'primary')} title="Binance order book only">Binance</button>
              <button className={p.book === 'combined' ? 'on' : ''} onClick={() => set('book', 'combined')} title="Binance + Bybit + OKX books, basis-adjusted">All books</button>
            </div>
            <label className="sel">
              Min
              <select value={p.minBubble} onChange={(e) => set('minBubble', +e.target.value)}>
                {[0, 0.05, 0.2, 0.5, 1, 2, 5].map((v) => <option key={v} value={v}>{v} BTC</option>)}
              </select>
            </label>
            <label className="sel" title="Lower pane">
              <select value={p.bottom} onChange={(e) => set('bottom', e.target.value as BottomMode)}>
                {BOTTOM.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
        )}
        {showFoot && (
          <div className="group">
            <label className="sel">
              Bars
              <select value={p.tf} onChange={(e) => set('tf', +e.target.value)}>
                {[1, 3, 5, 15, 30, 60, 240].map((v) => <option key={v} value={v}>{v < 60 ? `${v}m` : `${v / 60}h`}</option>)}
              </select>
            </label>
            <label className="sel">
              Rows
              <select value={p.row} onChange={(e) => set('row', +e.target.value)}>
                <option value={0}>Auto</option>
                {[1, 2, 5, 10, 25, 50, 100, 250].map((v) => <option key={v} value={v}>${v}</option>)}
              </select>
            </label>
            <label className="sel">
              Show
              <select value={p.fpMode} onChange={(e) => set('fpMode', e.target.value as FpMode)}>
                {FP_MODES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
            <label className="sel">
              Source
              <select value={p.fpSrc} onChange={(e) => set('fpSrc', e.target.value as Prefs['fpSrc'])}>
                {SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          </div>
        )}
        {p.view === 'tpo' && (
          <div className="group">
            <label className="sel">
              Session
              <select value={p.tpoSession} onChange={(e) => set('tpoSession', e.target.value as TpoSession)}>
                {(Object.keys(TPO_SESSIONS) as TpoSession[]).map((k) => <option key={k} value={k}>{TPO_SESSIONS[k].label}</option>)}
              </select>
            </label>
            <label className="sel">
              Show
              <select value={p.tpoDays} onChange={(e) => set('tpoDays', +e.target.value)}>
                {[1, 2, 3, 5, 7, 10].map((v) => <option key={v} value={v}>{v} session{v > 1 ? 's' : ''}</option>)}
              </select>
            </label>
            <Toggle on={p.tpoSplit} onClick={() => set('tpoSplit', !p.tpoSplit)}>Split letters</Toggle>
            <Toggle on={p.tpoComposite} onClick={() => set('tpoComposite', !p.tpoComposite)}>Composite</Toggle>
          </div>
        )}
        {p.view !== 'tpo' && (
          <div className="group">
            <Toggle on={p.tool === 'range'} onClick={() => setTool(p.tool === 'range' ? 'none' : 'range')} title="Drag across the chart to build a fixed-range volume profile">Range profile</Toggle>
            <Toggle on={p.tool === 'avwap'} onClick={() => setTool(p.tool === 'avwap' ? 'none' : 'avwap')} title="Click the chart where the VWAP should start">Anchor VWAP</Toggle>
            <select className="bare" value="" onChange={(e) => anchorPreset(e.target.value)} aria-label="Anchor VWAP preset">
              <option value="" disabled>Anchor…</option>
              <option value="week">Weekly open</option>
              <option value="day">Daily open (UTC)</option>
              <option value="funding">Last funding</option>
              <option value="liq">Last big liquidation</option>
            </select>
            {nTools > 0 && <button className="tog" onClick={() => store.clearTools()}>Clear ({nTools})</button>}
          </div>
        )}
        <div className="grow" />
        <Layers p={p} set={set} />
      </div>
      <main className={`main ${p.view}`}>
        {showHeat && <section className="pane heat"><HeatmapView p={p} onTool={setTool} /></section>}
        {showFoot && <section className="pane foot"><FootprintView p={p} onTool={setTool} /></section>}
        {p.view === 'tpo' && <section className="pane foot"><TpoView p={p} /></section>}
        <p className="hint">
          {p.tool === 'range' ? 'Drag across the chart to build a range profile · Esc cancels'
            : p.tool === 'avwap' ? 'Click where the VWAP should start · Esc cancels'
              : 'Scroll: zoom time · Shift + scroll or drag the price axis: zoom price · Drag: pan · Double-click: live · Right-click a range or anchor: remove'}
        </p>
      </main>
      <SidePanel p={p} set={set} />
      <FrozenBar />
      <KickedOverlay />
    </div>
  )
}

function Layers({ p, set }: { p: Prefs; set: <K extends keyof Prefs>(k: K, v: Prefs[K]) => void }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ top: 98, left: 8 })
  const ref = useRef<HTMLDivElement>(null)
  const toggle = () => {
    const r = ref.current?.getBoundingClientRect()
    // open under the button, kept fully on screen whichever row of the toolbar the button wrapped to
    const w = Math.min(470, window.innerWidth - 16)
    if (r) setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) })
    setOpen(!open)
  }
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const T = ({ k, children }: { k: keyof Prefs; children: React.ReactNode }) => (
    <Toggle on={!!p[k]} onClick={() => set(k, !p[k] as any)}>{children}</Toggle>
  )
  return (
    <div className="layers" ref={ref}>
      <button className={`tog ${open ? 'on' : ''}`} aria-expanded={open} onClick={toggle}>Layers ▾</button>
      {open && (
        <div className="pop" role="dialog" aria-label="Chart layers" style={pos}>
          <section>
            <h4>Trades &amp; book</h4>
            <div className="row">
              <T k="bubbles">Trade bubbles</T>
              <T k="xPrints">Other venues' prints</T>
              <T k="bidAsk">Bid / ask</T>
              <T k="dom">Depth ladder</T>
            </div>
            <div className="row">
              <label className="sel">Pull / stack
                <select value={p.domWin} onChange={(e) => set('domWin', +e.target.value)}>
                  {[0, 5, 30, 60].map((v) => <option key={v} value={v}>{v ? `${v} s` : 'Off'}</option>)}
                </select>
              </label>
              <label className="sel">Big trade
                <select value={p.bigTrade} onChange={(e) => set('bigTrade', +e.target.value)}>
                  {[2, 5, 10, 20, 50, 100].map((v) => <option key={v} value={v}>{v} BTC</option>)}
                </select>
              </label>
            </div>
          </section>
          <section>
            <h4>Heatmap</h4>
            <div className="row">
              <label className="sel">Colours
                <select value={p.heatPalette} onChange={(e) => set('heatPalette', e.target.value as Prefs['heatPalette'])}>
                  <option value="classic">Classic (blue → red)</option>
                  <option value="thermal">Thermal (teal → white)</option>
                </select>
              </label>
              <label className="sel">Price rows
                <select value={p.heatRows} onChange={(e) => set('heatRows', +e.target.value)}>
                  <option value={0}>Auto</option>
                  {[1, 2, 5, 10, 20, 25, 50].map((v) => <option key={v} value={v}>${v}</option>)}
                </select>
              </label>
              <T k="heatGrid">Row lines + time grid</T>
            </div>
          </section>
          <section>
            <h4>Bubbles</h4>
            <div className="row">
              <div className="seg sm" aria-label="Bubble style">
                {([['3d', '3D'], ['flat', '2D dots'], ['pie', 'Buy/sell pie']] as const).map(([k, l]) => (
                  <button key={k} className={p.bubbleStyle === k ? 'on' : ''} onClick={() => set('bubbleStyle', k)}>{l}</button>
                ))}
              </div>
              <div className="seg sm" aria-label="Bubble size by">
                <button className={p.bubbleSizeBy === 'total' ? 'on' : ''} onClick={() => set('bubbleSizeBy', 'total')} title="Size = all traded BTC">Total volume</button>
                <button className={p.bubbleSizeBy === 'delta' ? 'on' : ''} onClick={() => set('bubbleSizeBy', 'delta')} title="Size = buy minus sell">Volume delta</button>
              </div>
            </div>
            <div className="row">
              <label className="sel">Grouping
                <select value={p.bubbleCluster} onChange={(e) => set('bubbleCluster', e.target.value as Prefs['bubbleCluster'])}>
                  <option value="smart">Smart</option>
                  <option value="1s">1 s</option>
                  <option value="5s">5 s</option>
                  <option value="15s">15 s</option>
                  <option value="60s">1 min</option>
                  <option value="off">Off (every price)</option>
                </select>
              </label>
              <label className="sel rng">Size
                <input type="range" min={0.4} max={6} step={0.1} value={p.bubbleScale} onChange={(e) => set('bubbleScale', +e.target.value)} aria-label="Bubble size" />
                <span className="val">{p.bubbleScale.toFixed(1)}×</span>
              </label>
              <label className="sel rng">Transparency
                <input type="range" min={0} max={0.9} step={0.05} value={p.bubbleAlpha} onChange={(e) => set('bubbleAlpha', +e.target.value)} aria-label="Bubble transparency" />
                <span className="val">{Math.round(p.bubbleAlpha * 100)}%</span>
              </label>
            </div>
          </section>
          <section>
            <h4>Events</h4>
            <div className="row">
              <T k="liqs">Liquidations + cascades</T>
              <T k="liqMap">Liquidation levels (model)</T>
              <T k="micro">Walls &amp; icebergs</T>
              <T k="absorption">Absorption</T>
            </div>
          </section>
          <section>
            <h4>Levels</h4>
            <div className="row">
              <T k="gamma">Gamma levels</T>
              <select className="bare" value={p.gammaGroup} onChange={(e) => set('gammaGroup', e.target.value as Prefs['gammaGroup'])} aria-label="Gamma expiries">
                <option value="all">All expiries</option>
                <option value="front">Next expiry</option>
                <option value="week">≤ 7 days</option>
                <option value="month">≤ 35 days</option>
              </select>
              <T k="basisAdjust">Shift to perp price</T>
            </div>
            <div className="row">
              <T k="levels">Prior sessions + naked POCs</T>
              <select className="bare" value={p.levelDays} onChange={(e) => set('levelDays', +e.target.value)} aria-label="Sessions back">
                {[1, 3, 5, 7].map((v) => <option key={v} value={v}>{v} day{v > 1 ? 's' : ''}</option>)}
              </select>
              <T k="devPoc">Developing POC</T>
            </div>
            <div className="row">
              <label className="sel">VWAP
                <select value={p.vwap} onChange={(e) => set('vwap', e.target.value as Prefs['vwap'])}>
                  <option value="off">Off</option>
                  <option value="day">Daily</option>
                  <option value="week">Weekly</option>
                </select>
              </label>
              <T k="vwapBands">±1/2/3σ bands</T>
            </div>
          </section>
          <section>
            <h4>Volume profile</h4>
            <div className="row">
              <T k="profile">Show</T>
              <select className="bare" value={p.profileRange} onChange={(e) => set('profileRange', e.target.value as ProfileRange)} aria-label="Profile range">
                <option value="session">Session (UTC)</option>
                <option value="prev">Prior day</option>
                <option value="4h">Last 4h</option>
                <option value="1h">Last 1h</option>
                <option value="visible">Visible</option>
                <option value="3d">3-day composite</option>
                <option value="7d">7-day composite</option>
              </select>
              <select className="bare" value={p.profileMode} onChange={(e) => set('profileMode', e.target.value as ProfileView)} aria-label="Profile type">
                <option value="volume">Volume</option>
                <option value="delta">Delta</option>
                <option value="liq">Liquidations</option>
                <option value="svp">Spot vs perps</option>
              </select>
              <select className="bare" value={p.profileSrc} onChange={(e) => set('profileSrc', e.target.value as Prefs['profileSrc'])} aria-label="Profile source" disabled={p.profileMode === 'svp'}>
                {SOURCES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
          </section>
          <section>
            <h4>Footprint</h4>
            <div className="row">
              <T k="stats">Bar statistics</T>
              <T k="zones">Zones (imbalances, unfinished, nPOC)</T>
              <T k="showPoc">Bar POC</T>
              <T k="showImb">Imbalances</T>
            </div>
            <div className="row">
              <label className="sel" title="Diagonal imbalance ratio">
              Imb.
                <select value={p.imbalance} onChange={(e) => set('imbalance', +e.target.value)}>
                {[1.5, 2, 3, 4, 5].map((v) => <option key={v} value={v}>{v * 100}%</option>)}
              </select>
            </label>
              <label className="sel" title="Dim cells smaller than this">
              Filter
                <select value={p.fpMin} onChange={(e) => set('fpMin', +e.target.value)}>
                {[0, 0.5, 1, 2, 5, 10].map((v) => <option key={v} value={v}>{v ? `≥ ${v}` : 'Off'}</option>)}
              </select>
            </label>
              <label className="sel" title="Highlight clusters at or above this size">
              Cluster
                <select value={p.cluster} onChange={(e) => set('cluster', +e.target.value)}>
                {[0, 5, 10, 25, 50, 100, 250].map((v) => <option key={v} value={v}>{v ? `≥ ${v} BTC` : 'Off'}</option>)}
              </select>
            </label>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export function Toggle({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button className={`tog ${on ? 'on' : ''}`} aria-pressed={on} onClick={onClick} title={title}>
      {children}
    </button>
  )
}
