# సందేశిక · Sandeshika

On-device SMS intelligence for India. Native Android, Compose M3, backed by
[Medha](https://github.com/adabalap/medha) for inference over loopback.

**Status: P0 scaffold.** Ingestion, sanitisation, template mining, encrypted
storage and FTS. No AI yet — that is deliberate (see *Phases*).

---

## What this is

Not an SMS folder app. The thesis is that messages are telemetry about
long-lived things — a bill, an order, an invite — and those things have
*states*. "Bill due / paid / overdue" is one entity in three states, not three
categories of message.

```
MESSAGE → EVENT → ENTITY → STATE → OBLIGATION → NARRATIVE
```

---

## Setup

### 1. Configure

```bash
cp .env.example .env
$EDITOR .env          # MEDHA_PORT must match the port shown in the Medha app
```

`.env` is gitignored. `.env.example` is the committed default of record.
Precedence, highest first:

1. **Runtime** — the Settings screen (DataStore)
2. **Process env** — `SANDESHIKA_MEDHA_PORT=9000 ./gradlew assembleDebug`
3. **`.env`**
4. **`.env.example`**

Anything a user might change *after* install (ports, retention, biometric) is
also editable in-app. Build-time-only config would mean "recompile to change a
port", which is not a real product.

### 2. Pair with Medha

In the Medha app, create a client:

```
id            sandeshika
namespace     sms
capabilities  generate, rag, store
```

Note it does **not** get `sms.read`. Sandeshika reads SMS itself, so a leaked
Medha token cannot be used to read messages. Paste the token into `.env`
(`MEDHA_TOKEN`) or leave it blank and let the app prompt — it is then stored in
EncryptedSharedPreferences, not on disk in plaintext.

Install the **`core`** Medha build. Sandeshika does not need Medha's SMS
connector, and `core` installs without a Play Protect block.

### 3. Build and install

```bash
./gradlew :app:testDebugUnitTest     # golden corpus — run this first
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

**Use `adb install`, not the file manager.** Sandeshika declares `READ_SMS`, so
Play Protect hard-blocks the sideload with an OK-only dialog. Installing through
the shell never shows it, and nothing stays weakened.

Then grant the runtime permission in-app and tap **Run backfill now**.

---

## Privacy posture

- **No `INTERNET` permission.** At all. Loopback to Medha does not need one.
  Verify it yourself in Settings → Apps → Sandeshika → Permissions. That is a
  stronger claim than any privacy policy.
- **Database is SQLCipher-encrypted**, with the passphrase generated on device
  and held in the Android Keystore. It is never in the APK or in `.env`.
- **Auth OTP bodies are purged** after `OTP_RETENTION_HOURS`. The row survives
  so dedup stays correct; the body does not. Delivery OTPs are exempt — they
  belong to an order and stay useful.
- **Backup and device-transfer are excluded**, or a cloud backup would silently
  undo all of the above.
- `RECEIVE_SMS` is **not** declared. It is the permission Play Protect treats
  most harshly, and a ContentObserver plus periodic sweep covers the same ground.

Storing message bodies is a real trust cost, paid deliberately: FTS, re-parsing
and audit are impossible without them. Medha, by contrast, never copies bodies —
different job, different posture.

---

## Architecture notes worth knowing before you edit

**Paging is by timestamp, never offset.** A backfill over 40,000 messages takes
many pages; one message arriving mid-scan shifts every offset, silently
duplicating one message and skipping another.

**Amount parsing handles Indian lakh grouping.** `[\d,]+` reads
`Rs.1,23,456.78` as `1.23` — no error, just a money app that is confidently
wrong. See `SanitizerTest`.

**Mask order is load-bearing.** Amounts must be masked before generic digits,
or `2,340` becomes three number tokens and one bank template fingerprints
differently per amount.

**The miner learns slots, it is not told them.** Bucket on sender + prefix,
score by sequence similarity, merge by LCS alignment collapsing differing spans
to `<VAR>`. A stoplist of "words that are really merchants" never stops needing
curation and is wrong for every bank nobody has read yet. Two examples teach the
slot, in any language.

**Medha is a scarce resource, not a service.** One engine, one mutex. Its
`InferenceScheduler` already does priority, thermal hysteresis, battery gating
and a bounded queue. Do not reimplement any of it — send
`X-Medha-Priority: batch` for backlog work and honour `429` as backpressure,
never as an error.

**Degraded mode is a feature.** With Medha offline, ingestion, search, the
ledger and reminders all keep working. Only insights pause. The Money screen
must never depend on Medha — it is pure SQL.

---

## Verifying the pattern logic without a device

`tools/` holds the Python harnesses used to validate the regexes and the miner
against a real corpus before any Kotlin was written:

```bash
python3 tools/validate_patterns.py   # amount / account / OTP / DLT extraction
python3 tools/validate_miner2.py     # template collapse, variable-length slots
python3 tools/verify_lcs_port.py     # proves the Kotlin LCS port matches
```

The Kotlin equivalents live in `app/src/test/` and run in milliseconds. Add a
case there before fixing anything in the template bank.

---

## Phases

| | Scope | Status |
|---|---|---|
| **P0** | Ingest, SQLCipher, DLT normalisation, fingerprinting, template mining, FTS | **this scaffold** |
| P1 | Seed regex for top 40 senders, events, postings, accounts, rollups | next |
| P2 | Money screen | |
| P3 | Balance assertions, reconciliation, recurring detection | |
| P4 | Correlation keys, entities, BILL + ORDER state machines | |
| P5 | Obligations, notification actions, Actions screen | |
| P6 | Medha enrichment, template induction, review queue | |
| P7 | Embeddings, hybrid search, memory cards | |
| P8 | Insights, journal, forecast | |
| P9 | Biometric, export, wipe, eval harness, release signing | |

Medha does not enter until P6 — which is both the right risk order and the
proof that degraded mode works, because you will have lived in it for weeks.

---

## Known gaps in this scaffold

- **Never compiled.** Written without an Android SDK available; expect import
  and API-surface fixes on first sync. The pure logic (Sanitizer, TemplateMiner)
  is validated by the Python harnesses and the unit tests.
- Launcher icon and Compose theme are placeholders.
- `TemplateRow.senderNorm` is written as null by the worker; the miner keys
  buckets by sender internally but does not yet surface it on the template.
- No Room migration exists yet because there is only v1. The first schema bump
  needs a hand-written migration and an instrumented test — destructive
  migration is deliberately not configured.
