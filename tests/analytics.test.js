/*
 * Analytics — the arithmetic behind every figure on screen.
 *
 * This logic previously lived inside a 1,600-line UI file and could only be
 * exercised by opening the app and squinting at a card. It is pure now, so the
 * cases that actually corrupt totals — a refund booked as income, a
 * credit-card bill double-counted, an unreviewed guess quietly included — are
 * checked here instead of discovered later in someone's budget.
 */

import {
  range, dailyRange, inRange, isSpend, isRefund, isIncome, counted, isPending,
  summarise, dailyBuckets, lastNDays, monthProjection, qualityBreakdown, reviewReason,
  buildFacts,
} from '../static/js/core/analytics.js';
import { inr, inrShort, inrExact, dayKey, esc, csvCell, plural } from '../static/js/core/format.js';

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}  ${detail}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// A fixed clock: 15 August 2025, 12:00 local. Every assertion below is relative
// to it, so none of these tests can start failing on the 1st of a month.
const NOW = new Date(2025, 7, 15, 12, 0, 0).getTime();
const DAY = 864e5;

let seq = 0;
const txn = (o = {}) => ({
  smsId: ++seq,
  fingerprint: 'fp' + seq,
  direction: 'debit',
  kind: 'expense',
  amount: 100,
  currency: 'INR',
  foreignAmount: null,
  foreignCurrency: null,
  account: '1234',
  merchant: 'Test Merchant',
  merchantQuality: 'named',
  ref: null,
  channel: 'upi',
  date: NOW,
  balance: null,
  sender: 'AX-HDFCBK',
  senderId: 'HDFCBK',
  bank: 'HDFC',
  category: 'food',
  categorySource: 'rule',
  confidence: 0.9,
  needsReview: false,
  raw: 'test',
  ...o,
});

// ===========================================================================
// 1. Periods
// ===========================================================================
{
  const [a, b] = range('thisMonth', NOW);
  eq('thisMonth starts on the 1st', new Date(a).getDate(), 1);
  eq('thisMonth is August', new Date(a).getMonth(), 7);
  eq('thisMonth ends now', b, NOW);

  const [la, lb] = range('lastMonth', NOW);
  eq('lastMonth is July', new Date(la).getMonth(), 6);
  ok('lastMonth ends before this month starts', lb < a, `${lb} vs ${a}`);
  eq('lastMonth ends on 31 July', new Date(lb).getDate(), 31);

  const [ta] = range('last3', NOW);
  eq('last3 reaches back to June', new Date(ta).getMonth(), 5);

  eq('all time starts at epoch', range('all', NOW)[0], 0);

  // The daily view has its own period set; lastMonth must agree with the
  // headline view or the two screens disagree about what July was.
  eq('daily lastMonth matches range lastMonth', dailyRange('lastMonth', NOW)[0], la);
  eq('daily last30 is 30 days back', dailyRange('last30', NOW)[0], NOW - 30 * DAY);

  ok('inRange is inclusive at both ends',
    inRange(txn({ date: a }), [a, b]) && inRange(txn({ date: b }), [a, b]));
  ok('inRange excludes outside', !inRange(txn({ date: a - 1 }), [a, b]));
}

// ===========================================================================
// 2. Predicates — the definitions every total depends on
// ===========================================================================
{
  ok('an expense is spend', isSpend(txn()));
  ok('a transfer is NOT spend', !isSpend(txn({ kind: 'transfer' })));
  ok('a refund is NOT spend', !isSpend(txn({ kind: 'refund' })));
  ok('income is NOT spend', !isSpend(txn({ kind: 'income', direction: 'credit' })));

  // Investments move money without consuming it. Counting a SIP as spending
  // makes every "am I overspending" answer wrong in the same direction.
  ok('an investment is NOT spend', !isSpend(txn({ category: 'investment' })));

  // Foreign currency has no offline exchange rate, so it cannot join a rupee
  // total. Excluding it is the honest choice; converting at a guessed rate is
  // not.
  ok('foreign currency is NOT spend', !isSpend(txn({ currency: 'USD' })));

  ok('a refund is a refund', isRefund(txn({ kind: 'refund', direction: 'credit' })));
  ok('income is income', isIncome(txn({ kind: 'income', direction: 'credit' })));

  ok('unreviewed flagged rows are not counted', !counted(txn({ needsReview: true })));
  ok('confirmed flagged rows ARE counted', counted(txn({ needsReview: true, reviewed: true })));
  ok('isPending is the inverse for flagged rows', isPending(txn({ needsReview: true })));
  ok('isPending false once reviewed', !isPending(txn({ needsReview: true, reviewed: true })));
}

// ===========================================================================
// 3. summarise — where a wrong number would actually reach the user
// ===========================================================================
{
  const list = [
    txn({ amount: 1000, kind: 'expense', category: 'food' }),
    txn({ amount: 500, kind: 'expense', category: 'food' }),
    txn({ amount: 300, kind: 'expense', category: 'transport' }),
    txn({ amount: 200, kind: 'refund', direction: 'credit', category: 'food' }),
    txn({ amount: 5000, kind: 'income', direction: 'credit', category: 'income' }),
    txn({ amount: 9999, kind: 'transfer', category: 'transfer' }),
    txn({ amount: 7777, kind: 'expense', needsReview: true }),   // excluded
    txn({ amount: 4444, kind: 'expense', currency: 'USD' }),     // excluded
  ];
  const s = summarise(list, range('thisMonth', NOW));

  eq('gross spend sums only INR expenses', s.gross, 1800);
  eq('refunds are subtracted from spend', s.spent, 1600);
  eq('refund total is reported separately', s.refunded, 200);
  eq('income excludes refunds', s.received, 5000);
  eq('transfers are tracked but not spend', s.transferred, 9999);
  eq('net is income minus net spend', s.net, 3400);

  // The single most damaging failure available to this app.
  ok('a transfer never appears in spending', !s.byCat.some(([c]) => c === 'transfer'));
  ok('an unreviewed row never appears in a total', s.gross !== 1800 + 7777);

  eq('categories are sorted by size', s.byCat[0][0], 'food');
  eq('food total is correct', s.byCat[0][1], 1500);
  eq('largest expense is found', s.largest.amount, 1000);
  eq('merchant rollup counts occurrences', s.merchants[0].count, 3);

  // A refund landing in a month whose purchase sat in the previous one must
  // not produce a negative headline figure.
  const refundOnly = summarise(
    [txn({ amount: 500, kind: 'refund', direction: 'credit' })], range('thisMonth', NOW));
  eq('spend floors at zero, never negative', refundOnly.spent, 0);

  eq('an empty ledger summarises to zero', summarise([], range('all', NOW)).spent, 0);
  eq('an empty ledger has no largest', summarise([], range('all', NOW)).largest, null);
}

// ===========================================================================
// 4. Daily buckets and the seven-day strip
// ===========================================================================
{
  const list = [
    txn({ amount: 100, date: NOW }),
    txn({ amount: 250, date: NOW }),
    txn({ amount: 400, date: NOW - 2 * DAY }),
    txn({ amount: 50, kind: 'refund', direction: 'credit', date: NOW }),
    txn({ amount: 900, kind: 'income', direction: 'credit', date: NOW }),
  ];
  const days = dailyBuckets(list, range('thisMonth', NOW));

  eq('one bucket per active day', days.length, 2);
  eq('newest day first', days[0].key, dayKey(NOW));
  eq('daily spend is net of refunds', days[0].spend, 300);
  eq('daily income is tracked apart', days[0].income, 900);
  eq('daily count includes every row', days[0].count, 4);

  // The regression this exists to prevent: the old dashboard listed only days
  // that had transactions, so a quiet day silently vanished and the remaining
  // rows read as consecutive.
  const week = lastNDays(list, 7, NOW);
  eq('the week strip always has seven days', week.length, 7);
  eq('the strip starts today', week[0].key, dayKey(NOW));
  eq('a day with no spending shows zero, not nothing', week[1].spend, 0);
  eq('spending two days ago is still there', week[2].spend, 400);

  ok('projection is suppressed early in the month',
    monthProjection(1000, new Date(2025, 7, 2).getTime()) === null);
  const proj = monthProjection(15000, new Date(2025, 7, 15, 12).getTime());
  eq('projection extrapolates to month end', Math.round(proj), 31000);
}

// ===========================================================================
// 5. Coverage — buckets must be exclusive and must not lie
// ===========================================================================
{
  const list = [
    txn({ categorySource: 'rule' }),
    txn({ categorySource: 'rule' }),
    txn({ categorySource: 'user' }),
    txn({ categorySource: 'llm' }),
    txn({ categorySource: 'model' }),
    txn({ categorySource: 'sender' }),
    txn({ categorySource: 'guess', needsReview: true }),
    txn({ categorySource: 'unresolved', category: 'other' }),
  ];
  const q = qualityBreakdown(list);

  eq('total is the row count', q.total, 8);
  eq('rule count is counted, not inferred', q.rule, 2);

  // The bug this replaces: "by rule" was computed as total - llm - guessed -
  // uncategorised, which swept model and sender answers into "rule" and
  // overstated how much was handled deterministically.
  eq('model answers are not counted as rules', q.model, 1);
  eq('sender priors are not counted as rules', q.sender, 1);
  eq('llm answers are their own bucket', q.llm, 1);

  const summed = q.rule + q.user + q.sender + q.model + q.llm + q.guess
    + q.fallback + q.unresolved;
  eq('every row lands in exactly one source bucket', summed, q.total);
  ok('no bucket is ever negative', Object.values(q).every((v) => v >= 0));
  eq('pending review is counted', q.pendingReview, 1);
}

// ===========================================================================
// 6. Review reasons — the user is told precisely why something is queued
// ===========================================================================
{
  eq('foreign currency reason names the currency',
    reviewReason(txn({ currency: 'USD', foreignCurrency: 'USD', foreignAmount: 25 })),
    'USD 25 — no offline exchange rate');
  ok('ambiguous P2P is explained',
    reviewReason(txn({ ambiguousP2P: true })).includes('person or shop'));
  ok('opaque handles are explained',
    reviewReason(txn({ merchantQuality: 'opaque' })).includes('unreadable'));
  ok('otherwise the confidence is quoted',
    reviewReason(txn({ confidence: 0.42 })).includes('42%'));
  eq('an explicit override wins',
    reviewReason(txn({ reviewReasonOverride: 'custom reason' })), 'custom reason');
}

// ===========================================================================
// 7. buildFacts — the model must only ever see numbers we computed
// ===========================================================================
{
  const list = [
    txn({ amount: 1200, category: 'food', date: NOW }),
    txn({ amount: 800, category: 'transport', date: NOW }),
    txn({ amount: 3000, kind: 'expense', needsReview: true, date: NOW }),
  ];
  const facts = buildFacts(list, 'how much on food this month?', ['food', 'transport'], NOW);

  eq('the focus category is detected from the question', facts.focusCategory, 'food');
  eq('the focus figure is computed, not guessed', facts.focusThisMonth, 1200);
  eq('the month total excludes unreviewed rows', facts.thisMonth.spent, 2000);

  // Without this the model can present a partial total as a complete one, and
  // it has no way of knowing it is doing so.
  eq('excluded rows are disclosed to the model', facts.excludedPendingReview, 1);
  ok('no free-text is passed through', typeof facts.thisMonth.spent === 'number');
}

// ===========================================================================
// 8. Formatting
// ===========================================================================
{
  eq('rupees use Indian grouping', inr(825856), '₹8,25,856');
  eq('lakh notation for headline figures', inrShort(825856), '₹8.26 L');
  eq('crore notation above a crore', inrShort(12500000), '₹1.25 Cr');
  eq('thousands stay exact', inrShort(9500), '₹9,500');
  eq('paisa shown where it matters', inrExact(1234.5), '₹1,234.50');
  eq('negative amounts are shown unsigned', inr(-500), '₹500');

  // dayKey must be LOCAL: toISOString would put everything after 5:30am IST on
  // the wrong day for a user in India.
  eq('dayKey uses local midnight', dayKey(new Date(2025, 7, 15, 23, 30).getTime()), '2025-08-15');
  eq('dayKey pads single digits', dayKey(new Date(2025, 0, 5).getTime()), '2025-01-05');

  eq('html is escaped', esc('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  eq('quotes are escaped for attributes', esc('a"b\'c'), 'a&quot;b&#39;c');
  eq('null escapes to empty', esc(null), '');

  eq('csv quotes commas', csvCell('a,b'), '"a,b"');
  eq('csv doubles inner quotes', csvCell('say "hi"'), '"say ""hi"""');
  // A bare CR inside an unquoted field splits the row in Excel, and SMS bodies
  // contain them.
  eq('csv quotes carriage returns', csvCell('a\rb'), '"a\rb"');
  eq('csv leaves plain values alone', csvCell('plain'), 'plain');

  eq('plural singular', plural(1, 'transaction'), '1 transaction');
  eq('plural plural', plural(3, 'transaction'), '3 transactions');
}

console.log('\n' + '-'.repeat(50));
if (failures.length) console.log(failures.join('\n'));
console.log(`passed=${pass}  failed=${fail}`);
if (fail) process.exit(1);
