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
import json
import os
import random
import re
import time
from datetime import datetime, timedelta

import requests
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

APP_NAME = "Sandeshika"
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

SETTINGS_FILE = os.path.join(HERE, "settings.json")

DEFAULT_MEDHA_URL = "http://127.0.0.1:8080"
MEDHA_URL = os.environ.get("MEDHA_URL", DEFAULT_MEDHA_URL).rstrip("/")
MEDHA_TOKEN = os.environ.get("MEDHA_TOKEN", "")
MOCK = os.environ.get("SANDESHIKA_MOCK", "") == "1"


def load_settings():
    """
    Settings saved from the UI, layered under the environment.

    Precedence: env/CLI wins, because an explicitly launched server should not
    be silently overridden by something a browser wrote earlier.
    """
    global MEDHA_URL, MEDHA_TOKEN
    if not os.path.exists(SETTINGS_FILE):
        return
    try:
        with open(SETTINGS_FILE) as f:
            saved = json.load(f)
    except (OSError, ValueError):
        return
    if not os.environ.get("MEDHA_URL") and saved.get("medhaUrl"):
        MEDHA_URL = str(saved["medhaUrl"]).rstrip("/")
    if not os.environ.get("MEDHA_TOKEN") and saved.get("token"):
        MEDHA_TOKEN = saved["token"]


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


def mask(token: str) -> str:
    if not token:
        return ""
    return token[:6] + "…" + token[-4:] if len(token) > 12 else "set"

app = Flask(__name__, static_folder=None)

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
@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
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
    return send_from_directory(STATIC, path)


@app.route("/config.json")
def config():
    """Told to the client at boot so the UI can be honest about its state."""
    return jsonify({
        "app": APP_NAME,
        "mock": MOCK,
        "medhaUrl": "mock" if MOCK else MEDHA_URL,
        "defaultMedhaUrl": DEFAULT_MEDHA_URL,
        "tokenConfigured": bool(MEDHA_TOKEN) or MOCK,
        "tokenPreview": mask(MEDHA_TOKEN),
        "envLocked": bool(os.environ.get("MEDHA_TOKEN")),
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

    if os.environ.get("MEDHA_TOKEN"):
        return jsonify({
            "error": "This server was started with MEDHA_TOKEN in the environment, "
                     "which takes precedence. Restart without it to set the token here.",
            "code": "env_locked",
        }), 409

    body = request.get_json(silent=True) or {}
    url = str(body.get("medhaUrl") or MEDHA_URL).strip().rstrip("/")
    token = str(body.get("token") or "").strip()

    if not re.match(r"^https?://[\w.\-]+(:\d{1,5})?$", url):
        return jsonify({"error": f"'{url}' is not a valid base URL, e.g. http://127.0.0.1:8001",
                        "code": "bad_url"}), 400

    # An empty token means "keep the current one" so the user can change only
    # the port without re-pasting a credential they cannot read back.
    if not token:
        token = MEDHA_TOKEN
    if not token:
        return jsonify({"error": "A Medha API token is required", "code": "no_token"}), 400

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

    MEDHA_URL, MEDHA_TOKEN = url, token
    save_settings(url, token)
    health = probe.json() if probe.headers.get("Content-Type", "").startswith("application/json") else {}
    return jsonify({
        "ok": True,
        "medhaUrl": MEDHA_URL,
        "tokenPreview": mask(MEDHA_TOKEN),
        "modelLoaded": bool(health.get("modelLoaded")),
    })


@app.route("/settings", methods=["DELETE"])
def clear_settings():
    global MEDHA_TOKEN
    MEDHA_TOKEN = "" if not os.environ.get("MEDHA_TOKEN") else MEDHA_TOKEN
    try:
        os.remove(SETTINGS_FILE)
    except OSError:
        pass
    return jsonify({"cleared": True})


# ---------------------------------------------------------------------------
# Proxy
# ---------------------------------------------------------------------------
def _proxy(path: str):
    url = f"{MEDHA_URL}/{path}"
    headers = {"Content-Type": request.headers.get("Content-Type", "application/json")}
    if MEDHA_TOKEN:
        headers["Authorization"] = f"Bearer {MEDHA_TOKEN}"
    # Pass the batch-priority hint through: it is what makes Medha's thermal
    # gating apply to bulk imports.
    if request.headers.get("X-Medha-Priority"):
        headers["X-Medha-Priority"] = request.headers["X-Medha-Priority"]

    try:
        if path in STREAMING:
            upstream = requests.request(
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

        upstream = requests.request(
            request.method, url, headers=headers,
            data=request.get_data(), params=request.args, timeout=180,
        )
        resp = Response(upstream.content, status=upstream.status_code,
                        content_type=upstream.headers.get("Content-Type", "application/json"))
        # Retry-After carries Medha's thermal backoff; dropping it would make
        # the client guess how long to wait.
        if "Retry-After" in upstream.headers:
            resp.headers["Retry-After"] = upstream.headers["Retry-After"]
        return resp

    except requests.exceptions.ConnectionError:
        return jsonify({
            "error": f"Cannot reach Medha at {MEDHA_URL}. Is the service running, "
                     f"and is the port forwarded (adb forward tcp:8080 tcp:8080)?",
            "code": "medha_unreachable",
        }), 502
    except requests.exceptions.Timeout:
        return jsonify({"error": "Medha timed out", "code": "timeout"}), 504


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
            }); mid += 1
            # the same payment, reported again by the UPI app
            if random.random() < 0.25:
                msgs.append({
                    "id": mid, "date": int(day.timestamp() * 1000) + 40000, "address": "JM-PAYTM",
                    "body": f"You paid Rs.{amt} to {name.split('@')[0]} via Paytm UPI on {ds}",
                }); mid += 1
        if random.random() < 0.4:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000) + 120000,
                         "address": "VM-HDFCBK",
                         "body": f"Your OTP is {random.randint(1000,9999)} for txn of "
                                 f"Rs.{random.randint(500,5000)}. Do not share."}); mid += 1
        if random.random() < 0.2:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000) + 200000,
                         "address": "AD-HDFCBK",
                         "body": f"Avl bal in a/c XX1234 is Rs.{random.randint(20000,90000)}.00 "
                                 f"as on {ds}"}); mid += 1
        if day.day == 1:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000),
                         "address": "AX-HDFCBK",
                         "body": f"Rs.85,000.00 credited to a/c XX1234 on {ds} by NEFT from "
                                 f"ACME TECHNOLOGIES. Ref N{random.randint(10000,99999)}"}); mid += 1
        if day.day == 5:
            msgs.append({"id": mid, "date": int(day.timestamp() * 1000),
                         "address": "AX-HDFCBK",
                         "body": f"Rs.{random.randint(8000,25000)}.00 debited from a/c XX1234 on "
                                 f"{ds} towards HDFC Credit Card payment. Ref CC{random.randint(1000,9999)}"}); mid += 1
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
        limit = int(request.args.get("limit", 500)); offset = int(request.args.get("offset", 0))
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
    p.add_argument("--debug", action="store_true")
    args = p.parse_args()

    MEDHA_URL = args.medha.rstrip("/")
    MEDHA_TOKEN = args.token
    MOCK = args.mock or MOCK
    # Anything saved from the Setup screen fills the gaps left by env/CLI.
    if not MOCK:
        load_settings()

    print(f"\n  {APP_NAME} · సందేశిక")
    print(f"  http://{args.host}:{args.port}")
    print(f"  Medha    : {'MOCK (synthetic inbox)' if MOCK else MEDHA_URL}")
    print(f"  Token    : {mask(MEDHA_TOKEN) if MEDHA_TOKEN else ('not needed in mock' if MOCK else 'not set — paste it in Setup')}")
    if args.host not in ("127.0.0.1", "localhost"):
        print("\n  ! Browsers only offer 'Install app' on localhost or HTTPS.")
        print("    On a LAN IP the app still runs but cannot be installed.")
        print("    Use: adb reverse tcp:%d tcp:%d   and open http://localhost:%d"
              % (args.port, args.port, args.port))
    print()
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
