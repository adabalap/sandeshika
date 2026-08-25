/**
 * Sandeshika — the type contract.
 *
 * Every shape that crosses a module boundary is declared here once. These are
 * JSDoc typedefs rather than TypeScript syntax on purpose: the browser loads
 * these files directly with no build step, which matters on a phone, while
 * `npm run typecheck` still gets a real compiler pass over every field.
 *
 * The rule this file exists to enforce: a transaction's `kind` decides whether
 * an amount is counted, and `categorySource` decides whether we are allowed to
 * overwrite it. Getting either wrong is silent and corrupts every total, so
 * both are typed as closed unions rather than loose strings.
 */

/**
 * A raw SMS as Medha's connector returns it.
 * @typedef {object} Sms
 * @property {number} id      Android's message id — stable, used for dedup during a scan.
 * @property {string} body
 * @property {number} date    Epoch milliseconds.
 * @property {string} address DLT sender header, e.g. "AX-HDFCBK".
 */

/**
 * What an amount does to the totals. Distinct from `direction`, which is only
 * which way the money moved.
 *
 * - `expense`  counts as spending
 * - `income`   counts as money in
 * - `refund`   a credit that offsets earlier spend, never income
 * - `transfer` between the user's own accounts — excluded from both
 * @typedef {'expense'|'income'|'refund'|'transfer'} Kind
 */

/** @typedef {'debit'|'credit'} Direction */

/**
 * Where a category came from, in precedence order. `user` outranks everything
 * and is never overwritten.
 * @typedef {'user'|'rule'|'sender'|'model'|'llm'|'guess'|'fallback'|'unresolved'} CategorySource
 */

/**
 * How the merchant name was obtained.
 * - `named`  read from the message body
 * - `sender` taken from the DLT sender header, when the body named nobody
 * - `phone`  paid to a phone number: person or shop is genuinely unknown
 * - `opaque` an unreadable UPI handle
 * @typedef {'named'|'sender'|'phone'|'opaque'} MerchantQuality
 */

/**
 * A parsed transaction. Written to Medha's store keyed by `fingerprint`.
 * @typedef {object} Txn
 * @property {number} smsId
 * @property {string} fingerprint      Primary identity: ref, or amount+day+account.
 * @property {string[]} [softKeys]     Secondary identities for cross-sender duplicates.
 * @property {string} [softKey]
 * @property {Direction} direction
 * @property {Kind} kind
 * @property {number} amount           Always positive; `direction` carries the sign.
 * @property {string} currency
 * @property {number|null} foreignAmount
 * @property {string|null} foreignCurrency
 * @property {string|null} account     Last four digits, if the message gave them.
 * @property {string|null} merchant
 * @property {MerchantQuality|null} merchantQuality
 * @property {string|null} ref
 * @property {string} channel
 * @property {number} date
 * @property {number|null} balance
 * @property {string|null} sender
 * @property {string} senderId
 * @property {string|null} bank
 * @property {string|null} category
 * @property {CategorySource|null} categorySource
 * @property {'user'|null} [kindSource] Set only when the user chose the kind by hand.
 * @property {number} confidence       0..1.
 * @property {boolean} needsReview     Excluded from totals until confirmed.
 * @property {boolean} [reviewed]
 * @property {boolean} [ambiguousP2P]
 * @property {string} [reviewReasonOverride]
 * @property {string} raw              First 300 chars of the message, for audit.
 */

/**
 * @typedef {object} ParseOk
 * @property {true} ok
 * @property {Txn} txn
 */

/**
 * @typedef {object} ParseFail
 * @property {false} ok
 * @property {string} reason  Names the rule that rejected it.
 */

/** @typedef {ParseOk|ParseFail} ParseResult */

/**
 * An obligation extracted from a bill reminder.
 * @typedef {object} Bill
 * @property {number} smsId
 * @property {string} fingerprint
 * @property {string} issuer
 * @property {string|null} account
 * @property {'credit-card'|'telecom'|'utility'|'loan'|'insurance'|'other'} kind
 * @property {number|null} amount
 * @property {number|null} minimumDue
 * @property {number|null} dueAt
 * @property {number} seenAt
 * @property {boolean} overdue
 * @property {'open'|'paid'|'dismissed'} status
 * @property {string} raw
 */

/**
 * @typedef {object} Classification
 * @property {'transactions'|'bills'|'updates'|'promotions'|'personal'|'spam'} tab
 * @property {string} subtype
 * @property {string} reason
 * @property {Txn} [txn]
 * @property {boolean} [sensitive] True for OTPs — the body must never be rendered.
 */

/**
 * @typedef {object} CategoryDecision
 * @property {string} category
 * @property {CategorySource} source
 * @property {string} [merchant]
 * @property {number} [at]
 * @property {string[]} [why]
 */

/**
 * Server configuration, from GET /config.json or the native bridge.
 * @typedef {object} AppConfig
 * @property {string} [app]
 * @property {string} [version]
 * @property {boolean} [mock]
 * @property {string} [medhaUrl]
 * @property {string} [defaultMedhaUrl]
 * @property {boolean} [tokenConfigured]
 * @property {string} [tokenPreview]
 * @property {'saved'|'env'|'none'} [tokenSource]
 * @property {'saved'|'env'|'default'} [urlSource]
 * @property {boolean} [envTokenPresent]
 * @property {boolean} [installable]
 */

/**
 * @typedef {object} DetectResult
 * @property {Array<{url: string, modelLoaded: boolean, tokenOk: boolean|null}>} found
 * @property {string} [current]
 * @property {number[]} [tried]
 */

/**
 * Counters from an ingest run. Every field is shown to the user, so each one
 * has to mean exactly what it says.
 * @typedef {object} IngestTotals
 * @property {number} parsed
 * @property {number} rejected
 * @property {number} duplicates
 * @property {number} written
 * @property {number} updated
 * @property {number} scanned
 * @property {number} pages
 * @property {number|null} [resumedFrom]
 * @property {boolean} [reprocess]
 * @property {DriftRow[]} [drift]
 * @property {boolean} [stopped]
 * @property {boolean} [complete]
 */

/**
 * A message from a registered financial sender that failed to parse — the
 * signal that a bank changed its template.
 * @typedef {object} DriftRow
 * @property {string} sender
 * @property {string} reason
 * @property {string} body
 * @property {string} [subtype] What the organizer made of it, when it saw anything.
 * @property {number} [count]
 */

/**
 * @typedef {object} PeriodSummary
 * @property {number} spent
 * @property {number} gross
 * @property {number} refunded
 * @property {number} received
 * @property {number} transferred
 * @property {number} net
 * @property {number} count
 * @property {Array<[string, number]>} byCat
 * @property {Array<{name: string, total: number, count: number, category: string|null}>} merchants
 * @property {Record<string, number>} byDay
 * @property {Txn|null} largest
 */

export {};
