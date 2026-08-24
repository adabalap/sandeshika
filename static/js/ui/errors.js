/**
 * Sandeshika — error messages.
 *
 * Raw status codes are not an error message. "HTTP 401" tells the user nothing
 * they can act on; naming the cause AND the fix does. Four layers sit between a
 * tap and an answer — the transport, the Sandeshika host, Medha, and the token
 * — and a single "Failed to fetch" is consistent with all four. That ambiguity
 * has sent people debugging the wrong layer more than once, so every message
 * here names a layer and a next step.
 */

import Transport from '../data/transport.js';

/** @param {unknown} e */
export function friendly(e) {
  const err = /** @type {{status?: number, message?: string}} */ (e || {});
  const m = String(err.message || e);

  if (err.status === 401) return 'Medha rejected the saved token — re-paste it in Setup.';

  if (err.status === 403) {
    // Medha names the missing capability; prefer its wording over a generic
    // line, and say exactly where to fix it.
    if (/capabilit/i.test(m)) {
      return `${m}  Fix: Medha → API clients → Edit permissions → tick "Read SMS".`;
    }
    if (/sms/i.test(m)) return m;
    return 'Medha refused that request: ' + m;
  }

  if (err.status === 503) return 'Medha is running but no model is loaded.';
  if (err.status === 502) return m;
  if (err.status === 504) return 'Medha did not respond in time. It may be loading a model.';
  if (err.status === 429) return 'Medha is thermally throttled or busy. It will resume on its own.';
  if (/^HTTP \d+$/.test(m)) return `Medha returned ${m}. Check Setup.`;

  // Raw browser and network failures. "Failed to fetch" is the least useful
  // string a user can be shown, and it is the one they see most often.
  if (/failed to fetch|networkerror|load failed|not reachable/i.test(m)) {
    return Transport.native
      ? 'Could not reach Medha. Check it is running and the address in Setup matches its port.'
      : 'Could not reach the Sandeshika server. If you closed the terminal, start it again.';
  }
  return m;
}
