"""Account emails over SMTP (password reset, new sign-in alerts, password changed). Standard library only.

Settings (environment or backend/.env):
    SMTP_HOST, SMTP_PORT (587 = STARTTLS, 465 = TLS), SMTP_USER, SMTP_PASSWORD
    MAIL_FROM            "Flowdeck <no-reply@flowdeck.site>"; the address must belong to a domain the provider verified
    FLOWDECK_SITE_URL    https://flowdeck.site, the address put in email links. It is never taken from the request,
                         so a forged Host header can't send someone a reset link that points to another site.
    FLOWDECK_MAIL_DAILY_LIMIT   stop sending after this many emails per UTC day (default 90; Resend's free plan
                         allows 100). Sign-in alerts stop at 80 % of it so password resets always have room.
    FLOWDECK_MAIL_TZ     time zone for times written in emails (default Asia/Kolkata)
    SMTP_SECURITY        "starttls" (default for ports other than 465), "tls", or "none" (only for a local test server)
"""
from __future__ import annotations

import html
import logging
import os
import re
import smtplib
import ssl
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid, parseaddr

log = logging.getLogger("flow.mail")
DAY = 86_400_000


def _ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


class MailError(Exception):
    pass


class Mailer:
    def __init__(self, host: str = "", port: int = 587, user: str = "", password: str = "", sender: str = "",
                 site_url: str = "", daily_limit: int = 90, tz: str = "Asia/Kolkata", security: str = "", timeout: float = 20):
        self.host = host.strip()
        self.port = int(port or 587)
        self.user = user.strip()
        self.password = password
        self.sender = sender.strip()
        self.site_url = site_url.strip().rstrip("/")
        self.daily_limit = max(1, int(daily_limit or 90))
        self.tz = tz
        self.security = (security or ("tls" if self.port == 465 else "starttls")).lower()
        self.timeout = timeout
        self.sent_day = ""
        self.sent_today = 0
        self.last_error = ""
        self.last_ok_at = 0
        self.pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="mail")

    @classmethod
    def from_env(cls) -> "Mailer":
        e = os.environ.get
        try:
            port = int(e("SMTP_PORT", "587") or 587)
        except ValueError:
            port = 587
        try:
            limit = int(e("FLOWDECK_MAIL_DAILY_LIMIT", "90") or 90)
        except ValueError:
            limit = 90
        return cls(e("SMTP_HOST", ""), port, e("SMTP_USER", ""), e("SMTP_PASSWORD", ""), e("MAIL_FROM", ""),
                   e("FLOWDECK_SITE_URL", ""), limit, e("FLOWDECK_MAIL_TZ", "Asia/Kolkata") or "Asia/Kolkata",
                   e("SMTP_SECURITY", ""))

    # ------------------------------------------------------------------------------------------- status
    def problems(self) -> list[str]:
        out = []
        if not self.host:
            out.append("SMTP_HOST is not set")
        name, addr = parseaddr(self.sender)
        if not addr or "@" not in addr:
            out.append("MAIL_FROM is not set (for example: Flowdeck <no-reply@flowdeck.site>)")
        if not re.match(r"^https?://[^/\s]+$", self.site_url):
            out.append("FLOWDECK_SITE_URL is not set (for example: https://flowdeck.site)")
        if self.security not in ("starttls", "tls", "none"):
            out.append("SMTP_SECURITY must be starttls, tls or none")
        return out

    @property
    def enabled(self) -> bool:
        return not self.problems()

    def status(self) -> dict:
        self._roll()
        return {"enabled": self.enabled, "problems": self.problems(), "host": self.host, "port": self.port,
                "security": self.security, "user": self.user, "sender": self.sender, "site_url": self.site_url,
                "sent_today": self.sent_today, "daily_limit": self.daily_limit, "last_error": self.last_error,
                "last_ok_at": self.last_ok_at}

    def link(self, path: str) -> str:
        return self.site_url + path

    def _roll(self):
        day = time.strftime("%Y-%m-%d", time.gmtime())
        if day != self.sent_day:
            self.sent_day, self.sent_today = day, 0

    def budget_ok(self, kind: str) -> bool:
        """Room left today. Alerts give way to password emails well before the provider's limit."""
        self._roll()
        cap = self.daily_limit if kind != "alert" else int(self.daily_limit * 0.8)
        return self.sent_today < cap

    # ------------------------------------------------------------------------------------------- sending
    def build(self, to: str, subject: str, text: str, body_html: str, reply_to: str = "") -> EmailMessage:
        m = EmailMessage()
        m["From"] = self.sender
        m["To"] = to
        m["Subject"] = subject
        m["Date"] = formatdate(localtime=False)
        domain = parseaddr(self.sender)[1].rsplit("@", 1)[-1] or "flowdeck.local"
        m["Message-ID"] = make_msgid(domain=domain)
        if reply_to:
            m["Reply-To"] = reply_to
        m["Auto-Submitted"] = "auto-generated"
        m.set_content(text)
        m.add_alternative(body_html, subtype="html")
        return m

    def send(self, msg: EmailMessage):
        """Send now (blocking). Raises MailError with a short, readable reason."""
        if not self.enabled:
            raise MailError("Email isn't set up: " + "; ".join(self.problems()))
        try:
            if self.security == "tls":
                s = smtplib.SMTP_SSL(self.host, self.port, timeout=self.timeout, context=_ssl_context())
            else:
                s = smtplib.SMTP(self.host, self.port, timeout=self.timeout)
            with s:
                s.ehlo()
                if self.security == "starttls":
                    s.starttls(context=_ssl_context())
                    s.ehlo()
                if self.user:
                    s.login(self.user, self.password)
                s.send_message(msg)
        except smtplib.SMTPAuthenticationError:
            raise MailError("The SMTP server refused the username or password (check SMTP_USER and SMTP_PASSWORD).")
        except smtplib.SMTPSenderRefused as e:
            raise MailError(f"The SMTP server refused the sender {self.sender!r}: {_short(e.smtp_error)} "
                            "(is the domain verified with your email provider?)")
        except smtplib.SMTPRecipientsRefused:
            raise MailError("The SMTP server refused the recipient address.")
        except smtplib.SMTPException as e:
            raise MailError(f"SMTP error: {_short(str(e))}")
        except (OSError, ssl.SSLError) as e:   # DNS, refused or blocked port, timeout, TLS
            raise MailError(f"Couldn't connect to {self.host}:{self.port} ({_short(str(e)) or type(e).__name__}). "
                            "If the port is blocked, try 587, 465 or 2587.")
        self._roll()
        self.sent_today += 1
        self.last_ok_at = int(time.time() * 1000)
        self.last_error = ""

    def send_later(self, kind: str, to: str, subject: str, text: str, body_html: str, reply_to: str = "") -> bool:
        """Queue an email in the background (the request doesn't wait, and its timing says nothing about whether
        an account exists). False when email is off or today's budget is used up."""
        if not self.enabled:
            return False
        if not self.budget_ok(kind):
            log.warning("mail: daily limit reached, %s email to %s skipped", kind, _mask(to))
            return False
        msg = self.build(to, subject, text, body_html, reply_to)

        def run():   # on a mail thread: a slow or unreachable SMTP server never holds up the web server
            for attempt in range(2):
                try:
                    self.send(msg)
                    log.info("mail: %s email sent to %s", kind, _mask(to))
                    return
                except MailError as e:
                    self.last_error = str(e)
                    log.warning("mail: %s email to %s failed (attempt %d): %s", kind, _mask(to), attempt + 1, e)
                    if attempt == 0:
                        time.sleep(5)
                except Exception:
                    log.exception("mail: %s email to %s failed", kind, _mask(to))
                    return
        self.pool.submit(run)
        return True

    # ------------------------------------------------------------------------------------------- formatting
    def when(self, t_ms: int) -> str:
        utc = datetime.fromtimestamp(t_ms / 1000, tz=timezone.utc)
        try:
            from zoneinfo import ZoneInfo
            z = ZoneInfo(self.tz)
            local = utc.astimezone(z)
            return f"{local:%d %b %Y, %H:%M} {local.tzname()} ({utc:%H:%M} UTC)"
        except Exception:
            return f"{utc:%d %b %Y, %H:%M} UTC"


def _short(s) -> str:
    if isinstance(s, bytes):
        s = s.decode(errors="replace")
    return re.sub(r"\s+", " ", str(s)).strip()[:200]


def _mask(email: str) -> str:
    name, _, dom = email.partition("@")
    return (name[:2] + "***@" + dom) if dom else "***"


def mask_email(email: str) -> str:
    """m***k@gmail.com: enough for the owner to recognise, not enough to read off a stranger's address."""
    name, _, dom = email.partition("@")
    if len(name) <= 2:
        return name[:1] + "***@" + dom
    return name[0] + "***" + name[-1] + "@" + dom


def device_label(ua: str | None) -> str:
    """'Chrome on Windows' from a User-Agent string (good enough for an alert; never used for security)."""
    ua = ua or ""
    if "Edg/" in ua:
        b = "Edge"
    elif "OPR/" in ua or "Opera" in ua:
        b = "Opera"
    elif "SamsungBrowser" in ua:
        b = "Samsung Internet"
    elif "Firefox/" in ua or "FxiOS" in ua:
        b = "Firefox"
    elif "Chrome/" in ua or "CriOS" in ua:
        b = "Chrome"
    elif "Safari/" in ua:
        b = "Safari"
    else:
        b = "A browser"
    if "Android" in ua:
        o = "Android"
    elif "iPhone" in ua or "iPad" in ua:
        o = "iPhone" if "iPhone" in ua else "iPad"
    elif "Windows" in ua:
        o = "Windows"
    elif "Mac OS X" in ua or "Macintosh" in ua:
        o = "Mac"
    elif "CrOS" in ua:
        o = "ChromeOS"
    elif "Linux" in ua:
        o = "Linux"
    else:
        o = ""
    return f"{b} on {o}" if o else b


# =============================================================================================== templates
def _page(title: str, intro_html: str, button: tuple[str, str] | None, rows: list[tuple[str, str]], foot_html: str) -> str:
    """One simple, light email layout: works in Gmail, Outlook and phone mail apps (tables, inline styles)."""
    rows_html = "".join(
        f'<tr><td style="padding:6px 0;color:#5b6472;font-size:14px;width:120px;vertical-align:top">{html.escape(k)}</td>'
        f'<td style="padding:6px 0;color:#111827;font-size:14px">{html.escape(v)}</td></tr>' for k, v in rows)
    btn = ""
    if button:
        label, url = button
        btn = (f'<p style="margin:26px 0"><a href="{html.escape(url)}" style="display:inline-block;background:#111827;color:#ffffff;'
               f'text-decoration:none;font-weight:600;font-size:15px;padding:13px 22px;border-radius:999px">{html.escape(label)}</a></p>'
               f'<p style="margin:0 0 20px;color:#5b6472;font-size:13px;line-height:1.5">If the button doesn\'t work, copy this link into your browser:<br>'
               f'<a href="{html.escape(url)}" style="color:#1d4ed8;word-break:break-all">{html.escape(url)}</a></p>')
    table = f'<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 6px">{rows_html}</table>' if rows else ""
    return f"""<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<tr><td style="height:5px;background:linear-gradient(90deg,#2f7bff,#56d6ff,#ffb547,#ff3a34);background-color:#2f7bff"></td></tr>
<tr><td style="padding:28px 32px 30px">
<p style="margin:0 0 22px;font-weight:800;font-size:18px;letter-spacing:-0.02em;color:#111827">Flowdeck</p>
<h1 style="margin:0 0 14px;font-size:22px;line-height:1.25;color:#111827;font-weight:700">{html.escape(title)}</h1>
<div style="color:#1f2937;font-size:15px;line-height:1.6">{intro_html}</div>
{table}{btn}
<div style="margin-top:22px;padding-top:16px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12.5px;line-height:1.55">{foot_html}</div>
</td></tr></table></td></tr></table></body></html>"""


def reset_email(m: Mailer, name: str, link: str, minutes: int, ip: str, ua: str, t_ms: int, has_password: bool):
    action = "reset your password" if has_password else "set a password"
    subject = "Reset your Flowdeck password" if has_password else "Set a password for Flowdeck"
    device = device_label(ua)
    text = (f"Hi {name},\n\nSomeone (hopefully you) asked to {action} for your Flowdeck account.\n\n"
            f"Open this link to choose a new password. It works once and expires in {minutes} minutes:\n{link}\n\n"
            f"Requested: {m.when(t_ms)} from {device}, IP {ip}\n\n"
            "If you didn't ask for this, ignore this email. Your password stays the same.\n\n- Flowdeck\n")
    body_html = _page(subject,
                      f"<p style='margin:0'>Hi {html.escape(name)},</p><p style='margin:12px 0 0'>Someone (hopefully you) asked to "
                      f"{action} for your Flowdeck account. The link works once and expires in {minutes} minutes.</p>",
                      ("Choose a new password", link),
                      [("Requested", m.when(t_ms)), ("Device", device), ("IP address", ip)],
                      "If you didn't ask for this, ignore this email. Your password stays the same and nobody can change "
                      "it without this link.")
    return subject, text, body_html


def changed_email(m: Mailer, name: str, how: str, ip: str, ua: str, t_ms: int, forgot_link: str):
    subject = "Your Flowdeck password was changed"
    device = device_label(ua)
    text = (f"Hi {name},\n\nThe password for your Flowdeck account was {how}. Every other device was signed out.\n\n"
            f"When: {m.when(t_ms)}\nDevice: {device}\nIP address: {ip}\n\n"
            f"If this wasn't you, reset your password now: {forgot_link}\n\n- Flowdeck\n")
    body_html = _page(subject,
                      f"<p style='margin:0'>Hi {html.escape(name)},</p><p style='margin:12px 0 0'>The password for your Flowdeck "
                      f"account was {html.escape(how)}. Every other device was signed out.</p>",
                      None, [("When", m.when(t_ms)), ("Device", device), ("IP address", ip)],
                      f"If this wasn't you, <a href='{html.escape(forgot_link)}' style='color:#1d4ed8'>reset your password now</a> "
                      "and check the email account this message came to.")
    return subject, text, body_html


def signin_email(m: Mailer, name: str, via: str, ip: str, ua: str, t_ms: int, forgot_link: str):
    subject = "New sign-in to your Flowdeck account"
    device = device_label(ua)
    text = (f"Hi {name},\n\nYour Flowdeck account was just signed in on a device it hasn't used before.\n\n"
            f"When: {m.when(t_ms)}\nDevice: {device}\nIP address: {ip}\nSigned in with: {via}\n\n"
            "If this was you, there's nothing to do.\n"
            f"If it wasn't, reset your password now: {forgot_link}\n\n- Flowdeck\n")
    body_html = _page(subject,
                      f"<p style='margin:0'>Hi {html.escape(name)},</p><p style='margin:12px 0 0'>Your Flowdeck account was just "
                      "signed in on a device it hasn't used before.</p>",
                      None, [("When", m.when(t_ms)), ("Device", device), ("IP address", ip), ("Signed in with", via)],
                      "If this was you, there's nothing to do. If it wasn't, "
                      f"<a href='{html.escape(forgot_link)}' style='color:#1d4ed8'>reset your password now</a>. "
                      "Only one device can use an account at a time, so resetting signs the other device out.")
    return subject, text, body_html


def code_email(m: Mailer, name: str, code: str, minutes: int):
    subject = f"{code} is your Flowdeck code"
    text = (f"Hi {name},\n\nYour Flowdeck code is {code}\n\nType it on the sign-up page to confirm your email and start "
            f"your free trial. It expires in {minutes} minutes.\n\n"
            "If you didn't try to create a Flowdeck account, ignore this email. Nothing is created without this code.\n\n- Flowdeck\n")
    digits = "".join(f'<span style="display:inline-block;width:38px;margin:0 3px;padding:10px 0;border:1px solid #d1d5db;'
                     f'border-radius:10px;text-align:center;font:700 26px/1 ui-monospace,Menlo,Consolas,monospace;color:#111827">{d}</span>'
                     for d in code)
    body_html = _page("Confirm your email",
                      f"<p style='margin:0'>Hi {html.escape(name)},</p><p style='margin:12px 0 0'>Type this code on the sign-up "
                      f"page to confirm your email and start your free trial. It expires in {minutes} minutes.</p>"
                      f"<p style='margin:22px 0 4px'>{digits}</p>",
                      None, [], "If you didn't try to create a Flowdeck account, ignore this email. Nothing is created "
                                "without this code.")
    return subject, text, body_html


def test_email(m: Mailer, t_ms: int):
    subject = "Flowdeck test email"
    text = f"Email from your Flowdeck server works.\n\nSent {m.when(t_ms)} through {m.host}:{m.port}.\n"
    body_html = _page("Email works", f"<p style='margin:0'>This test came from your Flowdeck server through "
                                     f"{html.escape(m.host)}:{m.port}.</p>", None, [("Sent", m.when(t_ms))],
                      "Password reset links and new sign-in alerts will arrive the same way.")
    return subject, text, body_html
