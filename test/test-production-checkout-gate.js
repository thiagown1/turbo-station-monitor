'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { checkProductionCheckout } = require('../scripts/ci/check-production-checkout');

test('production checkout gate rejects missing and dirty checkouts', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-checkout-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'production');
  const remote = path.join(dir, 'origin.git');
  assert.throws(() => checkProductionCheckout(root), /missing/);

  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['clone', '-q', remote, root]);
  const git = (...args) => execFileSync('git', ['-C', root, ...args]);
  git('checkout', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'tracked.js'), 'initial\n');
  git('add', 'tracked.js');
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  git('push', '-q', '-u', 'origin', 'main');

  assert.equal(path.resolve(checkProductionCheckout(root)), path.resolve(root));
  fs.writeFileSync(path.join(root, 'new-file.js'), 'hello\n');
  assert.throws(() => checkProductionCheckout(root), /dirty.*new-file\.js/);
  fs.rmSync(path.join(root, 'new-file.js'));

  fs.writeFileSync(path.join(root, 'tracked.js'), 'local commit\n');
  git('add', 'tracked.js');
  execFileSync('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'local only']);
  assert.throws(() => checkProductionCheckout(root), /HEAD diverges/);
});

test('production checkout gate never writes refs the auto-deploy fetch also locks', (t) => {
  // On 2026-09-27 this gate's `git fetch origin main` raced the auto-deploy's own
  // fetch in the same checkout ("cannot lock ref refs/remotes/origin/main"), the
  // required check went red and the merged commit was never deployed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-checkout-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'production');
  const other = path.join(dir, 'other');
  const remote = path.join(dir, 'origin.git');
  const commit = (repo, file, body, message) => {
    fs.writeFileSync(path.join(repo, file), body);
    execFileSync('git', ['-C', repo, 'add', file]);
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message]);
  };
  const rev = (repo, ref) => execFileSync('git', ['-C', repo, 'rev-parse', ref], { encoding: 'utf8' }).trim();

  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, root]);
  execFileSync('git', ['-C', root, 'checkout', '-q', '-b', 'main']);
  commit(root, 'tracked.js', 'initial\n', 'initial');
  execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'main']);

  // main advances (the merge that triggered both CI and the deploy).
  execFileSync('git', ['clone', '-q', remote, other]);
  commit(other, 'tracked.js', 'merged\n', 'merged PR');
  execFileSync('git', ['-C', other, 'push', '-q', 'origin', 'main']);

  const trackingBefore = rev(root, 'refs/remotes/origin/main');
  // The deploy's fetch holds the lock while the gate runs.
  const lock = path.join(root, '.git', 'refs', 'remotes', 'origin', 'main.lock');
  fs.writeFileSync(lock, '');
  assert.equal(path.resolve(checkProductionCheckout(root)), path.resolve(root));
  fs.rmSync(lock);

  assert.equal(rev(root, 'refs/remotes/origin/main'), trackingBefore);
  assert.equal(fs.existsSync(path.join(root, '.git', 'FETCH_HEAD')), false);

  // Divergence is still judged against the remote's current main.
  commit(root, 'tracked.js', 'local only\n', 'local only');
  assert.throws(() => checkProductionCheckout(root), /HEAD diverges/);
});
