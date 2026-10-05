"""Search-engine files and headers: robots.txt, sitemap, icons, noindex on private pages, quiet signed-out check."""
import os
import tempfile

TMP = tempfile.mkdtemp(prefix="fd-seo-")
os.environ.setdefault("FLOWDECK_DB", os.path.join(TMP, "s.db"))
os.environ.setdefault("FLOW_DEMO", "1")
os.environ.setdefault("FLOW_DEMO_WARMUP_MIN", "1")

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402


def test_root_files_and_robots():
    with TestClient(main.app, base_url="http://testserver") as c:
        if not (main.STATIC / "robots.txt").exists():
            return   # frontend not built
        r = c.get("/robots.txt")
        assert r.status_code == 200 and "Disallow: /admin" in r.text and "Sitemap: https://flowdeck.site/sitemap.xml" in r.text
        assert "<loc>https://flowdeck.site/</loc>" in c.get("/sitemap.xml").text
        for f in ("/favicon.ico", "/favicon.svg", "/og.jpg", "/site.webmanifest", "/apple-touch-icon.png"):
            assert c.get(f).status_code == 200, f
        home = c.get("/")
        assert "X-Robots-Tag" not in home.headers and 'rel="canonical" href="https://flowdeck.site/"' in home.text
        assert c.get("/login").headers["X-Robots-Tag"] == "noindex"
        assert c.get("/api/public/config").headers["X-Robots-Tag"] == "noindex"


def test_auth_state_is_quiet_when_signed_out():
    with TestClient(main.app, base_url="http://testserver") as c:
        r = c.get("/api/auth/state")
        assert r.status_code == 200 and r.json() == {"user": None}
