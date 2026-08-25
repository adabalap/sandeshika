#!/usr/bin/env python3
"""
Sandeshika · సందేశిక — server.

Two jobs, and only two:

  1. Serve the PWA (static HTML/JS/CSS) with the headers a browser needs before
     it will treat the app as installable.
  2. Reverse-proxy /api/* to Medha on the phone.

The proxy is not decoration. Without it:

  - CORS blocks everything. Medha allows only its own loopback origins
    (127.0.0.1:8080 / localhost:8080). A page served from :5000 is a different
    origin, so the browser refuses to read any response.
  - The API token would have to live in the browser, where any script on the
    page can read it. Here it stays in the server process and is attached on
    the way out, so the browser never sees it.

This Flask server runs on a LAPTOP (or under Termux), never as a second service
on the phone alongside Medha. Medha is the backend; this is a static host with
one useful piece of plumbing.
"""

import argparse
import contextlib
import json
import logging
import os
import random
import re
import secrets
import sys
import threading
import time
from collections import deque
from datetime import datetime, timedelta

import requests
from flask import Flask, Response, g, jsonify, request, send_from_directory, stream_with_context
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

LOG_LEVEL = os.environ.get("SANDESHIKA_LOG", "INFO").upper()

logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format="%(asctime)s %(levelname)-5s %(name)s %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("sandeshika")

# Werkzeug logs one line per request at INFO, which drowns everything useful
# during a backfill — that is hundreds of proxied calls a minute. Ours are
# structured and include timing, so its default access log is redundant.
logging.getLogger("werkzeug").setLevel(logging.WARNING)

APP_NAME = "Sandeshika"
APP_VERSION = "2.2.0"  # kept in step with package.json by tests/shell.test.js
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

SETTINGS_FILE = os.path.join(HERE, "settings.json")
STARTED_AT = time.monotonic()

# Medha defaults to 8080, but 8001 is the port in use on this setup and
# "Find Medha" probes both regardless.
DEFAULT_MEDHA_URL = "http://127.0.0.1:8001"
MEDHA_URL = os.environ.get("MEDHA_URL", DEFAULT_MEDHA_URL).rstrip("/")
MEDHA_TOKEN = os.environ.get("MEDHA_TOKEN", "")
MOCK = os.environ.get("SANDESHIKA_MOCK", "") == "1"


# Where the currently active values came from, so the UI can say so.
SOURCE = {"url": "default", "token": "none"}

# MEDHA_URL and MEDHA_TOKEN are read by every proxied request and rewritten by
# POST /settings. Flask serves requests on multiple threads, so without this a
# backfill running while someone saves a new token can read a half-updated pair
# — the old URL with the new token — and get a 401 that makes no sense to
# anybody. The lock is held only around the read and the swap, never across the
# network call.
_config_lock = threading.RLock()


def medha_config():
    """Atomic snapshot of the address and token."""
    with _config_lock:
        return MEDHA_URL, MEDHA_TOKEN


def load_settings():
    """
    Settings saved from the Setup screen.

    Precedence: SAVED SETTINGS WIN over env/CLI.

    The reverse was tried first and was wrong. run.sh exported MEDHA_TOKEN, the
    server then treated the field as locked, and a user whose env token was
    stale had no way to fix it from the only screen that offers to. Whoever is
    sitting in front of the app right now is acting later and more
    deliberately than whatever was exported at launch, so they win. The UI shows
    which source is active and offers to clear the override.
    """
    global MEDHA_URL, MEDHA_TOKEN
    if os.environ.get("MEDHA_URL"):
        SOURCE["url"] = "env"
    if os.environ.get("MEDHA_TOKEN"):
        SOURCE["token"] = "env"

    if not os.path.exists(SETTINGS_FILE):
        return
    try:
        with open(SETTINGS_FILE) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return
    if saved.get("medhaUrl"):
        MEDHA_URL = str(saved["medhaUrl"]).rstrip("/")
        SOURCE["url"] = "saved"
    if saved.get("token"):
        MEDHA_TOKEN = saved["token"]
        SOURCE["token"] = "saved"


def save_settings(url: str, token: str):
    """
    Persisted server-side so the browser never holds the credential.

    Mode 0600: the token grants access to everything that client can reach in
    Medha, so it should not be world-readable on a shared machine.
    """
    data = {"medhaUrl": url, "token": token}
    tmp = SETTINGS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, SETTINGS_FILE)


def validate_url(url: str):
    """
    Returns (ok, message). Strict on purpose.

    The previous check was a loose dotted-string match, which happily
    accepted http://127.0.0.0:8001 — one digit off from loopback. The typo then
    surfaced as a raw "Failed to fetch" from the browser, which tells the user
    nothing. A wrong address is the single most likely setup mistake, so it is
    worth catching precisely.
    """
    m = re.match(r"^(https?)://([^/:\s]+)(?::(\d{1,5}))?/?$", url)
    if not m:
        return False, ("Use the form http://127.0.0.1:8080 — scheme, host and port, "
                       "with no path.")
    host, port = m.group(2), m.group(3)

    if re.fullmatch(r"[\d.]+", host):
        parts = host.split(".")
        if len(parts) != 4 or not all(p.isdigit() and 0 <= int(p) <= 255 for p in parts):
            return False, f"'{host}' is not a valid IP address. Did you mean 127.0.0.1?"
        # 127.0.0.0 is the loopback NETWORK address, not a host. Nothing listens
        # on it, and it is one keystroke away from the address people intend.
        if host == "127.0.0.0":
            return False, "127.0.0.0 is the loopback network, not an address. Use 127.0.0.1."
        if parts[0] == "127" and host != "127.0.0.1":
            return False, f"Loopback is 127.0.0.1, not {host}."

    if port is not None and not (1 <= int(port) <= 65535):
        return False, f"Port {port} is out of range (1-65535)."
    if port is None:
        return False, "Include the port, e.g. http://127.0.0.1:8080."
    return True, ""


# A pooled session, not a bare requests.get per call.
#
# A backfill issues one request per page plus one per uncached merchant —
# hundreds in a burst. Without pooling each one opens a new TCP connection to
# the phone, and over adb forward that handshake is the dominant cost. Retries
# cover only idempotent methods and only transport-level failures; a 4xx from
# Medha is an answer and must reach the user unchanged.
def _build_session() -> requests.Session:
    sess = requests.Session()
    retry = Retry(
        total=2,
        connect=2,
        read=1,
        backoff_factor=0.3,
        status_forcelist=(),          # never retry on a status; Medha means it
        allowed_methods=frozenset(["GET", "HEAD"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(pool_connections=8, pool_maxsize=16, max_retries=retry)
    sess.mount("http://", adapter)
    sess.mount("https://", adapter)
    return sess


HTTP = _build_session()


def probe(url: str, token: str = ""):
    """Single quick check of one candidate address."""
    try:
        h = HTTP.get(f"{url}/health", timeout=2.5)
        if h.status_code != 200:
            return None
        data = h.json() if h.headers.get("Content-Type", "").startswith("application/json") else {}
        out = {"url": url, "modelLoaded": bool(data.get("modelLoaded")), "tokenOk": None}
        if token:
            a = HTTP.get(f"{url}/store", params={"prefix": "meta/", "limit": 1},
                         headers={"Authorization": f"Bearer {token}"}, timeout=3)
            out["tokenOk"] = a.status_code not in (401, 403)
        return out
    except requests.exceptions.RequestException:
        return None


def mask(token: str) -> str:
    if not token:
        return ""
    return token[:6] + "…" + token[-4:] if len(token) > 12 else "set"

app = Flask(__name__, static_folder=None)

# A request body larger than this is not a legitimate call from this PWA. The
# biggest thing it sends is a /store/bulk write of one page of transactions.
app.config["MAX_CONTENT_LENGTH"] = 8 * 1024 * 1024
app.config["JSON_SORT_KEYS"] = False


class RateLimit:
    """
    A small fixed-window limiter for the endpoints worth protecting.

    /settings verifies a token against Medha, and /detect opens connections to
    six ports. Both are unauthenticated by necessity — they are how you get
    authenticated — so an errant script (or a page left reloading) can turn
    either into a loop that hammers the phone. This is not a defence against an
    attacker on the network; if someone can reach this port they can already
    reach Medha. It is a guard against the app, or a mistake, running away.
    """

    def __init__(self, limit: int, window: float):
        self.limit = limit
        self.window = window
        self.hits = deque()
        self.lock = threading.Lock()

    def allow(self) -> bool:
        now = time.monotonic()
        with self.lock:
            while self.hits and now - self.hits[0] > self.window:
                self.hits.popleft()
            if len(self.hits) >= self.limit:
                return False
            self.hits.append(now)
            return True

    def retry_after(self) -> int:
        with self.lock:
            if not self.hits:
                return 1
            return max(1, int(self.window - (time.monotonic() - self.hits[0])) + 1)


SETTINGS_LIMIT = RateLimit(limit=12, window=60.0)
DETECT_LIMIT = RateLimit(limit=6, window=60.0)


@app.before_request
def start_timer():
    g.started = time.monotonic()
    # Correlates the browser console, this log and a Medha-side log for one
    # user action. Debugging a proxy without one means guessing which of forty
    # near-identical lines belongs to the call that failed.
    g.rid = request.headers.get("X-Request-Id") or secrets.token_hex(4)


@app.after_request
def log_request(resp):
    started = getattr(g, "started", None)
    if started is not None and not request.path.startswith("/static/"):
        ms = (time.monotonic() - started) * 1000
        level = logging.WARNING if resp.status_code >= 500 else logging.INFO
        log.log(level, "%s %s %s %s %.0fms",
                getattr(g, "rid", "-"), request.method, request.path, resp.status_code, ms)
    resp.headers["X-Request-Id"] = getattr(g, "rid", "-")
    return resp


# ---------------------------------------------------------------------------
# Errors: JSON, always
#
# The client parses every failure as JSON and shows `error` to the user. A
# Flask HTML error page therefore surfaced as an unreadable parse failure,
# which is how a plain 404 came to look like a broken app.
# ---------------------------------------------------------------------------
def _json_error(status, message, code):
    return jsonify({"error": message, "code": code,
                    "requestId": getattr(g, "rid", "-")}), status


@app.errorhandler(404)
def not_found(_e):
    return _json_error(404, f"No such endpoint: {request.path}", "not_found")


@app.errorhandler(405)
def not_allowed(_e):
    return _json_error(405, f"{request.method} is not allowed on {request.path}", "method_not_allowed")


@app.errorhandler(413)
def too_large(_e):
    return _json_error(413, "That request body is too large.", "payload_too_large")


@app.errorhandler(Exception)
def unhandled(e):
    # Logged with a traceback for the operator; the user gets the request id and
    # nothing about the internals.
    log.exception("%s unhandled error on %s", getattr(g, "rid", "-"), request.path)
    return _json_error(
        500,
        f"Sandeshika hit an unexpected error (reference {getattr(g, 'rid', '-')}). "
        "The terminal running the server has the details.",
        "internal_error",
    )

# Endpoints the PWA is allowed to reach. An open proxy would let any script on
# the page drive the whole of Medha, including other apps' namespaces.
ALLOWED = re.compile(
    r"^(health|system|metrics|scheduler"
    r"|generate|generate/stream|chat"
    r"|store(/.*)?|sessions(/.*)?"
    r"|connectors/sms/(status|conversations|messages|messages/\d+|contacts/.+|mark-read|events)"
    r"|notify(/.*)?|rag/(ingest|query|collections|reindex))$"
)

STREAMING = {"generate/stream", "connectors/sms/events"}


# ---------------------------------------------------------------------------
# PWA shell
# ---------------------------------------------------------------------------
# The app loads no third-party anything: no CDN, no font service, no analytics.
# That means the policy can be closed almost completely, and any future
# dependency has to be a deliberate edit here rather than something that
# quietly starts phoning out. 'self' covers the ES module graph.
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",   # inline styles set bar widths per row
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
])


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Content-Security-Policy", CSP)
    resp.headers.setdefault("X-Frame-Options", "DENY")
    # This app reads financial messages. Nothing it does needs a camera, a
    # microphone or a location, so the browser is told to refuse outright.
    resp.headers.setdefault(
        "Permissions-Policy",
        "geolocation=(), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()")
    return resp


@app.route("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.route("/sw.js")
def service_worker():
    """
    Must be served from the ROOT path, not /static/. A service worker can only
    control pages at or below its own URL, so one served from /static/sw.js
    could never control "/" and the app would silently fail to work offline.
    """
    resp = send_from_directory(STATIC, "sw.js", mimetype="application/javascript")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["Service-Worker-Allowed"] = "/"
    return resp


@app.route("/manifest.webmanifest")
def manifest():
    return send_from_directory(STATIC, "manifest.webmanifest",
                               mimetype="application/manifest+json")


@app.route("/static/<path:path>")
def static_files(path):
    resp = send_from_directory(STATIC, path)
    if path.startswith("icons/"):
        # Icons are content-stable; the app's code is not. Caching JS here would
        # fight the service worker's network-first strategy, which exists
        # precisely because a stale bundle is invisible from inside the app.
        resp.headers["Cache-Control"] = "public, max-age=604800"
    else:
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.route("/healthz")
def healthz():
    """
    Liveness for a supervisor. Deliberately does NOT touch Medha: a health
    check that fails because the phone is unplugged would have systemd
    restarting a server that is working perfectly.
    """
    return jsonify({"ok": True, "app": APP_NAME, "version": APP_VERSION,
                    "mock": MOCK, "uptimeSeconds": round(time.monotonic() - STARTED_AT)})


@app.route("/config.json")
def config():
    """Told to the client at boot so the UI can be honest about its state."""
    return jsonify({
        "app": APP_NAME,
        "version": APP_VERSION,
        "mock": MOCK,
        "medhaUrl": "mock" if MOCK else MEDHA_URL,
        "defaultMedhaUrl": DEFAULT_MEDHA_URL,
        "tokenConfigured": bool(MEDHA_TOKEN) or MOCK,
        "tokenPreview": mask(MEDHA_TOKEN),
        "tokenSource": SOURCE["token"],
        "urlSource": SOURCE["url"],
        "envTokenPresent": bool(os.environ.get("MEDHA_TOKEN")),
        "installable": request.host.split(":")[0] in ("localhost", "127.0.0.1")
                       or request.scheme == "https",
    })


@app.route("/settings", methods=["POST"])
def settings():
    """
    Accepts a token and Medha URL from the Setup screen and stores them on the
    SERVER. The value is written to disk and attached to outgoing requests; it
    is never sent back to the browser, and the response only ever contains a
    masked preview.
    """
    global MEDHA_URL, MEDHA_TOKEN

    if not SETTINGS_LIMIT.allow():
        return jsonify({"error": "Too many attempts in a row. Wait a moment and try again.",
                        "code": "rate_limited"}), 429, {"Retry-After": str(SETTINGS_LIMIT.retry_after())}

    body = request.get_json(silent=True) or {}
    url = str(body.get("medhaUrl") or MEDHA_URL).strip().rstrip("/")
    token = str(body.get("token") or "").strip()

    valid, why = validate_url(url)
    if not valid:
        return jsonify({"error": why, "code": "bad_url"}), 400

    # An empty token means "keep the current one" so the user can change only
    # the port without re-pasting a credential they cannot read back.
    if not token:
        token = MEDHA_TOKEN
    if not token:
        return jsonify({"error": "A Medha API token is required", "code": "no_token"}), 400

    # Medha's client list displays tokens shortened, e.g. "ac0328c9d6…e4b4".
    # Selecting that text copies the ellipsis, and the result is rejected by the
    # server with a generic 401 that sends people hunting in the wrong place.
    # Name the actual mistake instead.
    if "…" in token or "..." in token:
        return jsonify({
            "error": "That is the shortened token Medha shows in the list, not the real one. "
                     "In Medha: API clients → tap the client → Copy token.",
            "code": "truncated_token"}), 400
    if not re.fullmatch(r"[0-9a-f]{32,64}", token):
        return jsonify({
            "error": f"A Medha token is 40 hexadecimal characters; this is {len(token)} "
                     f"character(s) and contains other symbols. Use API clients → "
                     f"tap the client → Copy token.",
            "code": "malformed_token"}), 400

    # Verify before persisting: saving a token that does not work just moves the
    # failure somewhere less obvious.
    try:
        probe = requests.get(f"{url}/health", timeout=6)
        if probe.status_code != 200:
            return jsonify({"error": f"Medha at {url} returned HTTP {probe.status_code} on /health",
                            "code": "medha_error"}), 502
        auth = requests.get(f"{url}/store", params={"prefix": "meta/", "limit": 1},
                            headers={"Authorization": f"Bearer {token}"}, timeout=10)
        if auth.status_code in (401, 403):
            return jsonify({"error": "Medha rejected that token. Check it was copied in full, "
                                     "and that the client has the store capability.",
                            "code": "bad_token"}), 401
    except requests.exceptions.ConnectionError:
        return jsonify({"error": f"Nothing is listening at {url}. Check Medha's port, and that "
                                 f"the phone is forwarded (adb forward tcp:8001 tcp:8001).",
                        "code": "medha_unreachable"}), 502
    except requests.exceptions.Timeout:
        return jsonify({"error": f"{url} did not respond in time", "code": "timeout"}), 504

    with _config_lock:
        MEDHA_URL, MEDHA_TOKEN = url, token
        SOURCE["url"] = SOURCE["token"] = "saved"
        save_settings(url, token)
    log.info("%s settings saved: %s token %s", getattr(g, "rid", "-"), url, mask(token))
    health = probe.json() if probe.headers.get("Content-Type", "").startswith("application/json") else {}
    return jsonify({
        "ok": True,
        "medhaUrl": MEDHA_URL,
        "tokenPreview": mask(MEDHA_TOKEN),
        "modelLoaded": bool(health.get("modelLoaded")),
    })


@app.route("/detect")
def detect():
    """
    Finds Medha by trying the ports it is usually on.

    Cheaper for the user than guessing, and it removes the most common setup
    failure entirely: a correct token paired with the wrong port.
    """
    if MOCK:
        return jsonify({"found": [{"url": "mock", "modelLoaded": True, "tokenOk": True}]})
    if not DETECT_LIMIT.allow():
        return jsonify({"error": "Port scan already running. Wait a moment.",
                        "code": "rate_limited"}), 429, {"Retry-After": str(DETECT_LIMIT.retry_after())}
    ports = [8001, 8080, 8000, 8081, 5001, 9090]
    current = MEDHA_URL
    found = []
    for host in ("127.0.0.1",):
        for port in ports:
            u = f"http://{host}:{port}"
            r = probe(u, MEDHA_TOKEN)
            if r:
                found.append(r)
    return jsonify({"found": found, "current": current, "tried": ports})


@app.route("/settings", methods=["DELETE"])
def clear_settings():
    """Drops the saved override and falls back to whatever env/CLI supplied."""
    global MEDHA_URL, MEDHA_TOKEN
    with contextlib.suppress(OSError):
        os.remove(SETTINGS_FILE)
    MEDHA_TOKEN = os.environ.get("MEDHA_TOKEN", "")
    MEDHA_URL = os.environ.get("MEDHA_URL", DEFAULT_MEDHA_URL).rstrip("/")
    SOURCE["token"] = "env" if MEDHA_TOKEN else "none"
    SOURCE["url"] = "env" if os.environ.get("MEDHA_URL") else "default"
    return jsonify({"cleared": True, "medhaUrl": MEDHA_URL,
                    "tokenPreview": mask(MEDHA_TOKEN), "tokenSource": SOURCE["token"]})


# ---------------------------------------------------------------------------
# Proxy
# ---------------------------------------------------------------------------
def _proxy(path: str):
    medha_url, token = medha_config()
    url = f"{medha_url}/{path}"
    headers = {"Content-Type": request.headers.get("Content-Type", "application/json")}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # Pass the batch-priority hint through: it is what makes Medha's thermal
    # gating apply to bulk imports.
    if request.headers.get("X-Medha-Priority"):
        headers["X-Medha-Priority"] = request.headers["X-Medha-Priority"]

    try:
        if path in STREAMING:
            upstream = HTTP.request(
                request.method, url, headers=headers,
                data=request.get_data(), params=request.args,
                stream=True, timeout=(5, None),
            )

            def relay():
                for chunk in upstream.iter_content(chunk_size=None):
                    if chunk:
                        yield chunk

            return Response(
                stream_with_context(relay()),
                status=upstream.status_code,
                content_type=upstream.headers.get("Content-Type", "text/event-stream"),
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )

        # 180s: a cold model load on the phone genuinely takes minutes, and a
        # timeout here turns a slow success into a failed import that the user
        # then re-runs, making the phone slower still.
        upstream = HTTP.request(
            request.method, url, headers=headers,
            data=request.get_data(), params=request.args, timeout=(5, 180),
        )
        resp = Response(upstream.content, status=upstream.status_code,
                        content_type=upstream.headers.get("Content-Type", "application/json"))
        # Retry-After carries Medha's thermal backoff; dropping it would make
        # the client guess how long to wait.
        if "Retry-After" in upstream.headers:
            resp.headers["Retry-After"] = upstream.headers["Retry-After"]
        return resp

    except requests.exceptions.ConnectionError:
        log.warning("%s cannot reach Medha at %s", getattr(g, "rid", "-"), medha_url)
        return jsonify({
            "error": f"Cannot reach Medha at {medha_url}. Is the service running, "
                     f"and is the port forwarded (adb forward tcp:8080 tcp:8080)?",
            "code": "medha_unreachable",
        }), 502
    except requests.exceptions.Timeout:
        log.warning("%s Medha timed out on %s", getattr(g, "rid", "-"), path)
        return jsonify({
            "error": "Medha did not respond in time. If a model is loading for the "
                     "first time this can take a few minutes — try again shortly.",
            "code": "timeout",
        }), 504
    except requests.exceptions.RequestException as exc:
        # Anything else at the transport layer. Named rather than swallowed:
        # an unlabelled 502 sends people debugging the wrong layer.
        log.warning("%s transport failure to Medha: %s", getattr(g, "rid", "-"), exc)
        return jsonify({"error": f"The connection to Medha failed: {exc.__class__.__name__}",
                        "code": "transport_error"}), 502


@app.route("/api/<path:path>", methods=["GET", "POST", "PUT", "DELETE"])
def api(path):
    # Enforced before the mock/proxy split so both behave identically. An open
    # proxy would let any script on the page drive the whole of Medha,
    # including other clients' namespaces and the admin surface.
    if not ALLOWED.match(path):
        return jsonify({"error": f"endpoint not permitted through this proxy: {path}",
                        "code": "forbidden"}), 403
    if MOCK:
        return mock_api(path)
    return _proxy(path)


# ---------------------------------------------------------------------------
# Mock Medha — lets the whole app be demoed with no phone attached.
# ---------------------------------------------------------------------------
_mock_store = {}
_mock_inbox = []


def _build_mock_inbox(n_days=120):
    """A realistic Indian inbox: genuine spend plus the noise that must not count."""
    random.seed(7)
    msgs, mid = [], 1
    merchants = [
        ("swiggy@ybl", 180, 700), ("zepto@ybl", 200, 1200), ("uber@axis", 60, 450),
        ("AMAZON", 300, 4000), ("airtel@hdfc", 299, 999), ("NETFLIX", 199, 799),
        ("bigbasket@ybl", 400, 2500), ("IRCTC", 250, 1800), ("apollo@hdfc", 150, 1500),
        ("RAZORPAY*BOOKSTORE", 200, 900), ("zomato@ybl", 150, 800),
    ]
    now = datetime.now()
    for d in range(n_days):
        day = now - timedelta(days=d)
        ds = day.strftime("%d-%m-%y")
        for _ in range(random.randint(0, 3)):
            name, lo, hi = random.choice(merchants)
            amt = round(random.uniform(lo, hi), 2)
            ref = f"{random.randint(100000000000, 999999999999)}"
            msgs.append({
                "id": mid, "date": int(day.timestamp() * 1000), "address": "AX-HDFCBK",
                "body": f"Rs.{amt} debited from a/c XX1234 on {ds} to VPA {name}. "
                        f"Ref {ref}. Not you? Call 18002586161",
            })
            mid += 1
            # the same payment, reported again by the UPI app
            if random.random() < 0.25:
                msgs.append({
                    "id": mid, "date": int(day.timestamp() * 1000) + 40000, "address": "JM-PAYTM",
                    "body": f"You paid Rs.{amt} to {name.split('@')[0]} via Paytm UPI on {ds}",
                })
            mid += 1
        if random.random() < 0.4:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000) + 120000,
                         "address": "VM-HDFCBK",
                         "body": f"Your OTP is {random.randint(1000,9999)} for txn of "
                                 f"Rs.{random.randint(500,5000)}. Do not share."})
            mid += 1
        if random.random() < 0.2:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000) + 200000,
                         "address": "AD-HDFCBK",
                         "body": f"Avl bal in a/c XX1234 is Rs.{random.randint(20000,90000)}.00 "
                                 f"as on {ds}"})
            mid += 1
        if day.day == 1:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000),
                         "address": "AX-HDFCBK",
                         "body": f"Rs.85,000.00 credited to a/c XX1234 on {ds} by NEFT from "
                                 f"ACME TECHNOLOGIES. Ref N{random.randint(10000,99999)}"})
            mid += 1
        # Bills, promos and spam: without these the organiser tabs are empty in
        # demo mode, which makes a working feature look broken.
        if day.day == 20:
            due = (day + timedelta(days=14)).strftime("%d-%b-%y")
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000), "address": "MD-HDFCBK",
                         "body": f"E-Statement Generated! For HDFC Bank Credit Card 0541. "
                                 f"Due date:{due}.Total Due:Rs.{random.randint(4000,40000)}."
                                 f"Min Due:Rs.{random.randint(500,2000)}"})
            mid += 1
        if day.day == 22:
            due = (day + timedelta(days=8)).strftime("%d-%b-%y")
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000), "address": "JZ-JioPay",
                         "body": f"Your Jio postpaid bill of Rs.{random.randint(300,900)} is due on {due}. "
                                 f"Pay to avoid disconnection."})
            mid += 1
        if random.random() < 0.3:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000) + 300000,
                         "address": "AX-ICICIT",
                         "body": "Convert your ICICI Bank Credit Card outstanding amount into "
                                 "easy EMIs, by clicking on REDACTED.LINK . T&Cs."})
            mid += 1
        if random.random() < 0.15:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000) + 400000,
                         "address": "VM-BLUDRT",
                         "body": "Your order has been dispatched and is out for delivery today. "
                                 "Track AWB 33487873145"})
            mid += 1
        if day.day == 9:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000) + 500000,
                         "address": "AX-HORFIN",
                         "body": "Trade Summary():- K1 is selecting capable agents who can earn "
                                 "Rs 5,000 - Rs 10,000 per day, contact:wa.me/918016841598"})
            mid += 1
        if day.day == 5:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000),
                         "address": "AX-HDFCBK",
                         "body": f"Rs.{random.randint(8000,25000)}.00 debited from a/c XX1234 on "
                                 f"{ds} towards HDFC Credit Card payment. Ref CC{random.randint(1000,9999)}"})
            mid += 1
    msgs.sort(key=lambda m: -m["date"])
    return msgs


def mock_api(path):
    global _mock_inbox
    if not _mock_inbox:
        _mock_inbox = _build_mock_inbox()

    if path == "health":
        return jsonify({"status": "ok", "modelLoaded": True, "backend": "MOCK", "busy": False})
    if path == "system":
        return jsonify({"name": "Medha (mock)", "version": "mock", "modelLoaded": True,
                        "backendConfigured": "MOCK", "memTotalMb": 8192, "memUsedMb": 3900,
                        "thermal": "none", "thermalHeadroom": 0.42})
    if path == "scheduler":
        return jsonify({"queueDepth": 0, "maxQueueDepth": 8, "batchPaused": False,
                        "thermalHeadroom": 0.42, "thermalPauseAt": 0.85,
                        "thermalResumeAt": 0.7, "charging": True, "batteryPercent": 88})
    if path == "connectors/sms/status":
        return jsonify({"supported": True, "canRead": True, "canSend": False,
                        "isDefaultSmsApp": False, "totalMessages": len(_mock_inbox)})
    if path == "connectors/sms/messages":
        before = int(request.args.get("before", 0) or 0)
        since = int(request.args.get("since", 0) or 0)
        limit = int(request.args.get("limit", 100) or 100)
        out = _mock_inbox
        if before:
            out = [m for m in out if m["date"] < before]
        if since:
            out = [m for m in out if m["date"] > since]
        out = out[:limit]
        return jsonify({"messages": out, "count": len(out),
                        "nextBefore": min([m["date"] for m in out]) if out else 0})
    if path == "generate":
        body = request.get_json(silent=True) or {}
        prompt = body.get("prompt", "")
        # Deterministic stand-in so mock runs are reproducible.
        if "Categories:" in prompt:
            for c in ("food", "groceries", "transport", "shopping", "bills",
                      "entertainment", "health", "travel"):
                if c in prompt.lower():
                    return jsonify({"text": c, "tokens": 1, "ms": 8, "tokensPerSec": 125})
            return jsonify({"text": "other", "tokens": 1, "ms": 8, "tokensPerSec": 125})
        time.sleep(0.2)
        return jsonify({
            "text": "This is a mock answer. Run against a real Medha for model output. "
                    "The figures shown in the app are computed locally and are real.",
            "tokens": 24, "ms": 200, "tokensPerSec": 120,
        })
    if path == "store/bulk":
        items = (request.get_json(silent=True) or {}).get("items", [])
        for i in items:
            _mock_store[i["key"]] = i["value"]
        return jsonify({"written": len(items)})
    if path == "store":
        prefix = request.args.get("prefix", "")
        limit = int(request.args.get("limit", 500))
        offset = int(request.args.get("offset", 0))
        rows = [(k, v) for k, v in _mock_store.items() if k.startswith(prefix)]
        page = rows[offset:offset + limit]
        return jsonify({"prefix": prefix, "total": len(rows),
                        "items": [{"key": k, "value": v, "updatedAt": 0} for k, v in page]})
    if path.startswith("store/"):
        key = path[len("store/"):]
        if request.method == "PUT":
            _mock_store[key] = request.get_data(as_text=True)
            return jsonify({"ok": True})
        if request.method == "DELETE":
            _mock_store.pop(key, None)
            return jsonify({"deleted": True})
        if key in _mock_store:
            return Response(_mock_store[key], content_type="application/json")
        return jsonify({"error": "no such key", "code": "not_found"}), 404
    return jsonify({"error": "mock does not implement " + path}), 404


# ---------------------------------------------------------------------------
def main():
    global MEDHA_URL, MEDHA_TOKEN, MOCK

    p = argparse.ArgumentParser(description=f"{APP_NAME} — spending from your SMS")
    p.add_argument("--host", default="127.0.0.1",
                   help="127.0.0.1 keeps the PWA installable; 0.0.0.0 exposes it on the LAN")
    p.add_argument("--port", type=int, default=5000)
    p.add_argument("--medha", default=MEDHA_URL)
    p.add_argument("--token", default=MEDHA_TOKEN)
    p.add_argument("--mock", action="store_true", help="run with a synthetic inbox, no phone needed")
    p.add_argument("--threads", type=int, default=8,
                   help="worker threads; raise only if a backfill is queueing")
    p.add_argument("--debug", action="store_true",
                   help="Flask development server with the reloader. Never for real use.")
    args = p.parse_args()

    MEDHA_URL = args.medha.rstrip("/")
    MEDHA_TOKEN = args.token
    MOCK = args.mock or MOCK
    if args.token:
        SOURCE["token"] = "env"
    if args.medha != DEFAULT_MEDHA_URL:
        SOURCE["url"] = "env"
    # Saved settings override env/CLI; see load_settings().
    if not MOCK:
        load_settings()

    print(f"\n  {APP_NAME} · సందేశిక")
    print(f"  http://{args.host}:{args.port}")
    print(f"  Medha    : {'MOCK (synthetic inbox)' if MOCK else MEDHA_URL}")
    print(f"  Token    : {mask(MEDHA_TOKEN) if MEDHA_TOKEN else ('not needed in mock' if MOCK else 'not set — paste it in Setup')}")
    if args.host not in ("127.0.0.1", "localhost"):
        print("\n  ! Browsers only offer 'Install app' on localhost or HTTPS.")
        print("    On a LAN IP the app still runs but cannot be installed.")
        print(f"    Use: adb reverse tcp:{args.port} tcp:{args.port}   "
              f"and open http://localhost:{args.port}")
    print()

    if args.debug:
        log.warning("debug mode: the reloader and interactive debugger are ON. "
                    "Never run this on a shared machine.")
        app.run(host=args.host, port=args.port, debug=True, threaded=True)
        return

    # Waitress over Flask's development server.
    #
    # `app.run()` prints "This is a development server. Do not use it in a
    # production deployment" for good reason: it is single-process, has no
    # request queue limit, and its threading is not tuned for the burst a
    # backfill produces. Waitress is pure Python, installs anywhere including
    # Termux, and needs no configuration. If it is genuinely unavailable the
    # app still starts — refusing to run would be worse than running warned.
    try:
        from waitress import serve as waitress_serve
    except ImportError:
        log.warning("waitress not installed — falling back to the Flask development "
                    "server. Run: pip install -r requirements.txt")
        app.run(host=args.host, port=args.port, threaded=True)
        return

    waitress_serve(
        app,
        host=args.host,
        port=args.port,
        threads=args.threads,
        # A backfill can queue many proxied calls at once; the default of 100
        # is ample, and naming it makes the ceiling explicit.
        connection_limit=200,
        # Streaming endpoints (generate/stream, sms/events) must not be cut off
        # while the model is still producing tokens.
        channel_timeout=300,
        ident=f"{APP_NAME}/{APP_VERSION}",
    )


if __name__ == "__main__":
    main()
