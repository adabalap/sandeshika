# Sandeshika · సందేశిక

*sandeśikā* — "messenger". Private insights from the SMS already on your phone:
spending, bills and highlights. Installable PWA, served by a small Flask app,
powered by **Medha** running on-device.

Nothing leaves the device. No cloud, no account. Works in airplane mode.

---

## Run it

**Demo — no phone needed.** Generates a realistic 120-day Indian inbox and a
mock model, so every screen is populated and the arithmetic is real:

```bash
./run.sh mock          # then open http://localhost:5000
```

**Against your phone:**

```bash
./run.sh               # sets up adb forwarding, then serves on :5000
```

Open **http://localhost:5000**, go to **Setup**, and paste your Medha token.

The `sandeshika` client needs two capabilities: **`store`** (to keep parsed
transactions) and **`sms.read`** (to read messages). When adding the client,
tick **Read SMS** — it is deliberately off by default, since most consumers
should not have it. To change it later: Medha → **API clients** → **Edit
permissions**.

Setup checks the whole chain and reports each link separately, because each has
a different remedy:

| Symptom | Fix |
|---|---|
| `no SMS connector in this build` | install the **full** APK, not `core` |
| `Medha lacks Android's SMS permission` | Medha → menu → SMS connector → Grant |
| `client … lacks capability 'sms.read'` | Medha → API clients → Edit permissions |

Set the **Medha address** to match the port shown in the Medha app — the
default is `8080`, but if you changed it to `8001` put
`http://127.0.0.1:8001` here.

The token is validated before it is saved: a wrong port, an unreachable Medha
and a rejected token each produce a specific message rather than `HTTP 401`.
It is then stored **server-side** in `settings.json` (mode `0600`) and attached
to outgoing requests. The browser never receives it — only a masked preview
like `realto…cdef`.

### Precedence: what you save in Setup wins

`MEDHA_TOKEN` / `MEDHA_URL` still work for launching, but **anything saved from
the Setup screen overrides them**, and the field is never disabled.

The reverse was tried first and was wrong: `run.sh` exported `MEDHA_TOKEN`, the
server treated the field as locked, and anyone whose exported token was stale
had no way to fix it from the only screen that offers to. Whoever is in front of
the app is acting later and more deliberately than whatever was exported at
launch, so they win. Setup shows which source is active, and **Forget saved
settings** drops the override and falls back to the environment.

`run.sh` no longer requires a token at all — start it, then paste in Setup.
`MEDHA_PORT=8001 ./run.sh` forwards and targets a non-default Medha port.

Then use the browser's *Install app* option to add it to your home screen.

---

## Why Flask, given the PWA has no backend

The Flask server does exactly two things, and the second is not optional.

**1. Serves the PWA** with the headers a browser requires before it will offer
to install: a `manifest.webmanifest` with the right MIME type, and `sw.js`
served from the **root** path — a service worker can only control pages at or
below its own URL, so one served from `/static/sw.js` could never control `/`.

**2. Reverse-proxies `/api/*` to Medha.** Without this the app cannot work at
all:

- **CORS.** Medha allows only its own loopback origins. A page served from
  `:5000` is a different origin, so the browser would issue requests and then
  refuse to let the page read any reply.
- **The token.** Proxying keeps the credential in the server process. A direct
  browser call would mean putting it in `localStorage`, where any script on the
  page can read it. **The browser never sees the token.**

The proxy enforces an **endpoint allowlist**. An open proxy would let any script
on the page drive the whole of Medha, including other clients' namespaces and
the admin surface. `/api/v1/models`, `/api/admin/*` and anything else unlisted
return `403`.

> Flask runs on your **laptop**, not as a second service on the phone. Medha is
> the backend; this is a static host with one piece of necessary plumbing.

### Installability

Browsers only offer *Install app* on `localhost` or HTTPS. Over a LAN IP
(`http://192.168.x.x:5000`) the app runs but **cannot be installed**. `run.sh`
sets up `adb reverse` so the phone reaches it as `localhost` and installation
works. `/config.json` reports `installable` so the UI can say so honestly.

---

## Accuracy: the rule that makes this real

**The model never parses and never does arithmetic.**

| Job | Done by | Why |
|---|---|---|
| Amount, date, merchant, reference | regex | deterministic, instant, testable |
| Unknown merchant → category | model, cached forever | genuinely fuzzy, once per merchant |
| Every figure on screen | JavaScript | a model that invents a plausible rupee number looks exactly like one that is right |
| Phrasing an answer | model, given pre-computed figures | grounded, and the figures are shown |

### Indian-market traps, and how each is handled

| Trap | Handling |
|---|---|
| **Credit-card bill paid from savings** | `kind: transfer`. The card purchases were already counted; booking the bill too double-counts the whole statement. |
| **Refunds / reversals** | `kind: refund`, subtracted from spend, never counted as income. |
| **Failed / declined** | Rejected. *"will be reversed"* is a promise, not money. |
| **Pre-auth holds** (fuel, hotels) | Rejected — they settle later at a different amount. |
| **Balance / credit-limit collision** | `"Spent Rs.500 … Avbl Credit Limit Rs.45,000"` takes 500. A pure limit advisory is rejected. |
| **Multi-SMS double counting** | Reference number, plus a soft key of amount+direction in a 10-minute bucket that catches bank/UPI-app/merchant copies sharing no account tail. |
| **TRAI DLT sender IDs** | Operator prefix stripped: `AX-HDFCBK` and `VM-HDFCBK` are one bank. |
| **Unannounced template changes** | Messages from a registered bank sender that fail to parse surface as **template drift**, with a copy button. Visible, not silently dropped. |
| **Cryptic VPAs** (`q398457239@ybl`) | Detected as opaque, sent to review. Never shown as a merchant, never sent to the model to be confidently mislabelled. |
| **Aggregator prefixes** | `RAZORPAY*SOMESHOP` → `SOMESHOP`. |
| **P2P vs P2M** | A phone-number VPA is genuinely ambiguous, so it is asked about rather than silently bucketed. |
| **Foreign currency** | Captured with its currency, excluded from INR totals, flagged. No offline rate exists; a wrong conversion is worse than a known unknown. |
| **Number anomalies** | `Rs 500/-`, `INR 100000`, `Rs. 1,00,000.00`, `Rs.500debited`. |

Analytics sum by `kind` (`expense` / `income` / `refund` / `transfer`), **never
by `direction`**. A credit-card bill is a debit but not expenditure; a refund is
a credit but not income. Summing by direction is the easiest way to make every
figure on the screen wrong.

### DPDP Act

Parsing happens entirely on-device and no SMS content is transmitted, which is
what the Act's PII provisions point at. There is no server to breach.

### Play Store

`READ_SMS` is restricted — publishing would require being the default SMS
handler or a personal-finance exemption with a privacy audit. This is built for
sideloading, which is why Medha's `full` flavour exists and the `core` build
stays clean of the permission.

---

## Upgrading

Extracting a release over a working tree adds and overwrites but **never
deletes**, so a file removed upstream survives locally and fails with an error
about its contents rather than about no longer belonging.

`MANIFEST.txt` ships with the release and lists every file in it, which is what
lets the upgrade express a deletion:

```bash
unzip -o sandeshika-v2.1.0.zip
npm run prune          # lists leftovers — dry run, changes nothing
npm run prune:apply    # removes them (git rm when tracked)
npm test
```

CI fails if leftovers are present or if the manifest is stale. See
[UPGRADING.md](UPGRADING.md).

## Tests

```bash
npm run check                 # lint + typecheck + all JS suites (what CI runs)
npm test                      # 832 assertions across 13 suites
python3 tests/server_test.py  # 34 assertions — proxy, limiter, headers
python3 tools/redact.py --selftest
```

```
✓ analytics · parser · organizer · model · transport · learning
✓ pipeline · realcorpus · shell · boot · e2e · provenance · redact
13 suites · 832 passed · 0 failed        (+ 40 Python)
```

Each suite is a plain script that counts assertions and exits non-zero, so any
one runs on its own with `node tests/parser.test.js` — no framework, no install,
which matters when the development machine is a phone in Termux.

Four of these check things no unit test can see:

- **`shell.test.js`** walks the real import graph from `main.js` and fails if a
  module is orphaned, an import does not resolve, the service worker's cache
  list has drifted, the version constants in `package.json` / `main.js` /
  `sw.js` / `app.py` disagree, or **the UI writes to an element id that
  `index.html` does not contain**.
- **`boot.test.js`** loads the real `index.html` into jsdom, points the app at a
  mock Medha, imports the real entry point, runs an import, and reads the
  rendered figures back off the DOM. It also asserts that **what reaches the
  clipboard is redacted even while the panel is showing the original**.
- **`redact.test.js`** takes real bank SMS shapes and asserts specific values
  are gone and specific structure survives.
- **`provenance.test.js`** holds a floor on how much of each message can be
  traced, so a bank format change cannot quietly switch the feature off.
- **`e2e.test.js`** starts `app.py` itself, drives the real ingest pipeline over
  HTTP through the real proxy, and checks the totals that come out. It skips
  loudly (exit 0) when the Python deps are absent rather than failing a JS run
  where nothing is broken.

`shell.test.js` also scans **every** file in `tests/` for `require()`,
`module.exports` and `__dirname`. `package.json` sets `"type": "module"`, which
retroactively makes every `.js` in the repository an ES module — including test
files nothing imports, which the module-graph walk cannot see. A stray
`require()` there is a crash at import time, not a failed assertion: the suite
never runs at all.

---

## Sharing an unrecognised message safely

When a bank changes a template, the messages that failed to parse appear under
**Unrecognised messages from your bank**. They are only useful if you can send
them to someone — and only safe to send if your name, account tail and payee are
not in them.

The panel therefore **defaults to a redacted view**, and the copy button always
emits the redacted report regardless of which view is on screen. That is
deliberate: one stray tap should never be the difference between a bug report
and a disclosure, and `boot.test.js` asserts it by switching to the original,
copying, and checking the clipboard is still clean.

| Replaced | Kept, because the parser author needs it |
|---|---|
| amounts, account tails, payee names | bank codes (`HDFCBK`), PSP handles (`@ybl`) |
| phone numbers, emails, OTP codes | keywords, separators, punctuation, digit counts |
| references, PAN, Aadhaar, IFSC, cards | the rejection reason and how often it was seen |
| UPI identities, URL paths | whether a link was present at all |

**Dates are shifted, not blanked.** A constant per-session offset keeps the
format, the ordering and the gaps between messages intact while making the
calendar wrong — blanking to `99/99/99` would destroy the one thing a date-parsing
bug report needs. Pseudonyms are stable within a report (`PERSON_a3f1`), salted
per session, never stored, so grouping still works and nothing is reversible.

The output is re-scanned by `verify()` before it is offered, and the header says
what was done so whoever receives it does not have to guess. The panel still
tells you to read it: no regex recognises every name.

`tools/redact.py` does the same job offline for bulk corpus files, and its
self-test runs in CI so the two cannot drift apart.

## Provenance: every figure traceable to its message

The transaction screen shows the original SMS with the amount, date, account,
merchant and reference **highlighted where they were read from**.

This is the app's central claim made checkable. "₹450, food, Swiggy" asks to be
believed; the same figure with the exact characters it came from marked
underneath can be verified at a glance, and a mis-parse becomes obvious rather
than merely wrong. If a field cannot be located in the text, the screen says so
instead of implying the number is confirmed.

## Running it for real

```bash
./run.sh                      # waitress, adb forwarding, port 5000
SANDESHIKA_LOG=DEBUG ./run.sh # verbose
python3 app.py --threads 16   # only if a backfill is queueing
```

The server runs under **waitress**, not Flask's development server. It logs one
structured line per request with a timing and a request id, and echoes that id
in `X-Request-Id` so a browser console, this log and a Medha-side log can be
lined up for a single user action.

| Hardening | Why |
|---|---|
| Pooled `requests.Session` | a backfill issues hundreds of calls; over adb the TCP handshake was the dominant cost |
| Locked config snapshot | saving a token mid-backfill could hand out the old URL with the new token — a 401 that makes no sense to anyone |
| CSP with no third-party origin | the app loads nothing external; a future dependency has to be a deliberate edit |
| Rate limits on `/settings`, `/detect` | both are unauthenticated by necessity; this stops a runaway page hammering the phone |
| JSON error handlers | the client parses every failure as JSON, so an HTML error page surfaced as an unreadable parse failure |
| `/healthz` that ignores Medha | a check failing because the phone is unplugged would have systemd restarting a healthy server |
| Request deadlines client-side | a request that never returns leaves the button disabled and the spinner spinning forever |

`--debug` still exists and warns loudly; it is never the default.

## Bugs the tests caught

Each produces a confident, plausible, wrong number — invisible in a demo.

- **`Rs.5000` parsed as ₹500.** The alternation matched `\d{1,3}` and stopped,
  truncating every un-grouped 4+ digit amount. Rent and salary off by 10×.
- **`Rs.-500` parsed as +₹500.**
- **A failed payment booked as spend.** The refund exemption was too broad, so
  *"will be reversed due to insufficient balance"* slipped past the filter.
- **Messages lost at tied timestamps.** The cursor advanced to exactly the
  page minimum while the server filters `date < before`, so everything else at
  that instant was skipped. Bank and UPI-app copies routinely share a
  millisecond.
- **A phone-number VPA became `"XX1234 to 9876543210"`** — the all-digits guard
  discarded the correct handle, letting a worse pattern win.
- **Balance alerts flooded the drift signal.** Moving direction detection ahead
  of the reject pass made them exit as `no-direction`, so 30 routine SMS looked
  like broken bank templates. Rejects now run in two passes.

### Found during the 2.0 restructure

- **`Transport` was never defined.** `app.js` referenced it in twelve places —
  configuration, save, clear, detect, and the whole diagnostics screen — and no
  file, inline script or injected global ever provided it. Every one of those
  calls threw `ReferenceError`. Because `boot()` wrapped `checkConnection()` in
  a `try/catch`, the error was swallowed and the app dropped the user on Setup
  with a misleading message **on every launch**, however healthy Medha was. It
  now exists as a real module with both transports tested.
- **The coverage panel overstated deterministic parsing.** "Categorised by
  rule" was computed as `total − llm − guessed − uncategorised`, which folded
  `sender` and `model` answers into "rule", double-subtracted rows that were
  both model-labelled and left as `other`, and could go negative. Exactly the
  panel that would hide a parser quietly degrading. Buckets are now counted
  directly, are mutually exclusive, and are asserted to sum to the total.
- **The seven-day strip dropped empty days.** Only days with transactions were
  listed, so a quiet Sunday vanished and the surrounding rows read as
  consecutive — an interrupted import looked like a frugal week.
- **`catchUp()` returned a bare zero** when no watermark existed, which is
  indistinguishable from "you are up to date". A never-imported inbox reported
  itself as current. It now returns `needsBackfill`.
- **An undefined soft key could enter the dedup set**, after which every
  keyless transaction matched the first one as a duplicate.

### Found during the 2.1 hardening pass

- **OTP codes survived redaction entirely.** Every high-risk identifier was
  covered except the one that is literally a credential. A drift report is
  pasted into issue trackers that outlive the code's validity.
- **A payee name leaked as `vide Mr Gadipudi Khadri`.** Every name rule was
  anchored to a preposition — "To", "from", "Dear" — so an unfamiliar connector
  walked straight past all of them. Now anchored to the title as well.
- **Provenance never highlighted the amount.** Two separate causes: the word
  boundary rejected `Rs.450` because of the full stop in the currency marker,
  and building the search form with `Math.round` turned `145678.90` into
  `1,45,679.90`, which appears nowhere in the message. Silent, and it defeated
  the entire feature on any transaction with paise.
- **`tools/bump_version.py` still pointed at `static/js/app.js`**, deleted in
  the 2.0 restructure, and did not know `package.json` existed. It printed a
  warning nobody reads and left the build half-bumped. It now exits non-zero.
- **The type checker found a broken discriminated union.** `parse()` returns
  `{ok: true, ...} | {ok: false, ...}`, but an object literal widens `true` to
  `boolean`, so the union never narrowed for callers and the contract was
  decorative until it was pinned in JSDoc.
- **`strictNullChecks` found `[txn.softKey]` could put `undefined` into the
  dedup set**, after which every keyless transaction matched the first.

## The Android wrapper

The APK exists so the app runs on the phone with no laptop and no Flask server.
It is a WebView hosting the *same* `static/` directory the browser build serves
— copied into assets by Gradle at build time, never duplicated into the Android
project, because two copies of a front end drift apart within a week and the
divergence only shows up as a bug that reproduces on the phone and nowhere else.

**The Android project and the web app share one repository root.** That is a
requirement, not a preference: `app/build.gradle.kts` reads `../static`, and
fails with an explanatory message if it is not there.

```
settings.gradle.kts  app/  gradlew  gradle/     ← Android
static/  app.py  tests/  tools/                 ← the web app
```

```bash
./gradlew assembleFullRelease     # the build that reads an inbox
./gradlew assembleCoreRelease     # no SMS features; installs anywhere
```

**Sandeshika never holds `READ_SMS`.** It asks Medha for messages over
loopback, and Medha is the app that holds the permission and shows the user
what it does with it. `INTERNET` is the only permission declared, and
`server_test.py` parses the manifest to keep it that way.

| Decision | Why |
|---|---|
| `WebViewAssetLoader` over `file://` | a `file://` page is an opaque origin — no service worker, no secure context — and the usual workaround hands page script the device filesystem |
| Async bridge methods | a `@JavascriptInterface` call blocks the JS thread; a cold model load takes minutes, so a synchronous bridge would freeze the UI and end in an ANR |
| Token in `EncryptedSharedPreferences` | it is a bearer credential for an API that can read every SMS; the page never sees it, and the page renders SMS-derived text |
| Allowlist enforced in Kotlin | there is no Flask proxy inside the APK to enforce it, and without it the bridge is an open proxy onto Medha |
| Cleartext limited to loopback | Medha is plain HTTP on 127.0.0.1; everything else is denied outright |
| Backups disabled | a financial history and that token do not belong in a cloud backup |
| ProGuard keeps the bridge | R8 sees no Kotlin callers, strips the methods, and only the *release* build breaks |

## Layout

```
settings.gradle.kts         Android — shares the repository root with the web app
app/                        WebView host, bridge, encrypted settings
gradlew  gradle/            Gradle 8.7 wrapper

app.py                      waitress host + allowlisted proxy + settings + mock Medha
settings.json               saved token and Medha URL, mode 0600, gitignored
package.json                scripts: check / test / lint / typecheck
tsconfig.json               checkJs + strictNullChecks over static/js — no build step
eslint.config.js            pyproject.toml (ruff)
.github/workflows/ci.yml    JS lint+types+12 suites · Python tests · live boot check

static/index.html           PWA shell; one module entry point
static/app.css              token system, real dark mode, tabular money figures
static/sw.js                offline shell; caches the whole module graph, never /api

static/js/main.js           entry: subscribe views, bind events, boot

static/js/core/             pure, no DOM and no network — the testable half
  types.js                    JSDoc contract; Kind and CategorySource are closed unions
  format.js                   rupees, Indian grouping, local day keys, escaping
  analytics.js                every figure on screen is computed here
  parser.js                   deterministic SMS parser (no model)
  organizer.js                inbox classification + bill extraction
  model.js                    on-device Naive Bayes, abstains rather than guessing
  provenance.js               locates each parsed field inside the original message
  redact.js                   strips PII before a message can be shared

static/js/data/             network and persistence
  transport.js                Flask proxy or Android bridge, behind one interface
  client.js                   errors, cursors, key-value store
  categories.js               the resolution ladder and user corrections
  ingest.js                   resumable, idempotent backfill

static/js/ui/
  state.js                    one store; views read it, actions change it
  actions.js                  every user-initiated operation
  dom.js  theme.js  errors.js  components.js
  views/                      overview, dashboard, daily, detail, transactions,
                              bills, inbox, ask, setup

tests/                      13 JS suites (832) + server_test.py (40)
tools/redact.py             the same redaction, offline, for bulk corpus files
tools/bump_version.py       moves all five version constants together
tools/prune_stale.py        removes files an upgrade could not delete
tools/make_manifest.py      regenerates MANIFEST.txt
MANIFEST.txt                every file in this release
```

Data lives in Medha's `/store` under this client's namespace, not IndexedDB —
browser storage is evictable and Android will drop it. Message bodies are never
copied; only parsed fields plus a short audit excerpt.

### Why ES modules and no bundler

The browser loads these files directly. There is no build step, which is what
makes the app editable from the device it runs on. `npm run typecheck` gives the
compiler pass that would otherwise never happen — `tsconfig.json` sets `checkJs`
with `strictNullChecks`, and the types are JSDoc, so nothing has to be compiled
before it can run.

The 1.x version was five `<script>` tags whose correctness depended on load order
and on each file hanging itself off `window`. Reordering them would have broken
the app silently, and `shell.test.js` now fails if anything reintroduces a
`window.Sandeshika*` global or stashes state on `window.__*`.

### Design notes

The indigo is unchanged. This is an evolution of an app already installed on
people's phones, not a rebrand, so the effort went into craft rather than
novelty: tabular numerals everywhere money appears, so columns align and a live
total does not jitter as it updates; a real dark theme rather than an inversion,
with surfaces chosen so the category hues stay distinguishable, because in the
charts those hues carry meaning; toasts that stack instead of one banner that
overwrote itself; skeletons shaped like the rows that are coming.

The one place boldness is spent is the provenance highlight — tint plus an
underline in the same hue, so the marks survive being printed, screenshotted or
read by someone who cannot distinguish the colours.
