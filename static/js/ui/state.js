/**
 * Sandeshika — UI state.
 *
 * One place holds what the screen is showing. The previous build kept this as
 * eleven module-level `let`s plus `window.__pairs` and `window.__drift`, which
 * meant any view could quietly reach into another's variables and the render
 * order was whatever the call sites happened to do. Stashing state on `window`
 * also put it one typo away from colliding with anything else on the page.
 *
 * Deliberately not a framework. Subscribers are notified on change, views
 * re-read what they need, and that is the whole mechanism.
 */

/** @typedef {import('../core/types.js').Txn} Txn */
/** @typedef {import('../core/types.js').Bill} Bill */
/** @typedef {import('../core/types.js').Sms} Sms */
/** @typedef {import('../core/types.js').Classification} Classification */
/** @typedef {import('../core/types.js').DriftRow} DriftRow */
/** @typedef {import('../core/types.js').AppConfig} AppConfig */

/**
 * @typedef {object} AppState
 * @property {Txn[]} txns
 * @property {Bill[]} bills
 * @property {Array<{sms: Sms, cls: Classification}>} inbox
 * @property {DriftRow[]} drift
 * @property {Array<{debit: Txn, credit: Txn, amount: number}>} pairs
 * @property {string[]} customCats
 * @property {AppConfig} cfg
 * @property {string} build Page build string, compared against the server's to spot a stale cache.
 * @property {import('../core/analytics.js').PeriodName} period
 * @property {import('../core/analytics.js').DailyPeriodName} dailyPeriod
 * @property {'safe'|'original'} driftView
 * @property {string} inboxTab
 * @property {number} listLimit
 * @property {number} inboxLimit
 * @property {string|null} openDay
 * @property {string|null} openTxnFp
 * @property {boolean} stopRequested
 */

/** @type {AppState} */
const state = {
  txns: [],
  bills: [],
  inbox: [],
  drift: [],
  pairs: [],
  customCats: [],
  cfg: {},
  build: '',
  period: 'thisMonth',
  dailyPeriod: 'thisMonth',
  driftView: 'safe',
  inboxTab: 'transactions',
  listLimit: 50,
  inboxLimit: 40,
  openDay: null,
  openTxnFp: null,
  stopRequested: false,
};

/** @type {Set<(s: AppState) => void>} */
const listeners = new Set();

/** @returns {Readonly<AppState>} */
export const get = () => state;

/**
 * Applies a partial update and notifies subscribers.
 * @param {Partial<AppState>} patch
 */
export function set(patch) {
  Object.assign(state, patch);
  notify();
}

/** Updates without notifying — for transient values that do not affect render. */
export function setQuiet(patch) {
  Object.assign(state, patch);
}

export function notify() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch (e) {
      // One broken view must not stop the others from painting.
      console.error('render failed', e);
    }
  }
}

/** @param {(s: AppState) => void} fn */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------
// Derived lookups used by more than one view
// ---------------------------------------------------------------------------

/** @param {string} fp */
export const findTxn = (fp) => state.txns.find((t) => t.fingerprint === fp) || null;

/** @param {string} fp */
export const findBill = (fp) => state.bills.find((b) => b.fingerprint === fp) || null;

/** The currently open transaction, re-read from the list so it is never stale. */
export const openTxn = () => (state.openTxnFp ? findTxn(state.openTxnFp) : null);
