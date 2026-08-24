/**
 * Sandeshika — analytics.
 *
 * ACCURACY RULE: every number the user sees is computed here, in JavaScript,
 * from stored transactions. The language model is never asked to do arithmetic
 * and never asked to recall a figure. A model that invents a plausible rupee
 * amount is indistinguishable from one that is correct, which is exactly the
 * failure a money app cannot ship.
 *
 * Everything in this file is PURE — no DOM, no network, no clock except where a
 * `now` is passed in. That is what makes the totals testable, and the totals
 * are the product.
 */

import { dayKey } from './format.js';

/** @typedef {import('./types.js').Txn} Txn */
/** @typedef {import('./types.js').PeriodSummary} PeriodSummary */
/** @typedef {[number, number]} Range Inclusive [startMs, endMs]. */

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** @typedef {'thisMonth'|'lastMonth'|'last3'|'all'} PeriodName */
/** @typedef {'thisMonth'|'lastMonth'|'last30'|'all'} DailyPeriodName */

export const PERIOD_LABEL = {
  thisMonth: 'This month',
  lastMonth: 'Last month',
  last3: 'Last 3 months',
  all: 'All time',
};

const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1).getTime();

/**
 * @param {PeriodName} p
 * @param {number} [now]
 * @returns {Range}
 */
export function range(p, now = Date.now()) {
  const d = new Date(now);
  switch (p) {
    case 'thisMonth': return [startOfMonth(d), now];
    case 'lastMonth': {
      const s = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      return [s.getTime(), startOfMonth(d) - 1];
    }
    case 'last3': {
      const s = new Date(d.getFullYear(), d.getMonth() - 2, 1);
      return [s.getTime(), now];
    }
    default: return [0, now];
  }
}

/**
 * @param {DailyPeriodName} p
 * @param {number} [now]
 * @returns {Range}
 */
export function dailyRange(p, now = Date.now()) {
  const d = new Date(now);
  switch (p) {
    case 'last30': return [now - 30 * 864e5, now];
    case 'lastMonth': {
      const s = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      return [s.getTime(), startOfMonth(d) - 1];
    }
    case 'all': return [0, now];
    default: return [startOfMonth(d), now];
  }
}

/** @param {Txn} t @param {Range} r */
export const inRange = (t, [a, b]) => t.date >= a && t.date <= b;

// ---------------------------------------------------------------------------
// Predicates
//
// These key off `kind`, never `direction`.
//
// A credit-card bill payment is a debit but not expenditure: the card purchases
// were already counted, so booking the bill as well double-counts every rupee
// on that statement. Likewise a refund is a credit but not income; it offsets
// earlier spend. Getting this wrong is invisible and corrupts every total on
// the screen, which is why it lives in one place with one definition.
// ---------------------------------------------------------------------------

/** @param {Txn} t */
export const isSpend = (t) => t.kind === 'expense' && t.currency === 'INR' && t.category !== 'investment';
/** @param {Txn} t */
export const isRefund = (t) => t.kind === 'refund' && t.currency === 'INR';
/** @param {Txn} t */
export const isIncome = (t) => t.kind === 'income' && t.currency === 'INR';
/** @param {Txn} t */
export const isTransfer = (t) => t.kind === 'transfer';

/**
 * Whether a transaction is allowed to affect a total.
 *
 * Anything flagged for review is excluded until the user confirms it. Showing a
 * total that quietly includes guesses is worse than showing a smaller total and
 * saying what is missing.
 * @param {Txn} t
 */
export const counted = (t) => !t.needsReview || t.reviewed === true;

/** @param {Txn} t */
export const isPending = (t) => Boolean(t.needsReview) && t.reviewed !== true;

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

const sumBy = (list, fn) => list.reduce((s, t) => s + (fn(t) ? t.amount : 0), 0);

/**
 * The headline figures for a period.
 * @param {Txn[]} list
 * @param {Range} r
 * @returns {PeriodSummary}
 */
export function summarise(list, r) {
  const inR = list.filter((t) => inRange(t, r) && counted(t));
  const spends = inR.filter(isSpend);

  const gross = sumBy(inR, isSpend);
  const refunded = sumBy(inR, isRefund);
  // Net of refunds: a returned purchase was never really spent. Floored at
  // zero because a refund can legitimately land in a period whose original
  // purchase sits in an earlier one, and a negative "spent" reads as a bug.
  const spent = Math.max(0, gross - refunded);
  const received = sumBy(inR, isIncome);
  const transferred = sumBy(inR, isTransfer);

  /** @type {Record<string, number>} */
  const byCat = {};
  for (const t of spends) {
    const c = t.category || 'other';
    byCat[c] = (byCat[c] || 0) + t.amount;
  }

  /** @type {Record<string, {name: string, total: number, count: number, category: string|null}>} */
  const byMerchant = {};
  for (const t of spends) {
    const key = (t.merchant || 'unknown').toLowerCase();
    if (!byMerchant[key]) {
      byMerchant[key] = { name: t.merchant || 'Unknown', total: 0, count: 0, category: t.category };
    }
    byMerchant[key].total += t.amount;
    byMerchant[key].count++;
  }

  /** @type {Record<string, number>} */
  const byDay = {};
  for (const t of spends) {
    const k = dayKey(t.date);
    byDay[k] = (byDay[k] || 0) + t.amount;
  }

  return {
    spent, gross, refunded, received, transferred,
    net: received - spent,
    count: inR.length,
    byCat: Object.entries(byCat).sort((a, b) => b[1] - a[1]),
    merchants: Object.values(byMerchant).sort((a, b) => b.total - a.total),
    byDay,
    largest: spends.slice().sort((a, b) => b.amount - a.amount)[0] || null,
  };
}

/**
 * @typedef {object} DayBucket
 * @property {string} key
 * @property {number} spend    Net of refunds, floored at zero.
 * @property {number} income
 * @property {number} count
 * @property {number} review
 */

/**
 * Per-day totals, newest first. Only days that had activity appear.
 * @param {Txn[]} list
 * @param {Range} r
 * @returns {DayBucket[]}
 */
export function dailyBuckets(list, r) {
  /** @type {Record<string, DayBucket>} */
  const byDay = {};
  for (const t of list) {
    if (!inRange(t, r) || !counted(t)) continue;
    const k = dayKey(t.date);
    if (!byDay[k]) byDay[k] = { key: k, spend: 0, income: 0, count: 0, review: 0 };
    const d = byDay[k];
    d.count++;
    if (isSpend(t)) d.spend += t.amount;
    if (isRefund(t)) d.spend -= t.amount;
    if (isIncome(t)) d.income += t.amount;
    if (isPending(t)) d.review++;
  }
  return Object.values(byDay)
    .map((d) => ({ ...d, spend: Math.max(0, d.spend) }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

/**
 * The last N calendar days, INCLUDING days with no spending.
 *
 * The previous version listed only days that had transactions, so a quiet
 * Sunday vanished and the remaining rows sat next to each other looking like
 * consecutive days. A zero day is information — it is the difference between
 * "I spent nothing" and "the import missed a day".
 * @param {Txn[]} list
 * @param {number} n
 * @param {number} [now]
 * @returns {Array<{key: string, spend: number, count: number}>}
 */
export function lastNDays(list, n, now = Date.now()) {
  /** @type {Record<string, {spend: number, count: number}>} */
  const acc = {};
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    acc[dayKey(d.getTime())] = { spend: 0, count: 0 };
  }
  for (const t of list) {
    if (!counted(t)) continue;
    const k = dayKey(t.date);
    if (!acc[k]) continue;
    acc[k].count++;
    if (isSpend(t)) acc[k].spend += t.amount;
    if (isRefund(t)) acc[k].spend -= t.amount;
  }
  return Object.entries(acc)
    .map(([key, v]) => ({ key, spend: Math.max(0, v.spend), count: v.count }))
    .sort((a, b) => (a.key < b.key ? 1 : -1));
}

/**
 * Month-end projection from the pace so far.
 *
 * "You have spent ₹18,000" is a fact; "on pace for ₹42,000" is the part that
 * changes behaviour. Returns null before the 3rd, because a projection built
 * from two days of data is noise dressed as insight.
 * @param {number} spentSoFar
 * @param {number} [now]
 */
export function monthProjection(spentSoFar, now = Date.now()) {
  const d = new Date(now);
  const dayOfMonth = d.getDate();
  if (dayOfMonth <= 2) return null;
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return (spentSoFar / dayOfMonth) * daysInMonth;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * How the stored transactions were categorised, in MUTUALLY EXCLUSIVE buckets.
 *
 * The previous version computed "by rule" as `total - llm - guessed -
 * uncategorised`, which was wrong three ways: it silently absorbed the `sender`
 * and `model` sources into "rule", it double-subtracted anything both
 * model-labelled and left as "other", and it could go negative. A coverage
 * panel that overstates how much was handled by deterministic rules is exactly
 * the panel that hides a degrading parser.
 *
 * @param {Txn[]} txns
 */
export function qualityBreakdown(txns) {
  /** @type {Record<string, number>} */
  const bySource = {};
  for (const t of txns) {
    const s = t.categorySource || 'unresolved';
    bySource[s] = (bySource[s] || 0) + 1;
  }
  return {
    total: txns.length,
    user: bySource.user || 0,
    rule: bySource.rule || 0,
    sender: bySource.sender || 0,
    model: bySource.model || 0,
    llm: bySource.llm || 0,
    guess: bySource.guess || 0,
    fallback: bySource.fallback || 0,
    unresolved: (bySource.unresolved || 0) + (bySource.null || 0),
    pendingReview: txns.filter(isPending).length,
    uncategorised: txns.filter((t) => !t.category || t.category === 'other').length,
    noMerchant: txns.filter((t) => !t.merchant).length,
    foreign: txns.filter((t) => t.currency !== 'INR').length,
  };
}

/**
 * Plain-language reason a transaction is in the review queue.
 * @param {Txn} t
 */
export function reviewReason(t) {
  if (t.reviewReasonOverride) return t.reviewReasonOverride;
  if (t.currency !== 'INR') return `${t.foreignCurrency} ${t.foreignAmount} — no offline exchange rate`;
  if (t.ambiguousP2P) return 'paid to a phone number — person or shop?';
  if (t.merchantQuality === 'opaque') return 'unreadable UPI handle';
  return `low confidence ${Math.round((t.confidence || 0) * 100)}%`;
}

// ---------------------------------------------------------------------------
// Grounding for the Ask tab
// ---------------------------------------------------------------------------

/**
 * Builds a compact factual brief from real data, for the model to PHRASE and
 * never to compute. This is retrieval-grounded answering: the model sees only
 * numbers already computed above, and is instructed not to invent any.
 *
 * @param {Txn[]} txns
 * @param {string} question
 * @param {string[]} categories
 * @param {number} [now]
 */
export function buildFacts(txns, question, categories, now = Date.now()) {
  const cur = summarise(txns, range('thisMonth', now));
  const last = summarise(txns, range('lastMonth', now));
  const all = summarise(txns, range('all', now));

  const q = String(question || '').toLowerCase();
  const catHit = categories.find((c) => q.includes(c));

  /** @type {Record<string, unknown>} */
  const facts = {
    currency: 'INR',
    thisMonth: { spent: Math.round(cur.spent), received: Math.round(cur.received), transactions: cur.count },
    lastMonth: { spent: Math.round(last.spent), received: Math.round(last.received), transactions: last.count },
    thisMonthByCategory: Object.fromEntries(cur.byCat.map(([c, v]) => [c, Math.round(v)])),
    lastMonthByCategory: Object.fromEntries(last.byCat.map(([c, v]) => [c, Math.round(v)])),
    topMerchantsThisMonth: cur.merchants.slice(0, 5)
      .map((m) => ({ name: m.name, total: Math.round(m.total), times: m.count })),
    largestThisMonth: cur.largest
      ? { merchant: cur.largest.merchant, amount: Math.round(cur.largest.amount), date: dayKey(cur.largest.date) }
      : null,
    allTime: { spent: Math.round(all.spent), transactions: all.count },
  };

  if (catHit) {
    facts.focusCategory = catHit;
    const catTotal = (s, name) => {
      const hit = s.byCat.find(([c]) => c === name);
      return hit ? Math.round(hit[1]) : 0;
    };
    facts.focusThisMonth = catTotal(cur, catHit);
    facts.focusLastMonth = catTotal(last, catHit);
  }
  if (cur.refunded) facts.thisMonthRefunds = Math.round(cur.refunded);
  if (cur.transferred) {
    facts.note = 'Transfers between own accounts and credit-card bill payments are '
      + 'excluded from spending.';
  }
  // Stated so the model cannot present a partial total as a complete one.
  const pending = txns.filter(isPending).length;
  if (pending) facts.excludedPendingReview = pending;

  return facts;
}
