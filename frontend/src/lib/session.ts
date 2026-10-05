// Signed-in user, plan and the small JSON API helper shared by the dashboard, sign-in and admin pages.

export interface PublicConfig {
  trial_days: number
  price_label: string
  price_inr: string
  contact_email: string
  signups_open: boolean
  upgrade_note: string
  /** OAuth client ID for "Sign in with Google"; null when the server has it switched off */
  google_client_id?: string | null
  /** Razorpay checkout is set up on the server (and whether it uses test keys) */
  payments_enabled?: boolean
  payments_test?: boolean
  /** days of access one payment buys */
  plan_days?: number
}

export interface MeUser {
  id: number
  name: string
  email: string
  role: 'user' | 'admin'
  plan: 'trial' | 'paid'
  expires_at: number | null
  state: 'trial' | 'active' | 'expired' | 'blocked' | 'admin'
  created_at: number
  /** signed in with Google at least once */
  google?: boolean
  /** false for accounts made with Google that never set a password */
  has_password?: boolean
}

export interface Me {
  user: MeUser
  live: boolean
  server_time: number
  config: PublicConfig
}

export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(opts.body ?? {}),
  })
  let d: any = null
  try {
    d = await r.json()
  } catch {
    /* empty body */
  }
  if (!r.ok) throw new ApiError(d?.error ?? 'error', d?.message ?? `Request failed (${r.status})`, r.status)
  return d as T
}

/** Reasons a session can end, as shown to the user. */
export const REASONS: Record<string, string> = {
  replaced: 'Your account was signed in on another device, so this one was signed out. Only one device can use an account at a time.',
  blocked: 'This account has been blocked. Contact support if you think this is a mistake.',
  deleted: 'This account no longer exists.',
  admin_logout: 'You were signed out by an administrator.',
  session_expired: 'Your session has expired. Please sign in again.',
  logout: 'You signed out.',
  revoked: 'Your session ended. Please sign in again.',
  no_session: 'Please sign in to continue.',
  other_tab: 'Flowdeck is open in another tab or window with this account. Only one can stream at a time.',
}

export const CLOSE_REASONS: Record<number, string> = {
  4401: 'session_expired', 4403: 'blocked', 4404: 'deleted', 4409: 'replaced', 4410: 'admin_logout', 4411: 'other_tab',
}

export function loginUrl(next = location.pathname, reason?: string) {
  const q = new URLSearchParams({ next })
  if (reason && reason !== 'no_session') q.set('reason', reason)
  return `/login?${q}`
}

export async function logout() {
  try {
    await api('/api/auth/logout', { body: {} })
  } finally {
    location.href = '/login'
  }
}

export function timeLeft(ms: number) {
  if (ms <= 0) return 'ended'
  const d = Math.floor(ms / 86_400_000)
  const h = Math.floor((ms % 86_400_000) / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (d >= 1) return `${d}d ${h}h`
  if (h >= 1) return `${h}h ${m}m`
  return `${Math.max(1, m)}m`
}

export function mailLink(to: string, subject: string, body: string) {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
