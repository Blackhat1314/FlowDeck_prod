export interface Column {
  t: number
  bb: number
  ba: number
  base: number
  qty: Float32Array // primary venue resting liquidity per bucket
  last: number
  trIdx: Int32Array // primary prints: bucket, buy, sell
  trBuy: Float32Array
  trSell: Float32Array
  xtIdx: Int32Array // other perps' prints (basis-adjusted buckets)
  xtBuy: Float32Array
  xtSell: Float32Array
  cbIdx: Int32Array // other perps' resting liquidity (combined book)
  cbQty: Float32Array
  ex: Float32Array // [venue, buy, sell] * k : volume per venue in this column
  sz: Float32Array // perp taker-order size classes: <1 b,s | 1-10 b,s | >=10 b,s
  prem: number // Coinbase premium (USD), NaN if n/a
  oi: number // open interest all venues (BTC), NaN if n/a
  liqL: number // long liquidations (BTC)
  liqS: number // short liquidations (BTC)
  buy: number // primary aggressive buy volume
  sell: number
  cvd: number // primary cumulative delta since history start
  pb: number // all perps buy / sell in this column (incl. primary)
  ps: number
  sb: number // spot buy / sell
  ss: number
  cvdP: number // cumulative all-perp delta
  cvdS: number // cumulative spot delta
  cvdZ: [number, number, number] // cumulative delta by taker-order size (<1, 1-10, >=10)
}

export interface Bar {
  t: number
  o: number
  h: number
  l: number
  c: number
  v: number
  bv: number
  sv: number
  n: number
  ax?: number // 1 = candle from exchange klines, 2 = older bar with per-price detail trimmed
  lv: Map<number, [number, number, number, number]> // bucket -> [buyBTC, sellBTC, buy trades, sell trades]
  sl: Map<number, [number, number]> // spot volume per bucket (basis-adjusted)
  xl: Map<number, [number, number]> // other perps' volume per bucket (basis-adjusted)
  ll: Map<number, [number, number]> // liquidations per bucket: [long, short]
  dmax: number // highest / lowest running delta inside the bar
  dmin: number
  oiD: number // open-interest change during the bar (all venues, BTC)
  oi: number | null
  lqL: number
  lqS: number
}

export interface Sweep {
  id: number | string
  t: number
  lt: number
  s: 1 | -1
  q: number
  p: number
  pa?: number // basis-adjusted price (other venues)
  lo: number
  hi: number
  n: number
  usd: number
  x?: number // venue id
  bf?: number
}

export interface Liq {
  t: number
  lt: number
  x?: number
  side: 'long' | 'short'
  p: number
  q: number
  usd: number
}

export interface AbsEvent {
  id: number
  t: number
  side: 'bid' | 'ask'
  p: number
  vol: number
  vis0: number
  vis: number
  ratio: number
  thr: number
  dur: number
  strength: number
  n: number
  res: null | { move: number; mfe: number; mae: number; win: boolean }
}

export interface MicroEvent {
  id: number
  type: 'pulled' | 'eaten' | 'iceberg'
  t: number
  side: 'bid' | 'ask'
  p: number
  label: string
  max?: number
  filled?: number
  cancelled?: number
  age?: number
  dist_bps?: number
  refills?: number
  exec?: number
  hidden?: number
  shown?: number
}

export interface XEvent {
  id: number
  type: 'cascade' | 'regime'
  t: number
  label: string
  side?: 'long' | 'short'
  btc?: number
  usd?: number
  n?: number
  lo?: number
  hi?: number
  state?: string
  bias?: number
  price?: number
  dp_bps?: number
  perp_z?: number
  spot_z?: number
  res?: null | { move: number; win: boolean }
}

export interface Wall {
  side: 'bid' | 'ask'
  p: number
  q: number
  max: number
  age: number
  filled: number
  cancelled: number
  refills: number
  dist_bps: number | null
}

export interface DomData {
  rows: number[][] // [bucket, bid, ask, then per window: stackBid, fillsBid, stackAsk, fillsAsk]
  bucket: number
  windows: number[]
}

export interface VenueRow {
  x: number
  key: string
  label: string
  name: string
  kind: 'perp' | 'spot'
  px: number | null
  basis: number | null
  oi: number | null
  fund: number | null
  next: number | null
  live: boolean
  trades: number
}

export interface FlowPanel {
  venues: VenueRow[]
  oi: number | null
  oi_d5: number | null
  oi_d60: number | null
  fund_w: number | null
  premium: number | null
  premium_bps: number | null
  usdt: number | null
  regime: { state: string; label: string; since: number | null; dp_bps?: number; perp_z?: number; spot_z?: number;
    perp_cvd?: number; spot_cvd?: number; price?: number }
  cvd5: { perp: number; spot: number; perp_vol: number; spot_vol: number }
  cvd60: { perp: number; spot: number; perp_vol: number; spot_vol: number }
  size5: [number, number, number]
  size60: [number, number, number]
  liq5: [number, number]
  liq60: [number, number]
  regime_stats: { scored: number; hit_rate: number | null }
}

export interface LiqMapData {
  bucket: number
  long: [number, number][]
  short: [number, number][]
  top_long: { lo: number; hi: number; p: number; btc: number }[]
  top_short: { lo: number; hi: number; p: number; btc: number }[]
  seeded: number
  updates: number
  total_long: number
  total_short: number
}

export interface GexGroup {
  net: number
  call: number
  put: number
  strikes: [number, number, number, number, number, number][] // K, callGex, putGex, net, callOI, putOI
  call_wall: number | null
  put_wall: number | null
  abs_strike: number | null
  flip: number | null
  pos: number[]
  neg: number[]
  curve: [number, number][]
}

export interface Gex {
  ts: number
  spot: number
  n_options: number
  expiries: { t: number; label: string }[]
  front: number
  max_pain: number | null
  call_oi: number
  put_oi: number
  pcr: number | null
  basis?: number
  perp_mark?: number
  groups: Record<'all' | 'front' | 'week' | 'month', GexGroup | null>
}

export interface Stats {
  mark: number | null
  index: number | null
  funding: number | null
  next_funding: number | null
  oi: number | null
  oi_usd: number | null
  chg24: number | null
  high24: number | null
  low24: number | null
  vol24: number | null
  volusd24: number | null
  last: number | null
}

export interface KCheck {
  t: number
  status: string
  vol_k: number
  vol_e: number
  buy_k: number
  buy_e: number
  vol_ok: boolean
  buy_ok: boolean
  vol_err: number
  vol_diff: number
  tape_ok?: boolean
  tape_v?: number
  delta_k: number
  delta_e: number
  n_k: number
  n_e: number
  ids_ok: boolean
  ohlc_ok: boolean
  gaps: number
}

export interface Health {
  kline_checked: number
  vol_exact: number
  vol_close: number
  buy_close: number
  buy_exact: number
  clock_offset?: number
  tape_checked?: number
  tape_exact?: number
  tape_arbitrated?: number
  ids_exact: number
  ohlc_exact: number
  vol_err_avg: number | null
  buy_err_avg: number | null
  book_checks: number
  book_pct_avg: number | null
  book_last: null | {
    pct: number | null
    known_pct: number | null
    coverage_pct: number | null
    levels: number
    match: number
    qty_diff: number
    missing: number
    stale: number
    repaired: number
  }
  lat_p50: number | null
  lat_p95: number | null
  resyncs: number
  agg_gaps: number
  crossed: number
  book_updates: number
  live_trades: number
  abs: { scored: number; hit_rate?: number; avg_move?: number; avg_mfe?: number; avg_mae?: number }
  book_state: string
  backfill: string
  msgs: number
  xmsgs?: number
  columns: number
  feeds?: Record<string, string>
  micro?: { filled: number; cancelled: number; hidden: number; added: number; decreases: number }
  xbooks?: Record<string, { ok: boolean; updates: number; gaps: number }>
  liqmap?: { seeded: number; updates: number }
}

export interface XVenueInfo {
  x: number
  key: string
  label: string
  name: string
  kind: 'perp' | 'spot'
}

export interface Config {
  venue: string
  exchange: string
  symbol: string
  label: string
  tick: number
  inverse: boolean
  contract_usd: number
  bucket: number
  column_ms: number
  half_range: number
  history_min: number
  big_trade_btc: number
  tape_min_btc: number
  primary_x: number
  xvenues: XVenueInfo[]
}

/** a user-drawn fixed-range volume profile */
export interface RangeProfile {
  id: number
  t0: number
  t1: number
}
