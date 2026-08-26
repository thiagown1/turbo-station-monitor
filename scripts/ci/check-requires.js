#!/usr/bin/env node
/**
 * Require-resolution audit — catches "recovered from prod but never committed"
 * files before they reach main.
 *
 * Walks the repo's shipped code (root-level scripts + services/**, excluding
 * test harnesses and one-off scripts) and resolves every relative require().
 * A fresh `git clone` + `npm ci` is exactly what this script's working
 * directory represents in CI, so any require() that doesn't resolve here is
 * a require() that will throw `Cannot find module` the moment someone else
 * clones the repo or a pm2 process restarts from a clean checkout.
 *
 * This is the automated version of the manual audit that found
 * services/support-copilot/lib/auto-close.js (and 6 siblings) missing from
 * git history entirely — see PR #19. Scoped to "shipped" directories only
 * (not __tests__/test/tests/scripts) because those legitimately contain
 * child-process-templated require() strings and pre-existing, separately
 * tracked breakage that isn't this script's job to catch.
 *
 * Run: node scripts/ci/check-requires.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const EXCLUDED_DIRS = new Set(['node_modules', '__tests__', 'test', 'tests', 'scripts', 'auth', '.git']);
const REQUIRE_RE = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

function walk(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || EXCLUDED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (/\.(js|cjs)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

function resolves(target) {
  const candidates = [target, `${target}.js`, `${target}.cjs`, path.join(target, 'index.js')];
  return candidates.some(c => fs.existsSync(c));
}

const files = [
  ...fs.readdirSync(ROOT).filter(f => /\.(js|cjs)$/.test(f)).map(f => path.join(ROOT, f)),
  ...walk(path.join(ROOT, 'services'), []),
];

let missingCount = 0;
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  let match;
  while ((match = REQUIRE_RE.exec(content))) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!resolves(target)) {
      console.error(`✗ ${path.relative(ROOT, file)} requires '${match[1]}', which does not resolve to any file on disk`);
      missingCount++;
    }
  }
}

if (missingCount > 0) {
  console.error(`\n${missingCount} unresolved require() call(s) across ${files.length} files scanned.`);
  console.error('If the file exists on your machine but not here, it was never committed — see PR #19.');
  process.exit(1);
}

console.log(`✓ All relative require() calls resolve (${files.length} files scanned)`);
