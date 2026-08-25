/**
 * Sandeshika — the full transaction list, with search and category filter.
 */

import { esc } from '../../core/format.js';
import { setHtml, toggleClass, val, $ } from '../dom.js';
import { txnRow, empty } from '../components.js';
import * as state from '../state.js';

/** Matches merchant, amount or the raw message text. */
function matches(t, q) {
  if (!q) return true;
  return (t.merchant || '').toLowerCase().includes(q)
    || String(t.amount).includes(q)
    || (t.raw || '').toLowerCase().includes(q);
}

export function render() {
  const s = state.get();
  const q = val('#search').trim().toLowerCase();
  const cat = val('#filterCat');

  const list = s.txns
    .filter((t) => !cat || t.category === cat)
    .filter((t) => matches(t, q))
    .sort((a, b) => b.date - a.date);

  setHtml('#txnList', list.slice(0, s.listLimit).map((t) => txnRow(t)).join('')
    || empty('No transactions match.'));
  toggleClass('#loadMore', 'hidden', list.length <= s.listLimit);
}

/** Rebuilds the category filter from what is actually present in the data. */
export function renderFilter() {
  const s = state.get();
  const cur = val('#filterCat');
  const cats = [...new Set(s.txns.map((t) => t.category).filter(Boolean))].sort();
  setHtml('#filterCat', '<option value="">All categories</option>'
    + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(''));
  // Keep the user's selection across a reload if it still exists.
  const el = /** @type {HTMLSelectElement|null} */ ($('#filterCat'));
  if (el && cats.includes(cur)) el.value = cur;
}
