# Sandeshika · సందేశిక

An SMS organizer for Indian inboxes, answering questions about your own
messages using a model that runs on your phone. It talks to
[Medha](../medha) over its local HTTP API and never sends a message anywhere.

## Status

Early. One vertical slice at a time, production-grade from the start rather
than prototyped and hardened later.

| Slice | State |
|---|---|
| Rule classifier (core logic) | **38 assertions passing** |
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
