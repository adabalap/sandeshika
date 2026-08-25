/**
 * Sandeshika — day-by-day view.
 *
 * The screen where a mis-categorised transaction gets found and fixed. Every
 * number here is a sum of rows the user can open and read: a total nobody can
 * trace is a total nobody can trust.
 */

import { inr, inrShort, esc, dayKeyToDate, fmtDayShort, plural } from '../../core/format.js';
import { dailyRange, dailyBuckets } from '../../core/analytics.js';
import { setHtml, setText } from '../dom.js';
import { GOOD } from '../theme.js';
import { row, empty, inlineBar } from '../components.js';
import * as state from '../state.js';

export function render() {
  const s = state.get();
  const r = dailyRange(s.dailyPeriod);
  const days = dailyBuckets(s.txns, r);

  const total = days.reduce((a, d) => a + d.spend, 0);
  const txnCount = days.reduce((a, d) => a + d.count, 0);
  // Averaged over days that actually had spending, not calendar days: a
  // month-to-date average divided by 31 on the 3rd is a misleading number.
  const active = days.filter((d) => d.spend > 0).length;

  setText('#dTotal', inrShort(total), inr(total));
  setText('#dTotalSub', `${plural(txnCount, 'transaction')} over ${plural(days.length, 'day')}`);
  setText('#dAvg', active ? inrShort(total / active) : '—');
  setText('#dAvgSub', active ? `across ${plural(active, 'day')} with spending` : '');

  const max = Math.max(1, ...days.map((d) => d.spend));
  setHtml('#dayList', days.map((d) => {
    const sub = [
      plural(d.count, 'txn'),
      d.income ? '+' + inr(d.income) : '',
      d.review ? `<em class="flag">${d.review} to review</em>` : '',
    ].filter(Boolean).join(' · ');
    return row({
      cls: 'day-row',
      attrs: `data-day="${esc(d.key)}"`,
      title: esc(fmtDayShort(dayKeyToDate(d.key).getTime())),
      sub: sub + inlineBar(d.spend, max, GOOD),
      amount: inr(d.spend),
      amountClass: 'debit',
    });
  }).join('') || empty('No transactions in this period.'));
}
