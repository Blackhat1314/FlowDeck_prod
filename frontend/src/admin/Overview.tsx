import { useState } from 'react'
import { type AdminUser, Empty, fmtDate, rel, usePoll, useNow } from './ui'
import { ExtendMenu } from './actions'
import { VENUE_NAMES } from './Accuracy'

interface Ov {
  total: number; trial: number; active: number; expired: number; blocked: number; admin: number
  signups_14d: { day: number; signups: number }[]
  logins_24h: number; failed_logins_24h: number
  expiring_48h: AdminUser[]
  online: number; online_frozen: number
  feed: { venue: string; demo: boolean; status: Record<string, string> }
}

export function Overview({ go, openUser }: { go: (hash: string) => void; openUser: (id: number) => void }) {
  const [o, error, reload] = usePoll<Ov>('/api/admin/overview', 10_000)
  const now = useNow(30_000)
  if (error && !o) return <section className="view"><p className="err-line">{error}</p></section>
  if (!o) return <section className="view"><p className="dim">Loading…</p></section>

  const feeds = Object.values(o.feed.status)
  const down = feeds.filter((s) => !['live', 'demo', 'done', 'idle'].includes(s)).length
  const stats: { n: number; label: string; to: string; tone?: string }[] = [
    { n: o.online, label: o.online_frozen ? `online now, ${o.online_frozen} frozen` : 'online now', to: '#/online', tone: 'on' },
    { n: o.trial, label: 'on free trial', to: '#/users?filter=trial' },
    { n: o.active, label: 'paid', to: '#/users?filter=active' },
    { n: o.expired, label: 'trial or plan ended', to: '#/users?filter=expired' },
    { n: o.blocked, label: 'blocked', to: '#/users?filter=blocked' },
    { n: o.total, label: 'accounts in total', to: '#/users' },
  ]
  return (
    <section className="view">
      <header className="view-head">
        <div>
          <h1>Overview</h1>
          <p className="lede">{new Date(now).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        </div>
      </header>

      <div className="stat-band">
        {stats.map((s) => (
          <a key={s.label} href={s.to} className={`stat-cell ${s.tone ?? ''}`} onClick={(e) => { e.preventDefault(); go(s.to) }}>
            <span className="stat-n">{s.n}</span>
            <span className="stat-l">{s.label}</span>
          </a>
        ))}
      </div>

      <div className="ov-grid">
        <div className="panel">
          <h2 className="panel-title">New accounts, last 14 days</h2>
          <SignupChart days={o.signups_14d} />
        </div>

        <div className="panel">
          <h2 className="panel-title">Live access ending in the next 48 hours</h2>
          {o.expiring_48h.length === 0 ? <Empty>Nobody's access ends in the next two days.</Empty> : (
            <ul className="expiring">
              {o.expiring_48h.map((u) => (
                <li key={u.id}>
                  <div>
                    <button className="who-name" onClick={() => openUser(u.id)}>{u.name}</button>
                    <span className="who-mail">{u.email}</span>
                  </div>
                  <span className="until soon">{u.plan === 'trial' ? 'Trial ends' : 'Plan ends'} {rel(u.expires_at, now)}<small>{fmtDate(u.expires_at)}</small></span>
                  <ExtendMenu u={u} onDone={reload} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="ov-foot">
        <p>
          <b>{o.logins_24h}</b> sign-in{o.logins_24h === 1 ? '' : 's'} in the last 24 hours
          {o.failed_logins_24h > 0 && <>, <a href="#/activity" onClick={(e) => { e.preventDefault(); go('#/activity?action=login_failed') }}><b>{o.failed_logins_24h}</b> wrong password{o.failed_logins_24h === 1 ? '' : 's'}</a></>}.
        </p>
        <p>
          Data feed: <b>{VENUE_NAMES[o.feed.venue] ?? o.feed.venue}</b>
          {o.feed.demo ? ', demo mode (simulated market)' : down ? `, ${down} connection${down > 1 ? 's' : ''} reconnecting` : ', all exchange connections live'}.{' '}
          <a href="#/accuracy" onClick={(e) => { e.preventDefault(); go('#/accuracy') }}>Check data accuracy</a>
        </p>
      </div>
    </section>
  )
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

function SignupChart({ days }: { days: { day: number; signups: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 560, H = 190, padL = 28, padB = 26, padT = 12
  const max = Math.max(4, ...days.map((d) => d.signups))
  const step = Math.ceil(max / 4)
  const top = step * 4
  const cw = (W - padL) / days.length
  const bw = Math.max(6, cw - 8)
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top)
  const total = days.reduce((a, d) => a + d.signups, 0)
  const h = hover != null ? days[hover] : null
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`New accounts per day for the last 14 days, ${total} in total`}
        onMouseLeave={() => setHover(null)}>
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={padL} x2={W} y1={y(i * step)} y2={y(i * step)} className={i ? 'grid' : 'base'} />
            <text x={padL - 8} y={y(i * step) + 4} className="tick" textAnchor="end">{i * step}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = padL + i * cw + (cw - bw) / 2
          const yy = y(d.signups)
          const hh = y(0) - yy
          const r = Math.min(4, hh, bw / 2)
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0}
              aria-label={`${dayFmt.format(new Date(d.day))}: ${d.signups} new`}>
              <rect x={padL + i * cw} y={padT} width={cw} height={H - padT - padB} fill="transparent" />
              {d.signups > 0 && (
                <path className={`bar ${hover === i ? 'hot' : ''}`}
                  d={`M${x},${y(0)} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${y(0)} Z`} />
              )}
              {(i % 2 === days.length % 2 || i === days.length - 1) && (
                <text x={x + bw / 2} y={H - 8} className="tick" textAnchor="middle">{new Date(d.day).getDate()}</text>
              )}
            </g>
          )
        })}
      </svg>
      <figcaption>
        {h ? <><b>{h.signups}</b> new on {dayFmt.format(new Date(h.day))}</> : <><b>{total}</b> new accounts in 14 days. Hover a day for its count.</>}
      </figcaption>
    </figure>
  )
}
