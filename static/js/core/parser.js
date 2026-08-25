/*
 * Sandeshika — deterministic bank SMS parser.
 *
 * DESIGN RULE: the LLM never parses. Bank SMS are templated, and a regex
 * extractor is instant, deterministic, reproducible and costs no battery. An
 * LLM asked to pull "450.00" out of a string will be right most of the time,
 * which is precisely the failure mode you cannot ship in a money app — a
 * silently wrong number looks exactly like a right one.
 *
 * The model is used for two things it is genuinely good at, both downstream of
 * this file: classifying an unknown merchant string into a category, and
 * answering questions in natural language.
 *
 * Everything here is pure and synchronous so it can be tested exhaustively.
 */

// ---------------------------------------------------------------------------
// TRAI DLT sender IDs.
//
// Indian financial SMS headers carry a two-letter OPERATOR prefix that changes
// with the telecom the message transited (AX/VK/JM/AD/VM/BP...), while the
// trailing identifier is the registered entity: AX-HDFCBK and VM-HDFCBK are the
// same bank. Keying anything off the raw header is therefore unstable; we strip
// the prefix before using it.
// ---------------------------------------------------------------------------
const BANK_IDS = {
  HDFCBK:'HDFC', HDFCBN:'HDFC', ICICIB:'ICICI', ICICIT:'ICICI', SBIINB:'SBI',
  SBIUPI:'SBI', ATMSBI:'SBI', AXISBK:'Axis', AXISB:'Axis', KOTAKB:'Kotak',
  INDUSB:'IndusInd', IDFCFB:'IDFC First', YESBNK:'Yes', PNBSMS:'PNB',
  CANBNK:'Canara', BOIIND:'BOI', UNIONB:'Union', FEDBNK:'Federal',
  RBLBNK:'RBL', AMEXIN:'Amex', SCBANK:'StanChart', CITIBK:'Citi',
  PAYTMB:'Paytm', PAYTM:'Paytm', PHONPE:'PhonePe', GPAYIN:'GPay',
  AMZNPY:'Amazon Pay', CREDCL:'CRED', SLICEIT:'Slice',
};

/** Strips the operator prefix: "AX-HDFCBK" -> "HDFCBK". */
function normaliseSender(address) {
  return String(address || '')
    .toUpperCase()
    .replace(/^[A-Z]{2}[-\s]/, '')
    .replace(/[^A-Z0-9]/g, '');
}

/**
 * A readable merchant name taken from the DLT sender header.
 *
 * WHY THIS EXISTS
 *
 * On a real inbox 1,165 transactions landed in the review queue, and almost all
 * of them for the same reason: the body named no merchant, so confidence fell
 * to 0.4 and the row was excluded from every total until a human confirmed it
 * one at a time. But the sender header names the merchant perfectly well —
 * AD-EPFOHO, VM-MYNTRA, VM-TSSPDC, VM-REDBUS. Throwing that away and then
 * asking the user to supply it by hand was the single largest source of
 * unusable output in the app.
 *
 * A BANK sender is deliberately excluded: money leaving an HDFC account is not
 * a payment to HDFC, and filling the merchant in with the bank's name would be
 * confidently wrong rather than merely unknown.
 *
 * @param {string|null} address
 * @returns {string|null}
 */
function senderMerchant(address) {
  const id = normaliseSender(address);
  if (!id || senderBank(address)) return null;
  // DLT headers are 6 alphanumerics; anything shorter is a shortcode, and a
  // numeric header is a person, not a business.
  if (!/^[A-Z][A-Z0-9]{2,9}$/.test(id)) return null;
  return (SENDER_BRANDS[id] || id.toLowerCase());
}

/**
 * Headers whose expansion is not obvious from the letters alone. Everything
 * else falls back to the header itself, lowercased, which is already a usable
 * label and groups correctly.
 */
const SENDER_BRANDS = {
  EPFOHO: 'epfo', EPFOIN: 'epfo',
  TSSPDC: 'tsspdcl', APSPDC: 'apspdcl', BESCOM: 'bescom',
  REDBUS: 'redbus', IRCTCI: 'irctc', MMYTRP: 'makemytrip',
  MYNTRA: 'myntra', AJIOIN: 'ajio', FKRTIN: 'flipkart', AMAZON: 'amazon',
  SWIGGY: 'swiggy', ZOMATO: 'zomato', BLNKIT: 'blinkit', ZEPTONW: 'zepto',
  ICICIP: 'icici prudential', HDFCLIFE: 'hdfc life', LICIND: 'lic',
  JIOPAY: 'jio', AIRTEL: 'airtel', VODAFN: 'vi',
  ACTFBR: 'act fibernet', BSNLIN: 'bsnl',
};

function senderBank(address) {
  const id = normaliseSender(address);
  if (BANK_IDS[id]) return BANK_IDS[id];
  for (const [k, v] of Object.entries(BANK_IDS)) if (id.startsWith(k)) return v;
  return null;
}

/**
 * True for headers that look like a registered financial entity. Used by the
 * app to detect TEMPLATE DRIFT: a message from a known bank sender that fails
 * to parse is a signal that the bank changed its format, not that the message
 * was irrelevant.
 */
function isFinancialSender(address) {
  const id = normaliseSender(address);
  if (!id) return false;
  if (senderBank(address)) return true;
  return /(BK|BNK|BANK|UPI|PAY|CARD|FIN|CRED)/.test(id);
}

// ---------------------------------------------------------------------------
// Rejection — runs FIRST and is the most important part of the file.
//
// A false positive is far more damaging than a miss. "Your OTP is 4506" must
// never become a ₹4,506 expense; a balance alert must never become income.
// Anything matching these is dropped before amount extraction is attempted.
// ---------------------------------------------------------------------------
/*
 * Two passes.
 *
 * PRE runs before direction detection, because these messages often have no
 * transaction verb at all -- a balance alert is exactly that. Running them
 * after direction meant they exited as "no-direction", which is technically a
 * rejection but reports the wrong reason and floods the template-drift signal
 * with routine balance SMS.
 *
 * POST needs the refund context, which needs direction, so it runs after.
 */
const REJECT_PRE = [
  { id: 'otp',        re: /\b(otp|one[\s-]?time\s*(password|pin)|verification code|do not share)\b/i },
  { id: 'promo',      re: /\b(offer|cashback up to|congratulations|win |sale |discount|apply now|click here|t&c apply|unsubscribe|limited period)\b/i },
  // `for using` is in the exemption list because a card-usage confirmation
  // quotes the balance left afterwards — "Thanks for using Card XXXX for INR
  // 250 at SWIGGY ... Avl Bal: INR 999" is a purchase, and without it the
  // balance rule discarded the entire transaction.
  { id: 'balance',    re: /^(?=.*\b(avl|available|closing|a\/c)\s*(bal|balance)\b)(?!.*\b(debited|credited|spent|withdrawn|paid|received|sent|for using)\b)/i },
  // Lookahead must scan the WHOLE message, not just what follows the phrase.
  // "Spent Rs.500 on Card 1234. Avbl Credit Limit: Rs.45,000" is a real
  // purchase whose spend verb appears BEFORE the limit phrase; the previous
  // trailing-only lookahead threw the transaction away entirely.
  { id: 'limit',      re: /^(?=.*\b(credit limit|available limit)\b)(?!.*\b(spent|debited|withdrawn|paid|purchase)\b)/i },
  // Pre-authorisation holds (fuel pumps, hotels) settle later at a DIFFERENT
  // amount. Counting the hold and then the settlement double-counts.
  { id: 'hold',       re: /\b(hold (placed|amount)|pre-?auth|blocked (for|on)|authorization hold|temporarily blocked)\b/i },
  { id: 'emandate',   re: /\b(e-?mandate|standing instruction).*\b(registered|created|cancelled)\b/i },

  // --- everything below was learned from a real inbox, where these accounted
  // --- for the overwhelming majority of "unparseable" bank messages.

  // Mandate lifecycle: setting up or cancelling an autopay is not a payment.
  // "UPI Mandate: Sent Rs..." IS one, so this must not match a send.
  { id: 'mandate',    re: /^(?=.*\b(mandate|autopay|standing instruction)\b)(?=.*\b(set|cancelled|registration|registered|created|failed|revoked)\b)(?!.*\bsent\b)/i },

  // Payee/beneficiary administration.
  { id: 'payee',      re: /\b(payee|beneficiary)\b.*\b(added|registered|activated)\b|\badded .{0,30}as a payee\b|\bafter 30 ?min|\bsince adding\b/i },

  // Balance-threshold nags. Very high volume; carries a balance, not a txn.
  { id: 'balance',    re: /\bbal(ance)? in .{0,40}a\/c\b.*\b(gone below|minimum limit)\b|\bmaintain rs\.?\s*[\d,]+ to avoid\b/i },

  // Marketing, servicing and security notices.
  { id: 'notice',     re: /\b(scheduled maintenance|will be unavailable|services (will be )?offline|re-?kyc|ckyc|has been (reactivated|generated)|logged into your|pin has been|address updation|e-?mail id verification|convert your .{0,30}into easy emis|smartemi|invites you|beware of|stay safe|fake|smishing|phishing|delink|reward points|hearty points|payback points|voucher|cashback\b.{0,20}\b(valid|earned)|download the app|visit (now|our)|t&cs?\b.{0,10}$)/i },

  // Delivery and application status.
  { id: 'status',     re: /\b(delivered|dispatched|received by|application|statement (generated|is ready)|e-?statement|unable to confirm|has moved to a new link)\b/i },

  // Somebody asking to be paid is not a payment.
  { id: 'request',    re: /\b(is requesting|payment request|collect request|has requested (money|payment)|approve.*request|requested payment (of|for))\b/i },

  // Returned / reversed outgoing payments.
  { id: 'returned',   re: /\b(returned on|has been unsuccessful|will be reversed|payment attempt .{0,20}unsuccessful)\b/i },
];

/**
 * Declines carry no direction verb, so they were falling through to
 * "no-direction" and polluting the template-drift signal. They belong in the
 * pre-pass, where a reason can be reported honestly.
 */
const REJECT_DECLINE = [
  { id: 'failed',     re: /\b(is declined|was declined|declined!|purchase declined|has failed|payment .{0,30}has failed|low funds|due to low funds|incorrect pin|txn .{0,20}declined)\b/i },
];

/** Needs direction + refund context, so evaluated after those are known. */
const REJECT_POST = [
  { id: 'failed',     re: /\b(failed|declined|unsuccessful|could not be processed|reversed due to|insufficient)\b/i },
  { id: 'reminder',   re: /\b(due on|payment due|minimum amount due|total amount due|bill generated|statement is ready|autopay.*scheduled|will be debited)\b/i },
];

/** Reject reasons that are ordinary inbox noise, not a broken bank template. */
const EXPECTED_NOISE = [
  'otp', 'promo', 'request', 'reminder', 'balance', 'limit', 'emandate', 'hold',
  'mandate', 'payee', 'notice', 'status', 'returned', 'failed',
];

/**
 * Refunds and reversals are credits that reference a failed or returned
 * payment, so they collide with the "failed" reject. They must be kept: a
 * refund offsets earlier spend, and dropping it overstates expenditure.
 */
const REFUND_RE = /\b(refund(ed)?|reversal|reversed|returned to (your )?(a\/c|account|card)|credited back|charge ?back)\b/i;

/**
 * Money moving between the user's OWN accounts is not expenditure.
 *
 * The most damaging case is a credit-card bill payment: the card purchases were
 * already recorded as expenses, so counting the bill payment as well
 * double-counts every rupee on that statement. Same for wallet top-ups and
 * self-transfers.
 */
const INTERNAL_RE = new RegExp([
  String.raw`\bcredit card (bill|payment|due)\b`,
  String.raw`\btowards .{0,20}\bcard\b`,
  String.raw`\bcard (bill )?payment\b`,
  String.raw`\bpayment (received )?(towards|for) .{0,20}\bcard\b`,
  String.raw`\bcard ending .{0,10}\b(paid|payment)\b`,
  String.raw`\bself[- ]transfer\b`,
  String.raw`\bto your own (a\/c|account)\b`,
  String.raw`\b(wallet|paytm|phonepe|amazon pay) (top[- ]?up|add(ed)? money|load)\b`,
  String.raw`\badded to your .{0,20}wallet\b`,
  String.raw`\bcred\b.{0,30}\bcard\b`,
  // "payment of INR 47,719.43 towards ICICI Bank Credit Card Account XX5008
  //  through Auto Debit from Account XX0570" -- the card spend was already
  //  counted; booking the bill too double-counts the whole statement.
  String.raw`\btowards\b.{0,40}\bcredit card\b`,
  String.raw`\bauto ?debit\b.{0,40}\bcredit card\b`,
  String.raw`\bcredit card\b.{0,30}\bthrough auto ?debit\b`,
  // Toll and transit wallets. A FASTag recharge is money moving from the bank
  // to another pocket of the user's own, so counting the debit as spending and
  // the credit as income double-counts it in both directions.
  String.raw`\bfastag\b`,
  // Retirement and provident-fund contributions: the user's own money moving
  // into the user's own pocket. Counting an EPF credit as income overstates
  // earnings every month it lands.
  String.raw`\b(epf|epfo|provident fund|ppf|nps)\b.{0,30}\bcontribution\b`,
  String.raw`\bcontribution\b.{0,30}\b(epf|epfo|provident fund|ppf|nps|uan)\b`,
  String.raw`\bnetc\b`,
  String.raw`\bmetro (card|smart ?card)\b.{0,20}\b(recharg|top ?up|load)`,
  // Any wallet or prepaid instrument being loaded.
  String.raw`\b(wallet|prepaid (card|instrument))\b.{0,24}\b(recharg|top ?up|load|credit)`,
  String.raw`\b(recharg\w*|top ?up|loaded)\b.{0,24}\b(wallet|fastag|netc)\b`,
  // Explicit movement between the user's own accounts.
  String.raw`\btransferred to your\b`,
  String.raw`\bby transfer from a\/c\b`,
  String.raw`\bto your (own )?(a\/c|account|wallet)\b`,
].join('|'), 'i');

// ---------------------------------------------------------------------------
// Amount. Indian grouping is 1,23,456.78 — NOT 123,456.78 — so a naive
// thousands-separator regex silently truncates lakh-scale amounts.
// ---------------------------------------------------------------------------
const CURRENCY = String.raw`(?:inr|rs\.?|₹|rupees)`;
// The grouped branch requires at least ONE comma group (+, not *). With * the
// alternation matched "500" out of "5000" and stopped, silently truncating
// every un-grouped four-digit-or-larger amount. Caught by the test corpus.
const NUMBER   = String.raw`(?:\d{1,3}(?:,\d{2,3})+|\d+)(?:\.\d{1,2})?`;

const AMOUNT_PATTERNS = [
  new RegExp(String.raw`${CURRENCY}\s*[:\-]?\s*(${NUMBER})`, 'i'),
  new RegExp(String.raw`(${NUMBER})\s*${CURRENCY}`, 'i'),
  // SBI-style: "debited by 450.0"
  new RegExp(String.raw`\bdebited\s+by\s+(${NUMBER})`, 'i'),
  new RegExp(String.raw`\bcredited\s+by\s+(${NUMBER})`, 'i'),
];

/**
 * Foreign-currency spend (international cards). Captured rather than dropped,
 * but never mixed into INR totals: converting needs a rate we do not have
 * offline, and a wrong conversion is worse than a flagged unknown.
 */
const FOREIGN_RE = /\b(USD|EUR|GBP|AED|SGD|AUD|CAD|JPY|CHF|THB|MYR)\s*([\d,]+(?:\.\d{1,2})?)/i;

function parseForeign(text) {
  const m = text.match(FOREIGN_RE);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? { currency: m[1].toUpperCase(), amount: n } : null;
}

function parseAmount(text) {
  for (const re of AMOUNT_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    // A leading minus must not be swallowed. "Rs.-500 debited" is malformed or
    // an adjustment line; treating it as +500 spend would be a silent error in
    // the user's favour, which is still an error.
    const at = m.index + m[0].indexOf(m[1]);
    if (at > 0 && /[-\u2212]/.test(text[at - 1])) continue;
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------
/*
 * Verbs taken from a real 5,000-message inbox, not invented.
 *
 * "Sent Rs.X From <bank> To <name>" is HDFC's standard UPI wording and was the
 * single largest gap: hundreds of genuine payments were being discarded as
 * "no-direction" because the list only had "sent to".
 */
const DEBIT_RE  = /\b(debited|spent|withdrawn|paid|purchase|deducted|sent|transferred to|txn of|charged|processed payment of|payment of|done for|recharged with|loaded with|thanks? (you )?for using)\b/i;
/*
 * `reversed` was missing while `reversal` was present, so "your UPI transaction
 * has been reversed in your account" produced no direction at all. In one real
 * inbox that single omission discarded 115 genuine refunds — money that had
 * come back and was never credited against the spend it offset.
 *
 * "Thanks for using <card> for INR X at <merchant>" is a purchase confirmation
 * with no spend verb in it. It is how card networks word a completed charge.
 */
const CREDIT_RE = /\b(credited|received|deposited|refund(ed)?|revers(al|ed)|cashback of|added to)\b/i;

function parseDirection(text) {
  const d = DEBIT_RE.test(text);
  const c = CREDIT_RE.test(text);
  if (d && !c) return 'debit';
  if (c && !d) return 'credit';
  if (d && c) {
    // Both appear, e.g. "debited ... credited to SWIGGY". The subject of the
    // sentence is the user's account, so whichever verb comes first wins.
    return text.search(DEBIT_RE) < text.search(CREDIT_RE) ? 'debit' : 'credit';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Account / card tail
// ---------------------------------------------------------------------------
const ACCOUNT_PATTERNS = [
  /\b(?:a\/c|acct|account|ac)\s*(?:no\.?)?\s*[:.]?\s*(?:x+|\*+)?(\d{3,6})\b/i,
  /\bcard\s*(?:no\.?)?\s*[:.]?\s*(?:x+|\*+)?(\d{3,6})\b/i,
  /\b(?:x{2,}|\*{2,})(\d{3,6})\b/i,
];

function parseAccount(text) {
  for (const re of ACCOUNT_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1].slice(-4);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date. Banks use a dozen formats; an unparseable date falls back to the SMS
// timestamp rather than dropping the transaction.
// ---------------------------------------------------------------------------
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseDate(text, fallbackMs) {
  const norm = (y) => (y < 100 ? 2000 + y : y);

  // 05-Aug-25 / 05Aug25 / 05 Aug 2025
  let m = text.match(/\b(\d{1,2})[\s\-\/]?([a-z]{3})[a-z]*[\s\-\/]?(\d{2,4})\b/i);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const d = new Date(norm(+m[3]), MONTHS[m[2].toLowerCase()], +m[1]);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  // 05-08-25 / 05/08/2025  (day-first: Indian convention)
  m = text.match(/\b(\d{1,2})[\-\/](\d{1,2})[\-\/](\d{2,4})\b/);
  if (m) {
    const d = new Date(norm(+m[3]), +m[2] - 1, +m[1]);
    if (!isNaN(d.getTime()) && +m[2] <= 12) return d.getTime();
  }
  // "Feb 24, 2025" / "Aug 06 2024" -- month name FIRST. Common in telecom and
  // wallet messages, and previously unmatched, so those transactions silently
  // took the SMS arrival time instead of the date they state.
  m = text.match(/\b([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})\b/i);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const d = new Date(+m[3], MONTHS[m[1].toLowerCase()], +m[2]);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  // 2025-08-05
  m = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return fallbackMs;
}

// ---------------------------------------------------------------------------
// Reference number — the strongest dedup key when present.
// ---------------------------------------------------------------------------
function parseRef(text) {
  const m = text.match(/\b(?:ref(?:erence)?(?:\s*(?:no|num|id))?|rrn|utr|txn(?:\s*id)?|upi(?:\s*ref)?)\s*[:.\-]?\s*(\w{6,25})\b/i);
  return m ? m[1].toUpperCase() : null;
}

// ---------------------------------------------------------------------------
// Merchant / counterparty
// ---------------------------------------------------------------------------
const MERCHANT_PATTERNS = [
  /\bto\s+vpa\s+([^\s;,.]+)/i,
  /\bvpa\s+([^\s;,.]+)/i,
  // HDFC UPI variant with no "On" before the date: "To Google Play 07/08/26"
  /\bTo\s+([^\n]{2,40}?)\s+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/i,
  // HDFC UPI: "Sent Rs.X From HDFC Bank A/C *5261 To <name> On 10/08/26 Ref N"
  // Anchored on "To ... On <date>" so the bank's own name is never taken.
  /\bTo\s+([^\n]{2,40}?)\s+On\s+\d{1,2}[\/\-]/i,
  // "processed payment of INR X to Merchant <name>, as per Standing Instruction"
  /\bto\s+Merchant\s+([^,;.]{2,40})/i,
  // PayU: "for Rs. 80.00 done for BOTTLE LAB TECHNOLOGIES PRI..."
  /\bdone for\s+([^,;.]{2,40}?)(?:\.{2,}|\s+has\b|[,;.]|$)/i,
  /\btrf\s+to\s+([^;,.]+?)(?=\s+(?:ref|refno|on|upi|rrn)\b|[;,.]|$)/i,
  /\bat\s+([A-Z0-9][^;,.]{2,40}?)(?=\s+on\b|\s+ref\b|[;,.]|$)/i,
  /\bto\s+([A-Z0-9][^;,.]{2,40}?)(?=\s+on\b|\s+ref\b|\s+upi\b|[;,.]|$)/i,
  /\bUPI\/(?:P2M|P2A)\/\d+\/([^\/;,.]+)/i,
  /\bfrom\s+([A-Z0-9][^;,.]{2,40}?)(?=\s+on\b|\s+ref\b|[;,.]|$)/i,
  /;\s*([A-Z][A-Za-z0-9 &.\-]{2,40}?)\s+credited/i,
];

const MERCHANT_NOISE = /\b(a\/c|acct|account|your|the|bank|via|using|ltd|limited|pvt|private|upi|vpa|neft|imps|rtgs|txn|ref)\b/gi;

/**
 * Payment aggregators prepend themselves to the real merchant:
 * "RAZORPAY*SOMESHOP", "PAYU*ACME", "BILLDESK MERCHANT". The consumer cares
 * about the shop, not the rails.
 */
const AGGREGATORS = /^(razorpay|payu|billdesk|ccavenue|cashfree|instamojo|paytm|phonepe|gpay|bharatpe|pine ?labs|worldline|atom|easebuzz)[\s*|:\-]+/i;

/**
 * A UPI handle that carries no human meaning: a phone number, or a random
 * alphanumeric string like "q398457239". Showing that as the merchant is worse
 * than showing nothing, because it looks like real data.
 */
function vpaQuality(handle) {
  const h = String(handle || '');
  if (/^\+?\d{10,13}$/.test(h)) return 'phone';        // P2P: a person, probably
  if (/^\d+$/.test(h)) return 'opaque';
  // mostly-digits or no vowels => machine-generated
  const digits = (h.match(/\d/g) || []).length;
  if (h.length >= 6 && digits / h.length > 0.5) return 'opaque';
  if (h.length >= 8 && !/[aeiou]/i.test(h)) return 'opaque';
  return 'named';
}

function parseMerchant(text) {
  for (const re of MERCHANT_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    let raw = m[1].trim();
    let quality = 'named';

    // VPA: take the handle, drop the PSP suffix. "swiggy.stores@icici" -> swiggy stores
    if (raw.includes('@')) {
      const handle = raw.split('@')[0];
      quality = vpaQuality(handle);
      raw = handle;
    }

    raw = raw.replace(AGGREGATORS, '');
    // Trailing date or reference left over when the bank omits "On"/"Ref"
    // separators, e.g. "To Google Play 07/08/26".
    raw = raw
      .replace(/\s+\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*$/, '')
      .replace(/\s+(?:on|ref|refno|upi|rrn)\b.*$/i, '')
      .trim();

    raw = raw
      .replace(/[_.\-]+/g, ' ')
      .replace(MERCHANT_NOISE, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // A low-quality VPA handle returns HERE, before the numeric guard below.
    // A phone-number handle is all digits, so the guard was discarding it and
    // letting a much worse pattern match further down the list -- turning
    // "to VPA 9876543210@paytm" into the merchant "XX1234 to 9876543210".
    if (quality !== 'named') {
      return raw ? { name: raw.slice(0, 60), quality } : null;
    }

    // Reject anything that is actually an account tail rather than a payee:
    // a bare number, or a masked form like "XX1234" left behind after the
    // "a/c" token was stripped as noise.
    if (!raw || /^\d+$/.test(raw) || /^[x*]+\s*\d+$/i.test(raw) || raw.length < 2) continue;
    return { name: raw.slice(0, 60), quality: 'named' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------
function parseChannel(text) {
  if (/\bupi\b|\bvpa\b|@[a-z]{2,}/i.test(text)) return 'upi';
  if (/\bcard\b|\bpos\b|\bspent on\b/i.test(text)) return 'card';
  if (/\bneft\b/i.test(text)) return 'neft';
  if (/\bimps\b/i.test(text)) return 'imps';
  if (/\brtgs\b/i.test(text)) return 'rtgs';
  if (/\batm\b|\bwithdrawn\b/i.test(text)) return 'atm';
  if (/\bcheque|chq\b/i.test(text)) return 'cheque';
  return 'other';
}

// ---------------------------------------------------------------------------
// Balance (informational only — never treated as a transaction)
// ---------------------------------------------------------------------------
function parseBalance(text) {
  const re = new RegExp(String.raw`(?:avl|available|closing|updated)?\s*bal(?:ance)?\s*[:.\-]?\s*(?:is\s*)?${CURRENCY}?\s*(${NUMBER})`, 'i');
  const m = text.match(re);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Confidence
//
// Drives the review queue. Anything below REVIEW_THRESHOLD is surfaced to the
// user instead of being silently folded into a total. Being visibly unsure is
// worth far more than being quietly wrong.
// ---------------------------------------------------------------------------
function score(t, hadExplicitDate) {
  let s = 0.4;                        // baseline: amount + direction present
  if (t.merchant) s += 0.25;
  if (t.ref) s += 0.15;
  if (t.account) s += 0.1;
  if (hadExplicitDate) s += 0.1;
  if (t.channel !== 'other') s += 0.05;
  // Suspiciously round large amounts are more often promo copy than spend.
  if (t.amount >= 100000 && t.amount % 10000 === 0) s -= 0.15;
  return Math.max(0, Math.min(1, s));
}

/**
 * Stable identity for a transaction, used to deduplicate.
 *
 * Banks routinely send two messages for one payment (account debit + card
 * alert), and a backfill re-run must not double-count. Reference number is the
 * strongest key; without one, amount + day + account + direction is a
 * reasonable proxy. Deliberately day-granular, because the two alerts for the
 * same payment can carry timestamps minutes apart.
 */
function fingerprint(t) {
  const day = new Date(t.date);
  const dayKey = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
  if (t.ref) return `r:${t.ref}:${t.amount}`;
  return `h:${t.direction}:${t.amount}:${dayKey}:${t.account || '?'}`;
}

const REVIEW_THRESHOLD = 0.6;

/**
 * @param {{id:number|string, body:string, date:number, address?:string}} sms
 * @returns {{ok:true, txn:object} | {ok:false, reason:string}}
 */
/**
 * @param {import('./types.js').Sms} sms
 * @returns {import('./types.js').ParseResult}
 */
function parse(sms) {
  // Field data contains "Rs.500debited" with no separator, which defeats every
  // \b-anchored verb pattern. Insert a space only between a digit and a known
  // transaction verb -- a blanket digit/letter split would wreck "05Aug25" and
  // "XX1234".
  const text = String(sms.body || '')
    .replace(/\s+/g, ' ')
    .replace(/(\d)(debited|credited|spent|withdrawn|paid|received|deducted)\b/gi, '$1 $2')
    .trim();
  if (!text) return { ok: false, reason: 'empty' };

  // Pass 1: rejections that do not depend on direction.
  for (const r of REJECT_PRE.concat(REJECT_DECLINE)) {
    if (r.re.test(text)) return { ok: false, reason: r.id };
  }

  const direction = parseDirection(text);
  if (!direction) return { ok: false, reason: 'no-direction' };

  // A genuine refund is money that HAS come back: a credit, in the past tense.
  // "Amount will be reversed due to insufficient balance" is a failed payment
  // announcing an intention -- gating on credit + non-future keeps that
  // rejected instead of booking it as spend.
  const futureTense = /\b(will be|shall be|to be)\s+(reversed|credited|refunded)\b/i.test(text);
  const isRefund = direction === 'credit' && !futureTense && REFUND_RE.test(text);

  // Pass 2: rejections that a genuine refund is exempt from, since a refund
  // necessarily references the payment it reverses.
  for (const r of REJECT_POST) {
    if (isRefund) continue;
    if (r.re.test(text)) return { ok: false, reason: r.id };
  }

  const foreign = parseForeign(text);
  const amount = parseAmount(text);
  if (amount === null) {
    // International spend with no INR figure: keep it, flagged, rather than
    // silently dropping a real transaction.
    if (!foreign) return { ok: false, reason: 'no-amount' };
  }

  const explicitDate = /\b\d{1,2}[\s\-\/]?[a-z]{3}|\b\d{1,2}[\-\/]\d{1,2}[\-\/]\d{2,4}|\b\d{4}-\d{2}-\d{2}/i.test(text);

  const m = parseMerchant(text);
  const internal = INTERNAL_RE.test(text);

  /** @type {import('./types.js').Txn} */
  const txn = /** @type {any} */ ({
    smsId: sms.id,
    direction,
    amount: amount === null ? 0 : amount,
    currency: amount === null && foreign ? foreign.currency : 'INR',
    foreignAmount: foreign ? foreign.amount : null,
    foreignCurrency: foreign ? foreign.currency : null,
    account: parseAccount(text),
    merchant: m ? m.name : senderMerchant(sms.address),
    // 'sender' records that the name came from the DLT header rather than the
    // message body: good enough to total and to categorise, but worth knowing
    // when a category rule misfires.
    merchantQuality: m ? m.quality : (senderMerchant(sms.address) ? 'sender' : null),
    ref: parseRef(text),
    channel: parseChannel(text),
    date: parseDate(text, sms.date),
    balance: parseBalance(text),
    sender: sms.address || null,
    senderId: normaliseSender(sms.address),
    bank: senderBank(sms.address),
    category: null,          // filled by the LLM, later
    categorySource: null,    // 'rule' | 'llm' | 'user'
    raw: text.slice(0, 300),
  });

  // kind drives the analytics, not `direction`. Spend, refunds, income and
  // internal movement have to be told apart or every total is wrong.
  /*
   * ORDER MATTERS. A refund is checked BEFORE the internal-transfer heuristic.
   *
   * INTERNAL_RE contains generic phrasing like "to your account", which
   * appears in almost every credit — including "Refund Initiated: Rs.499 ...
   * has been processed to your account". That booked real refunds as internal
   * movement, so they neither offset the spending they reversed nor showed up
   * anywhere the user could find them. Explicit refund wording is the far more
   * specific signal and wins.
   */
  txn.kind = isRefund && direction === 'credit' ? 'refund'
    : internal ? 'transfer'
    : direction === 'credit' ? 'income'
    : 'expense';
  if (txn.kind === 'transfer') { txn.category = 'transfer'; txn.categorySource = 'rule'; }

  // A phone-number VPA could be a friend or the tea stall that took UPI. The
  // honest answer is "unknown", so it goes to the review queue instead of
  // being silently bucketed either way.
  txn.ambiguousP2P = txn.merchantQuality === 'phone';

  txn.confidence = score(txn, explicitDate);
  // A sender-derived merchant is slightly weaker than one read from the body,
  // but it is a real name — not the penalty an opaque handle deserves.
  if (txn.merchantQuality === 'sender') txn.confidence -= 0.05;
  else if (txn.merchantQuality && txn.merchantQuality !== 'named') txn.confidence -= 0.25;
  if (txn.currency !== 'INR') txn.confidence -= 0.3;
  txn.confidence = Math.max(0, Math.min(1, txn.confidence));

  // An opaque handle like "q398457239" is not a merchant name, it just looks
  // like one. Surfacing it for review is honest; printing it in a report is not.
  txn.needsReview = txn.confidence < REVIEW_THRESHOLD
    || txn.ambiguousP2P
    || txn.currency !== 'INR'
    || (txn.merchantQuality != null
        && txn.merchantQuality !== 'named'
        && txn.merchantQuality !== 'sender');

  txn.fingerprint = fingerprint(txn);
  // Secondary key for cross-sender duplicates: one payment often produces a
  // bank SMS, a UPI-app SMS and a merchant SMS, none sharing an account tail.
  // Amount + direction + a 10-minute bucket catches those.
  // Cross-sender duplicate detection.
  //
  // One payment is often reported twice: once by the bank and once by the UPI
  // app, seconds apart, with no shared reference number. Amount + merchant +
  // rough time identifies that pair.
  //
  // Two subtleties, both learned the hard way:
  //
  //  - The MERCHANT must be in the key. Without it, "amount + 10-minute
  //    bucket" merged two different ₹100 payments made in the same window, and
  //    a busy day lost most of its transactions.
  //  - Only the LEADING token of the merchant is used, because the bank writes
  //    "swiggy" where the wallet writes "Swiggy via Paytm".
  //  - TWO buckets are emitted, not one. A fixed bucket boundary splits events
  //    45 seconds apart into different buckets roughly a tenth of the time, so
  //    the duplicate silently survives. Checking the current and previous
  //    bucket removes that edge entirely.
  const mk = merchantKey(txn.merchant).split(' ')[0];
  const bucket = Math.floor(txn.date / 600000);
  txn.softKeys = mk
    ? [`${direction}:${txn.amount}:${bucket}:${mk}`,
       `${direction}:${txn.amount}:${bucket - 1}:${mk}`]
    : [`nomerchant:${sms.id}`];
  txn.softKey = txn.softKeys[0];
  return { ok: true, txn };
}

// ---------------------------------------------------------------------------
// Merchant -> category, rules first.
//
// A lookup table answers most merchants instantly and identically every time.
// The LLM is only consulted for strings this misses, and its answer is cached,
// so a given merchant costs inference exactly once in the app's lifetime.
// ---------------------------------------------------------------------------
const CATEGORIES = [
  'food', 'groceries', 'transport', 'shopping', 'bills', 'entertainment',
  'health', 'education', 'travel', 'transfer', 'investment', 'income', 'other',
];

/** @type {Array<[RegExp, string]>} */
const MERCHANT_RULES = [
  [/swiggy|zomato|dominos|mcdonald|kfc|pizza|restaurant|cafe|starbucks|eatfit|faasos|behrouz/i, 'food'],
  [/bigbasket|blinkit|zepto|instamart|dmart|grofers|bazaar|kirana|supermarket|reliance fresh|more retail/i, 'groceries'],
  [/uber|ola|rapido|irctc|redbus|metro|petrol|fuel|hpcl|bpcl|iocl|indian oil|shell|parking|fastag/i, 'transport'],
  [/amazon|flipkart|myntra|ajio|meesho|nykaa|tatacliq|snapdeal|lenskart|decathlon/i, 'shopping'],
  [/airtel|jio|vodafone|vi |bsnl|electricity|water|gas|broadband|dth|tata power|adani|bescom|torrent power|recharge|postpaid|prepaid/i, 'bills'],
  [/netflix|spotify|hotstar|prime video|sonyliv|zee5|bookmyshow|pvr|inox|youtube|gaming|google play|play store|app ?store|itunes|apple\.com/i, 'entertainment'],
  [/pharmacy|apollo|medplus|1mg|pharmeasy|hospital|clinic|diagnostics?\b|path\s?lab|labs\b|practo|doctor|medical/i, 'health'],
  [/school|college|university|tuition|byju|unacademy|vedantu|coursera|udemy|fees/i, 'education'],
  [/makemytrip|goibibo|cleartrip|yatra|airbnb|oyo|indigo|vistara|air india|spicejet|hotel|booking\.com/i, 'travel'],
  [/zerodha|groww|upstox|kuvera|coin|mutual fund|sip |nps |ppf|rd |fd |smallcase|angel one/i, 'investment'],
  [/salary|payroll|interest credit|dividend|refund/i, 'income'],
  [/self|own account|transfer to|neft|imps|rtgs/i, 'transfer'],
];

/**
 * Looks like a person rather than a business: two or more capitalised words,
 * no company suffix, no digits. UPI to an individual is usually a transfer, not
 * a purchase -- but this is a GUESS, so it is marked low-confidence and the
 * caller sends it to review rather than silently reshaping the totals.
 */
function looksPersonal(merchant) {
  const m = String(merchant || '').trim();
  if (!m || /\d/.test(m)) return false;
  if (/\b(ltd|limited|pvt|private|inc|llp|corp|company|store|stores|enterprises|technologies|services|solutions|bank|traders|agencies|mart|hospital|hotel)\b/i.test(m)) return false;
  const words = m.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  return words.every((w) => /^(?:[A-Z][a-z]*|[A-Z]{2,})$/.test(w));
}

/**
 * @param {string|null} merchant
 * @param {'debit'|'credit'} direction
 * @returns {import('./types.js').CategoryDecision|null}
 */
function categorise(merchant, direction) {
  if (!merchant) return direction === 'credit' ? { category: 'income', source: 'rule' } : null;
  for (const [re, cat] of MERCHANT_RULES) {
    if (re.test(merchant)) return { category: cat, source: 'rule' };
  }
  // Debits only: an incoming payment from a person is still income to the
  // user, and treating it as a transfer silently removes it from the totals.
  if (direction === 'debit' && looksPersonal(merchant)) {
    return { category: 'transfer', source: 'guess' };
  }
  return null; // caller falls back to the LLM
}

/** Normalises a merchant string so the category cache actually hits. */
function merchantKey(merchant) {
  return String(merchant || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export {
  parse, categorise, merchantKey, fingerprint,
  normaliseSender, senderBank, senderMerchant, isFinancialSender, vpaQuality, parseForeign, looksPersonal,
  REFUND_RE, INTERNAL_RE,
  parseAmount, parseDirection, parseMerchant, parseDate, parseRef,
  parseAccount, parseChannel, parseBalance,
  CATEGORIES, REVIEW_THRESHOLD, REJECT_PRE, REJECT_POST, EXPECTED_NOISE,
};
