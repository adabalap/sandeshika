/*
 * Boot smoke test.
 *
 * Loads the real index.html into a headless DOM, points the app at a mock
 * Medha, imports the real entry point, and checks that the whole thing starts
 * and paints correct figures.
 *
 * This is the test the old build most needed and did not have. `Transport` was
 * undefined and every launch fell through to Setup with a misleading error;
 * nothing in a unit test could see it, because the failure only existed once
 * the modules were assembled and run together. Anything of that shape now fails
 * here instead of on the phone.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}\n     ${detail}`); }
}
const eq = (n, a, b) => ok(n, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// ---------------------------------------------------------------------------
// A small, believable inbox
// ---------------------------------------------------------------------------
const DAY = 864e5;
const NOW = Date.now();
const at = (daysAgo, hour = 10) => {
  const d = new Date(NOW - daysAgo * DAY);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};
const ddmmyy = (ms) => {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getFullYear()).slice(2)}`;
};

let mid = 1;
const sms = (address, body, date) => ({ id: mid++, address, body, date });

const INBOX = [
  // three real debits today
  sms('AX-HDFCBK', `Rs.450.00 debited from a/c XX1234 on ${ddmmyy(at(0))} to VPA swiggy@ybl. Ref 100000000001.`, at(0, 9)),
  sms('AX-HDFCBK', `Rs.1200.00 debited from a/c XX1234 on ${ddmmyy(at(0))} to VPA bigbasket@ybl. Ref 100000000002.`, at(0, 11)),
  sms('AX-HDFCBK', `Rs.350.00 debited from a/c XX1234 on ${ddmmyy(at(0))} to VPA uber@axis. Ref 100000000003.`, at(0, 18)),
  // salary
  sms('AX-HDFCBK', `Rs.85,000.00 credited to a/c XX1234 on ${ddmmyy(at(3))} by NEFT from ACME TECHNOLOGIES. Ref N55555`, at(3)),
  // noise that must never become money
  sms('VM-HDFCBK', 'Your OTP is 4506 for txn of Rs.9999.00. Do not share with anyone.', at(0, 12)),
  sms('AD-HDFCBK', `Avl bal in a/c XX1234 is Rs.45,678.90 as on ${ddmmyy(at(0))}`, at(0, 13)),
  sms('AX-ICICIT', 'Convert your ICICI Bank Credit Card outstanding into easy EMIs. T&Cs apply.', at(1)),
  // a registered bank sender in a format the parser does not know: this is
  // what must reach the drift panel, redacted.
  /*
   * Genuine drift: a financial sender, a reject reason outside EXPECTED_NOISE,
   * AND wording the organizer cannot place either. Anything the organizer
   * recognises — a bill, a service notice, an offer — is deliberately no
   * longer reported, since that is what buried the real signal under 94
   * entries on a live inbox.
   */
  sms('AX-HDFCBK', 'Amt Rs.1358.00 twds HDFC Bank A/C *5261 vide Mr Gadipudi Khadri dt 10/08/26 Ref 523456789012 Call 9876543210', at(4)),
  // a bill
  sms('MD-HDFCBK', `E-Statement Generated! For HDFC Bank Credit Card 0541. Due date:${ddmmyy(at(-10))}.Total Due:Rs.12,450.Min Due:Rs.600`, at(2)),
];

const store = new Map();

/** Stands in for Medha behind the Flask proxy. */
async function mockFetch(url, opts = {}) {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const json = (body, status = 200) => ({
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => body,
  });

  if (u === '/config.json') {
    return json({
      app: 'Sandeshika', version: '2.0.0', mock: false,
      medhaUrl: 'http://127.0.0.1:8001', defaultMedhaUrl: 'http://127.0.0.1:8001',
      tokenConfigured: true, tokenPreview: 'abc123…4444', tokenSource: 'saved',
      urlSource: 'saved', envTokenPresent: false, installable: true,
    });
  }

  const p = u.replace(/^\/api/, '').split('?')[0];
  const q = new URLSearchParams(u.includes('?') ? u.slice(u.indexOf('?') + 1) : '');

  if (p === '/health') return json({ status: 'ok', modelLoaded: true, backend: 'test' });
  if (p === '/connectors/sms/status') {
    return json({ supported: true, canRead: true, totalMessages: INBOX.length });
  }
  if (p === '/connectors/sms/messages') {
    const before = Number(q.get('before') || 0);
    const since = Number(q.get('since') || 0);
    const limit = Number(q.get('limit') || 50);
    let out = INBOX.slice().sort((a, b) => b.date - a.date);
    if (before) out = out.filter((m) => m.date < before);
    if (since) out = out.filter((m) => m.date > since);
    return json({ messages: out.slice(0, limit), count: out.length });
  }
  if (p === '/store/bulk') {
    const items = JSON.parse(opts.body).items;
    for (const i of items) store.set(i.key, i.value);
    return json({ written: items.length });
  }
  if (p === '/store') {
    const prefix = q.get('prefix') || '';
    const rows = [...store.entries()].filter(([k]) => k.startsWith(prefix));
    return json({ prefix, total: rows.length, items: rows.map(([key, value]) => ({ key, value })) });
  }
  if (p.startsWith('/store/')) {
    const key = decodeURIComponent(p.slice('/store/'.length));
    if (method === 'PUT') { store.set(key, opts.body); return json({ ok: true }); }
    if (method === 'DELETE') { store.delete(key); return json({ deleted: true }); }
    if (store.has(key)) return json(JSON.parse(store.get(key)));
    return json({ error: 'no such key' }, 404);
  }
  if (p === '/generate') return json({ text: 'other', tokens: 1 });
  return json({ error: 'unhandled ' + p }, 404);
}

// ---------------------------------------------------------------------------
// Stand up the DOM
// ---------------------------------------------------------------------------
const html = fs.readFileSync(path.join(ROOT, 'static', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'http://localhost:5000/', pretendToBeVisual: true });

const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
// Node 22 exposes navigator as a getter-only global, so it is defined rather
// than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: window.navigator, configurable: true, writable: true,
});
globalThis.location = window.location;
globalThis.Blob = window.Blob;
globalThis.URL = window.URL;
globalThis.confirm = () => true;
globalThis.alert = () => {};
// jsdom has no layout, so scrollTo is unimplemented and prints to stderr on
// every view change. The app's use of it is cosmetic.
window.scrollTo = () => {};
globalThis.fetch = mockFetch;
window.fetch = mockFetch;

const consoleErrors = [];
const realError = console.error;
console.error = (...a) => { consoleErrors.push(a.map(String).join(' ')); };
const consoleWarns = [];
console.warn = (...a) => { consoleWarns.push(a.map(String).join(' ')); };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let bootThrew = null;
try {
  await import('../static/js/main.js');
} catch (e) {
  bootThrew = e;
}
// Let boot()'s async chain settle.
await new Promise((r) => setTimeout(r, 150));

console.error = realError;

const $ = (s) => window.document.querySelector(s);
const text = (s) => ($(s) ? $(s).textContent.trim() : '<<missing>>');

ok('the app boots without throwing', bootThrew === null, String(bootThrew && bootThrew.stack));

// The exact failure mode of the previous build: a ReferenceError swallowed by
// boot's try/catch, leaving the user on Setup.
const refErrors = consoleErrors.filter((e) => /ReferenceError|is not defined/.test(e));
ok('no ReferenceError during boot', refErrors.length === 0, refErrors.join('\n'));

// setHtml/setText warn when an element id is absent, which is how a renamed
// element would otherwise disappear silently.
const domWarns = consoleWarns.filter((w) => /no element matches/.test(w));
ok('every element the views wrote to was found', domWarns.length === 0, domWarns.join('\n'));

ok('the connection panel reports success',
  /Connected to/.test($('#connState') ? $('#connState').innerHTML : ''),
  $('#connState') ? $('#connState').innerHTML : 'missing');

ok('it does NOT land on Setup when the backend is healthy',
  $('#view-setup') && $('#view-setup').classList.contains('hidden'),
  'the app fell through to the Setup screen');

ok('the overview is the visible view',
  $('#view-overview') && !$('#view-overview').classList.contains('hidden'));

// ---------------------------------------------------------------------------
// Import, then check the figures on screen
// ---------------------------------------------------------------------------
const importBtn = $('#btnImport');
ok('the import button exists', Boolean(importBtn));
importBtn.dispatchEvent(new window.Event('click'));

// Poll rather than guess a duration.
for (let i = 0; i < 100 && store.size === 0; i++) {
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, 300));

const stored = [...store.keys()].filter((k) => k.startsWith('txn/'));
eq('exactly the four real transactions were stored', stored.length, 4);

const txns = stored.map((k) => JSON.parse(store.get(k)));
const amounts = txns.map((t) => t.amount).sort((a, b) => a - b);
eq('amounts are exact', amounts.join(','), '350,450,1200,85000');

// The failure a money app cannot ship.
ok('the OTP amount never became a transaction', !txns.some((t) => t.amount === 9999),
  JSON.stringify(txns.filter((t) => t.amount === 9999)));
ok('the balance figure never became a transaction', !txns.some((t) => t.amount === 45678.9));

eq('the salary is income', txns.find((t) => t.amount === 85000).kind, 'income');
eq('the swiggy payment is an expense', txns.find((t) => t.amount === 450).kind, 'expense');

// The rendered figures, read back off the DOM.
const todaySpend = text('#dashToday');
ok("today's spend is rendered as ₹2,000", todaySpend === '₹2,000', todaySpend);

const monthLabel = text('#dashMonth');
ok('the month tile shows a rupee figure', /^₹/.test(monthLabel), monthLabel);

ok('the coverage panel is populated',
  ($('#qualityBody') || {}).innerHTML && $('#qualityBody').innerHTML.includes('Transactions stored'),
  ($('#qualityBody') || {}).innerHTML);

// ---------------------------------------------------------------------------
// Toasts stack rather than overwrite
// ---------------------------------------------------------------------------
{
  const { toast } = await import('../static/js/ui/dom.js');
  toast('first message', 'info');
  toast('second message', 'error');
  const host = $('#toasts');
  ok('the toast host exists', Boolean(host));
  ok('two toasts coexist', host.children.length >= 2, `${host && host.children.length}`);
  ok('an error toast is announced assertively',
    [...host.children].some((c) => c.getAttribute('aria-live') === 'assertive'));
  ok('the earlier message is still readable',
    host.textContent.includes('first message'), host.textContent);
}

// ---------------------------------------------------------------------------
// The drift panel shares redacted text, not the original
// ---------------------------------------------------------------------------
{
  const driftCard = $('#driftCard');
  ok('the drift card is shown when a bank template is unrecognised',
    driftCard && !driftCard.hidden, 'drift card stayed hidden');

  const shown = $('#driftList') ? $('#driftList').textContent : '';
  ok('the payee name is not on screen', !shown.includes('Gadipudi'), shown);
  ok('the amount is not on screen', !shown.includes('1358'), shown);
  ok('the phone number is not on screen', !shown.includes('9876543210'), shown);
  ok('the account tail is not on screen', !shown.includes('5261'), shown);
  ok('the message shape survives', /HDFC Bank/.test(shown), shown);

  const note = $('#driftPrivacy') ? $('#driftPrivacy').textContent : '';
  ok('the panel states that redaction happened', /[Rr]edacted on this device/.test(note), note);

  // The clipboard payload is what actually leaves the device.
  let copied = '';
  Object.defineProperty(window.navigator, 'clipboard', {
    value: { writeText: async (t) => { copied = t; } }, configurable: true,
  });
  globalThis.navigator = window.navigator;

  const actions = await import('../static/js/ui/actions.js');
  await actions.copyDrift();
  await new Promise((r) => setTimeout(r, 50));

  ok('something was copied', copied.length > 0);
  ok('the copied report carries no name', !copied.includes('Gadipudi'), copied);
  ok('the copied report carries no phone number', !copied.includes('9876543210'), copied);
  ok('the copied report carries no amount', !copied.includes('1358'), copied);
  ok('the copied report carries no account tail', !copied.includes('5261'), copied);
  ok('the copied report keeps the bank code', copied.includes('HDFCBK'), copied);
  ok('the copied report explains itself', copied.includes('REDACTED ON DEVICE'), copied);

  const { verify } = await import('../static/js/core/redact.js');
  const leaks = verify(copied);
  ok('the copied report passes its own leak scan', leaks.length === 0, JSON.stringify(leaks));

  // Switching the on-screen view to the original must NOT change what copying
  // produces. One stray tap should never be the difference between a bug
  // report and a disclosure.
  const originalBtn = [...window.document.querySelectorAll('#driftCard .seg-btn')]
    .find((b) => b.dataset.drift === 'original');
  if (originalBtn) {
    originalBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    ok('the original view does show the real text',
      $('#driftList').textContent.includes('Gadipudi'), 'toggle did not reveal the original');
    copied = '';
    await actions.copyDrift();
    await new Promise((r) => setTimeout(r, 30));
    ok('copying is still redacted even while viewing the original',
      copied.length > 0 && !copied.includes('Gadipudi'), copied);
  } else {
    ok('the drift view toggle exists', false, 'no [data-drift] control');
  }
}

// ---------------------------------------------------------------------------
// Provenance: the figures are traceable to the message
// ---------------------------------------------------------------------------
{
  const row = window.document.querySelector('#txnList .txn-row');
  ok('the transaction list has rows', Boolean(row));
  if (row) {
    row.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));

    const pre = $('#txnRaw');
    ok('the original message is shown', pre && pre.textContent.length > 0);
    const markedFields = [...window.document.querySelectorAll('#txnRaw mark.pv')]
      .map((m) => m.className.replace('pv pv-', ''));
    ok('the amount is highlighted in the message', markedFields.includes('amount'),
      JSON.stringify(markedFields));
    ok('the merchant is highlighted', markedFields.includes('merchant'),
      JSON.stringify(markedFields));

    // The evidence must be the evidence: highlighting may not alter a character.
    const txnFp = row.dataset.fp;
    const stored = JSON.parse(store.get('txn/' + txnFp));
    ok('the rendered message equals the stored message',
      pre.textContent === stored.raw, `${pre.textContent}\n     vs ${stored.raw}`);

    const trace = $('#txnTrace') ? $('#txnTrace').textContent : '';
    ok('the trace states whether everything was located', trace.length > 0, trace);
  }
}

// ---------------------------------------------------------------------------
// Navigation still works after a render
// ---------------------------------------------------------------------------
const dailyNav = [...window.document.querySelectorAll('[data-view="daily"]')][0];
if (dailyNav) {
  dailyNav.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  ok('navigating to the daily view shows it',
    $('#view-daily') && !$('#view-daily').classList.contains('hidden'));
  ok('the daily list has rows', ($('#dayList') || {}).innerHTML.includes('day-row'),
    ($('#dayList') || {}).innerHTML.slice(0, 200));
} else {
  ok('a daily nav control exists', false, 'no [data-view="daily"] element');
}

console.log(`\nbooted, imported ${INBOX.length} messages -> ${stored.length} transactions`);
console.log(`today rendered as ${todaySpend}`);
console.log('\n' + '-'.repeat(50));
if (failures.length) console.log(failures.join('\n'));
console.log(`passed=${pass}  failed=${fail}`);
if (fail) process.exit(1);
process.exit(0);
