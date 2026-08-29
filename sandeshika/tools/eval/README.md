# Corpus evaluation harness

Runs the real classifier over a real inbox export and reports what it misses.

## Why it exists

Rules written from imagination fail in ways that are invisible without
measurement. Two examples from this project: promotional terms that produced
**zero** promotions across 500 real messages, and a spam rule that caught
exactly **one** message in 24,040. Both looked reasonable in review.

## Using it

1. In the app: **Export shapes** → tick *Include all categories* → **Share CSV**
2. Rehydrate the redacted shapes into plausible text and run the classifier:

```
python3 rehydrate.py sandeshika-shapes.csv > corpus.tsv
kotlinc <core sources> Eval.kt -include-runtime -d eval.jar && java -jar eval.jar
```

Rehydration substitutes plausible values back into the placeholders —
`<N3>` becomes `555`, `<DATE>` becomes a date. The values are irrelevant to
the rules, which only care that an amount or a date is *present*, so this
gives a faithful measurement without any real data being involved.
