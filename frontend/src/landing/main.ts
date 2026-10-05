// Landing page behaviour: live config and sign-in state, scroll-linked product window, film player (also started
// from the hero's "Watch the film" button), the tool showcase, scroll reveals, a few one-time in-view moments and
// the live heatmap behind the closing call to action. The hero's entrance,
// menu and background loop are small inline scripts in index.html.
import './page.css'
import { mailLink, type Me, type PublicConfig } from '../lib/session'
import film720 from './media/flowdeck-film-720.mp4?url'
import film1080 from './media/flowdeck-film-1080.mp4?url'
import { mountShowcase } from './showcase'
import { AmbientHeatViz, VizCanvas } from './viz'

const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => r.querySelector(s) as T | null
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => Array.from(r.querySelectorAll(s)) as T[]
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches

// ------------------------------------------------------------------------------------------- config and sign-in state
fetch('/api/public/config', { credentials: 'same-origin' })
  .then((r) => (r.ok ? (r.json() as Promise<PublicConfig>) : null))
  .then((c) => {
    if (!c) return
    for (const el of $$('[data-cfg]')) {
      const k = el.dataset.cfg as keyof PublicConfig
      if (c[k] != null && c[k] !== '') el.textContent = String(c[k])
    }
    const mail = $<HTMLAnchorElement>('#foot-mail')
    if (mail && c.contact_email) { mail.href = mailLink(c.contact_email, 'Flowdeck', ''); mail.hidden = false }
  })
  .catch(() => {})

fetch('/api/auth/state', { credentials: 'same-origin' })
  .then((r) => (r.ok ? (r.json() as Promise<Me | { user: null }>) : null))
  .then((me) => {
    if (!me?.user) return
    for (const el of $$('[data-when]')) el.hidden = el.dataset.when !== 'in'
  })
  .catch(() => {})

const url = $('.window .url')
if (url && location.host) url.textContent = `${location.host}/app`
const year = $('#year')
if (year) year.textContent = String(new Date().getFullYear())

// ------------------------------------------------------------------------------------------- scroll-linked product window + phone
const win = $('.window')
const phone = $('.phone')
let ticking = false
const onScrollFx = () => {
  ticking = false
  const vh = innerHeight
  if (win) {
    const r = win.getBoundingClientRect()
    // 0 while the window sits low in the viewport, 1 once its top reaches the upper third
    const p = Math.min(1, Math.max(0, (vh - r.top) / (vh * 0.75)))
    win.style.setProperty('--p', reduced ? '1' : p.toFixed(3))
    if (p > 0.82) win.classList.add('lit')
  }
  if (phone && !reduced) {
    const r = phone.getBoundingClientRect()
    const c = (r.top + r.height / 2 - vh / 2) / vh
    phone.style.setProperty('--ty', `${(c * 60).toFixed(1)}px`)
  }
}
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScrollFx) } }, { passive: true })
addEventListener('resize', onScrollFx)
onScrollFx()

// ------------------------------------------------------------------------------------------- film
const player = $('#player')
const video = $<HTMLVideoElement>('#film-video')
const play = $<HTMLButtonElement>('#film-play')
if (player && video && play) {
  const start = () => {
    // full HD where the player is big enough on screen to show it (large or high-density displays)
    if (!video.src) video.src = player.clientWidth * (window.devicePixelRatio || 1) > 1400 ? film1080 : film720
    player.classList.add('playing')
    video.controls = true
    video.play().catch(() => { player.classList.remove('playing') })
  }
  play.addEventListener('click', start)
  video.addEventListener('ended', () => { video.controls = false; player.classList.remove('playing'); video.load() })
  // "Watch the film" in the hero: bring the player into view and start it with sound (the click allows audio)
  for (const a of $$('[data-film]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault()
      player.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
      start()
    })
  }
}

// ------------------------------------------------------------------------------------------- tools showcase
const showcase = $('#showcase')
if (showcase) {
  // the canvases draw text in the page font, so wait for it (it is already loading for the hero)
  const go = () => mountShowcase(showcase, reduced)
  document.fonts ? document.fonts.load('500 12px PJS').then(go, go) : go()
}

// ------------------------------------------------------------------------------------------- closing heatmap
// A live heatmap behind "Stop guessing where the size is.": built when the section comes near, drawn only while on
// screen, a still frame with reduced motion.
const finalHeat = $('.final-heat')
if (finalHeat) {
  let vc: VizCanvas | null = null
  let visible = false
  let raf = 0
  let last = 0
  const loop = (now: number) => {
    raf = 0
    if (!vc || !visible || document.hidden) return
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60
    last = now
    try { vc.frame(dt) } catch (err) { console.error(err) }
    raf = requestAnimationFrame(loop)
  }
  const start = () => { if (vc && !reduced && !raf && visible && !document.hidden) { last = 0; raf = requestAnimationFrame(loop) } }
  const build = () => {
    vc = new VizCanvas(finalHeat, () => new AmbientHeatViz(), 2)
    finalHeat.classList.add('wait')
    vc.resize()
    if (reduced) vc.still(); else vc.frame(0)
    requestAnimationFrame(() => finalHeat.classList.remove('wait'))
    new ResizeObserver(() => { if (vc?.resize() && !raf) reduced ? vc.still() : vc.frame(0) }).observe(finalHeat)
  }
  new IntersectionObserver(([e]) => {
    if (e.isIntersecting && !vc) build()
    visible = e.isIntersecting
    start()
  }, { rootMargin: '300px 0px' }).observe(finalHeat)
  document.addEventListener('visibilitychange', start)
}

// ------------------------------------------------------------------------------------------- scroll reveals
// Headings rise out of a mask; blocks lift in, staggered 45 ms within their group. Once each, never on exit.
if (document.documentElement.classList.contains('js-rv')) {
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue
      e.target.classList.add('in')
      io.unobserve(e.target)
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 })
  for (const el of $$('.rise, .rv')) {
    const group = el.parentElement
    if (el.classList.contains('rv') && group) {
      const sibs = Array.from(group.children).filter((c) => c.classList.contains('rv'))
      const i = sibs.indexOf(el)
      if (i > 0) el.style.setProperty('--d', `${Math.min(i, 8) * 45}ms`)
    }
    io.observe(el)
  }
}

// ------------------------------------------------------------------------------------------- in-view moments
function once(sel: string, fn: (el: HTMLElement) => void, threshold = 0.3) {
  for (const el of $$(sel)) {
    if (reduced) { el.classList.add('in'); continue }
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return
      io.disconnect()
      fn(el)
    }, { threshold })
    io.observe(el)
  }
}

const fmt = new Intl.NumberFormat('en-US')
// the accuracy ledger: rows arrive one after another, each result counts up, then its tick draws (CSS)
once('.ledger', (box) => {
  box.classList.add('in')
  $$<HTMLElement>('li', box).forEach((row, i) => {
    const b = $<HTMLElement>('[data-count]', row)
    const n = Number(b?.dataset.count)
    if (!b || !n) return
    b.textContent = '0'
    const t0 = performance.now() + i * 140 + 120
    const tick = (now: number) => {
      const f = Math.min(1, Math.max(0, (now - t0) / 800))
      b.textContent = fmt.format(Math.round(n * (1 - Math.pow(1 - f, 3))))
      if (f < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}, 0.25)
once('.bars', (el) => el.classList.add('in'), 0.35)
once('.steps', (el) => el.classList.add('in'), 0.5)
