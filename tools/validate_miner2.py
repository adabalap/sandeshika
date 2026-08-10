#!/usr/bin/env python3
"""Template mining v2 -- variable-LENGTH slots.

v1 clustered on token count, so "TO SWIGGY" and "TO UBER INDIA" landed in
different clusters and the same bank template was learned twice.

Merchant names, payee names and city names are all variable length, so token
count cannot be part of the cluster key. Align instead: bucket on sender plus
a short leading prefix, then compare candidates by sequence similarity and
merge by aligning them, collapsing each differing span to one <VAR>.
"""
import re, hashlib, unicodedata
from difflib import SequenceMatcher

AMOUNT_BODY = r'(?:\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)'
CURRENCY = re.compile(r'(?:₹|\bRs\.?|\bINR\b)\s*(' + AMOUNT_BODY + r')\s*(lakh|lac|cr|crore)?\b', re.I)
ACCOUNT  = re.compile(r'(?:a/?c|acct|account|card|ac)\b[^\dxX*]{0,12}(?:[xX*]{2,}|ending\s+(?:in\s+)?)?(\d{3,6})\b|(?:[xX*]{4,})(\d{3,6})\b', re.I)
MON  = r'(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)'
DATE = re.compile(r'\b\d{1,2}[-/](?:\d{1,2}|' + MON + r')[-/]\d{2,4}\b|\b\d{1,2}\s*' + MON + r'\s*\d{2,4}\b', re.I)
TIME = re.compile(r'\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|hrs)?\b', re.I)
VPA  = re.compile(r'\b[a-z0-9][\w.\-]{1,30}@[a-z]{2,20}\b(?!\.[a-z])', re.I)
URL  = re.compile(r'https?://\S+', re.I)
ZW   = dict.fromkeys(map(ord, '\u200b\u200c\u200d\u200e\u200f\u2060\ufeff\u00ad'), None)

PREFIX_LEN  = 3      # bucket on this many leading skeleton tokens
MERGE_RATIO = 0.62   # below this, it is a genuinely different template
VAR = '<VAR>'


def strict_skeleton(text):
    t = unicodedata.normalize('NFKC', text).translate(ZW)
    t = URL.sub(' <URL> ', t)
    t = CURRENCY.sub(' <AMT> ', t)      # before generic digits, or 2,340 splits
    t = ACCOUNT.sub(' <ACCT> ', t)
    t = VPA.sub(' <VPA> ', t)
    t = DATE.sub(' <DATE> ', t)
    t = TIME.sub(' <TIME> ', t)
    t = re.sub(r'\b\d[\d,\.]{2,}\b', ' <NUM> ', t)
    t = re.sub(r'\b\d+\b', ' <N> ', t)
    t = re.sub(r'[^\w<>\s]', ' ', t, flags=re.UNICODE)
    return re.sub(r'\s+', ' ', t).strip().upper()


def collapse_vars(toks):
    """Consecutive <VAR> tokens are one slot, not several."""
    out = []
    for t in toks:
        if t == VAR and out and out[-1] == VAR:
            continue
        out.append(t)
    return out


def align(a, b):
    """Merge two token lists; every differing span becomes a single <VAR>."""
    out = []
    for op, i1, i2, j1, j2 in SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if op == 'equal':
            out.extend(a[i1:i2])
        else:
            out.append(VAR)
    return collapse_vars(out)


def fp(skel):
    return hashlib.sha256(skel.encode()).hexdigest()[:16]


class TemplateMiner:
    def __init__(self):
        self.buckets = {}   # (sender, prefix) -> list of {'tokens','count'}

    def add(self, sender, text):
        toks = strict_skeleton(text).split()
        key = (sender, tuple(toks[:PREFIX_LEN]))
        bucket = self.buckets.setdefault(key, [])

        best, best_r = None, 0.0
        for tpl in bucket:
            r = SequenceMatcher(None, tpl['tokens'], toks, autojunk=False).ratio()
            if r > best_r:
                best, best_r = tpl, r

        if best is not None and best_r >= MERGE_RATIO:
            merged = align(best['tokens'], toks)
            status = 'MATCHED' if merged == best['tokens'] else 'REFINED'
            best['tokens'] = merged
            best['count'] += 1
            return self._view(best), status

        tpl = {'tokens': toks, 'count': 1}
        bucket.append(tpl)
        return self._view(tpl), 'NEW'

    @staticmethod
    def _view(tpl):
        skel = ' '.join(tpl['tokens'])
        return {'fp': fp(skel), 'skeleton': skel, 'count': tpl['count'],
                'slots': [i for i, t in enumerate(tpl['tokens']) if t == VAR]}

    def all(self):
        return [self._view(t) for b in self.buckets.values() for t in b]


STREAM = [
    ("HDFCBK", "Rs.2,340.00 debited from A/c XX4471 on 05-Aug-26 to TSSPDCL. Avl Bal Rs.48,221.19. Not you? Call 18002586161"),
    ("HDFCBK", "Rs.2,340.00 debited from A/c XX4471 on 07-Aug-26 to BIGBASKET. Avl Bal Rs.45,881.19. Not you? Call 18002586161"),
    ("HDFCBK", "Rs.899.00 debited from A/c XX4471 on 08-Aug-26 to SWIGGY. Avl Bal Rs.44,982.19. Not you? Call 18002586161"),
    ("HDFCBK", "Rs.150.00 debited from A/c XX9911 on 08-Aug-26 to UBER INDIA. Avl Bal Rs.12,000.00. Not you? Call 18002586161"),
    ("HDFCBK", "Rs.4,100.00 debited from A/c XX4471 on 09-Aug-26 to RELIANCE SMART POINT HYDERABAD. Avl Bal Rs.8,900.00. Not you? Call 18002586161"),
    ("HDFCBK", "Your HDFC Bank Credit Card ending 9012 statement is generated. Total Due Rs.24,900.00 by 18/08/2026"),
    ("ICICIB", "INR 1,23,456.78 credited to your Account XXXXX8891 on 01-08-2026. Info: SALARY-AUG. Avl Bal INR 2,04,110.50"),
    ("ICICIB", "INR 98,000.00 credited to your Account XXXXX8891 on 01-09-2026. Info: SALARY-SEP. Avl Bal INR 2,88,110.50"),
]


def run():
    m = TemplateMiner()
    print("=" * 78)
    for sender, body in STREAM:
        t, status = m.add(sender, body)
        print(f"{status:<8} {sender:<8} fp={t['fp']} n={t['count']}")
        print(f"         {t['skeleton'][:104]}")
    print("=" * 78)

    tpls = m.all()
    print(f"\n{len(STREAM)} messages -> {len(tpls)} templates\n")
    for t in sorted(tpls, key=lambda x: -x['count']):
        print(f"  {t['fp']}  n={t['count']:<2} slots@{t['slots']}")
        print(f"     {t['skeleton'][:110]}")

    fails = []
    debit = [t for t in tpls if 'DEBITED' in t['skeleton']]
    if len(debit) != 1:
        fails.append(f"expected 1 debit template, got {len(debit)}")
    elif debit[0]['count'] != 5:
        fails.append(f"debit template should absorb all 5 debits, got {debit[0]['count']}")
    elif len(debit[0]['slots']) != 1:
        fails.append(f"expected exactly 1 merchant slot, got {debit[0]['slots']}")
    if len(tpls) != 3:
        fails.append(f"expected 3 templates (debit / statement / credit), got {len(tpls)}")

    print()
    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("ALL PASS - variable-length merchant slot learned from data alone")
    return 0


if __name__ == '__main__':
    raise SystemExit(run())
