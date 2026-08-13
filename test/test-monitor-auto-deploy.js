#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ALL_SERVICES,
  assertCommitSha,
  servicesForFiles,
  waitForSuccessfulCi,
  deployMonitor,
} = require('../services/lib/monitor-auto-deploy');

const OLD_SHA = '1'.repeat(40);
const NEW_SHA = '2'.repeat(40);

async function expectReject(name, fn, pattern) {
  try {
    await fn();
    throw new Error(`${name}: expected rejection`);
  } catch (error) {
    assert.match(error.message, pattern, name);
  }
}

(async () => {
  console.log('🧪 Turbo Monitor auto-deploy');

  assert.strictEqual(assertCommitSha(NEW_SHA), NEW_SHA);
  assert.throws(() => assertCommitSha('main'), /invalid commit SHA/);
  console.log('  ✅ accepts only full immutable commit SHAs');

  assert.deepStrictEqual(
    [...servicesForFiles(['services/support-copilot/lib/contador.js'])],
    ['support-copilot']
  );
  assert.deepStrictEqual(
    [...servicesForFiles(['services/lib/service-port.js'])].sort(),
    [...ALL_SERVICES].sort()
  );
  console.log('  ✅ maps the real git diff to affected PM2 services');

  await expectReject(
    'failed CI',
    () => waitForSuccessfulCi({
      sha: NEW_SHA,
      run: async () => ({ stdout: JSON.stringify([{ status: 'completed', conclusion: 'failure', url: 'https://example.test/run' }]) }),
      sleepFn: async () => {},
      attempts: 1,
    }),
    /completed with failure/
  );
  console.log('  ✅ blocks deployment when main CI fails');

  const dirtyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-deploy-dirty-'));
  const dirtyCalls = [];
  const dirtyRun = async (command, args) => {
    dirtyCalls.push([command, ...args]);
    if (args[0] === 'run') return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]) };
    if (args[0] === 'fetch') return { stdout: '' };
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: `${NEW_SHA}\n` };
    if (args[0] === 'status') return { stdout: ' M services/support-copilot/index.js\n' };
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
  await expectReject(
    'dirty checkout',
    () => deployMonitor({ sha: NEW_SHA, repoDir: dirtyDir, run: dirtyRun, checkHealth: async () => {} }),
    /checkout is dirty/
  );
  assert.ok(!dirtyCalls.some((call) => call.includes('merge')));
  assert.ok(!dirtyCalls.some((call) => call.includes('ci')));
  console.log('  ✅ refuses a dirty production checkout before changing it');

  const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-deploy-clean-'));
  fs.mkdirSync(path.join(cleanDir, 'services', 'support-copilot'), { recursive: true });
  fs.mkdirSync(path.join(cleanDir, 'db'), { recursive: true });
  fs.writeFileSync(path.join(cleanDir, 'db', '.monitor-deploy.lock'), '999999999\nold\n');
  fs.writeFileSync(path.join(cleanDir, 'services', 'support-copilot', 'package-lock.json'), '{}');
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'run') return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]) };
    if (args[0] === 'fetch') return { stdout: '' };
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: `${NEW_SHA}\n` };
    if (args[0] === 'status') return { stdout: '' };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${OLD_SHA}\n` };
    if (args[0] === 'diff') return { stdout: 'services/support-copilot/lib/contador.js\n' };
    return { stdout: '' };
  };
  const result = await deployMonitor({
    sha: NEW_SHA,
    repoDir: cleanDir,
    run,
    checkHealth: async (services) => assert.deepStrictEqual(services, ['support-copilot']),
  });
  assert.deepStrictEqual(result.services, ['support-copilot']);
  assert.ok(calls.some((call) => call[1] === 'merge' && call.includes('--ff-only')));
  assert.ok(calls.some((call) => call[1] === 'ci' && call.includes('--omit=dev')));
  assert.ok(calls.some((call) => call[1] === 'restart' && call.includes('support-copilot')));
  assert.strictEqual(fs.readFileSync(path.join(cleanDir, 'db', '.monitor-deployed-sha'), 'utf8').trim(), NEW_SHA);
  assert.ok(!fs.existsSync(path.join(cleanDir, 'db', '.monitor-deploy.lock')));
  console.log('  ✅ clears stale lock, fast-forwards, installs, restarts, health-checks and records SHA');

  console.log('✅ Auto-deploy tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
