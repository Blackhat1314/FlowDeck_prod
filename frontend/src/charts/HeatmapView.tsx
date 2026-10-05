import { useEffect, useRef, useState } from 'react'
import {
  drawDevPoc, drawGamma, drawProfile, drawRanges, drawSessionLevels, drawVwapLabels, drawVwaps, getProfile, Labeler,
  profileWindow, type Ax,
} from '../lib/overlays'
import type { Prefs, Tool } from '../lib/prefs'
import { store } from '../lib/store'
import type { Column } from '../lib/types'
import { C, CLASSIC_LUT, fmtPx, fmtQty, fmtTime, HEAT_LUT, niceStep, venueColor } from '../lib/util'

const SIDE_W = 74
const DOM_W = 150
const STRIP_W = 44
const BOTTOM_H = 132
const TIME_AXIS_H = 20
const LIQMAP_W = 96

interface View {
  follow: boolean
  tRight: number
  mpp: number // ms per px
  ppp: number // usd per px
  pCenter: number | null
  autoCenter: boolean
}

interface Bin {
  x: number
  b: number // primary buy / sell
  s: number
  pd: number // enabled perps delta
  sd: number // spot delta
  ven: Map<number, number>
  z: number[] // size classes b,s x3
  ll: number
  ls: number
  cvd: number
  cvdP: number
  cvdS: number
  cz: [number, number, number]
  oi: number
  prem: number
  px: number
}

export default function HeatmapView({ p, onTool }: { p: Prefs; onTool: (t: Tool) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const pRef = useRef(p)
  pRef.current = p
  const toolRef = useRef(onTool)
  toolRef.current = onTool
  const [live, setLive] = useState(true)
  const ctl = useRef<HeatController | null>(null)

  useEffect(() => {
    const c = new HeatController(root.current!, pRef, setLive, (t) => toolRef.current(t))
    ctl.current = c
    return () => c.destroy()
  }, [])

  useEffect(() => {
    ctl.current?.invalidate()
  }, [p])

  return (
    <div className={`hm ${p.tool !== 'none' ? 'tooling' : ''}`} ref={root}>
      {!live && (
        <button className="relive" onClick={() => ctl.current?.goLive()}>
          Back to live
        </button>
      )}
    </div>
  )
}

// =====================================================================================================
class HeatController {
  root: HTMLElement
  pRef: { current: Prefs }
  setLive: (b: boolean) => void
  setTool: (t: Tool) => void
  chart: HTMLDivElement
  layer: HTMLDivElement
  heat: HTMLCanvasElement
  over: HTMLCanvasElement
  stat: HTMLCanvasElement
  cross: HTMLCanvasElement
  side: HTMLCanvasElement
  bwrap: HTMLDivElement
  blayer: HTMLDivElement
  bottom: HTMLCanvasElement
  bside: HTMLCanvasElement
  v: View = { follow: true, tRight: 0, mpp: 160, ppp: 0.6, pCenter: null, autoCenter: true }
  W = 0
  H = 0
  sideW = 0
  extra = 0
  dpr = 1
  anchor = 0
  colsVer = -1
  toolsVer = -1
  dirty = true
  lastRender = 0
  raf = 0
  mouse: { x: number; y: number; inChart: boolean } | null = null
  drag: null | { x: number; y: number; t: number; p: number; mode: 'pan' | 'pzoom'; ppp: number } = null
  tdrag: null | { t0: number; t1: number } = null
  img: ImageData | null = null
  vals = new Float32Array(1)
  pref = new Float64Array(1)
  scratch = new Float32Array(1)
  rowB0 = new Int32Array(1)
  rowCache = new WeakMap<Column, { start: number; v: Float32Array }>()
  rowKey = ''
  palKey = ''
  clip = 0
  lo = 0
  curve: Uint32Array | null = null
  ro: ResizeObserver

  constructor(root: HTMLElement, pRef: { current: Prefs }, setLive: (b: boolean) => void, setTool: (t: Tool) => void) {
    this.root = root
    this.pRef = pRef
    this.setLive = setLive
    this.setTool = setTool
    const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement) => {
      const e = document.createElement(tag)
      e.className = cls
      parent.appendChild(e)
      return e
    }
    const top = mk('div', 'hm-top', root)
    this.chart = mk('div', 'hm-chart', top)
    this.layer = mk('div', 'hm-layer', this.chart)
    this.heat = mk('canvas', 'hm-heat', this.layer)
    this.over = mk('canvas', 'hm-over', this.layer)
    this.stat = mk('canvas', 'hm-stat', this.chart)
    this.cross = mk('canvas', 'hm-cross', this.chart)
    this.side = mk('canvas', 'hm-side', top)
    const bot = mk('div', 'hm-bot', root)
    this.bwrap = mk('div', 'hm-bchart', bot)
    this.blayer = mk('div', 'hm-layer', this.bwrap)
    this.bottom = mk('canvas', 'hm-bcanvas', this.blayer)
    this.bside = mk('canvas', 'hm-bside', bot)
    this.bwrap.style.height = `${BOTTOM_H}px`
    this.bside.style.height = `${BOTTOM_H}px`

    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(root)
    this.bindEvents()
    this.resize()
    const loop = () => {
      this.frame()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.root.innerHTML = ''
  }

  invalidate() {
    const p = this.pRef.current
    if (SIDE_W + (p.dom ? DOM_W : 0) !== this.sideW) this.resize()
    this.dirty = true
  }

  goLive() {
    this.v.follow = true
    this.v.autoCenter = true
    this.v.pCenter = null
    this.setLive(true)
    this.dirty = true
  }

  // ------------------------------------------------------------------------------------ layout
  resize() {
    const r = this.root.getBoundingClientRect()
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    const sideW = SIDE_W + (this.pRef.current.dom ? DOM_W : 0)
    this.sideW = sideW
    this.W = Math.max(50, Math.floor(r.width - sideW))
    this.H = Math.max(50, Math.floor(r.height - BOTTOM_H))
    this.chart.style.width = `${this.W}px`
    this.chart.style.height = `${this.H}px`
    this.side.style.width = `${sideW}px`
    this.side.style.height = `${this.H}px`
    this.bwrap.style.width = `${this.W}px`
    this.bside.style.width = `${sideW}px`
    this.setExtra(true)
    for (const c of [this.stat, this.cross]) this.size(c, this.W, this.H)
    this.size(this.side, sideW, this.H)
    this.size(this.bside, sideW, BOTTOM_H)
    this.dirty = true
  }

  setExtra(force = false) {
    const extra = Math.min(600, Math.ceil(700 / this.v.mpp) + 4)
    if (force || extra !== this.extra || this.heat.width !== this.W + extra || this.heat.height !== this.H) {
      this.extra = extra
      const w = this.W + extra
      this.heat.width = w
      this.heat.height = this.H
      this.heat.style.width = `${w}px`
      this.heat.style.height = `${this.H}px`
      this.size(this.over, w, this.H)
      this.size(this.bottom, w, BOTTOM_H)
      this.img = null
    }
  }

  size(c: HTMLCanvasElement, w: number, h: number) {
    c.width = Math.round(w * this.dpr)
    c.height = Math.round(h * this.dpr)
    c.style.width = `${w}px`
    c.style.height = `${h}px`
  }

  // ------------------------------------------------------------------------------------ coordinates
  pTop() {
    return (this.v.pCenter ?? 0) + (this.H / 2) * this.v.ppp
  }
  y(p: number) {
    return (this.pTop() - p) / this.v.ppp
  }
  pAt(y: number) {
    return this.pTop() - y * this.v.ppp
  }
  /** x in the scrolling layer */
  x(t: number) {
    return (t - this.anchor) / this.v.mpp + (this.W - 1)
  }
  shift() {
    return this.v.follow ? Math.max(0, (store.now() - this.anchor) / this.v.mpp) : 0
  }
  /** time under a screen x of the chart */
  tAt(sx: number) {
    return this.anchor + (sx + this.shift() - (this.W - 1)) * this.v.mpp
  }
  rangeRow() {
    return Math.max(store.config?.bucket ?? 1, niceStep(this.v.ppp * 3, 1))
  }

  // ------------------------------------------------------------------------------------ frame
  frame() {
    const cfg = store.config
    if (!cfg || !store.cols.length) {
      this.drawEmpty()
      return
    }
    const v = this.v
    const now = store.now()
    const last = store.last ?? store.cols[store.cols.length - 1].last
    if (v.pCenter == null && last) {
      v.pCenter = last
      this.dirty = true
    }
    if (v.autoCenter && last && v.pCenter != null) {
      const half = (this.H / 2) * v.ppp
      if (Math.abs(last - v.pCenter) > half * 0.6) {
        v.pCenter = last
        this.dirty = true
      }
    }
    const ver = store.version('cols')
    const tv = store.version('tools')
    const target = v.follow ? now : v.tRight
    const stale = v.follow && now - this.anchor > 450
    // zoomed far out a new 250 ms column moves the picture by less than a pixel: redraw about once per pixel
    const gap = v.mpp > 400 && !this.dirty && tv === this.toolsVer ? Math.min(1500, v.mpp) : 0
    const due = gap === 0 || performance.now() - this.lastRender >= gap
    if (this.dirty || tv !== this.toolsVer || ((ver !== this.colsVer || stale) && due)) {
      this.lastRender = performance.now()
      this.colsVer = ver
      this.toolsVer = tv
      this.dirty = false
      this.anchor = target
      this.renderHeat()
      this.renderOverlay()
      this.renderBottom()
      this.renderStatic()
      this.renderSide()
      this.renderCross()
    }
    const tf = `translate3d(${-this.shift()}px,0,0)`
    this.layer.style.transform = tf
    this.blayer.style.transform = tf
  }

  drawEmpty() {
    const g = this.stat.getContext('2d')!
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, this.W, this.H)
    g.fillStyle = C.dim
    g.font = '500 13px "IBM Plex Sans", system-ui'
    g.textAlign = 'center'
    const msg = store.conn === 'down' ? 'Server unreachable. Start it with start.bat, retrying…' : 'Waiting for the order book to sync…'
    g.fillText(msg, this.W / 2, this.H / 2)
  }

  // ------------------------------------------------------------------------------------ heat layer
  /** price-row size ($) of the heat layer: fixed, or auto (~12 px rows in classic, ~1 px in thermal) */
  heatRow(): number {
    const p = this.pRef.current
    const bu = store.config!.bucket
    if (p.heatRows > 0) return Math.max(bu, p.heatRows)
    const want = this.v.ppp * (p.heatPalette === 'classic' ? 10 : 1)
    for (const r of [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000]) if (r >= bu && r >= want - 1e-9) return r
    return 1000
  }

  /** resting size per price row for one column (cached: columns never change once received) */
  colRows(col: Column, per: number, combined: boolean): { start: number; v: Float32Array } {
    const hit = this.rowCache.get(col)
    if (hit) return hit
    let q = col.qty
    const n = q.length
    if (combined && col.cbIdx.length) {
      const m = new Float32Array(n)
      m.set(q)
      for (let k = 0; k < col.cbIdx.length; k++) {
        const i = col.cbIdx[k] - col.base
        if (i >= 0 && i < n) m[i] += col.cbQty[k]
      }
      q = m
    }
    let e: { start: number; v: Float32Array }
    if (per === 1) e = { start: col.base, v: q }
    else {
      const start = Math.floor(col.base / per)
      const v = new Float32Array(Math.floor((col.base + n - 1) / per) - start + 1)
      for (let i = 0; i < n; i++) v[Math.floor((col.base + i) / per) - start] += q[i]
      e = { start, v }
    }
    this.rowCache.set(col, e)
    return e
  }

  renderHeat() {
    const cfg = store.config!
    const p = this.pRef.current
    const classic = p.heatPalette === 'classic'
    const combined = p.book === 'combined'
    const cols = store.cols
    const W = this.W + this.extra
    const H = this.H
    const g = this.heat.getContext('2d')!
    if (!this.img || this.img.width !== W || this.img.height !== H) {
      this.img = g.createImageData(W, H)
      this.vals = new Float32Array(W * H)
      this.rowB0 = new Int32Array(H)
    }
    const vals = this.vals
    const bu = cfg.bucket
    const R = this.heatRow()
    const per = Math.max(1, Math.round(R / bu))
    const key = `${per}|${combined}`
    if (key !== this.rowKey) {
      this.rowKey = key
      this.rowCache = new WeakMap()
    }
    const ppp = this.v.ppp
    const mpp = this.v.mpp
    const pTop = this.pTop()
    const rows = this.rowB0
    for (let y = 0; y < H; y++) rows[y] = Math.floor(Math.floor((pTop - (y + 0.5) * ppp) / bu) / per)
    const ents: { start: number; v: Float32Array }[] = []
    let prevKey = -2
    for (let x = 0; x < W; x++) {
      const t = this.anchor + (x - (this.W - 1)) * mpp
      const a = store.colAt(t)
      if (a < 0 || (a === cols.length - 1 && t - cols[a].t > 30000 && x < this.W)) {
        for (let y = 0; y < H; y++) vals[y * W + x] = 0
        prevKey = -2
        continue
      }
      // several columns inside one pixel when zoomed out: average a few of them, so liquidity reads as steady bands
      const b = mpp > cfg.column_ms ? Math.max(a, store.colAt(t + mpp - 1)) : a
      const ck = a * 65536 + (b - a)
      if (ck === prevKey) {
        for (let y = 0; y < H; y++) vals[y * W + x] = vals[y * W + x - 1]
        continue
      }
      prevKey = ck
      const cnt = b - a + 1
      const ns = Math.min(6, cnt)
      ents.length = 0
      for (let k = 0; k < ns; k++) ents.push(this.colRows(cols[a + Math.floor(((k + 0.5) * cnt) / ns)], per, combined))
      let lastRow = NaN
      let lastV = 0
      for (let y = 0; y < H; y++) {
        const r = rows[y]
        if (r !== lastRow) {
          lastRow = r
          let sum = 0
          for (const e of ents) {
            const j = r - e.start
            if (j >= 0 && j < e.v.length) sum += e.v[j]
          }
          lastV = sum / ns
        }
        vals[y * W + x] = lastV
      }
    }
    // adaptive normalisation on a log scale: typical rows stay dark/blue, walls run through yellow to red
    const sample: number[] = []
    const step = Math.max(1, Math.floor((W * H) / 6000)) | 1
    for (let i = 0; i < W * H; i += step) if (vals[i] > 0) sample.push(vals[i])
    if (sample.length > 20) {
      sample.sort((a, b) => a - b)
      const q = (f: number) => sample[Math.min(sample.length - 1, Math.floor(sample.length * f))]
      // classic: anchor on the typical (median) row, so normal liquidity stays blue and only outliers run yellow → red
      const hi = (classic ? Math.max(q(0.97), q(0.5) * 4) : q(0.995)) / Math.max(0.15, p.contrast)
      const lo = classic ? Math.max(q(0.5) * 0.35, hi * 0.004) : Math.max(q(0.5) * 0.3, hi * 0.002)
      this.clip = this.clip > 0 && this.palKey === key + p.heatPalette ? this.clip * 0.5 + hi * 0.5 : hi
      this.lo = this.lo > 0 && this.palKey === key + p.heatPalette ? this.lo * 0.5 + lo * 0.5 : lo
      this.palKey = key + p.heatPalette
    }
    const hi = this.clip
    const lo = Math.min(this.lo, hi * 0.5)
    const L = classic ? CLASSIC_LUT : HEAT_LUT
    const top = L.length - 1
    const N = 4095
    if (!this.curve) this.curve = new Uint32Array(N + 1)
    const lr = Math.log(hi / lo)
    for (let j = 0; j <= N; j++) {
      const v = (j / N) * hi
      const tt = v <= lo ? 0 : Math.log(v / lo) / lr
      this.curve[j] = L[Math.min(top, (tt * top) | 0)]
    }
    const cv = this.curve
    const inv = N / hi
    const u32 = new Uint32Array(this.img.data.buffer)
    for (let i = 0; i < W * H; i++) {
      const j = vals[i] * inv
      u32[i] = j >= N ? cv[N] : cv[j | 0]
    }
    // thin dark separator on the top pixel of every price row (rows of 5 px or more)
    if (p.heatGrid && R / ppp >= 5) {
      for (let y = 1; y < H; y++) {
        if (rows[y] === rows[y - 1]) continue
        const o = y * W
        for (let x = 0; x < W; x++) {
          const c = u32[o + x]
          const r = ((c & 255) * 0.5) | 0
          const gg = (((c >>> 8) & 255) * 0.5) | 0
          const bb = (((c >>> 16) & 255) * 0.5) | 0
          u32[o + x] = (255 << 24) | (bb << 16) | (gg << 8) | r
        }
      }
    }
    g.putImageData(this.img, 0, 0)
  }

  visibleRange(): [number, number] {
    const t0 = this.anchor - (this.W - 1) * this.v.mpp
    const t1 = this.anchor + this.extra * this.v.mpp
    return [t0, t1]
  }

  // ------------------------------------------------------------------------------------ overlay (time layer)
  renderOverlay() {
    const s = this.pRef.current
    const cfg = store.config!
    const g = this.over.getContext('2d')!
    const W = this.W + this.extra
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, W, this.H)
    const cols = store.cols
    const [t0] = this.visibleRange()
    const i0 = Math.max(0, store.colAt(t0))
    const i1 = cols.length - 1
    const mpp = this.v.mpp
    const bu = cfg.bucket
    const ax: Ax = { W, H: this.H, y: (q) => this.y(q), xt: (t) => this.x(t) }

    // dotted time grid (same steps as the time axis)
    if (s.heatGrid) {
      const stepS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((v) => (v * 1000) / mpp > 90) ?? 3600
      const [ta, tb] = this.visibleRange()
      g.strokeStyle = 'rgba(214,224,236,0.5)'
      g.lineWidth = 1
      g.setLineDash([2, 3])
      g.beginPath()
      for (let t = Math.ceil(ta / (stepS * 1000)) * stepS * 1000; t < tb; t += stepS * 1000) {
        const xx = Math.round(this.x(t)) + 0.5
        g.moveTo(xx, 0)
        g.lineTo(xx, this.H)
      }
      g.stroke()
      g.setLineDash([])
    }

    // time-based levels: VWAP + bands, anchored VWAPs, developing POC, user ranges
    drawVwaps(g, ax, s, null)
    drawDevPoc(g, ax, s)
    drawRanges(g, ax, this.rangeRow())

    // liquidation cascades: shaded price band over the 30 s window that triggered them
    if (s.liqs) {
      g.font = '600 10.5px "IBM Plex Sans Condensed", system-ui'
      for (const e of store.xev) {
        if (e.type !== 'cascade' || e.t < t0 - 60_000 || e.lo == null || e.hi == null) continue
        const xa = this.x(e.t - 30_000)
        const xb = this.x(e.t)
        const ya = this.y(e.hi + bu)
        const yb = this.y(e.lo - bu)
        const long = e.side === 'long'
        g.fillStyle = long ? 'rgba(255,159,67,0.13)' : 'rgba(90,209,255,0.13)'
        g.fillRect(xa, ya, xb - xa, yb - ya)
        g.strokeStyle = long ? C.orange : C.cyan
        g.lineWidth = 1
        g.strokeRect(xa + 0.5, ya + 0.5, xb - xa, yb - ya)
        g.fillStyle = long ? C.orange : C.cyan
        g.textAlign = 'left'
        g.textBaseline = 'bottom'
        g.fillText(`${long ? 'Long' : 'Short'} liq cascade ${fmtQty(e.btc ?? 0, 0)} BTC`, xa, ya - 2)
      }
    }

    // best bid / ask
    if (s.bidAsk) {
      const stride = Math.max(1, Math.floor(mpp / cfg.column_ms / 1.5))
      const classic = s.heatPalette === 'classic'
      for (const [key, color] of [['bb', classic ? '#35e89a' : 'rgba(43,217,159,0.9)'], ['ba', classic ? '#ff4f4f' : 'rgba(255,92,122,0.9)']] as const) {
        g.beginPath()
        let prevY = 0
        for (let i = i0; i <= i1; i += stride) {
          const c = cols[i]
          const xx = this.x(c.t)
          const yy = this.y(c[key])
          if (i === i0) g.moveTo(xx, yy)
          else {
            g.lineTo(xx, prevY)
            g.lineTo(xx, yy)
          }
          prevY = yy
        }
        g.lineTo(W, prevY)
        g.strokeStyle = color
        g.lineWidth = classic ? 2 : 1.25
        g.stroke()
      }
    }

    // trade bubbles (primary, plus other perps' prints basis-adjusted onto this book)
    if (s.bubbles) this.drawBubbles(g, i0, i1)

    // big sweeps (reconstructed taker orders) on every enabled venue
    const labels: [number, number, number, number][] = []
    const putLabel = (txt: string, lx: number, yy: number, color: string) => {
      const lw = g.measureText(txt).width
      if (labels.some(([a, b, c, d]) => lx < c && lx + lw > a && yy - 6 < d && yy + 6 > b)) return
      g.fillStyle = color
      g.textAlign = 'left'
      g.fillText(txt, lx, yy)
      labels.push([lx, yy - 6, lx + lw, yy + 6])
    }
    g.font = '600 11px "IBM Plex Sans Condensed", system-ui'
    g.textBaseline = 'middle'
    const px = cfg.primary_x
    for (let i = store.sweeps.length - 1; i >= 0; i--) {
      const sw = store.sweeps[i]
      if (sw.lt < t0 - 2000) break
      if (sw.q < s.bigTrade || sw.bf) continue
      const other = sw.x != null && sw.x !== px
      if (other && (!s.xPrints || s.venOff.includes(sw.x!))) continue
      const isSpot = other && store.spotIds.has(sw.x!)
      const pp = other ? sw.pa ?? sw.p : sw.p
      const xx = this.x(sw.lt)
      const yy = this.y(pp)
      const r = Math.min(30, 5 + Math.sqrt(sw.q) * 2.4)
      g.beginPath()
      g.arc(xx, yy, r, 0, Math.PI * 2)
      const quiet = s.bubbles && s.bubbleStyle !== 'pie' // with shaded bubbles keep big-order rings light
      g.lineWidth = quiet ? 1.25 : 2
      g.strokeStyle = sw.s > 0 ? C.buy : C.sell
      g.fillStyle = sw.s > 0 ? 'rgba(43,217,159,0.18)' : 'rgba(255,92,122,0.18)'
      if (isSpot) g.setLineDash([3, 2])
      if (!quiet) g.fill()
      g.stroke()
      g.setLineDash([])
      if (!other && sw.hi - sw.lo >= bu) {
        g.beginPath()
        g.moveTo(xx, this.y(sw.lo))
        g.lineTo(xx, this.y(sw.hi))
        g.strokeStyle = 'rgba(255,255,255,0.55)'
        g.lineWidth = 1
        g.stroke()
      }
      const ven = other ? store.venue(sw.x)?.label ?? '' : ''
      putLabel(`${fmtQty(sw.q, sw.q >= 100 ? 0 : 1)}${ven ? ` ${ven}` : ''}`, xx + r + 3, yy, other ? venueColor(sw.x) : '#fff')
    }

    // liquidations from every venue (basis-adjusted)
    if (s.liqs) {
      g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
      for (let i = store.liqs.length - 1; i >= 0; i--) {
        const l = store.liqs[i]
        if (l.lt < t0 - 2000) break
        if (l.x != null && s.venOff.includes(l.x)) continue
        const xx = this.x(l.lt)
        const yy = this.y(l.p - store.basis(l.x))
        const r = Math.min(16, 3 + Math.sqrt(l.q) * 2)
        g.save()
        g.translate(xx, yy)
        g.rotate(Math.PI / 4)
        g.fillStyle = l.side === 'long' ? C.orange : C.cyan
        g.strokeStyle = '#08111c'
        g.lineWidth = 1
        g.fillRect(-r / 2, -r / 2, r, r)
        g.strokeRect(-r / 2, -r / 2, r, r)
        g.restore()
        if (l.q >= Math.max(2, s.bigTrade / 2)) {
          putLabel(`${fmtQty(l.q, 1)} ${store.venue(l.x)?.label ?? ''}`, xx + r / 2 + 4, yy, l.side === 'long' ? C.orange : C.cyan)
        }
      }
    }

    // absorption
    if (s.absorption) {
      g.font = '600 10.5px "IBM Plex Sans Condensed", system-ui'
      for (let i = store.abs.length - 1; i >= 0; i--) {
        const a = store.abs[i]
        if (a.t < t0 - 60000) break
        const xx = this.x(a.t)
        const yy = this.y(a.p)
        const up = a.side === 'bid'
        g.beginPath()
        g.moveTo(xx - 6, yy)
        g.lineTo(Math.min(W, xx + 90), yy)
        g.strokeStyle = 'rgba(180,156,255,0.7)'
        g.lineWidth = 2
        g.setLineDash([4, 3])
        g.stroke()
        g.setLineDash([])
        g.beginPath()
        const d = up ? 1 : -1
        g.moveTo(xx, yy + d * 3)
        g.lineTo(xx - 7, yy + d * 14)
        g.lineTo(xx + 7, yy + d * 14)
        g.closePath()
        g.fillStyle = C.violet
        g.fill()
        g.textAlign = 'left'
        g.textBaseline = 'middle'
        g.fillText(`absorb ${fmtQty(a.vol, 1)}`, xx + 9, yy + d * 11)
      }
    }

    // walls pulled / filled and icebergs (order-book microstructure)
    if (s.micro) {
      g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
      g.textBaseline = 'middle'
      for (let i = store.micro.length - 1; i >= 0; i--) {
        const e = store.micro[i]
        if (e.t < t0 - 2000) break
        const xx = this.x(e.t)
        const yy = this.y(e.p)
        if (yy < -10 || yy > this.H + 10) continue
        if (e.type === 'pulled') {
          const r = Math.min(9, 3 + Math.sqrt(e.cancelled ?? 0) * 0.6)
          g.strokeStyle = C.amber
          g.lineWidth = 2
          g.beginPath()
          g.moveTo(xx - r, yy - r)
          g.lineTo(xx + r, yy + r)
          g.moveTo(xx + r, yy - r)
          g.lineTo(xx - r, yy + r)
          g.stroke()
          if ((e.cancelled ?? 0) >= 2 * (store.walls?.thr ?? 15)) putLabel(`pulled ${fmtQty(e.cancelled ?? 0, 0)}`, xx + 8, yy, C.amber)
        } else if (e.type === 'eaten') {
          g.fillStyle = e.side === 'bid' ? C.sell : C.buy
          g.fillRect(xx - 4, yy - 4, 8, 8)
          g.strokeStyle = '#08111c'
          g.strokeRect(xx - 4, yy - 4, 8, 8)
          putLabel(`wall filled ${fmtQty(e.filled ?? 0, 0)}`, xx + 8, yy, e.side === 'bid' ? '#ff9db0' : '#8ff5cf')
        } else {
          g.save()
          g.translate(xx, yy)
          g.rotate(Math.PI / 4)
          g.strokeStyle = '#7fe7ff'
          g.lineWidth = 2
          g.strokeRect(-5, -5, 10, 10)
          g.restore()
          putLabel(`iceberg ${fmtQty(e.exec ?? 0, 0)} (${fmtQty(e.hidden ?? 0, 0)} hidden)`, xx + 9, yy, '#7fe7ff')
        }
      }
    }
  }

  /**
   * Trade bubbles. Grouping: "off" = one bubble per $ step per column (binned when zoomed out);
   * "smart" = ~48 px time slots; fixed windows = 1 s … 1 min. Inside a slot trades are split into price bands
   * (~30–48 px) so bubbles stay on the price path; each bubble sits at the volume-weighted time and price.
   */
  drawBubbles(g: CanvasRenderingContext2D, i0: number, i1: number) {
    const s = this.pRef.current
    const cfg = store.config!
    const cols = store.cols
    const bu = cfg.bucket
    const mpp = this.v.mpp
    type Bub = [number, number, number, number] // buy, sell, x, y
    const out: Bub[] = []
    if (s.bubbleCluster === 'off') {
      const binPx = mpp > cfg.column_ms ? 4 : 0
      const bins = new Map<number, Bub>()
      const add = (i: number, xx: number, idx: number, b: number, sl: number) => {
        const yy = this.y((idx + 0.5) * bu)
        if (yy < -30 || yy > this.H + 30) return
        const bx = binPx ? Math.floor(xx / binPx) : xx
        const by = Math.round(yy / 3)
        const key = binPx ? bx * 100000 + by : i * 100000 + by
        const e = bins.get(key)
        if (e) {
          e[0] += b
          e[1] += sl
        } else bins.set(key, [b, sl, binPx ? (bx + 0.5) * binPx : xx, yy])
      }
      for (let i = i0; i <= i1; i++) {
        const c = cols[i]
        const xx = this.x(c.t)
        for (let k = 0; k < c.trIdx.length; k++) add(i, xx, c.trIdx[k], c.trBuy[k], c.trSell[k])
        if (s.xPrints) for (let k = 0; k < c.xtIdx.length; k++) add(i, xx, c.xtIdx[k], c.xtBuy[k], c.xtSell[k])
      }
      out.push(...bins.values())
    } else {
      const win = { smart: 0, '1s': 1000, '5s': 5000, '15s': 15000, '60s': 60000 }[s.bubbleCluster]
      const slot = Math.max(cfg.column_ms, win || mpp * 48)
      const band = Math.max(bu, this.v.ppp * (win ? 30 : 48))
      const bins = new Map<number, [number, number, number, number]>() // buy, sell, Σ t·v, Σ p·v
      const add = (t: number, idx: number, b: number, sl: number) => {
        const v = b + sl
        if (v <= 0) return
        const pr = (idx + 0.5) * bu
        const key = Math.floor(t / slot) * 1e6 + Math.floor(pr / band)
        const e = bins.get(key)
        if (e) {
          e[0] += b
          e[1] += sl
          e[2] += t * v
          e[3] += pr * v
        } else bins.set(key, [b, sl, t * v, pr * v])
      }
      for (let i = i0; i <= i1; i++) {
        const c = cols[i]
        for (let k = 0; k < c.trIdx.length; k++) add(c.t, c.trIdx[k], c.trBuy[k], c.trSell[k])
        if (s.xPrints) for (let k = 0; k < c.xtIdx.length; k++) add(c.t, c.xtIdx[k], c.xtBuy[k], c.xtSell[k])
      }
      for (const [b, sl, tv, pv] of bins.values()) {
        const v = b + sl
        const yy = this.y(pv / v)
        if (yy < -60 || yy > this.H + 60) continue
        out.push([b, sl, this.x(tv / v), yy])
      }
    }
    const byDelta = s.bubbleSizeBy === 'delta'
    const size = (e: Bub) => (byDelta ? Math.abs(e[0] - e[1]) : e[0] + e[1])
    const list = out.filter((e) => size(e) > 0 && size(e) >= s.minBubble)
    const k = s.bubbleScale
    const grouped = s.bubbleCluster !== 'off'
    const maxR = grouped ? 90 : 34
    const alpha = Math.max(0.1, 1 - s.bubbleAlpha)
    // biggest first, so small bubbles stay visible on top
    list.sort((a, b) => size(b) - size(a))
    for (const e of list) {
      const [b, sl, xx, yy] = e
      const r = Math.min(maxR, 1.6 + Math.sqrt(size(e)) * k)
      if (s.bubbleStyle === 'pie') {
        this.pie(g, xx, yy, r, b / (b + sl), alpha)
        continue
      }
      const rgb: [number, number, number] = b >= sl ? [52, 208, 130] : [226, 74, 64]
      if (s.bubbleStyle === '3d' && r >= 3) this.sphere(g, xx, yy, r, rgb, alpha)
      else {
        g.beginPath()
        g.arc(xx, yy, r, 0, Math.PI * 2)
        g.fillStyle = `rgba(${rgb.join(',')},${alpha})`
        g.fill()
        if (r > 5) {
          g.strokeStyle = `rgba(${rgb.map((c) => Math.round(c * 0.45)).join(',')},${Math.min(1, alpha + 0.2)})`
          g.lineWidth = 1
          g.stroke()
        }
      }
    }
  }

  /** shaded ball: light from the upper left, darker rim */
  sphere(g: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: [number, number, number], alpha: number) {
    const lit = rgb.map((c) => Math.round(c + (255 - c) * 0.6)).join(',')
    const mid = rgb.join(',')
    const dark = rgb.map((c) => Math.round(c * 0.42)).join(',')
    const grad = g.createRadialGradient(x - r * 0.38, y - r * 0.42, r * 0.06, x, y, r)
    grad.addColorStop(0, `rgba(${lit},${alpha})`)
    grad.addColorStop(0.5, `rgba(${mid},${alpha})`)
    grad.addColorStop(1, `rgba(${dark},${alpha})`)
    g.beginPath()
    g.arc(x, y, r, 0, Math.PI * 2)
    g.fillStyle = grad
    g.fill()
    if (r > 8) {
      g.strokeStyle = `rgba(${dark},${Math.min(1, alpha + 0.15)})`
      g.lineWidth = 1
      g.stroke()
    }
  }

  /** buy / sell split as a pie (green clockwise from the top) */
  pie(g: CanvasRenderingContext2D, x: number, y: number, r: number, fb: number, alpha: number) {
    const gr = `rgba(43,217,159,${alpha})`
    const rd = `rgba(255,92,122,${alpha})`
    if (fb > 0.97 || fb < 0.03) {
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.fillStyle = fb > 0.5 ? gr : rd
      g.fill()
    } else {
      const a = -Math.PI / 2
      g.beginPath()
      g.moveTo(x, y)
      g.arc(x, y, r, a, a + fb * Math.PI * 2)
      g.closePath()
      g.fillStyle = gr
      g.fill()
      g.beginPath()
      g.moveTo(x, y)
      g.arc(x, y, r, a + fb * Math.PI * 2, a + Math.PI * 2)
      g.closePath()
      g.fillStyle = rd
      g.fill()
    }
    if (r > 6) {
      g.beginPath()
      g.arc(x, y, r, 0, Math.PI * 2)
      g.strokeStyle = 'rgba(8,17,28,0.55)'
      g.lineWidth = 1
      g.stroke()
    }
  }

  // ------------------------------------------------------------------------------------ static overlay
  renderStatic() {
    const s = this.pRef.current
    const cfg = store.config!
    const g = this.stat.getContext('2d')!
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, this.W, this.H)
    const ax: Ax = { W: this.W, H: this.H, y: (q) => this.y(q), xt: (t) => this.x(t) - this.shift() }
    // price grid
    const range = this.H * this.v.ppp
    const step = niceStep(range, this.H / 70)
    const pBot = this.pAt(this.H)
    g.strokeStyle = C.grid
    g.lineWidth = 1
    for (let p = Math.ceil(pBot / step) * step; p < this.pTop(); p += step) {
      const yy = Math.round(this.y(p)) + 0.5
      g.beginPath()
      g.moveTo(0, yy)
      g.lineTo(this.W, yy)
      g.stroke()
    }

    // volume profile (left)
    if (s.profile) {
      const vr = this.visibleRange()
      const [t0, t1] = profileWindow(s.profileRange, [vr[0] - (vr[0] % 60000), vr[1]])
      const rowUsd = Math.max(cfg.bucket, niceStep(this.v.ppp * 3, 1))
      const pr = getProfile('heat', t0, t1, rowUsd, s.profileSrc, s.profileMode)
      const maxW = Math.min(150, this.W * 0.16)
      const grad = g.createLinearGradient(0, 0, maxW + 40, 0)
      grad.addColorStop(0, 'rgba(8,17,28,0.78)')
      grad.addColorStop(1, 'rgba(8,17,28,0)')
      g.fillStyle = grad
      g.fillRect(0, 0, maxW + 40, this.H)
      drawProfile(g, ax, pr, s.profileMode, 0, maxW, 1, { labels: true })
    }

    // liquidation-level model (right edge)
    if (s.liqMap && store.liqmap) this.drawLiqMap(g)

    // horizontal levels with shared label placement
    const lab = new Labeler(g)
    drawSessionLevels(g, ax, s, lab)
    drawGamma(g, ax, s, lab)
    drawVwapLabels(ax, s, lab)

    // live walls: short bright ticks at the right edge
    if (s.micro && store.walls) {
      g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
      g.textBaseline = 'middle'
      g.textAlign = 'right'
      for (const w of store.walls.walls) {
        const yy = Math.round(this.y(w.p)) + 0.5
        if (yy < 0 || yy > this.H) continue
        g.strokeStyle = w.side === 'bid' ? 'rgba(43,217,159,0.95)' : 'rgba(255,92,122,0.95)'
        g.lineWidth = 2
        g.beginPath()
        g.moveTo(this.W - 46, yy)
        g.lineTo(this.W, yy)
        g.stroke()
        g.fillStyle = '#fff'
        g.fillText(`W ${fmtQty(w.q, 0)}`, this.W - 50, yy)
      }
    }

    // last price line
    const last = store.last
    if (last != null) {
      const yy = Math.round(this.y(last)) + 0.5
      g.strokeStyle = store.lastDir > 0 ? 'rgba(43,217,159,0.6)' : 'rgba(255,92,122,0.6)'
      g.setLineDash([1, 3])
      g.beginPath()
      g.moveTo(0, yy)
      g.lineTo(this.W, yy)
      g.stroke()
      g.setLineDash([])
    }

    // badge: book source
    g.font = '500 10.5px "IBM Plex Sans", system-ui'
    g.textAlign = 'right'
    g.textBaseline = 'top'
    g.fillStyle = C.faint
    const books = s.book === 'combined'
      ? `Book: ${[store.venue(cfg.primary_x)?.label, ...Object.entries(store.health?.xbooks ?? {}).filter(([, b]) => b.ok).map(([k]) => k)].filter(Boolean).join(' + ')}`
      : `Book: ${store.venue(cfg.primary_x)?.name ?? cfg.exchange}`
    g.fillText(books, this.W - (s.liqMap ? LIQMAP_W + 8 : 8), 6)
  }

  drawLiqMap(g: CanvasRenderingContext2D) {
    const lm = store.liqmap!
    const x1 = this.W
    const pBot = this.pAt(this.H)
    const pTop = this.pTop()
    let max = 0
    for (const arr of [lm.long, lm.short]) for (const [p, v] of arr) if (p >= pBot && p <= pTop && v > max) max = v
    if (max <= 0) return
    const rh = Math.max(1, lm.bucket / this.v.ppp - (lm.bucket / this.v.ppp > 3 ? 1 : 0))
    const grad = g.createLinearGradient(x1 - LIQMAP_W - 30, 0, x1, 0)
    grad.addColorStop(0, 'rgba(8,17,28,0)')
    grad.addColorStop(1, 'rgba(8,17,28,0.7)')
    g.fillStyle = grad
    g.fillRect(x1 - LIQMAP_W - 30, 0, LIQMAP_W + 30, this.H)
    for (const [arr, color] of [[lm.long, '255,159,67'], [lm.short, '90,209,255']] as const) {
      for (const [p, v] of arr) {
        if (p < pBot - lm.bucket || p > pTop) continue
        const w = Math.sqrt(v / max) * LIQMAP_W
        const y0 = this.y(p + lm.bucket)
        g.fillStyle = `rgba(${color},${(0.25 + 0.6 * (v / max)).toFixed(3)})`
        g.fillRect(x1 - w, y0, w, rh)
      }
    }
    g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
    g.textBaseline = 'middle'
    g.textAlign = 'right'
    for (const [arr, color] of [[lm.top_long, C.orange], [lm.top_short, C.cyan]] as const) {
      for (const lv of arr) {
        const yy = Math.round(this.y(lv.p)) + 0.5
        if (yy < 8 || yy > this.H - 8) continue
        g.strokeStyle = color
        g.setLineDash([2, 3])
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(x1 - LIQMAP_W - 60, yy)
        g.lineTo(x1, yy)
        g.stroke()
        g.setLineDash([])
        g.fillStyle = color
        g.fillText(`liq ~${fmtQty(lv.btc, 0)}`, x1 - LIQMAP_W - 64, yy)
      }
    }
    g.fillStyle = C.faint
    g.textAlign = 'right'
    g.textBaseline = 'bottom'
    g.fillText('Liq levels (model)', x1 - 6, this.H - 4)
  }

  // ------------------------------------------------------------------------------------ side: axis + pull/stack + DOM
  renderSide() {
    const s = this.pRef.current
    const cfg = store.config!
    const g = this.side.getContext('2d')!
    const w = this.sideW
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, w, this.H)
    g.fillStyle = C.panel
    g.fillRect(0, 0, w, this.H)
    if (s.dom && store.cols.length) {
      const col = store.cols[store.cols.length - 1]
      const bu = cfg.bucket
      // ladder rows line up with the heatmap's price rows when those are tall enough to read
      const hr = this.heatRow()
      const rowUsd = hr / this.v.ppp >= 6 ? hr : Math.max(bu, niceStep(this.v.ppp * 4, 1))
      const per = Math.round(rowUsd / bu)
      const startB = Math.floor(this.pAt(this.H) / rowUsd) * per
      const endB = Math.ceil(this.pTop() / rowUsd) * per
      const combined = s.book === 'combined'
      const cb = new Map<number, number>()
      if (combined) for (let k = 0; k < col.cbIdx.length; k++) cb.set(col.cbIdx[k], col.cbQty[k])
      const rows: [number, number, boolean][] = []
      let max = 0
      for (let b = startB; b <= endB; b += per) {
        let q = 0
        for (let k = 0; k < per; k++) {
          const i = b + k - col.base
          if (i >= 0 && i < col.qty.length) q += col.qty[i]
          if (combined) q += cb.get(b + k) ?? 0
        }
        if (q <= 0) continue
        const p = b * bu
        rows.push([p, q, p + rowUsd / 2 < (col.bb + col.ba) / 2])
        if (q > max) max = q
      }
      const strip = s.domWin > 0 && store.dom ? STRIP_W : 0
      const x0 = SIDE_W + strip
      const lw = DOM_W - strip
      const rh = rowUsd / this.v.ppp
      g.font = '500 10px "IBM Plex Sans Condensed", system-ui'
      g.textBaseline = 'middle'
      g.textAlign = 'right'
      const wallRows = new Set<number>()
      if (!combined) for (const w of store.walls?.walls ?? []) wallRows.add(Math.floor((w.p + 1e-9) / rowUsd))
      for (const [p, q, isBid] of rows) {
        const y0 = this.y(p + rowUsd)
        const bw = Math.max(1, Math.sqrt(q / max) * (lw - 8))
        g.fillStyle = isBid ? 'rgba(43,217,159,0.35)' : 'rgba(255,92,122,0.35)'
        g.fillRect(x0 + 2, y0 + 0.5, bw, Math.max(1, rh - 1))
        if (wallRows.has(Math.round(p / rowUsd))) {
          g.strokeStyle = C.amber
          g.lineWidth = 1
          g.strokeRect(x0 + 2.5, y0 + 1, lw - 5, Math.max(1, rh - 2))
        }
        if (rh >= 11 && q >= max * 0.04) {
          g.fillStyle = q >= max * 0.5 ? '#fff' : C.text
          g.fillText(fmtQty(q, q >= 100 ? 0 : 1), x0 + lw - 4, y0 + rh / 2)
        }
      }
      if (strip) this.drawPullStack(g, rowUsd)
      g.strokeStyle = C.line
      g.beginPath()
      g.moveTo(x0 + 0.5, 0)
      g.lineTo(x0 + 0.5, this.H)
      g.moveTo(SIDE_W + 0.5, 0)
      g.lineTo(SIDE_W + 0.5, this.H)
      g.stroke()
    }
    // price labels
    const range = this.H * this.v.ppp
    const step = niceStep(range, this.H / 70)
    const pBot = this.pAt(this.H)
    g.fillStyle = C.dim
    g.font = '500 11px "IBM Plex Sans", system-ui'
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    const dec = step < 1 ? 1 : 0
    for (let p = Math.ceil(pBot / step) * step; p < this.pTop(); p += step) g.fillText(fmtPx(p, dec), 8, this.y(p))
    const tag = (p: number | null | undefined, bg: string, fg: string) => {
      if (p == null) return
      const yy = this.y(p)
      if (yy < -10 || yy > this.H + 10) return
      g.fillStyle = bg
      g.fillRect(1, yy - 9, SIDE_W - 2, 18)
      g.fillStyle = fg
      g.font = '600 11px "IBM Plex Sans", system-ui'
      g.fillText(fmtPx(p, 1), 6, yy + 0.5)
    }
    if (store.bb != null && s.bidAsk) tag(store.bb, 'rgba(43,217,159,0.20)', C.buy)
    if (store.ba != null && s.bidAsk) tag(store.ba, 'rgba(255,92,122,0.20)', C.sell)
    tag(store.last, store.lastDir > 0 ? C.buy : C.sell, '#06101a')
    g.strokeStyle = C.line
    g.beginPath()
    g.moveTo(0.5, 0)
    g.lineTo(0.5, this.H)
    g.stroke()
  }

  /** net liquidity added (stacking, green →) or cancelled (pulling, red ←) per row over the chosen window */
  drawPullStack(g: CanvasRenderingContext2D, rowUsd: number) {
    const s = this.pRef.current
    const dom = store.dom!
    const wi = dom.windows.indexOf(s.domWin)
    if (wi < 0) return
    const off = 3 + wi * 4
    const agg = new Map<number, [number, number]>() // row -> [net stack, fills]
    for (const r of dom.rows) {
      const k = Math.floor((r[0] * dom.bucket + 1e-9) / rowUsd)
      const e = agg.get(k) ?? [0, 0]
      e[0] += r[off] + r[off + 2]
      e[1] += r[off + 1] + r[off + 3]
      agg.set(k, e)
    }
    let max = 0
    for (const e of agg.values()) max = Math.max(max, Math.abs(e[0]))
    if (max <= 0) return
    const x0 = SIDE_W
    const mid = x0 + STRIP_W / 2
    const rh = rowUsd / this.v.ppp
    g.fillStyle = 'rgba(8,17,28,0.5)'
    g.fillRect(x0, 0, STRIP_W, this.H)
    for (const [k, [net]] of agg) {
      const y0 = this.y((k + 1) * rowUsd)
      if (y0 > this.H || y0 + rh < 0) continue
      const w = (Math.abs(net) / max) * (STRIP_W / 2 - 2)
      g.fillStyle = net >= 0 ? 'rgba(43,217,159,0.8)' : 'rgba(255,92,122,0.8)'
      if (net >= 0) g.fillRect(mid, y0 + 0.5, w, Math.max(1, rh - 1))
      else g.fillRect(mid - w, y0 + 0.5, w, Math.max(1, rh - 1))
    }
    g.fillStyle = C.faint
    g.font = '500 9.5px "IBM Plex Sans Condensed", system-ui'
    g.textAlign = 'center'
    g.textBaseline = 'top'
    g.fillText(`pull/stack ${s.domWin}s`, mid, 3)
    g.strokeStyle = 'rgba(127,144,170,0.25)'
    g.beginPath()
    g.moveTo(mid + 0.5, 14)
    g.lineTo(mid + 0.5, this.H)
    g.stroke()
  }

  // ------------------------------------------------------------------------------------ bottom pane
  bins(): Bin[] {
    const s = this.pRef.current
    const cfg = store.config!
    const cols = store.cols
    const [t0] = this.visibleRange()
    const i0 = Math.max(0, store.colAt(t0))
    const binPx = Math.max(3, Math.ceil(cfg.column_ms / this.v.mpp))
    const off = new Set(s.venOff)
    const spot = store.spotIds
    const prim = cfg.primary_x
    const bins: Bin[] = []
    let cur: Bin | null = null
    for (let i = i0; i < cols.length; i++) {
      const c = cols[i]
      const bx = Math.floor(this.x(c.t) / binPx)
      if (!cur || cur.x !== bx) {
        cur = { x: bx, b: 0, s: 0, pd: 0, sd: 0, ven: new Map(), z: [0, 0, 0, 0, 0, 0], ll: 0, ls: 0, cvd: c.cvd,
          cvdP: c.cvdP, cvdS: c.cvdS, cz: c.cvdZ, oi: NaN, prem: NaN, px: c.last }
        bins.push(cur)
      }
      cur.b += c.buy
      cur.s += c.sell
      if (c.ex.length) {
        for (let k = 0; k < c.ex.length; k += 3) {
          const v = c.ex[k]
          const d = c.ex[k + 1] - c.ex[k + 2]
          if (spot.has(v)) cur.sd += d
          else if (!off.has(v)) {
            cur.pd += d
            cur.ven.set(v, (cur.ven.get(v) ?? 0) + d)
          }
        }
      } else if (!off.has(prim)) {
        cur.pd += c.buy - c.sell
        cur.ven.set(prim, (cur.ven.get(prim) ?? 0) + c.buy - c.sell)
      }
      for (let k = 0; k < 6; k++) cur.z[k] += c.sz[k]
      cur.ll += c.liqL
      cur.ls += c.liqS
      cur.cvd = c.cvd
      cur.cvdP = c.cvdP
      cur.cvdS = c.cvdS
      cur.cz = c.cvdZ
      if (Number.isFinite(c.oi) && c.oi > 0) cur.oi = c.oi
      if (Number.isFinite(c.prem)) cur.prem = c.prem
      if (c.last) cur.px = c.last
    }
    return bins
  }

  renderBottom() {
    const s = this.pRef.current
    const cfg = store.config!
    const g = this.bottom.getContext('2d')!
    const W = this.W + this.extra
    const H = BOTTOM_H - TIME_AXIS_H
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, W, BOTTOM_H)
    const [t0, t1] = this.visibleRange()
    const binPx = Math.max(3, Math.ceil(cfg.column_ms / this.v.mpp))
    const bins = this.bins()
    const mid = H * 0.5
    const xb = (b: Bin) => b.x * binPx
    const legend: [string, string, string?][] = [] // label, color, value

    const bars = (vals: number[], pos: string, neg: string, scale?: number) => {
      const m = scale ?? Math.max(1e-9, ...vals.map(Math.abs))
      bins.forEach((b, i) => {
        const d = vals[i]
        const h = (Math.abs(d) / m) * (mid - 4)
        g.fillStyle = d >= 0 ? pos : neg
        if (d >= 0) g.fillRect(xb(b), mid - h, binPx - 1, h)
        else g.fillRect(xb(b), mid, binPx - 1, h)
      })
    }
    const line = (vals: number[], color: string, w = 1.5, lo?: number, hi?: number) => {
      const fin = vals.filter(Number.isFinite)
      if (fin.length < 2) return
      const a = lo ?? Math.min(...fin)
      const z = hi ?? Math.max(...fin)
      if (!(z > a)) return
      g.beginPath()
      let started = false
      bins.forEach((b, i) => {
        const v = vals[i]
        if (!Number.isFinite(v)) return
        const yy = 6 + (1 - (v - a) / (z - a)) * (H - 12)
        const xx = xb(b) + binPx / 2
        if (!started) {
          g.moveTo(xx, yy)
          started = true
        } else g.lineTo(xx, yy)
      })
      g.strokeStyle = color
      g.lineWidth = w
      g.stroke()
    }
    const run = (vals: number[]) => {
      let acc = 0
      return vals.map((v) => (acc += v))
    }
    const signed = (v: number, d = 1) => `${v >= 0 ? '+' : ''}${fmtQty(v, d)}`

    // volume backdrop (all modes)
    const vol = bins.map((b) => b.b + b.s)
    const maxV = Math.max(1e-9, ...vol)
    for (let i = 0; i < bins.length; i++) {
      const vh = (vol[i] / maxV) * (H - 6)
      g.fillStyle = 'rgba(127,144,170,0.10)'
      g.fillRect(xb(bins[i]), H - vh, binPx - 1, vh)
    }

    switch (s.bottom) {
      case 'delta': {
        const d = bins.map((b) => b.b - b.s)
        bars(d, 'rgba(43,217,159,0.85)', 'rgba(255,92,122,0.85)')
        const cvd = bins.map((b) => b.cvd)
        line(cvd, C.amber)
        legend.push(['Delta (Binance)', C.dim], ['CVD', C.amber, signed((cvd.at(-1) ?? 0) - (cvd[0] ?? 0))])
        break
      }
      case 'perps': {
        const d = bins.map((b) => b.pd)
        bars(d, 'rgba(43,217,159,0.8)', 'rgba(255,92,122,0.8)')
        const ids = new Set<number>()
        for (const b of bins) for (const k of b.ven.keys()) ids.add(k)
        const per = [...ids].sort((a, b) => a - b).map((v) => [v, run(bins.map((b) => b.ven.get(v) ?? 0))] as const)
        let lo = 0
        let hi = 0
        for (const [, arr] of per) for (const v of arr) {
          lo = Math.min(lo, v)
          hi = Math.max(hi, v)
        }
        const agg = run(d)
        for (const v of agg) {
          lo = Math.min(lo, v)
          hi = Math.max(hi, v)
        }
        for (const [v, arr] of per) line(arr, venueColor(v), 1, lo, hi)
        line(agg, '#ffffff', 1.8, lo, hi)
        legend.push(['All perps CVD', '#ffffff', signed(agg.at(-1) ?? 0)])
        for (const [v, arr] of per) legend.push([store.venue(v)?.label ?? `#${v}`, venueColor(v), signed(arr.at(-1) ?? 0)])
        break
      }
      case 'spotperp': {
        const pc = bins.map((b) => b.cvdP)
        const sc = bins.map((b) => b.cvdS)
        bars(bins.map((b) => b.sd), 'rgba(123,224,184,0.45)', 'rgba(255,92,122,0.35)')
        line(pc, C.amber, 1.6)
        line(sc, '#7be0b8', 1.6)
        // divergence / leadership flags from the server's regime detector
        g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
        g.textBaseline = 'top'
        g.textAlign = 'left'
        for (const e of store.xev) {
          if (e.type !== 'regime' || e.t < t0 || e.t > t1) continue
          const xx = this.x(e.t)
          const up = (e.bias ?? 0) > 0
          const col = up ? C.buy : (e.bias ?? 0) < 0 ? C.sell : C.dim
          g.strokeStyle = col
          g.setLineDash([2, 2])
          g.beginPath()
          g.moveTo(xx + 0.5, 0)
          g.lineTo(xx + 0.5, H)
          g.stroke()
          g.setLineDash([])
          g.fillStyle = col
          g.beginPath()
          if (up) {
            g.moveTo(xx, 2)
            g.lineTo(xx - 5, 10)
            g.lineTo(xx + 5, 10)
          } else {
            g.moveTo(xx, 10)
            g.lineTo(xx - 5, 2)
            g.lineTo(xx + 5, 2)
          }
          g.fill()
          g.fillText(e.label, xx + 7, 1)
        }
        legend.push(['Perps CVD', C.amber, signed((pc.at(-1) ?? 0) - (pc[0] ?? 0))],
          ['Spot CVD', '#7be0b8', signed((sc.at(-1) ?? 0) - (sc[0] ?? 0))])
        break
      }
      case 'size': {
        const whale = bins.map((b) => b.z[4] - b.z[5])
        bars(whale, 'rgba(242,181,68,0.55)', 'rgba(180,156,255,0.55)')
        const z = [0, 1, 2].map((k) => bins.map((b) => b.cz[k]))
        let lo = Infinity
        let hi = -Infinity
        z.forEach((arr) => arr.forEach((v, i) => {
          const r = v - arr[0]
          lo = Math.min(lo, r)
          hi = Math.max(hi, r)
          void i
        }))
        const cols = ['#7f90aa', C.cyan, C.amber]
        const names = ['< 1 BTC', '1–10 BTC', '≥ 10 BTC']
        z.forEach((arr, k) => {
          const rel = arr.map((v) => v - arr[0])
          line(rel, cols[k], k === 2 ? 1.8 : 1.3, lo, hi)
          legend.push([names[k], cols[k], signed(rel.at(-1) ?? 0)])
        })
        break
      }
      case 'oi': {
        // OI change per bin labelled by what it means together with price
        let prevOi = NaN
        let prevPx = NaN
        const dOi: number[] = []
        const kind: number[] = []
        for (const b of bins) {
          let d = 0
          if (Number.isFinite(b.oi) && Number.isFinite(prevOi)) d = b.oi - prevOi
          const dp = Number.isFinite(prevPx) ? b.px - prevPx : 0
          dOi.push(d)
          kind.push(d >= 0 ? (dp >= 0 ? 0 : 1) : dp <= 0 ? 2 : 3)
          if (Number.isFinite(b.oi)) prevOi = b.oi
          prevPx = b.px
        }
        const KC = [C.buy, C.sell, C.orange, C.cyan]
        const m = Math.max(1e-9, ...dOi.map(Math.abs))
        bins.forEach((b, i) => {
          const h = (Math.abs(dOi[i]) / m) * (mid - 4)
          g.fillStyle = KC[kind[i]]
          if (dOi[i] >= 0) g.fillRect(xb(b), mid - h, binPx - 1, h)
          else g.fillRect(xb(b), mid, binPx - 1, h)
        })
        line(bins.map((b) => b.oi), '#d3dceb', 1.3)
        // liquidations as ticks along the bottom
        const lm = Math.max(1e-9, ...bins.map((b) => Math.max(b.ll, b.ls)))
        for (const b of bins) {
          if (b.ll > 0) {
            g.fillStyle = C.orange
            g.fillRect(xb(b), H - (b.ll / lm) * 22, Math.max(1, binPx - 1), (b.ll / lm) * 22)
          }
          if (b.ls > 0) {
            g.fillStyle = C.cyan
            g.fillRect(xb(b), 0, Math.max(1, binPx - 1), (b.ls / lm) * 22)
          }
        }
        const oiF = bins.map((b) => b.oi).filter(Number.isFinite)
        legend.push(['OI all venues', '#d3dceb', oiF.length > 1 ? signed(oiF[oiF.length - 1] - oiF[0], 0) : '–'],
          ['New longs', C.buy], ['New shorts', C.sell], ['Longs closing', C.orange], ['Shorts covering', C.cyan])
        break
      }
      case 'premium': {
        const pv = bins.map((b) => b.prem)
        const fin = pv.filter(Number.isFinite)
        const m = Math.max(1, ...fin.map(Math.abs))
        g.strokeStyle = C.line
        g.beginPath()
        g.moveTo(0, mid + 0.5)
        g.lineTo(W, mid + 0.5)
        g.stroke()
        bins.forEach((b, i) => {
          const v = pv[i]
          if (!Number.isFinite(v)) return
          const h = (Math.abs(v) / m) * (mid - 6)
          g.fillStyle = v >= 0 ? 'rgba(43,217,159,0.55)' : 'rgba(255,92,122,0.55)'
          if (v >= 0) g.fillRect(xb(b), mid - h, binPx, h)
          else g.fillRect(xb(b), mid, binPx, h)
        })
        line(pv, '#4f8dff', 1.5, -m, m)
        legend.push(['Coinbase premium', '#4f8dff', fin.length ? `${fin[fin.length - 1] >= 0 ? '+' : ''}$${fin[fin.length - 1].toFixed(1)}` : '–'],
          ['(CB − Binance spot, USD)', C.faint])
        break
      }
    }
    if (s.bottom !== 'premium') {
      g.strokeStyle = C.line
      g.beginPath()
      g.moveTo(0, mid + 0.5)
      g.lineTo(W, mid + 0.5)
      g.stroke()
    }
    // time axis
    g.fillStyle = C.panel
    g.fillRect(0, H, W, TIME_AXIS_H)
    const stepS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((v) => (v * 1000) / this.v.mpp > 90) ?? 3600
    g.font = '500 10.5px "IBM Plex Sans", system-ui'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    for (let t = Math.ceil(t0 / (stepS * 1000)) * stepS * 1000; t < t1; t += stepS * 1000) {
      const xx = this.x(t)
      g.fillStyle = C.dim
      g.fillText(fmtTime(t).slice(0, stepS >= 60 ? 5 : 8), xx, H + TIME_AXIS_H / 2)
      g.fillStyle = 'rgba(127,144,170,0.25)'
      g.fillRect(xx, H, 1, 4)
    }
    // side legend
    const sg = this.bside.getContext('2d')!
    const sw = this.sideW
    sg.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    sg.clearRect(0, 0, sw, BOTTOM_H)
    sg.fillStyle = C.panel
    sg.fillRect(0, 0, sw, BOTTOM_H)
    sg.font = '500 10.5px "IBM Plex Sans", system-ui'
    sg.textBaseline = 'top'
    legend.slice(0, 7).forEach(([label, color, val], i) => {
      const yy = 6 + i * 15
      sg.fillStyle = color
      sg.fillRect(8, yy + 3, 7, 7)
      sg.textAlign = 'left'
      sg.fillStyle = C.dim
      sg.fillText(label, 20, yy)
      if (val) {
        sg.textAlign = 'right'
        sg.fillStyle = val.startsWith('-') ? C.sell : val === '–' ? C.dim : C.buy
        sg.fillText(val, sw - 8, yy)
      }
    })
    sg.strokeStyle = C.line
    sg.beginPath()
    sg.moveTo(0.5, 0)
    sg.lineTo(0.5, BOTTOM_H)
    sg.stroke()
  }

  // ------------------------------------------------------------------------------------ crosshair
  renderCross() {
    const g = this.cross.getContext('2d')!
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, this.W, this.H)
    const m = this.mouse
    if (!store.config) return
    const cfg = store.config
    // range tool preview
    if (this.tdrag) {
      const xa = this.x(Math.min(this.tdrag.t0, this.tdrag.t1)) - this.shift()
      const xb = this.x(Math.max(this.tdrag.t0, this.tdrag.t1)) - this.shift()
      g.fillStyle = 'rgba(180,156,255,0.12)'
      g.fillRect(xa, 0, xb - xa, this.H)
      g.strokeStyle = C.violet
      g.strokeRect(xa + 0.5, 0.5, xb - xa, this.H - 1)
    }
    if (!m || !m.inChart) return
    g.strokeStyle = 'rgba(211,220,235,0.35)'
    g.setLineDash([3, 3])
    g.beginPath()
    g.moveTo(0, m.y + 0.5)
    g.lineTo(this.W, m.y + 0.5)
    g.moveTo(m.x + 0.5, 0)
    g.lineTo(m.x + 0.5, this.H)
    g.stroke()
    g.setLineDash([])
    const s = this.pRef.current
    const t = this.tAt(m.x)
    const p = this.pAt(m.y)
    const ci = store.colAt(t)
    const lines = [`${fmtPx(p, 1)}`, fmtTime(t, true)]
    if (s.tool === 'range') lines.push('Drag to measure a range profile')
    if (s.tool === 'avwap') lines.push('Click to anchor a VWAP here')
    if (ci >= 0) {
      const col = store.cols[ci]
      const b = Math.floor(p / cfg.bucket)
      const i = b - col.base
      const q = i >= 0 && i < col.qty.length ? col.qty[i] : 0
      let xq = 0
      for (let k = 0; k < col.cbIdx.length; k++) if (col.cbIdx[k] === b) xq = col.cbQty[k]
      lines.push(`Resting ${fmtQty(q)} BTC @ $${cfg.bucket}${xq ? ` · other books ${fmtQty(xq)}` : ''}`)
      const R = this.heatRow()
      if (R > cfg.bucket) {
        const per = Math.max(1, Math.round(R / cfg.bucket))
        const e = this.colRows(col, per, s.book === 'combined')
        const j = Math.floor(b / per) - e.start
        const rq = j >= 0 && j < e.v.length ? e.v[j] : 0
        const r0 = Math.floor(b / per) * per * cfg.bucket
        lines.push(`Row ${fmtPx(r0, 0)}–${fmtPx(r0 + R, 0)}: ${fmtQty(rq)} BTC${s.book === 'combined' ? ' (all books)' : ''}`)
      }
      let pb = 0
      let ps = 0
      let xb = 0
      let xs = 0
      for (let k = 0; k < col.trIdx.length; k++) {
        if (Math.abs(col.trIdx[k] - b) <= 1) {
          pb += col.trBuy[k]
          ps += col.trSell[k]
        }
      }
      for (let k = 0; k < col.xtIdx.length; k++) {
        if (Math.abs(col.xtIdx[k] - b) <= 1) {
          xb += col.xtBuy[k]
          xs += col.xtSell[k]
        }
      }
      if (pb + ps > 0) lines.push(`Prints ${fmtQty(pb)} buy · ${fmtQty(ps)} sell`)
      if (xb + xs > 0) lines.push(`Other perps ${fmtQty(xb)} buy · ${fmtQty(xs)} sell`)
    }
    const lm = store.liqmap
    if (lm && s.liqMap) {
      const k = Math.floor(p / lm.bucket) * lm.bucket
      const f = (arr: [number, number][]) => arr.find(([q]) => Math.abs(q - k) < lm.bucket / 2)?.[1] ?? 0
      const lv = f(lm.long) + f(lm.short)
      if (lv > 0) lines.push(`Liq model ~${fmtQty(lv, 1)} BTC in $${lm.bucket}`)
    }
    g.font = '500 11px "IBM Plex Sans", system-ui'
    const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 16
    const h = lines.length * 16 + 8
    let bx = m.x + 14
    let by = m.y + 14
    if (bx + w > this.W) bx = m.x - w - 14
    if (by + h > this.H) by = m.y - h - 14
    g.fillStyle = 'rgba(13,24,38,0.94)'
    g.strokeStyle = C.line
    g.fillRect(bx, by, w, h)
    g.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1)
    g.textBaseline = 'top'
    g.textAlign = 'left'
    lines.forEach((l, i) => {
      g.fillStyle = i === 0 ? '#fff' : C.dim
      g.fillText(l, bx + 8, by + 6 + i * 16)
    })
  }

  // ------------------------------------------------------------------------------------ input
  bindEvents() {
    const chart = this.chart
    chart.addEventListener('wheel', (e) => {
      e.preventDefault()
      const f = Math.exp(Math.sign(e.deltaY) * Math.min(0.3, Math.abs(e.deltaY) / 400))
      if (e.ctrlKey || e.shiftKey || e.altKey) this.zoomPrice(f, e.offsetY)
      else this.zoomTime(f, e.offsetX)
    }, { passive: false })
    this.side.addEventListener('wheel', (e) => {
      e.preventDefault()
      const f = Math.exp(Math.sign(e.deltaY) * Math.min(0.3, Math.abs(e.deltaY) / 400))
      this.zoomPrice(f, e.offsetY)
    }, { passive: false })
    chart.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      chart.setPointerCapture(e.pointerId)
      const tool = this.pRef.current.tool
      const t = this.tAt(e.offsetX)
      if (tool === 'avwap') {
        store.addAnchor(Math.min(t, store.now()))
        this.setTool('none')
        return
      }
      if (tool === 'range') {
        this.tdrag = { t0: t, t1: t }
        return
      }
      this.drag = { x: e.clientX, y: e.clientY, t: this.anchor + this.shift() * this.v.mpp, p: this.v.pCenter ?? 0, mode: 'pan', ppp: this.v.ppp }
    })
    this.side.addEventListener('pointerdown', (e) => {
      this.side.setPointerCapture(e.pointerId)
      this.drag = { x: e.clientX, y: e.clientY, t: 0, p: this.v.pCenter ?? 0, mode: 'pzoom', ppp: this.v.ppp }
    })
    const move = (e: PointerEvent) => {
      const d = this.drag
      if (!d) return
      if (d.mode === 'pan') {
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (Math.abs(dx) > 3) {
          this.v.follow = false
          this.v.tRight = Math.min(store.now(), d.t - dx * this.v.mpp)
          this.setLive(false)
        }
        if (Math.abs(dy) > 3) {
          this.v.autoCenter = false
          this.v.pCenter = d.p + dy * this.v.ppp
          this.setLive(false)
        }
      } else {
        const f = Math.exp((e.clientY - d.y) / 150)
        this.v.ppp = Math.min(60, Math.max(0.02, d.ppp * f))
      }
      this.dirty = true
    }
    chart.addEventListener('pointermove', (e) => {
      this.mouse = { x: e.offsetX, y: e.offsetY, inChart: true }
      if (this.tdrag) this.tdrag.t1 = this.tAt(e.offsetX)
      move(e)
      this.renderCross()
    })
    this.side.addEventListener('pointermove', move)
    const up = () => {
      this.drag = null
      if (this.tdrag) {
        const { t0, t1 } = this.tdrag
        this.tdrag = null
        store.addRange(Math.min(t0, t1), Math.min(store.now() + 60_000, Math.max(t0, t1)))
        this.setTool('none')
        this.renderCross()
      }
    }
    chart.addEventListener('pointerup', up)
    this.side.addEventListener('pointerup', up)
    chart.addEventListener('pointerleave', () => {
      this.mouse = null
      this.renderCross()
    })
    chart.addEventListener('dblclick', () => this.goLive())
    chart.addEventListener('contextmenu', (e) => {
      // right-click removes a range profile or an anchored VWAP under the cursor
      const t = this.tAt(e.offsetX)
      const r = store.ranges.find((q) => t >= q.t0 && t <= q.t1)
      if (r) {
        e.preventDefault()
        store.removeRange(r.id)
        return
      }
      const a = store.anchors.find((q) => Math.abs(q - t) < 8 * this.v.mpp)
      if (a != null) {
        e.preventDefault()
        store.removeAnchor(a)
      }
    })
    this.side.addEventListener('dblclick', () => {
      this.v.ppp = 0.6
      this.v.autoCenter = true
      this.v.pCenter = store.last
      this.dirty = true
    })
  }

  zoomTime(f: number, x: number) {
    const v = this.v
    const old = v.mpp
    const nw = Math.min(5000, Math.max(8, old * f))
    if (!v.follow) {
      const tAtX = v.tRight + (x - (this.W - 1)) * old
      v.tRight = tAtX - (x - (this.W - 1)) * nw
    }
    v.mpp = nw
    this.setExtra()
    this.dirty = true
  }

  zoomPrice(f: number, y: number) {
    const v = this.v
    const pAt = this.pAt(y)
    v.ppp = Math.min(60, Math.max(0.02, v.ppp * f))
    if (v.pCenter != null) v.pCenter = pAt + (y - this.H / 2) * v.ppp
    this.dirty = true
  }
}
