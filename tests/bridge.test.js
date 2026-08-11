/*
 * Simulates the native bridge in JS and drives the REAL client through it,
 * proving the Transport shim behaves identically to the Flask path.
 */
const fs = require('fs'), http = require('http');
let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}  ${d}`); } };

const TOKEN = 'realtoken1234567890abcdef';
const store = new Map();
const inbox = [];
for (let d = 0; d < 30; d++) {
  const date = new Date(2025, 6, 1 + d).getTime();
  const dd = String(new Date(date).getDate()).padStart(2, '0');
  inbox.push({ id: d + 1, date, address: 'AX-HDFCBK',
    body: `Rs.${200 + d * 11}.00 debited from a/c XX1234 on ${dd}-07-25 to VPA swiggy@ybl. Ref R${d}` });
}
inbox.sort((a, b) => b.date - a.date);

const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const send = (code, o) => { res.writeHead(code, {'Content-Type':'application/json'}); res.end(JSON.stringify(o)); };
    if (u.pathname !== '/health' && req.headers.authorization !== 'Bearer ' + TOKEN)
      return send(401, { error: 'missing or invalid API token', code: 'unauthorized' });
    if (u.pathname === '/health') return send(200, { status: 'ok', modelLoaded: true });
    if (u.pathname === '/connectors/sms/status') return send(200, { supported: true, canRead: true, totalMessages: inbox.length });
    if (u.pathname === '/connectors/sms/messages') {
      const before = Number(u.searchParams.get('before') || 0);
      let out = before ? inbox.filter(m => m.date < before) : inbox;
      out = out.slice(0, Number(u.searchParams.get('limit') || 50));
      return send(200, { messages: out, count: out.length, nextBefore: out.length ? Math.min(...out.map(m => m.date)) : 0 });
    }
    if (u.pathname === '/generate') return send(200, { text: 'food', tokens: 1, ms: 5 });
    if (u.pathname === '/store/bulk') { JSON.parse(body).items.forEach(i => store.set(i.key, i.value)); return send(200, { written: JSON.parse(body).items.length }); }
    if (u.pathname === '/store') {
      const p = u.searchParams.get('prefix') || '';
      const rows = [...store.entries()].filter(([k]) => k.startsWith(p));
      return send(200, { prefix: p, total: rows.length, items: rows.map(([key, value]) => ({ key, value, updatedAt: 0 })) });
    }
    if (u.pathname.startsWith('/store/')) {
      const k = decodeURIComponent(u.pathname.slice(7));
      if (req.method === 'PUT') { store.set(k, body); return send(200, { ok: true }); }
      if (req.method === 'DELETE') { store.delete(k); return send(200, { deleted: true }); }
      if (store.has(k)) { res.writeHead(200, {'Content-Type':'application/json'}); return res.end(store.get(k)); }
      return send(404, { error: 'no such key', code: 'not_found' });
    }
    send(404, { error: 'not found' });
  });
});

(async () => {
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  // ---- stand in for MedhaBridge.kt, mirroring its contract exactly ----
  const ALLOWED = /^(health|system|metrics|scheduler|generate|generate\/stream|chat|store(\/.*)?|sessions(\/.*)?|connectors\/sms\/(status|conversations|messages|messages\/\d+|contacts\/.+|mark-read|events)|notify(\/.*)?|rag\/(ingest|query|collections|reindex))$/;
  let savedToken = '', savedUrl = base;
  global.window = global;
  global.localStorage = (() => { const m = new Map(); return {
    getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })();

  global.AndroidMedha = {
    getConfig: () => JSON.stringify({ native: true, mock: false, medhaUrl: savedUrl,
      defaultMedhaUrl: 'http://127.0.0.1:8080', tokenConfigured: !!savedToken,
      tokenPreview: savedToken ? savedToken.slice(0,6)+'…'+savedToken.slice(-4) : '',
      tokenSource: savedToken ? 'saved' : 'none', urlSource: 'saved', envTokenPresent: false, installable: false }),
    request: (id, method, path, body, priority) => {
      const bare = path.split('?')[0];
      if (!ALLOWED.test(bare)) return finish(id, 403, JSON.stringify({ error: 'endpoint not permitted: ' + path }));
      if (!savedToken) return finish(id, 401, JSON.stringify({ error: 'No Medha token saved yet — add one in Setup.' }));
      const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + savedToken };
      if (priority) headers['X-Medha-Priority'] = priority;
      fetch(savedUrl + '/' + path, { method, headers, body: method === 'GET' ? undefined : body })
        .then(async r => finish(id, r.status, await r.text()))
        .catch(e => finish(id, 502, JSON.stringify({ error: 'Cannot reach Medha: ' + e.message })));
    },
    saveSettings: (id, url, token) => {
      const use = (token || '').trim() || savedToken;
      if (!/^https?:\/\/[\w.\-]+(:\d{1,5})?$/.test(url)) return finish(id, 400, JSON.stringify({ error: 'bad url' }));
      if (!use) return finish(id, 400, JSON.stringify({ error: 'A Medha API token is required' }));
      fetch(url + '/store?prefix=meta/&limit=1', { headers: { Authorization: 'Bearer ' + use } })
        .then(r => {
          if (r.status === 401 || r.status === 403) return finish(id, 401, JSON.stringify({ error: 'Medha rejected that token.' }));
          savedUrl = url; savedToken = use;
          finish(id, 200, JSON.stringify({ ok: true, medhaUrl: url }));
        }).catch(e => finish(id, 502, JSON.stringify({ error: 'unreachable' })));
    },
    clearSettings: (id) => { savedToken = ''; finish(id, 200, JSON.stringify({ cleared: true })); },
  };
  const finish = (id, status, body) =>
    setTimeout(() => global.__medhaResolve(id, JSON.stringify({ status, body })), 0);

  new Function(fs.readFileSync(__dirname + '/../app/src/main/assets/web/js/bridge.js', 'utf8')).call(global);
  new Function(fs.readFileSync(__dirname + '/../app/src/main/assets/web/js/parser.js', 'utf8')).call(global);
  new Function(fs.readFileSync(__dirname + '/../app/src/main/assets/web/js/api.js', 'utf8')).call(global);
  const Api = global.SandeshikaApi;

  ok('bridge detected as native', global.Transport.native === true);

  // no token yet
  let cfg = await global.Transport.config();
  ok('config reports no token', cfg.tokenConfigured === false);
  try { await Api.api('/health'); ok('call without token rejected', false, 'it succeeded'); }
  catch (e) { ok('call without token rejected', e.status === 401, 'status ' + e.status); }

  // bad token
  try { await global.Transport.saveSettings(base, 'wrongtoken'); ok('bad token refused', false); }
  catch (e) { ok('bad token refused', /rejected/.test(e.message), e.message); }

  // good token
  await global.Transport.saveSettings(base, TOKEN);
  cfg = await global.Transport.config();
  ok('config reports token saved', cfg.tokenConfigured === true && cfg.tokenSource === 'saved');
  ok('token never exposed to JS', !JSON.stringify(cfg).includes(TOKEN), 'TOKEN LEAKED TO THE PAGE');

  const h = await Api.api('/health');
  ok('authenticated call succeeds', h.modelLoaded === true);

  // blocked endpoint
  try { await Api.api('/v1/models'); ok('allowlist enforced in bridge', false, 'it succeeded'); }
  catch (e) { ok('allowlist enforced in bridge', e.status === 403, 'status ' + e.status); }

  // full ingest through the bridge
  const res = await Api.backfill({ shouldStop: () => false });
  ok('backfill scanned inbox', res.scanned === inbox.length, `${res.scanned}/${inbox.length}`);
  ok('backfill wrote transactions', res.written === 30, String(res.written));
  const txns = await Api.loadTransactions();
  ok('transactions readable back', txns.length === 30, String(txns.length));
  const total = txns.reduce((s, t) => s + t.amount, 0);
  const expected = Array.from({ length: 30 }, (_, d) => 200 + d * 11).reduce((a, b) => a + b, 0);
  ok('amounts exact through the bridge', total === expected, `${total} vs ${expected}`);
  ok('every txn has a kind', txns.every(t => !!t.kind));

  const again = await Api.backfill({ shouldStop: () => false });
  ok('re-run idempotent', again.written === 0, String(again.written));

  await global.Transport.clearSettings();
  ok('clear removes the token', (await global.Transport.config()).tokenConfigured === false);

  srv.close();
  console.log(`\n  ${inbox.length} SMS -> ${txns.length} transactions through the native bridge`);
  console.log(`  total ₹${total.toLocaleString('en-IN')} (expected ₹${expected.toLocaleString('en-IN')})`);
  console.log(`\n${'-'.repeat(50)}\npassed=${pass}  failed=${fail}`);
  if (failures.length) { console.log('\nFAILURES:'); failures.forEach(f => console.log('  ' + f)); process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
