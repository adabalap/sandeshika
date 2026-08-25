/*
 * Sandeshika — on-device learned classifier.
 *
 * WHERE A MODEL BELONGS, AND WHERE IT DOES NOT
 *
 * Extraction (amount, date, reference) stays deterministic, forever. A model
 * that reads a rupee figure correctly 99% of the time is unusable here, because
 * the 1% is silent and indistinguishable from the 99%.
 *
 * Classification is the opposite case. "Is this groceries or shopping?" has no
 * ground truth in the text, the cost of a mistake is a mislabelled row rather
 * than a wrong total, and the user can correct it in one tap. That is exactly
 * where learning pays.
 *
 * WHY NAIVE BAYES RATHER THAN SOMETHING LARGER
 *
 *  - It trains in milliseconds on a few hundred examples, on the phone, with no
 *    download and no server.
 *  - It is inspectable: every prediction can name the tokens that drove it, so
 *    a wrong answer can be explained instead of shrugged at.
 *  - It improves from the corrections the user is already making, so accuracy
 *    tracks their actual inbox rather than a generic corpus.
 *  - It degrades honestly: when the margin between the top two classes is thin
 *    it abstains rather than guessing, and the LLM or the user decides.
 *
 * THE LADDER
 *
 *   user correction  →  rule table  →  sender prior  →  learned model
 *                    →  cached LLM answer  →  LLM  →  "other"
 *
 * Each rung is cheaper and more certain than the next. The model only sees what
 * the rules missed, and the LLM only sees what the model was not confident
 * about — which on a real inbox is a small tail.
 */
import * as P from './parser.js';

/** Minimum examples before the model is allowed an opinion at all. */
const MIN_EXAMPLES = 12;
/** Minimum per-class examples for that class to be predictable. */
const MIN_PER_CLASS = 3;
/**
 * How much more likely the winner must be than the runner-up.
 *
 * In log space. Chosen by sweeping it against leave-one-out on a realistic
 * correction set, not guessed:
 *
 *     margin  accuracy  coverage
 *      1.2      86%       73%
 *      2        94%       57%     <- chosen
 *      3        92%       40%
 *      5       100%       37%
 *
 * 94% on 57% of the tail, with the rest handed to the LLM, beats 86% on 73%.
 * A confident wrong label costs the user's trust in every other label; an
 * honest abstention costs one model call.
 */
const MIN_MARGIN = 2;

/**
 * Features from a transaction.
 *
 * Merchant tokens carry nearly all the signal. The sender and channel are
 * included because they disambiguate the hard cases: the same ₹200 to the
 * same-looking name is a different thing from HDFCBK than from JIOPAY.
 * Amount is bucketed by magnitude, never used raw — the model must not learn
 * that "₹437" specifically means groceries.
 */
function features(txn) {
  const f = [];
  const merchant = P.merchantKey(txn.merchant || '');
  for (const tok of merchant.split(' ').filter(Boolean)) {
    f.push('m:' + tok);
    // A prefix captures "swiggy" inside "swiggyinstamart".
    if (tok.length > 4) f.push('mp:' + tok.slice(0, 4));
  }
  // Character trigrams over the whole merchant string.
  //
  // Whole-token features alone cannot generalise to a merchant never seen
  // before, which is most of the long tail: "More Supermarket" and "Sri
  // Supermarket" share nothing at token level but almost everything at
  // trigram level. Without these the model abstained on roughly three
  // quarters of transactions, which is safe but not useful.
  const flat = merchant.replace(/\s+/g, ' ');
  for (let i = 0; i + 3 <= flat.length; i++) {
    const g = flat.slice(i, i + 3);
    if (g.trim().length === 3) f.push('g:' + g);
  }
  if (txn.sender) f.push('s:' + P.normaliseSender(txn.sender));
  if (txn.bank) f.push('b:' + txn.bank);
  if (txn.channel) f.push('c:' + txn.channel);
  f.push('d:' + (txn.direction || '?'));
  f.push('a:' + magnitude(txn.amount));
  return f;
}

function magnitude(amount) {
  const a = Math.abs(Number(amount) || 0);
  if (a < 100) return 'xs';
  if (a < 500) return 's';
  if (a < 2000) return 'm';
  if (a < 10000) return 'l';
  return 'xl';
}

/**
 * Trains a multinomial Naive Bayes from labelled transactions.
 * Only user-confirmed labels are used as training data: training on the
 * model's own past output would compound its mistakes into confidence.
 */
function train(labelled) {
  const classCount = Object.create(null);
  const tokenCount = Object.create(null);   // class -> token -> n
  const classTotal = Object.create(null);   // class -> total tokens
  const vocab = new Set();
  let n = 0;

  for (const t of labelled) {
    const c = t.category;
    if (!c) continue;
    n++;
    classCount[c] = (classCount[c] || 0) + 1;
    tokenCount[c] = tokenCount[c] || Object.create(null);
    for (const f of features(t)) {
      tokenCount[c][f] = (tokenCount[c][f] || 0) + 1;
      classTotal[c] = (classTotal[c] || 0) + 1;
      vocab.add(f);
    }
  }

  const usable = Object.keys(classCount).filter((c) => classCount[c] >= MIN_PER_CLASS);
  return {
    n,
    classes: usable,
    classCount,
    tokenCount,
    classTotal,
    vocabSize: vocab.size,
    ready: n >= MIN_EXAMPLES && usable.length >= 2,
  };
}

/**
 * Returns { category, confidence, margin, why } or null when the model
 * declines to answer. Declining is a first-class outcome.
 */
function predict(model, txn) {
  if (!model || !model.ready) return null;
  const f = features(txn);
  if (!f.length) return null;

  const scores = model.classes.map((c) => {
    // Laplace smoothing: an unseen token must not zero out a whole class.
    let logp = Math.log(model.classCount[c] / model.n);
    const denom = (model.classTotal[c] || 0) + model.vocabSize;
    for (const tok of f) {
      const seen = (model.tokenCount[c] && model.tokenCount[c][tok]) || 0;
      logp += Math.log((seen + 1) / denom);
    }
    return { c, logp };
  }).sort((a, b) => b.logp - a.logp);

  if (scores.length < 2) return null;
  const margin = scores[0].logp - scores[1].logp;
  if (margin < MIN_MARGIN) return null;

  // Which tokens actually moved the decision, for an explanation the user
  // can read. A prediction nobody can interrogate is a prediction nobody
  // should act on.
  const why = f.map((tok) => {
    const a = (model.tokenCount[scores[0].c] || {})[tok] || 0;
    const b = (model.tokenCount[scores[1].c] || {})[tok] || 0;
    return { tok, lift: a - b };
  }).filter((x) => x.lift > 0).sort((a, b) => b.lift - a.lift).slice(0, 3)
    .map((x) => x.tok);

  return {
    category: scores[0].c,
    // Squashed to something readable; the margin is the honest number.
    confidence: Math.min(0.95, 0.5 + margin / 10),
    margin,
    why,
    source: 'model',
  };
}

/**
 * Sender-level prior — the idea Organiso's classifier gets most of its
 * real-world accuracy from.
 *
 * A single message is ambiguous; a sender rarely is. If every categorised
 * message from `AX-BIGBSK` has been groceries, the next one almost certainly
 * is too. Requires unanimity across a few examples, because a mixed sender
 * (a bank that sends both spend alerts and offers) must not get a prior.
 */
function senderPriors(labelled, minExamples = 4) {
  const bySender = Object.create(null);
  for (const t of labelled) {
    const s = P.normaliseSender(t.sender || '');
    if (!s || !t.category) continue;
    bySender[s] = bySender[s] || Object.create(null);
    bySender[s][t.category] = (bySender[s][t.category] || 0) + 1;
  }
  const priors = Object.create(null);
  for (const [s, counts] of Object.entries(bySender)) {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((a, e) => a + e[1], 0);
    if (total < minExamples) continue;
    // 90% of a sender's history agreeing is enough; total unanimity is too
    // brittle when one message was mis-tapped.
    if (entries[0][1] / total >= 0.9) {
      priors[s] = { category: entries[0][0], n: total, source: 'sender' };
    }
  }
  return priors;
}

/** Leave-one-out accuracy, so the claim can be checked rather than asserted. */
function evaluate(labelled) {
  if (labelled.length < MIN_EXAMPLES + 1) return { n: 0, tested: 0 };
  let correct = 0, tested = 0, abstained = 0;
  for (let i = 0; i < labelled.length; i++) {
    const holdout = labelled[i];
    const rest = labelled.filter((_, j) => j !== i);
    const m = train(rest);
    const p = predict(m, holdout);
    if (!p) { abstained++; continue; }
    tested++;
    if (p.category === holdout.category) correct++;
  }
  return {
    n: labelled.length,
    tested,
    abstained,
    correct,
    accuracy: tested ? correct / tested : 0,
    coverage: labelled.length ? tested / labelled.length : 0,
  };
}

export {
train, predict, evaluate, features, senderPriors, magnitude,
MIN_EXAMPLES, MIN_PER_CLASS, MIN_MARGIN,
};
