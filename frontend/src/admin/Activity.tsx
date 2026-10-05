import { useEffect, useState } from 'react'
import { type AuditRow, Empty, fmtDate, rel, usePoll, useNow } from './ui'

export const ACTIONS: Record<string, string> = {
  login: 'Signed in',
  logout: 'Signed out',
  login_failed: 'Wrong password',
  login_blocked: 'Blocked account tried to sign in',
  signup: 'Created an account',
  user_create: 'Added a user',
  user_update: 'Edited an account',
  extend: 'Extended access',
  password_change: 'Changed own password',
  password_reset: 'Set a new password',
  force_logout: 'Signed a user out',
  user_delete: 'Deleted an account',
  settings: 'Changed settings',
  feed_switch: 'Switched the instrument',
  bootstrap_skipped: 'Admin email from the server settings belongs to a regular account; not promoted',
  google_link: 'Linked a Google account',
  payment_order: 'Opened Razorpay checkout',
  payment: 'Paid with Razorpay',
  payment_failed: 'Payment could not be confirmed',
}

const TONE: Record<string, string> = {
  login_failed: 'bad', login_blocked: 'bad', user_delete: 'bad', force_logout: 'warn', extend: 'good', signup: 'good', user_create: 'good',
  payment: 'good', payment_failed: 'bad',
}

const ms13 = /\b(1\d{12})\b/g
/** Make the stored detail readable: timestamps become dates, "days=30" becomes "+30 days". */
function detail(r: AuditRow) {
  let s = r.detail || ''
  if (r.action === 'login' && s.startsWith('replaced')) return `${s.replace('replaced', 'Signed out')} elsewhere`
  s = s.replace(/days=(-?\d+)/, (_, d) => `${Number(d) > 0 ? '+' : ''}${d} days`)
  s = s.replace(/until=/, 'until ').replace(/expires=None/, 'no end date').replace(/expires=/, 'access until ')
  s = s.replace(/status=blocked/, 'blocked').replace(/status=active/, 'unblocked').replace(/role=admin/, 'made admin').replace(/role=user/, 'made regular user')
  s = s.replace(/venue=usdm/, 'BTCUSDT perpetual').replace(/venue=coinm/, 'BTCUSD perpetual (COIN-M)')
  return s.replace(ms13, (_, t) => fmtDate(Number(t)))
}

export function AuditList({ rows, compact = false }: { rows: AuditRow[]; compact?: boolean }) {
  const now = useNow(30_000)
  if (!rows.length) return <Empty>Nothing recorded yet.</Empty>
  return (
    <ol className={`audit ${compact ? 'compact' : ''}`}>
      {rows.map((r) => {
        const self = r.actor_email && r.actor_email === r.target_email
        const who = r.actor_email ?? (r.action === 'login_failed' ? 'Someone' : 'System')
        return (
          <li key={r.id} className={TONE[r.action] ?? ''}>
            <time dateTime={new Date(r.t).toISOString()} title={fmtDate(r.t, true)}>{compact ? rel(r.t, now) : fmtDate(r.t)}</time>
            <div className="a-main">
              <span className="a-what">
                {!compact && <b>{who}</b>} {ACTIONS[r.action] ?? r.action}
                {r.target_email && !self && r.action !== 'login_failed' && <> for <b>{r.target_email}</b></>}
                {r.action === 'login_failed' && (r.target_email ?? r.detail) && <> for <b>{r.target_email ?? r.detail}</b></>}
              </span>
              {r.action !== 'login_failed' && detail(r) && <span className="a-detail">{detail(r)}</span>}
            </div>
            {r.ip && <span className="a-ip">{r.ip}</span>}
          </li>
        )
      })}
    </ol>
  )
}

export function Activity() {
  const [q, setQ] = useState('')
  const [dq, setDq] = useState('')
  const [action, setAction] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('action') ?? '')
  useEffect(() => {
    const id = setTimeout(() => setDq(q), 250)
    return () => clearTimeout(id)
  }, [q])
  const [rows, error] = usePoll<AuditRow[]>(`/api/admin/audit?limit=400&q=${encodeURIComponent(dq)}&action=${action}`, 10_000)
  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Activity</h1>
          <p className="lede">Every sign-in, sign-up and admin change, newest first.</p>
        </div>
      </header>
      <div className="toolbar">
        <input className="search" type="search" placeholder="Search email, IP or detail" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search activity" />
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Type of event">
          <option value="">All events</option>
          {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      {error && <p className="err-line">{error}</p>}
      {rows && <div className="panel"><AuditList rows={rows} /></div>}
    </section>
  )
}
