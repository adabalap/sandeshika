/*
 * Sandeshika — inbox organiser.
 *
 * Two jobs the transaction parser deliberately does not do:
 *
 *   1. CLASSIFY every message into an inbox tab, including the ~80% that are
 *      not transactions at all.
 *   2. EXTRACT obligations — bills, due dates, deliveries, travel — which the
 *      parser correctly rejects as "not spending" and then throws away. A bill
 *      due on the 15th is the single most useful thing in an inbox and it was
 *      landing in the bin.
 *
 * Still no model involved. Categorising an inbox is pattern work, and a
 * deterministic classifier can be tested against a real corpus, which is the
 * only way to know it is right.
 */
import * as P from './parser.js';

// ---------------------------------------------------------------------
// Tabs. Ordered by how much the user cares, because a message can plausibly
// match more than one and the first hit wins.
// ---------------------------------------------------------------------
/** @type {Record<string, import('./types.js').Classification['tab']>} */
const TAB = {
  TRANSACTIONS: 'transactions',
  BILLS: 'bills',           // money owed, not yet paid
  UPDATES: 'updates',       // deliveries, travel, appointments, OTPs
  PROMOTIONS: 'promotions', // marketing
  PERSONAL: 'personal',     // an actual human
  SPAM: 'spam',
};

// ---------------------------------------------------------------------
// Spam. Kept narrow on purpose: wrongly hiding a real message is far worse
// than leaving one piece of junk in the inbox, so this only fires on things
// no legitimate sender does.
// ---------------------------------------------------------------------
const SPAM_RE = [
  /\b(earn|income)\s+(rs\.?|₹)?\s*[\d,]+\s*(per day|daily|\/day|per month)\b/i,
  /\bwork from home\b.{0,40}\b(earn|income|salary)\b/i,
  /\b(lottery|jackpot|lucky draw|you have won|prize money)\b/i,
  /\b(loan approved|instant loan).{0,40}\b(no documents|without documents)\b/i,
  /\bwa\.me\/\d+/i,                       // WhatsApp funnel
  /\btrade summary\b.{0,40}\bagents\b/i,  // the trading-tout pattern
];

// ---------------------------------------------------------------------
// Bills and obligations — the category that was being discarded.
// ---------------------------------------------------------------------
const BILL_RE = [
  /\b(bill|payment|amount|emi|premium)\s+(is\s+)?due\b/i,
  /\b(total|minimum|min)\s+(amount\s+)?due\b/i,
  /\bdue\s+(date|on|by)\b/i,
  /\b(statement|e-?statement)\s+generated\b/i,
  /\bis overdue\b|\bpayment is overdue\b|\bpay immediately\b/i,
  /\bplease (make )?pay\b|\bpay your\b.{0,30}\b(bill|dues|card)\b/i,
  /\bwill be (debited|deducted)\b/i,       // scheduled autopay
  /\balternate pymt\b|\bmake alternate payment\b/i,
];

const TRAVEL_RE = /\b(pnr|boarding|flight|train|bus|coach|seat no|departure|arrival|gate no|terminal)\b/i;
const DELIVERY_RE = /\b(delivered|out for delivery|shipped|dispatched|courier|awb|tracking|order .{0,20}(placed|confirmed)|will arrive)\b/i;
const APPOINTMENT_RE = /\b(appointment|scheduled for|your slot|booking confirmed|reporting time)\b/i;
const OTP_RE = /\b(otp|one[\s-]?time\s*(password|pin)|verification code|do not share)\b/i;

const PROMO_RE = [
  /\b(offer|sale|discount|cashback up to|flat \d+%|save up to|limited period|hurry|last chance)\b/i,
  // "T&Cs." often appears alone as the sign-off on an offer, with no "apply".
  /\bt&cs?\b|\bterms (and conditions )?apply\b/i,
  /\b(download the app|install now|click here|apply now|shop now|book now|order now)\b/i,
  // The gap between "convert" and "into easy EMIs" is a full product name,
  // routinely 40+ characters. A 30-char window silently missed every one.
  /\bconvert\b.{0,80}\binto easy emis?\b|\bsmartemi\b|\bpre-?approved\b|\bupgrade your\b/i,
  /\b(reward points|hearty points|payback points|voucher|coupon)\b/i,
  /\b(invites you|introducing|new feature|now available)\b/i,
];

// Bank service notices: not promotions, not transactions. Users want these
// out of the way but not filed as junk.
const SERVICE_RE = [
  /\b(scheduled maintenance|will be unavailable|services (will be )?offline)\b/i,
  /\b(re-?kyc|ckyc|address updation|pin has been|has been (reactivated|generated))\b/i,
  /\b(logged into your|login alert|beware of|fraud|smishing|phishing|never asks)\b/i,
  /\b(payee|beneficiary)\b.{0,30}\b(added|registered)\b/i,
  /\bmandate\b.{0,30}\b(set|cancelled|registered|failed)\b/i,
  /\bbal(ance)? in\b.{0,40}\b(gone below|minimum limit)\b/i,
];

const any = (res, t) => res.some((r) => r.test(t));

/**
 * Which tab a message belongs in.
 *
 * Returns { tab, subtype, reason } — `reason` names the rule that fired, so
 * a misfiling can be traced instead of argued about.
 */
/**
 * @param {import('./types.js').Sms} sms
 * @returns {import('./types.js').Classification}
 */
function classify(sms) {
  const text = String(sms.body || '').replace(/\s+/g, ' ').trim();
  const from = String(sms.address || '');
  const financial = P.isFinancialSender(from);

  if (!text) return { tab: TAB.UPDATES, subtype: 'empty', reason: 'empty' };

  if (any(SPAM_RE, text)) return { tab: TAB.SPAM, subtype: 'junk', reason: 'spam-pattern' };

  // A real transaction outranks everything: it is the reason the app exists.
  const parsed = P.parse(sms);
  if (parsed.ok) {
    return {
      tab: TAB.TRANSACTIONS,
      subtype: parsed.txn.kind,
      reason: 'parsed-transaction',
      txn: parsed.txn,
    };
  }

  if (OTP_RE.test(text)) {
    // OTPs are shown as "an OTP arrived", never with the code surfaced or
    // summarised. Repeating a one-time code in a digest or a widget is
    // exactly the behaviour that makes OTP phishing work.
    return { tab: TAB.UPDATES, subtype: 'otp', reason: 'otp', sensitive: true };
  }

  if (any(BILL_RE, text)) return { tab: TAB.BILLS, subtype: 'bill', reason: 'bill-pattern' };
  if (TRAVEL_RE.test(text)) return { tab: TAB.UPDATES, subtype: 'travel', reason: 'travel' };
  if (DELIVERY_RE.test(text)) return { tab: TAB.UPDATES, subtype: 'delivery', reason: 'delivery' };
  if (APPOINTMENT_RE.test(text)) return { tab: TAB.UPDATES, subtype: 'appointment', reason: 'appointment' };

  // Service notices are checked BEFORE promotions: "mandate cancelled" is
  // operational even though it mentions a product. Everything left that
  // matches marketing language is a promotion, whoever sent it -- banks are
  // the biggest advertisers in this inbox.
  if (any(SERVICE_RE, text)) return { tab: TAB.UPDATES, subtype: 'service', reason: 'service-notice' };
  if (any(PROMO_RE, text)) return { tab: TAB.PROMOTIONS, subtype: 'offer', reason: 'promo-pattern' };

  // A numeric sender is a person; an alphabetic DLT header is a business.
  // This is the most reliable personal/business signal Android gives us.
  if (/^\+?\d{7,15}$/.test(from.replace(/[\s-]/g, ''))) {
    return { tab: TAB.PERSONAL, subtype: 'person', reason: 'numeric-sender' };
  }

  if (financial) return { tab: TAB.UPDATES, subtype: 'bank-other', reason: 'financial-sender' };
  return { tab: TAB.UPDATES, subtype: 'other', reason: 'unmatched' };
}

// ---------------------------------------------------------------------
// Bill extraction
// ---------------------------------------------------------------------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/**
 * Finds the DUE date specifically, not just any date.
 *
 * A bill SMS usually contains two or three dates — the statement date, the
 * due date, sometimes a transaction date. Taking the first one found would
 * put reminders on the wrong day, which is worse than no reminder at all, so
 * this only accepts a date that is anchored to due-date wording.
 */
function parseDueDate(text, fallbackMs) {
  const anchors = [
    /\bdue\s*(?:date)?\s*[:\-]?\s*(\d{1,2})[\s\-\/]?([a-z]{3})[a-z]*[\s\-\/]?(\d{2,4})/i,
    /\bdue\s*(?:date)?\s*[:\-]?\s*(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{2,4})/i,
    /\bdue\s+(?:on|by)\s+(\d{1,2})[\s\-\/]?([a-z]{3})[a-z]*[\s\-\/]?(\d{2,4})/i,
    /\bdue\s+(?:on|by)\s+(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{2,4})/i,
    /\bpay\s+by\s+(\d{1,2})[\s\-\/]?([a-z]{3})[a-z]*[\s\-\/]?(\d{2,4})/i,
    /\b(?:on|before)\s+(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{2,4})\b(?=[^.]{0,40}\bdue\b)/i,
  ];
  const yr = (y) => (Number(y) < 100 ? 2000 + Number(y) : Number(y));

  for (const re of anchors) {
    const m = text.match(re);
    if (!m) continue;
    const monthTok = String(m[2]).toLowerCase();
    const month = MONTHS[monthTok] !== undefined ? MONTHS[monthTok] : Number(m[2]) - 1;
    if (!(month >= 0 && month <= 11)) continue;
    const d = new Date(yr(m[3]), month, Number(m[1]));
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

const MIN_DUE_RE = /\b(?:min(?:imum)?\s+(?:amount\s+)?due)\s*[:\-]?\s*(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i;

/** Amount attached to due-date wording, not merely the first number present. */
function parseDueAmount(text) {
  // Order matters. A bill SMS routinely carries BOTH a total and a minimum,
  // and the minimum is the smaller, more prominent-looking number. Matching
  // it would understate the obligation by an order of magnitude, so the
  // total is claimed first and "minimum" is explicitly excluded everywhere.
  const NOT_MIN = '(?<!min\\s)(?<!minimum\\s)(?<!min\\sdue\\s)';
  const pats = [
    /\b(?:total\s+(?:amount\s+)?due|amount\s+due|total\s+due)\s*[:\-]?\s*(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:bill|payment|emi|premium)\s+of\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
    /\b(?:pay|paying)\s+(?:INR|Rs\.?|₹)\s*([\d,]+(?:\.\d{1,2})?)/i,
    new RegExp(NOT_MIN + '(?:INR|Rs\\.?|₹)\\s*([\\d,]+(?:\\.\\d{1,2})?)\\s+(?:is\\s+)?due\\b', 'i'),
  ];
  const minM = text.match(MIN_DUE_RE);
  const minimum = minM ? Number(minM[1].replace(/,/g, '')) : null;

  for (const re of pats) {
    const m = text.match(re);
    if (!m) continue;
    const n = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(n) || n <= 0) continue;
    // If this is exactly the minimum and a larger total exists, keep looking.
    if (minimum !== null && n === minimum && /total|amount\s+due/i.test(text)) continue;
    return n;
  }
  // Fall back to the parser's generic amount, which already refuses to take
  // a balance or a credit limit.
  return P.parseAmount(text);
}

/**
 * Turns a bill message into a tracked obligation.
 * Returns null when there is nothing actionable — no amount and no date.
 */
/**
 * @param {import('./types.js').Sms} sms
 * @returns {import('./types.js').Bill|null}
 */
function extractBill(sms) {
  const text = String(sms.body || '').replace(/\s+/g, ' ').trim();
  const amount = parseDueAmount(text);
  const dueAt = parseDueDate(text, sms.date);
  if (amount === null && dueAt === null) return null;

  const minM = text.match(MIN_DUE_RE);
  const bank = P.senderBank(sms.address);
  const account = P.parseAccount(text);

  let issuer = bank;
  if (!issuer) {
    const m = text.match(/\b(?:your|for)\s+([A-Z][A-Za-z ]{2,24}?)\s+(?:bill|card|connection|postpaid)/);
    if (m) issuer = m[1].trim();
  }

  /** @type {import('./types.js').Bill['kind']} */
  const kind = /\bcredit card\b/i.test(text) ? 'credit-card'
    : /\b(postpaid|prepaid|mobile|broadband|dth|fibernet)\b/i.test(text) ? 'telecom'
    : /\b(electricity|power|water|gas|tsspdcl|bescom)\b/i.test(text) ? 'utility'
    : /\b(emi|loan)\b/i.test(text) ? 'loan'
    : /\b(premium|insurance|policy)\b/i.test(text) ? 'insurance'
    : 'other';

  return {
    smsId: sms.id,
    issuer: issuer || 'unknown',
    account,
    kind,
    amount,
    minimumDue: minM ? Number(minM[1].replace(/,/g, '')) : null,
    dueAt,
    seenAt: sms.date,
    overdue: /\b(overdue|immediately|returned on|alternate pymt)\b/i.test(text),
    // Same identity trick as transactions: one bill produces several
    // reminders, and they must collapse into a single obligation.
    fingerprint: `bill:${(issuer || '?').toLowerCase()}:${account || '?'}:${
      dueAt ? new Date(dueAt).toISOString().slice(0, 10) : 'nodate'}:${amount || 0}`,
    raw: text.slice(0, 300),
    status: /** @type {const} */ ('open'),   // open | paid | dismissed
  };
}

/** Days until due; negative when overdue. */
function daysUntil(ms, now) {
  if (!ms) return null;
  const day = 864e5;
  const a = new Date(ms); a.setHours(0, 0, 0, 0);
  const b = new Date(now || Date.now()); b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / day);
}

/**
 * Finds debit/credit pairs that are really one movement between the user's
 * own accounts.
 *
 * Wording does not always give it away: "Rs.5000 debited from XX1234" and
 * "Rs.5000 credited to XX5678" name no merchant and read like a payment and
 * an unrelated income. Left alone, one transfer inflates BOTH spending and
 * income by the same amount, and the net figure looks right while every
 * component is wrong.
 *
 * Matching is deliberately conservative: same amount to the paisa, same day,
 * opposite directions, different accounts, and neither side naming a
 * recognisable third-party merchant. Anything looser starts eating real
 * refunds. Pairs are SUGGESTED, never applied silently -- a wrong merge hides
 * a real expense, which is exactly the error a spending app must not make on
 * its own.
 */
function findTransferPairs(txns, windowMs = 864e5) {
  const debits = txns.filter((t) => t.kind === 'expense' && !t.pairedWith);
  const credits = txns.filter((t) => t.kind === 'income' && !t.pairedWith);
  const used = new Set();
  const pairs = [];

  for (const d of debits) {
    const match = credits.find((c) => !used.has(c.fingerprint)
      && c.amount === d.amount
      && Math.abs(c.date - d.date) <= windowMs
      && (c.account || '?') !== (d.account || '?')
      && !namesAThirdParty(d) && !namesAThirdParty(c));
    if (match) {
      used.add(match.fingerprint);
      pairs.push({ debit: d, credit: match, amount: d.amount });
    }
  }
  return pairs;
}

/**
 * True when the merchant looks like a real payee rather than blank or a bank
 * artefact. A named third party means it is a payment, not a self-transfer.
 */
function namesAThirdParty(t) {
  const m = (t.merchant || '').trim();
  if (!m) return false;
  if (/^(unknown|self|own)$/i.test(m)) return false;
  // A person's name is not evidence either way: paying a friend and moving
  // money to your own account look identical from the text.
  return !(t.merchantQuality === 'phone' || t.merchantQuality === 'opaque');
}

export {
TAB, classify, extractBill, parseDueDate, parseDueAmount, daysUntil,
findTransferPairs, namesAThirdParty, SPAM_RE, BILL_RE, PROMO_RE,
};
