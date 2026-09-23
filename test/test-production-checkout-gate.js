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
