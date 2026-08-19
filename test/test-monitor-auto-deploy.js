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
  notifyDeploy,
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

  // ── notifyDeploy ──────────────────────────────────────────────────────────
  // Regression for 2026-08-18: the notifier shelled out to a Telegram transport
  // that is not linked on this box, so three consecutive dirty-checkout refusals
  // (PRs #49, #50 and #51 merged and never reaching production) were announced
  // to nobody. It only surfaced because someone read the log by hand.
  const notifyOpts = {
    apiBase: 'http://127.0.0.1:3005',
    conversationId: 'conv_test',
    brandId: 'turbo',
    secret: 'shhh',
  };

  const notifyCalls = [];
  const okNotify = await notifyDeploy('deploy ok', {
    ...notifyOpts,
    fetchImpl: async (url, init) => { notifyCalls.push({ url, init }); return { ok: true, status: 200 }; },
  });
  assert.strictEqual(okNotify.delivered, true, 'entrega confirmada em 200');
  assert.strictEqual(notifyCalls.length, 1, 'exatamente um POST');
  assert.match(notifyCalls[0].url, /\/api\/support\/conversations\/conv_test\/messages/, 'rota da conversa');
  assert.match(notifyCalls[0].url, /brandId=turbo/, 'brand na query');
  assert.strictEqual(notifyCalls[0].init.method, 'POST');
  assert.strictEqual(notifyCalls[0].init.headers['x-api-secret'], 'shhh', 'manda o segredo');
  assert.deepStrictEqual(JSON.parse(notifyCalls[0].init.body), { body: 'deploy ok', source: 'system' });
  assert.ok(!/telegram/i.test(notifyCalls[0].url), 'nunca mais telegram');
  console.log('  ✅ notifyDeploy posts to the support-copilot API, not Telegram');

  const http503 = await notifyDeploy('x', { ...notifyOpts, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.strictEqual(http503.delivered, false, 'non-2xx não conta como entregue');
  assert.match(http503.reason, /503/, 'reason carrega o status');

  const threw = await notifyDeploy('x', {
    ...notifyOpts,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.strictEqual(threw.delivered, false);
  assert.match(threw.reason, /ECONNREFUSED/, 'transporte quebrado não derruba o deploy');
  console.log('  ✅ notifyDeploy reports failure instead of throwing or swallowing');

  const noSecret = await notifyDeploy('x', {
    ...notifyOpts,
    secret: '',
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.strictEqual(noSecret.delivered, false, 'sem segredo não finge sucesso');
  assert.match(noSecret.reason, /SECRET/i, 'diz qual config falta');

  const noConv = await notifyDeploy('x', {
    ...notifyOpts,
    conversationId: '',
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.strictEqual(noConv.delivered, false);
  assert.match(noConv.reason, /conversation/i);

  const noFetch = await notifyDeploy('x', { ...notifyOpts, fetchImpl: undefined });
  assert.strictEqual(noFetch.delivered, false);
  assert.match(noFetch.reason, /fetch/i);
  console.log('  ✅ notifyDeploy names the missing configuration instead of failing silently');

  console.log('✅ Auto-deploy tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
