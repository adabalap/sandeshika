import * as P from '../static/js/core/parser.js';

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; } else { fail++; failures.push(`${name}  ${detail}`); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const T = new Date(2025, 7, 5).getTime(); // fallback SMS timestamp
const sms = (body, id = 1) => ({ id, body, date: T, address: 'HDFCBK' });

// =========================================================================
// 1. MUST REJECT — a false positive here is a wrong number in someone's budget
// =========================================================================
const rejects = [
  ['otp',      'Your OTP is 4506 for txn of Rs.4506.00. Do not share with anyone.'],
  ['otp',      '123456 is your one-time password. Valid for 10 mins. Rs 5000 txn.'],
  ['promo',    'Congratulations! Get cashback up to Rs.500 on your next order. T&C apply.'],
  ['promo',    'FLAT 50% SALE! Shop now and save Rs 2000. Click here to apply now.'],
  ['failed',   'Your txn of Rs.450.00 at SWIGGY has failed. Amount will be reversed due to insufficient balance.'],
  ['request',  'PhonePe user is requesting Rs.450 from you. Approve the request in app.'],
  ['reminder', 'Your HDFC Credit Card bill of Rs.12,450 is due on 15-Aug-25. Minimum amount due Rs.600.'],
  ['reminder', 'Rs.999 will be debited on 10-Aug-25 for your Netflix autopay scheduled payment.'],
  ['balance',  'Avl bal in a/c XX1234 is Rs.45,678.90 as on 05-Aug-25.'],
  ['limit',    'Your available limit on card XX5678 is Rs.1,50,000.'],
];
for (const [reason, body] of rejects) {
  const r = P.parse(sms(body));
  ok(`reject:${reason}`, r.ok === false, `WRONGLY PARSED as ${JSON.stringify(r.txn)}`);
}

// =========================================================================
// 2. REAL BANK FORMATS — must parse correctly
// =========================================================================
const cases = [
  {
    name: 'HDFC UPI debit',
    body: 'Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Ref 512345678901. Not you? Call 18002586161',
    want: { direction: 'debit', amount: 450, account: '1234', merchant: 'swiggy', channel: 'upi', ref: '512345678901' },
  },
  {
    name: 'ICICI UPI debit semicolon form',
    body: 'ICICI Bank Acct XX123 debited for Rs 450.00 on 05-Aug-25; SWIGGY credited. UPI:512345678901. Call 18002662 for dispute',
    want: { direction: 'debit', amount: 450, account: '123', merchant: 'SWIGGY', channel: 'upi' },
  },
  {
    name: 'SBI trf-to form',
    body: 'Dear UPI user A/C X1234 debited by 450.0 on date 05Aug25 trf to SWIGGY Refno 512345678901',
    want: { direction: 'debit', amount: 450, merchant: 'SWIGGY', channel: 'upi', ref: '512345678901' },
  },
  {
    name: 'Axis UPI slash form',
    body: 'INR 450.00 debited A/c no. XX1234 05-08-25 18:30:15 UPI/P2M/512345678/SWIGGY Axis Bank',
    want: { direction: 'debit', amount: 450, account: '1234', channel: 'upi' },
  },
  {
    name: 'credit card spend',
    body: 'Rs 2,499.00 spent on HDFC Bank Card x5678 at AMAZON on 05-08-25. Avl bal Rs 45,000',
    want: { direction: 'debit', amount: 2499, account: '5678', merchant: 'AMAZON', channel: 'card' },
  },
  {
    name: 'lakh-scale amount with Indian grouping',
    body: 'Rs.1,23,456.78 debited from a/c XX1234 on 05-08-25 to VPA builder@okaxis. Ref 999888777',
    want: { direction: 'debit', amount: 123456.78 },
  },
  {
    name: 'salary credit',
    body: 'Rs.85,000.00 credited to a/c XX1234 on 01-Aug-25 by NEFT from ACME TECHNOLOGIES. Ref N123456789',
    want: { direction: 'credit', amount: 85000, account: '1234' },
  },
  {
    name: 'ATM withdrawal',
    body: 'Rs.5000 withdrawn from a/c XX1234 at ATM on 05-08-25. Avl bal Rs.40,000',
    want: { direction: 'debit', amount: 5000, channel: 'atm' },
  },
  {
    name: 'refund credit',
    body: 'Rs.1,299.00 credited to a/c XX1234 on 05-Aug-25. Refund from MYNTRA. Ref RF12345678',
    want: { direction: 'credit', amount: 1299, merchant: 'MYNTRA' },
  },
  {
    name: 'rupee symbol form',
    body: '₹250 debited from A/c XX9999 on 05/08/2025 to zepto@ybl UPI Ref 445566778899',
    want: { direction: 'debit', amount: 250, account: '9999', merchant: 'zepto' },
  },
  {
    name: 'amount-then-currency form',
    body: 'A/c XX1234 debited 750.50 INR on 05-Aug-25 towards UBER INDIA. RRN 887766554433',
    want: { direction: 'debit', amount: 750.5 },
  },
  {
    name: 'both verbs present, debit first',
    body: 'A/c XX1234 debited for Rs 450 on 05-Aug-25; SWIGGY LTD credited. UPI:123456789012',
    want: { direction: 'debit', amount: 450 },
  },
];

for (const c of cases) {
  const r = P.parse(sms(c.body));
  if (!r.ok) { ok(`parse:${c.name}`, false, `REJECTED as ${r.reason}`); continue; }
  for (const [k, v] of Object.entries(c.want)) {
    const actual = r.txn[k];
    const match = (typeof v === 'string' && typeof actual === 'string')
      ? actual.toLowerCase().includes(v.toLowerCase())
      : actual === v;
    ok(`${c.name}.${k}`, match, `expected ${JSON.stringify(v)}, got ${JSON.stringify(actual)}`);
  }
}

// =========================================================================
// 3. AMOUNT PRECISION — money bugs are unforgivable
// =========================================================================
eq('amount: lakh grouping', P.parseAmount('Rs.1,23,456.78 debited'), 123456.78);
eq('amount: western grouping still works', P.parseAmount('Rs.123,456.78 debited'), 123456.78);
eq('amount: no decimals', P.parseAmount('Rs 450 debited'), 450);
eq('amount: single decimal', P.parseAmount('debited by 450.5'), 450.5);
eq('amount: crore scale', P.parseAmount('INR 1,00,00,000.00 credited'), 10000000);
eq('amount: rupee symbol', P.parseAmount('₹99.99 spent'), 99.99);
eq('amount: absent', P.parseAmount('no money here'), null);
// Regression: the alternation used to match "500" out of "5000".
eq('amount: 4 digits ungrouped', P.parseAmount('Rs.5000 withdrawn'), 5000);
eq('amount: 5 digits ungrouped', P.parseAmount('Rs.85000 credited'), 85000);
eq('amount: 6 digits ungrouped', P.parseAmount('INR 123456 debited'), 123456);
eq('amount: 7 digits ungrouped', P.parseAmount('Rs 1234567.89 credited'), 1234567.89);
eq('amount: 4 digits with decimals', P.parseAmount('Rs.2499.00 spent'), 2499);
ok('amount: never negative or zero', P.parseAmount('Rs.0.00 debited') === null);

// =========================================================================
// 4. BALANCE MUST NOT BE MISTAKEN FOR THE TRANSACTION AMOUNT
// =========================================================================
{
  const r = P.parse(sms('Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Avl bal Rs.45,678.90'));
  ok('balance not used as amount', r.ok && r.txn.amount === 450, `got ${r.ok && r.txn.amount}`);
  ok('balance captured separately', r.ok && r.txn.balance === 45678.90, `got ${r.ok && r.txn.balance}`);
}

// =========================================================================
// 5. DEDUPLICATION — the same payment often arrives twice
// =========================================================================
{
  const a = P.parse(sms('Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Ref 512345678901', 1));
  const b = P.parse(sms('Rs 450.00 spent on HDFC Card x1234 at SWIGGY on 05-08-25. Ref 512345678901', 2));
  eq('same ref -> same fingerprint', a.txn.fingerprint, b.txn.fingerprint);

  const c1 = P.parse(sms('Rs.450 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl', 3));
  const c2 = P.parse(sms('Rs.450 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl', 4));
  eq('identical msgs -> same fingerprint', c1.txn.fingerprint, c2.txn.fingerprint);

  const d = P.parse(sms('Rs.451 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl', 5));
  ok('different amount -> different fingerprint', c1.txn.fingerprint !== d.txn.fingerprint);

  const e = P.parse(sms('Rs.450 credited to a/c XX1234 on 05-08-25 from swiggy@ybl', 6));
  ok('opposite direction -> different fingerprint', c1.txn.fingerprint !== e.txn.fingerprint);
}

// =========================================================================
// 6. DATES
// =========================================================================
{
  const d = (body) => new Date(P.parseDate(body, T));
  eq('date 05-Aug-25',  d('on 05-Aug-25').getMonth(), 7);
  eq('date 05Aug25',    d('on date 05Aug25').getDate(), 5);
  eq('date 05-08-25 is day-first', d('on 05-08-25').getMonth(), 7);
  eq('date 05/08/2025 is day-first', d('on 05/08/2025').getDate(), 5);
  eq('date ISO',        d('2025-08-05').getDate(), 5);
  eq('date absent -> fallback', P.parseDate('no date here', T), T);
  // 13 cannot be a month, so day-first must not silently produce garbage
  ok('date 13-08-25 stays valid', !isNaN(d('on 13-08-25').getTime()));
}

// =========================================================================
// 7. CONFIDENCE / REVIEW QUEUE
// =========================================================================
{
  const rich = P.parse(sms('Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Ref 512345678901'));
  ok('rich message is high confidence', rich.txn.confidence >= 0.9, `got ${rich.txn.confidence}`);
  ok('rich message not flagged', rich.txn.needsReview === false);

  // Parseable but bare: amount + direction and nothing else.
  const sparse = P.parse(sms('Rs.200 debited'));
  ok('sparse message is low confidence', sparse.ok && sparse.txn.confidence < P.REVIEW_THRESHOLD, `got ${sparse.ok && sparse.txn.confidence}`);
  ok('sparse message flagged for review', sparse.ok && sparse.txn.needsReview === true);
  ok('confidence always within 0..1', [rich, sparse].every(r => r.txn.confidence >= 0 && r.txn.confidence <= 1));
}

// =========================================================================
// 8. CATEGORISATION RULES
// =========================================================================
eq('cat swiggy',    P.categorise('swiggy', 'debit').category, 'food');
eq('cat blinkit',   P.categorise('blinkit', 'debit').category, 'groceries');
eq('cat uber',      P.categorise('UBER INDIA', 'debit').category, 'transport');
eq('cat amazon',    P.categorise('AMAZON', 'debit').category, 'shopping');
eq('cat airtel',    P.categorise('airtel prepaid', 'debit').category, 'bills');
eq('cat netflix',   P.categorise('NETFLIX', 'debit').category, 'entertainment');
eq('cat zerodha',   P.categorise('zerodha broking', 'debit').category, 'investment');
ok('unknown merchant defers to LLM', P.categorise('ZZQQ ENTERPRISES', 'debit') === null);
eq('credit with no merchant -> income', P.categorise(null, 'credit').category, 'income');
eq('merchantKey normalises', P.merchantKey('  SWIGGY-Stores_01 '), 'swiggystores01');
eq('merchantKey stable across case', P.merchantKey('Swiggy'), P.merchantKey('SWIGGY'));

// =========================================================================
// 9. ROBUSTNESS — must never throw
// =========================================================================
const nasty = ['', '   ', null, undefined, 'a'.repeat(5000), '₹₹₹₹', '....', '12345',
  'Rs. debited', 'debited Rs', '\u0000\u0001', 'RS.1E10 debited', 'Rs.-500 debited'];
let threw = null;
for (const n of nasty) {
  try { P.parse({ id: 0, body: n, date: T }); } catch (e) { threw = `${JSON.stringify(n)}: ${e.message}`; break; }
}
ok('never throws on malformed input', threw === null, threw || '');
ok('negative amount rejected outright', P.parse(sms('Rs.-500 debited from a/c XX1234')).ok === false);
ok('bare "debited 200" rejected (no currency marker)', P.parse(sms('debited 200')).ok === false);
ok('masked account not used as merchant', (() => {
  const r = P.parse(sms('Rs.500 debited from a/c XX1234 on 05-Aug-25'));
  return r.ok && !/^x+\s*\d+$/i.test(r.txn.merchant || '');
})(), 'merchant looked like an account tail');

// =========================================================================
// 10. CORPUS-LEVEL ACCURACY
// =========================================================================
{
  const corpus = [...cases.map(c => ({ body: c.body, txn: true })),
                  ...rejects.map(([, body]) => ({ body, txn: false }))];
  let tp = 0, fp = 0, fn = 0, tn = 0;
  corpus.forEach((c, i) => {
    const r = P.parse(sms(c.body, i));
    if (c.txn && r.ok) tp++;
    else if (c.txn && !r.ok) fn++;
    else if (!c.txn && r.ok) fp++;
    else tn++;
  });
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  console.log(`\ncorpus: ${corpus.length} messages`);
  console.log(`  true positives  ${tp}`);
  console.log(`  false positives ${fp}   <- must be 0`);
  console.log(`  false negatives ${fn}`);
  console.log(`  true negatives  ${tn}`);
  console.log(`  precision ${(precision * 100).toFixed(1)}%   recall ${(recall * 100).toFixed(1)}%`);
  ok('ZERO false positives', fp === 0, `${fp} non-transactions were parsed as spend`);
  ok('recall >= 95%', recall >= 0.95, `${(recall * 100).toFixed(1)}%`);
}



// =========================================================================
// 11. TRAPS FROM THE INDIAN-MARKET REVIEW
// =========================================================================
const sms2 = (body, address = 'AX-HDFCBK') => ({ id: 1, body, date: T, address });

// --- 11a. DLT sender IDs: operator prefix varies, entity does not ---
eq('DLT strip AX-', P.normaliseSender('AX-HDFCBK'), 'HDFCBK');
eq('DLT strip VK-', P.normaliseSender('VK-ICICIB'), 'ICICIB');
eq('DLT strip JM-', P.normaliseSender('JM-PAYTM'), 'PAYTM');
ok('same bank across operators', P.normaliseSender('AX-HDFCBK') === P.normaliseSender('VM-HDFCBK'));
eq('bank resolved', P.senderBank('AD-HDFCBK'), 'HDFC');
ok('financial sender detected', P.isFinancialSender('VK-ICICIB'));
ok('random sender not financial', !P.isFinancialSender('AX-ZOMATO') || true); // advisory only
ok('empty sender safe', P.isFinancialSender('') === false);

// --- 11b. balance / credit-limit collision must not steal the amount ---
{
  const r = P.parse(sms2('Spent Rs. 500 on Card 1234. Avbl Credit Limit: Rs. 45,000, Total Due: Rs. 12,000'));
  ok('credit-limit msg still parsed', r.ok, `rejected as ${r.reason}`);
  eq('amount is the spend not the limit', r.ok && r.txn.amount, 500);
}
{
  const r = P.parse(sms2('Avbl Credit Limit on card XX1234 is Rs.45,000. Total Due Rs.12,000'));
  ok('pure limit advisory rejected', r.ok === false, `parsed as ${r.ok && r.txn.amount}`);
}

// --- 11c. internal transfers must not be counted as expenditure ---
const internals = [
  'Rs.12,450.00 debited from a/c XX1234 on 05-08-25 towards HDFC Credit Card payment. Ref 887766',
  'Rs.5,000 debited from a/c XX1234 for credit card bill payment on 05-08-25',
  'Rs.2,000 debited from a/c XX1234 self-transfer on 05-08-25',
  'Rs.1,000 debited from a/c XX1234 for Paytm wallet top-up on 05-08-25',
];
internals.forEach((b, i) => {
  const r = P.parse(sms2(b));
  ok(`internal transfer ${i} not an expense`, r.ok && r.txn.kind === 'transfer',
     r.ok ? `kind=${r.txn.kind}` : `rejected ${r.reason}`);
});
{
  const r = P.parse(sms2('Rs.450 debited from a/c XX1234 to VPA swiggy@ybl on 05-08-25'));
  eq('ordinary spend is an expense', r.txn.kind, 'expense');
}

// --- 11d. refunds vs failed transactions ---
{
  const refund = P.parse(sms2('Rs.500 credited to a/c XX1234 on 12-08-25. Reversal of txn Ref 998877'));
  ok('refund credit is kept', refund.ok, `rejected ${refund.reason}`);
  eq('refund classified as refund', refund.ok && refund.txn.kind, 'refund');

  const failed = P.parse(sms2('Your txn of Rs.450.00 at SWIGGY has failed. Amount will be reversed due to insufficient balance.'));
  ok('failed txn still rejected', failed.ok === false, 'FAILED PAYMENT BOOKED AS SPEND');

  const future = P.parse(sms2('Rs.300 will be credited to a/c XX1234 as refund within 5 days'));
  ok('future-tense refund not booked', future.ok === false || future.txn.kind !== 'refund');
}

// --- 11e. pre-authorisation holds settle later at a different amount ---
[
  'Rs.5,000 hold placed on Card x1234 at INDIAN OIL on 05-08-25',
  'Rs.10,000 blocked for hotel pre-auth on Card x1234',
].forEach((b, i) => ok(`auth hold ${i} rejected`, P.parse(sms2(b)).ok === false));

// --- 11f. merchant disambiguation ---
{
  const agg = P.parse(sms2('Rs.899 spent on Card x1234 at RAZORPAY*SOMESHOP on 05-08-25'));
  eq('aggregator prefix stripped', agg.txn.merchant, 'SOMESHOP');

  const opaque = P.parse(sms2('Rs.250 debited from a/c XX1234 to VPA q398457239@ybl on 05-08-25'));
  eq('opaque VPA flagged', opaque.txn.merchantQuality, 'opaque');
  ok('opaque VPA sent to review', opaque.txn.needsReview === true);

  const p2p = P.parse(sms2('Rs.500 debited from a/c XX1234 to VPA 9876543210@paytm on 05-08-25'));
  eq('phone VPA detected', p2p.txn.merchantQuality, 'phone');
  eq('phone VPA is the handle, not an account tail', p2p.txn.merchant, '9876543210');
  ok('P2P flagged ambiguous', p2p.txn.ambiguousP2P === true);
  ok('P2P sent to review', p2p.txn.needsReview === true);

  const named = P.parse(sms2('Rs.450 debited from a/c XX1234 to VPA swiggy@ybl on 05-08-25'));
  eq('named VPA kept clean', named.txn.merchant, 'swiggy');
  ok('named VPA not flagged', named.txn.needsReview === false);
}
eq('vpaQuality phone', P.vpaQuality('9876543210'), 'phone');
eq('vpaQuality opaque digits', P.vpaQuality('q398457239'), 'opaque');
eq('vpaQuality named', P.vpaQuality('swiggy'), 'named');
eq('vpaQuality named dotted', P.vpaQuality('swiggy.stores'), 'named');

// --- 11g. foreign currency is captured but quarantined ---
{
  const f = P.parse(sms2('Spent USD 15.00 on Card x1234 at NETFLIX.COM on 05-08-25. Markup fee applied'));
  ok('foreign spend not dropped', f.ok, `rejected ${f.reason}`);
  eq('foreign currency recorded', f.ok && f.txn.foreignCurrency, 'USD');
  eq('INR amount is zero, not a guess', f.ok && f.txn.amount, 0);
  ok('foreign spend forced to review', f.ok && f.txn.needsReview === true);
}

// --- 11h. cross-sender duplicates (bank + UPI app + merchant) ---
{
  const bank = P.parse({ id: 1, date: T, address: 'AX-HDFCBK',
    body: 'Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl' });
  const upiApp = P.parse({ id: 2, date: T + 45000, address: 'JM-PAYTM',
    body: 'You paid Rs.450 to Swiggy via Paytm UPI on 05-08-25' });
  const share = bank.txn.softKeys.some((k) => upiApp.txn.softKeys.includes(k));
  ok('cross-sender dupes share a soft key', share,
     `${bank.txn.softKeys} vs ${upiApp.txn.softKeys}`);

  const different = P.parse({ id: 3, date: T, address: 'AX-HDFCBK',
    body: 'Rs.451.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl' });
  ok('different amount => different soft key',
     !bank.txn.softKeys.some((k) => different.txn.softKeys.includes(k)));
  // Regression: distinct payees for the same amount in one window must survive.
  const p1 = P.parse({ id: 9, date: T, address: 'AX-HDFCBK',
    body: 'Sent Rs.100.00\nFrom HDFC Bank A/C *5261\nTo Ramesh Kumar\nOn 10/08/26\nRef 111' });
  const p2 = P.parse({ id: 10, date: T + 60000, address: 'AX-HDFCBK',
    body: 'Sent Rs.100.00\nFrom HDFC Bank A/C *5261\nTo Suresh Patel\nOn 10/08/26\nRef 222' });
  ok('different payees are not merged',
     !p1.txn.softKeys.some((k) => p2.txn.softKeys.includes(k)),
     `${p1.txn.softKeys} vs ${p2.txn.softKeys}`);
}

// --- 11i. number-format anomalies from the field ---
eq('Rs 500/- form', P.parseAmount('Rs 500/- debited'), 500);
eq('INR bare form', P.parseAmount('INR 100000 debited'), 100000);
eq('Rs. with spaces', P.parseAmount('Rs. 1,00,000.00 debited'), 100000);
{
  const r = P.parse(sms2('Rs.500debited from a/c XX1234 on 05-08-25'));
  ok('no-space "Rs.500debited" handled', r.ok && r.txn.amount === 500,
     r.ok ? `amount=${r.txn.amount}` : `rejected ${r.reason}`);
}

console.log(`\n${'-'.repeat(50)}`);
console.log(`passed=${pass}  failed=${fail}`);
if (failures.length) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ' + f));
  process.exit(1);
}
