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
  restartServices,
  SELF_SERVICE,
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

  const supersededDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-deploy-superseded-'));
  fs.mkdirSync(path.join(supersededDir, 'db'), { recursive: true });
  const supersedingSha = '3'.repeat(40);
  const supersededCalls = [];
  const supersededResult = await deployMonitor({
    sha: NEW_SHA,
    repoDir: supersededDir,
    run: async (command, args) => {
      supersededCalls.push([command, ...args]);
      if (args[0] === 'run') {
        return {
          stdout: JSON.stringify([{
            status: 'completed',
            conclusion: 'cancelled',
            url: 'https://example.test/cancelled-run',
          }]),
        };
      }
      if (args[0] === 'fetch') return { stdout: '' };
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: `${supersedingSha}\n` };
      if (args[0] === 'merge-base') return { stdout: '' };
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
    checkHealth: async () => { throw new Error('superseded deploy must not health-check'); },
  });
  assert.strictEqual(supersededResult.status, 'superseded');
  assert.strictEqual(supersededResult.targetSha, NEW_SHA);
  assert.strictEqual(supersededResult.supersededBy, supersedingSha);
  assert.ok(supersededCalls.some((call) => call[1] === 'merge-base' && call.includes('--is-ancestor')));
  assert.ok(!supersededCalls.some((call) => call[1] === 'merge'));
  assert.ok(!supersededCalls.some((call) => call[1] === 'ci'));
  assert.ok(!fs.existsSync(path.join(supersededDir, 'db', '.monitor-deploy.lock')));
  console.log('  ✅ treats cancelled CI as superseded only when a newer main commit contains the target');

  const divergentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-deploy-divergent-'));
  fs.mkdirSync(path.join(divergentDir, 'db'), { recursive: true });
  await expectReject(
    'divergent main',
    () => deployMonitor({
      sha: NEW_SHA,
      repoDir: divergentDir,
      run: async (command, args) => {
        if (args[0] === 'run') return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]) };
        if (args[0] === 'fetch') return { stdout: '' };
        if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: `${supersedingSha}\n` };
        if (args[0] === 'merge-base') {
          const error = new Error('not an ancestor');
          error.code = 1;
          throw error;
        }
        throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
      },
      checkHealth: async () => { throw new Error('divergent deploy must not health-check'); },
    }),
    /does not contain target/
  );
  assert.ok(!fs.existsSync(path.join(divergentDir, 'db', '.monitor-deploy.lock')));
  console.log('  ✅ fails closed when main diverges instead of silently treating it as superseded');

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
  // Through the ecosystem file, not the bare name: a bare `pm2 restart <name>`
  // reuses the config pm2 holds in memory, so ecosystem.config.js edits (memory
  // ceilings, env) land on disk and never take effect.
  const restartCall = calls.find((call) => call[1] === 'restart' && call.includes('support-copilot'));
  assert.ok(restartCall, 'reiniciou o support-copilot');
  assert.ok(restartCall.includes('ecosystem.config.js'), 'restart relê o ecosystem.config.js');
  assert.ok(restartCall.includes('--only'), 'restart usa --only');
  assert.ok(restartCall.includes('--update-env'), 'restart atualiza o env');
  assert.strictEqual(fs.readFileSync(path.join(cleanDir, 'db', '.monitor-deployed-sha'), 'utf8').trim(), NEW_SHA);
  assert.ok(!fs.existsSync(path.join(cleanDir, 'db', '.monitor-deploy.lock')));
  console.log('  ✅ clears stale lock, fast-forwards, installs, restarts, health-checks and records SHA');

  const waitingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-deploy-waiting-lock-'));
  fs.mkdirSync(path.join(waitingDir, 'db'), { recursive: true });
  const waitingLockPath = path.join(waitingDir, 'db', '.monitor-deploy.lock');
  fs.writeFileSync(waitingLockPath, `${process.pid}\nactive\n`);
  let lockSleeps = 0;
  const waitingResult = await deployMonitor({
    sha: NEW_SHA,
    repoDir: waitingDir,
    run: async (command, args) => {
      if (args[0] === 'run') return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]) };
      if (args[0] === 'fetch') return { stdout: '' };
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: `${NEW_SHA}\n` };
      if (args[0] === 'status') return { stdout: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${OLD_SHA}\n` };
      if (args[0] === 'diff') return { stdout: 'services/alert-engine.js\n' };
      return { stdout: '' };
    },
    checkHealth: async () => {},
    lockSleepFn: async () => {
      lockSleeps += 1;
      fs.unlinkSync(waitingLockPath);
    },
    lockAttempts: 2,
    lockIntervalMs: 1,
  });
  assert.strictEqual(waitingResult.status, 'deployed');
  assert.strictEqual(lockSleeps, 1, 'esperou o deploy ativo liberar o lock');
  assert.ok(!fs.existsSync(waitingLockPath));
  console.log('  ✅ waits for an active short deploy instead of raising a false failure');

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

  // `null`, not `undefined`: undefined falls through to the destructuring
  // default and would issue a REAL request from the runner. No unit test in this
  // file is allowed to touch the network.
  const noFetch = await notifyDeploy('x', { ...notifyOpts, fetchImpl: null });
  assert.strictEqual(noFetch.delivered, false);
  assert.match(noFetch.reason, /fetch/i);
  assert.ok(!/support API/.test(noFetch.reason), 'não pode ter saído pela rede');
  console.log('  ✅ notifyDeploy names the missing configuration instead of failing silently');


  // ── self-restart hazard ───────────────────────────────────────────────────
  // Regression for 2026-08-18/19: the worker is spawned BY github-webhook, and
  // pm2 kills a restarted app's process tree by ppid. Restarting the webhook from
  // inside deployMonitor killed the worker after the git merge but before the
  // remaining restarts, the health check and the SHA record — twice, each time
  // leaving new code on disk with old code in memory and a log that just stopped.
  assert.strictEqual(SELF_SERVICE, 'github-webhook', 'o serviço que gera o worker');

  const selfDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-deploy-self-'));
  fs.mkdirSync(path.join(selfDir, 'db'), { recursive: true });
  const selfCalls = [];
  const selfRun = async (command, args) => {
    selfCalls.push([command, ...args]);
    if (args[0] === 'run') return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]) };
    if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: `${NEW_SHA}\n` };
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${OLD_SHA}\n` };
    if (args[0] === 'status') return { stdout: '' };
    // A shared file: fans out to every service, github-webhook included.
    if (args[0] === 'diff') return { stdout: 'package.json\n' };
    return { stdout: '' };
  };
  let healthChecked = null;
  const selfResult = await deployMonitor({
    sha: NEW_SHA,
    repoDir: selfDir,
    run: selfRun,
    checkHealth: async (services) => { healthChecked = services; },
  });

  assert.ok(selfResult.services.includes(SELF_SERVICE), 'o webhook está entre os afetados');
  assert.deepStrictEqual(selfResult.deferredServices, [SELF_SERVICE], 'webhook adiado para o fim');
  assert.ok(!selfResult.immediateServices.includes(SELF_SERVICE), 'webhook fora da rodada imediata');

  const restartedNames = selfCalls
    .filter((call) => call[1] === 'restart')
    .map((call) => call[call.indexOf('--only') + 1]);
  assert.ok(restartedNames.length > 0, 'reiniciou alguma coisa');
  assert.ok(
    !restartedNames.includes(SELF_SERVICE),
    'deployMonitor NUNCA reinicia o próprio pai — isso se mata no meio do deploy'
  );
  assert.ok(healthChecked && !healthChecked.includes(SELF_SERVICE), 'health check não espera o webhook adiado');

  // The durable bits must already be on disk before the caller triggers the
  // self-kill, otherwise dying on that last restart loses them again.
  assert.strictEqual(
    fs.readFileSync(path.join(selfDir, 'db', '.monitor-deployed-sha'), 'utf8').trim(),
    NEW_SHA,
    'SHA gravado ANTES do restart do webhook'
  );
  assert.ok(!fs.existsSync(path.join(selfDir, 'db', '.monitor-deploy.lock')), 'lock liberado antes do self-kill');
  console.log('  ✅ never restarts the webhook that spawns it; defers it to the caller');

  // Nothing to defer when the webhook is not among the changed services.
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-deploy-plain-'));
  fs.mkdirSync(path.join(plainDir, 'db'), { recursive: true });
  const plainResult = await deployMonitor({
    sha: NEW_SHA,
    repoDir: plainDir,
    run: async (command, args) => {
      if (args[0] === 'run') return { stdout: JSON.stringify([{ status: 'completed', conclusion: 'success' }]) };
      if (args[0] === 'rev-parse' && args[1] === 'origin/main') return { stdout: `${NEW_SHA}\n` };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: `${OLD_SHA}\n` };
      if (args[0] === 'status') return { stdout: '' };
      if (args[0] === 'diff') return { stdout: 'services/alert-engine.js\n' };
      return { stdout: '' };
    },
    checkHealth: async () => {},
  });
  assert.deepStrictEqual(plainResult.deferredServices, [], 'sem webhook afetado, nada a adiar');
  console.log('  ✅ defers nothing when the webhook is not affected');

  // The deferred restart the caller runs uses the same ecosystem-aware command.
  const deferredCalls = [];
  await restartServices([SELF_SERVICE], {
    run: async (command, args) => { deferredCalls.push([command, ...args]); return { stdout: '' }; },
    pm2Bin: '/usr/bin/pm2',
    repoDir: '/tmp/whatever',
  });
  assert.strictEqual(deferredCalls.length, 1);
  assert.ok(deferredCalls[0].includes('ecosystem.config.js'), 'restart adiado também relê o config');
  assert.ok(deferredCalls[0].includes(SELF_SERVICE));
  console.log('  ✅ the deferred restart re-reads the ecosystem config too');

  console.log('✅ Auto-deploy tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
