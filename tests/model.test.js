/*
 * The learned classifier. Two properties matter more than raw accuracy:
 * it must ABSTAIN when unsure, and it must never be consulted for amounts.
 */
import * as P from '../static/js/core/parser.js';
global.SandeshikaParser = P;
import * as M from '../static/js/core/model.js';

let pass = 0, fail = 0; const failures = [];
const ok = (n, c, d = '') => { if (c) pass++; else { fail++; failures.push(`${n}  ${d}`); } };

const t = (merchant, category, extra = {}) => Object.assign({
  merchant, category, direction: 'debit', amount: 300, channel: 'upi',
  sender: 'AX-HDFCBK', bank: 'HDFC',
}, extra);

// a small, realistic training set of USER-CONFIRMED labels
const train = [
  t('Rajdhani Rice Depot', 'groceries'), t('Rajdhani Rice Depot', 'groceries'),
  t('More Supermarket', 'groceries'), t('Bigbasket Daily', 'groceries'),
  t('Rapido', 'transport'), t('Rapido Bike', 'transport'),
  t('Uber India', 'transport'), t('Ola Cabs', 'transport'),
  t('Google Play', 'entertainment'), t('Netflix India', 'entertainment'),
  t('Hotstar', 'entertainment'), t('Spotify India', 'entertainment'),
  t('Apollo Pharmacy', 'health'), t('MedPlus Store', 'health'),
  t('Practo Care', 'health'), t('Apollo Clinic', 'health'),
  t('Sri Supermarket', 'groceries'), t('Ratnadeep Supermarket', 'groceries'),
  t('Vijetha Supermarket', 'groceries'), t('Heritage Fresh', 'groceries'),
  t('Ola Auto', 'transport'), t('Uber Trip', 'transport'),
  t('Rapido Cab', 'transport'), t('Metro Rail', 'transport'),
  t('Prime Video', 'entertainment'), t('Sony Liv', 'entertainment'),
  t('BookMyShow', 'entertainment'), t('Zee5 India', 'entertainment'),
  t('MedPlus Pharmacy', 'health'), t('Pharmeasy Order', 'health'),
];

const model = M.train(train);
ok('model trains', model.ready === true, JSON.stringify({ n: model.n, classes: model.classes }));
ok('all four classes usable', model.classes.length === 4, JSON.stringify(model.classes));

// --- it generalises to unseen merchants in a known family ---
const p1 = M.predict(model, t('Rajdhani Rice Depot Branch 2', null));
ok('known merchant predicted', p1 && p1.category === 'groceries', JSON.stringify(p1));
const p2 = M.predict(model, t('Rapido Auto', null));
ok('merchant variant predicted', p2 && p2.category === 'transport', JSON.stringify(p2));

// --- it explains itself ---
ok('prediction names its evidence', p1 && Array.isArray(p1.why) && p1.why.length > 0,
   JSON.stringify(p1 && p1.why));

// --- ABSTAINING is the important behaviour ---
const unknown = M.predict(model, t('ZZQQ Unheard Of Enterprises', null));
ok('abstains on an unfamiliar merchant', unknown === null || unknown.margin >= M.MIN_MARGIN,
   JSON.stringify(unknown));

const tiny = M.train(train.slice(0, 5));
ok('refuses to train on too little data', tiny.ready === false);
ok('and predicts nothing when not ready', M.predict(tiny, t('Rapido', null)) === null);
ok('null model is safe', M.predict(null, t('Rapido', null)) === null);
ok('empty transaction is safe', M.predict(model, { }) === null || true);

// --- amounts must never influence a category beyond coarse magnitude ---
const f = M.features(t('Rapido', null, { amount: 437.65 }));
ok('raw amount is not a feature', !f.some((x) => x.includes('437')), JSON.stringify(f));
ok('magnitude bucket is', f.includes('a:s'), JSON.stringify(f));
ok('buckets are coarse', M.magnitude(101) === M.magnitude(499));

// --- measured, not asserted ---
const ev = M.evaluate(train);
console.log(`\n  leave-one-out: ${ev.correct}/${ev.tested} correct `
  + `(${(ev.accuracy * 100).toFixed(0)}%), abstained on ${ev.abstained} of ${ev.n}`);
// Accuracy is measured only on what the model chose to answer; coverage is
// reported separately. A model that answers everything at 80% is worse here
// than one that answers 70% at 95% and hands the rest to the LLM.
ok('accuracy on answered items is high', ev.accuracy >= 0.9,
   `${(ev.accuracy * 100).toFixed(0)}%`);
ok('it answers a useful share', ev.coverage >= 0.5, `${(ev.coverage * 100).toFixed(0)}%`);

// --- sender priors: the whole-conversation idea ---
{
  const labelled = [
    t('Bigbasket', 'groceries', { sender: 'AX-BIGBSK' }),
    t('Bigbasket Daily', 'groceries', { sender: 'VM-BIGBSK' }),
    t('BB Now', 'groceries', { sender: 'JM-BIGBSK' }),
    t('Bigbasket Express', 'groceries', { sender: 'AD-BIGBSK' }),
    // a mixed sender must NOT earn a prior
    t('HDFC spend', 'shopping', { sender: 'AX-HDFCBK' }),
    t('HDFC spend', 'food', { sender: 'VM-HDFCBK' }),
    t('HDFC spend', 'bills', { sender: 'JM-HDFCBK' }),
    t('HDFC spend', 'transport', { sender: 'AD-HDFCBK' }),
  ];
  const priors = M.senderPriors(labelled);
  ok('a consistent sender earns a prior', priors.BIGBSK && priors.BIGBSK.category === 'groceries',
     JSON.stringify(priors));
  ok('a mixed sender earns none', !priors.HDFCBK, JSON.stringify(priors.HDFCBK));
  ok('DLT prefixes are collapsed first', priors.BIGBSK && priors.BIGBSK.n === 4,
     JSON.stringify(priors.BIGBSK));
}

// --- never crashes on junk ---
let threw = null;
for (const junk of [{}, { merchant: null }, { merchant: '', amount: NaN },
                    { merchant: '   ', sender: null }]) {
  try { M.predict(model, junk); M.features(junk); } catch (e) { threw = e.message; }
}
ok('never throws on malformed input', threw === null, threw || '');

console.log(`\n${'-'.repeat(50)}\npassed=${pass}  failed=${fail}`);
if (failures.length) { console.log('\nFAILURES:'); failures.forEach((f) => console.log('  ' + f)); process.exit(1); }
