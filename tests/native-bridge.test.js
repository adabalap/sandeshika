/*
 * The native bridge contract.
 *
 * The bridge has two halves that are compiled by different toolchains, live in
 * different languages, and are only ever connected at runtime by string name:
 *
 *   app/src/main/java/.../MedhaBridge.kt   @JavascriptInterface methods
 *   static/js/data/transport.js            the calls into them
 *
 * Nothing checks that they agree. A renamed Kotlin method compiles cleanly, the
 * APK builds, installs and launches — and then one screen quietly does nothing,
 * because `window.AndroidMedha.detectAsync` is undefined. That is the worst
 * shape a bug can take: invisible on every machine except a real phone.
 *
 * This replaces an older check that grepped a bundled `assets/web/js/bridge.js`
 * for method names. That file no longer exists — the bridge moved into
 * transport.js in 2.0.0 and the assets are generated at build time rather than
 * committed. Grepping for names could only ever prove a string appeared
 * somewhere in a file; this compares the two sides against each other.
 *
 * Runs without an Android SDK: it reads source, it does not build anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KOTLIN = path.join(ROOT, 'app/src/main/java/com/adabala/sandeshika/MedhaBridge.kt');
const TRANSPORT = path.join(ROOT, 'static/js/data/transport.js');

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}\n     ${detail}`); }
}
const eq = (n, a, b) => ok(n, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
const read = (p) => fs.readFileSync(p, 'utf8');

if (!fs.existsSync(KOTLIN)) {
  // The web app is shipped and developed without the Android project present.
  console.log('\nSKIPPED — no Android project in this checkout.');
  console.log('\n' + '-'.repeat(50));
  console.log('passed=0  failed=0  (skipped)');
  process.exit(0);
}

const kotlin = read(KOTLIN);
const transport = read(TRANSPORT);

// ---------------------------------------------------------------------------
// 1. Every method the page calls exists on the native side
// ---------------------------------------------------------------------------

/** Method names carrying the @JavascriptInterface annotation. */
const exported = new Set(
  [...kotlin.matchAll(/@JavascriptInterface\s+fun\s+([A-Za-z][A-Za-z0-9]*)\s*\(/g)]
    .map((m) => m[1]),
);

ok('the Kotlin bridge exports methods', exported.size > 0,
  'no @JavascriptInterface methods found — did the annotation import change?');

/** The names transport.js treats as the required set. */
const requiredBlock = transport.match(/const BRIDGE_METHODS = [^;]*?\[([\s\S]*?)\]/);
ok('transport.js declares BRIDGE_METHODS', Boolean(requiredBlock));

const required = [...(requiredBlock ? requiredBlock[1] : '').matchAll(/'([^']+)'/g)]
  .map((m) => m[1]);

for (const name of required) {
  ok(`MedhaBridge.kt exports ${name}`, exported.has(name),
    `transport.js requires it and reports its absence to the user as a broken install.\n     `
    + `Kotlin exports: ${[...exported].join(', ')}`);
}

/*
 * The blocking fallbacks. A page cached from before the async bridge existed
 * still calls these, so removing them from Kotlin would break an upgrade for
 * anyone whose service worker had not refreshed yet.
 */
for (const name of ['request', 'saveSettings', 'detect']) {
  ok(`MedhaBridge.kt keeps the legacy ${name} for cached pages`, exported.has(name),
    'transport.js falls back to it when the async variant is absent');
}

// ---------------------------------------------------------------------------
// 2. Arity — a mismatch fails silently at the JNI boundary
// ---------------------------------------------------------------------------

/** @param {string} name */
function kotlinParams(name) {
  const m = kotlin.match(
    new RegExp(`@JavascriptInterface\\s+fun\\s+${name}\\s*\\(([^)]*)\\)`),
  );
  if (!m) return null;
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/*
 * Async methods take their own arguments PLUS a trailing callId. transport.js
 * appends it in bridgeCall(); if Kotlin does not accept it, the call throws
 * inside the WebView with a message nobody sees.
 */
const ASYNC_ARITY = {
  requestAsync: 5,        // method, path, body, headersJson, callId
  saveSettingsAsync: 3,   // url, token, callId
  detectAsync: 1,         // callId
};

for (const [name, arity] of Object.entries(ASYNC_ARITY)) {
  const params = kotlinParams(name);
  ok(`${name} exists in Kotlin`, params !== null);
  if (params) {
    eq(`${name} takes ${arity} parameters`, params.length, arity);
    ok(`${name} takes callId last`,
      /callId\s*:/.test(params[params.length - 1]),
      `last parameter is "${params[params.length - 1]}" — transport.js appends callId`);
  }
}

const SYNC_ARITY = { getConfig: 0, clearSettings: 0, detect: 0, saveSettings: 2, request: 4 };
for (const [name, arity] of Object.entries(SYNC_ARITY)) {
  const params = kotlinParams(name);
  if (params) eq(`${name} takes ${arity} parameters`, params.length, arity);
}

// ---------------------------------------------------------------------------
// 3. The async result path
// ---------------------------------------------------------------------------

ok('Kotlin resolves async calls via window.__medhaResolve',
  kotlin.includes('__medhaResolve'),
  'the async bridge has no way to deliver a result and every call would time out');

ok('transport.js installs window.__medhaResolve',
  transport.includes('__medhaResolve'),
  'Kotlin would call a function that does not exist');

// A Medha error message can contain quotes and newlines. Splicing one into a
// JavaScript expression breaks the call at best and executes it at worst.
ok('the payload is passed as a quoted JSON string, not spliced into code',
  kotlin.includes('JSONObject.quote'),
  'evaluateJavascript builds a JS expression; an unescaped error message is an injection');

// evaluateJavascript must run on the thread that owns the WebView. Calling it
// from the IO dispatcher throws, and the call never resolves.
ok('the resolve is posted back to the WebView thread',
  /webView\.post\s*\{/.test(kotlin),
  'evaluateJavascript from a background thread throws and the promise hangs forever');

// ---------------------------------------------------------------------------
// 4. Safety properties that only exist in Kotlin
// ---------------------------------------------------------------------------

// There is no Flask proxy inside the APK, so the allowlist has to be here or
// the bridge is an open proxy onto Medha for any script on the page — and the
// page renders SMS-derived text.
ok('the Kotlin bridge enforces the proxy allowlist',
  /val ALLOWED = Regex/.test(kotlin),
  'without it the bridge exposes all of Medha to page script');

// Letting the page set Authorization would let any script substitute a token.
ok('the page cannot override the Authorization header',
  /equals\("Authorization", ignoreCase = true\)/.test(kotlin),
  'header passthrough must skip Authorization');

{
  const rules = read(path.join(ROOT, 'app/proguard-rules.pro'));

  ok('ProGuard keeps the bridge methods', rules.includes('JavascriptInterface'),
    'R8 sees no Kotlin callers, strips them, and only the RELEASE build breaks');
  ok('the bridge class itself is kept', /-keep class .*MedhaBridge/.test(rules));

  /*
   * R8 refuses to finish when a referenced class is missing, and Tink — pulled
   * in by androidx.security:security-crypto, which stores the Medha token — is
   * annotated with Error Prone and JSR-305 types that exist only at compile
   * time. Without these the release build fails with a wall of
   * "Missing class com.google.errorprone.annotations.*". It only ever affects
   * the minified build, so nothing before this step catches it.
   */
  for (const pkg of ['com.google.errorprone.annotations', 'javax.annotation']) {
    ok(`R8 is told ${pkg}.* is absent on purpose`,
      rules.includes(`-dontwarn ${pkg}.`),
      'compile-time-only annotations; R8 halts on the missing references');
  }

  // Tink resolves key managers reflectively from the keyset, so they have no
  // static callers. Losing one means EncryptedSharedPreferences throws the
  // first time the token is saved.
  ok('Tink classes are kept for reflective key-manager lookup',
    /-keep class com\.google\.crypto\.tink\./.test(rules));

  // A stack trace from a user's device is worth having.
  ok('line numbers survive minification', rules.includes('LineNumberTable'));
}

// ---------------------------------------------------------------------------
// 5. The bundled asset path the APK actually loads
// ---------------------------------------------------------------------------
{
  const activity = read(path.join(ROOT, 'app/src/main/java/com/adabala/sandeshika/MainActivity.kt'));
  const startUrl = (activity.match(/startUrl = "([^"]+)"/) || [])[1] || '';

  ok('the WebView loads the app over the asset-loader origin',
    startUrl.startsWith('https://appassets.androidplatform.net/'),
    `startUrl is "${startUrl}" — a file:// origin has no service worker and no secure context`);

  // The Gradle sync copies static/ to assets/web, so the entry point the
  // activity asks for has to be the one that lands there.
  const rel = startUrl.replace('https://appassets.androidplatform.net/assets/', '');
  eq('the entry point is web/index.html', rel, 'web/index.html');
  ok('static/index.html is what gets copied there',
    fs.existsSync(path.join(ROOT, 'static/index.html')));

  const gradle = read(path.join(ROOT, 'app/build.gradle.kts'));
  ok('Gradle syncs the web app into assets',
    /syncWebAssets/.test(gradle) && /rootProject\.file\("static"\)/.test(gradle),
    'nothing copies static/ into the APK, so it would open a blank screen');
}

console.log(`\nbridge contract: ${exported.size} @JavascriptInterface methods,`
  + ` ${required.length} required by transport.js`);
console.log('\n' + '-'.repeat(50));
if (failures.length) console.log(failures.join('\n'));
console.log(`passed=${pass}  failed=${fail}`);
if (fail) process.exit(1);
