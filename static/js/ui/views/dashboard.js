/**
 * Sandeshika — dashboard.
 *
 * Answers the four questions worth opening the app for: what have I spent
 * today, what have I spent this month and where is that heading, what do I owe
 * soon, and what needs a decision from me.
 */

import { inr, inrShort, esc, dayKey, dayKeyToDate, fmtDayShort, plural } from '../../core/format.js';
import {
  counted, isSpend, isRefund, isPending, lastNDays, monthProjection, range, summarise,
} from '../../core/analytics.js';
import * as O from '../../core/organizer.js';
import { setHtml, setText, setHidden, $ } from '../dom.js';
import { GOOD, WARN, BAD, INFO } from '../theme.js';
import { row, empty, inlineBar } from '../components.js';
import * as state from '../state.js';

const DAY = 864e5;

export function render() {
  const s = state.get();
  const now = Date.now();

  renderToday(s.txns, now);
  renderMonth(s.txns, now);
  renderBillTiles(s.bills, now);
  renderAttention(s, now);
  renderWeek(s.txns, now);
}

function renderToday(txns, now) {
  const today = txns.filter((t) => counted(t) && dayKey(t.date) === dayKey(now));
  const spend = Math.max(0,
    today.filter(isSpend).reduce((a, t) => a + t.amount, 0)
    - today.filter(isRefund).reduce((a, t) => a + t.amount, 0));

  setText('#dashToday', spend ? inrShort(spend) : '₹0', inr(spend));
  setText('#dashTodaySub', today.length ? plural(today.length, 'transaction') : 'nothing yet today');
}

function renderMonth(txns, now) {
  const sum = summarise(txns, range('thisMonth', now));
  setText('#dashMonth', inrShort(sum.spent), inr(sum.spent));

  // Pace, not just position: "on track" is the useful half of a month total.
  // Suppressed for the first two days, when the projection is noise.
  const projected = monthProjection(sum.spent, now);
  setText('#dashMonthSub', projected !== null
    ? `on pace for ${inrShort(projected)}`
    : plural(sum.count, 'transaction'));
}

const openBills = (bills) => bills.filter((b) => b.status === 'open');

/** Due within a week, and not already past due. */
export function dueSoon(bills, now) {
  return openBills(bills).filter((b) => {
    const d = O.daysUntil(b.dueAt, now);
    return d !== null && d >= 0 && d <= 7;
  });
}

export function overdue(bills, now) {
  return openBills(bills).filter((b) => {
    const d = O.daysUntil(b.dueAt, now);
    return b.overdue || (d !== null && d < 0);
  });
}

const billTotal = (list) => list.reduce((a, b) => a + (b.amount || 0), 0);

function renderBillTiles(bills, now) {
  const soon = dueSoon(bills, now);
  const late = overdue(bills, now);

  setText('#dashDue', soon.length ? inrShort(billTotal(soon)) : '—');
  setText('#dashDueSub', soon.length
    ? soon.map((b) => b.issuer).slice(0, 2).join(', ')
    : 'nothing due');

  setText('#dashOverdue', late.length ? inrShort(billTotal(late)) : '—');
  const el = $('#dashOverdue');
  if (el) el.className = late.length ? 'neg' : '';
  setText('#dashOverdueSub', late.length ? plural(late.length, 'bill') : 'all clear');
}

/**
 * Things awaiting a decision. Each entry names the consequence of ignoring it,
 * because "3 items need review" does not tell anyone why they should care.
 */
function renderAttention(s, now) {
  const review = s.txns.filter(isPending);
  const pairs = O.findTransferPairs(s.txns.filter((t) => t.date >= now - 60 * DAY));
  const late = overdue(s.bills, now);
  const items = [];

  if (pairs.length) {
    items.push(row({
      color: INFO,
      title: `${plural(pairs.length, 'possible transfer')} between your accounts`,
      sub: 'A matching debit and credit — counting both inflates spending and income',
      trailing: '<button class="mini ok" id="btnShowPairs">Review</button>',
    }));
  }
  if (review.length) {
    items.push(row({
      color: WARN,
      title: `${plural(review.length, 'transaction')} to confirm`,
      sub: 'Excluded from totals until you do',
    }));
  }
  if (late.length) {
    items.push(row({
      color: BAD,
      title: plural(late.length, 'overdue bill'),
      sub: esc(late.map((b) => b.issuer).slice(0, 3).join(', ')),
    }));
  }

  setHidden('#attentionCard', !items.length);
  setHtml('#attentionList', items.join(''));
  state.setQuiet({ pairs });
}

/** The last seven calendar days, zero days included. */
function renderWeek(txns, now) {
  const days = lastNDays(txns, 7, now);
  const max = Math.max(1, ...days.map((d) => d.spend));
  setHtml('#dashDays', days.map((d) => row({
    cls: 'day-row',
    attrs: `data-day="${esc(d.key)}"`,
    title: esc(fmtDayShort(dayKeyToDate(d.key).getTime())),
    sub: inlineBar(d.spend, max, GOOD),
    amount: inr(d.spend),
    amountClass: 'debit',
  })).join('') || empty('No spending in the last week.'));
}

/** Renders the suggested pairs in place, so both sides can be fixed at once. */
export function renderPairs() {
  const { pairs } = state.get();
  const html = pairs.map((p, i) => row({
    cls: 'pair-row',
    attrs: `data-i="${i}"`,
    color: INFO,
    title: `${inr(p.amount)} out and back in`,
    sub: `${esc(dayKey(p.debit.date))} · ${esc(p.debit.merchant || 'unknown')}`
      + ` ${p.debit.account ? '••' + esc(p.debit.account) : ''} →`
      + ` ${p.credit.account ? '••' + esc(p.credit.account) : 'another account'}`,
    trailing: '<button class="mini ok" data-pair="yes">Both transfers</button>'
      + '<button class="mini no" data-pair="no">Keep as is</button>',
  })).join('');
  setHtml('#attentionList', html || empty('No transfer pairs found.'));
}
