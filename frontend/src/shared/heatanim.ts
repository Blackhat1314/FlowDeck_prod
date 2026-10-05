// Procedural order-book heatmap used on the landing and sign-in pages: price rows that scroll left,
// walls that build, get pulled or eaten, best bid/ask step lines and shaded trade bubbles.
// It is an illustration of the dashboard, not market data.

const STOPS: [number, [number, number, number]][] = [
  [0.0, [24, 34, 40]],
  [0.12, [26, 46, 60]],
  [0.26, [26, 66, 90]],
  [0.38, [28, 92, 126]],
  [0.48, [56, 124, 156]],
  [0.55, [122, 150, 158]],
  [0.61, [190, 196, 192]],
  [0.68, [222, 204, 72]],
  [0.8, [230, 140, 48]],
  [0.91, [218, 78, 48]],
  [1.0, [238, 40, 30]],
]

export const LUT: string[] = (() => {
  const out: string[] = []
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    let k = 0
    while (k < STOPS.length - 2 && x > STOPS[k + 1][0]) k++
    const [x0, c0] = STOPS[k]
    const [x1, c1] = STOPS[k + 1]
    const f = (x - x0) / (x1 - x0)
    out.push(`rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * f)).join(',')})`)
  }
  return out
})()

interface Wall { row: number; size: number; age: number; fate: 'hold' | 'pull' | 'eat'; dead: boolean }
interface Bubble { x: number; y: number; v: number; buy: boolean }

export interface HeatAnimOptions {
  rowPx?: number // height of a price row in CSS px
  speed?: number // scroll speed, px per second
  basePrice?: number
  tick?: number // $ per row
  interactive?: boolean
  reveal?: boolean // paint in from the right on start
}

function mulberry(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class HeatAnim {
  root: HTMLElement
  heat = document.createElement('canvas')
  over = document.createElement('canvas')
  tip = document.createElement('div')
  o: Required<HeatAnimOptions>
  W = 0
  H = 0
  dpr = 1
  rows = 0
  mid = 0 // price in rows (float)
  vel = 0
  liq: Float32Array = new Float32Array(0) // smoothed resting size per row
  walls: Wall[] = []
  path: { x: number; bid: number; ask: number }[] = []
  bubbles: Bubble[] = []
  acc = 0
  last = 0
  raf = 0
  running = false
  visible = true
  reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  rnd = mulberry(7)
  revealStart = 0
  mouse: { x: number; y: number } | null = null
  ro: ResizeObserver
  io: IntersectionObserver

  constructor(root: HTMLElement, opts: HeatAnimOptions = {}) {
    this.root = root
    this.o = { rowPx: 10, speed: 34, basePrice: 84000, tick: 5, interactive: false, reveal: true, ...opts }
    root.classList.add('heatanim')
    for (const c of [this.heat, this.over]) {
      c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'
      c.setAttribute('aria-hidden', 'true')
      root.appendChild(c)
    }
    this.tip.className = 'heatanim-tip'
    this.tip.hidden = true
    root.appendChild(this.tip)
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(root)
    this.io = new IntersectionObserver((es) => {
      this.visible = es[0].isIntersecting
      if (this.visible) this.start()
    })
    this.io.observe(root)
    document.addEventListener('visibilitychange', () => !document.hidden && this.start())
    if (this.o.interactive) {
      root.addEventListener('pointermove', (e) => {
        const r = root.getBoundingClientRect()
        this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top }
        if (this.reduced) this.drawOverlay()
      })
      root.addEventListener('pointerleave', () => {
        this.mouse = null
        this.tip.hidden = true
        if (this.reduced) this.drawOverlay()
      })
    }
    this.resize()
  }

  destroy() {
    cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    this.io.disconnect()
  }

  resize() {
    const r = this.root.getBoundingClientRect()
    const W = Math.max(50, Math.round(r.width))
    const H = Math.max(50, Math.round(r.height))
    if (W === this.W && H === this.H) return
    this.W = W
    this.H = H
    this.dpr = Math.min(2, window.devicePixelRatio || 1)
    for (const c of [this.heat, this.over]) {
      c.width = Math.round(W * this.dpr)
      c.height = Math.round(H * this.dpr)
    }
    this.rows = Math.ceil(H / this.o.rowPx) + 1
    this.liq = new Float32Array(this.rows)
    this.mid = this.rows * 0.55
    this.vel = 0
    this.walls = []
    this.path = []
    this.bubbles = []
    this.rnd = mulberry(7)
    for (let i = 0; i < 6; i++) this.spawnWall(true)
    // pre-simulate the whole width so the picture is full on first paint
    const g = this.heat.getContext('2d')!
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = LUT[0]
    g.fillRect(0, 0, W, H)
    for (let x = 0; x < W; x += 2) this.step(x, 2)
    this.revealStart = this.o.reveal && !this.reduced ? performance.now() : 0
    this.drawOverlay()
    this.start()
  }

  spawnWall(initial = false) {
    const side = this.rnd() < 0.5 ? -1 : 1
    const dist = 3 + Math.floor(this.rnd() * (this.rows * 0.42))
    const row = Math.round(this.mid + side * dist)
    if (row < 1 || row >= this.rows - 1) return
    const f = this.rnd()
    this.walls.push({ row, size: 0.55 + this.rnd() * 0.45, age: initial ? 400 + this.rnd() * 900 : 0,
      fate: f < 0.55 ? 'hold' : f < 0.8 ? 'pull' : 'eat', dead: false })
  }

  /** advance the market by one column of width w at x (CSS px) and paint it */
  step(x: number, w: number) {
    const r = this.rnd
    // price: mean-reverting random walk with bursts
    this.vel = this.vel * 0.94 + (r() - 0.5) * 0.09 + (this.rows * 0.5 - this.mid) * 0.0006
    if (r() < 0.004) this.vel += (r() < 0.5 ? -1 : 1) * 0.5
    // walls repel or attract
    for (const wl of this.walls) {
      const d = wl.row - this.mid
      if (wl.fate === 'hold' && Math.abs(d) < 2.2) this.vel -= Math.sign(d) * 0.05
    }
    this.mid = Math.max(4, Math.min(this.rows - 5, this.mid + this.vel))
    const bid = Math.floor(this.mid)
    const ask = bid + 1
    // walls: build, get pulled near price or eaten when price trades through
    for (const wl of this.walls) {
      wl.age += w
      const d = Math.abs(wl.row - this.mid)
      if (wl.fate === 'pull' && d < 3.5) wl.size *= 0.6
      if (wl.fate === 'eat' && d < 0.8) wl.size *= 0.82
      if (wl.size < 0.08 || wl.age > 2600) wl.dead = true
    }
    this.walls = this.walls.filter((wl) => !wl.dead)
    if (this.walls.length < 7 && r() < 0.02 * w) this.spawnWall()
    // resting liquidity per row
    const target = new Float32Array(this.rows)
    for (let i = 0; i < this.rows; i++) {
      const d = Math.abs(i + 0.5 - this.mid)
      target[i] = d < 0.9 ? 0.04 : 0.2 + 0.26 * Math.exp(-d / (this.rows * 0.32)) + (r() - 0.5) * 0.16
    }
    for (const wl of this.walls) {
      if (wl.row >= 0 && wl.row < this.rows) {
        const build = Math.min(1, wl.age / 160)
        target[wl.row] = Math.max(target[wl.row], 0.62 + 0.38 * wl.size * build)
      }
    }
    const g = this.heat.getContext('2d')!
    const rp = this.o.rowPx
    for (let i = 0; i < this.rows; i++) {
      this.liq[i] += (target[i] - this.liq[i]) * (target[i] > this.liq[i] ? 0.35 : 0.12)
      const v = Math.max(0, Math.min(1, this.liq[i] + (r() - 0.5) * 0.05))
      const y = this.H - (i + 1) * rp
      g.fillStyle = LUT[(v * 255) | 0]
      g.fillRect(x, y, w, rp)
      if (rp >= 6) {
        g.fillStyle = 'rgba(8,12,15,0.42)'
        g.fillRect(x, y, w, 1)
      }
    }
    this.path.push({ x: x + w, bid, ask })
    // trades
    if (r() < 0.16 * w) {
      const big = r() < 0.08
      const v = big ? 4 + r() * 22 : 0.2 + r() * r() * 4
      const buy = this.vel > 0 ? r() < 0.68 : r() < 0.32
      const row = buy ? ask : bid
      this.bubbles.push({ x: x + w / 2, y: this.H - (row + 0.5) * rp, v, buy })
    }
  }

  start() {
    if (this.running || this.reduced || !this.visible || document.hidden) return
    this.running = true
    this.last = performance.now()
    const loop = (t: number) => {
      if (!this.visible || document.hidden) {
        this.running = false
        return
      }
      const dt = Math.min(0.1, (t - this.last) / 1000)
      this.last = t
      this.acc += dt * this.o.speed
      const n = Math.floor(this.acc)
      if (n >= 1) {
        this.acc -= n
        this.scroll(n)
      }
      this.drawOverlay()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  scroll(n: number) {
    const g = this.heat.getContext('2d')!
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = 'copy'
    g.drawImage(this.heat, -n * this.dpr, 0)
    g.globalCompositeOperation = 'source-over'
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    for (const p of this.path) p.x -= n
    for (const b of this.bubbles) b.x -= n
    this.path = this.path.filter((p) => p.x > -4)
    this.bubbles = this.bubbles.filter((b) => b.x > -40)
    this.step(this.W - n, n)
  }

  drawOverlay() {
    const g = this.over.getContext('2d')!
    const W = this.W
    const H = this.H
    const rp = this.o.rowPx
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, W, H)
    // best bid / ask as step lines
    for (const [key, color] of [['bid', '#35e89a'], ['ask', '#ff4f4f']] as const) {
      g.beginPath()
      let prev = 0
      this.path.forEach((p, i) => {
        const y = H - (p[key] + (key === 'bid' ? 1 : 0)) * rp
        if (i === 0) g.moveTo(p.x, y)
        else {
          g.lineTo(p.x, prev)
          g.lineTo(p.x, y)
        }
        prev = y
      })
      g.strokeStyle = color
      g.lineWidth = 2
      g.stroke()
    }
    // shaded trade bubbles, biggest first
    const bs = [...this.bubbles].sort((a, b) => b.v - a.v)
    for (const b of bs) {
      const rad = Math.min(34, 2 + Math.sqrt(b.v) * 5.2)
      const c = b.buy ? [52, 208, 130] : [226, 74, 64]
      const lit = c.map((v) => Math.round(v + (255 - v) * 0.6)).join(',')
      const dark = c.map((v) => Math.round(v * 0.42)).join(',')
      const gr = g.createRadialGradient(b.x - rad * 0.38, b.y - rad * 0.42, rad * 0.06, b.x, b.y, rad)
      gr.addColorStop(0, `rgba(${lit},0.82)`)
      gr.addColorStop(0.5, `rgba(${c.join(',')},0.8)`)
      gr.addColorStop(1, `rgba(${dark},0.82)`)
      g.beginPath()
      g.arc(b.x, b.y, rad, 0, Math.PI * 2)
      g.fillStyle = gr
      g.fill()
    }
    // load reveal: the picture paints in from the right edge once
    if (this.revealStart) {
      const f = Math.min(1, (performance.now() - this.revealStart) / 1400)
      const e = 1 - Math.pow(1 - f, 3)
      const edge = W * (1 - e)
      if (f < 1) {
        g.fillStyle = '#0f171c'
        g.fillRect(0, 0, edge, H)
        const grd = g.createLinearGradient(edge, 0, edge + 60, 0)
        grd.addColorStop(0, 'rgba(15,23,28,1)')
        grd.addColorStop(1, 'rgba(15,23,28,0)')
        g.fillStyle = grd
        g.fillRect(edge, 0, 60, H)
      } else this.revealStart = 0
    }
    // crosshair + readout
    const m = this.mouse
    if (m) {
      g.strokeStyle = 'rgba(233,236,234,0.45)'
      g.setLineDash([3, 3])
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(0, Math.round(m.y) + 0.5)
      g.lineTo(W, Math.round(m.y) + 0.5)
      g.moveTo(Math.round(m.x) + 0.5, 0)
      g.lineTo(Math.round(m.x) + 0.5, H)
      g.stroke()
      g.setLineDash([])
      const row = Math.floor((H - m.y) / rp)
      const px = this.o.basePrice + (row - Math.floor(this.rows * 0.55)) * this.o.tick
      const v = row >= 0 && row < this.rows ? this.liq[row] : 0
      const btc = Math.max(0.1, Math.pow(v, 2.4) * 260)
      this.tip.hidden = false
      this.tip.textContent = `${btc >= 10 ? btc.toFixed(0) : btc.toFixed(1)} BTC waiting at ${px.toLocaleString('en-US')}`
      const tx = Math.min(W - 190, m.x + 14)
      const ty = Math.max(8, m.y - 34)
      this.tip.style.transform = `translate(${tx}px, ${ty}px)`
    }
  }
}
