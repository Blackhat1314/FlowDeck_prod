import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import './page.css'
import { api, mailLink, type PublicConfig } from '../lib/session'

// /privacy and /terms. The contact line and trial/price come from the site settings in the admin panel.
const UPDATED = '6 October 2026'
type Doc = 'privacy' | 'terms'

function Contact({ cfg }: { cfg: PublicConfig | null }) {
  const mail = cfg?.contact_email
  if (!mail) return <>through the contact details on the Flowdeck home page</>
  return <>by email at <a href={mailLink(mail, 'Flowdeck account', '')}>{mail}</a></>
}

function Privacy({ cfg }: { cfg: PublicConfig | null }) {
  return (
    <article className="legal">
      <h1>Privacy policy</h1>
      <p className="updated">Last updated {UPDATED}</p>
      <p className="lead">Flowdeck collects only what it needs to run your account. It doesn't sell your data, show ads or use tracking tools.</p>

      <h2>What we collect</h2>
      <ul>
        <li><b>Your account:</b> your name and email address. If you use a password, we store only a scrambled form of it (a scrypt hash), never the password itself.</li>
        <li><b>If you sign in with Google:</b> Google shares your name, email address and Google account ID with us. We don't receive your Google password and can't see your Gmail, Drive, contacts or anything else in your Google account.</li>
        <li><b>Sign-ins and security:</b> your IP address, browser type, and the times you sign in and use the dashboard. We also keep a log of account events, such as sign-ins, failed sign-in attempts and plan changes.</li>
        <li><b>Payments:</b> payments are handled by <a href="https://razorpay.com/privacy/" target="_blank" rel="noopener noreferrer">Razorpay</a>. Your card, UPI or bank details go to Razorpay, never to us. We keep the payment's order and payment IDs, the amount and the date with your account, so we can extend your access and answer questions about it.</li>
        <li><b>Your chart settings</b> are saved in your own browser and aren't sent to us.</li>
      </ul>

      <h2>Cookies</h2>
      <p>We use two cookies. <b>fd_session</b> keeps you signed in for up to 30 days. <b>fd_device</b> is a random ID for your browser, kept for about a year, so we can email you when your account signs in from a device it hasn't used before. There are no advertising or analytics cookies. The &ldquo;Sign in with Google&rdquo; button on the sign-in page is loaded from Google, and Google's <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">privacy policy</a> covers what it does.</p>

      <h2>How we use it</h2>
      <ul>
        <li>To create and run your account, including your free trial and paid access.</li>
        <li>To keep each account to one device at a time and to protect accounts from misuse.</li>
        <li>To contact you about your account or a payment.</li>
        <li>To email you account messages: password reset links, a note when your password changes, and an alert when your account signs in from a new device. We don't send newsletters or marketing.</li>
      </ul>

      <h2>Who else sees it</h2>
      <p>No one we sell or rent it to. Your data is stored on servers we rent from Google Cloud in Mumbai, India. When you pay, Razorpay processes the payment and sees your name, email and payment details. Account emails are delivered by our email provider, which sees your email address and the message. We'll share data with authorities only when the law requires it.</p>

      <h2>How long we keep it</h2>
      <p>We keep your account details while your account exists. When you ask us to delete your account, we remove your profile and sign-in sessions. Entries in the security log that mention your email may be kept to protect the service.</p>

      <h2>Your choices</h2>
      <ul>
        <li>To see, correct or delete your data, contact us <Contact cfg={cfg} />.</li>
        <li>You can change or set your password from the account menu in the dashboard.</li>
        <li>You can remove Flowdeck's access to your Google account at <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener noreferrer">myaccount.google.com/permissions</a>. This doesn't delete your Flowdeck account.</li>
      </ul>

      <h2>Security</h2>
      <p>The site is served only over HTTPS. Passwords are stored as hashes, and sign-in tokens are stored only in hashed form.</p>

      <h2>Age</h2>
      <p>Flowdeck is for people aged 18 and over.</p>

      <h2>Changes</h2>
      <p>If this policy changes, we'll update this page and the date at the top.</p>
      <p className="legal-foot">Questions about privacy? Contact us <Contact cfg={cfg} />.</p>
    </article>
  )
}

function Terms({ cfg }: { cfg: PublicConfig | null }) {
  const days = cfg?.trial_days ?? 3
  return (
    <article className="legal">
      <h1>Terms of service</h1>
      <p className="updated">Last updated {UPDATED}</p>
      <p className="lead">These terms cover your use of Flowdeck at flowdeck.site. By creating an account or signing in, you agree to them.</p>

      <h2>What Flowdeck is</h2>
      <p>Flowdeck shows live order-flow views of the Bitcoin perpetual, built from the public market data of Binance, Bybit, OKX, Coinbase and Deribit. Flowdeck isn't affiliated with any of these exchanges. Their data can arrive late, be incomplete or be wrong, and a feed can stop without warning.</p>

      <h2>Not financial advice</h2>
      <p>Nothing on Flowdeck is investment, financial or trading advice. Trading crypto derivatives carries a high risk of loss. You alone are responsible for your trading decisions and their results.</p>

      <h2>Your account</h2>
      <ul>
        <li>You must be 18 or older and give a real email address.</li>
        <li>An account is for one person. It can be used on one device at a time: signing in on another device signs out the first.</li>
        <li>Keep your password and Google account secure. You're responsible for activity on your account.</li>
      </ul>

      <h2>Free trial and payment</h2>
      <ul>
        <li>New accounts get a free trial of {days} {days === 1 ? 'day' : 'days'} with full access. No card is needed.</li>
        <li>After the trial, live data needs a paid plan{cfg?.price_label ? <> ({cfg.price_label})</> : null}. You pay from the dashboard through Razorpay (UPI, card or net banking). Each payment adds {cfg?.plan_days ?? 30} days of access, starting as soon as the payment goes through, or on top of any time you have left.</li>
        <li>When access ends, the dashboard shows a frozen snapshot until you renew.</li>
        <li>For questions about a payment or a refund, contact us <Contact cfg={cfg} />.</li>
      </ul>

      <h2>Fair use</h2>
      <p>Don't share your account, resell or redistribute Flowdeck's data, scrape the site, or try to break, overload or get around its security. We may suspend or close accounts that do.</p>

      <h2>Changes and availability</h2>
      <p>We aim to keep Flowdeck running around the clock but can't promise it will always be available or error-free. We may change, add or remove features. If we change these terms in a way that matters, we'll update this page and the date at the top.</p>

      <h2>Liability</h2>
      <p>Flowdeck is provided &ldquo;as is&rdquo;. As far as the law allows, we aren't liable for trading losses or for indirect or consequential losses. Our total liability to you is limited to the amount you paid us in the three months before the claim.</p>

      <h2>Law</h2>
      <p>These terms are governed by the laws of India.</p>
      <p className="legal-foot">Questions about these terms? Contact us <Contact cfg={cfg} />.</p>
    </article>
  )
}

function Legal() {
  const doc: Doc = location.pathname.startsWith('/terms') ? 'terms' : 'privacy'
  const [cfg, setCfg] = useState<PublicConfig | null>(null)
  useEffect(() => {
    api<PublicConfig>('/api/public/config').then(setCfg).catch(() => {})
    document.title = doc === 'terms' ? 'Terms of service · Flowdeck' : 'Privacy policy · Flowdeck'
    // one HTML file serves both pages: give each its own description and canonical address for search engines
    document.querySelector('meta[name="description"]')?.setAttribute('content', doc === 'terms'
      ? 'The terms for using Flowdeck: the free trial, payment, fair use and why nothing on Flowdeck is financial advice.'
      : 'What Flowdeck collects, including with Sign in with Google, how it is used, and how to have it deleted.')
    const canon = document.querySelector('link[rel="canonical"]') ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'canonical' }))
    canon.setAttribute('href', `https://flowdeck.site/${doc}`)
  }, [doc])
  return (
    <>
      <header className="legal-top">
        <a className="brandmark" href="/">
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden>
            <rect x="3" y="17" width="5" height="12" rx="1.6" fill="#2f7bff" />
            <rect x="10" y="10" width="5" height="19" rx="1.6" fill="#56d6ff" />
            <rect x="17" y="4" width="5" height="25" rx="1.6" fill="#ffb547" />
            <rect x="24" y="12" width="5" height="17" rx="1.6" fill="#ff3a34" />
          </svg>
          Flowdeck
        </a>
        <nav className="legal-switch" aria-label="Legal pages">
          <a href="/privacy" aria-current={doc === 'privacy' ? 'page' : undefined}>Privacy</a>
          <a href="/terms" aria-current={doc === 'terms' ? 'page' : undefined}>Terms</a>
        </nav>
      </header>
      <main>{doc === 'terms' ? <Terms cfg={cfg} /> : <Privacy cfg={cfg} />}</main>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Legal />)
