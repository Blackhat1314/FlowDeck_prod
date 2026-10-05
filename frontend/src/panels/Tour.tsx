// First-visit tour: a spotlight on one part of the screen at a time with Back / Next, and Skip to leave at any point.
// Shown once per account (remembered on the server); "Take the tour" in the account menu starts it again.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../lib/session'
import { store, useTopic } from '../lib/store'

interface Step {
  sel?: string // element to highlight; none = a centred card
  title: string
  text: string
}

const STEPS: Step[] = [
  { title: 'Welcome to Flowdeck', text: 'A one-minute tour of the screen. Use Next to go through it, or Skip to start using Flowdeck straight away.' },
  { sel: '.toolbar .seg[role=tablist]', title: 'Pick a view', text: 'Heatmap shows the waiting orders, Footprint the trades inside each candle, Both stacks them, and TPO shows where price spent its time.' },
  { sel: '.pane.heat', title: 'The heatmap', text: 'Each row is a price, each moment a column. Bright bands are big resting orders; bubbles are trades, green buys and red sells. Scroll to zoom, drag to move, and zoom out or drag back to load older history.' },
  { sel: '.pane.foot', title: 'The footprint', text: 'Every candle split into price rows: BTC sold on the left, bought on the right. Lopsided rows show who won at that price.' },
  { sel: '.toolbar .group', title: 'Chart settings', text: 'Contrast, bubble size, which order books to include, and what the lower pane shows. The settings change with the view you pick.' },
  { sel: '.layers', title: 'Layers', text: 'Switch overlays on and off: walls and icebergs, absorption, liquidations, gamma levels, VWAP, volume profile and more.' },
  { sel: '.topbar .stats', title: 'The numbers that matter', text: 'Price change, funding, open interest across exchanges and the Coinbase premium, updated live.' },
  { sel: '.topbar .integrity', title: 'Accuracy you can check', text: 'Every minute our data is graded against Binance\'s own records. Green means it matched exactly.' },
  { sel: '.side .tabs', title: 'Side panel', text: 'Big trades as they happen, flow by exchange, walls in the book, options gamma, signals and the accuracy log.' },
  { sel: '.acct-btn', title: 'Your account', text: 'Your plan and time left, the Pay button, your password, the full guide, and this tour again.' },
  { title: 'You\'re set', text: 'Rest the pointer on any button or panel for 2 seconds to see what it does. The full guide is in the account menu.' },
]

let startNow: (() => void) | null = null
/** Start the tour again (account menu). */
export function startTour() {
  startNow?.()
}

export default function Tour({ onStart, onEnd }: { onStart?: () => void; onEnd?: () => void }) {
  useTopic('conn')
  const [i, setI] = useState(-1) // -1 = not running
  const [rect, setRect] = useState<DOMRect | null>(null)
  const next = useRef<HTMLButtonElement>(null)
  const steps = useRef<Step[]>(STEPS)

  const begin = () => {
    onStart?.()
    // steps whose part of the screen isn't showing (a narrow window, another view) are left out
    setTimeout(() => {
      steps.current = STEPS.filter((s) => !s.sel || document.querySelector(s.sel))
      setI(0)
    }, 250)
  }
  startNow = begin

  // first visit: once the dashboard is live
  const me = store.me
  useEffect(() => {
    if (i >= 0 || !me || me.user.tour_done || store.conn !== 'live') return
    try {
      if (localStorage.getItem('fd-tour') === String(me.user.id)) return
    } catch {
      /* no storage: rely on the server */
    }
    const id = setTimeout(begin, 1200)
    return () => clearTimeout(id)
  }, [me, store.conn])

  const finish = () => {
    setI(-1)
    onEnd?.()
    if (store.me) store.me.user.tour_done = true
    try {
      if (store.me) localStorage.setItem('fd-tour', String(store.me.user.id))
    } catch {
      /* ignore */
    }
    api('/api/me/tour', { body: { done: true } }).catch(() => {})
  }

  const step = i >= 0 ? steps.current[i] : null
  useLayoutEffect(() => {
    if (!step) return
    const place = () => {
      const el = step.sel ? document.querySelector(step.sel) : null
      setRect(el ? el.getBoundingClientRect() : null)
    }
    place()
    next.current?.focus()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [i])
  useEffect(() => {
    if (!step) return
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  if (!step) return null
  const n = steps.current.length
  const go = (d: number) => {
    const j = i + d
    if (j >= n) finish()
    else if (j >= 0) setI(j)
  }

  // card beside the highlighted part, kept on screen
  const W = Math.min(340, innerWidth - 24)
  let style: React.CSSProperties
  if (!rect) style = { left: (innerWidth - W) / 2, top: Math.max(24, innerHeight / 2 - 120), width: W }
  else {
    const below = rect.bottom + 12
    const big = rect.height > innerHeight * 0.45
    const top = big ? rect.top + 24 : below + 200 > innerHeight ? Math.max(12, rect.top - 212) : below
    const left = big ? rect.left + 24 : rect.left + rect.width / 2 - W / 2
    style = { left: Math.max(12, Math.min(innerWidth - W - 12, left)), top: Math.max(12, Math.min(innerHeight - 220, top)), width: W }
  }
  return (
    <div className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-t">
      {rect ? (
        <div className="tour-spot" style={{ left: rect.left - 6, top: rect.top - 6, width: rect.width + 12, height: rect.height + 12 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div className="tour-card" style={style}>
        <span className="tour-n">{i + 1} of {n}</span>
        <h3 id="tour-t">{step.title}</h3>
        <p>{step.text}</p>
        <div className="tour-btns">
          <button className="tour-skip" onClick={finish}>{i === n - 1 ? 'Close' : 'Skip tour'}</button>
          <span className="grow" />
          {i > 0 && <button onClick={() => go(-1)}>Back</button>}
          <button ref={next} className="primary" onClick={() => go(1)}>{i === n - 1 ? 'Start using Flowdeck' : 'Next'}</button>
        </div>
      </div>
    </div>
  )
}
