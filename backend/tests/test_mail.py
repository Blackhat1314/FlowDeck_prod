"""Account emails: SMTP sending, password reset by email, password-changed notes and new-device sign-in alerts.

A small SMTP server in a thread stands in for the email provider, so the real smtplib path is exercised."""
import email
import os
import re
import socketserver
import tempfile
import threading
import time
from email import policy

import pytest

TMP = tempfile.mkdtemp(prefix="fd-mail-")
os.environ.setdefault("FLOWDECK_DB", os.path.join(TMP, "m.db"))
os.environ.setdefault("FLOW_DEMO", "1")
os.environ.setdefault("FLOW_DEMO_WARMUP_MIN", "1")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.accounts import Accounts  # noqa: E402
from app.mailer import MailError, Mailer, device_label, mask_email  # noqa: E402

J = {"origin": "http://testserver"}
SITE = "https://flowdeck.example"
UA_A = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
UA_B = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"


# ------------------------------------------------------------------------------------------ fake provider
class SMTPHandler(socketserver.StreamRequestHandler):
    def send(self, line):
        self.wfile.write((line + "\r\n").encode())

    def handle(self):
        srv = self.server
        self.send("220 fake ESMTP")
        mail_from, rcpt, authed = None, [], False
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.decode(errors="replace").rstrip("\r\n")
            cmd = line.split(" ", 1)[0].upper()
            if cmd in ("EHLO", "HELO"):
                self.wfile.write(b"250-fake\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n")
            elif cmd == "AUTH":
                import base64
                parts = line.split(" ")
                creds = base64.b64decode(parts[2]).split(b"\0") if len(parts) > 2 else []
                if len(creds) == 3 and creds[1].decode() == srv.user and creds[2].decode() == srv.password:
                    authed = True
                    self.send("235 ok")
                else:
                    self.send("535 bad credentials")
            elif cmd == "MAIL":
                if srv.user and not authed:
                    self.send("530 auth required")
                    continue
                mail_from = line[10:].strip("<> ")
                self.send("250 ok")
            elif cmd == "RCPT":
                rcpt.append(line[8:].strip("<> "))
                self.send("250 ok")
            elif cmd == "DATA":
                self.send("354 go")
                buf = []
                while True:
                    ln = self.rfile.readline()
                    if ln in (b".\r\n", b".\n", b""):
                        break
                    buf.append(ln[1:] if ln.startswith(b"..") else ln)
                msg = email.message_from_bytes(b"".join(buf), policy=policy.default)
                srv.inbox.append({"from": mail_from, "to": list(rcpt), "msg": msg})
                rcpt = []
                self.send("250 queued")
            elif cmd == "QUIT":
                self.send("221 bye")
                return
            else:
                self.send("250 ok")


class FakeSMTP(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, user="resend", password="re_test_key"):
        super().__init__(("127.0.0.1", 0), SMTPHandler)
        self.user, self.password, self.inbox = user, password, []
        threading.Thread(target=self.serve_forever, daemon=True).start()

    @property
    def port(self):
        return self.server_address[1]

    def wait(self, n=1, timeout=8.0, to=None):
        end = time.time() + timeout
        while time.time() < end:
            got = [m for m in self.inbox if to is None or to in m["to"]]
            if len(got) >= n:
                return got
            time.sleep(0.05)
        return [m for m in self.inbox if to is None or to in m["to"]]


def body_text(msg):
    return msg.get_body(preferencelist=("plain",)).get_content()


@pytest.fixture(scope="module")
def smtp():
    s = FakeSMTP()
    yield s
    s.shutdown()


def mailer_for(s, **kw):
    return Mailer("127.0.0.1", s.port, "resend", "re_test_key", "Flowdeck <no-reply@flowdeck.example>", SITE,
                  security="none", **kw)


# ------------------------------------------------------------------------------------------ unit
def test_mailer_sends_multipart_through_smtp(smtp):
    m = mailer_for(smtp)
    assert m.enabled and m.problems() == []
    m.send(m.build("ann@example.com", "Hello", "plain body", "<p>html body</p>", reply_to="help@example.com"))
    got = smtp.wait(to="ann@example.com")[-1]
    msg = got["msg"]
    assert msg["Subject"] == "Hello" and msg["Reply-To"] == "help@example.com" and "flowdeck.example" in msg["Message-ID"]
    assert body_text(msg).strip() == "plain body" and "html body" in msg.get_body(preferencelist=("html",)).get_content()
    assert got["from"] == "no-reply@flowdeck.example" and m.sent_today == 1


def test_mailer_reports_problems_clearly(smtp):
    off = Mailer()
    assert not off.enabled and any("SMTP_HOST" in p for p in off.problems())
    assert any("FLOWDECK_SITE_URL" in p for p in Mailer("h", 587, "", "", "a@b.co", "").problems())
    bad = Mailer("127.0.0.1", smtp.port, "resend", "wrong", "Flowdeck <no-reply@flowdeck.example>", SITE, security="none")
    with pytest.raises(MailError, match="username or password"):
        bad.send(bad.build("x@example.com", "s", "t", "<p>t</p>"))
    closed = Mailer("127.0.0.1", 1, "u", "p", "a@b.co", SITE, security="none", timeout=2)
    with pytest.raises(MailError, match="Couldn't connect"):
        closed.send(closed.build("x@example.com", "s", "t", "<p>t</p>"))


def test_budget_keeps_room_for_resets():
    m = Mailer("h", 587, "", "", "a@b.co", SITE, daily_limit=10)
    m._roll()
    m.sent_today = 8
    assert not m.budget_ok("alert") and m.budget_ok("reset")
    m.sent_today = 10
    assert not m.budget_ok("reset")


def test_labels_and_masks():
    assert device_label(UA_A) == "Chrome on Windows" and device_label(UA_B) == "Safari on iPhone"
    assert mask_email("mayank@gmail.com") == "m***k@gmail.com" and mask_email("ab@x.io") == "a***@x.io"


def test_known_device_rules():
    a = Accounts(os.path.join(TMP, "dev.db"))
    u = a.create_user("d@x.io", "D", "password1")
    assert a.known_device(u["id"], "h1", UA_A)                     # first sign-in ever: no alert
    a.open_session(u, "1.1.1.1", UA_A)                             # a session from before device cookies
    assert a.known_device(u["id"], "h1", UA_A) and not a.known_device(u["id"], "h1", UA_B)
    a.open_session(u, "1.1.1.1", UA_A, device="h1")
    assert a.known_device(u["id"], "h1", UA_B) and not a.known_device(u["id"], "h2", UA_A)


# ------------------------------------------------------------------------------------------ server
@pytest.fixture(scope="module")
def srv(smtp):
    old = main.mailer
    with TestClient(main.app, base_url="http://testserver") as c:
        main.mailer = mailer_for(smtp)
        main.accounts.set_settings({"verify_signups": "0"})   # the sign-up code tests switch it on themselves
        yield c
        main.accounts.set_settings({"verify_signups": "1"})
    main.mailer = old


def fresh(ua=UA_A):
    return TestClient(main.app, base_url="http://testserver", headers={"user-agent": ua})


def reset_link(smtp, to, n):
    msgs = smtp.wait(n, to=to)
    assert len(msgs) >= n, f"expected {n} emails to {to}, got {len(msgs)}"
    text = body_text(msgs[n - 1]["msg"])
    m = re.search(r"(https://\S+/reset#t=([\w-]+))", text)
    return msgs[n - 1]["msg"], m.group(1), m.group(2)


def test_forgot_and_reset_flow(srv, smtp):
    main.forgot_ip.hits.clear()
    main.signup_ip.hits.clear()
    c = fresh()
    assert c.post("/api/auth/signup", json={"name": "Riya", "email": "riya@example.com", "password": "old-password-1"}, headers=J).status_code == 200
    assert srv.get("/api/public/config").json()["email_enabled"] is True

    # unknown address: same answer, no email
    r = c.post("/api/auth/forgot", json={"email": "nobody@example.com"}, headers=J)
    assert r.status_code == 200 and r.json()["ok"]
    # a forged Host header must not change where the link points
    r = c.post("/api/auth/forgot", json={"email": "RIYA@example.com"}, headers={"host": "evil.example"})
    assert r.status_code == 200
    msg, link, token = reset_link(smtp, "riya@example.com", 1)
    assert link.startswith(SITE + "/reset#t=") and msg["Subject"] == "Reset your Flowdeck password"
    assert "Chrome on Windows" in body_text(msg) and not smtp.wait(1, timeout=0.3, to="nobody@example.com")

    chk = c.post("/api/auth/reset/check", json={"token": token}, headers=J).json()
    assert chk["email"] == "r***a@example.com" and chk["has_password"] is True

    other = fresh(UA_B)                               # the account is also open on a phone
    assert other.post("/api/auth/login", json={"email": "riya@example.com", "password": "old-password-1"}, headers=J).status_code == 200
    assert c.post("/api/auth/reset", json={"token": token, "password": "short"}, headers=J).json()["error"] == "weak_password"
    r = c.post("/api/auth/reset", json={"token": token, "password": "new-password-2"}, headers=J)
    assert r.status_code == 200 and r.json()["user"]["email"] == "riya@example.com"
    assert c.get("/api/auth/me").status_code == 200                       # signed in here
    assert other.get("/api/auth/me").json()["error"] == "password_reset"  # and out everywhere else
    assert c.post("/api/auth/reset", json={"token": token, "password": "another-pass-3"}, headers=J).json()["error"] == "bad_link"
    assert fresh().post("/api/auth/login", json={"email": "riya@example.com", "password": "old-password-1"}, headers=J).status_code == 401
    assert fresh().post("/api/auth/login", json={"email": "riya@example.com", "password": "new-password-2"}, headers=J).status_code == 200
    changed = [m for m in smtp.wait(3, to="riya@example.com") if m["msg"]["Subject"] == "Your Flowdeck password was changed"]
    assert changed and "reset with an email link" in body_text(changed[0]["msg"])
    # the page that opens the link sends no referrer and stays out of search engines
    page = c.get("/reset")
    assert page.headers["referrer-policy"] == "no-referrer" and page.headers["x-robots-tag"] == "noindex"


def test_reset_links_expire_and_newest_wins(srv, smtp):
    main.forgot_ip.hits.clear()
    c = fresh()
    c.post("/api/auth/signup", json={"name": "Kabir", "email": "kabir@example.com", "password": "password-k1"}, headers=J)
    before = len(smtp.wait(0, to="kabir@example.com"))
    c.post("/api/auth/forgot", json={"email": "kabir@example.com"}, headers=J)
    _, _, t1 = reset_link(smtp, "kabir@example.com", before + 1)
    c.post("/api/auth/forgot", json={"email": "kabir@example.com"}, headers=J)
    _, _, t2 = reset_link(smtp, "kabir@example.com", before + 2)
    assert c.post("/api/auth/reset/check", json={"token": t1}, headers=J).json()["error"] == "bad_link"
    main.accounts.run("UPDATE password_resets SET expires_at=1 WHERE used_at IS NULL")
    assert c.post("/api/auth/reset/check", json={"token": t2}, headers=J).json()["error"] == "link_expired"
    # three emails an hour per address; more requests get the same answer but no email
    c.post("/api/auth/forgot", json={"email": "kabir@example.com"}, headers=J)
    c.post("/api/auth/forgot", json={"email": "kabir@example.com"}, headers=J)
    time.sleep(0.5)
    assert len(smtp.wait(0, to="kabir@example.com")) == before + 3


def test_google_only_account_gets_set_password_email(srv, smtp):
    main.forgot_ip.hits.clear()
    u = main.accounts.create_user("gina@gmail.com", "Gina", None, created_by="google", google_sub="g-123")
    fresh().post("/api/auth/forgot", json={"email": "gina@gmail.com"}, headers=J)
    msg, _, token = reset_link(smtp, "gina@gmail.com", 1)
    assert msg["Subject"] == "Set a password for Flowdeck"
    c = fresh()
    assert c.post("/api/auth/reset/check", json={"token": token}, headers=J).json()["has_password"] is False
    assert c.post("/api/auth/reset", json={"token": token, "password": "gina-pass-1"}, headers=J).status_code == 200
    assert main.accounts.user(u["id"])["pw_hash"]


def test_new_device_alert(srv, smtp):
    main.signup_ip.hits.clear()
    a = fresh(UA_A)
    a.post("/api/auth/signup", json={"name": "Dev", "email": "dev@example.com", "password": "password-d1"}, headers=J)
    login = {"email": "dev@example.com", "password": "password-d1"}
    assert a.post("/api/auth/login", json=login, headers=J).status_code == 200       # same browser: no alert
    time.sleep(0.4)
    assert smtp.wait(0, to="dev@example.com") == []
    b = fresh(UA_B)
    assert b.post("/api/auth/login", json=login, headers=J).status_code == 200       # new phone: alert
    msg = smtp.wait(1, to="dev@example.com")[0]["msg"]
    assert msg["Subject"] == "New sign-in to your Flowdeck account"
    t = body_text(msg)
    assert "Safari on iPhone" in t and SITE + "/forgot" in t and "email and password" in t
    assert b.post("/api/auth/login", json=login, headers=J).status_code == 200       # that phone again: no alert
    assert a.post("/api/auth/login", json=login, headers=J).status_code == 200       # back on the PC: known
    time.sleep(0.4)
    assert len(smtp.wait(1, to="dev@example.com")) == 1


def test_password_change_signs_out_others_and_emails(srv, smtp):
    main.signup_ip.hits.clear()
    c = fresh()
    c.post("/api/auth/signup", json={"name": "Pia", "email": "pia@example.com", "password": "password-p1"}, headers=J)
    assert c.post("/api/auth/password", json={"current": "password-p1", "new": "password-p2"}, headers=J).status_code == 200
    msg = smtp.wait(1, to="pia@example.com")[0]["msg"]
    assert msg["Subject"] == "Your Flowdeck password was changed" and "account menu" in body_text(msg)


def test_admin_mail_status_and_test(srv, smtp):
    a = fresh()
    em = f"mailadmin{int(time.time() * 1000)}@example.com"
    main.accounts.create_user(em, "Boss", "boss-password-9", role="admin", created_by="admin")
    assert a.post("/api/auth/login", json={"email": em, "password": "boss-password-9"}, headers=J).status_code == 200
    st = a.get("/api/admin/mail").json()
    assert st["enabled"] and st["host"] == "127.0.0.1" and st["password"] is True and "re_test_key" not in str(st)
    r = a.post("/api/admin/mail/test", json={"to": "ops@example.com"}, headers=J)
    assert r.status_code == 200 and smtp.wait(1, to="ops@example.com")[0]["msg"]["Subject"] == "Flowdeck test email"
    main.mailer.password = "wrong"
    try:
        r = a.post("/api/admin/mail/test", json={"to": "ops@example.com"}, headers=J)
        assert r.status_code == 502 and "username or password" in r.json()["message"]
    finally:
        main.mailer.password = "re_test_key"
    # a regular user can't use it
    u = fresh()
    main.signup_ip.hits.clear()
    u.post("/api/auth/signup", json={"name": "U", "email": f"u{em}", "password": "password-u1"}, headers=J)
    assert u.post("/api/admin/mail/test", json={}, headers=J).status_code == 403


def test_forgot_without_email_setup(srv):
    old = main.mailer
    main.mailer = Mailer()
    try:
        r = fresh().post("/api/auth/forgot", json={"email": "riya@example.com"}, headers=J)
        assert r.status_code == 503 and r.json()["error"] == "email_off"
        assert fresh().get("/api/public/config").json()["email_enabled"] is False
    finally:
        main.mailer = old


# ------------------------------------------------------------------------------------------ sign-up codes
def code_from(smtp, to, n):
    msgs = [m for m in smtp.wait(n, to=to) if m["msg"]["Subject"].endswith("is your Flowdeck code")]
    assert len(msgs) >= n, f"expected {n} codes for {to}"
    return re.match(r"^(\d{6}) is your Flowdeck code", msgs[n - 1]["msg"]["Subject"]).group(1)


@pytest.fixture()
def verify_on(srv):
    main.accounts.set_settings({"verify_signups": "1"})
    main.signup_ip.hits.clear()
    main.code_ip.hits.clear()
    yield
    main.accounts.set_settings({"verify_signups": "0"})


def test_signup_needs_the_emailed_code(srv, smtp, verify_on):
    assert srv.get("/api/public/config").json()["verify_signups"] is True
    c = fresh()
    r = c.post("/api/auth/signup", json={"name": "Neha", "email": "Neha@Example.com", "password": "password-n1"}, headers=J).json()
    assert r["verify"] and r["email"] == "neha@example.com" and r["minutes"] == 10 and len(r["ticket"]) > 20
    assert main.accounts.user_by_email("neha@example.com") is None and c.get("/api/auth/me").status_code == 401
    code = code_from(smtp, "neha@example.com", 1)
    msg = smtp.wait(1, to="neha@example.com")[0]["msg"]
    assert code in body_text(msg) and "Neha" in body_text(msg)
    wrong = f"{(int(code) + 1) % 1_000_000:06d}"
    bad = c.post("/api/auth/signup/verify", json={"email": "neha@example.com", "code": wrong, "ticket": r["ticket"]}, headers=J).json()
    assert bad["error"] == "bad_code" and "4 tries left" in bad["message"]
    # the right code from a browser that didn't start this sign-up is refused
    assert fresh().post("/api/auth/signup/verify", json={"email": "neha@example.com", "code": code, "ticket": "x" * 32},
                        headers=J).json()["error"] == "no_pending"
    ok = c.post("/api/auth/signup/verify", json={"email": "neha@example.com", "code": f"{code[:3]} {code[3:]}", "ticket": r["ticket"]}, headers=J)
    assert ok.status_code == 200 and ok.json()["user"]["state"] == "trial" and ok.json()["live"]
    assert c.get("/api/auth/me").json()["user"]["email"] == "neha@example.com"
    assert fresh().post("/api/auth/login", json={"email": "neha@example.com", "password": "password-n1"}, headers=J).status_code == 200
    again = c.post("/api/auth/signup/verify", json={"email": "neha@example.com", "code": code, "ticket": r["ticket"]}, headers=J).json()
    assert again["error"] == "email_taken"


def test_stranger_cannot_pre_set_the_password(srv, smtp, verify_on):
    owner, stranger = fresh(), fresh(UA_B)
    r1 = owner.post("/api/auth/signup", json={"name": "Om", "email": "om@example.com", "password": "owner-pass-1"}, headers=J).json()
    # someone else starts a sign-up for the same address with their own password (after the 30 s pause)
    assert stranger.post("/api/auth/signup", json={"name": "X", "email": "om@example.com", "password": "stranger-1"},
                         headers=J).json()["error"] == "too_soon"
    main.accounts.run("UPDATE pending_signups SET last_sent_at=last_sent_at-60000 WHERE email='om@example.com'")
    r2 = stranger.post("/api/auth/signup", json={"name": "X", "email": "om@example.com", "password": "stranger-1"}, headers=J).json()
    assert r2["verify"]
    latest = code_from(smtp, "om@example.com", 2)   # the code goes to the owner's inbox, not the stranger
    # the owner types the newest code in their own browser: refused, because it's tied to the stranger's attempt
    res = owner.post("/api/auth/signup/verify", json={"email": "om@example.com", "code": latest, "ticket": r1["ticket"]}, headers=J).json()
    assert res["error"] == "no_pending" and main.accounts.user_by_email("om@example.com") is None
    # the owner starts again, which cancels the stranger's attempt, and confirms with their own password
    main.accounts.run("UPDATE pending_signups SET last_sent_at=last_sent_at-60000 WHERE email='om@example.com'")
    r3 = owner.post("/api/auth/signup", json={"name": "Om", "email": "om@example.com", "password": "owner-pass-1"}, headers=J).json()
    code = code_from(smtp, "om@example.com", 3)
    assert stranger.post("/api/auth/signup/verify", json={"email": "om@example.com", "code": code, "ticket": r2["ticket"]},
                         headers=J).json()["error"] == "no_pending"
    assert owner.post("/api/auth/signup/verify", json={"email": "om@example.com", "code": code, "ticket": r3["ticket"]}, headers=J).status_code == 200
    assert fresh().post("/api/auth/login", json={"email": "om@example.com", "password": "owner-pass-1"}, headers=J).status_code == 200


def test_code_limits(srv, smtp, verify_on):
    c = fresh()
    r = c.post("/api/auth/signup", json={"name": "Lim", "email": "lim@example.com", "password": "password-l1"}, headers=J).json()
    t = r["ticket"]
    code = code_from(smtp, "lim@example.com", 1)
    wrong = f"{(int(code) + 7) % 1_000_000:06d}"
    for _ in range(4):
        c.post("/api/auth/signup/verify", json={"email": "lim@example.com", "code": wrong, "ticket": t}, headers=J)
    assert c.post("/api/auth/signup/verify", json={"email": "lim@example.com", "code": wrong, "ticket": t}, headers=J).json()["error"] == "code_locked"
    assert c.post("/api/auth/signup/verify", json={"email": "lim@example.com", "code": code, "ticket": t}, headers=J).json()["error"] == "code_locked"
    # a new code unlocks it; asking again within 30 s is refused
    assert c.post("/api/auth/signup/resend", json={"email": "lim@example.com", "ticket": t}, headers=J).json()["error"] == "too_soon"
    main.accounts.run("UPDATE pending_signups SET last_sent_at=last_sent_at-60000 WHERE email='lim@example.com'")
    assert c.post("/api/auth/signup/resend", json={"email": "lim@example.com", "ticket": t}, headers=J).status_code == 200
    code2 = code_from(smtp, "lim@example.com", 2)
    assert c.post("/api/auth/signup/verify", json={"email": "lim@example.com", "code": code, "ticket": t}, headers=J).json()["error"] in ("bad_code",) or code == code2
    main.accounts.run("UPDATE pending_signups SET expires_at=1 WHERE email='lim@example.com'")
    assert c.post("/api/auth/signup/verify", json={"email": "lim@example.com", "code": code2, "ticket": t}, headers=J).json()["error"] == "code_expired"
    # five codes per address a day
    for _ in range(3):
        main.accounts.run("UPDATE pending_signups SET last_sent_at=last_sent_at-60000 WHERE email='lim@example.com'")
        assert c.post("/api/auth/signup/resend", json={"email": "lim@example.com", "ticket": t}, headers=J).status_code == 200
    main.accounts.run("UPDATE pending_signups SET last_sent_at=last_sent_at-60000 WHERE email='lim@example.com'")
    assert c.post("/api/auth/signup/resend", json={"email": "lim@example.com", "ticket": t}, headers=J).json()["error"] == "too_many_codes"


def test_signup_code_send_failure_and_switch(srv, smtp, verify_on):
    main.mailer.password = "wrong"
    try:
        r = fresh().post("/api/auth/signup", json={"name": "F", "email": "fail@example.com", "password": "password-f1"}, headers=J)
        assert r.status_code == 502 and r.json()["error"] == "mail_failed"
    finally:
        main.mailer.password = "re_test_key"
    assert main.accounts.user_by_email("fail@example.com") is None
    # switched off by the admin: straight in, no code
    main.accounts.set_settings({"verify_signups": "0"})
    c = fresh()
    r = c.post("/api/auth/signup", json={"name": "Q", "email": "quick@example.com", "password": "password-q1"}, headers=J)
    assert r.status_code == 200 and "verify" not in r.json() and r.json()["user"]["email"] == "quick@example.com"
