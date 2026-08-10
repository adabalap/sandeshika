/*
 * Lekha — UI and analytics.
 *
 * ACCURACY RULE, applied throughout: every number shown to the user is computed
 * in JavaScript from stored transactions. The language model is never asked to
 * do arithmetic and never asked to recall a figure. In the Ask tab it receives
 * pre-computed totals and is allowed only to phrase them. A model that invents
 * a plausible rupee figure is indistinguishable from one that is correct, which
 * is exactly the failure a money app cannot ship.
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const { api, ApiError, Store, loadTransactions, backfill, catchUp } = SandeshikaApi;

  let txns = [];
  let period = 'thisMonth';
  let listLimit = 50;
  let stopRequested = false;

  // ------------------------------ formatting ------------------------------
  const inr = (n) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');
  const inrExact = (n) =>
    '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (ms) =>
    new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });

  const CAT_COLOR = {
    food: '#F4A62E', groceries: '#1FAE7A', transport: '#4C8DF6', shopping: '#B569E8',
    bills: '#E8635A', entertainment: '#E85AA8', health: '#42C0C0', education: '#7B8DF6',
    travel: '#F27B3D', transfer: '#8896A6', investment: '#12805A', income: '#2FBF71',
    other: '#A0AAB6',
  };

  // ------------------------------ periods ------------------------------
  function range(p) {
    const now = new Date();
    const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    switch (p) {
      case 'thisMonth': return [startOfMonth(now), Date.now()];
      case 'lastMonth': {
        const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return [s.getTime(), startOfMonth(now) - 1];
      }
      case 'last3': {
        const s = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        return [s.getTime(), Date.now()];
      }
      default: return [0, Date.now()];
    }
  }

  const inRange = (t, [a, b]) => t.date >= a && t.date <= b;

  /**
   * Analytics key off `kind`, never `direction`.
   *
   * A credit-card bill payment is a debit but not expenditure -- the card
   * purchases were already counted, so booking the bill too double-counts every
   * rupee on that statement. Likewise a refund is a credit but not income; it
   * offsets earlier spend. Getting this wrong is invisible and corrupts
   * every total on the screen.
   */
  const isSpend = (t) => t.kind === 'expense' && t.currency === 'INR' && t.category !== 'investment';
  const isRefund = (t) => t.kind === 'refund' && t.currency === 'INR';
  const isIncome = (t) => t.kind === 'income' && t.currency === 'INR';
  const counted = (t) => !t.needsReview || t.reviewed === true;

  // ------------------------------ analytics ------------------------------
  function summarise(list, r) {
    const inR = list.filter((t) => inRange(t, r) && counted(t));
    const gross = inR.filter(isSpend).reduce((s, t) => s + t.amount, 0);
    const refunded = inR.filter(isRefund).reduce((s, t) => s + t.amount, 0);
    // Net of refunds: a returned purchase was never really spent.
    const spent = Math.max(0, gross - refunded);
    const received = inR.filter(isIncome).reduce((s, t) => s + t.amount, 0);
    const transferred = inR.filter((t) => t.kind === 'transfer').reduce((s, t) => s + t.amount, 0);

    const byCat = {};
    for (const t of inR.filter(isSpend)) byCat[t.category || 'other'] = (byCat[t.category || 'other'] || 0) + t.amount;

    const byMerchant = {};
    for (const t of inR.filter(isSpend)) {
      const key = (t.merchant || 'unknown').toLowerCase();
      if (!byMerchant[key]) byMerchant[key] = { name: t.merchant || 'Unknown', total: 0, count: 0, category: t.category };
      byMerchant[key].total += t.amount;
      byMerchant[key].count++;
    }

    const byDay = {};
    for (const t of inR.filter(isSpend)) {
      const d = new Date(t.date);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      byDay[k] = (byDay[k] || 0) + t.amount;
    }

    return {
      spent, gross, refunded, received, transferred,
      net: received - spent, count: inR.length,
      byCat: Object.entries(byCat).sort((a, b) => b[1] - a[1]),
      merchants: Object.values(byMerchant).sort((a, b) => b.total - a.total),
      byDay,
      largest: inR.filter(isSpend).sort((a, b) => b.amount - a.amount)[0] || null,
    };
  }

  // ------------------------------ rendering ------------------------------
  function render() {
    const r = range(period);
    const s = summarise(txns, r);
    const prev = summarise(txns, period === 'thisMonth' ? range('lastMonth') : r);

    $('#kpiSpent').textContent = inr(s.spent);
    $('#kpiIn').textContent = inr(s.received);
    $('#kpiNet').textContent = (s.net >= 0 ? '+' : '−') + inr(s.net);
    $('#kpiNet').className = s.net >= 0 ? 'pos' : 'neg';
    $('#kpiSpentSub').textContent = s.refunded
      ? `${s.count} txns · ${inr(s.refunded)} refunded`
      : `${s.count} transactions`;
    $('#kpiInSub').textContent = s.transferred
      ? `${inr(s.transferred)} moved between accounts`
      : (s.received ? 'income in period' : '');

    if (period === 'thisMonth' && prev.spent > 0) {
      const delta = ((s.spent - prev.spent) / prev.spent) * 100;
      $('#kpiNetSub').textContent =
        `${Math.abs(delta).toFixed(0)}% ${delta >= 0 ? 'more' : 'less'} than last month`;
    } else {
      $('#kpiNetSub').textContent = '';
    }

    // categories
    const max = s.byCat.length ? s.byCat[0][1] : 1;
    $('#catChart').innerHTML = s.byCat.length
      ? s.byCat.map(([c, v]) => `
        <div class="bar-row">
          <span class="bar-label">${c}</span>
          <div class="bar-track">
            <div class="bar-fill" style="width:${(v / max) * 100}%;background:${CAT_COLOR[c] || '#A0AAB6'}"></div>
          </div>
          <span class="bar-val">${inr(v)}</span>
        </div>`).join('')
      : '<p class="empty">No spending in this period.</p>';

    // merchants
    $('#merchantList').innerHTML = s.merchants.slice(0, 8).map((m) => `
      <div class="row">
        <span class="dot" style="background:${CAT_COLOR[m.category] || '#A0AAB6'}"></span>
        <div class="row-main">
          <strong>${esc(m.name)}</strong>
          <span class="row-sub">${m.count}×</span>
        </div>
        <span class="row-amt">${inr(m.total)}</span>
      </div>`).join('') || '<p class="empty">Nothing yet.</p>';

    renderSpark(s.byDay, r);
    renderReview();
    renderTxns();
  }

  function renderSpark(byDay, [a, b]) {
    const days = [];
    const start = new Date(Math.max(a, b - 60 * 864e5));
    for (let d = new Date(start); d.getTime() <= b; d.setDate(d.getDate() + 1)) {
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push([k, byDay[k] || 0]);
    }
    const max = Math.max(1, ...days.map((x) => x[1]));
    $('#spark').innerHTML = days.map(([k, v]) =>
      `<div class="spark-bar" style="height:${Math.max(2, (v / max) * 100)}%"
            title="${k}: ${inr(v)}"></div>`).join('');
  }

  function renderReview() {
    const pending = txns.filter((t) => t.needsReview && !t.reviewed);
    const card = $('#reviewCard');
    if (!pending.length) { card.hidden = true; return; }
    card.hidden = false;
    $('#reviewList').innerHTML = pending.slice(0, 10).map((t) => `
      <div class="review" data-fp="${esc(t.fingerprint)}">
        <div class="row-main">
          <strong>${inrExact(t.amount)} · ${esc(t.merchant || 'unknown')}</strong>
          <span class="row-sub">${fmtDate(t.date)} · ${esc(reviewReason(t))}</span>
          <span class="raw">${esc(t.raw)}</span>
        </div>
        <div class="review-actions">
          <button class="mini ok" data-act="accept">Correct</button>
          <button class="mini no" data-act="reject">Not a transaction</button>
        </div>
      </div>`).join('');
  }

  /** Tells the user precisely why something is in the queue. */
  function reviewReason(t) {
    if (t.currency !== 'INR') return `${t.foreignCurrency} ${t.foreignAmount} — no offline exchange rate`;
    if (t.ambiguousP2P) return 'paid to a phone number — person or shop?';
    if (t.merchantQuality === 'opaque') return 'unreadable UPI handle';
    return `low confidence ${(t.confidence * 100).toFixed(0)}%`;
  }

  function renderTxns() {
    const q = $('#search').value.trim().toLowerCase();
    const cat = $('#filterCat').value;
    const list = txns
      .filter((t) => !cat || t.category === cat)
      .filter((t) => !q || (t.merchant || '').toLowerCase().includes(q)
        || String(t.amount).includes(q) || (t.raw || '').toLowerCase().includes(q))
      .sort((a, b) => b.date - a.date);

    $('#txnList').innerHTML = list.slice(0, listLimit).map((t) => `
      <div class="row ${t.direction}">
        <span class="dot" style="background:${CAT_COLOR[t.category] || '#A0AAB6'}"></span>
        <div class="row-main">
          <strong>${esc(t.merchant || 'Unknown')}</strong>
          <span class="row-sub">
            ${fmtDate(t.date)} · ${t.category || 'other'} · ${t.channel}
            ${t.kind === 'transfer' ? '<em class="flag tf">transfer</em>' : ''}
            ${t.kind === 'refund' ? '<em class="flag rf">refund</em>' : ''}
            ${t.needsReview && !t.reviewed ? '<em class="flag">unverified</em>' : ''}
          </span>
        </div>
        <span class="row-amt ${t.direction}">${t.direction === 'debit' ? '−' : '+'}${inrExact(t.amount)}</span>
      </div>`).join('') || '<p class="empty">No transactions match.</p>';

    $('#loadMore').classList.toggle('hidden', list.length <= listLimit);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------ Ask ------------------------------
  /**
   * Builds a compact factual brief from real data, then asks the model to
   * phrase it. The model sees only numbers we computed, and is instructed not
   * to invent any. This is retrieval-grounded answering, not recall.
   */
  function buildFacts(question) {
    const r = range('thisMonth');
    const cur = summarise(txns, r);
    const last = summarise(txns, range('lastMonth'));
    const all = summarise(txns, range('all'));

    const q = question.toLowerCase();
    const catHit = LekhaParser.CATEGORIES.find((c) => q.includes(c));

    const facts = {
      currency: 'INR',
      thisMonth: { spent: Math.round(cur.spent), received: Math.round(cur.received), transactions: cur.count },
      lastMonth: { spent: Math.round(last.spent), received: Math.round(last.received), transactions: last.count },
      thisMonthByCategory: Object.fromEntries(cur.byCat.map(([c, v]) => [c, Math.round(v)])),
      lastMonthByCategory: Object.fromEntries(last.byCat.map(([c, v]) => [c, Math.round(v)])),
      topMerchantsThisMonth: cur.merchants.slice(0, 5).map((m) => ({ name: m.name, total: Math.round(m.total), times: m.count })),
      largestThisMonth: cur.largest
        ? { merchant: cur.largest.merchant, amount: Math.round(cur.largest.amount), date: fmtDate(cur.largest.date) }
        : null,
      allTime: { spent: Math.round(all.spent), transactions: all.count },
    };
    if (catHit) {
      facts.focusCategory = catHit;
      facts.focusThisMonth = Math.round(cur.byCat.find(([c]) => c === catHit)?.[1] || 0);
      facts.focusLastMonth = Math.round(last.byCat.find(([c]) => c === catHit)?.[1] || 0);
  }
  if (cur.refunded) facts.thisMonthRefunds = Math.round(cur.refunded);
  if (cur.transferred) {
    facts.note = 'Transfers between own accounts and credit-card bill payments are excluded from spending.';
    }
    return facts;
  }

  async function ask() {
    const q = $('#askInput').value.trim();
    if (!q) return;
    const out = $('#askOut');
    out.textContent = 'Thinking…';
    const facts = buildFacts(q);
    $('#askFacts').textContent = JSON.stringify(facts, null, 2);
    $('#askEvidence').hidden = false;

    try {
      const r = await api('/generate', {
        method: 'POST',
        body: JSON.stringify({
          system:
            'You answer questions about the user\'s spending using ONLY the JSON figures provided. ' +
            'Never invent or estimate a number. If the JSON does not contain what was asked, say so plainly. ' +
            'Amounts are Indian rupees. Answer in at most three sentences.',
          prompt: `Figures:\n${JSON.stringify(facts)}\n\nQuestion: ${q}\nAnswer:`,
        }),
      });
      out.textContent = (r.text || '').trim() || 'No answer returned.';
    } catch (e) {
      out.textContent = 'Could not answer: ' + e.message;
    }
  }

  // ------------------------------ import ------------------------------
  function setProgress(pct, text) {
    $('#progressBar').style.width = Math.min(100, pct) + '%';
    $('#progressText').textContent = text;
  }

  async function runImport() {
    stopRequested = false;
    $('#btnImport').disabled = true;
    $('#btnStop').classList.remove('hidden');

    let total = 0;
    try {
      const st = await api('/connectors/sms/status');
      if (st.supported === false) throw new ApiError(
        'This Medha build has no SMS connector. Install the "full" APK.', 0, 0);
      if (!st.canRead) throw new ApiError(
        'Medha does not have SMS permission yet. Grant it in the Medha app.', 0, 0);
      total = st.totalMessages || 0;
    } catch (e) {
      banner(e.message, 'error');
      $('#btnImport').disabled = false;
      $('#btnStop').classList.add('hidden');
      return;
    }

    try {
      const res = await backfill({
        shouldStop: () => stopRequested,
        onWait: (msg, secs) => setProgress(0, `Paused — ${msg}. Retrying in ${secs}s`),
        onProgress: (t) => {
          const pct = total ? (t.scanned / total) * 100 : 0;
          setProgress(pct, `${t.scanned} of ${total || '?'} messages · ${t.written} transactions found`);
          $('#importStats').innerHTML = statsHtml(t);
          renderDrift(t.drift);
        },
      });
      setProgress(100, res.stopped ? 'Stopped — resume any time' : 'Import complete');
      $('#importStats').innerHTML = statsHtml(res);
      renderDrift(res.drift);
      await reload();
    } catch (e) {
      banner('Import stopped: ' + e.message, 'error');
    } finally {
      $('#btnImport').disabled = false;
      $('#btnStop').classList.add('hidden');
    }
  }

  function renderDrift(list) {
    const card = $('#driftCard');
    if (!list || !list.length) { card.hidden = true; return; }
    card.hidden = false;
    // Deduplicate by sender + reason so one broken template shows once.
    const seen = new Map();
    for (const d of list) {
      const k = d.sender + '|' + d.reason;
      if (!seen.has(k)) seen.set(k, { ...d, count: 0 });
      seen.get(k).count++;
    }
    window.__drift = [...seen.values()];
    $('#driftList').innerHTML = window.__drift.slice(0, 8).map((d) => `
      <div class="drift-row">
        <span class="row-sub">${esc(d.sender)} · ${esc(d.reason)} · ${d.count}×</span>
        <span class="raw">${esc(d.body)}</span>
      </div>`).join('');
  }

  const statsHtml = (t) => `
    <div class="stat"><span>${t.scanned}</span>messages read</div>
    <div class="stat"><span>${t.written}</span>transactions</div>
    <div class="stat"><span>${t.duplicates}</span>duplicates skipped</div>
    <div class="stat"><span>${t.rejected}</span>non-transactions</div>`;

  function banner(msg, kind = 'info') {
    const b = $('#banner');
    $('#bannerText').textContent = msg;
    b.className = 'banner ' + kind;
    b.classList.remove('hidden');
    if (kind === 'info') setTimeout(() => b.classList.add('hidden'), 4000);
  }

  // ------------------------------ boot ------------------------------
  async function reload() {
    try {
      txns = await loadTransactions();
      const cats = [...new Set(txns.map((t) => t.category).filter(Boolean))].sort();
      $('#filterCat').innerHTML = '<option value="">All categories</option>' +
        cats.map((c) => `<option value="${c}">${c}</option>`).join('');
      render();
      $('#subtitle').textContent = txns.length
        ? `${txns.length} transactions · all on this device`
        : 'Import your SMS to begin';
    } catch (e) {
      banner(e.message, 'error');
    }
  }

  async function checkConnection() {
    const el = $('#connState');
    try {
      const cfg = await fetch('/config.json').then((r) => r.json());
      const h = await api('/health');
      if (cfg.mock) {
        el.innerHTML = '<span class="warn">Demo mode — synthetic inbox, mock model. '
          + 'Figures are computed for real from generated messages.</span>';
        return true;
      }
      if (!cfg.tokenConfigured) {
        el.innerHTML = '<span class="err">Server has no MEDHA_TOKEN set. '
          + 'Restart it with --token &lt;token&gt;.</span>';
        return false;
      }
      if (!h.modelLoaded) {
        el.innerHTML = '<span class="warn">Medha is reachable but no model is loaded.</span>';
        return false;
      }
      await api('/store?prefix=meta/&limit=1');   // proves the token is accepted
      el.innerHTML = `<span class="ok">Connected to ${esc(cfg.medhaUrl)} · model loaded</span>`;
      if (!cfg.installable) {
        banner('Open via localhost or HTTPS to install as an app', 'info');
      }
      return true;
    } catch (e) {
      el.innerHTML = `<span class="err">${esc(e.message)}</span>`;
      return false;
    }
  }

  // ------------------------------ events ------------------------------
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + t.dataset.view).classList.remove('hidden');
  }));

  $$('.period .chip').forEach((c) => c.addEventListener('click', () => {
    $$('.period .chip').forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
    period = c.dataset.period;
    render();
  }));
  $('.period .chip').classList.add('sel');

  $('#search').addEventListener('input', () => { listLimit = 50; renderTxns(); });
  $('#filterCat').addEventListener('change', renderTxns);
  $('#loadMore').addEventListener('click', () => { listLimit += 100; renderTxns(); });

  $('#btnAsk').addEventListener('click', ask);
  $$('.chip.q').forEach((c) => c.addEventListener('click', () => {
    $('#askInput').value = c.textContent;
    ask();
  }));

  $('#btnRecheck').addEventListener('click', async () => {
    if (await checkConnection()) { banner('Connected'); reload(); }
  });

  $('#btnCopyDrift')?.addEventListener('click', async () => {
    const text = (window.__drift || [])
      .map((d) => `${d.sender} [${d.reason}] x${d.count}\n${d.body}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); banner('Copied'); }
    catch (_) { banner('Could not copy', 'error'); }
  });

  $('#btnImport').addEventListener('click', runImport);
  $('#btnStop').addEventListener('click', () => { stopRequested = true; });

  $('#btnRefresh').addEventListener('click', async () => {
    try {
      const r = await catchUp();
      banner(r.written ? `${r.written} new transactions` : 'Up to date');
      if (r.written) reload();
    } catch (e) { banner(e.message, 'error'); }
  });

  // Review queue: accepting counts a transaction, rejecting removes it.
  $('#reviewList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const fp = btn.closest('.review').dataset.fp;
    const t = txns.find((x) => x.fingerprint === fp);
    if (!t) return;
    try {
      if (btn.dataset.act === 'accept') {
        t.reviewed = true;
        t.needsReview = false;
        await api('/store/' + SandeshikaApi.Keys.txn(fp), { method: 'PUT', body: JSON.stringify(t) });
      } else {
        await api('/store/' + SandeshikaApi.Keys.txn(fp), { method: 'DELETE' });
        txns = txns.filter((x) => x.fingerprint !== fp);
      }
      render();
    } catch (err) { banner(err.message, 'error'); }
  });

  $('#btnReset').addEventListener('click', async () => {
    if (!confirm('Delete every transaction and category Lekha has stored? Your SMS are untouched.')) return;
    try {
      const rows = await SandeshikaApi.listPrefix('txn/', 100000);
      for (const r of rows) await api('/store/' + r.key, { method: 'DELETE' }).catch(() => {});
      Store.reset();
      txns = [];
      render();
      banner('All Lekha data deleted');
    } catch (e) { banner(e.message, 'error'); }
  });

  (async () => {
    const connected = await checkConnection();
    await reload();
    if (!connected || !txns.length) {
      $$('.tab').forEach((x) => x.classList.remove('active'));
      $$('.view').forEach((v) => v.classList.add('hidden'));
      document.querySelector('[data-view="setup"]').classList.add('active');
      $('#view-setup').classList.remove('hidden');
    }
  })();
})();
