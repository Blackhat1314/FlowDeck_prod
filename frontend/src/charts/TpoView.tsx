// TPO / Market Profile: 30-minute letters per price row, initial balance, value area / POC, single prints,
// poor highs / lows, excess tails, split or merged letters, and a composite of all displayed sessions.
import { useEffect, useRef, useState } from 'react'
import { finishProfile, lowerBound, type Cell } from '../lib/analytics'
import { drawGamma, drawSessionLevels, Labeler, type Ax } from '../lib/overlays'
import { TPO_SESSIONS, type Prefs } from '../lib/prefs'
import { store } from '../lib/store'
import { C, fmtDay, fmtPx, niceStep } from '../lib/util'

const AXIS_W = 74
const COMP_W = 120
const HEAD_H = 34
const FOOT_H = 52
const PERIOD = 30 * 60_000
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXabcdefghijklmnopqrstuvwx'
const ROWS = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500]

interface Period {
  i: number
  t: number
  hi: number
  lo: number
}

interface Sess {
  t0: number
  t1: number
  live: boolean
  periods: Period[]
  rows: Map<number, number[]> // row -> period indexes that traded there
  maxCount: number
  hi: number
  lo: number
  open: number
  close: number
  ibHi: number
  ibLo: number
  poc: number | null
  vah: number | null
  val: number | null
  singles: Set<number>
  tailHi: number // rows in the single-print tail at the high (>= 2 = excess)
  tailLo: number
  poorHi: boolean
  poorLo: boolean
}

function letter(i: number) {
  return LETTERS[i % LETTERS.length]
}

function periodColor(i: number, n: number) {
  const f = n > 1 ? i / (n - 1) : 0
  const hue = 205 - f * 165 // blue -> amber
  return `hsl(${hue.toFixed(0)}, 70%, ${(62 + f * 4).toFixed(0)}%)`
}

function buildSessions(p: Prefs, row: number, now: number): Sess[] {
  const cfg = TPO_SESSIONS[p.tpoSession]
  const times = store.barTimes
  const bars = store.bars
  let st = Math.floor((now - cfg.start) / cfg.every) * cfg.every + cfg.start
  if (st > now) st -= cfg.every
  const out: Sess[] = []
  for (let k = p.tpoDays - 1; k >= 0; k--) {
    const t0 = st - k * cfg.every
    const t1 = t0 + cfg.len
    const periods: Period[] = []
    let open = NaN
    let close = NaN
    for (let i = lowerBound(times, t0); i < times.length && times[i] < t1; i++) {
      const b = bars.get(times[i])
      if (!b || b.h == null || !(b.v > 0 || b.h !== b.l)) continue
      const pi = Math.floor((times[i] - t0) / PERIOD)
      let per = periods[periods.length - 1]
      if (!per || per.i !== pi) {
        per = { i: pi, t: t0 + pi * PERIOD, hi: b.h, lo: b.l }
        periods.push(per)
      }
      per.hi = Math.max(per.hi, b.h)
      per.lo = Math.min(per.lo, b.l)
      if (Number.isNaN(open)) open = b.o
      close = b.c
    }
    if (!periods.length) continue
    const rows = new Map<number, number[]>()
    let hi = -Infinity
    let lo = Infinity
    for (const per of periods) {
      hi = Math.max(hi, per.hi)
      lo = Math.min(lo, per.lo)
      for (let r = Math.floor(per.lo / row); r <= Math.floor(per.hi / row - 1e-9); r++) {
        const a = rows.get(r)
        if (a) a.push(per.i)
        else rows.set(r, [per.i])
      }
    }
    let maxCount = 0
    const cells = new Map<number, Cell>()
    for (const [r, a] of rows) {
      maxCount = Math.max(maxCount, a.length)
      cells.set(r, { b: a.length, s: 0, nb: 0, ns: 0, ll: 0, ls: 0 })
    }
    const prof = finishProfile(cells, row)
    const ib = periods.filter((x) => x.i < 2)
    const keys = [...rows.keys()].sort((a, b) => a - b)
    let tailHi = 0
    for (let j = keys.length - 1; j >= 0 && rows.get(keys[j])!.length === 1; j--) tailHi++
    let tailLo = 0
    for (let j = 0; j < keys.length && rows.get(keys[j])!.length === 1; j++) tailLo++
    const singles = new Set<number>()
    for (let j = tailLo; j < keys.length - tailHi; j++) if (rows.get(keys[j])!.length === 1) singles.add(keys[j])
    // A tail (excess) needs 2+ single prints at the extreme, a profile of 2+ periods, rows beyond the tail, and must
    // not be made only by the period still trading (price can still come back into it).
    const cur = now < t1 ? Math.floor((now - t0) / PERIOD) : -1
    const confirmed = (from: number, n: number, dir: 1 | -1) => {
      if (n < 2 || n >= keys.length || periods.length < 2) return false
      for (let k = 0; k < n; k++) if (rows.get(keys[from + dir * k])![0] !== cur) return true
      return false
    }
    if (!confirmed(keys.length - 1, tailHi, -1)) tailHi = Math.min(tailHi, 1)
    if (!confirmed(0, tailLo, 1)) tailLo = Math.min(tailLo, 1)
    const enough = periods.length >= 2 && keys.length > 2
    out.push({
      t0, t1, live: now < t1, periods, rows, maxCount, hi, lo, open, close,
      ibHi: Math.max(...ib.map((x) => x.hi)), ibLo: Math.min(...ib.map((x) => x.lo)),
      poc: prof.poc, vah: prof.vah, val: prof.val, singles, tailHi, tailLo,
      poorHi: enough && rows.get(keys[keys.length - 1])!.length >= 2,
      poorLo: enough && rows.get(keys[0])!.length >= 2,
    })
  }
  return out
}

export default function TpoView({ p }: { p: Prefs }) {
  const root = useRef<HTMLDivElement>(null)
  const pRef = useRef(p)
  pRef.current = p
  const ctl = useRef<TpoController | null>(null)
  const [live, setLive] = useState(true)
  useEffect(() => {
    const c = new TpoController(root.current!, pRef, setLive)
    ctl.current = c
    return () => c.destroy()
  }, [])
  useEffect(() => {
    if (ctl.current) ctl.current.dirty = true
  }, [p])
  return (
    <div className="fp" ref={root}>
      {!live && (
        <button className="relive" onClick={() => ctl.current?.goLive()}>
          Back to live
        </button>
      )}
    </div>
  )
}

class TpoController {
  root: HTMLElement
  pRef: { current: Prefs }
  setLive: (b: boolean) => void
  cv: HTMLCanvasElement
  W = 0
  H = 0
  dpr = 1
  cellW = 10
  xOff = 0
  pCenter: number | null = null
  ppp = 4
  autoCenter = true
  dirty = true
  ver = ''
  raf = 0
  lastDraw = 0
  ro: ResizeObserver
  drag: null | { x: number; y: number; xOff: number; p: number } = null
  mouse: { x: number; y: number } | null = null
  cache: { key: string; at: number; s: Sess[] } = { key: '', at: 0, s: [] }

  constructor(root: HTMLElement, pRef: { current: Prefs }, setLive: (b: boolean) => void) {
    this.root = root
    this.pRef = pRef
    this.setLive = setLive
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
  get chartW() {
    return this.W - AXIS_W - (this.pRef.current.tpoComposite ? COMP_W : 0)
  }
  get top() {
    return HEAD_H
  }
  get chartH() {
    return this.H - HEAD_H - FOOT_H
  }
  y(p: number) {
    return (this.pCenter! - p) / this.ppp + this.top + this.chartH / 2
  }
  pAt(y: number) {
    return this.pCenter! - (y - this.top - this.chartH / 2) * this.ppp
  }
  rowUsd() {
    const bu = store.config?.bucket ?? 1
    return ROWS.find((r) => r >= bu && r / this.ppp >= 11) ?? 500
  }

  frame() {
    if (!store.config) return
    const v = `${store.version('bars')}:${store.version('gex')}`
    const now = performance.now()
    if (!this.dirty && (v === this.ver || now - this.lastDraw < 500)) return
    this.ver = v
    this.dirty = false
    this.lastDraw = now
    this.draw()
  }

  sessions(row: number): Sess[] {
    const p = this.pRef.current
    const now = store.now()
    const key = `${p.tpoSession}:${p.tpoDays}:${row}`
    const c = this.cache
    if (c.key !== key || performance.now() - c.at > 2000) {
      c.s = buildSessions(p, row, now)
      c.key = key
      c.at = performance.now()
    }
    return c.s
  }

  blockW(s: Sess) {
    const p = this.pRef.current
    const n = p.tpoSplit ? (s.periods.length ? s.periods[s.periods.length - 1].i + 1 : 1) : s.maxCount
    return Math.max(150, n * this.cellW + 40)
  }

  draw() {
    const p = this.pRef.current
    const g = this.cv.getContext('2d')!
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.fillStyle = C.bg
    g.fillRect(0, 0, this.W, this.H)
    const row = this.rowUsd()
    const ss = this.sessions(row)
    if (!ss.length) {
      g.fillStyle = C.dim
      g.font = '500 13px "IBM Plex Sans", system-ui'
      g.textAlign = 'center'
      g.fillText('Waiting for bars in this session window…', this.W / 2, this.H / 2)
      return
    }
    const last = ss[ss.length - 1]
    if (this.pCenter == null) {
      this.pCenter = store.last ?? last.close
      // fit the latest session's range
      this.ppp = Math.max(0.5, ((last.hi - last.lo) * 1.35) / Math.max(100, this.chartH))
    }
    if (this.autoCenter && store.last != null) {
      const half = (this.chartH / 2) * this.ppp
      if (Math.abs(store.last - this.pCenter) > half * 0.6) this.pCenter = store.last
    }
    const cw = this.chartW
    const top = this.top
    const ch = this.chartH
    const rowPx = row / this.ppp
    const step = niceStep(ch * this.ppp, ch / 60)

    // grid
    g.strokeStyle = C.grid
    g.lineWidth = 1
    for (let q = Math.ceil(this.pAt(top + ch) / step) * step; q < this.pAt(top); q += step) {
      const yy = Math.round(this.y(q)) + 0.5
      g.beginPath()
      g.moveTo(0, yy)
      g.lineTo(cw, yy)
      g.stroke()
    }

    g.save()
    g.beginPath()
    g.rect(0, 0, cw, this.H)
    g.clip()
    let xEnd = cw - 16 + this.xOff
    const letters = rowPx >= 10 && this.cellW >= 8
    for (let k = ss.length - 1; k >= 0; k--) {
      const s = ss[k]
      const w = this.blockW(s)
      const x0 = xEnd - w
      xEnd = x0 - 18
      if (x0 > cw || x0 + w < 0) continue
      this.drawSession(g, s, x0, w, row, rowPx, letters)
    }
    // shared levels (prior sessions, gamma) for context
    const ax: Ax = { W: cw, H: top + ch, y: (q) => this.y(q), xt: () => -1e6 }
    const lab = new Labeler(g)
    drawSessionLevels(g, ax, { ...p, levels: p.levels }, lab)
    drawGamma(g, ax, p, lab)
    if (store.last != null) {
      const yy = Math.round(this.y(store.last)) + 0.5
      g.strokeStyle = store.lastDir > 0 ? 'rgba(43,217,159,0.6)' : 'rgba(255,92,122,0.6)'
      g.setLineDash([1, 3])
      g.beginPath()
      g.moveTo(0, yy)
      g.lineTo(cw, yy)
      g.stroke()
      g.setLineDash([])
    }
    g.restore()

    let xa = cw
    if (p.tpoComposite) {
      this.drawComposite(g, ss, xa, row, rowPx)
      xa += COMP_W
    }
    // price axis
    g.fillStyle = C.panel
    g.fillRect(xa, 0, AXIS_W, this.H)
    g.fillStyle = C.dim
    g.font = '500 11px "IBM Plex Sans", system-ui'
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    for (let q = Math.ceil(this.pAt(top + ch) / step) * step; q < this.pAt(top + 8); q += step) {
      g.fillText(fmtPx(q, step < 1 ? 1 : 0), xa + 8, this.y(q))
    }
    if (store.last != null) {
      const yy = this.y(store.last)
      if (yy > top && yy < top + ch) {
        g.fillStyle = store.lastDir > 0 ? C.buy : C.sell
        g.fillRect(xa + 1, yy - 9, AXIS_W - 2, 18)
        g.fillStyle = '#06101a'
        g.font = '600 11px "IBM Plex Sans", system-ui'
        g.fillText(fmtPx(store.last, 1), xa + 6, yy + 0.5)
      }
    }
    g.fillStyle = C.faint
    g.font = '500 10px "IBM Plex Sans", system-ui'
    g.fillText(`Row $${row}`, xa + 8, 14)
    g.fillText('30 min / letter', xa + 8, 28)
    g.strokeStyle = C.line
    g.beginPath()
    g.moveTo(xa + 0.5, 0)
    g.lineTo(xa + 0.5, this.H)
    g.stroke()

    const m = this.mouse
    if (m && m.x < cw && m.y > top && m.y < top + ch) {
      g.strokeStyle = 'rgba(211,220,235,0.35)'
      g.setLineDash([3, 3])
      g.beginPath()
      g.moveTo(0, m.y + 0.5)
      g.lineTo(cw, m.y + 0.5)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = C.panel2
      g.fillRect(xa + 1, m.y - 9, AXIS_W - 2, 18)
      g.fillStyle = '#fff'
      g.font = '500 11px "IBM Plex Sans", system-ui'
      g.fillText(fmtPx(this.pAt(m.y), 1), xa + 6, m.y + 0.5)
    }
  }

  drawSession(g: CanvasRenderingContext2D, s: Sess, x0: number, w: number, row: number, rowPx: number, letters: boolean) {
    const p = this.pRef.current
    const top = this.top
    const ch = this.chartH
    const h = Math.max(1, rowPx - (rowPx > 4 ? 1 : 0))
    const nPer = s.periods.length ? s.periods[s.periods.length - 1].i + 1 : 1
    const cx0 = x0 + 22 // letters start right of the IB / open-close rail
    // value area background
    if (s.vah != null && s.val != null) {
      g.fillStyle = 'rgba(90,209,255,0.06)'
      g.fillRect(cx0 - 2, this.y(s.vah), w - 24, this.y(s.val) - this.y(s.vah))
    }
    // IB rail
    g.fillStyle = 'rgba(242,181,68,0.85)'
    g.fillRect(x0 + 6, this.y(s.ibHi), 3, Math.max(1, this.y(s.ibLo) - this.y(s.ibHi)))
    // session range rail
    g.fillStyle = 'rgba(127,144,170,0.45)'
    g.fillRect(x0 + 12, this.y(s.hi), 2, Math.max(1, this.y(s.lo) - this.y(s.hi)))
    // open / close ticks
    if (Number.isFinite(s.open)) {
      g.fillStyle = C.text
      g.fillRect(x0 + 2, Math.round(this.y(s.open)) - 1, 12, 2)
    }
    if (Number.isFinite(s.close)) {
      g.fillStyle = s.close >= s.open ? C.buy : C.sell
      g.beginPath()
      const yc = this.y(s.close)
      g.moveTo(x0 + 14, yc)
      g.lineTo(x0 + 19, yc - 4)
      g.lineTo(x0 + 19, yc + 4)
      g.fill()
    }
    const curPer = s.live ? Math.floor((store.now() - s.t0) / PERIOD) : -1
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.font = `600 ${Math.min(12, Math.max(9, rowPx - 2))}px "IBM Plex Sans Condensed", system-ui`
    for (const [r, pers] of s.rows) {
      const y0 = this.y((r + 1) * row)
      if (y0 > top + ch || y0 + rowPx < top) continue
      const isPoc = s.poc != null && Math.abs((r + 0.5) * row - s.poc) < row / 2
      const single = s.singles.has(r)
      if (isPoc) {
        g.fillStyle = 'rgba(242,181,68,0.22)'
        g.fillRect(cx0 - 2, y0, (p.tpoSplit ? nPer : pers.length) * this.cellW + 4, h)
      } else if (single) {
        g.fillStyle = 'rgba(180,156,255,0.22)'
        g.fillRect(cx0 - 2, y0, (p.tpoSplit ? nPer : pers.length) * this.cellW + 4, h)
      }
      pers.forEach((pi, j) => {
        const cx = cx0 + (p.tpoSplit ? pi : j) * this.cellW
        const col = periodColor(pi, Math.max(nPer, 2))
        if (letters) {
          g.fillStyle = pi === curPer ? '#ffffff' : pi < 2 ? '#ffd166' : col
          g.fillText(letter(pi), cx + this.cellW / 2, y0 + h / 2 + 0.5)
        } else {
          g.fillStyle = pi === curPer ? '#ffffff' : col
          g.globalAlpha = 0.85
          g.fillRect(cx + 1, y0, Math.max(1, this.cellW - 2), h)
          g.globalAlpha = 1
        }
      })
    }
    // POC / VA lines and tags
    g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
    g.textAlign = 'right'
    g.textBaseline = 'bottom'
    const right = x0 + w - 2
    const tagLine = (px: number | null, txt: string, color: string, dash: number[]) => {
      if (px == null) return
      const yy = Math.round(this.y(px)) + 0.5
      g.setLineDash(dash)
      g.strokeStyle = color
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(cx0 - 2, yy)
      g.lineTo(right, yy)
      g.stroke()
      g.setLineDash([])
      g.fillStyle = color
      g.fillText(txt, right, yy - 1)
    }
    tagLine(s.vah, 'VAH', 'rgba(154,180,255,0.75)', [4, 3])
    tagLine(s.val, 'VAL', 'rgba(154,180,255,0.75)', [4, 3])
    tagLine(s.poc, 'POC', C.amber, [])
    // auction quality marks at the extremes
    g.textAlign = 'left'
    // labels sit just outside the extreme row so they never cover its letters
    const mark = (px: number, txt: string, color: string, below: boolean) => {
      const r = below ? Math.floor(px / row) : Math.floor(px / row - 1e-9)
      g.fillStyle = color
      g.textBaseline = below ? 'top' : 'bottom'
      g.fillText(txt, cx0, below ? this.y(r * row) + 2 : this.y((r + 1) * row) - 2)
    }
    if (s.tailHi >= 2) mark(s.hi, 'excess', C.buy, false)
    else if (s.poorHi) mark(s.hi, 'poor high', C.orange, false)
    if (s.tailLo >= 2) mark(s.lo, 'excess', C.buy, true)
    else if (s.poorLo) mark(s.lo, 'poor low', C.orange, true)
    // header
    const cfg = TPO_SESSIONS[p.tpoSession]
    g.fillStyle = C.panel
    g.fillRect(x0, 0, w, HEAD_H - 4)
    g.fillStyle = s.live ? '#fff' : C.text
    g.font = '600 11.5px "IBM Plex Sans", system-ui'
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    const hm = new Date(s.t0).toISOString().slice(11, 16)
    const head = p.tpoSession === 'funding' ? `${fmtDay(s.t0)} ${hm} UTC` : fmtDay(s.t0)
    g.fillText(`${head}${s.live ? ' · live' : ''}`, x0 + 6, 10)
    g.fillStyle = C.faint
    g.font = '500 10px "IBM Plex Sans", system-ui'
    g.fillText(cfg.label, x0 + 6, 23)
    // footer stats
    const fy = top + ch
    g.fillStyle = C.panel
    g.fillRect(x0, fy + 4, w, FOOT_H - 6)
    g.font = '500 10.5px "IBM Plex Sans Condensed", system-ui'
    g.fillStyle = C.dim
    g.fillText(`Range ${fmtPx(s.hi - s.lo, 0)} · IB ${fmtPx(s.ibHi - s.ibLo, 0)}`, x0 + 6, fy + 15)
    g.fillStyle = C.amber
    g.fillText(`POC ${fmtPx(s.poc, 0)}`, x0 + 6, fy + 29)
    g.fillStyle = C.dim
    g.fillText(`VA ${fmtPx(s.val, 0)}–${fmtPx(s.vah, 0)}`, x0 + 72, fy + 29)
    const ext = s.close > s.ibHi ? 'range ext. up' : s.close < s.ibLo ? 'range ext. down' : 'inside IB'
    g.fillStyle = C.faint
    g.fillText(`${s.singles.size} single prints · ${ext}`, x0 + 6, fy + 43)
  }

  drawComposite(g: CanvasRenderingContext2D, ss: Sess[], x0: number, row: number, rowPx: number) {
    const top = this.top
    const ch = this.chartH
    const counts = new Map<number, Cell>()
    for (const s of ss) for (const [r, a] of s.rows) {
      const c = counts.get(r)
      if (c) c.b += a.length
      else counts.set(r, { b: a.length, s: 0, nb: 0, ns: 0, ll: 0, ls: 0 })
    }
    const prof = finishProfile(counts, row)
    g.fillStyle = C.panel
    g.fillRect(x0, 0, COMP_W, this.H)
    g.save()
    g.beginPath()
    g.rect(x0, top, COMP_W, ch)
    g.clip()
    if (prof.vah != null && prof.val != null) {
      g.fillStyle = 'rgba(90,209,255,0.07)'
      g.fillRect(x0, this.y(prof.vah), COMP_W, this.y(prof.val) - this.y(prof.vah))
    }
    const h = Math.max(1, rowPx - (rowPx > 4 ? 1 : 0))
    for (const [r, c] of counts) {
      const y0 = this.y((r + 1) * row)
      if (y0 > top + ch || y0 + rowPx < top) continue
      g.fillStyle = 'rgba(154,180,255,0.45)'
      g.fillRect(x0 + 4, y0, (c.b / (prof.max || 1)) * (COMP_W - 12), h)
    }
    if (prof.poc != null) {
      const yy = Math.round(this.y(prof.poc)) + 0.5
      g.strokeStyle = C.amber
      g.beginPath()
      g.moveTo(x0, yy)
      g.lineTo(x0 + COMP_W, yy)
      g.stroke()
    }
    g.restore()
    g.font = '500 10.5px "IBM Plex Sans", system-ui'
    g.textAlign = 'left'
    g.textBaseline = 'middle'
    g.fillStyle = C.dim
    g.fillText(`Composite · ${ss.length} sessions`, x0 + 6, 12)
    g.fillStyle = C.amber
    g.fillText(`POC ${fmtPx(prof.poc, 0)}`, x0 + 6, top + ch + 15)
    g.fillStyle = C.dim
    g.fillText(`VA ${fmtPx(prof.val, 0)}–${fmtPx(prof.vah, 0)}`, x0 + 6, top + ch + 30)
    g.strokeStyle = C.line
    g.beginPath()
    g.moveTo(x0 + 0.5, 0)
    g.lineTo(x0 + 0.5, this.H)
    g.stroke()
  }

  bind() {
    const cv = this.cv
    cv.addEventListener('wheel', (e) => {
      e.preventDefault()
      const f = Math.exp(Math.sign(e.deltaY) * Math.min(0.3, Math.abs(e.deltaY) / 400))
      if (e.ctrlKey || e.shiftKey) this.cellW = Math.max(3, Math.min(24, this.cellW / f))
      else if (this.pCenter != null) {
        const pAt = this.pAt(e.offsetY)
        this.ppp = Math.max(0.1, Math.min(200, this.ppp * f))
        this.pCenter = pAt + (e.offsetY - this.top - this.chartH / 2) * this.ppp
      }
      this.dirty = true
    }, { passive: false })
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId)
      this.drag = { x: e.clientX, y: e.clientY, xOff: this.xOff, p: this.pCenter ?? 0 }
    })
    cv.addEventListener('pointermove', (e) => {
      this.mouse = { x: e.offsetX, y: e.offsetY }
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
    cv.addEventListener('pointerup', () => (this.drag = null))
    cv.addEventListener('pointerleave', () => {
      this.mouse = null
      this.dirty = true
    })
    cv.addEventListener('dblclick', () => this.goLive())
  }
}

