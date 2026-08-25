/**
 * Sandeshika — category resolution and learning.
 *
 * THE LADDER, cheapest and most certain first:
 *
 *   user correction → rule table → sender prior → learned model
 *                   → cached LLM answer → LLM → "other"
 *
 * Each rung only sees what the rung above could not answer. On a real inbox the
 * same twenty merchants account for most transactions, so a merchant costs
 * inference exactly once in the app's lifetime — the difference between a
 * backfill that takes minutes and one that takes an hour.
 */

import * as P from '../core/parser.js';
import * as M from '../core/model.js';
import { api, batchCall, listPrefix, putMany, loadTransactions, Keys, ApiError } from './client.js';

/** @typedef {import('../core/types.js').Txn} Txn */
/** @typedef {import('../core/types.js').CategoryDecision} CategoryDecision */

/** merchantKey -> decision. Mirrors the `cat/` namespace in Medha's store. */
export const catCache = new Map();

/** @type {ReturnType<typeof M.train>|null} */
let learnedModel = null;
/** @type {Record<string, {category: string, n: number}>} */
let learnedPriors = Object.create(null);

/** A category name the user may have invented, so shape is checked, not membership. */
const CATEGORY_NAME_RE = /^[a-z][a-z0-9 &-]{1,23}$/i;

/**
 * Retrains from the user's own confirmed labels.
 *
 * ONLY user-confirmed rows are used. Training on the model's own past output
 * would compound its mistakes into confidence, which is how a classifier ends
 * up wrong and certain at the same time.
 * @param {Txn[]} [transactions]
 */
export async function retrainModel(transactions) {
  const rows = (transactions || await loadTransactions())
    .filter((t) => t.categorySource === 'user' && t.category && t.category !== 'other');
  learnedModel = M.train(rows);
  learnedPriors = M.senderPriors(rows);
  return {
    examples: rows.length,
    ready: learnedModel.ready,
    classes: learnedModel.classes,
    senders: Object.keys(learnedPriors).length,
  };
}

export function modelStats() {
  return {
    ready: Boolean(learnedModel && learnedModel.ready),
    examples: learnedModel ? learnedModel.n : 0,
    classes: learnedModel ? learnedModel.classes : [],
    senders: Object.keys(learnedPriors).length,
  };
}

/** Loads every cached decision in one pass, before a backfill starts. */
export async function primeCategoryCache() {
  const rows = await listPrefix('cat/', 5000);
  for (const r of rows) {
    const key = r.key.replace(/^cat\//, '');
    try {
      catCache.set(key, JSON.parse(r.value));
    } catch { /* a corrupt cache entry just means one extra model call */ }
  }
  return catCache.size;
}

const CATEGORY_PROMPT = (merchant) => `Classify this Indian merchant into exactly one category.
Merchant: "${merchant}"
Categories: ${P.CATEGORIES.join(', ')}
Answer with one word from the list and nothing else.`;

/**
 * @param {string|null} merchant
 * @param {'debit'|'credit'} direction
 * @param {((msg: string, secs: number) => void)|null} [onWait]
 * @param {Txn} [txnHint] Enables the sender-prior and learned-model rungs.
 * @returns {Promise<CategoryDecision>}
 */
export async function resolveCategory(merchant, direction, onWait, txnHint) {
  const mk = P.merchantKey(merchant);

  // A user correction is checked FIRST, before the built-in rule table.
  // Checking rules first meant a correction on any merchant the table already
  // knew ("Rapido" -> transport) was silently ignored and the user was asked to
  // fix the same thing again. If they told us once, that is the answer.
  const cached = catCache.get(mk);
  if (mk && cached && cached.source === 'user') return cached;

  const rule = P.categorise(merchant, direction);
  if (rule) return rule;

  if (!mk) return { category: 'other', source: 'rule' };
  if (cached) return cached;

  // Learned rungs, between the rules and the model call. Both are free and
  // instant; the LLM is neither.
  if (txnHint) {
    const senderKey = P.normaliseSender(txnHint.sender || '');
    const prior = learnedPriors[senderKey];
    if (prior) return { category: prior.category, source: 'sender' };

    const guess = M.predict(learnedModel, { ...txnHint, merchant });
    if (guess) return { category: guess.category, source: 'model', why: guess.why };
  }

  let category = 'other';
  /** @type {import('../core/types.js').CategorySource} */
  let source = 'llm';
  try {
    const r = await batchCall('/generate', {
      system: 'You are a strict classifier. Reply with exactly one word.',
      prompt: CATEGORY_PROMPT(merchant),
    }, onWait || undefined);
    const word = String(r.text || '').toLowerCase().replace(/[^a-z]/g, '');
    // Never trust the model's output shape. An unrecognised answer becomes
    // "other" rather than creating a phantom category in the totals.
    category = P.CATEGORIES.includes(word) ? word : 'other';
  } catch (e) {
    const err = /** @type {ApiError} */ (e);
    if (err.status === 503 || err.status === 0) throw err; // service down: stop the run
    source = 'fallback';
  }

  /** @type {CategoryDecision} */
  const val = { category, source };
  catCache.set(mk, val);
  // A failed cache write costs one extra inference later; it must not abort
  // an import that is otherwise succeeding.
  await api(`/store/${Keys.cat(mk)}`, { method: 'PUT', body: JSON.stringify(val) })
    .catch(() => {});
  return val;
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export const KINDS = /** @type {const} */ (['expense', 'income', 'refund', 'transfer']);

/**
 * The kind implied by a category, given the direction of the money.
 *
 * A kind the user set by hand is never overridden. Category and kind are
 * related but not the same: a "bills" payment to your own credit card is a
 * transfer, and a "shopping" credit is a refund rather than income. Deriving
 * kind from category alone silently undoes a correction they already made.
 * @param {string} category
 * @param {Txn} txn
 * @returns {import('../core/types.js').Kind}
 */
export function kindFor(category, txn) {
  if (txn && txn.kindSource === 'user' && txn.kind) return txn.kind;
  if (category === 'transfer' || category === 'investment') return 'transfer';
  if (txn.direction === 'credit') return txn.kind === 'refund' ? 'refund' : 'income';
  return 'expense';
}

/**
 * Records a correction and applies it BACKWARDS as well as forwards.
 *
 * Forwards-only would be half a feature: the inbox already holds months of
 * transactions filed under the wrong category, and re-importing does not fix
 * them because the parse is cached. Every stored transaction from the same
 * merchant is relabelled in one bulk write, and the count is returned so the UI
 * can say so rather than leaving the user to wonder whether it took.
 *
 * @param {string} merchant
 * @param {string} category
 * @param {{thisOnly?: boolean}} [opts]
 */
export async function correctCategory(merchant, category, opts = {}) {
  const mk = P.merchantKey(merchant);
  if (!mk) throw new ApiError('No merchant to learn from on this transaction.', 0, 0);
  if (!CATEGORY_NAME_RE.test(category)) {
    throw new ApiError(`'${category}' is not a usable category name.`, 0, 0);
  }

  /** @type {CategoryDecision} */
  const rule = { category, source: 'user', merchant, at: Date.now() };
  catCache.set(mk, rule);
  await api(`/store/${Keys.cat(mk)}`, { method: 'PUT', body: JSON.stringify(rule) });

  if (opts.thisOnly) return { merchantKey: mk, updated: 0 };

  const all = await loadTransactions();
  const touched = all.filter((t) => P.merchantKey(t.merchant) === mk
    && (t.category !== category || t.categorySource !== 'user'));
  if (!touched.length) return { merchantKey: mk, updated: 0 };

  await putMany(touched.map((t) => {
    // `kind` decides whether the amount counts as spending, so it must always
    // follow the category. Updating it only for unreviewed rows left an
    // already-confirmed transaction labelled "transfer" while still being
    // summed as an expense — the totals and the label disagreeing is the worst
    // outcome available here.
    const next = {
      ...t,
      category,
      categorySource: /** @type {const} */ ('user'),
      kind: kindFor(category, t),
      needsReview: false,
      reviewed: true,
    };
    return { key: Keys.txn(t.fingerprint), value: JSON.stringify(next) };
  }));

  // Each correction is a training example; retrain immediately so the very next
  // unknown merchant benefits from it.
  await retrainModel();
  return { merchantKey: mk, updated: touched.length };
}

/**
 * Sets the kind directly.
 *
 * `kind` decides whether an amount is counted as spending, income, or excluded
 * entirely, so it is the most consequential field on a transaction — and it
 * used to be changeable only indirectly, by picking a category that happened to
 * imply the right one. That is an odd way to ask someone to fix a ₹5,000 error.
 *
 * Scope defaults to this transaction only: two payments to the same merchant
 * can legitimately differ (a Paytm payment to a shop vs a Paytm wallet load).
 *
 * @param {Txn} txn
 * @param {import('../core/types.js').Kind} kind
 * @param {{merchantWide?: boolean}} [opts]
 */
export async function setKind(txn, kind, opts = {}) {
  if (!KINDS.includes(kind)) throw new ApiError(`'${kind}' is not a valid kind.`, 0, 0);

  const write = (t) => ({
    key: Keys.txn(t.fingerprint),
    value: JSON.stringify({ ...t, kind, kindSource: 'user', needsReview: false, reviewed: true }),
  });

  if (!opts.merchantWide || !txn.merchant) {
    await api(`/store/${Keys.txn(txn.fingerprint)}`, { method: 'PUT', body: write(txn).value });
    return { updated: 1 };
  }

  const mk = P.merchantKey(txn.merchant);
  const all = await loadTransactions();
  // Same direction only: a refund from a merchant must not be swept up by a
  // bulk change to how their charges are counted.
  const touched = all.filter((t) => P.merchantKey(t.merchant) === mk
    && t.direction === txn.direction && t.kind !== kind);
  if (!touched.length) {
    await api(`/store/${Keys.txn(txn.fingerprint)}`, { method: 'PUT', body: write(txn).value });
    return { updated: 1 };
  }
  await putMany(touched.map(write));
  return { updated: touched.length };
}

/** Everything the app has been taught, for a screen that can show and undo it. */
export async function learnedRules() {
  const rows = await listPrefix('cat/', 5000);
  return rows.map((r) => {
    /** @type {Partial<CategoryDecision>} */
    let v = {};
    try {
      v = JSON.parse(r.value);
    } catch { /* unreadable rule; surfaced as a bare key so it can be forgotten */ }
    return { merchantKey: r.key.replace(/^cat\//, ''), ...v };
  }).filter((r) => r.source === 'user').sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** Forgets one correction. Past transactions keep their current label. */
export async function forgetRule(merchantKey) {
  catCache.delete(merchantKey);
  await api(`/store/${Keys.cat(merchantKey)}`, { method: 'DELETE' });
}
