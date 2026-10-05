"""Net gamma exposure (GEX) from the Deribit BTC options chain (free public API).

Per option:  gamma = BS gamma(F, K, T, sigma=mark_iv)   (r = 0, F = Deribit underlying/forward price)
             GEX$  = gamma * OI(BTC) * F^2 * 1%          -> USD change in dealer delta per 1% move
Sign convention (SqueezeMetrics / SpotGamma style): dealers long calls (+), short puts (-).
Key levels: call wall, put wall, gamma flip (zero crossing of total GEX vs spot), max pain,
largest +/- net strikes. Groups: all expiries, front expiry, <= 7 days, <= 35 days.
"""
from __future__ import annotations

import math
import re
import time
from datetime import datetime, timezone

_MON = {m: i + 1 for i, m in enumerate("JAN FEB MAR APR MAY JUN JUL AUG SEP OCT NOV DEC".split())}
_RX = re.compile(r"^BTC-(\d{1,2})([A-Z]{3})(\d{2})-(\d+(?:d\d+)?)-([CP])$")
_INV_SQRT_2PI = 1.0 / math.sqrt(2.0 * math.pi)
YEAR_MS = 365.0 * 24 * 3600 * 1000
GROUPS = ("all", "front", "week", "month")


def parse_instrument(name: str):
    m = _RX.match(name)
    if not m:
        return None
    d, mon, yy, k, cp = m.groups()
    exp = datetime(2000 + int(yy), _MON[mon], int(d), 8, 0, tzinfo=timezone.utc)
    return int(exp.timestamp() * 1000), float(k.replace("d", ".")), cp


def bs_gamma(F: float, K: float, T: float, sig: float) -> float:
    if T <= 0 or sig <= 0 or F <= 0 or K <= 0:
        return 0.0
    st = sig * math.sqrt(T)
    d1 = (math.log(F / K) + 0.5 * sig * sig * T) / st
    return math.exp(-0.5 * d1 * d1) * _INV_SQRT_2PI / (F * st)


def bs_delta(F, K, T, sig, cp):
    if T <= 0 or sig <= 0:
        return 0.0
    st = sig * math.sqrt(T)
    d1 = (math.log(F / K) + 0.5 * sig * sig * T) / st
    nd1 = 0.5 * (1 + math.erf(d1 / math.sqrt(2)))
    return nd1 if cp == "C" else nd1 - 1


def compute_gex(rows, now_ms: float | None = None, spot: float | None = None, span: float = 0.2,
                step: float = 0.0025):
    now_ms = now_ms or time.time() * 1000
    opts = []
    idx_px = []
    for r in rows:
        meta = parse_instrument(r.get("instrument_name", ""))
        if not meta:
            continue
        exp, K, cp = meta
        T = (exp - now_ms) / YEAR_MS
        oi = float(r.get("open_interest") or 0)
        iv = r.get("mark_iv")
        F = r.get("underlying_price")
        if r.get("estimated_delivery_price"):
            idx_px.append(float(r["estimated_delivery_price"]))
        if T <= 0 or oi <= 0 or not iv or not F:
            continue
        opts.append((exp, K, cp, T, float(iv) / 100.0, float(F), oi))
    if spot is None:
        spot = sorted(idx_px)[len(idx_px) // 2] if idx_px else None
    if not opts or not spot:
        return None

    expiries = sorted({o[0] for o in opts})
    front = expiries[0]
    wk, mo = now_ms + 7 * 86_400_000, now_ms + 35 * 86_400_000

    def groups_of(exp):
        g = ["all"]
        if exp == front:
            g.append("front")
        if exp <= wk:
            g.append("week")
        if exp <= mo:
            g.append("month")
        return g

    per = {g: {} for g in GROUPS}       # strike -> [callGex, putGex, callOI, putOI]
    tot = {g: [0.0, 0.0] for g in GROUPS}
    opt_groups = []
    for exp, K, cp, T, sig, F, oi in opts:
        gs = groups_of(exp)
        opt_groups.append(gs)
        g = bs_gamma(F, K, T, sig)
        gex = g * oi * F * F * 0.01
        for gname in gs:
            e = per[gname].get(K)
            if e is None:
                e = per[gname][K] = [0.0, 0.0, 0.0, 0.0]
            if cp == "C":
                e[0] += gex
                e[2] += oi
                tot[gname][0] += gex
            else:
                e[1] -= gex
                e[3] += oi
                tot[gname][1] -= gex

    # gamma profile vs hypothetical spot (sticky strike, forwards scale with spot)
    n = int(round(2 * span / step)) + 1
    grid = [spot * (1 - span + i * step) for i in range(n)]
    curve = {g: [0.0] * n for g in GROUPS}
    for (exp, K, cp, T, sig, F, oi), gs in zip(opts, opt_groups):
        ratio = F / spot
        sign = 1.0 if cp == "C" else -1.0
        st = sig * math.sqrt(T)
        half = 0.5 * sig * sig * T
        for i, S in enumerate(grid):
            Fp = S * ratio
            d1 = (math.log(Fp / K) + half) / st
            if d1 > 8 or d1 < -8:
                continue
            gm = math.exp(-0.5 * d1 * d1) * _INV_SQRT_2PI / (Fp * st)
            val = sign * gm * oi * Fp * Fp * 0.01
            for gname in gs:
                curve[gname][i] += val

    out_groups = {}
    for gname in GROUPS:
        strikes = per[gname]
        if not strikes:
            out_groups[gname] = None
            continue
        rows_out = []
        for K in sorted(strikes):
            c, p, coi, poi = strikes[K]
            rows_out.append([K, round(c), round(p), round(c + p), round(coi, 1), round(poi, 1)])
        near = [r for r in rows_out if abs(r[0] / spot - 1) <= 0.35]
        cw = max(near, key=lambda r: r[1]) if near else None
        pw = min(near, key=lambda r: r[2]) if near else None
        ab = max(near, key=lambda r: abs(r[3])) if near else None
        cv = curve[gname]
        flips = []
        for i in range(1, n):
            a, b = cv[i - 1], cv[i]
            if (a < 0 <= b) or (a > 0 >= b):
                x = grid[i - 1] + (grid[i] - grid[i - 1]) * (0 - a) / (b - a) if b != a else grid[i]
                flips.append(x)
        flip = min(flips, key=lambda x: abs(x - spot)) if flips else None
        pos = sorted([r for r in near if r[3] > 0], key=lambda r: -r[3])[:3]
        neg = sorted([r for r in near if r[3] < 0], key=lambda r: r[3])[:3]
        out_groups[gname] = {
            "net": round(tot[gname][0] + tot[gname][1]),
            "call": round(tot[gname][0]),
            "put": round(tot[gname][1]),
            "strikes": near,
            "call_wall": cw[0] if cw else None,
            "put_wall": pw[0] if pw else None,
            "abs_strike": ab[0] if ab else None,
            "flip": round(flip, 1) if flip else None,
            "pos": [r[0] for r in pos],
            "neg": [r[0] for r in neg],
            "curve": [[round(grid[i], 1), round(cv[i])] for i in range(0, n, 2)],
        }

    # max pain for the front expiry
    fo = [o for o in opts if o[0] == front]
    ks = sorted({o[1] for o in fo})
    mp = None
    if ks:
        best = None
        for P in ks:
            pay = 0.0
            for exp, K, cp, T, sig, F, oi in fo:
                pay += oi * (max(0.0, P - K) if cp == "C" else max(0.0, K - P))
            if best is None or pay < best:
                best, mp = pay, P
    call_oi = sum(o[6] for o in opts if o[2] == "C")
    put_oi = sum(o[6] for o in opts if o[2] == "P")
    return {
        "ts": int(now_ms),
        "spot": round(spot, 2),
        "n_options": len(opts),
        "expiries": [{"t": e, "label": datetime.fromtimestamp(e / 1000, tz=timezone.utc).strftime("%d %b %y")}
                     for e in expiries],
        "front": front,
        "max_pain": mp,
        "call_oi": round(call_oi, 1),
        "put_oi": round(put_oi, 1),
        "pcr": round(put_oi / call_oi, 3) if call_oi else None,
        "groups": out_groups,
    }
