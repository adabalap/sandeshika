/*
 * Transport — the module that did not exist.
 *
 * The previous build referenced a global `Transport` in twelve places and
 * never defined it, so configuration, save, clear, detect and the whole
 * diagnostics screen threw ReferenceError. Boot swallowed it in a try/catch and
 * dropped the user on Setup with a misleading message, every launch, however
 * healthy the backend was.
 *
 * These tests exist so that cannot recur silently: both transports are
 * exercised, and the contract each must satisfy is written down.
 */

import Transport from '../static/js/data/transport.js';
import { api, ApiError, Store, Keys } from '../static/js/data/client.js';

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}  ${detail}`); }
}
const eq = (n, a, b) => ok(n, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

async function throws(name, fn, check) {
  try {
    await fn();
    ok(name, false, 'did not throw');
  } catch (e) {
    ok(name, check ? check(e) : true, `threw ${e && e.message}`);
  }
}

/** Records what the code under test asked for, so the call can be asserted. */
function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts);
  };
  return calls;
}

const jsonRes = (body, status = 200, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k) => headers[k] || null },
  json: async () => body,
});

// ===========================================================================
// 1. Browser transport
// ===========================================================================
{
  delete globalThis.AndroidMedha;
  eq('no bridge means not native', Transport.native, false);
  eq('no bridge reports no missing methods', Transport.missingBridgeMethods().length, 0);

  const calls = mockFetch((url) => {
    if (url === '/config.json') return jsonRes({ version: '2.0.0', medhaUrl: 'http://127.0.0.1:8001' });
    if (url === '/detect') return jsonRes({ found: [{ url: 'http://127.0.0.1:8001', modelLoaded: true, tokenOk: true }] });
    if (url === '/settings') return jsonRes({ ok: true, tokenPreview: 'abc…1234' });
    if (url === '/api/health') return jsonRes({ status: 'ok', modelLoaded: true });
    return jsonRes({ error: 'not found' }, 404);
  });

  const cfg = await Transport.config();
  eq('config comes from /config.json', cfg.version, '2.0.0');

  const d = await Transport.detect();
  eq('detect returns candidates', d.found[0].modelLoaded, true);

  await Transport.saveSettings('http://127.0.0.1:8001', 'deadbeef');
  const save = calls.find((c) => c.url === '/settings' && c.opts.method === 'POST');
  ok('settings are POSTed', Boolean(save));
  eq('the token is sent in the body, never a query string',
    JSON.parse(save.opts.body).token, 'deadbeef');
  ok('the token never appears in a URL', calls.every((c) => !c.url.includes('deadbeef')));

  const h = await Transport.request('/health');
  eq('requests are proxied under /api', calls.some((c) => c.url === '/api/health'), true);
  eq('the response body is returned', h.modelLoaded, true);
}

// ===========================================================================
// 2. Errors carry the server's own words
// ===========================================================================
{
  delete globalThis.AndroidMedha;
  mockFetch(() => jsonRes({ error: 'Medha rejected that token.' }, 401));
  await throws('a 401 surfaces as ApiError with status',
    () => api('/store'),
    (e) => e instanceof ApiError && e.status === 401 && /rejected that token/.test(e.message));

  mockFetch(() => jsonRes({ error: 'busy' }, 429, { 'Retry-After': '17' }));
  await throws('Retry-After is preserved so backoff waits the right time',
    () => api('/generate', { method: 'POST' }),
    (e) => e.retryAfter === 17);

  // A network failure has no status at all, and must not be reported as if the
  // server answered.
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await throws('an unreachable host becomes a status-0 ApiError',
    () => api('/health'),
    (e) => e instanceof ApiError && e.status === 0);
}

// ===========================================================================
// 3. Native bridge (APK)
//
// There is no Flask server inside the APK, so anything that reached for
// fetch('/settings') there would silently hit the app shell. Every method must
// route through the bridge instead.
// ===========================================================================
{
  const seen = [];
  globalThis.AndroidMedha = {
    getConfig: () => JSON.stringify({ version: '2.0.0', medhaUrl: 'http://127.0.0.1:8080', mock: false }),
    saveSettings: (url, token) => { seen.push(['save', url, token]); return JSON.stringify({ ok: true }); },
    clearSettings: () => JSON.stringify({ cleared: true }),
    detect: () => JSON.stringify({ found: [{ url: 'http://127.0.0.1:8080', modelLoaded: true, tokenOk: null }] }),
    request: (method, path) => {
      seen.push(['req', method, path]);
      return JSON.stringify({ status: 200, body: { modelLoaded: true } });
    },
  };
  // If anything falls through to HTTP, this fails the test loudly.
  globalThis.fetch = async () => { throw new Error('fetch must not be used when the bridge is present'); };

  eq('the bridge is detected', Transport.native, true);
  eq('all bridge methods present', Transport.missingBridgeMethods().length, 0);

  const cfg = await Transport.config();
  eq('config comes from the bridge', cfg.medhaUrl, 'http://127.0.0.1:8080');

  await Transport.saveSettings('http://127.0.0.1:8080', 'tok');
  ok('saveSettings goes through the bridge, not fetch',
    seen.some(([k, , t]) => k === 'save' && t === 'tok'));

  eq('clearSettings works over the bridge', (await Transport.clearSettings()).cleared, true);
  eq('detect works over the bridge', (await Transport.detect()).found.length, 1);

  const r = await Transport.request('/health');
  eq('the bridge unwraps the body', r.modelLoaded, true);
  ok('the path is passed through untouched', seen.some(([k, , p]) => k === 'req' && p === '/health'));
}

// ===========================================================================
// 4. Bridge failure modes
// ===========================================================================
{
  globalThis.AndroidMedha = {
    request: () => JSON.stringify({ status: 403, error: 'client lacks the sms capability' }),
  };
  eq('a partial bridge is reported by name',
    Transport.missingBridgeMethods().join(','),
    'getConfig,saveSettings,clearSettings,detect');

  await throws('an in-band error status is re-raised as a throw',
    () => Transport.request('/connectors/sms/status'),
    (e) => e.status === 403 && /sms capability/.test(e.message));

  globalThis.AndroidMedha = { request: () => 'not json at all' };
  await throws('a malformed bridge reply gives an actionable message',
    () => Transport.request('/health'),
    (e) => /unreadable/.test(e.message));

  delete globalThis.AndroidMedha;
}

// ===========================================================================
// 5. Cursors and keys
// ===========================================================================
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };

  eq('no cursor initially', Store.cursor(), null);
  Store.setCursor(1234);
  eq('cursor round-trips as a number', Store.cursor(), 1234);
  Store.setWatermark(9999);
  eq('watermark round-trips', Store.watermark(), 9999);
  Store.reset();
  eq('reset clears the cursor', Store.cursor(), null);
  eq('reset clears the watermark', Store.watermark(), 0);

  // A cursor of 0 means "start from the top", and must not read back as a
  // resumable position — that distinction is what made repeat imports scan
  // three messages and report success.
  Store.setCursor(0);
  eq('a zero cursor is not a resume point', Store.cursor(), null);

  eq('txn keys are namespaced', Keys.txn('abc'), 'txn/abc');
  eq('cat keys are namespaced', Keys.cat('swiggy'), 'cat/swiggy');
  eq('bill keys are namespaced', Keys.bill('x'), 'bill/x');
}

console.log('\n' + '-'.repeat(50));
if (failures.length) console.log(failures.join('\n'));
console.log(`passed=${pass}  failed=${fail}`);
if (fail) process.exit(1);
