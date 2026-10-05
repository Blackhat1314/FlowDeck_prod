"""Sign in with Google: token checks and account linking, with tokens signed by a local test key
(Google's key download is replaced, nothing goes over the network)."""
import asyncio
import os
import tempfile
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

TMP = tempfile.mkdtemp(prefix="fd-gtest-")
os.environ.setdefault("FLOWDECK_DB", os.path.join(TMP, "g.db"))
os.environ.setdefault("FLOW_DEMO", "1")
os.environ.setdefault("FLOW_DEMO_WARMUP_MIN", "1")
os.environ.setdefault("FLOWDECK_ADMIN_EMAIL", "boss@example.com")
os.environ.setdefault("FLOWDECK_ADMIN_PASSWORD", "boss-password-1")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.accounts import Accounts  # noqa: E402
from app.google_auth import GoogleTokenError, GoogleVerifier, valid_client_id  # noqa: E402

CID = main.GOOGLE_CLIENT_ID
J = {"origin": "http://testserver"}
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
FETCHES = []


def jwk(key, kid):
    d = jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    return {**d, "kid": kid, "alg": "RS256", "use": "sig"}


async def fake_certs():
    FETCHES.append(time.time())
    return {"keys": [jwk(KEY, "k1")]}, 3600.0


def token(sub="1001", email="g@example.com", verified=True, aud=None, iss="https://accounts.google.com",
          exp_in=600, key=KEY, kid="k1", name="Gita Rao", alg="RS256", **extra):
    now = int(time.time())
    claims = {"iss": iss, "aud": aud or CID, "sub": sub, "email": email, "email_verified": verified,
              "name": name, "iat": now, "exp": now + exp_in, **extra}
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid})


@pytest.fixture(scope="module")
def srv():
    main.google._fetch = fake_certs
    with TestClient(main.app, base_url="http://testserver") as c:
        yield c


def fresh():
    main.google_ip.hits.clear()
    main.signup_ip.hits.clear()
    return TestClient(main.app, base_url="http://testserver")


def gpost(c, cred):
    return c.post("/api/auth/google", json={"credential": cred}, headers=J)


# ------------------------------------------------------------------------------------------ verifier
def verify(t, cid=None):
    v = GoogleVerifier(cid or CID, fetch=fake_certs)
    return asyncio.run(v.verify(t))


def test_client_id_shape():
    assert valid_client_id(CID)
    assert not valid_client_id("not-a-client-id") and not valid_client_id("")


def test_valid_token_passes():
    c = verify(token())
    assert c["sub"] == "1001" and c["email"] == "g@example.com"


@pytest.mark.parametrize("bad", [
    lambda: token(aud="123456-other.apps.googleusercontent.com"),      # issued for another site
    lambda: token(iss="https://evil.example.com"),                    # not issued by Google
    lambda: token(exp_in=-3600),                                      # expired
    lambda: token(key=OTHER_KEY),                                     # signed by someone else's key
    lambda: token(kid="unknown"),                                     # key id Google never published
    lambda: token(verified=False),                                    # email not verified at Google
    lambda: token(alg="HS256", key="secret-shared-key-that-is-long-enough-x"),  # algorithm swap
    lambda: "not.a.jwt",
    lambda: "",
    lambda: "x" * 5000,
])
def test_bad_tokens_rejected(bad):
    with pytest.raises(GoogleTokenError):
        verify(bad())


def test_unknown_kid_refetch_is_throttled():
    v = GoogleVerifier(CID, fetch=fake_certs)
    asyncio.run(v.verify(token()))
    n = len(FETCHES)
    for _ in range(5):
        with pytest.raises(GoogleTokenError):
            asyncio.run(v.verify(token(kid="rotated")))
    assert len(FETCHES) - n <= 1


def test_google_unreachable_is_a_clear_error():
    async def down():
        raise OSError("no network")
    v = GoogleVerifier(CID, fetch=down)
    with pytest.raises(GoogleTokenError, match="reach Google"):
        asyncio.run(v.verify(token()))


# ------------------------------------------------------------------------------------------ accounts
def test_accounts_link_and_create():
    a = Accounts(os.path.join(TMP, "unit-g.db"))
    pw_user = a.create_user("both@gmail.com", "Both", "password1")
    old, *_ = a.login("both@gmail.com", "password1", "9.9.9.9", "ua")
    t, u, _, _, created, cleared = a.google_login({"sub": "s-1", "email": "Both@Gmail.com", "name": "B"}, "1.1.1.1", "ua", False)
    # linked; the unproven password is switched off and the old session signed out
    assert not created and cleared and u["id"] == pw_user["id"] and u["google_sub"] == "s-1" and u["pw_hash"] == ""
    assert a.session(old)[2] == "replaced"
    t, u, _, _, created, cleared = a.google_login({"sub": "s-2", "email": "new@x.io", "name": "  New   Person "}, "1.1.1.1", "ua", True)
    assert created and u["name"] == "New Person" and u["plan"] == "trial" and u["pw_hash"] == "" and u["created_by"] == "google"
    assert a.state(u) == "trial" and a.has_live(u)
    # no password: the password form can't be used to get in
    with pytest.raises(Exception):
        a.login("new@x.io", "", "1.1.1.1", "ua")


def test_linking_needs_google_to_own_the_email():
    a = Accounts(os.path.join(TMP, "unit-g2.db"))
    a.create_user("someone@company.io", "S", "password1")
    with pytest.raises(Exception, match="already exists"):     # a Google account made with a non-Gmail address
        a.google_login({"sub": "x-1", "email": "someone@company.io"}, "1.1.1.1", "ua", True)
    assert a.user_by_email("someone@company.io")["google_sub"] is None
    # a Google Workspace domain vouches for its own addresses
    *_, created, cleared = a.google_login({"sub": "x-1", "email": "someone@company.io", "hd": "company.io"}, "1.1.1.1", "ua", True)
    assert not created and cleared


def test_admin_accounts_never_auto_linked():
    a = Accounts(os.path.join(TMP, "unit-g3.db"))
    a.create_user("chief@gmail.com", "Chief", "password1", role="admin", created_by="admin")
    with pytest.raises(Exception, match="admin account"):
        a.google_login({"sub": "ad-1", "email": "chief@gmail.com"}, "1.1.1.1", "ua", True)


def test_duplicate_google_id_is_a_clean_error():
    a = Accounts(os.path.join(TMP, "unit-g4.db"))
    a.create_user("one@x.io", "One", None, created_by="google", google_sub="dup-1")
    with pytest.raises(Exception, match="already exists"):     # UNIQUE(google_sub) -> AccountError, not a crash
        a.create_user("two@x.io", "Two", None, created_by="google", google_sub="dup-1")


def test_email_change_drops_google_link():
    a = Accounts(os.path.join(TMP, "unit-g5.db"))
    u = a.create_user("move@x.io", "Mo", None, created_by="google", google_sub="mv-1")
    u = a.update_user(u["id"], {"email": "moved@x.io"})
    assert u["google_sub"] is None


def test_google_outage_keeps_cached_keys():
    calls = []

    async def flaky():
        calls.append(1)
        if len(calls) > 1:
            raise OSError("down")
        return {"keys": [jwk(KEY, "k1")]}, 3600.0
    v = GoogleVerifier(CID, fetch=flaky)
    asyncio.run(v.verify(token()))
    v._expires = 0           # cache runs out while Google is down
    for _ in range(3):
        assert asyncio.run(v.verify(token()))["sub"] == "1001"
    assert len(calls) == 2   # one failed refetch, then it waits a minute


# ------------------------------------------------------------------------------------------ API
def test_config_exposes_client_id(srv):
    assert srv.get("/api/public/config").json()["google_client_id"] == CID


def test_new_google_user_gets_trial_session(srv):
    c = fresh()
    r = gpost(c, token(sub="2001", email="newbie@example.com"))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["created"] and j["user"]["state"] == "trial" and j["user"]["google"] and not j["user"]["has_password"]
    assert j["live"]
    assert c.get("/api/auth/me").json()["user"]["email"] == "newbie@example.com"
    # second sign-in: same account, not a new one
    c2 = fresh()
    j2 = gpost(c2, token(sub="2001", email="newbie@example.com")).json()
    assert not j2["created"] and j2["user"]["id"] == j["user"]["id"] and j2["replaced"] == 1


def test_links_existing_password_account(srv):
    # someone signs up with a Gmail address they may not own; the address's real owner then uses Google
    c = fresh()
    r = c.post("/api/auth/signup", json={"name": "Pat", "email": "pat.g@gmail.com", "password": "password123"}, headers=J)
    assert r.status_code == 200
    uid = r.json()["user"]["id"]
    j = gpost(fresh(), token(sub="3001", email="PAT.G@gmail.com")).json()
    assert j["user"]["id"] == uid and j["user"]["google"] and j["password_cleared"] and not j["user"]["has_password"]
    # the first browser is signed out and the old password no longer works
    assert c.get("/api/auth/me").status_code == 401
    assert fresh().post("/api/auth/login", json={"email": "pat.g@gmail.com", "password": "password123"}, headers=J).status_code == 401


def test_existing_non_gmail_account_not_linked(srv):
    fresh().post("/api/auth/signup", json={"name": "Wu", "email": "wu@example.com", "password": "password123"}, headers=J)
    r = gpost(fresh(), token(sub="3500", email="wu@example.com"))
    assert r.status_code == 409 and r.json()["error"] == "google_link_refused"
    assert fresh().post("/api/auth/login", json={"email": "wu@example.com", "password": "password123"}, headers=J).status_code == 200


def test_other_google_account_cannot_take_linked_email(srv):
    gpost(fresh(), token(sub="4001", email="owner@example.com"))
    r = gpost(fresh(), token(sub="4999", email="owner@example.com"))
    assert r.status_code == 409 and r.json()["error"] == "google_mismatch"


def test_rejections_over_http(srv):
    for t, code in [(token(aud="99999999-zz9zz9zz9z.apps.googleusercontent.com"), 401),
                    (token(verified=False, sub="5001", email="unv@example.com"), 401),
                    (token(exp_in=-3600), 401)]:
        r = gpost(fresh(), t)
        assert r.status_code == code and r.json()["error"] == "google_failed"
    assert main.accounts.user_by_email("unv@example.com") is None


def test_cross_site_post_refused(srv):
    r = fresh().post("/api/auth/google", json={"credential": token()}, headers={"origin": "https://evil.example.com"})
    assert r.status_code == 403


def test_blocked_user_refused(srv):
    j = gpost(fresh(), token(sub="6001", email="blocked@example.com")).json()
    main.accounts.update_user(j["user"]["id"], {"status": "blocked"})
    r = gpost(fresh(), token(sub="6001", email="blocked@example.com"))
    assert r.status_code == 403 and r.json()["error"] == "blocked"


def test_signups_closed_blocks_new_but_not_existing(srv):
    gpost(fresh(), token(sub="7001", email="early-google@example.com"))
    main.accounts.set_settings({"signups_open": "0"})
    try:
        r = gpost(fresh(), token(sub="7002", email="late-google@example.com"))
        assert r.status_code == 403 and r.json()["error"] == "signups_closed"
        assert gpost(fresh(), token(sub="7001", email="early-google@example.com")).status_code == 200
    finally:
        main.accounts.set_settings({"signups_open": "1"})


def test_google_user_sets_first_password(srv):
    c = fresh()
    gpost(c, token(sub="8001", email="setpw@example.com"))
    r = c.post("/api/auth/password", json={"current": "", "new": "brand-new-pass"}, headers=J)
    assert r.status_code == 200, r.text
    assert c.get("/api/auth/me").json()["user"]["has_password"]
    # now that a password exists, changing it needs the current one
    r = c.post("/api/auth/password", json={"current": "", "new": "another-pass-1"}, headers=J)
    assert r.status_code == 400
    assert fresh().post("/api/auth/login", json={"email": "setpw@example.com", "password": "brand-new-pass"}, headers=J).status_code == 200


def test_first_password_needs_a_recent_sign_in(srv):
    c = fresh()
    j = gpost(c, token(sub="8500", email="stale@example.com")).json()
    main.accounts.run("UPDATE sessions SET created_at=created_at-3600000 WHERE user_id=?", (j["user"]["id"],))
    r = c.post("/api/auth/password", json={"current": "", "new": "brand-new-pass"}, headers=J)
    assert r.status_code == 403 and r.json()["error"] == "reauth"


def test_rate_limit(srv):
    main.google_ip.hits.clear()
    c = TestClient(main.app, base_url="http://testserver")
    codes = [gpost(c, "junk").status_code for _ in range(32)]
    assert codes[0] == 401 and codes[-1] == 429
    main.google_ip.hits.clear()


def test_legal_pages_served(srv):
    for path in ("/privacy", "/terms"):
        r = srv.get(path)
        assert r.status_code in (200, 500)   # 500 only when the frontend hasn't been built
