/**
 * Sandeshika — shared row markup.
 *
 * The same three row shapes were hand-written in nine places, each drifting
 * slightly: some escaped the merchant name, some did not; some showed the
 * "you set this" flag, some forgot. Building them once removes both the
 * duplication and the inconsistency — and means the escaping is right
 * everywhere by construction.
 */

import { esc, inr, inrExact, fmtDate } from '../core/format.js';
import { catColor, NEUTRAL } from './theme.js';

/** @typedef {import('../core/types.js').Txn} Txn */

/** @param {string} text */
export const empty = (text) => `<p class="empty">${esc(text)}</p>`;

/**
 * @param {object} o
 * @param {string} [o.color]
 * @param {string} o.title
 * @param {string} [o.sub]     Pre-escaped: callers may include <em> flags.
 * @param {string} [o.amount]
 * @param {string} [o.amountClass]
 * @param {string} [o.raw]
 * @param {string} [o.trailing] Buttons.
 * @param {string} [o.attrs]
 * @param {string} [o.cls]
 */
export function row(o) {
  return `
    <div class="row ${o.cls || ''}" ${o.attrs || ''}>
      ${o.color ? `<span class="dot" style="background:${o.color}"></span>` : ''}
      <div class="row-main">
        <strong>${o.title}</strong>
        ${o.sub ? `<span class="row-sub">${o.sub}</span>` : ''}
        ${o.raw ? `<span class="raw">${o.raw}</span>` : ''}
      </div>
      ${o.amount ? `<span class="row-amt ${o.amountClass || ''}">${o.amount}</span>` : ''}
      ${o.trailing || ''}
    </div>`;
}

/** Signed, paisa-exact amount with the class the stylesheet colours by. */
export const signed = (t) => `${t.direction === 'debit' ? '−' : '+'}${inrExact(t.amount)}`;

/**
 * The canonical transaction row.
 * @param {Txn} t
 * @param {{showDate?: boolean, showFlags?: boolean, cls?: string}} [opts]
 */
export function txnRow(t, opts = {}) {
  const { showDate = true, showFlags = true, cls = 'txn-row' } = opts;
  const flags = showFlags ? [
    t.kind === 'transfer' ? '<em class="flag tf">transfer</em>' : '',
    t.kind === 'refund' ? '<em class="flag rf">refund</em>' : '',
    t.needsReview && !t.reviewed ? '<em class="flag">unverified</em>' : '',
    t.categorySource === 'user' || t.kindSource === 'user'
      ? '<em class="flag ok2">you set this</em>' : '',
  ].filter(Boolean).join(' ') : '';

  const sub = [
    showDate ? esc(fmtDate(t.date)) : '',
    esc(t.category || 'other'),
    esc(t.channel || ''),
  ].filter(Boolean).join(' · ') + (flags ? ' · ' + flags : '');

  return row({
    cls,
    attrs: `data-fp="${esc(t.fingerprint)}"`,
    color: catColor(t.category),
    title: esc(t.merchant || 'Unknown'),
    sub,
    amount: signed(t),
    amountClass: t.direction,
  });
}

/** A labelled counter line, used by the coverage panel. */
export const statRow = (label, n, tone = NEUTRAL) => row({
  color: tone,
  title: esc(label),
  amount: String(n),
});

/** A horizontal bar in the category chart. */
export const barRow = (label, value, max, color) => `
  <div class="bar-row">
    <span class="bar-label">${esc(label)}</span>
    <div class="bar-track">
      <div class="bar-fill" style="width:${max ? (value / max) * 100 : 0}%;background:${color}"></div>
    </div>
    <span class="bar-val">${inr(value)}</span>
  </div>`;

/** An inline progress bar nested inside a row. */
export const inlineBar = (value, max, color) => `
  <div class="bar-track" style="margin-top:5px">
    <div class="bar-fill" style="width:${max ? (value / max) * 100 : 0}%;background:${color}"></div>
  </div>`;
