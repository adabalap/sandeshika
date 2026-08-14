/*
 * Transport shim.
 *
 * The same UI runs in two places:
 *   - inside the Sandeshika APK, where a native bridge does the HTTP; and
 *   - behind the Flask server, where /api is a reverse proxy.
 *
 * Both keep the API token out of JavaScript. This file hides the difference so
 * app.js and api.js never branch on it.
 */
(function () {
  const native = typeof window.AndroidMedha !== 'undefined';

  // Native calls are fire-and-forget with a request id; the bridge evaluates
  // window.__medhaResolve when it finishes. This wraps that back into a Promise.
  const pending = new Map();
  let seq = 0;

  window.__medhaResolve = function (id, payload) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    let parsed;
    try { parsed = JSON.parse(payload); }
    catch (e) { entry.reject(new Error('malformed bridge reply')); return; }
    entry.resolve(parsed);
  };

  function nativeCall(fn, ...args) {
    const id = 'r' + (++seq);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // A hung native call must not leave the UI waiting forever.
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Medha did not respond in time'));
        }
      }, 200000);
      try { window.AndroidMedha[fn](id, ...args); }
      catch (e) { pending.delete(id); reject(e); }
    });
  }

  /** Mirrors the fetch() shape the rest of the code already expects. */
  function toResponse(r) {
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: () => null },
      json: async () => (r.body ? JSON.parse(r.body) : null),
      text: async () => r.body || '',
    };
  }

  window.Transport = {
    native,

    /** path is like '/health' or '/store?prefix=txn/' */
    async api(path, opts = {}) {
      if (!native) {
        return fetch('/api' + path, opts);
      }
      const clean = path.replace(/^\//, '');
      const priority = (opts.headers && opts.headers['X-Medha-Priority']) || '';
      const r = await nativeCall('request', opts.method || 'GET', clean, opts.body || null, priority);
      return toResponse(r);
    },

    async config() {
      if (!native) return fetch('/config.json').then((r) => r.json());
      return JSON.parse(window.AndroidMedha.getConfig());
    },

    async saveSettings(medhaUrl, token) {
      if (!native) {
        const r = await fetch('/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ medhaUrl, token }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      }
      const r = await nativeCall('saveSettings', medhaUrl, token);
      const j = r.body ? JSON.parse(r.body) : {};
      if (r.status < 200 || r.status >= 300) throw new Error(j.error || ('HTTP ' + r.status));
      return j;
    },

    async detect() {
      if (!native) return fetch('/detect').then((r) => r.json());
      const r = await nativeCall('detect');
      return r.body ? JSON.parse(r.body) : { found: [] };
    },

    async clearSettings() {
      if (!native) return fetch('/settings', { method: 'DELETE' }).then((r) => r.json());
      const r = await nativeCall('clearSettings');
      return r.body ? JSON.parse(r.body) : {};
    },
  };
})();
