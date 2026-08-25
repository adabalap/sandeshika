/**
 * Sandeshika — Medha client.
 *
 * The storage and error primitives everything else is built on. Split out of
 * the old monolithic api.js so that the ingest pipeline, the category resolver
 * and the UI can each be read — and tested — without dragging in the other two.
 */

import Transport from './transport.js';

/** @typedef {import('../core/types.js').Txn} Txn */

export class ApiError extends Error {
  /**
   * @param {string} msg
   * @param {number} [status]
   * @param {number} [retryAfter] Seconds Medha asked us to wait, from Retry-After.
   */
  constructor(msg, status = 0, retryAfter = 0) {
    super(msg);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter || 0;
  }
}

/**
 * One call to Medha. Normalises every failure into an ApiError so callers
 * never have to distinguish a thrown TypeError from an HTTP status.
 * @param {string} path
 * @param {RequestInit} [opts]
 * @returns {Promise<any>}
 */
export async function api(path, opts = {}) {
  try {
    return await Transport.request(path, opts);
  } catch (e) {
    const err = /** @type {any} */ (e);
    if (err instanceof ApiError) throw err;
    if (typeof err.status === 'number' && err.status > 0) {
      throw new ApiError(err.message, err.status, err.retryAfter);
    }
    // No status at all means the request never reached anything: the Flask
    // host is down, the phone is unplugged, or the WebView has no bridge.
    throw new ApiError(
      Transport.native
        ? 'Could not reach Medha from the app.'
        : 'The Sandeshika server is not reachable.',
      0, 0,
    );
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Batch-priority call with backoff.
 *
 * 429 means Medha is thermally gated or its queue is full. The only correct
 * response is to wait exactly as long as it asked and try again — hammering it
 * makes the phone hotter, which makes the gate stay shut for longer.
 * @param {string} path
 * @param {unknown} body
 * @param {(msg: string, secs: number) => void} [onWait]
 */
export async function batchCall(path, body, onWait) {
  const MAX_ATTEMPTS = 6;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await api(path, {
        method: 'POST',
        headers: { 'X-Medha-Priority': 'batch' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const err = /** @type {ApiError} */ (e);
      if (err.status !== 429) throw err;
      const wait = err.retryAfter || 5;
      if (onWait) onWait(err.message, wait);
      await sleep(wait * 1000);
    }
  }
  throw new ApiError(`Medha stayed busy after ${MAX_ATTEMPTS} attempts`, 429, 30);
}

// ---------------------------------------------------------------------------
// Scan cursors — the only thing kept in browser storage.
//
// Everything durable lives in Medha's /store, never in localStorage or
// IndexedDB: browser storage is evictable, Android drops it under memory
// pressure, and a financial history that silently disappears is worse than no
// app at all. A cursor is different — losing it costs one re-scan, and a
// re-scan is idempotent.
// ---------------------------------------------------------------------------

const CURSOR_KEY = 'sandeshika.cursor';   // oldest SMS date processed so far
const WATERMARK_KEY = 'sandeshika.high';  // newest SMS date processed so far

/** Tolerates a WebView with storage disabled rather than throwing on boot. */
function safeStorage() {
  try {
    const s = globalThis.localStorage;
    s.getItem(CURSOR_KEY);
    return s;
  } catch {
    /** @type {Map<string, string>} */
    const mem = new Map();
    return /** @type {Storage} */ (/** @type {unknown} */ ({
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
    }));
  }
}

export const Store = {
  /** @returns {number|null} */
  cursor: () => Number(safeStorage().getItem(CURSOR_KEY) || 0) || null,
  setCursor: (v) => safeStorage().setItem(CURSOR_KEY, String(v)),
  watermark: () => Number(safeStorage().getItem(WATERMARK_KEY) || 0),
  setWatermark: (v) => safeStorage().setItem(WATERMARK_KEY, String(v)),
  reset: () => {
    safeStorage().removeItem(CURSOR_KEY);
    safeStorage().removeItem(WATERMARK_KEY);
  },
};

// ---------------------------------------------------------------------------
// Key-value store
// ---------------------------------------------------------------------------

export const Keys = {
  /** @param {string} fp */
  txn: (fp) => `txn/${fp}`,
  /** @param {string} mk */
  cat: (mk) => `cat/${mk}`,
  /** @param {string} fp */
  bill: (fp) => `bill/${fp}`,
  /** @param {string} k */
  meta: (k) => `meta/${k}`,
};

/**
 * Precedence for a category decision:
 *
 *   user > rule > sender prior > learned model > cached LLM > fallback
 *
 * A correction the user made outranks everything and is never overwritten by a
 * later rule change or model answer. That is the whole point: if they told us
 * once, asking again is a bug.
 */
export const SOURCE_RANK = {
  user: 6, rule: 5, sender: 4, model: 3, llm: 2, guess: 1, fallback: 0, unresolved: 0,
};

const PAGE = 500;

/**
 * @param {Array<{key: string, value: string}>} items
 * @returns {Promise<number>} how many were written
 */
export async function putMany(items) {
  if (!items.length) return 0;
  const out = await api('/store/bulk', { method: 'POST', body: JSON.stringify({ items }) });
  return out.written;
}

/**
 * @param {string} prefix
 * @param {number} [limit]
 * @returns {Promise<Array<{key: string, value: string}>>}
 */
export async function listPrefix(prefix, limit = 1000) {
  /** @type {Array<{key: string, value: string}>} */
  const all = [];
  let offset = 0;
  for (;;) {
    const page = await api(
      `/store?prefix=${encodeURIComponent(prefix)}&limit=${PAGE}&offset=${offset}`);
    all.push(...page.items);
    if (page.items.length < PAGE || all.length >= limit) break;
    offset += PAGE;
  }
  return all;
}

/**
 * A single stored row that failed to parse is skipped, not fatal. One corrupt
 * value must not take the whole ledger down with it.
 * @returns {Promise<Txn[]>}
 */
export async function loadTransactions() {
  const rows = await listPrefix('txn/', 100000);
  /** @type {Txn[]} */
  const out = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.value));
    } catch {
      // Skip; the fingerprint is still in the key, so a re-import restores it.
    }
  }
  return out;
}

/** @param {Txn} t */
export const txnWrite = (t) => ({ key: Keys.txn(t.fingerprint), value: JSON.stringify(t) });

/** @param {Txn} t */
export async function putTxn(t) {
  await api(`/store/${Keys.txn(t.fingerprint)}`, { method: 'PUT', body: JSON.stringify(t) });
}

/** @param {string} fingerprint */
export async function deleteTxn(fingerprint) {
  await api(`/store/${Keys.txn(fingerprint)}`, { method: 'DELETE' });
}
