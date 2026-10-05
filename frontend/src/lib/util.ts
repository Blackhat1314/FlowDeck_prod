// ---------------------------------------------------------------- palette
export const C = {
  bg: '#08111c',
  panel: '#0d1826',
  panel2: '#112033',
  line: '#1a2a40',
  grid: 'rgba(120,150,190,0.07)',
  text: '#d3dceb',
  dim: '#7f90aa',
  faint: '#4d5f7a',
  buy: '#2bd99f',
  sell: '#ff5c7a',
  amber: '#f2b544',
  violet: '#b49cff',
  cyan: '#5ad1ff',
  orange: '#ff9f43',
}

// Thermal ramp tuned to the navy base: ink -> deep blue -> teal -> lime -> yellow -> orange -> white-hot
const STOPS: [number, [number, number, number]][] = [
  [0.0, [8, 17, 28]],
  [0.06, [10, 33, 62]],
  [0.2, [14, 78, 128]],
  [0.38, [26, 150, 176]],
  [0.56, [118, 206, 98]],
  [0.72, [242, 214, 66]],
  [0.86, [245, 140, 52]],
  [1.0, [255, 246, 228]],
]

// Classic order-book palette (the look most order-flow traders know): dark slate -> blues -> steel grey ->
// light grey -> yellow -> orange -> red. Tones sampled from common desktop heatmap tools.
const CLASSIC: [number, [number, number, number]][] = [
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

function makeLut(stops: [number, [number, number, number]][]) {
  const n = 512
  const lut = new Uint32Array(n)
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1)
    let k = 0
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++
    const [x0, c0] = stops[k]
    const [x1, c1] = stops[k + 1]
    const f = (x - x0) / (x1 - x0)
    const r = Math.round(c0[0] + (c1[0] - c0[0]) * f)
    const g = Math.round(c0[1] + (c1[1] - c0[1]) * f)
    const b = Math.round(c0[2] + (c1[2] - c0[2]) * f)
    lut[i] = (255 << 24) | (b << 16) | (g << 8) | r // little-endian RGBA
  }
  return lut
}

export const HEAT_LUT = makeLut(STOPS)
export const CLASSIC_LUT = makeLut(CLASSIC)
const css = (stops: [number, [number, number, number]][]) => stops.map(([x, c]) => `rgb(${c.join(',')}) ${Math.round(x * 100)}%`).join(', ')
export const HEAT_CSS = css(STOPS)
export const CLASSIC_CSS = css(CLASSIC)
export const CLASSIC_BG = 'rgb(24,34,40)'

// ---------------------------------------------------------------- formatting
export function fmtPx(p: number | null | undefined, d = 1) {
  if (p == null || !isFinite(p)) return '–'
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}

export function fmtQty(q: number | null | undefined, d?: number) {
  if (q == null || !isFinite(q)) return '–'
  const a = Math.abs(q)
  const dd = d ?? (a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3)
  return q.toFixed(dd)
}

export function fmtUsd(v: number | null | undefined, d = 1) {
  if (v == null || !isFinite(v)) return '–'
  const a = Math.abs(v)
  const s = v < 0 ? '-' : ''
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(d + 1)}B`
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(d)}M`
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`
  return `${s}$${a.toFixed(0)}`
}

export function fmtTime(t: number, ms = false) {
  const d = new Date(t)
  const s = d.toLocaleTimeString('en-GB', { hour12: false })
  return ms ? `${s}.${String(d.getMilliseconds()).padStart(3, '0')}` : s
}

const TICK_STEPS_S = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800]

/** Time-axis ticks for a visible range at `mpp` ms per pixel: ~90 px apart, aligned to local clock time, with dates
 *  where a day starts or when zoomed out to days. */
export function timeTicks(t0: number, t1: number, mpp: number): { t: number; label: string; step: number }[] {
  const stepS = TICK_STEPS_S.find((v) => (v * 1000) / mpp > 90) ?? 604800
  const step = stepS * 1000
  const off = -new Date(t0).getTimezoneOffset() * 60000 // local time = UTC + off
  const out: { t: number; label: string; step: number }[] = []
  for (let t = Math.ceil((t0 + off) / step) * step - off; t < t1; t += step) {
    const d = new Date(t)
    const midnight = d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    const label = stepS >= 86400 || (midnight && stepS >= 60) ? date : fmtTime(t).slice(0, stepS >= 60 ? 5 : 8)
    out.push({ t, label, step })
    if (out.length > 400) break
  }
  return out
}

export function fmtSigned(v: number, d = 1) {
  return (v > 0 ? '+' : '') + v.toFixed(d)
}

export function niceStep(range: number, target: number) {
  const raw = range / Math.max(1, target)
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  const m = raw / p
  const s = m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10
  return s * p
}

export function utcDayStart(t: number) {
  return t - (t % 86400000)
}

/** colour per venue id (see backend XVENUES) */
export const VENUE_COLOR: Record<number, string> = {
  0: '#f2c94c', // Binance USDⓈ-M
  1: '#c4a24a', // Binance COIN-M
  2: '#ff8a5c', // Bybit linear
  3: '#d9785a', // Bybit inverse
  4: '#9ab4ff', // OKX
  5: '#7be0b8', // Binance spot
  6: '#4f8dff', // Coinbase
}

export function venueColor(x: number | undefined) {
  return (x != null && VENUE_COLOR[x]) || C.dim
}

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

export function fmtAge(sec: number) {
  if (sec < 60) return `${sec.toFixed(0)}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(Math.floor(sec % 60)).padStart(2, '0')}`
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`
}

export function fmtDay(t: number) {
  const d = new Date(t)
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
}
