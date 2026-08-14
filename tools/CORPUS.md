# Sending me your 25k corpus

Three commands. Everything runs offline; nothing is uploaded.

```bash
python3 tools/corpus.py redact sms.xml -o corpus.jsonl   # 1. strip PII
python3 tools/corpus.py mine   corpus.jsonl              # 2. see the templates
python3 tools/corpus.py audit  corpus.jsonl              # 3. see what breaks
```

Send me `corpus.jsonl`, or just the output of steps 2 and 3 if you'd rather
send nothing at all — the audit alone tells me most of what I need.

Accepts `.xml` (SMS Backup & Restore), `.csv`, `.jsonl`, `.txt`.

## Why not train a model

For a spending app the extraction step has to be **exact**. A model that reads
an amount or a date correctly 98% of the time is worse than useless here,
because the 2% is silent: a wrong rupee figure looks identical to a right one,
and nothing in the UI can tell you which is which.

Bank SMS are machine-generated from a small number of templates. On a synthetic
25k corpus, **12 templates covered 93% of the inbox**. So the useful thing to
learn from your data is not weights — it's *the template list*.

`mine` derives it: every message is normalised to its shape, clustered, and
ranked by volume. The output is a work list ordered by how many messages each
fix is worth. The parser stays deterministic; its rules just come from your
inbox instead of my guesses.

## Dates are shifted, not blanked

The first version of the redactor replaced every date with `99/99/99` — and
destroyed exactly the signal needed to debug a date bug. Dates are now moved by
one constant random offset per run, so:

- the **format** survives (`10/08/26`, `02-Jul-26`, `Feb 24, 2025`)
- ordering, gaps between transactions and day-of-week patterns survive
- the actual calendar dates are wrong, and the offset is discarded on exit

That is all the privacy a transaction date needs, and it keeps the file useful.
`--blank-dates` restores the old behaviour if you prefer.

## What the audit tells you

```
corpus: 25000 messages
  parsed as transactions : 15274 (61%)

dates:
  used the SMS arrival time : 2968
  ...though the text HAD a date : 0        <- these would be wrong

unhandled templates (12 shapes):
     184  [no-direction]  Your last payment attempt of Rs. 999.99 on Mar 15, 2024 ...
```

The line that matters is **"though the text HAD a date"**. Those are messages
where the SMS states a date and the parser ignored it, filing the transaction
under the day it happened to arrive. It reads as "my spending is on the wrong
days" and it is invisible without this check.

Running it on the synthetic corpus found 12,306 such messages: **month-name-first
dates (`Feb 24, 2025`) were never matched.** Fixed, and now covered by nine
format tests plus an end-to-end case.

## Privacy

`redact` refuses nothing, but `mine` and `audit` refuse to run on a file that
still contains PII patterns, so a raw export cannot be processed by accident.

Regex cannot recognise every name. Skim `corpus.jsonl` before sending —
`python3 tools/redact.py --verify corpus.jsonl` lists anything mechanical that
survived.
