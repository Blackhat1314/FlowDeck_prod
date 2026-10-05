// Tool showcase: a tab list of the eight tools beside one large live illustration.
// Auto-advances every 7 s with a progress bar; pauses while pointed at or focused, stops for good when the visitor
// picks a tool, and has a play/pause button. Arrow keys, Home and End move between tools. Animates only while on
// screen; with reduced motion it shows still frames and never advances on its own.
import { AbsorbViz, DeltaViz, ExchangesViz, FootprintViz, GammaViz, HeatmapViz, ProfileViz, TradesViz, VizCanvas, type Viz } from './viz'

const MAKERS: Record<string, () => Viz> = {
  heat: () => new HeatmapViz(),
  trades: () => new TradesViz(),
  footprint: () => new FootprintViz(),
  profile: () => new ProfileViz(),
  delta: () => new DeltaViz(),
  absorption: () => new AbsorbViz(),
  gamma: () => new GammaViz(),
  venues: () => new ExchangesViz(),
}
const DUR = 7

export function mountShowcase(root: HTMLElement, reduced: boolean) {
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const panel = root.querySelector<HTMLElement>('[role="tabpanel"]')
  const host = root.querySelector<HTMLElement>('.sc-canvas')
  const caption = root.querySelector<HTMLElement>('.sc-caption')
  const sr = root.querySelector<HTMLElement>('.sc-sr')
  const toggle = root.querySelector<HTMLButtonElement>('.sc-toggle')
  if (!tabs.length || !panel || !host) return

  const canvases = new Map<string, VizCanvas>()
  let active = -1
  let cur: VizCanvas | null = null
  let prev: VizCanvas | null = null
  let prevUntil = 0
  let elapsed = 0
  let stopped = reduced // auto-advance off: reduced motion, or the visitor picked a tool / pressed pause
  let holding = false // pointer over or focus inside: pause the timer, not the drawing
  let visible = false
  let last = 0
  let raf = 0

  const get = (key: string) => {
    let c = canvases.get(key)
    if (!c) { c = new VizCanvas(host, MAKERS[key]); canvases.set(key, c); c.resize() }
    return c
  }
  const bar = (i: number) => tabs[i].querySelector<HTMLElement>('.sc-bar i')

  function setToggle() {
    if (!toggle) return
    toggle.setAttribute('aria-pressed', String(stopped))
    toggle.setAttribute('aria-label', stopped ? 'Play the tool tour' : 'Pause the tool tour')
    toggle.classList.toggle('is-paused', stopped)
    root.classList.toggle('sc-stopped', stopped)
  }

  function select(i: number, fromUser: boolean) {
    if (fromUser) { stopped = true; setToggle() }
    if (i === active) return
    if (active >= 0) {
      tabs[active].setAttribute('aria-selected', 'false')
      tabs[active].tabIndex = -1
      const b = bar(active); if (b) b.style.transform = 'scaleX(0)'
    }
    active = i
    const tab = tabs[i]
    tab.setAttribute('aria-selected', 'true')
    tab.tabIndex = 0
    panel!.setAttribute('aria-labelledby', tab.id)
    const desc = tab.querySelector('.sc-desc')?.textContent ?? ''
    if (caption) caption.textContent = desc
    if (sr) sr.textContent = tab.dataset.sr ?? ''
    prev = cur
    cur = get(tab.dataset.viz!)
    cur.canvas.classList.add('on')
    if (prev && prev !== cur) { prev.canvas.classList.remove('on'); prevUntil = performance.now() + 380 } else prev = null
    elapsed = 0
    if (reduced) cur.still()
    else if (!raf && visible) cur.frame(0)
    // keep the chosen chip in view on phones without scrolling the page
    const list = tab.parentElement!
    if (list.scrollWidth > list.clientWidth) list.scrollTo({ left: tab.offsetLeft - 16, behavior: reduced ? 'auto' : 'smooth' })
  }

  function loop(now: number) {
    raf = 0
    if (!visible || document.hidden) return
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
    last = now
    // one bad frame must never stop the loop
    try { cur?.frame(dt) } catch (err) { console.error(err) }
    try { if (prev && now < prevUntil) prev.frame(dt) } catch (err) { console.error(err) }
    if (!stopped && !holding) {
      elapsed += dt
      if (elapsed >= DUR) select((active + 1) % tabs.length, false)
    }
    const b = bar(active)
    if (b) b.style.transform = `scaleX(${stopped ? 0 : Math.min(1, elapsed / DUR).toFixed(4)})`
    raf = requestAnimationFrame(loop)
  }
  const start = () => { if (!reduced && !raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(loop) } }

  tabs.forEach((t, i) => {
    t.tabIndex = -1
    t.addEventListener('click', () => select(i, true))
  })
  tabs[0].parentElement!.addEventListener('keydown', (e) => {
    const k = e.key
    let n = -1
    if (k === 'ArrowDown' || k === 'ArrowRight') n = (active + 1) % tabs.length
    else if (k === 'ArrowUp' || k === 'ArrowLeft') n = (active - 1 + tabs.length) % tabs.length
    else if (k === 'Home') n = 0
    else if (k === 'End') n = tabs.length - 1
    if (n < 0) return
    e.preventDefault()
    select(n, true)
    tabs[n].focus()
  })
  toggle?.addEventListener('click', () => { stopped = !stopped; setToggle(); start() })
  root.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') holding = true })
  root.addEventListener('pointerleave', () => { holding = false })
  root.addEventListener('focusin', () => { holding = true })
  root.addEventListener('focusout', (e) => { if (!root.contains(e.relatedTarget as Node)) holding = false })

  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) start() }, { threshold: 0.15 }).observe(root)
  document.addEventListener('visibilitychange', start)
  new ResizeObserver(() => {
    for (const c of canvases.values()) if (c.resize() && (reduced || !raf)) c === cur ? (reduced ? c.still() : c.frame(0)) : null
  }).observe(host)

  if (reduced && toggle) toggle.hidden = true
  setToggle()
  select(0, false)
}
