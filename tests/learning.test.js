/*
 * Correction engine: user categories must win, persist, and apply BACKWARDS.
 * Forward-only would be half a feature — months of history are already filed
 * under the wrong category and re-importing does not fix them.
 */
import http from 'node:http';
import * as P from '../static/js/core/parser.js';
import { loadTransactions, putMany } from '../static/js/data/client.js';
import {
  catCache, primeCategoryCache, resolveCategory, correctCategory, setKind,
  learnedRules, forgetRule,
} from '../static/js/data/categories.js';

const Api = {
  loadTransactions, putMany, catCache, primeCategoryCache, resolveCategory,
  correctCategory, setKind, learnedRules, forgetRule,
};
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}  ${d}`); } };

const store = new Map();
let generateCalls = 0;
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const j = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/store/bulk') {
      const items = JSON.parse(body).items; items.forEach((i) => store.set(i.key, i.value));
      return j(200, { written: items.length });
    }
    if (u.pathname === '/store') {
      const p = u.searchParams.get('prefix') || '';
      const rows = [...store.entries()].filter(([k]) => k.startsWith(p));
      return j(200, { prefix: p, total: rows.length, items: rows.map(([key, value]) => ({ key, value, updatedAt: 0 })) });
    }
    if (u.pathname.startsWith('/store/')) {
      const k = decodeURIComponent(u.pathname.slice(7));
      if (req.method === 'PUT') { store.set(k, body); return j(200, { ok: true }); }
      if (req.method === 'DELETE') { store.delete(k); return j(200, { deleted: true }); }
      if (store.has(k)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(store.get(k)); }
      return j(404, { error: 'no such key' });
    }
    if (u.pathname === '/generate') { generateCalls++; return j(200, { text: 'shopping' }); }
    j(404, { error: 'nope' });
  });
});

(async () => {
  await new Promise((r) => srv.listen(0, r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  global.window = global;
  global.localStorage = (() => { const m = new Map(); return {
    getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; })();
  const realFetch = global.fetch;
  global.fetch = (url, o) => realFetch(origin + String(url).replace(/^\/api/, ''), o);

  // seed five transactions from one unknown merchant, filed as "other"
  const seed = [];
  for (let i = 0; i < 5; i++) {
    seed.push({ key: `txn/fp${i}`, value: JSON.stringify({
      fingerprint: `fp${i}`, merchant: 'ZZQQ ENTERPRISES', amount: 100 + i,
      direction: 'debit', kind: 'expense', category: 'other', categorySource: 'llm',
      date: Date.now() - i * 864e5, currency: 'INR', needsReview: false }) });
  }
  seed.push({ key: 'txn/other1', value: JSON.stringify({
    fingerprint: 'other1', merchant: 'Rapido', amount: 60, direction: 'debit',
    kind: 'expense', category: 'transport', categorySource: 'rule',
    date: Date.now(), currency: 'INR', needsReview: false }) });
  await Api.putMany(seed);

  // --- the correction applies backwards ---
  const r = await Api.correctCategory('ZZQQ ENTERPRISES', 'groceries');
  ok('reports how many rows it changed', r.updated === 5, String(r.updated));

  const after = await Api.loadTransactions();
  const zz = after.filter((t) => t.merchant === 'ZZQQ ENTERPRISES');
  ok('every past transaction relabelled', zz.every((t) => t.category === 'groceries'),
     JSON.stringify(zz.map((t) => t.category)));
  ok('marked as user-set', zz.every((t) => t.categorySource === 'user'));
  ok('unrelated merchants untouched',
     after.find((t) => t.merchant === 'Rapido').category === 'transport');

  // --- and forwards, without consulting the model ---
  const before = generateCalls;
  Api.catCache.clear();
  await Api.primeCategoryCache();
  const c = await Api.resolveCategory('ZZQQ ENTERPRISES', 'debit');
  ok('future transactions use the correction', c.category === 'groceries', JSON.stringify(c));
  ok('and it is recorded as a user decision', c.source === 'user');
  ok('the model was not asked again', generateCalls === before, `${generateCalls - before} calls`);

  // --- a user decision outranks a built-in rule ---
  await Api.correctCategory('Rapido', 'travel');
  Api.catCache.clear(); await Api.primeCategoryCache();
  const rr = await Api.resolveCategory('Rapido', 'debit');
  ok('user beats the built-in rule', rr.category === 'travel' && rr.source === 'user',
     JSON.stringify(rr));
  ok('the built-in rule itself is unchanged',
     P.categorise('Rapido', 'debit').category === 'transport');

  // --- setting "transfer" removes it from spending ---
  await Api.correctCategory('ZZQQ ENTERPRISES', 'transfer');
  const t2 = (await Api.loadTransactions()).filter((t) => t.merchant === 'ZZQQ ENTERPRISES');
  ok('transfer correction changes kind', t2.every((t) => t.kind === 'transfer'),
     JSON.stringify(t2.map((t) => t.kind)));

  // --- visible and reversible ---
  const rules = await Api.learnedRules();
  ok('learned rules are listable', rules.length === 2, String(rules.length));
  ok('rules carry the category', rules.every((x) => !!x.category && x.source === 'user'));
  await Api.forgetRule(P.merchantKey('Rapido'));
  Api.catCache.clear(); await Api.primeCategoryCache();
  const back = await Api.resolveCategory('Rapido', 'debit');
  ok('forgetting restores the built-in rule', back.category === 'transport', JSON.stringify(back));
  ok('only that rule was forgotten', (await Api.learnedRules()).length === 1);

  // --- guards ---
  // Custom categories are allowed, so the guard checks the NAME's shape rather
  // than membership of a closed list -- otherwise it would reject the very
  // categories the user just created.
  let threw = false;
  try { await Api.correctCategory('ZZQQ ENTERPRISES', 'sub/scription!'); } catch (_) { threw = true; }
  ok('malformed category name rejected', threw);
  threw = false;
  try { await Api.correctCategory('ZZQQ ENTERPRISES', 'x'.repeat(40)); } catch (_) { threw = true; }
  ok('over-long category name rejected', threw);
  threw = false;
  try { await Api.correctCategory('ZZQQ ENTERPRISES', 'school fees'); } catch (_) { threw = true; }
  ok('a custom category is accepted', !threw);
  threw = false;
  try { await Api.correctCategory('', 'food'); } catch (_) { threw = true; }
  ok('empty merchant rejected', threw);

  // --- scoped to one transaction only ---
  const one = await Api.correctCategory('ZZQQ ENTERPRISES', 'food', { thisOnly: true });
  ok('thisOnly touches no past rows', one.updated === 0, String(one.updated));


  // ================= kind can be set directly, and it sticks =================
  //
  // `kind` decides whether an amount is counted as spending, income, or left
  // out of both. Until now it could only be changed sideways, by picking a
  // category that happened to imply the right one — an odd way to ask someone
  // to correct a ₹5,000 error.
  {
    await Api.putMany([{ key: 'txn/k1', value: JSON.stringify({
      fingerprint: 'k1', merchant: 'HDFC NETC FASTag', amount: 1000,
      direction: 'credit', kind: 'income', category: 'other', categorySource: 'llm',
      date: Date.now(), currency: 'INR', needsReview: false }) }]);

    let rows = await Api.loadTransactions();
    const k1 = rows.find((t) => t.fingerprint === 'k1');
    const res = await Api.setKind(k1, 'transfer');
    ok('setKind writes one row by default', res.updated === 1, String(res.updated));

    rows = await Api.loadTransactions();
    const after = rows.find((t) => t.fingerprint === 'k1');
    ok('kind changed', after.kind === 'transfer', after.kind);
    ok('marked as user-set', after.kindSource === 'user');
    ok('no longer awaiting review', after.needsReview === false);

    // a later category correction must NOT undo it
    await Api.correctCategory('HDFC NETC FASTag', 'bills');
    rows = await Api.loadTransactions();
    const still = rows.find((t) => t.fingerprint === 'k1');
    ok('a category change does not override a user kind', still.kind === 'transfer',
       still.kind);
    ok('but the category did change', still.category === 'bills', still.category);

    // invalid kinds are refused
    let threw = false;
    try { await Api.setKind(still, 'nonsense'); } catch (_) { threw = true; }
    ok('invalid kind rejected', threw);

    // merchant-wide, but only for the same direction
    await Api.putMany([
      { key: 'txn/k2', value: JSON.stringify({ fingerprint: 'k2', merchant: 'Paytm Wallet',
        amount: 500, direction: 'debit', kind: 'expense', category: 'other',
        date: Date.now(), currency: 'INR' }) },
      { key: 'txn/k3', value: JSON.stringify({ fingerprint: 'k3', merchant: 'Paytm Wallet',
        amount: 700, direction: 'debit', kind: 'expense', category: 'other',
        date: Date.now(), currency: 'INR' }) },
      { key: 'txn/k4', value: JSON.stringify({ fingerprint: 'k4', merchant: 'Paytm Wallet',
        amount: 900, direction: 'credit', kind: 'income', category: 'other',
        date: Date.now(), currency: 'INR' }) },
    ]);
    rows = await Api.loadTransactions();
    const k2 = rows.find((t) => t.fingerprint === 'k2');
    const wide = await Api.setKind(k2, 'transfer', { merchantWide: true });
    ok('merchant-wide updates the matching direction', wide.updated === 2, String(wide.updated));
    rows = await Api.loadTransactions();
    ok('both debits became transfers',
       ['k2', 'k3'].every((f) => rows.find((t) => t.fingerprint === f).kind === 'transfer'));
    ok('the opposite direction is untouched',
       rows.find((t) => t.fingerprint === 'k4').kind === 'income');
  }

  srv.close();
  console.log(`\n${'-'.repeat(50)}\npassed=${pass}  failed=${fail}`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
