import { act, adminApi, type Conn, device, Empty, initials, rel, span, usePoll, useNow } from './ui'

interface Sess { id: number; user_id: number; created_at: number; last_seen_at: number; ip: string; ua: string; email: string; name: string; role: string }

export function Online({ me, openUser }: { me: number; openUser: (id: number) => void }) {
  const [d, error, reload] = usePoll<{ connections: Conn[]; sessions: Sess[] }>('/api/admin/online', 5000)
  const now = useNow(1000)
  const conns = d?.connections ?? []
  const open = new Set(conns.map((c) => c.session_id))
  const idle = (d?.sessions ?? []).filter((s) => !open.has(s.id))
  const users = new Set(conns.map((c) => c.user_id)).size
  const frozen = conns.filter((c) => !c.live).length

  const kick = async (sid: number, who: string) => {
    if (await act(() => adminApi(`/api/admin/sessions/${sid}/revoke`, { body: {} }), `${who} was signed out`)) reload()
  }

  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Online now</h1>
          <p className="lede">
            {d ? `${users} ${users === 1 ? 'person' : 'people'} with the dashboard open${frozen ? `, ${frozen} on a frozen snapshot` : ''}. Updates every 5 seconds.` : 'Loading…'}
          </p>
        </div>
      </header>
      {error && <p className="err-line">{error}</p>}

      <div className="panel">
        <h2 className="panel-title">Dashboard open</h2>
        {d && conns.length === 0 && <Empty>Nobody has the dashboard open right now.</Empty>}
        {conns.length > 0 && (
          <ul className="conns">
            {conns.map((c) => (
              <li key={`${c.session_id}-${c.since}`}>
                <span className="ava on" aria-hidden>{initials(c.name)}</span>
                <div className="c-who">
                  <button className="who-name" onClick={() => openUser(c.user_id)}>{c.name}</button>
                  <span className="who-mail">{c.email}</span>
                </div>
                <div className="c-dev">
                  <span>{device(c.ua)}</span>
                  <span className="dim">{c.ip}</span>
                </div>
                <div className="c-time">
                  <span className={c.live ? 'live-tag' : 'frozen-tag'}>{c.live ? 'Live' : 'Frozen'}</span>
                  <span className="dim">for {span(now - c.since)}</span>
                </div>
                {c.user_id !== me ? <button className="b-quiet small" onClick={() => kick(c.session_id, c.name)}>Sign out</button> : <span className="you">you</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="panel">
        <h2 className="panel-title">Signed in, dashboard closed</h2>
        <p className="panel-note">These devices can open the dashboard without a password. Each account has at most one.</p>
        {d && idle.length === 0 && <Empty>No other signed-in devices.</Empty>}
        {idle.length > 0 && (
          <ul className="conns">
            {idle.map((s) => (
              <li key={s.id}>
                <span className="ava" aria-hidden>{initials(s.name)}</span>
                <div className="c-who">
                  <button className="who-name" onClick={() => openUser(s.user_id)}>{s.name}</button>
                  <span className="who-mail">{s.email}</span>
                </div>
                <div className="c-dev">
                  <span>{device(s.ua)}</span>
                  <span className="dim">{s.ip}</span>
                </div>
                <div className="c-time">
                  <span className="dim">active {rel(s.last_seen_at, now)}</span>
                  <span className="dim">signed in {rel(s.created_at, now)}</span>
                </div>
                {s.user_id !== me ? <button className="b-quiet small" onClick={() => kick(s.id, s.name)}>Sign out</button> : <span className="you">you</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
