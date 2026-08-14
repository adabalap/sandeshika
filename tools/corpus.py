#!/usr/bin/env python3
"""
corpus.py — turn a raw SMS export into something safe to share and useful to fix.

Three subcommands, meant to be run in order:

    python3 tools/corpus.py redact sms.xml   -o corpus.jsonl   # strip PII
    python3 tools/corpus.py mine   corpus.jsonl                # find templates
    python3 tools/corpus.py audit  corpus.jsonl                # what breaks

Everything runs offline. Nothing is uploaded. `redact` must run first; `mine`
and `audit` refuse to touch a file that still looks unredacted.

WHY MINE TEMPLATES INSTEAD OF TRAINING A MODEL

For a spending app the extraction step must be exact. A neural model that gets
an amount or a date right 98% of the time is worse than useless here, because
the 2% is silent: a wrong rupee figure looks exactly like a right one, and you
cannot tell which is which without re-reading the SMS.

Bank SMS are machine-generated from a small number of templates. Roughly a
hundred shapes cover almost everything. So the useful thing to learn from 25k
messages is not weights — it is *the template list*. This tool derives it:
normalise every message to its shape, cluster, rank by volume, and show what
the parser currently does with each cluster.

The result is still a deterministic parser. It is just one whose rules were
learned from your inbox rather than guessed by me.
"""

import argparse
import json
import os
import re
import sys
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

try:
    import redact as R
except ImportError:
    print("redact.py must sit next to corpus.py", file=sys.stderr)
    raise


# ---------------------------------------------------------------------------
# Readers. Whatever your backup app produced, get to (address, body, date).
# ---------------------------------------------------------------------------
def read_xml(path):
    """SMS Backup & Restore format."""
    import xml.etree.ElementTree as ET
    for _, el in ET.iterparse(path, events=("end",)):
        if el.tag == "sms":
            yield {
                "address": el.get("address") or "",
                "body": el.get("body") or "",
                "date": int(el.get("date") or 0),
            }
            el.clear()


def read_csv(path):
    import csv
    with open(path, newline="", encoding="utf-8", errors="replace") as f:
        for row in csv.DictReader(f):
            low = {k.lower().strip(): v for k, v in row.items() if k}
            yield {
                "address": low.get("address") or low.get("from") or low.get("sender") or "",
                "body": low.get("body") or low.get("message") or low.get("text") or "",
                "date": int(low.get("date") or low.get("timestamp") or 0 or 0),
            }


def read_jsonl(path):
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if line:
                yield json.loads(line)


def read_txt(path):
    """Plain text: blank-line separated blocks, optional 'SENDER ::' prefix."""
    block, sender = [], ""
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if line.strip():
                m = re.match(r"^([A-Z]{2}-[A-Z0-9\-]+)\s*(?:::|\|)?\s*(.*)$", line.strip())
                if m and not block:
                    sender = m.group(1)
                    if m.group(2):
                        block.append(m.group(2))
                else:
                    block.append(line.rstrip("\n"))
            elif block:
                yield {"address": sender, "body": "\n".join(block), "date": 0}
                block, sender = [], ""
    if block:
        yield {"address": sender, "body": "\n".join(block), "date": 0}


READERS = {".xml": read_xml, ".csv": read_csv, ".jsonl": read_jsonl,
           ".json": read_jsonl, ".txt": read_txt}


def load(path):
    ext = os.path.splitext(path)[1].lower()
    reader = READERS.get(ext)
    if not reader:
        print(f"Unsupported file type '{ext}'. Use .xml, .csv, .jsonl or .txt",
              file=sys.stderr)
        sys.exit(2)
    return reader(path)


# ---------------------------------------------------------------------------
# Shape: what a message looks like with every value removed.
#
# This is the clustering key. Two messages from the same bank template collapse
# to an identical shape even though every number and name differs.
# ---------------------------------------------------------------------------
SHAPE_RULES = [
    (re.compile(r"\d+[.,]\d{2}"), "<AMT>"),
    (re.compile(r"\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}"), "<DATE>"),
    (re.compile(r"\d{1,2}[\s\-/]?[A-Za-z]{3}[\s\-/]?\d{2,4}"), "<DATE>"),
    (re.compile(r"\d{1,2}:\d{2}(:\d{2})?"), "<TIME>"),
    (re.compile(r"\b[Xx*]{1,4}\d{3,6}\b"), "<ACCT>"),
    (re.compile(r"\b\d{6,}\b"), "<REF>"),
    (re.compile(r"\b\d+\b"), "<N>"),
    (re.compile(r"\bPERSON_[0-9a-f]+\b"), "<NAME>"),
    (re.compile(r"\bVPA_[0-9a-f]+\b"), "<VPA>"),
    (re.compile(r"https?://\S+|REDACTED\.LINK\S*"), "<URL>"),
    (re.compile(r"\s+"), " "),
]


def shape(body: str) -> str:
    t = body
    for pat, rep in SHAPE_RULES:
        t = pat.sub(rep, t)
    return t.strip()[:220]


def looks_unredacted(rows, sample=400):
    """Refuse to process a file that still contains obvious PII."""
    hits = Counter()
    for i, r in enumerate(rows[:sample]):
        for name, pat in R.LEAKS:
            for m in re.finditer(pat, r.get("body", "")):
                if not R.is_placeholder(m.group()):
                    hits[name] += 1
    return hits


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_redact(args):
    if args.salt:
        R.SALT = args.salt
    rows, kept, skipped = [], 0, 0
    for r in load(args.file):
        body = (r.get("body") or "").strip()
        if not body:
            skipped += 1
            continue
        rows.append({
            "address": R.normaliseSender(r.get("address", "")) if hasattr(R, "normaliseSender")
                       else re.sub(r"^[A-Z]{2}[-\s]", "", (r.get("address") or "").upper()),
            "body": R.redact(body),
            "date": r.get("date", 0),
        })
        kept += 1

    out = open(args.out, "w", encoding="utf-8") if args.out else sys.stdout
    for r in rows:
        out.write(json.dumps(r, ensure_ascii=False) + "\n")
    if args.out:
        out.close()

    leaks = looks_unredacted(rows, sample=len(rows))
    print(f"\n  {kept} messages redacted, {skipped} empty skipped", file=sys.stderr)
    for k, v in sorted(R.COUNTS.items(), key=lambda kv: -kv[1])[:12]:
        print(f"    {v:6d}  {k}", file=sys.stderr)
    if leaks:
        print("\n  POSSIBLE LEAKS REMAINING:", file=sys.stderr)
        for k, v in leaks.items():
            print(f"    {v:6d}  {k}", file=sys.stderr)
        print("  Review before sharing.", file=sys.stderr)
    else:
        print("\n  No PII patterns remain. Skim the output anyway — regex "
              "cannot catch every name.", file=sys.stderr)


def cmd_mine(args):
    rows = list(read_jsonl(args.file))
    leaks = looks_unredacted(rows)
    if leaks and not args.force:
        print(f"Refusing: this file still contains {sum(leaks.values())} PII matches "
              f"({', '.join(leaks)}). Run `redact` first, or pass --force.", file=sys.stderr)
        sys.exit(1)

    clusters = defaultdict(lambda: {"n": 0, "senders": Counter(), "example": None})
    for r in rows:
        sh = shape(r["body"])
        c = clusters[sh]
        c["n"] += 1
        c["senders"][r.get("address", "?")] += 1
        if c["example"] is None:
            c["example"] = r

    ranked = sorted(clusters.items(), key=lambda kv: -kv[1]["n"])
    total = len(rows)
    covered = 0

    print(f"{total} messages -> {len(clusters)} distinct templates\n")
    print(f"{'#':>4} {'count':>6} {'cum%':>6}  template")
    print("-" * 100)
    for i, (sh, c) in enumerate(ranked[:args.top], 1):
        covered += c["n"]
        print(f"{i:>4} {c['n']:>6} {covered * 100 // total:>5}%  {sh[:88]}")

    tail = sum(c["n"] for _, c in ranked[args.top:])
    print("-" * 100)
    print(f"top {min(args.top, len(ranked))} templates cover "
          f"{covered * 100 // total}% of the inbox; {tail} messages in the long tail")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump([{
                "shape": sh, "count": c["n"],
                "senders": c["senders"].most_common(5),
                "example": c["example"]["body"],
            } for sh, c in ranked], f, indent=2, ensure_ascii=False)
        print(f"\nwrote {args.out}")


def load_parser():
    """Runs the real parser.js under Node so the audit matches the app exactly."""
    import subprocess, tempfile
    js = os.path.join(os.path.dirname(HERE), "static", "js", "parser.js")
    if not os.path.exists(js):
        js = os.path.join(os.path.dirname(HERE), "app", "src", "main", "assets",
                          "web", "js", "parser.js")
    if not os.path.exists(js):
        print("Cannot find parser.js", file=sys.stderr)
        sys.exit(2)
    return js


def cmd_audit(args):
    """
    Runs the real parser over the corpus and reports what it does — including
    the dates, which is the whole point: a date that is silently wrong looks
    identical to one that is right.
    """
    import subprocess
    rows = list(read_jsonl(args.file))
    leaks = looks_unredacted(rows)
    if leaks and not args.force:
        print(f"Refusing: run `redact` first ({sum(leaks.values())} PII matches).",
              file=sys.stderr)
        sys.exit(1)

    js = load_parser()
    script = r"""
const fs = require('fs');
global.window = global;
new Function(fs.readFileSync(process.argv[2], 'utf8')).call(global);
const P = global.SandeshikaParser;
const rows = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = [];
for (const r of rows) {
  const res = P.parse({ id: 0, body: r.body, date: r.date || Date.now(), address: r.address });
  // The date the message CLAIMS, pulled out separately, so a mismatch between
  // the written date and the parsed one is visible rather than assumed away.
  const claimed = (r.body.match(/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/) ||
                   r.body.match(/\b\d{1,2}[\s\-\/]?[A-Za-z]{3}[a-z]*[\s\-\/]?\d{2,4}\b/) || [null])[0];
  out.push({
    ok: res.ok,
    reason: res.ok ? null : res.reason,
    amount: res.ok ? res.txn.amount : null,
    kind: res.ok ? res.txn.kind : null,
    merchant: res.ok ? res.txn.merchant : null,
    parsedDate: res.ok ? new Date(res.txn.date).toISOString().slice(0, 10) : null,
    usedFallbackDate: res.ok ? (res.txn.date === (r.date || 0)) : null,
    claimedDate: claimed,
    address: r.address,
    body: r.body,
  });
}
process.stdout.write(JSON.stringify(out));
"""
    with open("/tmp/_audit.js", "w") as f:
        f.write(script)
    with open("/tmp/_rows.json", "w") as f:
        json.dump(rows, f)
    res = subprocess.run(["node", "/tmp/_audit.js", js, "/tmp/_rows.json"],
                         capture_output=True, text=True)
    if res.returncode != 0:
        print(res.stderr[:2000], file=sys.stderr)
        sys.exit(1)
    parsed = json.loads(res.stdout)

    total = len(parsed)
    okc = sum(1 for p in parsed if p["ok"])
    reasons = Counter(p["reason"] for p in parsed if not p["ok"])
    fallback = sum(1 for p in parsed if p["ok"] and p["usedFallbackDate"])
    claimed_but_fallback = [p for p in parsed
                            if p["ok"] and p["usedFallbackDate"] and p["claimedDate"]]

    print(f"corpus: {total} messages")
    print(f"  parsed as transactions : {okc} ({okc * 100 // max(total,1)}%)")
    print(f"  rejected               : {total - okc}")
    print("\nrejection reasons:")
    for r, n in reasons.most_common(15):
        flag = "" if r in ("otp", "promo", "reminder", "balance", "limit", "notice",
                           "status", "mandate", "payee", "returned", "failed",
                           "request", "emandate", "hold") else "   <- worth reviewing"
        print(f"  {n:6d}  {r}{flag}")

    print(f"\ndates:")
    print(f"  used the SMS arrival time : {fallback}")
    print(f"  ...though the text HAD a date : {len(claimed_but_fallback)}   <- these are wrong")
    if claimed_but_fallback:
        print("\n  examples where a written date was ignored:")
        seen = set()
        for p in claimed_but_fallback:
            key = shape(p["body"])[:60]
            if key in seen:
                continue
            seen.add(key)
            print(f"    claimed {p['claimedDate']!r} -> parsed {p['parsedDate']}")
            print(f"      {p['body'][:100].replace(chr(10), ' | ')}")
            if len(seen) >= 8:
                break

    # unparsed messages from bank senders, grouped by shape: the real work list
    misses = defaultdict(lambda: {"n": 0, "ex": None, "reason": None})
    for p in parsed:
        if p["ok"]:
            continue
        if p["reason"] in ("otp", "promo", "notice", "status", "balance", "limit",
                           "mandate", "payee", "returned", "failed", "request",
                           "emandate", "hold", "reminder"):
            continue
        sh = shape(p["body"])
        m = misses[sh]
        m["n"] += 1
        m["reason"] = p["reason"]
        if m["ex"] is None:
            m["ex"] = p["body"]

    if misses:
        print(f"\nunhandled templates ({len(misses)} shapes):")
        for sh, m in sorted(misses.items(), key=lambda kv: -kv[1]["n"])[:20]:
            print(f"  {m['n']:6d}  [{m['reason']}]  {m['ex'][:90].replace(chr(10), ' | ')}")

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(parsed, f, indent=2, ensure_ascii=False)
        print(f"\nwrote {args.out}")


def main():
    ap = argparse.ArgumentParser(description="Redact, mine and audit an SMS corpus")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("redact", help="strip PII from a raw export")
    r.add_argument("file")
    r.add_argument("-o", "--out", help="output .jsonl (default stdout)")
    r.add_argument("--salt", help="fixed salt for reproducible pseudonyms")
    r.set_defaults(fn=cmd_redact)

    m = sub.add_parser("mine", help="cluster into templates by volume")
    m.add_argument("file")
    m.add_argument("--top", type=int, default=60)
    m.add_argument("-o", "--out")
    m.add_argument("--force", action="store_true")
    m.set_defaults(fn=cmd_mine)

    a = sub.add_parser("audit", help="run the real parser and report what breaks")
    a.add_argument("file")
    a.add_argument("-o", "--out")
    a.add_argument("--force", action="store_true")
    a.set_defaults(fn=cmd_audit)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
