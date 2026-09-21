#!/usr/bin/env node
// Runs every suite in this directory, one at a time.
//
// Sequential on purpose: each suite requires the app's server.js and binds a
// port, so running them together would fight over ports and over the
// in-memory Firestore the harness installs. Each gets its own process so a
// crash in one is a failed suite rather than a dead run.
const { readdirSync } = require('fs');
const { join } = require('path');
const { spawnSync } = require('child_process');

const SKIP = new Set(['harness.js', 'run.js']);
const only = process.argv[2];
const suites = readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && !SKIP.has(f) && !f.startsWith('boot-'))
  .filter((f) => !only || f.includes(only))
  .sort();

if (!suites.length) { console.error('no suites found'); process.exit(1); }

let failed = [];
for (const s of suites) {
  process.stdout.write(`\n── ${s} ${'─'.repeat(Math.max(0, 56 - s.length))}\n`);
  const r = spawnSync(process.execPath, [join(__dirname, s)], { stdio: 'inherit', timeout: 180000 });
  if (r.status !== 0) failed.push(s);
}

console.log('\n' + '='.repeat(60));
if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}  (${suites.length - failed.length}/${suites.length} suites passed)`);
  process.exit(1);
}
console.log(`All ${suites.length} suites passed.`);
