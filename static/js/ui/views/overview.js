/**
 * Sandeshika — overview view: KPIs, category chart, top merchants, sparkline,
 * coverage and the review queue.
 */

import { inr, inrShort, inrExact, esc, plural, dayKey } from '../../core/format.js';
import {
  range, summarise, isPending, qualityBreakdown, reviewGroups, PERIOD_LABEL,
} from '../../core/analytics.js';
import { setHtml, setText, setHidden, $ } from '../dom.js';
import { catColor, NEUTRAL, GOOD, WARN, INFO } from '../theme.js';
import { row, empty, barRow } from '../components.js';
import * as state from '../state.js';

export function render() {
  const s = state.get();
  const r = range(s.period);
  const sum = summarise(s.txns, r);
  const prev = summarise(s.txns, range('lastMonth'));

  setText('#periodLabel', PERIOD_LABEL[s.period] + ' · change in the menu');

  setText('#kpiSpent', inrShort(sum.spent), inrExact(sum.spent));
  setText('#kpiIn', inrShort(sum.received), inrExact(sum.received));
  setText('#kpiNet', (sum.net >= 0 ? '+' : '−') + inrShort(sum.net), inrExact(sum.net));
  const net = $('#kpiNet');
  if (net) net.className = sum.net >= 0 ? 'pos' : 'neg';

  setText('#kpiSpentSub', sum.refunded
    ? `${plural(sum.count, 'txn')} · ${inr(sum.refunded)} refunded`
    : plural(sum.count, 'transaction'));

  setText('#kpiInSub', sum.transferred
    ? `${inrShort(sum.transferred)} moved between accounts`
    : (sum.received ? 'income in period' : ''));

  // Month-on-month only makes sense when there is a comparable month behind it.
  if (s.period === 'thisMonth' && prev.spent > 0) {
    const delta = ((sum.spent - prev.spent) / prev.spent) * 100;
    setText('#kpiNetSub', `${Math.abs(delta).toFixed(0)}% ${delta >= 0 ? 'more' : 'less'} than last month`);
  } else {
    setText('#kpiNetSub', '');
  }

  renderCategories(sum);
  renderMerchants(sum);
  renderSpark(sum.byDay, r);
  renderQuality(s.txns);
  renderReview(s.txns);
}

function renderCategories(sum) {
  const max = sum.byCat.length ? sum.byCat[0][1] : 0;
  setHtml('#catChart', sum.byCat.length
    ? sum.byCat.map(([c, v]) => barRow(c, v, max, catColor(c))).join('')
    : empty('No spending in this period.'));
}

function renderMerchants(sum) {
  setHtml('#merchantList', sum.merchants.slice(0, 8).map((m) => row({
    color: catColor(m.category),
    title: esc(m.name),
    sub: `${m.count}×`,
    amount: inr(m.total),
  })).join('') || empty('Nothing yet.'));
}

/**
 * Up to 60 days of daily spend as a sparkline. Every calendar day in the window
 * gets a bar, including empty ones — a gap is information, and collapsing it
 * makes an interrupted import look like a frugal week.
 */
function renderSpark(byDay, [a, b]) {
  const days = [];
  const start = new Date(Math.max(a, b - 60 * 864e5));
  for (const d = new Date(start); d.getTime() <= b; d.setDate(d.getDate() + 1)) {
    const k = dayKey(d.getTime());
    days.push([k, byDay[k] || 0]);
  }
  const max = Math.max(1, ...days.map((x) => x[1]));
  setHtml('#spark', days.map(([k, v]) =>
    `<div class="spark-bar" style="height:${Math.max(2, (v / max) * 100)}%" title="${esc(k)}: ${inr(v)}"></div>`)
    .join(''));
}

/**
 * Coverage, stated plainly.
 *
 * A spending app is only as good as the fraction of the inbox it actually
 * understood, and that number is normally invisible — which lets a parser miss
 * a whole message format while the totals still look plausible. The buckets
 * here are mutually exclusive and sum to the total; the old version computed
 * "by rule" by subtraction and quietly counted model answers as rules.
 */
function renderQuality(txns) {
  if (!txns.length) {
    setHtml('#qualityBody', empty('Import your messages to see coverage.'));
    return;
  }
  const q = qualityBreakdown(txns);
  /** @type {Array<{label: string, n: number, tone: string, always?: boolean}>} */
  const rows = [
    { label: 'Transactions stored', n: q.total, tone: GOOD, always: true },
    { label: 'Categorised by rule', n: q.rule, tone: GOOD },
    { label: 'You corrected these', n: q.user, tone: GOOD },
    { label: 'From a sender pattern', n: q.sender, tone: INFO },
    { label: 'Predicted on device', n: q.model, tone: INFO },
    { label: 'Categorised by the model', n: q.llm, tone: INFO },
    { label: 'Guessed — confirm these', n: q.guess, tone: WARN },
    { label: 'Could not be read', n: q.unresolved, tone: NEUTRAL },
    { label: 'Model unavailable, left as other', n: q.fallback, tone: NEUTRAL },
    { label: 'Waiting for review', n: q.pendingReview, tone: WARN },
    { label: 'No merchant identified', n: q.noMerchant, tone: NEUTRAL },
    { label: 'Foreign currency, excluded', n: q.foreign, tone: '#B569E8' },
  ];
  // Zero rows are hidden so the panel stays short, except the total, which is
  // the denominator everything else is read against.
  setHtml('#qualityBody', rows
    .filter((r) => r.always || r.n > 0)
    .map((r) => row({ color: r.tone, title: esc(r.label), amount: String(r.n) }))
    .join(''));
}

/**
 * The review queue, grouped.
 *
 * A flat list of 1,165 rows is not a queue anyone clears, and until it is
 * cleared those amounts are excluded from every total on the screen — so the
 * app shows a number it knows to be incomplete. Grouped by merchant and
 * reason, the same backlog becomes a few dozen decisions, each resolvable in
 * one tap for the whole group.
 */
function renderReview(txns) {
  const pending = txns.filter(isPending);
  if (!pending.length) {
    setHidden('#reviewCard', true);
    return;
  }
  setHidden('#reviewCard', false);

  const groups = reviewGroups(txns);
  const excluded = pending.reduce((a, t) => a + t.amount, 0);

  setText('#reviewSummary',
    `${plural(pending.length, 'transaction')} worth ${inr(excluded)} are excluded from `
    + `every total until confirmed — ${plural(groups.length, 'decision')} to clear them.`);

  setHidden('#reviewBulk', false);
  setHtml('#reviewList', groups.slice(0, 25).map((g) => `
    <div class="review group" data-key="${esc(g.key)}">
      <label class="review-pick">
        <input type="checkbox" class="review-check" data-key="${esc(g.key)}" />
      </label>
      <div class="row-main">
        <strong>${esc(g.merchant)}
          <span class="count-pill">${g.count}×</span></strong>
        <span class="row-sub">${inrExact(g.total)} total · counted as ${esc(g.kind)} · ${esc(g.reason)}</span>
        <span class="raw">${esc(g.sample.raw || '')}</span>
      </div>
      <div class="review-actions">
        <button class="mini ok" data-act="accept">Correct</button>
        <button class="mini no" data-act="reject">Not a transaction</button>
      </div>
    </div>`).join('')
    + (groups.length > 25
      ? `<p class="hint tight">${groups.length - 25} more groups below the top 25.</p>` : ''));
}
