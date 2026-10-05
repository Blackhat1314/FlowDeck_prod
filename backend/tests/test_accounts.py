"""Accounts, trial access, single session and admin API (runs the server in demo mode with a temporary database)."""
import os
import tempfile
import time

import pytest

TMP = tempfile.mkdtemp(prefix="fd-test-")
os.environ["FLOWDECK_DB"] = os.path.join(TMP, "t.db")
os.environ["FLOW_DEMO"] = "1"
os.environ["FLOW_DEMO_WARMUP_MIN"] = "1"
os.environ["FLOWDECK_ADMIN_EMAIL"] = "boss@example.com"
os.environ["FLOWDECK_ADMIN_PASSWORD"] = "boss-password-1"

from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from app.accounts import DAY, Accounts, AccountError, hash_password, now_ms, verify_password  # noqa: E402
from app import main  # noqa: E402

J = {"origin": "http://testserver"}


# ------------------------------------------------------------------------------------------ unit
def test_password_hash_roundtrip():
    h = hash_password("correct horse")
    assert h.startswith("scrypt$") and verify_password("correct horse", h) and not verify_password("wrong", h)


def test_trial_and_expiry_rules():
    a = Accounts(os.path.join(TMP, "unit.db"))
    u = a.create_user("A@B.com", "Ann", "password1")
    assert u["email"] == "a@b.com" and u["plan"] == "trial"
    assert abs(u["expires_at"] - (now_ms() + 3 * DAY)) < 5000
    assert a.has_live(u) and a.state(u) == "trial"
    a.update_user(u["id"], {"expires_at": now_ms() - 1})
    u = a.user(u["id"])
    assert not a.has_live(u) and a.state(u) == "expired"
    u = a.extend(u["id"], days=30)
    assert a.has_live(u) and a.state(u) == "active" and u["plan"] == "paid"
    with pytest.raises(AccountError):
        a.create_user("a@b.com", "Dup", "password1")
    with pytest.raises(AccountError):
        a.create_user("bad-email", "X", "password1")
    with pytest.raises(AccountError):
        a.create_user("c@d.com", "X", "short")


def test_single_session_revokes_previous():
    a = Accounts(os.path.join(TMP, "unit2.db"))
    a.create_user("s@x.io", "S", "password1")
    t1, *_ = a.login("s@x.io", "password1", "1.1.1.1", "ua1")
    t2, u, revoked, _ = a.login("s@x.io", "password1", "2.2.2.2", "ua2")
    assert len(revoked) == 1
    assert a.session(t1)[2] == "replaced"
    assert a.session(t2)[2] is None


def test_last_admin_protected():
    a = Accounts(os.path.join(TMP, "unit3.db"))
    ad = a.create_user("ad@x.io", "Ad", "password1", role="admin", created_by="admin")
    for upd in ({"role": "user"}, {"status": "blocked"}):
        with pytest.raises(AccountError):
            a.update_user(ad["id"], upd)
    with pytest.raises(AccountError):
        a.delete_user(ad["id"])


# ------------------------------------------------------------------------------------------ server
@pytest.fixture(scope="module")
def srv():
    with TestClient(main.app, base_url="http://testserver") as c:
        yield c


def client():
    return TestClient(main.app, base_url="http://testserver")


def signup(c, email, pw="password123", name="Tester"):
    main.signup_ip.hits.clear()   # the per-IP sign-up limit has its own test
    return c.post("/api/auth/signup", json={"name": name, "email": email, "password": pw}, headers=J)


def login(c, email, pw):
    return c.post("/api/auth/login", json={"email": email, "password": pw}, headers=J)


def read_until(ws, kind, limit=20000):
    for _ in range(limit):
        m = ws.receive()
        if m.get("type") == "websocket.close":
            raise WebSocketDisconnect(m.get("code", 1000))
        if m.get("text") and f'"type":"{kind}"' in m["text"]:
            return m["text"]
    raise AssertionError(f"no {kind} message")


def test_pages_require_login(srv):
    r = srv.get("/app", follow_redirects=False)
    assert r.status_code == 302 and r.headers["location"].startswith("/login?next=/app")
    r = srv.get("/admin", follow_redirects=False)
    assert r.status_code == 302


def test_signup_gives_trial_and_live_stream(srv):
    c = client()
    with c:
        r = signup(c, "trial@example.com")
        assert r.status_code == 200, r.text
        me = c.get("/api/auth/me").json()
        assert me["live"] and me["user"]["state"] == "trial"
        assert c.get("/app", follow_redirects=False).status_code == 200
        assert c.get("/admin", follow_redirects=False).status_code == 302   # not admin
        with c.websocket_connect("/ws", headers=J) as ws:
            assert '"type":"init"' in ws.receive_text()


def test_expired_user_gets_frozen_snapshot(srv):
    c = client()
    with c:
        signup(c, "late@example.com")
        uid = c.get("/api/auth/me").json()["user"]["id"]
        main.accounts.update_user(uid, {"expires_at": now_ms() - 1000})
        assert not c.get("/api/auth/me").json()["live"]
        with c.websocket_connect("/ws", headers=J) as ws:
            assert '"type":"init"' in ws.receive_text()
            read_until(ws, "frozen")
            assert all(cl.uid != uid for cl in main.runtime.hub.clients)   # no live updates


def test_second_login_kicks_first_device(srv):
    a, b = client(), client()
    with a, b:
        signup(a, "solo@example.com", pw="password-solo")
        with a.websocket_connect("/ws", headers=J) as ws:
            ws.receive_text()
            assert login(b, "solo@example.com", "password-solo").status_code == 200
            with pytest.raises(WebSocketDisconnect) as e:
                for _ in range(20000):
                    m = ws.receive()
                    if m.get("type") == "websocket.close":
                        raise WebSocketDisconnect(m.get("code"))
            assert e.value.code == 4409
        r = a.get("/api/auth/me")
        assert r.status_code == 401 and r.json()["error"] == "replaced"
        assert b.get("/api/auth/me").status_code == 200


def test_login_errors_and_rate_limit(srv):
    c = client()
    with c:
        signup(c, "rl@example.com", pw="password-rl")
    c2 = client()
    with c2:
        assert login(c2, "rl@example.com", "nope").status_code == 401
        for _ in range(8):
            login(c2, "rl@example.com", "nope")
        r = login(c2, "rl@example.com", "password-rl")
        assert r.status_code == 429


def test_cross_site_post_refused(srv):
    c = client()
    with c:
        r = c.post("/api/auth/login", json={"email": "x@y.zz", "password": "whatever1"}, headers={"origin": "https://evil.example"})
        assert r.status_code == 403
        r = c.post("/api/auth/login", content=b"email=x", headers={**J, "content-type": "application/x-www-form-urlencoded"})
        assert r.status_code == 415


def test_admin_flow(srv):
    ad, u = client(), client()
    with ad, u:
        assert login(ad, "boss@example.com", "boss-password-1").status_code == 200
        assert ad.get("/admin", follow_redirects=False).status_code == 200
        # create, list, extend, block, unblock, reset password, delete
        r = ad.post("/api/admin/users", json={"name": "Paid", "email": "paid@example.com", "password": "password-p", "days": 30}, headers=J)
        assert r.status_code == 200, r.text
        pid = r.json()["id"]
        assert r.json()["state"] == "active" and r.json()["plan"] == "paid"
        assert any(x["email"] == "paid@example.com" for x in ad.get("/api/admin/users?q=paid").json())
        assert login(u, "paid@example.com", "password-p").status_code == 200
        with u.websocket_connect("/ws", headers=J) as ws:
            ws.receive_text()
            online = ad.get("/api/admin/online").json()["connections"]
            assert any(o["user_id"] == pid for o in online)
            assert ad.post(f"/api/admin/users/{pid}/block", json={}, headers=J).status_code == 200
            with pytest.raises(WebSocketDisconnect) as e:
                for _ in range(20000):
                    m = ws.receive()
                    if m.get("type") == "websocket.close":
                        raise WebSocketDisconnect(m.get("code"))
            assert e.value.code == 4403
        assert login(u, "paid@example.com", "password-p").status_code == 403
        assert ad.post(f"/api/admin/users/{pid}/unblock", json={}, headers=J).status_code == 200
        before = ad.get(f"/api/admin/users/{pid}").json()["user"]["expires_at"]
        r = ad.post(f"/api/admin/users/{pid}/extend", json={"days": 7}, headers=J).json()
        assert r["expires_at"] - before == 7 * DAY
        assert ad.post(f"/api/admin/users/{pid}/password", json={"password": "new-password-9"}, headers=J).status_code == 200
        assert login(u, "paid@example.com", "new-password-9").status_code == 200
        # non-admins can't use admin APIs; admin can't delete self
        assert u.get("/api/admin/users").status_code == 403
        me_id = ad.get("/api/auth/me").json()["user"]["id"]
        assert ad.delete(f"/api/admin/users/{me_id}", headers=J).status_code == 400
        assert ad.delete(f"/api/admin/users/{pid}", headers=J).status_code == 200
        assert u.get("/api/auth/me").status_code == 401
        # settings, accuracy, audit, csv
        s = ad.put("/api/admin/settings", json={"trial_days": "5", "contact_email": "Help@Example.com"}, headers=J).json()
        assert s["trial_days"] == "5" and s["contact_email"] == "help@example.com" and "contact_whatsapp" not in s
        assert ad.get("/api/public/config").json()["trial_days"] == 5
        acc = ad.get("/api/admin/accuracy").json()
        assert "health" in acc and "venues" in acc
        assert any(e["action"] == "user_delete" for e in ad.get("/api/admin/audit").json())
        assert "paid@example.com" not in ad.get("/api/admin/users.csv").text and "boss@example.com" in ad.get("/api/admin/users.csv").text
        ov = ad.get("/api/admin/overview").json()
        assert ov["total"] >= 1 and len(ov["signups_14d"]) == 14
        ad.put("/api/admin/settings", json={"trial_days": "3"}, headers=J)


def test_extension_reconnects_frozen_dashboard(srv):
    ad, u = client(), client()
    with ad, u:
        login(ad, "boss@example.com", "boss-password-1")
        signup(u, "renew@example.com")
        uid = u.get("/api/auth/me").json()["user"]["id"]
        main.accounts.update_user(uid, {"expires_at": now_ms() - 1000})
        with u.websocket_connect("/ws", headers=J) as ws:
            read_until(ws, "frozen")
            ad.post(f"/api/admin/users/{uid}/extend", json={"days": 30}, headers=J)
            with pytest.raises(WebSocketDisconnect) as e:
                for _ in range(20000):
                    m = ws.receive()
                    if m.get("type") == "websocket.close":
                        raise WebSocketDisconnect(m.get("code"))
            assert e.value.code == 4100
        assert u.get("/api/auth/me").json()["live"]


def test_logout(srv):
    c = client()
    with c:
        signup(c, "bye@example.com")
        assert c.post("/api/auth/logout", json={}, headers=J).status_code == 200
        assert c.get("/api/auth/me").status_code == 401


def test_admin_input_checks_and_csv_escaping(srv):
    ad = client()
    with ad:
        assert login(ad, "boss@example.com", "boss-password-1").status_code == 200
        r = ad.post("/api/admin/users", json={"name": "=HYPERLINK(\"http://x\")", "email": "csv@example.com",
                                              "password": "password-c", "days": "thirty"}, headers=J)
        assert r.status_code == 400 and r.json()["error"] == "bad_request"
        r = ad.post("/api/admin/users", json={"name": "=HYPERLINK(\"http://x\")", "email": "csv@example.com",
                                              "password": "password-c", "days": 30}, headers=J)
        assert r.status_code == 200
        uid = r.json()["id"]
        assert ad.post(f"/api/admin/users/{uid}/extend", json={"until": "soon"}, headers=J).status_code == 400
        assert ad.patch(f"/api/admin/users/{uid}", json={"expires_at": None}, headers=J).json()["expires_at"] is None
        csv_text = ad.get("/api/admin/users.csv").text
        assert "'=HYPERLINK" in csv_text
        ad.delete(f"/api/admin/users/{uid}", headers=J)


def test_public_pages_and_asset_caching(srv):
    r = srv.get("/", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and "Flowdeck" in r.text
    assert r.headers.get("content-encoding") == "gzip"
    for path in ("/login", "/signup"):
        assert srv.get(path).status_code == 200
    import re
    asset = re.search(r'/assets/[^"]+\.js', r.text).group(0)
    a = srv.get(asset)
    assert a.status_code == 200 and "immutable" in a.headers["cache-control"]
    assert srv.get("/api/public/config").headers["cache-control"] == "no-store"
    media = re.search(r'/assets/[^"]+\.webp', r.text)
    if media:   # images and video are served as-is (no gzip), so browsers can use range requests
        m = srv.get(media.group(0), headers={"Accept-Encoding": "gzip", "Range": "bytes=0-99"})
        assert m.status_code == 206 and "content-encoding" not in m.headers


def wait_close(ws, limit=20000):
    for _ in range(limit):
        m = ws.receive()
        if m.get("type") == "websocket.close":
            return m.get("code")
    raise AssertionError("socket stayed open")


def test_env_admin_never_promotes_an_existing_account():
    a = Accounts(os.path.join(TMP, "boot.db"))
    a.create_user("owner@x.io", "Owner", "password1", role="admin", created_by="admin")
    a.create_user("taken@x.io", "Squatter", "password1")             # someone signed up with the env address
    assert a.ensure_admin("taken@x.io", "env-password-1") == (None, None)
    assert a.user_by_email("taken@x.io")["role"] == "user"
    b = Accounts(os.path.join(TMP, "boot2.db"))
    b.create_user("taken@x.io", "Squatter", "password1")
    email, pw = b.ensure_admin("taken@x.io", "env-password-1")       # no admin at all: a generated one is made
    assert email and pw and email != "taken@x.io" and b.user_by_email(email)["role"] == "admin"
    assert b.user_by_email("taken@x.io")["role"] == "user"


def test_request_shape_checks(srv):
    c = client()
    with c:
        r = c.post("/api/auth/login", content=b'{"email":"a@b.co","password":"x"}',
                   headers={**J, "content-type": "text/plain; application/json"})
        assert r.status_code == 415
        assert c.post("/api/auth/login", json={"email": ["x"], "password": 5}, headers=J).status_code == 401
        assert c.post("/api/auth/signup", json={"email": {"a": 1}, "name": 3, "password": "password123"}, headers=J).status_code == 400


def test_second_tab_takes_over_and_patch_block_revokes(srv):
    ad, u = client(), client()
    with ad, u:
        login(ad, "boss@example.com", "boss-password-1")
        signup(u, "tabs@example.com")
        uid = u.get("/api/auth/me").json()["user"]["id"]
        with u.websocket_connect("/ws", headers=J) as ws1:
            ws1.receive_text()
            with u.websocket_connect("/ws", headers=J) as ws2:
                ws2.receive_text()
                assert wait_close(ws1) == 4411
                ad.patch(f"/api/admin/users/{uid}", json={"status": "blocked"}, headers=J)
                assert wait_close(ws2) == 4403
        ad.patch(f"/api/admin/users/{uid}", json={"status": "active"}, headers=J)
        assert u.get("/api/auth/me").status_code == 401        # the old cookie stays dead after unblocking


def test_frozen_snapshot_allowance(srv):
    c = client()
    with c:
        signup(c, "reload@example.com")
        uid = c.get("/api/auth/me").json()["user"]["id"]
        main.accounts.update_user(uid, {"expires_at": now_ms() - 1000})
        for _ in range(4):
            with c.websocket_connect("/ws", headers=J) as ws:
                assert '"type":"init"' in ws.receive_text()
        with c.websocket_connect("/ws", headers=J) as ws:
            first = ws.receive_text()
            assert '"type":"frozen"' in first and '"snapshot":false' in first
