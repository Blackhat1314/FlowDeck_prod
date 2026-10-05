# Flowdeck roadmap

Combined feature list from two reviews: features crypto order-flow tools charge for (Bookmap, Velo,
Coinglass, Hyblock, Laevitas, Exocharts) and Sierra Chart's paid tiers (Advanced Features, Market by Order).
Ordered by dependency. Phases 1–2 carry most of the expected edge.

## Status (3 Oct 2026)
- **Phase 2: done.** Items 4–12 plus the exchange connectors from item 3 (Bybit linear + inverse, OKX,
  Binance spot and COIN-M, Coinbase). Live-tested against each exchange's own REST data (see ACCURACY.md).
- **Phase 3: done.** Items 13–18.
- Phase 1 (recorder, replay), Phase 4 and Phase 5: not started.

## Already in Flowdeck before Phase 2
Liquidity heatmap with trade bubbles and big-trade sweeps · footprint (bid × ask, diagonal imbalances,
bar POC, delta, CVD) · volume profile (session / 4h / 1h / visible) · delta + CVD pane · absorption signals
scored after 60 s · Binance liquidations (throttled to 1/s by Binance) · net GEX with flip, call/put walls
and max pain · live accuracy monitor.

## Phase 1: Data foundation
1. **Recorder**: write every raw exchange message to compressed daily files (≈0.5 GB/day). Heatmap, footprint
   and tape survive restarts and keep days of history.
2. **Replay**: pick a date and time and play the whole dashboard at 1–20× speed, with pause and step.
3. **Exchange connectors** ✅ (built with Phase 2): Bybit BTCUSDT and inverse BTCUSD perps, OKX BTC-USDT-SWAP,
   Binance spot BTCUSDT and COIN-M BTCUSD, Coinbase BTC-USD spot. Deribit was already connected.

## Phase 2: Order flow and liquidity ✅
4. **Aggregated perp tape and CVD** across exchanges, with per-exchange toggles.
5. **Spot vs perp CVD** with divergence flags, plus the **Coinbase premium** (Coinbase BTC-USD vs Binance BTCUSDT).
6. **CVD by trade size**: under 1 BTC, 1–10 BTC and 10 BTC or more.
7. **Complete liquidations**: Bybit All Liquidation and OKX added to Binance. Bubbles on the heatmap and
   footprint, plus a liquidation-cascade detector.
8. **Liquidation-level heatmap (estimate)**: likely liquidation prices of positions opened at each price,
   from OI change × leverage tiers. Labelled as a model.
9. **Open-interest change** per bar and per price move, labelled new longs, new shorts, long liquidation
   or short covering.
10. **Pulling/stacking DOM**: recent bid/ask volume plus liquidity added and cancelled per price over the
    last 5 / 30 / 60 s. Closest free substitute for Sierra's Market by Order.
11. **Wall tracker**: resting orders ≥ X BTC with their age, pulled-wall events (cancelled as price
    approached, never traded), and iceberg detection (executed more than displayed, refill count). Marked on the heatmap.
12. **Combined order-book heatmap** (Binance + Bybit + OKX depth), as a toggle.

## Phase 3: Sierra-grade charting ✅
13. **Footprint views**: bid × ask, delta per price, volume, trade count, dominant-side %. Size filters, and a
    cluster search that highlights prints ≥ X.
14. **Bar stats row**: trades, buy/sell ratio, highest and lowest delta within the bar, delta change,
    stacked-imbalance count, OI change.
15. **Footprint zones**: stacked imbalances (3 or more) extended until price retests them, unfinished
    auctions, and bar POCs extended until revisited.
16. **TPO / Market Profile**: 30-minute letters, initial balance, value area, single prints, poor highs and lows,
    excess, split/merge, composite. Session presets: UTC day, Asia/London/NY, funding windows (00/08/16 UTC).
17. **Volume profile tool**: drag over any range; multi-day composite; previous-session POC/VAH/VAL and
    untouched POCs as levels; developing POC; delta-profile and liquidation-profile modes; spot vs perp profile.
18. **VWAP**: session VWAP with 1/2/3σ bands, plus anchored VWAP (click to anchor, or anchor to the daily/weekly
    open, funding times or the last big liquidation).

## Phase 4: Derivatives context
19. **Positioning panel**: funding on Binance, Bybit and OKX, OI-weighted funding, predicted next funding,
    perp premium, quarterly basis curve, OI summed across exchanges, Binance top-trader and taker long/short ratios.
20. **Options flow tape (Deribit)**: large and block trades with buyer/seller side, IV and premium; net
    call vs put premium flow; heat by strike.
21. **Dealer-exposure upgrade**: vanna and charm exposure, next-expiry gamma, GEX by expiry, intraday moves of
    the flip and walls. Also DVOL, ATM implied-volatility term structure and 25-delta skew.

## Phase 5: Signals and workflow
22. **Alerts**: any condition (price at a level, absorption, sweep ≥ N, pulled wall, liquidation cascade,
    spot/perp divergence, funding flip, gamma-flip cross) sent as sound, desktop notification or Telegram.
23. **Signal scoreboard and backtest**: every signal logged with its result at 30 s / 1 m / 5 m, including
    best and worst move along the way, split by session and gamma regime. Any signal can be backtested over
    recorded days.
24. **Spot order-by-order context (optional)**: Bitstamp's public order feed and Coinbase Level 3 (free API
    key) for iceberg and queue analysis on spot BTC/USD.

## Not possible with free data
True Market by Order on the perp (Binance publishes no order IDs). Changes shorter than 100 ms in the book
stream. Real dealer positioning (GEX stays a model).
