import { useEffect, useState } from 'react'
import { api, ApiError, type Me, type PublicConfig } from '../lib/session'
import { act, adminApi, toast } from './ui'

type S = Record<'trial_days' | 'price_label' | 'price_inr' | 'contact_email' | 'signups_open' | 'upgrade_note', string>

export function Settings() {
  const [s, setS] = useState<S | null>(null)
  const [orig, setOrig] = useState<S | null>(null)
  const [busy, setBusy] = useState(false)
  const [pub, setPub] = useState<PublicConfig | null>(null)
  useEffect(() => {
    adminApi<S>('/api/admin/settings').then((d) => { setS(d); setOrig(d) }).catch(() => toast('Could not load settings.', 'bad'))
    api<PublicConfig>('/api/public/config').then(setPub).catch(() => {})
  }, [])
  if (!s || !orig) return <section className="view"><p className="dim">Loading…</p></section>
  const set = (k: keyof S) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setS({ ...s, [k]: e.target.value })
  const dirty = (Object.keys(s) as (keyof S)[]).some((k) => s[k] !== orig[k])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const changed = Object.fromEntries((Object.keys(s) as (keyof S)[]).filter((k) => s[k] !== orig[k]).map((k) => [k, s[k]]))
    const r = await act(() => adminApi<S>('/api/admin/settings', { method: 'PUT', body: changed }), 'Settings saved')
    if (r) { setS(r); setOrig(r) }
    setBusy(false)
  }

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Settings</h1>
          <p className="lede">What new users get and how they pay.</p>
        </div>
      </header>

      <form className="panel form settings" onSubmit={save}>
        <h2 className="panel-title">Sign-ups and trial</h2>
        <label className="check big">
          <input type="checkbox" checked={s.signups_open === '1'} onChange={(e) => setS({ ...s, signups_open: e.target.checked ? '1' : '0' })} />
          <span>Anyone can create an account<small>Turn off to stop new sign-ups. You can still add users yourself.</small></span>
        </label>
        <label className="fld narrow">Free trial length, in days
          <input type="number" min={0} max={90} value={s.trial_days} onChange={set('trial_days')} required />
          <small>Applies to new sign-ups. Existing trials keep their end date.</small>
        </label>

        <h2 className="panel-title">Price</h2>
        <div className="row2">
          <label className="fld">Price shown to users
            <input value={s.price_label} onChange={set('price_label')} maxLength={60} required />
            <small>Shown on the sign-up page, the trial banner and the account menu.</small>
          </label>
          <label className="fld narrow">Price in rupees
            <input inputMode="numeric" value={s.price_inr} onChange={set('price_inr')} pattern="\d{0,6}" />
            <small>What Razorpay charges for {pub?.plan_days ?? 30} days.</small>
          </label>
        </div>

        <h2 className="panel-title">How users pay you</h2>
        <p className="panel-note">
          {pub == null ? 'Checking Razorpay…'
            : pub.payments_enabled
              ? <>Users pay with Razorpay (UPI, card, net banking) from the dashboard. A successful payment adds {pub.plan_days ?? 30} days to their account straight away, and shows up under Users and Activity.{pub.payments_test && <b> Razorpay is in test mode: no real money is taken. Put your live keys on the server to start charging.</b>}</>
              : <>Razorpay isn't set up on this server: add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to its settings. Until then users see an email button.</>}
        </p>
        <div className="row2">
          <label className="fld">Support email
            <input type="email" value={s.contact_email} onChange={set('contact_email')} placeholder="you@example.com" />
            <small>For payment questions and the privacy page. Leave empty to hide it.</small>
          </label>
        </div>
        <label className="fld">Note under the Pay button
          <textarea rows={3} value={s.upgrade_note} onChange={set('upgrade_note')} maxLength={600} />
          <small>Shown on the trial-ended banner.</small>
        </label>

        <div className="save-bar">
          <button className="b-primary" disabled={!dirty || busy}>{busy ? 'Saving…' : 'Save settings'}</button>
          {dirty && <button type="button" className="b-quiet" onClick={() => setS(orig)}>Discard changes</button>}
        </div>
      </form>

      <OwnPassword />
    </section>
  )
}

function OwnPassword() {
  const [had, setHad] = useState(true)   // false: admin account made with Google that never set a password
  useEffect(() => { api<Me>('/api/auth/me').then((m) => setHad(m.user.has_password !== false)).catch(() => {}) }, [])
  const [cur, setCur] = useState('')
  const [nw, setNw] = useState('')
  const [nw2, setNw2] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; t: string } | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (nw !== nw2) return setMsg({ ok: false, t: 'The two new passwords are different.' })
    try {
      await api('/api/auth/password', { body: { current: cur, new: nw } })
      setMsg({ ok: true, t: had ? 'Password changed.' : 'Password set.' })
      setCur(''); setNw(''); setNw2('')
      setHad(true)
    } catch (err) {
      setMsg({ ok: false, t: err instanceof ApiError ? err.message : 'Could not reach the server.' })
    }
  }
  return (
    <form className="panel form settings" onSubmit={submit}>
      <h2 className="panel-title">Your password</h2>
      <div className="row3">
        {had && <label className="fld">Current password<input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required /></label>}
        <label className="fld">New password<input type="password" autoComplete="new-password" minLength={8} value={nw} onChange={(e) => setNw(e.target.value)} required /></label>
        <label className="fld">New password again<input type="password" autoComplete="new-password" minLength={8} value={nw2} onChange={(e) => setNw2(e.target.value)} required /></label>
      </div>
      {msg && <p className={msg.ok ? 'ok-line' : 'err-line'} role="status">{msg.t}</p>}
      <div className="save-bar"><button className="b-primary">{had ? 'Change password' : 'Set password'}</button></div>
    </form>
  )
}
