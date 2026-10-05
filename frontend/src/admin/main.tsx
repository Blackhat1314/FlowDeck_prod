import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import '../shared/brand.css'
import './admin.css'
import { api, ApiError, loginUrl, logout, type Me } from '../lib/session'
import { ConfirmHost, initials, Toasts, usePoll } from './ui'
import { Overview } from './Overview'
import { Users } from './Users'
import { Online } from './Online'
import { Activity } from './Activity'
import { Accuracy } from './Accuracy'
import { Settings } from './Settings'

type View = 'overview' | 'users' | 'online' | 'activity' | 'accuracy' | 'settings'
const NAV: { k: View; label: string; icon: string }[] = [
  { k: 'overview', label: 'Overview', icon: 'M3 13h4v8H3zM10 8h4v13h-4zM17 3h4v18h-4z' },
  { k: 'users', label: 'Users', icon: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 10c0-4 3-6 7-6s7 2 7 6M17 11a3 3 0 1 0 0-6M19 15c2 .6 3 2.4 3 5' },
  { k: 'online', label: 'Online now', icon: 'M2 12h4l3-8 4 16 3-8h6' },
  { k: 'activity', label: 'Activity', icon: 'M4 5h16M4 10h16M4 15h10M4 20h7' },
  { k: 'accuracy', label: 'Data accuracy', icon: 'M4 12l5 5L20 6' },
  { k: 'settings', label: 'Settings', icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z' },
]

function parseHash(): View {
  const v = location.hash.replace(/^#\/?/, '').split('?')[0] as View
  return NAV.some((n) => n.k === v) ? v : 'overview'
}

function Admin() {
  const [me, setMe] = useState<Me | null>(null)
  const [hash, setHash] = useState(location.hash)
  const [openId, setOpenId] = useState<number | null>(null)
  const view = parseHash()

  useEffect(() => {
    api<Me>('/api/auth/me')
      .then((m) => (m.user.role === 'admin' ? setMe(m) : (location.href = '/app')))
      .catch((e) => { location.href = loginUrl('/admin', e instanceof ApiError ? e.code : undefined) })
    const h = () => setHash(location.hash)
    window.addEventListener('hashchange', h)
    return () => window.removeEventListener('hashchange', h)
  }, [])
  useEffect(() => {
    document.title = `${NAV.find((n) => n.k === view)?.label} | Flowdeck admin`
    window.scrollTo(0, 0)
  }, [view])

  const [ov] = usePoll<{ online: number; expiring_48h: unknown[] }>(me ? '/api/admin/overview' : null, 15_000)

  const go = (h: string) => { location.hash = h.replace(/^#/, '') }
  const openUser = (id: number) => { setOpenId(id); if (view !== 'users') go('#/users') }

  if (!me) return <div className="boot" aria-busy="true" />
  return (
    <div className="shell">
      <aside className="side">
        <a className="brandmark" href="/">
          <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
            <rect x="3" y="17" width="5" height="12" rx="1" fill="#1c5c7e" />
            <rect x="10" y="10" width="5" height="19" rx="1" fill="#bec4c0" />
            <rect x="17" y="4" width="5" height="25" rx="1" fill="#decc48" />
            <rect x="24" y="12" width="5" height="17" rx="1" fill="#ee281e" />
          </svg>
          Flowdeck <span className="side-tag">admin</span>
        </a>
        <nav aria-label="Admin sections">
          {NAV.map((n) => (
            <a key={n.k} href={`#/${n.k}`} aria-current={view === n.k ? 'page' : undefined}>
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden><path d={n.icon} /></svg>
              <span>{n.label}</span>
              {n.k === 'online' && ov && ov.online > 0 && <span className="pill on">{ov.online}</span>}
              {n.k === 'users' && ov && ov.expiring_48h.length > 0 && <span className="pill" title="Access ending within 48 hours">{ov.expiring_48h.length}</span>}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <a className="b-quiet wide" href="/app">Open the dashboard</a>
          <div className="me">
            <span className="ava" aria-hidden>{initials(me.user.name)}</span>
            <span className="me-txt"><b>{me.user.name}</b><span>{me.user.email}</span></span>
            <button className="linkish" onClick={() => logout()}>Sign out</button>
          </div>
        </div>
      </aside>

      <main className="main" key={view === 'users' ? 'users' : hash}>
        {view === 'overview' && <Overview go={go} openUser={openUser} />}
        {view === 'users' && <Users me={me.user.id} openId={openId} setOpenId={setOpenId} />}
        {view === 'online' && <Online me={me.user.id} openUser={openUser} />}
        {view === 'activity' && <Activity />}
        {view === 'accuracy' && <Accuracy />}
        {view === 'settings' && <Settings />}
      </main>
      <Toasts />
      <ConfirmHost />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Admin />)
