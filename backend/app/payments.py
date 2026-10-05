"""Razorpay Standard Checkout: order creation and payment signature checks.

The flow, for one 30-day plan:
1. The dashboard calls /api/create-order. The server creates a Razorpay order for the plan price from the site
   settings (never an amount sent by the browser) and remembers which account it belongs to.
2. The browser opens Razorpay's checkout with that order id. Razorpay takes the payment.
3. Razorpay hands the browser razorpay_order_id, razorpay_payment_id and razorpay_signature, which the browser posts to
   /api/verify-payment. The server recomputes HMAC-SHA256(order_id + "|" + payment_id) with the key secret. Only a
   match marks the order paid and extends the account.

Keys come from the environment (RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET); the secret never leaves the server.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os

API = "https://api.razorpay.com/v1"
PLAN_DAYS = 30


class RazorpayError(Exception):
    """A failed call to Razorpay. `status` is what our API answers with, `message` is safe to show."""

    def __init__(self, status: int, message: str, code: str = "razorpay_error"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


def signature_ok(order_id: str, payment_id: str, signature: str, secret: str) -> bool:
    """Razorpay's checkout signature: hex HMAC-SHA256 of "order_id|payment_id" keyed with the key secret."""
    if not all(isinstance(x, str) and x for x in (order_id, payment_id, signature, secret)):
        return False
    expected = hmac.new(secret.encode(), f"{order_id}|{payment_id}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature)


async def _post(path: str, payload: dict, key_id: str, key_secret: str) -> tuple[int, dict]:
    import aiohttp
    from .runtime import _ssl_ctx
    timeout = aiohttp.ClientTimeout(total=20)
    async with aiohttp.ClientSession(timeout=timeout) as s:
        async with s.post(API + path, json=payload, auth=aiohttp.BasicAuth(key_id, key_secret), ssl=_ssl_ctx()) as r:
            text = await r.text()
            try:
                data = json.loads(text) if text else {}
            except ValueError:
                data = {"error": {"description": text[:200]}}
            return r.status, data


class Razorpay:
    def __init__(self, key_id: str | None, key_secret: str | None, post=_post):
        self.key_id = (key_id or "").strip()
        self.key_secret = (key_secret or "").strip()
        self._post = post

    @classmethod
    def from_env(cls) -> "Razorpay":
        return cls(os.environ.get("RAZORPAY_KEY_ID"), os.environ.get("RAZORPAY_KEY_SECRET"))

    @property
    def enabled(self) -> bool:
        return bool(self.key_id and self.key_secret)

    @property
    def test_mode(self) -> bool:
        return self.key_id.startswith("rzp_test_")

    async def create_order(self, amount: int, currency: str, receipt: str, notes: dict) -> dict:
        """Create an order (amount in paise). Returns Razorpay's order object (id, amount, currency, ...)."""
        if not isinstance(amount, int) or amount < 100:
            raise RazorpayError(400, "The amount must be at least ₹1 (100 paise).", "bad_amount")
        try:
            status, data = await self._post("/orders", {"amount": amount, "currency": currency, "receipt": receipt[:40],
                                                        "notes": notes}, self.key_id, self.key_secret)
        except Exception:
            raise RazorpayError(500, "Couldn't reach Razorpay. Try again in a minute.")
        if status == 401:
            raise RazorpayError(401, "Razorpay rejected the server's API keys. The site owner needs to check them.", "razorpay_auth")
        if status >= 400 or not isinstance(data.get("id"), str):
            desc = (data.get("error") or {}).get("description") if isinstance(data.get("error"), dict) else None
            raise RazorpayError(500, f"Razorpay couldn't create the order{': ' + desc if desc else ''}.")
        return data

    def verify(self, order_id: str, payment_id: str, signature: str) -> bool:
        return signature_ok(order_id, payment_id, signature, self.key_secret)
