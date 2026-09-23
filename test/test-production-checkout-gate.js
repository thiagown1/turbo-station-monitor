'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { checkProductionCheckout } = require('../scripts/ci/check-production-checkout');

test('production checkout gate rejects missing and dirty checkouts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-checkout-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => checkProductionCheckout(path.join(root, 'missing')), /missing/);

  execFileSync('git', ['init', '-q', root]);
  assert.equal(path.resolve(checkProductionCheckout(root)), path.resolve(root));
  fs.writeFileSync(path.join(root, 'new-file.js'), 'hello\n');
  assert.throws(() => checkProductionCheckout(root), /dirty.*new-file\.js/);
});
