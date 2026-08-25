/**
 * Sandeshika — ingest.
 *
 * Correctness properties this file is responsible for:
 *
 *  - RESUMABLE. The user will close the tab mid-backfill. The cursor is
 *    persisted after every page, so a re-run costs nothing for work already
 *    done.
 *  - IDEMPOTENT. Transactions are keyed by fingerprint, so the same payment
 *    arriving twice (bank alert + UPI-app alert) is stored once.
 *  - BOUNDED. Bulk work is submitted at batch priority so Medha's thermal and
 *    battery gating applies. 429 is honoured, never hammered.
 *  - AUDITABLE. Every stored transaction keeps the raw SMS text and the source
 *    of its category, so a wrong number can always be traced back.
 */

import * as P from '../core/parser.js';
import * as O from '../core/organizer.js';
import { api, Keys, putMany, loadTransactions, Store } from './client.js';
import { resolveCategory, primeCategoryCache } from './categories.js';

/** @typedef {import('../core/types.js').Txn} Txn */
/** @typedef {import('../core/types.js').Sms} Sms */
/** @typedef {import('../core/types.js').DriftRow} DriftRow */
/** @typedef {import('../core/types.js').IngestTotals} IngestTotals */

const PAGE_SIZE = 50;
const CATCHUP_LIMIT = 100;

/** Fields whose change a user would actually notice on screen. */
const MATERIAL_FIELDS = ['amount', 'kind', 'category', 'merchant', 'date', 'currency'];

/**
 * The organizer's catch-all buckets: it placed the message nowhere specific.
 * Every other subtype — bill, service, offer, travel, delivery, otp — means it
 * WAS recognised, just not as a transaction, and reporting those as broken
 * templates is what turned this signal into 94 entries of noise.
 */
const UNRECOGNISED_SUBTYPES = new Set(['bank-other', 'other']);

/**
 * Keeps every decision the user made, while accepting the new parse for
 * everything they did not touch.
 * @param {Txn} prior
 * @param {Txn} fresh
 * @returns {Txn}
 */
export function mergeUserDecisions(prior, fresh) {
  const next = { ...fresh };
  if (prior.categorySource === 'user') {
    next.category = prior.category;
    next.categorySource = 'user';
  }
  if (prior.kindSource === 'user') {
    next.kind = prior.kind;
    next.kindSource = 'user';
  }
  if (prior.reviewed) {
    next.reviewed = true;
    next.needsReview = false;
  }
  return next;
}

/** Only rewrite when something a user would notice actually changed. */
export function changedMaterially(prior, fresh) {
  const merged = mergeUserDecisions(prior, fresh);
  return MATERIAL_FIELDS.some((k) => prior[k] !== merged[k]);
}

/**
 * @typedef {object} IngestContext
 * @property {Set<string>} known      Fingerprints already stored.
 * @property {Set<string>} soft       Secondary keys already stored.
 * @property {Map<string, Txn>} priors
 * @property {DriftRow[]|null} drift
 * @property {boolean} reprocess
 * @property {((msg: string, secs: number) => void)|null} onWait
 */

/**
 * Processes one page of SMS into stored transactions.
 * @param {Sms[]} messages
 * @param {IngestContext} ctx
 */
export async function ingestPage(messages, ctx) {
  const { known, soft, priors, drift, reprocess, onWait } = ctx;
  /** @type {Array<{key: string, value: string}>} */
  const toWrite = [];
  let parsed = 0; let rejected = 0; let duplicates = 0; let updated = 0;

  for (const m of messages) {
    const r = P.parse(m);

    if (!r.ok) {
      rejected++;
      /*
       * TEMPLATE DRIFT SIGNAL: a message from a registered bank sender that we
       * could not parse, and that is not something else we already understand.
       *
       * The reject reason alone is far too coarse. On a real 5,000-message
       * inbox this produced 94 "unrecognised templates", of which the large
       * majority were dormancy notices, FASTag balance nags, e-mandate
       * confirmations, statement alerts and promotional offers — all correctly
       * identified as non-transactions elsewhere in the app, and all reported
       * here as though the parser were broken. A signal that noisy is one
       * nobody reads, which is the same as having no signal at all.
       *
       * So a message only counts as drift if the ORGANIZER recognised nothing
       * specific about it either. A bill, a service notice, an offer, a
       * delivery update — all understood, just not as transactions. Only the
       * catch-all subtypes mean genuinely unfamiliar wording from a bank.
       */
      if (drift && P.isFinancialSender(m.address) && !P.EXPECTED_NOISE.includes(r.reason)) {
        const cls = O.classify(m);
        if (UNRECOGNISED_SUBTYPES.has(cls.subtype)) {
          drift.push({
            sender: m.address,
            reason: r.reason,
            subtype: cls.subtype,
            body: String(m.body).slice(0, 160),
          });
        }
      }
      continue;
    }
    parsed++;
    const txn = r.txn;

    if (known.has(txn.fingerprint)) {
      // On a re-scan, an already-stored row is RE-PARSED rather than skipped.
      //
      // Skipping was the old default, and it meant every parser improvement was
      // invisible on data already imported: transfers stayed classified as
      // spending, and months of totals stayed wrong no matter how often the
      // user re-ran the import. Anything the user decided by hand is carried
      // across untouched.
      if (reprocess) {
        const prior = priors.get(txn.fingerprint);
        if (prior && changedMaterially(prior, txn)) {
          toWrite.push({
            key: Keys.txn(txn.fingerprint),
            value: JSON.stringify(mergeUserDecisions(prior, txn)),
          });
          updated++;
        }
      }
      duplicates++;
      continue;
    }

    // Secondary key: one payment can produce a bank SMS, a UPI-app SMS and a
    // merchant SMS, none sharing an account tail or a reference number. Amount
    // + merchant inside a 10-minute bucket catches those cross-sender copies.
    //
    // Filtered: an older stored row may predate softKeys entirely, and letting
    // `undefined` into the set makes every subsequent keyless transaction look
    // like a duplicate of the first one.
    const keys = (txn.softKeys || [txn.softKey]).filter((k) => typeof k === 'string');
    if (keys.some((k) => soft.has(k))) {
      duplicates++;
      continue;
    }
    known.add(txn.fingerprint);
    keys.forEach((k) => soft.add(k));

    if (txn.kind === 'transfer') {
      txn.category = 'transfer';
      txn.categorySource = 'rule';
    } else if (txn.merchantQuality && txn.merchantQuality !== 'named') {
      // No point asking a model to categorise "q398457239"; it will invent
      // something confident and wrong. It goes to the review queue instead.
      txn.category = 'other';
      txn.categorySource = 'unresolved';
    } else {
      const cat = await resolveCategory(txn.merchant, txn.direction, onWait, txn);
      txn.category = cat.category;
      txn.categorySource = cat.source;
      // A heuristic guess ("this looks like a person, so a transfer") changes
      // whether the amount counts as spending at all. That is too big an effect
      // to apply silently, so it goes to the review queue.
      if (cat.source === 'guess') {
        txn.kind = 'transfer';
        txn.needsReview = true;
        txn.reviewReasonOverride = 'paid to what looks like a person — spend or transfer?';
      }
    }

    toWrite.push({ key: Keys.txn(txn.fingerprint), value: JSON.stringify(txn) });
  }

  const written = await putMany(toWrite);
  return { parsed, rejected, duplicates, written, updated };
}

/** Builds the dedup sets once, from what is already stored. */
async function buildContext(opts) {
  const existing = await loadTransactions();
  await primeCategoryCache();
  return {
    existing,
    known: new Set(existing.map((t) => t.fingerprint)),
    soft: new Set(existing.flatMap((t) => t.softKeys || [t.softKey]).filter(Boolean)),
    priors: new Map(existing.map((t) => [t.fingerprint, t])),
    ...opts,
  };
}

/**
 * Backfill: walks backwards through history using timestamp cursors.
 *
 * Cursor pagination, not offsets. New messages arriving mid-scan shift every
 * offset and cause duplicates or gaps; `before` is stable regardless.
 *
 * @param {object} [opts]
 * @param {(t: IngestTotals, before: number|null) => void} [opts.onProgress]
 * @param {(msg: string, secs: number) => void} [opts.onWait]
 * @param {() => boolean} [opts.shouldStop]
 * @param {boolean} [opts.restart] Ignore any saved cursor and walk the whole
 *   inbox again. Existing transactions are still deduplicated, so a restart is
 *   cheap and never creates copies.
 * @returns {Promise<IngestTotals>}
 */
export async function backfill({ onProgress, onWait, shouldStop, restart } = {}) {
  // A full re-scan also re-parses what is already stored, so parser fixes reach
  // historical data instead of only new messages.
  const reprocess = Boolean(restart);
  const ctx = await buildContext({ drift: [], reprocess, onWait: onWait || null });

  /** @type {IngestTotals} */
  const totals = {
    parsed: 0, rejected: 0, duplicates: 0, written: 0, updated: 0, scanned: 0,
    pages: 0, resumedFrom: null, reprocess, drift: ctx.drift,
  };

  /*
   * A cursor left by an earlier run means "carry on from here". That is right
   * for a run that was interrupted, and badly wrong as a silent default: once a
   * previous pass reached the oldest message, every later "Start import"
   * resumed at the end of history, scanned a handful of messages, and reported
   * success. The caller decides, and the cursor is reported either way.
   */
  if (restart) Store.reset();
  let before = restart ? null : Store.cursor();
  let high = restart ? 0 : Store.watermark();
  totals.resumedFrom = before;

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

    const q = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before) q.set('before', String(before));
    const page = await api('/connectors/sms/messages?' + q);
    if (!page.messages.length) break;

    totals.pages++;
    high = Math.max(high, ...page.messages.map((m) => m.date));

    const fresh = page.messages.filter((m) => !seenIds.has(m.id));
    fresh.forEach((m) => seenIds.add(m.id));

    if (fresh.length) {
      const r = await ingestPage(fresh, ctx);
      totals.parsed += r.parsed;
      totals.updated += r.updated;
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
      if (++guard > 2) {
        before = minDate;
        guard = 0;
      } else {
        before = next;
      }
    } else {
      before = next;
      guard = 0;
    }

    // Persist after every page: closing the tab loses at most one page of work
    // rather than the whole run.
    Store.setCursor(before);
    Store.setWatermark(high);

    if (onProgress) onProgress(totals, before);
    if (page.messages.length < PAGE_SIZE && !fresh.length) break;
  }

  // History is exhausted. Clearing the cursor means the next run starts from
  // the top rather than resuming at the end of time.
  Store.setCursor(0);
  Store.setWatermark(high);
  return { ...totals, stopped: false, complete: true };
}

/**
 * Incremental catch-up for messages newer than the high-water mark. Runs at
 * interactive priority: it is a handful of messages and the user is waiting.
 *
 * Returns `needsBackfill` rather than silently doing nothing when no watermark
 * exists — the old version returned a bare zero, which is indistinguishable
 * from "you are up to date" and made a never-imported inbox look current.
 */
export async function catchUp() {
  const since = Store.watermark();
  if (!since) return { written: 0, scanned: 0, needsBackfill: true };

  const ctx = await buildContext({ drift: null, reprocess: false, onWait: null });

  const page = await api(`/connectors/sms/messages?limit=${CATCHUP_LIMIT}&since=${since}`);
  if (!page.messages.length) return { written: 0, scanned: 0, needsBackfill: false };

  const r = await ingestPage(page.messages, ctx);
  Store.setWatermark(Math.max(since, ...page.messages.map((m) => m.date)));
  return { ...r, scanned: page.messages.length, needsBackfill: false };
}
