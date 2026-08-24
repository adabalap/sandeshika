/**
 * Sandeshika — formatting.
 *
 * Pure and dependency-free so it can be unit tested without a DOM. Indian
 * numbering throughout: this app is read by people who think in lakh and
 * crore, and `toLocaleString('en-IN')` groups 8,25,856 rather than 825,856.
 */

/** Rounded rupees, e.g. ₹8,25,856. Sign is dropped — the caller shows it. */
export const inr = (n) => '₹' + Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-IN');

/**
 * Compact Indian notation for headline figures.
 *
 * ₹8,25,856 is nine characters and overflowed the KPI card, shrinking the text
 * until three cards became unreadable. Lakh and crore are how the amount would
 * be said aloud anyway, and the exact figure stays one tap away in the
 * drill-down (and in the `title` attribute).
 */
export const inrShort = (n) => {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e7) return '₹' + (v / 1e7).toFixed(v >= 1e8 ? 0 : 2) + ' Cr';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(v >= 1e6 ? 1 : 2) + ' L';
  if (v >= 1e3) return '₹' + Math.round(v).toLocaleString('en-IN');
  return '₹' + Math.round(v);
};

/** Paisa-exact. Used anywhere the user might reconcile against a statement. */
export const inrExact = (n) => '₹' + Math.abs(Number(n) || 0)
  .toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** @param {number} ms */
export const fmtDate = (ms) => new Date(ms)
  .toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });

/** @param {number} ms */
export const fmtDayLong = (ms) => new Date(ms)
  .toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

/** @param {number} ms */
export const fmtDayShort = (ms) => new Date(ms)
  .toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' });

/**
 * Local-time day key, "YYYY-MM-DD".
 *
 * Deliberately not `toISOString().slice(0,10)`: that converts to UTC, so every
 * transaction after 5:30am IST would land on the wrong day for a user in
 * India. Day boundaries here are always the user's own.
 * @param {number} ms
 */
export const dayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Parses a `dayKey` back into local midnight. */
export const dayKeyToDate = (k) => new Date(k + 'T00:00:00');

/**
 * HTML-escapes a value for interpolation into a template string.
 *
 * Every piece of SMS-derived text goes through this. An SMS body is attacker
 * controlled — anyone can send one — so a merchant name containing a script
 * tag is a realistic input, not a theoretical one.
 * @param {unknown} s
 */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c));

/**
 * One CSV field, RFC 4180.
 *
 * Carriage return is in the test alongside comma, quote and newline: a bare \r
 * inside an unquoted field splits the row in Excel, and SMS bodies do contain
 * them.
 * @param {unknown} v
 */
export const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/** "3 days" / "1 day" — pluralisation in one place rather than inline everywhere. */
export const plural = (n, word, suffix = 's') => `${n} ${word}${n === 1 ? '' : suffix}`;
