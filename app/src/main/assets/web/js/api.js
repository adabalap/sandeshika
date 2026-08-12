/*
 * Sandeshika — Medha client and ingest pipeline.
 *
 * Correctness properties this file is responsible for:
 *
 *  - RESUMABLE. The user will close the tab mid-backfill. Every unit of work
 *    checks /store before spending inference, so a re-run costs nothing for
 *    anything already done.
 *  - IDEMPOTENT. Transactions are keyed by fingerprint, so the same payment
 *    arriving twice (bank alert + card alert) is stored once.
 *  - BOUNDED. All bulk work is submitted at batch priority so Medha's thermal
 *    and battery gating applies. 429 is honoured, never hammered.
 *  - AUDITABLE. Every stored transaction keeps the raw SMS text and the source
 *    of its category, so a wrong number can always be traced back.
 */

/*
 * All calls go to this app's own origin under /api, which the Flask server
 * proxies to Medha.
 *
 * Two reasons it is not a direct call to 127.0.0.1:8080:
 *  - CORS. Medha permits only its own loopback origins, so a page served from
 *    :5000 could issue the request but never read the reply.
 *  - The token. Proxying keeps it in the server process; a direct call would
 *    require putting a credential in localStorage where any script can read it.
 */
const MEDHA = '/api';

const K = {
  cursor: 'sandeshika.cursor',     // oldest SMS date processed so far
  watermark: 'sandeshika.high',    // newest SMS date processed so far
};

const Store = {
  cursor: () => Number(localStorage.getItem(K.cursor) || 0) || null,
  setCursor: (v) => localStorage.setItem(K.cursor, String(v)),
  watermark: () => Number(localStorage.getItem(K.watermark) || 0),
  setWatermark: (v) => localStorage.setItem(K.watermark, String(v)),
  reset: () => { localStorage.removeItem(K.cursor); localStorage.removeItem(K.watermark); },
};

class ApiError extends Error {
  constructor(msg, status, retryAfter) {
    super(msg);
    this.status = status;
    this.retryAfter = retryAfter || 0;
  }
}

async function api(path, opts = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  // No Authorization header: the server attaches it.

  let r;
  try {
    // Transport picks the native bridge (APK) or the Flask proxy (browser).
    // Either way the token is attached outside JS.
    r = await Transport.api(path, { ...opts, headers });
  } catch (e) {
    throw new ApiError(e.message || 'Cannot reach Medha.', 0, 0);
  }
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch (_) {}
    throw new ApiError(msg, r.status, Number(r.headers.get('Retry-After') || 0));
  }
  if (r.status === 204) return null;
  return r.json();
}

/**
 * Batch-priority call with backoff. 429 means Medha is thermally gated or its
 * queue is full; the only correct response is to wait exactly as long as it
 * asked and try again.
 */
async function batchCall(path, body, onWait) {
  for (let i = 0; i < 6; i++) {
    try {
      return await api(path, {
        method: 'POST',
        headers: { 'X-Medha-Priority': 'batch' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.status !== 429) throw e;
      const wait = e.retryAfter || 5;
      if (onWait) onWait(e.message, wait);
      await sleep(wait * 1000);
    }
  }
  throw new ApiError('Medha stayed busy after 6 attempts', 429, 30);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Persistence — everything lives in Medha's /store, never in IndexedDB.
// Browser storage is evictable; Android drops it under memory pressure, and a
// financial history that silently disappears is worse than no app at all.
// ---------------------------------------------------------------------------
const Keys = {
  txn: (fp) => `txn/${fp}`,
  cat: (mk) => `cat/${mk}`,
  meta: (k) => `meta/${k}`,
};

async function putMany(items) {
  if (!items.length) return 0;
  const out = await api('/store/bulk', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
  return out.written;
}

async function listPrefix(prefix, limit = 1000) {
  const all = [];
  let offset = 0;
  for (;;) {
    const page = await api(`/store?prefix=${encodeURIComponent(prefix)}&limit=500&offset=${offset}`);
    all.push(...page.items);
    if (page.items.length < 500 || all.length >= limit) break;
    offset += 500;
  }
  return all;
}

async function loadTransactions() {
  const rows = await listPrefix('txn/', 100000);
  return rows.map((r) => {
    try { return JSON.parse(r.value); } catch (_) { return null; }
  }).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Category resolution: rules -> cache -> LLM -> cache write.
//
// A merchant costs inference exactly once, ever. On a real inbox the same
// twenty merchants account for most transactions, so this is the difference
// between a backfill that takes minutes and one that takes an hour.
// ---------------------------------------------------------------------------
const catCache = new Map();

async function primeCategoryCache() {
  const rows = await listPrefix('cat/', 5000);
  for (const r of rows) {
    const key = r.key.replace(/^cat\//, '');
    try { catCache.set(key, JSON.parse(r.value)); } catch (_) {}
  }
  return catCache.size;
}

const CATEGORY_PROMPT = (merchant) =>
  `Classify this Indian merchant into exactly one category.
Merchant: "${merchant}"
Categories: ${SandeshikaParser.CATEGORIES.join(', ')}
Answer with one word from the list and nothing else.`;

async function resolveCategory(merchant, direction, onWait) {
  const rule = SandeshikaParser.categorise(merchant, direction);
  if (rule) return rule;

  const mk = SandeshikaParser.merchantKey(merchant);
  if (!mk) return { category: 'other', source: 'rule' };
  if (catCache.has(mk)) return catCache.get(mk);

  let category = 'other', source = 'llm';
  try {
    const r = await batchCall('/generate', {
      system: 'You are a strict classifier. Reply with exactly one word.',
      prompt: CATEGORY_PROMPT(merchant),
    }, onWait);
    const word = String(r.text || '').toLowerCase().replace(/[^a-z]/g, '');
    // Never trust the model's output shape. An unrecognised answer becomes
    // "other" rather than creating a phantom category in the totals.
    category = SandeshikaParser.CATEGORIES.includes(word) ? word : 'other';
  } catch (e) {
    if (e.status === 503 || e.status === 0) throw e; // service down: stop the run
    source = 'fallback';
  }

  const val = { category, source };
  catCache.set(mk, val);
  await api(`/store/${Keys.cat(mk)}`, { method: 'PUT', body: JSON.stringify(val) })
    .catch(() => {});
  return val;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

/**
 * Processes one page of SMS into stored transactions.
 * Returns per-page counters so the UI can show honest progress.
 */
async function ingestPage(messages, known, soft, onWait, drift) {
  const toWrite = [];
  let parsed = 0, rejected = 0, duplicates = 0;

  for (const m of messages) {
    const r = SandeshikaParser.parse(m);
    if (!r.ok) {
      rejected++;
      // TEMPLATE DRIFT SIGNAL: a message from a registered bank sender that we
      // could not parse probably means the bank changed its format. Ordinary
      // noise (OTPs, promos) is expected and not counted here.
      if (drift && SandeshikaParser.isFinancialSender(m.address) &&
          !SandeshikaParser.EXPECTED_NOISE.includes(r.reason)) {
        drift.push({ sender: m.address, reason: r.reason, body: String(m.body).slice(0, 160) });
      }
      continue;
    }
    parsed++;

    // Primary key: reference number, or amount+day+account.
    if (known.has(r.txn.fingerprint)) { duplicates++; continue; }
    // Secondary key: one payment can produce a bank SMS, a UPI-app SMS and a
    // merchant SMS, none sharing an account tail or a reference. Amount +
    // direction inside a 10-minute bucket catches those cross-sender copies.
    if (soft.has(r.txn.softKey)) { duplicates++; continue; }
    known.add(r.txn.fingerprint);
    soft.add(r.txn.softKey);

    if (r.txn.kind === 'transfer') {
      r.txn.category = 'transfer';
      r.txn.categorySource = 'rule';
    } else if (r.txn.merchantQuality && r.txn.merchantQuality !== 'named') {
      // No point asking a model to categorise "q398457239"; it will invent
      // something confident and wrong. It goes to the review queue instead.
      r.txn.category = 'other';
      r.txn.categorySource = 'unresolved';
    } else {
      const cat = await resolveCategory(r.txn.merchant, r.txn.direction, onWait);
      r.txn.category = cat.category;
      r.txn.categorySource = cat.source;
      // A heuristic guess (e.g. "this looks like a person, so a transfer")
      // changes whether the amount counts as spending. That is too big an
      // effect to apply silently, so it goes to the review queue.
      if (cat.source === 'guess') {
        r.txn.kind = 'transfer';
        r.txn.needsReview = true;
        r.txn.reviewReasonOverride = 'paid to what looks like a person — spend or transfer?';
      }
    }

    toWrite.push({ key: Keys.txn(r.txn.fingerprint), value: JSON.stringify(r.txn) });
  }

  const written = await putMany(toWrite);
  return { parsed, rejected, duplicates, written };
}

/**
 * Backfill: walks backwards through history using timestamp cursors.
 *
 * Cursor pagination, not offsets. New messages arriving mid-scan shift every
 * offset and cause duplicates or gaps; `before` is stable regardless.
 */
async function backfill({ onProgress, onWait, shouldStop }) {
  const existing = await loadTransactions();
  const known = new Set(existing.map((t) => t.fingerprint));
  const soft = new Set(existing.map((t) => t.softKey).filter(Boolean));
  await primeCategoryCache();

  const drift = [];
  const totals = { parsed: 0, rejected: 0, duplicates: 0, written: 0, scanned: 0, drift };
  let before = Store.cursor();
  let high = Store.watermark();

  /*
   * Timestamp cursors are stable against inserts, but they are NOT unique:
   * several SMS routinely share a millisecond (a bank alert and the UPI app's
   * copy of the same payment, or a burst delivered together). The server
   * filters `date < before`, so advancing the cursor to exactly the page's
   * minimum silently drops every other message at that instant.
   *
   * Fix: advance to minDate + 1 so the boundary instant is re-fetched, and skip
   * anything already handled by SMS id. The overlap is at most a few rows and
   * costs one extra dedup check each.
   */
  const seenIds = new Set();
  let guard = 0;

  for (;;) {
    if (shouldStop && shouldStop()) return { ...totals, stopped: true };

    const q = new URLSearchParams({ limit: '50' });
    if (before) q.set('before', String(before));
    const page = await api('/connectors/sms/messages?' + q);
    if (!page.messages.length) break;

    high = Math.max(high, ...page.messages.map((m) => m.date));

    const fresh = page.messages.filter((m) => !seenIds.has(m.id));
    fresh.forEach((m) => seenIds.add(m.id));

    if (fresh.length) {
      const r = await ingestPage(fresh, known, soft, onWait, drift);
      totals.parsed += r.parsed;
      totals.rejected += r.rejected;
      totals.duplicates += r.duplicates;
      totals.written += r.written;
      totals.scanned += fresh.length;
    }

    const minDate = Math.min(...page.messages.map((m) => m.date));
    const next = minDate + 1;

    // A whole page sharing one timestamp cannot be paged past by time alone.
    // Step over that instant rather than looping forever; the messages at it
    // were just processed above, so nothing is lost.
    if (before !== null && next >= before) {
      if (++guard > 2) { before = minDate; guard = 0; }
      else before = next;
    } else {
      before = next;
      guard = 0;
    }

    // Persist the cursor after every page: closing the tab loses at most one
    // page of work rather than the whole run.
    Store.setCursor(before);
    Store.setWatermark(high);

    if (onProgress) onProgress(totals, before);
    if (page.messages.length < 50 && !fresh.length) break;
  }

  Store.setWatermark(high);
  return { ...totals, stopped: false };
}

/**
 * Incremental catch-up for messages newer than the high-water mark. Runs at
 * INTERACTIVE priority: it is a handful of messages and the user is present.
 */
async function catchUp() {
  const since = Store.watermark();
  if (!since) return { written: 0, scanned: 0 };

  const existing = await loadTransactions();
  const known = new Set(existing.map((t) => t.fingerprint));
  const soft = new Set(existing.map((t) => t.softKey).filter(Boolean));
  await primeCategoryCache();

  const page = await api('/connectors/sms/messages?limit=100&since=' + since);
  if (!page.messages.length) return { written: 0, scanned: 0 };

  const r = await ingestPage(page.messages, known, soft, null, null);
  Store.setWatermark(Math.max(since, ...page.messages.map((m) => m.date)));
  return { ...r, scanned: page.messages.length };
}

window.SandeshikaApi = {
  MEDHA, Store, api, batchCall, ApiError,
  loadTransactions, listPrefix, putMany, Keys,
  resolveCategory, primeCategoryCache, catCache,
  backfill, catchUp, ingestPage, sleep,
};
