# Live accuracy test

**When:** 2 Oct 2026, 18:38–19:11 UTC (3 Oct, 00:08–00:41 IST), live BTCUSDT and BTCUSD perpetual markets.
**What was tested:** the shipped engine (`backend/app/engine`), run unmodified on the live exchange feeds
and graded against the exchange's own reference data.

## Bottom line

| Check | Compared against | Result |
|---|---|---|
| Footprint: buy and sell volume at every price | Binance's public trade tape (REST aggTrades) for the same minute | **24 / 24 minutes identical** at every price level, 56,860 trades |
| Missing trades | aggTrade ID sequence | **0 missing** |
| 1m volume, delta, OHLC, trade-ID range (final run) | Binance 1-minute candles | **14 / 14 minutes exact** on every field |
| Same, BTCUSD COIN-M perpetual | Binance COIN-M 1-minute candles | **14 / 14 minutes exact** (contracts) |
| Order book | 51 independent 1,000-level snapshots | **0 wrong sizes, 0 stale levels** in every check |
| Gamma model inputs | Deribit's published greeks, 60 options with the most open interest | Delta within **0.00003**; gamma equal to Deribit's figure at the 5 decimals Deribit publishes, **60 / 60** |
| Feed latency, BTCUSDT | Exchange event time, corrected for your PC's clock | **p50 64 ms, p95 242 ms** |

## How it was run

My cloud workspace cannot reach crypto exchanges, and the local shell on your PC was unavailable. So the test
ran inside the Claude app's browser on your PC, on your internet connection:

1. The engine's Python files were loaded into Pyodide (Python compiled to WebAssembly) in a browser tab.
   Each file's SHA-256 was checked against the shipped file before the run, and all matched.
2. The tab subscribed to the same Binance streams the server uses (`/public` depth@100ms, `/market` aggTrade,
   markPrice, forceOrder, kline_1m, ticker, plus the COIN-M streams) and fed every message to the engine.
   Order-book snapshots came from Binance's WebSocket API, and Deribit data from its public REST API.
3. A second tab on `fapi.binance.com` downloaded Binance's REST trade tape for each finished minute. Both sides
   reduced the minute to a fingerprint: a SHA-256 over every $1 price level with its exact buy and sell size.
   Identical fingerprints mean the footprint matches the exchange tape at every price.

The scripts are in `tools/live_accuracy/` if you want to repeat the test.
There were three runs. All three used identical order-book, trade-flow, heatmap and gamma code.
Between runs only the latency clock correction, the accuracy counters and the absorption thresholds changed.

## Trades, footprint, delta

- **Trade tape:** 24 minutes were fingerprinted (3 + 7 + 14 across the runs). All 24 matched exactly,
  covering 56,860 aggregated trades and up to 309 price levels per minute (18:40, a liquidation-heavy
  minute with 1,878 BTC traded). The trade-ID sequence had no gaps.
- **Candles:** in 5 of the 24 minutes, Binance's own 1-minute candle disagreed with Binance's own trade tape.
  The engine matched the tape in every one of them:

  | Minute (UTC) | Engine = trade tape | Binance candle | What differs in the candle |
  |---|---|---|---|
  | 18:39 | 1,891.475 BTC | 1,891.472 | 0.003 BTC fewer sells |
  | 18:40 | 1,878.474 | 1,878.477 | 0.003 BTC more, OHLC differs |
  | 18:44 | 323.136 | 323.590 | 0.454 BTC of sells (3 trades) not on the public tape |
  | 18:48 | 458.501 | 458.484 | 0.017 BTC of buys placed in the next minute |
  | 18:49 | 174.121 | 174.138 | the same 0.017 BTC |

  Binance's candle leaves out or adds a handful of trades, or files a boundary trade in a different minute,
  usually around liquidation bursts. These are exchange-side differences. The server now handles them
  automatically: when a candle disagrees, it downloads that minute's trades and grades the engine against
  those. The badge in the top bar therefore reads "Trades x/y min exact".
- In the final, calmer run, all 14 BTCUSDT and all 14 BTCUSD (COIN-M) minutes matched the candles on every
  field: volume, taker-buy volume (so delta), open/high/low/close and first/last trade ID.

## Order book (heatmap source)

| Run | Snapshot checks | Levels compared | Wrong size | Stale | Never-seen levels |
|---|---|---|---|---|---|
| 1 | 6 | 6,469 | 0 | 0 | 27 (first check only) |
| 2 | 15 | 12,422 in the first 8 checks | 0 | 0 | 22 (first two checks) |
| 3 | 30 | 57,180 | 0 | 0 | 126 |

- Every 30 seconds an independent 1,000-level snapshot is compared, level by level, with the engine's book.
  Levels that changed after the snapshot was taken are left out of that comparison, so it measures exact equality.
- "Never-seen levels" are prices outside the first snapshot's 1,000-level window that had not changed since,
  so the stream never reported them. This is a limit of Binance's free data. Coverage stayed at 97.7% or better,
  and each check fills those levels in from the snapshot.
- The book stayed in sequence for the whole test: 0 resyncs and 0 crossed books (bid ≥ ask) across 8,973 depth updates in the final run.

## Gamma (Deribit)

- 830 BTC options with open interest were used, refreshed every 60 s (16 refreshes in the final run).
- **Greeks:** for the 60 options with the most open interest, our Black-Scholes delta matched Deribit's to within
  0.00003. Gamma matched Deribit's published figure in all 60 cases, at the 5 decimals Deribit shows.
  Strike, expiry, forward price, time to expiry and implied vol are therefore read and used exactly as Deribit does.
- Snapshot at 19:10 UTC: Deribit index 84,101; net GEX **+$182M per 1% move** (positive gamma); call wall
  **90,000**; put wall **84,000**; gamma flip **≈ 75,250**; max pain for the 3 Oct expiry **85,000**; put/call OI 0.56.
- What cannot be verified: GEX assumes dealers are long calls and short puts, the industry convention.
  No free source reports actual dealer positioning, so the levels are a model, not a measurement.

## Absorption signals

Absorption is a heuristic: heavy market orders at one price, more traded than was ever visible there, and the
level holds. Each signal is scored by the price move 60 s later.

- The first thresholds were too strict for real BTCUSDT volume and produced no signals in about 12 minutes. A
  calibration run then tried 8 settings side by side on the same feed. The table shows the four thresholds
  at the 1× visible-liquidity ratio:

  | Threshold (× 10-s market volume) | Signals in 8 min | Held after 60 s |
  |---|---|---|
  | 0.08 | 17 | 33% |
  | 0.15 | 15 | 31% |
  | **0.25 (new default)** | 6 | 50% |
  | 0.40 | 1 | 1 / 1 |

- The shipped detector also compares traded volume with the *most* liquidity seen at the level (not just
  the first reading), and waits for the 10-second volume baseline to fill before it fires.
- Final run with the new default: 8 signals in 15 minutes, 4 held (50%), with an average move of −$6.
  On this small sample that is a coin flip. Use absorption as context for reading the tape, not as a
  stand-alone trade signal. The Signals tab keeps the running hit rate so you can judge it over longer periods.

## Other observations

- **Your PC's clock was 0.36–0.37 s behind exchange time** and drifted about 20 ms during the test. The app
  measures this offset and corrects for it, but you may want to re-sync Windows time (Settings → Time & language →
  Sync now).
- Processing cost inside the browser (WebAssembly) averaged 0.23 ms per exchange message. The real server runs
  native Python, which is several times faster, so CPU is not a constraint.
- Throughput in the final run was 28,182 messages in 15 minutes: 8,973 book updates, 15,460 trades and 2,375 candle updates.

---

# Phase 2 live test: every venue

**When:** 2–3 Oct 2026, 23:45–00:00 UTC (05:15–05:30 IST), live markets, on your internet connection.
**What was tested:** the shipped engine with all of its feeds: Binance USDⓈ-M (book + tape), Binance COIN-M,
Binance spot, Bybit linear and inverse, OKX and Coinbase. Each venue was graded against that exchange's own REST
data. Harness: `tools/live_accuracy/harness2.py` + `harness2.js` (bundle with `make_bundle.py --phase2`).
The engine files were loaded with comments and docstrings stripped so the bundle fit the browser paste; the
stripped copy was first run side by side with the original on simulated feeds and gave identical output.

| Check | Compared against | Result |
|---|---|---|
| Per-minute BTC volume, Bybit BTCUSDT | Bybit 1m klines (REST) | **8 / 8 minutes exact** |
| Per-minute BTC volume, Bybit BTCUSD inverse (USD contracts → BTC) | Bybit klines `turnover` | **8 / 8 within 1×10⁻⁷ BTC** (Bybit rounds turnover to 8 decimals per trade) |
| Per-minute BTC volume, OKX BTC-USDT-SWAP (0.01 BTC contracts) | OKX 1m candles `volCcy` | **8 / 8 exact** |
| Per-minute BTC volume, Coinbase BTC-USD | Coinbase 1m candles | **8 / 8 exact** |
| Per-minute volume and taker-buy volume, Binance spot | Binance spot kline stream | **10 / 10 exact** (both) |
| Per-minute BTC volume and taker-buy, Binance COIN-M ($100 contracts → BTC) | COIN-M kline base volume | **10 / 10 exact** (both) |
| Every trade: id, price, size, aggressor side, Bybit linear | Bybit REST recent trades | **8,635 / 8,635** |
| Same, Bybit inverse | Bybit REST recent trades | **763 / 763** |
| Same, Coinbase (maker side inverted to aggressor) | Coinbase REST trades | **9,512 / 9,512** |
| Same, OKX | OKX REST trades | price and side 3,273 / 3,273; sizes differ by design (see below); volume exact via candles |
| Bybit order book (1000-level stream) | 23 REST snapshots, top 200 levels per side | **9,200 / 9,200 levels exact** |
| OKX order book (400-level stream) | 23 REST snapshots, top 200 levels per side | **98.3 %** exact (9,041 / 9,200); differences are levels that changed between the two reads |
| Binance order book | 24 snapshot checks | **0 wrong sizes**, 0 stale; 51 far levels filled in from snapshots |
| Open interest: Bybit linear, Bybit inverse, OKX | Each exchange's REST open interest | **Exact** in every sample (Bybit: single-counted figure, see below) |
| Funding: Bybit, OKX | REST funding rate | Exact (Bybit inverse can lag by up to 0.000001 %, its stream rarely re-sends funding) |
| Coinbase premium | Coinbase REST ticker − Binance spot WS-API price × USDT/USD | **within $0.01** in 4 of 5 samples (one sample $1.70 apart: prices moved between the two reads) |
| OKX liquidations | OKX REST liquidation history | **2 / 2** (time, price, size, side) |
| Pull/stack reconciliation | Binance trade tape over 11 minutes | fills matched from the book + hidden volume = **99.998 %** of traded volume (295.18 BTC) |
| Book sequence gaps | Bybit `u`, OKX `seqId/prevSeqId` | 0 gaps, 0 resubscribes in the run (forced gap in the mock test: detected, resubscribed, recovered) |
| Engine cost | WebAssembly in the browser | 0.21 ms per message across ≈ 42,000 messages; native Python on the server is faster |

## Findings that changed the code or the grading

- **Bybit open interest is now single-counted.** Bybit switched to single-counted OI on 11 June 2026. Its
  tickers still carry the old two-sided `openInterest` (exactly 2×) next to `singleOpenInterest`. Flowdeck uses
  `singleOpenInterest`, which is the same convention as Binance and OKX, so the "OI all venues" total adds up.
  The grader initially compared against the two-sided field and showed a 50 % gap; the engine was right.
- **OKX's `trades` channel merges fills.** Fills of one taker order at one price arrive as one record (its id is
  the last fill's id). Volume is unaffected (8 / 8 candles exact), but a trade-by-trade comparison against REST,
  which lists every fill, shows size mismatches on merged records. The harness now groups both sides by
  time, price and side before comparing.
- **Binance liquidations are a sample.** Binance pushes at most one liquidation per second per symbol; Bybit's
  `allLiquidation` and OKX's feed are complete. Only 2 liquidations occurred during the quiet test window.

## Phase 3 checks

The Phase 3 tools are computed in the browser from the bars above. They were checked against brute-force
reference calculations on two days of synthetic 1-minute bars: VWAP and its standard deviation (identical to
6 decimals), value area (POC is the maximum row, VAH–VAL holds ≥ 70 % of volume: 70.8 %), footprint
aggregation (total volume preserved exactly at any timeframe and row size), prior-session POCs, naked-POC
detection and developing POC (ends on the session POC). Because they are built from the tick-exact footprint,
their accuracy is that of the footprint (exact at $1) plus the $0.50 price-bucket rounding inside each level.
