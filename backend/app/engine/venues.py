"""Venue + engine settings. Pure Python (also runs inside Pyodide for the live accuracy test)."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict


@dataclass(frozen=True)
class Venue:
    key: str
    exchange: str
    symbol: str          # REST symbol
    stream: str          # lower-case stream symbol
    label: str           # human label
    tick: float          # price tick
    qty_decimals: int    # quantity precision of the native unit
    inverse: bool        # True -> quantities are contracts of 'contract_usd'
    contract_usd: float
    ws_book: str         # order-book stream URL
    ws_market: str       # trades / mark / liquidations / kline / ticker URL
    rest: str
    p_depth: str
    p_klines: str
    p_agg: str
    p_oi: str
    p_ticker: str

    @property
    def qty_scale(self) -> int:
        return 10 ** self.qty_decimals

    @property
    def native_unit(self) -> str:
        return "cont" if self.inverse else "BTC"


def _usdm() -> Venue:
    s = "btcusdt"
    return Venue(
        key="usdm",
        exchange="Binance USDⓈ-M",
        symbol="BTCUSDT",
        stream=s,
        label="BTCUSDT perpetual",
        tick=0.1,
        qty_decimals=3,
        inverse=False,
        contract_usd=1.0,
        # 2026 Binance split: order book on /public, everything else on /market
        ws_book=f"wss://fstream.binance.com/public/stream?streams={s}@depth@100ms",
        ws_market=(
            "wss://fstream.binance.com/market/stream?streams="
            f"{s}@aggTrade/{s}@markPrice@1s/{s}@forceOrder/{s}@kline_1m/{s}@ticker"
        ),
        rest="https://fapi.binance.com",
        p_depth="/fapi/v1/depth",
        p_klines="/fapi/v1/klines",
        p_agg="/fapi/v1/aggTrades",
        p_oi="/fapi/v1/openInterest",
        p_ticker="/fapi/v1/ticker/24hr",
    )


def _coinm() -> Venue:
    s = "btcusd_perp"
    return Venue(
        key="coinm",
        exchange="Binance COIN-M",
        symbol="BTCUSD_PERP",
        stream=s,
        label="BTCUSD perpetual",
        tick=0.1,
        qty_decimals=0,
        inverse=True,
        contract_usd=100.0,
        ws_book=f"wss://dstream.binance.com/stream?streams={s}@depth@100ms",
        ws_market=(
            "wss://dstream.binance.com/stream?streams="
            f"{s}@aggTrade/{s}@markPrice@1s/{s}@forceOrder/{s}@kline_1m/{s}@ticker"
        ),
        rest="https://dapi.binance.com",
        p_depth="/dapi/v1/depth",
        p_klines="/dapi/v1/klines",
        p_agg="/dapi/v1/aggTrades",
        p_oi="/dapi/v1/openInterest",
        p_ticker="/dapi/v1/ticker/24hr",
    )


VENUES = {"usdm": _usdm(), "coinm": _coinm()}


@dataclass
class Settings:
    bucket_usd: float = 1.0          # heatmap / footprint base price bucket
    half_range: int = 800            # buckets each side of mid sent per heatmap column
    column_ms: int = 250             # heatmap time resolution
    history_min: int = 30            # heatmap history kept server-side
    bars_keep: int = 10080           # 1m bars kept (7 days; per-price detail for the last 24 h)
    tape_min_btc: float = 0.5        # sweeps at/above this go to the tape
    big_trade_btc: float = 5.0       # default "big trade" highlight
    prune_pct: float = 0.08          # drop book levels further than this from mid
    # absorption
    abs_window_ms: int = 8000
    abs_confirm_ms: int = 1500
    abs_min_btc: float = 5.0
    abs_rel: float = 0.25            # x EMA of 10s market volume (calibrated on live BTCUSDT)
    abs_ratio: float = 1.0           # traded / visible-at-start
    abs_tol_buckets: int = 1
    abs_horizon_ms: int = 60000      # outcome evaluation horizon
    extra: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)
