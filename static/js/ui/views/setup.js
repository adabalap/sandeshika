/**
 * Sandeshika — setup, diagnostics, import progress and the learning log.
 */

import { esc, fmtDate } from '../../core/format.js';
import { redact } from '../../core/redact.js';
import * as P from '../../core/parser.js';
import { setHtml, setText, setHidden, $ } from '../dom.js';
import { catColor } from '../theme.js';
import { row, empty } from '../components.js';
import * as state from '../state.js';
import { Store } from '../../data/client.js';

/** The form reflects where the live values came from, so nothing is a mystery. */
export function renderSettingsForm() {
  const { cfg } = state.get();
  const url = /** @type {HTMLInputElement|null} */ ($('#medhaUrl'));
  const tok = /** @type {HTMLInputElement|null} */ ($('#tokenInput'));
  const save = /** @type {HTMLButtonElement|null} */ ($('#btnSaveToken'));
  if (!url || !tok || !save) return;

  if (cfg.mock) {
    url.value = 'mock';
    url.disabled = true;
    tok.disabled = true;
    save.disabled = true;
    setHidden('#btnClearSaved', true);
    setText('#tokenHint', 'Demo mode — no token needed.');
    return;
  }

  // Never disabled. An earlier build locked this field whenever MEDHA_TOKEN was
  // in the environment, which left anyone with a stale env token unable to fix
  // it from the only screen that offers to.
  url.disabled = false;
  tok.disabled = false;
  save.disabled = false;
  url.value = cfg.medhaUrl || cfg.defaultMedhaUrl || 'http://127.0.0.1:8001';

  const parts = [];
  if (cfg.tokenConfigured) {
    tok.placeholder = 'saved — leave blank to keep';
    parts.push(`Using token ${cfg.tokenPreview} (${cfg.tokenSource === 'saved' ? 'saved here' : 'from the environment'}).`);
    parts.push('Type a new one to replace it.');
  } else {
    tok.placeholder = 'paste token';
    parts.push('No token yet — paste one from Medha → API clients.');
  }
  if (cfg.tokenSource === 'saved' && cfg.envTokenPresent) {
    parts.push('This overrides MEDHA_TOKEN from the environment.');
  }
  setText('#tokenHint', parts.join(' '));
  setHidden('#btnClearSaved', !(cfg.tokenSource === 'saved' || cfg.urlSource === 'saved'));
}

/** Tells the user whether the next tap resumes or starts fresh. */
export function renderImportHint() {
  const c = Store.cursor();
  setText('#btnImport', c ? 'Resume import' : 'Start import');
  setText('#importHint', c
    ? `A previous run stopped part-way; this continues from ${new Date(c).toLocaleDateString()}. `
      + 'Use "Re-scan everything" to walk the whole inbox again.'
    : 'Reads every message once. Re-running later is safe — duplicates are skipped.');
}

export function setProgress(pct, text) {
  const bar = $('#progressBar');
  if (bar) bar.style.width = Math.min(100, pct) + '%';
  setText('#progressText', text);
}

export const statsHtml = (t) => `
  <div class="stat"><span>${t.scanned}</span>messages read</div>
  <div class="stat"><span>${t.written}</span>transactions</div>
  <div class="stat"><span>${t.duplicates}</span>duplicates skipped</div>
  <div class="stat"><span>${t.rejected}</span>non-transactions</div>
  <div class="stat"><span>${t.pages || 0}</span>pages read</div>`;

/**
 * Template drift: messages from registered bank senders that failed to parse.
 * Deduplicated by sender + reason so one broken template shows once rather than
 * ninety times.
 *
 * DEFAULTS TO THE REDACTED VIEW. These messages exist to be sent to someone
 * else, and the whole point of the panel is that a user can copy them without
 * having to audit each one for their own name and account number first. The
 * original is one tap away and clearly labelled, because a user debugging their
 * own inbox still needs to see what actually arrived.
 */
export function renderDrift(list) {
  if (!list || !list.length) {
    setHidden('#driftCard', true);
    state.setQuiet({ drift: [] });
    return;
  }
  const seen = new Map();
  for (const d of list) {
    const k = d.sender + '|' + d.reason;
    if (!seen.has(k)) seen.set(k, { ...d, count: 0 });
    seen.get(k).count++;
  }
  const rows = [...seen.values()];
  state.setQuiet({ drift: rows });
  setHidden('#driftCard', false);
  renderDriftList();
}

/** Re-renders the list in whichever mode the segmented control is on. */
export function renderDriftList() {
  const { drift, driftView } = state.get();
  const safe = driftView !== 'original';

  let replaced = 0;
  let warned = false;

  const html = drift.slice(0, 8).map((d) => {
    const sender = safe ? P.normaliseSender(d.sender) : d.sender;
    let body = d.body;
    if (safe) {
      const out = redact(d.body);
      body = out.text;
      replaced += Object.values(out.counts).reduce((a, b) => a + b, 0);
      if (out.warnings.length) warned = true;
    }
    return `
      <div class="drift-row${safe ? ' safe' : ''}">
        <span class="row-sub">${esc(sender)} · ${esc(d.reason)} · ${d.count}×</span>
        <span class="raw">${esc(body)}</span>
      </div>`;
  }).join('');

  setHtml('#driftList', html);

  setHtml('#driftPrivacy', safe
    ? `<span class="ok">Redacted on this device.</span> ${replaced} value${replaced === 1 ? '' : 's'} `
      + 'replaced — amounts, names, account tails, phone numbers, UPI handles, references and links. '
      + 'Dates are shifted by a fixed offset so the format survives but the calendar is wrong. '
      + (warned
        ? '<span class="warn">Something in here still resembles personal data — read it before sending.</span>'
        : 'Read it over before sending anyway; no automatic rule catches every name.')
    : '<span class="warn">This is the original text, including anything personal in it. '
      + 'Switch to “Safe to share” before copying it anywhere.</span>');
}

/** Everything the app has been taught, with an undo next to each entry. */
export function renderLearned(rules) {
  setHtml('#learnedList', rules.length
    ? rules.map((r) => row({
      attrs: `data-mk="${esc(r.merchantKey)}"`,
      color: catColor(r.category),
      title: esc(r.merchant || r.merchantKey),
      sub: esc(r.category) + (r.at ? ' · ' + esc(fmtDate(r.at)) : ''),
      trailing: '<button class="mini no" data-forget="1">Forget</button>',
    })).join('')
    : empty('Nothing yet. Correct a category on any transaction and it appears here.'));
}

export function renderCustomCats() {
  const { customCats } = state.get();
  setHtml('#customCatList', customCats.length
    ? customCats.map((c) => row({
      attrs: `data-cat="${esc(c)}"`,
      title: esc(c),
      trailing: '<button class="mini no" data-delcat="1">Remove</button>',
    })).join('')
    : empty('Only the built-in categories so far.'));
}
