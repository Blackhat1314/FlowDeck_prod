"""Sign in with Google: checks the ID token the browser receives from Google Identity Services.

The browser shows Google's button, Google hands it a signed ID token (a JWT), and the page posts that token to
/api/auth/google. Nothing from the browser is trusted until the token passes every check here:
- signed with RS256 by one of Google's current keys (fetched from Google, cached for as long as Google says),
- issued by accounts.google.com, for this site's client ID, not expired,
- the Google account's email address is verified.
"""
from __future__ import annotations

import asyncio
import json
import re
import time

import jwt

CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("accounts.google.com", "https://accounts.google.com")
CLIENT_ID_RE = re.compile(r"^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$")
LEEWAY_S = 60            # tolerated clock difference between Google and this server
MAX_TOKEN_LEN = 4096


class GoogleTokenError(Exception):
    """The token was rejected. `message` is safe to show to the user."""

    def __init__(self, message: str = "Google sign-in failed. Try again."):
        super().__init__(message)
        self.message = message


def valid_client_id(cid: str | None) -> bool:
    return bool(cid) and bool(CLIENT_ID_RE.match(cid))


async def _fetch_certs() -> tuple[dict, float]:
    """Google's public signing keys, and how many seconds they may be cached."""
    import aiohttp
    from .runtime import _ssl_ctx
    timeout = aiohttp.ClientTimeout(total=10)
    async with aiohttp.ClientSession(timeout=timeout) as s:
        async with s.get(CERTS_URL, ssl=_ssl_ctx()) as r:
            r.raise_for_status()
            data = json.loads(await r.text())
            m = re.search(r"max-age=(\d+)", r.headers.get("Cache-Control", ""))
            return data, float(m.group(1)) if m else 3600.0


class GoogleVerifier:
    def __init__(self, client_id: str, fetch=_fetch_certs):
        self.client_id = client_id
        self._fetch = fetch
        self._keys: dict[str, object] = {}
        self._expires = 0.0
        self._last_fetch = 0.0
        self._lock: asyncio.Lock | None = None

    async def _key(self, kid: str):
        if time.monotonic() < self._expires and kid in self._keys:
            return self._keys[kid]
        if self._lock is None:
            self._lock = asyncio.Lock()
        async with self._lock:
            now = time.monotonic()
            if now < self._expires and kid in self._keys:
                return self._keys[kid]
            # cache expired, or a key id we don't know (Google rotated its keys): refetch, at most once a minute
            # for unknown ids so junk tokens can't make us hammer Google
            if now >= self._expires or now - self._last_fetch > 60:
                self._last_fetch = now
                try:
                    data, max_age = await self._fetch()
                except Exception:
                    # Google unreachable: keep using the keys we had (Google rotates keys with overlap) and retry in a
                    # minute, rather than making every sign-in wait on a fetch that's failing
                    self._expires = now + 60.0
                    if kid in self._keys:
                        return self._keys[kid]
                    raise GoogleTokenError("Couldn't reach Google to check the sign-in. Try again in a minute.")
                keys = {}
                for k in data.get("keys", []):
                    if k.get("kty") == "RSA" and k.get("kid"):
                        keys[k["kid"]] = jwt.PyJWK(k, algorithm="RS256").key
                self._keys = keys
                self._expires = now + max(60.0, min(max_age, 86400.0))
            return self._keys.get(kid)

    async def verify(self, token: str) -> dict:
        """Claims of a valid token (sub, email, name, ...) or GoogleTokenError."""
        if not isinstance(token, str) or not token or len(token) > MAX_TOKEN_LEN:
            raise GoogleTokenError()
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise GoogleTokenError()
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise GoogleTokenError()
        key = await self._key(header["kid"])
        if key is None:
            raise GoogleTokenError()
        try:
            claims = jwt.decode(token, key=key, algorithms=["RS256"], audience=self.client_id, leeway=LEEWAY_S,
                                options={"require": ["exp", "iat", "iss", "aud", "sub"]})
        except jwt.ExpiredSignatureError:
            raise GoogleTokenError("That Google sign-in expired. Try again.")
        except jwt.PyJWTError:
            raise GoogleTokenError()
        if claims.get("iss") not in ISSUERS:
            raise GoogleTokenError()
        if not isinstance(claims.get("sub"), str) or not claims["sub"]:
            raise GoogleTokenError()
        if not isinstance(claims.get("email"), str) or claims.get("email_verified") not in (True, "true"):
            raise GoogleTokenError("Your Google account's email address isn't verified. Verify it with Google, or sign up with email and a password.")
        return claims
