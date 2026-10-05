import { useEffect, useRef, useState } from 'react'
import { aggregateBars, barPoc, footprintZones, imbalances, type AggBar, type FpZone } from '../lib/analytics'
import {
  drawDevPoc, drawGamma, drawProfile, drawRanges, drawSessionLevels, drawVwapLabels, drawVwaps, getProfile, Labeler,
  profileWindow, type Ax,
} from '../lib/overlays'
import type { Prefs, Tool } from '../lib/prefs'
import { store } from '../lib/store'
import { C, fmtPx, fmtQty, fmtTime, niceStep } from '../lib/util'

const AXIS_W = 74
const PROF_W = 120
const SUM_H = 64
const STAT_ROW = 14
const ROWS = [1, 2, 5, 10, 25, 50, 100, 250, 500]

const STAT_ROWS = ['Time', 'Volume', 'Delta', 'Δ change', 'Max Δ', 'Min Δ', 'Trades', 'Buy %', 'Stacked imb.', 'OI Δ',
  'Liquidations', 'CVD'] as const

export default function FootprintView({ p, onTool }: { p: Prefs; onTool: (t: Tool) => void }) {
  const root = useRef<HTMLDivElement>(null)
  const pRef = useRef(p)
  pRef.current = p
  const toolRef = useRef(onTool)
  toolRef.current = onTool
  const ctl = useRef<FootController | null>(null)
  const [live, setLive] = useState(true)
  useEffect(() => {
    const c = new FootController(root.current!, pRef, setLive, (t) => toolRef.current(t))
    ctl.current = c
    return () => c.destroy()
  }, [])
  useEffect(() => {
    if (ctl.current) ctl.current.dirty = true
  }, [p])
  return (
    <div className={`fp ${p.tool !== 'none' ? 'tooling' : ''}`} ref={root}>
      {!live && (
        <button className="relive" onClick={() => ctl.current?.goLive()}>
          Back to live
        </button>
      )}
    </div>
  )
}

interface Layout {
  bars: AggBar[]
  zones: FpZone[]
  tf: number
  row: number
}

class FootController {
  root: HTMLElement
  pRef: { current: Prefs }
  setLive: (b: boolean) => void
  setTool: (t: Tool) => void
  cv: HTMLCanvasElement
  W = 0
  H = 0
  dpr = 1
  barW = 128
  xOff = 0 // px shifted to the past
  pCenter: number | null = null
  ppp = 1.2
  autoCenter = true
  dirty = true
  ver = ''
  raf = 0
  lastDraw = 0
  ro: ResizeObserver
  drag: null | { x: number; y: number; xOff: number; p: number } = null
  tdrag: null | { t0: number; t1: number } = null
  mouse: { x: number; y: number } | null = null
  cache: { key: string; lay: Layout | null } = { key: '', lay: null }
  lay: Layout | null = null

  constructor(root: HTMLElement, pRef: { current: Prefs }, setLive: (b: boolean) => void, setTool: (t: Tool) => void) {
    this.root = root
    this.pRef = pRef
    this.setLive = setLive
    this.setTool = setTool
    this.cv = document.createElement('canvas')
    root.appendChild(this.cv)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(root)
    this.bind()
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
  goLive() {
    this.xOff = 0
    this.autoCenter = true
    this.pCenter = null
    this.setLive(true)
    this.dirty = true
  }
  resize() {
    const r = this.root.getBoundingClientRect()
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    this.W = Math.max(100, Math.floor(r.width))
    this.H = Math.max(100, Math.floor(r.height))
    this.cv.width = Math.round(this.W * this.dpr)
    this.cv.height = Math.round(this.H * this.dpr)
    this.cv.style.width = `${this.W}px`
    this.cv.style.height = `${this.H}px`
    this.dirty = true
  }

  get sumH() {
    return this.pRef.current.stats ? STAT_ROWS.length * STAT_ROW + 6 : SUM_H
  }
  get chartW() {
    return this.W - AXIS_W - (this.pRef.current.profile ? PROF_W : 0)
  }
  get chartH() {
    return Math.max(60, this.H - this.sumH)
  }
  y(p: number) {
    return (this.pCenter! - p) / this.ppp + this.chartH / 2
  }
  pAt(y: number) {
    return this.pCenter! - (y - this.chartH / 2) * this.ppp
  }
  rowUsd() {
    const s = this.pRef.current
    if (s.row) return s.row
    const bu = store.config?.bucket ?? 1
    return ROWS.find((r) => r >= bu && r / this.ppp >= 15) ?? 500
  }
  xOf(i: number, n: number) {
    return this.chartW - (n - i) * this.barW + this.xOff
  }
  /** x of a time (inside the bar that holds it) */
  xOfT(t: number) {
    const lay = this.lay
    if (!lay || !lay.bars.length) return -1e6
    const bars = lay.bars
    const n = bars.length
    const tf = lay.tf
    let lo = 0
    let hi = n - 1
    if (t < bars[0].t) return this.xOf(0, n) - ((bars[0].t - t) / tf) * this.barW
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1
      if (bars[m].t <= t) lo = m
      else hi = m - 1
    }
    const b = bars[lo]
    return this.xOf(lo, n) + Math.min(1.5, (t - b.t) / tf) * this.barW
  }
  tAtX(x: number) {
    const lay = this.lay
    if (!lay || !lay.bars.length) return store.now()
    const n = lay.bars.length
    const f = (x - this.xOf(0, n)) / this.barW
    const i = Math.max(0, Math.min(n - 1, Math.floor(f)))
    return lay.bars[i].t + Math.max(0, f - i) * lay.tf
  }

  frame() {
    if (!store.config) return
    const v = `${store.version('bars')}:${store.version('abs')}:${store.version('gex')}:${store.version('tools')}`
    const now = performance.now()
    if (!this.dirty && (v === this.ver || now - this.lastDraw < 220)) return
    this.ver = v
    this.dirty = false
    this.lastDraw = now
    this.draw()
  }

  layout(): Layout {
    const s = this.pRef.current
    const cfg = store.config!
    const row = this.rowUsd()
    const n = Math.ceil(this.chartW / this.barW) + Math.ceil(this.xOff / this.barW) + 2
    const times = store.barTimes
    const tf = s.tf * 60000
    const lastT = times.length ? times[times.length - 1] : 0
    const fromT = lastT - (lastT % tf) - n * tf
    const key = `${store.version('bars')}:${s.tf}:${row}:${n}:${s.fpSrc}:${s.imbalance}`
    if (this.cache.key !== key || !this.cache.lay) {
      const bars = aggregateBars(store.bars, times, s.tf, row, cfg.bucket, fromT, s.fpSrc)
      this.cache = { key, lay: { bars, zones: footprintZones(bars, row, s.imbalance), tf, row } }
    }
    return this.cache.lay!
  }

  draw() {
    const s = this.pRef.current
    const g = this.cv.getContext('2d')!
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = C.bg
    g.fillRect(0, 0, this.W, this.H)
    const lay = this.layout()
    this.lay = lay
    const bars = lay.bars
    if (!bars.length) {
      g.fillStyle = C.dim
      g.font = '500 13px "IBM Plex Sans", system-ui'
      g.textAlign = 'center'
      g.fillText(s.fpSrc === 'spot' ? 'Waiting for spot trades…' : 'Waiting for trades…', this.W / 2, this.H / 2)
      return
    }
    const last = bars[bars.length - 1]
    if (this.pCenter == null) this.pCenter = last.c
    if (this.autoCenter) {
      const half = (this.chartH / 2) * this.ppp
      if (Math.abs(last.c - this.pCenter) > half * 0.55) this.pCenter = last.c
    }
    const row = lay.row
    const rowPx = row / this.ppp
    const cw = this.chartW
    const ch = this.chartH
    const n = bars.length
    const ax: Ax = { W: cw, H: ch, y: (q) => this.y(q), xt: (t) => this.xOfT(t) }

    // grid
    const step = niceStep(ch * this.ppp, ch / 70)
    g.strokeStyle = C.grid
    g.lineWidth = 1
    for (let p = Math.ceil(this.pAt(ch) / step) * step; p < this.pAt(0); p += step) {
      const yy = Math.round(this.y(p)) + 0.5
      g.beginPath()
      g.moveTo(0, yy)
      g.lineTo(cw, yy)
      g.stroke()
    }

    g.save()
    g.beginPath()
    g.rect(0, 0, cw, ch)
    g.clip()

    // zones under the cells
    if (s.zones) this.drawZones(g, lay, n)
    drawRanges(g, ax, row)

    const textOk = rowPx >= 12 && this.barW >= 74
    const fsz = Math.min(12, Math.max(9, rowPx - 4))
    let maxAbsD = 1e-9
    let maxV = 1e-9
    let maxN = 1
    for (const b of bars) for (const c of b.rows.values()) {
      maxAbsD = Math.max(maxAbsD, Math.abs(c.b - c.s))
      maxV = Math.max(maxV, c.b + c.s)
      maxN = Math.max(maxN, c.nb + c.ns)
    }
    const dec = (v: number) => (Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2)
    for (let i = 0; i < n; i++) {
      const b = bars[i]
      const bx = this.xOf(i, n)
      if (bx + this.barW < 0 || bx > cw) continue
      const cellX = bx + 10
      const cellW = this.barW - 14
      // candle (thin, left edge)
      const up = b.c >= b.o
      g.strokeStyle = up ? C.buy : C.sell
      g.fillStyle = up ? C.buy : C.sell
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(bx + 4.5, this.y(b.h))
      g.lineTo(bx + 4.5, this.y(b.l))
      g.stroke()
      const yo = this.y(b.o)
      const yc = this.y(b.c)
      g.fillRect(bx + 2, Math.min(yo, yc), 5, Math.max(1, Math.abs(yc - yo)))
      if (b.ax || b.rows.size === 0) {
        g.globalAlpha = 0.35
        g.fillRect(bx + this.barW / 2 - 6, Math.min(yo, yc), 12, Math.max(1, Math.abs(yc - yo)))
        g.fillRect(bx + this.barW / 2 - 0.5, this.y(b.h), 1, this.y(b.l) - this.y(b.h))
        g.globalAlpha = 1
        continue
      }
      const { buy: imbB, sell: imbS, maxSide } = s.showImb ? imbalances(b, s.imbalance) : { buy: new Set<number>(), sell: new Set<number>(), maxSide: 0 }
      let ms = maxSide
      if (!ms) for (const c of b.rows.values()) ms = Math.max(ms, c.b, c.s)
      const half = cellW / 2
      for (const [r, c] of b.rows) {
        const y0 = this.y((r + 1) * row)
        if (y0 > ch || y0 + rowPx < 0) continue
        const h = Math.max(1, rowPx - (rowPx > 4 ? 1 : 0))
        const tot = c.b + c.s
        const faint = tot < s.fpMin
        if (faint) g.globalAlpha = 0.25
        const mode = s.fpMode
        if (mode === 'bidask') {
          g.fillStyle = `rgba(255,92,122,${(0.08 + 0.62 * (c.s / ms)).toFixed(3)})`
          g.fillRect(cellX, y0, half - 0.5, h)
          g.fillStyle = `rgba(43,217,159,${(0.08 + 0.62 * (c.b / ms)).toFixed(3)})`
          g.fillRect(cellX + half + 0.5, y0, half - 0.5, h)
        } else if (mode === 'delta') {
          const d = c.b - c.s
          const a = 0.08 + 0.7 * (Math.abs(d) / maxAbsD)
          g.fillStyle = d >= 0 ? `rgba(43,217,159,${a.toFixed(3)})` : `rgba(255,92,122,${a.toFixed(3)})`
          g.fillRect(cellX, y0, cellW, h)
        } else if (mode === 'volume') {
          g.fillStyle = `rgba(90,209,255,${(0.06 + 0.7 * (tot / maxV)).toFixed(3)})`
          g.fillRect(cellX, y0, cellW, h)
        } else if (mode === 'trades') {
          g.fillStyle = `rgba(180,156,255,${(0.06 + 0.7 * ((c.nb + c.ns) / maxN)).toFixed(3)})`
          g.fillRect(cellX, y0, cellW, h)
        } else {
          const dom = tot > 0 ? Math.max(c.b, c.s) / tot : 0.5
          const a = 0.06 + 0.7 * Math.max(0, (dom - 0.5) * 2) * Math.min(1, tot / (maxV * 0.25))
          g.fillStyle = c.b >= c.s ? `rgba(43,217,159,${a.toFixed(3)})` : `rgba(255,92,122,${a.toFixed(3)})`
          g.fillRect(cellX, y0, cellW, h)
        }
        const bI = imbB.has(r)
        const sI = imbS.has(r)
        if (bI) {
          g.fillStyle = C.buy
          g.fillRect(cellX + cellW - 2, y0, 2, h)
        }
        if (sI) {
          g.fillStyle = C.sell
          g.fillRect(cellX, y0, 2, h)
        }
        if (s.cluster > 0 && tot >= s.cluster) {
          g.strokeStyle = C.amber
          g.lineWidth = 2
          g.shadowColor = 'rgba(242,181,68,0.6)'
          g.shadowBlur = 6
          g.strokeRect(cellX + 1, y0 + 1, cellW - 2, Math.max(1, h - 2))
          g.shadowBlur = 0
        }
        // liquidations that hit this price
        const lq = c.ll + c.ls
        if (lq > 0) {
          const sz = Math.min(7, 2.5 + Math.sqrt(lq) * 1.2)
          g.save()
          g.translate(cellX - 4, y0 + h / 2)
          g.rotate(Math.PI / 4)
          g.fillStyle = c.ll >= c.ls ? C.orange : C.cyan
          g.fillRect(-sz / 2, -sz / 2, sz, sz)
          g.restore()
        }
        if (textOk && !faint) {
          g.textBaseline = 'middle'
          const yt = y0 + h / 2
          if (mode === 'bidask') {
            g.font = `${sI ? 700 : 500} ${fsz}px "IBM Plex Sans Condensed", system-ui`
            g.textAlign = 'right'
            g.fillStyle = sI ? '#ff9db0' : C.text
            g.fillText(fmtQty(c.s, dec(c.s)), cellX + half - 5, yt)
            g.font = `${bI ? 700 : 500} ${fsz}px "IBM Plex Sans Condensed", system-ui`
            g.textAlign = 'left'
            g.fillStyle = bI ? '#8ff5cf' : C.text
            g.fillText(fmtQty(c.b, dec(c.b)), cellX + half + 5, yt)
          } else {
            let txt = ''
            let col = C.text
            if (mode === 'delta') {
              const d = c.b - c.s
              txt = `${d > 0 ? '+' : ''}${fmtQty(d, dec(d))}`
              col = d >= 0 ? '#8ff5cf' : '#ff9db0'
            } else if (mode === 'volume') txt = fmtQty(tot, dec(tot))
            else if (mode === 'trades') txt = s.fpSrc === 'primary' ? `${c.ns} × ${c.nb}` : '–'
            else {
              const dom = tot > 0 ? Math.max(c.b, c.s) / tot : 0
              txt = `${Math.round(dom * 100)}% ${c.b >= c.s ? 'B' : 'S'}`
              col = c.b >= c.s ? '#8ff5cf' : '#ff9db0'
            }
            g.font = `${bI || sI ? 700 : 500} ${fsz}px "IBM Plex Sans Condensed", system-ui`
            g.textAlign = 'center'
            g.fillStyle = col
            g.fillText(txt, cellX + half, yt)
          }
        }
        g.globalAlpha = 1
      }
      if (s.showPoc) {
        const poc = barPoc(b)
        if (poc != null) {
          const y0 = this.y((poc + 1) * row)
          g.strokeStyle = C.amber
          g.lineWidth = 1.5
          g.strokeRect(cellX + 0.5, y0 + 0.5, cellW - 1, Math.max(1, rowPx - 1))
        }
      }
    }

    // absorption markers
    if (s.absorption) {
      g.font = '600 10.5px "IBM Plex Sans Condensed", system-ui'
      for (const a of store.abs) {
        const bt = a.t - (a.t % lay.tf)
        const i = bars.findIndex((b) => b.t === bt)
        if (i < 0) continue
        const bx = this.xOf(i, n)
        const yy = this.y(a.p)
        g.strokeStyle = C.violet
        g.lineWidth = 2
        g.strokeRect(bx + 9, yy - rowPx / 2, this.barW - 12, rowPx)
        g.fillStyle = C.violet
        g.textAlign = 'right'
        g.textBaseline = 'bottom'
        g.fillText(`absorb ${fmtQty(a.vol, 1)}`, bx + this.barW - 4, yy - rowPx / 2 - 1)
      }
    }

    // time-based levels and horizontal levels
    drawVwaps(g, ax, s, null)
    drawDevPoc(g, ax, s)
    const lab = new Labeler(g)
    drawSessionLevels(g, ax, s, lab)
    drawGamma(g, ax, s, lab)
    drawVwapLabels(ax, s, lab)
    if (store.last != null) {
      const yy = Math.round(this.y(store.last)) + 0.5
      g.strokeStyle = 'rgba(211,220,235,0.4)'
      g.setLineDash([1, 3])
      g.beginPath()
      g.moveTo(0, yy)
      g.lineTo(cw, yy)
      g.stroke()
      g.setLineDash([])
    }
    // range tool preview
    if (this.tdrag) {
      const xa = this.xOfT(Math.min(this.tdrag.t0, this.tdrag.t1))
      const xb = this.xOfT(Math.max(this.tdrag.t0, this.tdrag.t1))
      g.fillStyle = 'rgba(180,156,255,0.12)'
      g.fillRect(xa, 0, Math.max(2, xb - xa), ch)
      g.strokeStyle = C.violet
      g.strokeRect(xa + 0.5, 0.5, Math.max(2, xb - xa), ch - 1)
    }
    g.restore()

    // summary / stats strip
    this.drawStats(g, lay, n)

    // volume profile panel
    let x0 = cw
    if (s.profile) {
      const [t0, t1] = profileWindow(s.profileRange, [bars[0].t, bars[n - 1].t1])
      const pr = getProfile('foot', t0, t1, row, s.profileSrc, s.profileMode)
      g.fillStyle = C.panel
      g.fillRect(x0, 0, PROF_W, this.H)
      g.save()
      g.beginPath()
      g.rect(x0, 0, PROF_W, ch)
      g.clip()
      drawProfile(g, { ...ax, W: PROF_W }, pr, s.profileMode, x0 + 4, PROF_W - 10, 1, { alpha: 0.45 })
      g.restore()
      g.fillStyle = C.dim
      g.font = '500 10.5px "IBM Plex Sans", system-ui'
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      const rl: Record<string, string> = { session: 'Session', prev: 'Prior day', '4h': 'Last 4h', '1h': 'Last 1h',
        visible: 'Visible', '3d': '3-day composite', '7d': '7-day composite' }
      g.fillText(`${rl[s.profileRange]} · ${s.profileMode === 'svp' ? 'spot vs perps' : s.profileMode}`, x0 + 8, ch + 12)
      if (pr.main.poc != null) {
        g.fillStyle = C.amber
        g.fillText(`POC ${fmtPx(pr.main.poc, 0)}`, x0 + 8, ch + 28)
        g.fillStyle = C.dim
        if (pr.main.vah != null && pr.main.val != null)
          g.fillText(`VA ${fmtPx(pr.main.val, 0)}–${fmtPx(pr.main.vah, 0)}`, x0 + 8, ch + 44)
      }
      g.strokeStyle = C.line
      g.beginPath()
      g.moveTo(x0 + 0.5, 0)
      g.lineTo(x0 + 0.5, this.H)
      g.stroke()
      x0 += PROF_W
    }
    // price axis
    g.fillStyle = C.panel
    g.fillRect(x0, 0, AXIS_W, this.H)
    g.fillStyle = C.dim
    g.font = '500 11px "IBM Plex Sans", system-ui'
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    for (let p = Math.ceil(this.pAt(ch) / step) * step; p < this.pAt(0); p += step) {
      g.fillText(fmtPx(p, step < 1 ? 1 : 0), x0 + 8, this.y(p))
    }
    if (store.last != null) {
      const yy = this.y(store.last)
      if (yy > 0 && yy < ch) {
        g.fillStyle = store.lastDir > 0 ? C.buy : C.sell
        g.fillRect(x0 + 1, yy - 9, AXIS_W - 2, 18)
        g.fillStyle = '#06101a'
        g.font = '600 11px "IBM Plex Sans", system-ui'
        g.fillText(fmtPx(store.last, 1), x0 + 6, yy + 0.5)
      }
    }
    // stats row labels / footer
    g.fillStyle = C.panel
    g.fillRect(x0, ch, AXIS_W, this.sumH)
    g.font = '500 10px "IBM Plex Sans Condensed", system-ui'
    g.textBaseline = 'middle'
    if (s.stats) {
      STAT_ROWS.forEach((name, k) => {
        g.fillStyle = k === 0 ? C.faint : C.dim
        g.fillText(k === 0 ? `Row $${row}` : name, x0 + 6, ch + 3 + k * STAT_ROW + STAT_ROW / 2)
      })
    } else {
      g.fillStyle = C.faint
      g.fillText(`Row $${row}`, x0 + 8, ch + 14)
    }
    g.strokeStyle = C.line
    g.beginPath()
    g.moveTo(x0 + 0.5, 0)
    g.lineTo(x0 + 0.5, this.H)
    g.stroke()

    // crosshair
    const m = this.mouse
    if (m && m.x < cw && m.y < ch) {
      g.strokeStyle = 'rgba(211,220,235,0.35)'
      g.setLineDash([3, 3])
      g.beginPath()
      g.moveTo(0, m.y + 0.5)
      g.lineTo(cw, m.y + 0.5)
      g.stroke()
      g.setLineDash([])
      const p = this.pAt(m.y)
      g.font = '500 11px "IBM Plex Sans", system-ui'
      g.fillStyle = C.panel2
      g.fillRect(x0 + 1, m.y - 9, AXIS_W - 2, 18)
      g.fillStyle = '#fff'
      g.textAlign = 'left'
      g.fillText(fmtPx(p, 1), x0 + 6, m.y + 0.5)
      if (s.tool !== 'none') {
        g.fillStyle = C.violet
        g.font = '600 11px "IBM Plex Sans", system-ui'
        g.fillText(s.tool === 'range' ? 'Drag across bars to measure a range profile' : 'Click a bar to anchor a VWAP',
          10, 14)
      }
    }
  }

  drawZones(g: CanvasRenderingContext2D, lay: Layout, n: number) {
    const cw = this.chartW
    for (const z of lay.zones) {
      const i = lay.bars.findIndex((b) => b.t === z.t)
      if (i < 0) continue
      const xa = this.xOf(i, n) + this.barW - 2
      let xb = cw
      if (z.endT != null) {
        const j = lay.bars.findIndex((b) => b.t === z.endT)
        xb = j >= 0 ? this.xOf(j, n) + this.barW / 2 : cw
      }
      if (xb < 0 || xa > cw) continue
      const ya = this.y(z.hi)
      const yb = this.y(z.lo)
      if (z.kind === 'buyImb' || z.kind === 'sellImb') {
        const buy = z.kind === 'buyImb'
        g.fillStyle = buy ? 'rgba(43,217,159,0.10)' : 'rgba(255,92,122,0.10)'
        g.fillRect(xa, ya, xb - xa, yb - ya)
        g.strokeStyle = buy ? 'rgba(43,217,159,0.55)' : 'rgba(255,92,122,0.55)'
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(xa, Math.round(ya) + 0.5)
        g.lineTo(xb, Math.round(ya) + 0.5)
        g.moveTo(xa, Math.round(yb) + 0.5)
        g.lineTo(xb, Math.round(yb) + 0.5)
        g.stroke()
      } else {
        const yy = z.kind === 'unfinHigh' ? ya : z.kind === 'unfinLow' ? yb : (ya + yb) / 2
        const open = z.endT == null
        g.strokeStyle = z.kind === 'poc' ? (open ? 'rgba(255,209,102,0.8)' : 'rgba(242,181,68,0.25)')
          : open ? 'rgba(154,180,255,0.85)' : 'rgba(154,180,255,0.3)'
        g.setLineDash(z.kind === 'poc' ? [] : [4, 3])
        g.lineWidth = 1
        g.beginPath()
        g.moveTo(xa, Math.round(yy) + 0.5)
        g.lineTo(xb, Math.round(yy) + 0.5)
        g.stroke()
        g.setLineDash([])
        if (open && xb - xa > 40) {
          g.font = '600 9.5px "IBM Plex Sans Condensed", system-ui'
          g.textAlign = 'left'
          g.textBaseline = 'bottom'
          g.fillStyle = z.kind === 'poc' ? '#ffd166' : '#9ab4ff'
          g.fillText(z.kind === 'poc' ? 'nPOC' : 'unfinished', xa + 4, yy - 1)
        }
      }
    }
  }

  drawStats(g: CanvasRenderingContext2D, lay: Layout, n: number) {
    const s = this.pRef.current
    const bars = lay.bars
    const cw = this.chartW
    const ch = this.chartH
    const H = this.sumH
    g.fillStyle = C.panel
    g.fillRect(0, ch, cw, H)
    g.strokeStyle = C.line
    g.beginPath()
    g.moveTo(0, ch + 0.5)
    g.lineTo(cw, ch + 0.5)
    g.stroke()
    g.font = '500 10.5px "IBM Plex Sans Condensed", system-ui'
    g.textBaseline = 'middle'
    let cvd = 0
    const cvds: number[] = []
    for (const b of bars) {
      cvd += b.bv - b.sv
      cvds.push(cvd)
    }
    const maxAbsD = Math.max(1e-9, ...bars.map((b) => Math.abs(b.bv - b.sv)))
    const maxV = Math.max(1e-9, ...bars.map((b) => b.v))
    const maxOi = Math.max(1e-9, ...bars.map((b) => Math.abs(b.oiD)))
    const timeLbl = (i: number) => {
      const b = bars[i]
      let lbl = fmtTime(b.t).slice(0, 5)
      if (i === n - 1) {
        const left = Math.max(0, b.t1 - store.now())
        lbl += ` · ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`
      }
      return lbl
    }
    for (let i = 0; i < n; i++) {
      const b = bars[i]
      const bx = this.xOf(i, n)
      if (bx + this.barW < 0 || bx > cw) continue
      const cx = bx + this.barW / 2 + 3
      const d = b.bv - b.sv
      if (!s.stats) {
        g.fillStyle = d >= 0 ? 'rgba(43,217,159,0.16)' : 'rgba(255,92,122,0.16)'
        g.fillRect(bx + 10, ch + 21, (this.barW - 14) * (Math.abs(d) / maxAbsD), 14)
        g.textAlign = 'center'
        g.fillStyle = C.dim
        g.fillText(timeLbl(i), cx, ch + 10)
        g.fillStyle = d >= 0 ? C.buy : C.sell
        g.fillText(`Δ ${d >= 0 ? '+' : ''}${fmtQty(d, 1)}`, cx, ch + 28)
        g.fillStyle = C.text
        g.fillText(`Vol ${fmtQty(b.v, 0)}`, cx - this.barW * 0.22, ch + 47)
        g.fillStyle = cvds[i] >= 0 ? C.buy : C.sell
        g.fillText(`CVD ${fmtQty(cvds[i], 0)}`, cx + this.barW * 0.22, ch + 47)
      } else {
        const prevD = i > 0 ? bars[i - 1].bv - bars[i - 1].sv : 0
        let sb = 0
        let ss = 0
        if (!b.ax && b.rows.size) {
          const { buy, sell } = imbalances(b, s.imbalance)
          const runs = (set: Set<number>) => {
            const rs = [...set].sort((a, c) => a - c)
            let cnt = 0
            let k = 0
            while (k < rs.length) {
              let j = k
              while (j + 1 < rs.length && rs[j + 1] === rs[j] + 1) j++
              if (j - k + 1 >= 3) cnt++
              k = j + 1
            }
            return cnt
          }
          sb = runs(buy)
          ss = runs(sell)
        }
        const oiKind = b.oiD === 0 ? '' : b.oiD > 0 ? (b.c >= b.o ? 'new longs' : 'new shorts') : b.c <= b.o ? 'longs out' : 'shorts out'
        const buyPct = b.v > 0 ? (100 * b.bv) / b.v : 0
        const cells: [string, string, number, number][] = [ // text, color, bar fraction (signed), unused
          [timeLbl(i), C.dim, 0, 0],
          [fmtQty(b.v, 0), C.text, b.v / maxV, 0],
          [`${d >= 0 ? '+' : ''}${fmtQty(d, 1)}`, d >= 0 ? C.buy : C.sell, d / maxAbsD, 0],
          [`${d - prevD >= 0 ? '+' : ''}${fmtQty(d - prevD, 1)}`, d - prevD >= 0 ? C.buy : C.sell, 0, 0],
          [`+${fmtQty(b.dmax, 1)}`, C.buy, 0, 0],
          [fmtQty(b.dmin, 1), C.sell, 0, 0],
          [s.fpSrc === 'primary' ? b.n.toLocaleString() : '–', C.text, 0, 0],
          [`${buyPct.toFixed(0)}%`, buyPct >= 50 ? C.buy : C.sell, (buyPct - 50) / 50, 0],
          [sb || ss ? `${sb ? `${sb}B` : ''}${sb && ss ? ' ' : ''}${ss ? `${ss}S` : ''}` : '·', sb > ss ? C.buy : ss > sb ? C.sell : C.faint, 0, 0],
          [b.oiD ? `${b.oiD > 0 ? '+' : ''}${fmtQty(b.oiD, 0)} ${oiKind}` : '·',
            b.oiD > 0 ? (b.c >= b.o ? C.buy : C.sell) : b.oiD < 0 ? (b.c <= b.o ? C.orange : C.cyan) : C.faint, b.oiD / maxOi, 0],
          [b.lqL + b.lqS > 0 ? `${b.lqL ? `L ${fmtQty(b.lqL, 1)}` : ''}${b.lqL && b.lqS ? ' ' : ''}${b.lqS ? `S ${fmtQty(b.lqS, 1)}` : ''}` : '·',
            b.lqL >= b.lqS ? C.orange : C.cyan, 0, 0],
          [fmtQty(cvds[i], 0), cvds[i] >= 0 ? C.buy : C.sell, 0, 0],
        ]
        cells.forEach(([txt, col, frac], k) => {
          const y0 = ch + 3 + k * STAT_ROW
          if (frac) {
            g.fillStyle = frac >= 0 ? 'rgba(43,217,159,0.14)' : 'rgba(255,92,122,0.14)'
            if (k === 1) g.fillStyle = 'rgba(127,144,170,0.14)'
            if (k === 9) g.fillStyle = 'rgba(154,180,255,0.14)'
            g.fillRect(bx + 8, y0 + 1, (this.barW - 12) * Math.min(1, Math.abs(frac)), STAT_ROW - 2)
          }
          g.fillStyle = col
          g.textAlign = 'center'
          g.fillText(txt, cx, y0 + STAT_ROW / 2)
        })
      }
      g.strokeStyle = C.line
      g.beginPath()
      g.moveTo(Math.round(bx) + 0.5, ch)
      g.lineTo(Math.round(bx) + 0.5, ch + H)
      g.stroke()
    }
  }

  bind() {
    const cv = this.cv
    cv.addEventListener('wheel', (e) => {
      e.preventDefault()
      const f = Math.exp(Math.sign(e.deltaY) * Math.min(0.3, Math.abs(e.deltaY) / 400))
      if (e.ctrlKey || e.shiftKey) {
        this.barW = Math.max(30, Math.min(320, this.barW / f))
      } else {
        const pAt = this.pAt(e.offsetY)
        this.ppp = Math.max(0.05, Math.min(80, this.ppp * f))
        this.pCenter = pAt + (e.offsetY - this.chartH / 2) * this.ppp
      }
      this.dirty = true
    }, { passive: false })
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      cv.setPointerCapture(e.pointerId)
      const tool = this.pRef.current.tool
      if (tool !== 'none' && e.offsetX < this.chartW && e.offsetY < this.chartH) {
        const t = this.tAtX(e.offsetX)
        if (tool === 'avwap') {
          store.addAnchor(Math.min(t, store.now()))
          this.setTool('none')
        } else this.tdrag = { t0: t, t1: t }
        this.dirty = true
        return
      }
      this.drag = { x: e.clientX, y: e.clientY, xOff: this.xOff, p: this.pCenter ?? 0 }
    })
    cv.addEventListener('pointermove', (e) => {
      this.mouse = { x: e.offsetX, y: e.offsetY }
      if (this.tdrag) this.tdrag.t1 = this.tAtX(e.offsetX)
      const d = this.drag
      if (d) {
        const dx = e.clientX - d.x
        const dy = e.clientY - d.y
        if (Math.abs(dx) > 3) {
          this.xOff = Math.max(0, d.xOff + dx)
          if (this.xOff > 0) this.setLive(false)
        }
        if (Math.abs(dy) > 3) {
          this.autoCenter = false
          this.pCenter = d.p + dy * this.ppp
          this.setLive(false)
        }
      }
      this.dirty = true
    })
    cv.addEventListener('pointerup', () => {
      this.drag = null
      if (this.tdrag) {
        const lay = this.lay
        const tf = lay?.tf ?? 60_000
        let a = Math.min(this.tdrag.t0, this.tdrag.t1)
        let b = Math.max(this.tdrag.t0, this.tdrag.t1)
        a -= a % tf // snap to whole bars
        b = b - (b % tf) + tf
        this.tdrag = null
        store.addRange(a, Math.min(b, store.now() + 60_000))
        this.setTool('none')
        this.dirty = true
      }
    })
    cv.addEventListener('pointerleave', () => {
      this.mouse = null
      this.dirty = true
    })
    cv.addEventListener('dblclick', () => this.goLive())
    cv.addEventListener('contextmenu', (e) => {
      const t = this.tAtX(e.offsetX)
      const r = store.ranges.find((q) => t >= q.t0 && t <= q.t1)
      if (r) {
        e.preventDefault()
        store.removeRange(r.id)
        return
      }
      const tf = this.lay?.tf ?? 60_000
      const a = store.anchors.find((q) => Math.abs(q - t) < tf / 2)
      if (a != null) {
        e.preventDefault()
        store.removeAnchor(a)
      }
    })
  }
}
