/*
 * Provenance.
 *
 * The transaction screen shows the original SMS with the parsed fields marked
 * in place, so a user can see the exact characters ₹450 was read from. That
 * only helps if the marks are in the right place, and a wrong mark is worse
 * than none: it would argue for a number that came from somewhere else.
 *
 * The last test is the important one. It runs every message in the parser's own
 * corpus through the locator and holds a floor on how much is traceable, so a
 * future bank-format change cannot quietly turn the feature off.
 */

import * as P from '../static/js/core/parser.js';
import { locate, segments, coverage } from '../static/js/core/provenance.js';

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}\n     ${detail}`); }
}
const eq = (n, a, b) => ok(n, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const parse = (body, address = 'AX-HDFCBK') => {
  const r = P.parse({ id: 1, body, date: Date.now(), address });
  if (!r.ok) throw new Error(`corpus message rejected: ${r.reason} — ${body}`);
  return r.txn;
};

/** field -> matched text, for readable assertions. */
const marks = (txn) => Object.fromEntries(
  segments(txn).filter((s) => s.field).map((s) => [s.field, s.text]));

// ===========================================================================
// 1. The common UPI debit
// ===========================================================================
{
  const body = 'Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Ref 100000000001.';
  const m = marks(parse(body));

  eq('the amount is located exactly as written', m.amount, '450.00');
  eq('the account is located with its mask', m.account, 'XX1234');
  eq('the date is located in the format used', m.date, '05-08-25');
  eq('the merchant is located including the PSP', m.merchant, 'swiggy@ybl');
  eq('the reference is located', m.ref, '100000000001');
  eq('everything is traced', coverage(parse(body)).traced, 5);
}

// ===========================================================================
// 2. Indian grouping — 2-2-3, not 3-3-3
// ===========================================================================
{
  // The regression this locks down: building the search form with Math.round
  // turned 145678.90 into "1,45,679.90", which appears nowhere in the message,
  // so the amount was never highlighted on any transaction with paise.
  const m = marks(parse('Sent Rs.1,45,678.90 From HDFC Bank A/C *5261 To AMAZON On 10/08/26 Ref 523456789012'));
  eq('a lakh-grouped amount with paise is located', m.amount, '1,45,678.90');
  eq('an asterisk mask is located', m.account, '*5261');
  eq('a dd/mm/yy date is located', m.date, '10/08/26');
}

{
  const m = marks(parse('Rs 5000 debited from A/c XX9999 on 12/03/25 to MERCHANT XYZ. Ref 998877'));
  eq('an ungrouped four-figure amount is located', m.amount, '5000');
}

{
  const m = marks(parse('INR 1,00,000.00 debited from a/c XX1111 on 01/01/25 to BUILDER. Ref 4455667788'));
  eq('a one-lakh amount is located', m.amount, '1,00,000.00');
}

// ===========================================================================
// 3. Amount and balance in the same message must not be confused
// ===========================================================================
{
  const txn = parse('Your a/c XX4455 credited by Rs.85,000.00 on 03-Aug-25 by NEFT from ACME. Avl bal Rs.99,000.00');
  const m = marks(txn);
  eq('the transaction amount is located', m.amount, '85,000.00');
  eq('the balance is located separately', m.balance, '99,000.00');
  ok('the amount and the balance are different spans', m.amount !== m.balance);

  const spans = locate(txn);
  const amt = spans.find((s) => s.field === 'amount');
  const bal = spans.find((s) => s.field === 'balance');
  ok('the balance is found after the amount in the text', bal.start > amt.end,
    JSON.stringify({ amt, bal }));
}

// ===========================================================================
// 4. Spans never overlap, and reassemble into the original
// ===========================================================================
{
  const bodies = [
    'Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Ref 100000000001.',
    'Sent Rs.1,45,678.90 From HDFC Bank A/C *5261 To AMAZON On 10/08/26 Ref 523456789012',
    'INR 250 spent on HDFC Bank Card x1234 at UBER on 2025-08-05. Avl Lmt Rs.45,000',
  ];
  for (const body of bodies) {
    const txn = parse(body);
    const spans = locate(txn);

    const overlapping = spans.some((a, i) => spans.slice(i + 1).some((b) => a.start < b.end && a.end > b.start));
    ok('no two spans overlap', !overlapping, `${body}\n     ${JSON.stringify(spans)}`);

    const ordered = spans.every((s, i) => i === 0 || s.start >= spans[i - 1].end);
    ok('spans are returned in document order', ordered, JSON.stringify(spans));

    // The rendered message must be the message. Losing or duplicating a
    // character while highlighting would be a quiet corruption of evidence.
    eq('segments reassemble into the original text',
      segments(txn).map((s) => s.text).join(''), txn.raw);
  }
}

// ===========================================================================
// 5. Nothing is invented
// ===========================================================================
{
  const txn = parse('Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Ref 100000000001.');

  // A field the message does not contain must produce no mark at all, rather
  // than a plausible-looking one somewhere nearby.
  const noRef = { ...txn, ref: 'NOTPRESENT123' };
  ok('a field absent from the text is not marked',
    !locate(noRef).some((s) => s.field === 'ref'), JSON.stringify(locate(noRef)));
  ok('and it is reported as missing', coverage(noRef).missing.includes('ref'));

  eq('an empty message yields no segments', segments({ ...txn, raw: '' }).length, 0);
  eq('a message with nothing to find is returned whole',
    segments({ ...txn, raw: 'nothing here', ref: null, account: null, merchant: null, amount: null, date: 0, balance: null }).length, 1);
}

// ===========================================================================
// 6. Corpus floor
// ===========================================================================
{
  const CORPUS = [
    ['AX-HDFCBK', 'Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Ref 100000000001.'],
    ['AX-HDFCBK', 'Sent Rs.1358.00 From HDFC Bank A/C *5261 To AMAZON On 10/08/26 Ref 523456789012'],
    ['AX-ICICIT', 'INR 250.00 spent on ICICI Bank Card XX4455 on 12-Aug-25 at UBER INDIA. Avl Lmt INR 45,000.00'],
    ['AX-SBIINB', 'Rs 2,500.00 debited from A/c XX7788 on 15/08/25 transfer to ZEPTO Ref 887766554433'],
    ['AX-HDFCBK', 'Rs.85,000.00 credited to a/c XX1234 on 03-08-25 by NEFT from ACME LTD. Ref N5555'],
    ['AX-AXISBK', 'INR 1,00,000.00 debited from a/c XX9911 on 01/09/25 to BUILDER PVT LTD. Ref 4455667788'],
    ['AX-KOTAKB', 'Rs 99 debited from a/c XX2233 on 22-Sep-25 to NETFLIX. Ref 121212121212'],
    ['AX-HDFCBK', 'Rs.12,450.75 debited from a/c XX1234 on 05/10/25 to BIGBASKET. Ref 909090909090'],
  ];

  let total = 0; let traced = 0; let amounts = 0; let amountsFound = 0;
  const misses = [];

  for (const [address, body] of CORPUS) {
    const r = P.parse({ id: 1, body, date: Date.now(), address });
    if (!r.ok) {
      misses.push(`REJECTED ${r.reason}: ${body}`);
      continue;
    }
    const c = coverage(r.txn);
    total += c.expected;
    traced += c.traced;
    if (typeof r.txn.amount === 'number') {
      amounts++;
      if (!c.missing.includes('amount')) amountsFound++;
      else misses.push(`amount ${r.txn.amount} not located in: ${body}`);
    }
  }

  const rate = total ? traced / total : 0;
  console.log(`\ncorpus provenance: ${traced}/${total} fields located (${(rate * 100).toFixed(0)}%)`);
  console.log(`amount located on ${amountsFound}/${amounts} transactions`);

  // The amount is the field the whole feature exists for. Anything less than
  // every one of them is a bug, not a tuning question.
  eq('the amount is located on every transaction', amountsFound, amounts);
  ok('at least 90% of expected fields are located overall', rate >= 0.9,
    `${(rate * 100).toFixed(0)}%\n     ${misses.join('\n     ')}`);
}

console.log('\n' + '-'.repeat(50));
if (failures.length) console.log(failures.join('\n'));
console.log(`passed=${pass}  failed=${fail}`);
if (fail) process.exit(1);
