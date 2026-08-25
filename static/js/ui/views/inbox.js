/**
 * Sandeshika — inbox organiser.
 *
 * Messages are read LIVE from Medha and never copied into storage. The system
 * SMS provider is already the source of truth; a second copy is one more thing
 * to secure, keep in sync, and get wrong.
 */

import { inr, esc, fmtDate } from '../../core/format.js';
import * as P from '../../core/parser.js';
import { setHtml, setText, toggleClass, $$, val } from '../dom.js';
import { boxColor, BOX_EMPTY } from '../theme.js';
import { row, empty } from '../components.js';
import * as state from '../state.js';

export function render() {
  const s = state.get();
  const q = val('#inboxSearch').trim().toLowerCase();

  const rows = s.inbox
    .filter((r) => r.cls.tab === s.inboxTab)
    .filter((r) => !q || r.sms.body.toLowerCase().includes(q)
      || String(r.sms.address).toLowerCase().includes(q));

  renderTabCounts(s);
  setText('#inboxCount', `${rows.length} of ${s.inbox.length} messages loaded`);

  setHtml('#inboxList', rows.slice(0, s.inboxLimit).map((r) => {
    const t = r.cls.txn;
    // An OTP code is NEVER rendered. Repeating a one-time code in a list, a
    // digest or a notification is exactly what makes OTP phishing work.
    const body = r.cls.sensitive
      ? '<em>One-time code received — hidden for safety</em>'
      : esc(r.sms.body).replace(/\n/g, ' ');

    return row({
      color: boxColor(r.cls.tab),
      title: esc(P.senderBank(r.sms.address) || r.sms.address),
      sub: `${esc(fmtDate(r.sms.date))} · ${esc(r.cls.subtype)}`,
      raw: body,
      amount: t ? `${t.direction === 'debit' ? '−' : '+'}${inr(t.amount)}` : '',
      amountClass: t ? t.direction : '',
    });
  }).join('') || empty(BOX_EMPTY[s.inboxTab] || 'Nothing here.'));

  toggleClass('#inboxMore', 'hidden', rows.length <= s.inboxLimit);
}

function renderTabCounts(s) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const r of s.inbox) counts[r.cls.tab] = (counts[r.cls.tab] || 0) + 1;

  $$('#inboxTabs .chip').forEach((c) => {
    const box = c.dataset.box || '';
    const n = counts[box] || 0;
    c.textContent = box.charAt(0).toUpperCase() + box.slice(1) + (n ? ` ${n}` : '');
    c.classList.toggle('sel', box === s.inboxTab);
  });
}
