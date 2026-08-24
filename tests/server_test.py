#!/usr/bin/env python3
"""
Server tests.

The JavaScript suites cover everything above the proxy. These cover the parts
that only exist in Python: the address validation that stops a one-character
typo becoming an unexplained "Failed to fetch", the limiter that stops a
runaway page hammering the phone, the allowlist that keeps this from being an
open proxy onto Medha, and the guarantee that every failure comes back as JSON.

    python3 tests/server_test.py
"""

import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["SANDESHIKA_MOCK"] = "1"
os.environ["SANDESHIKA_LOG"] = "WARNING"

import app as server  # noqa: E402


class TestValidateUrl(unittest.TestCase):
    """A wrong address is the single most likely setup mistake."""

    def test_accepts_loopback_with_port(self):
        ok, _ = server.validate_url("http://127.0.0.1:8080")
        self.assertTrue(ok)

    def test_accepts_localhost(self):
        ok, _ = server.validate_url("http://localhost:8001")
        self.assertTrue(ok)

    def test_rejects_loopback_network_address(self):
        # One digit from what the user meant, and nothing listens on it.
        ok, why = server.validate_url("http://127.0.0.0:8001")
        self.assertFalse(ok)
        self.assertIn("127.0.0.1", why)

    def test_rejects_wrong_loopback(self):
        ok, why = server.validate_url("http://127.0.1.1:8001")
        self.assertFalse(ok)
        self.assertIn("127.0.0.1", why)

    def test_requires_a_port(self):
        ok, why = server.validate_url("http://127.0.0.1")
        self.assertFalse(ok)
        self.assertIn("port", why.lower())

    def test_rejects_a_path(self):
        ok, _ = server.validate_url("http://127.0.0.1:8001/api")
        self.assertFalse(ok)

    def test_rejects_out_of_range_port(self):
        ok, why = server.validate_url("http://127.0.0.1:99999")
        self.assertFalse(ok)
        self.assertIn("range", why)

    def test_rejects_octet_over_255(self):
        ok, _ = server.validate_url("http://999.1.1.1:8001")
        self.assertFalse(ok)

    def test_rejects_garbage(self):
        for bad in ("", "not a url", "ftp://127.0.0.1:21", "127.0.0.1:8001"):
            ok, _ = server.validate_url(bad)
            self.assertFalse(ok, bad)


class TestRateLimit(unittest.TestCase):
    """Bypassed in mock mode, so it is exercised directly."""

    def test_allows_up_to_the_limit(self):
        rl = server.RateLimit(limit=3, window=60.0)
        self.assertEqual([rl.allow() for _ in range(4)], [True, True, True, False])

    def test_window_expires(self):
        rl = server.RateLimit(limit=2, window=0.15)
        self.assertTrue(rl.allow())
        self.assertTrue(rl.allow())
        self.assertFalse(rl.allow())
        time.sleep(0.2)
        self.assertTrue(rl.allow())

    def test_retry_after_is_actionable(self):
        rl = server.RateLimit(limit=1, window=30.0)
        rl.allow()
        self.assertGreaterEqual(rl.retry_after(), 1)
        self.assertLessEqual(rl.retry_after(), 31)

    def test_is_thread_safe(self):
        # Flask serves on many threads; a limiter with a racy counter lets
        # bursts through, which is exactly the case it exists for.
        rl = server.RateLimit(limit=50, window=60.0)
        granted = []
        lock = threading.Lock()

        def worker():
            got = sum(1 for _ in range(20) if rl.allow())
            with lock:
                granted.append(got)

        threads = [threading.Thread(target=worker) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sum(granted), 50)


class TestAllowlist(unittest.TestCase):
    """An open proxy would expose the whole of Medha to any script on the page."""

    def test_permits_what_the_app_needs(self):
        for path in ("health", "generate", "store", "store/txn/abc",
                     "connectors/sms/status", "connectors/sms/messages"):
            self.assertTrue(server.ALLOWED.match(path), path)

    def test_blocks_everything_else(self):
        for path in ("admin", "admin/keys", "v1/models", "../etc/passwd",
                     "clients", "config", "shutdown"):
            self.assertFalse(server.ALLOWED.match(path), path)


class TestMask(unittest.TestCase):
    def test_never_reveals_the_middle(self):
        token = "a" * 20 + "b" * 20
        masked = server.mask(token)
        self.assertNotIn(token, masked)
        self.assertIn("…", masked)

    def test_short_tokens_are_not_partially_shown(self):
        self.assertEqual(server.mask("short"), "set")

    def test_empty_is_empty(self):
        self.assertEqual(server.mask(""), "")


class TestHttpSurface(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.MOCK = True
        server.app.config["TESTING"] = True
        cls.c = server.app.test_client()

    def test_healthz_does_not_depend_on_medha(self):
        r = self.c.get("/healthz")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])

    def test_config_never_returns_the_token(self):
        server.MEDHA_TOKEN = "deadbeef" * 5
        body = self.c.get("/config.json").get_data(as_text=True)
        self.assertNotIn("deadbeef" * 5, body)
        self.assertIn("tokenPreview", body)

    def test_unknown_endpoint_is_json_not_html(self):
        r = self.c.get("/does-not-exist")
        self.assertEqual(r.status_code, 404)
        self.assertEqual(r.get_json()["code"], "not_found")

    def test_wrong_method_is_json(self):
        r = self.c.delete("/config.json")
        self.assertEqual(r.status_code, 405)
        self.assertEqual(r.get_json()["code"], "method_not_allowed")

    def test_blocked_proxy_path_is_403(self):
        r = self.c.get("/api/admin/secrets")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()["code"], "forbidden")

    def test_security_headers_are_present(self):
        h = self.c.get("/").headers
        self.assertIn("default-src 'self'", h["Content-Security-Policy"])
        self.assertEqual(h["X-Frame-Options"], "DENY")
        self.assertEqual(h["X-Content-Type-Options"], "nosniff")
        self.assertIn("camera=()", h["Permissions-Policy"])

    def test_csp_allows_no_third_party_origin(self):
        # The app loads nothing from anywhere else. If that ever changes it
        # should be a deliberate edit, not a silent new dependency.
        csp = self.c.get("/").headers["Content-Security-Policy"]
        self.assertNotIn("http://", csp)
        self.assertNotIn("https://", csp)
        self.assertIn("connect-src 'self'", csp)

    def test_every_response_carries_a_request_id(self):
        self.assertTrue(self.c.get("/healthz").headers["X-Request-Id"])

    def test_supplied_request_id_is_echoed(self):
        r = self.c.get("/healthz", headers={"X-Request-Id": "abc123"})
        self.assertEqual(r.headers["X-Request-Id"], "abc123")

    def test_app_code_is_not_cached_but_icons_are(self):
        self.assertEqual(
            self.c.get("/static/js/main.js").headers["Cache-Control"], "no-cache")
        self.assertIn("max-age", self.c.get("/static/icons/icon.svg").headers["Cache-Control"])

    def test_service_worker_is_served_from_the_root(self):
        # A worker under /static/ could never control "/", so the app would
        # silently fail to work offline.
        r = self.c.get("/sw.js")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers["Service-Worker-Allowed"], "/")

    def test_oversized_body_is_rejected_as_json(self):
        r = self.c.post("/api/store/bulk", data=b"x" * (9 * 1024 * 1024),
                        content_type="application/json")
        self.assertEqual(r.status_code, 413)

    def test_settings_rejects_a_truncated_token(self):
        r = self.c.post("/settings", json={"medhaUrl": "http://127.0.0.1:8001",
                                           "token": "ac0328c9d6…e4b4"})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.get_json()["code"], "truncated_token")

    def test_settings_rejects_a_bad_url_before_touching_the_network(self):
        r = self.c.post("/settings", json={"medhaUrl": "http://127.0.0.0:8001",
                                           "token": "a" * 40})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.get_json()["code"], "bad_url")

    def test_mock_inbox_is_usable(self):
        r = self.c.get("/api/connectors/sms/messages?limit=5")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(len(r.get_json()["messages"]) > 0)


class TestConfigSnapshot(unittest.TestCase):
    def test_snapshot_is_atomic(self):
        # The pair must never be read half-updated: the old URL with the new
        # token produces a 401 that makes no sense to anyone.
        server.MEDHA_URL, server.MEDHA_TOKEN = "http://127.0.0.1:1", "tok1"
        url, tok = server.medha_config()
        self.assertEqual((url, tok), ("http://127.0.0.1:1", "tok1"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
