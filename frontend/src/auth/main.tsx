import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import './page.css'
import loop1080 from '../landing/media/hero-loop.mp4?url'
import loop4k from '../landing/media/hero-loop-4k.mp4?url'
import loopWebm from '../landing/media/hero-loop.webm?url'
import loopPoster from '../landing/media/hero-loop-poster.webp?url'

// the same silent loop as the landing page hero: walls of resting orders lining the price
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
function ArtLoop() {
  return (
    <video className="auth-loop" autoPlay={!reducedMotion} muted loop playsInline preload="auto" poster={loopPoster} aria-hidden="true" disablePictureInPicture>
      <source src={loop4k} type="video/mp4" media="(min-width: 1600px) and (min-resolution: 1.5dppx), (min-width: 2600px)" />
      <source src={loop1080} type="video/mp4" />
      <source src={loopWebm} type="video/webm" />
    </video>
  )
}
import { api, ApiError, type Me, type PublicConfig, REASONS } from '../lib/session'

type Mode = 'signin' | 'signup'

// ------------------------------------------------------------------ Sign in with Google (Google Identity Services)
declare global {
  interface Window { google?: any }
}
let gisLoad: Promise<void> | null = null
let gisReadyFor = ''
let onGoogleCredential: (credential: string) => void = () => {}

function loadGis(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve()
  gisLoad ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => { gisLoad = null; reject(new Error('Google sign-in script failed to load')) }
    document.head.appendChild(s)
  })
  return gisLoad
}

/** Google's own button (an iframe Google draws), sized to the form. The token it returns goes to onCredential. */
function GoogleButton({ clientId, mode, onCredential }: { clientId: string; mode: Mode; onCredential: (c: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  onGoogleCredential = onCredential
  useEffect(() => {
    let alive = true
    loadGis().then(() => {
      const el = box.current
      if (!alive || !el) return
      const gid = window.google.accounts.id
      if (gisReadyFor !== clientId) {   // initialise once per page; the callback reads the latest handler
        gid.initialize({ client_id: clientId, callback: (r: { credential: string }) => onGoogleCredential(r.credential),
          ux_mode: 'popup', auto_select: false, cancel_on_tap_outside: true, itp_support: true })
        gisReadyFor = clientId
      }
      el.replaceChildren()
      gid.renderButton(el, { type: 'standard', theme: 'filled_black', size: 'large', shape: 'pill', logo_alignment: 'center',
        text: mode === 'signup' ? 'signup_with' : 'signin_with', width: Math.max(200, Math.min(400, el.clientWidth || 400)) })
    }).catch(() => alive && setFailed(true))
    return () => { alive = false }
  }, [clientId, mode])
  if (failed) return <p className="auth-fine">Google sign-in couldn't load here. Use your email and password instead.</p>
  return <div className="gbtn" ref={box} />
}

/** Where to go after signing in: only a path on this site, never another origin (tabs and backslashes included). */
function safeNext() {
  const n = new URLSearchParams(location.search).get('next') || '/app'
  try {
    const u = new URL(n, location.origin)
    if (u.origin === location.origin && n.startsWith('/')) return u.pathname + u.search + u.hash
  } catch {
    /* not a URL */
  }
  return '/app'
}

export function Brandmark() {
  return (
    <a className="brandmark" href="/">
      <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
        <rect x="3" y="17" width="5" height="12" rx="1.6" fill="#2f7bff" />
        <rect x="10" y="10" width="5" height="19" rx="1.6" fill="#56d6ff" />
        <rect x="17" y="4" width="5" height="25" rx="1.6" fill="#ffb547" />
        <rect x="24" y="12" width="5" height="17" rx="1.6" fill="#ff3a34" />
      </svg>
      Flowdeck
    </a>
  )
}

function Auth() {
  const [mode, setMode] = useState<Mode>(location.pathname.startsWith('/signup') ? 'signup' : 'signin')
  const [cfg, setCfg] = useState<PublicConfig | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [show, setShow] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reason = new URLSearchParams(location.search).get('reason')

  useEffect(() => {
    api<PublicConfig>('/api/public/config').then(setCfg).catch(() => {})
    api<Me>('/api/auth/me').then(setMe).catch(() => {})
  }, [])
  useEffect(() => {
    document.title = mode === 'signup' ? 'Create your Flowdeck account' : 'Sign in to Flowdeck'
  }, [mode])

  const switchMode = (m: Mode) => {
    setMode(m)
    setError(null)
    history.replaceState(null, '', (m === 'signup' ? '/signup' : '/login') + location.search)
  }

  const googleId = cfg?.google_client_id || null
  const googleBusy = useRef(false)
  const [linked, setLinked] = useState(false)

  const withGoogle = async (credential: string) => {
    if (googleBusy.current) return   // Google's button can fire twice on a double click
    googleBusy.current = true
    setBusy(true)
    setError(null)
    try {
      const r = await api<{ created: boolean; password_cleared: boolean }>('/api/auth/google', { body: { credential } })
      if (r.password_cleared) {   // tell them before leaving: their old password no longer works
        setLinked(true)
        return
      }
      location.href = r.created ? '/app' : safeNext()
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection and try again.')
      setBusy(false)
      googleBusy.current = false
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === 'signup') await api('/api/auth/signup', { body: { name, email, password: pw } })
      else await api('/api/auth/login', { body: { email, password: pw } })
      location.href = mode === 'signup' ? '/app' : safeNext()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_login' && googleId) {
        setError(`${err.message} If you created your account with Google, use the Google button above.`)
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection and try again.')
      }
      setBusy(false)
    }
  }

  const days = cfg?.trial_days ?? 3
  const closed = mode === 'signup' && cfg && !cfg.signups_open
  return (
    <div className="auth">
      <aside className="auth-art">
        <ArtLoop />
        <div className="auth-art-copy">
          <Brandmark />
          <p className="auth-quote">Every order resting in the Binance BTC perpetual book and every trade from four exchanges. One tab.</p>
          <ul className="auth-facts">
            <li><b>{days} days free</b> with everything switched on</li>
            <li><b>{cfg?.price_label ?? '₹499 / month'}</b> after that</li>
            <li><b>No card</b> needed to start</li>
          </ul>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-top"><Brandmark /></div>
        <div className="auth-card">
          {linked ? (
            <div className="signed-in">
              <h1>Google is connected</h1>
              <p>Your Flowdeck account now signs in with Google. For your security, the password on this account has been switched off.</p>
              <p>To sign in with a password as well, choose <b>Set a password</b> in the dashboard's account menu.</p>
              <a className="btn btn-signal" href={safeNext()}>Open the dashboard</a>
            </div>
          ) : me ? (
            <div className="signed-in">
              <h1>You're signed in</h1>
              <p>as <b>{me.user.name}</b> ({me.user.email}).</p>
              <a className="btn btn-signal" href={safeNext()}>Open the dashboard</a>
              <button className="linklike" onClick={async () => { await api('/api/auth/logout', { body: {} }); setMe(null) }}>
                Sign in with a different account
              </button>
            </div>
          ) : (
            <>
              <div className="auth-tabs" role="tablist" aria-label="Account">
                <button role="tab" aria-selected={mode === 'signin'} onClick={() => switchMode('signin')}>Sign in</button>
                <button role="tab" aria-selected={mode === 'signup'} onClick={() => switchMode('signup')}>Create account</button>
              </div>
              <h1>{mode === 'signup' ? `Start your ${days}-day free trial` : 'Welcome back'}</h1>
              <p className="auth-sub">
                {mode === 'signup'
                  ? `Full access for ${days} days. Then ${cfg?.price_label ?? '₹499 / month'} to keep the live data.`
                  : 'Sign in to open the live dashboard.'}
              </p>
              {reason && REASONS[reason] && mode === 'signin' && <p className="auth-note" role="status">{REASONS[reason]}</p>}
              {closed ? (
                <p className="auth-note">New sign-ups are paused right now. Contact us for access.</p>
              ) : (
                <>
                {googleId && (
                  <>
                    <GoogleButton clientId={googleId} mode={mode} onCredential={withGoogle} />
                    <div className="auth-or" aria-hidden="true"><span>or with email</span></div>
                  </>
                )}
                <form onSubmit={submit} noValidate={false}>
                  {mode === 'signup' && (
                    <label>Your name
                      <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={80} />
                    </label>
                  )}
                  <label>Email
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required inputMode="email" />
                  </label>
                  <label>Password
                    <span className="pw">
                      <input type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)}
                        autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 8 : 1} />
                      <button type="button" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
                    </span>
                    {mode === 'signup' && <small>At least 8 characters.</small>}
                  </label>
                  {error && <p className="auth-error" role="alert">{error}</p>}
                  <button className="btn btn-signal wide" disabled={busy}>
                    {busy ? (mode === 'signup' ? 'Creating your account…' : 'Signing in…') : mode === 'signup' ? 'Create account' : 'Sign in'}
                  </button>
                </form>
                </>
              )}
              <p className="auth-switch">
                {mode === 'signup'
                  ? <>Already have an account? <button className="linklike" onClick={() => switchMode('signin')}>Sign in</button></>
                  : <>New to Flowdeck? <button className="linklike" onClick={() => switchMode('signup')}>Create an account</button></>}
              </p>
              <p className="auth-fine">One device at a time per account: signing in here signs out any other device.</p>
              <p className="auth-fine">By continuing you agree to the <a href="/terms">Terms</a> and <a href="/privacy">Privacy Policy</a>.</p>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Auth />)
