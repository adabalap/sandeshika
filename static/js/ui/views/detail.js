/**
 * Sandeshika — drill-down: a single day, a single transaction, and the generic
 * list behind any headline tile.
 *
 * Every tile in the app leads somewhere. A total the user cannot open is a
 * total they cannot check or correct, and correcting is how the app learns.
 */

import { inr, inrExact, esc, fmtDayLong, dayKey, dayKeyToDate, plural } from '../../core/format.js';
import { isSpend } from '../../core/analytics.js';
import * as P from '../../core/parser.js';
import { segments, coverage } from '../../core/provenance.js';
import { KINDS } from '../../data/categories.js';
import { setHtml, setText, showView, $ } from '../dom.js';
import { KIND_LABEL } from '../theme.js';
import { txnRow, empty } from '../components.js';
import * as state from '../state.js';

const spendTotal = (rows) => rows.filter(isSpend).reduce((a, t) => a + t.amount, 0);

/**
 * Opens the rows behind any headline figure.
 * @param {string} title
 * @param {import('../../core/types.js').Txn[]} rows
 * @param {string} [note]
 */
export function drill(title, rows, note) {
  setText('#listTitle', title);
  setText('#listSummary', note
    || `${plural(rows.length, 'transaction')} · ${inr(spendTotal(rows))} spent. `
       + 'Tap any row to see the message and fix its category or kind.');
  setHtml('#listRows', rows.slice().sort((a, b) => b.date - a.date)
    .map((t) => txnRow(t)).join('') || empty('Nothing here.'));
  showView('list');
}

/** Renders whichever day is open, if any. Driven by state, not by the caller. */
export function renderDay() {
  const s = state.get();
  if (!s.openDay) return;
  const rows = s.txns.filter((t) => dayKey(t.date) === s.openDay)
    .sort((a, b) => b.date - a.date);

  setText('#dayTitle', fmtDayLong(dayKeyToDate(s.openDay).getTime()));
  setText('#daySummary',
    `${plural(rows.length, 'message')} · ${inr(spendTotal(rows))} spent. `
    + 'Tap any row to see the original SMS and set its category.');
  setHtml('#dayTxns', rows.map((t) => txnRow(t, { showDate: false })).join('')
    || empty('Nothing on this day.'));
}

const FIELD_LABEL = {
  amount: 'amount', date: 'date', account: 'account',
  merchant: 'merchant', ref: 'reference', balance: 'balance',
};

/**
 * The original message with each parsed field marked where it was read from.
 *
 * This is the app's central claim made checkable. "₹450, food, Swiggy" asks to
 * be believed; the same figure with the exact characters it came from
 * highlighted underneath can be verified at a glance, and a mis-parse becomes
 * obvious instead of merely wrong.
 *
 * @param {import('../../core/types.js').Txn} t
 */
function renderProvenance(t) {
  if (!t.raw) {
    setHtml('#txnRaw', '<p class="empty">The message text was not stored for this transaction.</p>');
    setHtml('#txnTrace', '');
    return;
  }

  const parts = segments(t);
  setHtml('#txnRaw', parts.map((p) => (p.field
    ? `<mark class="pv pv-${p.field}" title="read as the ${FIELD_LABEL[p.field] || p.field}">${esc(p.text)}</mark>`
    : esc(p.text))).join(''));

  const c = coverage(t);
  const used = [...new Set(parts.filter((p) => p.field).map((p) => p.field))];
  const legend = used.map((f) =>
    `<span class="pv-key"><i class="pv-swatch pv-${f}"></i>${esc(FIELD_LABEL[f] || f)}</span>`).join('');

  const verdict = c.missing.length
    ? `<span class="warn">${esc(c.missing.map((f) => FIELD_LABEL[f] || f).join(', '))} could not be `
      + 'located in the text — check this one.</span>'
    : '<span class="ok">Every figure above was read from the highlighted text.</span>';

  setHtml('#txnTrace', `<div class="pv-legend">${legend}</div><p class="pv-verdict">${verdict}</p>`);
}

/** The single-transaction screen: facts, then the two things the user can change. */
export function renderTxn() {
  const s = state.get();
  const t = state.openTxn();
  if (!t) return;

  setText('#txnTitle', `${inrExact(t.amount)} · ${t.merchant || 'Unknown'}`);

  // Label above value, which is the inverse of the usual row, so this does not
  // reuse `row()` — bending that helper into shape with a string replace was
  // how the old version did it and it broke the moment the markup changed.
  const fact = (label, value) => `
    <div class="row">
      <div class="row-main">
        <span class="row-sub">${esc(label)}</span>
        <strong>${esc(value)}</strong>
      </div>
    </div>`;

  setHtml('#txnFacts', [
    fact('When', new Date(t.date).toLocaleString('en-IN')),
    fact('Kind', t.kind + (t.kind === 'transfer' ? ' — excluded from spending' : '')),
    fact('Channel', t.channel),
    t.bank ? fact('Bank', t.bank) : '',
    t.account ? fact('Account', '••' + t.account) : '',
    t.ref ? fact('Reference', t.ref) : '',
    fact('Category source', t.categorySource || 'unset'),
    fact('Confidence', Math.round((t.confidence || 0) * 100) + '%'),
  ].filter(Boolean).join(''));

  setText('#txnCatHint', t.merchant
    ? `Choosing a category teaches Sandeshika about "${t.merchant}".`
    : 'No merchant was read from this message, so only this transaction can be changed.');

  const scope = /** @type {HTMLSelectElement|null} */ ($('#catScope'));
  if (scope) {
    scope.disabled = !t.merchant;
    if (!t.merchant) scope.value = 'one';
  }

  setHtml('#kindChips', KINDS.map((k) =>
    `<button class="chip kind ${k === t.kind ? 'sel' : ''}" data-kind="${k}">${esc(KIND_LABEL[k])}</button>`)
    .join(''));
  setHtml('#kindSaveState', t.kindSource === 'user' ? '<span class="ok">You set this.</span>' : '');

  const cats = P.CATEGORIES.concat(s.customCats);
  setHtml('#catChips', cats.map((c) =>
    `<button class="chip cat ${c === t.category ? 'sel' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`)
    .join(''));
  setHtml('#txnSaveState', '');
  renderProvenance(t);
}
