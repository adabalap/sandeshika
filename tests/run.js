/*
 * Test runner.
 *
 * The suites are plain scripts that count assertions and exit non-zero on
 * failure — deliberately, so any one of them can be run on its own with
 * `node tests/parser.test.js` on a phone with no test framework installed.
 * This aggregates them for CI and prints one summary.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Ordered cheapest-first, so a broken parser is reported before a slow browser
// test spends ten seconds confirming the same thing.
const ORDER = [
  'format', 'analytics', 'parser', 'organizer', 'model',
  'transport', 'learning', 'pipeline', 'realcorpus', 'shell', 'boot', 'e2e',
];

const files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith('.test.js'))
  .sort((a, b) => {
    const ai = ORDER.indexOf(a.replace('.test.js', ''));
    const bi = ORDER.indexOf(b.replace('.test.js', ''));
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });

let totalPass = 0;
let totalFail = 0;
const broken = [];

for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, f)], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/passed=(\d+)\s+failed=(\d+)/);
  const ms = Date.now() - started;

  if (!m) {
    broken.push(f);
    process.stdout.write(`✗ ${f.padEnd(24)} did not report a result\n${out}\n`);
    totalFail++;
    continue;
  }

  const skipped = /\(skipped\)/.test(out);
  const [, p, fl] = m;
  totalPass += Number(p);
  totalFail += Number(fl);
  const bad = Number(fl) > 0 || r.status !== 0;
  // A skipped suite is reported as skipped, never as a silent pass. A suite
  // that quietly reports zero of zero is how coverage disappears.
  process.stdout.write(skipped
    ? `− ${f.padEnd(24)} skipped (see its output for why)\n`
    : `${bad ? '✗' : '✓'} ${f.padEnd(24)} ${String(p).padStart(4)} passed  `
      + `${Number(fl) ? `${fl} FAILED  ` : ''}${String(ms).padStart(5)}ms\n`);
  if (bad) process.stdout.write(out.split('\n').filter((l) => l.trim()).slice(-12).join('\n') + '\n');
}

console.log('-'.repeat(60));
console.log(`${files.length} suites · ${totalPass} passed · ${totalFail} failed`);
if (totalFail || broken.length) process.exit(1);
