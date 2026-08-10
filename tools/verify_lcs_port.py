"""Verify the LCS-based align() in TemplateMiner.kt behaves like the
difflib version that was validated. Same corpus, same assertions."""
import sys
sys.path.insert(0, '.')
from validate_miner2 import strict_skeleton, STREAM, VAR, fp, PREFIX_LEN, MERGE_RATIO

def lcs_table(a, b):
    t = [[0]*(len(b)+1) for _ in range(len(a)+1)]
    for i in range(len(a)-1, -1, -1):
        for j in range(len(b)-1, -1, -1):
            t[i][j] = 1+t[i+1][j+1] if a[i]==b[j] else max(t[i+1][j], t[i][j+1])
    return t

def similarity(a, b):
    if not a and not b: return 1.0
    if not a or not b: return 0.0
    return 2.0*lcs_table(a,b)[0][0]/(len(a)+len(b))

def align(a, b):
    out, i, j = [], 0, 0
    t = lcs_table(a, b)
    def push_var():
        if not out or out[-1] != VAR: out.append(VAR)
    while i < len(a) and j < len(b):
        if a[i] == b[j]:
            out.append(a[i]); i += 1; j += 1
        else:
            push_var()
            if t[i+1][j] >= t[i][j+1]: i += 1
            else: j += 1
    if i < len(a) or j < len(b): push_var()
    return out

class Miner:
    def __init__(self): self.buckets = {}
    def add(self, sender, text):
        toks = strict_skeleton(text).split()
        key = sender + "|" + " ".join(toks[:PREFIX_LEN])
        bucket = self.buckets.setdefault(key, [])
        best, best_r = None, 0.0
        for c in bucket:
            r = similarity(c['tokens'], toks)
            if r > best_r: best, best_r = c, r
        if best and best_r >= MERGE_RATIO:
            merged = align(best['tokens'], toks)
            status = 'MATCHED' if merged == best['tokens'] else 'REFINED'
            best['tokens'], best['count'] = merged, best['count']+1
            return best, status
        c = {'tokens': toks, 'count': 1}
        bucket.append(c)
        return c, 'NEW'
    def all(self): return [c for b in self.buckets.values() for c in b]

m = Miner()
print("="*78)
for sender, body in STREAM:
    c, st = m.add(sender, body)
    print(f"{st:<8} {sender:<8} n={c['count']}  {' '.join(c['tokens'])[:88]}")
print("="*78)
tpls = m.all()
print(f"\n{len(STREAM)} messages -> {len(tpls)} templates\n")
for c in sorted(tpls, key=lambda x: -x['count']):
    skel = ' '.join(c['tokens'])
    slots = [i for i,t in enumerate(c['tokens']) if t == VAR]
    print(f"  {fp(skel)}  n={c['count']:<2} slots@{slots}")
    print(f"     {skel[:110]}")

fails = []
debit = [c for c in tpls if 'DEBITED' in ' '.join(c['tokens'])]
if len(debit) != 1: fails.append(f"expected 1 debit template, got {len(debit)}")
elif debit[0]['count'] != 5: fails.append(f"debit should absorb 5, got {debit[0]['count']}")
elif [i for i,t in enumerate(debit[0]['tokens']) if t==VAR] != [7]:
    fails.append(f"expected merchant slot at index 7, got {[i for i,t in enumerate(debit[0]['tokens']) if t==VAR]}")
if len(tpls) != 3: fails.append(f"expected 3 templates, got {len(tpls)}")
print()
for f in fails: print("FAIL:", f)
print("ALL PASS - LCS port matches the difflib-validated behaviour" if not fails else "PORT DIVERGES")
sys.exit(1 if fails else 0)
