/**
 * Sandeshika — DOM helpers.
 *
 * Thin on purpose. The views build HTML strings and hand them to `setHtml`;
 * anything user-derived is escaped by the caller with `esc` from core/format.
 */

/** @param {string} sel @returns {HTMLElement|null} */
export const $ = (sel) => /** @type {HTMLElement|null} */ (document.querySelector(sel));

/** @param {string} sel @returns {HTMLElement[]} */
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/**
 * Every write goes through here so a renamed element fails loudly in the
 * console instead of silently painting nothing. A view referring to an id that
 * no longer exists in index.html is a real bug and used to be invisible.
 * @param {string} sel
 * @param {string} html
 */
export function setHtml(sel, html) {
  const el = $(sel);
  if (!el) {
    console.warn(`setHtml: no element matches ${sel}`);
    return;
  }
  el.innerHTML = html;
}

/** @param {string} sel @param {string} text @param {string} [title] */
export function setText(sel, text, title) {
  const el = $(sel);
  if (!el) {
    console.warn(`setText: no element matches ${sel}`);
    return;
  }
  el.textContent = text;
  if (title !== undefined) el.title = title;
}

/** @param {string} sel @param {boolean} hidden */
export function setHidden(sel, hidden) {
  const el = $(sel);
  if (el) el.hidden = hidden;
}

/** @param {string} sel @param {string} cls @param {boolean} on */
export function toggleClass(sel, cls, on) {
  const el = $(sel);
  if (el) el.classList.toggle(cls, on);
}

/**
 * Delegated listener. Views bind once to a container rather than to rows that
 * are replaced on every render — the old code rebuilt innerHTML and relied on
 * the container listener surviving, which worked, but only by accident of
 * where each `addEventListener` happened to sit.
 * @param {string} containerSel
 * @param {string} childSel
 * @param {string} evt
 * @param {(el: HTMLElement, e: Event) => void} fn
 */
export function delegate(containerSel, childSel, evt, fn) {
  const c = $(containerSel);
  if (!c) return;
  c.addEventListener(evt, (e) => {
    const target = /** @type {HTMLElement} */ (e.target);
    const hit = target && target.closest ? target.closest(childSel) : null;
    if (hit && c.contains(hit)) fn(/** @type {HTMLElement} */ (hit), e);
  });
}

/** @param {string} sel @param {string} evt @param {(e: Event) => void} fn */
export function on(sel, evt, fn) {
  const el = $(sel);
  if (el) el.addEventListener(evt, fn);
}

/** @param {string} sel @returns {string} */
export const val = (sel) => {
  const el = /** @type {HTMLInputElement|HTMLSelectElement|null} */ (document.querySelector(sel));
  return el ? el.value : '';
};

/** @param {string} sel @param {string} v */
export const setVal = (sel, v) => {
  const el = /** @type {HTMLInputElement|null} */ (document.querySelector(sel));
  if (el) el.value = v;
};

/*
 * Toasts.
 *
 * The previous build had a single banner element: a second message overwrote
 * the first, so an import that reported "3 new transactions" immediately
 * replaced the error explaining why the other forty failed. A stack shows both,
 * newest at the bottom, and errors stay until dismissed because an error the
 * user did not read is an error that will be hit again.
 */
const TOAST_MS = { info: 4000, success: 4000, error: 0, progress: 0 };
const MAX_TOASTS = 3;

/** @param {string} id */
export function dismissToast(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('leaving');
  // Matches the CSS transition. Removing immediately makes messages disappear
  // rather than leave, which reads as a glitch.
  setTimeout(() => el.remove(), 180);
}

/**
 * @param {string} msg
 * @param {'info'|'success'|'error'|'progress'} [kind]
 * @param {{action?: {label: string, onClick: () => void}, id?: string}} [opts]
 * @returns {string} the toast id, so a progress toast can be replaced later
 */
export function toast(msg, kind = 'info', opts = {}) {
  const host = $('#toasts');
  if (!host) {
    console.warn('toast: no #toasts host —', msg);
    return '';
  }

  const id = opts.id || 'toast-' + Math.random().toString(36).slice(2, 9);
  const existing = document.getElementById(id);

  const el = existing || document.createElement('div');
  el.id = id;
  el.className = `toast ${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  // Errors interrupt; everything else is announced when the reader is idle.
  el.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  el.textContent = '';

  const body = document.createElement('span');
  body.className = 'toast-msg';
  body.textContent = msg;
  el.appendChild(body);

  const action = opts.action;
  if (action) {
    const btn = document.createElement('button');
    btn.className = 'toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      dismissToast(id);
    });
    el.appendChild(btn);
  }

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => dismissToast(id));
  el.appendChild(close);

  if (!existing) host.appendChild(el);

  // Oldest first: a burst of messages should leave the most recent readable.
  while (host.children.length > MAX_TOASTS && host.firstChild) {
    host.removeChild(host.firstChild);
  }

  const ms = TOAST_MS[kind];
  if (ms) setTimeout(() => dismissToast(id), ms);
  return id;
}

/**
 * Kept as `banner` so every existing call site reads the same. Maps the old
 * two-state vocabulary onto the toast stack.
 * @param {string} msg
 * @param {'info'|'error'|'success'} [kind]
 * @param {{action?: {label: string, onClick: () => void}}} [opts]
 */
export const banner = (msg, kind = 'info', opts = {}) => toast(msg, kind, opts);

/*
 * Skeletons.
 *
 * A spinner says "something is happening"; a skeleton says "a list of rows is
 * coming, and roughly this many". On a first import over adb the difference is
 * several seconds of the user wondering whether the tap registered.
 */
export function skeleton(rows = 3) {
  return `<div class="skeleton-list" aria-hidden="true">${
    Array.from({ length: rows }, () => `
      <div class="skeleton-row">
        <span class="sk sk-dot"></span>
        <span class="sk sk-line"></span>
        <span class="sk sk-amt"></span>
      </div>`).join('')
  }</div>`;
}

/** @param {string} sel @param {number} [rows] */
export const showSkeleton = (sel, rows = 3) => setHtml(sel, skeleton(rows));

/** @param {string} name */
export function showView(name) {
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const v = $('#view-' + name);
  if (v) v.classList.remove('hidden');
}

/** Triggers a client-side file download. */
export function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
