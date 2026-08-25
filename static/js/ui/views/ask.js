/**
 * Sandeshika — the Ask tab.
 *
 * Retrieval-grounded answering, not recall. The model receives ONLY figures
 * this app computed and is instructed to invent none. The evidence panel shows
 * the user exactly what it was given, so any answer can be checked against the
 * numbers behind it rather than taken on trust.
 */

import * as P from '../../core/parser.js';
import { buildFacts } from '../../core/analytics.js';
import { api } from '../../data/client.js';
import { setText, setHidden, val } from '../dom.js';
import { friendly } from '../errors.js';
import * as state from '../state.js';

const SYSTEM = "You answer questions about the user's spending using ONLY the JSON figures "
  + 'provided. Never invent or estimate a number. If the JSON does not contain what was '
  + 'asked, say so plainly. Amounts are Indian rupees. Answer in at most three sentences.';

export async function ask() {
  const q = val('#askInput').trim();
  if (!q) return;

  setText('#askOut', 'Thinking…');
  const s = state.get();
  const facts = buildFacts(s.txns, q, P.CATEGORIES.concat(s.customCats));
  setText('#askFacts', JSON.stringify(facts, null, 2));
  setHidden('#askEvidence', false);

  try {
    const r = await api('/generate', {
      method: 'POST',
      body: JSON.stringify({
        system: SYSTEM,
        prompt: `Figures:\n${JSON.stringify(facts)}\n\nQuestion: ${q}\nAnswer:`,
      }),
    });
    setText('#askOut', String(r.text || '').trim() || 'No answer returned.');
  } catch (e) {
    setText('#askOut', 'Could not answer: ' + friendly(e));
  }
}
