// Hover help: rest the pointer on a control or panel for 2 seconds and a short description appears.
// Elements opt in with data-tip="…" (and optionally data-tip-title). Side-panel section headings get theirs from
// HEADINGS below. Turn it off from the account menu (remembered in this browser).

const DELAY = 2000
const PANEL_SHOW_MS = 7000 // panel descriptions close by themselves
const KEY = 'fd-hints'

export function hintsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}
export function setHintsOn(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* private mode: stays on for this visit */
  }
}

/** Spread onto an element: <button {...tip('view.heatmap')}> */
export function tip(id: keyof typeof TIPS): { 'data-tip': string; 'data-tip-title'?: string } {
  const [title, text] = TIPS[id]
  return title ? { 'data-tip': text, 'data-tip-title': title } : { 'data-tip': text }
}

export const TIPS = {
  // chart views
  'view.heatmap': ['Heatmap', 'Every resting order in the Binance book over time: brighter means bigger. Trades are drawn on top as bubbles.'],
  'view.footprint': ['Footprint', 'Candles split into price rows, showing how much BTC was sold (left) and bought (right) at each price.'],
  'view.split': ['Both', 'Heatmap on top and footprint underneath, each with its own zoom.'],
  'view.tpo': ['TPO', 'Market profile: a letter for every 30 minutes price spent at a level. Shows value area and the shape of the day.'],
  // heatmap toolbar
  'heat.contrast': ['Contrast', 'Brightens or dims the heatmap. Raise it to see thin liquidity, lower it to pick out only the biggest walls.'],
  'heat.bubbleSize': ['Bubble size', 'Scales the trade bubbles. Bigger bubbles make large prints stand out when zoomed out.'],
  'heat.bookPrimary': ['Binance book', 'Show only the Binance perpetual order book (the one the dashboard trades from).'],
  'heat.bookAll': ['All books', 'Add the Bybit and OKX books, shifted onto Binance prices, for the whole visible market.'],
  'heat.min': ['Minimum bubble', 'Hide trade bubbles smaller than this, so small prints don\'t clutter the chart.'],
  'heat.bottom': ['Lower pane', 'Choose what the strip under the chart shows: delta and CVD, CVD by venue or order size, open interest, or the Coinbase premium.'],
  // footprint / tpo toolbar
  'fp.bars': ['Bar length', 'Time each footprint candle covers, from 1 minute to 4 hours.'],
  'fp.rows': ['Row size', 'Price step of each footprint row. Auto picks one that fits the zoom.'],
  'fp.show': ['Cell values', 'What each cell shows: bid × ask volume, delta, total volume, number of trades, or the dominant side in %.'],
  'fp.source': ['Source', 'Whose trades build the footprint: Binance only, every perpetual, or spot exchanges.'],
  'tpo.session': ['Session', 'Which trading session the profile is built for (UTC day or a regional session).'],
  'tpo.days': ['Sessions shown', 'How many past sessions to draw side by side.'],
  'tpo.split': ['Split letters', 'Spread each period\'s letters out so you can see when price was at each level.'],
  'tpo.composite': ['Composite', 'Merge the shown sessions into one profile to find levels that held over several days.'],
  // drawing tools
  'tool.range': ['Range profile', 'Drag across the chart to see the volume traded at each price in just that stretch of time.'],
  'tool.avwap': ['Anchored VWAP', 'Click the chart where a move started: the line shows the average price everyone has paid since then.'],
  'tool.preset': ['Anchor presets', 'Start an anchored VWAP at the weekly or daily open, the last funding, or the last big liquidation.'],
  'tool.clear': ['Clear tools', 'Remove every range profile and anchored VWAP you added.'],
  'layers': ['Layers', 'Turn chart overlays on and off: bubbles, walls, absorption, liquidations, gamma, VWAP, profiles and more.'],
  // layers popup
  'L.bubbles': ['', 'Bubbles for every trade, sized by volume, green for buys and red for sells.'],
  'L.xPrints': ['', 'Also draw trades from other exchanges, shifted onto Binance prices.'],
  'L.bidAsk': ['', 'Lines for the best bid and best ask.'],
  'L.dom': ['', 'Depth ladder on the right edge: resting size per price right now.'],
  'L.domWin': ['', 'Shows where size was added (stack) or removed (pull) over this window.'],
  'L.bigTrade': ['', 'Taker orders at or above this size get a ring and a label.'],
  'L.heatPalette': ['', 'Colour scheme of the heatmap.'],
  'L.heatRows': ['', 'Price step of the heatmap rows. Auto follows the zoom.'],
  'L.heatGrid': ['', 'Thin lines between price rows and a dotted time grid.'],
  'L.bubbleStyle': ['', 'How bubbles are drawn: shaded 3D, flat dots, or a pie split into buys and sells.'],
  'L.bubbleSizeBy': ['', 'Size bubbles by total traded volume, or by buy minus sell.'],
  'L.bubbleCluster': ['', 'Group nearby trades into one bubble per time slot, or show every price separately.'],
  'L.liqs': ['', 'Forced liquidations from every exchange (diamonds), and shaded bands for cascades.'],
  'L.liqMap': ['', 'Model of where leveraged positions would be liquidated. An estimate, not exchange data.'],
  'L.micro': ['', 'Walls being pulled (×) or filled (■), and icebergs: hidden orders that keep refilling.'],
  'L.absorption': ['', 'Places where heavy market orders hit a level and price didn\'t move: someone big is absorbing.'],
  'L.gamma': ['', 'Options levels from Deribit: call and put walls, max pain, and where dealer hedging can speed up or slow down price.'],
  'L.basisAdjust': ['', 'Move option levels from the index price onto the perpetual\'s price.'],
  'L.levels': ['', 'High, low, value area and point of control of earlier sessions, and POCs that price hasn\'t revisited yet.'],
  'L.devPoc': ['', 'The price with the most volume so far in this session, drawn as it develops.'],
  'L.vwap': ['', 'Volume-weighted average price for the day or week, a level large funds benchmark against.'],
  'L.vwapBands': ['', 'Standard-deviation bands around the VWAP: stretched price tends to snap back.'],
  'L.profile': ['', 'Volume traded at each price for the chosen range, drawn on the left.'],
  'L.stats': ['', 'Table under the footprint: volume, delta, trades and more for each bar.'],
  'L.zones': ['', 'Highlight stacked imbalances, unfinished auctions and naked POCs on the footprint.'],
  'L.showPoc': ['', 'Mark the price with the most volume inside each footprint bar.'],
  'L.showImb': ['', 'Highlight cells where one side traded much more than the diagonal cell on the other side.'],
  'L.imbalance': ['', 'How lopsided a cell must be to count as an imbalance.'],
  'L.fpMin': ['', 'Dim footprint cells smaller than this.'],
  'L.cluster': ['', 'Outline footprint cells at or above this size.'],
  // top bar
  'top.venue': ['Instrument', 'The market every chart shows. Only an admin can switch it, and it changes for everyone.'],
  'top.price': ['Last price', 'Last traded price on Binance. Green after an uptick, red after a downtick.'],
  'top.24h': ['24 h change', 'Price change over the last 24 hours.'],
  'top.mark': ['Mark price', 'The price Binance uses for profit and liquidations, with the spot index below.'],
  'top.funding': ['Funding', 'What longs pay shorts (or the reverse) at the next funding time, counting down. Positive means longs pay.'],
  'top.oi': ['Open interest', 'BTC in open perpetual positions on Binance.'],
  'top.oiAll': ['Open interest, all venues', 'Open positions across every perpetual we stream, with the change over the last hour.'],
  'top.prem': ['Coinbase premium', 'Coinbase spot price minus Binance. Positive often means US buyers are leading.'],
  'top.vol': ['24 h volume', 'BTC traded on Binance in the last 24 hours.'],
  'top.spread': ['Spread', 'Gap between the best bid and the best ask right now.'],
  'top.regime': ['Flow leader', 'Whether spot or perpetual traders led the last 5 minutes, and in which direction.'],
  'top.integrity': ['Accuracy check', 'Our numbers graded every minute against Binance\'s own candles and fresh order-book snapshots, and the delay to our server.'],
  'top.conn': ['Connection', 'Live: data is streaming. Frozen: your plan has ended. Offline: reconnecting.'],
  'top.account': ['Your account', 'Plan and time left, payment, password, this guide, and sign out.'],
  // side panel tabs
  'side.tape': ['Tape', 'Big taker orders as they happen on every exchange, with filters by size and venue.'],
  'side.flow': ['Flow', 'Volume, delta, open interest and funding per exchange, spot vs perps, and liquidation levels.'],
  'side.book': ['Book', 'Walls in the order book right now, where size is being pulled or stacked, and recent wall events.'],
  'side.gamma': ['Gamma', 'Options positioning from Deribit: gamma by strike, call and put walls, and max pain.'],
  'side.signals': ['Signals', 'Absorption, liquidation cascades and flow-regime changes as they are detected.'],
  'side.health': ['Accuracy', 'Minute-by-minute proof that trades and the order book match the exchange, and the state of every feed.'],
  // panels
  'pane.heat': ['Heatmap', 'Scroll to zoom time, Shift + scroll to zoom price, drag to move. Zoom out or drag back to load older history. Double-click to return to live.'],
  'pane.foot': ['Footprint', 'Each bar shows sold volume on the left and bought volume on the right at every price. Drag back to load older bars.'],
  'pane.tpo': ['TPO', 'Each letter is 30 minutes of price at that level. The widest part is where the market agreed on value.'],
  'side.panel': ['Side panel', 'Live details that go with the chart. Pick a tab at the top.'],
} as const satisfies Record<string, readonly [string, string]>

/** Side-panel section headings that explain themselves on hover (matched by their text). */
const HEADINGS: [RegExp, string][] = [
  [/^Venues/, 'Volume, delta and open interest per exchange over the chosen window.'],
  [/^Spot vs perps delta/, 'Who is pushing: spot buyers and sellers versus perpetual traders.'],
  [/^Delta by order size/, 'Buy minus sell volume split by order size: small, medium and whale orders.'],
  [/^Liquidation levels/, 'Model of where leveraged positions would be force-closed. Clusters often act as magnets.'],
  [/^Walls now/, 'Resting orders big enough to matter, right now, nearest first.'],
  [/^Wall events/, 'Walls that were pulled before price got there, walls that got filled, and icebergs.'],
  [/^Cascades/, 'Chains of liquidations and changes in which side is leading the flow.'],
  [/^Absorption/, 'Heavy market orders that hit a level without moving price: a large passive buyer or seller.'],
  [/^Liquidations/, 'Every forced liquidation on every exchange we stream.'],
  [/^Trades vs exchange/, 'Each minute our trade totals are compared with Binance\'s official candle.'],
  [/^Order book vs snapshot/, 'Our live order book compared with a fresh snapshot from Binance.'],
  [/^Other venues/, 'Connection state of the other exchanges.'],
  [/^Feed/, 'Message counts and delays of the data feeds.'],
]

let installed = false

export function installHints() {
  if (installed) return
  installed = true
  let el: HTMLElement | null = null // element under the pointer that has a description
  let timer = 0
  let closeTimer = 0
  let box: HTMLDivElement | null = null
  let shown = false // already shown for this element: wait until the pointer leaves it
  let sx = 0
  let sy = 0

  const describe = (e: HTMLElement): [string, string] | null => {
    if (e.dataset.tip) return [e.dataset.tipTitle ?? '', e.dataset.tip]
    if (e.tagName === 'H3') {
      const t = e.textContent?.trim() ?? ''
      const m = HEADINGS.find(([re]) => re.test(t))
      if (m) return ['', m[1]]
    }
    return null
  }
  const find = (t: EventTarget | null): HTMLElement | null => {
    let n = t instanceof Element ? (t as HTMLElement) : null
    while (n) {
      if (n.dataset?.tip || (n.tagName === 'H3' && n.closest('.side-body'))) return n
      n = n.parentElement
    }
    return null
  }
  const hide = () => {
    clearTimeout(timer)
    clearTimeout(closeTimer)
    box?.remove()
    box = null
  }
  const show = () => {
    if (!el || !el.isConnected || !hintsOn()) return
    const d = describe(el)
    if (!d) return
    hide()
    shown = true
    const b = document.createElement('div')
    b.className = 'hint-tip'
    b.setAttribute('role', 'tooltip')
    if (d[0]) {
      const h = document.createElement('b')
      h.textContent = d[0]
      b.appendChild(h)
    }
    const p = document.createElement('span')
    p.textContent = d[1]
    b.appendChild(p)
    document.body.appendChild(b)
    box = b
    const r = el.getBoundingClientRect()
    const panel = r.width > 360 && r.height > 200 // a whole panel: show it beside the pointer
    const bw = b.offsetWidth
    const bh = b.offsetHeight
    let x = panel ? sx + 14 : r.left + r.width / 2 - bw / 2
    let y = panel ? sy + 18 : r.bottom + 8
    if (y + bh > innerHeight - 8) y = (panel ? sy : r.top) - bh - 10
    x = Math.max(8, Math.min(innerWidth - bw - 8, x))
    y = Math.max(8, y)
    b.style.left = `${x}px`
    b.style.top = `${y}px`
    if (panel) closeTimer = window.setTimeout(hide, PANEL_SHOW_MS)
  }
  const arm = () => {
    clearTimeout(timer)
    if (el && !shown && hintsOn()) timer = window.setTimeout(show, DELAY)
  }

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return
    const t = find(e.target)
    if (t === el) return
    hide()
    el = t
    shown = false
    sx = e.clientX
    sy = e.clientY
    arm()
  })
  document.addEventListener('pointermove', (e) => {
    if (!el || shown || e.pointerType === 'touch') return
    if (Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy) > 6) {
      sx = e.clientX
      sy = e.clientY
      arm() // only after the pointer has rested
    }
  })
  document.addEventListener('pointerout', (e) => {
    if (el && !(e.relatedTarget instanceof Node && el.contains(e.relatedTarget))) {
      hide()
      el = null
      shown = false
    }
  })
  const quiet = () => {
    hide()
    shown = true // acting on the element: don't pop up until the pointer leaves and comes back
  }
  document.addEventListener('pointerdown', quiet, true)
  document.addEventListener('wheel', quiet, { capture: true, passive: true })
  document.addEventListener('keydown', quiet, true)
  window.addEventListener('blur', quiet)
}
