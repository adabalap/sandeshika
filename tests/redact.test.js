/*
 * Redaction.
 *
 * The output of this module is meant to be copied out of the app and pasted
 * into a bug report, so a miss here is a real disclosure rather than a wrong
 * number on a screen. The tests are correspondingly blunt: take real Indian
 * bank SMS shapes, redact them, and assert that specific values are gone and
 * specific structure survives.
 */

import { redact, verify, buildDriftReport } from '../static/js/core/redact.js';

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}\n     ${detail}`); }
}
const gone = (name, out, needle) => ok(name, !out.includes(needle), `"${needle}" survived in: ${out}`);
const kept = (name, out, needle) => ok(name, out.includes(needle), `"${needle}" was lost from: ${out}`);

const r = (s) => redact(s).text;

// ===========================================================================
// 1. Real message shapes
// ===========================================================================
{
  const src = 'Sent Rs.1358.00 From HDFC Bank A/C *5261 To Mr Gadipudi Khadri On 10/08/26 Ref 523456789012. Not You? Call 18002586161';
  const out = r(src);

  gone('the amount is replaced', out, '1358');
  gone('the account tail is replaced', out, '5261');
  gone('the payee name is replaced', out, 'Gadipudi');
  gone('the reference number is replaced', out, '523456789012');
  gone('the helpline is replaced', out, '18002586161');

  kept('the bank name survives', out, 'HDFC Bank');
  kept('the A/C keyword survives', out, 'A/C');
  kept('the masking style survives', out, '*9999');
  kept('the rupee notation survives', out, 'Rs.');
  kept('the Ref keyword survives', out, 'Ref');
  ok('a pseudonym replaces the name', /PERSON_[0-9a-f]{4}/.test(out), out);
  ok('the amount keeps its shape', /Rs\.9999\.99/.test(out), out);
}

{
  const src = 'Rs.450.00 debited from a/c XX1234 on 05-08-25 to VPA swiggy@ybl. Ref 100000000001. Not you? call 18001234567';
  const out = r(src);

  gone('the debited amount is replaced', out, '450.00');
  gone('the account digits are replaced', out, '1234');
  kept('the PSP handle survives so routing can be debugged', out, '@ybl');
  ok('the VPA identity is pseudonymised', /VPA_[0-9a-f]{4}@ybl/.test(out), out);
  kept('the debited keyword survives', out, 'debited');
}

{
  // A phone-number VPA must not be turned into a pseudonym that hides the fact
  // that it WAS a phone number — that shape is the whole reason the parser
  // sends these to review.
  const out = r('Paid Rs.200 to 9876543210@paytm on 01/02/25');
  gone('the mobile number in a VPA is replaced', out, '9876543210@paytm');
  kept('but the phone-shaped handle is still visibly a phone', out, '9999999999@paytm');
}

{
  const src = 'Dear Ramesh Kumar, your a/c XX4455 is credited by Rs.85,000.00 on 03-Aug-25 by NEFT from ACME TECHNOLOGIES PVT LTD. Avl bal Rs.1,45,678.90';
  const out = r(src);
  gone('the greeting name is replaced', out, 'Ramesh');
  gone('the credited amount is replaced', out, '85,000');
  gone('the balance is replaced', out, '1,45,678.90');
  kept('the NEFT channel survives', out, 'NEFT');
  kept('the Indian grouping shape survives', out, 'Rs.9,99,999.99');
}

// ===========================================================================
// 2. High-risk identifiers
// ===========================================================================
{
  gone('email addresses go', r('write to raju.patel@gmail.com'), 'raju.patel@gmail.com');
  gone('PAN goes', r('PAN ABCDE1234F linked'), 'ABCDE1234F');
  gone('Aadhaar goes', r('Aadhaar 1234 5678 9012 seeded'), '1234 5678 9012');
  gone('IFSC goes', r('IFSC HDFC0001234'), 'HDFC0001234');
  gone('a card number goes', r('card 4111111111111111 used'), '4111111111111111');
  gone('a bare mobile goes', r('call me on 9876543210'), '9876543210');
  gone('a +91 mobile goes', r('sms +91 9812345678 now'), '9812345678');
  gone('a URL path goes', r('click https://hdfcbank.co/x/aB9tokenZ now'), 'aB9tokenZ');
  kept('but the fact a link existed survives', r('click https://x.co/tok now'), 'REDACTED.LINK');
}

// ===========================================================================
// 3. Dates are shifted, not destroyed
// ===========================================================================
{
  const out = r('txn on 10/08/26 and again on 12-08-26 and on 03-Aug-25 and Feb 24, 2025');

  ok('the dd/mm/yy format survives', /\b\d{2}\/\d{2}\/\d{2}\b/.test(out), out);
  ok('the dd-mm-yy format survives', /\b\d{2}-\d{2}-\d{2}\b/.test(out), out);
  ok('the dd-Mon-yy format survives', /\b\d{2}-[A-Z][a-z]{2}-\d{2}\b/.test(out), out);
  ok('the Mon dd, yyyy format survives', /\b[A-Z][a-z]{2} \d{2}, \d{4}\b/.test(out), out);

  gone('the actual date is not the real one', out, '10/08/26');

  // The gap between two dates is what makes a duplicate-detection bug
  // reproducible, so a constant offset must preserve it.
  const asDate = (s) => {
    const [, d, mo, y] = s.match(/\b(\d{2})\/(\d{2})\/(\d{2})\b/);
    return new Date(2000 + Number(y), Number(mo) - 1, Number(d)).getTime();
  };
  const a = r('on 01/03/25');
  const b = r('on 11/03/25');
  ok('the interval between two dates is preserved',
    Math.round((asDate(b) - asDate(a)) / 864e5) === 10, `${a} vs ${b}`);

  ok('an impossible date is left alone rather than mangled',
    r('ref 99/99/99 here').includes('99/99/99'));
}

// ===========================================================================
// 4. Structure the parser author actually needs
// ===========================================================================
{
  const out = r('Your HDFC Bank Credit Card 0541 statement is generated. Total Due:Rs.12,450.00 Min Due:Rs.600.00 Due date:05/09/26');
  kept('Total Due survives', out, 'Total Due');
  kept('Min Due survives', out, 'Min Due');
  kept('Due date survives', out, 'Due date');
  gone('the total is replaced', out, '12,450');
  gone('the minimum is replaced', out, '600.00');
  ok('the two amounts stay distinguishable by digit count',
    /Total Due:Rs\.99,999\.99/.test(out) && /Min Due:Rs\.999\.99/.test(out), out);
}

{
  // Instruction text is not a name. Pseudonymising it destroys the template.
  const out = r('To track your application click here');
  kept('an instruction beginning with "to" is left intact', out, 'track your application');

  const out2 = r('Update your KYC to continue using UPI');
  kept('a service notice is left readable', out2, 'KYC');
}

{
  const out = r('OTP is 456789 for txn of Rs.9999.00. Do not share with anyone.');
  kept('the OTP keyword survives so the reject rule can be checked', out, 'OTP');
  kept('the do-not-share wording survives', out, 'Do not share');
  gone('the OTP code itself is gone', out, '456789');
  ok('the OTP keeps its digit count', /OTP is 999999/.test(out), out);
}

// ===========================================================================
// 5. Pseudonyms are stable within a session
// ===========================================================================
{
  const a = r('Sent Rs.100 To Gadipudi Khadri On 01/01/25');
  const b = r('Sent Rs.200 To Gadipudi Khadri On 02/01/25');
  const tagOf = (s) => (s.match(/PERSON_[0-9a-f]{4}/) || [])[0];
  ok('the same person gets the same pseudonym twice', tagOf(a) === tagOf(b), `${a}\n     ${b}`);

  const c = r('Sent Rs.100 To Someone Else Entirely On 01/01/25');
  ok('a different person gets a different pseudonym', tagOf(a) !== tagOf(c), `${a}\n     ${c}`);
}

// ===========================================================================
// 6. verify() catches what the rules miss
// ===========================================================================
{
  ok('clean output produces no warnings', verify(r('Rs.100 debited from a/c XX1234')).length === 0,
    JSON.stringify(verify(r('Rs.100 debited from a/c XX1234'))));

  ok('a raw email is reported', verify('contact me at a@b.com').includes('an email address'));
  ok('a raw phone is reported', verify('call 9876543210').includes('a phone number'));
  ok('a raw PAN is reported', verify('PAN ABCDE1234F').includes('a PAN'));

  // The redactor's own placeholders must never be reported, or the warning
  // becomes noise and stops being read.
  const clean = r('Sent Rs.1358.00 From HDFC Bank A/C *5261 To Mr A B Kumar On 10/08/26 Ref 5234567890');
  ok('placeholders are not mistaken for leaks', verify(clean).length === 0,
    `${clean}\n     -> ${JSON.stringify(verify(clean))}`);
}

// ===========================================================================
// 7. Empty and hostile input
// ===========================================================================
{
  ok('empty input is safe', r('') === '');
  ok('null is safe', redact(null).text === '');
  ok('undefined is safe', redact(undefined).text === '');
  ok('a very long message does not hang',
    redact('Rs.100 to raju@ybl '.repeat(400)).text.length > 0);
}

// ===========================================================================
// 8. The shareable report
// ===========================================================================
{
  const rows = [
    { sender: 'AX-HDFCBK', reason: 'no-amount', body: 'Sent Rs.1358.00 From HDFC Bank A/C *5261 To Mr Gadipudi Khadri On 10/08/26', count: 4 },
    { sender: 'VM-ICICIT', reason: 'no-direction', body: 'Dear Ramesh, call 9876543210 about a/c XX9911', count: 1 },
  ];
  const report = buildDriftReport(rows, { build: '2.1.0' });
  const t = report.text;

  gone('no name reaches the report', t, 'Gadipudi');
  gone('no second name reaches the report', t, 'Ramesh');
  gone('no phone reaches the report', t, '9876543210');
  gone('no amount reaches the report', t, '1358');
  gone('no account tail reaches the report', t, '5261');
  gone('the operator prefix is stripped from the sender', t, 'AX-HDFCBK');

  kept('the bank code survives so the template can be identified', t, 'HDFCBK');
  kept('the rejection reason survives', t, 'no-amount');
  kept('how often it was seen survives', t, '4×');
  kept('the build is stated', t, '2.1.0');
  kept('the header says redaction happened', t, 'REDACTED ON DEVICE');
  kept('the header tells the reader to check anyway', t, 'Read it anyway');
  kept('what was replaced is summarised', t, 'Replaced:');

  ok('the whole report passes verification', verify(t).length === 0,
    JSON.stringify(verify(t)) + '\n' + t);
  ok('the report counts what it replaced', (report.counts.amount || 0) > 0,
    JSON.stringify(report.counts));

  const empty = buildDriftReport([], { build: '2.1.0' });
  ok('an empty report is still well-formed', empty.text.includes('0 templates'), empty.text);
}

// ===========================================================================
// 9. Regressions from a real 5,000-message inbox
//
// Every case below leaked, or over-redacted, in a report generated from an
// actual phone. They are the reason the name rules were rewritten.
// ===========================================================================
{
  // THE LEAK THAT MATTERED: HDFC opens with the account holder's name alone on
  // the first line. No preposition-anchored or title-anchored rule can see it.
  const salutation = r('Adabalaphani,\nGood news!\nYou can avail HDFC Bank Loan on CreditCard No. xx0541');
  gone("the user's own name in a salutation", salutation, 'Adabalaphani');
  ok('and it becomes a pseudonym', /PERSON_[0-9a-f]{4},/.test(salutation), salutation);

  // Telephone shapes that all survived the first pass.
  gone('a 91-prefixed number without a plus', r('Not You ? Call 9122616061'), '9122616061');
  gone('an STD landline with spaced hyphen', r('Contact your RM @ 080 - 68111518.'), '68111518');
  gone('an eleven-digit toll-free', r('call at 18602585000 or download'), '18602585000');
  gone('a landline with a leading zero', r('To vote call on 01140132102.'), '01140132102');
  gone('an SMS shortcode', r('To opt out, SMS STOP to 5676766 in 5 days'), '5676766');

  // Unlabelled long identifiers.
  gone('a FASTag wallet id', r('FASTag wallet id 19000009944770 Avl. Bal: Rs. 84.50'), '19000009944770');
  gone('a biller bill number', r('TSSPDCL Bill 101837804 cannot be AutoPaid'), '101837804');
  gone('the tail of a long masked account',
    r('Your HDFC Bank A/c XXXXXXXXXX9601 is Dormant.'), '9601');

  // A twelve-digit UPI reference is NOT an Aadhaar number. Labelling it as one
  // was wrong twice: the wrong field name, and the digit-count shape — the
  // thing a parser bug report is for — destroyed.
  const ref = r('UPI transaction reversed (UPI Ref no. 214859673021)');
  gone('the reference value is replaced', ref, '214859673021');
  ok('but it is not mislabelled as an Aadhaar', !ref.includes('AADHAAR'), ref);
  ok('and its length survives', /999999999999/.test(ref), ref);

  ok('a real Aadhaar in written form is still caught',
    r('Aadhaar 1234 5678 9012 seeded').includes('AADHAAR_REDACTED'));

  // OVER-REDACTION. The generic capitalised-run rule fired 118 times on one
  // inbox and shredded the template vocabulary the report exists to convey.
  const trai = r('This is as per the Telecom Regulatory Authority of India (TRAI) guidelines.');
  kept('a regulator name survives', trai, 'Telecom Regulatory Authority of India');
  ok('no pseudonym is invented for it', !/PERSON_/.test(trai), trai);

  const dormant = r('Attention! Your HDFC Bank A/c is Dormant. Please visit your nearest HDFC Branch with valid KYC documents');
  kept('service vocabulary survives', dormant, 'Dormant');
  kept('KYC survives', dormant, 'KYC');
  ok('no pseudonym in a dormancy notice', !/PERSON_/.test(dormant), dormant);

  const declined = r('Declined! Rs.1500.00 on HDFC Bank Credit Card xx0541. Reason: Online use off.');
  kept('the rejection keyword survives', declined, 'Declined');
  ok('no pseudonym in a decline notice', !/PERSON_/.test(declined), declined);

  const stop = r('To opt out, SMS STOP to 5676766 in 5 days');
  kept('an SMS command survives', stop, 'SMS STOP');
}

console.log('\n' + '-'.repeat(50));
if (failures.length) console.log(failures.join('\n'));
console.log(`passed=${pass}  failed=${fail}`);
if (fail) process.exit(1);
