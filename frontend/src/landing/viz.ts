// Live, resolution-independent illustrations of the eight Flowdeck tools for the landing page's tool showcase.
// Each one is a small simulation drawn on a canvas at the screen's full pixel density (sharp on 4K), animated only
// while it is on screen. They illustrate how each tool reads; they are not market data.
import { LUT } from '../shared/heatanim'

export interface Viz {
  init(w: number, h: number, dpr: number): void
  update(dt: number): void
  draw(g: CanvasRenderingContext2D): void
}

// ------------------------------------------------------------------------------------------- shared
const C = {
  bg: '#060709', grid: 'rgba(255,255,255,0.05)', axis: 'rgba(237,241,248,0.42)', text: 'rgba(240,243,250,0.92)',
  dim: 'rgba(237,241,248,0.5)', buy: '#2ee6a0', sell: '#ff4d6a', amber: '#ffb547', cyan: '#56d6ff', blue: '#2f7bff', white: '#f4f6fb',
}
const F = (px: number, w = 500) => `${w} ${px}px PJS, -apple-system, 'Segoe UI', sans-serif`
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const easeOut = (x: number) => 1 - Math.pow(1 - clamp(x), 3)
const fmt = (n: number, d = 0) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const heat = (v: number) => LUT[Math.round(clamp(v) * 255)]

function rng(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Smooth random walk with mean reversion: drifts, trends a little, never runs away. */
class Walk {
  v = 0
  constructor(public x: number, public center: number, private r: () => number, private kick = 1, private pull = 0.15, private damp = 1.6) {}
  step(dt: number) {
    this.v += (this.r() - 0.5) * this.kick * Math.sqrt(dt) * 6
    this.v -= (this.x - this.center) * this.pull * dt
    this.v *= Math.exp(-this.damp * dt)
    this.x += this.v * dt
    return this.x
  }
}

function pill(g: CanvasRenderingContext2D, x: number, y: number, text: string, color: string, align: 'left' | 'right' = 'left', bg = 'rgba(6,7,9,0.82)') {
  g.font = F(11.5, 600)
  const w = g.measureText(text).width + 14
  const x0 = align === 'right' ? x - w : x
  g.fillStyle = bg
  g.beginPath(); g.roundRect(x0, y - 10, w, 20, 10); g.fill()
  g.strokeStyle = color; g.globalAlpha *= 0.55; g.lineWidth = 1; g.stroke(); g.globalAlpha /= 0.55
  g.fillStyle = color; g.textBaseline = 'middle'; g.textAlign = 'left'
  g.fillText(text, x0 + 7, y + 0.5)
  return w
}

function legend(g: CanvasRenderingContext2D, items: [string, string, 'dot' | 'ring' | 'line' | 'dash' | 'dot-line'][], x = 16, y = 18) {
  g.font = F(11.5, 500)
  g.textBaseline = 'middle'
  g.textAlign = 'left'
  const maxX = g.canvas.width / g.getTransform().a - 12
  // first pass: lay out, so a dark backing can go behind each line and keep it readable over busy charts
  const rows: [number, number, number][] = [] // y, x0, x1
  {
    let lx = x, ly = y, x0 = x
    for (const [label, , kind] of items) {
      const need = (kind === 'dot' || kind === 'ring' ? 14 : 20) + g.measureText(label).width
      if (lx + need > maxX && lx > 20) { rows.push([ly, x0, lx - 16]); lx = 16; x0 = 16; ly += 18 }
      lx += need + 16
    }
    rows.push([ly, x0, lx - 16])
  }
  g.fillStyle = 'rgba(6,7,9,0.72)'
  for (const [ry, a, b] of rows) { g.beginPath(); g.roundRect(a - 8, ry - 10, b - a + 16, 20, 10); g.fill() }
  for (const [label, color, kind] of items) {
    const need = (kind === 'dot' || kind === 'ring' ? 14 : 20) + g.measureText(label).width
    if (x + need > maxX && x > 20) { x = 16; y += 18 }
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = 2
    if (kind === 'dot') { g.beginPath(); g.arc(x + 5, y, 4.5, 0, Math.PI * 2); g.fill() }
    else if (kind === 'ring') { g.beginPath(); g.arc(x + 5, y, 4, 0, Math.PI * 2); g.stroke() }
    else {
      g.setLineDash(kind === 'dash' ? [5, 3] : kind === 'dot-line' ? [1.5, 3] : [])
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + 14, y); g.stroke(); g.setLineDash([])
    }
    const lx = x + (kind === 'dot' || kind === 'ring' ? 14 : 20)
    g.fillStyle = C.dim
    g.fillText(label, lx, y + 0.5)
    x = lx + g.measureText(label).width + 16
  }
}

function priceAxis(g: CanvasRenderingContext2D, x: number, h: number, top: number, bottom: number, pTop: number, pBot: number, step: number) {
  g.font = F(11, 500); g.textAlign = 'left'; g.textBaseline = 'middle'
  const first = Math.ceil(pBot / step) * step
  for (let p = first; p <= pTop; p += step) {
    const y = top + ((pTop - p) / (pTop - pBot)) * (h - top - bottom)
    if (y < 12 || y > h - 12) continue
    g.fillStyle = C.grid; g.fillRect(0, Math.round(y), x - 6, 1)
    g.fillStyle = C.axis; g.fillText(fmt(p), x, y)
  }
}

function bubble(g: CanvasRenderingContext2D, x: number, y: number, r: number, buy: boolean, a = 1) {
  if (!(r > 0.6) || !(a > 0)) return // still popping in (or fully faded): nothing to draw yet
  g.globalAlpha = a
  if (buy) {
    const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r)
    gr.addColorStop(0, 'rgba(170,255,220,0.95)'); gr.addColorStop(0.45, 'rgba(46,230,160,0.85)'); gr.addColorStop(1, 'rgba(10,120,80,0.75)')
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
  } else {
    g.fillStyle = 'rgba(255,77,106,0.18)'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
    g.strokeStyle = C.sell; g.lineWidth = Math.min(r, Math.max(1.5, r * 0.14)); g.beginPath(); g.arc(x, y, Math.max(0.3, r - g.lineWidth / 2), 0, Math.PI * 2); g.stroke()
  }
  g.globalAlpha = 1
}

// ------------------------------------------------------------------------------------------- 1. liquidity heatmap
export class HeatmapViz implements Viz {
  w = 0; h = 0; dpr = 1
  buf = document.createElement('canvas')
  bg!: CanvasRenderingContext2D
  r = rng(11)
  rows = 0
  row = 8
  base: number[] = []
  lvl: number[] = [] // live resting size per row: drifts, jumps when orders arrive or leave
  price!: Walk
  walls: { row: number; size: number; target: number; age: number; life: number; fate: 'hold' | 'pull'; dead: boolean }[] = []
  hist: number[] = [] // price row per painted column, newest last
  trades: { x: number; y: number; s: number; buy: boolean }[] = []
  tags: { x: number; y: number; text: string; age: number }[] = []
  acc = 0
  t = 0
  tradeRate = 7 // prints per second (before the size cut)
  kick = 3.4 // how restless price is
  floor = 1 // scale for the ordinary resting size between the walls
  fillAt: number | null = null // while pre-filling: paint columns left to right instead of shifting the whole buffer for each one
  colW = 2
  speed = 38
  axisW = 66
  init(w: number, h: number, dpr: number) {
    this.w = w; this.h = h; this.dpr = dpr
    this.buf.width = Math.round(w * dpr); this.buf.height = Math.round(h * dpr)
    this.bg = this.buf.getContext('2d')!
    this.bg.setTransform(dpr, 0, 0, dpr, 0, 0)
    this.rows = Math.ceil(h / this.row)
    this.base = Array.from({ length: this.rows }, (_, i) => 0.12 + this.r() * 0.2 + 0.12 * Math.max(0, Math.sin(i * 0.37 + this.r() * 0.4)) ** 3)
    this.lvl = this.base.map((b) => b)
    this.price = new Walk(this.rows / 2, this.rows / 2, this.r, this.kick, 0.05, 1.1)
    this.walls = []; this.hist = []; this.trades = []; this.tags = []
    for (let i = 0; i < 4; i++) this.spawnWall(true)
    // pre-fill the screen so it opens full
    const cols = Math.ceil((w - this.axisW) / this.colW) + 2
    this.fillAt = w - this.axisW - cols * this.colW
    for (let i = 0; i < cols; i++) this.step(this.colW / this.speed)
    this.fillAt = null
  }
  spawnWall(initial = false) {
    const pr = this.price.x
    let row = 0
    for (let k = 0; k < 20; k++) {
      row = Math.round(pr + (this.r() < 0.5 ? -1 : 1) * (6 + this.r() * (this.rows * 0.4)))
      if (row > 1 && row < this.rows - 2 && this.walls.every((w) => Math.abs(w.row - row) > 3)) break
    }
    const target = 0.42 + this.r() * 0.5
    const life = 16 + this.r() * 22
    this.walls.push({ row, size: initial ? target : 0, target, age: initial ? this.r() * life * 0.7 : 0, life, fate: this.r() < 0.45 ? 'pull' : 'hold', dead: false })
  }
  paintColumn() {
    const g = this.bg
    let x = this.w - this.axisW - this.colW
    if (this.fillAt !== null) { x = this.fillAt; this.fillAt += this.colW }
    else {
      g.globalCompositeOperation = 'copy' // shift everything one column to the left
      g.drawImage(this.buf, -this.colW, 0, this.w, this.h)
      g.globalCompositeOperation = 'source-over'
    }
    const pr = this.price.x
    for (let i = 0; i < this.rows; i++) {
      // orders come and go: each row's size drifts toward its own level and occasionally jumps
      let l = this.lvl[i] + (this.base[i] - this.lvl[i]) * 0.01 + (this.r() - 0.5) * 0.02
      if (this.r() < 0.004) l += 0.1 + this.r() * 0.24
      if (this.r() < 0.004) l *= 0.35
      this.lvl[i] = l = clamp(l, 0.05, 0.6)
      let v = (l * (0.9 + this.r() * 0.2) + 0.2 * Math.exp(-Math.abs(i - pr) / 5)) * this.floor
      for (const wl of this.walls) {
        const d = Math.abs(wl.row - i)
        if (d === 0) v += wl.size
        else if (d === 1) v += wl.size * 0.72
        else if (d === 2) v += wl.size * 0.18
      }
      g.fillStyle = heat(v)
      g.fillRect(x, i * this.row, this.colW, this.row - 1)
    }
    g.fillStyle = C.bg
    g.fillRect(this.w - this.axisW, 0, this.axisW, this.h)
    this.hist.push(pr)
    if (this.hist.length > (this.w - this.axisW) / this.colW + 4) this.hist.shift()
  }
  step(dt: number) {
    this.t += dt
    const prev = this.price.x
    this.price.step(dt)
    // walls that hold turn price back; walls set to be pulled vanish as price gets close
    for (const wl of this.walls) {
      if (wl.dead) continue
      wl.age += dt
      wl.size = lerp(wl.size, wl.target, 1 - Math.exp(-dt * 1.4))
      const near = Math.abs(this.price.x - wl.row)
      if (wl.fate === 'hold' && wl.size > 0.3 && (prev - wl.row) * (this.price.x - wl.row) <= 0) { this.price.x = prev; this.price.v *= -0.6 }
      if (wl.fate === 'pull' && near < 3.2 && wl.size > 0.5) {
        wl.dead = true
        this.tags.push({ x: this.w - this.axisW - 4, y: wl.row * this.row + this.row / 2, text: `Pulled ${Math.round(150 + wl.target * 250)} BTC`, age: 0 })
      }
      if (wl.age > wl.life) { wl.target = 0; wl.fate = 'hold'; if (wl.size < 0.03) wl.dead = true }
    }
    this.walls = this.walls.filter((w) => !w.dead)
    while (this.walls.filter((w) => w.target > 0).length < 4) this.spawnWall()
    // trades print at the price, sized by volume
    if (this.r() < dt * this.tradeRate) {
      const s = Math.pow(this.r(), 3.2) * 30 + 0.4
      if (s > 1.4) this.trades.push({ x: this.w - this.axisW - 3, y: this.price.x * this.row, s, buy: this.price.v > 0 ? this.r() < 0.72 : this.r() < 0.28 })
    }
    const dx = this.speed * dt
    for (const b of this.trades) b.x -= dx
    for (const tg of this.tags) { tg.x -= dx; tg.age += dt }
    this.trades = this.trades.filter((b) => b.x > -40)
    this.tags = this.tags.filter((t) => t.age < 4.5)
    this.acc += dx
    while (this.acc >= this.colW) { this.acc -= this.colW; this.paintColumn() }
  }
  update(dt: number) { this.step(Math.min(dt, 0.05)) }
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    g.drawImage(this.buf, 0, 0, w, h)
    // price line
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.6; g.beginPath()
    const n = this.hist.length
    for (let i = 0; i < n; i++) {
      const x = this.w - this.axisW - (n - i) * this.colW
      const y = this.hist[i] * this.row
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y)
    }
    g.stroke()
    for (const b of this.trades) bubble(g, b.x, b.y, 2.4 + Math.sqrt(b.s) * 2.6, b.buy, 0.92)
    for (const t of this.tags) {
      g.globalAlpha = clamp(Math.min(t.age * 4, (4.5 - t.age) / 1.2))
      pill(g, t.x - 6, t.y, t.text, C.amber, 'right')
      g.globalAlpha = 1
    }
    // walls that hold: labelled at the axis
    for (const wl of this.walls) {
      if (wl.size < 0.4) continue
      const y = wl.row * this.row + this.row / 2
      g.globalAlpha = clamp((wl.size - 0.4) * 3)
      pill(g, this.w - this.axisW - 6, y, `${Math.round(150 + wl.target * 250)} BTC`, wl.fate === 'hold' ? C.white : C.dim, 'right')
      g.globalAlpha = 1
    }
    const p0 = 85600 + (this.rows / 2) * 5
    priceAxis(g, this.w - this.axisW + 10, h, 0, 0, p0, p0 - this.rows * 5, 25)
    // live price tag
    const py = this.price.x * this.row
    g.fillStyle = C.buy; g.beginPath(); g.roundRect(this.w - this.axisW + 4, py - 10, this.axisW - 8, 20, 4); g.fill()
    g.fillStyle = '#04120c'; g.font = F(11.5, 700); g.textBaseline = 'middle'; g.textAlign = 'left'
    g.fillText(fmt(p0 - this.price.x * 5, 1), this.w - this.axisW + 9, py + 0.5)
    legend(g, [['Resting orders, brighter = bigger', C.amber, 'dot'], ['Buy', C.buy, 'dot'], ['Sell', C.sell, 'ring']])
  }
}

/** The heatmap with nothing on top: no axis, labels or legend. Background for the closing call to action. */
export class AmbientHeatViz extends HeatmapViz {
  axisW = 0
  speed = 26
  colW = 3
  row = 12
  tradeRate = 3
  kick = 2
  floor = 0.62
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    g.drawImage(this.buf, 0, 0, w, h)
    g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1.5; g.beginPath()
    const n = this.hist.length
    for (let i = 0; i < n; i++) {
      const x = w - (n - i) * this.colW
      const y = this.hist[i] * this.row
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y)
    }
    g.stroke()
    for (const b of this.trades) bubble(g, b.x, b.y, 2.4 + Math.sqrt(b.s) * 3, b.buy, 0.75)
  }
}

// ------------------------------------------------------------------------------------------- 2. big trades
export class TradesViz implements Viz {
  w = 0; h = 0
  r = rng(7)
  price!: Walk
  pts: { x: number; y: number }[] = []
  trades: { x: number; y: number; s: number; buy: boolean; v: string; age: number }[] = []
  t = 0
  readonly speed = 46
  readonly axisW = 66
  init(w: number, h: number) {
    this.w = w; this.h = h
    this.price = new Walk(h * 0.5, h * 0.52, this.r, 30, 0.12, 1.1)
    this.pts = []; this.trades = []
    for (let i = 0; i < 400; i++) this.step(1 / 30)
  }
  step(dt: number) {
    this.t += dt
    const x0 = this.w - this.axisW - 10
    const y = this.price.step(dt)
    const dx = this.speed * dt
    for (const p of this.pts) p.x -= dx
    this.pts.push({ x: x0, y })
    this.pts = this.pts.filter((p) => p.x > -10)
    for (const b of this.trades) { b.x -= dx; b.age += dt }
    this.trades = this.trades.filter((b) => b.x > -60)
    if (this.r() < dt * 3.2) {
      const s = 2 + Math.pow(this.r(), 4.2) * 36
      const buy = this.price.v < 0 ? this.r() < 0.3 : this.r() < 0.7
      const v = ['BIN', 'BYB', 'OKX', 'CB'][Math.floor(this.r() * 4)]
      this.trades.push({ x: x0, y: y + (this.r() - 0.5) * 4, s, buy, v, age: 0 })
    }
  }
  update(dt: number) { this.step(Math.min(dt, 0.05)) }
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    // faint book behind
    for (let y = 0; y < h; y += 8) { g.fillStyle = `rgba(28,92,126,${0.05 + 0.05 * Math.sin(y * 0.13) ** 2})`; g.fillRect(0, y, w - this.axisW, 7) }
    priceAxis(g, w - this.axisW + 10, h, 0, 0, 85760, 85440, 40)
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.6; g.beginPath()
    this.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke()
    const sorted = [...this.trades].sort((a, b) => b.s - a.s)
    const labelled: number[] = []
    for (const b of sorted) {
      const r = (4 + Math.sqrt(b.s) * 4.2) * easeOut(b.age / 0.35)
      bubble(g, b.x, b.y, r, b.buy, clamp(b.x / 60))
      if (b.s >= 9 && b.age > 0.3 && labelled.every((lx) => Math.abs(lx - b.x) > 52)) {
        labelled.push(b.x)
        g.globalAlpha = clamp(b.x / 60) * clamp((b.age - 0.3) * 4)
        g.font = F(12, 700); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = C.white
        g.fillText(b.s.toFixed(1), b.x, b.y - r - 9)
        g.font = F(10, 600); g.fillStyle = C.dim; g.fillText(b.v, b.x, b.y - r - 22)
        g.globalAlpha = 1
      }
    }
    legend(g, [['Market buy', C.buy, 'dot'], ['Market sell', C.sell, 'ring'], ['Size in BTC, from 2 BTC up', C.dim, 'line']])
  }
}

// ------------------------------------------------------------------------------------------- 3. footprint
interface Candle { cells: Map<number, { bid: number; ask: number; flash: number }>; o: number; c: number; hi: number; lo: number; label: string }
export class FootprintViz implements Viz {
  w = 0; h = 0
  r = rng(5)
  candles: Candle[] = []
  p = 0 // price level (integer rows)
  pv = 0
  t = 0
  shift = 0 // 0..1 slide while a candle closes
  clock = 0
  minute = 41
  N = 5
  readonly rows = 10
  init(w: number, h: number) {
    this.w = w; this.h = h
    this.N = w < 620 ? 3 : 5
    this.candles = []; this.p = 5; this.pv = 0; this.minute = 41
    for (let i = 0; i < this.N; i++) { this.newCandle(); for (let k = 0; k < 70; k++) this.trade() }
    this.newCandle()
    for (let k = 0; k < 20; k++) this.trade()
  }
  newCandle() {
    this.candles.push({ cells: new Map(), o: this.p, c: this.p, hi: this.p, lo: this.p, label: `01:${String(this.minute++ % 60).padStart(2, '0')}` })
    if (this.candles.length > this.N + 1) this.candles.shift()
  }
  trade() {
    if (this.r() < 0.35) {
      this.pv += (this.r() - 0.5) * 1.4 - (this.p - 5) * 0.08
      this.p = Math.max(1, Math.min(this.rows - 2, Math.round(this.p + Math.sign(this.pv) * (this.r() < 0.6 ? 1 : 0))))
    }
    const c = this.candles[this.candles.length - 1]
    const cell = c.cells.get(this.p) ?? { bid: 0, ask: 0, flash: 0 }
    const buy = this.pv > 0 ? this.r() < 0.68 : this.r() < 0.32
    const s = Math.pow(this.r(), 2.4) * 18 + 0.2
    if (buy) cell.ask += s; else cell.bid += s
    cell.flash = 1
    c.cells.set(this.p, cell)
    c.c = this.p; c.hi = Math.max(c.hi, this.p); c.lo = Math.min(c.lo, this.p)
  }
  update(dt: number) {
    this.t += dt; this.clock += dt
    if (this.r() < dt * 9) this.trade()
    for (const c of this.candles) for (const cell of c.cells.values()) cell.flash = Math.max(0, cell.flash - dt * 2.5)
    if (this.clock > 4.6) { this.clock = 0; this.shift = 1; this.newCandle() }
    this.shift = Math.max(0, this.shift - dt * 2.2)
  }
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    const axisW = 66, top = 46, bottom = 30
    const rh = (h - top - bottom) / this.rows
    const cw = (w - axisW - 24) / this.N
    const pTop = 85660
    priceAxis(g, w - axisW + 10, h, top + rh / 2, bottom + rh / 2, pTop, pTop - (this.rows - 1) * 10, 10)
    const off = easeOut(1 - this.shift) // slide left as the new candle opens
    const list = this.candles.slice(-this.N - 1)
    g.save(); g.beginPath(); g.rect(8, 0, w - axisW - 8, h); g.clip()
    list.forEach((c, i) => {
      const x = 12 + (i - 1 + (1 - off)) * cw
      if (x < -cw * 0.4 || x > w - axisW) return
      g.globalAlpha = clamp((x + cw * 0.4) / (cw * 0.6))
      const live = i === list.length - 1
      let poc = -1, pocV = -1, vmax = 1
      for (const [k, cell] of c.cells) { const v = cell.bid + cell.ask; if (v > pocV) { pocV = v; poc = k } vmax = Math.max(vmax, v) }
      // candle body
      const bx = x + 6
      const yOf = (k: number) => top + (this.rows - 1 - k) * rh
      g.fillStyle = C.dim; g.fillRect(bx + 2, yOf(c.hi) + 4, 1.5, yOf(c.lo) - yOf(c.hi) + rh - 8)
      const up = c.c >= c.o
      g.fillStyle = up ? C.buy : C.sell
      const y1 = Math.min(yOf(c.o), yOf(c.c)), y2 = Math.max(yOf(c.o), yOf(c.c)) + rh
      g.fillRect(bx, y1 + 3, 5.5, y2 - y1 - 6)
      // cells: sells (bid) left, buys (ask) right
      const cx0 = x + 20, cwid = cw - 28
      for (const [k, cell] of c.cells) {
        const y = yOf(k)
        const v = (cell.bid + cell.ask) / vmax
        g.fillStyle = `rgba(86,214,255,${0.04 + v * 0.13})`
        g.fillRect(cx0, y + 1, cwid, rh - 2)
        if (cell.flash > 0) { g.fillStyle = `rgba(255,255,255,${cell.flash * 0.12})`; g.fillRect(cx0, y + 1, cwid, rh - 2) }
        const bidImb = cell.bid >= 3 * cell.ask && cell.bid > 3
        const askImb = cell.ask >= 3 * cell.bid && cell.ask > 3
        g.font = F(Math.min(13, rh * 0.42), 600); g.textBaseline = 'middle'
        g.textAlign = 'right'; g.fillStyle = bidImb ? C.sell : 'rgba(240,243,250,0.78)'
        g.fillText(cell.bid.toFixed(1), cx0 + cwid / 2 - 6, y + rh / 2)
        g.textAlign = 'left'; g.fillStyle = askImb ? C.buy : 'rgba(240,243,250,0.78)'
        g.fillText(cell.ask.toFixed(1), cx0 + cwid / 2 + 6, y + rh / 2)
        g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(cx0 + cwid / 2, y + 5, 1, rh - 10)
      }
      if (poc >= 0) { g.strokeStyle = C.amber; g.lineWidth = 1.5; g.strokeRect(cx0 + 0.5, yOf(poc) + 1.5, cwid - 1, rh - 3) }
      g.font = F(11, 500); g.textAlign = 'center'; g.fillStyle = live ? C.text : C.dim
      g.fillText(live ? `${c.label} live` : c.label, cx0 + cwid / 2, h - 14)
      g.globalAlpha = 1
    })
    g.restore()
    legend(g, [['Sells × buys at each price', C.dim, 'line'], ['Imbalance ≥ 3×', C.buy, 'dot'], ['Busiest price (POC)', C.amber, 'line']])
  }
}

// ------------------------------------------------------------------------------------------- 4. volume profile
export class ProfileViz implements Viz {
  w = 0; h = 0
  r = rng(3)
  price!: Walk
  vol: number[] = []
  pts: { x: number; y: number }[] = []
  rows = 0
  readonly row = 9
  readonly speed = 30
  init(w: number, h: number) {
    this.w = w; this.h = h
    this.rows = Math.floor((h - 40) / this.row)
    this.vol = new Array(this.rows).fill(0)
    this.price = new Walk(this.rows * 0.5, this.rows * 0.5, this.r, 3.6, 0.1, 1.0)
    this.pts = []
    for (let i = 0; i < 900; i++) this.step(1 / 30)
  }
  step(dt: number) {
    const p = this.price.step(dt)
    const k = Math.round(p)
    if (k >= 0 && k < this.rows) this.vol[k] += dt * (0.6 + this.r())
    for (let i = 0; i < this.rows; i++) this.vol[i] *= Math.exp(-dt * 0.02)
    const x0 = this.w * 0.56
    for (const q of this.pts) q.x -= this.speed * dt
    this.pts.push({ x: x0, y: 30 + p * this.row })
    this.pts = this.pts.filter((q) => q.x > -4)
  }
  update(dt: number) { this.step(Math.min(dt, 0.05)) }
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    const axisW = 66
    const vmax = Math.max(...this.vol, 1e-6)
    let poc = 0
    this.vol.forEach((v, i) => { if (v > this.vol[poc]) poc = i })
    // value area: grow from the POC until 70 % of the volume is inside
    const total = this.vol.reduce((a, b) => a + b, 0)
    let lo = poc, hi = poc, acc = this.vol[poc]
    while (acc < total * 0.7 && (lo > 0 || hi < this.rows - 1)) {
      const up = hi < this.rows - 1 ? this.vol[hi + 1] : -1
      const dn = lo > 0 ? this.vol[lo - 1] : -1
      if (up >= dn) { hi++; acc += up } else { lo--; acc += dn }
    }
    const yOf = (i: number) => 30 + i * this.row
    const px0 = w * 0.6, pw = w - axisW - px0 - 10
    g.fillStyle = 'rgba(86,214,255,0.06)'; g.fillRect(0, yOf(lo) - this.row / 2, w - axisW, (hi - lo + 1) * this.row)
    for (let i = 0; i < this.rows; i++) {
      const bw = (this.vol[i] / vmax) * pw
      const inVA = i >= lo && i <= hi
      g.fillStyle = i === poc ? C.amber : inVA ? 'rgba(86,214,255,0.62)' : 'rgba(86,214,255,0.24)'
      g.fillRect(px0, yOf(i) - this.row / 2 + 1, bw, this.row - 2)
    }
    g.setLineDash([4, 4]); g.strokeStyle = C.amber; g.lineWidth = 1.2
    g.beginPath(); g.moveTo(0, yOf(poc)); g.lineTo(px0 - 6, yOf(poc)); g.stroke(); g.setLineDash([])
    g.strokeStyle = 'rgba(255,255,255,0.88)'; g.lineWidth = 1.6; g.beginPath()
    this.pts.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.stroke()
    pill(g, px0 - 10, yOf(poc), 'POC', C.amber, 'right')
    pill(g, px0 - 10, yOf(hi) + this.row / 2 + 2, 'VAL', C.cyan, 'right')
    pill(g, px0 - 10, yOf(lo) - this.row / 2 - 2, 'VAH', C.cyan, 'right')
    priceAxis(g, w - axisW + 10, h, 30, h - 30 - this.rows * this.row + this.row, 85700, 85700 - (this.rows - 1) * 5, 50)
    legend(g, [['Volume at price', C.cyan, 'dot'], ['Value area (70 %)', 'rgba(86,214,255,0.45)', 'line'], ['Point of control', C.amber, 'dash']])
  }
}

// ------------------------------------------------------------------------------------------- 5. delta and CVD
export class DeltaViz implements Viz {
  w = 0; h = 0
  r = rng(13)
  bars: { d: number }[] = []
  perp: number[] = []
  spot: number[] = []
  acc = 0
  trend = 0
  readonly barW = 7
  init(w: number, h: number) {
    this.w = w; this.h = h
    this.bars = []; this.perp = [0]; this.spot = [0]
    for (let i = 0; i < 200; i++) this.addBar()
  }
  addBar() {
    this.trend += (this.r() - 0.5) * 0.5 - this.trend * 0.05
    const d = this.trend * 6 + (this.r() - 0.5) * 9
    this.bars.push({ d })
    this.perp.push(this.perp[this.perp.length - 1] + d)
    this.spot.push(this.spot[this.spot.length - 1] + d * 0.45 + (this.r() - 0.5) * 3 - this.trend * 1.2)
    const max = Math.ceil((this.w - 80) / this.barW) + 2
    while (this.bars.length > max) { this.bars.shift(); this.perp.shift(); this.spot.shift() }
  }
  update(dt: number) {
    this.acc += dt * 6
    while (this.acc >= 1) { this.acc -= 1; this.addBar() }
  }
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    const right = w - 70, top = 44, mid = h * 0.6, bottom = h - 14
    const n = this.bars.length
    const xOf = (i: number) => right - (n - 1 - i + this.acc) * this.barW
    // CVD lines (upper panel)
    const lines: [number[], string, number[]][] = [[this.perp, C.amber, []], [this.spot, C.cyan, [5, 4]]]
    const all = [...this.perp, ...this.spot]
    const lo = Math.min(...all), hi = Math.max(...all)
    const yC = (v: number) => top + (1 - (v - lo) / (hi - lo || 1)) * (mid - top - 24)
    g.fillStyle = C.grid; for (let k = 0; k < 4; k++) g.fillRect(0, top + (k * (mid - top - 24)) / 3, right, 1)
    for (const [s, col, dash] of lines) {
      g.strokeStyle = col; g.lineWidth = 2; g.setLineDash(dash); g.beginPath()
      s.forEach((v, i) => (i ? g.lineTo(xOf(i), yC(v)) : g.moveTo(xOf(i), yC(v)))); g.stroke(); g.setLineDash([])
      pill(g, right + 6, yC(s[s.length - 1]), (s[s.length - 1] >= 0 ? '+' : '') + fmt(s[s.length - 1]), col)
    }
    // delta bars (lower panel): buyers above the zero line, sellers below
    const zero = (mid + bottom) / 2
    const dm = Math.max(...this.bars.map((b) => Math.abs(b.d)), 1)
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(0, zero, right, 1)
    this.bars.forEach((b, i) => {
      const bh = (b.d / dm) * (bottom - mid) * 0.46
      g.fillStyle = b.d >= 0 ? C.buy : C.sell
      g.fillRect(xOf(i) - this.barW / 2 + 1, b.d >= 0 ? zero - bh : zero, this.barW - 2, Math.abs(bh))
    })
    g.font = F(11, 500); g.fillStyle = C.dim; g.textAlign = 'left'; g.textBaseline = 'middle'
    g.fillText('Delta per bar: buyers above, sellers below', 16, mid + 8)
    legend(g, [['Perps CVD', C.amber, 'line'], ['Spot CVD', C.cyan, 'dash']])
  }
}

// ------------------------------------------------------------------------------------------- 6. absorption
export class AbsorbViz implements Viz {
  w = 0; h = 0
  r = rng(17)
  t = 0
  hits: { x: number; y: number; s: number; age: number }[] = []
  pts: { x: number; y: number }[] = []
  absorbed = 0
  rows: number[] = []
  readonly L = 10.5
  init(w: number, h: number) {
    this.w = w; this.h = h
    this.rows = Array.from({ length: Math.ceil(h / 8) }, () => 0.12 + this.r() * 0.14)
    this.reset()
  }
  reset() { this.t = 0; this.hits = []; this.pts = []; this.absorbed = 0 }
  wallY() { return this.h * 0.66 }
  priceAt(t: number) {
    const wy = this.wallY(), top = this.h * 0.22
    if (t < 3) return lerp(top, wy - 6, easeOut(t / 3)) + Math.sin(t * 7) * 5
    if (t < 6.2) return wy - 6 - Math.abs(Math.sin(t * 5.3)) * 14
    return lerp(wy - 8, this.h * 0.4, easeOut((t - 6.2) / 2.2)) + Math.sin(t * 6) * 4
  }
  update(dt: number) {
    this.t += Math.min(dt, 0.05)
    if (this.t > this.L) this.reset()
    const x = this.w * 0.62
    const y = this.priceAt(this.t)
    for (const p of this.pts) p.x -= 30 * dt
    this.pts.push({ x, y })
    this.pts = this.pts.filter((p) => p.x > -4)
    for (const hh of this.hits) { hh.x -= 30 * dt; hh.age += dt }
    if (this.t > 3 && this.t < 6.2 && this.r() < dt * 7) {
      const s = 4 + Math.pow(this.r(), 2) * 30
      this.hits.push({ x, y: this.wallY() - 4, s, age: 0 })
      this.absorbed += s
    }
  }
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    const wy = this.wallY()
    this.rows.forEach((v, i) => { g.fillStyle = heat(v * 0.9); g.fillRect(0, i * 8, w - 66, 7) })
    // the bid wall: stays bright while it is hit (it holds)
    const pulse = this.t > 3 && this.t < 6.2 ? 0.08 * Math.sin(this.t * 20) : 0
    g.fillStyle = heat(0.93 + pulse); g.fillRect(0, wy - 4, w - 66, 8)
    g.fillStyle = 'rgba(255,146,46,0.18)'; g.fillRect(0, wy - 12, w - 66, 24)
    pill(g, w - 74, wy, `Bid wall ${fmt(420 - this.absorbed * 0.15)} BTC`, C.amber, 'right')
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.8; g.beginPath()
    this.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke()
    for (const hh of this.hits) bubble(g, hh.x, hh.y, (4 + Math.sqrt(hh.s) * 3.4) * easeOut(hh.age / 0.3), false, clamp(1.5 - hh.age * 0.25))
    // counter, then the verdict once price turns
    g.font = F(12, 600); g.textAlign = 'left'; g.textBaseline = 'middle'
    if (this.t > 3) { g.fillStyle = C.text; g.fillText(`Sold into the wall: ${fmt(this.absorbed)} BTC`, 16, h - 22) }
    if (this.t > 6.4) {
      const a = clamp((this.t - 6.4) * 3)
      g.globalAlpha = a
      const mx = this.w * 0.62 - (this.t - 6.4) * 30 - 3.2 * 30 / 2
      g.fillStyle = C.amber; g.beginPath(); g.moveTo(mx, wy - 22); g.lineTo(mx + 7, wy - 15); g.lineTo(mx, wy - 8); g.lineTo(mx - 7, wy - 15); g.closePath(); g.fill()
      const bw = pill(g, Math.min(mx + 14, w - 250), wy - 40, w < 620 ? `Absorbed ${fmt(this.absorbed)} BTC, held` : `Absorption: ${fmt(this.absorbed)} BTC absorbed, wall held`, C.amber)
      // score 60 s later
      const s = clamp((this.t - 7.2) / 1.6)
      const bx0 = Math.min(mx + 14, w - 250)
      g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(bx0, wy - 24, bw, 4)
      g.fillStyle = C.buy; g.fillRect(bx0, wy - 24, bw * s, 4)
      if (s >= 1) { g.font = F(11.5, 600); g.fillStyle = C.buy; g.fillText('Scored 60 s later: +$46', bx0, wy + 32) }
      g.globalAlpha = 1
    }
    priceAxis(g, w - 56, h, 0, 0, 85700, 85700 - (h / 8) * 5, 25)
    if (this.t > this.L - 0.4) { g.fillStyle = `rgba(6,7,9,${(this.t - (this.L - 0.4)) / 0.4})`; g.fillRect(0, 0, w, h) }
    if (this.t < 0.4) { g.fillStyle = `rgba(6,7,9,${1 - this.t / 0.4})`; g.fillRect(0, 0, w, h) }
    legend(g, [['Market sells hitting the wall', C.sell, 'ring'], ['Absorption signal', C.amber, 'dot']])
  }
}

// ------------------------------------------------------------------------------------------- 7. options gamma
export class GammaViz implements Viz {
  w = 0; h = 0
  r = rng(19)
  strikes: number[] = []
  cur: number[] = []
  target: number[] = []
  clock = 0
  flash = 0
  price!: Walk
  init(w: number, h: number) {
    this.w = w; this.h = h
    this.strikes = []
    for (let k = 81000; k <= 89000; k += 500) this.strikes.push(k)
    this.refresh(); this.cur = [...this.target]
    this.price = new Walk(85300, 85300, this.r, 260, 0.2, 0.9)
  }
  refresh() {
    this.target = this.strikes.map((k) => {
      const call = Math.exp(-(((k - 87000) / 1100) ** 2)) * 1.0
      const put = -Math.exp(-(((k - 83000) / 1000) ** 2)) * 0.82
      const near = 0.25 * Math.exp(-(((k - 85500) / 900) ** 2))
      return call + put + near + (this.r() - 0.5) * 0.12
    })
    this.flash = 1
  }
  update(dt: number) {
    dt = Math.min(dt, 0.05)
    this.clock += dt
    if (this.clock > 3.4) { this.clock = 0; this.refresh() }
    this.flash = Math.max(0, this.flash - dt * 1.5)
    this.cur = this.cur.map((v, i) => lerp(v, this.target[i], 1 - Math.exp(-dt * 3)))
    this.price.step(dt)
    this.price.x = Math.max(83600, Math.min(86900, this.price.x))
  }
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    const compact = w < 620
    const top = compact ? 76 : 62, bottom = 20, left = compact ? 58 : 70, right = w - (compact ? 104 : 150)
    const n = this.strikes.length
    const rh = (h - top - bottom) / n
    const zx = (left + right) / 2
    const half = (right - left) / 2 - 8
    const yOfP = (p: number) => top + ((89000 - p) / 8000) * (n - 1) * rh + rh / 2
    g.fillStyle = 'rgba(255,255,255,0.16)'; g.fillRect(zx, top - 6, 1, h - top - bottom + 6)
    g.font = F(11, 500); g.textBaseline = 'middle'
    this.strikes.forEach((k, i) => {
      const y = yOfP(k)
      const v = this.cur[i]
      g.fillStyle = v >= 0 ? 'rgba(86,214,255,0.75)' : 'rgba(255,146,46,0.75)'
      const bw = Math.abs(v) * half
      g.fillRect(v >= 0 ? zx : zx - bw, y - rh * 0.34, bw, rh * 0.68)
      g.textAlign = 'right'; g.fillStyle = C.axis; g.fillText(fmt(k), left - 10, y)
    })
    g.textAlign = 'center'; g.fillStyle = C.dim
    g.fillText(compact ? 'Negative' : 'Negative gamma', zx - half / 2, top - 18); g.fillText(compact ? 'Positive' : 'Positive gamma', zx + half / 2, top - 18)
    const level = (p: number, label: string, col: string, dash: number[]) => {
      const y = yOfP(p)
      g.strokeStyle = col; g.lineWidth = 1.4; g.setLineDash(dash); g.beginPath(); g.moveTo(left - 4, y); g.lineTo(right + 8, y); g.stroke(); g.setLineDash([])
      pill(g, right + 14, y, label, col)
    }
    level(87000, compact ? 'Call wall' : 'Call wall 87,000', C.buy, [6, 4])
    level(83000, compact ? 'Put wall' : 'Put wall 83,000', C.sell, [6, 4])
    level(84500, compact ? 'Flip' : 'Gamma flip 84,500', C.amber, [])
    level(85500, compact ? 'Max pain' : 'Max pain 85,500', C.dim, [1.5, 3])
    const py = yOfP(this.price.x)
    g.strokeStyle = C.white; g.lineWidth = 1.6; g.beginPath(); g.moveTo(left - 4, py); g.lineTo(right + 8, py); g.stroke()
    pill(g, left - 6, py, fmt(this.price.x), C.white, 'right', 'rgba(6,7,9,0.92)')
    g.globalAlpha = 0.55 + 0.45 * this.flash
    legend(g, [['Deribit options, refreshed every 60 s', C.cyan, 'dot']])
    g.globalAlpha = 1
  }
}

// ------------------------------------------------------------------------------------------- 8. exchanges side by side
export class ExchangesViz implements Viz {
  w = 0; h = 0
  r = rng(23)
  base!: Walk
  offs: Walk[] = []
  series: number[][] = [[], [], [], []]
  acc = 0
  oi = 145820
  fund = 0.0081
  prem = 21.5
  readonly venues: [string, string, number[]][] = [['Binance', C.white, []], ['Bybit', C.amber, [7, 4]], ['OKX', C.cyan, [2, 3]], ['Coinbase', C.blue, [10, 3, 2, 3]]]
  readonly step = 4
  init(w: number, h: number) {
    this.w = w; this.h = h
    this.base = new Walk(85600, 85600, this.r, 22, 0.14, 0.9)
    this.offs = [0, 3, -2, 18].map((o) => new Walk(o, o, this.r, 6, 0.6, 1.5))
    this.series = [[], [], [], []]
    for (let i = 0; i < 260; i++) this.tick(1 / 8)
  }
  tick(dt: number) {
    const b = this.base.step(dt)
    this.offs.forEach((o, i) => { this.series[i].push(b + o.step(dt)); const max = Math.ceil((this.w - 170) / this.step) + 2; while (this.series[i].length > max) this.series[i].shift() })
    this.oi += (this.r() - 0.48) * 40
    this.fund = Math.max(0.002, this.fund + (this.r() - 0.5) * 0.0002)
    this.prem += (this.r() - 0.5) * 0.8
  }
  update(dt: number) {
    this.acc += Math.min(dt, 0.05) * 8
    while (this.acc >= 1) { this.acc -= 1; this.tick(1 / 8) }
  }
  draw(g: CanvasRenderingContext2D) {
    const { w, h } = this
    g.fillStyle = C.bg; g.fillRect(0, 0, w, h)
    const compact = w < 620
    const top = compact ? 66 : 48, bottom = 64, right = w - (compact ? 112 : 160)
    const all = this.series.flat()
    const mid0 = (Math.min(...all) + Math.max(...all)) / 2
    const span = Math.max(60, Math.max(...all) - Math.min(...all) + 12)
    const lo = mid0 - span / 2, hi = mid0 + span / 2
    const yOf = (v: number) => top + (1 - (v - lo) / (hi - lo)) * (h - top - bottom)
    g.fillStyle = C.grid; for (let k = 0; k < 5; k++) g.fillRect(0, top + (k * (h - top - bottom)) / 4, right, 1)
    const n = this.series[0].length
    const xOf = (i: number) => right - (n - 1 - i + this.acc) * this.step
    // spread between the highest and lowest venue
    g.fillStyle = 'rgba(255,181,71,0.07)'; g.beginPath()
    for (let i = 0; i < n; i++) { const m = Math.max(...this.series.map((s) => s[i])); i ? g.lineTo(xOf(i), yOf(m)) : g.moveTo(xOf(i), yOf(m)) }
    for (let i = n - 1; i >= 0; i--) g.lineTo(xOf(i), yOf(Math.min(...this.series.map((s) => s[i]))))
    g.fill()
    const ends: { y: number; i: number }[] = []
    this.series.forEach((s, vi) => {
      const [, col, dash] = this.venues[vi]
      g.strokeStyle = col; g.lineWidth = vi === 0 ? 2 : 1.7; g.setLineDash(dash); g.beginPath()
      s.forEach((v, i) => (i ? g.lineTo(xOf(i), yOf(v)) : g.moveTo(xOf(i), yOf(v)))); g.stroke(); g.setLineDash([])
      ends.push({ y: yOf(s[s.length - 1]), i: vi })
    })
    // labels at the right edge, nudged apart so they never overlap
    ends.sort((a, b) => a.y - b.y)
    for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 22) ends[k].y = ends[k - 1].y + 22
    for (const e of ends) {
      const [name, col] = this.venues[e.i]
      pill(g, right + 10, e.y, `${compact ? ['BIN', 'BYB', 'OKX', 'CB'][e.i] : name} ${fmt(this.series[e.i][this.series[e.i].length - 1], compact ? 0 : 1)}`, col)
    }
    const chips: [string, string][] = [
      ['Open interest', `${fmt(this.oi / 1000, 1)}k BTC`], ['Funding', `${this.fund.toFixed(4)} %`], ['Coinbase premium', `${this.prem >= 0 ? '+' : '−'}$${Math.abs(this.prem).toFixed(1)}`],
    ]
    let x = 16
    for (const [k, v] of compact ? chips.slice(0, 2) : chips) {
      g.font = F(11, 500); const kw = g.measureText(k).width
      g.font = F(13, 700); const vw = g.measureText(v).width
      const cw = Math.max(kw, vw) + 24
      g.fillStyle = 'rgba(255,255,255,0.045)'; g.beginPath(); g.roundRect(x, h - 52, cw, 40, 10); g.fill()
      g.textAlign = 'left'; g.textBaseline = 'middle'
      g.font = F(11, 500); g.fillStyle = C.dim; g.fillText(k, x + 12, h - 41)
      g.font = F(13, 700); g.fillStyle = C.text; g.fillText(v, x + 12, h - 24)
      x += cw + 10
    }
    legend(g, this.venues.map(([n, c, d]) => [n, c, d.length === 0 ? 'line' : d[0] === 2 ? 'dot-line' : 'dash'] as [string, string, 'line' | 'dash' | 'dot-line']))
  }
}

// ------------------------------------------------------------------------------------------- stage
/** Draws one Viz into a canvas at the device's pixel density, only while visible; cross-fades between canvases. */
export class VizCanvas {
  canvas = document.createElement('canvas')
  g = this.canvas.getContext('2d')!
  viz: Viz
  w = 0; h = 0; dpr = 1
  constructor(public host: HTMLElement, make: () => Viz, private maxDpr = 3) {
    this.viz = make()
    this.canvas.className = 'viz-canvas'
    this.canvas.setAttribute('aria-hidden', 'true')
    host.appendChild(this.canvas)
  }
  resize() {
    const r = this.host.getBoundingClientRect()
    const dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1)
    const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height))
    if (w === this.w && h === this.h && dpr === this.dpr) return false
    this.w = w; this.h = h; this.dpr = dpr
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr)
    this.viz.init(w, h, dpr)
    return true
  }
  frame(dt: number) {
    this.viz.update(dt)
    this.g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.viz.draw(this.g)
  }
  /** A still frame for reduced motion: run the simulation forward a few seconds, then draw once. */
  still(seconds = 6) {
    for (let t = 0; t < seconds; t += 1 / 30) this.viz.update(1 / 30)
    this.frame(0)
  }
}
