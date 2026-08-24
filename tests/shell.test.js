/*
 * Shell integrity.
 *
 * Three ways this app can break without a single unit test noticing:
 *
 *   1. A view writes to an element id that index.html does not contain. The
 *      old build did exactly this via `Transport`, and a whole screen was dead
 *      for months without anything failing.
 *   2. A module is added but never listed in the service worker's SHELL, so
 *      the app half-works offline — the shell paints and nothing responds.
 *   3. A module is imported but the file does not exist, which in a buildless
 *      ES-module app is a runtime 404 rather than a build error.
 *
 * None of these are logic bugs, so none of them show up in the parser tests.
 * They are checked here instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JS = path.join(ROOT, 'static', 'js');

let pass = 0; let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) pass++;
  else { fail++; failures.push(`${name}\n     ${detail}`); }
}
const eq = (n, a, b) => ok(n, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------------------
// Walk the real import graph from the entry point
// ---------------------------------------------------------------------------
const IMPORT_RE = /^\s*(?:import|export)[\s\S]*?from\s+['"](\.[^'"]+)['"]/gm;

/** @returns {Set<string>} absolute paths of every reachable module */
function walk(entry) {
  const seen = new Set();
  const missing = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) {
      missing.push(file);
      continue;
    }
    seen.add(file);
    const src = read(file);
    for (const m of src.matchAll(IMPORT_RE)) {
      queue.push(path.resolve(path.dirname(file), m[1]));
    }
  }
  return { seen, missing };
}

const entry = path.join(JS, 'main.js');
ok('the entry point exists', fs.existsSync(entry), entry);

const { seen: reachable, missing } = walk(entry);
ok('every import resolves to a real file', missing.length === 0,
  missing.map((f) => path.relative(ROOT, f)).join(', '));

// Every .js under static/js should be reachable from main.js. An orphan is
// either dead code or something that was meant to be wired up and was not.
const allFiles = [];
(function collect(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p);
    else if (e.name.endsWith('.js')) allFiles.push(p);
  }
}(JS));

/*
 * types.js holds JSDoc typedefs only. It is referenced as import('./types.js')
 * inside comments, which the compiler follows and the browser never fetches, so
 * it is legitimately absent from both the runtime graph and the offline shell.
 */
const TYPE_ONLY = new Set([path.join(JS, 'core', 'types.js')]);

const orphans = allFiles.filter((f) => !reachable.has(f) && !TYPE_ONLY.has(f));
ok('no orphaned modules under static/js', orphans.length === 0,
  orphans.map((f) => path.relative(ROOT, f)).join(', '));

ok('the module graph is non-trivial', reachable.size >= 15, `${reachable.size} modules`);

// ---------------------------------------------------------------------------
// index.html loads exactly one module entry point
// ---------------------------------------------------------------------------
const html = read(path.join(ROOT, 'static', 'index.html'));
const srcTags = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"[^>]*>/g)];

eq('index.html loads exactly one script file', srcTags.length, 1);
eq('and it is the module entry point', srcTags[0] && srcTags[0][1], '/static/js/main.js');
ok('it is loaded as a module', /<script[^>]*type="module"[^>]*src="\/static\/js\/main\.js"/.test(html),
  'missing type="module" — the imports will not resolve');

// ---------------------------------------------------------------------------
// The service worker caches the whole graph
// ---------------------------------------------------------------------------
const sw = read(path.join(ROOT, 'static', 'sw.js'));
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
ok('sw.js declares a SHELL list', Boolean(shellBlock));

const shell = new Set([...(shellBlock ? shellBlock[1] : '').matchAll(/'([^']+)'/g)].map((m) => m[1]));
const shellJs = [...shell].filter((u) => u.endsWith('.js'));

const expected = [...reachable]
  .map((f) => '/' + path.relative(ROOT, f).split(path.sep).join('/'))
  .sort();

const notCached = expected.filter((u) => !shell.has(u));
ok('every reachable module is in the service worker SHELL', notCached.length === 0,
  `missing: ${notCached.join(', ')}`);

const stale = shellJs.filter((u) => !expected.includes(u));
ok('the SHELL lists no modules that no longer exist', stale.length === 0,
  `stale: ${stale.join(', ')}`);

ok('the offline shell includes the page itself', shell.has('/'));
ok('the offline shell includes the stylesheet', shell.has('/static/app.css'));

// ---------------------------------------------------------------------------
// Versions agree
//
// A page build that disagrees with the server's is reported to the user as a
// stale cache. If the two constants drift in the repo, that warning fires for
// everyone and stops meaning anything.
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
const mainBuild = (read(entry).match(/const BUILD = '([^']+)'/) || [])[1];
const swVersion = (sw.match(/const VERSION = '([^']+)'/) || [])[1];
const pyVersion = (read(path.join(ROOT, 'app.py')).match(/APP_VERSION = "([^"]+)"/) || [])[1];

eq('main.js BUILD matches package.json', mainBuild, pkg.version);
eq('sw.js VERSION matches package.json', swVersion, pkg.version);
eq('app.py APP_VERSION matches package.json', pyVersion, pkg.version);

// ---------------------------------------------------------------------------
// Every element the UI writes to actually exists
//
// This is the check that would have caught the dead Setup screen.
// ---------------------------------------------------------------------------
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

/** Selectors the UI targets by id, gathered from the real call sites. */
const SELECTOR_RE = /(?:\$\(|setHtml\(|setText\(|setHidden\(|toggleClass\(|on\(|delegate\(|val\(|setVal\()\s*'#([A-Za-z][\w-]*)'(\s*\+)?/g;

const referenced = new Map();
for (const file of reachable) {
  const rel = path.relative(ROOT, file);
  for (const m of read(file).matchAll(SELECTOR_RE)) {
    // A selector built by concatenation ($('#view-' + name)) names a family of
    // elements, not one; the routing test covers those instead.
    if (m[2]) continue;
    if (!referenced.has(m[1])) referenced.set(m[1], rel);
  }
}

ok('the UI references a meaningful number of elements', referenced.size >= 30,
  `${referenced.size} referenced`);

const dangling = [...referenced.entries()].filter(([id]) => !ids.has(id));
ok('every element id the UI writes to exists in index.html', dangling.length === 0,
  dangling.map(([id, f]) => `#${id} (${f})`).join('\n     '));

// ---------------------------------------------------------------------------
// Every file under tests/ must be an ES module
//
// package.json sets "type": "module", which retroactively makes EVERY .js file
// in the repository an ES module — including test files that were never
// imported from main.js and so are invisible to the import walk above.
//
// A stray require() in one of them is not a failed assertion, it is a crash at
// import time: the suite never runs, and if CI invokes the files individually
// the run stops there and the suites after it are never reached. That is
// exactly how a converted repo loses a test file without anyone noticing.
// ---------------------------------------------------------------------------
{
  const testDir = path.join(ROOT, 'tests');
  const testFiles = fs.readdirSync(testDir).filter((n) => n.endsWith('.js'));

  ok('tests/ contains test files', testFiles.length > 0);

  for (const f of testFiles) {
    // This file names the very patterns it forbids, in its own regexes and
    // comments, so it would fail its own check. Skipping it is the honest fix;
    // narrowing the patterns until they miss their own source would weaken
    // them for every other file.
    if (f === 'shell.test.js') continue;

    /*
     * Comments are stripped before scanning. A file that explains in prose why
     * it no longer uses __dirname was being failed for saying the word, which
     * is the kind of false positive that gets a check deleted rather than
     * fixed. Strings are left in: a require() built from one is still a bug.
     */
    const src = read(path.join(testDir, f))
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    // Ignores `foo.require(` and `// require` prose; catches a bare call.
    ok(`tests/${f} uses import, not require()`,
      !/(^|[^.\w'"`])require\s*\(/m.test(src),
      'CommonJS require() in a file package.json treats as an ES module — '
      + "convert to `import x from 'node:fs'`");

    ok(`tests/${f} does not use module.exports`,
      !/\bmodule\.exports\b/.test(src),
      'not defined in ESM — use `export` instead');

    ok(`tests/${f} does not use __dirname or __filename`,
      !/\b__(?:dirname|filename)\b/.test(src),
      'not defined in ESM — use fileURLToPath(import.meta.url)');

    // The 2.0 restructure moved every core module into core/ and split api.js
    // into four. A path from the old layout resolves to nothing at runtime.
    const stale = [...src.matchAll(/from\s+'(\.\.\/static\/js\/[^']+)'/g)]
      .map((m) => m[1])
      .filter((rel) => !fs.existsSync(path.resolve(testDir, rel)));
    ok(`tests/${f} imports only modules that exist`, stale.length === 0,
      `missing: ${stale.join(', ')} — core modules moved to static/js/core/ in 2.0.0, `
      + 'and api.js split into data/{client,categories,ingest,transport}.js');
  }
}

// ---------------------------------------------------------------------------
// No module may reintroduce a window global as its interface
// ---------------------------------------------------------------------------
for (const file of reachable) {
  const rel = path.relative(ROOT, file);
  const src = read(file);
  ok(`${rel} exports rather than assigning to window`,
    !/window\.Sandeshika\w*\s*=/.test(src),
    'found a window.Sandeshika* assignment');
  ok(`${rel} keeps no state on window.__*`,
    !/window\.__\w+\s*=/.test(src),
    'found a window.__ global');
}

console.log(`\nmodule graph: ${reachable.size} modules reachable from main.js`);
console.log(`dom contract: ${referenced.size} element ids referenced, ${ids.size} defined`);
console.log('\n' + '-'.repeat(50));
if (failures.length) console.log(failures.join('\n'));
console.log(`passed=${pass}  failed=${fail}`);
if (fail) process.exit(1);
