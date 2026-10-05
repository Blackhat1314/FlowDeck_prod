# Flowdeck: BTC perpetual order flow

An order-flow dashboard for the Bitcoin perpetual, built on free public exchange APIs, with a landing page, sign-up with a free trial, and an admin panel. FastAPI is the engine and React draws the screen. Run it on your own machine or put it online.

| What you see | Built from |
|---|---|
| Liquidity heatmap (Bookmap-style) with trade bubbles, best bid/ask, big-order walls | Binance diff-depth stream (100 ms) + aggTrade stream |
| **Combined order-book heatmap** (toggle "All books") | Binance + Bybit + OKX depth, shifted by each venue's basis onto the Binance price |
| **Aggregated perp tape** and sweeps with per-venue toggles | Binance USDⓈ-M + COIN-M, Bybit linear + inverse, OKX; Binance spot and Coinbase for spot |
| Footprint: bid × ask, delta, volume, trade count, dominant-side %; Binance / all perps / spot source; size filter and cluster search | Every trade, bucketed at $1 and regrouped at any row size |
| **Bar statistics row**: volume, delta, delta change, max/min delta, trades, buy %, stacked imbalances, OI change (labelled), liquidations, CVD | Same trades + open interest from all venues |
| **Footprint zones**: stacked imbalances, unfinished auctions and bar POCs, extended until price returns | Footprint rows |
| Lower pane: delta + CVD, **perps CVD by venue**, **spot vs perps CVD** with leadership flags, **CVD by order size** (<1, 1–10, ≥10 BTC), **OI change + liquidations**, **Coinbase premium** | All venues' trades, OI and Coinbase vs Binance spot |
| **Liquidations from Binance, Bybit and OKX** with a cascade detector | Binance forceOrder, Bybit allLiquidation, OKX liquidation-orders |
| **Liquidation-level map** (labelled as a model) | Open-interest increases at each price × a 5×–100× leverage mix |
| **Pull/stack DOM** (5 / 30 / 60 s), wall tracker, pulled walls, filled walls and icebergs | Every order-book size change reconciled with the trade tape |
| Volume profile: session, prior day, 4h, 1h, visible, 3- and 7-day composites; volume / delta / liquidation / spot-vs-perp modes; **drag-a-range profiles** | Tick data; older history uses 1-minute candles spread over each candle's range |
| **Prior-session POC/VAH/VAL, naked POCs, developing POC** | Same profiles per UTC day |
| **VWAP** (daily / weekly) with ±1/2/3σ bands and **anchored VWAPs** (click, weekly/daily open, last funding, last big liquidation) | Tick data |
| **TPO / Market Profile**: 30-min letters, IB, VA/POC, single prints, poor highs/lows, excess, split letters, composite; UTC / Asia / London / NY / funding-window sessions | 1-minute highs and lows |
| Absorption signals, each scored 60 s later | Heavy hits at one price that exceed the visible liquidity while the level holds |
| Net gamma exposure, gamma flip, call/put walls, max pain | Deribit BTC options chain (about 1,000 options, refreshed every 60 s) |
| Accuracy panel | Live comparison with Binance's own 1-minute candles, its trade tape and order-book snapshots; status of every other venue |

Default instrument: **BTCUSDT perpetual (Binance USDⓈ-M)**, the deepest BTC perpetual book.
The instrument menu switches to **BTCUSD perpetual (Binance COIN-M)**, which is quoted in $100 contracts;
the app converts its quantities to BTC.

## Run it (Windows)

1. Install Python 3.9 or newer from python.org (tick **Add python.exe to PATH**).
2. Double-click **`start.bat`**.

The first run creates a private Python environment and installs four small packages. After that,
the sign-in page opens at http://127.0.0.1:8000/login. Leave the black window open while you use it.
The first start prints your admin login (see *Website, accounts and admin* below).

- `start-demo.bat` runs the same dashboard on a built-in synthetic market, which is useful offline.
- **`start-lan.bat`** also lets your phone, tablet or other PCs on the same Wi-Fi open it. The black window prints the
  address to type on them, for example `http://192.168.1.23:8000`. The first time, Windows asks whether Python may
  use the network: tick **Private networks** and click **Allow**. If another device still can't connect, run
  `allow-lan-firewall.bat` once (right-click > Run as administrator) and make sure your Wi-Fi is set to
  *Private network* in Windows Settings > Network & internet. macOS / Linux: `./start.sh --lan`.
- macOS / Linux: `./start.sh` (or `./start.sh --demo`).
- Manual: `cd backend`, `pip install -r requirements.txt`, then `python run.py --open`
  (`--venue coinm` for the coin-margined contract, `--port 8001` to change the port).

You do **not** need Node.js. The React app ships prebuilt in `backend/static`.
To change the UI: `cd frontend`, `npm install`, `npm run dev` (hot reload on :5173 while the backend runs),
then `npm run build` to update `backend/static`.

## Website, accounts and admin

Flowdeck is a small website with these pages:

| Page | Who sees it |
|---|---|
| `/` | Landing page: a full-screen hero over a looping video of liquidity walls (4K on large high-density screens), the dashboard, the 60-second film, a live demo of each tool, the accuracy results, price and FAQ |
| `/login`, `/signup` | Everyone. A new sign-up gets a free trial (3 days by default) |
| `/app` | The dashboard, for signed-in users. When the trial or plan ends, it shows a frozen snapshot instead of live data |
| `/admin` | Admins only |
| `/privacy`, `/terms` | Everyone. The privacy policy and terms, linked from Google's sign-in screen and the site footer. Contact details come from Settings |
| `/guide` | Everyone. The Flowdeck Field Manual: every panel explained in depth, in English with a Hinglish switch. Linked from the account menu |

**Your first admin login.** On the first start the server creates an admin and prints the login in the console.
It also saves it to `backend/data/FIRST_ADMIN_LOGIN.txt`. Sign in, change the password from the account menu
(top right of the dashboard, or Settings in the admin panel), then delete that file.
To pick the admin yourself, set `FLOWDECK_ADMIN_EMAIL` and `FLOWDECK_ADMIN_PASSWORD` before the first start.
The server only ever *creates* that account. It never promotes an existing account that happens to use the email.

**What the admin panel does**
- Overview: who's online, how many accounts are on trial, paid, expired or blocked, sign-ups per day, and whose access ends in the next 48 hours.
- Users: search and filter; add a user (trial, 30 days, until a date, or no end date); extend access (+3/+7/+30/+90 days or a date);
  set a new password; sign someone out; block or unblock; make or remove admins; delete; export to CSV.
  Click a user for their devices, sign-in history and an admin note (for payment references).
- Online now: every open dashboard (live or frozen) and every signed-in device, with a sign-out button.
- Activity: every sign-in, failed password, sign-up and admin change.
- Data accuracy: the server's own grading against Binance (trades vs candles, order-book snapshots, latency)
  and the status, price, basis, open interest and funding of every exchange feed. The instrument switch is here
  too, because it changes the feed for every user.
- Settings: trial length, the price charged through Razorpay, the support email, payment instructions,
  and whether new sign-ups are open.

**How payment works (Razorpay).** The trial-ended banner and the account menu have a **Pay ₹499 for 30 days** button.
It opens Razorpay's checkout (UPI, card, net banking). The server creates the order for the price set under Settings
(the browser can't change the amount), and when Razorpay reports the payment the server checks its signature
(HMAC-SHA256 of `order_id|payment_id` with the key secret). Only a matching signature marks the order paid and adds
30 days, once per order, on top of any time left. The open dashboard goes live within seconds. Payments show under
Users (each user's Payments) and Activity. You can still extend anyone by hand under Users.
- Keys: `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in `backend/.env` locally (copy `backend/.env.example`) or in
  `/etc/flowdeck/flowdeck.env` on the server. Without them the Pay button is replaced by the support email.
- Test keys (`rzp_test_...`) take no real money; the button says so. Swap in live keys (`rzp_live_...`) to charge.
- Endpoints: `POST /api/create-order` and `POST /api/verify-payment` (signed-in users only, same-origin, rate-limited).

**Account rules**
- One device at a time: signing in signs out every other device, and opening the dashboard in a second tab stops the first.
- Expired accounts get a frozen snapshot. Reloading refreshes it at most 4 times per half hour, so reloading
  can't stand in for a live feed.
- Passwords are stored as scrypt hashes, sessions as SHA-256 hashes of a random token, in an HttpOnly cookie.
  Failed sign-ins are rate-limited per IP and per email, and sign-ups per IP.
- Everything is stored in one SQLite file, `backend/data/flowdeck.db`. Back that file up, and never commit it.

**Sign in with Google.** The sign-in and sign-up pages show a Google button. The server checks every Google token
itself (signature against Google's published keys, this site's client ID, issuer, expiry, verified email).
- A new Google user gets the same free trial as an email sign-up. Paused sign-ups pause Google sign-ups too.
- An existing account with the same email is linked only when Google owns the address (Gmail, or a Google Workspace
  domain). Email sign-ups never proved ownership of the address, so linking switches the old password off and signs
  out other devices; the page tells the user, and they can set a new password. Admin accounts are never linked
  automatically, and other addresses are told to sign in with their password.
- Accounts made with Google have no password until the user chooses **Set a password** in the account menu, within
  15 minutes of signing in. Admins see a Google tag on these users and how each one signs in.
- In Google Cloud the OAuth client needs these authorized JavaScript origins: `https://flowdeck.site`,
  `https://www.flowdeck.site`, `http://localhost` and `http://localhost:8000`.

### Putting it online

On a fresh Ubuntu 22.04/24.04 server (2 vCPU / 4 GB, in a region that can reach Binance futures; US servers can't),
with ports 80 and 443 open and the domain's A record pointing at the server, run in its SSH window:

```bash
curl -fsSL https://raw.githubusercontent.com/Blackhat1314/FlowDeck_prod/main/deploy/setup.sh -o setup.sh
sudo bash setup.sh flowdeck.site
```

`deploy/setup.sh` installs the app from this repository into `/opt/flowdeck`, runs it as the `flowdeck` service
(restarts on crashes and reboots, listens only on 127.0.0.1:8000), and puts Caddy in front. Caddy gets the HTTPS
certificate from Let's Encrypt, renews it, redirects `http://` and `www.` to `https://flowdeck.site`, and passes the
`/ws` websocket through. The database lives in `/var/lib/flowdeck`, the settings in `/etc/flowdeck/flowdeck.env`.
The script prints the first admin login at the end.

To ship new code: push to `main`, then on the server `sudo bash /opt/flowdeck/src/deploy/update.sh`.

| Setting | Use |
|---|---|
| `FLOWDECK_TRUST_PROXY=1` | Behind a proxy on another machine (for example Cloudflare): trust its `X-Forwarded-*` headers |
| `FLOWDECK_PROXY_HOPS=2` | Number of proxies in front of the app when they're chained (Cloudflare + nginx = 2) |
| `FLOWDECK_SECURE_COOKIE=1` | Always mark the session cookie Secure (set this whenever the site is served over HTTPS) |
| `FLOWDECK_DB=/path/flowdeck.db` | Keep the accounts database somewhere else |
| `FLOWDECK_ADMIN_EMAIL`, `FLOWDECK_ADMIN_PASSWORD` | Create this admin on start if no account uses the email |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys for the Pay button. Also read from `backend/.env` |
| `FLOWDECK_GOOGLE_CLIENT_ID=...` | Google OAuth client ID for "Sign in with Google" (Flowdeck's own is built in). Empty value turns the button off |
| `FLOWDECK_ARCHIVE_DAYS=0` | Days of 1-minute heatmap and footprint history to keep on disk. `0` (default) keeps it forever |
| `FLOWDECK_FILL_DAYS=7` | Days of footprint to back-fill from Binance's free daily trade files. `0` turns the back-fill off |

Tests: `pip install -r requirements-dev.txt`, then `python -m pytest -q` in `backend/`.

## Using the screen

- **Views**: Heatmap, Footprint, Both, TPO. **Layers ▾** (right of the toolbar) holds every overlay switch.
- **Heatmap**: scroll to zoom time. Shift + scroll, or drag the price axis, to zoom price.
  Drag to pan, and double-click to snap back to live. Hover for resting size, prints and the liquidation model at any price/time.
  "Binance / All books" switches between the Binance book and the combined Binance + Bybit + OKX book.
  The select next to it picks the lower pane (delta, perps CVD by venue, spot vs perps, CVD by order size, OI + liquidations, Coinbase premium).
  The strip next to the price axis shows liquidity stacked (green) or pulled (red) over the last 5/30/60 s.
- **Footprint**: scroll zooms price and Ctrl + scroll changes bar width. Pick 1m–4h bars, a row size, what each cell shows
  (bid × ask, delta, volume, trades, dominant %) and the source (Binance, all perps, spot).
  In bid × ask, left half = market sells, right half = market buys. A coloured edge marks a diagonal imbalance.
  The amber box is the bar POC; the diamonds at a cell's left edge are liquidations at that price.
  Imbalance ratio, size filter and cluster highlight are under Layers ▾ → Footprint.
- **Range profile / Anchor VWAP**: click the tool, then drag across the chart (range) or click where the VWAP should start.
  "Anchor…" adds anchors at the weekly open, the UTC daily open, the last funding time or the last big liquidation.
  Right-click a range or an anchor to remove it; Esc cancels a tool.
- **TPO**: pick the session preset and how many sessions to show; "Split letters" puts each 30-minute period in its own column.
  Amber rail = initial balance, grey rail = session range, highlighted row = POC, shaded rows = value area, violet = single prints.
- **Side tabs**: Tape (all venues, filter by venue), Flow (who leads: spot or perps, premium, OI, funding, size buckets,
  liquidation model levels), Book (pull/stack ladder, walls, wall events and icebergs), Gamma, Signals (cascades, regime changes,
  absorption, liquidations), Accuracy.
- **Hover help**: rest the pointer on any button, menu, panel or chart for 2 seconds and a short note says what it does.
  Moving the mouse, clicking or scrolling hides it. Turn it off (or back on) under **Hover help** in the account menu.
- **Tour**: the first time someone opens the dashboard, an 11-step tour highlights each part of the screen with
  Back / Next, and **Skip tour** goes straight to the app (Esc and the arrow keys work too). It shows once per account;
  **Take the tour** in the account menu runs it again. **Guide** in the same menu opens the full manual.

### How much history you get

| | Detail | How far back |
|---|---|---|
| Heatmap, live | every 250 ms column | about the last 30 minutes in the browser; older columns are merged into 5-second columns, not dropped |
| Heatmap, recent | 5-second columns | the last 12 hours, kept in memory and on disk, so a restart doesn't lose them |
| Heatmap, archive | 1-minute columns | from the day the server first started, kept on disk forever (or `FLOWDECK_ARCHIVE_DAYS`) |
| Footprint | 1-minute bars with every price row | live bars are saved to disk once final; days the server missed are back-filled from Binance's daily trade files (`FLOWDECK_FILL_DAYS`, 7 by default) |

Zoom out or drag the heatmap back in time and it loads older history by itself: 5-second columns for the last
12 hours, then 1-minute columns. The time axis shows dates once you're past a day. On the footprint, scrolling back
loads saved bars with full price rows in 6-hour blocks. A 1-minute heatmap column is an average of its 5-second
columns (resting liquidity averaged, trades and liquidations summed, best bid/ask and last price from the end of the
minute). History needs a live plan; expired accounts keep the frozen snapshot.

Disk use, measured on the demo feed: about 4–7 MB a day for the 1-minute heatmap and about 3.5 MB a day for the
footprint, so roughly 3–4 GB a year. The 5-second files are deleted after 2 days. Everything lives under
`history/<instrument>/` next to the database (`/var/lib/flowdeck/history` on the server). The Binance back-fill runs
every 6 hours in a separate low-priority process, checks each file's SHA-256, and never overwrites minutes the server
recorded live (those also hold other exchanges' volume and liquidations).

The server keeps recording while the browser tab is closed. On startup it also loads the last 7 days of 1-minute
candles (for profiles, prior-session levels, VWAP and TPO), the most recent 60,000 individual trades (usually
10–40 minutes of tick-exact footprint) and 500 five-minute open-interest steps for the liquidation model.
Per-price detail is kept for 24 hours (6 hours for other venues); older bars keep their candle.

## Accuracy

`ACCURACY.md` has the full live test report. In short:

- **Trades and footprint:** 24 of 24 minutes matched Binance's public trade tape exactly at every price
  level (56,860 trades, 0 missing).
- **Candles:** in the final run, 14 of 14 BTCUSDT and 14 of 14 BTCUSD minutes matched Binance's 1-minute
  candles on every field. In the 5 minutes where the engine differed from a candle, Binance's candle also
  differed from Binance's own trade tape, and the engine matched the tape.
- **Order book:** 51 independent snapshot checks, 0 wrong sizes, 0 stale levels.
- **Gamma:** delta within 0.00003 of Deribit's published greeks, gamma equal at Deribit's precision (60 / 60 options).
- **Latency:** 64 ms median and 242 ms p95 from Binance to the engine (measured from India).
- **Other venues (Phase 2 test):** per-minute volume equal to each exchange's own candles on Bybit (linear and
  inverse), OKX, Coinbase, Binance spot and Binance COIN-M; 18,910 Bybit and Coinbase trades matched one by one
  (price, size, side); Bybit book 9,200 / 9,200 levels exact against REST snapshots, OKX 98.3 %; open interest,
  funding and the Coinbase premium equal to the exchanges' REST values.

The app keeps checking this while it runs (Accuracy tab, plus the badge in the top bar).

## How it works

```
Binance USDⓈ-M WS  depth@100ms, aggTrade, markPrice, forceOrder, kline, ticker ─┐
Binance COIN-M · Binance spot · Bybit linear + inverse · OKX · Coinbase WS      ├─► engine (pure Python) ──► binary heatmap columns (4/s)
Binance REST depth / klines / aggTrades / openInterest(+Hist)                   │   book · micro · flow ·     JSON: bars, sweeps, liquidations,
Deribit REST options summary                                                    ┘   xflow · xbooks · liqmap   flow panel, DOM, walls, gamma …
                                                                                    heatmap · gamma · integrity  └─► React dashboard (canvas)
```

- `backend/app/engine/` is IO-free, so the same code runs in the server, in the demo and in the browser-based live test.
- The Binance order book follows the documented sync procedure (buffer, snapshot, `U ≤ L ≤ u`, `pu` chain)
  with integer ticks and lots. Bybit and OKX books are kept from their own snapshot + delta streams; an OKX
  sequence gap triggers an automatic resubscribe.
- Every book size change on Binance is matched against the trade tape (within 350–700 ms) to split it into
  filled, cancelled, added and hidden (iceberg) volume. Pull/stack, walls and icebergs come from that.
- Other venues' prices are mapped onto the Binance price with a running basis per venue, so their prints,
  liquidations and books line up on one chart.
- Heatmap columns are sent as compact binary. The browser renders them on a canvas and scrolls smoothly between columns.

## Known limits (free data)

- Binance snapshots stop at 1,000 levels per side (about ±$100–150 for BTCUSDT). Deeper levels appear as soon as
  they change, and the 30-second snapshot check fills in the rest of the snapshot range.
- Heatmap (order-book) history cannot be back-filled, because no free source records it. It builds up from the day
  the server first starts, and any time the server is down stays empty. Footprint gaps are back-filled from Binance's
  daily files the next day (Binance trades only; the other exchanges' volume isn't in those files).
- Gamma assumes the usual dealer positioning (dealers long calls, short puts). It uses Deribit only, the largest
  BTC options venue, so other venues' options are not included.
- Absorption is a heuristic signal, not ground truth. That is why each event shows its 60-second result
  and the Signals tab keeps a running hit rate.
- The liquidation map is a model: it assumes positions opened where open interest rose, with a typical
  leverage mix. Exchanges do not publish real liquidation prices.
- Bybit reports single-counted open interest (since 11 June 2026); Flowdeck uses that figure so it adds up
  with Binance and OKX.
- Binance publishes at most one liquidation per second per symbol, so its liquidation feed is a sample; Bybit's
  allLiquidation and OKX's feed are complete.
- Binance blocks some countries (for example the US). If the feeds show `reconnecting`, check that
  binance.com futures are reachable from your network.

## Project layout

```
start.bat / start-demo.bat / start.sh   launchers
start-lan.bat, allow-lan-firewall.bat    open it to other devices on your network
backend/run.py                          server entry point (uvicorn)
backend/app/engine/                     order book, flow, heatmap, absorption, gamma, integrity,
                                        micro (pull/stack, walls, icebergs), xchg (venue adapters),
                                        xflow (cross-venue flow), xbook (Bybit/OKX books), liqmap
backend/app/runtime.py                  exchange connections, REST jobs, broadcast hub
backend/app/main.py                     FastAPI app: pages, /api/auth, /api/admin, /ws stream
backend/app/accounts.py                 users, sessions, trial rules, audit log, settings (SQLite)
backend/app/engine/heattiers.py         merges live heatmap columns into 5-second and 1-minute history
backend/app/archive.py                  history files on disk (heatmap tiers, footprint bars), one file per UTC day
backend/app/histfill.py                 footprint back-fill from data.binance.vision (runs as its own process)
backend/data/                           accounts database + first admin login (created on start; not in git)
backend/app/sim.py, xsim.py             synthetic market and other venues (demo mode + tests)
backend/tests/                          unit tests + mock exchange for offline integration tests
backend/static/                         prebuilt pages (landing, sign-in, dashboard, admin)
frontend/                               React + TypeScript source (Vite): index.html = landing, auth.html,
                                        app.html = dashboard, admin.html; src/landing, src/auth, src/admin
tools/live_accuracy/                    harnesses used for the live accuracy tests (Binance; all venues)
tools/film/, frontend/film/              the 60-second film and the landing page's background loop (see tools/film/README.md)
media/flowdeck-film-1080p.mp4           the film in full HD (the landing page plays it on large or high-density screens, 720p elsewhere)
ACCURACY.md                             live test report
```
