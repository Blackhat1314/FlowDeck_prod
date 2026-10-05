// High-frequency market data lives outside React. Canvases read it in requestAnimationFrame;
// React panels subscribe to coarse version counters (throttled) via useSyncExternalStore.
import { useSyncExternalStore } from 'react'
import { CLOSE_REASONS, type Me } from './session'
import type {
  AbsEvent, Bar, Column, Config, DomData, FlowPanel, Gex, Health, KCheck, Liq, LiqMapData, MicroEvent,
  RangeProfile, Stats, Sweep, Wall, XEvent,
} from './types'

type Topic = 'cols' | 'bars' | 'tape' | 'abs' | 'liqs' | 'gex' | 'stats' | 'health' | 'conn' | 'config' | 'dom'
  | 'walls' | 'flow' | 'liqmap' | 'micro' | 'xev' | 'tools'

const HDR = 40
const BARS_KEEP = 10080 + 60
const LEVELS_KEEP_MS = 24 * 3600_000
const XLEVELS_KEEP_MS = 6 * 3600_000

interface Cum {
  cvd: number
  cvdP: number
  cvdS: number
  z: [number, number, number]
}

export function decodeColumns(buf: ArrayBuffer, cum: Cum, spot: Set<number>): Column[] {
  const dv = new DataView(buf)
  const typ = dv.getUint8(0)
  const ver = dv.getUint8(1)
  const cnt = dv.getUint16(2, true)
  const out: Column[] = []
  if (typ !== 1) return out
  let off = 4
  const triples = (k: number) => {
    const idx = new Int32Array(k)
    const a = new Float32Array(k)
    const b = new Float32Array(k)
    for (let i = 0; i < k; i++) {
      idx[i] = dv.getInt32(off, true)
      a[i] = dv.getFloat32(off + 4, true)
      b[i] = dv.getFloat32(off + 8, true)
      off += 12
    }
    return [idx, a, b] as const
  }
  for (let i = 0; i < cnt; i++) {
    const t = dv.getFloat64(off, true)
    const bb = dv.getFloat64(off + 8, true)
    const ba = dv.getFloat64(off + 16, true)
    const base = dv.getInt32(off + 24, true)
    const n = dv.getUint32(off + 28, true)
    const m = dv.getUint32(off + 32, true)
    const last = dv.getFloat32(off + 36, true)
    off += HDR
    const qty = new Float32Array(buf, off, n)
    off += 4 * n
    const [trIdx, trBuy, trSell] = triples(m)
    let buy = 0
    let sell = 0
    for (let k = 0; k < m; k++) {
      buy += trBuy[k]
      sell += trSell[k]
    }
    let xtIdx = new Int32Array(0)
    let xtBuy = new Float32Array(0)
    let xtSell = new Float32Array(0)
    let cbIdx = new Int32Array(0)
    let cbQty = new Float32Array(0)
    let ex = new Float32Array(0)
    let sz = new Float32Array(6)
    let prem = NaN
    let oi = NaN
    let liqL = 0
    let liqS = 0
    if (ver >= 2) {
      const m2 = dv.getUint32(off, true)
      off += 4
      ;[xtIdx, xtBuy, xtSell] = triples(m2)
      const k3 = dv.getUint32(off, true)
      off += 4
      cbIdx = new Int32Array(k3)
      cbQty = new Float32Array(k3)
      for (let k = 0; k < k3; k++) {
        cbIdx[k] = dv.getInt32(off, true)
        cbQty[k] = dv.getFloat32(off + 4, true)
        off += 8
      }
      const nx = dv.getUint32(off, true)
      off += 4
      ex = new Float32Array(nx * 3)
      for (let k = 0; k < nx; k++) {
        ex[k * 3] = dv.getInt32(off, true)
        ex[k * 3 + 1] = dv.getFloat32(off + 4, true)
        ex[k * 3 + 2] = dv.getFloat32(off + 8, true)
        off += 12
      }
      sz = new Float32Array(6)
      for (let k = 0; k < 6; k++) sz[k] = dv.getFloat32(off + 4 * k, true)
      off += 24
      prem = dv.getFloat32(off, true)
      oi = dv.getFloat32(off + 4, true)
      liqL = dv.getFloat32(off + 8, true)
      liqS = dv.getFloat32(off + 12, true)
      off += 16
    }
    let pb = 0
    let ps = 0
    let sb = 0
    let ss = 0
    if (ex.length) {
      for (let k = 0; k < ex.length; k += 3) {
        if (spot.has(ex[k])) {
          sb += ex[k + 1]
          ss += ex[k + 2]
        } else {
          pb += ex[k + 1]
          ps += ex[k + 2]
        }
      }
    } else {
      pb = buy
      ps = sell
    }
    cum.cvd += buy - sell
    cum.cvdP += pb - ps
    cum.cvdS += sb - ss
    cum.z = [cum.z[0] + sz[0] - sz[1], cum.z[1] + sz[2] - sz[3], cum.z[2] + sz[4] - sz[5]]
    out.push({
      t, bb, ba, base, qty, last, trIdx, trBuy, trSell, xtIdx, xtBuy, xtSell, cbIdx, cbQty, ex, sz, prem, oi,
      liqL, liqS, buy, sell, cvd: cum.cvd, pb, ps, sb, ss, cvdP: cum.cvdP, cvdS: cum.cvdS, cvdZ: cum.z,
    })
  }
  return out
}

function pairs(f: number[] | undefined, into: Map<number, [number, number]>) {
  if (f) for (let i = 0; i < f.length; i += 3) into.set(f[i], [f[i + 1], f[i + 2]])
}

function toBar(j: any, prev?: Bar): Bar {
  const b: Bar = prev ?? {
    t: j.t, o: j.o, h: j.h, l: j.l, c: j.c, v: 0, bv: 0, sv: 0, n: 0, lv: new Map(), sl: new Map(), xl: new Map(),
    ll: new Map(), dmax: 0, dmin: 0, oiD: 0, oi: null, lqL: 0, lqS: 0,
  }
  b.o = j.o
  b.h = j.h
  b.l = j.l
  b.c = j.c
  b.v = j.v
  b.bv = j.bv
  b.sv = j.sv
  b.n = j.n
  if (!j.ax && prev?.ax === 1) prev.lv.clear()
  b.ax = j.ax
  if (j.dx) {
    b.dmax = j.dx[0]
    b.dmin = j.dx[1]
  }
  if (j.oi) {
    b.oiD = j.oi[0]
    b.oi = j.oi[1]
  }
  if (j.lq) {
    b.lqL = j.lq[0]
    b.lqS = j.lq[1]
  }
  const f: number[] | undefined = j.lv
  if (f) {
    // 5 numbers per level: bucket, buy BTC, sell BTC, buy trades, sell trades
    for (let i = 0; i < f.length; i += 5) b.lv.set(f[i], [f[i + 1], f[i + 2], f[i + 3], f[i + 4]])
  }
  pairs(j.sl, b.sl)
  pairs(j.xl, b.xl)
  pairs(j.ll, b.ll)
  return b
}

class Store {
  config: Config | null = null
  venues: { key: string; label: string; exchange: string }[] = []
  demo = false
  cols: Column[] = []
  cum: Cum = { cvd: 0, cvdP: 0, cvdS: 0, z: [0, 0, 0] }
  spotIds = new Set<number>()
  bars = new Map<number, Bar>()
  barTimes: number[] = []
  sweeps: Sweep[] = []
  liqs: Liq[] = []
  abs: AbsEvent[] = []
  micro: MicroEvent[] = []
  xev: XEvent[] = []
  gex: Gex | null = null
  stats: Stats | null = null
  health: Health | null = null
  kchk: KCheck[] = []
  dom: DomData | null = null
  walls: { walls: Wall[]; thr: number } | null = null
  flow: FlowPanel | null = null
  liqmap: LiqMapData | null = null
  bb: number | null = null
  ba: number | null = null
  last: number | null = null
  prevLast: number | null = null
  lastDir: 1 | -1 = 1
  conn: 'connecting' | 'live' | 'down' | 'frozen' = 'connecting'
  me: Me | null = null
  kicked: string | null = null // why the session ended (no reconnect)
  frozenAt: number | null = null // expired plan: time of the frozen snapshot
  frozenEmpty = false // expired plan and the snapshot allowance is used up: nothing to show
  lastColAt = 0 // performance.now() when the last column arrived
  serverSkew = 0 // server t - local Date.now()
  // user tools shared by all charts
  ranges: RangeProfile[] = []
  anchors: number[] = [] // anchored VWAP start times
  private nextRange = 1
  private lastTrim = 0

  private ver: Record<Topic, number> = {
    cols: 0, bars: 0, tape: 0, abs: 0, liqs: 0, gex: 0, stats: 0, health: 0, conn: 0, config: 0, dom: 0,
    walls: 0, flow: 0, liqmap: 0, micro: 0, xev: 0, tools: 0,
  }
  private subs = new Set<() => void>()
  private pending = false
  private ws: WebSocket | null = null
  private retry = 0

  version(t: Topic) {
    return this.ver[t]
  }
  bump(...ts: Topic[]) {
    for (const t of ts) this.ver[t]++
    if (!this.pending) {
      this.pending = true
      setTimeout(() => {
        this.pending = false
        this.subs.forEach((f) => f())
      }, 200)
    }
  }
  subscribe = (f: () => void) => {
    this.subs.add(f)
    return () => this.subs.delete(f)
  }

  // ------------------------------------------------------------------ connection
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.conn = 'connecting'
    this.bump('conn')
    ws.onopen = () => {
      this.retry = 0
    }
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.onJson(JSON.parse(e.data))
      else this.onBinary(e.data as ArrayBuffer)
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      const reason = CLOSE_REASONS[e.code]
      if (reason) {
        // session ended (signed in elsewhere, blocked, signed out by admin…): stop here
        this.kicked = e.reason || reason
        this.conn = 'down'
        this.bump('conn')
        return
      }
      this.conn = 'down'
      this.bump('conn')
      // 4100 = access changed (plan extended): reconnect at once for the live stream
      const d = e.code === 4100 ? 100 : Math.min(8000, 500 * 2 ** this.retry++)
      setTimeout(() => this.connect(), d)
    }
  }

  switchVenue(key: string) {
    this.ws?.send(JSON.stringify({ cmd: 'venue', key }))
  }

  private onBinary(buf: ArrayBuffer) {
    const cols = decodeColumns(buf, this.cum, this.spotIds)
    if (!cols.length) return
    const arr = this.cols
    for (const c of cols) {
      if (arr.length && c.t <= arr[arr.length - 1].t) continue
      arr.push(c)
    }
    const cap = this.config ? Math.ceil((this.config.history_min * 60000) / this.config.column_ms) + 40 : 8000
    if (arr.length > cap + 200) arr.splice(0, arr.length - cap)
    const lc = arr[arr.length - 1]
    this.lastColAt = performance.now()
    this.serverSkew = lc.t - Date.now()
    this.bump('cols')
  }

  private onJson(d: any) {
    switch (d.type) {
      case 'init':
        this.config = d.config
        this.spotIds = new Set((d.config?.xvenues ?? []).filter((x: any) => x.kind === 'spot').map((x: any) => x.x))
        this.venues = d.venues ?? []
        this.demo = !!d.demo
        this.cols = []
        this.cum = { cvd: 0, cvdP: 0, cvdS: 0, z: [0, 0, 0] }
        this.bars.clear()
        this.barTimes = []
        this.setBars(d.bars)
        this.sweeps = d.sweeps ?? []
        this.liqs = d.liqs ?? []
        this.abs = d.abs ?? []
        this.micro = d.micro ?? []
        this.xev = d.xev ?? []
        this.gex = d.gex
        this.stats = d.stats
        this.health = d.health
        this.kchk = d.kchk ?? []
        this.flow = d.flow ?? null
        this.liqmap = d.liqmap ?? null
        this.walls = d.walls ?? null
        this.last = d.stats?.last ?? null
        this.frozenAt = null
        this.conn = 'live'
        this.bump('config', 'cols', 'bars', 'tape', 'abs', 'liqs', 'gex', 'stats', 'health', 'conn', 'flow', 'liqmap',
          'walls', 'micro', 'xev')
        break
      case 'bars':
        this.bars.clear()
        this.barTimes = []
        this.setBars(d.bars)
        if (d.sweeps) this.sweeps = d.sweeps
        this.bump('bars', 'tape')
        break
      case 'u':
        this.onUpdate(d)
        break
      case 'frozen': {
        const lc = this.cols[this.cols.length - 1]
        this.frozenAt = lc ? lc.t + 250 : d.at
        this.frozenEmpty = d.snapshot === false && !lc
        this.conn = 'frozen'
        this.bump('conn', 'cols')
        break
      }
    }
  }

  private setBars(list: any[]) {
    for (const j of list) this.bars.set(j.t, toBar(j))
    this.barTimes = Array.from(this.bars.keys()).sort((a, b) => a - b)
  }

  private onUpdate(d: any) {
    if (d.last != null) {
      if (this.last != null && d.last !== this.last) this.lastDir = d.last > this.last ? 1 : -1
      this.prevLast = this.last
      this.last = d.last
    }
    if (d.bb != null) this.bb = d.bb
    if (d.ba != null) this.ba = d.ba
    if (d.bars) {
      for (const j of d.bars) {
        const prev = this.bars.get(j.t)
        const b = toBar(j, prev)
        if (!prev) {
          this.bars.set(j.t, b)
          this.barTimes.push(j.t)
          if (this.barTimes.length > 1 && this.barTimes[this.barTimes.length - 2] > j.t) this.barTimes.sort((a, b) => a - b)
          if (this.barTimes.length > BARS_KEEP) this.bars.delete(this.barTimes.shift()!)
        }
      }
      this.trim()
      this.bump('bars')
    }
    const push = <T,>(arr: T[], items: T[] | undefined, cap: number) => {
      if (!items) return false
      arr.push(...items)
      if (arr.length > cap) arr.splice(0, arr.length - cap)
      return true
    }
    if (push(this.sweeps, d.sweeps, 4000)) this.bump('tape')
    if (push(this.liqs, d.liqs, 1500)) this.bump('liqs')
    if (push(this.abs, d.abs, 400)) this.bump('abs')
    if (push(this.micro, d.micro, 400)) this.bump('micro')
    if (push(this.xev, d.xev, 300)) this.bump('xev')
    if (d.absu) {
      for (const u of d.absu) {
        const e = this.abs.find((x) => x.id === u.id)
        if (e) e.res = u.res
      }
      this.bump('abs')
    }
    if (d.xevu) {
      for (const u of d.xevu) {
        const e = this.xev.find((x) => x.id === u.id)
        if (e) e.res = u.res
      }
      this.bump('xev')
    }
    if (d.gex) {
      this.gex = d.gex
      this.bump('gex')
    }
    if (d.stats) {
      this.stats = d.stats
      this.bump('stats')
    }
    if (d.dom) {
      this.dom = d.dom
      this.bump('dom')
    }
    if (d.walls) {
      this.walls = d.walls
      this.bump('walls')
    }
    if (d.flow) {
      this.flow = d.flow
      this.bump('flow')
    }
    if (d.liqmap) {
      this.liqmap = d.liqmap
      this.bump('liqmap')
    }
    if (d.kchk) {
      this.kchk.push(...d.kchk)
      if (this.kchk.length > 240) this.kchk.splice(0, this.kchk.length - 240)
    }
    if (d.kchk_fix) {
      for (const r of d.kchk_fix) {
        const i = this.kchk.findIndex((x) => x.t === r.t)
        if (i >= 0) this.kchk[i] = r
      }
      this.bump('health')
    }
    if (d.health) {
      this.health = d.health
      this.bump('health')
    }
  }

  /** mirror the server: drop per-price detail of old bars to bound memory */
  private trim() {
    const now = Date.now()
    if (now - this.lastTrim < 600_000) return
    this.lastTrim = now
    const cutL = now - LEVELS_KEEP_MS
    const cutX = now - XLEVELS_KEEP_MS
    for (const t of this.barTimes) {
      if (t >= cutX) break
      const b = this.bars.get(t)!
      b.sl.clear()
      b.xl.clear()
      if (t < cutL && b.lv.size && !b.ax) {
        b.lv.clear()
        b.ax = 2
      }
    }
  }

  // ------------------------------------------------------------------ tools
  addRange(t0: number, t1: number) {
    if (t1 - t0 < 60_000) return
    this.ranges.push({ id: this.nextRange++, t0, t1 })
    if (this.ranges.length > 6) this.ranges.shift()
    this.bump('tools')
  }
  removeRange(id: number) {
    this.ranges = this.ranges.filter((r) => r.id !== id)
    this.bump('tools')
  }
  addAnchor(t: number) {
    this.anchors.push(t)
    if (this.anchors.length > 4) this.anchors.shift()
    this.bump('tools')
  }
  removeAnchor(t: number) {
    this.anchors = this.anchors.filter((a) => a !== t)
    this.bump('tools')
  }
  clearTools() {
    this.ranges = []
    this.anchors = []
    this.bump('tools')
  }

  // ------------------------------------------------------------------ queries
  /** index of the last column with t <= time (or -1) */
  colAt(time: number): number {
    const a = this.cols
    let lo = 0
    let hi = a.length - 1
    if (hi < 0 || time < a[0].t) return -1
    if (time >= a[hi].t) return hi
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (a[mid].t <= time) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** index of the first bar time >= t */
  barIndex(t: number): number {
    const a = this.barTimes
    let lo = 0
    let hi = a.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (a[mid] < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  venue(x: number | undefined) {
    if (x == null || !this.config?.xvenues) return null
    return this.config.xvenues.find((v) => v.x === x) ?? null
  }

  /** latest price offset of a venue vs the primary (from the flow panel) */
  basis(x: number | undefined): number {
    if (x == null || x === this.config?.primary_x) return 0
    const v = this.flow?.venues.find((r) => r.x === x)
    return v?.basis ?? 0
  }

  /** server-clock "now" estimated from the column stream */
  now(): number {
    return this.frozenAt ?? Date.now() + this.serverSkew
  }
}

export const store = new Store()

export function useTopic(...topics: Topic[]) {
  return useSyncExternalStore(store.subscribe, () => topics.map((t) => store.version(t)).join(':'))
}
