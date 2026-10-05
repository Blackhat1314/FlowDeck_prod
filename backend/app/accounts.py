"""User accounts, sessions, trial access, audit log and site settings (SQLite, standard library only).

Rules
- Sign-up creates a user with a free trial of `trial_days` (site setting, default 3).
- Live data needs an active, unblocked account whose expiry is in the future (admins never expire).
  Expired users still log in but receive a frozen snapshot.
- One active session per account: a new login revokes the others (reason "replaced").
- Sign in with Google: a verified Google email signs into the account with that email (and links it), or creates a
  trial account. Accounts made this way have no password (pw_hash '') until the user sets one.
- Passwords: scrypt (n=2^14, r=8, p=1, 16-byte salt). Session tokens: 32 random bytes, only the SHA-256 is stored.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
import threading
import time
from pathlib import Path

DAY = 86_400_000
MAX_TS = 4_102_444_800_000   # 1 Jan 2100
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$")
SESSION_DAYS = 30
RESET_MINUTES = 30   # how long a password-reset link works
CODE_MINUTES = 10    # how long a sign-up code works
CODE_TRIES = 5       # wrong guesses allowed per code
CODE_SENDS = 5       # codes per pending sign-up (then start again later)

DEFAULT_SETTINGS = {
    "trial_days": "3",
    "price_label": "₹499 / month",
    "price_inr": "499",
    "contact_email": "",
    "signups_open": "1",
    "verify_signups": "1",   # new email sign-ups confirm their address with a 6-digit code (when email is set up)
    "upgrade_note": "Pay with UPI, card or net banking through Razorpay. Your 30 days start as soon as the payment goes through.",
}
# notes shipped by earlier versions: replaced by the current default unless the admin had changed them
OLD_UPGRADE_NOTES = (
    "Pay ₹499 for 30 days. Send your registered email after paying and your access is extended within a few hours.",
)


def now_ms() -> int:
    return int(time.time() * 1000)


class AccountError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


# ------------------------------------------------------------------------------------------- passwords
def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32)
    return f"scrypt$16384$8$1${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, dk = stored.split("$")
        if algo != "scrypt":
            return False
        calc = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                              maxmem=64 * 1024 * 1024, dklen=len(bytes.fromhex(dk)))
        return hmac.compare_digest(calc, bytes.fromhex(dk))
    except Exception:
        return False


DUMMY_HASH = hash_password("timing-equaliser-not-a-real-password")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def check_password_rules(pw: str):
    if not isinstance(pw, str) or len(pw) < 8:
        raise AccountError("weak_password", "Password must be at least 8 characters.")
    if len(pw) > 200:
        raise AccountError("weak_password", "Password is too long.")


def clean_email(email: str) -> str:
    if email is not None and not isinstance(email, str):
        raise AccountError("bad_email", "Enter a valid email address.")
    e = (email or "").strip().lower()
    if not EMAIL_RE.match(e):
        raise AccountError("bad_email", "Enter a valid email address.")
    return e


def clean_name(name: str) -> str:
    if name is not None and not isinstance(name, str):
        raise AccountError("bad_name", "Enter your name.")
    n = re.sub(r"\s+", " ", (name or "").strip())
    if not n:
        raise AccountError("bad_name", "Enter your name.")
    return n[:80]


# ------------------------------------------------------------------------------------------- store
class Accounts:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self._new_device: dict[int, bool] = {}
        with self.lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  email TEXT NOT NULL UNIQUE,
                  name TEXT NOT NULL,
                  pw_hash TEXT NOT NULL,
                  role TEXT NOT NULL DEFAULT 'user',
                  status TEXT NOT NULL DEFAULT 'active',
                  created_at INTEGER NOT NULL,
                  expires_at INTEGER,
                  last_login_at INTEGER,
                  last_seen_at INTEGER,
                  last_ip TEXT,
                  note TEXT NOT NULL DEFAULT '',
                  created_by TEXT NOT NULL DEFAULT 'signup',
                  plan TEXT NOT NULL DEFAULT 'trial'
                );
                CREATE TABLE IF NOT EXISTS sessions (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  token_hash TEXT NOT NULL UNIQUE,
                  created_at INTEGER NOT NULL,
                  last_seen_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL,
                  ip TEXT, ua TEXT,
                  revoked_at INTEGER, revoke_reason TEXT
                );
                CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
                CREATE TABLE IF NOT EXISTS audit (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  t INTEGER NOT NULL,
                  actor_id INTEGER, actor_email TEXT,
                  action TEXT NOT NULL,
                  target_id INTEGER, target_email TEXT,
                  detail TEXT NOT NULL DEFAULT '',
                  ip TEXT
                );
                CREATE INDEX IF NOT EXISTS audit_t ON audit(t);
                CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS payments (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
                  email TEXT NOT NULL,
                  order_id TEXT NOT NULL UNIQUE,
                  payment_id TEXT UNIQUE,
                  amount INTEGER NOT NULL,
                  currency TEXT NOT NULL,
                  days INTEGER NOT NULL,
                  status TEXT NOT NULL DEFAULT 'created',
                  created_at INTEGER NOT NULL,
                  paid_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS payments_user ON payments(user_id);
                CREATE TABLE IF NOT EXISTS password_resets (
                  id INTEGER PRIMARY KEY AUTOINCREMENT,
                  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                  token_hash TEXT NOT NULL UNIQUE,
                  created_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL,
                  used_at INTEGER,
                  ip TEXT
                );
                CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
                CREATE TABLE IF NOT EXISTS pending_signups (
                  email TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  pw_hash TEXT NOT NULL,
                  code_hash TEXT NOT NULL,
                  ticket_hash TEXT NOT NULL,
                  created_at INTEGER NOT NULL,
                  expires_at INTEGER NOT NULL,
                  tries INTEGER NOT NULL DEFAULT 0,
                  sends INTEGER NOT NULL DEFAULT 1,
                  last_sent_at INTEGER NOT NULL,
                  ip TEXT
                );
                """
            )
            scols = {r[1] for r in self.db.execute("PRAGMA table_info(sessions)")}
            if "device" not in scols:   # SHA-256 of the browser's long-lived device cookie (new-device sign-in alerts)
                self.db.execute("ALTER TABLE sessions ADD COLUMN device TEXT")
            cols = {r[1] for r in self.db.execute("PRAGMA table_info(users)")}
            if "plan" not in cols:
                self.db.execute("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial'")
            if "tour_done_at" not in cols:   # when the user finished or skipped the first-visit tour
                self.db.execute("ALTER TABLE users ADD COLUMN tour_done_at INTEGER")
            if "google_sub" not in cols:   # Google account id ("sub" claim) once the user has signed in with Google
                self.db.execute("ALTER TABLE users ADD COLUMN google_sub TEXT")
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL")
            for k, v in DEFAULT_SETTINGS.items():
                self.db.execute("INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)", (k, v))
            # payments go through Razorpay now: the WhatsApp payment number is no longer kept
            self.db.execute("DELETE FROM settings WHERE key='contact_whatsapp'")
            for old in OLD_UPGRADE_NOTES:
                self.db.execute("UPDATE settings SET value=? WHERE key='upgrade_note' AND value=?", (DEFAULT_SETTINGS["upgrade_note"], old))

    # ---------------------------------------------------------------------------------------- helpers
    def q(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def one(self, sql, args=()):
        with self.lock:
            return self.db.execute(sql, args).fetchone()

    def run(self, sql, args=()):
        with self.lock:
            cur = self.db.execute(sql, args)
            return cur.lastrowid, cur.rowcount

    def audit(self, action: str, actor=None, target=None, detail: str = "", ip: str | None = None):
        self.run("INSERT INTO audit(t, actor_id, actor_email, action, target_id, target_email, detail, ip) VALUES (?,?,?,?,?,?,?,?)",
                 (now_ms(), actor["id"] if actor else None, actor["email"] if actor else None, action,
                  target["id"] if target else None, target["email"] if target else None, detail[:500], ip))

    # ---------------------------------------------------------------------------------------- settings
    def settings(self) -> dict:
        return {r["key"]: r["value"] for r in self.q("SELECT key, value FROM settings")}

    def set_settings(self, upd: dict, actor=None, ip=None):
        cur = self.settings()
        changed = []
        for k, v in upd.items():
            if k not in DEFAULT_SETTINGS:
                raise AccountError("bad_setting", f"Unknown setting {k}.")
            v = str(v).strip()
            if k == "trial_days":
                if not re.fullmatch(r"[0-9]{1,2}", v) or not 0 <= int(v) <= 90:
                    raise AccountError("bad_setting", "Trial days must be 0–90.")
            if k == "price_inr" and v and not re.fullmatch(r"\d{1,6}", v):
                raise AccountError("bad_setting", "Price must be a whole number of rupees.")
            if k in ("signups_open", "verify_signups"):
                v = "1" if v in ("1", "true", "True", "on") else "0"
            if k == "contact_email" and v:
                v = clean_email(v)
            v = v[:600]
            if cur.get(k) != v:
                self.run("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
                changed.append(k)
        if changed:
            self.audit("settings", actor, None, ", ".join(changed), ip)
        return self.settings()

    def public_config(self) -> dict:
        s = self.settings()
        return {"trial_days": int(s["trial_days"]), "price_label": s["price_label"], "price_inr": s["price_inr"],
                "contact_email": s["contact_email"],
                "signups_open": s["signups_open"] == "1", "upgrade_note": s["upgrade_note"],
                "verify_signups": s.get("verify_signups", "1") == "1"}

    # ---------------------------------------------------------------------------------------- users
    def user(self, uid: int):
        return self.one("SELECT * FROM users WHERE id=?", (uid,))

    def user_by_email(self, email: str):
        return self.one("SELECT * FROM users WHERE email=?", ((email or "").strip().lower(),))

    def count_admins(self) -> int:
        return self.one("SELECT COUNT(*) c FROM users WHERE role='admin' AND status='active'")["c"]

    @staticmethod
    def has_live(u, t: int | None = None) -> bool:
        if u is None or u["status"] != "active":
            return False
        if u["role"] == "admin" or u["expires_at"] is None:
            return True
        return u["expires_at"] > (t or now_ms())

    def create_user(self, email, name, password, role="user", expires_at=None, created_by="signup", actor=None, ip=None,
                    plan: str | None = None, google_sub: str | None = None, pw_hash: str | None = None):
        """password=None only for Google sign-ups: the account has no password until the user sets one.
        pw_hash: the password already hashed (a sign-up confirmed with an emailed code)."""
        email = clean_email(email)
        name = clean_name(name)
        if pw_hash:
            pass
        elif password is None and google_sub:
            pw_hash = ""
        else:
            check_password_rules(password)
            pw_hash = hash_password(password)
        if role not in ("user", "admin"):
            raise AccountError("bad_role", "Role must be user or admin.")
        if self.user_by_email(email):
            raise AccountError("email_taken", "An account with this email already exists.", 409)
        t = now_ms()
        if expires_at is not None and not 0 < int(expires_at) < MAX_TS:
            raise AccountError("bad_date", "That end date is out of range.")
        if expires_at is None and role == "user":
            expires_at = t + int(self.settings()["trial_days"]) * DAY
        self_signup = created_by in ("signup", "google")
        plan = plan or ("trial" if self_signup else "paid")
        if plan not in ("trial", "paid"):
            raise AccountError("bad_plan", "Plan must be trial or paid.")
        try:   # two requests at once can both pass the check above; the UNIQUE columns decide
            uid, _ = self.run(
                "INSERT INTO users(email, name, pw_hash, role, status, created_at, expires_at, created_by, plan, google_sub)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                (email, name, pw_hash, role, "active", t, expires_at, created_by, plan, google_sub))
        except sqlite3.IntegrityError:
            raise AccountError("email_taken", "An account with this email already exists.", 409)
        u = self.user(uid)
        self.audit("signup" if self_signup else "user_create", actor or u, u,
                   f"role={role}" + (f", expires={expires_at}" if expires_at else "") + (", via Google" if google_sub else ""), ip)
        return u

    def update_user(self, uid: int, upd: dict, actor=None, ip=None):
        u = self.user(uid)
        if not u:
            raise AccountError("not_found", "User not found.", 404)
        sets, args, notes = [], [], []
        if "name" in upd:
            sets.append("name=?"); args.append(clean_name(upd["name"])); notes.append("name")
        if "email" in upd:
            e = clean_email(upd["email"])
            other = self.user_by_email(e)
            if other and other["id"] != uid:
                raise AccountError("email_taken", "Another account uses this email.", 409)
            sets.append("email=?"); args.append(e); notes.append("email")
            if e != u["email"] and u["google_sub"]:
                sets.append("google_sub=NULL"); notes.append("google unlinked")
        if "note" in upd:
            sets.append("note=?"); args.append(str(upd["note"])[:500]); notes.append("note")
        if "role" in upd:
            r = upd["role"]
            if r not in ("user", "admin"):
                raise AccountError("bad_role", "Role must be user or admin.")
            if u["role"] == "admin" and r != "admin" and self.count_admins() <= 1:
                raise AccountError("last_admin", "You can't remove the last admin.")
            sets.append("role=?"); args.append(r); notes.append(f"role={r}")
        if "status" in upd:
            st = upd["status"]
            if st not in ("active", "blocked"):
                raise AccountError("bad_status", "Status must be active or blocked.")
            if st == "blocked" and u["role"] == "admin" and self.count_admins() <= 1:
                raise AccountError("last_admin", "You can't block the last admin.")
            sets.append("status=?"); args.append(st); notes.append(f"status={st}")
        if "expires_at" in upd:
            ex = upd["expires_at"]
            ex = None if ex in (None, "", 0) else int(ex)
            if ex is not None and not 0 < ex < MAX_TS:
                raise AccountError("bad_date", "That end date is out of range.")
            sets.append("expires_at=?"); args.append(ex); notes.append(f"expires={ex}")
        if "plan" in upd:
            if upd["plan"] not in ("trial", "paid"):
                raise AccountError("bad_plan", "Plan must be trial or paid.")
            sets.append("plan=?"); args.append(upd["plan"]); notes.append(f"plan={upd['plan']}")
        if not sets:
            return u
        args.append(uid)
        self.run(f"UPDATE users SET {', '.join(sets)} WHERE id=?", args)
        if upd.get("status") == "blocked":
            self.revoke_user_sessions(uid, "blocked")
        nu = self.user(uid)
        self.audit("user_update", actor, nu, "; ".join(notes), ip)
        return nu

    def extend(self, uid: int, days: int | None = None, until: int | None = None, actor=None, ip=None):
        u = self.user(uid)
        if not u:
            raise AccountError("not_found", "User not found.", 404)
        t = now_ms()
        if until is not None:
            ex = int(until)
            if not 0 < ex < MAX_TS:
                raise AccountError("bad_date", "That end date is out of range.")
        else:
            if days is None or not -365 <= int(days) <= 3650 or int(days) == 0:
                raise AccountError("bad_days", "Days must be between -365 and 3650.")
            base = max(t, u["expires_at"] or t)
            ex = base + int(days) * DAY
        self.run("UPDATE users SET expires_at=?, plan='paid' WHERE id=?", (ex, uid))
        nu = self.user(uid)
        self.audit("extend", actor, nu, f"days={days}" if until is None else f"until={until}", ip)
        return nu

    def set_password(self, uid: int, password: str, actor=None, ip=None, revoke_others_than: int | None = None):
        check_password_rules(password)
        u = self.user(uid)
        if not u:
            raise AccountError("not_found", "User not found.", 404)
        self.run("UPDATE users SET pw_hash=? WHERE id=?", (hash_password(password), uid))
        self.audit("password_reset" if actor and actor["id"] != uid else "password_change", actor or u, u, "", ip)
        return u

    def delete_user(self, uid: int, actor=None, ip=None):
        u = self.user(uid)
        if not u:
            raise AccountError("not_found", "User not found.", 404)
        if u["role"] == "admin" and self.count_admins() <= 1:
            raise AccountError("last_admin", "You can't delete the last admin.")
        self.audit("user_delete", actor, u, "", ip)
        self.run("DELETE FROM users WHERE id=?", (uid,))
        return u

    def list_users(self, query: str = "", flt: str = "all"):
        t = now_ms()
        rows = self.q("SELECT * FROM users ORDER BY created_at DESC")
        out = []
        ql = (query or "").strip().lower()
        for u in rows:
            if ql and ql not in u["email"] and ql not in u["name"].lower():
                continue
            st = self.state(u, t)
            if flt != "all" and flt != st and not (flt == "admin" and u["role"] == "admin"):
                continue
            out.append(self.user_json(u, t))
        return out

    def state(self, u, t=None) -> str:
        t = t or now_ms()
        if u["status"] == "blocked":
            return "blocked"
        if u["role"] == "admin":
            return "admin"
        if u["expires_at"] is not None and u["expires_at"] <= t:
            return "expired"
        return "trial" if u["plan"] == "trial" else "active"

    def user_json(self, u, t=None) -> dict:
        t = t or now_ms()
        return {"id": u["id"], "email": u["email"], "name": u["name"], "role": u["role"], "status": u["status"],
                "state": self.state(u, t), "created_at": u["created_at"], "expires_at": u["expires_at"],
                "last_login_at": u["last_login_at"], "last_seen_at": u["last_seen_at"], "last_ip": u["last_ip"],
                "note": u["note"], "created_by": u["created_by"], "plan": u["plan"], "live": self.has_live(u, t),
                "google": bool(u["google_sub"]), "has_password": bool(u["pw_hash"])}

    # ---------------------------------------------------------------------------------------- sessions
    def login(self, email: str, password: str, ip: str | None, ua: str | None, device: str | None = None,
              check_device: bool = False):
        u = self.user_by_email(email)
        has_pw = bool(u and u["pw_hash"])
        ok = verify_password(password if isinstance(password, str) else "", u["pw_hash"] if has_pw else DUMMY_HASH) and has_pw
        if not u or not ok:
            self.audit("login_failed", None, u, (email or "")[:120], ip)
            raise AccountError("bad_login", "Wrong email or password.", 401)
        if u["status"] == "blocked":
            self.audit("login_blocked", u, u, "", ip)
            raise AccountError("blocked", "This account is blocked. Contact support.", 403)
        return self.open_session(u, ip, ua, device=device, check_device=check_device)

    def google_account(self, sub: str, email: str):
        """The account a Google sign-in belongs to: the one already linked to that Google account, else the one
        registered with the same (Google-verified) email address, else None."""
        u = self.one("SELECT * FROM users WHERE google_sub=?", (sub,))
        return u if u else self.user_by_email(email)

    @staticmethod
    def google_owns_email(claims: dict, email: str) -> bool:
        """Google vouches for who owns an address only for Gmail and for Google Workspace domains (the hd claim)."""
        domain = email.rsplit("@", 1)[-1]
        return domain in ("gmail.com", "googlemail.com") or (isinstance(claims.get("hd"), str) and claims["hd"].lower() == domain)

    def google_login(self, claims: dict, ip: str | None, ua: str | None, allow_create: bool, device: str | None = None):
        """Sign in with verified Google claims (see google_auth).

        - Already linked: sign in.
        - An account with the same email but not linked: link it only when Google owns the address (Gmail or a
          Workspace domain). Sign-up never proved that the password's creator owned the email, so linking switches
          that password off and signs out every other session; the user can set a new one. Admin accounts are
          never linked automatically.
        - No account: create a trial account when allow_create.
        Returns (token, user, revoked session ids, session id, created, password_cleared)."""
        sub = claims["sub"]
        email = clean_email(claims["email"])
        u = self.google_account(sub, email)
        created = cleared = False
        if u is None:
            if not allow_create:
                raise AccountError("signups_closed", "New sign-ups are paused. Contact us for access.", 403)
            try:
                name = clean_name(claims.get("name") or claims.get("given_name") or "")
            except AccountError:
                name = email.split("@")[0][:80]
            try:
                u = self.create_user(email, name, None, created_by="google", ip=ip, google_sub=sub)
                created = True
            except AccountError as e:   # the same person double-clicked: the first request made the account
                u = self.google_account(sub, email)
                if e.code != "email_taken" or u is None:
                    raise
        if u["google_sub"] is None:
            if u["role"] == "admin":
                self.audit("login_failed", None, u, "Google: admin accounts aren't linked automatically", ip)
                raise AccountError("google_link_refused", "This is an admin account. Sign in with your email and password.", 409)
            if not self.google_owns_email(claims, email):
                self.audit("login_failed", None, u, "Google: email not owned by Google; not linked", ip)
                raise AccountError("google_link_refused", "An account with this email already exists. "
                                                          "Sign in with your email and password.", 409)
            cleared = bool(u["pw_hash"])
            try:
                _, n = self.run("UPDATE users SET google_sub=?, pw_hash='' WHERE id=? AND google_sub IS NULL", (sub, u["id"]))
            except sqlite3.IntegrityError:   # this Google account got linked elsewhere a moment ago
                n = 0
            if n:
                self.revoke_user_sessions(u["id"], "replaced")
                self.audit("google_link", u, u, "linked by Google-owned email" + ("; old password switched off" if cleared else ""), ip)
            else:
                cleared = False
            u = self.google_account(sub, email)
            if u is None:
                raise AccountError("google_failed", "Google sign-in failed. Try again.", 409)
        if u["google_sub"] != sub:
            self.audit("login_failed", None, u, "Google: this email's account is linked to another Google account", ip)
            raise AccountError("google_mismatch", "This email's Flowdeck account is linked to a different Google account. "
                                                  "Sign in with that Google account or with your password.", 409)
        if u["status"] == "blocked":
            self.audit("login_blocked", u, u, "via Google", ip)
            raise AccountError("blocked", "This account is blocked. Contact support.", 403)
        token, u, revoked, sid = self.open_session(u, ip, ua, via="Google", device=device, check_device=True)
        return token, u, revoked, sid, created, cleared

    def known_device(self, uid: int, device: str | None, ua: str | None) -> bool:
        """Has this account signed in from this browser before? `device` is the SHA-256 of the browser's device
        cookie. Accounts that never signed in count as known (no alert on the first sign-in), and accounts whose
        sessions all predate device cookies fall back to the browser string, so upgrading doesn't alert everyone."""
        if device and self.one("SELECT 1 FROM sessions WHERE user_id=? AND device=? LIMIT 1", (uid, device)):
            return True
        if self.one("SELECT 1 FROM sessions WHERE user_id=? AND device IS NOT NULL LIMIT 1", (uid,)):
            return False
        if not self.one("SELECT 1 FROM sessions WHERE user_id=? LIMIT 1", (uid,)):
            return True
        return bool(self.one("SELECT 1 FROM sessions WHERE user_id=? AND ua=? LIMIT 1", (uid, (ua or "")[:300])))

    def open_session(self, u, ip, ua, via: str = "", device: str | None = None, check_device: bool = False):
        """Create a session and revoke every other session of the user. Returns (token, user, revoked session ids).
        With check_device, last_new_device(session id) then tells whether this browser was new to the account."""
        new_device = check_device and not self.known_device(u["id"], device, ua)
        t = now_ms()
        revoked = [r["id"] for r in self.q("SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL", (u["id"],))]
        if revoked:
            self.run("UPDATE sessions SET revoked_at=?, revoke_reason='replaced' WHERE user_id=? AND revoked_at IS NULL", (t, u["id"]))
        token = secrets.token_urlsafe(32)
        sid, _ = self.run("INSERT INTO sessions(user_id, token_hash, created_at, last_seen_at, expires_at, ip, ua, device)"
                          " VALUES (?,?,?,?,?,?,?,?)",
                          (u["id"], token_hash(token), t, t, t + SESSION_DAYS * DAY, ip, (ua or "")[:300], device))
        self.run("UPDATE users SET last_login_at=?, last_seen_at=?, last_ip=? WHERE id=?", (t, t, ip, u["id"]))
        notes = ([f"via {via}"] if via else []) + ([f"replaced {len(revoked)} session(s)"] if revoked else []) \
            + (["new device"] if new_device else [])
        self.audit("login", u, u, ", ".join(notes), ip)
        if check_device:
            self._new_device[sid] = new_device
        return token, self.user(u["id"]), revoked, sid

    def last_new_device(self, sid: int) -> bool:
        """Was the session opened (with check_device) from a browser this account hadn't used before? Asked once."""
        return self._new_device.pop(sid, False)

    def session(self, token: str | None):
        """Returns (session row, user row, problem). problem is None when the session is valid."""
        if not token:
            return None, None, "no_session"
        s = self.one("SELECT * FROM sessions WHERE token_hash=?", (token_hash(token),))
        if not s:
            return None, None, "no_session"
        if s["revoked_at"]:
            return s, None, s["revoke_reason"] or "revoked"
        if s["expires_at"] <= now_ms():
            return s, None, "session_expired"
        u = self.user(s["user_id"])
        if not u:
            return s, None, "deleted"
        if u["status"] == "blocked":
            return s, u, "blocked"
        return s, u, None

    def revoke_session(self, sid: int, reason: str):
        self.run("UPDATE sessions SET revoked_at=?, revoke_reason=? WHERE id=? AND revoked_at IS NULL", (now_ms(), reason, sid))

    def revoke_user_sessions(self, uid: int, reason: str) -> list[int]:
        ids = [r["id"] for r in self.q("SELECT id FROM sessions WHERE user_id=? AND revoked_at IS NULL", (uid,))]
        if ids:
            self.run("UPDATE sessions SET revoked_at=?, revoke_reason=? WHERE user_id=? AND revoked_at IS NULL", (now_ms(), reason, uid))
        return ids

    def touch(self, session_ids: list[int], user_ids: list[int]):
        if not session_ids:
            return
        t = now_ms()
        with self.lock:
            self.db.executemany("UPDATE sessions SET last_seen_at=? WHERE id=?", [(t, s) for s in session_ids])
            self.db.executemany("UPDATE users SET last_seen_at=? WHERE id=?", [(t, u) for u in set(user_ids)])

    def active_sessions(self):
        return self.q("""SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.ip, s.ua, u.email, u.name, u.role
                         FROM sessions s JOIN users u ON u.id = s.user_id
                         WHERE s.revoked_at IS NULL AND s.expires_at > ? ORDER BY s.last_seen_at DESC""", (now_ms(),))

    def audit_log(self, limit: int = 200, query: str = "", action: str = ""):
        sql = "SELECT * FROM audit"
        cond, args = [], []
        if query:
            cond.append("(LOWER(COALESCE(actor_email,'')) LIKE ? OR LOWER(COALESCE(target_email,'')) LIKE ? OR LOWER(detail) LIKE ? OR COALESCE(ip,'') LIKE ?)")
            ql = f"%{query.strip().lower()}%"
            args += [ql, ql, ql, ql]
        if action:
            cond.append("action=?")
            args.append(action)
        if cond:
            sql += " WHERE " + " AND ".join(cond)
        sql += " ORDER BY id DESC LIMIT ?"
        args.append(max(1, min(1000, int(limit))))
        return [dict(r) for r in self.q(sql, args)]

    def overview(self):
        t = now_ms()
        users = self.q("SELECT * FROM users")
        states = {"trial": 0, "active": 0, "expired": 0, "blocked": 0, "admin": 0}
        for u in users:
            states[self.state(u, t)] += 1
        days = []
        start = (t // DAY - 13) * DAY
        for i in range(14):
            d0 = start + i * DAY
            n = self.one("SELECT COUNT(*) c FROM users WHERE created_at>=? AND created_at<?", (d0, d0 + DAY))["c"]
            days.append({"day": d0, "signups": n})
        expiring = self.q("SELECT * FROM users WHERE role='user' AND status='active' AND expires_at>? AND expires_at<=? ORDER BY expires_at",
                          (t, t + 2 * DAY))
        logins24 = self.one("SELECT COUNT(*) c FROM audit WHERE action='login' AND t>?", (t - DAY,))["c"]
        failed24 = self.one("SELECT COUNT(*) c FROM audit WHERE action='login_failed' AND t>?", (t - DAY,))["c"]
        return {"total": len(users), **states, "signups_14d": days, "logins_24h": logins24, "failed_logins_24h": failed24,
                "expiring_48h": [self.user_json(u, t) for u in expiring]}

    def set_tour_done(self, uid: int, done: bool = True):
        self.run("UPDATE users SET tour_done_at=? WHERE id=?", (now_ms() if done else None, uid))

    # ---------------------------------------------------------------------------------------- password reset
    def create_reset(self, u, ip: str | None, minutes: int = RESET_MINUTES) -> str:
        """A single-use reset token for the user (only its SHA-256 is stored). Asking again cancels older links."""
        t = now_ms()
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.db.execute("DELETE FROM password_resets WHERE user_id=? AND (used_at IS NOT NULL OR expires_at<=?)", (u["id"], t))
            self.db.execute("UPDATE password_resets SET used_at=? WHERE user_id=? AND used_at IS NULL", (t, u["id"]))
            self.db.execute("INSERT INTO password_resets(user_id, token_hash, created_at, expires_at, ip) VALUES (?,?,?,?,?)",
                            (u["id"], token_hash(token), t, t + minutes * 60_000, ip))
        self.audit("reset_requested", None, u, "", ip)
        return token

    def reset_target(self, token: str | None):
        """The user a reset token is for, or an AccountError saying why the link can't be used."""
        if not isinstance(token, str) or not 20 <= len(token) <= 100:
            raise AccountError("bad_link", "This reset link isn't valid. Ask for a new one.", 400)
        r = self.one("SELECT * FROM password_resets WHERE token_hash=?", (token_hash(token),))
        if r is None or r["used_at"] is not None:
            raise AccountError("bad_link", "This reset link has already been used or replaced by a newer one. Ask for a new one.", 400)
        if r["expires_at"] <= now_ms():
            raise AccountError("link_expired", "This reset link has expired. Ask for a new one.", 400)
        u = self.user(r["user_id"])
        if u is None:
            raise AccountError("bad_link", "This reset link isn't valid. Ask for a new one.", 400)
        if u["status"] == "blocked":
            raise AccountError("blocked", "This account is blocked. Contact support.", 403)
        return r, u

    def use_reset(self, token: str, password: str, ip: str | None, ua: str | None, device: str | None = None):
        """Set the new password, spend the token, sign out every session and sign this browser in.
        Returns (session token, user, revoked session ids, session id)."""
        check_password_rules(password)
        pw = hash_password(password)
        with self.lock:
            r, u = self.reset_target(token)
            _, n = self.run("UPDATE password_resets SET used_at=? WHERE id=? AND used_at IS NULL", (now_ms(), r["id"]))
            if not n:   # two submits at once: only the first one counts
                raise AccountError("bad_link", "This reset link has already been used. Ask for a new one.", 400)
            self.run("UPDATE users SET pw_hash=? WHERE id=?", (pw, u["id"]))
            revoked = self.revoke_user_sessions(u["id"], "password_reset")
            self.audit("password_reset_email", u, u, f"signed out {len(revoked)} session(s)", ip)
            token_s, u2, _, sid = self.open_session(u, ip, ua, via="password reset", device=device)
        return token_s, u2, revoked, sid

    # ---------------------------------------------------------------------------------------- sign-up codes
    @staticmethod
    def _code_hash(email: str, code: str, salt: str) -> str:
        return hashlib.sha256(f"{salt}|{email}|{code}".encode()).hexdigest()

    def _new_code(self) -> tuple[str, str]:
        return f"{secrets.randbelow(1_000_000):06d}", secrets.token_hex(8)

    def start_signup(self, email, name, password, ip: str | None) -> tuple[str, str]:
        """Hold a sign-up until its owner types the code we email. Returns (code to send, ticket for the browser).
        The account, and its trial, only exist once the code is confirmed. The ticket ties the code to the browser
        that chose the password: if someone else starts a sign-up for the same address, theirs replaces the pending
        one and the earlier browser's ticket stops working, so a stranger's password can never be confirmed by the
        address owner typing a code. Starting again replaces the pending one (new code, new ticket)."""
        email = clean_email(email)
        name = clean_name(name)
        check_password_rules(password)
        if self.user_by_email(email):
            raise AccountError("email_taken", "An account with this email already exists.", 409)
        t = now_ms()
        self.run("DELETE FROM pending_signups WHERE created_at<=?", (t - DAY,))   # the per-address code count lasts a day
        p = self.one("SELECT * FROM pending_signups WHERE email=?", (email,))
        if p and t - p["last_sent_at"] < 30_000:
            raise AccountError("too_soon", "We just sent a code to this address. Wait a few seconds before asking for another.", 429)
        if p and p["sends"] >= CODE_SENDS:
            raise AccountError("too_many_codes", "Too many codes for this address. Try again in a day, or sign up with Google.", 429)
        pw = hash_password(password)
        code, salt = self._new_code()
        ticket = secrets.token_urlsafe(24)
        with self.lock:
            self.db.execute("""INSERT INTO pending_signups(email, name, pw_hash, code_hash, ticket_hash, created_at, expires_at,
                                 tries, sends, last_sent_at, ip)
                               VALUES (?,?,?,?,?,?,?,0,1,?,?)
                               ON CONFLICT(email) DO UPDATE SET name=excluded.name, pw_hash=excluded.pw_hash,
                                 code_hash=excluded.code_hash, ticket_hash=excluded.ticket_hash, expires_at=excluded.expires_at,
                                 tries=0, sends=pending_signups.sends + 1, last_sent_at=excluded.last_sent_at, ip=excluded.ip""",
                            (email, name, pw, f"{salt}${self._code_hash(email, code, salt)}", token_hash(ticket), t,
                             t + CODE_MINUTES * 60_000, t, ip))
        return code, ticket

    def _pending_for(self, email: str, ticket) -> "sqlite3.Row":
        p = self.one("SELECT * FROM pending_signups WHERE email=?", (email,))
        if p is None or not isinstance(ticket, str) or not hmac.compare_digest(token_hash(ticket), p["ticket_hash"]):
            if p is None and self.user_by_email(email):
                raise AccountError("email_taken", "This account is already confirmed. Sign in instead.", 409)
            raise AccountError("no_pending", "This sign-up was started again somewhere else, or has ended. "
                                             "Fill in the form again to get a new code.", 400)
        return p

    def resend_signup(self, email, ticket) -> tuple[str, str]:
        """A fresh code for a pending sign-up, for the browser that started it. Returns (code, name)."""
        email = clean_email(email)
        t = now_ms()
        p = self._pending_for(email, ticket)
        if t - p["last_sent_at"] < 30_000:
            raise AccountError("too_soon", "We just sent a code. Wait a few seconds before asking for another.", 429)
        if p["sends"] >= CODE_SENDS:
            raise AccountError("too_many_codes", "Too many codes for this address. Try again in a day, or sign up with Google.", 429)
        code, salt = self._new_code()
        self.run("UPDATE pending_signups SET code_hash=?, expires_at=?, tries=0, sends=sends+1, last_sent_at=? WHERE email=?",
                 (f"{salt}${self._code_hash(email, code, salt)}", t + CODE_MINUTES * 60_000, t, email))
        return code, p["name"]

    def confirm_signup(self, email, code, ticket, ip: str | None):
        """Check the emailed code and create the account (its trial starts now). Returns the new user."""
        email = clean_email(email)
        code = re.sub(r"\D", "", code if isinstance(code, str) else "")
        t = now_ms()
        with self.lock:
            p = self._pending_for(email, ticket)
            if p["expires_at"] <= t:
                raise AccountError("code_expired", "This code has expired. Ask for a new one.", 400)
            if p["tries"] >= CODE_TRIES:
                raise AccountError("code_locked", "Too many wrong codes. Ask for a new one.", 400)
            salt, want = p["code_hash"].split("$", 1)
            if len(code) != 6 or not hmac.compare_digest(self._code_hash(email, code, salt), want):
                self.run("UPDATE pending_signups SET tries=tries+1 WHERE email=?", (email,))
                left = CODE_TRIES - p["tries"] - 1
                if left <= 0:
                    raise AccountError("code_locked", "Too many wrong codes. Ask for a new one.", 400)
                raise AccountError("bad_code", f"That code isn't right. {left} {'try' if left == 1 else 'tries'} left.", 400)
            self.run("DELETE FROM pending_signups WHERE email=?", (email,))
        return self.create_user(email, p["name"], None, ip=ip, pw_hash=p["pw_hash"])

    # ---------------------------------------------------------------------------------------- payments
    def create_payment(self, u, order_id: str, amount: int, currency: str, days: int, ip=None):
        self.run("INSERT INTO payments(user_id, email, order_id, amount, currency, days, status, created_at) VALUES (?,?,?,?,?,?,?,?)",
                 (u["id"], u["email"], order_id, amount, currency, days, "created", now_ms()))
        self.audit("payment_order", u, u, f"order {order_id}, {amount / 100:.2f} {currency}", ip)

    def payment(self, order_id: str):
        return self.one("SELECT * FROM payments WHERE order_id=?", (order_id,))

    def payments_of(self, uid: int, limit: int = 50):
        return [dict(r) for r in self.q("SELECT * FROM payments WHERE user_id=? ORDER BY id DESC LIMIT ?", (uid, limit))]

    def complete_payment(self, u, order_id: str, payment_id: str, ip=None):
        """Mark a verified order paid and extend the account by the order's days, exactly once.
        Returns (user, newly_paid). Call only after the Razorpay signature has been checked."""
        with self.lock:
            p = self.payment(order_id)
            if p is None or p["user_id"] != u["id"]:
                raise AccountError("unknown_order", "This payment doesn't belong to your account.", 400)
            if p["status"] == "paid":
                if p["payment_id"] == payment_id:   # the same confirmation sent twice: already counted
                    return self.user(u["id"]), False
                raise AccountError("order_paid", "This order has already been paid.", 400)
            self.run("UPDATE payments SET status='paid', payment_id=?, paid_at=? WHERE order_id=? AND status='created'",
                     (payment_id, now_ms(), order_id))
            nu = self.extend(u["id"], days=p["days"], actor=u, ip=ip)
            self.audit("payment", u, nu, f"paid {p['amount'] / 100:.2f} {p['currency']}, +{p['days']} days, "
                                         f"order {order_id}, payment {payment_id}", ip)
            return nu, True

    def ensure_admin(self, email: str | None, password: str | None):
        """Make sure an admin exists. Returns (email, generated password or None).

        With FLOWDECK_ADMIN_EMAIL/PASSWORD set, that admin is created if no account uses the email. An existing
        account is never promoted: anyone could have signed up with that address (or taken it over after the
        real admin changed theirs). Without the env vars, or if they can't be applied and there is no admin at
        all, a random admin login is generated."""
        if email and password:
            u = self.user_by_email(email)
            if u is None:
                self.create_user(email, "Admin", password, role="admin", created_by="env")
                return email, None
            if u["role"] != "admin":
                self.audit("bootstrap_skipped", None, u, "FLOWDECK_ADMIN_EMAIL belongs to a regular account; not promoted")
        if self.count_admins() > 0:
            return None, None
        pw = secrets.token_urlsafe(12)
        email = "admin@flowdeck.local"
        u = self.user_by_email(email)
        if u and u["created_by"] == "bootstrap":
            self.run("UPDATE users SET role='admin', status='active', pw_hash=? WHERE id=?", (hash_password(pw), u["id"]))
        else:
            if u:   # someone registered the bootstrap address: pick another one
                email = f"admin-{secrets.token_hex(3)}@flowdeck.local"
            self.create_user(email, "Admin", pw, role="admin", created_by="bootstrap")
        return email, pw


class RateLimiter:
    """Sliding-window counter per key (in memory)."""

    def __init__(self, limit: int, window_ms: int):
        self.limit = limit
        self.window = window_ms
        self.hits: dict[str, list[int]] = {}

    def hit(self, key: str) -> bool:
        t = now_ms()
        arr = [x for x in self.hits.get(key, []) if x > t - self.window]
        arr.append(t)
        self.hits[key] = arr
        if len(self.hits) > 20000:
            for k in list(self.hits)[:5000]:
                self.hits.pop(k, None)
        return len(arr) <= self.limit

    def count(self, key: str) -> int:
        t = now_ms()
        return sum(1 for x in self.hits.get(key, []) if x > t - self.window)

    def full(self, key: str) -> bool:
        return self.count(key) >= self.limit

    def reset(self, key: str):
        self.hits.pop(key, None)
