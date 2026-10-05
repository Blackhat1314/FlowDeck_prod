"""Razorpay checkout: order creation, signature checks and access extension (Razorpay's API is replaced by a fake)."""
import hashlib
import hmac
import os
import tempfile

import pytest

TMP = tempfile.mkdtemp(prefix="fd-pay-")
os.environ.setdefault("FLOWDECK_DB", os.path.join(TMP, "p.db"))
os.environ.setdefault("FLOW_DEMO", "1")
os.environ.setdefault("FLOW_DEMO_WARMUP_MIN", "1")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.accounts import DAY, now_ms  # noqa: E402
from app.envfile import load_env_file  # noqa: E402
from app.payments import Razorpay, RazorpayError, signature_ok  # noqa: E402

J = {"origin": "http://testserver"}
SECRET = "test_secret_for_signatures"
CALLS = []


def sign(order_id, payment_id, secret=SECRET):
    return hmac.new(secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()


async def fake_post(path, payload, key_id, key_secret):
    CALLS.append((path, payload, key_id))
    if key_secret != SECRET:
        return 401, {"error": {"code": "BAD_REQUEST_ERROR", "description": "Authentication failed"}}
    return 200, {"id": f"order_T{len(CALLS):06d}", "amount": payload["amount"], "currency": payload["currency"],
                 "receipt": payload["receipt"], "status": "created"}


@pytest.fixture(scope="module")
def srv():
    main.razorpay = Razorpay("rzp_test_dummykey", SECRET, post=fake_post)
    with TestClient(main.app, base_url="http://testserver") as c:
        yield c


def user(email):
    main.signup_ip.hits.clear()
    main.pay_orders.hits.clear()
    main.pay_verify.hits.clear()
    c = TestClient(main.app, base_url="http://testserver")
    r = c.post("/api/auth/signup", json={"name": "Payer", "email": email, "password": "password123"}, headers=J)
    assert r.status_code == 200, r.text
    return c, r.json()["user"]


# ------------------------------------------------------------------------------------------ unit
def test_signature_algorithm():
    assert signature_ok("order_1", "pay_1", sign("order_1", "pay_1"), SECRET)
    assert not signature_ok("order_1", "pay_2", sign("order_1", "pay_1"), SECRET)
    assert not signature_ok("order_1", "pay_1", sign("order_1", "pay_1", "other"), SECRET)
    assert not signature_ok("order_1", "pay_1", "", SECRET) and not signature_ok("order_1", "pay_1", None, SECRET)


def test_minimum_amount():
    import asyncio
    with pytest.raises(RazorpayError) as e:
        asyncio.run(Razorpay("k", SECRET, post=fake_post).create_order(99, "INR", "r", {}))
    assert e.value.status == 400


def test_env_file_does_not_override(tmp_path, monkeypatch):
    f = tmp_path / ".env"
    f.write_text('# comment\nRAZORPAY_KEY_ID="rzp_test_fromfile"\nFD_TEST_ONLY=1\n')
    monkeypatch.setenv("RAZORPAY_KEY_ID", "from_environment")
    monkeypatch.delenv("FD_TEST_ONLY", raising=False)
    load_env_file(f)
    assert os.environ["RAZORPAY_KEY_ID"] == "from_environment" and os.environ["FD_TEST_ONLY"] == "1"
    monkeypatch.delenv("FD_TEST_ONLY")


# ------------------------------------------------------------------------------------------ API
def test_config_says_payments_on(srv):
    cfg = srv.get("/api/public/config").json()
    assert cfg["payments_enabled"] and cfg["payments_test"] and cfg["plan_days"] == 30
    assert "secret" not in str(cfg).lower() and SECRET not in str(cfg)


def test_order_needs_sign_in(srv):
    r = TestClient(main.app, base_url="http://testserver").post("/api/create-order", json={}, headers=J)
    assert r.status_code == 401


def test_full_payment_extends_access(srv):
    c, u = user("payer1@example.com")
    trial_end = u["expires_at"]
    r = c.post("/api/create-order", json={"amount": 1}, headers=J)    # a browser-sent amount is ignored
    assert r.status_code == 200, r.text
    o = r.json()
    assert o["amount"] == int(main.accounts.settings()["price_inr"]) * 100 and o["currency"] == "INR"
    assert o["key_id"] == "rzp_test_dummykey" and SECRET not in r.text and o["prefill"]["email"] == "payer1@example.com"
    assert CALLS[-1][1]["amount"] == o["amount"] and len(CALLS[-1][1]["receipt"]) <= 40
    pay = {"razorpay_order_id": o["order_id"], "razorpay_payment_id": "pay_ABC1", "razorpay_signature": sign(o["order_id"], "pay_ABC1")}
    r = c.post("/api/verify-payment", json=pay, headers=J)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["ok"] and j["newly_paid"] and j["user"]["plan"] == "paid" and j["live"]
    assert abs(j["user"]["expires_at"] - (trial_end + 30 * DAY)) < 5000     # added on top of the remaining trial
    row = main.accounts.payment(o["order_id"])
    assert row["status"] == "paid" and row["payment_id"] == "pay_ABC1"
    # the same confirmation again doesn't add another 30 days
    j2 = c.post("/api/verify-payment", json=pay, headers=J).json()
    assert not j2["newly_paid"] and j2["user"]["expires_at"] == j["user"]["expires_at"]


def test_bad_signature_does_not_pay(srv):
    c, u = user("payer2@example.com")
    o = c.post("/api/create-order", json={}, headers=J).json()
    r = c.post("/api/verify-payment", json={"razorpay_order_id": o["order_id"], "razorpay_payment_id": "pay_X",
                                            "razorpay_signature": sign(o["order_id"], "pay_X", "wrong-secret")}, headers=J)
    assert r.status_code == 400 and r.json()["error"] == "bad_signature"
    assert main.accounts.payment(o["order_id"])["status"] == "created"
    assert main.accounts.user(u["id"])["plan"] == "trial"


def test_missing_fields(srv):
    c, _ = user("payer3@example.com")
    r = c.post("/api/verify-payment", json={"razorpay_order_id": "order_x"}, headers=J)
    assert r.status_code == 400 and r.json()["error"] == "missing_fields"


def test_cannot_use_someone_elses_order(srv):
    a, _ = user("owner-pay@example.com")
    o = a.post("/api/create-order", json={}, headers=J).json()
    b, bu = user("thief-pay@example.com")
    r = b.post("/api/verify-payment", json={"razorpay_order_id": o["order_id"], "razorpay_payment_id": "pay_T",
                                            "razorpay_signature": sign(o["order_id"], "pay_T")}, headers=J)
    assert r.status_code == 400 and r.json()["error"] == "unknown_order"
    assert main.accounts.user(bu["id"])["plan"] == "trial"


def test_wrong_keys_is_401_and_no_order_saved(srv):
    c, u = user("payer4@example.com")
    good = main.razorpay
    main.razorpay = Razorpay("rzp_test_dummykey", "not-the-secret", post=fake_post)
    try:
        r = c.post("/api/create-order", json={}, headers=J)
        assert r.status_code == 401 and r.json()["error"] == "razorpay_auth"
        assert main.accounts.payments_of(u["id"]) == []
    finally:
        main.razorpay = good


def test_razorpay_down_is_500(srv):
    async def down(*a):
        raise OSError("no route")
    c, _ = user("payer5@example.com")
    good = main.razorpay
    main.razorpay = Razorpay("rzp_test_dummykey", SECRET, post=down)
    try:
        r = c.post("/api/create-order", json={}, headers=J)
        assert r.status_code == 500 and r.json()["error"] == "razorpay_error"
    finally:
        main.razorpay = good


def test_payments_off_without_keys(srv):
    c, _ = user("payer6@example.com")
    good = main.razorpay
    main.razorpay = Razorpay("", "")
    try:
        assert c.post("/api/create-order", json={}, headers=J).status_code == 503
        assert not srv.get("/api/public/config").json()["payments_enabled"]
    finally:
        main.razorpay = good


def test_expired_user_goes_live_after_paying(srv):
    c, u = user("expired-pay@example.com")
    main.accounts.update_user(u["id"], {"expires_at": now_ms() - 1000})
    o = c.post("/api/create-order", json={}, headers=J).json()
    j = c.post("/api/verify-payment", json={"razorpay_order_id": o["order_id"], "razorpay_payment_id": "pay_EXP",
                                            "razorpay_signature": sign(o["order_id"], "pay_EXP")}, headers=J).json()
    assert j["live"] and abs(j["user"]["expires_at"] - (now_ms() + 30 * DAY)) < 5000


def test_cross_site_order_refused(srv):
    c, _ = user("payer7@example.com")
    assert c.post("/api/create-order", json={}, headers={"origin": "https://evil.example"}).status_code == 403
