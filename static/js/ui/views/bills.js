/**
 * Sandeshika — bills and due dates.
 *
 * The obligations the transaction parser correctly rejects as "not spending"
 * and then used to throw away. A bill due on the 15th is the single most useful
 * thing in an inbox, and it was landing in the bin.
 */

import { inr, inrExact, inrShort, esc, plural } from '../../core/format.js';
import * as O from '../../core/organizer.js';
import { setHtml, setText, $ } from '../dom.js';
import { BAD, WARN } from '../theme.js';
import { row, empty } from '../components.js';
import { dueSoon, overdue } from './dashboard.js';
import * as state from '../state.js';

/** Plain-language time-to-due, including the overdue case. */
function whenLabel(bill, now) {
  const d = O.daysUntil(bill.dueAt, now);
  if (d === null) return 'no date found';
  if (d < 0) return `${plural(Math.abs(d), 'day')} overdue`;
  if (d === 0) return 'due today';
  return `due in ${plural(d, 'day')}`;
}

function billRow(b, now) {
  const d = O.daysUntil(b.dueAt, now);
  const urgent = d !== null && d < 3;
  const sub = [
    esc(b.kind),
    whenLabel(b, now),
    b.minimumDue ? 'min ' + inr(b.minimumDue) : '',
  ].filter(Boolean).join(' · ');

  return row({
    attrs: `data-fp="${esc(b.fingerprint)}"`,
    color: urgent ? BAD : WARN,
    title: esc(b.issuer) + (b.account ? ' ••' + esc(b.account) : ''),
    sub,
    amount: b.amount ? inrExact(b.amount) : '—',
    amountClass: 'debit',
    trailing: b.status === 'open'
      ? '<button class="mini ok" data-bill="paid">Paid</button>'
      : '<button class="mini" data-bill="reopen">Undo</button>',
  });
}

const total = (list) => list.reduce((a, b) => a + (b.amount || 0), 0);

export function render() {
  const s = state.get();
  const now = Date.now();

  // Undated bills sort last rather than first: an obligation with no readable
  // due date is the least actionable thing on the screen.
  const open = s.bills.filter((b) => b.status === 'open')
    .sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity));
  const done = s.bills.filter((b) => b.status !== 'open');

  const soon = dueSoon(s.bills, now);
  const late = overdue(s.bills, now);

  setText('#kpiDueSoon', soon.length ? inrShort(total(soon)) : '—');
  setText('#kpiDueSoonSub', soon.length ? plural(soon.length, 'bill') : 'nothing due');
  setText('#kpiOverdue', late.length ? inrShort(total(late)) : '—');
  setText('#kpiOverdueSub', late.length ? `${late.length} overdue` : 'all clear');
  const el = $('#kpiOverdue');
  if (el) el.className = late.length ? 'neg' : '';

  setHtml('#billList', open.map((b) => billRow(b, now)).join('')
    || empty('No bills outstanding.'));
  setHtml('#billDone', done.map((b) => billRow(b, now)).join('')
    || empty('Nothing settled yet.'));
}
