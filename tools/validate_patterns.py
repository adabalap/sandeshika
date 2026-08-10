#!/usr/bin/env python3
"""Validate Sandeshika sanitizer patterns against realistic Indian SMS.

Ports the exact regexes intended for Sanitizer.kt so correctness is proven
on a real corpus before any Kotlin is written.
"""
import re, hashlib, unicodedata

# ---------------------------------------------------------------- DLT header
DLT = re.compile(r'^(?:([A-Z]{2})[-_])?([A-Z0-9]{2,10})(?:[-_]([STPG]))?$')

def norm_sender(raw):
    s = raw.strip().upper()
    if re.fullmatch(r'\+?\d[\d\s\-]{5,}', s):
        return None, None, 'PERSON'
    m = DLT.match(s)
    if not m:
        return None, None, 'UNKNOWN'
    return m.group(2), m.group(3), 'INSTITUTION'

# ---------------------------------------------------------------- amounts
# Indian lakh grouping: 1,23,456.78 -- naive [\d,]+ silently mis-parses this.
AMOUNT_BODY = r'(?:\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)'
CURRENCY = re.compile(
    r'(?:₹|\bRs\.?|\bINR\b|\bRUPEES\b)\s*(' + AMOUNT_BODY + r')'
    r'\s*(lakh|lac|lakhs|cr|crore|crores|k)?\b',
    re.I)
MULT = {'lakh':1e5,'lac':1e5,'lakhs':1e5,'cr':1e7,'crore':1e7,'crores':1e7,'k':1e3}

def parse_amounts(text):
    out = []
    for m in CURRENCY.finditer(text):
        v = float(m.group(1).replace(',', ''))
        if m.group(2):
            v *= MULT[m.group(2).lower()]
        out.append(round(v, 2))
    return out

# ---------------------------------------------------------------- accounts
ACCOUNT = re.compile(
    r'(?:a/?c|acct|account|card|ac)\b[^\dxX*]{0,12}(?:[xX*]{2,}|ending\s+(?:in\s+)?)?(\d{3,6})\b'
    r'|(?:[xX*]{4,})(\d{3,6})\b',
    re.I)

def parse_accounts(text):
    seen = []
    for m in ACCOUNT.finditer(text):
        v = m.group(1) or m.group(2)
        if v and v not in seen:
            seen.append(v)
    return seen

# ---------------------------------------------------------------- refs
RRN = re.compile(r'\b(\d{12})\b')
UPI_REF = re.compile(r'(?:upi|ref|rrn|txn|transaction|utr)[^\d]{0,15}(\d{9,18})\b', re.I)
# UPI handles have no dot in the domain; emails do. That single fact separates them.
VPA = re.compile(r'\b([a-z0-9][\w.\-]{1,30}@[a-z]{2,20})\b(?!\.[a-z])', re.I)
ORDER_ID = re.compile(r'\b(\d{3}-\d{7}-\d{7})\b|order\s*(?:id|no\.?|#)?\s*[:#]?\s*([A-Z0-9\-]{6,20})\b', re.I)

# ---------------------------------------------------------------- dates
MON = r'(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)'
DATE = re.compile(
    r'\b(\d{1,2}[-/](?:\d{1,2}|' + MON + r')[-/]\d{2,4})\b'      # 05-08-26, 05-Aug-2026
    r'|\b(\d{1,2}\s*' + MON + r'\s*\d{2,4})\b'                    # 05 Aug 26
    r'|\b(\d{1,2}(?:st|nd|rd|th)?\s+' + MON + r')\b',             # 15th Aug
    re.I)
TIME = re.compile(r'\b(\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|hrs)?)\b', re.I)

# ---------------------------------------------------------------- OTP gate
OTP_MARK = re.compile(
    r'\b(?:otp|o\.t\.p|one[\s\-]?time\s+p(?:ass)?wo?r?d?|verification\s+code|'
    r'security\s+code|auth(?:entication)?\s+code|login\s+code)\b', re.I)
OTP_VAL = re.compile(r'\b(\d{4,8})\b')
DO_NOT_SHARE = re.compile(r"(?:do\s*not|never|don'?t)\s+share", re.I)
DELIVERY_CTX = re.compile(r'\b(?:deliver|delivery|courier|parcel|shipment|rider|agent|collect)\w*\b', re.I)

def otp_check(text):
    m = OTP_MARK.search(text)
    if not m:
        return None
    lo, hi = max(0, m.start() - 60), min(len(text), m.end() + 60)
    v = OTP_VAL.search(text, lo, hi)
    if not v:
        return None
    kind = 'DELIVERY' if DELIVERY_CTX.search(text) else 'AUTH'
    return {'code_len': len(v.group(1)), 'kind': kind,
            'confirmed': bool(DO_NOT_SHARE.search(text))}

# ---------------------------------------------------------------- normalise
ZW = dict.fromkeys(map(ord, '\u200b\u200c\u200d\u200e\u200f\u2060\ufeff\u00ad'), None)

def normalise(text):
    t = unicodedata.normalize('NFKC', text).translate(ZW)
    t = re.sub(r'\b(?:Rs\.?|INR|RUPEES)\s*', '₹', t, flags=re.I)
    return re.sub(r'[ \t]+', ' ', t).strip()

# ---------------------------------------------------------------- fingerprint
URL = re.compile(r'https?://\S+|\b(?:bit\.ly|tinyurl\.com)/\S+', re.I)

def fingerprint(text):
    """Mask every variable slot, leaving the template skeleton."""
    t = normalise(text)
    t = URL.sub(' <URL> ', t)
    t = CURRENCY.sub(' <AMT> ', t)
    t = ACCOUNT.sub(' <ACCT> ', t)
    t = VPA.sub(' <VPA> ', t)
    t = DATE.sub(' <DATE> ', t)
    t = TIME.sub(' <TIME> ', t)
    t = re.sub(r'\b\d[\d,\.]{2,}\b', ' <NUM> ', t)     # long digit runs
    t = re.sub(r'\b\d+\b', ' <N> ', t)                  # short digit runs
    t = re.sub(r'[^A-Za-z<>\s]', ' ', t)                # punctuation drops out
    t = re.sub(r'\s+', ' ', t).strip().upper()
    return t, hashlib.sha256(t.encode()).hexdigest()[:16]


# ================================================================== CORPUS
CORPUS = [
    # (sender, body, expected_amounts, expected_accts, note)
    ("AD-HDFCBK-S",
     "Rs.2,340.00 debited from A/c XX4471 on 05-Aug-26 to TSSPDCL. Avl Bal Rs.48,221.19. Not you? Call 18002586161",
     [2340.0, 48221.19], ["4471"], "classic debit + balance"),

    ("VM-ICICIB",
     "INR 1,23,456.78 credited to your Account XXXXX8891 on 01-08-2026. Info: SALARY-AUG. Avl Bal INR 2,04,110.50",
     [123456.78, 204110.50], ["8891"], "LAKH GROUPING - the one naive regex breaks on"),

    ("JD-SBIINB-T",
     "Dear Customer, Rs 2,340 debited from A/c no. XXXXXXXX1234 on 05-08-26 and credited to swiggy@ybl (UPI Ref no 408772934112)",
     [2340.0], ["1234"], "comma-thousand + VPA + 12-digit RRN"),

    ("BP-AXISBK-S",
     "Alert: You've spent Rs 1299 on AXIS BANK Credit Card ending 9012 at AMAZON on 03-Aug-26.",
     [1299.0], ["9012"], "no comma, 'ending' form"),

    ("AX-KOTAKB",
     "Payment of Rs 2.5 Lakh received towards Loan A/c 445566. Outstanding Rs 12,45,000",
     [250000.0, 1245000.0], ["445566"], "lakh multiplier + 7-digit grouping"),

    ("TX-TSSPDC",
     "Your electricity bill for consumer no 1234567 is Rs.2,340 due on 15-Aug-2026. Pay at https://tgsouthernpower.org",
     [2340.0], [], "utility bill, consumer no is NOT an account"),

    ("VK-HDFCBK",
     "OTP for your transaction of Rs.4,999 at FLIPKART is 483920. Do not share this OTP with anyone. Valid 10 mins.",
     [4999.0], [], "AUTH OTP - must be gated and purged"),

    ("JM-AMAZON",
     "Your Amazon delivery OTP is 4821. Share with the delivery agent to collect order 408-7729341-8823910.",
     [], [], "DELIVERY OTP - keep, attach to order"),

    ("AD-SBICRD-S",
     "Your SBI Card statement is generated. Total Amt Due Rs.24,900.00, Min Amt Due Rs.1,245.00, Due Date 18/08/2026",
     [24900.0, 1245.0], [], "statement, two amounts, slash date"),

    ("+919876543210",
     "Anna, meeting ki 5:30 pm ki వస్తున్నాను. Call me back when free.",
     [], [], "person, Telugu script + Hinglish, no amounts"),

    ("BZ-SWIGGY",
     "FLAT 60% OFF! Use code EAT60. Order now on Swiggy. T&C apply.",
     [], [], "promo, no money entity despite '60'"),

    ("AD-HDFCBK-S",
     "Rs.2,340.00 debited from A/c XX4471 on 07-Aug-26 to BIGBASKET. Avl Bal Rs.45,881.19. Not you? Call 18002586161",
     [2340.0, 45881.19], ["4471"], "SAME TEMPLATE as #1 - fingerprints must match"),
]


def run():
    fails = 0
    fps = {}
    print("=" * 78)
    for sender, body, exp_amt, exp_acct, note in CORPUS:
        hdr, cat, kind = norm_sender(sender)
        amts = parse_amounts(body)
        accts = parse_accounts(body)
        otp = otp_check(body)
        skel, fp = fingerprint(body)
        fps.setdefault(fp, []).append(note)

        ok_a = amts == exp_amt
        ok_b = accts == exp_acct
        if not (ok_a and ok_b):
            fails += 1

        print(f"{'PASS' if ok_a and ok_b else 'FAIL'}  {sender:<16} [{kind}] hdr={hdr} cat={cat}")
        print(f"      note     : {note}")
        print(f"      amounts  : {amts}{'' if ok_a else f'   EXPECTED {exp_amt}'}")
        print(f"      accounts : {accts}{'' if ok_b else f'   EXPECTED {exp_acct}'}")
        if otp:
            print(f"      OTP      : {otp}")
        print(f"      fp       : {fp}  {skel[:72]}")
        print("-" * 78)

    dupes = {k: v for k, v in fps.items() if len(v) > 1}
    print(f"\nTemplate collapse: {len(CORPUS)} messages -> {len(fps)} fingerprints")
    for k, v in dupes.items():
        print(f"  {k} shared by {len(v)}: {v}")
    print(f"\n{'ALL PASS' if fails == 0 else f'{fails} FAILURES'}")
    return fails


if __name__ == '__main__':
    raise SystemExit(run())
