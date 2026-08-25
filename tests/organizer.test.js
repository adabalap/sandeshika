/*
 * Organiser tests. Every message below was observed in a real Indian inbox.
 * Misfiling is the failure mode that makes an organiser useless, so each case
 * asserts the exact tab.
 */
import * as P from '../static/js/core/parser.js';
global.SandeshikaParser = P;
import * as O from '../static/js/core/organizer.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}  ${d}`); } };
const T = new Date(2026, 7, 10).getTime();
const sms = (body, address = 'AX-HDFCBK') => ({ id: 1, body, date: T, address });

// ------------------------------ tab routing ------------------------------
const cases = [
  // real spending -> Transactions
  ['Sent Rs.1358.00\nFrom HDFC Bank A/C *5261\nTo Rapido\nOn 10/08/26\nRef 127698382602', O.TAB.TRANSACTIONS],
  ['Rs.450 debited from a/c XX1234 to VPA swiggy@ybl on 05-08-25. Ref 512345678901', O.TAB.TRANSACTIONS],
  ['Rs.85,000.00 credited to a/c XX1234 on 03-07-25 by NEFT from ACME TECH. Ref N9999', O.TAB.TRANSACTIONS],

  // obligations -> Bills
  ['E-Statement Generated! For HDFC Bank Credit Card 0541.Due date:08/NOV/2026.Total Due:Rs.38968.Min Due:Rs.1950.', O.TAB.BILLS],
  ['Your HDFC Credit Card bill of Rs.12,450 is due on 15-Aug-26. Minimum amount due Rs.600.', O.TAB.BILLS],
  ['Your Postpaid connection will be DISCONNECTED! Your bill payment for Jio Number 9999999999 is overdue since 20-Jun-26.', O.TAB.BILLS],
  ['Rs.999 will be debited on 10-Aug-26 for your Netflix autopay', O.TAB.BILLS],
  ['Immediate Action:Your HDFC Bank Credit Card XX0541 payment is overdue.Details on how to pay: REDACTED', O.TAB.BILLS],

  // updates
  ['Your OTP is 4506 for txn of Rs.4506.00. Do not share with anyone.', O.TAB.UPDATES],
  ['Delivered! Your HDFC Bank Credit Card Awb -33487873145 has been delivered.', O.TAB.UPDATES],
  ['PNR 2456789012 confirmed. Train 12723 departure 06:15 from SC. Seat no B4-32.', O.TAB.UPDATES],
  ['UPDATE:Bal in HDFC Bank A/c XX5261 has gone below minimum limit of INR 5,000.00.', O.TAB.UPDATES],
  ['Scheduled Maintenance\nSome HDFC Bank services will be unavailable on 13 Sep 26', O.TAB.UPDATES],
  ['You logged into your Airtel Payments Bank account from samsung SM-S948B', O.TAB.UPDATES],
  ['Payee GCET added. Transfer funds after 30 mins.', O.TAB.UPDATES],

  // promotions
  ['Convert your ICICI Bank Credit Card outstanding amount into easy EMIs. T&Cs.', O.TAB.PROMOTIONS],
  ['238 Reward Points credited to your HDFC Bank Credit Card ending 0541 towards Weekday Dining Bonus.', O.TAB.PROMOTIONS],
  ['FLAT 50% SALE! Shop now and save Rs 2000. Click here to apply now.', O.TAB.PROMOTIONS],
  ['Dear Customer, Your 27.6 Hearty Points Balance is Expiring on 30-Apr-2026. Visit Nearest KS Bakers store to redeem.', O.TAB.PROMOTIONS],

  // spam
  ['Trade Summary():- K1 is selecting a group of capable agents who can earn Rs 5,000 - Rs 10,000 per day, please contact:wa.me/918016841598', O.TAB.SPAM],
  ['Congratulations! You have won a lottery of Rs 25,00,000. Claim now.', O.TAB.SPAM],
];
for (const [body, want] of cases) {
  const r = O.classify(sms(body));
  ok(`tab: ${body.slice(0, 44).replace(/\n/g, ' ')}`, r.tab === want, `got ${r.tab} (${r.reason})`);
}

// personal: a numeric sender is a human
{
  const r = O.classify(sms('Reached home, call me when free', '+919876543210'));
  ok('numeric sender -> personal', r.tab === O.TAB.PERSONAL, `got ${r.tab}`);
  const b = O.classify(sms('Rs.450 debited from a/c XX1234 to VPA swiggy@ybl on 05-08-25', 'AX-HDFCBK'));
  ok('DLT sender never personal', b.tab !== O.TAB.PERSONAL);
}

// OTP codes must never be surfaced
{
  const r = O.classify(sms('Your OTP is 4506 for txn of Rs.4506.00. Do not share.'));
  ok('OTP marked sensitive', r.sensitive === true);
  ok('OTP subtype set', r.subtype === 'otp');
}

// spam must stay narrow — a real message must never be hidden
const notSpam = [
  'Sent Rs.100.00\nFrom HDFC Bank A/C *5261\nTo Balaji Chat Bhandar\nOn 06/05/26\nRef 104357010846',
  'Your HDFC Credit Card bill of Rs.12,450 is due on 15-Aug-26.',
  'Your OTP is 4506. Do not share.',
  'Rs.85,000.00 credited to a/c XX1234 by NEFT from ACME TECH.',
];
for (const b of notSpam) {
  ok(`not spam: ${b.slice(0, 40).replace(/\n/g, ' ')}`, O.classify(sms(b)).tab !== O.TAB.SPAM);
}

// ------------------------------ bill extraction ------------------------------
{
  const b = O.extractBill(sms('E-Statement Generated! For HDFC Bank Credit Card 0541.Due date:08/NOV/2026.Total Due:Rs.38968.Min Due:Rs.1950.'));
  ok('bill extracted', !!b);
  ok('bill amount is the total due', b && b.amount === 38968, String(b && b.amount));
  ok('minimum due captured', b && b.minimumDue === 1950, String(b && b.minimumDue));
  ok('due date is 08 Nov 2026', b && new Date(b.dueAt).getMonth() === 10 && new Date(b.dueAt).getDate() === 8,
     b ? new Date(b.dueAt).toDateString() : '');
  ok('kind is credit-card', b && b.kind === 'credit-card', b && b.kind);
  ok('issuer resolved', b && b.issuer === 'HDFC', b && b.issuer);
}
{
  const b = O.extractBill(sms('Your HDFC Credit Card bill of Rs.12,450 is due on 15-Aug-26. Minimum amount due Rs.600.'));
  ok('due amount not the minimum', b && b.amount === 12450, String(b && b.amount));
  ok('due date 15 Aug', b && new Date(b.dueAt).getDate() === 15, b ? new Date(b.dueAt).toDateString() : '');
}
{
  // Statement date and due date both present: the reminder must use the DUE one.
  const b = O.extractBill(sms('Statement dated 20/07/2026 for card XX0541. Total Due Rs.5,000. Due date 08/08/2026.'));
  ok('picks due date, not statement date', b && new Date(b.dueAt).getDate() === 8,
     b ? new Date(b.dueAt).toDateString() : 'none');
}
{
  const b = O.extractBill(sms('Immediate Action:Your HDFC Bank Credit Card XX0541 payment is overdue. Pay Rs.4910 now'));
  ok('overdue flagged', b && b.overdue === true);
}
ok('no bill from a plain promo', O.extractBill(sms('Shop now and save big! T&C apply')) === null);

// duplicate reminders for one bill collapse
{
  const a = O.extractBill(sms('Your HDFC Credit Card bill of Rs.12,450 is due on 15-Aug-26.'));
  const c = O.extractBill(sms('Reminder: HDFC Credit Card bill of Rs.12,450 due on 15-Aug-26. Pay now'));
  ok('same bill -> same fingerprint', a && c && a.fingerprint === c.fingerprint,
     `${a && a.fingerprint} vs ${c && c.fingerprint}`);
}

// days-until arithmetic
{
  const now = new Date(2026, 7, 10).getTime();
  ok('5 days ahead', O.daysUntil(new Date(2026, 7, 15).getTime(), now) === 5);
  ok('overdue is negative', O.daysUntil(new Date(2026, 7, 5).getTime(), now) === -5);
  ok('today is zero', O.daysUntil(new Date(2026, 7, 10, 23).getTime(), now) === 0);
  ok('null date safe', O.daysUntil(null, now) === null);
}


// ==========================================================================
// Whole-inbox behaviour: run the classifier over a realistic mixed inbox and
// assert the distribution, since a classifier can pass every unit case and
// still funnel everything into one tab.
// ==========================================================================
{
  const mixed = [
    ...Array(20).fill('Sent Rs.250.00\nFrom HDFC Bank A/C *5261\nTo Rapido\nOn 10/08/26\nRef 1276'),
    ...Array(8).fill('Your OTP is 4506 for txn of Rs.4506.00. Do not share.'),
    ...Array(6).fill('UPDATE:Bal in HDFC Bank A/c XX5261 has gone below minimum limit of INR 5,000.00.'),
    ...Array(4).fill('Convert your ICICI Bank Credit Card outstanding into easy EMIs. T&Cs.'),
    ...Array(3).fill('Your HDFC Credit Card bill of Rs.12,450 is due on 15-Aug-26. Minimum amount due Rs.600.'),
    'Trade Summary():- earn Rs 5,000 - Rs 10,000 per day contact:wa.me/918016841598',
  ].map((b, i) => sms(b));
  const tally = {};
  mixed.forEach((m) => { const c = O.classify(m); tally[c.tab] = (tally[c.tab] || 0) + 1; });

  ok('transactions tab populated', tally.transactions === 20, JSON.stringify(tally));
  ok('bills tab populated', tally.bills === 3, JSON.stringify(tally));
  ok('promotions separated', tally.promotions === 4, JSON.stringify(tally));
  ok('updates holds OTP + service', tally.updates === 14, JSON.stringify(tally));
  ok('exactly one spam', tally.spam === 1, JSON.stringify(tally));
  ok('nothing lost', Object.values(tally).reduce((a, b) => a + b, 0) === mixed.length);
  // the failure mode a classifier hides behind: everything in one bucket
  ok('no single tab swallows everything', Math.max(...Object.values(tally)) < mixed.length * 0.8,
     JSON.stringify(tally));
}

// bills dedupe across repeated reminders
{
  const reminders = [
    'Your HDFC Credit Card bill of Rs.12,450 is due on 15-Aug-26.',
    'Reminder: HDFC Credit Card bill of Rs.12,450 due on 15-Aug-26. Pay now',
    'Final reminder! HDFC Credit Card bill of Rs.12,450 due on 15-Aug-26.',
  ].map((b) => O.extractBill(sms(b))).filter(Boolean);
  ok('three reminders extract', reminders.length === 3);
  ok('collapse to one obligation', new Set(reminders.map((b) => b.fingerprint)).size === 1);
}

// a different card must not collapse into the same bill
{
  const a = O.extractBill(sms('HDFC Credit Card XX0541 bill of Rs.5,000 due on 15-Aug-26.'));
  const b = O.extractBill(sms('HDFC Credit Card XX2003 bill of Rs.5,000 due on 15-Aug-26.'));
  ok('different accounts stay separate', a.fingerprint !== b.fingerprint,
     `${a.fingerprint} vs ${b.fingerprint}`);
}


// ==========================================================================
// SELF-TRANSFERS. One movement between the user's own accounts produces a
// debit AND a credit. Counted naively it inflates spending and income by the
// same amount, so the net looks right while every component is wrong.
// ==========================================================================
{
  const wallets = [
    'HDFC NETC FASTag 19000009944 has been recharged with Rs.1000.00',
    'Rs.1000.00 credited to your HDFC NETC FASTag wallet',
    'Rs.500 debited from a/c XX1234 for Paytm wallet top-up',
    'Rs.5000 debited from a/c XX1234 transferred to your HDFC UPI account',
    'Rs.5000.00 credited to a/c XX5678 by transfer from a/c XX1234',
  ];
  for (const b of wallets) {
    const r = P.parse(sms(b));
    ok(`wallet/self-transfer: ${b.slice(0, 44)}`, r.ok && r.txn.kind === 'transfer',
       r.ok ? `kind=${r.txn.kind}` : `rejected ${r.reason}`);
  }
  // and real money still counts
  const spend = P.parse(sms('Rs.450 debited from a/c XX1234 to VPA swiggy@ybl on 05-08-25'));
  ok('ordinary spend unaffected', spend.txn.kind === 'expense');
  const salary = P.parse(sms('Rs.85,000.00 credited to a/c XX1234 by NEFT from ACME TECH'));
  ok('salary still income', salary.txn.kind === 'income');
}

// pairing, for the cases the wording does not reveal
{
  const day = new Date(2026, 7, 14).getTime();
  const mk = (o) => Object.assign({ fingerprint: Math.random().toString(36).slice(2),
    currency: 'INR', merchant: null, account: null }, o);
  const set = [
    mk({ kind: 'expense', amount: 5000, date: day, account: '1234' }),
    mk({ kind: 'income', amount: 5000, date: day + 36e5, account: '5678' }),
    mk({ kind: 'expense', amount: 7868, date: day, merchant: 'Rajdhani Rice Depot', account: '1234' }),
    mk({ kind: 'income', amount: 85000, date: day, merchant: 'ACME TECH', account: '1234' }),
    mk({ kind: 'expense', amount: 499, date: day, merchant: 'MYNTRA', account: '1234' }),
    mk({ kind: 'income', amount: 499, date: day + 72e5, merchant: 'MYNTRA', account: '1234' }),
  ];
  const pairs = O.findTransferPairs(set);
  ok('unnamed debit/credit pair detected', pairs.length === 1 && pairs[0].amount === 5000,
     JSON.stringify(pairs.map((p) => p.amount)));
  ok('a real refund is NOT paired away', !pairs.some((p) => p.amount === 499));
  ok('salary is NOT paired away', !pairs.some((p) => p.amount === 85000));

  // same account on both sides is not a transfer between accounts
  const same = O.findTransferPairs([
    mk({ kind: 'expense', amount: 300, date: day, account: '1234' }),
    mk({ kind: 'income', amount: 300, date: day + 36e5, account: '1234' }),
  ]);
  ok('same account is not paired', same.length === 0);

  // and a week apart is not one movement
  const far = O.findTransferPairs([
    mk({ kind: 'expense', amount: 300, date: day, account: '1234' }),
    mk({ kind: 'income', amount: 300, date: day + 7 * 864e5, account: '5678' }),
  ]);
  ok('far apart in time is not paired', far.length === 0);
}

console.log(`\n${'-'.repeat(50)}\npassed=${pass}  failed=${fail}`);
if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
