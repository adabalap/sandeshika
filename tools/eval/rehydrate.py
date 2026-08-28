#!/usr/bin/env python3
"""Turns a redacted shapes CSV back into plausible message text for evaluation."""
import csv, re, sys

def rehydrate(s):
    s = re.sub(r'<N(\d+)\.DD>', lambda m: '5' * min(int(m.group(1)), 6) + '.00', s)
    s = re.sub(r'<N(\d+)>', lambda m: '5' * min(int(m.group(1)), 6), s)
    for a, b in [('<DATE>', '01/01/25'), ('<TIME>', '10:30'), ('<ACCT*>', '*5261'),
                 ('<ACCTX>', 'XX5261'), ('<ACCT.>', '...5261'), ('<PHONE>', '9876543210'),
                 ('<URL>', 'http://x.co/a'), ('<NAME>', 'Ramesh Kumar'), ('<VPA>', 'ram@okhdfc'),
                 ('<EMAIL>', 'a@b.com'), ('<PAN>', 'ABCDE1234F'), ('<CARD>', '4111 1111 1111 1111'),
                 ('<AADHAAR>', '1234 5678 9012'), ('<VEHICLE>', 'MH12AB1234'),
                 ('<REDACTED>', 'thing'), ('<REF>', 'AB12CD34')]:
        s = s.replace(a, b)
    return s.replace('\t', ' ').replace('\n', ' ').replace('\r', ' ')

for r in csv.DictReader(open(sys.argv[1], encoding='utf-8')):
    print(f"{r['count']}\t{r['sender']}\t{rehydrate(r['shape'])}")
