/**
 * Sandeshika — actions.
 *
 * Everything the user can cause to happen. Views render state; actions change
 * it. Keeping the two apart is what stops a render function from quietly
 * issuing a network call, which is how the old single-file version ended up
 * re-fetching the whole ledger from inside a redraw.
 *
 * Every action here ends by updating state, which notifies the views. None of
 * them reach into the DOM to re-render a specific element.
 */

import * as P from '../core/parser.js';
import { buildDriftReport } from '../core/redact.js';
import * as O from '../core/organizer.js';
import { inrExact, esc, csvCell } from '../core/format.js';
import {
  api, ApiError, Store, Keys, listPrefix, putMany, loadTransactions, putTxn, deleteTxn,
} from '../data/client.js';
import Transport from '../data/transport.js';
import {
  retrainModel, correctCategory, setKind as apiSetKind, kindFor, learnedRules, forgetRule,
} from '../data/categories.js';
import { backfill, catchUp } from '../data/ingest.js';
import { banner, toast, setHtml, setText, setHidden, showSkeleton, download, val, $ } from './dom.js';
import { friendly } from './errors.js';
import * as state from './state.js';
import { renderSettingsForm, renderImportHint, setProgress, statsHtml, renderDrift, renderLearned }
  from './views/setup.js';

/** @typedef {import('../core/types.js').Txn} Txn */

const CATEGORY_NAME_RE = /^[a-z][a-z0-9 &-]{1,23}$/;
const INBOX_PAGE = 400;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Re-reads the ledger and retrains from the user's confirmed labels. */
export async function reload() {
  const first = !state.get().txns.length;
  if (first) {
    showSkeleton('#txnList', 5);
    showSkeleton('#dayList', 4);
  }
  try {
    const txns = await loadTransactions();
    state.set({ txns });
    // Retrain so the next unknown merchant benefits from every correction made
    // so far. Failure here degrades predictions; it must not block the screen.
    await retrainModel(txns).catch(() => {});
    setText('#drawerSub', txns.length
      ? `${txns.length} transactions · on this device`
      : 'సందేశిక');
    await refreshLearned();
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

export async function refreshLearned() {
  try {
    renderLearned(await learnedRules());
  } catch {
    // Setup remains usable without the learning log.
  }
}

export async function loadCustomCats() {
  try {
    const r = await api('/store/meta/categories');
    state.set({ customCats: Array.isArray(r) ? r : (r.categories || []) });
  } catch {
    state.set({ customCats: [] });
  }
}

async function saveCustomCats() {
  await api('/store/meta/categories', {
    method: 'PUT',
    body: JSON.stringify({ categories: state.get().customCats }),
  });
}

export async function addCustomCat(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!CATEGORY_NAME_RE.test(v)) {
    banner('Use 2-24 letters, digits, spaces or &-', 'error');
    return false;
  }
  const s = state.get();
  if (P.CATEGORIES.concat(s.customCats).includes(v)) {
    banner('That category already exists', 'error');
    return false;
  }
  const next = s.customCats.concat(v);
  state.set({ customCats: next });
  try {
    await saveCustomCats();
    banner(`Added "${v}"`);
    return true;
  } catch (e) {
    state.set({ customCats: next.filter((c) => c !== v) });
    banner(friendly(e), 'error');
    return false;
  }
}

export async function removeCustomCat(c) {
  const before = state.get().customCats;
  state.set({ customCats: before.filter((x) => x !== c) });
  try {
    await saveCustomCats();
    banner(`Removed "${c}"`);
  } catch (e) {
    state.set({ customCats: before });
    banner(friendly(e), 'error');
  }
}

// ---------------------------------------------------------------------------
// Inbox and bills
// ---------------------------------------------------------------------------

export async function loadInbox(limit = INBOX_PAGE) {
  setHidden('#inboxEmptyCard', true);
  setText('#inboxCount', 'Reading messages…');
  // Reading 400 messages over adb takes a visible moment. A shaped placeholder
  // says "a list is coming"; a spinner only says "something is happening".
  showSkeleton('#inboxList', 6);
  try {
    const page = await api('/connectors/sms/messages?limit=' + limit);
    state.set({ inbox: page.messages.map((m) => ({ sms: m, cls: O.classify(m) })) });
    await refreshBills();
  } catch (e) {
    setHidden('#inboxEmptyCard', false);
    setText('#inboxCount', '');
    banner(friendly(e), 'error');
  }
}

/**
 * Rebuilds the bill list from the loaded messages, then layers the stored
 * status (paid / dismissed) on top.
 *
 * One bill produces several reminders; the fingerprint collapses them, and the
 * newest sighting wins because amounts get revised between reminders.
 */
export async function refreshBills() {
  const { inbox } = state.get();
  /** @type {Map<string, import('../core/types.js').Bill>} */
  const found = new Map();
  for (const r of inbox) {
    if (r.cls.tab !== O.TAB.BILLS) continue;
    const b = O.extractBill(r.sms);
    if (!b) continue;
    const prev = found.get(b.fingerprint);
    if (!prev || prev.seenAt < b.seenAt) found.set(b.fingerprint, b);
  }

  /** @type {Record<string, object>} */
  const saved = {};
  try {
    for (const r of await listPrefix('bill/', 500)) {
      try {
        saved[r.key.replace(/^bill\//, '')] = JSON.parse(r.value);
      } catch { /* one unreadable row must not lose the rest */ }
    }
  } catch {
    // Offline or store unavailable: show freshly parsed bills as open rather
    // than showing nothing at all.
  }

  state.set({ bills: [...found.values()].map((b) => ({ ...b, ...(saved[b.fingerprint] || {}) })) });
}

export async function setBillStatus(fp, status) {
  const bills = state.get().bills.map((b) => (b.fingerprint === fp ? { ...b, status } : b));
  state.set({ bills });
  try {
    await api('/store/' + Keys.bill(fp), {
      method: 'PUT',
      body: JSON.stringify({ status, updatedAt: Date.now() }),
    });
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

export async function setTxnKind(kind) {
  const t = state.openTxn();
  if (!t) return;
  setHtml('#kindSaveState', '<span class="warn">Saving…</span>');
  try {
    const wide = val('#catScope') === 'merchant' && Boolean(t.merchant);
    const r = await apiSetKind(t, kind, { merchantWide: wide });
    setHtml('#kindSaveState', `<span class="ok">Counted as ${esc(kind)}`
      + (r.updated > 1 ? ` — ${r.updated} transactions from "${esc(t.merchant)}" updated` : '')
      + '.</span>');
    await reload();
  } catch (e) {
    setHtml('#kindSaveState', `<span class="err">${esc(friendly(e))}</span>`);
  }
}

export async function setCategory(cat) {
  const t = state.openTxn();
  if (!t) return;
  setHtml('#txnSaveState', '<span class="warn">Saving…</span>');
  try {
    if (val('#catScope') === 'one' || !t.merchant) {
      // Same kind rule as the bulk path, so a one-off correction and a
      // merchant-wide one can never disagree about whether it is spending.
      await putTxn({
        ...t,
        category: cat,
        categorySource: 'user',
        kind: kindFor(cat, t),
        needsReview: false,
        reviewed: true,
      });
      setHtml('#txnSaveState', '<span class="ok">Saved for this transaction.</span>');
    } else {
      const r = await correctCategory(t.merchant, cat);
      setHtml('#txnSaveState', `<span class="ok">Saved. ${r.updated} past transaction`
        + `${r.updated === 1 ? '' : 's'} from "${esc(t.merchant)}" updated, and future `
        + 'ones will use it too.</span>');
    }
    await reload();
  } catch (e) {
    setHtml('#txnSaveState', `<span class="err">${esc(friendly(e))}</span>`);
  }
}

export async function forgetLearned(mk) {
  try {
    await forgetRule(mk);
    banner('Forgotten');
    await refreshLearned();
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

/** Accepting counts a transaction; rejecting deletes it. */
export async function resolveReview(fp, accept) {
  const t = state.findTxn(fp);
  if (!t) return;
  try {
    if (accept) {
      await putTxn({ ...t, reviewed: true, needsReview: false });
      state.set({
        txns: state.get().txns.map((x) => (x.fingerprint === fp
          ? { ...x, reviewed: true, needsReview: false } : x)),
      });
    } else {
      await deleteTxn(fp);
      state.set({ txns: state.get().txns.filter((x) => x.fingerprint !== fp) });
    }
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

/** Marks both halves of a suggested pair as an internal transfer, in one write. */
export async function markPairAsTransfer(i) {
  const p = state.get().pairs[i];
  if (!p) return;
  try {
    await putMany([p.debit, p.credit].map((t) => ({
      key: Keys.txn(t.fingerprint),
      value: JSON.stringify({
        ...t,
        kind: 'transfer',
        category: 'transfer',
        categorySource: 'user',
        kindSource: 'user',
        needsReview: false,
        reviewed: true,
      }),
    })));
    banner(`${inrExact(p.amount)} marked as a transfer — removed from both spending and income`);
    await reload();
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export async function runImport(restart = false) {
  state.setQuiet({ stopRequested: false });
  const btn = /** @type {HTMLButtonElement|null} */ ($('#btnImport'));
  if (btn) btn.disabled = true;
  const stop = $('#btnStop');
  if (stop) stop.classList.remove('hidden');

  const finish = () => {
    if (btn) btn.disabled = false;
    if (stop) stop.classList.add('hidden');
    renderImportHint();
  };

  let total = 0;
  try {
    // Three separate things must be true and each has a different remedy.
    // Reporting them apart is the difference between a two-minute fix and an
    // afternoon.
    const st = await api('/connectors/sms/status');
    if (st.supported === false) {
      throw new ApiError('This Medha build has no SMS connector. Install the "full" APK — '
        + 'the "core" build ships without SMS permissions so it installs cleanly.', 0, 0);
    }
    if (!st.canRead) {
      throw new ApiError("Medha does not have Android's SMS permission yet. "
        + 'Medha → menu → SMS connector → Grant SMS permission.', 0, 0);
    }
    total = st.totalMessages || 0;
  } catch (e) {
    banner(friendly(e), 'error');
    finish();
    return;
  }

  try {
    const res = await backfill({
      restart,
      shouldStop: () => state.get().stopRequested,
      onWait: (msg, secs) => setProgress(0, `Paused — ${msg}. Retrying in ${secs}s`),
      onProgress: (t) => {
        setProgress(total ? (t.scanned / total) * 100 : 0,
          `${t.scanned} of ${total || '?'} messages · ${t.written} transactions found`);
        setHtml('#importStats', statsHtml(t));
        renderDrift(t.drift);
      },
    });

    setProgress(100, res.stopped ? 'Stopped — resume any time' : 'Import complete');
    // Scanning far fewer messages than exist almost always means a stale cursor
    // sent the run to the end of history. Say so, rather than reporting success
    // over an empty result.
    if (!res.stopped && total && res.scanned < total * 0.5) {
      banner(`Only ${res.scanned} of ${total} messages were read — a previous run had already `
        + 'reached the end. Tap "Re-scan everything" to read them all.', 'error');
    }
    setHtml('#importStats', statsHtml(res));
    renderDrift(res.drift);
    await reload();
  } catch (e) {
    banner('Import stopped: ' + friendly(e), 'error');
  } finally {
    finish();
  }
}

export function requestStop() {
  state.setQuiet({ stopRequested: true });
}

export async function refresh() {
  const btn = $('#btnRefresh');
  if (btn) btn.classList.add('spin');
  try {
    const r = await catchUp();
    if (r.needsBackfill) {
      banner('Nothing imported yet — run the first import from Setup.', 'error');
    } else {
      banner(r.written ? `${r.written} new transactions` : 'Up to date');
      if (r.written) await reload();
    }
  } catch (e) {
    banner(friendly(e), 'error');
  } finally {
    if (btn) btn.classList.remove('spin');
  }
}

export async function resetAll() {
  try {
    const rows = await listPrefix('txn/', 100000);
    // Sequential on purpose: a hundred parallel deletes is exactly the burst
    // that makes Medha's queue reject the rest of them.
    for (const r of rows) {
      await api('/store/' + r.key, { method: 'DELETE' }).catch(() => {});
    }
    Store.reset();
    state.set({ txns: [] });
    banner('All Sandeshika data deleted');
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function checkConnection() {
  const el = $('#connState');
  const say = (html) => { if (el) el.innerHTML = html; };
  try {
    state.set({ cfg: await Transport.config() });
    renderSettingsForm();
    const { cfg } = state.get();

    if (!cfg.mock && !cfg.tokenConfigured) {
      say('<span class="warn">No token saved yet — paste one above.</span>');
      return false;
    }

    const h = await api('/health');
    if (cfg.mock) {
      say('<span class="warn">Demo mode — synthetic inbox, mock model. '
        + 'Figures are computed for real from generated messages.</span>');
      return true;
    }
    if (!h.modelLoaded) {
      say('<span class="warn">Medha is reachable but no model is loaded.</span>');
      return false;
    }
    await api('/store?prefix=meta/&limit=1'); // proves the token is accepted

    say(`<span class="ok">Connected to ${esc(cfg.medhaUrl)} · model loaded</span>`
      + await smsStatusHtml() + versionHtml(cfg));

    if (!cfg.installable) banner('Open via localhost or HTTPS to install as an app', 'info');
    return true;
  } catch (e) {
    say(`<span class="err">${esc(friendly(e))}</span>`);
    return false;
  }
}

/** Checked here, while the user is on the screen that explains how to fix it. */
async function smsStatusHtml() {
  try {
    const st = await api('/connectors/sms/status');
    if (st.supported === false) {
      return '<br><span class="err">No SMS connector in this Medha build — install the "full" APK.</span>';
    }
    if (!st.canRead) {
      return "<br><span class=\"warn\">Medha lacks Android's SMS permission. "
        + 'Medha → menu → SMS connector → Grant.</span>';
    }
    return `<br><span class="ok">SMS access OK · ${st.totalMessages} messages visible</span>`;
  } catch (e) {
    const err = /** @type {ApiError} */ (e);
    return err.status === 403
      ? '<br><span class="err">This client cannot read SMS. Medha → API clients → '
        + 'Edit permissions → tick "Read SMS".</span>'
      : `<br><span class="warn">${esc(friendly(e))}</span>`;
  }
}

/**
 * A service worker serving stale JS is invisible from the inside and has cost
 * days of debugging behaviour the device was not running. Comparing the page's
 * build against the server's makes it loud.
 */
function versionHtml(cfg) {
  const build = state.get().build;
  if (cfg.version && build && cfg.version !== build) {
    return `<br><span class="err">This page is build ${esc(build)} but the server is `
      + `${esc(cfg.version)} — an old copy is cached. Pull down to refresh, or reinstall.</span>`;
  }
  return cfg.version ? `<br><span class="row-sub">build ${esc(cfg.version)}</span>` : '';
}

export async function saveSettings() {
  const el = $('#connState');
  const btn = /** @type {HTMLButtonElement|null} */ ($('#btnSaveToken'));
  if (btn) btn.disabled = true;
  if (el) el.innerHTML = '<span class="warn">Checking…</span>';
  try {
    // Transport picks the native bridge (APK) or the Flask proxy (browser).
    // Calling fetch('/settings') directly worked in the browser and failed in
    // the APK, where there is no server to answer it.
    await Transport.saveSettings(val('#medhaUrl').trim(), val('#tokenInput').trim());
    const input = /** @type {HTMLInputElement|null} */ ($('#tokenInput'));
    if (input) input.value = '';
    banner('Connected to Medha');
    await checkConnection();
    await reload();
  } catch (e) {
    if (el) el.innerHTML = `<span class="err">${esc(friendly(e))}</span>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function clearSettings() {
  try {
    await Transport.clearSettings();
    banner('Saved settings cleared');
    await checkConnection();
  } catch (e) {
    banner(friendly(e), 'error');
  }
}

export async function detect() {
  const el = $('#connState');
  if (el) el.innerHTML = '<span class="warn">Scanning the usual ports…</span>';
  try {
    const r = await Transport.detect();
    if (!r.found || !r.found.length) {
      if (el) {
        el.innerHTML = '<span class="err">No Medha found on '
          + esc((r.tried || []).join(', '))
          + '. Check the port shown in the Medha app, and that it is running.</span>';
      }
      return;
    }
    // Prefer one that already accepts the saved token.
    const best = r.found.find((f) => f.tokenOk) || r.found[0];
    const input = /** @type {HTMLInputElement|null} */ ($('#medhaUrl'));
    if (input) input.value = best.url;
    if (el) {
      el.innerHTML = `<span class="ok">Found Medha at ${esc(best.url)}`
        + (best.modelLoaded ? ' · model loaded' : ' · no model loaded')
        + (best.tokenOk === false ? ' · saved token rejected, paste a new one' : '')
        + '</span>';
    }
    if (best.tokenOk) await saveSettings();
  } catch (e) {
    if (el) el.innerHTML = `<span class="err">${esc(friendly(e))}</span>`;
  }
}

/**
 * Names the failing layer instead of leaving us to guess.
 *
 * Four things sit between a tap and an answer: the transport, the Sandeshika
 * host, Medha itself, and the token. A single "Failed to fetch" is consistent
 * with all four, which is why the same symptom has been chased through the
 * wrong layer more than once.
 */
export async function diagnose() {
  const out = $('#diagOut');
  if (!out) return;
  out.hidden = false;
  const lines = [];
  const flush = () => { out.textContent = lines.join('\n'); };

  const step = async (label, fn) => {
    try {
      const r = await fn();
      lines.push(`PASS  ${label}${r ? '  ' + r : ''}`);
      return true;
    } catch (e) {
      lines.push(`FAIL  ${label}\n        ${/** @type {Error} */ (e).message}`);
      return false;
    } finally {
      flush();
    }
  };

  lines.push(`page build  : ${state.get().build}`);
  lines.push(`transport   : ${Transport.native ? 'native bridge (APK)' : 'HTTP proxy (browser)'}`);
  if (Transport.native) {
    const missing = Transport.missingBridgeMethods();
    lines.push(missing.length
      ? `bridge      : MISSING ${missing.join(', ')} — the APK and its web assets are out of step`
      : 'bridge      : all methods present');
  }
  flush();

  await step('read configuration', async () => {
    const c = await Transport.config();
    return `address ${c.medhaUrl}, token ${c.tokenConfigured ? c.tokenPreview : 'NOT SET'}`;
  });

  const reachable = await step('Medha /health', async () => {
    const h = await api('/health');
    return `model ${h.modelLoaded ? 'loaded' : 'NOT loaded'}, backend ${h.backend || '?'}`;
  });

  if (reachable) {
    await step('token accepted (/store)', async () => {
      await api('/store?prefix=meta/&limit=1');
      return 'yes';
    });
    await step('SMS connector', async () => {
      const st = await api('/connectors/sms/status');
      if (st.supported === false) throw new Error('this Medha build has no SMS connector — install the "full" APK');
      if (!st.canRead) throw new Error("Medha lacks Android's SMS permission — Medha → menu → SMS connector → Grant");
      return `${st.totalMessages} messages visible`;
    });
    await step('read one page of messages', async () => {
      const p = await api('/connectors/sms/messages?limit=5');
      if (!p.messages.length) throw new Error('the connector returned no messages at all');
      return `${p.messages.length} returned, newest ${new Date(p.messages[0].date).toLocaleString()}`;
    });
  } else {
    await step('scan for Medha', async () => {
      const d = await Transport.detect();
      if (!d.found || !d.found.length) throw new Error('nothing answered on any common port');
      return d.found.map((f) => f.url).join(', ');
    });
  }
  lines.push('', 'Send this text if you need help — it contains no personal data.');
  flush();
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const CSV_COLS = ['date', 'kind', 'direction', 'amount', 'currency', 'merchant', 'category',
  'categorySource', 'channel', 'account', 'bank', 'ref', 'confidence', 'needsReview'];

export function exportCsv() {
  const { txns } = state.get();
  if (!txns.length) {
    banner('Nothing to export yet', 'error');
    return;
  }
  const lines = [CSV_COLS.join(',')];
  for (const t of txns.slice().sort((a, b) => a.date - b.date)) {
    lines.push(CSV_COLS.map((c) =>
      csvCell(c === 'date' ? new Date(t.date).toISOString() : t[c])).join(','));
  }
  download(`sandeshika-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
    lines.join('\n'), 'text/csv');
  banner(`Exported ${txns.length} transactions`);
}

export function exportJson() {
  const { txns, bills } = state.get();
  const payload = {
    app: 'Sandeshika',
    exportedAt: new Date().toISOString(),
    // Stated so a future reader knows what the numbers mean without the app.
    notes: 'Amounts in INR. kind: expense | income | refund | transfer. '
      + 'Transfers and investments are excluded from spending totals. Rows with '
      + 'needsReview=true and reviewed!=true are excluded from in-app totals.',
    transactions: txns,
    bills,
  };
  download(`sandeshika-export-${new Date().toISOString().slice(0, 10)}.json`,
    JSON.stringify(payload, null, 2), 'application/json');
  banner(`Exported ${txns.length} transactions and ${bills.length} bills`);
}

/**
 * The shareable report — always redacted, whichever view is on screen.
 *
 * Deliberately NOT tied to the toggle. The toggle exists so a user can inspect
 * what actually arrived; the copy button exists so they can send it to someone
 * else. Letting the toggle decide what lands on the clipboard would make one
 * stray tap the difference between a bug report and a disclosure.
 */
function driftReport() {
  const { drift, build } = state.get();
  return buildDriftReport(drift, { build, normaliseSender: P.normaliseSender });
}

export async function copyDrift() {
  const { drift } = state.get();
  if (!drift.length) {
    banner('Nothing to share — no unrecognised messages.', 'error');
    return;
  }
  const report = driftReport();
  try {
    await navigator.clipboard.writeText(report.text);
    const n = Object.values(report.counts).reduce((a, b) => a + b, 0);
    if (report.warnings.length) {
      toast(`Copied, but check it first — it still resembles ${report.warnings.join(', ')}.`,
        'error');
    } else {
      toast(`Copied ${drift.length} redacted message${drift.length === 1 ? '' : 's'} `
        + `· ${n} personal value${n === 1 ? '' : 's'} replaced`, 'success');
    }
  } catch {
    // Clipboard access is refused in plenty of ordinary situations — an
    // insecure origin, a WebView without permission. Offer the file instead of
    // just failing.
    banner('The clipboard is not available here. Save it as a file instead.', 'error',
      { action: { label: 'Save file', onClick: downloadDrift } });
  }
}

export function downloadDrift() {
  const { drift } = state.get();
  if (!drift.length) {
    banner('Nothing to share — no unrecognised messages.', 'error');
    return;
  }
  const report = driftReport();
  download(`sandeshika-unrecognised-${new Date().toISOString().slice(0, 10)}.txt`,
    report.text, 'text/plain');
  toast('Saved. It contains no personal data, but read it before sending.', 'success');
}
