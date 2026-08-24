/*
 * Drives the REAL client code (parser.js + api.js) against a running
 * Sandeshika Flask server in mock mode — exactly the path a browser takes.
 */
import fs from 'node:fs';
const PORT = process.env.PORT || 5058;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}  ${d}`); } };

// browser shims
const ls = new Map();
global.localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: k => ls.delete(k),
};
global.location = { origin: ORIGIN };
global.window = global;
new Function(fs.readFileSync(__dirname + '/../static/js/parser.js', 'utf8'))();
new Function(fs.readFileSync(__dirname + '/../static/js/api.js', 'utf8'))();

// api.js targets '/api' (same-origin); prefix it with the server origin.
const realFetch = global.fetch;
global.fetch = (u, o) => realFetch(String(u).startsWith('http') ? u : ORIGIN + u, o);

(async () => {
  const cfg = await fetch('/config.json').then(r => r.json());
  ok('server reports mock mode', cfg.mock === true);
  ok('server reports installable on localhost', cfg.installable === true);

  const Api = global.SandeshikaApi;
  ok('client targets same-origin /api', Api.MEDHA === '/api', Api.MEDHA);

  const st = await Api.api('/connectors/sms/status');
  ok('sms connector reachable through proxy', st.canRead === true);
  ok('mock inbox is substantial', st.totalMessages > 200, String(st.totalMessages));

  const t0 = Date.now();
  const res = await Api.backfill({ shouldStop: () => false });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  ok('scanned the whole inbox', res.scanned === st.totalMessages, `${res.scanned}/${st.totalMessages}`);
  ok('wrote transactions', res.written > 0, String(res.written));
  ok('rejected the noise', res.rejected > 0, String(res.rejected));
  ok('collapsed cross-sender duplicates', res.duplicates > 0, String(res.duplicates));

  const txns = await Api.loadTransactions();
  ok('all transactions retrievable', txns.length === res.written, `${txns.length}/${res.written}`);
  ok('no OTP or balance message stored',
     !txns.some(t => /otp|avl bal/i.test(t.raw)), 'NOISE STORED');
  ok('fingerprints unique', new Set(txns.map(t => t.fingerprint)).size === txns.length);

  const kinds = txns.reduce((a, t) => (a[t.kind] = (a[t.kind] || 0) + 1, a), {});
  ok('expenses present', (kinds.expense || 0) > 0, JSON.stringify(kinds));
  ok('income detected', (kinds.income || 0) > 0, JSON.stringify(kinds));
  ok('CC bill payments classed as transfers', (kinds.transfer || 0) > 0, JSON.stringify(kinds));

  const spend = txns.filter(t => t.kind === 'expense').reduce((s, t) => s + t.amount, 0);
  const transfers = txns.filter(t => t.kind === 'transfer').reduce((s, t) => s + t.amount, 0);
  ok('transfers excluded from spend', transfers > 0 && spend > 0);
  ok('all amounts positive and finite', txns.every(t => Number.isFinite(t.amount) && t.amount >= 0));
  ok('every txn carries a kind', txns.every(t => !!t.kind));
  ok('DLT prefixes normalised', txns.every(t => !/^[A-Z]{2}-/.test(t.senderId || '')));

  // idempotence over the wire
  const again = await Api.backfill({ shouldStop: () => false });
  ok('re-import writes nothing', again.written === 0, `wrote ${again.written}`);

  // blocked endpoint
  const blocked = await fetch('/api/v1/models').then(r => r.status);
  ok('proxy blocks non-allowlisted paths', blocked === 403, String(blocked));

  console.log(`\n  inbox ${st.totalMessages} SMS -> ${txns.length} transactions in ${secs}s`);
  console.log(`  kinds: ${JSON.stringify(kinds)}`);
  console.log(`  spend ₹${Math.round(spend).toLocaleString('en-IN')} · transfers excluded ₹${Math.round(transfers).toLocaleString('en-IN')}`);
  console.log(`  duplicates ${res.duplicates} · rejected ${res.rejected} · drift ${res.drift.length}`);
  console.log(`\n${'-'.repeat(50)}\npassed=${pass}  failed=${fail}`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach(f => console.log('  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
