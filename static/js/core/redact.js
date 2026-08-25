/**
 * Sandeshika — redaction.
 *
 * Strips personal data out of a bank SMS so the message can be shared to get
 * the parser fixed. Runs entirely on the device; nothing here talks to the
 * network.
 *
 * WHAT THIS IS FOR
 *
 * Debugging a parser needs the SHAPE of a message — which keywords appear, in
 * what order, with what separators. It does not need who was paid or how much.
 * So values are replaced while the template is preserved:
 *
 *   Sent Rs.1358.00 From HDFC Bank A/C *5261 To Mr Gadipudi Khadri On 10/08/26
 *   Sent Rs.9999.99 From HDFC Bank A/C *9999 To PERSON_a3f1      On 14/11/23
 *
 * The template is intact; the facts are gone.
 *
 * CONSISTENT PSEUDONYMS
 *
 * The same name maps to the same PERSON_xxxx within one report, so duplicate
 * detection and per-merchant grouping still work in the redacted output. The
 * mapping is a salted hash and the salt is generated per session and never
 * stored, so it cannot be reversed even by someone who guesses the name.
 *
 * WHAT IS DELIBERATELY KEPT
 *
 * Bank sender IDs (AX-HDFCBK), payment-app handles (@ybl, @okicici), currency
 * markers, keywords and punctuation. None of these are personal, and removing
 * them would make the sample useless for the thing it is being sent for.
 *
 * DATES ARE SHIFTED, NOT BLANKED
 *
 * Blanking a date to 99/99/99 destroys the one thing a parser bug report needs:
 * the date FORMAT, and whether the parser read it correctly. A constant offset
 * preserves the format, the ordering and the gaps between messages while making
 * the actual calendar dates wrong — which is all the privacy a transaction date
 * needs.
 *
 * HONEST LIMITS
 *
 * A regex cannot recognise every name. A name in a shape not covered here may
 * survive. `verify()` re-scans the output for the mechanical patterns and the
 * UI shows the result, but it cannot catch "paid to Ramesh" phrased in a way
 * nothing here anticipated. The UI therefore shows the redacted text for review
 * before it can be copied, and says so.
 *
 * This mirrors tools/redact.py, which does the same job offline for bulk
 * corpus files. Both are covered by tests/redact.test.js.
 */

/**
 * Fills an array with random values, falling back to Math.random only where
 * crypto is genuinely absent. The fallback weakens the pseudonym salt, not the
 * redaction itself — every value is still replaced either way.
 * @template {Uint8Array | Uint32Array} T
 * @param {T} arr
 * @returns {T}
 */
function randomFill(arr) {
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    /** @type {(a: unknown) => void} */ (c.getRandomValues.bind(c))(arr);
    return arr;
  }
  for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 4294967296);
  return arr;
}

/** Per-session salt. Never persisted; regenerated on every page load. */
const SALT = Array.from(randomFill(new Uint8Array(16)),
  (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * A constant date offset for the session, between 400 and 1200 days either way.
 * @type {number}
 */
const DATE_SHIFT_DAYS = (() => {
  const b = randomFill(new Uint32Array(2));
  return (400 + (b[0] % 801)) * (b[1] % 2 ? 1 : -1);
})();

/**
 * FNV-1a over the salt and value. Not a cryptographic hash — it does not need
 * to be. It needs to be stable within a report and unguessable without the
 * salt, and the salt is what provides the second property.
 * @param {string} s
 */
function hash4(s) {
  let h = 0x811c9dc5;
  const str = SALT + s;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 4);
}

/** Stable pseudonym for a value within this session. */
const tag = (kind, value) => `${kind}_${hash4(kind + String(value).trim().toLowerCase())}`;

/**
 * Words that look like names to a regex but are not. Without this list the name
 * rules chew through ordinary sentences and the sample becomes unreadable —
 * which defeats the purpose, because an unreadable sample cannot be debugged.
 */
const NOT_NAMES = new Set(`
hdfc icici axis sbi kotak yes idfc indusind rbl amex american express bob canara
pnb union federal bandhan au ujjivan equitas dbs hsbc citi standard chartered
paytm phonepe gpay google play amazon flipkart swiggy zomato uber ola rapido
airtel jio vodafone idea netflix spotify irctc razorpay payu zepto blinkit
bank credit debit card account acc upi neft imps rtgs atm pos ref refno rrn utr
txn transaction dear customer user sent from to on not you your call sms block
update alert low balance funds mandate payee beneficiary statement generated
delivered please thank the for and has have been will is was rs inr usd min due
date total limit available avbl ltd limited pvt private services service
solutions india digital technologies enterprises mr mrs ms dr shri smt team bill
pay payment app link click visit valid till off get now new old yesterday today
track view know check enable disable restore avoid redeem reset activate
download register confirm verify continue learn report unblock dispute add added
make info help support branch ifsc cheque deposit withdrawal interest emi loan
stop start quit unsub resume active inactive yes no ok done fail failed success
dormant kyc ckyc rekyc fastag netc wallet reload autopay smartpay mycards imobile
netbanking mobilebanking upi vpa qr atm pos otp pin mpin cvv nach ecs mandate
declined reversed reversal refund cashback reward statement generated overdue
telecom regulatory authority india npci rbi trai uidai government dept department
notice alert attention important update reminder congratulations welcome thanks
regards team customer care relationship manager rm nominee nomination
`.trim().split(/\s+/));

/** @param {string} s */
function looksLikeName(s) {
  const words = String(s).trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  if (/\d/.test(s)) return false;
  if (!words.every((w) => /^[A-Za-z][A-Za-z.'-]*$/.test(w))) return false;
  const real = words.filter((w) => !NOT_NAMES.has(w.toLowerCase().replace(/[.,]/g, '')));
  if (!real.length) return false;
  // A payee is a proper noun. "track your application" is an instruction that
  // happens to be three words long, and pseudonymising it destroys the very
  // structure this exists to preserve.
  return real.some((w) => /^[A-Z]/.test(w));
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MON_IDX = Object.fromEntries(MON.map((m, i) => [m.toLowerCase(), i]));

/** Applies the session offset. Returns null when the date is not real. */
function shifted(day, month, year) {
  const y = year < 100 ? 2000 + year : year;
  const d = new Date(y, month - 1, day);
  if (d.getFullYear() !== y || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
  d.setDate(d.getDate() + DATE_SHIFT_DAYS);
  return d;
}

const pad = (n) => String(n).padStart(2, '0');
const yearLike = (d, sample) => (sample.length === 2 ? pad(d.getFullYear() % 100) : String(d.getFullYear()));
const nines = (s) => s.replace(/[A-Za-z0-9]/g, '9');

/**
 * @typedef {object} RedactionResult
 * @property {string} text
 * @property {Record<string, number>} counts What was replaced, by category.
 * @property {string[]} warnings Patterns that still look like PII afterwards.
 */

/**
 * @param {string} input
 * @returns {RedactionResult}
 */
export function redact(input) {
  /** @type {Record<string, number>} */
  const counts = {};
  let t = String(input == null ? '' : input);

  const sub = (re, repl, kind) => {
    t = t.replace(re, (...args) => {
      counts[kind] = (counts[kind] || 0) + 1;
      return typeof repl === 'function' ? repl(...args) : repl;
    });
  };

  // ---- highest-risk identifiers first --------------------------------------
  sub(/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, 'EMAIL_REDACTED', 'email');
  sub(/\b[A-Z]{5}\d{4}[A-Z]\b/g, 'PANXXXXXXXXX', 'pan');
  /*
   * Aadhaar only in its written form (4-4-4 with separators) or next to the
   * word. A bare twelve-digit run is far more often a UPI reference or a
   * biller id, and labelling those AADHAAR_REDACTED was wrong twice over: it
   * mislabelled the field AND destroyed the digit-count shape that a parser
   * bug report needs.
   */
  sub(/\b\d{4}[\s-]\d{4}[\s-]\d{4}\b/g, 'AADHAAR_REDACTED', 'aadhaar');
  sub(/\b(aadhaar|uidai)\b([^\d\n]{0,20})(\d{8,12})/gi,
    (_m, w, gap) => `${w}${gap}AADHAAR_REDACTED`, 'aadhaar');
  sub(/\b[A-Z]{4}0[A-Z0-9]{6}\b/g, 'IFSC0XXXXXX', 'ifsc');
  // 13-19 digit runs are card numbers. Done before the generic digit rules.
  sub(/\b\d{13,19}\b/g, (m) => '9'.repeat(m.length), 'card_or_long_id');

  // ---- UPI handles: keep the PSP, pseudonymise the identity ----------------
  sub(
    /\b([A-Za-z0-9._-]{2,})@(ybl|okicici|okhdfcbank|oksbi|okaxis|paytm|apl|ibl|axl|upi|hdfcbank|icici|sbi|axisbank|axisb|jupiteraxis|fam|superyes)\b/gi,
    (_m, handle, psp) => (/^\+?\d{10,13}$/.test(handle)
      ? `9999999999@${psp}`
      : `${tag('VPA', handle)}@${psp}`),
    'vpa',
  );

  // ---- one-time codes ------------------------------------------------------
  //
  // An OTP is short-lived but it is still a credential, and a drift report is
  // pasted into issue trackers that outlive it. The keyword is kept because the
  // reject rule that catches OTPs is exactly the thing being debugged; only the
  // digits go.
  sub(/\b(otp|o\.t\.p|one[\s-]?time\s*(?:password|pin|code)|verification code|security code|passcode|pin)\b([^\d\n]{0,24}?)(\d{4,8})\b/gi,
    (_m, word, gap, code) => `${word}${gap}${'9'.repeat(code.length)}`, 'otp');
  sub(/\b(\d{4,8})(\s+is\s+your\s+(?:otp|one[\s-]?time|verification))/gi,
    (_m, code, tail) => '9'.repeat(code.length) + tail, 'otp');

  // ---- phone numbers -------------------------------------------------------
  /*
   * Every shape a bank actually uses, learned from a real inbox where the
   * previous rules leaked six of them: a 91-prefixed number without the plus
   * (9122616061), an STD landline with spaces around the hyphen
   * (080 - 68111518), eleven-digit toll-free (18602585000), a landline with a
   * leading zero (01140132102), and SMS shortcodes (5676766).
   */
  sub(/\b1800[-\s]?\d{3,8}\b/g, '1800XXXXXX', 'helpline');
  sub(/\b18[0-9]{2}[-\s]?\d{6,8}\b/g, '1800XXXXXX', 'helpline');
  sub(/(?<!\d)\+?91[-\s]?[6-9]\d{9}(?!\d)/g, '919999999999', 'phone');
  sub(/(?<!\d)0\d{2,4}[-\s]*\d{6,8}(?!\d)/g, '0XXXXXXXXXX', 'phone');
  sub(/(?<!\d)(?:\+91[-\s]?)?[6-9]\d{9}(?!\d)/g, '9999999999', 'phone');
  // Shortcodes appear next to an instruction to message or call them.
  sub(/\b(to|on|at)\s+(\d{5,8})(?!\d)/gi,
    (m, w, num) => (/^\d+$/.test(num) ? `${w} ${'9'.repeat(num.length)}` : m), 'shortcode');

  // ---- account and card tails: keep the masking style, blank the digits ----
  sub(
    /\b(a\/c|acct|account|ac|card|acc)(\s*no\.?)?\s*[:.]?\s*((?:x|\*){0,4})(\d{3,6})\b/gi,
    (_m, word, no, mask, digits) => `${word}${no || ''} ${mask}${'9'.repeat(digits.length)}`.replace(/\s+/g, ' '),
    'account',
  );
  sub(/\b((?:x|\*){1,4})(\d{4,6})\b/gi, (_m, mask, d) => mask + '9'.repeat(d.length), 'masked_tail');

  // ---- reference / transaction / application ids ---------------------------
  sub(
    /\b(ref(?:no|erence)?|rrn|utr|txn(?:\s*id)?|transaction no\.?|umn|sr|awb|order id|application)\s*[:.\-]?\s*([A-Za-z0-9_@-]{4,40})/gi,
    (_m, label, id) => `${label} ${nines(id)}`,
    'reference',
  );
  sub(/\b(?:IHL|MHL|SR)[_A-Z0-9]{6,}\b/g, 'APPLICATION_ID', 'application_id');

  /*
   * Anything still carrying seven or more consecutive digits: wallet ids, bill
   * numbers, unlabelled reference numbers, the tail of a long masked account.
   * Replaced digit-for-digit so the FORMAT survives — which is the whole
   * reason a drift report is worth sending — while the value does not. This
   * runs late, after every labelled rule has had its turn.
   */
  sub(/(?<![\dX*x])\d{7,}(?![\d])/g, (m) => '9'.repeat(m.length), 'long_id');
  sub(/\b([Xx*]{4,})(\d{2,6})\b/g, (_m, mask, d) => mask + '9'.repeat(d.length), 'masked_tail');

  // ---- URLs: keep that a link was present, drop it. Paths carry tokens. ----
  sub(/https?:\/\/\S+/g, 'https://REDACTED.LINK/x', 'url');
  sub(/\b(?:[a-z0-9-]+\.)+(?:io|in|com|co|me|bank|org|net)\b(?:\/\S*)?/gi, 'REDACTED.LINK/x', 'short_url');

  // ---- amounts: preserve the notation, replace the value -------------------
  sub(/((?:INR|Rs\.?|₹)\s*)([\d,]+(?:\.\d{1,2})?)/gi, (_m, cur, num) => cur + num.replace(/\d/g, '9'), 'amount');
  sub(/([\d,]+(?:\.\d{1,2})?)(\s*(?:INR|Rs\.?|₹))/gi, (_m, num, cur) => num.replace(/\d/g, '9') + cur, 'amount');

  // ---- dates: shifted, not destroyed ---------------------------------------
  sub(/\b(\d{1,2})([/-])(\d{1,2})\2(\d{2,4})\b/g, (m, d, sep, mo, y) => {
    const s = shifted(+d, +mo, +y);
    return s ? `${pad(s.getDate())}${sep}${pad(s.getMonth() + 1)}${sep}${yearLike(s, y)}` : m;
  }, 'date');

  sub(/\b(\d{1,2})([\s\-/]?)([A-Za-z]{3})([a-z]*)([\s\-/]?)(\d{2,4})\b/g,
    (m, d, s1, mon, tail, s2, y) => {
      const idx = MON_IDX[mon.toLowerCase()];
      if (idx === undefined) return m;
      const s = shifted(+d, idx + 1, +y);
      if (!s) return m;
      let name = MON[s.getMonth()];
      if (mon === mon.toUpperCase()) name = name.toUpperCase();
      return `${pad(s.getDate())}${s1}${name}${tail}${s2}${yearLike(s, y)}`;
    }, 'date');

  sub(/\b([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/g, (m, mon, d, y) => {
    const idx = MON_IDX[mon.toLowerCase()];
    if (idx === undefined) return m;
    const s = shifted(+d, idx + 1, +y);
    return s ? `${MON[s.getMonth()]} ${pad(s.getDate())}, ${s.getFullYear()}` : m;
  }, 'date');

  sub(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '99:99', 'time');

  // ---- names, last: everything above is already neutralised ----------------
  const named = (whole, prefix, name) => (looksLikeName(name.trimEnd())
    ? `${prefix}${tag('PERSON', name.trimEnd())}`
    : whole);

  /*
   * A title is the single strongest name signal in these messages, and it is
   * not tied to any one preposition — "To Mr X", "vide Mr X", "favouring Mrs Y"
   * are all the same thing. Matching on the title itself caught a real leak
   * that every preposition-anchored rule below had missed.
   */
  sub(/\b((?:Mr|Mrs|Ms|Dr|Shri|Smt|Sri|Kum)\.?\s+)([A-Z][A-Za-z.'-]*(?:\s+[A-Z][A-Za-z.'-]*){0,4})/g,
    (_m, title, name) => `${title}${tag('PERSON', name)}`, 'name_titled');

  sub(/\b(To\s+)([A-Za-z][A-Za-z\s.'-]{2,40}?)(?=\s*(?:\n|$|On\b|Ref\b|UPI\b))/gi, named, 'name');
  sub(/\b(from\s+)([A-Z][A-Za-z\s.'-]{2,40}?)(?=\s*(?:\n|$|on\b|ref\b|\.))/g, named, 'name');
  sub(/\b(Dear\s+)([A-Za-z][A-Za-z\s.'-]{2,40}?)(?=\s*[,\n]|$)/g, named, 'name');
  sub(/\b(received by\s+)([A-Za-z][A-Za-z\s.'-]{2,40}?)(?=\s*(?:on\b|at\b|[,.\n]|$))/gi, named, 'name');
  sub(/\b(credited by\s+)([A-Z][A-Za-z\s.'-]{2,40}?)(?=\s*(?:on\b|[,.\n]|$))/gi, named, 'name');
  // Initials followed by a surname: "N V V ANJANEYULU MUTYALA"
  sub(/\b((?:[A-Z]\s+){1,4}[A-Z]{2,}(?:\s+[A-Z]{2,})*)\b/g, (m) => tag('PERSON', m), 'name_initials');
  // ALL-CAPS runs of two or more words are almost always a payee in these SMS
  sub(/\b([A-Z]{2,}(?:\s+[A-Z]+){1,4})\b/g,
    (m) => (looksLikeName(m) ? tag('PERSON', m) : m), 'name_caps');

  /*
   * A NAME ON ITS OWN LINE, usually the salutation.
   *
   * This is how the user's own name reaches a report. HDFC opens with the
   * account holder's name and nothing else — "Adabalaphani,\nGood news!" —
   * which no preposition-anchored or title-anchored rule can see. It leaked
   * through every one of them in a real 5,000-message inbox.
   */
  t = t.replace(/^([A-Z][A-Za-z.'-]{2,30}(?:\s+[A-Z][A-Za-z.'-]{1,30}){0,3})\s*,\s*$/gm,
    (m, name) => {
      if (!looksLikeName(name)) return m;
      counts.name_salutation = (counts.name_salutation || 0) + 1;
      return `${tag('PERSON', name)},`;
    });

  /*
   * The generic "two capitalised words in a row" rule that used to sit here is
   * GONE.
   *
   * On a real inbox it fired 118 times — more than every other category
   * combined — and what it replaced was almost entirely template vocabulary:
   * "Telecom Regulatory Authority of India" became PERSON_4be3, "Login PIN"
   * became PERSON_172d, "Statement Generated" became a pseudonym. The report
   * exists so someone can read the SHAPE of a message and fix the parser, and
   * that rule shredded exactly the words that carry the shape while catching
   * few real names the anchored rules had missed.
   *
   * The trade was backwards. Anchored rules — titles, salutations, "To X",
   * "from X", "Dear X" — plus the all-caps payee rule catch names where names
   * actually appear in bank SMS. verify() re-scans the output, and the panel
   * tells the user to read it before sending, because no regex catches every
   * name and pretending otherwise is worse than saying so.
   */

  return { text: t, counts, warnings: verify(t) };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** @type {Array<[string, RegExp]>} */
const LEAKS = [
  ['an email address', /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/],
  ['a phone number', /(?<!\d)(?:\+91[-\s]?)?[6-9]\d{9}(?!\d)/],
  ['a long digit run', /(?<!\d)\d{11,}(?!\d)/],
  ['a PAN', /\b[A-Z]{5}\d{4}[A-Z]\b/],
  ['an IFSC code', /\b[A-Z]{4}0[A-Z0-9]{6}\b/],
  ['a live link', /https?:\/\/(?!REDACTED)\S{6,}/],
  ['an unmasked amount', /(?:INR|Rs\.?|₹)\s*\d*[1-8]\d*/i],
];

/**
 * The redactor writes 9s and fixed placeholders, and several of those match the
 * leak patterns above. Reporting them would train the reader to ignore the
 * warnings, which is worse than not warning at all.
 */
const PLACEHOLDER = /^(?:[9X]+|REDACTED\S*|EMAIL_REDACTED|AADHAAR_REDACTED|PANXXXXXXXXX|IFSC0XXXXXX|APPLICATION_ID|1800XXXXXX|9999999999@\w+)$/;

const isPlaceholder = (s) => {
  const core = String(s).trim();
  return PLACEHOLDER.test(core) || /^[9X*x\s./-]+$/.test(core);
};

/**
 * Re-scans redacted text and names anything that still looks personal.
 * @param {string} text
 * @returns {string[]}
 */
export function verify(text) {
  /** @type {string[]} */
  const found = [];
  for (const [label, re] of LEAKS) {
    const m = String(text).match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m && m.some((hit) => !isPlaceholder(hit))) found.push(label);
  }
  return [...new Set(found)];
}

/**
 * Builds the shareable report for the "Unrecognised messages" panel.
 *
 * Every field is redacted, including the sender, which is normalised to the
 * bank code so `AX-HDFCBK` and `VM-HDFCBK` read as one bank without carrying
 * the operator route. The header states what was done, so whoever receives it
 * does not have to guess whether it is safe to paste into an issue tracker.
 *
 * @param {Array<{sender: string, reason: string, body: string, count?: number}>} rows
 * @param {{build?: string, normaliseSender?: (s: string) => string}} [opts]
 */
export function buildDriftReport(rows, opts = {}) {
  const norm = opts.normaliseSender || ((s) => String(s || '').toUpperCase().replace(/^[A-Z]{2}[-\s]/, ''));
  /** @type {Record<string, number>} */
  const totals = {};
  const warnings = new Set();

  const blocks = rows.map((r, i) => {
    const out = redact(r.body);
    for (const [k, v] of Object.entries(out.counts)) totals[k] = (totals[k] || 0) + v;
    out.warnings.forEach((w) => warnings.add(w));
    return [
      `--- ${i + 1} of ${rows.length} ---`,
      `sender : ${norm(r.sender)}`,
      `reason : ${r.reason}`,
      `seen   : ${r.count || 1}×`,
      '',
      out.text.trim(),
      '',
    ].join('\n');
  });

  const replaced = Object.entries(totals).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v}`).join(', ') || 'nothing matched';

  const header = [
    'Sandeshika — unrecognised bank messages',
    `build ${opts.build || 'unknown'} · ${rows.length} template${rows.length === 1 ? '' : 's'}`,
    '',
    'REDACTED ON DEVICE before this text was produced. Amounts, account tails,',
    'names, phone numbers, UPI handles, references and links are replaced;',
    'dates are shifted by a constant offset so the format survives but the',
    'calendar is wrong. Sender IDs are reduced to the bank code.',
    `Replaced: ${replaced}.`,
    warnings.size
      ? `CHECK BEFORE SENDING — still resembles: ${[...warnings].join(', ')}.`
      : 'Automated re-scan found no remaining personal data. Read it anyway.',
    '',
  ].join('\n');

  return { text: header + blocks.join('\n'), counts: totals, warnings: [...warnings] };
}
