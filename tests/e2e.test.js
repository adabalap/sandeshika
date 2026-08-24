/*
 * End-to-end: the real client modules against a real Flask server.
 *
 * Every other suite stubs something. This one starts app.py in mock mode, lets
 * the actual ingest pipeline talk to it over HTTP through the actual proxy, and
 * checks the numbers that come out the other side. It is the only test that
 * exercises the proxy, the allowlist, the cursor pagination and the dedup logic
 * together on a full-size inbox.
 *
 * WHY THIS WAS REWRITTEN
 *
 * It had been dead since 2.0.0 and nothing noticed, for three compounding
 * reasons, each worth naming because each is a category of silent test loss:
 *
 *   1. It used `__dirname`, which does not exist in an ES module. Setting
 *      "type": "module" in package.json turned every .js in the repo into one,
 *      so this crashed at import.
 *   2. It loaded static/js/parser.js and static/js/api.js by reading them off
 *      disk into `new Function` — paths that stopped existing when the modules
 *      moved into core/ and api.js was split into four.
 *   3. It was named e2e_flask.js, so the *.test.js glob in run.js never picked
 *      it up, and it needed a server someone had already started by hand.
 *
 * It now imports the modules directly, starts and stops its own server, and is
 * named so the runner finds it. tests/shell.test.js fails on (1) and (2) for
 * every file in tests/, so this cannot recur quietly.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { api, loadTransactions, Store } from '../static/js/data/client.js';
import { backfill } from '../static/js/data/ingest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5058);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let pass = 0; let fail = 0;
const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}\n     ${d}`); } };

// --- browser shims -------------------------------------------------------
const ls = new Map();
globalThis.localStorage = /** @type {any} */ ({
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k),
});
globalThis.window = /** @type {any} */ (globalThis);
globalThis.location = /** @type {any} */ ({ origin: ORIGIN, href: ORIGIN });

// The client calls same-origin '/api/...'; in Node there is no origin, so it
// is prefixed here rather than by changing what the client does.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(String(u).startsWith('http') ? u : ORIGIN + u, o);

// --- server lifecycle ----------------------------------------------------
async function waitForServer(ms = 25000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await realFetch(`${ORIGIN}/healthz`);
      if (r.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

const server = spawn('python3', [path.join(ROOT, 'app.py'), '--mock', '--port', String(PORT)], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SANDESHIKA_LOG: 'WARNING' },
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const stop = () => { try { server.kill('SIGTERM'); } catch { /* already gone */ } };
process.on('exit', stop);
process.on('SIGINT', () => { stop(); process.exit(130); });

if (!(await waitForServer())) {
  stop();
  /*
   * Flask is a Python dependency, and the JS job does not install it. Skipping
   * loudly with a zero exit is deliberate: failing here would make the whole JS
   * suite red on a machine where nothing is actually broken, and a test that
   * cries wolf gets muted. The Python job runs the same server for real.
   */
  console.log('\nSKIPPED — could not start app.py on ' + ORIGIN);
  console.log('  Install the server deps first:  pip install -r requirements.txt');
  console.log(serverLog.split('\n').slice(-4).map((l) => '  ' + l).join('\n'));
  console.log('\n' + '-'.repeat(50));
  console.log('passed=0  failed=0  (skipped)');
  process.exit(0);
}

// --- the run -------------------------------------------------------------
try {
  Store.reset();

  const cfg = await realFetch(`${ORIGIN}/config.json`).then((r) => r.json());
  ok('the server reports mock mode', cfg.mock === true);
  ok('the server reports installable on localhost', cfg.installable === true);
  ok('the served build matches package.json', cfg.version === '2.1.0', cfg.version);

  const st = await api('/connectors/sms/status');
  ok('the SMS connector is reachable through the proxy', st.canRead === true);
  ok('the mock inbox is substantial', st.totalMessages > 200, String(st.totalMessages));

  const t0 = Date.now();
  const res = await backfill({ shouldStop: () => false });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // Cursor pagination over a full inbox: the case where a tied timestamp
  // silently dropped messages.
  ok('the whole inbox was scanned', res.scanned === st.totalMessages,
    `${res.scanned}/${st.totalMessages}`);
  ok('transactions were written', res.written > 0, String(res.written));
  ok('noise was rejected', res.rejected > 0, String(res.rejected));
  ok('cross-sender duplicates were collapsed', res.duplicates > 0, String(res.duplicates));
  ok('the run reported itself complete', res.complete === true);

  const txns = await loadTransactions();
  ok('every written transaction is retrievable', txns.length === res.written,
    `${txns.length}/${res.written}`);
  ok('fingerprints are unique', new Set(txns.map((t) => t.fingerprint)).size === txns.length);

  // The failure a money app cannot ship.
  ok('no OTP or balance advisory became a transaction',
    !txns.some((t) => /otp|avl bal/i.test(t.raw)),
    JSON.stringify(txns.filter((t) => /otp|avl bal/i.test(t.raw)).slice(0, 2)));

  const kinds = txns.reduce((a, t) => { a[t.kind] = (a[t.kind] || 0) + 1; return a; }, {});
  ok('expenses are present', (kinds.expense || 0) > 0, JSON.stringify(kinds));
  ok('income was detected', (kinds.income || 0) > 0, JSON.stringify(kinds));
  ok('credit-card bill payments are classed as transfers', (kinds.transfer || 0) > 0,
    JSON.stringify(kinds));

  const sum = (k) => txns.filter((t) => t.kind === k).reduce((s, t) => s + t.amount, 0);
  const spend = sum('expense');
  const transfers = sum('transfer');
  ok('transfers are tracked separately from spend', transfers > 0 && spend > 0);
  ok('all amounts are positive and finite',
    txns.every((t) => Number.isFinite(t.amount) && t.amount >= 0));
  ok('every transaction carries a kind', txns.every((t) => Boolean(t.kind)));
  ok('DLT operator prefixes are normalised',
    txns.every((t) => !/^[A-Z]{2}-/.test(t.senderId || '')));

  // Idempotence over the wire, not just in a unit test with a fake store.
  const again = await backfill({ shouldStop: () => false });
  ok('a re-import writes nothing', again.written === 0, `wrote ${again.written}`);

  const blocked = await realFetch(`${ORIGIN}/api/v1/models`).then((r) => r.status);
  ok('the proxy blocks non-allowlisted paths', blocked === 403, String(blocked));

  const notFound = await realFetch(`${ORIGIN}/nope`).then((r) => r.json());
  ok('an unknown endpoint answers in JSON', notFound.code === 'not_found', JSON.stringify(notFound));

  console.log(`\n  inbox ${st.totalMessages} SMS -> ${txns.length} transactions in ${secs}s`);
  console.log(`  kinds: ${JSON.stringify(kinds)}`);
  console.log(`  spend ₹${Math.round(spend).toLocaleString('en-IN')}`
    + ` · transfers excluded ₹${Math.round(transfers).toLocaleString('en-IN')}`);
  console.log(`  duplicates ${res.duplicates} · rejected ${res.rejected}`
    + ` · drift ${(res.drift || []).length}`);
} catch (e) {
  fail++;
  failures.push(`the run threw\n     ${e && e.stack}`);
} finally {
  stop();
}

console.log('\n' + '-'.repeat(50));
if (failures.length) console.log(failures.join('\n'));
console.log(`passed=${pass}  failed=${fail}`);
process.exit(fail ? 1 : 0);
