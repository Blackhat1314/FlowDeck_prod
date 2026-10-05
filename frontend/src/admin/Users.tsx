import { useEffect, useMemo, useState } from 'react'
import {
  act, adminApi, type AdminUser, type AuditRow, copy, DAY, Drawer, Empty, fmtDate, genPassword, initials, Menu, Modal,
  rel, StateBadge, usePoll, useNow, device, dateInput, fromDateInput, type UserState,
} from './ui'
import { block, ExtendMenu, PasswordModal, remove, setRole, signOut, unblock } from './actions'
import { AuditList } from './Activity'

type Filter = 'all' | UserState | 'online'
const FILTERS: { k: Filter; label: string }[] = [
  { k: 'all', label: 'Everyone' },
  { k: 'online', label: 'Online' },
  { k: 'trial', label: 'Trial' },
  { k: 'active', label: 'Paid' },
  { k: 'expired', label: 'Expired' },
  { k: 'blocked', label: 'Blocked' },
  { k: 'admin', label: 'Admins' },
]

export function Users({ me, openId, setOpenId }: { me: number; openId: number | null; setOpenId: (id: number | null) => void }) {
  const [users, error, reload] = usePoll<AdminUser[]>('/api/admin/users', 15_000)
  const [q, setQ] = useState('')
  const [f, setF] = useState<Filter>(() => (new URLSearchParams(location.hash.split('?')[1]).get('filter') as Filter) || 'all')
  const [creating, setCreating] = useState(false)
  const [pwFor, setPwFor] = useState<AdminUser | null>(null)
  const now = useNow(30_000)

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0, online: 0, trial: 0, active: 0, expired: 0, blocked: 0, admin: 0 }
    for (const u of users ?? []) {
      c.all++
      c[u.state]++
      if (u.online) c.online++
    }
    return c
  }, [users])

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return (users ?? []).filter((u) =>
      (f === 'all' || (f === 'online' ? u.online : u.state === f)) &&
      (!ql || u.email.includes(ql) || u.name.toLowerCase().includes(ql) || (u.note ?? '').toLowerCase().includes(ql) || (u.last_ip ?? '').includes(ql)))
  }, [users, q, f])

  const open = users?.find((u) => u.id === openId) ?? null

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Users</h1>
          <p className="lede">{users ? `${counts.all} accounts, ${counts.online} online now` : 'Loading accounts…'}</p>
        </div>
        <div className="head-actions">
          <a className="b-quiet" href="/api/admin/users.csv" download>Export CSV</a>
          <button className="b-primary" onClick={() => setCreating(true)}>Add user</button>
        </div>
      </header>

      <div className="toolbar">
        <input className="search" type="search" placeholder="Search name, email, note or IP" value={q} onChange={(e) => setQ(e.target.value)}
          aria-label="Search users" />
        <div className="chips" role="tablist" aria-label="Filter users">
          {FILTERS.map((x) => (
            <button key={x.k} role="tab" aria-selected={f === x.k} onClick={() => setF(x.k)}>
              {x.label} <span className="count">{counts[x.k] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {error && <p className="err-line">{error}</p>}
      {users && rows.length === 0 && (
        <Empty>{q || f !== 'all' ? 'No account matches this search or filter.' : 'No accounts yet. Add one, or share the sign-up link.'}</Empty>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="tbl users">
            <thead>
              <tr>
                <th>Account</th>
                <th>Status</th>
                <th>Live data until</th>
                <th>Last seen</th>
                <th>Joined</th>
                <th><span className="sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id} onClick={() => setOpenId(u.id)} className={u.id === openId ? 'sel' : ''}>
                  <td data-label="Account">
                    <div className="who">
                      <span className={`ava ${u.online ? 'on' : ''}`} aria-hidden>{initials(u.name)}</span>
                      <span>
                        <button className="who-name" onClick={(e) => { e.stopPropagation(); setOpenId(u.id) }}>{u.name}</button>
                        <span className="who-mail">{u.email}{u.google && <span className="who-g" title="Signs in with Google">Google</span>}</span>
                        {u.note && <span className="who-note" title={u.note}>{u.note}</span>}
                      </span>
                    </div>
                  </td>
                  <td data-label="Status"><StateBadge s={u.state} /></td>
                  <td data-label="Live data until">
                    {u.role === 'admin' || u.expires_at == null ? <span className="dim">No end date</span> : (
                      <span className={`until ${u.expires_at < now ? 'past' : u.expires_at - now < DAY ? 'soon' : ''}`}>
                        {fmtDate(u.expires_at)}<small>{u.expires_at < now ? `ended ${rel(u.expires_at, now)}` : rel(u.expires_at, now)}</small>
                      </span>
                    )}
                  </td>
                  <td data-label="Last seen">
                    {u.online ? <span className="online">{u.online_live ? 'Online now' : 'Online, frozen view'}</span>
                      : <span className="dim">{rel(u.last_seen_at, now)}</span>}
                  </td>
                  <td data-label="Joined"><span className="dim">{fmtDate(u.created_at)}</span></td>
                  <td className="row-actions" onClick={(e) => e.stopPropagation()}>
                    {u.role !== 'admin' && <ExtendMenu u={u} onDone={reload} />}
                    <Menu label={`More actions for ${u.name}`} className="more" items={rowItems(u, me, reload, setOpenId, setPwFor)}>
                      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg>
                    </Menu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateUser onClose={() => setCreating(false)} onCreated={(u) => { reload(); setOpenId(u.id) }} />}
      {pwFor && <PasswordModal u={pwFor} onClose={() => setPwFor(null)} />}
      {open && <UserDrawer key={open.id} u={open} me={me} onClose={() => setOpenId(null)} reload={reload} onPassword={() => setPwFor(open)} />}
    </section>
  )
}

function rowItems(u: AdminUser, me: number, reload: () => void, setOpenId: (n: number | null) => void, setPwFor: (u: AdminUser) => void) {
  const run = async (p: Promise<unknown>) => { if (await p) reload() }
  const self = u.id === me
  return [
    { label: 'Open details', onClick: () => setOpenId(u.id) },
    { label: 'Set a new password', onClick: () => setPwFor(u) },
    { label: 'Sign out of all devices', onClick: () => run(signOut(u)), hidden: self },
    { label: u.status === 'blocked' ? 'Unblock' : 'Block', onClick: () => run(u.status === 'blocked' ? unblock(u) : block(u)), hidden: self, sep: true },
    { label: u.role === 'admin' ? 'Remove admin rights' : 'Make admin', onClick: () => run(setRole(u, u.role === 'admin' ? 'user' : 'admin')), hidden: self },
    { label: 'Delete account', onClick: () => run(remove(u).then((r) => { if (r) setOpenId(null); return r })), danger: true, hidden: self, sep: true },
  ]
}

// ------------------------------------------------------------------------------------------- create
type Access = 'trial' | 'd30' | 'date' | 'none'

function CreateUser({ onClose, onCreated }: { onClose: () => void; onCreated: (u: AdminUser) => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState(genPassword())
  const [role, setRole] = useState<'user' | 'admin'>('user')
  const [access, setAccess] = useState<Access>('d30')
  const [date, setDate] = useState(dateInput(Date.now() + 30 * DAY))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<AdminUser | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const body: Record<string, unknown> = { name, email, password: pw, role }
    if (role === 'user') {
      if (access === 'trial') body.plan = 'trial'
      else if (access === 'd30') body.days = 30
      else if (access === 'date') body.expires_at = fromDateInput(date)
    }
    let u = await act(() => adminApi<AdminUser>('/api/admin/users', { body }))
    if (u && role === 'user' && access === 'none') {
      u = (await act(() => adminApi<AdminUser>(`/api/admin/users/${u!.id}`, { method: 'PATCH', body: { expires_at: null } }))) ?? u
    }
    if (u && note.trim()) await act(() => adminApi(`/api/admin/users/${u!.id}`, { method: 'PATCH', body: { note } }))
    setBusy(false)
    if (u) setMade(u)
  }

  if (made) {
    const share = `Your Flowdeck account is ready.\nSign in: ${location.origin}/login\nEmail: ${made.email}\nPassword: ${pw}`
    return (
      <Modal title="Account created" onClose={() => { onClose(); onCreated(made) }} small>
        <div className="form">
          <p><b>{made.name}</b> can sign in now{made.expires_at ? `, with live data until ${fmtDate(made.expires_at)}` : ''}. The password is shown only this once.</p>
          <pre className="share">{share}</pre>
          <div className="modal-actions">
            <button className="b-quiet" onClick={() => { onClose(); onCreated(made) }}>Done</button>
            <button className="b-primary" onClick={() => copy(share, 'Sign-in details copied')}>Copy details</button>
          </div>
        </div>
      </Modal>
    )
  }

  return (
    <Modal title="Add a user" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="row2">
          <label className="fld">Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoFocus /></label>
          <label className="fld">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        </div>
        <label className="fld">Password
          <span className="inline">
            <input value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required spellCheck={false} autoComplete="off" />
            <button type="button" className="b-quiet" onClick={() => setPw(genPassword())}>Generate</button>
          </span>
        </label>
        <fieldset className="fld">
          <legend>Role</legend>
          <div className="seg">
            <label><input type="radio" name="role" checked={role === 'user'} onChange={() => setRole('user')} /> User</label>
            <label><input type="radio" name="role" checked={role === 'admin'} onChange={() => setRole('admin')} /> Admin</label>
          </div>
        </fieldset>
        {role === 'user' ? (
          <fieldset className="fld">
            <legend>Live data access</legend>
            <div className="seg wrap">
              <label><input type="radio" name="acc" checked={access === 'trial'} onChange={() => setAccess('trial')} /> Free trial</label>
              <label><input type="radio" name="acc" checked={access === 'd30'} onChange={() => setAccess('d30')} /> Paid, 30 days</label>
              <label><input type="radio" name="acc" checked={access === 'date'} onChange={() => setAccess('date')} /> Paid, until a date</label>
              <label><input type="radio" name="acc" checked={access === 'none'} onChange={() => setAccess('none')} /> No end date</label>
            </div>
            {access === 'date' && (
              <input type="date" aria-label="Access end date" value={date} min={dateInput(Date.now())} onChange={(e) => setDate(e.target.value)} required />
            )}
          </fieldset>
        ) : <p className="hint">Admins have every permission in this panel and their access never ends.</p>}
        <label className="fld">Note <small>only admins see this</small>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Paid by UPI on 4 Oct, ref 4471" />
        </label>
        <div className="modal-actions">
          <button type="button" className="b-quiet" onClick={onClose}>Cancel</button>
          <button className="b-primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        </div>
      </form>
    </Modal>
  )
}

// ------------------------------------------------------------------------------------------- details drawer
interface Detail {
  user: AdminUser
  sessions: { id: number; created_at: number; last_seen_at: number; expires_at: number; ip: string; ua: string; revoked_at: number | null; revoke_reason: string | null }[]
  audit: AuditRow[]
  payments?: { id: number; order_id: string; payment_id: string | null; amount: number; currency: string; days: number; status: string; created_at: number; paid_at: number | null }[]
  online: { session_id: number; live: boolean; since: number; ip: string; ua: string }[]
}

const REVOKE: Record<string, string> = {
  replaced: 'Signed in elsewhere', logout: 'Signed out', admin_logout: 'Signed out by admin', blocked: 'Account blocked',
}

function UserDrawer({ u, me, onClose, reload, onPassword }: { u: AdminUser; me: number; onClose: () => void; reload: () => void; onPassword: () => void }) {
  const [d, , reloadD] = usePoll<Detail>(`/api/admin/users/${u.id}`, 10_000)
  const [name, setName] = useState(u.name)
  const [email, setEmail] = useState(u.email)
  const [note, setNote] = useState(u.note ?? '')
  const [saving, setSaving] = useState(false)
  const now = useNow(15_000)
  useEffect(() => { setName(u.name); setEmail(u.email); setNote(u.note ?? '') }, [u.name, u.email, u.note])
  const dirty = name !== u.name || email !== u.email || note !== (u.note ?? '')
  const self = u.id === me
  const both = () => { reload(); reloadD() }
  const run = async (p: Promise<unknown>) => { if (await p) both() }

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const body: Record<string, string> = {}
    if (name !== u.name) body.name = name
    if (email !== u.email) body.email = email
    if (note !== (u.note ?? '')) body.note = note
    if (await act(() => adminApi(`/api/admin/users/${u.id}`, { method: 'PATCH', body }), 'Changes saved')) both()
    setSaving(false)
  }

  const revoke = async (sid: number) => {
    if (await act(() => adminApi(`/api/admin/sessions/${sid}/revoke`, { body: {} }), 'Device signed out')) both()
  }

  const left = u.expires_at != null ? u.expires_at - now : null
  return (
    <Drawer onClose={onClose} label={`Account: ${u.name}`}>
      <div className="dr-head">
        <span className={`ava big ${u.online ? 'on' : ''}`} aria-hidden>{initials(u.name)}</span>
        <div>
          <h2>{u.name}{self && <span className="you">you</span>}</h2>
          <p>{u.email}</p>
        </div>
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className="dr-body">
        <section className="dr-sec access">
          <div className="access-line">
            <StateBadge s={u.state} />
            <span>
              {u.role === 'admin' ? 'Admin: live data with no end date.'
                : u.status === 'blocked' ? 'Blocked: cannot sign in.'
                  : left == null ? 'Live data with no end date.'
                    : left <= 0 ? `Trial or plan ended ${rel(u.expires_at, now)}. Sees a frozen snapshot.`
                      : `${u.plan === 'trial' ? 'Free trial' : 'Paid'}: live data until ${fmtDate(u.expires_at)} (${rel(u.expires_at, now)}).`}
            </span>
          </div>
          <div className="btn-row">
            {u.role !== 'admin' && <ExtendMenu u={u} onDone={both} label="Extend access" />}
            <button className="b-quiet" onClick={onPassword}>Set a new password</button>
            {!self && <button className="b-quiet" onClick={() => run(signOut(u))}>Sign out of all devices</button>}
            {!self && (u.status === 'blocked'
              ? <button className="b-quiet" onClick={() => run(unblock(u))}>Unblock</button>
              : <button className="b-quiet warn" onClick={() => run(block(u))}>Block</button>)}
          </div>
        </section>

        <section className="dr-sec">
          <h3>Devices</h3>
          {!d ? <p className="dim">Loading…</p> : (() => {
            const active = d.sessions.filter((s) => !s.revoked_at && s.expires_at > now)
            const past = d.sessions.filter((s) => s.revoked_at || s.expires_at <= now).slice(0, 6)
            return (
              <>
                {active.length === 0 && <p className="dim">Not signed in anywhere.</p>}
                {active.map((s) => {
                  const on = d.online.find((o) => o.session_id === s.id)
                  return (
                    <div className="dev" key={s.id}>
                      <div>
                        <b>{device(s.ua)}</b>
                        <span className="dim">{s.ip}, signed in {rel(s.created_at, now)}</span>
                        <span className={on ? 'online' : 'dim'}>{on ? (on.live ? 'Watching live now' : 'Open, frozen view') : `Last active ${rel(s.last_seen_at, now)}`}</span>
                      </div>
                      {!self && <button className="b-quiet small" onClick={() => revoke(s.id)}>Sign out</button>}
                    </div>
                  )
                })}
                {past.length > 0 && (
                  <details className="past">
                    <summary>Earlier sign-ins ({past.length})</summary>
                    {past.map((s) => (
                      <div className="dev past" key={s.id}>
                        <div>
                          <b>{device(s.ua)}</b>
                          <span className="dim">{s.ip}, {fmtDate(s.created_at)}</span>
                          <span className="dim">{s.revoked_at ? `${REVOKE[s.revoke_reason ?? ''] ?? 'Ended'} ${rel(s.revoked_at, now)}` : 'Expired'}</span>
                        </div>
                      </div>
                    ))}
                  </details>
                )}
              </>
            )
          })()}
        </section>

        {d?.payments && d.payments.some((p) => p.status === 'paid') && (
          <section className="dr-sec">
            <h3>Payments</h3>
            {d.payments.filter((p) => p.status === 'paid').map((p) => (
              <div className="dev" key={p.id}>
                <div>
                  <b>₹{(p.amount / 100).toLocaleString('en-IN')} · {p.days} days</b>
                  <span className="dim">{fmtDate(p.paid_at ?? p.created_at, true)} via Razorpay</span>
                  <span className="dim mono">{p.payment_id}</span>
                </div>
              </div>
            ))}
          </section>
        )}

        <section className="dr-sec">
          <h3>Profile</h3>
          <form className="form" onSubmit={save}>
            <label className="fld">Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></label>
            <label className="fld">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
            <label className="fld">Admin note<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              placeholder="Payment reference, phone number, anything useful" /></label>
            <dl className="facts">
              <dt>Joined</dt><dd>{fmtDate(u.created_at, true)} {u.created_by === 'google' ? <span className="dim">(signed up with Google)</span>
                : u.created_by !== 'signup' && <span className="dim">(added by {u.created_by === 'admin' ? 'an admin' : u.created_by})</span>}</dd>
              <dt>Signs in with</dt><dd>{u.google ? (u.has_password ? 'Google or password' : 'Google only (no password set)') : 'Email and password'}</dd>
              <dt>Last sign-in</dt><dd>{u.last_login_at ? `${fmtDate(u.last_login_at, true)} from ${u.last_ip ?? 'unknown IP'}` : 'Never'}</dd>
              <dt>Plan</dt><dd>{u.role === 'admin' ? 'Admin' : u.plan === 'trial' ? 'Free trial' : 'Paid'}</dd>
              <dt>Account ID</dt><dd>{u.id}</dd>
            </dl>
            <div className="btn-row">
              <button className="b-primary" disabled={!dirty || saving}>{saving ? 'Saving…' : 'Save changes'}</button>
              {dirty && <button type="button" className="b-quiet" onClick={() => { setName(u.name); setEmail(u.email); setNote(u.note ?? '') }}>Undo</button>}
            </div>
          </form>
        </section>

        <section className="dr-sec">
          <h3>History</h3>
          {d ? <AuditList rows={d.audit.slice(0, 25)} compact /> : <p className="dim">Loading…</p>}
        </section>

        {!self && (
          <section className="dr-sec danger-zone">
            <h3>Admin rights and deletion</h3>
            <div className="btn-row">
              <button className="b-quiet" onClick={() => run(setRole(u, u.role === 'admin' ? 'user' : 'admin'))}>
                {u.role === 'admin' ? 'Remove admin rights' : 'Make admin'}
              </button>
              <button className="b-danger" onClick={async () => { if (await remove(u)) { onClose(); reload() } }}>Delete account</button>
            </div>
          </section>
        )}
      </div>
    </Drawer>
  )
}

