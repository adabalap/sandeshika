/**
 * Sandeshika — provenance.
 *
 * Finds where each parsed field came from inside the original message, so the
 * transaction screen can show the SMS with the amount, date, account, merchant
 * and reference marked in place.
 *
 * This is the whole argument of the app made visible. "₹450, food, Swiggy" asks
 * to be believed. The same figure with the exact characters it was read from
 * highlighted underneath can be checked in a second, and a mis-parse becomes
 * obvious rather than merely wrong. It is also the fastest way to report a bad
 * parse: the user can see which part the app misread.
 *
 * Pure string work — no DOM. The caller escapes and renders.
 */

/** @typedef {import('./types.js').Txn} Txn */

/**
 * @typedef {object} Span
 * @property {number} start
 * @property {number} end
 * @property {'amount'|'date'|'account'|'merchant'|'ref'|'balance'} field
 * @property {string} label
 */

/** Escapes a literal for embedding in a regex. */
const lit = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds the first match that does not overlap anything already claimed.
 * @param {string} text
 * @param {RegExp} re
 * @param {Span[]} taken
 */
function firstFree(text, re, taken) {
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  for (const m of text.matchAll(rx)) {
    const start = m.index + (m[0].length - m[0].trimStart().length);
    const end = m.index + m[0].trimEnd().length;
    if (!taken.some((s) => start < s.end && end > s.start)) return { start, end };
  }
  return null;
}

/**
 * Locates the parsed fields inside the raw message.
 *
 * Ordered most-specific first. A reference number is a long digit run and an
 * account tail is a short one; claiming the reference first stops the account
 * highlighter from grabbing four digits out of the middle of it.
 *
 * @param {Txn} txn
 * @param {string} [raw] Defaults to the message stored on the transaction.
 * @returns {Span[]} sorted by position, never overlapping
 */
export function locate(txn, raw) {
  const text = String(raw ?? txn.raw ?? '');
  if (!text) return [];

  /** @type {Span[]} */
  const spans = [];
  const claim = (re, field, label) => {
    if (!re) return;
    const hit = firstFree(text, re, spans);
    if (hit) spans.push({ ...hit, field, label });
  };

  // Reference: long and unambiguous, so it goes first.
  if (txn.ref) claim(new RegExp(lit(txn.ref)), 'ref', 'reference');

  /*
   * Amount. The stored value is a number, so 1358 must be found however it was
   * written: 1358, 1,358, 1358.00, 1,358.00. Indian grouping is 2-2-3, not
   * 3-3-3, so a naive thousands regex misses ₹1,45,678 entirely — which is
   * most large amounts in this inbox.
   */
  if (typeof txn.amount === 'number') {
    /*
     * The integer part is TRUNCATED, not rounded. Rounding turned 145678.90
     * into "1,45,679.90", which appears nowhere in the message, so the amount
     * — the single most important field — was never highlighted on any
     * transaction with paise. Silent, and it defeated the whole feature.
     */
    const whole = Math.trunc(txn.amount);
    const grouped = whole.toLocaleString('en-IN');
    const paise = String(Math.round((txn.amount - whole) * 100)).padStart(2, '0');
    const forms = [...new Set([
      grouped + '.' + paise,
      txn.amount.toFixed(2),
      grouped + '.00',
      grouped,
      String(whole),
      String(txn.amount),
    ])].sort((a, b) => b.length - a.length);
    /*
     * The boundary must reject a match inside a longer number without
     * rejecting "Rs.450" — where the preceding character is the full stop in
     * the currency marker, not a decimal point. So: no digit before, and no
     * separator-after-a-digit before, which is what being mid-number looks
     * like.
     */
    claim(new RegExp(`(?<!\\d)(?<!\\d[.,])(?:${forms.map(lit).join('|')})(?!\\d)`), 'amount', 'amount');
  }

  // Account tail, with whatever masking style the bank used.
  if (txn.account) claim(new RegExp(`(?:[xX*]{0,6})${lit(txn.account)}(?![\\d])`), 'account', 'account');

  // Merchant, as written. VPAs keep their handle, so match the local part too.
  if (txn.merchant) {
    const m = String(txn.merchant);
    claim(new RegExp(`${lit(m)}(?:@[a-z]+)?`, 'i'), 'merchant', 'merchant');
  }

  // Date: try the formats the parser understands, in the order it tries them.
  if (txn.date) {
    const d = new Date(txn.date);
    const dd = String(d.getDate()).padStart(2, '0');
    const D = String(d.getDate());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    const yy = String(d.getFullYear() % 100).padStart(2, '0');
    const yyyy = String(d.getFullYear());
    const patterns = [
      `${dd}[-/]${mm}[-/](?:${yyyy}|${yy})`,
      `${D}[-/]${Number(mm)}[-/](?:${yyyy}|${yy})`,
      `${dd}[\\s-]?${mon}[a-z]*[\\s-]?(?:${yyyy}|${yy})`,
      `${D}[\\s-]?${mon}[a-z]*[\\s-]?(?:${yyyy}|${yy})`,
      `${mon}[a-z]*\\s+${dd},?\\s+${yyyy}`,
      `${yyyy}-${mm}-${dd}`,
    ];
    claim(new RegExp(patterns.join('|'), 'i'), 'date', 'date');
  }

  if (typeof txn.balance === 'number' && txn.balance > 0) {
    const bWhole = Math.trunc(txn.balance);
    const b = bWhole.toLocaleString('en-IN');
    const bPaise = String(Math.round((txn.balance - bWhole) * 100)).padStart(2, '0');
    claim(new RegExp(`(?<!\\d)(?<!\\d[.,])(?:${lit(`${b}.${bPaise}`)}|${lit(b + '.00')}|${lit(b)})(?!\\d)`),
      'balance', 'balance');
  }

  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Splits the message into rendering segments.
 *
 * Returns plain text and marked pieces in order, so the caller escapes each one
 * and wraps only the marked ones. Building HTML here would mean escaping here,
 * and a module that returns a string of HTML is a module that eventually
 * returns unescaped SMS text.
 *
 * @param {Txn} txn
 * @param {string} [raw]
 * @returns {Array<{text: string, field?: string, label?: string}>}
 */
export function segments(txn, raw) {
  const text = String(raw ?? txn.raw ?? '');
  const spans = locate(txn, raw);
  if (!spans.length) return text ? [{ text }] : [];

  const out = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start > cursor) out.push({ text: text.slice(cursor, s.start) });
    out.push({ text: text.slice(s.start, s.end), field: s.field, label: s.label });
    cursor = s.end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out;
}

/**
 * How much of the transaction could be traced back to the message.
 *
 * Shown to the user as a plain count. A transaction where nothing can be
 * located is not necessarily wrong, but it is unverifiable, and saying so is
 * more honest than a confidence percentage nobody can interpret.
 *
 * @param {Txn} txn
 */
export function coverage(txn) {
  /** @type {Array<Span['field']>} */
  const candidates = ['amount', 'date', 'account', 'merchant', 'ref'];
  const expected = candidates.filter((f) => {
    if (f === 'amount') return typeof txn.amount === 'number';
    /*
     * A merchant taken from the DLT sender header is not IN the body, so it can
     * never be highlighted there. Counting it as untraceable would tell the
     * user their transaction looks suspect when nothing is wrong with it — the
     * name simply came from the envelope rather than the letter.
     */
    if (f === 'merchant' && txn.merchantQuality === 'sender') return false;
    return Boolean(txn[f]);
  });
  const found = new Set(locate(txn).map((s) => s.field));
  return {
    expected: expected.length,
    traced: expected.filter((f) => found.has(f)).length,
    missing: expected.filter((f) => !found.has(f)),
  };
}
