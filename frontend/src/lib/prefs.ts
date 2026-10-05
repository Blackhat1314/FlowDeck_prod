// User preferences shared by every chart and panel (persisted in localStorage when available).
import type { ProfileMode, Source } from './analytics'

export type GammaGroup = 'all' | 'front' | 'week' | 'month'
export type ViewMode = 'heatmap' | 'footprint' | 'split' | 'tpo'
export type BottomMode = 'delta' | 'perps' | 'spotperp' | 'size' | 'oi' | 'premium'
export type ProfileRange = 'session' | 'prev' | '4h' | '1h' | 'visible' | '3d' | '7d'
export type ProfileView = ProfileMode | 'svp' // svp = spot vs perp side by side
export type FpMode = 'bidask' | 'delta' | 'volume' | 'trades' | 'ratio'
export type VwapMode = 'off' | 'day' | 'week'
export type Tool = 'none' | 'range' | 'avwap'
export type TpoSession = 'utc' | 'asia' | 'london' | 'ny' | 'funding'

export type HeatPalette = 'classic' | 'thermal'
export type BubbleStyle = '3d' | 'flat' | 'pie'
export type BubbleCluster = 'off' | 'smart' | '1s' | '5s' | '15s' | '60s'

export const DEFAULTS = {
  view: 'heatmap' as ViewMode,
  // heatmap
  contrast: 1,
  heatPalette: 'classic' as HeatPalette, // classic = blue → grey → yellow → orange → red
  heatRows: 0, // price-row size in $ (0 = auto: about 12 px per row in classic, 1 px in thermal)
  heatGrid: true, // row separators and dotted time grid
  bubbles: true,
  bubbleStyle: '3d' as BubbleStyle,
  bubbleSizeBy: 'total' as 'total' | 'delta',
  bubbleAlpha: 0.25, // transparency 0 … 0.9
  bubbleCluster: 'smart' as BubbleCluster,
  bubbleScale: 2.2,
  minBubble: 0.2,
  bigTrade: 5,
  bidAsk: true,
  dom: true,
  domWin: 30, // pull/stack window in seconds, 0 = off
  book: 'primary' as 'primary' | 'combined',
  xPrints: true, // include other perps' prints and sweeps
  liqs: true,
  liqMap: true,
  micro: true,
  bottom: 'delta' as BottomMode,
  venOff: [] as number[], // venues switched off for the aggregated tape / CVD
  // levels shared by heatmap and footprint
  gamma: true,
  gammaGroup: 'all' as GammaGroup,
  basisAdjust: true,
  absorption: true,
  profile: true,
  profileRange: 'session' as ProfileRange,
  profileMode: 'volume' as ProfileView,
  profileSrc: 'primary' as Source,
  levels: true, // prior-session POC / VAH / VAL and naked POCs
  levelDays: 3,
  devPoc: false,
  vwap: 'day' as VwapMode,
  vwapBands: true,
  // footprint
  tf: 1,
  row: 0,
  imbalance: 3,
  showImb: true,
  showPoc: true,
  fpMode: 'bidask' as FpMode,
  fpSrc: 'primary' as Source,
  fpMin: 0, // hide cells below this size (BTC)
  cluster: 0, // highlight cells at or above this size (BTC), 0 = off
  stats: true,
  zones: true,
  // TPO
  tpoSession: 'utc' as TpoSession,
  tpoDays: 3,
  tpoSplit: false,
  tpoComposite: true,
  // drawing tool (not persisted)
  tool: 'none' as Tool,
}
export type Prefs = typeof DEFAULTS

const KEY = 'flowdeck.prefs.v2'

export function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw), tool: 'none' }
  } catch {
    /* storage unavailable */
  }
  return DEFAULTS
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...p, tool: 'none' }))
  } catch {
    /* ignore */
  }
}

export const TPO_SESSIONS: Record<TpoSession, { label: string; start: number; len: number; every: number }> = {
  // start offset from 00:00 UTC (ms), length (ms), repeat interval (ms)
  utc: { label: 'UTC day', start: 0, len: 86_400_000, every: 86_400_000 },
  asia: { label: 'Asia 00–08 UTC', start: 0, len: 8 * 3_600_000, every: 86_400_000 },
  london: { label: 'London 07–16 UTC', start: 7 * 3_600_000, len: 9 * 3_600_000, every: 86_400_000 },
  ny: { label: 'New York 13:30–20 UTC', start: 13.5 * 3_600_000, len: 6.5 * 3_600_000, every: 86_400_000 },
  funding: { label: 'Funding 8h (00/08/16)', start: 0, len: 8 * 3_600_000, every: 8 * 3_600_000 },
}
