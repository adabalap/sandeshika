# Sandeshika · సందేశిక — Android app

*sandeśikā*, "messenger". Private insights from the SMS already on your phone —
spending, bills, highlights. A single APK. **No Flask, no Termux, no adb, no
port forwarding.**

## Install

```bash
adb install -r sandeshika-1.0.0-debug-<sha>.apk
```

Open it, go to **Setup**, paste your Medha token, set the address to match
Medha's port. Done.

No SMS permission is requested — see below.

## Why this replaces the Flask build

| | Flask + browser | This APK |
|---|---|---|
| Extra runtime | Python, on a laptop or Termux | none |
| Reaching Medha | `adb forward`, reverse proxy | direct, on-device |
| CORS | proxy required to avoid it | not applicable |
| Token location | server process | Android Keystore |
| Install | PWA, only on localhost/HTTPS | normal APK |
| Offline | service worker | assets are local |

The UI is the same code. `js/bridge.js` picks a transport at load time, so
`app.js` and `api.js` never branch on which host they are running under.

## Architecture

```
WebView  ──loads──▶  https://appassets.androidplatform.net/assets/web/
   │                 (WebViewAssetLoader — a real secure origin, no server)
   │
   └──JS bridge──▶  MedhaBridge.kt  ──HTTP──▶  Medha @ 127.0.0.1:8080
                    (holds the token)
```

**Why a native bridge rather than `fetch()` straight to Medha.** The WebView's
origin is `https://appassets.androidplatform.net`; Medha is
`http://127.0.0.1:8080`. That is cross-origin *and* mixed content, so the
request would be blocked twice over. Going through native sidesteps both and
keeps the token out of JavaScript — the same property the Flask proxy existed
to preserve.

**Threading.** `@JavascriptInterface` methods run on a WebView worker thread,
where anything slow stalls JS. Calls are therefore fire-and-forget: JS passes a
request id, native works on a coroutine, and the result arrives via
`window.__medhaResolve`. `bridge.js` wraps that back into a Promise, so callers
just `await`.

**The same allowlist** the Flask proxy enforced is enforced in
`MedhaBridge.request()`. Anything outside it returns 403 without a network call.

## Permissions

Only `INTERNET`, which Android requires even for `127.0.0.1`.

**`READ_SMS` is deliberately absent.** Sandeshika never touches the SMS provider
— it asks Medha, which holds that permission. So this APK does not trigger the
Play Protect block that SMS permissions cause; only Medha's `full` flavour does.

The token is stored in `EncryptedSharedPreferences` (Android Keystore), excluded
from cloud backup and device transfer. If the Keystore is unavailable — it
fails on a few OEM builds — it degrades to plain prefs inside the app sandbox
rather than becoming unusable.

## Medha setup

The `sandeshika` client needs **`store`** and **`sms.read`**. Add it in Medha →
**API clients**, tick **Read SMS** (off by default), and grant Medha itself the
Android SMS permission via **menu → SMS connector**. Sandeshika's Setup screen
checks all three and names whichever is missing.

## Build

Push to GitHub; the workflow produces `sandeshika-<version>-<type>-<sha>.apk`.
Set `SANDESHIKA_KEYSTORE_BASE64` and friends for a signed release build.

CI verifies the **bridge contract** before compiling: the JS calls
`AndroidMedha` methods by name, so a renamed `@JavascriptInterface` method would
fail only at runtime. R8 is off in release for the same reason.

## Tests

```bash
node tests/bridge.test.js     # 15 assertions
python3 tools/check_overrides.py app/src
```

`bridge.test.js` stands in for `MedhaBridge.kt` with a JS implementation of the
same contract and drives the **real** client through it — auth failures,
allowlist, a full 30-message import, exact rupee totals, idempotent re-run, and
that the token never becomes visible to the page.

## What is not verified

No Android SDK was available when this was written, so the APK has never been
compiled or run. Kotlin parses cleanly and every resource and asset reference
resolves, but `MedhaBridge` ↔ WebView has only been exercised through the JS
simulation. The first real run is where to look for surprises — most likely in
`WebViewAssetLoader` paths or `EncryptedSharedPreferences` on your device.
