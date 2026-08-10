/*
 * End-to-end pipeline test.
 *
 * Stands up a mock Medha (SMS connector + /store + /generate) and drives the
 * real ingest code against a simulated inbox. Verifies the properties that
 * actually matter in production: resumability, deduplication, 429 backoff,
 * category caching, and arithmetic correctness of the totals.
 */
const http = require('http');
const P = require('../static/js/parser.js');

// ------------------------------- simulated inbox -------------------------------
const DAY = 864e5;
const BASE = new Date(2025, 6, 1).getTime();

function buildInbox() {
  const msgs = [];
  let id = 1;
  const merchants = [
    ['swiggy@ybl', 'food'], ['zepto@ybl', 'groceries'], ['uber@axis', 'transport'],
    ['AMAZON', 'shopping'], ['airtel@hdfc', 'bills'], ['NETFLIX', 'entertainment'],
    ['ZZQQ ENTERPRISES', null],
  ];
  for (let d = 0; d < 40; d++) {
    const date = BASE + d * DAY;
    const dd = String(new Date(date).getDate()).padStart(2, '0');
    const mm = String(new Date(date).getMonth() + 1).padStart(2, '0');
    const [m] = merchants[d % merchants.length];
    const amt = 100 + d * 37;
    const ref = 'REF' + String(100000 + d);
    msgs.push({ id: id++, date, address: 'HDFCBK',
      body: `Rs.${amt}.00 debited from a/c XX1234 on ${dd}-${mm}-25 to VPA ${m}. Ref ${ref}` });
    // duplicate card alert for the same payment, same ref
    if (d % 5 === 0) {
      msgs.push({ id: id++, date: date + 60000, address: 'HDFCBK',
        body: `Rs ${amt}.00 spent on HDFC Card x1234 at ${m} on ${dd}-${mm}-25. Ref ${ref}` });
    }
    // noise that must never be counted
    if (d % 4 === 0) msgs.push({ id: id++, date: date + 120000, address: 'VM-HDFCBK',
      body: `Your OTP is ${1000 + d} for txn of Rs.${amt}.00. Do not share.` });
    if (d % 7 === 0) msgs.push({ id: id++, date: date + 180000, address: 'VM-HDFCBK',
      body: `Avl bal in a/c XX1234 is Rs.45,678.90 as on ${dd}-${mm}-25.` });
  }
  // one salary credit
  msgs.push({ id: id++, date: BASE + 2 * DAY, address: 'AX-HDFCBK',
    body: 'Rs.85,000.00 credited to a/c XX1234 on 03-07-25 by NEFT from ACME TECH. Ref N9999' });

  // --- traps from the Indian-market review ---
  // credit card bill paid from savings: NOT an expense (already counted as card spend)
  msgs.push({ id: id++, date: BASE + 10 * DAY, address: 'AX-HDFCBK',
    body: 'Rs.12,450.00 debited from a/c XX1234 on 11-07-25 towards HDFC Credit Card payment. Ref CC1111' });
  // refund of an earlier purchase: offsets spend, is not income
  msgs.push({ id: id++, date: BASE + 12 * DAY, address: 'AX-HDFCBK',
    body: 'Rs.500.00 credited to a/c XX1234 on 13-07-25. Refund from MYNTRA Ref RF2222' });
  // failed payment: not spend
  msgs.push({ id: id++, date: BASE + 13 * DAY, address: 'AX-HDFCBK',
    body: 'Your txn of Rs.777.00 at SOMESHOP has failed. Amount will be reversed.' });
  // fuel pre-auth hold: settles later at a different amount
  msgs.push({ id: id++, date: BASE + 14 * DAY, address: 'AX-HDFCBK',
    body: 'Rs.5,000 hold placed on Card x1234 at INDIAN OIL on 15-07-25' });
  // cross-sender duplicate: same payment reported by the UPI app, no ref, no account
  const dupDate = BASE + 3 * DAY;
  msgs.push({ id: id++, date: dupDate + 40000, address: 'JM-PAYTM',
    body: 'You paid Rs.211.00 to Uber via Paytm UPI on 04-07-25' });
  return msgs.sort((a, b) => b.date - a.date);
}

const INBOX = buildInbox();

// --------------------------------- mock server ---------------------------------
const store = new Map();
let generateCalls = 0;
let force429Until = 0;

function json(res, code, obj, headers = {}) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(b);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // No auth check here: this mock stands in for Medha as seen from BEHIND the
    // Flask proxy, which is the component that attaches the bearer token. The
    // browser client deliberately never holds one. Proxy-level auth and the
    // endpoint allowlist are covered by tests/e2e_flask.js against the real
    // server.
    if (p === '/health') return json(res, 200, { status: 'ok', modelLoaded: true });

    if (p === '/connectors/sms/status') {
      return json(res, 200, { supported: true, canRead: true, canSend: false, totalMessages: INBOX.length });
    }
    if (p === '/connectors/sms/messages') {
      const before = Number(url.searchParams.get('before') || 0);
      const since = Number(url.searchParams.get('since') || 0);
      const limit = Number(url.searchParams.get('limit') || 100);
      let out = INBOX;
      if (before) out = out.filter((m) => m.date < before);
      if (since) out = out.filter((m) => m.date > since);
      out = out.slice(0, limit);
      return json(res, 200, {
        messages: out, count: out.length,
        nextBefore: out.length ? Math.min(...out.map((m) => m.date)) : 0,
      });
    }
    if (p === '/generate') {
      generateCalls++;
      if (Date.now() < force429Until) {
        return json(res, 429, { error: 'thermal headroom 0.91 >= 0.85', code: 'rejected' },
          { 'Retry-After': '1' });
      }
      return json(res, 200, { text: 'shopping', tokens: 1, ms: 10, tokensPerSec: 100 });
    }
    if (p === '/store/bulk') {
      const items = JSON.parse(body).items;
      items.forEach((i) => store.set(i.key, i.value));
      return json(res, 200, { written: items.length });
    }
    if (p === '/store') {
      const prefix = url.searchParams.get('prefix') || '';
      const limit = Number(url.searchParams.get('limit') || 500);
      const offset = Number(url.searchParams.get('offset') || 0);
      const all = [...store.entries()].filter(([k]) => k.startsWith(prefix));
      const page = all.slice(offset, offset + limit);
      return json(res, 200, {
        prefix, total: all.length,
        items: page.map(([key, value]) => ({ key, value, updatedAt: Date.now() })),
      });
    }
    if (p.startsWith('/store/')) {
      const key = decodeURIComponent(p.slice('/store/'.length));
      if (req.method === 'PUT') { store.set(key, body); return json(res, 200, { ok: true }); }
      if (req.method === 'DELETE') { store.delete(key); return json(res, 200, { deleted: true }); }
      if (store.has(key)) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(store.get(key)); }
      return json(res, 404, { error: 'no such key', code: 'not_found' });
    }
    json(res, 404, { error: 'not found' });
  });
});

// ------------------------------- browser shims -------------------------------
let pass = 0, fail = 0;
const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}  ${d}`); } };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const ls = new Map([['sandeshika.token', 'test-token']]);
  global.localStorage = {
    getItem: (k) => (ls.has(k) ? ls.get(k) : null),
    setItem: (k, v) => ls.set(k, v),
    removeItem: (k) => ls.delete(k),
  };
  global.location = { origin, href: origin };
  global.window = global;
  global.LekhaParser = P;
  require('../static/js/api.js');
  const Api = global.SandeshikaApi;

  // api.js issues same-origin '/api/...' requests. Rewrite them onto the mock
  // server, stripping the '/api' prefix the Flask proxy would have consumed.
  const realFetch = global.fetch;
  global.fetch = (u, o) => {
    const str = String(u);
    if (str.startsWith('http')) return realFetch(str, o);
    return realFetch(origin + str.replace(/^\/api/, ''), o);
  };

  // ============================ 1. full backfill ============================
  const r1 = await Api.backfill({ shouldStop: () => false });
  ok('backfill scanned every message', r1.scanned === INBOX.length, `${r1.scanned}/${INBOX.length}`);
  ok('backfill wrote transactions', r1.written > 0, String(r1.written));
  ok('duplicates were detected', r1.duplicates > 0, String(r1.duplicates));
  ok('noise was rejected', r1.rejected > 0, String(r1.rejected));

  const txns = await Api.loadTransactions();
  ok('stored count equals written', txns.length === r1.written, `${txns.length} vs ${r1.written}`);

  // no OTP or balance message may have become a transaction
  const bad = txns.filter((t) => /otp|avl bal/i.test(t.raw));
  ok('ZERO noise messages stored', bad.length === 0, JSON.stringify(bad.slice(0, 2)));

  // fingerprints unique
  const fps = new Set(txns.map((t) => t.fingerprint));
  ok('all fingerprints unique', fps.size === txns.length, `${fps.size} vs ${txns.length}`);

  // arithmetic: 40 debits (one per day) + 1 credit, duplicates collapsed
  const debits = txns.filter((t) => t.direction === 'debit');
  const credits = txns.filter((t) => t.direction === 'credit');
  ok('exactly 40 expenses', txns.filter((t) => t.kind === 'expense').length === 40,
     String(txns.filter((t) => t.kind === 'expense').length));
  ok('exactly 1 income', txns.filter((t) => t.kind === 'income').length === 1,
     String(txns.filter((t) => t.kind === 'income').length));
  const expectedSpend = Array.from({ length: 40 }, (_, d) => 100 + d * 37).reduce((a, b) => a + b, 0);
  const actualSpend = txns.filter((t) => t.kind === 'expense').reduce((s, t) => s + t.amount, 0);
  ok('total spend is exact and excludes transfers', actualSpend === expectedSpend,
     `${actualSpend} vs ${expectedSpend}`);
  ok('income amount is exact', txns.find((t) => t.kind === 'income').amount === 85000);

  // ================= 1b. traps from the market review =================
  const byKind = (k) => txns.filter((t) => t.kind === k);
  ok('CC bill payment classified as transfer', byKind('transfer').length === 1,
     `${byKind('transfer').length} transfers`);
  ok('CC bill not counted as expense',
     !byKind('expense').some((t) => t.amount === 12450), 'DOUBLE COUNTING');
  ok('refund classified as refund', byKind('refund').length === 1,
     `${byKind('refund').length} refunds`);
  ok('refund not counted as income',
     !byKind('income').some((t) => t.amount === 500));
  ok('failed payment absent', !txns.some((t) => t.amount === 777), 'failed txn booked');
  ok('auth hold absent', !txns.some((t) => t.amount === 5000), 'hold booked as spend');

  // the day-3 Uber debit (100 + 3*37 = 211) exists once, not twice
  const uber211 = txns.filter((t) => t.amount === 211 && t.kind === 'expense');
  ok('cross-sender duplicate collapsed', uber211.length === 1,
     `${uber211.length} copies of the same 211 payment`);

  ok('DLT sender normalised on stored rows',
     txns.every((t) => !/^[A-Z]{2}-/.test(t.senderId || '')), 'raw operator prefix stored');
  ok('bank identified from sender', txns.some((t) => t.bank === 'HDFC'));

  // ======================= 2. idempotent re-run =======================
  const before = store.size;
  const r2 = await Api.backfill({ shouldStop: () => false });
  ok('re-run writes nothing new', (await Api.loadTransactions()).length === txns.length);
  ok('re-run sees all as duplicates', r2.written === 0, `wrote ${r2.written}`);
  ok('store did not grow', store.size === before, `${store.size} vs ${before}`);

  // ==================== 3. category cache limits LLM ====================
  const callsAfterFirst = generateCalls;
  Api.catCache.clear();
  await Api.primeCategoryCache();
  ok('category cache persisted to store', Api.catCache.size > 0, String(Api.catCache.size));
  // only the unknown merchant should ever have reached the model
  ok('LLM called sparingly', callsAfterFirst <= 3, `${callsAfterFirst} generate calls for 40 txns`);

  // ======================= 4. 429 backoff is honoured =======================
  Api.catCache.clear();
  store.delete('cat/zzqq enterprises');
  force429Until = Date.now() + 1200;
  const waits = [];
  const cat = await Api.resolveCategory('BRAND NEW MERCHANT LTD', 'debit',
    (msg, s) => waits.push(s));
  ok('429 triggered a wait', waits.length > 0, 'no backoff observed');
  ok('recovered after backoff', cat && cat.category === 'shopping', JSON.stringify(cat));
  force429Until = 0;

  // ===================== 5. resume from partial state =====================
  store.clear();
  ls.delete('sandeshika.cursor');
  ls.delete('sandeshika.high');
  let pages = 0;
  const partial = await Api.backfill({ shouldStop: () => ++pages > 2 });
  ok('partial run stopped early', partial.stopped === true);
  const partialCount = (await Api.loadTransactions()).length;
  ok('partial run stored something', partialCount > 0, String(partialCount));
  ok('cursor persisted for resume', Api.Store.cursor() !== null);

  const resumed = await Api.backfill({ shouldStop: () => false });
  const finalCount = (await Api.loadTransactions()).length;
  ok('resume completes the job', finalCount === txns.length, `${finalCount} vs ${txns.length}`);
  ok('resume did not duplicate', new Set((await Api.loadTransactions()).map((t) => t.fingerprint)).size === finalCount);

  // ============ 5b. tied timestamps must not lose messages ============
  // Regression: the cursor advanced to exactly the page minimum, and the
  // server filters `date < before`, so every other message sharing that
  // instant was silently skipped.
  {
    store.clear(); ls.delete('sandeshika.cursor'); ls.delete('sandeshika.high');
    const tie = new Date(2025, 5, 1).getTime();
    const saved = INBOX.splice(0, INBOX.length);
    for (let i = 0; i < 12; i++) {
      INBOX.push({ id: 5000 + i, date: tie, address: 'AX-HDFCBK',
        body: `Rs.${100 + i}.00 debited from a/c XX1234 on 01-06-25 to VPA shop${i}@ybl. Ref TIE${i}` });
    }
    const r = await Api.backfill({ shouldStop: () => false });
    const got = await Api.loadTransactions();
    ok('all 12 same-instant messages scanned', r.scanned === 12, `${r.scanned}/12`);
    ok('all 12 stored, none lost to the cursor', got.length === 12, `${got.length}/12`);
    INBOX.splice(0, INBOX.length, ...saved);
    store.clear(); ls.delete('sandeshika.cursor'); ls.delete('sandeshika.high');
    await Api.backfill({ shouldStop: () => false });
  }

  // ===================== 6. incremental catch-up =====================
  const newDate = Date.now();
  INBOX.unshift({ id: 99999, date: newDate, address: 'HDFCBK',
    body: 'Rs.999.00 debited from a/c XX1234 on 20-08-25 to VPA newshop@ybl. Ref REFNEW1' });
  Api.Store.setWatermark(newDate - DAY);
  const cu = await Api.catchUp();
  ok('catch-up found the new message', cu.written === 1, `wrote ${cu.written}`);
  const after = await Api.loadTransactions();
  ok('catch-up did not disturb history', after.length === finalCount + 1, `${after.length}`);

  server.close();

  console.log(`\ncorpus: ${INBOX.length} SMS -> ${txns.length} unique transactions`);
  console.log(`  duplicates collapsed : ${r1.duplicates}`);
  console.log(`  noise rejected       : ${r1.rejected}`);
  console.log(`  LLM calls            : ${callsAfterFirst} (rules+cache handled the rest)`);
  console.log(`  total spend          : ₹${actualSpend.toLocaleString('en-IN')} (expected ₹${expectedSpend.toLocaleString('en-IN')})`);
  console.log(`\n${'-'.repeat(50)}`);
  console.log(`passed=${pass}  failed=${fail}`);
  if (failures.length) {
    console.log('\nFAILURES:');
    failures.forEach((f) => console.log('  ' + f));
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
