// User actions shared by the users table, the user drawer and the overview.
import { useState } from 'react'
import { act, adminApi, type AdminUser, confirmAction, copy, DAY, fmtDate, fromDateInput, dateInput, genPassword, Menu, Modal, toast } from './ui'

export async function extendBy(u: AdminUser, days: number) {
  const r = await act(() => adminApi<AdminUser>(`/api/admin/users/${u.id}/extend`, { body: { days } }))
  if (r) toast(`${u.name}: access until ${fmtDate(r.expires_at)}`)
  return r
}

export async function extendUntil(u: AdminUser, until: number) {
  return act(() => adminApi<AdminUser>(`/api/admin/users/${u.id}/extend`, { body: { until } }), `${u.name}: access until ${fmtDate(until)}`)
}

export async function noExpiry(u: AdminUser) {
  const ok = await confirmAction({
    title: 'Remove the end date?',
    body: <p><b>{u.name}</b> keeps live access with no end date until you set one again.</p>,
    confirm: 'Give lifetime access',
  })
  if (!ok) return null
  return act(() => adminApi<AdminUser>(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { expires_at: null, plan: 'paid' } }),
    `${u.name} has lifetime access`)
}

export async function endNow(u: AdminUser) {
  const ok = await confirmAction({
    title: 'End access now?',
    body: <p><b>{u.name}</b> drops to the frozen snapshot within a few seconds. They stay signed in.</p>,
    confirm: 'End access', danger: true,
  })
  if (!ok) return null
  return act(() => adminApi<AdminUser>(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { expires_at: Date.now() - 1000 } }),
    `${u.name}'s access ended`)
}

export async function block(u: AdminUser) {
  const ok = await confirmAction({
    title: `Block ${u.name}?`,
    body: <p>They are signed out everywhere right away and can't sign in again until you unblock them.</p>,
    confirm: 'Block account', danger: true,
  })
  if (!ok) return null
  return act(() => adminApi(`/api/admin/users/${u.id}/block`, { body: {} }), `${u.name} is blocked`)
}

export const unblock = (u: AdminUser) => act(() => adminApi(`/api/admin/users/${u.id}/unblock`, { body: {} }), `${u.name} can sign in again`)

export async function signOut(u: AdminUser) {
  const ok = await confirmAction({
    title: `Sign ${u.name} out?`,
    body: <p>Every device signed in to this account is signed out. They can sign in again with their password.</p>,
    confirm: 'Sign out',
  })
  if (!ok) return null
  return act(() => adminApi(`/api/admin/users/${u.id}/logout`, { body: {} }), `${u.name} was signed out`)
}

export async function setRole(u: AdminUser, role: 'user' | 'admin') {
  const ok = await confirmAction(role === 'admin'
    ? { title: `Make ${u.name} an admin?`, body: <p>Admins can see and change every account, the settings and the data feed. Admin accounts never expire.</p>, confirm: 'Make admin', danger: true }
    : { title: `Remove admin rights from ${u.name}?`, body: <p>They become a regular user. Their access end date stays as it is{u.expires_at ? '' : ' (none)'}.</p>, confirm: 'Remove admin rights' })
  if (!ok) return null
  return act(() => adminApi(`/api/admin/users/${u.id}`, { method: 'PATCH', body: { role } }),
    role === 'admin' ? `${u.name} is now an admin` : `${u.name} is now a regular user`)
}

export async function remove(u: AdminUser) {
  const ok = await confirmAction({
    title: `Delete ${u.name}?`,
    body: <p>This removes <b>{u.email}</b>, their sessions and sign-in history. It can't be undone. Blocking keeps the record instead.</p>,
    confirm: 'Delete account', danger: true, typed: 'delete',
  })
  if (!ok) return null
  return act(() => adminApi(`/api/admin/users/${u.id}`, { method: 'DELETE' }), `${u.email} was deleted`)
}

/** Extend button with presets and a date picker. */
export function ExtendMenu({ u, onDone, label = 'Extend' }: { u: AdminUser; onDone: () => void; label?: string }) {
  const [pick, setPick] = useState(false)
  const run = async (p: Promise<unknown>) => { if (await p) onDone() }
  return (
    <>
      <Menu label={`Extend access for ${u.name}`} className="extend" items={[
        { label: '+3 days', onClick: () => run(extendBy(u, 3)) },
        { label: '+7 days', onClick: () => run(extendBy(u, 7)) },
        { label: '+30 days', onClick: () => run(extendBy(u, 30)) },
        { label: '+90 days', onClick: () => run(extendBy(u, 90)) },
        { label: 'Pick a date…', onClick: () => setPick(true), sep: true },
        { label: 'No end date', onClick: () => run(noExpiry(u)), hidden: u.expires_at == null },
        { label: 'End access now', onClick: () => run(endNow(u)), danger: true, hidden: u.state === 'expired' || u.role === 'admin' },
      ]}>{label}</Menu>
      {pick && <DateModal u={u} onClose={() => setPick(false)} onDone={onDone} />}
    </>
  )
}

function DateModal({ u, onClose, onDone }: { u: AdminUser; onClose: () => void; onDone: () => void }) {
  const base = Math.max(Date.now(), u.expires_at ?? 0)
  const [d, setD] = useState(dateInput(base + 30 * DAY))
  const t = d ? fromDateInput(d) : 0
  return (
    <Modal title={`Access end date for ${u.name}`} onClose={onClose} small>
      <form className="form" onSubmit={async (e) => {
        e.preventDefault()
        if (await extendUntil(u, t)) { onClose(); onDone() }
      }}>
        <label className="fld">Live data until the end of
          <input type="date" value={d} min={dateInput(Date.now())} onChange={(e) => setD(e.target.value)} required />
        </label>
        <p className="hint">Currently {u.expires_at ? `until ${fmtDate(u.expires_at)}` : 'no end date'}. The account is marked as paid.</p>
        <div className="modal-actions">
          <button type="button" className="b-quiet" onClick={onClose}>Cancel</button>
          <button className="b-primary" disabled={!t || t < Date.now()}>Save date</button>
        </div>
      </form>
    </Modal>
  )
}

/** Set a new password for someone and show it once so it can be shared. */
export function PasswordModal({ u, onClose }: { u: AdminUser; onClose: () => void }) {
  const [pw, setPw] = useState(genPassword())
  const [kick, setKick] = useState(true)
  const [done, setDone] = useState(false)
  const share = `Your Flowdeck password was reset.\nEmail: ${u.email}\nNew password: ${pw}\nSign in: ${location.origin}/login`
  return (
    <Modal title={`New password for ${u.name}`} onClose={onClose} small>
      {done ? (
        <div className="form">
          <p>Password changed. Send these details to {u.name}; they can change the password from their account menu.</p>
          <pre className="share">{share}</pre>
          <div className="modal-actions">
            <button className="b-quiet" onClick={onClose}>Done</button>
            <button className="b-primary" onClick={() => copy(share, 'Sign-in details copied')}>Copy details</button>
          </div>
        </div>
      ) : (
        <form className="form" onSubmit={async (e) => {
          e.preventDefault()
          if (await act(() => adminApi(`/api/admin/users/${u.id}/password`, { body: { password: pw, logout: kick } }))) setDone(true)
        }}>
          <label className="fld">New password
            <span className="inline">
              <input value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required spellCheck={false} />
              <button type="button" className="b-quiet" onClick={() => setPw(genPassword())}>Generate</button>
            </span>
          </label>
          <label className="check"><input type="checkbox" checked={kick} onChange={(e) => setKick(e.target.checked)} /> Sign them out of every device</label>
          <div className="modal-actions">
            <button type="button" className="b-quiet" onClick={onClose}>Cancel</button>
            <button className="b-primary" disabled={pw.length < 8}>Set password</button>
          </div>
        </form>
      )}
    </Modal>
  )
}
