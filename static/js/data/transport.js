/**
 * Sandeshika — transport.
 *
 * THIS MODULE WAS MISSING. The previous build referenced a global `Transport`
 * in twelve places — configuration, save, clear, detect and the whole
 * diagnostics screen — and nothing ever defined it. Every one of those paths
 * threw `ReferenceError: Transport is not defined` at runtime. Because the
 * boot sequence calls `checkConnection()` inside a try/catch, the error was
 * swallowed and the app simply fell back to the Setup screen with a confusing
 * message, on every single launch, no matter how healthy the backend was.
 *
 * There are two ways this app can reach Medha, and they are not
 * interchangeable:
 *
 *   1. BROWSER. The page is served by the Flask host, which proxies /api/* to
 *      Medha and attaches the token server-side. Configuration is read from
 *      /config.json and written to /settings.
 *
 *   2. APK. The page is loaded inside an Android WebView that injects
 *      `window.AndroidMedha`. There is no Flask server at all, so fetching
 *      '/settings' returns the app shell (or a 404) rather than doing anything
 *      — which is precisely the bug that made a working browser build fail
 *      silently once wrapped.
 *
 * Everything above this layer calls the same five methods and never has to
 * know which one is live.
 */

/** @typedef {import('../core/types.js').AppConfig} AppConfig */
/** @typedef {import('../core/types.js').DetectResult} DetectResult */

/**
 * The Android bridge, when present. Methods are `@JavascriptInterface` calls,
 * which return synchronously as JSON strings.
 * @typedef {object} AndroidBridge
 * @property {() => string} getConfig                Instant: reads local preferences.
 * @property {() => string} clearSettings            Instant: clears local preferences.
 * @property {(method: string, path: string, body: string|null, headers: string, callId: string) => void} [requestAsync]
 * @property {(url: string, token: string, callId: string) => void} [saveSettingsAsync]
 * @property {(callId: string) => void} [detectAsync]
 * @property {(method: string, path: string, body: string|null, headers: string) => string} [request]      Legacy, blocking.
 * @property {(url: string, token: string) => string} [saveSettings]                                        Legacy, blocking.
 * @property {() => string} [detect]                                                                        Legacy, blocking.
 */

/**
 * What a usable bridge must provide.
 *
 * getConfig and clearSettings read local preferences and return instantly, so
 * they are synchronous. Everything that touches the network has an *Async
 * variant, because a @JavascriptInterface call BLOCKS the JavaScript thread
 * until Kotlin returns — and a cold model load on the phone takes minutes. A
 * synchronous bridge would freeze the entire interface for the duration, with
 * no scrolling and no cancel button, and end in an ANR.
 */
const BRIDGE_METHODS = /** @type {const} */ (
  ['getConfig', 'clearSettings', 'requestAsync', 'saveSettingsAsync', 'detectAsync']
);

/*
 * Async bridge plumbing.
 *
 * Kotlin cannot hand a Promise back across the JNI boundary, so the call is
 * given an id, returns immediately, and the native side later invokes
 * window.__medhaResolve(id, json) on the UI thread.
 */
/** @type {Map<string, {resolve: (v: any) => void, reject: (e: Error) => void, timer: any}>} */
const pending = new Map();
let callSeq = 0;

/** Installed once, on the first async call. */
function installResolver() {
  if (/** @type {any} */ (globalThis).__medhaResolve) return;
  /** @type {any} */ (globalThis).__medhaResolve = (callId, json) => {
    const entry = pending.get(callId);
    if (!entry) return; // already timed out, or a late duplicate
    pending.delete(callId);
    clearTimeout(entry.timer);
    try {
      entry.resolve(json == null || json === '' ? {} : JSON.parse(String(json)));
    } catch {
      entry.reject(new Error('The Android bridge returned something unreadable.'));
    }
  };
}

/**
 * Calls an async bridge method and waits for the native resolve.
 * @param {string} method
 * @param {unknown[]} args
 * @param {number} ms
 */
function bridgeCall(method, args, ms) {
  installResolver();
  const b = /** @type {any} */ (globalThis).AndroidMedha;
  const callId = `c${++callSeq}_${Date.now().toString(36)}`;

  return new Promise((resolve, reject) => {
    // A native side that dies mid-call would otherwise leave this pending
    // forever, with the UI stuck on a spinner and no way back.
    const timer = setTimeout(() => {
      pending.delete(callId);
      const e = /** @type {Error & {status?: number}} */ (
        new Error(`No response from Medha after ${Math.round(ms / 1000)}s.`));
      e.status = 504;
      reject(e);
    }, ms);

    pending.set(callId, { resolve, reject, timer });

    try {
      b[method](...args, callId);
    } catch (e) {
      pending.delete(callId);
      clearTimeout(timer);
      reject(/** @type {Error} */ (e));
    }
  });
}

/**
 * Fetches a legacy blocking method, failing with a message that names the
 * cause. A bridge missing both generations of a method means the APK and its
 * bundled web assets have drifted out of step, and the symptom otherwise is
 * one screen quietly not working.
 * @param {any} b
 * @param {'request'|'saveSettings'|'detect'} name
 * @returns {(...args: any[]) => string}
 */
function legacy(b, name) {
  const fn = b && b[name];
  if (typeof fn !== 'function') {
    throw new Error(`This app's bridge provides neither ${name} nor ${name}Async. `
      + 'The APK and its web assets are out of step — reinstall the app.');
  }
  return fn.bind(b);
}

/** True when the bridge exposes the non-blocking variants. */
const hasAsync = () => {
  const b = /** @type {any} */ (globalThis).AndroidMedha;
  return Boolean(b && typeof b.requestAsync === 'function');
};

/**
 * @returns {AndroidBridge|null}
 *
 * Either generation counts. Gating on `request` alone meant an async-only
 * bridge — the one the current APK ships — was not detected at all, and every
 * call fell through to fetch() against an origin with no server behind it.
 */
function bridge() {
  const b = /** @type {any} */ (globalThis).AndroidMedha;
  if (!b) return null;
  return (typeof b.requestAsync === 'function' || typeof b.request === 'function') ? b : null;
}

/**
 * A bridge method may return a JSON string (the usual case) or, in newer
 * WebView versions, a promise. Normalise both, and never let a malformed
 * reply surface as an unhelpful "unexpected token" parse error.
 * @param {unknown} raw
 * @param {string} label
 */
async function decode(raw, label) {
  const v = await Promise.resolve(raw);
  if (v == null || v === '') return {};
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(String(v));
  } catch {
    throw new Error(`The Android bridge returned something unreadable from ${label}.`);
  }
}

/**
 * A request that never returns is worse than one that fails: the import button
 * stays disabled, the spinner spins, and the user has no way to tell whether
 * anything is happening. Every call gets a ceiling.
 *
 * Generation is slow on a phone and a cold model load genuinely takes minutes,
 * so that path gets its own much longer budget rather than dragging the
 * default up for everything.
 */
const DEFAULT_TIMEOUT_MS = 20000;
const SLOW_PATHS = [/^\/generate/, /^\/chat/, /^\/rag\//];
const SLOW_TIMEOUT_MS = 180000;

const timeoutFor = (path) => (SLOW_PATHS.some((re) => re.test(path))
  ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

/**
 * Wraps fetch with an abort deadline, and turns the abort into an error that
 * names the wait rather than the mechanism — "signal is aborted without
 * reason" tells a user nothing.
 */
async function fetchWithTimeout(url, opts = {}, ms = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') {
      const err = /** @type {Error & {status?: number}} */ (
        new Error(`No response after ${Math.round(ms / 1000)}s. Medha may be busy or the connection dropped.`));
      err.status = 504;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Throws with the server's own error text rather than a bare status code. */
async function unwrap(res) {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch { /* non-JSON error body; the status is all we have */ }
    const e = /** @type {Error & {status?: number}} */ (new Error(msg));
    e.status = res.status;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

export const Transport = {
  /**
   * The browser's own view of connectivity.
   *
   * Only meaningful in a browser tab: inside the APK the "network" is a JNI
   * bridge to a service on the same device, so navigator.onLine says nothing
   * useful and is ignored.
   */
  get offline() {
    return !bridge() && typeof navigator !== 'undefined' && navigator.onLine === false;
  },

  /** True when running inside the APK's WebView. */
  get native() {
    return bridge() !== null;
  },

  /**
   * Bridge methods that are expected but absent — meaning the APK and its
   * bundled web assets have drifted out of step. Diagnostics reports this by
   * name, because the symptom (one screen quietly not working) points nowhere
   * near the cause.
   * @returns {string[]}
   */
  missingBridgeMethods() {
    const b = /** @type {any} */ (globalThis).AndroidMedha;
    if (!b) return [];
    return BRIDGE_METHODS.filter((m) => typeof b[m] !== 'function');
  },

  /** @returns {Promise<AppConfig>} */
  async config() {
    const b = bridge();
    if (b) return decode(b.getConfig(), 'getConfig');
    return unwrap(await fetchWithTimeout('/config.json', { cache: 'no-store' }, 8000));
  },

  /**
   * Persists the address and token. The token is written server-side (or into
   * Android's encrypted preferences) and never held in the page, so no script
   * on this origin can read it back.
   * @param {string} medhaUrl
   * @param {string} token
   */
  async saveSettings(medhaUrl, token) {
    const b = bridge();
    if (b) {
      // Saving verifies the token against a live Medha before persisting it,
      // so it is a network call however local it looks.
      const r = hasAsync()
        ? await bridgeCall('saveSettingsAsync', [medhaUrl, token], 30000)
        : await decode(legacy(b, 'saveSettings')(medhaUrl, token), 'saveSettings');
      if (r && r.error) throw new Error(r.error);
      return r;
    }
    // Saving verifies the token against Medha before persisting, so this is
    // allowed longer than an ordinary call.
    return unwrap(await fetchWithTimeout('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ medhaUrl, token }),
    }, 30000));
  },

  async clearSettings() {
    const b = bridge();
    if (b) return decode(b.clearSettings(), 'clearSettings');
    return unwrap(await fetchWithTimeout('/settings', { method: 'DELETE' }, 8000));
  },

  /**
   * Scans the ports Medha is usually on. Removes the single most common setup
   * failure: a correct token paired with the wrong port.
   * @returns {Promise<DetectResult>}
   */
  async detect() {
    const b = bridge();
    if (b) {
      // Six ports, each with its own probe timeout on the native side.
      return hasAsync()
        ? await bridgeCall('detectAsync', [], 45000)
        : /** @type {any} */ (await decode(legacy(b, 'detect')(), 'detect'));
    }
    // Six ports, each with its own probe timeout server-side.
    return unwrap(await fetchWithTimeout('/detect', {}, 45000));
  },

  /**
   * One API call to Medha, via whichever path is live.
   * @param {string} path Begins with '/', relative to the Medha API root.
   * @param {RequestInit} [opts]
   */
  async request(path, opts = {}) {
    const b = bridge();
    const method = (opts.method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', .../** @type {any} */ (opts.headers || {}) };

    if (b) {
      const body = /** @type {string|null} */ (opts.body ?? null);
      const r = hasAsync()
        ? /** @type {any} */ (await bridgeCall(
          'requestAsync', [method, path, body, JSON.stringify(headers)], timeoutFor(path)))
        : /** @type {any} */ (await decode(
          legacy(b, 'request')(method, path, body, JSON.stringify(headers)), 'request'));
      // The bridge reports HTTP failures in-band, since it cannot throw across
      // the JNI boundary. Re-raise them in the shape the rest of the app
      // already handles.
      if (r && typeof r.status === 'number' && r.status >= 400) {
        const e = /** @type {Error & {status?: number, retryAfter?: number}} */ (
          new Error(r.error || `HTTP ${r.status}`));
        e.status = r.status;
        e.retryAfter = Number(r.retryAfter || 0);
        throw e;
      }
      return r && r.body !== undefined ? r.body : r;
    }

    /*
     * All browser calls go to this app's own origin under /api, which Flask
     * proxies to Medha. Not a direct call to 127.0.0.1:8080, for two reasons:
     * CORS (Medha permits only its own loopback origins, so the page could
     * issue the request but never read the reply) and the token (proxying
     * keeps it in the server process instead of localStorage, where any script
     * could read it).
     */
    const res = await fetchWithTimeout('/api' + path, { ...opts, headers }, timeoutFor(path));
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j && j.error) msg = j.error;
      } catch { /* keep the status */ }
      const e = /** @type {Error & {status?: number, retryAfter?: number}} */ (new Error(msg));
      e.status = res.status;
      e.retryAfter = Number(res.headers.get('Retry-After') || 0);
      throw e;
    }
    if (res.status === 204) return null;
    return res.json();
  },
};

export default Transport;
