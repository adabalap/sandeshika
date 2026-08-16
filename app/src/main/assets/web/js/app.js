/*
 * Sandeshika — UI and analytics.
 *
 * ACCURACY RULE, applied throughout: every number shown to the user is computed
 * in JavaScript from stored transactions. The language model is never asked to
 * do arithmetic and never asked to recall a figure. In the Ask tab it receives
 * pre-computed totals and is allowed only to phrase them. A model that invents
 * a plausible rupee figure is indistinguishable from one that is correct, which
 * is exactly the failure a money app cannot ship.
 */
(() => {
  /** Bumped with every release; compared against the server to spot a stale cache. */
  const BUILD = '1.11.0';

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const { api, ApiError, Store, loadTransactions, backfill, catchUp } = SandeshikaApi;

  let txns = [];
  let period = 'thisMonth';
  let listLimit = 50;
  let stopRequested = false;

  // ------------------------------ formatting ------------------------------
  const inr = (n) => '₹' + Math.round(Math.abs(n)).toLocaleString('en-IN');

  /**
   * Compact Indian notation for headline figures.
   *
   * ₹8,25,856 is nine characters and overflowed the KPI card, shrinking the
   * text until three cards became unreadable. Lakh and crore are how the amount
   * would be said aloud anyway, and the exact figure stays one tap away in the
   * drill-down.
   */
  const inrShort = (n) => {
    const v = Math.abs(n);
    if (v >= 1e7) return '₹' + (v / 1e7).toFixed(v >= 1e8 ? 0 : 2) + ' Cr';
    if (v >= 1e5) return '₹' + (v / 1e5).toFixed(v >= 1e6 ? 1 : 2) + ' L';
    if (v >= 1e3) return '₹' + Math.round(v).toLocaleString('en-IN');
    return '₹' + Math.round(v);
  };
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

    $('#kpiSpent').textContent = inrShort(s.spent);
    $('#kpiSpent').title = inr(s.spent);
    $('#kpiIn').textContent = inrShort(s.received);
    $('#kpiIn').title = inr(s.received);
    $('#kpiNet').textContent = (s.net >= 0 ? '+' : '−') + inrShort(s.net);
    $('#kpiNet').title = inr(s.net);
    $('#kpiNet').className = s.net >= 0 ? 'pos' : 'neg';
    $('#kpiSpentSub').textContent = s.refunded
      ? `${s.count} txns · ${inr(s.refunded)} refunded`
      : `${s.count} transactions`;
    $('#kpiInSub').textContent = s.transferred
      ? `${inrShort(s.transferred)} moved between accounts`
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
    renderDashboard();
    renderDaily();
    renderQuality();
    renderReview();
    renderTxns();
  }

  /**
   * Coverage, stated plainly.
   *
   * A spending app is only as good as the fraction of the inbox it actually
   * understood, and that number is normally invisible — which lets a parser
   * miss a whole message format while the totals still look plausible.
   */
  /**
   * The dashboard. Answers the four questions worth opening the app for:
   * what have I spent today and this month, what do I owe soon, and what needs
   * a decision from me.
   */
  function renderDashboard() {
    const now = Date.now();
    const todayKey = dayKey(now);
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

    const counted_ = txns.filter(counted);
    const today = counted_.filter((t) => dayKey(t.date) === todayKey);
    const month = counted_.filter((t) => t.date >= monthStart);
    const sum = (list) => list.filter(isSpend).reduce((a, t) => a + t.amount, 0)
      - list.filter(isRefund).reduce((a, t) => a + t.amount, 0);

    const tSpend = Math.max(0, sum(today));
    const mSpend = Math.max(0, sum(month));
    $('#dashToday').textContent = tSpend ? inrShort(tSpend) : '₹0';
    $('#dashToday').title = inr(tSpend);
    $('#dashTodaySub').textContent = today.length
      ? `${today.length} transaction${today.length > 1 ? 's' : ''}`
      : 'nothing yet today';

    // Pace, not just position: "on track" is the useful part of a month total.
    const dayOfMonth = new Date().getDate();
    const projected = mSpend / dayOfMonth * new Date(
      new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    $('#dashMonth').textContent = inrShort(mSpend);
    $('#dashMonth').title = inr(mSpend);
    $('#dashMonthSub').textContent = dayOfMonth > 2
      ? `on pace for ${inrShort(projected)}` : `${month.length} transactions`;

    const open = bills.filter((b) => b.status === 'open');
    const soon = open.filter((b) => { const d = O.daysUntil(b.dueAt, now); return d !== null && d >= 0 && d <= 7; });
    const late = open.filter((b) => { const d = O.daysUntil(b.dueAt, now); return b.overdue || (d !== null && d < 0); });
    $('#dashDue').textContent = soon.length ? inrShort(soon.reduce((a, b) => a + (b.amount || 0), 0)) : '—';
    $('#dashDueSub').textContent = soon.length
      ? soon.map((b) => b.issuer).slice(0, 2).join(', ') : 'nothing due';
    $('#dashOverdue').textContent = late.length ? inrShort(late.reduce((a, b) => a + (b.amount || 0), 0)) : '—';
    $('#dashOverdue').className = late.length ? 'neg' : '';
    $('#dashOverdueSub').textContent = late.length ? `${late.length} bill${late.length > 1 ? 's' : ''}` : 'all clear';

    // things awaiting a decision
    const review = txns.filter((t) => t.needsReview && !t.reviewed);
    const pairs = O.findTransferPairs(txns.filter((t) => t.date >= now - 60 * 864e5));
    const items = [];
    if (pairs.length) {
      items.push(`<div class="row">
        <span class="dot" style="background:#4C8DF6"></span>
        <div class="row-main"><strong>${pairs.length} possible transfer${pairs.length > 1 ? 's' : ''} between your accounts</strong>
        <span class="row-sub">A matching debit and credit — counting both inflates spending and income</span></div>
        <button class="mini ok" id="btnShowPairs">Review</button></div>`);
    }
    if (review.length) {
      items.push(`<div class="row">
        <span class="dot" style="background:#F4A62E"></span>
        <div class="row-main"><strong>${review.length} transaction${review.length > 1 ? 's' : ''} to confirm</strong>
        <span class="row-sub">Excluded from totals until you do</span></div></div>`);
    }
    if (late.length) {
      items.push(`<div class="row">
        <span class="dot" style="background:#E8635A"></span>
        <div class="row-main"><strong>${late.length} overdue bill${late.length > 1 ? 's' : ''}</strong>
        <span class="row-sub">${esc(late.map((b) => b.issuer).slice(0, 3).join(', '))}</span></div></div>`);
    }
    $('#attentionCard').hidden = !items.length;
    $('#attentionList').innerHTML = items.join('');

    // last seven days, tappable
    const byDay = {};
    for (const t of counted_.filter((x) => x.date >= now - 7 * 864e5)) {
      const k = dayKey(t.date);
      byDay[k] = (byDay[k] || 0) + (isSpend(t) ? t.amount : 0);
    }
    const days = Object.entries(byDay).sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 7);
    const max = Math.max(1, ...days.map(([, v]) => v));
    $('#dashDays').innerHTML = days.map(([k, v]) => {
      const d = new Date(k + 'T00:00:00');
      return `<div class="row day-row" data-day="${k}">
        <div class="row-main"><strong>${d.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}</strong>
          <div class="bar-track" style="margin-top:5px"><div class="bar-fill" style="width:${(v / max) * 100}%;background:#1FAE7A"></div></div>
        </div><span class="row-amt debit">${inr(v)}</span></div>`;
    }).join('') || '<p class="empty">No spending in the last week.</p>';
  }

  /** Shows the suggested pairs and lets both sides be reclassified at once. */
  function showPairs() {
    const pairs = O.findTransferPairs(txns.filter((t) => t.date >= Date.now() - 60 * 864e5));
    if (!pairs.length) return banner('No transfer pairs found');
    $('#attentionList').innerHTML = pairs.map((p, i) => `
      <div class="row pair-row" data-i="${i}">
        <span class="dot" style="background:#4C8DF6"></span>
        <div class="row-main">
          <strong>${inrExact(p.amount)} out and back in</strong>
          <span class="row-sub">${fmtDate(p.debit.date)} · ${esc(p.debit.merchant || 'unknown')}
            ${p.debit.account ? '••' + p.debit.account : ''} →
            ${p.credit.account ? '••' + p.credit.account : 'another account'}</span>
        </div>
        <button class="mini ok" data-pair="yes">Both transfers</button>
        <button class="mini no" data-pair="no">Keep as is</button>
      </div>`).join('');
    window.__pairs = pairs;
  }

  async function markPairAsTransfer(i) {
    const p = (window.__pairs || [])[i];
    if (!p) return;
    try {
      await SandeshikaApi.putMany([p.debit, p.credit].map((t) => ({
        key: SandeshikaApi.Keys.txn(t.fingerprint),
        value: JSON.stringify({ ...t, kind: 'transfer', category: 'transfer',
                                categorySource: 'user', needsReview: false, reviewed: true }),
      })));
      banner(`${inrExact(p.amount)} marked as a transfer — removed from both spending and income`);
      await reload();
    } catch (e) { banner(friendly(e), 'error'); }
  }

  function renderQuality() {
    const el = $('#qualityBody');
    if (!txns.length) {
      el.innerHTML = '<p class="empty">Import your messages to see coverage.</p>';
      return;
    }
    const review = txns.filter((t) => t.needsReview && !t.reviewed).length;
    const guessed = txns.filter((t) => t.categorySource === 'guess').length;
    const llm = txns.filter((t) => t.categorySource === 'llm').length;
    const uncategorised = txns.filter((t) => !t.category || t.category === 'other').length;
    const noMerchant = txns.filter((t) => !t.merchant).length;
    const foreign = txns.filter((t) => t.currency !== 'INR').length;

    const row = (label, n, tone) => `
      <div class="row">
        <span class="dot" style="background:${tone}"></span>
        <div class="row-main"><strong>${label}</strong></div>
        <span class="row-amt">${n}</span>
      </div>`;

    el.innerHTML = [
      row('Transactions stored', txns.length, '#1FAE7A'),
      row('Categorised by rule', txns.length - llm - guessed - uncategorised, '#1FAE7A'),
      llm ? row('Categorised by the model', llm, '#4C8DF6') : '',
      guessed ? row('Guessed — confirm these', guessed, '#F4A62E') : '',
      review ? row('Waiting for review', review, '#F4A62E') : '',
      uncategorised ? row('Uncategorised', uncategorised, '#A0AAB6') : '',
      noMerchant ? row('No merchant identified', noMerchant, '#A0AAB6') : '',
      foreign ? row('Foreign currency, excluded', foreign, '#B569E8') : '',
    ].filter(Boolean).join('');
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
    const catHit = SandeshikaParser.CATEGORIES.find((c) => q.includes(c));

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

  /** Tells the user whether the next tap resumes or starts fresh. */
  function renderImportHint() {
    const c = Store.cursor();
    $('#btnImport').textContent = c ? 'Resume import' : 'Start import';
    $('#importHint').textContent = c
      ? `A previous run stopped part-way; this continues from ${new Date(c).toLocaleDateString()}. `
        + 'Use "Re-scan everything" to walk the whole inbox again.'
      : 'Reads every message once. Re-running later is safe — duplicates are skipped.';
  }

  async function runImport(restart = false) {
    stopRequested = false;
    $('#btnImport').disabled = true;
    $('#btnStop').classList.remove('hidden');

    let total = 0;
    try {
      // Three separate things must be true, and each has a different remedy.
      // Reporting them apart is the difference between a two-minute fix and an
      // afternoon.
      const st = await api('/connectors/sms/status');
      if (st.supported === false) throw new ApiError(
        'This Medha build has no SMS connector. Install the "full" APK — the "core" '
        + 'build ships without SMS permissions so it installs cleanly.', 0, 0);
      if (!st.canRead) throw new ApiError(
        'Medha does not have Android\'s SMS permission yet. '
        + 'Medha → menu → SMS connector → Grant SMS permission.', 0, 0);
      total = st.totalMessages || 0;
    } catch (e) {
      banner(friendly(e), 'error');
      $('#btnImport').disabled = false;
      $('#btnStop').classList.add('hidden');
      return;
    }

    try {
      const res = await backfill({
        restart,
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
      // Scanning far fewer messages than exist almost always means a stale
      // cursor sent the run to the end of history. Say so, rather than
      // reporting success over an empty result.
      if (!res.stopped && total && res.scanned < total * 0.5) {
        banner(`Only ${res.scanned} of ${total} messages were read — a previous run had `
          + 'already reached the end. Tap "Re-scan everything" to read them all.', 'error');
      }
      $('#importStats').innerHTML = statsHtml(res);
      renderDrift(res.drift);
      await reload();
    } catch (e) {
      banner('Import stopped: ' + friendly(e), 'error');
    } finally {
      $('#btnImport').disabled = false;
      $('#btnStop').classList.add('hidden');
      renderImportHint();
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
    <div class="stat"><span>${t.rejected}</span>non-transactions</div>
    <div class="stat"><span>${t.pages || 0}</span>pages read</div>`;

  /**
   * Raw status codes are not an error message. "HTTP 401" tells the user
   * nothing they can act on; naming the cause and the fix does.
   */
  function friendly(e) {
    const m = String(e && e.message || e);
    if (e && e.status === 401) return 'Medha rejected the saved token — re-paste it in Setup.';
    if (e && e.status === 403) {
      // Medha names the missing capability; prefer its wording over a generic
      // line, and say exactly where to fix it.
      if (/capabilit/i.test(m)) {
        return m + '  Fix: Medha → API clients → Edit permissions → tick "Read SMS".';
      }
      if (/sms/i.test(m)) return m;
      return 'Medha refused that request: ' + m;
    }
    if (e && e.status === 503) return 'Medha is running but no model is loaded.';
    if (e && e.status === 502) return m;
    if (/^HTTP \d+$/.test(m)) return `Medha returned ${m}. Check Setup.`;
    // Raw browser/network failures. "Failed to fetch" is the least useful
    // string a user can be shown, and it is the one they see most often.
    if (/failed to fetch|networkerror|load failed/i.test(m)) {
      return Transport.native
        ? 'Could not reach Medha. Check it is running and the address in Setup matches its port.'
        : 'Could not reach the Sandeshika server. If you closed the terminal, start it again.';
    }
    if (/not reachable|cannot reach/i.test(m)) return m;
    return m;
  }

  function banner(msg, kind = 'info') {
    const b = $('#banner');
    $('#bannerText').textContent = msg;
    b.className = 'banner ' + kind;
    b.classList.remove('hidden');
    if (kind === 'info') setTimeout(() => b.classList.add('hidden'), 4000);
  }


  // ======================================================================
  // Inbox organiser
  //
  // Messages are read LIVE from Medha and never copied into storage. The
  // system SMS provider is already the source of truth; a second copy is one
  // more thing to secure, keep in sync, and get wrong.
  // ======================================================================
  const O = window.SandeshikaOrganizer;
  let inbox = [];            // { sms, cls } for the loaded window
  let box = 'transactions';
  let inboxLimit = 40;
  let bills = [];

  const BOX_EMPTY = {
    transactions: 'No transactions in the loaded messages.',
    bills: 'No bills or due dates found.',
    updates: 'No delivery, travel or service updates.',
    promotions: 'No promotional messages. Enjoy the quiet.',
    personal: 'No personal messages — these come from numeric senders.',
    spam: 'Nothing flagged as spam.',
  };

  async function loadInbox(limit = 400) {
    $('#inboxEmptyCard').hidden = true;
    $('#inboxCount').textContent = 'Loading…';
    try {
      const page = await api('/connectors/sms/messages?limit=' + limit);
      inbox = page.messages.map((m) => ({ sms: m, cls: O.classify(m) }));
      await refreshBills();
      renderInbox();
    } catch (e) {
      $('#inboxEmptyCard').hidden = false;
      banner(friendly(e), 'error');
      $('#inboxCount').textContent = '';
    }
  }

  function renderInbox() {
    const q = $('#inboxSearch').value.trim().toLowerCase();
    const rows = inbox
      .filter((r) => r.cls.tab === box)
      .filter((r) => !q || r.sms.body.toLowerCase().includes(q)
        || String(r.sms.address).toLowerCase().includes(q));

    const counts = {};
    inbox.forEach((r) => { counts[r.cls.tab] = (counts[r.cls.tab] || 0) + 1; });
    $$('#inboxTabs .chip').forEach((c) => {
      const n = counts[c.dataset.box] || 0;
      c.textContent = c.dataset.box.charAt(0).toUpperCase() + c.dataset.box.slice(1)
        + (n ? ` ${n}` : '');
      c.classList.toggle('sel', c.dataset.box === box);
    });
    $('#inboxCount').textContent = `${rows.length} of ${inbox.length} messages loaded`;

    $('#inboxList').innerHTML = rows.slice(0, inboxLimit).map((r) => {
      const t = r.cls.txn;
      // An OTP code is never rendered. Repeating a one-time code in a list or
      // a digest is exactly what makes OTP phishing work.
      const body = r.cls.sensitive
        ? '<em>One-time code received — hidden for safety</em>'
        : esc(r.sms.body).replace(/\n/g, ' ');
      return `
      <div class="row">
        <span class="dot" style="background:${boxColor(r.cls.tab)}"></span>
        <div class="row-main">
          <strong>${esc(SandeshikaParser.senderBank(r.sms.address) || r.sms.address)}</strong>
          <span class="row-sub">${fmtDate(r.sms.date)} · ${esc(r.cls.subtype)}</span>
          <span class="raw">${body}</span>
        </div>
        ${t ? `<span class="row-amt ${t.direction}">${t.direction === 'debit' ? '−' : '+'}${inr(t.amount)}</span>` : ''}
      </div>`;
    }).join('') || `<p class="empty">${BOX_EMPTY[box] || 'Nothing here.'}</p>`;

    $('#inboxMore').classList.toggle('hidden', rows.length <= inboxLimit);
  }

  const boxColor = (tab) => ({
    transactions: '#1FAE7A', bills: '#E8635A', updates: '#4C8DF6',
    promotions: '#F4A62E', personal: '#B569E8', spam: '#8896A6',
  }[tab] || '#A0AAB6');

  // ---------------------------- bills ----------------------------

  async function refreshBills() {
    const found = new Map();
    for (const r of inbox) {
      if (r.cls.tab !== O.TAB.BILLS) continue;
      const b = O.extractBill(r.sms);
      // One bill produces several reminders; the fingerprint collapses them,
      // and the newest sighting wins because amounts get revised.
      if (b && (!found.has(b.fingerprint) || found.get(b.fingerprint).seenAt < b.seenAt)) {
        found.set(b.fingerprint, b);
      }
    }
    // Merge stored status (paid / dismissed) over freshly parsed bills.
    let saved = {};
    try {
      const rows = await SandeshikaApi.listPrefix('bill/', 500);
      rows.forEach((r) => { try { saved[r.key.replace(/^bill\//, '')] = JSON.parse(r.value); } catch (_) {} });
    } catch (_) {}

    bills = [...found.values()].map((b) => ({ ...b, ...(saved[b.fingerprint] || {}) }));
    renderBills();
  }

  function renderBills() {
    const now = Date.now();
    const open = bills.filter((b) => b.status === 'open')
      .sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity));
    const done = bills.filter((b) => b.status !== 'open');

    const soon = open.filter((b) => {
      const d = O.daysUntil(b.dueAt, now);
      return d !== null && d >= 0 && d <= 7;
    });
    const late = open.filter((b) => {
      const d = O.daysUntil(b.dueAt, now);
      return b.overdue || (d !== null && d < 0);
    });

    $('#kpiDueSoon').textContent = soon.length ? inrShort(soon.reduce((s, b) => s + (b.amount || 0), 0)) : '—';
    $('#kpiDueSoonSub').textContent = soon.length ? `${soon.length} bill${soon.length > 1 ? 's' : ''}` : 'nothing due';
    $('#kpiOverdue').textContent = late.length ? inrShort(late.reduce((s, b) => s + (b.amount || 0), 0)) : '—';
    $('#kpiOverdueSub').textContent = late.length ? `${late.length} overdue` : 'all clear';
    $('#kpiOverdue').className = late.length ? 'neg' : '';

    const row = (b) => {
      const d = O.daysUntil(b.dueAt, now);
      const when = d === null ? 'no date found'
        : d < 0 ? `${Math.abs(d)} day${Math.abs(d) > 1 ? 's' : ''} overdue`
        : d === 0 ? 'due today' : `due in ${d} day${d > 1 ? 's' : ''}`;
      return `
      <div class="row" data-fp="${esc(b.fingerprint)}">
        <span class="dot" style="background:${d !== null && d < 3 ? '#E8635A' : '#F4A62E'}"></span>
        <div class="row-main">
          <strong>${esc(b.issuer)}${b.account ? ' ••' + esc(b.account) : ''}</strong>
          <span class="row-sub">${esc(b.kind)} · ${when}${
            b.minimumDue ? ' · min ' + inr(b.minimumDue) : ''}</span>
        </div>
        <span class="row-amt debit">${b.amount ? inrExact(b.amount) : '—'}</span>
        ${b.status === 'open'
          ? '<button class="mini ok" data-bill="paid">Paid</button>'
          : '<button class="mini" data-bill="reopen">Undo</button>'}
      </div>`;
    };
    $('#billList').innerHTML = open.map(row).join('') || '<p class="empty">No bills outstanding.</p>';
    $('#billDone').innerHTML = done.map(row).join('') || '<p class="empty">Nothing settled yet.</p>';
  }

  async function setBillStatus(fp, status) {
    const b = bills.find((x) => x.fingerprint === fp);
    if (!b) return;
    b.status = status;
    try {
      await api('/store/bill/' + encodeURIComponent(fp), {
        method: 'PUT',
        body: JSON.stringify({ status, updatedAt: Date.now() }),
      });
    } catch (e) { banner(friendly(e), 'error'); }
    renderBills();
  }

  // ---------------------------- export ----------------------------

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    if (!txns.length) return banner('Nothing to export yet', 'error');
    const cols = ['date', 'kind', 'direction', 'amount', 'currency', 'merchant',
                  'category', 'categorySource', 'channel', 'account', 'bank', 'ref',
                  'confidence', 'needsReview'];
    const lines = [cols.join(',')];
    for (const t of txns.slice().sort((a, b) => a.date - b.date)) {
      lines.push(cols.map((c) => csvCell(
        c === 'date' ? new Date(t.date).toISOString() : t[c])).join(','));
    }
    download(`sandeshika-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
             lines.join('\n'), 'text/csv');
    banner(`Exported ${txns.length} transactions`);
  }

  function exportJson() {
    const payload = {
      app: 'Sandeshika',
      exportedAt: new Date().toISOString(),
      // Stated so a future reader knows what the numbers mean without the app.
      notes: 'Amounts in INR. kind: expense | income | refund | transfer. '
           + 'Transfers and investments are excluded from spending totals.',
      transactions: txns,
      bills,
    };
    download(`sandeshika-export-${new Date().toISOString().slice(0, 10)}.json`,
             JSON.stringify(payload, null, 2), 'application/json');
    banner(`Exported ${txns.length} transactions and ${bills.length} bills`);
  }


  // ======================================================================
  // Daily view and drill-down
  //
  // Every number here is a sum of rows the user can open and read. That is the
  // point of the drill-down: a total nobody can trace is a total nobody can
  // trust, and this is the screen where a mis-categorised transaction gets
  // found and fixed.
  // ======================================================================
  /**
   * Categories = the built-in list plus anything the user added.
   *
   * Held in Medha under meta/categories so it survives reinstalls and is shared
   * by every device pointing at the same service.
   */
  let customCats = [];
  const allCategories = () => SandeshikaParser.CATEGORIES.concat(customCats);

  async function loadCustomCats() {
    try {
      const r = await api('/store/meta/categories');
      customCats = Array.isArray(r) ? r : (r.categories || []);
    } catch (_) { customCats = []; }
    renderCustomCats();
  }

  async function saveCustomCats() {
    await api('/store/meta/categories', {
      method: 'PUT', body: JSON.stringify({ categories: customCats }),
    });
    renderCustomCats();
  }

  function renderCustomCats() {
    const el = $('#customCatList');
    if (!el) return;
    el.innerHTML = customCats.length
      ? customCats.map((c) => `
        <div class="row" data-cat="${esc(c)}">
          <div class="row-main"><strong>${esc(c)}</strong></div>
          <button class="mini no" data-delcat="1">Remove</button>
        </div>`).join('')
      : '<p class="empty">Only the built-in categories so far.</p>';
  }

  let dPeriod = 'thisMonth';
  let openDay = null;
  let openTxn = null;

  function dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function dailyRange() {
    const now = new Date();
    switch (dPeriod) {
      case 'last30': return [Date.now() - 30 * 864e5, Date.now()];
      case 'lastMonth': {
        const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        return [s.getTime(), new Date(now.getFullYear(), now.getMonth(), 1).getTime() - 1];
      }
      case 'all': return [0, Date.now()];
      default: return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Date.now()];
    }
  }

  function renderDaily() {
    const [a, b] = dailyRange();
    const rows = txns.filter((t) => t.date >= a && t.date <= b && counted(t));
    const byDay = {};
    for (const t of rows) {
      const k = dayKey(t.date);
      if (!byDay[k]) byDay[k] = { spend: 0, income: 0, count: 0, review: 0 };
      const d = byDay[k];
      d.count++;
      if (isSpend(t)) d.spend += t.amount;
      if (isRefund(t)) d.spend -= t.amount;
      if (isIncome(t)) d.income += t.amount;
      if (t.needsReview && !t.reviewed) d.review++;
    }
    const days = Object.entries(byDay).sort((x, y) => (x[0] < y[0] ? 1 : -1));
    const total = days.reduce((s, [, d]) => s + Math.max(0, d.spend), 0);
    // Averaged over days that actually had spending, not calendar days: a
    // month-to-date average divided by 31 on the 3rd is a misleading number.
    const active = days.filter(([, d]) => d.spend > 0).length;

    $('#dTotal').textContent = inrShort(total);
    $('#dTotal').title = inr(total);
    $('#dTotalSub').textContent = `${rows.length} transactions over ${days.length} days`;
    $('#dAvg').textContent = active ? inrShort(total / active) : '—';
    $('#dAvgSub').textContent = active ? `across ${active} days with spending` : '';

    const max = Math.max(1, ...days.map(([, d]) => d.spend));
    $('#dayList').innerHTML = days.map(([k, d]) => {
      const dt = new Date(k + 'T00:00:00');
      return `
      <div class="row day-row" data-day="${k}">
        <div class="row-main">
          <strong>${dt.toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}</strong>
          <span class="row-sub">${d.count} txn${d.count > 1 ? 's' : ''}${
            d.income ? ' · +' + inr(d.income) : ''}${
            d.review ? ' · <em class="flag">' + d.review + ' to review</em>' : ''}</span>
          <div class="bar-track" style="margin-top:5px">
            <div class="bar-fill" style="width:${(Math.max(0, d.spend) / max) * 100}%;background:#1FAE7A"></div>
          </div>
        </div>
        <span class="row-amt debit">${inr(Math.max(0, d.spend))}</span>
      </div>`;
    }).join('') || '<p class="empty">No transactions in this period.</p>';
  }

  function showView(name) {
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + name).classList.remove('hidden');
  }

  function renderDay(k) {
    openDay = k;
    const rows = txns.filter((t) => dayKey(t.date) === k).sort((x, y) => y.date - x.date);
    const spend = rows.filter(isSpend).reduce((s, t) => s + t.amount, 0);
    const dt = new Date(k + 'T00:00:00');
    $('#dayTitle').textContent = dt.toLocaleDateString('en-IN',
      { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    $('#daySummary').textContent =
      `${rows.length} message${rows.length > 1 ? 's' : ''} · ${inr(spend)} spent. `
      + 'Tap any row to see the original SMS and set its category.';
    $('#dayTxns').innerHTML = rows.map((t) => `
      <div class="row txn-row" data-fp="${esc(t.fingerprint)}">
        <span class="dot" style="background:${CAT_COLOR[t.category] || '#A0AAB6'}"></span>
        <div class="row-main">
          <strong>${esc(t.merchant || 'Unknown')}</strong>
          <span class="row-sub">${t.category || 'other'} · ${t.kind}${
            t.categorySource === 'user' ? ' · <em class="flag ok2">you set this</em>' : ''}${
            t.needsReview && !t.reviewed ? ' · <em class="flag">unverified</em>' : ''}</span>
        </div>
        <span class="row-amt ${t.direction}">${t.direction === 'debit' ? '−' : '+'}${inrExact(t.amount)}</span>
      </div>`).join('') || '<p class="empty">Nothing on this day.</p>';
    showView('day');
  }

  function renderTxn(fp) {
    const t = txns.find((x) => x.fingerprint === fp);
    if (!t) return;
    openTxn = t;
    $('#txnTitle').textContent = `${inrExact(t.amount)} · ${t.merchant || 'Unknown'}`;
    const fact = (k, v) => `<div class="row"><div class="row-main"><span class="row-sub">${k}</span>
      <strong>${esc(v)}</strong></div></div>`;
    $('#txnFacts').innerHTML = [
      fact('When', new Date(t.date).toLocaleString('en-IN')),
      fact('Kind', t.kind + (t.kind === 'transfer' ? ' — excluded from spending' : '')),
      fact('Channel', t.channel),
      t.bank ? fact('Bank', t.bank) : '',
      t.account ? fact('Account', '••' + t.account) : '',
      t.ref ? fact('Reference', t.ref) : '',
      fact('Category source', t.categorySource || 'unset'),
      fact('Confidence', Math.round((t.confidence || 0) * 100) + '%'),
    ].filter(Boolean).join('');

    $('#txnCatHint').textContent = t.merchant
      ? `Choosing a category teaches Sandeshika about "${t.merchant}".`
      : 'No merchant was read from this message, so only this transaction can be changed.';
    $('#catScope').disabled = !t.merchant;
    if (!t.merchant) $('#catScope').value = 'one';

    const KIND_LABEL = { expense: 'Spending', income: 'Income',
                         refund: 'Refund', transfer: 'Transfer (own accounts)' };
    $('#kindChips').innerHTML = SandeshikaApi.KINDS.map((k) => `
      <button class="chip kind ${k === t.kind ? 'sel' : ''}" data-kind="${k}">${KIND_LABEL[k]}</button>`).join('');
    $('#kindSaveState').innerHTML = t.kindSource === 'user'
      ? '<span class="ok">You set this.</span>' : '';

    $('#catChips').innerHTML = allCategories().map((c) => `
      <button class="chip cat ${c === t.category ? 'sel' : ''}" data-cat="${c}">${c}</button>`).join('');
    $('#txnSaveState').innerHTML = '';
    $('#txnRaw').textContent = t.raw || '(not stored)';
    showView('txn');
  }

  async function setTxnKind(kind) {
    const t = openTxn;
    if (!t) return;
    const el = $('#kindSaveState');
    el.innerHTML = '<span class="warn">Saving…</span>';
    try {
      const wide = $('#catScope').value === 'merchant' && !!t.merchant;
      const r = await SandeshikaApi.setKind(t, kind, { merchantWide: wide });
      el.innerHTML = `<span class="ok">Counted as ${esc(kind)}`
        + (r.updated > 1 ? ` — ${r.updated} transactions from "${esc(t.merchant)}" updated` : '')
        + '.</span>';
      await reload();
      renderTxn(t.fingerprint);
      if (openDay) renderDay(openDay);
      showView('txn');
    } catch (e) {
      el.innerHTML = `<span class="err">${esc(friendly(e))}</span>`;
    }
  }

  async function setCategory(cat) {
    const t = openTxn;
    if (!t) return;
    const el = $('#txnSaveState');
    el.innerHTML = '<span class="warn">Saving…</span>';
    try {
      if ($('#catScope').value === 'one' || !t.merchant) {
        // Same kind rule as the bulk path, so a one-off correction and a
        // merchant-wide one can never disagree about whether it is spending.
        const next = { ...t, category: cat, categorySource: 'user',
                       kind: SandeshikaApi.kindFor(cat, t),
                       needsReview: false, reviewed: true };
        await api('/store/' + SandeshikaApi.Keys.txn(t.fingerprint),
                  { method: 'PUT', body: JSON.stringify(next) });
        el.innerHTML = '<span class="ok">Saved for this transaction.</span>';
      } else {
        const r = await SandeshikaApi.correctCategory(t.merchant, cat);
        el.innerHTML = `<span class="ok">Saved. ${r.updated} past transaction`
          + `${r.updated === 1 ? '' : 's'} from "${esc(t.merchant)}" updated, and future `
          + 'ones will use it too.</span>';
      }
      await reload();
      renderTxn(t.fingerprint);
      if (openDay) renderDay(openDay);
      showView('txn');
    } catch (e) {
      el.innerHTML = `<span class="err">${esc(friendly(e))}</span>`;
    }
  }

  async function renderLearned() {
    try {
      const rules = await SandeshikaApi.learnedRules();
      $('#learnedList').innerHTML = rules.length ? rules.map((r) => `
        <div class="row" data-mk="${esc(r.merchantKey)}">
          <span class="dot" style="background:${CAT_COLOR[r.category] || '#A0AAB6'}"></span>
          <div class="row-main">
            <strong>${esc(r.merchant || r.merchantKey)}</strong>
            <span class="row-sub">${esc(r.category)}${r.at ? ' · ' + fmtDate(r.at) : ''}</span>
          </div>
          <button class="mini no" data-forget="1">Forget</button>
        </div>`).join('')
        : '<p class="empty">Nothing yet. Correct a category on any transaction and it appears here.</p>';
    } catch (e) { /* Setup still usable without it */ }
  }

  // ------------------------------ boot ------------------------------
  async function reload() {
    try {
      txns = await loadTransactions();
      const cats = [...new Set(txns.map((t) => t.category).filter(Boolean))].sort();
      $('#filterCat').innerHTML = '<option value="">All categories</option>' +
        cats.map((c) => `<option value="${c}">${c}</option>`).join('');
      render();
      renderLearned();
      loadCustomCats();
      $('#subtitle').textContent = txns.length
        ? `${txns.length} transactions · all on this device`
        : 'Spending, bills and highlights from your messages';
    } catch (e) {
      // Raw status codes are not an error message; friendly() names the fix.
      banner(friendly(e), 'error');
    }
  }

  let cfg = {};

  function renderSettingsForm() {
    const url = $('#medhaUrl'), tok = $('#tokenInput'), hint = $('#tokenHint');

    if (cfg.mock) {
      url.value = 'mock'; url.disabled = true;
      tok.disabled = true; $('#btnSaveToken').disabled = true;
      $('#btnClearSaved').hidden = true;
      hint.textContent = 'Demo mode — no token needed.';
      return;
    }

    // Never disabled. An earlier build locked this field whenever MEDHA_TOKEN
    // was in the environment, which left anyone with a stale env token unable
    // to fix it from the only screen that offers to.
    url.disabled = false; tok.disabled = false; $('#btnSaveToken').disabled = false;
    url.value = cfg.medhaUrl || cfg.defaultMedhaUrl || 'http://127.0.0.1:8001';

    const parts = [];
    if (cfg.tokenConfigured) {
      tok.placeholder = 'saved — leave blank to keep';
      parts.push(`Using token ${cfg.tokenPreview} (${
        cfg.tokenSource === 'saved' ? 'saved here' : 'from the environment'}).`);
      parts.push('Type a new one to replace it.');
    } else {
      tok.placeholder = 'paste token';
      parts.push('No token yet — paste one from Medha → API clients.');
    }
    if (cfg.tokenSource === 'saved' && cfg.envTokenPresent) {
      parts.push('This overrides MEDHA_TOKEN from the environment.');
    }
    hint.textContent = parts.join(' ');
    $('#btnClearSaved').hidden = !(cfg.tokenSource === 'saved' || cfg.urlSource === 'saved');
  }

  /**
   * Names the failing layer instead of leaving us to guess.
   *
   * Four things sit between a tap and an answer: the transport (native bridge
   * or Flask proxy), the Sandeshika server, Medha itself, and the token. A
   * single "Failed to fetch" is consistent with all four, which is why the same
   * symptom has been chased through the wrong layer more than once.
   */
  async function diagnose() {
    const out = $('#diagOut');
    out.hidden = false;
    const lines = [];
    const step = async (label, fn) => {
      try {
        const r = await fn();
        lines.push(`PASS  ${label}${r ? '  ' + r : ''}`);
        return true;
      } catch (e) {
        lines.push(`FAIL  ${label}\n        ${e.message}`);
        return false;
      } finally {
        out.textContent = lines.join('\n');
      }
    };

    lines.push(`page build  : ${BUILD}`);
    lines.push(`transport   : ${Transport.native ? 'native bridge (APK)' : 'HTTP proxy (browser)'}`);
    if (Transport.native) {
      const missing = ['getConfig', 'saveSettings', 'clearSettings', 'request', 'detect']
        .filter((m) => typeof window.AndroidMedha[m] !== 'function');
      lines.push(missing.length
        ? `bridge      : MISSING ${missing.join(', ')} — the APK and its web assets are out of step`
        : 'bridge      : all methods present');
    }
    out.textContent = lines.join('\n');

    let cfg2 = null;
    await step('read configuration', async () => {
      cfg2 = await Transport.config();
      return `address ${cfg2.medhaUrl}, token ${cfg2.tokenConfigured ? cfg2.tokenPreview : 'NOT SET'}`;
    });

    const reachable = await step('Medha /health', async () => {
      const h = await api('/health');
      return `model ${h.modelLoaded ? 'loaded' : 'NOT loaded'}, backend ${h.backend || '?'}`;
    });

    if (reachable) {
      await step('token accepted (/store)', async () => {
        await api('/store?prefix=meta/&limit=1');
        return 'yes';
      });
      await step('SMS connector', async () => {
        const st = await api('/connectors/sms/status');
        if (st.supported === false) throw new Error('this Medha build has no SMS connector — install the "full" APK');
        if (!st.canRead) throw new Error('Medha lacks Android\'s SMS permission — Medha → menu → SMS connector → Grant');
        return `${st.totalMessages} messages visible`;
      });
      await step('read one page of messages', async () => {
        const p = await api('/connectors/sms/messages?limit=5');
        if (!p.messages.length) throw new Error('the connector returned no messages at all');
        return `${p.messages.length} returned, newest ${new Date(p.messages[0].date).toLocaleString()}`;
      });
    } else {
      await step('scan for Medha', async () => {
        const d = await Transport.detect();
        if (!d.found || !d.found.length) throw new Error('nothing answered on any common port');
        return d.found.map((f) => f.url).join(', ');
      });
    }
    out.textContent = lines.join('\n') + '\n\nSend this text if you need help — it contains no personal data.';
  }

  async function saveSettings() {
    const el = $('#connState');
    const btn = $('#btnSaveToken');
    btn.disabled = true;
    el.innerHTML = '<span class="warn">Checking…</span>';
    try {
      // Transport picks the native bridge (APK) or the Flask proxy (browser).
      // Calling fetch('/settings') directly worked in the browser and failed in
      // the APK, where there is no server to answer it.
      await Transport.saveSettings($('#medhaUrl').value.trim(), $('#tokenInput').value.trim());
      $('#tokenInput').value = '';
      banner('Connected to Medha');
      cfg = await Transport.config();
      renderSettingsForm();
      await checkConnection();
      await reload();
    } catch (e) {
      el.innerHTML = `<span class="err">${esc(friendly(e))}</span>`;
    } finally {
      btn.disabled = false;
    }
  }

  async function checkConnection() {
    const el = $('#connState');
    try {
      cfg = await Transport.config();
      renderSettingsForm();
      if (!cfg.mock && !cfg.tokenConfigured) {
        el.innerHTML = '<span class="warn">No token saved yet — paste one above.</span>';
        return false;
      }
      const h = await api('/health');
      if (cfg.mock) {
        el.innerHTML = '<span class="warn">Demo mode — synthetic inbox, mock model. '
          + 'Figures are computed for real from generated messages.</span>';
        return true;
      }
      if (!h.modelLoaded) {
        el.innerHTML = '<span class="warn">Medha is reachable but no model is loaded.</span>';
        return false;
      }
      await api('/store?prefix=meta/&limit=1');   // proves the token is accepted

      // Check SMS access now, while the user is on the screen that explains it.
      let sms = '';
      try {
        const st = await api('/connectors/sms/status');
        if (st.supported === false) {
          sms = '<br><span class="err">No SMS connector in this Medha build — install the "full" APK.</span>';
        } else if (!st.canRead) {
          sms = '<br><span class="warn">Medha lacks Android\'s SMS permission. '
              + 'Medha → menu → SMS connector → Grant.</span>';
        } else {
          sms = `<br><span class="ok">SMS access OK · ${st.totalMessages} messages visible</span>`;
        }
      } catch (e) {
        sms = (e && e.status === 403)
          ? '<br><span class="err">This client cannot read SMS. Medha → API clients → '
            + 'Edit permissions → tick "Read SMS".</span>'
          : `<br><span class="warn">${esc(friendly(e))}</span>`;
      }
      // Version check. A service worker serving stale JS is invisible from the
      // inside, and cost days of debugging behaviour the device was not
      // running. Comparing the page's build against the server's makes it loud.
      let ver = '';
      if (cfg.version && cfg.version !== BUILD) {
        ver = `<br><span class="err">This page is build ${BUILD} but the server is `
            + `${esc(cfg.version)} — an old copy is cached. Pull down to refresh, or `
            + 'reinstall the app.</span>';
      } else if (cfg.version) {
        ver = `<br><span class="row-sub">build ${esc(cfg.version)}</span>`;
      }
      el.innerHTML = `<span class="ok">Connected to ${esc(cfg.medhaUrl)} · model loaded</span>${sms}${ver}`;
      if (!cfg.installable) {
        banner('Open via localhost or HTTPS to install as an app', 'info');
      }
      return true;
    } catch (e) {
      el.innerHTML = `<span class="err">${esc(friendly(e))}</span>`;
      return false;
    }
  }

  // ------------------------------ events ------------------------------
  function activate(view) {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    const tab = document.querySelector(`.tab[data-view="${view}"]`);
    if (tab) tab.classList.add('active');
    else $('#btnMenu').classList.add('active');
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + view).classList.remove('hidden');
    if ((view === 'inbox' || view === 'bills') && !inbox.length) loadInbox();
  }

  $('#btnMenu').addEventListener('click', () => $('#menuSheet').classList.remove('hidden'));
  $('#btnMenuClose').addEventListener('click', () => $('#menuSheet').classList.add('hidden'));
  $('#menuSheet').addEventListener('click', (e) => {
    if (e.target.id === 'menuSheet') $('#menuSheet').classList.add('hidden');
    const item = e.target.closest('.sheet-item[data-view]');
    if (item) { $('#menuSheet').classList.add('hidden'); activate(item.dataset.view); }
  });

  $('#btnAddCat').addEventListener('click', async () => {
    const v = $('#newCat').value.trim().toLowerCase();
    if (!/^[a-z][a-z0-9 &-]{1,23}$/.test(v)) return banner('Use 2-24 letters, digits, spaces or &-', 'error');
    if (allCategories().includes(v)) return banner('That category already exists', 'error');
    customCats.push(v);
    try { await saveCustomCats(); $('#newCat').value = ''; banner(`Added "${v}"`); }
    catch (e) { customCats.pop(); banner(friendly(e), 'error'); }
  });
  $('#customCatList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-delcat]');
    if (!b) return;
    const c = b.closest('.row').dataset.cat;
    customCats = customCats.filter((x) => x !== c);
    try { await saveCustomCats(); banner(`Removed "${c}"`); }
    catch (err) { banner(friendly(err), 'error'); }
  });

  $$('.tab[data-view]').forEach((t) => t.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active'));
    t.classList.add('active');
    // Lazily: reading 400 messages on boot would slow the first paint for
    // someone who only wants the spending summary.
    activate(t.dataset.view);
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

  // inbox
  $('#btnLoadInbox').addEventListener('click', () => loadInbox());
  $('#inboxSearch').addEventListener('input', () => { inboxLimit = 40; renderInbox(); });
  $('#inboxMore').addEventListener('click', () => { inboxLimit += 60; renderInbox(); });
  $$('#inboxTabs .chip').forEach((c) => c.addEventListener('click', () => {
    box = c.dataset.box; inboxLimit = 40; renderInbox();
  }));
  $('#billList').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-bill]');
    if (b) setBillStatus(b.closest('.row').dataset.fp, 'paid');
  });
  $('#billDone').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-bill]');
    if (b) setBillStatus(b.closest('.row').dataset.fp, 'open');
  });

  // export
  $('#btnExportCsv').addEventListener('click', exportCsv);
  $('#btnExportJson').addEventListener('click', exportJson);

  // daily + drill-down
  $$('#dailyPeriod .chip').forEach((c) => c.addEventListener('click', () => {
    $$('#dailyPeriod .chip').forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel'); dPeriod = c.dataset.dperiod; renderDaily();
  }));
  $('#dayList').addEventListener('click', (e) => {
    const row = e.target.closest('.day-row');
    if (row) renderDay(row.dataset.day);
  });
  $('#dayTxns').addEventListener('click', (e) => {
    const row = e.target.closest('.txn-row');
    if (row) renderTxn(row.dataset.fp);
  });
  $('#kindChips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (b) setTxnKind(b.dataset.kind);
  });
  $('#catChips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cat]');
    if (b) setCategory(b.dataset.cat);
  });
  $('#btnBackDaily').addEventListener('click', () => { renderDaily(); showView('daily'); });
  $('#btnBackDay').addEventListener('click', () => {
    if (openDay) { renderDay(openDay); } else { renderDaily(); showView('daily'); }
  });
  $('#learnedList').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-forget]');
    if (!b) return;
    const mk = b.closest('.row').dataset.mk;
    if (!confirm(`Forget the category you set for "${mk}"? Past transactions keep their current label.`)) return;
    try { await SandeshikaApi.forgetRule(mk); banner('Forgotten'); renderLearned(); }
    catch (err) { banner(friendly(err), 'error'); }
  });

  $('#btnAllDays').addEventListener('click', () => activate('daily'));
  $('#dashDays').addEventListener('click', (e) => {
    const row = e.target.closest('.day-row');
    if (row) { activate('daily'); renderDay(row.dataset.day); }
  });
  $('#attentionList').addEventListener('click', (e) => {
    if (e.target.id === 'btnShowPairs') return showPairs();
    const b = e.target.closest('button[data-pair]');
    if (!b) return;
    const row = b.closest('.pair-row');
    if (b.dataset.pair === 'yes') markPairAsTransfer(Number(row.dataset.i));
    else { row.remove(); }
  });

  $('#btnAsk').addEventListener('click', ask);
  $$('.chip.q').forEach((c) => c.addEventListener('click', () => {
    $('#askInput').value = c.textContent;
    ask();
  }));

  $('#btnDetect').addEventListener('click', async () => {
    const el = $('#connState');
    el.innerHTML = '<span class="warn">Scanning the usual ports…</span>';
    try {
      const r = await Transport.detect();
      if (!r.found || !r.found.length) {
        el.innerHTML = '<span class="err">No Medha found on '
          + esc((r.tried || []).join(', '))
          + '. Check the port shown in the Medha app, and that it is running.</span>';
        return;
      }
      // Prefer one that already accepts the saved token.
      const best = r.found.find((f) => f.tokenOk) || r.found[0];
      $('#medhaUrl').value = best.url;
      el.innerHTML = `<span class="ok">Found Medha at ${esc(best.url)}`
        + (best.modelLoaded ? ' · model loaded' : ' · no model loaded')
        + (best.tokenOk === false ? ' · saved token rejected, paste a new one' : '')
        + '</span>';
      if (best.tokenOk) await saveSettings();
    } catch (e) {
      el.innerHTML = `<span class="err">${esc(friendly(e))}</span>`;
    }
  });

  $('#btnDiagnose').addEventListener('click', diagnose);
  $('#btnSaveToken').addEventListener('click', saveSettings);
  $('#btnClearSaved').addEventListener('click', async () => {
    if (!confirm('Forget the saved token and address, and fall back to how the server was started?')) return;
    try {
      await Transport.clearSettings();
      banner('Saved settings cleared');
      await checkConnection();
    } catch (e) { banner(friendly(e), 'error'); }
  });
  $('#tokenInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
  $('#medhaUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveSettings(); });
  $('#btnRecheck').addEventListener('click', async () => {
    if (await checkConnection()) { banner('Connected'); reload(); }
  });

  $('#btnCopyDrift')?.addEventListener('click', async () => {
    const text = (window.__drift || [])
      .map((d) => `${d.sender} [${d.reason}] x${d.count}\n${d.body}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); banner('Copied'); }
    catch (_) { banner('Could not copy', 'error'); }
  });

  $('#btnImport').addEventListener('click', () => runImport(false));
  $('#btnRestart').addEventListener('click', () => {
    if (confirm('Read every message again from the beginning? Existing transactions are kept and duplicates skipped.')) {
      runImport(true);
    }
  });
  $('#btnStop').addEventListener('click', () => { stopRequested = true; });

  $('#btnRefresh').addEventListener('click', async () => {
    const btn = $('#btnRefresh');
    btn.classList.add('spin');
    try {
      const r = await catchUp();
      banner(r.written ? `${r.written} new transactions` : 'Up to date');
      if (r.written) reload();
    } catch (e) {
      banner(friendly(e), 'error');
    } finally {
      btn.classList.remove('spin');
    }
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
    if (!confirm('Delete every transaction and category Sandeshika has stored? Your SMS are untouched.')) return;
    try {
      const rows = await SandeshikaApi.listPrefix('txn/', 100000);
      for (const r of rows) await api('/store/' + r.key, { method: 'DELETE' }).catch(() => {});
      Store.reset();
      txns = [];
      render();
      banner('All Sandeshika data deleted');
    } catch (e) { banner(friendly(e), 'error'); }
  });

  renderImportHint();

  (async () => {
    const connected = await checkConnection();
    await reload();
    if (!connected || !txns.length) {
      activate('setup');
    }
  })();
})();
