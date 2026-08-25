/**
 * Sandeshika · సందేశిక — entry point.
 *
 * Three jobs and nothing else: subscribe the views to state, bind every DOM
 * event to an action, and boot. No rendering logic and no network calls live
 * here.
 *
 * ACCURACY RULE, enforced across the whole app: every number shown to the user
 * is computed in JavaScript from stored transactions. The language model is
 * never asked to do arithmetic and never asked to recall a figure. In the Ask
 * tab it receives pre-computed totals and is allowed only to phrase them.
 */

import { dayKey } from './core/format.js';
import {
  range, dailyRange, counted, isSpend, isIncome, inRange,
} from './core/analytics.js';
import { $, $$, on, delegate, banner, showView, setText, val } from './ui/dom.js';
import { VIEW_TITLE } from './ui/theme.js';
import * as state from './ui/state.js';
import * as actions from './ui/actions.js';

import * as overview from './ui/views/overview.js';
import * as dashboard from './ui/views/dashboard.js';
import * as daily from './ui/views/daily.js';
import * as detail from './ui/views/detail.js';
import * as transactions from './ui/views/transactions.js';
import * as bills from './ui/views/bills.js';
import * as inbox from './ui/views/inbox.js';
import { renderCustomCats, renderImportHint, renderDriftList } from './ui/views/setup.js';
import { ask } from './ui/views/ask.js';

/** Bumped with every release; compared against the server to spot a stale cache. */
const BUILD = '2.2.0';

// ---------------------------------------------------------------------------
// Rendering
//
// One subscriber paints everything. Views read only what they need, so this
// stays cheap, and it removes the class of bug where an action updated the data
// but forgot to call one of the six render functions that depend on it.
// ---------------------------------------------------------------------------
function renderAll() {
  overview.render();
  dashboard.render();
  daily.render();
  transactions.render();
  transactions.renderFilter();
  bills.render();
  inbox.render();
  detail.renderDay();
  detail.renderTxn();
  renderCustomCats();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
function activate(view) {
  $$('.nav-item').forEach((x) => x.classList.toggle('active', x.dataset.view === view));
  showView(view);
  const drawer = $('#drawer');
  if (drawer) drawer.classList.add('hidden');
  setText('#subtitle', VIEW_TITLE[view] || '');
  window.scrollTo(0, 0);
  // Lazily: reading 400 messages on boot would slow the first paint for someone
  // who only wants the spending summary.
  if ((view === 'inbox' || view === 'bills') && !state.get().inbox.length) actions.loadInbox();
}

function openTxn(fp) {
  state.set({ openTxnFp: fp });
  showView('txn');
}

function openDay(k) {
  state.set({ openDay: k });
  showView('day');
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------
function wireNavigation() {
  on('#btnMenu', 'click', () => {
    const d = $('#drawer');
    if (d) d.classList.toggle('hidden');
  });

  on('#drawer', 'click', (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    if (target.id === 'drawer') {
      target.classList.add('hidden');
      return;
    }
    const item = target.closest('.nav-item[data-view]');
    if (item) activate(/** @type {HTMLElement} */ (item).dataset.view || 'overview');
  });

  $$('.tab[data-view]').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    activate(t.dataset.view || 'overview');
  }));

  $$('.sheet-period .chip').forEach((c) => c.addEventListener('click', () => {
    $$('.sheet-period .chip').forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
    state.set({ period: /** @type {any} */ (c.dataset.period) });
    const d = $('#drawer');
    if (d) d.classList.add('hidden');
  }));

  $$('#dailyPeriod .chip').forEach((c) => c.addEventListener('click', () => {
    $$('#dailyPeriod .chip').forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
    state.set({ dailyPeriod: /** @type {any} */ (c.dataset.dperiod) });
  }));

  on('#btnAllDays', 'click', () => activate('daily'));
  on('#btnBackDaily', 'click', () => showView('daily'));
  on('#btnBackDay', 'click', () => showView(state.get().openDay ? 'day' : 'daily'));
  on('#btnBackList', 'click', () => activate('overview'));
}

function wireTransactions() {
  on('#search', 'input', () => state.set({ listLimit: 50 }));
  on('#filterCat', 'change', () => transactions.render());
  on('#loadMore', 'click', () => state.set({ listLimit: state.get().listLimit + 100 }));

  delegate('#txnList', '.txn-row', 'click', (el) => openTxn(el.dataset.fp || ''));
  delegate('#listRows', '.txn-row', 'click', (el) => openTxn(el.dataset.fp || ''));
  delegate('#dayTxns', '.txn-row', 'click', (el) => openTxn(el.dataset.fp || ''));
  delegate('#dayList', '.day-row', 'click', (el) => openDay(el.dataset.day || ''));
  delegate('#dashDays', '.day-row', 'click', (el) => {
    activate('daily');
    openDay(el.dataset.day || '');
  });

  delegate('#kindChips', 'button[data-kind]', 'click',
    (el) => actions.setTxnKind(/** @type {any} */ (el.dataset.kind)));
  delegate('#catChips', 'button[data-cat]', 'click',
    (el) => actions.setCategory(el.dataset.cat || ''));

  delegate('#reviewList', 'button[data-act]', 'click', (el) => {
    const wrap = el.closest('.review');
    if (!wrap) return;
    actions.resolveReview(/** @type {HTMLElement} */ (wrap).dataset.fp || '',
      el.dataset.act === 'accept');
  });

  delegate('#attentionList', 'button', 'click', (el) => {
    if (el.id === 'btnShowPairs') {
      dashboard.renderPairs();
      return;
    }
    const rowEl = el.closest('.pair-row');
    if (!rowEl) return;
    if (el.dataset.pair === 'yes') {
      actions.markPairAsTransfer(Number(/** @type {HTMLElement} */ (rowEl).dataset.i));
    } else {
      rowEl.remove();
    }
  });
}

function wireBillsAndInbox() {
  on('#btnLoadInbox', 'click', () => actions.loadInbox());
  on('#inboxSearch', 'input', () => state.set({ inboxLimit: 40 }));
  on('#inboxMore', 'click', () => state.set({ inboxLimit: state.get().inboxLimit + 60 }));
  $$('#inboxTabs .chip').forEach((c) => c.addEventListener('click', () => {
    state.set({ inboxTab: c.dataset.box || 'transactions', inboxLimit: 40 });
  }));

  delegate('#billList', 'button[data-bill]', 'click', (el) => {
    const r = el.closest('.row');
    if (r) actions.setBillStatus(/** @type {HTMLElement} */ (r).dataset.fp || '', 'paid');
  });
  delegate('#billDone', 'button[data-bill]', 'click', (el) => {
    const r = el.closest('.row');
    if (r) actions.setBillStatus(/** @type {HTMLElement} */ (r).dataset.fp || '', 'open');
  });
}

function wireSetup() {
  on('#btnImport', 'click', () => actions.runImport(false));
  on('#btnRestart', 'click', () => {
    if (confirm('Read every message again from the beginning? Existing transactions are kept and duplicates skipped.')) {
      actions.runImport(true);
    }
  });
  on('#btnStop', 'click', () => actions.requestStop());
  on('#btnRefresh', 'click', () => actions.refresh());
  on('#btnDetect', 'click', () => actions.detect());
  on('#btnDiagnose', 'click', () => actions.diagnose());
  on('#btnSaveToken', 'click', () => actions.saveSettings());
  on('#btnCopyDrift', 'click', () => actions.copyDrift());
  on('#btnDownloadDrift', 'click', () => actions.downloadDrift());
  $$('#driftCard .seg-btn').forEach((b) => b.addEventListener('click', () => {
    $$('#driftCard .seg-btn').forEach((x) => {
      x.classList.toggle('sel', x === b);
      x.setAttribute('aria-selected', String(x === b));
    });
    state.setQuiet({ driftView: /** @type {any} */ (b.dataset.drift) });
    renderDriftList();
  }));
  on('#btnExportCsv', 'click', () => actions.exportCsv());
  on('#btnExportJson', 'click', () => actions.exportJson());

  on('#btnClearSaved', 'click', () => {
    if (confirm('Forget the saved token and address, and fall back to how the server was started?')) {
      actions.clearSettings();
    }
  });
  on('#btnRecheck', 'click', async () => {
    if (await actions.checkConnection()) {
      banner('Connected');
      actions.reload();
    }
  });
  on('#btnReset', 'click', () => {
    if (confirm('Delete every transaction and category Sandeshika has stored? Your SMS are untouched.')) {
      actions.resetAll();
    }
  });

  const submitOnEnter = (e) => {
    if (/** @type {KeyboardEvent} */ (e).key === 'Enter') actions.saveSettings();
  };
  on('#tokenInput', 'keydown', submitOnEnter);
  on('#medhaUrl', 'keydown', submitOnEnter);

  on('#btnAddCat', 'click', async () => {
    if (await actions.addCustomCat(val('#newCat'))) {
      const el = /** @type {HTMLInputElement|null} */ ($('#newCat'));
      if (el) el.value = '';
    }
  });
  delegate('#customCatList', 'button[data-delcat]', 'click', (el) => {
    const r = el.closest('.row');
    if (r) actions.removeCustomCat(/** @type {HTMLElement} */ (r).dataset.cat || '');
  });
  delegate('#learnedList', 'button[data-forget]', 'click', (el) => {
    const r = el.closest('.row');
    if (!r) return;
    const mk = /** @type {HTMLElement} */ (r).dataset.mk || '';
    if (confirm(`Forget the category you set for "${mk}"? Past transactions keep their current label.`)) {
      actions.forgetLearned(mk);
    }
  });

  on('#btnAsk', 'click', () => ask());
  $$('.chip.q').forEach((c) => c.addEventListener('click', () => {
    const el = /** @type {HTMLInputElement|null} */ ($('#askInput'));
    if (el) el.value = c.textContent || '';
    ask();
  }));

  on('#btnAbout', 'click', () => {
    const d = $('#drawer');
    if (d) d.classList.add('hidden');
    alert(`Sandeshika · సందేశిక — build ${BUILD}\n\n`
      + 'Private insights from the SMS already on your phone: spending, bills and highlights.\n\n'
      + 'Nothing leaves the device. Messages are read from Medha on 127.0.0.1, parsed here, '
      + 'and only what is extracted is stored — never the message bodies themselves.\n\n'
      + 'Amounts and dates are read by deterministic rules, never by the model. The model only '
      + 'names unfamiliar merchants and phrases answers.');
  });
}

/**
 * Every headline tile drills through to the rows behind it.
 *
 * A total the user cannot open is a total they cannot check or correct, and
 * correcting is how the app learns.
 */
function wireDrilldowns() {
  const txns = () => state.get().txns;
  const monthStart = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  };

  /** @type {Record<string, () => void>} */
  const tiles = {
    dashToday: () => detail.drill('Spent today',
      txns().filter((t) => dayKey(t.date) === dayKey(Date.now()) && counted(t))),
    dashMonth: () => detail.drill('This month',
      txns().filter((t) => t.date >= monthStart() && counted(t))),
    kpiSpent: () => {
      const r = range(state.get().period);
      detail.drill('Spending', txns().filter((t) => inRange(t, r) && counted(t) && isSpend(t)));
    },
    kpiIn: () => {
      const r = range(state.get().period);
      detail.drill('Money received', txns().filter((t) => inRange(t, r) && counted(t) && isIncome(t)));
    },
    kpiNet: () => {
      const r = range(state.get().period);
      detail.drill('Everything in this period', txns().filter((t) => inRange(t, r) && counted(t)));
    },
    dTotal: () => {
      const r = dailyRange(state.get().dailyPeriod);
      detail.drill('All spending in this period',
        txns().filter((t) => inRange(t, r) && counted(t) && isSpend(t)));
    },
  };

  for (const [id, fn] of Object.entries(tiles)) {
    const el = $('#' + id);
    if (!el) continue;
    const card = el.closest('.card') || el;
    card.classList.add('tappable');
    card.addEventListener('click', fn);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  state.setQuiet({ build: BUILD });

  state.subscribe(renderAll);
  wireNavigation();
  wireTransactions();
  wireBillsAndInbox();
  wireSetup();
  wireDrilldowns();

  renderImportHint();

  const connected = await actions.checkConnection();
  await actions.loadCustomCats();
  await actions.reload();

  // Land on Setup only when there is nothing useful to show. Someone with data
  // and a temporarily unreachable backend should still see their history.
  if (!connected && !state.get().txns.length) {
    activate('setup');
  } else {
    activate('overview');
  }
}

boot().catch((e) => {
  console.error(e);
  banner('Sandeshika failed to start: ' + (e && e.message), 'error');
});
