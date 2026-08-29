# Sandeshika · సందేశిక

An SMS organizer for Indian inboxes, answering questions about your own
messages using a model that runs on your phone. It talks to
[Medha](../medha) over its local HTTP API and never sends a message anywhere.

## Status

Early. One vertical slice at a time, production-grade from the start rather
than prototyped and hardened later.

| Slice | State |
|---|---|
| Rule classifier (core logic) | **50 assertions passing** · 16.5% uncategorised on a real 20,261-message inbox |
| Redaction / corpus export | **42 assertions passing** |
| Local linear model | **built · 21 assertions passing** |
| Corrections (storage + override + UI) | **built** |
| Active learning (review queue) | **built · 12 assertions passing** |
| SMS reading | not started |
| Compose inbox UI | not started |
| Medha integration | not started (will use the consent handshake) |

## Layout

```
core/classify/   pure Kotlin, no Android — testable on a bare JVM
app/             Compose UI, SMS access, Room
```

The split is deliberate. Everything where a bug is *silent* — misreading an
amount, misfiling a message — lives in `core/`, which needs no emulator to
test. `./gradlew :core:classify:test` runs in seconds and is the check that
actually matters.

## How intelligence works here

Three layers, in order. Each one only sees what the layer above could not
settle.

| Layer | Handles | Runs |
|---|---|---|
| **Rules** | Anything structurally certain: sender shape, rupee amounts, OTP codes, dates | Instantly, explainably |
| **Local linear model** | Learned patterns and your corrections | On device, trained on device |
| **Medha** | The genuinely novel tail, and natural-language questions over your inbox | On device, via its consent handshake |

### Why a linear model and not a fine-tuned transformer

This was a real decision, so the reasoning is recorded rather than assumed.

**The data is templated, not varied — now measured rather than assumed.** A
full export of a real 20,261-message inbox gives:

| Templates | Share of messages |
|---|---|
| top 50 | 36.2% |
| top 250 | 52.3% |
| top 1000 | 68.3% |
| seen 3+ times | 68.7% |
| true one-offs | 22.4% |

Roughly seven messages in ten come from a shape that repeats. A transformer's
advantage is generalising across novel phrasing, and repeats offer little for
it to work on. The 22.4% that are one-offs are not semantically novel either
— they are the same message *types* carrying different values, which a
bag-of-words plus character n-gram model handles by sharing vocabulary with
their category.

**Size and speed are not close.** MobileBERT is around 100 MB and DistilBERT
around 250 MB, against a few hundred KB for a linear model. Classifying
24,000 messages takes minutes and real battery through a transformer, and
milliseconds through a linear model.

**The decisive point: a linear model can be trained on the device.** A
transformer cannot, in any practical sense. Fine-tuning one means exporting
messages somewhere to train them — which quietly undoes the entire premise of
this app. Training locally means the corpus never leaves, the model is
personalised to *this* inbox rather than an average one, and a correction
improves things immediately instead of at the next release.

**Explainability survives.** Every classification carries the reason that
produced it. A transformer would replace that with a number.

Prior evidence agrees: an earlier build of this app reached 94% accuracy on a
real inbox with Naive Bayes.

**What would change this decision:** if the uncategorised tail turns out to be
genuinely varied rather than templated — many one-off phrasings rather than
repeated shapes — the case for a linear model weakens and this should be
revisited. The export feature exists partly to answer that question with data
instead of assumption.

### Design of the model layer

Multinomial Naive Bayes over word **and character** n-grams. Character n-grams
are not a detail here: they are what handles Hinglish, transliteration and the
mangled abbreviations banks use, where word-level features fall apart.

Labels come from two places. Rule-confident messages bootstrap it, but that
has a ceiling — the model mostly learns to imitate the rules and inherits
their blind spots. The signal that matters comes from **active learning**:
surface the messages the model is least sure about, take a correction, retrain.
A few dozen labels on genuinely uncertain cases are worth more than thousands
on cases the rules already handle.

The abstention margin carries over from the earlier build's tuning sweep, which
found margin=2 at 94% accuracy / 57% coverage preferable to 86% / 73%. That
trade is deliberate and should stay: a confident wrong label costs trust in
every other label.

### What Medha is *not* used for

Bulk classification, and arithmetic. Spending totals are computed with SQL over
deterministically parsed amounts; the model interprets the question and phrases
the answer, but never sums the figures. An LLM will occasionally get a sum
wrong, and there is no way to tell which time.

Medha is an enhancement, not a dependency. With it absent, not running, or
without a model loaded, rules and the local model still classify and the app
still works — it just loses the novel tail and natural-language questions, and
says so plainly.

## Measuring against a real corpus

`tools/eval` rehydrates a redacted export back into plausible message text and
runs the real classifier over all 20,261 messages, reporting the uncategorised
rate and the largest remaining misses by volume.

This is the difference between tuning and guessing. Writing rules from
imagination produced "Offers 0" across 500 real messages, and a spam rule that
caught exactly one message in 24,040. Every rule added since has been measured:

| Change | Uncategorised |
|---|---|
| baseline | 23.8% |
| + SERVICE and INSTITUTION categories | 18.7% |
| + missed money verbs, unpaid dues, courier vocabulary | **16.5%** |

Adding the learned layer on top, measured the same way:

| Stage | Uncategorised |
|---|---|
| rules only | 16.5% |
| rules + model at the measured margin | **13.0%** |

The model answers 21.6% of the tail and abstains on the rest, at 95% agreement
on held-out data. An earlier run showed 1.1% uncategorised, which looked far
better and was not — the abstention margin was miscalibrated and the model was
answering almost everything. Being wrong quietly on 15% of a tab is worse than
leaving it uncategorised.

**One caveat that matters:** the model is bootstrapped from rule labels, so
"95% accuracy" means agreement with the rules. It proves the model learned
them; it says nothing about the tail, where no rule label exists and where the
model is actually used. That number stays unvalidated until real corrections
exist, which is what the active-learning loop is for.

The remaining rule misses are a genuine long tail — no single shape above 14
messages — which is exactly the boundary where rules stop paying and the
learned layer starts.

## The correction loop

Long-press any message, pick the right category. The correction is stored
against the message *shape*, not the message, so correcting one of 311
near-identical offers re-labels all of them — the dialog says how many it will
affect, because that number often changes whether someone wants to proceed.

Corrections sit above the rules, not beside them:

```
your correction  ->  rules  ->  learned model  ->  uncategorised
```

An explicit instruction has to win. Feeding corrections only into training
would turn "this is a bill" into a statistical hint that might lose to a rule,
and the app would visibly disagree with something the user just told it.

They are also training examples, so a correction on one shape helps with
similar messages the app has not seen. And `OTHER` is deliberately not
offerable as a choice: "uncategorised" is what the app says when it does not
know, and a person picking it means "none of these fit" — real feedback, but
not a label, and it should not be stored as one.

## Two findings from a real 20,261-message inbox

**The tail is flat, so active learning has limited leverage.** The top 20
shapes worth labelling cover only ~2.5% of the messages needing attention —
there is no small set of big templates left to fix, just several thousand
near-singletons. The review queue is still worth having, because every label
also becomes model training data and so helps beyond the shape it was given
for. But it is not a button that fixes the inbox in one sitting, and building
it to look like one would only teach people the app overpromises.

**Indic-script messages are effectively invisible to the rules.** 119
templates covering 218 messages are in Telugu or Devanagari, and every rule in
the classifier is an English keyword — so 75 of them land in "uncategorised"
by construction and the rest match only incidentally.

This is not a gap that more rules should close. Hand-writing Telugu keyword
lists would be slow, partial, and unmaintainable by anyone who does not read
the script. It is precisely what the character n-gram features exist for: the
model can learn these shapes from a handful of corrections without anyone
writing a rule, which is a point in favour of the architecture rather than
against it.

## Design commitments

**Deterministic where correctness is checkable.** Amounts, dates and
categories that follow from structure are decided by rules, not a model. A
classifier that reads a rupee figure wrong 1% of the time is unusable, because
the 1% is indistinguishable from the 99%.

**Abstain rather than guess.** A confident wrong label costs trust in every
other label. `Category.OTHER` with `confident = false` is a real answer.

**Every decision is explainable.** Each classification carries the rule that
produced it. A category you disagree with is worth little if neither of us can
see why it happened.

**Read-only.** Sandeshika does not become Android's default SMS handler.
Owning the inbox means missing real messages if the app crashes; that is not a
trade worth making for an organizer.
