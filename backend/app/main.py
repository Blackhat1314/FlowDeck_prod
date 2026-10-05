"""FastAPI app: landing page, sign-in, the order-flow dashboard (/app), the admin panel (/admin) and the data stream (/ws).

Access model
- /app and /ws need a signed-in user. Users with an active plan (trial or paid) get the live stream.
  Expired users get one frozen snapshot and no updates.
- One session per account. A new login revokes the old session and closes its open dashboards (code 4409).
- /admin and /api/admin/* need role=admin.
"""
from __future__ import annotations

import asyncio
import csv
import io
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote, urlparse

import orjson
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.middleware.gzip import GZipMiddleware

from .envfile import load_env_file

# settings such as the Razorpay keys can live in backend/.env (or .env at the project root); real environment
# variables win. Loaded before anything below reads the environment.
load_env_file(Path(__file__).resolve().parent.parent / ".env", Path(__file__).resolve().parent.parent.parent / ".env")

from .accounts import DAY, AccountError, Accounts, RateLimiter  # noqa: E402
from .accounts import now_ms as now_ms_int  # noqa: E402
from .google_auth import GoogleTokenError, GoogleVerifier, valid_client_id  # noqa: E402
from .payments import PLAN_DAYS, Razorpay, RazorpayError  # noqa: E402
from .engine import VENUES
from .engine.xchg import XVENUES
from .runtime import Client, Runtime, now_ms

log = logging.getLogger("flow")
BACKEND = Path(__file__).resolve().parent.parent
STATIC = BACKEND / "static"
DB_PATH = Path(os.environ.get("FLOWDECK_DB", str(BACKEND / "data" / "flowdeck.db")))
COOKIE = "fd_session"
TRUST_PROXY = os.environ.get("FLOWDECK_TRUST_PROXY") == "1"
FORCE_SECURE = os.environ.get("FLOWDECK_SECURE_COOKIE") == "1"
# how many proxies sit in front of the app (nginx = 1, Cloudflare + nginx = 2); used to pick the real client IP
PROXY_HOPS = max(1, int(os.environ.get("FLOWDECK_PROXY_HOPS", "1") or 1))
# "Sign in with Google": the OAuth client ID from Google Cloud (public, not a secret). Set
# FLOWDECK_GOOGLE_CLIENT_ID to another ID to use your own, or to an empty value to hide the Google button.
GOOGLE_CLIENT_ID = os.environ.get("FLOWDECK_GOOGLE_CLIENT_ID",
                                  "858381296511-4t3ipt8m3r4jkblpp4781a81drorj7ab.apps.googleusercontent.com").strip()
if GOOGLE_CLIENT_ID and not valid_client_id(GOOGLE_CLIENT_ID):
    logging.getLogger("flow").warning("FLOWDECK_GOOGLE_CLIENT_ID doesn't look like a Google client ID; Google sign-in is off")
    GOOGLE_CLIENT_ID = ""
google = GoogleVerifier(GOOGLE_CLIENT_ID) if GOOGLE_CLIENT_ID else None
# Razorpay Standard Checkout: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (environment or .env). Without them the
# Pay button is hidden and users are pointed to the contact email.
razorpay = Razorpay.from_env()

# websocket close codes understood by the dashboard
WS_CODES = {"no_session": 4401, "session_expired": 4401, "logout": 4401, "replaced": 4409, "blocked": 4403,
            "deleted": 4404, "admin_logout": 4410, "revoked": 4401, "reconnect": 4100, "other_tab": 4411}

runtime: Runtime | None = None
accounts: Accounts | None = None
login_ip = RateLimiter(20, 15 * 60_000)      # failed logins per IP
login_pair = RateLimiter(8, 15 * 60_000)     # failed logins per email from one IP
login_email = RateLimiter(60, 15 * 60_000)   # failed logins per email from anywhere (slows distributed guessing
                                             # without letting one stranger lock the owner out)
pw_change = RateLimiter(6, 15 * 60_000)      # wrong current-password attempts per account
frozen_snap = RateLimiter(4, 30 * 60_000)    # fresh snapshots per expired account (reloading is not a live feed)
signup_ip = RateLimiter(8, 60 * 60_000)      # sign-ups per IP
google_ip = RateLimiter(30, 15 * 60_000)     # Google sign-in attempts per IP
pay_orders = RateLimiter(20, 60 * 60_000)    # checkout orders per account
pay_verify = RateLimiter(30, 60 * 60_000)    # payment confirmations per account
hist_reqs = RateLimiter(240, 10 * 60_000)    # history requests per account (scrolling back loads chunks)


# ============================================================================================ presence
class Presence:
    """Open dashboard connections per user, so admin actions and new logins take effect immediately."""

    def __init__(self):
        self.clients: set[Client] = set()

    def add(self, c: Client):
        self.clients.add(c)

    def remove(self, c: Client):
        self.clients.discard(c)

    def of_user(self, uid: int):
        return [c for c in self.clients if c.uid == uid and not c.dead]

    def online(self):
        t = now_ms_int()
        out = []
        for c in list(self.clients):
            if c.dead:
                continue
            out.append({"user_id": c.uid, "session_id": c.sid, "email": c.email, "name": c.name, "ip": c.ip,
                        "ua": c.ua, "since": c.since, "live": c.live, "seconds": round((t - c.since) / 1000)})
        out.sort(key=lambda r: r["since"])
        return out


presence = Presence()


def freeze(c: Client, reason="trial_ended"):
    """Stop live updates for a connection; it keeps the last picture."""
    runtime.hub.remove(c)
    c.live = False
    c.put(("t", orjson.dumps({"type": "frozen", "reason": reason, "at": now_ms_int()}).decode()))


def close_client(c: Client, problem: str):
    code = WS_CODES.get(problem, 4401)
    c.put(("c", (code, problem)))


def enforce(clients):
    """Re-check access for open connections: revoke, block, delete, expire or (after an extension) reconnect."""
    t = now_ms_int()
    for c in list(clients):
        if c.dead:
            continue
        row = accounts.one(
            """SELECT s.revoked_at, s.revoke_reason, s.expires_at AS s_exp, u.id AS uid, u.status, u.role, u.expires_at
               FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id=?""", (c.sid,))
        if row is None or row["uid"] is None:
            close_client(c, "deleted")
        elif row["revoked_at"]:
            close_client(c, row["revoke_reason"] or "revoked")
        elif row["s_exp"] <= t:
            close_client(c, "session_expired")
        elif row["status"] == "blocked":
            close_client(c, "blocked")
        else:
            live = row["role"] == "admin" or row["expires_at"] is None or row["expires_at"] > t
            if c.live and not live:
                freeze(c)
            elif not c.live and live:
                close_client(c, "reconnect")   # access restored: reconnect to get the live stream


async def enforcer():
    last_touch = 0.0
    while True:
        await asyncio.sleep(10)
        try:
            enforce(presence.clients)
            if time.time() - last_touch > 60:
                last_touch = time.time()
                cs = [c for c in presence.clients if not c.dead]
                accounts.touch([c.sid for c in cs], [c.uid for c in cs])
        except Exception:
            log.exception("enforcer failed")


# ============================================================================================ app
@asynccontextmanager
async def lifespan(app: FastAPI):
    global runtime, accounts
    accounts = Accounts(DB_PATH)
    email, pw = accounts.ensure_admin(os.environ.get("FLOWDECK_ADMIN_EMAIL"), os.environ.get("FLOWDECK_ADMIN_PASSWORD"))
    if pw:
        note = DB_PATH.parent / "FIRST_ADMIN_LOGIN.txt"
        note.write_text(f"Flowdeck admin login\nEmail: {email}\nPassword: {pw}\n\n"
                        "Sign in at /login, then change the password (top-right menu > Change password)\n"
                        "and change the email in the admin panel. Delete this file afterwards.\n", encoding="utf-8")
        log.warning("=" * 70)
        log.warning("First admin created: %s / %s", email, pw)
        log.warning("Also saved to %s - change it after signing in.", note)
        log.warning("=" * 70)
    runtime = Runtime(venue=os.environ.get("FLOW_VENUE", "usdm"), demo=os.environ.get("FLOW_DEMO") == "1",
                      archive_root=DB_PATH.parent / "history",
                      archive_days=int(os.environ.get("FLOWDECK_ARCHIVE_DAYS", "0") or 0),
                      fill_days=int(os.environ.get("FLOWDECK_FILL_DAYS", "7") or 0))
    await runtime.start()
    task = asyncio.create_task(enforcer())
    yield
    task.cancel()
    await runtime.stop()


app = FastAPI(title="Flowdeck", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


NOINDEX = ("/app", "/admin", "/api/", "/login", "/signup")   # kept out of search results (see also robots.txt)


@app.middleware("http")
async def headers(request: Request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")   # Google's sign-in button needs the origin
    resp.headers.setdefault("X-Frame-Options", "DENY")
    path = request.url.path
    if path.startswith(NOINDEX):
        resp.headers.setdefault("X-Robots-Tag", "noindex")
    if path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")
    elif path.startswith("/assets/") and resp.status_code in (200, 206):
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"   # file names carry a content hash
    return resp


class SelectiveGZip:
    """gzip text responses; leave already-compressed media (video, images, fonts) alone so range requests work."""
    SKIP = (".mp4", ".webm", ".webp", ".jpg", ".jpeg", ".png", ".woff", ".woff2", ".gz")

    def __init__(self, app):
        self.app = app
        self.gzip = GZipMiddleware(app, minimum_size=1024, compresslevel=6)

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("path", "").lower().endswith(self.SKIP):
            await self.app(scope, receive, send)
        else:
            await self.gzip(scope, receive, send)


app.add_middleware(SelectiveGZip)


@app.exception_handler(AccountError)
async def account_error(request: Request, e: AccountError):
    return JSONResponse({"ok": False, "error": e.code, "message": e.message}, status_code=e.status)


def err(code: str, message: str, status: int = 400):
    raise AccountError(code, message, status)


def as_int(v, name: str):
    """Optional integer from a JSON body: None/'' -> None, anything else must be a whole number."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        err("bad_request", f"{name} must be a number.")
    try:
        f = float(v)
    except (TypeError, ValueError):
        err("bad_request", f"{name} must be a number.")
    if f != f or abs(f) > 1e15:
        err("bad_request", f"{name} is out of range.")
    return int(f)


# -------------------------------------------------------------------------------------------- request helpers
def peer_ip(headers, client) -> str:
    """Client IP. Behind a proxy, the right-most X-Forwarded-For entries are the ones our own proxies appended;
    anything to their left was sent by the client and can't be trusted."""
    if TRUST_PROXY:
        parts = [x.strip() for x in (headers.get("x-forwarded-for") or "").split(",") if x.strip()]
        if parts:
            return parts[-min(PROXY_HOPS, len(parts))]
    return client.host if client else "?"


def client_ip(request) -> str:
    return peer_ip(request.headers, request.client)


def is_https(request) -> bool:
    if FORCE_SECURE or request.url.scheme == "https":
        return True
    return TRUST_PROXY and request.headers.get("x-forwarded-proto") == "https"


def same_origin(headers) -> bool:
    origin = headers.get("origin")
    if not origin:
        return True
    host = headers.get("x-forwarded-host") if TRUST_PROXY and headers.get("x-forwarded-host") else headers.get("host")
    return urlparse(origin).netloc == host


async def body(request: Request) -> dict:
    """JSON body for state-changing calls, with a same-origin check (CSRF)."""
    if not same_origin(request.headers):
        err("bad_origin", "Cross-site request refused.", 403)
    if (request.headers.get("content-type") or "").split(";")[0].strip().lower() != "application/json":
        err("bad_request", "Send JSON.", 415)
    try:
        d = orjson.loads(await request.body() or b"{}")
    except Exception:
        err("bad_request", "Invalid JSON.")
    if not isinstance(d, dict):
        err("bad_request", "Invalid JSON.")
    return d


def current(request: Request, need_admin=False):
    s, u, problem = accounts.session(request.cookies.get(COOKIE))
    if problem:
        err(problem, {"replaced": "You signed in on another device.", "blocked": "This account is blocked.",
                      "admin_logout": "You were signed out by an admin.", "deleted": "This account no longer exists."}
            .get(problem, "Please sign in."), 401)
    if need_admin and u["role"] != "admin":
        err("forbidden", "Admins only.", 403)
    return s, u


def set_cookie(resp: Response, request: Request, token: str):
    resp.set_cookie(COOKIE, token, max_age=30 * 86400, httponly=True, samesite="lax", secure=is_https(request), path="/")


def me_json(u) -> dict:
    t = now_ms_int()
    return {"user": {"id": u["id"], "name": u["name"], "email": u["email"], "role": u["role"], "plan": u["plan"],
                     "expires_at": u["expires_at"], "state": accounts.state(u, t), "created_at": u["created_at"],
                     "google": bool(u["google_sub"]), "has_password": bool(u["pw_hash"]),
                     "tour_done": bool(u["tour_done_at"])},
            "live": accounts.has_live(u, t), "server_time": t, "config": public_cfg()}


def public_cfg() -> dict:
    return {**accounts.public_config(), "google_client_id": GOOGLE_CLIENT_ID or None,
            "payments_enabled": razorpay.enabled, "payments_test": razorpay.enabled and razorpay.test_mode,
            "plan_days": PLAN_DAYS}


def kick_others(uid: int, keep_sid: int | None, problem: str):
    for c in presence.of_user(uid):
        if c.sid != keep_sid:
            close_client(c, problem)


# ============================================================================================ pages
def page(name: str):
    f = STATIC / name
    if not f.exists():
        return JSONResponse({"error": "frontend not built: run `npm run build` in frontend/"}, status_code=500)
    return FileResponse(f, headers={"Cache-Control": "no-cache"})


def to_login(request: Request, nxt: str, reason: str | None = None):
    q = f"?next={quote(nxt)}" + (f"&reason={quote(reason)}" if reason and reason != "no_session" else "")
    return RedirectResponse(f"/login{q}", status_code=302)


@app.get("/", include_in_schema=False)
async def landing():
    return page("index.html")


# files the build copies from frontend/public to the site root: icons, the social card, robots.txt, sitemap
ROOT_FILES = {"robots.txt": "text/plain; charset=utf-8", "sitemap.xml": "application/xml", "favicon.ico": "image/x-icon",
              "favicon.svg": "image/svg+xml", "apple-touch-icon.png": "image/png", "icon-192.png": "image/png",
              "icon-512.png": "image/png", "og.jpg": "image/jpeg", "site.webmanifest": "application/manifest+json"}


def root_file(name: str, media_type: str):
    async def serve():
        f = STATIC / name
        if not f.exists():
            return Response(status_code=404)
        return FileResponse(f, media_type=media_type, headers={"Cache-Control": "public, max-age=86400"})
    return serve


for _name, _type in ROOT_FILES.items():
    app.add_api_route(f"/{_name}", root_file(_name, _type), methods=["GET", "HEAD"], include_in_schema=False)


@app.get("/login", include_in_schema=False)
@app.get("/signup", include_in_schema=False)
async def auth_page(request: Request):
    return page("auth.html")


@app.get("/app", include_in_schema=False)
async def app_page(request: Request):
    s, u, problem = accounts.session(request.cookies.get(COOKIE))
    if problem:
        return to_login(request, "/app", problem)
    return page("app.html")


@app.get("/guide", include_in_schema=False)
async def guide_page():
    """The Flowdeck field manual (English): every chart, marker and setting explained."""
    return page("guide.html")


@app.get("/privacy", include_in_schema=False)
@app.get("/terms", include_in_schema=False)
async def legal_page():
    return page("legal.html")


@app.get("/admin", include_in_schema=False)
async def admin_page(request: Request):
    s, u, problem = accounts.session(request.cookies.get(COOKIE))
    if problem:
        return to_login(request, "/admin", problem)
    if u["role"] != "admin":
        return RedirectResponse("/app", status_code=302)
    return page("admin.html")


# ============================================================================================ public + auth API
@app.get("/api/public/config")
async def public_config():
    return public_cfg()


@app.get("/api/venues")
async def venues():
    return [{"key": v.key, "label": v.label, "exchange": v.exchange, "symbol": v.symbol} for v in VENUES.values()]


@app.post("/api/auth/signup")
async def signup(request: Request):
    d = await body(request)
    ip = client_ip(request)
    if accounts.settings()["signups_open"] != "1":
        err("signups_closed", "New sign-ups are paused. Contact us for access.", 403)
    if not signup_ip.hit(ip):
        err("rate_limited", "Too many sign-ups from your network. Try again later.", 429)
    u = await asyncio.to_thread(accounts.create_user, d.get("email"), d.get("name"), d.get("password"), ip=ip)
    token, u, _, sid = accounts.open_session(u, ip, request.headers.get("user-agent"))
    resp = JSONResponse({"ok": True, **me_json(u)})
    set_cookie(resp, request, token)
    return resp


@app.post("/api/auth/login")
async def login(request: Request):
    d = await body(request)
    ip = client_ip(request)
    email = d.get("email")
    email = email.strip().lower()[:200] if isinstance(email, str) else ""
    pair = f"{email}|{ip}"
    if login_ip.full(ip) or login_pair.full(pair) or login_email.full(email):
        err("rate_limited", "Too many failed attempts. Wait 15 minutes and try again.", 429)
    try:
        token, u, revoked, sid = await asyncio.to_thread(accounts.login, email, d.get("password") or "", ip,
                                                         request.headers.get("user-agent"))
    except AccountError as e:
        if e.code == "bad_login":
            login_ip.hit(ip)
            login_pair.hit(pair)
            login_email.hit(email)
        raise
    login_pair.reset(pair)
    kick_others(u["id"], sid, "replaced")
    resp = JSONResponse({"ok": True, "replaced": len(revoked), **me_json(u)})
    set_cookie(resp, request, token)
    return resp


@app.post("/api/auth/google")
async def google_signin(request: Request):
    """The browser posts the ID token Google gave it; see google_auth for the checks."""
    d = await body(request)
    ip = client_ip(request)
    if google is None:
        err("google_off", "Google sign-in isn't set up on this server.", 404)
    if not google_ip.hit(ip):
        err("rate_limited", "Too many attempts. Wait 15 minutes and try again.", 429)
    try:
        claims = await google.verify(d.get("credential"))
    except GoogleTokenError as e:
        accounts.audit("login_failed", None, None, f"Google: {e.message}"[:120], ip)
        err("google_failed", e.message, 401)
    existing = accounts.google_account(claims["sub"], (claims.get("email") or "").strip().lower())
    allow_create = False
    if existing is None:
        if accounts.settings()["signups_open"] != "1":
            err("signups_closed", "New sign-ups are paused. Contact us for access.", 403)
        if not signup_ip.hit(ip):
            err("rate_limited", "Too many sign-ups from your network. Try again later.", 429)
        allow_create = True
    token, u, revoked, sid, created, cleared = await asyncio.to_thread(
        accounts.google_login, claims, ip, request.headers.get("user-agent"), allow_create)
    kick_others(u["id"], sid, "replaced")
    resp = JSONResponse({"ok": True, "created": created, "password_cleared": cleared, "replaced": len(revoked), **me_json(u)})
    set_cookie(resp, request, token)
    return resp


# ============================================================================================ payments (Razorpay)
@app.post("/api/create-order")
async def create_order(request: Request):
    """Start a payment for one plan period. The price comes from the site settings, not from the browser."""
    await body(request)
    s, u = current(request)
    if not razorpay.enabled:
        err("payments_off", "Online payment isn't set up on this server yet.", 503)
    if not pay_orders.hit(str(u["id"])):
        err("rate_limited", "Too many payment attempts. Try again in an hour.", 429)
    try:
        amount = int(accounts.settings()["price_inr"]) * 100
    except ValueError:
        amount = 0
    if amount < 100:
        err("bad_amount", "The plan price isn't set. Ask the site owner to set it in the admin panel.", 400)
    receipt = f"fd-{u['id']}-{now_ms_int()}"
    try:
        order = await razorpay.create_order(amount, "INR", receipt, {"user_id": str(u["id"]), "email": u["email"],
                                                                     "days": str(PLAN_DAYS)})
    except RazorpayError as e:
        log.warning("razorpay create order failed: %s", e.message)
        err(e.code, e.message, e.status)
    accounts.create_payment(u, order["id"], int(order.get("amount", amount)), order.get("currency", "INR"), PLAN_DAYS,
                            ip=client_ip(request))
    return {"order_id": order["id"], "amount": order.get("amount", amount), "currency": order.get("currency", "INR"),
            "key_id": razorpay.key_id, "name": "Flowdeck", "description": f"{PLAN_DAYS} days of live data",
            "prefill": {"name": u["name"], "email": u["email"]}, "days": PLAN_DAYS}


@app.post("/api/verify-payment")
async def verify_payment(request: Request):
    """Razorpay's checkout result. Marks the order paid only when the signature matches."""
    d = await body(request)
    s, u = current(request)
    order_id, payment_id, signature = d.get("razorpay_order_id"), d.get("razorpay_payment_id"), d.get("razorpay_signature")
    if not all(isinstance(x, str) and 0 < len(x) <= 200 for x in (order_id, payment_id, signature)):
        err("missing_fields", "razorpay_order_id, razorpay_payment_id and razorpay_signature are required.", 400)
    if not razorpay.enabled:
        err("payments_off", "Online payment isn't set up on this server yet.", 503)
    if not pay_verify.hit(str(u["id"])):
        err("rate_limited", "Too many attempts. Try again in an hour.", 429)
    if not razorpay.verify(order_id, payment_id, signature):
        accounts.audit("payment_failed", u, u, f"signature mismatch, order {order_id[:40]}, payment {payment_id[:40]}",
                       client_ip(request))
        err("bad_signature", "We couldn't confirm this payment. If money left your account, contact us with the payment ID "
                             f"{payment_id[:40]}.", 400)
    nu, newly = await asyncio.to_thread(accounts.complete_payment, u, order_id, payment_id, ip=client_ip(request))
    enforce(presence.of_user(u["id"]))   # open dashboards go live again
    return {"ok": True, "newly_paid": newly, "payment_id": payment_id, **me_json(nu)}


# ============================================================================================ history (heatmap, footprint)
def history_user(request: Request):
    s, u = current(request)
    if not accounts.has_live(u):
        err("plan_ended", "History is part of the live plan.", 403)
    if not hist_reqs.hit(str(u["id"])):
        err("rate_limited", "Too many history requests. Wait a minute.", 429)
    return u


@app.get("/api/history/heatmap")
async def heatmap_history(request: Request, before: float, span: float = 4 * 3600_000):
    """Older heatmap columns ending at `before` (ms): 5-second columns while the last 12 hours have them, 1-minute
    columns from the archive before that. Body: frames of u32 length | history message (see engine/heattiers.py)."""
    history_user(request)
    from .engine.heattiers import TIER_1M, TIER_5S, pack_history
    eng = runtime.engine
    span = max(60_000.0, min(float(span), 48 * 3600_000.0))
    t1, t0 = float(before), float(before) - span
    first5 = eng.tiers.first_time()
    if first5 is not None and t1 > first5:
        dt, recs = TIER_5S, eng.tiers.range(max(t0, first5), t1, 4320)
    elif runtime.archive is not None:
        dt, recs = TIER_1M, await asyncio.to_thread(runtime.archive.read_heat, "1m", t0, t1, 2880)
    else:
        dt, recs = TIER_1M, []
    out = bytearray()
    for i in range(0, len(recs), 400):
        msg = pack_history(dt, recs[i:i + 400])
        out += len(msg).to_bytes(4, "little") + msg
    return Response(bytes(out), media_type="application/octet-stream",
                    headers={"Cache-Control": "no-store", "X-History-Dt": str(dt), "X-History-Count": str(len(recs))})


@app.get("/api/history/footprint")
async def footprint_history(request: Request, start: float, end: float):
    """Archived 1-minute footprint bars (per-price buy/sell) between start and end (ms), at most 3 days per call."""
    history_user(request)
    end = min(float(end), float(start) + 3 * 86_400_000)
    bars = await asyncio.to_thread(runtime.archive.read_bars, float(start), end) if runtime.archive is not None else []
    return Response(orjson.dumps({"bars": bars}), media_type="application/json", headers={"Cache-Control": "no-store"})


@app.post("/api/auth/logout")
async def logout(request: Request):
    await body(request)
    s, u, problem = accounts.session(request.cookies.get(COOKIE))
    if s and not problem:
        accounts.revoke_session(s["id"], "logout")
        accounts.audit("logout", u, u, "", client_ip(request))
        for c in presence.of_user(u["id"]):
            if c.sid == s["id"]:
                close_client(c, "logout")
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(COOKIE, path="/")
    return resp


@app.get("/api/auth/me")
async def me(request: Request):
    s, u = current(request)
    return me_json(u)


@app.get("/api/auth/state")
async def auth_state(request: Request):
    """Like /api/auth/me, but answers 200 with user=null when signed out (the public pages ask on every visit)."""
    s, u, problem = accounts.session(request.cookies.get(COOKIE))
    return {"user": None} if problem else me_json(u)


@app.post("/api/me/tour")
async def tour_state(request: Request):
    """The first-visit tour was finished or skipped (done=true), or the user wants it again (done=false)."""
    d = await body(request)
    s, u = current(request)
    accounts.set_tour_done(u["id"], bool(d.get("done", True)))
    return {"ok": True}


@app.post("/api/auth/password")
async def change_password(request: Request):
    d = await body(request)
    s, u = current(request)
    from .accounts import verify_password
    key = str(u["id"])
    if pw_change.full(key):
        err("rate_limited", "Too many wrong passwords. Wait 15 minutes and try again.", 429)
    cur = d.get("current")
    # accounts made with Google have no password: the first one needs no current password, but only within
    # 15 minutes of signing in, so a stolen old session can't add a password to keep its access
    if not u["pw_hash"] and now_ms_int() - s["created_at"] > 15 * 60_000:
        err("reauth", "For your security, sign out, sign in with Google again, then set your password within 15 minutes.", 403)
    if u["pw_hash"] and not await asyncio.to_thread(verify_password, cur if isinstance(cur, str) else "", u["pw_hash"]):
        pw_change.hit(key)
        err("bad_password", "Your current password is wrong.", 400)
    await asyncio.to_thread(accounts.set_password, u["id"], d.get("new") or "", actor=u, ip=client_ip(request))
    return {"ok": True}


# ============================================================================================ admin API
def admin(request: Request):
    return current(request, need_admin=True)[1]


@app.get("/api/admin/overview")
async def admin_overview(request: Request):
    admin(request)
    o = accounts.overview()
    on = presence.online()
    o["online"] = len({r["user_id"] for r in on})
    o["online_frozen"] = len({r["user_id"] for r in on if not r["live"]})
    o["feed"] = {"venue": runtime.venue_key, "demo": runtime.demo, "status": runtime.status}
    return o


@app.get("/api/admin/users")
async def admin_users(request: Request, q: str = "", filter: str = "all"):
    admin(request)
    online = {}
    for r in presence.online():
        online.setdefault(r["user_id"], r)
    rows = accounts.list_users(q, filter)
    for r in rows:
        o = online.get(r["id"])
        r["online"] = bool(o)
        r["online_live"] = bool(o and o["live"])
    return rows


@app.post("/api/admin/users")
async def admin_create_user(request: Request):
    a = admin(request)
    d = await body(request)
    exp = as_int(d.get("expires_at"), "expires_at")
    days = as_int(d.get("days"), "days")
    if days is not None and not 1 <= days <= 3650:
        err("bad_days", "Days must be between 1 and 3650.")
    if exp is None and days is not None:
        exp = now_ms_int() + days * DAY
    u = await asyncio.to_thread(accounts.create_user, d.get("email"), d.get("name"), d.get("password"), role=d.get("role") or "user",
                             expires_at=exp, created_by="admin", actor=a,
                             ip=client_ip(request), plan=d.get("plan") or "paid")
    return accounts.user_json(u)


@app.get("/api/admin/users/{uid}")
async def admin_user(request: Request, uid: int):
    admin(request)
    u = accounts.user(uid)
    if not u:
        err("not_found", "User not found.", 404)
    sess = [dict(r) for r in accounts.q("SELECT id, created_at, last_seen_at, expires_at, ip, ua, revoked_at, revoke_reason "
                                        "FROM sessions WHERE user_id=? ORDER BY id DESC LIMIT 20", (uid,))]
    log_rows = [dict(r) for r in accounts.q("SELECT * FROM audit WHERE target_id=? OR actor_id=? ORDER BY id DESC LIMIT 50", (uid, uid))]
    return {"user": accounts.user_json(u), "sessions": sess, "audit": log_rows, "payments": accounts.payments_of(uid),
            "online": [r for r in presence.online() if r["user_id"] == uid]}


@app.patch("/api/admin/users/{uid}")
async def admin_update_user(request: Request, uid: int):
    a = admin(request)
    d = await body(request)
    if uid == a["id"] and (d.get("status") == "blocked" or d.get("role") == "user"):
        err("self", "You can't block or demote your own account.")
    allowed = {k: d[k] for k in ("name", "email", "note", "role", "status", "expires_at", "plan") if k in d}
    if "expires_at" in allowed:
        allowed["expires_at"] = as_int(allowed["expires_at"], "expires_at")
    u = accounts.update_user(uid, allowed, actor=a, ip=client_ip(request))
    enforce(presence.of_user(uid))
    return accounts.user_json(u)


@app.post("/api/admin/users/{uid}/extend")
async def admin_extend(request: Request, uid: int):
    a = admin(request)
    d = await body(request)
    u = accounts.extend(uid, days=as_int(d.get("days"), "days"), until=as_int(d.get("until"), "until"), actor=a, ip=client_ip(request))
    enforce(presence.of_user(uid))
    return accounts.user_json(u)


@app.post("/api/admin/users/{uid}/block")
async def admin_block(request: Request, uid: int):
    a = admin(request)
    await body(request)
    if uid == a["id"]:
        err("self", "You can't block your own account.")
    u = accounts.update_user(uid, {"status": "blocked"}, actor=a, ip=client_ip(request))
    accounts.revoke_user_sessions(uid, "blocked")
    enforce(presence.of_user(uid))
    return accounts.user_json(u)


@app.post("/api/admin/users/{uid}/unblock")
async def admin_unblock(request: Request, uid: int):
    a = admin(request)
    await body(request)
    u = accounts.update_user(uid, {"status": "active"}, actor=a, ip=client_ip(request))
    return accounts.user_json(u)


@app.post("/api/admin/users/{uid}/logout")
async def admin_logout_user(request: Request, uid: int):
    a = admin(request)
    await body(request)
    u = accounts.user(uid)
    if not u:
        err("not_found", "User not found.", 404)
    n = accounts.revoke_user_sessions(uid, "admin_logout")
    accounts.audit("force_logout", a, u, f"{len(n)} session(s)", client_ip(request))
    enforce(presence.of_user(uid))
    return {"ok": True, "revoked": len(n)}


@app.post("/api/admin/users/{uid}/password")
async def admin_set_password(request: Request, uid: int):
    a = admin(request)
    d = await body(request)
    await asyncio.to_thread(accounts.set_password, uid, d.get("password") or "", actor=a, ip=client_ip(request))
    if d.get("logout", True) and uid != a["id"]:
        accounts.revoke_user_sessions(uid, "admin_logout")
        enforce(presence.of_user(uid))
    return {"ok": True}


@app.delete("/api/admin/users/{uid}")
async def admin_delete(request: Request, uid: int):
    a = admin(request)
    if not same_origin(request.headers):
        err("bad_origin", "Cross-site request refused.", 403)
    if uid == a["id"]:
        err("self", "You can't delete your own account.")
    clients = presence.of_user(uid)
    accounts.delete_user(uid, actor=a, ip=client_ip(request))
    enforce(clients)
    return {"ok": True}


@app.get("/api/admin/online")
async def admin_online(request: Request):
    admin(request)
    sess = [dict(r) for r in accounts.active_sessions()]
    return {"connections": presence.online(), "sessions": sess}


@app.post("/api/admin/sessions/{sid}/revoke")
async def admin_revoke_session(request: Request, sid: int):
    a = admin(request)
    await body(request)
    row = accounts.one("SELECT user_id FROM sessions WHERE id=?", (sid,))
    if not row:
        err("not_found", "Session not found.", 404)
    accounts.revoke_session(sid, "admin_logout")
    accounts.audit("force_logout", a, accounts.user(row["user_id"]), f"session {sid}", client_ip(request))
    enforce(presence.of_user(row["user_id"]))
    return {"ok": True}


@app.get("/api/admin/audit")
async def admin_audit(request: Request, q: str = "", action: str = "", limit: int = 300):
    admin(request)
    return accounts.audit_log(limit, q, action)


@app.get("/api/admin/settings")
async def admin_settings(request: Request):
    admin(request)
    return accounts.settings()


@app.put("/api/admin/settings")
async def admin_save_settings(request: Request):
    a = admin(request)
    d = await body(request)
    return accounts.set_settings(d, actor=a, ip=client_ip(request))


@app.get("/api/admin/users.csv")
async def admin_export(request: Request):
    admin(request)
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["id", "name", "email", "role", "state", "plan", "created", "expires", "last_login", "last_seen", "last_ip", "note"])

    def iso(t):
        return time.strftime("%Y-%m-%d %H:%M", time.gmtime(t / 1000)) + " UTC" if t else ""

    def cell(v):   # stop spreadsheet apps from running user-supplied text as a formula
        v = "" if v is None else str(v)
        return "'" + v if v[:1] in ("=", "+", "-", "@", "\t", "\r") else v
    for u in accounts.list_users():
        w.writerow([u["id"], cell(u["name"]), cell(u["email"]), u["role"], u["state"], u["plan"], iso(u["created_at"]),
                    iso(u["expires_at"]), iso(u["last_login_at"]), iso(u["last_seen_at"]), cell(u["last_ip"]), cell(u["note"])])
    return Response(buf.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": "attachment; filename=flowdeck-users.csv"})


@app.get("/api/admin/accuracy")
async def admin_accuracy(request: Request):
    admin(request)
    eng = runtime.engine
    h = eng.health()
    h.update(runtime.tape_summary())
    t = now_ms()
    venues_out = []
    for key, xv in XVENUES.items():
        try:
            st = eng.xflow.v[xv.id]
        except (KeyError, IndexError):
            continue
        if st is None:
            continue
        book = h.get("xbooks", {}).get(xv.label)
        venues_out.append({"key": key, "label": xv.label, "name": xv.name, "kind": xv.kind, "primary": xv.id == eng.pvid,
                           "msgs": st.msgs, "trades": st.trades,
                           "last_msg_age_ms": round(t - st.last_msg) if st.last_msg else None,
                           "live": bool(st.last_msg) and t - st.last_msg < 30_000,
                           "px": st.px, "basis": round(st.basis, 2) if st.basis is not None else None,
                           "oi": round(st.oi, 1) if st.oi is not None else None, "fund": st.fund, "book": book})
    return {"health": h, "feeds": runtime.status, "venues": venues_out, "venue": runtime.venue_key, "demo": runtime.demo,
            "klines": list(eng.integ.klines)[-30:], "server_time": t}


@app.post("/api/admin/feed")
async def admin_feed(request: Request):
    a = admin(request)
    d = await body(request)
    key = d.get("venue")
    if key not in VENUES:
        err("bad_venue", "Unknown instrument.")
    ok = await runtime.switch(key)
    accounts.audit("feed_switch", a, None, f"venue={key}", client_ip(request))
    return {"ok": ok, "venue": runtime.venue_key}


# ============================================================================================ data stream
@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    if not same_origin(ws.headers):
        await ws.close(code=4403)
        return
    await ws.accept()
    s, u, problem = accounts.session(ws.cookies.get(COOKIE))   # read after accept: no window for a stale check
    if problem:
        await ws.close(code=WS_CODES.get(problem, 4401), reason=problem)
        return
    rt = runtime
    eng = rt.engine
    live = accounts.has_live(u)
    client = Client(ws)
    client.uid, client.sid, client.email, client.name = u["id"], s["id"], u["email"], u["name"]
    client.ip = peer_ip(ws.headers, ws.client)
    client.ua = (ws.headers.get("user-agent") or "")[:200]
    client.since = now_ms_int()
    client.live = live
    # one live connection per session: a second tab (or a copied cookie) takes over and the older one stops
    for other in presence.of_user(u["id"]):
        if other.sid == s["id"]:
            close_client(other, "other_tab")
    if not live and not frozen_snap.hit(str(u["id"])):
        # reloading over and over must not turn the frozen snapshot into a slow live feed
        client.put(("t", orjson.dumps({"type": "frozen", "reason": "trial_ended", "at": now_ms_int(),
                                       "snapshot": False}).decode()))
        presence.add(client)
        sender = asyncio.create_task(client.sender())
        try:
            while not client.dead:
                await ws.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            presence.remove(client)
            client.dead = True
            sender.cancel()
        return
    # build the snapshot and register in the same synchronous step -> no gap / no duplicates
    js, bins = eng.init_payload(now_ms())
    js["demo"] = rt.demo
    js["venues"] = [{"key": v.key, "label": v.label, "exchange": v.exchange} for v in VENUES.values()]
    client.put(("t", orjson.dumps(js).decode()))
    for b in bins:
        client.put(("b", b))
    client.q._maxsize = max(client.q.maxsize, len(bins) + 1500)  # history burst
    if live:
        rt.hub.add(client)
    else:
        client.put(("t", orjson.dumps({"type": "frozen", "reason": "trial_ended", "at": now_ms_int()}).decode()))
    presence.add(client)
    sender = asyncio.create_task(client.sender())
    try:
        while not client.dead:
            msg = await ws.receive_text()
            try:
                cmd = orjson.loads(msg)
            except Exception:
                continue
            if not isinstance(cmd, dict):
                continue
            if cmd.get("cmd") == "venue":
                cu = accounts.user(client.uid)
                if cu and cu["role"] == "admin":
                    accounts.audit("feed_switch", cu, None, f"venue={cmd.get('key')}", client.ip)
                    asyncio.create_task(rt.switch(cmd.get("key", "usdm")))
            elif cmd.get("cmd") == "ping":
                client.put(("t", orjson.dumps({"type": "pong", "id": cmd.get("id")}).decode()))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        rt.hub.remove(client)
        presence.remove(client)
        client.dead = True
        sender.cancel()


if (STATIC / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC / "assets")), name="assets")
