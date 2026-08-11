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
Set the **Medha address** to match the port shown in the Medha app — the
default is `8080`, but if you changed it to `8001` put
`http://127.0.0.1:8001` here.

The token is validated before it is saved: a wrong port, an unreachable Medha
and a rejected token each produce a specific message rather than `HTTP 401`.
It is then stored **server-side** in `settings.json` (mode `0600`) and attached
to outgoing requests. The browser never receives it — only a masked preview
like `realto…cdef`.

`MEDHA_TOKEN` / `MEDHA_URL` in the environment still work and take precedence;
the Setup screen says so and disables the field rather than silently ignoring
what you type.

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

## Tests

```bash
node tests/parser.test.js        # 147 assertions — bank formats + every trap
node tests/pipeline.test.js      #  36 assertions — mock Medha, full backfill
PORT=5173 node tests/e2e_flask.js  # 21 assertions — real client, live Flask server
```

The e2e test drives the actual browser client against a running server:

```
inbox 295 SMS -> 179 transactions in 0.2s
kinds: {"expense":171,"transfer":4,"income":4}
duplicates 40 · rejected 76 · drift 0
```

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

## Layout

```
app.py                    Flask: static host + allowlisted proxy + settings + mock Medha
settings.json             saved token and Medha URL, mode 0600, gitignored
static/index.html         PWA shell
static/js/parser.js       deterministic SMS parser (no model)
static/js/api.js          Medha client, resumable ingest
static/js/app.js          analytics + UI (all arithmetic here)
static/sw.js              offline shell; never caches /api
tests/                    parser, pipeline, and live-server suites
```

Data lives in Medha's `/store` under this client's namespace, not IndexedDB —
browser storage is evictable and Android will drop it. Message bodies are never
copied; only parsed fields plus a short audit excerpt.
