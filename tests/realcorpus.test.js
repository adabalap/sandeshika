/*
 * Regression suite built from a REAL 5,000-message Indian bank inbox.
 * Every case here was observed in the field, not invented.
 */
import * as P from '../static/js/core/parser.js';
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}  ${d}`); } };
const T = Date.now();
const p = (body, address = 'AX-HDFCBK') => P.parse({ id: 1, body, date: T, address });

// ---- must parse as real spending (previously all lost as "no-direction") ----
const spends = [
  ['HDFC UPI sent', 'Sent Rs.1358.00\nFrom HDFC Bank A/C *5261\nTo Mr Gadipudi Khadri Sri Sa\nOn 10/08/26\nRef 127698382602', 1358],
  ['HDFC UPI merchant', 'Sent Rs.72.00\nFrom HDFC Bank A/C x5261\nTo Rapido\nOn 05/05/25\nRef 104301657537', 72],
  ['HDFC UPI decimals', 'Sent Rs.391.35\nFrom HDFC Bank A/C x5261\nTo Vodafone Idea Ltd\nOn 30/11/24\nRef 433509033833', 391.35],
  ['UPI mandate charge', 'UPI Mandate:\nSent Rs.1999.00\nfrom HDFC Bank A/c 5261\nTo Google Play\n07/08/26\nRef 849120672196', 1999],
  ['standing instruction', 'We have successfully processed payment of INR 1500.00 to Merchant Country Delight, as per Standing Instruction Y76LgJJlM2 on 25/06/2026 for ICICI Bank Credit Ca', 1500],
  ['PayU aggregator', 'Transaction No. 29671634511 for Rs. 80.00 done for BOTTLE LAB TECHNOLOGIES PRI... has succeeded Team PayU', 80],
  ['bank fee', 'Low Balance Alert!\nRs.450.48 +GST charged for low balance in your HDFC Bank A/c X5261. Balance as of JUL-26 Rs.3637.46', 450.48],
];
for (const [name, body, amt] of spends) {
  const r = p(body);
  ok(`parses: ${name}`, r.ok, r.ok ? '' : `rejected as ${r.reason}`);
  if (r.ok) ok(`amount: ${name}`, r.txn.amount === amt, `${r.txn.amount} vs ${amt}`);
}

// the fee message must take the charge, not the balance that follows it
{
  const r = p('Low Balance Alert!\nRs.450.48 +GST charged for low balance in your HDFC Bank A/c X5261. Balance as of JUL-26 Rs.3637.46');
  ok('fee: balance not mistaken for amount', r.ok && r.txn.amount === 450.48, String(r.ok && r.txn.amount));
}

// ---- merchant extraction from the real shapes ----
const merchants = [
  ['Sent Rs.72.00\nFrom HDFC Bank A/C x5261\nTo Rapido\nOn 05/05/25\nRef 1043', 'Rapido'],
  ['UPI Mandate:\nSent Rs.1999.00\nfrom HDFC Bank A/c 5261\nTo Google Play\n07/08/26\nRef 8491', 'Google Play'],
  ['We have successfully processed payment of INR 1500.00 to Merchant Country Delight, as per Standing Instruction X on 25/06/2026', 'Country Delight'],
];
for (const [body, want] of merchants) {
  const r = p(body);
  ok(`merchant "${want}"`, r.ok && r.txn.merchant === want, r.ok ? `got ${JSON.stringify(r.txn.merchant)}` : r.reason);
}
{
  const r = p('Sent Rs.1000.00\nFrom HDFC Bank A/C *5261\nTo Google India Digital Serv\nOn 04/08/26\nRef 6582');
  ok('bank name never becomes the merchant', r.ok && !/HDFC/i.test(r.txn.merchant || ''), String(r.ok && r.txn.merchant));
  ok('date never rides into the merchant', r.ok && !/\d{2}\/\d{2}/.test(r.txn.merchant || ''), String(r.ok && r.txn.merchant));
}

// ---- credit-card autopay is an internal transfer, not spending ----
{
  const r = p('Dear Customer, thank you for your payment of INR 47,719.43 towards ICICI Bank Credit Card Account XX5008 through Auto Debit from Account XX0570 on 01-Apr-25', 'JM-ICICIT');
  ok('CC autopay parsed', r.ok, r.ok ? '' : r.reason);
  ok('CC autopay is a transfer', r.ok && r.txn.kind === 'transfer', r.ok ? r.txn.kind : '');
  ok('CC autopay amount exact', r.ok && r.txn.amount === 47719.43, String(r.ok && r.txn.amount));
}

// ---- must be rejected: the noise that dominated the drift report ----
const noise = [
  ['balance', 'UPDATE:Bal in HDFC Bank A/c XX5261 has gone below minimum limit of INR 5,000.00.Yesterday\'s bal:INR 1,222.41'],
  ['balance', 'Low Balance Alert!\nRs.213.15 +GST charged for low balance in your HDFC Bank A/c X5261. Maintain Rs.10000 to avoid charges'],
  ['mandate', 'Mandate Set\nRs.1999.00\nFor Google Play\nFrom HDFC Bank A/c x5261\nUMN: 59ee@ok'],
  ['mandate', 'Update:\nRs. 1999.00 UPI mandate to Google Play has been cancelled from HDFC Bank A/c x5261.'],
  ['mandate', 'Dear Customer, your AutoPay mandate registration has failed due to invalid card status=A -ICICI Bank.'],
  ['payee',   'Payee GCET added. Transfer funds after 30 mins. Send up to Rs 5,00,000.00 for first 24hrs.'],
  ['payee',   '30 mins have passed since adding GCET as Payee. Send upto Rs 5,00,000.00 in first 24 hrs.'],
  ['failed',  'Low Funds Alert! Rs 20000.00 declined on HDFC Bank Credit Card 0541 at VARUN ENTERPRISES 2372 due to low funds.'],
  ['failed',  'Txn of INR 1,18,000.00 is declined on ICICI Bank Credit Card XX2003, as the amt exceeds the Per Txn Limit set.'],
  ['failed',  'Purchase Declined! Due to Incorrect PIN. For Rs. 1245.00 on 08-03-2025 via HDFC Bank Credit Card 0541.'],
  ['failed',  'Payment of Rs. 19200.00 at Meridian Educational Society has failed.'],
  ['returned','Dear Customer, your UPI transaction of Rs 30000.00 to DARSHANAM SURE has been unsuccessful and will be reversed.'],
  ['returned','Pymt of Rs. 8226 ,for HDFC Bank Cr.card ending 0541 returned on 11/MAR/2024 .Make alternate pymt imdly'],
  ['status',  'E-Statement Generated! For HDFC Bank Credit Card 0541.Due date:08/NOV/2021.Total Due:Rs.38968.Min Due:Rs.1950.'],
  ['status',  'Delivered! Your HDFC Bank Credit Card Awb -33487873145 has been delivered.'],
  ['notice',  'You logged into your Airtel Payments Bank account from samsung SM-S948B at 07-06-2026 02:16:25.'],
  ['notice',  'Convert your ICICI Bank Credit Card outstanding amount into easy EMIs, by clicking on https://icici.co/x . T&Cs.'],
  ['notice',  'Scheduled Maintenance\nSome HDFC Bank services will be unavailable on 13 Sep 25, 12:30 AM - 07:30 AM IST'],
  ['notice',  '238 Reward Points credited to your HDFC Bank Credit Card ending 0541 on 03/FEB/2023 towards Weekday Dining Bonus.'],
  ['notice',  'Beware of fraud SMSs/calls about Income Tax refunds. These alerts may contain links that compromise your Card.'],
  ['request', 'kk electronics has requested payment of INR 54300.00. You can pay through this link: https://rzp.io/i/x - Razorpay'],
];
for (const [, body] of noise) {
  const r = p(body);
  ok(`rejected: ${body.slice(0, 42).replace(/\n/g, ' ')}`, r.ok === false,
     r.ok ? `PARSED AS ₹${r.txn.amount} ${r.txn.kind}` : '');
}

// every rejection above must be classed as expected noise, not template drift
for (const [, body] of noise) {
  const r = p(body);
  if (!r.ok) ok(`noise not flagged as drift: ${r.reason}`, P.EXPECTED_NOISE.includes(r.reason), r.reason);
}

// ---- categorisation traps found in this inbox ----
ok('"BOTTLE LAB TECHNOLOGIES" is not health', (P.categorise('BOTTLE LAB TECHNOLOGIES PRI', 'debit') || {}).category !== 'health');
ok('real diagnostics still health', P.categorise('Apollo Diagnostics', 'debit').category === 'health');
ok('Google Play categorised', P.categorise('Google Play', 'debit').category === 'entertainment');
ok('person -> transfer, marked as a guess', (() => {
  const c = P.categorise('KALYANI PUSHPALATHA ADABALA', 'debit');
  return c && c.category === 'transfer' && c.source === 'guess';
})());
ok('company not treated as a person', !P.looksPersonal('BOTTLE LAB TECHNOLOGIES PRI'));
ok('bank not treated as a person', !P.looksPersonal('HDFC Bank'));
ok('digits disqualify a person', !P.looksPersonal('KEESARA W01'));

// ---- DLT sender variants all normalise to one bank ----
const senders = ['VM-HDFCBK-T', 'JM-HDFCBK-S', 'AD-HDFCBK', 'JX-HDFCBK-S', 'CP-HDFCBK-T'];
ok('DLT suffixes normalise', new Set(senders.map((s) => P.senderBank(s))).size === 1,
   JSON.stringify(senders.map((s) => P.senderBank(s))));
ok('ICICI variants resolve', P.senderBank('JD-ICICIT-S') === 'ICICI', String(P.senderBank('JD-ICICIT-S')));



// ==========================================================================
// DATES. A wrong date is invisible: the amount is right, the merchant is
// right, and the transaction lands in the wrong month. Corpus auditing found
// 12,306 messages whose written date was ignored in favour of the SMS arrival
// time, because month-name-first dates were never matched.
// ==========================================================================
{
  const arrived = new Date(2026, 7, 13).getTime();
  const dates = [
    ['DD/MM/YY slash',   'Sent Rs.100 From HDFC To Rapido On 10/08/26 Ref 1', '2026-08-10'],
    ['DD-MM-YY dash',    'Rs.450 debited from a/c XX1234 on 05-08-25 to VPA x@ybl', '2025-08-05'],
    ['DD-MMM-YY',        'payment of INR 39,710.00 towards ICICI Credit Card on 02-Jul-26', '2026-07-02'],
    ['DD/MMM/YYYY',      'Rs.500 debited on 03/FEB/2023 card XX1234', '2023-02-03'],
    ['DDMMMYY squashed', 'A/C X1234 debited by 450.0 on date 05Aug25 trf to SHOP', '2025-08-05'],
    ['MMM DD, YYYY',     'payment attempt of Rs. 299.00 on Feb 24, 2025 01:11:30 PM failed', '2025-02-24'],
    ['MMM DD YYYY',      'Rs.500 debited on Aug 06 2024 to VPA x@ybl', '2024-08-06'],
    ['ISO',              'Rs.500 debited on 2025-08-05 to VPA x@ybl', '2025-08-05'],
    ['DD/MM/YYYY',       'processed payment of INR 1500.00 to Merchant X on 25/06/2026', '2026-06-25'],
  ];
  for (const [name, body, want] of dates) {
    const got = new Date(P.parseDate(body, arrived)).toISOString().slice(0, 10);
    ok(`date ${name}`, got === want, `got ${got}, want ${want}`);
  }

  // day-first, not month-first: 05/08 is 5 August in India, never 8 May
  ok('day-first convention', new Date(P.parseDate('on 05/08/25', arrived)).getMonth() === 7);
  // a message with no date must fall back to arrival, not to epoch
  ok('no date falls back to arrival', P.parseDate('no date at all here', arrived) === arrived);
  // an impossible date must not silently become something else
  const weird = P.parseDate('on 45/45/45', arrived);
  ok('impossible date rejected', weird === arrived, new Date(weird).toISOString());

  // the whole-message path, not just the helper
  const r = P.parse({ id: 1, date: arrived, address: 'JE-JIOPAY',
    body: 'Rs.299.00 debited on Feb 24, 2025 for Jio recharge. Ref 998877' });
  ok('month-first date used end to end', r.ok &&
     new Date(r.txn.date).toISOString().slice(0, 10) === '2025-02-24',
     r.ok ? new Date(r.txn.date).toISOString() : r.reason);
}

console.log(`\n${'-'.repeat(50)}\npassed=${pass}  failed=${fail}`);
if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
