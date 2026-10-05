import { useEffect, useRef, useState } from 'react'
import { api, ApiError, loginUrl, logout, mailLink, REASONS, timeLeft } from '../lib/session'
import { paymentInProgress, payWithRazorpay } from '../lib/razorpay'
import { hintsOn, setHintsOn, tip } from '../lib/hints'
import { startTour } from './Tour'
import { store, useTopic } from '../lib/store'

function useTick(ms: number) {
  const [, set] = useState(0)
  useEffect(() => {
    const id = setInterval(() => set((x) => x + 1), ms)
    return () => clearInterval(id)
  }, [ms])
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

function upgradeText() {
  const me = store.me
  return `Hi, I'd like to continue Flowdeck (${me?.config.price_label ?? ''}). My account: ${me?.user.email ?? ''}`
}

/** A short confirmation at the top of the screen that outlives the component that shows it. */
function flash(text: string) {
  const el = document.createElement('div')
  el.className = 'pay-toast'
  el.setAttribute('role', 'status')
  el.textContent = text
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 7000)
}

/** Pay for the next period with Razorpay (UPI, card, net banking). Falls back to the contact email when the server
 *  has no Razorpay keys. */
export function UpgradeButtons({ compact = false }: { compact?: boolean }) {
  useTopic('conn')
  const cfg = store.me?.config
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null)
  if (!cfg) return null
  const price = cfg.price_inr ? `₹${cfg.price_inr}` : cfg.price_label

  const pay = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await payWithRazorpay()
      if (r.status === 'paid') {
        store.me = r.me
        store.bump('conn')
        const until = r.me.user.expires_at ? new Date(r.me.user.expires_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''
        const t = `Payment received. Live data is on${until ? ` until ${until}` : ''}.`
        setMsg({ ok: true, t })
        flash(t)   // the trial banner closes as the data goes live, so confirm it outside the banner too
      } else {
        setMsg({ ok: false, t: r.error ? `${r.error} You haven't been charged.` : "Payment cancelled. You haven't been charged." })
      }
    } catch (err) {
      setMsg({ ok: false, t: err instanceof ApiError ? err.message : 'Could not reach the server. Check your connection and try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="up-btns">
      {cfg.payments_enabled ? (
        <button className="up-btn pay" onClick={pay} disabled={busy}>
          {busy ? 'Opening payment…' : compact ? `Pay ${price} · ${cfg.plan_days ?? 30} days` : `Pay ${price} for ${cfg.plan_days ?? 30} days`}
        </button>
      ) : cfg.contact_email ? (
        <a className="up-btn" href={mailLink(cfg.contact_email, 'Flowdeck upgrade', upgradeText())}>
          {compact ? 'Email us to upgrade' : 'Upgrade by email'}
        </a>
      ) : (
        <span className="up-none">Contact the admin to continue.</span>
      )}
      {cfg.payments_enabled && cfg.payments_test && <span className="up-test">Test mode: no real money is taken.</span>}
      {msg && <span className={msg.ok ? 'up-ok' : 'up-bad'} role="status">{msg.t}</span>}
    </div>
  )
}

/** Account button + menu in the top bar: plan, time left, admin link, password, sign out. */
export function AccountMenu() {
  useTopic('conn')
  useTick(30_000)
  const [open, setOpen] = useState(false)
  const [pw, setPw] = useState(false)
  const [hints, setHints] = useState(hintsOn)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (paymentInProgress()) return   // clicks in Razorpay's window
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !paymentInProgress() && setOpen(false)
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', k)
    }
  }, [open])
  const me = store.me
  if (!me) return null
  const u = me.user
  const left = u.expires_at != null ? u.expires_at - Date.now() : null
  const initials = u.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?'
  const tag = u.role === 'admin' ? 'Admin'
    : left != null && left <= 0 ? 'Expired'
      : u.plan === 'trial' ? `Trial · ${timeLeft(left ?? 0)}`
        : left != null ? `Pro · ${timeLeft(left)}` : 'Pro'
  const warn = u.role !== 'admin' && (left == null ? false : left < 86_400_000)
  return (
    <div className="acct" ref={ref}>
      <button className={`acct-btn ${warn ? 'warn' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" {...tip('top.account')}>
        <span className="acct-tag">{tag}</span>
        <span className="avatar" aria-hidden>{initials}</span>
        <span className="sr">Account menu</span>
      </button>
      {open && (
        <div className="acct-pop" role="menu">
          <div className="acct-head">
            <b>{u.name}</b>
            <span>{u.email}</span>
          </div>
          <div className="acct-plan">
            {u.role === 'admin' ? <span>Administrator · no expiry</span>
              : left != null && left <= 0 ? <span className="bad">Plan ended {when(u.expires_at!)}</span>
                : <span>{u.plan === 'trial' ? 'Free trial' : 'Pro'} until {u.expires_at ? when(u.expires_at) : '—'}</span>}
            {u.role !== 'admin' && <UpgradeButtons compact />}
          </div>
          {u.role === 'admin' && <a role="menuitem" href="/admin">Admin panel</a>}
          <a role="menuitem" href="/guide" target="_blank" rel="noopener">Guide: how to read every chart</a>
          <button role="menuitem" onClick={() => { setOpen(false); startTour() }}>Take the tour</button>
          <button role="menuitem" aria-pressed={hints} onClick={() => { setHintsOn(!hints); setHints(!hints) }}>
            Hover help <span className={`acct-sw ${hints ? 'on' : ''}`}>{hints ? 'On' : 'Off'}</span>
          </button>
          <button role="menuitem" onClick={() => { setOpen(false); setPw(true) }}>{u.has_password === false ? 'Set a password' : 'Change password'}</button>
          <button role="menuitem" onClick={() => logout()}>Sign out</button>
        </div>
      )}
      {pw && <PasswordDialog hasPassword={u.has_password !== false} onClose={() => setPw(false)} />}
    </div>
  )
}

/** hasPassword=false: an account made with Google sets its first password, so there is no current one to ask for. */
export function PasswordDialog({ onClose, hasPassword = true }: { onClose: () => void; hasPassword?: boolean }) {
  const [had, setHad] = useState(hasPassword)
  const [cur, setCur] = useState('')
  const [nw, setNw] = useState('')
  const [nw2, setNw2] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (nw !== nw2) return setMsg({ ok: false, t: 'The new passwords do not match.' })
    setBusy(true)
    try {
      await api('/api/auth/password', { body: { current: cur, new: nw } })
      setMsg({ ok: true, t: had ? 'Password changed.' : 'Password set. You can now also sign in with your email and this password.' })
      setCur(''); setNw(''); setNw2('')
      if (!had && store.me) store.me.user.has_password = true
      setHad(true)
    } catch (err) {
      setMsg({ ok: false, t: err instanceof ApiError ? err.message : 'Something went wrong.' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal" onSubmit={submit} aria-label={had ? 'Change password' : 'Set a password'}>
        <h3>{had ? 'Change password' : 'Set a password'}</h3>
        {had
          ? <label>Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>
          : <p>You signed up with Google. A password lets you also sign in with your email.</p>}
        <label>New password<input type="password" autoComplete="new-password" minLength={8} value={nw} onChange={(e) => setNw(e.target.value)} required /></label>
        <label>Repeat new password<input type="password" autoComplete="new-password" minLength={8} value={nw2} onChange={(e) => setNw2(e.target.value)} required /></label>
        {msg && <p className={msg.ok ? 'ok' : 'bad'} role="status">{msg.t}</p>}
        <div className="modal-btns">
          <button type="button" onClick={onClose}>Close</button>
          <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : had ? 'Change password' : 'Set password'}</button>
        </div>
      </form>
    </div>
  )
}

/** Trial ended: the chart shows a frozen snapshot. */
export function FrozenBar() {
  useTopic('conn')
  if (store.conn !== 'frozen' || !store.frozenAt) return null
  const cfg = store.me?.config
  return (
    <div className="frozen-bar" role="status">
      <div className="fz-icon" aria-hidden>❄</div>
      <div className="fz-text">
        <b>Your free trial has ended.</b>
        <span>
          {store.frozenEmpty
            ? 'The market snapshot refreshes a few times every half hour, and you have reloaded more often than that, so the chart is empty for now. '
            : `You're looking at a frozen snapshot from ${new Date(store.frozenAt).toLocaleTimeString()}. Nothing on screen updates. `}
          Continue live for {cfg?.price_label ?? 'a small monthly fee'}.
        </span>
        {cfg?.upgrade_note && <span className="fz-note">{cfg.upgrade_note}</span>}
      </div>
      <UpgradeButtons />
    </div>
  )
}

/** Session ended elsewhere (other device, admin, block): full-screen notice, no reconnect. */
export function KickedOverlay() {
  useTopic('conn')
  const r = store.kicked
  if (!r) return null
  const title = r === 'replaced' ? 'Signed in on another device' : r === 'blocked' ? 'Account blocked'
    : r === 'admin_logout' ? 'Signed out by admin' : r === 'other_tab' ? 'Open in another tab' : 'Signed out'
  return (
    <div className="kicked" role="alertdialog" aria-modal="true" aria-labelledby="kicked-t">
      <div className="kicked-card">
        <h2 id="kicked-t">{title}</h2>
        <p>{REASONS[r] ?? REASONS.revoked}</p>
        {r === 'other_tab' ? <button className="primary" onClick={() => location.reload()}>Use this tab instead</button>
          : r !== 'blocked' && r !== 'deleted' && <a className="primary" href={loginUrl('/app', r)}>Sign in again</a>}
        <a className="ghost" href="/">Back to the homepage</a>
      </div>
    </div>
  )
}
