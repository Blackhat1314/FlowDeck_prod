// Shared level computations (cached per bar version) and canvas drawing helpers used by the heatmap and footprint.
import {
  buildProfile, DAY, developingPoc, finishProfile, sessionLevels, vwapSeries, weekStart,
  type Cell, type Profile, type SessionLevels, type Source, type VwapPoint,
} from './analytics'
import type { Prefs, ProfileRange, ProfileView } from './prefs'
import { store } from './store'
import { C, fmtDay, fmtPx, fmtQty } from './util'

export interface Ax {
  W: number
  H: number
  y(p: number): number
  xt(t: number): number
}

// ------------------------------------------------------------------------------------------- caches
type Entry<T> = { key: string; at: number; v: T }
const cache = new Map<string, Entry<any>>()

/** memoise f() under `name` while `key` is unchanged; when only the bar version changes recompute at most every `ms` */
export function memo<T>(name: string, key: string, f: () => T, ms = 1000): T {
  const e = cache.get(name)
  const ver = store.version('bars')
  const full = `${key}|${ver}`
  const now = performance.now()
  if (e && (e.key === full || (e.key.startsWith(`${key}|`) && now - e.at < ms))) return e.v
  const v = f()
  cache.set(name, { key: full, at: now, v })
  return v
}

export function priorLevels(days: number): SessionLevels[] {
  const cfg = store.config
  if (!cfg) return []
  const now = store.now()
  return memo(`levels`, `${days}:${Math.floor(now / DAY)}`, () =>
    sessionLevels(store.bars, store.barTimes, days, levelRow(), cfg.bucket, now), 15_000)
}

/** row size used for session levels: $10 keeps POCs precise without splitting thin markets */
export function levelRow() {
  return Math.max(store.config?.bucket ?? 1, 10)
}

export function vwapFor(mode: 'day' | 'week'): VwapPoint[] {
  const cfg = store.config
  if (!cfg) return []
  const now = store.now()
  const t0 = mode === 'day' ? now - (now % DAY) : weekStart(now)
  return memo(`vwap:${mode}`, `${t0}`, () => vwapSeries(store.bars, store.barTimes, t0, cfg.bucket), 1000)
}

export function anchoredVwap(t0: number): VwapPoint[] {
  const cfg = store.config
  if (!cfg) return []
  const a = t0 - (t0 % 60_000)
  return memo(`avwap:${a}`, `${a}`, () => vwapSeries(store.bars, store.barTimes, a, cfg.bucket), 1000)
}

export function devPocPath(): [number, number][] {
  const cfg = store.config
  if (!cfg) return []
  const now = store.now()
  const t0 = now - (now % DAY)
  return memo('dpoc', `${t0}`, () => developingPoc(store.bars, store.barTimes, t0, levelRow(), cfg.bucket), 2000)
}

export function profileWindow(r: ProfileRange, visible?: [number, number]): [number, number] {
  const now = store.now()
  const today = now - (now % DAY)
  switch (r) {
    case 'session':
      return [today, now + 60_000]
    case 'prev':
      return [today - DAY, today]
    case '4h':
      return [now - 4 * 3_600_000, now + 60_000]
    case '1h':
      return [now - 3_600_000, now + 60_000]
    case '3d':
      return [today - 2 * DAY, now + 60_000]
    case '7d':
      return [today - 6 * DAY, now + 60_000]
    default:
      return visible ?? [today, now + 60_000]
  }
}

export interface ProfilePair {
  main: Profile
  spot: Profile | null // for spot-vs-perp
}

/** profile (or spot-vs-perp pair) for a window, cached per caller name */
export function getProfile(name: string, t0: number, t1: number, rowUsd: number, src: Source, mode: ProfileView): ProfilePair {
  const cfg = store.config!
  const a = t0 - (t0 % 60_000)
  const key = `${a}:${Math.floor(t1 / 60_000)}:${rowUsd}:${src}:${mode}`
  return memo(`prof:${name}`, key, () => {
    if (mode === 'svp') {
      return {
        main: buildProfile(store.bars, store.barTimes, a, t1, rowUsd, cfg.bucket, 'perps'),
        spot: buildProfile(store.bars, store.barTimes, a, t1, rowUsd, cfg.bucket, 'spot'),
      }
    }
    return { main: buildProfile(store.bars, store.barTimes, a, t1, rowUsd, cfg.bucket, src, mode), spot: null }
  }, 1000)
}

export function rangeProfile(id: number, t0: number, t1: number, rowUsd: number): Profile {
  const cfg = store.config!
  return memo(`range:${id}`, `${t0}:${t1}:${rowUsd}`, () =>
    buildProfile(store.bars, store.barTimes, t0, t1, rowUsd, cfg.bucket, 'primary', 'volume'), 1500)
}

export { finishProfile }

// ------------------------------------------------------------------------------------------- labels
/** places right-aligned labels without overlap: shifts left when a label would collide */
export class Labeler {
  placed: [number, number, number][] = [] // y, left, right
  constructor(public g: CanvasRenderingContext2D) {}
  put(txt: string, right: number, y: number, color: string) {
    const w = this.g.measureText(txt).width
    let r = right
    for (let k = 0; k < 8; k++) {
      const hit = this.placed.find(([py, l, rr]) => Math.abs(py - y) < 11 && r > l - 6 && r - w < rr + 6)
      if (!hit) break
      r = hit[1] - 10
    }
    this.g.fillStyle = color
    this.g.textAlign = 'right'
    this.g.fillText(txt, r, y)
    this.placed.push([y, r - w, r])
  }
}

function hline(g: CanvasRenderingContext2D, x0: number, x1: number, y: number, color: string, dash: number[], w = 1) {
  const yy = Math.round(y) + 0.5
  g.setLineDash(dash)
  g.strokeStyle = color
  g.lineWidth = w
  g.beginPath()
  g.moveTo(x0, yy)
  g.lineTo(x1, yy)
  g.stroke()
  g.setLineDash([])
}

// ------------------------------------------------------------------------------------------- gamma levels
export function drawGamma(g: CanvasRenderingContext2D, ax: Ax, p: Prefs, lab: Labeler) {
  if (!p.gamma || !store.gex) return
  const gg = store.gex.groups[p.gammaGroup] ?? store.gex.groups.all
  if (!gg) return
  const basis = p.basisAdjust ? store.gex.basis ?? 0 : 0
  const lines: [number | null, string, string, number[]][] = [
    [gg.call_wall, 'Call wall', C.buy, [6, 4]],
    [gg.put_wall, 'Put wall', C.sell, [6, 4]],
    [gg.flip, 'Gamma flip', C.amber, []],
    [store.gex.max_pain, 'Max pain', '#9aa9c0', [2, 4]],
  ]
  for (const k of gg.pos) if (k !== gg.call_wall) lines.push([k, '+γ', 'rgba(43,217,159,0.55)', [2, 6]])
  for (const k of gg.neg) if (k !== gg.put_wall) lines.push([k, '−γ', 'rgba(255,92,122,0.55)', [2, 6]])
  g.font = '600 10.5px "IBM Plex Sans Condensed", system-ui'
  g.textBaseline = 'bottom'
  for (const [p0, label, color, dash] of lines) {
    if (p0 == null) continue
    const px = p0 + basis
    const yy = ax.y(px)
    if (yy < -2 || yy > ax.H + 2) continue
    hline(g, 0, ax.W, yy, color, dash, label === 'Gamma flip' ? 1.5 : 1.2)
    lab.put(`${label} ${fmtPx(px, 0)}`, ax.W - 8, Math.round(yy) - 2, color)
  }
}

// ------------------------------------------------------------------------------------------- prior sessions
export function drawSessionLevels(g: CanvasRenderingContext2D, ax: Ax, p: Prefs, lab: Labeler) {
  if (!p.levels) return
  const lv = priorLevels(p.levelDays)
  g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
  g.textBaseline = 'bottom'
  lv.forEach((s, i) => {
    const day = fmtDay(s.day)
    const tag = s.approx ? '~' : ''
    if (i === 0) {
      // the previous session: VAH / VAL / POC
      for (const [px, name, col, dash] of [
        [s.vah, 'pVAH', 'rgba(154,180,255,0.75)', [5, 4]],
        [s.val, 'pVAL', 'rgba(154,180,255,0.75)', [5, 4]],
        [s.poc, s.naked ? 'pPOC naked' : 'pPOC', s.naked ? '#ffd166' : 'rgba(242,181,68,0.8)', []],
      ] as [number, string, string, number[]][]) {
        const yy = ax.y(px)
        if (yy < -2 || yy > ax.H + 2) continue
        hline(g, 0, ax.W, yy, col, dash, name.includes('POC') ? 1.4 : 1)
        lab.put(`${tag}${name} ${fmtPx(px, 0)}`, ax.W - 8, Math.round(yy) - 2, col)
      }
    } else if (s.naked) {
      const yy = ax.y(s.poc)
      if (yy < -2 || yy > ax.H + 2) return
      hline(g, 0, ax.W, yy, 'rgba(255,209,102,0.7)', [8, 3], 1.2)
      lab.put(`${tag}nPOC ${day} ${fmtPx(s.poc, 0)}`, ax.W - 8, Math.round(yy) - 2, '#ffd166')
    }
  })
}

// ------------------------------------------------------------------------------------------- VWAP
function polyline(g: CanvasRenderingContext2D, ax: Ax, pts: VwapPoint[], f: (p: VwapPoint) => number, color: string,
  w: number, dash: number[] = []) {
  if (pts.length < 2) return
  g.beginPath()
  let started = false
  let lastX = -Infinity
  for (const pt of pts) {
    const x = ax.xt(pt.t)
    if (x < -50) continue
    if (x - lastX < 1 && started) continue
    const y = ax.y(f(pt))
    if (!started) {
      g.moveTo(x, y)
      started = true
    } else g.lineTo(x, y)
    lastX = x
    if (x > ax.W + 50) break
  }
  g.setLineDash(dash)
  g.strokeStyle = color
  g.lineWidth = w
  g.stroke()
  g.setLineDash([])
}

export function drawVwaps(g: CanvasRenderingContext2D, ax: Ax, p: Prefs, lab: Labeler | null) {
  g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
  g.textBaseline = 'bottom'
  if (p.vwap !== 'off') {
    const s = vwapFor(p.vwap)
    if (s.length > 1) {
      if (p.vwapBands) {
        const alphas = [0.45, 0.32, 0.22]
        for (let k = 1; k <= 3; k++) {
          const col = `rgba(90,209,255,${alphas[k - 1]})`
          polyline(g, ax, s, (q) => q.v + k * q.sd, col, 1, [4, 4])
          polyline(g, ax, s, (q) => q.v - k * q.sd, col, 1, [4, 4])
        }
      }
      polyline(g, ax, s, (q) => q.v, C.cyan, 1.6)
      const l = s[s.length - 1]
      if (lab) {
        lab.put(`${p.vwap === 'day' ? 'VWAP' : 'wVWAP'} ${fmtPx(l.v, 0)}`, ax.W - 8, Math.round(ax.y(l.v)) - 2, C.cyan)
        if (p.vwapBands) for (const k of [1, 2, 3]) {
          lab.put(`+${k}σ`, ax.W - 8, Math.round(ax.y(l.v + k * l.sd)) - 2, 'rgba(90,209,255,0.6)')
          lab.put(`−${k}σ`, ax.W - 8, Math.round(ax.y(l.v - k * l.sd)) - 2, 'rgba(90,209,255,0.6)')
        }
      }
    }
  }
  for (const t of store.anchors) {
    const s = anchoredVwap(t)
    if (s.length < 2) continue
    polyline(g, ax, s, (q) => q.v, C.violet, 1.5)
    const x = ax.xt(t)
    if (x > -10 && x < ax.W) {
      g.fillStyle = C.violet
      g.beginPath()
      g.arc(x, ax.y(s[0].v), 3.5, 0, Math.PI * 2)
      g.fill()
    }
    const l = s[s.length - 1]
    if (lab) lab.put(`aVWAP ${fmtPx(l.v, 0)}`, ax.W - 8, Math.round(ax.y(l.v)) - 2, C.violet)
  }
}

export function drawDevPoc(g: CanvasRenderingContext2D, ax: Ax, p: Prefs) {
  if (!p.devPoc) return
  const path = devPocPath()
  if (path.length < 2) return
  g.beginPath()
  let started = false
  let prevY = 0
  for (const [t, px] of path) {
    const x = ax.xt(t)
    const y = ax.y(px)
    if (!started) {
      g.moveTo(x, y)
      started = true
    } else {
      g.lineTo(x, prevY)
      g.lineTo(x, y)
    }
    prevY = y
  }
  g.strokeStyle = 'rgba(242,181,68,0.9)'
  g.lineWidth = 1.5
  g.setLineDash([2, 2])
  g.stroke()
  g.setLineDash([])
}

// ------------------------------------------------------------------------------------------- profiles
export function drawProfile(g: CanvasRenderingContext2D, ax: Ax, pr: ProfilePair, mode: ProfileView, x0: number,
  maxW: number, dir: 1 | -1, opts: { labels?: boolean; alpha?: number } = {}) {
  const prof = pr.main
  if (!(prof.total > 0) && !(pr.spot && pr.spot.total > 0)) return
  const rh = Math.max(1, Math.abs(ax.y(0) - ax.y(prof.rowUsd)))
  const a = opts.alpha ?? 0.55
  const bar = (x: number, w: number, y: number, h: number) => {
    if (dir > 0) g.fillRect(x0 + x, y, w, h)
    else g.fillRect(x0 - x - w, y, w, h)
  }
  if (prof.vah != null && prof.val != null && mode !== 'liq') {
    g.fillStyle = 'rgba(90,209,255,0.05)'
    const y1 = ax.y(prof.vah)
    bar(0, maxW, y1, ax.y(prof.val) - y1)
  }
  const h = Math.max(1, rh - (rh > 3 ? 1 : 0))
  const rows = prof.rows
  if (mode === 'svp' && pr.spot) {
    const spot = pr.spot
    let mp = 0
    let ms = 0
    for (const c of rows.values()) mp = Math.max(mp, c.b + c.s)
    for (const c of spot.rows.values()) ms = Math.max(ms, c.b + c.s)
    for (const [r, c] of rows) {
      const y0 = ax.y((r + 1) * prof.rowUsd)
      if (y0 > ax.H || y0 + rh < 0) continue
      g.fillStyle = `rgba(154,180,255,${a * 0.8})`
      bar(0, ((c.b + c.s) / (mp || 1)) * maxW, y0, h)
    }
    for (const [r, c] of spot.rows) {
      const y0 = ax.y((r + 1) * spot.rowUsd)
      if (y0 > ax.H || y0 + rh < 0) continue
      g.fillStyle = `rgba(123,224,184,${Math.min(0.9, a + 0.25)})`
      bar(0, ((c.b + c.s) / (ms || 1)) * maxW, y0 + h * 0.3, Math.max(1, h * 0.4))
    }
  } else {
    const max = prof.max || 1
    for (const [r, c] of rows) {
      const y0 = ax.y((r + 1) * prof.rowUsd)
      if (y0 > ax.H || y0 + rh < 0) continue
      if (mode === 'delta') {
        const d = c.b - c.s
        g.fillStyle = d >= 0 ? `rgba(43,217,159,${a + 0.1})` : `rgba(255,92,122,${a + 0.1})`
        bar(0, (Math.abs(d) / max) * maxW, y0, h)
      } else if (mode === 'liq') {
        const wl = (c.ll / max) * maxW
        const ws = (c.ls / max) * maxW
        g.fillStyle = `rgba(255,159,67,${a + 0.2})`
        bar(0, wl, y0, h)
        g.fillStyle = `rgba(90,209,255,${a + 0.2})`
        bar(wl, ws, y0, h)
      } else {
        const w = ((c.b + c.s) / max) * maxW
        const wb = (c.b / max) * maxW
        g.fillStyle = `rgba(43,217,159,${a})`
        bar(0, wb, y0, h)
        g.fillStyle = `rgba(255,92,122,${a})`
        bar(wb, w - wb, y0, h)
      }
    }
  }
  if (prof.poc != null && mode !== 'liq') {
    const yy = Math.round(ax.y(prof.poc)) + 0.5
    g.strokeStyle = 'rgba(242,181,68,0.85)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(x0, yy)
    g.lineTo(x0 + dir * (maxW + 20), yy)
    g.stroke()
    if (opts.labels) {
      g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
      g.textAlign = dir > 0 ? 'left' : 'right'
      g.textBaseline = 'bottom'
      const tx = x0 + dir * 4
      g.fillStyle = C.amber
      g.fillText(`POC ${fmtPx(prof.poc, 0)}`, tx, yy - 2)
      g.fillStyle = C.dim
      if (prof.vah != null) g.fillText(`VAH ${fmtPx(prof.vah, 0)}`, tx, ax.y(prof.vah) - 2)
      g.textBaseline = 'top'
      if (prof.val != null) g.fillText(`VAL ${fmtPx(prof.val, 0)}`, tx, ax.y(prof.val) + 2)
    }
  }
}

/** user-drawn fixed-range profile: box over the range with its own histogram, POC and value area */
export function drawRanges(g: CanvasRenderingContext2D, ax: Ax, rowUsd: number) {
  for (const r of store.ranges) {
    const xa = ax.xt(r.t0)
    const xb = ax.xt(r.t1)
    if (xb < -10 || xa > ax.W + 10) continue
    const prof = rangeProfile(r.id, r.t0, r.t1, rowUsd)
    if (!(prof.total > 0)) continue
    let lo = Infinity
    let hi = -Infinity
    let b = 0
    let s = 0
    for (const [k, c] of prof.rows) {
      lo = Math.min(lo, k * rowUsd)
      hi = Math.max(hi, (k + 1) * rowUsd)
      b += c.b
      s += c.s
    }
    const y0 = ax.y(hi)
    const y1 = ax.y(lo)
    g.fillStyle = 'rgba(180,156,255,0.06)'
    g.fillRect(xa, y0, xb - xa, y1 - y0)
    g.strokeStyle = 'rgba(180,156,255,0.6)'
    g.lineWidth = 1
    g.strokeRect(Math.round(xa) + 0.5, Math.round(y0) + 0.5, Math.round(xb - xa), Math.round(y1 - y0))
    const maxW = Math.max(50, Math.min(240, (xb - xa) * 0.8))
    drawProfile(g, ax, { main: prof, spot: null }, 'volume', xa + 1, maxW, 1, { alpha: 0.5 })
    if (prof.vah != null && prof.val != null) {
      for (const v of [prof.vah, prof.val]) hline(g, xa, Math.max(xb, xa + maxW), ax.y(v), 'rgba(154,180,255,0.6)', [3, 3])
    }
    g.font = '600 10.5px "IBM Plex Sans Condensed", system-ui'
    g.textAlign = 'left'
    g.textBaseline = 'bottom'
    const d = b - s
    g.fillStyle = C.violet
    g.fillText(`Range · vol ${fmtQty(b + s, 0)} · Δ ${d >= 0 ? '+' : ''}${fmtQty(d, 1)} · POC ${fmtPx(prof.poc, 0)}`,
      xa + 3, y0 - 3)
  }
}

export type { Cell }

/** right-edge labels for VWAP / anchored VWAP drawn on a fixed (non-scrolling) layer */
export function drawVwapLabels(ax: Ax, p: Prefs, lab: Labeler) {
  lab.g.font = '600 10px "IBM Plex Sans Condensed", system-ui'
  lab.g.textBaseline = 'bottom'
  if (p.vwap !== 'off') {
    const s = vwapFor(p.vwap)
    const l = s[s.length - 1]
    if (l) {
      lab.put(`${p.vwap === 'day' ? 'VWAP' : 'wVWAP'} ${fmtPx(l.v, 0)}`, ax.W - 8, Math.round(ax.y(l.v)) - 2, C.cyan)
      if (p.vwapBands) for (const k of [1, 2, 3]) {
        for (const sg of [1, -1]) {
          const y = ax.y(l.v + sg * k * l.sd)
          if (y > 0 && y < ax.H) lab.put(`${sg > 0 ? '+' : '−'}${k}σ ${fmtPx(l.v + sg * k * l.sd, 0)}`, ax.W - 8, Math.round(y) - 2,
            'rgba(90,209,255,0.65)')
        }
      }
    }
  }
  for (const t of store.anchors) {
    const s = anchoredVwap(t)
    const l = s[s.length - 1]
    if (l) lab.put(`aVWAP ${fmtPx(l.v, 0)}`, ax.W - 8, Math.round(ax.y(l.v)) - 2, C.violet)
  }
}
