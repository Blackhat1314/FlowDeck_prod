// Small building blocks shared by the admin views: formatting, polling, toasts, confirm dialogs, menus.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, ApiError, loginUrl } from '../lib/session'

// ------------------------------------------------------------------------------------------- types
export type UserState = 'trial' | 'active' | 'expired' | 'blocked' | 'admin'

export interface AdminUser {
  id: number
  email: string
  name: string
  role: 'user' | 'admin'
  status: 'active' | 'blocked'
  state: UserState
  plan: 'trial' | 'paid'
  created_at: number
  expires_at: number | null
  last_login_at: number | null
  last_seen_at: number | null
  last_ip: string | null
  note: string
  created_by: string
  live: boolean
  google?: boolean
  has_password?: boolean
  online?: boolean
  online_live?: boolean
}

export interface Conn {
  user_id: number
  session_id: number
  email: string
  name: string
  ip: string
  ua: string
  since: number
  live: boolean
  seconds: number
}

export interface AuditRow {
  id: number
  t: number
  actor_id: number | null
  actor_email: string | null
  action: string
  target_id: number | null
  target_email: string | null
  detail: string
  ip: string | null
}

export const DAY = 86_400_000

// ------------------------------------------------------------------------------------------- formatting
const dtf = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const dtfY = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const df = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function fmtDate(t: number | null | undefined, withYear = false) {
  if (!t) return '—'
  const d = new Date(t)
  return (withYear || d.getFullYear() !== new Date().getFullYear() ? dtfY : dtf).format(d)
}
export const fmtDay = (t: number) => df.format(new Date(t))

export function span(ms: number) {
  const a = Math.abs(ms)
  if (a < 60_000) return `${Math.max(1, Math.round(a / 1000))}s`
  if (a < 3_600_000) return `${Math.round(a / 60_000)}m`
  if (a < DAY) {
    const min = Math.round(a / 60_000)
    const h = Math.floor(min / 60)
    const m = min % 60
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const hrs = Math.round(a / 3_600_000)
  const d = Math.floor(hrs / 24)
  const h = hrs % 24
  return h && d < 10 ? `${d}d ${h}h` : `${d}d`
}

/** "in 2d 4h" or "3h ago". */
export function rel(t: number | null | undefined, now = Date.now()) {
  if (!t) return '—'
  const d = t - now
  if (Math.abs(d) < 45_000) return 'just now'
  return d > 0 ? `in ${span(d)}` : `${span(d)} ago`
}

export const num = (n: number | null | undefined, digits = 0) =>
  n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })

/** "Chrome on Windows" from a user-agent string. */
export function device(ua: string | null | undefined) {
  if (!ua) return 'Unknown device'
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari'
      : /python|httpx|curl|testclient/i.test(ua) ? 'Script' : 'Browser'
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : ''
  return o ? `${b} on ${o}` : b
}

export const STATE_LABEL: Record<UserState, string> = {
  trial: 'Trial', active: 'Paid', expired: 'Expired', blocked: 'Blocked', admin: 'Admin',
}

export function StateBadge({ s }: { s: UserState }) {
  return <span className={`badge b-${s}`}>{STATE_LABEL[s]}</span>
}

export function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?'
}

// ------------------------------------------------------------------------------------------- API with session handling
/** Like api(), but a lost session sends the admin to sign in and a non-admin to the dashboard. */
export async function adminApi<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await api<T>(path, opts)
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) location.href = loginUrl('/admin', e.code)
    if (e instanceof ApiError && e.status === 403 && e.code === 'forbidden') location.href = '/app'
    throw e
  }
}

/** Fetch now and every `ms` while the tab is visible. Returns [data, error, reload]. */
export function usePoll<T>(path: string | null, ms: number): [T | null, string | null, () => void] {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)
  const load = useCallback(() => {
    if (!path) return
    const n = ++seq.current
    adminApi<T>(path)
      .then((d) => { if (n === seq.current) { setData(d); setError(null) } })
      .catch((e) => { if (n === seq.current) setError(e instanceof ApiError ? e.message : 'Could not reach the server.') })
  }, [path])
  useEffect(() => {
    load()
    if (!ms) return
    const id = setInterval(() => { if (!document.hidden) load() }, ms)
    const vis = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', vis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis) }
  }, [load, ms])
  return [data, error, load]
}

export function useNow(ms = 1000) {
  const [t, set] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => set(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return t
}

// ------------------------------------------------------------------------------------------- toasts
type Toast = { id: number; text: string; kind: 'ok' | 'bad' }
let toasts: Toast[] = []
const toastSubs = new Set<() => void>()
let toastId = 0
export function toast(text: string, kind: Toast['kind'] = 'ok') {
  const id = ++toastId
  toasts = [...toasts.slice(-3), { id, text, kind }]
  toastSubs.forEach((f) => f())
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== id)
    toastSubs.forEach((f) => f())
  }, kind === 'bad' ? 6000 : 3500)
}
export function Toasts() {
  const list = useSyncExternalStore((f) => { toastSubs.add(f); return () => toastSubs.delete(f) }, () => toasts)
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  )
}

/** Run an admin action: shows the success text or the server's error as a toast. Returns the result or null. */
export async function act<T>(fn: () => Promise<T>, okText?: string): Promise<T | null> {
  try {
    const r = await fn()
    if (okText) toast(okText)
    return r
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Could not reach the server.', 'bad')
    return null
  }
}

// ------------------------------------------------------------------------------------------- confirm dialog
type Ask = { title: string; body: ReactNode; confirm: string; danger?: boolean; typed?: string; resolve: (ok: boolean) => void }
let ask: Ask | null = null
const askSubs = new Set<() => void>()
export function confirmAction(o: Omit<Ask, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => {
    ask = { ...o, resolve }
    askSubs.forEach((f) => f())
  })
}
export function ConfirmHost() {
  const a = useSyncExternalStore((f) => { askSubs.add(f); return () => askSubs.delete(f) }, () => ask)
  const [typed, setTyped] = useState('')
  useEffect(() => setTyped(''), [a])
  if (!a) return null
  const done = (ok: boolean) => {
    a.resolve(ok)
    ask = null
    askSubs.forEach((f) => f())
  }
  const blocked = !!a.typed && typed.trim().toLowerCase() !== a.typed.toLowerCase()
  return (
    <Modal title={a.title} onClose={() => done(false)} small>
      <div className="confirm-body">{a.body}</div>
      {a.typed && (
        <label className="fld">Type <b>{a.typed}</b> to confirm
          <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
        </label>
      )}
      <div className="modal-actions">
        <button className="b-quiet" onClick={() => done(false)}>Cancel</button>
        <button className={a.danger ? 'b-danger' : 'b-primary'} disabled={blocked} onClick={() => done(true)} autoFocus={!a.typed}>
          {a.confirm}
        </button>
      </div>
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------- modal, drawer, menu
export function Modal({ title, onClose, children, small = false }: { title: string; onClose: () => void; children: ReactNode; small?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${small ? 'small' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="x" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Drawer({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && !ask && onClose()
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])
  return (
    <div className="scrim drawer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={label}>{children}</aside>
    </div>
  )
}

export interface MenuItem { label: string; onClick: () => void; danger?: boolean; hidden?: boolean; sep?: boolean }

export function Menu({ label, items, className = '', children }: { label: string; items: MenuItem[]; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k) }
  }, [open])
  return (
    <div className={`menu ${className}`} ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="menu-btn" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {items.filter((i) => !i.hidden).map((i, k) => (
            <button key={k} role="menuitem" className={`${i.danger ? 'danger' : ''} ${i.sep ? 'sep' : ''}`}
              onClick={() => { setOpen(false); i.onClick() }}>{i.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------------------------------- misc
export function genPassword(n = 12) {
  const a = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const r = crypto.getRandomValues(new Uint32Array(n))
  return Array.from(r, (x) => a[x % a.length]).join('')
}

export async function copy(text: string, what = 'Copied') {
  // navigator.clipboard only exists on https or localhost; over the local network (http://192.168…) fall back
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text)
    else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.cssText = 'position:fixed;left:-9999px;top:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      if (!ok) throw new Error('copy refused')
    }
    toast(`${what} to clipboard`)
  } catch {
    toast('Copy failed: select the text and copy it yourself.', 'bad')
  }
}

/** yyyy-mm-dd for <input type=date>, in local time. */
export function dateInput(t: number) {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** End of the chosen local day. */
export function fromDateInput(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d, 23, 59, 0).getTime()
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}
