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

/**
 * The ids currently awaiting a native answer. Not exported by transport.js —
 * that map is an implementation detail — so it is recovered here by watching
 * the callIds the bridge was handed.
 */
const observedCallIds = new Set();
const pendingIds = () => observedCallIds;

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
// 3. Native bridge (APK) — the async contract
//
// There is no Flask server inside the APK, so anything reaching for
// fetch('/settings') there would silently hit the app shell.
//
// The network methods are ASYNCHRONOUS: a @JavascriptInterface call blocks the
// JS thread until Kotlin returns, and a cold model load takes minutes, so a
// synchronous bridge would freeze the whole interface and end in an ANR. The
// native side answers later via window.__medhaResolve(callId, json).
// ===========================================================================
{
  const seen = [];

  /** Answers on a later tick, exactly as the real bridge does. */
  const reply = (callId, payload, delay = 0) => {
    setTimeout(() => globalThis.__medhaResolve(callId, JSON.stringify(payload)), delay);
  };

  globalThis.AndroidMedha = {
    getConfig: () => JSON.stringify({ version: '2.1.0', medhaUrl: 'http://127.0.0.1:8080', mock: false }),
    clearSettings: () => JSON.stringify({ cleared: true }),
    saveSettingsAsync: (url, token, callId) => {
      seen.push(['save', url, token]);
      reply(callId, { ok: true, medhaUrl: url });
    },
    detectAsync: (callId) => {
      seen.push(['detect']);
      reply(callId, { found: [{ url: 'http://127.0.0.1:8080', modelLoaded: true, tokenOk: null }] });
    },
    requestAsync: (method, path, body, headers, callId) => {
      seen.push(['req', method, path]);
      reply(callId, { status: 200, body: { modelLoaded: true } });
    },
  };
  // If anything falls through to HTTP, this fails loudly.
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
  eq('the async bridge unwraps the body', r.modelLoaded, true);
  ok('the path is passed through untouched', seen.some(([k, , p]) => k === 'req' && p === '/health'));

  // Concurrent calls must not cross wires: each is keyed by its own callId.
  seen.length = 0;
  globalThis.AndroidMedha.requestAsync = (method, path, body, headers, callId) => {
    // Answered out of order and at different delays, which is the realistic
    // case — a /generate and a /health in flight together.
    reply(callId, { status: 200, body: { path } }, path === '/health' ? 5 : 30);
  };
  const [slow, fast] = await Promise.all([
    Transport.request('/generate', { method: 'POST' }),
    Transport.request('/health'),
  ]);
  eq('a slow call gets its own answer', slow.path, '/generate');
  eq('a fast call gets its own answer', fast.path, '/health');

  // An in-band error status must surface as a thrown error, since an exception
  // cannot cross the JNI boundary.
  globalThis.AndroidMedha.requestAsync = (method, path, body, headers, callId) => {
    reply(callId, { status: 403, error: 'client lacks the sms capability', retryAfter: 0 });
  };
  await throws('an async in-band error is re-raised as a throw',
    () => Transport.request('/connectors/sms/status'),
    (e) => e.status === 403 && /sms capability/.test(e.message));

  /*
   * A native side that dies mid-call must not leave the UI pending forever.
   *
   * The real ceiling is 45 seconds, and an earlier version of this test simply
   * waited it out — which made the suite take 45s and would have got it
   * skipped or deleted within a week. What actually needs asserting is that a
   * deadline is ARMED and that a stray resolve cannot settle the wrong call,
   * neither of which requires sitting through it.
   */
  globalThis.AndroidMedha.detectAsync = (callId) => { observedCallIds.add(callId); };
  let settled = false;
  const hanging = Transport.detect().then(
    () => { settled = true; },
    () => { settled = true; },
  );

  // A resolve carrying an id nobody is waiting on must be dropped silently,
  // not throw and not settle an unrelated call.
  let strayThrew = false;
  try {
    globalThis.__medhaResolve('nonexistent-id', '{}');
  } catch {
    strayThrew = true;
  }
  ok('a stray resolve for an unknown id does not throw', !strayThrew);

  await new Promise((r) => setTimeout(r, 20));
  ok('a stray resolve does not settle an unrelated call', settled === false);

  // Settle it so the suite does not hold an open timer.
  globalThis.__medhaResolve([...pendingIds()].pop(), JSON.stringify({ found: [] }));
  await hanging;
  ok('the call settles once its own id is resolved', settled === true);
}

// ===========================================================================
// 3b. An older bundle still works against the sync bridge
//
// A cached page from before the async bridge existed must not silently do
// nothing. It blocks, which is why the async path is preferred, but it works.
// ===========================================================================
{
  const seen = [];
  globalThis.AndroidMedha = {
    getConfig: () => JSON.stringify({ version: '2.0.0', medhaUrl: 'http://127.0.0.1:8080' }),
    clearSettings: () => JSON.stringify({ cleared: true }),
    saveSettings: (url, token) => { seen.push(['save', url, token]); return JSON.stringify({ ok: true }); },
    detect: () => JSON.stringify({ found: [{ url: 'http://127.0.0.1:8080', modelLoaded: true }] }),
    request: (method, path) => {
      seen.push(['req', method, path]);
      return JSON.stringify({ status: 200, body: { modelLoaded: true } });
    },
  };
  globalThis.fetch = async () => { throw new Error('fetch must not be used when the bridge is present'); };

  eq('a sync-only bridge is still detected', Transport.native, true);
  eq('the sync bridge still answers requests', (await Transport.request('/health')).modelLoaded, true);
  await Transport.saveSettings('http://127.0.0.1:8080', 'tok');
  ok('the sync bridge still saves', seen.some(([k]) => k === 'save'));
  eq('the sync bridge still detects', (await Transport.detect()).found.length, 1);
}

// ===========================================================================
// 4. Bridge failure modes
// ===========================================================================
{
  globalThis.AndroidMedha = {
    request: () => JSON.stringify({ status: 403, error: 'client lacks the sms capability' }),
  };
  delete globalThis.__medhaResolve;
  eq('a partial bridge is reported by name',
    Transport.missingBridgeMethods().join(','),
    'getConfig,clearSettings,requestAsync,saveSettingsAsync,detectAsync');

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
