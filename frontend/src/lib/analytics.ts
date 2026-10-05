// Bar-derived analytics shared by the charts: footprint aggregation (any source / timeframe / row size),
// footprint zones, volume profiles, session levels (POC/VAH/VAL, naked POCs, developing POC), VWAP.
import type { Bar } from './types'

export type Source = 'primary' | 'perps' | 'spot'
export const DAY = 86_400_000

export interface Cell {
  b: number // aggressive buy volume
  s: number // aggressive sell volume
  nb: number // buy trades (primary only)
  ns: number
  ll: number // long liquidations
  ls: number // short liquidations
}

export interface AggBar {
  t: number
  t1: number
  o: number
  h: number
  l: number
  c: number
  v: number
  bv: number
  sv: number
  n: number
  dmax: number
  dmin: number
  oiD: number
  oi: number | null
  lqL: number
  lqS: number
  ax: boolean // candle only, no per-price detail
  rows: Map<number, Cell>
}

function cell(rows: Map<number, Cell>, r: number): Cell {
  let c = rows.get(r)
  if (!c) {
    c = { b: 0, s: 0, nb: 0, ns: 0, ll: 0, ls: 0 }
    rows.set(r, c)
  }
  return c
}

/** visit the per-price volume of one 1m bar for a source: f(bucket, buy, sell, buyTrades, sellTrades) */
export function eachLevel(b: Bar, src: Source, f: (k: number, buy: number, sell: number, nb: number, ns: number) => void) {
  if (src !== 'spot') for (const [k, e] of b.lv) f(k, e[0], e[1], e[2], e[3])
  if (src === 'perps') for (const [k, e] of b.xl) f(k, e[0], e[1], 0, 0)
  if (src === 'spot') for (const [k, e] of b.sl) f(k, e[0], e[1], 0, 0)
}

export function hasDetail(b: Bar, src: Source) {
  return src === 'spot' ? b.sl.size > 0 : b.lv.size > 0
}

/** merge 1m bars into tf-minute bars and group levels into rowUsd rows */
export function aggregateBars(bars: Map<number, Bar>, times: number[], tfMin: number, rowUsd: number, bucketUsd: number,
  fromT = -Infinity, src: Source = 'primary'): AggBar[] {
  const tf = tfMin * 60000
  const out: AggBar[] = []
  let cur: AggBar | null = null
  let run = 0 // running delta inside the aggregated bar
  const start = fromT === -Infinity ? 0 : lowerBound(times, fromT - (fromT % tf))
  for (let i = start; i < times.length; i++) {
    const t = times[i]
    const b = bars.get(t)
    if (!b || b.o == null) continue
    const bt = t - (t % tf)
    if (!cur || cur.t !== bt) {
      cur = { t: bt, t1: bt + tf, o: b.o, h: b.h, l: b.l, c: b.c, v: 0, bv: 0, sv: 0, n: 0, dmax: 0, dmin: 0, oiD: 0,
        oi: null, lqL: 0, lqS: 0, ax: false, rows: new Map() }
      out.push(cur)
      run = 0
    }
    cur.h = Math.max(cur.h, b.h)
    cur.l = Math.min(cur.l, b.l)
    cur.c = b.c
    let bv = b.bv
    let sv = b.sv
    if (src !== 'primary') {
      bv = 0
      sv = 0
      if (src === 'perps') {
        bv = b.bv
        sv = b.sv
      }
      const m = src === 'perps' ? b.xl : b.sl
      for (const e of m.values()) {
        bv += e[0]
        sv += e[1]
      }
    }
    cur.v += bv + sv
    cur.bv += bv
    cur.sv += sv
    cur.n += b.n
    cur.dmax = Math.max(cur.dmax, run + (src === 'primary' ? b.dmax : Math.max(0, bv - sv)))
    cur.dmin = Math.min(cur.dmin, run + (src === 'primary' ? b.dmin : Math.min(0, bv - sv)))
    run += bv - sv
    cur.oiD += b.oiD
    if (b.oi != null) cur.oi = b.oi
    cur.lqL += b.lqL
    cur.lqS += b.lqS
    if (b.ax || !hasDetail(b, src)) cur.ax = cur.ax || !!b.ax || (src === 'spot' && b.sl.size === 0 && b.v > 0)
    eachLevel(b, src, (k, buy, sell, nb, ns) => {
      const c = cell(cur!.rows, Math.floor((k * bucketUsd + 1e-9) / rowUsd))
      c.b += buy
      c.s += sell
      c.nb += nb
      c.ns += ns
    })
    for (const [k, e] of b.ll) {
      const c = cell(cur.rows, Math.floor((k * bucketUsd + 1e-9) / rowUsd))
      c.ll += e[0]
      c.ls += e[1]
    }
  }
  return out
}

export function lowerBound(a: number[], x: number) {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (a[m] < x) lo = m + 1
    else hi = m
  }
  return lo
}

// ---------------------------------------------------------------- footprint zones
export interface FpZone {
  kind: 'buyImb' | 'sellImb' | 'unfinHigh' | 'unfinLow' | 'poc'
  t: number // bar start where it formed
  lo: number
  hi: number
  endT: number | null // time price came back (null = still open)
}

/** diagonal imbalance flags per row of one aggregated bar */
export function imbalances(bar: AggBar, ratio: number, minFrac = 0.04) {
  let maxSide = 0
  for (const c of bar.rows.values()) maxSide = Math.max(maxSide, c.b, c.s)
  const minV = maxSide * minFrac
  const buy = new Set<number>()
  const sell = new Set<number>()
  for (const [r, c] of bar.rows) {
    const below = bar.rows.get(r - 1)
    const above = bar.rows.get(r + 1)
    if (below && c.b > minV && c.b >= ratio * below.s) buy.add(r)
    if (above && c.s > minV && c.s >= ratio * above.b) sell.add(r)
  }
  return { buy, sell, maxSide }
}

export function barPoc(bar: AggBar): number | null {
  let best = -1
  let poc: number | null = null
  for (const [r, c] of bar.rows) {
    const v = c.b + c.s
    if (v > best) {
      best = v
      poc = r
    }
  }
  return poc
}

/** stacked imbalances (>= minStack rows), unfinished auctions and bar POCs, each tracked until price returns */
export function footprintZones(bars: AggBar[], rowUsd: number, ratio: number, minStack = 3): FpZone[] {
  const zones: FpZone[] = []
  for (const bar of bars) {
    if (bar.ax || !bar.rows.size) continue
    const { buy, sell } = imbalances(bar, ratio)
    for (const [set, kind] of [[buy, 'buyImb'], [sell, 'sellImb']] as const) {
      const rs = [...set].sort((a, b) => a - b)
      let i = 0
      while (i < rs.length) {
        let j = i
        while (j + 1 < rs.length && rs[j + 1] === rs[j] + 1) j++
        if (j - i + 1 >= minStack) zones.push({ kind, t: bar.t, lo: rs[i] * rowUsd, hi: (rs[j] + 1) * rowUsd, endT: null })
        i = j + 1
      }
    }
    // unfinished auction: both sides traded at the bar's extreme row
    const top = Math.floor(bar.h / rowUsd)
    const bot = Math.floor(bar.l / rowUsd)
    const ct = bar.rows.get(top)
    const cb = bar.rows.get(bot)
    if (ct && ct.b > 0 && ct.s > 0) zones.push({ kind: 'unfinHigh', t: bar.t, lo: top * rowUsd, hi: (top + 1) * rowUsd, endT: null })
    if (cb && cb.b > 0 && cb.s > 0) zones.push({ kind: 'unfinLow', t: bar.t, lo: bot * rowUsd, hi: (bot + 1) * rowUsd, endT: null })
    const p = barPoc(bar)
    if (p != null) zones.push({ kind: 'poc', t: bar.t, lo: p * rowUsd, hi: (p + 1) * rowUsd, endT: null })
  }
  // close zones when a later bar trades back into them
  for (const z of zones) {
    for (const bar of bars) {
      if (bar.t <= z.t) continue
      let hit = false
      if (z.kind === 'unfinHigh') hit = bar.h >= z.hi
      else if (z.kind === 'unfinLow') hit = bar.l < z.lo
      else hit = bar.l < z.hi && bar.h >= z.lo
      if (hit) {
        z.endT = bar.t
        break
      }
    }
  }
  return zones
}

// ---------------------------------------------------------------- volume profile
export type ProfileMode = 'volume' | 'delta' | 'liq'

export interface Profile {
  rowUsd: number
  rows: Map<number, Cell>
  max: number // max of the displayed quantity
  total: number
  poc: number | null
  vah: number | null
  val: number | null
}

/** profile over [t0, t1). Bars without tick detail spread their candle volume evenly over the range. */
export function buildProfile(bars: Map<number, Bar>, times: number[], t0: number, t1: number, rowUsd: number,
  bucketUsd: number, src: Source = 'primary', mode: ProfileMode = 'volume'): Profile {
  const rows = new Map<number, Cell>()
  const i0 = lowerBound(times, t0)
  for (let i = i0; i < times.length && times[i] < t1; i++) {
    const b = bars.get(times[i])
    if (!b) continue
    if (src !== 'spot' && (b.ax || b.lv.size === 0)) {
      if (!(b.v > 0) || b.h == null) continue
      const r0 = Math.floor(b.l / rowUsd)
      const r1 = Math.floor(b.h / rowUsd)
      const k = r1 - r0 + 1
      for (let r = r0; r <= r1; r++) {
        const c = cell(rows, r)
        c.b += b.bv / k
        c.s += b.sv / k
      }
    } else {
      eachLevel(b, src, (k, buy, sell) => {
        const c = cell(rows, Math.floor((k * bucketUsd + 1e-9) / rowUsd))
        c.b += buy
        c.s += sell
      })
    }
    if (mode === 'liq') {
      for (const [k, e] of b.ll) {
        const c = cell(rows, Math.floor((k * bucketUsd + 1e-9) / rowUsd))
        c.ll += e[0]
        c.ls += e[1]
      }
    }
  }
  return finishProfile(rows, rowUsd, mode)
}

export function finishProfile(rows: Map<number, Cell>, rowUsd: number, mode: ProfileMode = 'volume'): Profile {
  let max = 0
  let total = 0
  let pocV = 0
  let poc: number | null = null
  for (const [r, c] of rows) {
    const v = c.b + c.s
    total += v
    if (v > pocV) {
      pocV = v
      poc = r
    }
    const shown = mode === 'delta' ? Math.abs(c.b - c.s) : mode === 'liq' ? c.ll + c.ls : v
    if (shown > max) max = shown
  }
  let vah: number | null = null
  let val: number | null = null
  if (poc != null && total > 0) {
    const keys = [...rows.keys()].sort((a, b) => a - b)
    const pi = keys.indexOf(poc)
    let lo = pi
    let hi = pi
    let acc = pocV
    const tgt = total * 0.7
    const vol = (i: number) => {
      const c = rows.get(keys[i])!
      return c.b + c.s
    }
    while (acc < tgt && (lo > 0 || hi < keys.length - 1)) {
      const up = (hi + 1 < keys.length ? vol(hi + 1) : 0) + (hi + 2 < keys.length ? vol(hi + 2) : 0)
      const dn = (lo - 1 >= 0 ? vol(lo - 1) : 0) + (lo - 2 >= 0 ? vol(lo - 2) : 0)
      if ((up >= dn && hi < keys.length - 1) || lo === 0) {
        const n = Math.min(2, keys.length - 1 - hi)
        for (let k = 1; k <= n; k++) acc += vol(hi + k)
        hi += n
      } else {
        const n = Math.min(2, lo)
        for (let k = 1; k <= n; k++) acc += vol(lo - k)
        lo -= n
      }
    }
    vah = (keys[hi] + 1) * rowUsd
    val = keys[lo] * rowUsd
  }
  return { rowUsd, rows, max, total, poc: poc != null ? (poc + 0.5) * rowUsd : null, vah, val }
}

// ---------------------------------------------------------------- session levels
export interface SessionLevels {
  day: number // UTC day start
  poc: number
  vah: number
  val: number
  naked: boolean // POC not traded since the session ended
  approx: boolean // built from candles (no tick detail)
}

export function sessionLevels(bars: Map<number, Bar>, times: number[], days: number, rowUsd: number, bucketUsd: number,
  now: number): SessionLevels[] {
  const out: SessionLevels[] = []
  const today = now - (now % DAY)
  for (let d = 1; d <= days; d++) {
    const t0 = today - d * DAY
    const i0 = lowerBound(times, t0)
    if (i0 >= times.length || times[i0] >= t0 + DAY) continue
    const p = buildProfile(bars, times, t0, t0 + DAY, rowUsd, bucketUsd)
    if (p.poc == null) continue
    let approx = true
    for (let i = i0; i < times.length && times[i] < t0 + DAY; i++) {
      const b = bars.get(times[i])
      if (b && !b.ax && b.lv.size) {
        approx = false
        break
      }
    }
    // naked: no bar after the session traded through the POC
    let naked = true
    for (let i = lowerBound(times, t0 + DAY); i < times.length; i++) {
      const b = bars.get(times[i])
      if (b && b.l <= p.poc && b.h >= p.poc) {
        naked = false
        break
      }
    }
    out.push({ day: t0, poc: p.poc, vah: p.vah ?? p.poc, val: p.val ?? p.poc, naked, approx })
  }
  return out
}

/** developing POC path for a session: one point per minute */
export function developingPoc(bars: Map<number, Bar>, times: number[], t0: number, rowUsd: number, bucketUsd: number):
  [number, number][] {
  const vol = new Map<number, number>()
  let best = -1
  let poc: number | null = null
  const out: [number, number][] = []
  for (let i = lowerBound(times, t0); i < times.length; i++) {
    const b = bars.get(times[i])
    if (!b) continue
    const add = (r: number, v: number) => {
      const x = (vol.get(r) ?? 0) + v
      vol.set(r, x)
      if (x > best) {
        best = x
        poc = r
      }
    }
    if (b.ax || !b.lv.size) {
      if (b.v > 0 && b.h != null) {
        const r0 = Math.floor(b.l / rowUsd)
        const r1 = Math.floor(b.h / rowUsd)
        for (let r = r0; r <= r1; r++) add(r, b.v / (r1 - r0 + 1))
      }
    } else for (const [k, e] of b.lv) add(Math.floor((k * bucketUsd + 1e-9) / rowUsd), e[0] + e[1])
    if (poc != null) out.push([times[i] + 60_000, (poc + 0.5) * rowUsd])
  }
  return out
}

// ---------------------------------------------------------------- VWAP
export interface VwapPoint {
  t: number // end of the minute
  v: number
  sd: number
}

/** volume-weighted average price from t0, with standard deviation (for bands), one point per minute */
export function vwapSeries(bars: Map<number, Bar>, times: number[], t0: number, bucketUsd: number): VwapPoint[] {
  let sv = 0
  let spv = 0
  let sp2v = 0
  const out: VwapPoint[] = []
  const half = bucketUsd / 2
  for (let i = lowerBound(times, t0); i < times.length; i++) {
    const b = bars.get(times[i])
    if (!b || !(b.v > 0)) continue
    if (b.lv.size && !b.ax) {
      for (const [k, e] of b.lv) {
        const p = k * bucketUsd + half
        const v = e[0] + e[1]
        sv += v
        spv += p * v
        sp2v += p * p * v
      }
    } else {
      const p = (b.h + b.l + b.c) / 3
      sv += b.v
      spv += p * b.v
      sp2v += p * p * b.v
    }
    if (sv > 0) {
      const m = spv / sv
      out.push({ t: times[i] + 60_000, v: m, sd: Math.sqrt(Math.max(0, sp2v / sv - m * m)) })
    }
  }
  return out
}

/** the most recent funding time (00/08/16 UTC) at or before t */
export function lastFunding(t: number) {
  return t - (t % (8 * 3600_000))
}

export function weekStart(t: number) {
  const d = new Date(t - (t % DAY))
  const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
  return d.getTime() - dow * DAY
}
